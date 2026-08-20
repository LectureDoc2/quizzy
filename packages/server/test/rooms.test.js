import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Room, RoomManager } from '../src/rooms.js';

describe('Room', () => {
  it('addParticipant returns a participant with an ID', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    const mockWs = { readyState: 1 };
    const p = room.addParticipant(mockWs, 'Alice');
    assert.ok(p.id);
    assert.strictEqual(p.name, 'Alice');
    assert.strictEqual(p.score, 0);
    assert.strictEqual(room.getParticipantCount(), 1);
  });

  it('removeParticipant removes the correct participant', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    const mockWs1 = { readyState: 1 };
    const mockWs2 = { readyState: 1 };
    const p1 = room.addParticipant(mockWs1, 'Alice');
    const p2 = room.addParticipant(mockWs2, 'Bob');
    assert.strictEqual(room.getParticipantCount(), 2);
    const removed = room.removeParticipant(mockWs1);
    assert.strictEqual(removed.id, p1.id);
    assert.strictEqual(room.getParticipantCount(), 1);
  });

  it('getParticipantById finds the correct participant', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    const mockWs = { readyState: 1 };
    const p = room.addParticipant(mockWs, 'Alice');
    const found = room.getParticipantById(p.id);
    assert.strictEqual(found.id, p.id);
    assert.strictEqual(room.getParticipantById('nonexistent'), null);
  });

  it('startGame initializes the first question', () => {
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    const room = new Room('ABC123', 'token', quiz);
    room.startGame();
    assert.strictEqual(room.state, 'question');
    assert.strictEqual(room.currentQuestionIndex, 0);
    assert.ok(room.currentQuestionStartTime);
  });

  it('startQuestion resets answers and start time', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    room.startQuestion();
    assert.strictEqual(room.currentAnswers.size, 0);
    assert.strictEqual(room.state, 'question');
    assert.ok(room.currentQuestionStartTime);
  });

  it('submitAnswer accepts only during question state', () => {
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    const room = new Room('ABC123', 'token', quiz);
    const mockWs = { readyState: 1 };
    const p = room.addParticipant(mockWs, 'Alice');

    // Before game starts
    assert.strictEqual(room.submitAnswer(p.id, [0]), false);

    room.startGame();
    assert.strictEqual(room.submitAnswer(p.id, [0]), true);

    // Duplicate answer
    assert.strictEqual(room.submitAnswer(p.id, [0]), false);

    // After question ends
    room.endQuestion();
    assert.strictEqual(room.submitAnswer(p.id, [0]), false);
  });

  it('submitAnswer auto-ends when all participants answered', () => {
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    const room = new Room('ABC123', 'token', quiz);
    let autoEndCalled = false;
    room.onAutoEnd = (results) => {
      autoEndCalled = true;
    };
    const ws1 = { readyState: 1 };
    const ws2 = { readyState: 1 };
    const p1 = room.addParticipant(ws1, 'Alice');
    const p2 = room.addParticipant(ws2, 'Bob');

    room.startGame();
    room.submitAnswer(p1.id, [0]);
    assert.strictEqual(room.state, 'question');
    room.submitAnswer(p2.id, [1]);
    assert.strictEqual(room.state, 'results');
    assert.strictEqual(autoEndCalled, true);
  });

  it('time limit auto-ends question', async () => {
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0], timeLimit: 0.05 }] };
    const room = new Room('ABC123', 'token', quiz);
    let autoEndCalled = false;
    room.onAutoEnd = (results) => {
      autoEndCalled = true;
    };
    room.addParticipant({ readyState: 1 }, 'Alice');

    room.startGame();
    assert.strictEqual(room.state, 'question');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(room.state, 'results');
    assert.strictEqual(autoEndCalled, true);
  });

  it('endQuestion is idempotent', () => {
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    const room = new Room('ABC123', 'token', quiz);
    const ws1 = { readyState: 1 };
    const p1 = room.addParticipant(ws1, 'Alice');

    room.startGame();
    room.submitAnswer(p1.id, [0]);
    const results1 = room.endQuestion();
    const results2 = room.endQuestion();
    assert.strictEqual(results1.scores.get(p1.id), 100);
    assert.strictEqual(results2.scores.get(p1.id), 100);
    assert.strictEqual(results1.leaderboard[0].score, 100);
    assert.strictEqual(results2.leaderboard[0].score, 100);
  });

  it('scoreQuestion multiple-choice: correct gets 100, wrong gets 0', () => {
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    const room = new Room('ABC123', 'token', quiz);
    const ws1 = { readyState: 1 };
    const ws2 = { readyState: 1 };
    const p1 = room.addParticipant(ws1, 'Alice');
    const p2 = room.addParticipant(ws2, 'Bob');

    room.startGame();
    room.submitAnswer(p1.id, [0]); // correct
    room.submitAnswer(p2.id, [1]); // wrong

    const results = room.endQuestion();
    assert.strictEqual(results.scores.get(p1.id), 100);
    assert.strictEqual(results.scores.get(p2.id), 0);
    assert.strictEqual(results.leaderboard[0].name, 'Alice');
    assert.strictEqual(results.leaderboard[0].score, 100);
    assert.strictEqual(results.leaderboard[1].name, 'Bob');
    assert.strictEqual(results.leaderboard[1].score, 0);
  });

  it('scoreQuestion estimation: rank-based scoring (100/50/25/0)', () => {
    const quiz = { title: 'Test', questions: [{ type: 'estimation', text: 'Estimate', correctAnswer: 100, timeLimit: 30 }] };
    const room = new Room('ABC123', 'token', quiz);
    const ws1 = { readyState: 1 };
    const ws2 = { readyState: 1 };
    const ws3 = { readyState: 1 };
    const ws4 = { readyState: 1 };
    const p1 = room.addParticipant(ws1, 'A');
    const p2 = room.addParticipant(ws2, 'B');
    const p3 = room.addParticipant(ws3, 'C');
    const p4 = room.addParticipant(ws4, 'D');
    
    room.startGame();
    room.submitAnswer(p1.id, 100); // exact
    room.submitAnswer(p2.id, 102); // diff 2
    room.submitAnswer(p3.id, 95);  // diff 5
    room.submitAnswer(p4.id, 200); // diff 100
    
    const results = room.endQuestion();
    assert.strictEqual(results.scores.get(p1.id), 100);
    assert.strictEqual(results.scores.get(p2.id), 50);
    assert.strictEqual(results.scores.get(p3.id), 25);
    assert.strictEqual(results.scores.get(p4.id), 0);
  });

  it('scoreQuestion estimation: tie-breaker uses earliest timestamp', () => {
    const quiz = { title: 'Test', questions: [{ type: 'estimation', text: 'Estimate', correctAnswer: 100, timeLimit: 30 }] };
    const room = new Room('ABC123', 'token', quiz);
    const ws1 = { readyState: 1 };
    const ws2 = { readyState: 1 };
    const p1 = room.addParticipant(ws1, 'Alice');
    const p2 = room.addParticipant(ws2, 'Bob');
    
    room.startGame();
    room.submitAnswer(p1.id, 100);
    room.submitAnswer(p2.id, 100);
    
    const results = room.endQuestion();
    // Both are equally close, but Alice submitted first
    assert.strictEqual(results.scores.get(p1.id), 100);
    assert.strictEqual(results.scores.get(p2.id), 50);
  });

  it('nextQuestion advances the game', () => {
    const quiz = { title: 'Test', questions: [
      { type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] },
      { type: 'multiple-choice', text: 'Q2', options: ['A', 'B'], correctIndices: [0] }
    ] };
    const room = new Room('ABC123', 'token', quiz);
    room.startGame();
    assert.strictEqual(room.currentQuestionIndex, 0);
    room.endQuestion();
    assert.strictEqual(room.nextQuestion(), true);
    assert.strictEqual(room.currentQuestionIndex, 1);
    assert.strictEqual(room.nextQuestion(), false);
    assert.strictEqual(room.currentQuestionIndex, 1);
  });

  it('getLeaderboard sorts by score descending', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    const ws1 = { readyState: 1 };
    const ws2 = { readyState: 1 };
    const ws3 = { readyState: 1 };
    const p1 = room.addParticipant(ws1, 'Alice');
    const p2 = room.addParticipant(ws2, 'Bob');
    const p3 = room.addParticipant(ws3, 'Charlie');
    p1.score = 100;
    p2.score = 50;
    p3.score = 200;
    const lb = room.getLeaderboard();
    assert.strictEqual(lb[0].name, 'Charlie');
    assert.strictEqual(lb[1].name, 'Alice');
    assert.strictEqual(lb[2].name, 'Bob');
  });

  it('getPublicQuestion strips correct answer', () => {
    const quiz = { title: 'Test', questions: [
      { type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0], correctAnswer: 42, timeLimit: 30 }
    ] };
    const room = new Room('ABC123', 'token', quiz);
    room.startGame();
    const pub = room.getPublicQuestion();
    assert.strictEqual(pub.text, 'Q1');
    assert.strictEqual(pub.type, 'multiple-choice');
    assert.deepStrictEqual(pub.options, ['A', 'B']);
    assert.strictEqual(pub.timeLimit, 30);
    assert.strictEqual(pub.correctIndices, undefined);
    assert.strictEqual(pub.correctAnswer, undefined);
  });

  it('sendToPresenter sends to the presenter websocket', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    let sent = null;
    const mockWs = {
      readyState: 1,
      send: (data) => { sent = JSON.parse(data); }
    };
    room.addPresenter(mockWs);
    room.sendToPresenter({ type: 'test' });
    assert.deepStrictEqual(sent, { type: 'test' });
  });

  it('sendToPresenter sends to all presenter websockets', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    const messages = [];
    const mockPresenter1 = {
      readyState: 1,
      send: (data) => { messages.push(JSON.parse(data)); }
    };
    const mockPresenter2 = {
      readyState: 1,
      send: (data) => { messages.push(JSON.parse(data)); }
    };
    room.addPresenter(mockPresenter1);
    room.addPresenter(mockPresenter2);
    room.sendToPresenter({ type: 'test' });
    assert.strictEqual(messages.length, 2);
    assert.deepStrictEqual(messages[0], { type: 'test' });
    assert.deepStrictEqual(messages[1], { type: 'test' });
  });

  it('broadcast sends to all participants and presenter', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    const messages = [];
    const mockWs1 = { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
    const mockWs2 = { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
    const mockPresenter = { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
    
    room.addParticipant(mockWs1, 'Alice');
    room.addParticipant(mockWs2, 'Bob');
    room.addPresenter(mockPresenter);
    room.broadcast({ type: 'hello' });
    
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[0].type, 'hello');
    assert.strictEqual(messages[1].type, 'hello');
    assert.strictEqual(messages[2].type, 'hello');
  });

  it('broadcast excludes the specified websocket', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    const messages = [];
    const mockWs1 = { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
    const mockWs2 = { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
    
    room.addParticipant(mockWs1, 'Alice');
    room.addParticipant(mockWs2, 'Bob');
    room.broadcast({ type: 'hello' }, mockWs1);
    
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'hello');
  });

  it('broadcastToParticipants sends only to participants', () => {
    const room = new Room('ABC123', 'token', { title: 'Test', questions: [] });
    const messages = [];
    const mockWs1 = { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
    const mockPresenter = { readyState: 1, send: (d) => messages.push(JSON.parse(d)) };
    
    room.addParticipant(mockWs1, 'Alice');
    room.addPresenter(mockPresenter);
    room.broadcastToParticipants({ type: 'hello' });
    
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, 'hello');
  });

  it('getSummary returns a clean object', () => {
    const room = new Room('ABC123', 'token', { title: 'My Quiz', questions: [1, 2, 3] });
    room.addParticipant({ readyState: 1 }, 'Alice');
    const summary = room.getSummary();
    assert.strictEqual(summary.roomId, 'ABC123');
    assert.strictEqual(summary.title, 'My Quiz');
    assert.strictEqual(summary.state, 'lobby');
    assert.strictEqual(summary.participantCount, 1);
    assert.strictEqual(summary.totalQuestions, 3);
    assert.ok(summary.createdAt);
  });

  it('scoreQuestion multi-select: exact match gets 100, partial or wrong gets 0', () => {
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B', 'C', 'D'], correctIndices: [0, 2] }] };
    const room = new Room('ABC123', 'token', quiz);
    const ws1 = { readyState: 1 };
    const ws2 = { readyState: 1 };
    const ws3 = { readyState: 1 };
    const ws4 = { readyState: 1 };
    const p1 = room.addParticipant(ws1, 'Alice');
    const p2 = room.addParticipant(ws2, 'Bob');
    const p3 = room.addParticipant(ws3, 'Charlie');
    const p4 = room.addParticipant(ws4, 'Diana');

    room.startGame();
    room.submitAnswer(p1.id, [0, 2]); // exact match
    room.submitAnswer(p2.id, [0, 1]); // partial (one wrong)
    room.submitAnswer(p3.id, [1, 3]); // completely wrong
    room.submitAnswer(p4.id, []); // empty

    const results = room.endQuestion();
    assert.strictEqual(results.scores.get(p1.id), 100);
    assert.strictEqual(results.scores.get(p2.id), 0);
    assert.strictEqual(results.scores.get(p3.id), 0);
    assert.strictEqual(results.scores.get(p4.id), 0);
  });
});

