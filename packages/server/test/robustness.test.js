/**
 * The server must survive anything a client can say to it.
 *
 * This file is deliberately not a unit test of any one function. It is the
 * standing answer to a question with a bad failure mode: "can a message from
 * the outside stop this process?" A crash here does not spoil one quiz, it ends
 * every lecture running on the host -- so the property is asserted directly:
 * throw the garbage, then check the server is still answering.
 *
 * The bug that prompted it: a multiple-choice question with no `correctIndices`
 * reached the scorer through the auto-end `setTimeout`, where a throw has no
 * caller, and Node exited.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { createHash } from 'crypto';
import { createQuizServer, MAX_QUIZ_SIZE } from '../src/server.js';
import { PROTOCOL_VERSION } from '../../ld-quiz/src/protocol.js';
import { loopbackHost, originFor } from './loopback.js';

const VALID_QUIZ = {
  title: 'Still Alive',
  questions: [
    { type: 'multiple-choice', text: 'q', options: ['a', 'b'], correctIndices: [0] }
  ]
};

const tokenFor = (name, quiz = VALID_QUIZ) =>
  createHash('sha256').update(`${name} ${JSON.stringify(quiz)}`).digest('hex');

/** Quizzes that are wrong in ways the runtime used to assume away. */
const MALFORMED_QUIZZES = {
  'null': null,
  'a string': 'not a quiz',
  'a number': 42,
  'an array': [{ type: 'multiple-choice' }],
  'no questions key': { title: 'T' },
  'questions as a string': { questions: 'lots' },
  'no questions at all': { questions: [] },
  'a null question': { questions: [null] },
  'a question that is a string': { questions: ['q1'] },
  'an unknown question type': { questions: [{ type: 'essay', text: 'discuss' }] },
  'a missing type': { questions: [{ text: 'q', options: ['a', 'b'] }] },
  // The original crash: valid enough to look like a question, fatal at scoring.
  'no correctIndices':
    { questions: [{ type: 'multiple-choice', text: 'q', options: ['a', 'b'], timeLimit: 1 }] },
  'correctIndices as a number':
    { questions: [{ type: 'multiple-choice', text: 'q', options: ['a', 'b'], correctIndices: 0 }] },
  'correctIndices out of range':
    { questions: [{ type: 'multiple-choice', text: 'q', options: ['a', 'b'], correctIndices: [7] }] },
  'a string in correctIndices':
    { questions: [{ type: 'multiple-choice', text: 'q', options: ['a', 'b'], correctIndices: ['0'] }] },
  'options that are not an array':
    { questions: [{ type: 'multiple-choice', text: 'q', options: 'a,b', correctIndices: [0] }] },
  'options holding objects':
    { questions: [{ type: 'multiple-choice', text: 'q', options: [{}, {}], correctIndices: [0] }] },
  'a single option':
    { questions: [{ type: 'multiple-choice', text: 'q', options: ['a'], correctIndices: [0] }] },
  'an estimation with no answer': { questions: [{ type: 'estimation', text: 'q' }] },
  'an unnumeric estimation answer':
    { questions: [{ type: 'estimation', text: 'q', correctAnswer: 'about ten' }] },
  'a string timeLimit':
    { questions: [{ type: 'estimation', text: 'q', correctAnswer: 1, timeLimit: 'soon' }] },
  'a negative timeLimit':
    { questions: [{ type: 'estimation', text: 'q', correctAnswer: 1, timeLimit: -5 }] },
  // Not Infinity: JSON.stringify turns that into null, which legitimately
  // means "no time limit". A finite absurdity is what actually travels.
  'an absurd timeLimit':
    { questions: [{ type: 'estimation', text: 'q', correctAnswer: 1, timeLimit: 1e12 }] },
  'text that is an object':
    { questions: [{ type: 'estimation', text: { toString: 1 }, correctAnswer: 1 }] },
  '4000 questions':
    { questions: Array.from({ length: 4000 }, () => ({ type: 'estimation', text: 'q', correctAnswer: 1 })) },
  '2000 options':
    { questions: [{ type: 'multiple-choice', text: 'q', options: Array(2000).fill('x'), correctIndices: [0] }] }
};

