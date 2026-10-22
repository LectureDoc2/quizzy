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
 * Deliberately shorter than EMPTY_ROOM_TTL_MS above: once the last socket
 * closes, nothing can read the room again -- there is no room listing, no
 * persistence, and a process restart discards it anyway -- so a longer window
 * buys nothing and only widens the memory that an unauthenticated
 * `create_room` can pin down. An empty room that is still running is the
 * opposite case, and is what the ninety minutes above pay for: its presenter
 * is expected back. Fifteen minutes is enough for a presenter whose laptop
 * slept as the lecture broke up to reattach and export, and no longer. If the
 * final results need to outlive the lecture, export them from the control view
 * rather than holding participant data in RAM.
 */
const ENDED_ROOM_TTL_MS =
  Number(process.env.ENDED_ROOM_RETENTION_MINUTES || 15) * 60 * 1000;

/** Backstop: no room outlives this, whatever its state or connections. */
const ABSOLUTE_ROOM_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

/**
 * How long a participant whose connection dropped can still come back as
 * themselves -- same name, same score, same answers -- by presenting their
 * resume token.
 *
 * This is a data-protection knob as much as a memory one: for this long after
 * a socket closes, the name and score of somebody who is no longer connected
 * are still held in RAM. Fifteen minutes is enough to walk out of a wifi
 * shadow, reload a tab, or have an iOS tab discarded and restored, and it is
 * the same shape and default as ENDED_ROOM_RETENTION_MINUTES. The room's own
 * TTLs above remain the outer bound.
 */
const DETACHED_TTL_MS =
  Number(process.env.DETACHED_RETENTION_MINUTES || 15) * 60 * 1000;

/**
 * Detached participants are capped, so that a join-drop-join loop cannot grow
 * the map without bound inside the retention window. Sized relative to the
 * room's peak attendance -- a hall-wide wifi drop detaches everybody at once
 * and must not evict anybody -- with a floor for small rooms.
 */
const DETACHED_CAP_FACTOR = 3;
const DETACHED_CAP_MIN = 30;

/**
 * How a practice estimate scores. Estimation is normally ranked against the
 * rest of the room, which alone is meaningless -- the only estimate is always
 * the closest -- so a practice game scores the relative error instead, on the
 * same 100/50/25 scale the ranking uses.
 */
const PRACTICE_ESTIMATION_BANDS = [
  { within: 10, points: 100 },
  { within: 25, points: 50 },
  { within: 50, points: 25 }
];

/**
 * The band a practice estimate falls into, or null when it is further off than
 * the widest one. A correct answer of zero has no relative error, so only an
 * exact answer scores there.
 */
function practiceEstimationBand(answer, correctAnswer) {
  const correct = Number(correctAnswer);
  if (!Number.isFinite(correct) || !Number.isFinite(answer)) return null;
  if (correct === 0) return answer === 0 ? PRACTICE_ESTIMATION_BANDS[0] : null;
  const difference = Math.abs(answer - correct);
  // The tolerance keeps an answer of exactly 10 % off inside the 10 % band;
  // 92.4 - 84 is 8.400000000000006 in floating point.
  return PRACTICE_ESTIMATION_BANDS.find(
    (band) => difference <= Math.abs(correct) * (band.within / 100) * (1 + 1e-9)
  ) ?? null;
}

