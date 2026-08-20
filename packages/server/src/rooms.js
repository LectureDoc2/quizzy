import { createHash, randomBytes, randomInt } from 'crypto';

/**
 * Room identifiers are read aloud and typed in by hand, so the alphabet omits
 * characters that are routinely confused on a projector: I/1, O/0, and the
 * lowercase forms entirely.
 */
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 6;

/** How long a room that is still running may sit with nobody connected. */
const EMPTY_ROOM_TTL_MS = 90 * 60 * 1000; // 90 minutes

/**
 * How long a finished room is kept after its last connection goes away.
 *
 * Deliberately short: once the last socket closes, nothing can read the room
 * again -- there is no room listing, no persistence, and a process restart
 * discards it anyway -- so a longer window buys nothing and only widens the
 * memory that an unauthenticated `create_room` can pin down. If final results
 * need to outlive the lecture, export them from the control view rather than
 * holding participant data in RAM.
 */
const ENDED_ROOM_TTL_MS =
  Number(process.env.ENDED_ROOM_RETENTION_MINUTES || 120) * 60 * 1000;

/** Backstop: no room outlives this, whatever its state or connections. */
const ABSOLUTE_ROOM_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

class Room {
  constructor(roomId, presenterToken, quiz) {
    this.roomId = roomId;
    this.presenterToken = presenterToken;
    this.quiz = quiz;
    this.participants = new Map(); // ws -> { name, id, answers: [], score }
    this.state = 'lobby'; // lobby, question, results, ended
    this.currentQuestionIndex = -1;
    this.currentQuestionStartTime = null;
    this.currentAnswers = new Map(); // participantId -> { answer, timestamp }
    this.presenterWss = new Set();
    this.createdAt = Date.now();
    this.questionTimer = null;
    this.onAutoEnd = null; // callback(results) -> void
    // Timestamp at which the room last became connectionless, or null while
    // anybody is still connected. Drives expiry; see RoomManager.sweep().
    this.emptySince = this.createdAt;
    // Aggregate per-question statistics, appended as each question closes.
    // See recordQuestionStatistics() for why this is not derived at the end.
    this.questionStats = [];
  }

  /** Number of live sockets attached to this room, presenter included. */
  connectionCount() {
    return this.participants.size + this.presenterWss.size;
  }

  /**
   * Recompute the "empty since" marker. Called after every attach/detach: the
   * clock starts when the last socket leaves and is cleared when one returns.
   */
  updateEmptySince(now = Date.now()) {
    if (this.connectionCount() > 0) {
      this.emptySince = null;
    } else if (this.emptySince === null) {
      this.emptySince = now;
    }
  }

  /** True once this room may be discarded. */
  isExpired(now = Date.now()) {
    if (now - this.createdAt >= ABSOLUTE_ROOM_TTL_MS) return true;
    if (this.emptySince === null) return false;
    const ttl = this.state === 'ended' ? ENDED_ROOM_TTL_MS : EMPTY_ROOM_TTL_MS;
    return now - this.emptySince >= ttl;
  }

  addParticipant(ws, name) {
    const id = `p_${Date.now()}_${randomBytes(9).toString('base64url')}`;
    const participant = { id, name, score: 0, answers: [] };
    this.participants.set(ws, participant);
    this.updateEmptySince();
    return participant;
  }

  removeParticipant(ws) {
    const participant = this.participants.get(ws);
    if (participant) {
      this.participants.delete(ws);
      this.updateEmptySince();
      return participant;
    }
    return null;
  }

  getParticipantById(id) {
    for (const [, p] of this.participants) {
      if (p.id === id) return p;
    }
    return null;
  }

  getParticipantCount() {
    return this.participants.size;
  }

  addPresenter(ws) {
    this.presenterWss.add(ws);
    this.updateEmptySince();
  }

  removePresenter(ws) {
    this.presenterWss.delete(ws);
    this.updateEmptySince();
  }

  startGame() {
    this.state = 'question';
    this.currentQuestionIndex = 0;
    this.startQuestion();
  }

  startQuestion() {
    this.currentAnswers = new Map();
    this.currentQuestionStartTime = Date.now();
    this.state = 'question';
    this.clearQuestionTimer();

    const question = this.getCurrentQuestion();
    if (question && question.timeLimit > 0 && typeof this.onAutoEnd === 'function') {
      this.questionTimer = setTimeout(() => {
        this.autoEndQuestion();
      }, question.timeLimit * 1000);
    }
  }

