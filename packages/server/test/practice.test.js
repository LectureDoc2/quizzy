/**
 * Integration tests for practice mode: a student playing a catalog quiz alone,
 * with the server running the game.
 *
 * Driven over real WebSockets against the real server, like server.test.js.
 * The results screen is shortened through the catalog's resultsSeconds, so a
 * whole game takes a fraction of a second.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { createQuizServer, GENERIC_REJECTION, PRACTICE_UNAVAILABLE } from '../src/server.js';
import { buildPracticeCatalog } from '../src/practice-catalog.js';
import { PROTOCOL_VERSION } from '../../ld-quiz/src/protocol.js';
import { loopbackHost, originFor } from './loopback.js';

const HANDSHAKE_TYPES = new Set([
  'create_room', 'join_room', 'rejoin_room', 'control_connect', 'room_status', 'start_practice'
]);

const withProtocolVersion = (msg) =>
  HANDSHAKE_TYPES.has(msg.type) && msg.protocolVersion === undefined
    ? { protocolVersion: PROTOCOL_VERSION, ...msg }
    : msg;

const QUIZZES = {
  'two.json': {
    title: 'Two Questions',
    questions: [
      { type: 'multiple-choice', text: 'Which?', options: ['A', 'B', 'C'], correctIndices: [0, 2], timeLimit: 30 },
      { type: 'estimation', text: 'How many?', correctAnswer: 84, timeLimit: 30 }
    ]
  },
  'timed.json': {
    title: 'Timed',
    questions: [{ type: 'multiple-choice', text: 'Quick!', options: ['A', 'B'], correctIndices: [1], timeLimit: 0.2 }]
  }
};

/** A catalog whose results screens last `resultsSeconds`. */
function catalog(resultsSeconds) {
  return buildPracticeCatalog({
    resultsSeconds,
    quizzes: [
      { id: 'two', category: 'Tests', file: 'two.json', description: 'Two of them' },
      { id: 'timed', file: 'timed.json' }
    ]
  }, (file) => QUIZZES[file]).catalog;
}

const SHORT = 0.08;
const LONG = 60;