describe('RoomManager', () => {
  it('createRoom generates a unique room ID', () => {
    const manager = new RoomManager();
    const room1 = manager.createRoom('token1', { title: 'Q1', questions: [] });
    const room2 = manager.createRoom('token1', { title: 'Q2', questions: [] });
    assert.notStrictEqual(room1.roomId, room2.roomId);
    assert.ok(room1.roomId);
    assert.ok(room2.roomId);
  });

  it('getRoom returns the correct room', () => {
    const manager = new RoomManager();
    const room = manager.createRoom('token1', { title: 'Q1', questions: [] });
    assert.strictEqual(manager.getRoom(room.roomId), room);
    assert.strictEqual(manager.getRoom('nonexistent'), undefined);
  });

  it('getPresenterRooms returns only that presenter rooms', () => {
    const manager = new RoomManager();
    manager.createRoom('token1', { title: 'Q1', questions: [] });
    manager.createRoom('token1', { title: 'Q2', questions: [] });
    manager.createRoom('token2', { title: 'Q3', questions: [] });
    const rooms = manager.getPresenterRooms('token1');
    assert.strictEqual(rooms.length, 2);
    assert.strictEqual(rooms[0].title, 'Q1');
    assert.strictEqual(rooms[1].title, 'Q2');
  });

  it('removeRoom cleans up both maps', () => {
    const manager = new RoomManager();
    const room = manager.createRoom('token1', { title: 'Q1', questions: [] });
    manager.removeRoom(room.roomId);
    assert.strictEqual(manager.getRoom(room.roomId), undefined);
    assert.strictEqual(manager.getPresenterRooms('token1').length, 0);
  });

  it('hashPassword is deterministic', () => {
    const manager = new RoomManager();
    const h1 = manager.hashPassword('test');
    const h2 = manager.hashPassword('test');
    const h3 = manager.hashPassword('other');
    assert.strictEqual(h1, h2);
    assert.notStrictEqual(h1, h3);
    assert.strictEqual(h1.length, 64); // SHA-256 hex
  });
});