/** Raw frames that are not well-formed anything. */
const MALFORMED_MESSAGES = [
  '', ' ', 'null', 'undefined', '[]', '{}', '42', '"a string"', 'true',
  'not json at all', '{"type":', '{"type":null}', '{"type":42}', '{"type":[]}',
  '{"type":"create_room"}',
  '{"type":"join_room"}',
  '{"type":"submit_answer","answer":{"a":1}}',
  '{"type":"submit_answer","answer":[1,2,3]}',
  '{"type":"next_question"}',
  '{"type":"end_game"}',
  '{"type":"control_connect"}',
  '{"type":"room_status"}',
  '{"type":"kick"}',
  '{"type":"__proto__"}',
  '{"type":"constructor"}',
  '{"type":"toString"}',
  JSON.stringify({ type: 'create_room', presenterToken: null, quiz: VALID_QUIZ }),
  JSON.stringify({ type: 'create_room', presenterToken: 'short', quiz: VALID_QUIZ }),
  JSON.stringify({ type: 'join_room', roomId: null, name: null }),
  JSON.stringify({ type: 'join_room', roomId: {}, name: [] }),
  '{"type":"rejoin_room"}',
  JSON.stringify({ type: 'rejoin_room', protocolVersion: PROTOCOL_VERSION, roomId: null, resumeToken: null }),
  JSON.stringify({ type: 'rejoin_room', protocolVersion: PROTOCOL_VERSION, roomId: {}, resumeToken: { length: 43 } }),
  JSON.stringify({ type: 'rejoin_room', protocolVersion: PROTOCOL_VERSION, roomId: '__proto__', resumeToken: '__proto__' }),
  JSON.stringify({ type: 'rejoin_room', protocolVersion: PROTOCOL_VERSION, roomId: 'ABCDEF', resumeToken: 'x'.repeat(10000) }),
  '{"type":"create_room","quiz":{"a":' + '['.repeat(200) + '}}'
];

