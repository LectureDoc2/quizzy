/**
 * Integration tests for the real server.
 *
 * These import `createQuizServer` from src/server.js and drive the actual
 * message handlers over real WebSockets. That distinction matters: the previous
 * version of this file reimplemented a cut-down server inline and asserted
 * against *that*, so it exercised express and ws rather than any of our code --
 * and when the room-listing feature was removed it did not fail, it hung.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { createHash } from 'crypto';
import { createQuizServer, limitsFromEnv, DEFAULT_LIMITS, GENERIC_REJECTION, QUIZ_FINISHED } from '../src/server.js';
import { PROTOCOL_VERSION } from '../../ld-quiz/src/protocol.js';
import { loopbackHost, originFor } from './loopback.js';

/**
 * Message types the server version-checks, and the version to stamp on them.
 *
 * Stamped centrally rather than at every call site: `protocolVersion` is part of
 * how a real client speaks, not part of what any individual test is about, and a
 * test that forgets it would fail for a reason unrelated to its subject.
 */
const HANDSHAKE_TYPES = new Set(['create_room', 'join_room', 'control_connect', 'room_status']);

function withProtocolVersion(msg) {
  return HANDSHAKE_TYPES.has(msg.type) && msg.protocolVersion === undefined
    ? { protocolVersion: PROTOCOL_VERSION, ...msg }
    : msg;
}

const QUIZ = {
  title: 'Integration Quiz',
  secret: 'high-entropy-secret',
  questions: [
    {
      type: 'multiple-choice',
      text: 'Which are <b>connection-oriented</b>?',
      options: ['TCP', 'UDP', 'SCTP'],
      correctIndices: [0, 2]
    },
    { type: 'estimation', text: 'Bits in an IPv6 address?', correctAnswer: 128 }
  ]
};

/** Mirrors ld-quiz.js hashQuiz(quiz, presenterName). */
function tokenFor(name, quiz = QUIZ) {
  return createHash('sha256').update(`${name}\u0000${JSON.stringify(quiz)}`).digest('hex');
}

