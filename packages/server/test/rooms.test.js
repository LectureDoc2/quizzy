import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  Room,
  RoomManager,
  EMPTY_ROOM_TTL_MS,
  ENDED_ROOM_TTL_MS,
  ABSOLUTE_ROOM_TTL_MS,
  DETACHED_TTL_MS,
  DETACHED_CAP_MIN,
  MAX_ROOMS
} from '../src/rooms.js';

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

  it('still auto-ends after a participant answers and then disconnects', () => {
    // The failure this pins down was permanent rather than momentary: the
    // answer of somebody who has left stayed in currentAnswers while they
    // left participants, so the two counts could never meet again and every
    // remaining question of that lecture had to be ended by hand.
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    const room = new Room('ABC123', 'token', quiz);
    let autoEndCalled = false;
    room.onAutoEnd = () => {
      autoEndCalled = true;
    };
    const ws1 = { readyState: 1 };
    const ws2 = { readyState: 1 };
    const p1 = room.addParticipant(ws1, 'Alice');
    const p2 = room.addParticipant(ws2, 'Bob');

    room.startGame();
    room.submitAnswer(p1.id, [0]);
    assert.strictEqual(room.state, 'question');
    room.removeParticipant(ws1); // Alice shuts her laptop

    room.submitAnswer(p2.id, [1]);
    assert.strictEqual(room.state, 'results');
    assert.strictEqual(autoEndCalled, true);
  });

  it('never auto-ends a question that nobody is present for', () => {
    // An answer can outlive its author -- see the test above -- so 'everybody
    // has answered' must not be read as true of an empty room, which would
    // close the question behind the presenter's back.
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] }] };
    const room = new Room('ABC123', 'token', quiz);
    let autoEndCalled = false;
    room.onAutoEnd = () => {
      autoEndCalled = true;
    };
    const ws1 = { readyState: 1 };
    const p1 = room.addParticipant(ws1, 'Alice');

    room.startGame();
    room.removeParticipant(ws1);
    room.submitAnswer(p1.id, [0]);
    assert.strictEqual(room.state, 'question');
    assert.strictEqual(autoEndCalled, false);
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
  it('openRoom generates a unique room ID for different presenters', () => {
    const manager = new RoomManager();
    const { room: room1 } = manager.openRoom('token1', { title: 'Q1', questions: [] });
    const { room: room2 } = manager.openRoom('token2', { title: 'Q2', questions: [] });
    assert.notStrictEqual(room1.roomId, room2.roomId);
    assert.ok(room1.roomId);
    assert.ok(room2.roomId);
  });

  it('openRoom resumes the same room for the same presenter', () => {
    // This is what makes a dropped WebSocket survivable: the presenter page
    // re-sends create_room on reconnect, and must not strand participants by
    // minting a new room code.
    const manager = new RoomManager();
    const first = manager.openRoom('token1', { title: 'Q1', questions: [] });
    const second = manager.openRoom('token1', { title: 'Q1', questions: [] });
    assert.strictEqual(first.resumed, false);
    assert.strictEqual(second.resumed, true);
    assert.strictEqual(second.room, first.room);
    assert.strictEqual(manager.rooms.size, 1);
  });

  it('a resumed room keeps its participants and scores', () => {
    const manager = new RoomManager();
    const { room } = manager.openRoom('token1', { title: 'Q1', questions: [] });
    const p = room.addParticipant({ readyState: 1 }, 'Alice');
    p.score = 250;
    const { room: resumed } = manager.openRoom('token1', { title: 'Q1', questions: [] });
    assert.strictEqual(resumed.roomId, room.roomId);
    assert.strictEqual(resumed.getParticipantCount(), 1);
    assert.strictEqual(resumed.getLeaderboard()[0].score, 250);
  });

  it('openRoom starts a fresh room once the previous one has ended', () => {
    const manager = new RoomManager();
    const first = manager.openRoom('token1', { title: 'Q1', questions: [] });
    first.room.state = 'ended';
    const second = manager.openRoom('token1', { title: 'Q1', questions: [] });
    assert.strictEqual(second.resumed, false);
    assert.notStrictEqual(second.room.roomId, first.room.roomId);
  });

  it('generateRoomId never returns an id that is in use', () => {
    const manager = new RoomManager();
    // Occupy a large slice of the space, then verify the next 200 ids are free.
    for (let i = 0; i < 300; i++) {
      manager.openRoom(`token${i}`, { title: 'Q', questions: [] });
    }
    const seen = new Set(manager.rooms.keys());
    assert.strictEqual(seen.size, 300);
    for (let i = 0; i < 200; i++) {
      const id = manager.generateRoomId();
      assert.ok(!manager.rooms.has(id));
    }
  });

  it('room ids avoid characters that are misread on a projector', () => {
    const manager = new RoomManager();
    for (let i = 0; i < 200; i++) {
      assert.match(manager.generateRoomId(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it('openRoom refuses to exceed the global room cap', () => {
    const manager = new RoomManager();
    for (let i = 0; i < MAX_ROOMS; i++) {
      manager.openRoom(`token${i}`, { title: 'Q', questions: [] });
    }
    assert.throws(() => manager.openRoom('one-too-many', { title: 'Q', questions: [] }));
  });

  it('getRoom returns the correct room', () => {
    const manager = new RoomManager();
    const { room } = manager.openRoom('token1', { title: 'Q1', questions: [] });
    assert.strictEqual(manager.getRoom(room.roomId), room);
    assert.strictEqual(manager.getRoom('nonexistent'), undefined);
  });

  it('removeRoom cleans up both maps and fires the hook', () => {
    const manager = new RoomManager();
    const removedRooms = [];
    manager.onRoomRemoved = (r) => removedRooms.push(r.roomId);
    const { room } = manager.openRoom('token1', { title: 'Q1', questions: [] });
    manager.removeRoom(room.roomId);
    assert.strictEqual(manager.getRoom(room.roomId), undefined);
    assert.deepStrictEqual(removedRooms, [room.roomId]);
    // The presenter can now open a genuinely new room.
    assert.strictEqual(manager.openRoom('token1', { title: 'Q1', questions: [] }).resumed, false);
  });

  it('there is no way to enumerate rooms by presenter token', () => {
    const manager = new RoomManager();
    assert.strictEqual(typeof manager.getPresenterRooms, 'undefined');
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

describe('Room expiry', () => {
  function roomWith(state) {
    const manager = new RoomManager();
    const { room } = manager.openRoom('t', { title: 'Q', questions: [] });
    room.state = state;
    return { manager, room };
  }

  it('a room with connections never expires on the idle timers', () => {
    const { room } = roomWith('lobby');
    room.addParticipant({ readyState: 1 }, 'Alice');
    assert.strictEqual(room.emptySince, null);
    // Stay inside the absolute cap; that backstop is asserted separately.
    assert.strictEqual(room.isExpired(Date.now() + EMPTY_ROOM_TTL_MS * 5), false);
  });

  it('the empty clock starts when the last connection leaves and stops when one returns', () => {
    const { room } = roomWith('lobby');
    const ws = { readyState: 1 };
    room.addParticipant(ws, 'Alice');
    assert.strictEqual(room.emptySince, null);
    room.removeParticipant(ws);
    assert.ok(room.emptySince !== null);
    room.addPresenter({ readyState: 1 });
    assert.strictEqual(room.emptySince, null);
  });

  it('a running but empty room expires after the empty TTL', () => {
    const { room } = roomWith('lobby');
    const now = Date.now();
    room.emptySince = now;
    assert.strictEqual(room.isExpired(now + EMPTY_ROOM_TTL_MS - 1000), false);
    assert.strictEqual(room.isExpired(now + EMPTY_ROOM_TTL_MS), true);
  });

  it('an ended room uses the shorter ended TTL', () => {
    const { room } = roomWith('ended');
    const now = Date.now();
    room.emptySince = now;
    assert.strictEqual(room.isExpired(now + ENDED_ROOM_TTL_MS - 1000), false);
    assert.strictEqual(room.isExpired(now + ENDED_ROOM_TTL_MS), true);
  });

  it('discards a finished room sooner than a running one, as the comment claims', () => {
    // The ended TTL used to be the longer of the two, which contradicted the
    // reasoning written above it: a finished room can never be read again,
    // while an empty running one is waiting for its presenter to come back.
    assert.ok(ENDED_ROOM_TTL_MS < EMPTY_ROOM_TTL_MS,
      'a room nobody can read again must not be kept longer than one still in play');

    const { room: finished } = roomWith('ended');
    const { room: running } = roomWith('lobby');
    const now = Date.now();
    finished.emptySince = now;
    running.emptySince = now;

    const afterEndedTtl = now + ENDED_ROOM_TTL_MS;
    assert.strictEqual(finished.isExpired(afterEndedTtl), true);
    assert.strictEqual(running.isExpired(afterEndedTtl), false);
  });

  it('the absolute TTL applies even to a room that is still in use', () => {
    const { room } = roomWith('question');
    room.addParticipant({ readyState: 1 }, 'Alice');
    assert.strictEqual(room.isExpired(room.createdAt + ABSOLUTE_ROOM_TTL_MS), true);
  });

  it('sweep removes exactly the expired rooms and frees the presenter token', () => {
    const manager = new RoomManager();
    const { room: stale } = manager.openRoom('stale', { title: 'Q', questions: [] });
    const { room: live } = manager.openRoom('live', { title: 'Q', questions: [] });
    live.addParticipant({ readyState: 1 }, 'Alice');

    const later = Date.now() + EMPTY_ROOM_TTL_MS + 1000;
    const removed = manager.sweep(later);
    assert.deepStrictEqual(removed, [stale.roomId]);
    assert.strictEqual(manager.getRoom(live.roomId), live);
    assert.strictEqual(manager.openRoom('stale', { title: 'Q', questions: [] }).resumed, false);
  });

  it('sweep clears a swept room\'s question timer', () => {
    const manager = new RoomManager();
    const quiz = { title: 'Q', questions: [{ type: 'estimation', text: 'x', correctAnswer: 1, timeLimit: 3600 }] };
    const { room } = manager.openRoom('t', quiz);
    room.onAutoEnd = () => {};
    room.startGame();
    assert.ok(room.questionTimer);
    manager.sweep(Date.now() + ABSOLUTE_ROOM_TTL_MS);
    assert.strictEqual(room.questionTimer, null);
  });
});

describe('Room.validateAnswer (untrusted participant input)', () => {
  function estimationRoom() {
    const quiz = { title: 'Test', questions: [{ type: 'estimation', text: 'Estimate', correctAnswer: 100 }] };
    const room = new Room('ABC123', 'token', quiz);
    room.addParticipant({ readyState: 1 }, 'Alice');
    room.startGame();
    return room;
  }

  function choiceRoom() {
    const quiz = { title: 'Test', questions: [{ type: 'multiple-choice', text: 'Q1', options: ['A', 'B', 'C'], correctIndices: [0] }] };
    const room = new Room('ABC123', 'token', quiz);
    room.addParticipant({ readyState: 1 }, 'Alice');
    room.startGame();
    return room;
  }

  it('estimation rejects strings, including HTML payloads', () => {
    const room = estimationRoom();
    for (const payload of ['<img src=x onerror=alert(1)>', '42', '', 'NaN']) {
      assert.strictEqual(room.validateAnswer(payload).valid, false);
    }
  });

  it('estimation rejects non-finite and non-scalar values', () => {
    const room = estimationRoom();
    for (const payload of [NaN, Infinity, -Infinity, null, undefined, true, {}, [], { toString: () => '1' }]) {
      assert.strictEqual(room.validateAnswer(payload).valid, false);
    }
  });

  it('estimation accepts finite numbers, including negatives and floats', () => {
    const room = estimationRoom();
    for (const value of [0, -17, 3.5, 1e12]) {
      const result = room.validateAnswer(value);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.answer, value);
    }
  });

  it('multiple-choice rejects string indices (which would otherwise concatenate)', () => {
    const room = choiceRoom();
    // `"<img>" + 1` is string concatenation, so a string index would carry a
    // payload straight through a naive `Opt ${i + 1}` renderer.
    assert.strictEqual(room.validateAnswer(['<img src=x onerror=alert(1)>']).valid, false);
    assert.strictEqual(room.validateAnswer(['0']).valid, false);
  });

  it('multiple-choice rejects out-of-range and non-integer indices', () => {
    const room = choiceRoom();
    for (const payload of [[3], [-1], [1.5], [NaN], [null], [[0]], 0, 'abc', null, { 0: 0 }]) {
      assert.strictEqual(room.validateAnswer(payload).valid, false);
    }
  });

  it('multiple-choice accepts an empty selection and normalizes duplicates/order', () => {
    const room = choiceRoom();
    assert.deepStrictEqual(room.validateAnswer([]).answer, []);
    assert.deepStrictEqual(room.validateAnswer([2, 0, 2]).answer, [0, 2]);
  });

  it('submitAnswer refuses invalid answers so they never reach the presenter', () => {
    const room = estimationRoom();
    const p = room.getLeaderboard()[0];
    assert.strictEqual(room.submitAnswer(p.id, '<svg onload=alert(1)>'), false);
    assert.strictEqual(room.currentAnswers.size, 0);
    assert.strictEqual(room.submitAnswer(p.id, 42), true);
    assert.strictEqual(room.currentAnswers.get(p.id).answer, 42);
  });

  it('a rejected answer does not consume the participant\'s single attempt', () => {
    const room = choiceRoom();
    const p = room.getLeaderboard()[0];
    assert.strictEqual(room.submitAnswer(p.id, ['x']), false);
    assert.strictEqual(room.submitAnswer(p.id, [0]), true);
  });

  it('estimation scoring survives a non-numeric correctAnswer in the quiz file', () => {
    const quiz = { title: 'Test', questions: [{ type: 'estimation', text: 'Estimate', correctAnswer: 'one hundred' }] };
    const room = new Room('ABC123', 'token', quiz);
    const p1 = room.addParticipant({ readyState: 1 }, 'Alice');
    const p2 = room.addParticipant({ readyState: 1 }, 'Bob');
    room.startGame();
    room.submitAnswer(p1.id, 100);
    const results = room.endQuestion();
    // Nobody is closer than anybody else, but scoring must stay well-defined.
    assert.strictEqual(typeof results.scores.get(p1.id), 'number');
    assert.strictEqual(results.leaderboard.length, 2);
  });
});

describe('Question statistics (post-game export)', () => {
  function playRoom() {
    const quiz = { title: 'Stats', questions: [
      { type: 'multiple-choice', text: '<p>Which are <b>prime</b>?</p>', options: ['2', '4', '7'], correctIndices: [0, 2] },
      { type: 'estimation', text: 'How many?', correctAnswer: 100 }
    ] };
    const room = new Room('ABC123', 'token', quiz);
    return room;
  }

  it('records the option distribution for multiple-choice questions', () => {
    const room = playRoom();
    const p1 = room.addParticipant({ readyState: 1 }, 'Alice');
    const p2 = room.addParticipant({ readyState: 1 }, 'Bob');
    const p3 = room.addParticipant({ readyState: 1 }, 'Carol');
    room.startGame();
    room.submitAnswer(p1.id, [0, 2]); // correct
    room.submitAnswer(p2.id, [0, 2]); // correct
    room.submitAnswer(p3.id, [1]);    // wrong
    room.endQuestion();

    const stat = room.getStatistics().questions[0];
    assert.strictEqual(stat.type, 'multiple-choice');
    assert.strictEqual(stat.responseCount, 3);
    assert.strictEqual(stat.correctCount, 2);
    assert.deepStrictEqual(stat.options.map(o => o.count), [2, 1, 2]);
    assert.deepStrictEqual(stat.options.map(o => o.isCorrect), [true, false, true]);
  });

  it('records spread and accuracy for estimation questions', () => {
    const room = playRoom();
    const p1 = room.addParticipant({ readyState: 1 }, 'Alice');
    const p2 = room.addParticipant({ readyState: 1 }, 'Bob');
    const p3 = room.addParticipant({ readyState: 1 }, 'Carol');
    room.startGame();
    room.endQuestion();
    room.nextQuestion();
    room.submitAnswer(p1.id, 95);
    room.submitAnswer(p2.id, 100);
    room.submitAnswer(p3.id, 500);
    room.endQuestion();

    const stat = room.getStatistics().questions[1];
    assert.strictEqual(stat.type, 'estimation');
    assert.strictEqual(stat.correctAnswer, 100);
    assert.strictEqual(stat.min, 95);
    assert.strictEqual(stat.max, 500);
    assert.strictEqual(stat.median, 100);
    assert.strictEqual(stat.withinTenPercent, 2); // 95 and 100
  });

  it('keeps the answers of participants who left before the end', () => {
    // Participants are removed from the room when their socket drops. Deriving
    // statistics at the end would silently omit them and bias the numbers.
    const room = playRoom();
    const ws = { readyState: 1 };
    const leaver = room.addParticipant(ws, 'Alice');
    const stayer = room.addParticipant({ readyState: 1 }, 'Bob');
    room.startGame();
    room.submitAnswer(leaver.id, [1]);
    room.submitAnswer(stayer.id, [0, 2]);
    room.endQuestion();
    room.removeParticipant(ws);

    const stat = room.getStatistics().questions[0];
    assert.strictEqual(stat.responseCount, 2);
    assert.deepStrictEqual(stat.options.map(o => o.count), [1, 1, 1]);
  });

  it('records each question exactly once even if endQuestion is repeated', () => {
    const room = playRoom();
    const p = room.addParticipant({ readyState: 1 }, 'Alice');
    room.startGame();
    room.submitAnswer(p.id, [0, 2]);
    room.endQuestion();
    room.endQuestion();
    assert.strictEqual(room.getStatistics().questions.length, 1);
  });

  it('statistics contain no participant names', () => {
    const room = playRoom();
    const p = room.addParticipant({ readyState: 1 }, 'Alice');
    room.startGame();
    room.submitAnswer(p.id, [0]);
    room.endQuestion();
    assert.ok(!JSON.stringify(room.getStatistics()).includes('Alice'));
  });

  it('reports only the questions actually played', () => {
    const room = playRoom();
    room.addParticipant({ readyState: 1 }, 'Alice');
    room.startGame();
    room.endQuestion();
    const stats = room.getStatistics();
    assert.strictEqual(stats.totalQuestions, 2);
    assert.strictEqual(stats.questions.length, 1);
  });
});

describe('Participant reattach', () => {
  const QUIZ = { title: 'Reattach', questions: [
    { type: 'multiple-choice', text: 'Q1', options: ['A', 'B'], correctIndices: [0] },
    { type: 'multiple-choice', text: 'Q2', options: ['A', 'B'], correctIndices: [1] }
  ] };
  const socket = () => ({ readyState: 1 });

  it('hands every participant a distinct, unguessable resume token', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const a = room.addParticipant(socket(), 'Alice');
    const b = room.addParticipant(socket(), 'Bob');
    const ta = room.resumeTokenFor(a.id);
    const tb = room.resumeTokenFor(b.id);
    assert.match(ta, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
    assert.notStrictEqual(ta, tb);
    assert.notStrictEqual(ta, a.id, 'the public id must not be the credential');
  });

  it('never puts the token anywhere that is broadcast', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    const p = room.addParticipant(ws, 'Alice');
    room.addParticipant(socket(), 'Bob');
    const token = room.resumeTokenFor(p.id);
    room.detachParticipant(ws);

    for (const [what, value] of [
      ['the participant record', p],
      ['the leaderboard', room.getLeaderboard()],
      ['the participant list', room.getParticipantList()],
      ['the summary', room.getSummary()],
      ['the statistics', room.getStatistics()]
    ]) {
      assert.ok(!JSON.stringify(value).includes(token), `the token leaked into ${what}`);
    }
  });

  it('keeps a dropped participant, score and all, instead of deleting them', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    const p = room.addParticipant(ws, 'Alice');
    room.addParticipant(socket(), 'Bob');
    room.startGame();
    room.submitAnswer(p.id, [0]);
    room.endQuestion();
    assert.strictEqual(p.score, 100);

    room.detachParticipant(ws);
    assert.strictEqual(room.getParticipantCount(), 1, 'detached is not connected');
    assert.strictEqual(room.getReconnectingCount(), 1);

    const fresh = socket();
    const { participant, supersededWs } = room.reattachParticipant(room.resumeTokenFor(p.id), fresh);
    assert.strictEqual(participant, p, 'the very same record comes back');
    assert.strictEqual(participant.score, 100);
    assert.strictEqual(supersededWs, null);
    assert.strictEqual(room.participants.get(fresh), p);
    assert.strictEqual(room.getParticipantCount(), 2);
    assert.strictEqual(room.getReconnectingCount(), 0);
  });

  it('scores an answer given before the drop', () => {
    // endQuestion() credits points via getParticipantById(), which used to
    // look only at connected participants -- an answer followed by a dropped
    // connection was silently worth nothing.
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    const p = room.addParticipant(ws, 'Alice');
    room.addParticipant(socket(), 'Bob');
    room.startGame();
    room.submitAnswer(p.id, [0]);
    room.detachParticipant(ws);
    const results = room.endQuestion();

    assert.strictEqual(p.score, 100);
    assert.strictEqual(p.answers.length, 1);
    assert.strictEqual(results.leaderboard.find((e) => e.id === p.id).score, 100);
  });

  it('keeps reconnecting participants on the leaderboard, without saying so', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    const p = room.addParticipant(ws, 'Alice');
    room.addParticipant(socket(), 'Bob');
    room.detachParticipant(ws);

    const board = room.getLeaderboard();
    assert.deepStrictEqual(board.map((e) => e.name).sort(), ['Alice', 'Bob']);
    assert.deepStrictEqual(Object.keys(board.find((e) => e.id === p.id)).sort(), ['id', 'name', 'score'],
      'the board goes to every participant, so it must not say who is offline');

    const list = room.getParticipantList();
    assert.strictEqual(list.find((e) => e.id === p.id).connected, false);
  });

  it('does not wait for a detached participant before auto-ending', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    let ended = false;
    room.onAutoEnd = () => { ended = true; };
    const ws = socket();
    room.addParticipant(ws, 'Alice');
    const bob = room.addParticipant(socket(), 'Bob');
    room.startGame();
    room.detachParticipant(ws);

    assert.strictEqual(room.countAwaitedAnswers(), 1);
    room.submitAnswer(bob.id, [0]);
    assert.strictEqual(ended, true, 'a phone in a lift must not hold the question open');
  });

  it('remembers that a returning participant already answered', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    const p = room.addParticipant(ws, 'Alice');
    room.addParticipant(socket(), 'Bob');
    room.startGame();
    room.submitAnswer(p.id, [1]);
    room.detachParticipant(ws);
    room.reattachParticipant(room.resumeTokenFor(p.id), socket());

    assert.ok(room.currentAnswers.has(p.id));
    assert.strictEqual(room.submitAnswer(p.id, [0]), false, 'a second answer must be refused');
  });

  it('refuses unknown, malformed and expired tokens', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    const p = room.addParticipant(ws, 'Alice');
    const token = room.resumeTokenFor(p.id);
    const t0 = 1_000_000;
    room.detachParticipant(ws, t0);

    for (const bad of ['nope', '', null, undefined, 42, {}, p.id, '__proto__']) {
      assert.strictEqual(room.reattachParticipant(bad, socket(), t0), null, `accepted ${String(bad)}`);
    }
    assert.strictEqual(room.reattachParticipant(token, socket(), t0 + DETACHED_TTL_MS), null,
      'an expired token must be refused even before the sweep has run');
    assert.strictEqual(room.getReconnectingCount(), 0, 'and the expired record forgotten');
    assert.strictEqual(room.resumeTokenFor(p.id), undefined);
  });

  it('hands over a still-attached participant and names the socket it replaced', () => {
    // A half-open connection the heartbeat has not yet caught, or a duplicated
    // tab: the newest connection wins.
    const room = new Room('ABC123', 'token', QUIZ);
    const old = socket();
    const p = room.addParticipant(old, 'Alice');
    const fresh = socket();
    const { participant, supersededWs } = room.reattachParticipant(room.resumeTokenFor(p.id), fresh);

    assert.strictEqual(participant, p);
    assert.strictEqual(supersededWs, old);
    assert.ok(!room.participants.has(old), 'the old socket must no longer speak for anybody');
    assert.strictEqual(room.participants.get(fresh), p);
    assert.strictEqual(room.detachParticipant(old), null,
      'the old socket closing later must not detach the participant who just came back');
    assert.strictEqual(room.getParticipantCount(), 1);
  });

  it('sweeps detached participants once the retention window has passed', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws1 = socket();
    const ws2 = socket();
    const early = room.addParticipant(ws1, 'Alice');
    const late = room.addParticipant(ws2, 'Bob');
    room.detachParticipant(ws1, 0);
    room.detachParticipant(ws2, 60_000);

    assert.strictEqual(room.sweepDetached(DETACHED_TTL_MS - 1), 0);
    assert.strictEqual(room.sweepDetached(DETACHED_TTL_MS), 1);
    assert.strictEqual(room.getParticipantById(early.id), null);
    assert.ok(room.getParticipantById(late.id));
    assert.strictEqual(room.resumeTokenFor(early.id), undefined, 'the token goes with the record');
  });

  it('RoomManager.sweep also sweeps the detached participants of live rooms', () => {
    const manager = new RoomManager();
    const { room } = manager.openRoom('presenter', QUIZ);
    room.addPresenter({ readyState: 1 }); // keeps the room itself alive
    const ws = socket();
    room.addParticipant(ws, 'Alice');
    room.detachParticipant(ws, Date.now());

    manager.sweep(Date.now() + DETACHED_TTL_MS + 1);
    assert.ok(manager.getRoom(room.roomId), 'the room is still running');
    assert.strictEqual(room.getReconnectingCount(), 0);
  });

  it('caps the detached map so a join-drop loop cannot grow it without bound', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const first = [];
    for (let i = 0; i < DETACHED_CAP_MIN + 10; i++) {
      const ws = socket();
      const p = room.addParticipant(ws, `Bot ${i}`);
      if (i < 10) first.push(p);
      room.detachParticipant(ws, i);
    }
    assert.strictEqual(room.getReconnectingCount(), DETACHED_CAP_MIN);
    for (const p of first) {
      assert.strictEqual(room.getParticipantById(p.id), null, 'the oldest are evicted first');
    }
  });

  it('never evicts anybody when a whole hall drops at once', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const sockets = [];
    for (let i = 0; i < 300; i++) {
      const ws = socket();
      room.addParticipant(ws, `Student ${i}`);
      sockets.push(ws);
    }
    for (const ws of sockets) room.detachParticipant(ws);
    assert.strictEqual(room.getReconnectingCount(), 300);
  });

  it('a purge cannot be undone by reconnecting', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    const p = room.addParticipant(ws, 'Alice');
    const token = room.resumeTokenFor(p.id);

    assert.strictEqual(room.purgeParticipant(p.id), true);
    assert.strictEqual(room.detachParticipant(ws), null, 'the kicked socket closing detaches nobody');
    assert.strictEqual(room.reattachParticipant(token, socket()), null);
    assert.strictEqual(room.getLeaderboard().length, 0);
    assert.strictEqual(room.purgeParticipant(p.id), false);
  });

  it('a purge also reaches a participant who is currently detached', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    const p = room.addParticipant(ws, 'Alice');
    const token = room.resumeTokenFor(p.id);
    room.detachParticipant(ws);

    assert.strictEqual(room.purgeParticipant(p.id), true);
    assert.strictEqual(room.reattachParticipant(token, socket()), null);
  });

  it('removeParticipant is final: it takes the token with it', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    const p = room.addParticipant(ws, 'Alice');
    const token = room.resumeTokenFor(p.id);
    room.removeParticipant(ws);
    assert.strictEqual(room.reattachParticipant(token, socket()), null);
  });

  it('a room with only detached participants counts as empty for expiry', () => {
    const room = new Room('ABC123', 'token', QUIZ);
    const ws = socket();
    room.addParticipant(ws, 'Alice');
    assert.strictEqual(room.emptySince, null);
    room.detachParticipant(ws, 5000);
    assert.strictEqual(room.emptySince, 5000);
    room.reattachParticipant(room.resumeTokenFor(room.getLeaderboard()[0].id), socket(), 6000);
    assert.strictEqual(room.emptySince, null);
  });
});
