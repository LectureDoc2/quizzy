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
import { createQuizServer, GENERIC_REJECTION, QUIZ_FINISHED } from '../src/server.js';

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
  const sockets = [];

  before(async () => {
    quizServer = createQuizServer({
      // Tightened so the limiter can be observed without sending 60 messages.
      limits: { maxMessagesPerWindow: 12, maxFailedAttemptsPerWindow: 3, maxRoomsPerIp: 2 },
      heartbeatIntervalMs: 60_000
    });
    port = await quizServer.listen(0, '127.0.0.1');
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

  const send = (ws, msg) => ws.send(JSON.stringify(msg));

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
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions?token=${tokenFor('michael')}`);
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
      const res = await fetch(`http://127.0.0.1:${port}/api/anything`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://other-origin.example' }
      });
      assert.strictEqual(res.status, 204);
      assert.ok(res.headers.get('access-control-allow-origin'));
      assert.ok(res.headers.get('access-control-allow-methods'));
    });
  });
});