describe('Server integration', () => {
  let quizServer;
  let port;
  // Bind and connect using the same loopback literal, whichever family this
  // host provides; see loopback.js.
  const host = loopbackHost();
  const sockets = [];

  before(async () => {
    quizServer = createQuizServer({
      // Tightened so the limiter can be observed without sending 60 messages.
      limits: { maxMessagesPerWindow: 12, maxFailedAttemptsPerWindow: 3, maxRoomsPerIp: 2 },
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
    // Each test starts from a clean room table.
    for (const roomId of [...quizServer.roomManager.rooms.keys()]) {
      quizServer.roomManager.removeRoom(roomId);
    }
  });

  /**
   * Open a socket and buffer everything it receives.
   *
   * The buffer matters: a WebSocket reply frequently lands before the test gets
   * around to attaching a listener, so a naive `ws.once('message')` misses it
   * and times out. Every message is captured from the moment the socket opens
   * and consumed from the buffer instead.
   */
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

  /**
   * Resolve with the first buffered message matching `predicate`, removing it.
   * Rejects on timeout so a missing message fails loudly rather than hanging.
   */
  function take(ws, predicate, label, timeoutMs = 3000) {
    const grab = () => {
      const index = ws.inbox.findIndex(predicate);
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
        reject(new Error(`timed out waiting for ${label}; buffered: ` +
          JSON.stringify(ws.inbox.map((m) => m.type))));
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

  const next = (ws, timeoutMs) => take(ws, () => true, 'any message', timeoutMs);
  const waitFor = (ws, type, timeoutMs) => take(ws, (m) => m.type === type, type, timeoutMs);

  const send = (ws, msg) => ws.send(JSON.stringify(withProtocolVersion(msg)));

  async function openRoom(token = tokenFor('michael'), quiz = QUIZ) {
    const ws = await connect();
    send(ws, { type: 'create_room', presenterToken: token, quiz });
    return { ws, created: await next(ws) };
  }

  async function joinRoom(roomId, name) {
    const ws = await connect();
    send(ws, { type: 'join_room', roomId, name });
    return { ws, reply: await next(ws) };
  }

  describe('opening a session', () => {
    it('creates a room and reports it as new', async () => {
      const { created } = await openRoom();
      assert.strictEqual(created.type, 'room_created');
      assert.match(created.roomId, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
      assert.strictEqual(created.quizTitle, 'Integration Quiz');
      assert.strictEqual(created.totalQuestions, 2);
      assert.strictEqual(created.resumed, false);
    });

    it('rejects a token too short to be a SHA-256 digest', async () => {
      const ws = await connect();
      send(ws, { type: 'create_room', presenterToken: 'short', quiz: QUIZ });
      assert.strictEqual((await next(ws)).type, 'error');
    });

    it('resumes rather than stranding participants when the presenter reconnects', async () => {
      const token = tokenFor('michael');
      const first = await openRoom(token);
      await joinRoom(first.created.roomId, 'Alice Adams');

      first.ws.terminate(); // the lecture-hall WiFi glitch
      await new Promise((r) => setTimeout(r, 100));

      const second = await openRoom(token);
      assert.strictEqual(second.created.roomId, first.created.roomId);
      assert.strictEqual(second.created.resumed, true);
      assert.strictEqual(second.created.participantCount, 1);
    });

    it('isolates two presenters who share the same quiz file', async () => {
      const mine = await openRoom(tokenFor('michael'));
      const theirs = await openRoom(tokenFor('anna'));
      assert.notStrictEqual(mine.created.roomId, theirs.created.roomId);

      // ...and neither can drive the other's session.
      const intruder = await connect();
      send(intruder, {
        type: 'control_connect',
        presenterToken: tokenFor('anna'),
        roomId: mine.created.roomId
      });
      assert.strictEqual((await next(intruder)).type, 'error');
    });

    it('strips unsafe markup from the quiz and tells the presenter', async () => {
      const quiz = {
        title: 'Sanitized',
        questions: [{
          type: 'estimation',
          text: 'Count them <p onclick="boom()">hint</p><script>boom()</script>',
          correctAnswer: 3
        }]
      };
      const { ws, created } = await openRoom(tokenFor('sanitize-me', quiz), quiz);
      assert.ok(created.warnings.some(w => w.includes('script')));
      assert.ok(created.warnings.some(w => w.includes('onclick')));

      send(ws, { type: 'start_game' });
      const started = await waitFor(ws, 'game_started');
      assert.ok(!started.question.text.includes('<script'));
      assert.ok(!started.question.text.includes('onclick'));
    });
  });

  describe('probing gives nothing away', () => {
    it('uses one opaque message for an unknown room', async () => {
      const { reply } = await joinRoom('ZZZZZZ', 'Prober One');
      assert.strictEqual(reply.type, 'error');
      assert.strictEqual(reply.message, GENERIC_REJECTION);
      assert.ok(!/not found|denied|exist/i.test(reply.message));
    });

    it('cannot distinguish a wrong token from a missing room', async () => {
      const { created } = await openRoom();
      const badToken = await connect();
      send(badToken, { type: 'control_connect', presenterToken: 'x'.repeat(64), roomId: created.roomId });
      const noRoom = await connect();
      send(noRoom, { type: 'control_connect', presenterToken: 'x'.repeat(64), roomId: 'QQQQQQ' });
      assert.strictEqual((await next(badToken)).message, (await next(noRoom)).message);
    });

    it('has no endpoint that lists rooms', async () => {
      await openRoom();
      const res = await fetch(`${originFor('http', host, port)}/api/sessions?token=${tokenFor('michael')}`);
      assert.strictEqual(res.status, 404);
    });

    it('returns no session list when the room id is omitted', async () => {
      await openRoom();
      const ws = await connect();
      send(ws, { type: 'control_connect', presenterToken: tokenFor('michael') });
      const reply = await next(ws);
      assert.strictEqual(reply.type, 'error');
      assert.strictEqual(reply.sessions, undefined);
    });
  });

  describe('room status before joining', () => {
    it('reports the lobby state so the join page can label itself', async () => {
      const { created } = await openRoom();
      const ws = await connect();
      send(ws, { type: 'room_status', roomId: created.roomId });
      const status = await next(ws);

      assert.strictEqual(status.type, 'room_status');
      assert.strictEqual(status.state, 'lobby');
      assert.strictEqual(status.currentQuestionIndex, -1);
      assert.strictEqual(status.totalQuestions, 2);
      assert.strictEqual(status.quizTitle, 'Integration Quiz');
    });

    it('reports a running quiz and which question it is on', async () => {
      const presenter = await openRoom();
      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');

      const ws = await connect();
      send(ws, { type: 'room_status', roomId: presenter.created.roomId });
      const status = await next(ws);

      assert.strictEqual(status.state, 'question');
      assert.strictEqual(status.currentQuestionIndex, 0);
    });

    it('never leaks the quiz secret or the questions', async () => {
      const { created } = await openRoom();
      const ws = await connect();
      send(ws, { type: 'room_status', roomId: created.roomId });
      const status = await next(ws);
      const serialized = JSON.stringify(status);
      assert.ok(!serialized.includes('high-entropy-secret'));
      assert.ok(!serialized.includes('TCP'));
    });

    it('is opaque for an unknown room', async () => {
      const ws = await connect();
      send(ws, { type: 'room_status', roomId: 'ZZZZZZ' });
      const reply = await next(ws);
      assert.strictEqual(reply.type, 'error');
      assert.strictEqual(reply.message, GENERIC_REJECTION);
    });

    it('is equally opaque for a finished room, so codes stay unenumerable', async () => {
      const presenter = await openRoom();
      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');
      send(presenter.ws, { type: 'next_question' });
      await waitFor(presenter.ws, 'question_started');
      const ended = waitFor(presenter.ws, 'game_ended');
      send(presenter.ws, { type: 'next_question' });
      await ended;

      const ws = await connect();
      send(ws, { type: 'room_status', roomId: presenter.created.roomId });
      const reply = await next(ws);
      assert.strictEqual(reply.message, GENERIC_REJECTION, 'status must not distinguish finished from unknown');
    });

    it('only says a quiz has finished once a real name has been supplied', async () => {
      const presenter = await openRoom();
      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');
      send(presenter.ws, { type: 'next_question' });
      await waitFor(presenter.ws, 'question_started');
      const ended = waitFor(presenter.ws, 'game_ended');
      send(presenter.ws, { type: 'next_question' });
      await ended;

      const { reply } = await joinRoom(presenter.created.roomId, 'Late Arrival');
      assert.strictEqual(reply.message, QUIZ_FINISHED);

      // A room that never existed stays opaque even after a valid name.
      const { reply: unknown } = await joinRoom('ZZZZZZ', 'Late Arrival');
      assert.strictEqual(unknown.message, GENERIC_REJECTION);
    });

    it('still admits a latecomer and sends them the question in progress', async () => {
      const presenter = await openRoom();
      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');

      const late = await joinRoom(presenter.created.roomId, 'Late Arrival');
      assert.strictEqual(late.reply.type, 'joined');
      const question = await waitFor(late.ws, 'question');
      assert.strictEqual(question.questionIndex, 0);
      assert.ok(question.question.options, 'the latecomer needs the options to answer');
      assert.strictEqual(question.question.correctIndices, undefined, 'answers must stay hidden');
    });

    it('counts a status probe against the failure budget', async () => {
      const ws = await connect();
      const closed = new Promise((resolve) => ws.once('close', resolve));
      for (let i = 0; i < 6; i++) {
        send(ws, { type: 'room_status', roomId: `BBBB${String(i).padStart(2, '0')}` });
        await new Promise((r) => setTimeout(r, 20));
      }
      await closed;
    });
  });

  describe('abuse limits', () => {
    it('disconnects a client that keeps guessing room ids', async () => {
      const ws = await connect();
      const closed = new Promise((resolve) => ws.once('close', resolve));
      for (let i = 0; i < 6; i++) {
        send(ws, { type: 'join_room', roomId: `AAAA${String(i).padStart(2, '0')}`, name: 'Flood Bot' });
        await new Promise((r) => setTimeout(r, 20));
      }
      await closed; // fails the test by timeout if the limiter never fires
    });

    it('disconnects a client that floods messages', async () => {
      const ws = await connect();
      const closed = new Promise((resolve) => ws.once('close', resolve));
      for (let i = 0; i < 25; i++) send(ws, { type: 'get_participants' });
      await closed;
    });
  });

  describe('answers from untrusted participants', () => {
    async function startedGame() {
      const presenter = await openRoom();
      const roomId = presenter.created.roomId;
      const player = await joinRoom(roomId, 'Alice Adams');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');
      await waitFor(player.ws, 'question');
      return { presenter, player, roomId };
    }

    it('refuses markup where a number is expected', async () => {
      const { presenter, player } = await startedGame();
      send(presenter.ws, { type: 'next_question' }); // on to the estimation question
      await waitFor(player.ws, 'question');

      send(player.ws, { type: 'submit_answer', answer: '<img src=x onerror=alert(1)>' });
      assert.strictEqual((await next(player.ws)).type, 'error');
    });

    it('refuses option indices that are strings', async () => {
      const { player } = await startedGame();
      // `"<img>" + 1` concatenates rather than adds, so a string index would
      // otherwise carry a payload through the presenter's results renderer.
      send(player.ws, { type: 'submit_answer', answer: ['<img src=x onerror=alert(1)>'] });
      assert.strictEqual((await next(player.ws)).type, 'error');
    });

    it('refuses out-of-range option indices', async () => {
      const { player } = await startedGame();
      send(player.ws, { type: 'submit_answer', answer: [99] });
      assert.strictEqual((await next(player.ws)).type, 'error');
    });

    it('accepts a well-formed answer and forwards it to the presenter', async () => {
      const { presenter, player } = await startedGame();
      const results = waitFor(presenter.ws, 'question_results');
      send(player.ws, { type: 'submit_answer', answer: [0, 2] });

      const msg = await results; // the room auto-ends once everyone has answered
      assert.strictEqual(msg.answers.length, 1);
      assert.deepStrictEqual(msg.answers[0].answer, [0, 2]);
      assert.strictEqual(msg.answers[0].points, 100);
    });
  });

  describe('one socket, one participant', () => {
    it('refuses a second join_room on a connection that has already joined', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const player = await joinRoom(roomId, 'Alice Adams');
      assert.strictEqual(player.reply.type, 'joined');

      send(player.ws, { type: 'join_room', roomId, name: 'Alice Again' });
      const refusal = await waitFor(player.ws, 'error');
      assert.match(refusal.message, /already joined/i);
      assert.strictEqual(player.ws.readyState, WebSocket.OPEN,
        'a confused client should be told what is wrong, not disconnected');
      assert.strictEqual(quizServer.roomManager.getRoom(roomId).getParticipantCount(), 1);
    });

    it('does not let a re-join answer the open question a second time', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const bob = await joinRoom(roomId, 'Bob Brown');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');
      await waitFor(alice.ws, 'question');
      await waitFor(bob.ws, 'question');

      send(alice.ws, { type: 'submit_answer', answer: [0, 2] });
      await waitFor(alice.ws, 'answer_accepted');

      // Re-joining used to mint a second participant id on Alice's socket:
      // that identity could answer the same question again, and the first one
      // -- which the presenter's results still referred to -- stopped
      // resolving to anybody and showed up as a phantom 'Unknown' row.
      send(alice.ws, { type: 'join_room', roomId, name: 'Alice Adams' });
      await waitFor(alice.ws, 'error');
      send(alice.ws, { type: 'submit_answer', answer: [1] });
      await new Promise((r) => setTimeout(r, 50));

      const results = waitFor(presenter.ws, 'question_results');
      send(bob.ws, { type: 'submit_answer', answer: [1] });
      const msg = await results;

      assert.strictEqual(msg.answers.length, 2, 'two people answered, so there are two answers');
      assert.ok(!msg.answers.some((a) => a.name === 'Unknown'),
        'the presenter must never be shown a row it cannot name');
      assert.strictEqual(msg.answers.filter((a) => a.name === 'Alice Adams').length, 1);
      assert.strictEqual(msg.leaderboard.find((p) => p.name === 'Alice Adams').score, 100);
    });
  });

  describe('ending the quiz on purpose', () => {
    it('ends the game where it stands instead of advancing', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const player = await joinRoom(roomId, 'Alice Adams');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');
      await waitFor(player.ws, 'question'); // the first of two questions

      const playerEnded = waitFor(player.ws, 'game_ended');
      const presenterEnded = waitFor(presenter.ws, 'game_ended');
      send(presenter.ws, { type: 'end_game' });
      await playerEnded;
      const ended = await presenterEnded;

      assert.ok(Array.isArray(ended.statistics.questions), 'the export must be ready at once');
      assert.strictEqual(quizServer.roomManager.getRoom(roomId).state, 'ended');
      // The whole point: `next_question` would have pushed question two.
      assert.ok(!player.ws.inbox.some((m) => m.type === 'question'));
    });

    it('is presenter-only, like every other control message', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const player = await joinRoom(roomId, 'Alice Adams');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(player.ws, 'question');

      send(player.ws, { type: 'end_game' });
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(quizServer.roomManager.getRoom(roomId).state, 'question');
    });
  });

  describe('post-game export', () => {
    it('delivers aggregate statistics when the quiz ends', async () => {
      const presenter = await openRoom();
      const roomId = presenter.created.roomId;
      const a = await joinRoom(roomId, 'Alice Adams');
      const b = await joinRoom(roomId, 'Bob Brown');

      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');
      send(a.ws, { type: 'submit_answer', answer: [0, 2] }); // correct
      send(b.ws, { type: 'submit_answer', answer: [1] });    // wrong
      await waitFor(presenter.ws, 'question_results');

      send(presenter.ws, { type: 'next_question' });
      await waitFor(presenter.ws, 'question_started');
      send(a.ws, { type: 'submit_answer', answer: 128 });
      send(b.ws, { type: 'submit_answer', answer: 64 });
      await waitFor(presenter.ws, 'question_results');

      const ended = waitFor(presenter.ws, 'game_ended');
      send(presenter.ws, { type: 'next_question' }); // ends the quiz
      const stats = (await ended).statistics;

      assert.strictEqual(stats.questions.length, 2);
      assert.strictEqual(stats.questions[0].correctCount, 1);
      assert.deepStrictEqual(stats.questions[0].options.map(o => o.count), [1, 1, 1]);
      assert.strictEqual(stats.questions[1].correctAnswer, 128);
      assert.strictEqual(stats.questions[1].withinTenPercent, 1);
      // The export must stay free of personal data.
      assert.ok(!JSON.stringify(stats).includes('Alice'));
    });

    it('re-sends statistics when the control view is reopened on a finished room', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');
      send(presenter.ws, { type: 'next_question' });
      await waitFor(presenter.ws, 'question_started');
      const ended = waitFor(presenter.ws, 'game_ended');
      send(presenter.ws, { type: 'next_question' }); // ends the quiz
      await ended;

      const reopened = await connect();
      send(reopened, { type: 'control_connect', presenterToken: tokenFor('michael'), roomId });
      const connected = await next(reopened);
      assert.strictEqual(connected.state, 'ended');

      send(reopened, { type: 'export_results' });
      const exported = await next(reopened);
      assert.strictEqual(exported.type, 'results_export');
      assert.ok(Array.isArray(exported.statistics.questions));
    });
  });

  describe('transport limits', () => {
    it('rejects a quiz larger than the payload cap', async () => {
      const ws = await connect();
      const quiz = {
        title: 'Oversized',
        questions: [{ type: 'estimation', text: 'x'.repeat(2 * 1024 * 1024), correctAnswer: 1 }]
      };
      send(ws, { type: 'create_room', presenterToken: tokenFor('big'), quiz });

      const outcome = await new Promise((resolve) => {
        ws.once('message', (data) => resolve({ kind: 'message', msg: JSON.parse(data) }));
        ws.once('close', () => resolve({ kind: 'close' }));
        setTimeout(() => resolve({ kind: 'timeout' }), 2000);
      });
      assert.notStrictEqual(outcome.kind, 'timeout', 'oversized payload should be rejected');
    });

    it('answers a CORS preflight', async () => {
      const res = await fetch(`${originFor('http', host, port)}/api/anything`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://other-origin.example' }
      });
      assert.strictEqual(res.status, 204);
      assert.ok(res.headers.get('access-control-allow-origin'));
      assert.ok(res.headers.get('access-control-allow-methods'));
    });
  });
});