  /**
   * Validate a participant-supplied answer against the *current* question.
   *
   * Participants are untrusted: `answer` arrives verbatim from a WebSocket
   * message and may be any JSON value. Everything downstream -- scoring, and in
   * particular the presenter's results view -- assumes a number for estimation
   * questions and an array of option indices for multiple-choice questions.
   * This is the single choke point that keeps those assumptions true, so
   * answers are rejected rather than coerced.
   *
   * @returns {{valid: boolean, error?: string, answer?: number|number[]}}
   */
  validateAnswer(answer) {
    if (this.state !== 'question') {
      return { valid: false, error: 'No question is currently accepting answers' };
    }

    const question = this.getCurrentQuestion();
    if (!question) {
      return { valid: false, error: 'No question is currently accepting answers' };
    }

    if (question.type === 'estimation') {
      // Note: typeof NaN === 'number', hence the explicit isFinite check.
      // Without it, a NaN answer silently corrupts the ranking comparator.
      if (typeof answer !== 'number' || !Number.isFinite(answer)) {
        return { valid: false, error: 'Answer must be a finite number' };
      }
      return { valid: true, answer };
    }

    if (question.type === 'multiple-choice') {
      if (!Array.isArray(answer)) {
        return { valid: false, error: 'Answer must be an array of option indices' };
      }
      const optionCount = Array.isArray(question.options) ? question.options.length : 0;
      // An empty selection is legitimate ("I don't know"); it simply scores 0.
      if (answer.length > optionCount) {
        return { valid: false, error: 'Answer selects more options than the question has' };
      }
      for (const index of answer) {
        if (!Number.isInteger(index) || index < 0 || index >= optionCount) {
          return { valid: false, error: 'Answer contains an invalid option index' };
        }
      }
      // Normalize so scoring and rendering see a canonical value.
      return { valid: true, answer: [...new Set(answer)].sort((a, b) => a - b) };
    }

    return { valid: false, error: 'Unsupported question type' };
  }

  submitAnswer(participantId, answer) {
    if (this.state !== 'question') return false;
    if (this.currentAnswers.has(participantId)) return false;

    // Validated here as well as at the transport layer, so that no caller can
    // place an unvalidated value into currentAnswers.
    const validation = this.validateAnswer(answer);
    if (!validation.valid) return false;
    answer = validation.answer;

    this.currentAnswers.set(participantId, {
      answer,
      timestamp: Date.now()
    });

    // Auto-end if all participants have answered
    if (this.participants.size > 0 && this.currentAnswers.size === this.participants.size) {
      this.clearQuestionTimer();
      this.autoEndQuestion();
    }

    return true;
  }

  endQuestion() {
    this.clearQuestionTimer();
    const question = this.quiz.questions[this.currentQuestionIndex];

    if (this.state === 'results') {
      const results = this.scoreQuestion(question);
      results.leaderboard = this.getLeaderboard();
      return results;
    }

    const results = this.scoreQuestion(question);

    // Update participant scores
    for (const [participantId, points] of results.scores) {
      const participant = this.getParticipantById(participantId);
      if (participant) {
        participant.score += points;
        participant.answers.push({
          questionIndex: this.currentQuestionIndex,
          answer: this.currentAnswers.get(participantId)?.answer,
          points,
          timestamp: this.currentAnswers.get(participantId)?.timestamp
        });
      }
    }

    this.recordQuestionStatistics(question, results);

    // Recalculate leaderboard after score updates
    results.leaderboard = this.getLeaderboard();
    this.state = 'results';
    return results;
  }

  /**
   * Snapshot how a question was answered, for the post-game export.
   *
   * Recorded when the question closes rather than derived from participants at
   * the end, because participants are removed from the room the moment their
   * socket drops: anyone who shuts their laptop before the last question would
   * otherwise silently vanish from the statistics, quietly biasing exactly the
   * numbers the lecturer is trying to read.
   *
   * Deliberately aggregate: counts and distributions, never names. Nothing here
   * identifies a participant, which keeps the exported file free of personal
   * data.
   */
  recordQuestionStatistics(question, results) {
    if (this.questionStats.some(s => s.questionIndex === this.currentQuestionIndex)) {
      return; // endQuestion() can be reached twice; record once.
    }

    const answers = Array.from(this.currentAnswers.values()).map(a => a.answer);
    const stat = {
      questionIndex: this.currentQuestionIndex,
      type: question.type,
      text: question.text,
      responseCount: answers.length,
      participantCount: this.participants.size
    };

    if (question.type === 'multiple-choice') {
      const options = Array.isArray(question.options) ? question.options : [];
      const correct = [...(question.correctIndices || [])].sort((a, b) => a - b);
      stat.options = options.map((option, index) => ({
        index,
        text: option,
        isCorrect: correct.includes(index),
        // How many participants selected this option (multi-select counts once
        // per participant per option).
        count: answers.filter(a => Array.isArray(a) && a.includes(index)).length
      }));
      stat.correctIndices = correct;
      stat.correctCount = Array.from(results.scores.values()).filter(p => p > 0).length;
    } else if (question.type === 'estimation') {
      const values = answers.filter(a => typeof a === 'number' && Number.isFinite(a));
      const sorted = [...values].sort((a, b) => a - b);
      const correctAnswer = Number(question.correctAnswer);
      stat.correctAnswer = Number.isFinite(correctAnswer) ? correctAnswer : null;
      stat.min = sorted.length ? sorted[0] : null;
      stat.max = sorted.length ? sorted[sorted.length - 1] : null;
      stat.mean = sorted.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      stat.median = sorted.length
        ? (sorted.length % 2
          ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
        : null;
      // A rough "did they know it" signal: answers within 10% of the truth.
      stat.withinTenPercent = stat.correctAnswer === null
        ? null
        : values.filter(v => Math.abs(v - stat.correctAnswer) <= Math.abs(stat.correctAnswer) * 0.1).length;
    }

    this.questionStats.push(stat);
  }

  /**
   * Aggregate statistics for every question that has been played.
   * Used by the presenter's post-game export.
   */
  getStatistics() {
    return {
      quizTitle: this.quiz.title,
      roomId: this.roomId,
      totalQuestions: this.quiz.questions.length,
      questions: this.questionStats.map(s => ({ ...s }))
    };
  }

  clearQuestionTimer() {
    if (this.questionTimer) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }
  }