class Room {
  constructor(roomId, presenterToken, quiz) {
    this.roomId = roomId;
    this.presenterToken = presenterToken;
    this.quiz = quiz;
    this.participants = new Map(); // ws -> { name, id, answers: [], score }
    // Participants whose socket closed, kept for DETACHED_TTL_MS so that they
    // can come back as themselves. Insertion order is detach order, which is
    // what the cap evicts by. See detachParticipant().
    this.detached = new Map(); // participantId -> { participant, detachedAt }
    // The resume credential. Kept here rather than on the participant record,
    // because that record is what leaderboards and participant lists are built
    // from -- a token stored on it would be one careless spread away from being
    // broadcast to the whole room. participantId cannot double as the
    // credential for exactly that reason: it *is* broadcast.
    this.resumeTokens = new Map(); // resumeToken -> participantId
    this.resumeTokenById = new Map(); // participantId -> resumeToken
    this.peakParticipants = 0;
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
    // A practice game is one student and no presenter: the server moves it on
    // by itself. See RoomManager.openPracticeRoom().
    this.practice = false;
    // Practice only: moves a practice game from a results screen to the next
    // question. Armed by the transport layer, which knows who is connected;
    // `advanceAt` is when it fires, for the countdown on the results screen.
    this.advanceTimer = null;
    this.advanceAt = null;
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
    // Nobody but its one student can ever reach a practice game, and their
    // resume token expires after DETACHED_TTL_MS; past that the room is dead
    // weight, whatever state it is in.
    const ttl = this.practice
      ? DETACHED_TTL_MS
      : this.state === 'ended' ? ENDED_ROOM_TTL_MS : EMPTY_ROOM_TTL_MS;
    return now - this.emptySince >= ttl;
  }

  addParticipant(ws, name) {
    const id = `p_${Date.now()}_${randomBytes(9).toString('base64url')}`;
    const participant = { id, name, score: 0, answers: [] };
    const resumeToken = randomBytes(32).toString('base64url');
    this.participants.set(ws, participant);
    this.resumeTokens.set(resumeToken, id);
    this.resumeTokenById.set(id, resumeToken);
    this.peakParticipants = Math.max(this.peakParticipants, this.participants.size);
    this.updateEmptySince();
    return participant;
  }

  /**
   * The secret that lets this participant reattach after a dropped connection.
   * Sent once, to its owner, in `joined`; never broadcast and never logged.
   */
  resumeTokenFor(participantId) {
    return this.resumeTokenById.get(participantId);
  }

  /**
   * Remove a participant for good: no record, no resume token, no way back.
   * For a deliberate exit; a dropped connection goes through
   * detachParticipant() instead.
   */
  removeParticipant(ws) {
    const participant = this.participants.get(ws);
    if (participant) {
      this.participants.delete(ws);
      this.forgetResumeToken(participant.id);
      this.updateEmptySince();
      return participant;
    }
    return null;
  }

  /**
   * A participant's socket closed: keep them, unconnected, so they can come
   * back with their score intact.
   *
   * Deleting the record here -- which is what used to happen -- made every
   * wifi hiccup cost the student their place in the quiz, irreversibly, even
   * though the page that could have reconnected was still loaded.
   *
   * Detached participants are deliberately absent from `participants`, so
   * everything that is about who is *present* -- the awaited-answer count that
   * auto-ends a question, the connection count that drives room expiry --
   * ignores them without further code. A question must never be held open for
   * somebody whose phone is in a lift.
   *
   * @returns {object|null} The participant, or null if `ws` was not one.
   */
  detachParticipant(ws, now = Date.now()) {
    const participant = this.participants.get(ws);
    if (!participant) return null;
    this.participants.delete(ws);
    this.detached.set(participant.id, { participant, detachedAt: now });
    this.enforceDetachedCap();
    this.updateEmptySince(now);
    return participant;
  }