/**
 * The failed-attempt budget, across reconnects.
 *
 * Its own server instance: the counters are per address and per server, and
 * the integration suite above deliberately spends its budget, so sharing a
 * server would let these tests pass for the wrong reason.
 */
describe('Failed-attempt budget', () => {
  let quizServer;
  let port;
  const host = loopbackHost();
  const sockets = [];

  before(async () => {
    quizServer = createQuizServer({
      limits: { maxFailedAttemptsPerWindow: 3 },
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

  async function probe(target = port) {
    const ws = new WebSocket(`${originFor('ws', host, target)}/ws`);
    sockets.push(ws);
    ws.on('error', () => {});
    ws.closed = new Promise((resolve) => ws.once('close', resolve));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  }

  /** One wrong room code, which costs exactly one slot of the budget. */
  function guess(ws, attempt) {
    ws.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: 'join_room',
      roomId: `CCCC${String(attempt).padStart(2, '0')}`,
      name: 'Flood Bot'
    }));
  }

  const closedWithin = (ws, ms = 1500) => Promise.race([
    ws.closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms))
  ]);

  it('is not reset by reconnecting', async () => {
    const first = await probe();
    for (let attempt = 0; attempt < 3; attempt++) {
      guess(first, attempt);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(first.readyState, WebSocket.OPEN, 'three guesses is still within the budget');

    first.close();
    await first.closed;
    await new Promise((r) => setTimeout(r, 50)); // let the server process the close
    assert.strictEqual(quizServer.ipState.size, 1, 'the counters must outlive the socket');

    // Closing the socket is what the limiter itself does once the budget is
    // spent, so a budget that started again here would make room-code probing
    // free: reconnect, guess, reconnect, guess.
    const second = await probe();
    guess(second, 9);
    assert.ok(await closedWithin(second), 'reconnecting handed the prober a fresh budget');
  });

  it('forgets the retained counters once their window has passed', async () => {
    // Keeping the counters must not mean keeping one entry per address that
    // ever mistyped a room code. The room sweep drops them as soon as the
    // window they describe is over.
    const shortLived = createQuizServer({
      limits: { maxFailedAttemptsPerWindow: 3, failedAttemptWindowMs: 100 },
      sweepIntervalMs: 30,
      heartbeatIntervalMs: 60_000
    });
    const shortPort = await shortLived.listen(0, host);

    const ws = await probe(shortPort);
    guess(ws, 0);
    await new Promise((r) => setTimeout(r, 50));
    ws.close();
    await ws.closed;
    assert.strictEqual(shortLived.ipState.size, 1);

    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(shortLived.ipState.size, 0, 'expired counters were never released');
    await shortLived.close();
  });
});