  autoEndQuestion() {
    if (this.state !== 'question') return;
    const results = this.endQuestion();
    if (typeof this.onAutoEnd === 'function') {
      this.onAutoEnd(results);
    }
  }

  scoreQuestion(question) {
    const scores = new Map();
    const rankings = [];

    if (question.type === 'multiple-choice') {
      const correctSorted = [...question.correctIndices].sort((a, b) => a - b);
      for (const [participantId, data] of this.currentAnswers) {
        let points = 0;
        if (Array.isArray(data.answer)) {
          const answerSorted = [...data.answer].sort((a, b) => a - b);
          const isCorrect = answerSorted.length === correctSorted.length &&
            answerSorted.every((val, idx) => val === correctSorted[idx]);
          points = isCorrect ? 100 : 0;
        }
        scores.set(participantId, points);
        rankings.push({ participantId, points, timestamp: data.timestamp });
      }
    } else if (question.type === 'estimation') {
      // Answers are guaranteed finite by validateAnswer(); the correct answer
      // comes from the quiz file, so guard against an author typo turning every
      // comparison into NaN (which would scramble the sort below).
      const correct = Number(question.correctAnswer);
      const entries = [];
      for (const [participantId, data] of this.currentAnswers) {
        const diff = Number.isFinite(correct)
          ? Math.abs(data.answer - correct)
          : Number.POSITIVE_INFINITY;
        entries.push({ participantId, diff, timestamp: data.timestamp });
      }

      // Sort by difference ascending, then by timestamp ascending
      entries.sort((a, b) => {
        if (a.diff !== b.diff) return a.diff - b.diff;
        return a.timestamp - b.timestamp;
      });

      const pointsTable = [100, 50, 25];
      entries.forEach((entry, index) => {
        const points = index < pointsTable.length ? pointsTable[index] : 0;
        scores.set(entry.participantId, points);
      });

      rankings.push(...entries.map((e, i) => ({
        participantId: e.participantId,
        points: scores.get(e.participantId),
        timestamp: e.timestamp
      })));
    }

    // Get leaderboard after this question
    const leaderboard = this.getLeaderboard();

    return { scores, rankings, leaderboard };
  }

  nextQuestion() {
    if (this.currentQuestionIndex < this.quiz.questions.length - 1) {
      this.currentQuestionIndex++;
      this.startQuestion();
      return true;
    }
    return false;
  }

  getLeaderboard() {
    const list = [];
    for (const [, p] of this.participants) {
      list.push({ id: p.id, name: p.name, score: p.score });
    }
    list.sort((a, b) => b.score - a.score);
    return list;
  }

  getCurrentQuestion() {
    if (this.currentQuestionIndex >= 0 && this.currentQuestionIndex < this.quiz.questions.length) {
      return this.quiz.questions[this.currentQuestionIndex];
    }
    return null;
  }

  getPublicQuestion() {
    const q = this.getCurrentQuestion();
    if (!q) return null;
    // Return question without correct answer
    const { correctIndices: _, correctAnswer: ___, ...publicQ } = q;
    return {
      ...publicQ,
      type: q.type,
      text: q.text,
      options: q.options || undefined,
      timeLimit: q.timeLimit || undefined
    };
  }

