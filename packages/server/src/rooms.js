import { createHash } from 'crypto';

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
  }

  addParticipant(ws, name) {
    const id = `p_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const participant = { id, name, score: 0, answers: [] };
    this.participants.set(ws, participant);
    return participant;
  }

  removeParticipant(ws) {
    const participant = this.participants.get(ws);
    if (participant) {
      this.participants.delete(ws);
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
  }

  removePresenter(ws) {
    this.presenterWss.delete(ws);
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

  submitAnswer(participantId, answer) {
    if (this.state !== 'question') return false;
    if (this.currentAnswers.has(participantId)) return false;

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

    // Recalculate leaderboard after score updates
    results.leaderboard = this.getLeaderboard();
    this.state = 'results';
    return results;
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
      const entries = [];
      for (const [participantId, data] of this.currentAnswers) {
        const diff = Math.abs(data.answer - question.correctAnswer);
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

class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> Room
    this.presenterRooms = new Map(); // presenterToken -> Set(roomId)
  }

  createRoom(presenterToken, quiz) {
    const roomId = this.generateRoomId();
    const room = new Room(roomId, presenterToken, quiz);
    this.rooms.set(roomId, room);

    if (!this.presenterRooms.has(presenterToken)) {
      this.presenterRooms.set(presenterToken, new Set());
    }
    this.presenterRooms.get(presenterToken).add(roomId);

    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  getPresenterRooms(presenterToken) {
    const roomIds = this.presenterRooms.get(presenterToken);
    if (!roomIds) return [];
    return Array.from(roomIds)
      .map(id => this.rooms.get(id))
      .filter(r => r !== undefined)
      .map(r => r.getSummary());
  }

  removeRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (room) {
      this.rooms.delete(roomId);
      if (this.presenterRooms.has(room.presenterToken)) {
        this.presenterRooms.get(room.presenterToken).delete(roomId);
      }
    }
  }

  generateRoomId() {
    return Math.random().toString(36).substr(2, 6).toUpperCase();
  }

  hashPassword(password) {
    return createHash('sha256').update(password).digest('hex');
  }
}

export { Room, RoomManager };