/**
 * The abuse limits on IPv6.
 *
 * This container has no IPv6 stack, so the addresses are fed in through
 * X-Forwarded-For with trustProxy enabled -- which exercises exactly the code
 * path that turns an address into a limit bucket, over whatever transport
 * happens to be available.
 */
describe('Abuse limits on IPv6', () => {
  let quizServer;
  let port;
  const host = loopbackHost();
  const sockets = [];

  before(async () => {
    quizServer = createQuizServer({
      trustProxy: true,
      limits: { maxRoomsPerIp: 1 },
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

  async function openRoomFrom(address, presenterName) {
    const ws = new WebSocket(`${originFor('ws', host, port)}/ws`, {
      headers: { 'X-Forwarded-For': address }
    });
    sockets.push(ws);
    ws.on('error', () => {});
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(JSON.stringify(withProtocolVersion({
      type: 'create_room',
      presenterToken: tokenFor(presenterName),
      quiz: QUIZ
    })));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 3000);
      ws.once('message', (data) => { clearTimeout(timer); resolve(JSON.parse(data)); });
    });
  }

  it('treats a whole IPv6 /64 as one client', async () => {
    // Anyone with a /64 -- which is the normal home or campus allocation --
    // can pick a fresh source address per connection. If the limits counted
    // addresses, this second request would sail through and every quota in the
    // server would be decorative on IPv6.
    const first = await openRoomFrom('2001:db8:1:2:aaaa::1', 'presenter-one');
    assert.strictEqual(first.type, 'room_created');

    const second = await openRoomFrom('2001:db8:1:2:ffff::9', 'presenter-two');
    assert.strictEqual(second.type, 'error', 'a new address in the same /64 evaded the room cap');
    assert.match(second.message, /too many/i);
  });

  it('still lets a genuinely different prefix through', async () => {
    const other = await openRoomFrom('2001:db8:9:9::1', 'presenter-three');
    assert.strictEqual(other.type, 'room_created');
  });

  it('does not count an IPv4 client against an IPv6 bucket', async () => {
    const ipv4 = await openRoomFrom('203.0.113.7', 'presenter-four');
    assert.strictEqual(ipv4.type, 'room_created');
  });

  it('treats an IPv4-mapped address as the IPv4 client it is', async () => {
    // ::ffff:203.0.113.7 is the same client as 203.0.113.7, which already has
    // its one room, so this must be refused rather than given a fresh bucket.
    const mapped = await openRoomFrom('::ffff:203.0.113.7', 'presenter-five');
    assert.strictEqual(mapped.type, 'error', 'an IPv4-mapped address opened a second bucket');
  });

  it('accepts the bracketed forwarded form', async () => {
    const bracketed = await openRoomFrom('[2001:db8:1:2:5555::5]:41234', 'presenter-six');
    assert.strictEqual(bracketed.type, 'error', 'bracketed form was not matched to its /64');
  });
});

/**
 * The per-client limits only mean anything if clients land in different
 * buckets. Behind a reverse proxy on the same host every connection arrives
 * from 127.0.0.1, so this used to require TRUST_PROXY=true -- and forgetting it
 * silently turned `maxRoomsPerIp` into a limit on the whole deployment.
 */
describe('Bucketing behind a local reverse proxy', () => {
  let quizServer;
  let port;
  const host = loopbackHost();
  const sockets = [];

  before(async () => {
    // No trustProxy option and no TRUST_PROXY env var: the default is what is
    // under test.
    quizServer = createQuizServer({
      limits: { maxRoomsPerIp: 1 },
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

  /** A socket carrying the header Caddy would add for `forwardedFor`. */
  async function proxiedSocket(forwardedFor) {
    const ws = new WebSocket(`${originFor('ws', host, port)}/ws`, {
      headers: { 'x-forwarded-for': forwardedFor }
    });
    sockets.push(ws);
    ws.inbox = [];
    ws.on('message', (data) => ws.inbox.push(JSON.parse(data)));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  }

  async function tryCreateRoom(ws, who) {
    ws.send(JSON.stringify(withProtocolVersion({
      type: 'create_room',
      presenterToken: tokenFor(who),
      quiz: QUIZ
    })));
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      created: ws.inbox.find((m) => m.type === 'room_created'),
      error: ws.inbox.find((m) => m.type === 'error')
    };
  }

  it('gives two forwarded addresses two separate budgets', async () => {
    const first = await tryCreateRoom(await proxiedSocket('203.0.113.7'), 'lecturer-one');
    assert.ok(first.created, 'the first lecturer should get a room');

    // With the limit at one room per client, this only succeeds if the second
    // lecturer is counted as a different client.
    const second = await tryCreateRoom(await proxiedSocket('198.51.100.42'), 'lecturer-two');
    assert.ok(second.created, 'a second forwarded address must not inherit the first budget');
    assert.notStrictEqual(second.created.roomId, first.created.roomId);
  });

  it('still holds one forwarded address to its own budget', async () => {
    const ws = await proxiedSocket('203.0.113.99');
    const first = await tryCreateRoom(ws, 'same-client-one');
    assert.ok(first.created, 'setup: the first room should be created');

    const again = await tryCreateRoom(await proxiedSocket('203.0.113.99'), 'same-client-two');
    assert.ok(!again.created, 'the same forwarded address must not get a second room');
    assert.ok(again.error, 'and should be told why');
  });
});

describe('limitsFromEnv', () => {
  /*
   * A deployment that cannot resize these is stuck with numbers chosen for
   * someone else's lecture hall, so the parsing has to be both usable and
   * unwilling to disable a limit by accident.
   */
  it('reads every limit', () => {
    assert.deepStrictEqual(limitsFromEnv({
      MAX_MESSAGES_PER_WINDOW: '120',
      MESSAGE_WINDOW_MS: '5000',
      MAX_FAILED_ATTEMPTS_PER_WINDOW: '80',
      FAILED_ATTEMPT_WINDOW_MS: '30000',
      MAX_ROOMS_PER_IP: '40',
      MAX_SOCKETS_PER_IP: '1200'
    }), {
      maxMessagesPerWindow: 120,
      messageWindowMs: 5000,
      maxFailedAttemptsPerWindow: 80,
      failedAttemptWindowMs: 30000,
      maxRoomsPerIp: 40,
      maxSocketsPerIp: 1200
    });
  });

  it('leaves unset variables alone', () => {
    assert.deepStrictEqual(limitsFromEnv({}), {});
  });

  it('keeps the default rather than accepting a value that would disable a limit', () => {
    // An empty or malformed value in a unit file must not read as zero, which
    // would refuse every connection.
    for (const bad of ['', '   ', '0', '-5', 'lots', 'NaN', 'Infinity']) {
      assert.deepStrictEqual(
        limitsFromEnv({ MAX_SOCKETS_PER_IP: bad }), {},
        `MAX_SOCKETS_PER_IP=${JSON.stringify(bad)} should be ignored`
      );
    }
  });

  it('is sized for a lecture hall rather than a household', () => {
    // A few hundred people behind one NATed address or one IPv6 /64 all land in
    // the same bucket; these numbers exist to survive that, not to be tuned.
    assert.ok(DEFAULT_LIMITS.maxSocketsPerIp >= 300,
      'a full lecture hall shares one egress address');
    assert.ok(DEFAULT_LIMITS.maxRoomsPerIp >= 10,
      'an institution runs several lectures at once from one address');
  });
});