  broadcast(message, excludeWs = null) {
    const msg = JSON.stringify(message);
    for (const [ws] of this.participants) {
      if (ws !== excludeWs && ws.readyState === 1) {
        ws.send(msg);
      }
    }
    for (const ws of this.presenterWss) {
      if (ws !== excludeWs && ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }

  broadcastToParticipants(message, excludeWs = null) {
    const msg = JSON.stringify(message);
    for (const [ws] of this.participants) {
      if (ws !== excludeWs && ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }

  sendToPresenter(message) {
    const msg = JSON.stringify(message);
    for (const ws of this.presenterWss) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }

  getSummary() {
    return {
      roomId: this.roomId,
      title: this.quiz.title,
      state: this.state,
      participantCount: this.participants.size,
      currentQuestionIndex: this.currentQuestionIndex,
      totalQuestions: this.quiz.questions.length,
      createdAt: this.createdAt
    };
  }
}

/** Global ceiling on concurrent rooms; `create_room` is unauthenticated. */
const MAX_ROOMS = 500;

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> Room
    // presenterToken -> roomId of that presenter's single active room.
    // Deliberately NOT a Set: one active room per presenter is what makes
    // create-or-resume unambiguous, and it means there is no code path
    // anywhere that can enumerate rooms.
    this.activeRoomByToken = new Map();
    // Optional hook: called with the Room after it has been removed, whether by
    // expiry or explicitly. Lets the transport layer release per-client quotas
    // without this module knowing anything about connections.
    this.onRoomRemoved = null;
  }

  /**
   * Open a room for a presenter: resume theirs if one is still running,
   * otherwise create a new one.
   *
   * This is what makes a dropped WebSocket survivable. The presenter page
   * re-sends this on every reconnect, and previously each attempt minted a
   * fresh room with a fresh code -- so a brief network glitch silently
   * stranded every participant who had already joined. Resuming keeps the
   * room code, the scores and the participants intact.
   *
   * A room that has *ended* is not resumed; the next call starts a fresh one.
   *
   * @returns {{room: Room, resumed: boolean}}
   * @throws {Error} when the server is at capacity.
   */
  /**
   * The presenter's resumable room, if they have one.
   *
   * Returns undefined when there is nothing to resume, which is the caller's
   * signal that a genuinely new room is about to be created (and that the quiz
   * therefore needs sanitizing, and quotas checking).
   *
   * @returns {Room|undefined}
   */
  openRoomIfPresent(presenterToken) {
    const existingId = this.activeRoomByToken.get(presenterToken);
    if (existingId === undefined) return undefined;
    const existing = this.rooms.get(existingId);
    if (existing && existing.state !== 'ended') return existing;
    this.activeRoomByToken.delete(presenterToken);
    return undefined;
  }

  openRoom(presenterToken, quiz) {
    const existing = this.openRoomIfPresent(presenterToken);
    if (existing) return { room: existing, resumed: true };

    if (this.rooms.size >= MAX_ROOMS) {
      throw new Error('Server is at capacity');
    }

    const roomId = this.generateRoomId();
    const room = new Room(roomId, presenterToken, quiz);
    this.rooms.set(roomId, room);
    this.activeRoomByToken.set(presenterToken, roomId);
    return { room, resumed: false };
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.clearQuestionTimer();
    this.rooms.delete(roomId);
    if (this.activeRoomByToken.get(room.presenterToken) === roomId) {
      this.activeRoomByToken.delete(room.presenterToken);
    }
    if (typeof this.onRoomRemoved === 'function') this.onRoomRemoved(room);
  }

  /**
   * Discard expired rooms. Called periodically; returns the ids removed so the
   * caller can log them.
   */
  sweep(now = Date.now()) {
    const removed = [];
    for (const [roomId, room] of this.rooms) {
      if (room.isExpired(now)) {
        removed.push(roomId);
      }
    }
    for (const roomId of removed) this.removeRoom(roomId);
    return removed;
  }

  /**
   * Generate a room id that is not currently in use.
   *
   * Uses `crypto.randomInt` rather than `Math.random()`: the old version could
   * in principle hand out an id that was already taken, which would have
   * silently replaced a running room in the map.
   */
  generateRoomId() {
    // With a 32-character alphabet and 6 positions there are ~10^9 ids, so a
    // clash is already unlikely; the loop makes it impossible rather than
    // improbable. The length grows only in the pathological case.
    for (let length = ROOM_ID_LENGTH; length < ROOM_ID_LENGTH + 4; length++) {
      for (let attempt = 0; attempt < 1000; attempt++) {
        let id = '';
        for (let i = 0; i < length; i++) {
          id += ROOM_ID_ALPHABET[randomInt(0, ROOM_ID_ALPHABET.length)];
        }
        if (!this.rooms.has(id)) return id;
      }
    }
    throw new Error('Unable to allocate a room id');
  }

  hashPassword(password) {
    return createHash('sha256').update(password).digest('hex');
  }
}

export {
  Room,
  RoomManager,
  ROOM_ID_ALPHABET,
  EMPTY_ROOM_TTL_MS,
  ENDED_ROOM_TTL_MS,
  ABSOLUTE_ROOM_TTL_MS,
  MAX_ROOMS
};