  /**
   * Put the participant holding `resumeToken` back in the room, on `ws`.
   *
   * Normally they are found among the detached. They may instead still be
   * attached to an old socket that the server has not yet noticed is dead --
   * the heartbeat takes up to two intervals to give up on a half-open
   * connection -- or to another tab that holds the same token. Either way the
   * newest connection wins, and the caller is handed the superseded socket so
   * it can be closed.
   *
   * The record moves to the new socket *before* the caller closes the old one,
   * which matters: the old socket's close would otherwise detach the
   * participant who has just come back.
   *
   * @returns {{participant: object, supersededWs: object|null}|null} null when
   *   the token is unknown, expired, or not a string.
   */
  reattachParticipant(resumeToken, ws, now = Date.now()) {
    if (typeof resumeToken !== 'string') return null;
    const id = this.resumeTokens.get(resumeToken);
    if (id === undefined) return null;

    let participant = null;
    let supersededWs = null;
    const entry = this.detached.get(id);
    if (entry) {
      // Checked here as well as in the sweep, which runs only every few minutes.
      if (now - entry.detachedAt >= DETACHED_TTL_MS) {
        this.purgeParticipant(id);
        return null;
      }
      this.detached.delete(id);
      participant = entry.participant;
    } else {
      for (const [oldWs, p] of this.participants) {
        if (p.id === id) {
          supersededWs = oldWs;
          participant = p;
          break;
        }
      }
      if (!participant) return null;
      this.participants.delete(supersededWs);
    }

    this.participants.set(ws, participant);
    this.peakParticipants = Math.max(this.peakParticipants, this.participants.size);
    this.updateEmptySince(now);
    return { participant, supersededWs };
  }

  /**
   * Forget a participant entirely, connected or not. A kick goes through here,
   * so that it cannot be undone by reconnecting.
   *
   * @returns {boolean} whether there was anybody to forget.
   */
  purgeParticipant(id) {
    let found = this.detached.delete(id);
    for (const [ws, p] of this.participants) {
      if (p.id === id) {
        this.participants.delete(ws);
        found = true;
        break;
      }
    }
    this.forgetResumeToken(id);
    this.updateEmptySince();
    return found;
  }

  forgetResumeToken(id) {
    const token = this.resumeTokenById.get(id);
    if (token === undefined) return;
    this.resumeTokenById.delete(id);
    this.resumeTokens.delete(token);
  }

  /** Drop detached participants who have been gone longer than the TTL. */
  sweepDetached(now = Date.now()) {
    const expired = [];
    for (const [id, entry] of this.detached) {
      if (now - entry.detachedAt >= DETACHED_TTL_MS) expired.push(id);
    }
    for (const id of expired) this.purgeParticipant(id);
    return expired.length;
  }

  detachedCap() {
    return Math.max(DETACHED_CAP_MIN, DETACHED_CAP_FACTOR * this.peakParticipants);
  }

  enforceDetachedCap() {
    const cap = this.detachedCap();
    while (this.detached.size > cap) {
      const oldest = this.detached.keys().next().value;
      this.purgeParticipant(oldest);
    }
  }

  getParticipantById(id) {
    for (const [, p] of this.participants) {
      if (p.id === id) return p;
    }
    // Somebody who answered and then dropped must still be scored for that
    // answer: endQuestion() credits points through this lookup.
    const entry = this.detached.get(id);
    return entry ? entry.participant : null;
  }

  /** Participants currently connected. Detached ones are not counted. */
  getParticipantCount() {
    return this.participants.size;
  }

  /** Participants whose connection dropped and who may still come back. */
  getReconnectingCount() {
    return this.detached.size;
  }

  /**
   * Everybody the presenter should know about, with whether they are
   * connected right now. Never includes the resume token.
   */
  getParticipantList() {
    const list = [];
    for (const [, p] of this.participants) {
      list.push({ id: p.id, name: p.name, score: p.score, connected: true });
    }
    for (const [, { participant: p }] of this.detached) {
      list.push({ id: p.id, name: p.name, score: p.score, connected: false });
    }
    return list;
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
        /* This callback runs on the event loop with no caller to catch it, so
           anything thrown here reaches the process and Node exits -- taking
           every other room on the host with it. Quizzes are validated before a
           room is created (see quiz-validator.js), which should make a throw
           here impossible; this is the guard that keeps "should" from being
           load-bearing. */
        try {
          this.autoEndQuestion();
        } catch (err) {
          console.error(`auto-ending a question in room ${this.roomId} failed:`, err);
        }
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

    // Close the question as soon as nobody who is still in the room is being
    // waited for. Comparing currentAnswers.size against participants.size was
    // wrong in one direction that never healed: a participant leaves
    // `participants` the instant their socket closes (they are detached, see
    // detachParticipant()), but their answer stays in currentAnswers, so after any mid-question disconnect the two counts
    // could not become equal again and the presenter had to end every
    // remaining question by hand. Counting who has *not* answered instead
    // ignores answers from people who have left, which is the intent.
    //
    // The emptiness check stays: a question with nobody in the room must not
    // close itself, or a stray answer -- or a room whose last participant
    // dropped -- would silently advance the quiz behind the presenter's back.
    if (this.participants.size > 0 && this.countAwaitedAnswers() === 0) {
      this.clearQuestionTimer();
      this.autoEndQuestion();
    }

    return true;
  }