describe('The server survives hostile input', () => {
  let quizServer;
  let port;
  const host = loopbackHost();
  const sockets = [];

  before(async () => {
    quizServer = createQuizServer({
      // Generous, so that the rate limiter is not what makes this test pass.
      limits: { maxMessagesPerWindow: 100000, maxFailedAttemptsPerWindow: 100000, maxRoomsPerIp: 100000 },
      heartbeatIntervalMs: 60000
    });
    port = await quizServer.listen(0, host);
  });

  after(async () => {
    for (const ws of sockets) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    await quizServer.close();
  });

  async function connect() {
    const ws = new WebSocket(`${originFor('ws', host, port)}/ws`);
    sockets.push(ws);
    ws.inbox = [];
    ws.on('error', () => { /* an intentionally rejected frame closes the socket */ });
    ws.on('message', (data) => {
      try { ws.inbox.push(JSON.parse(data)); } catch { ws.inbox.push({ type: 'unparseable' }); }
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  }

  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** The liveness check: a fresh client can still open a real room. */
  async function assertServerStillWorks(what) {
    const ws = await connect();
    ws.send(JSON.stringify({
      type: 'create_room',
      protocolVersion: PROTOCOL_VERSION,
      presenterToken: tokenFor(`survivor-${what}`),
      quiz: VALID_QUIZ
    }));
    const created = await new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        const hit = ws.inbox.find((m) => m.type === 'room_created');
        if (hit) { clearTimeout(deadline); clearInterval(poll); resolve(hit); }
      }, 10);
      const deadline = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`the server stopped answering after ${what}`));
      }, 4000);
    });
    assert.ok(created.roomId, `the server should still create rooms after ${what}`);
    ws.close();
  }

  for (const [label, quiz] of Object.entries(MALFORMED_QUIZZES)) {
    it(`refuses a quiz with ${label} instead of dying`, async () => {
      const ws = await connect();
      ws.send(JSON.stringify({
        type: 'create_room',
        protocolVersion: PROTOCOL_VERSION,
        presenterToken: tokenFor(`bad-${label}`),
        quiz
      }));
      await settle(150);

      const created = ws.inbox.find((m) => m.type === 'room_created');
      const error = ws.inbox.find((m) => m.type === 'error');
      assert.ok(!created, `a quiz with ${label} must not create a room`);
      assert.ok(error, `a quiz with ${label} should be refused with a message`);
      assert.match(error.message, /\S/, 'the refusal should say something');

      ws.close();
      await assertServerStillWorks(`a quiz with ${label}`);
    });
  }

  it('does not let a quiz reach Object.prototype', async () => {
    // The payload below is a perfectly good quiz, so it is expected to be
    // accepted -- the property under test is that carrying a `__proto__` key
    // through parsing, sanitizing and rendering pollutes nothing.
    const ws = await connect();
    ws.send('{"type":"create_room","protocolVersion":' + PROTOCOL_VERSION +
      ',"presenterToken":"' + tokenFor('pollution') + '"' +
      ',"quiz":{"questions":[{"type":"estimation","text":"q","correctAnswer":1}]' +
      ',"__proto__":{"polluted":true}}}');
    await settle(150);

    assert.strictEqual({}.polluted, undefined, 'Object.prototype must be untouched');
    assert.strictEqual(({}).constructor, Object, 'Object.prototype.constructor must be untouched');
    await assertServerStillWorks('a prototype-pollution attempt');
  });

  it('shrugs off every malformed message', async () => {
    const ws = await connect();
    for (const raw of MALFORMED_MESSAGES) ws.send(raw);
    await settle(300);
    await assertServerStillWorks(`${MALFORMED_MESSAGES.length} malformed messages`);
  });

  it('shrugs off garbage from a participant inside a live room', async () => {
    const presenter = await connect();
    presenter.send(JSON.stringify({
      type: 'create_room',
      protocolVersion: PROTOCOL_VERSION,
      presenterToken: tokenFor('live-room'),
      quiz: VALID_QUIZ
    }));
    await settle(150);
    const roomId = presenter.inbox.find((m) => m.type === 'room_created')?.roomId;
    assert.ok(roomId, 'setup: the room should exist');

    const participant = await connect();
    participant.send(JSON.stringify({
      type: 'join_room', protocolVersion: PROTOCOL_VERSION, roomId, name: 'Ada'
    }));
    await settle(100);
    presenter.send(JSON.stringify({ type: 'start_game' }));
    await settle(100);

    // A joined participant reaches further into the room code than a stranger.
    for (const raw of MALFORMED_MESSAGES) participant.send(raw);
    for (const answer of [null, {}, [], 'x', [1.5], [-1], [999], [NaN], Infinity, [[0]], true]) {
      participant.send(JSON.stringify({ type: 'submit_answer', answer }));
    }
    await settle(300);

    await assertServerStillWorks('garbage from a joined participant');
  });

  it('refuses an oversized message without falling over', async () => {
    const ws = await connect();
    const closed = new Promise((resolve) => ws.once('close', resolve));
    // Past `maxPayload`, so ws rejects the frame before any handler sees it.
    ws.send(JSON.stringify({
      type: 'create_room',
      protocolVersion: PROTOCOL_VERSION,
      presenterToken: tokenFor('huge'),
      quiz: { title: 'x'.repeat(MAX_QUIZ_SIZE + 1024), questions: [] }
    }));
    await closed;
    await assertServerStillWorks('an oversized message');
  });

  it('survives a question whose auto-end timer fires', async () => {
    // The original crash needed the *timer* to run, not merely the message to
    // arrive. A rejected quiz never gets that far, so this drives the whole
    // path rather than only proving that validation refused something.
    const ws = await connect();
    ws.send(JSON.stringify({
      type: 'create_room',
      protocolVersion: PROTOCOL_VERSION,
      presenterToken: tokenFor('timer'),
      quiz: {
        title: 'Timed',
        questions: [{
          type: 'multiple-choice', text: 'q', options: ['a', 'b'],
          correctIndices: [0], timeLimit: 1
        }]
      }
    }));
    await settle(150);
    assert.ok(ws.inbox.find((m) => m.type === 'room_created'), 'setup: the room should exist');

    ws.send(JSON.stringify({ type: 'start_game' }));
    await settle(1400); // let the timer fire

    await assertServerStillWorks('an auto-ended question');
  });
});