describe('Practice mode (server, real sockets)', () => {
  let quizServer;
  let port;
  const host = loopbackHost();
  const sockets = [];

  before(async () => {
    quizServer = createQuizServer({
      limits: { maxPracticeGamesPerIp: 3, maxRoomsPerIp: 1 },
      heartbeatIntervalMs: 60_000
    });
    port = await quizServer.listen(0, host);
  });

  after(async () => {
    for (const ws of sockets) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    await quizServer.close();
  });

  beforeEach(() => {
    for (const roomId of [...quizServer.roomManager.rooms.keys()]) {
      quizServer.roomManager.removeRoom(roomId);
    }
    quizServer.setPracticeCatalog(catalog(SHORT));
  });

  /** Open a socket that buffers everything it receives; see server.test.js. */
  async function connect() {
    const ws = new WebSocket(`${originFor('ws', host, port)}/ws`);
    sockets.push(ws);
    ws.inbox = [];
    ws.waiters = [];
    ws.on('message', (data) => {
      ws.inbox.push(JSON.parse(data));
      for (const waiter of [...ws.waiters]) waiter();
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  }

  function waitFor(ws, type, timeoutMs = 3000) {
    const grab = () => {
      const index = ws.inbox.findIndex((m) => m.type === type);
      return index === -1 ? undefined : ws.inbox.splice(index, 1)[0];
    };
    const immediate = grab();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        ws.waiters = ws.waiters.filter((w) => w !== check);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${type}; buffered: ${JSON.stringify(ws.inbox.map((m) => m.type))}`));
      }, timeoutMs);
      const check = () => {
        const msg = grab();
        if (!msg) return;
        cleanup();
        resolve(msg);
      };
      ws.waiters.push(check);
    });
  }

  const send = (ws, msg) => ws.send(JSON.stringify(withProtocolVersion(msg)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function startPractice(quizId = 'two') {
    const ws = await connect();
    send(ws, { type: 'start_practice', quizId });
    const joined = await waitFor(ws, 'joined');
    const question = await waitFor(ws, 'question');
    return { ws, joined, question, room: quizServer.roomManager.getRoom(joined.roomId) };
  }

  it('lists the catalog over HTTP, without answers', async () => {
    const response = await fetch(`${originFor('http', host, port)}/api/practice`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body.quizzes, [
      { id: 'two', category: 'Tests', title: 'Two Questions', description: 'Two of them', questionCount: 2 },
      { id: 'timed', category: null, title: 'Timed', description: null, questionCount: 1 }
    ]);
  });

  it('plays a whole game by itself: answer, verdict, countdown, next, final tally', async () => {
    const { ws, joined, question } = await startPractice();
    assert.strictEqual(joined.practice, true);
    assert.strictEqual(joined.practiceQuizId, 'two');
    assert.strictEqual(joined.quizTitle, 'Two Questions');
    assert.ok(joined.resumeToken);
    assert.strictEqual(question.questionIndex, 0);
    assert.strictEqual(question.totalQuestions, 2);
    assert.strictEqual(question.question.correctIndices, undefined);

    // Answering closes the question at once: the student is everybody.
    send(ws, { type: 'submit_answer', answer: [0, 2] });
    const first = await waitFor(ws, 'results');
    assert.strictEqual(first.practice, true);
    assert.strictEqual(first.waiting, true);
    assert.strictEqual(first.feedback.isCorrect, true);
    assert.ok(!('correctIndices' in first.feedback));
    assert.ok(first.advanceInMs > 0 && first.advanceInMs <= SHORT * 1000);

    const second = await waitFor(ws, 'question');
    assert.strictEqual(second.questionIndex, 1);

    send(ws, { type: 'submit_answer', answer: 100 });
    const last = await waitFor(ws, 'results');
    assert.strictEqual(last.waiting, false);
    assert.strictEqual(last.feedback.band, 25);
    assert.strictEqual(last.feedback.points, 50);
    assert.ok(!('correctAnswer' in last.feedback) && !('rank' in last.feedback));

    const ended = await waitFor(ws, 'game_ended');
    assert.deepStrictEqual(ended.summary, { score: 150, maxScore: 200, correct: 1, total: 2 });
  });

  it('moves on at the time limit when the student does not answer', async () => {
    const { ws } = await startPractice('timed');
    const results = await waitFor(ws, 'results');
    assert.strictEqual(results.feedback.answered, false);
    const ended = await waitFor(ws, 'game_ended');
    assert.strictEqual(ended.summary.score, 0);
  });

  it('lets the student skip the rest of the countdown', async () => {
    quizServer.setPracticeCatalog(catalog(LONG));
    const { ws } = await startPractice();
    send(ws, { type: 'submit_answer', answer: [1] });
    const results = await waitFor(ws, 'results');
    assert.ok(results.advanceInMs > (LONG - 5) * 1000);

    send(ws, { type: 'practice_next' });
    const next = await waitFor(ws, 'question', 1000);
    assert.strictEqual(next.questionIndex, 1);

    // Not from a question that is still open: Continue must never skip one.
    send(ws, { type: 'practice_next' });
    await sleep(100);
    assert.strictEqual(ws.inbox.length, 0, JSON.stringify(ws.inbox));
  });

  it('keeps the countdown a game started with when the catalog is reloaded', async () => {
    quizServer.setPracticeCatalog(catalog(LONG));
    const { ws } = await startPractice();
    quizServer.setPracticeCatalog(catalog(SHORT));
    send(ws, { type: 'submit_answer', answer: [1] });
    assert.ok((await waitFor(ws, 'results')).advanceInMs > (LONG - 5) * 1000);
  });

  it('waits on the results screen while the student is away, and resumes on rejoin', async () => {
    quizServer.setPracticeCatalog(catalog(0.3));
    const { ws, joined, room } = await startPractice();
    send(ws, { type: 'submit_answer', answer: [0, 2] });
    await waitFor(ws, 'results');
    ws.terminate();

    // Well past the countdown: nothing moved, because nobody was watching.
    await sleep(600);
    assert.strictEqual(room.state, 'results');
    assert.strictEqual(room.currentQuestionIndex, 0);
    assert.strictEqual(room.advanceTimer, null);

    const back = await connect();
    send(back, { type: 'rejoin_room', roomId: joined.roomId, resumeToken: joined.resumeToken });
    const rejoined = await waitFor(back, 'rejoined');
    assert.strictEqual(rejoined.practice, true);
    assert.strictEqual(rejoined.practiceQuizId, 'two');
    const results = await waitFor(back, 'results');
    assert.ok(results.advanceInMs > 200, `countdown restarted, got ${results.advanceInMs}`);
    assert.strictEqual(results.totalQuestions, 2, 'enough for "Question 1 of 2" after a reload');
    assert.strictEqual((await waitFor(back, 'question')).questionIndex, 1);
  });

  it('is invisible to everybody but its student', async () => {
    const { joined } = await startPractice();
    const stranger = await connect();

    send(stranger, { type: 'room_status', roomId: joined.roomId });
    assert.strictEqual((await waitFor(stranger, 'error')).message, GENERIC_REJECTION);

    send(stranger, { type: 'join_room', roomId: joined.roomId, name: 'Eve Evans' });
    assert.strictEqual((await waitFor(stranger, 'error')).message, GENERIC_REJECTION);

    const presenter = await connect();
    for (const presenterToken of [undefined, null, '']) {
      send(presenter, { type: 'control_connect', roomId: joined.roomId, presenterToken });
      assert.strictEqual((await waitFor(presenter, 'error')).message, GENERIC_REJECTION);
    }
  });

  it('gives the student no presenter powers', async () => {
    const { ws, room } = await startPractice();
    send(ws, { type: 'next_question' });
    send(ws, { type: 'end_game' });
    await sleep(100);
    assert.strictEqual(room.state, 'question');
    assert.strictEqual(room.currentQuestionIndex, 0);
  });

  it('is one game per connection', async () => {
    const { ws } = await startPractice();
    send(ws, { type: 'start_practice', quizId: 'two' });
    assert.match((await waitFor(ws, 'error')).message, /already joined/);
    assert.strictEqual(quizServer.roomManager.practiceRoomCount, 1);
  });

  it('says so for a quiz that is not in the catalog', async () => {
    const ws = await connect();
    for (const quizId of ['nope', ['two'], undefined]) {
      send(ws, { type: 'start_practice', quizId });
      const error = await waitFor(ws, 'error');
      assert.strictEqual(error.code, 'practice_unavailable');
      assert.strictEqual(error.message, PRACTICE_UNAVAILABLE);
    }
    assert.strictEqual(ws.readyState, WebSocket.OPEN, 'not treated as a probe');
  });

  it('caps practice games per address without touching the lectures\' allowance', async () => {
    for (let i = 0; i < 3; i++) await startPractice();
    const fourth = await connect();
    send(fourth, { type: 'start_practice', quizId: 'two' });
    assert.match((await waitFor(fourth, 'error')).message, /Too many practice games/);

    // maxRoomsPerIp is 1 here, and three practice games did not use it up.
    const presenter = await connect();
    send(presenter, {
      type: 'create_room',
      presenterToken: 'p'.repeat(64),
      quiz: QUIZZES['two.json']
    });
    assert.ok(await waitFor(presenter, 'room_created'));
  });

  it('frees a finished game, and its quota, as soon as the student leaves', async () => {
    const { ws, joined } = await startPractice('timed');
    await waitFor(ws, 'game_ended');
    ws.close();
    await sleep(100);
    assert.strictEqual(quizServer.roomManager.getRoom(joined.roomId), undefined);
    const state = [...quizServer.ipState.values()][0];
    assert.strictEqual(state?.practiceGames ?? 0, 0);
  });
});