  /**
   * How many connected participants have yet to answer the current question.
   *
   * Deliberately derived from `participants` rather than from a counter kept
   * alongside it: participants come and go mid-question, and a counter would
   * have to be corrected on every join, leave and answer to stay honest.
   */
  countAwaitedAnswers() {
    let awaited = 0;
    for (const [, participant] of this.participants) {
      if (!this.currentAnswers.has(participant.id)) awaited++;
    }
    return awaited;
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
   * the end, because participants do not stay in the room forever once their
   * socket drops -- a detached participant is purged after DETACHED_TTL_MS:
   * anyone who shuts their laptop before the last question would
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

  clearAdvanceTimer() {
    if (this.advanceTimer) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
    this.advanceAt = null;
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
    const ranks = new Map(); // estimation only: participantId -> 1-based place

    if (question.type === 'multiple-choice') {
      /* Guarded like the identical read in getQuestionStatistics. Validation
         makes this unreachable for any quiz that created a room, but scoring is
         reached from a timer, and an unguarded spread on a missing field is
         exactly how this used to become a process exit. */
      const correctSorted = [...(question.correctIndices || [])].sort((a, b) => a - b);
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
    } else if (question.type === 'estimation' && this.practice) {
      // Nobody to rank against; see PRACTICE_ESTIMATION_BANDS.
      for (const [participantId, data] of this.currentAnswers) {
        const band = practiceEstimationBand(data.answer, question.correctAnswer);
        const points = band ? band.points : 0;
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

      entries.forEach((entry, index) => ranks.set(entry.participantId, index + 1));

      rankings.push(...entries.map((e, i) => ({
        participantId: e.participantId,
        points: scores.get(e.participantId),
        timestamp: e.timestamp
      })));
    }

    // Get leaderboard after this question
    const leaderboard = this.getLeaderboard();

    return { scores, rankings, ranks, leaderboard };
  }

  /**
   * How one participant did on the question that just closed, for their own
   * results screen.
   *
   * Deliberately the minimum: the question itself (so it can be shown again),
   * the participant's own answer, and a verdict -- right or wrong, or for an
   * estimate how it ranked among everybody's (in a practice game, which band
   * of relative error it fell into and what that scored). It never carries the correct
   * answer (revealing it is the presenter's call, on the projector), the
   * distance to it (which together with one's own answer *is* the correct
   * answer), or anything about another participant beyond a count.
   *
   * @param {string} participantId
   * @param {{scores: Map, ranks: Map}} results scoreQuestion()'s result for the
   *   current question; passed in so a room full of participants is scored
   *   once, not once per participant.
   */
  getAnswerFeedback(participantId, results) {
    const question = this.getCurrentQuestion();
    if (!question) return null;

    const submitted = this.currentAnswers.get(participantId);
    const feedback = {
      // Whitelisted rather than getPublicQuestion(): that one passes through
      // whatever else the quiz author put on the question.
      question: {
        type: question.type,
        text: question.text,
        options: Array.isArray(question.options) ? question.options : undefined
      },
      answered: submitted !== undefined,
      answer: submitted?.answer ?? null
    };

    if (question.type === 'multiple-choice') {
      feedback.isCorrect = feedback.answered && (results.scores.get(participantId) || 0) > 0;
    } else if (question.type === 'estimation' && this.practice) {
      // The band, never the distance or its direction: either of those, next
      // to one's own answer, would give the correct answer away.
      const band = feedback.answered
        ? practiceEstimationBand(submitted.answer, question.correctAnswer)
        : null;
      feedback.band = band ? band.within : null;
      feedback.points = band ? band.points : 0;
    } else if (question.type === 'estimation') {
      feedback.answerCount = results.ranks.size;
      // A meaningless rank when the quiz's correct answer is unusable; see
      // scoreQuestion().
      feedback.rank = feedback.answered && Number.isFinite(Number(question.correctAnswer))
        ? results.ranks.get(participantId) ?? null
        : null;
    }

    return feedback;
  }

  nextQuestion() {
    if (this.currentQuestionIndex < this.quiz.questions.length - 1) {
      this.currentQuestionIndex++;
      this.startQuestion();
      return true;
    }
    return false;
  }

  /**
   * Everybody's score, including participants who are reconnecting.
   *
   * Including them is deliberate, and the same argument as the one made for
   * recordQuestionStatistics(): otherwise somebody whose phone drops for ten
   * seconds vanishes from the board and every rank below theirs jumps, then
   * jumps back when they return. Nothing here says who is offline -- this list
   * goes to every participant.
   */
  getLeaderboard() {
    const list = [];
    for (const [, p] of this.participants) {
      list.push({ id: p.id, name: p.name, score: p.score });
    }
    for (const [, { participant: p }] of this.detached) {
      list.push({ id: p.id, name: p.name, score: p.score });
    }
    list.sort((a, b) => b.score - a.score);
    return list;
  }

  /**
   * A practice game's final tally for its one student. "Correct" means full
   * points: a right multiple-choice answer, or an estimate within the closest
   * band.
   */
  getPracticeSummary() {
    const participant = this.participants.values().next().value
      ?? this.detached.values().next().value?.participant;
    const answers = participant ? participant.answers : [];
    return {
      score: participant ? participant.score : 0,
      maxScore: this.quiz.questions.length * 100,
      correct: answers.filter((a) => a.points === 100).length,
      total: this.quiz.questions.length
    };
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

/**
 * Global ceiling on concurrent practice games, counted apart from MAX_ROOMS so
 * that students practising can never stop a lecture from opening a room. Higher
 * because a practice room is small: its quiz is shared with the catalog.
 */
const MAX_PRACTICE_ROOMS = 2000;

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
    // How many of `rooms` are practice games; see openPracticeRoom().
    this.practiceRoomCount = 0;
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

    if (this.rooms.size - this.practiceRoomCount >= MAX_ROOMS) {
      throw new Error('Server is at capacity');
    }

    const roomId = this.generateRoomId();
    const room = new Room(roomId, presenterToken, quiz);
    this.rooms.set(roomId, room);
    this.activeRoomByToken.set(presenterToken, roomId);
    return { room, resumed: false };
  }

  /**
   * Open a practice game: a room for one student, with no presenter.
   *
   * The presenter token is random and never registered in activeRoomByToken,
   * so no `control_connect` can match it and no `create_room` can resume it.
   * `quiz` is the catalog's frozen copy, shared with every other game of it.
   *
   * @returns {Room}
   * @throws {Error} when MAX_PRACTICE_ROOMS games are already running.
   */
  openPracticeRoom(quiz) {
    if (this.practiceRoomCount >= MAX_PRACTICE_ROOMS) {
      throw new Error('Server is at capacity');
    }
    const room = new Room(this.generateRoomId(), randomBytes(32).toString('base64url'), quiz);
    room.practice = true;
    this.rooms.set(room.roomId, room);
    this.practiceRoomCount++;
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.clearQuestionTimer();
    room.clearAdvanceTimer();
    this.rooms.delete(roomId);
    if (room.practice) this.practiceRoomCount--;
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
      } else {
        room.sweepDetached(now);
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
  DETACHED_TTL_MS,
  DETACHED_CAP_MIN,
  MAX_ROOMS,
  MAX_PRACTICE_ROOMS,
  PRACTICE_ESTIMATION_BANDS,
  practiceEstimationBand
};
