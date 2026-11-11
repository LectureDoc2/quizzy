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
import {
  createQuizServer, limitsFromEnv, DEFAULT_LIMITS, GENERIC_REJECTION, QUIZ_FINISHED,
  REJOIN_FAILED, SUPERSEDED_CLOSE_CODE
} from '../src/server.js';
import { PROTOCOL_VERSION } from '../../ld-quiz/src/protocol.js';
import { loopbackHost, originFor } from './loopback.js';

/**
 * Message types the server version-checks, and the version to stamp on them.
 *
 * Stamped centrally rather than at every call site: `protocolVersion` is part of
 * how a real client speaks, not part of what any individual test is about, and a
 * test that forgets it would fail for a reason unrelated to its subject.
 */
const HANDSHAKE_TYPES = new Set([
  'create_room', 'join_room', 'rejoin_room', 'control_connect', 'room_status', 'start_practice'
]);

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
      assert.strictEqual(reply.code, 'session_unavailable');
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
      assert.strictEqual(reply.code, 'quiz_finished');

      // A room that never existed stays opaque even after a valid name.
      const { reply: unknown } = await joinRoom('ZZZZZZ', 'Late Arrival');
      assert.strictEqual(unknown.message, GENERIC_REJECTION);
    });

    it('refuses a name with a code and parameters the join page can translate', async () => {
      const { created } = await openRoom();
      const { reply } = await joinRoom(created.roomId, 'A');
      assert.strictEqual(reply.type, 'error');
      assert.strictEqual(reply.code, 'name_too_short');
      assert.deepStrictEqual(reply.params, { min: 2 });
      assert.match(reply.message, /at least 2 characters/, 'the English text stays for older clients');
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
      const refusal = await next(player.ws);
      assert.strictEqual(refusal.type, 'error');
      assert.strictEqual(refusal.code, 'invalid_answer');
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

  describe('feedback on the results screen', () => {
    async function twoPlayers() {
      const presenter = await openRoom();
      const roomId = presenter.created.roomId;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const bob = await joinRoom(roomId, 'Bob Brown');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(alice.ws, 'question');
      await waitFor(bob.ws, 'question');
      return { presenter, roomId, alice, bob };
    }

    async function onEstimationQuestion() {
      const game = await twoPlayers();
      send(game.presenter.ws, { type: 'end_question' });
      await waitFor(game.alice.ws, 'results');
      await waitFor(game.bob.ws, 'results');
      send(game.presenter.ws, { type: 'next_question' });
      await waitFor(game.alice.ws, 'question');
      await waitFor(game.bob.ws, 'question');
      return game;
    }

    it('tells each participant whether their own choice was correct, and nothing more', async () => {
      const { alice, bob } = await twoPlayers();
      send(alice.ws, { type: 'submit_answer', answer: [2, 0] });
      send(bob.ws, { type: 'submit_answer', answer: [1] });

      const mine = (await waitFor(alice.ws, 'results')).feedback;
      assert.deepStrictEqual(mine, {
        question: { type: 'multiple-choice', text: QUIZ.questions[0].text, options: QUIZ.questions[0].options },
        answered: true,
        answer: [0, 2],
        isCorrect: true
      });

      const theirs = (await waitFor(bob.ws, 'results')).feedback;
      assert.deepStrictEqual(theirs.answer, [1], 'each participant sees only their own answer');
      assert.strictEqual(theirs.isCorrect, false);
      assert.ok(!('correctIndices' in theirs), 'the correct options are the presenter\'s to reveal');
    });

    it('ranks an estimate against the others without revealing the truth or their values', async () => {
      const { alice, bob } = await onEstimationQuestion();
      send(alice.ws, { type: 'submit_answer', answer: 100 });
      send(bob.ws, { type: 'submit_answer', answer: 130 });

      const bobs = (await waitFor(bob.ws, 'results')).feedback;
      assert.deepStrictEqual(bobs, {
        question: { type: 'estimation', text: QUIZ.questions[1].text },
        answered: true,
        answer: 130,
        answerCount: 2,
        rank: 1
      });

      const alices = (await waitFor(alice.ws, 'results')).feedback;
      assert.strictEqual(alices.rank, 2);
      assert.strictEqual(alices.answer, 100);
    });

    it('gives equally close estimates the same rank', async () => {
      const { alice, bob } = await onEstimationQuestion();
      send(alice.ws, { type: 'submit_answer', answer: 100 });
      send(bob.ws, { type: 'submit_answer', answer: 100 });

      const alices = (await waitFor(alice.ws, 'results')).feedback;
      const bobs = (await waitFor(bob.ws, 'results')).feedback;
      assert.strictEqual(alices.rank, 1);
      assert.strictEqual(bobs.rank, 1);
      assert.strictEqual(bobs.answerCount, 2);
    });

    it('passes on none of the quiz author\'s other question fields', async () => {
      const quiz = {
        ...QUIZ,
        questions: [{ ...QUIZ.questions[0], explanation: 'TCP and SCTP set up a connection.' }]
      };
      const presenter = await openRoom(tokenFor('michael', quiz), quiz);
      const alice = await joinRoom(presenter.created.roomId, 'Alice Adams');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(alice.ws, 'question');
      send(alice.ws, { type: 'submit_answer', answer: [0] });

      const results = await waitFor(alice.ws, 'results');
      assert.deepStrictEqual(Object.keys(results.feedback.question).sort(), ['options', 'text', 'type']);
      assert.ok(!JSON.stringify(results).includes('set up a connection'));
    });

    it('says so when a participant did not answer', async () => {
      const { presenter, alice, bob } = await twoPlayers();
      send(alice.ws, { type: 'submit_answer', answer: [0, 2] });
      send(presenter.ws, { type: 'end_question' });

      const feedback = (await waitFor(bob.ws, 'results')).feedback;
      assert.strictEqual(feedback.answered, false);
      assert.strictEqual(feedback.answer, null);
      assert.strictEqual(feedback.isCorrect, false);
    });

    it('gives no rank to somebody who did not estimate', async () => {
      const { presenter, alice, bob } = await onEstimationQuestion();
      send(alice.ws, { type: 'submit_answer', answer: 100 });
      send(presenter.ws, { type: 'end_question' });

      const feedback = (await waitFor(bob.ws, 'results')).feedback;
      assert.strictEqual(feedback.answered, false);
      assert.strictEqual(feedback.rank, null);
      assert.strictEqual(feedback.answerCount, 1);
    });

    it('is shown again to a participant who rejoins on the results screen', async () => {
      const { roomId, alice, bob } = await twoPlayers();
      send(alice.ws, { type: 'submit_answer', answer: [0, 2] });
      send(bob.ws, { type: 'submit_answer', answer: [1] });
      await waitFor(alice.ws, 'results');
      alice.ws.terminate();
      await new Promise((r) => setTimeout(r, 50));

      const ws = await connect();
      send(ws, { type: 'rejoin_room', roomId, resumeToken: alice.reply.resumeToken });
      assert.strictEqual((await next(ws)).type, 'rejoined');
      const replay = await waitFor(ws, 'results');
      assert.strictEqual(replay.feedback.isCorrect, true);
      assert.deepStrictEqual(replay.feedback.answer, [0, 2]);
    });
  });

  describe('accepting a short answer after all', () => {
    const TERMS = {
      title: 'Terms',
      secret: 'high-entropy-secret',
      questions: [{
        type: 'short-answer',
        text: 'Same name, different parameter lists?',
        acceptedAnswers: ['Overloading [of Methods]']
      }]
    };

    /** Alice right, Bob wrong; both answered, so the results are up. */
    async function closedQuestion() {
      const presenter = await openRoom(tokenFor('michael', TERMS), TERMS);
      const roomId = presenter.created.roomId;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const bob = await joinRoom(roomId, 'Bob Brown');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(alice.ws, 'question');
      await waitFor(bob.ws, 'question');
      send(alice.ws, { type: 'submit_answer', answer: 'Overloading' });
      send(bob.ws, { type: 'submit_answer', answer: 'Overload' });
      await waitFor(alice.ws, 'results');
      assert.strictEqual((await waitFor(bob.ws, 'results')).feedback.isCorrect, false);
      const results = await waitFor(presenter.ws, 'question_results');
      assert.strictEqual(results.answers.find((a) => a.name === 'Bob Brown').points, 0);
      // The control view groups the answers in the mode they were compared in.
      assert.strictEqual(results.match, 'fuzzy');
      return { presenter, roomId, alice, bob };
    }

    it('re-scores the group and sends everybody the results again', async () => {
      const { presenter, roomId, alice, bob } = await closedQuestion();
      send(presenter.ws, { type: 'accept_answer', questionIndex: 0, answer: 'overload' });

      const bobs = await waitFor(bob.ws, 'results');
      assert.strictEqual(bobs.feedback.isCorrect, true);
      assert.strictEqual(bobs.feedback.acceptedByPresenter, true);
      assert.deepStrictEqual(bobs.leaderboard.map((e) => e.score), [100, 100]);

      const alices = await waitFor(alice.ws, 'results');
      assert.strictEqual(alices.feedback.isCorrect, true);
      assert.ok(!('acceptedByPresenter' in alices.feedback));

      const control = await waitFor(presenter.ws, 'question_results');
      const bobsRow = control.answers.find((a) => a.name === 'Bob Brown');
      assert.strictEqual(bobsRow.points, 100);
      assert.strictEqual(bobsRow.acceptedByPresenter, true);
      assert.ok(!('acceptedByPresenter' in control.answers.find((a) => a.name === 'Alice Adams')));

      // Somebody who comes back gets the corrected verdict, not the first one.
      bob.ws.terminate();
      await new Promise((r) => setTimeout(r, 50));
      const ws = await connect();
      send(ws, { type: 'rejoin_room', roomId, resumeToken: bob.reply.resumeToken });
      assert.strictEqual((await next(ws)).type, 'rejoined');
      assert.strictEqual((await waitFor(ws, 'results')).feedback.acceptedByPresenter, true);
    });

    it('takes an acceptance back', async () => {
      const { presenter, bob } = await closedQuestion();
      send(presenter.ws, { type: 'accept_answer', questionIndex: 0, answer: 'Overload' });
      assert.strictEqual((await waitFor(bob.ws, 'results')).feedback.isCorrect, true);
      await waitFor(presenter.ws, 'question_results');

      send(presenter.ws, { type: 'accept_answer', questionIndex: 0, answer: 'Overload', accepted: false });
      const bobs = await waitFor(bob.ws, 'results');
      assert.strictEqual(bobs.feedback.isCorrect, false);
      assert.ok(!('acceptedByPresenter' in bobs.feedback));
      const control = await waitFor(presenter.ws, 'question_results');
      assert.strictEqual(control.answers.find((a) => a.name === 'Bob Brown').points, 0);
    });

    it('is the presenter\'s alone', async () => {
      const { presenter, alice, bob } = await closedQuestion();
      send(bob.ws, { type: 'accept_answer', questionIndex: 0, answer: 'Overload' });
      // Replies come in order, so once this one is back the attempt above
      // has been dealt with.
      send(bob.ws, { type: 'room_status', roomId: presenter.created.roomId });
      await waitFor(bob.ws, 'room_status');

      send(presenter.ws, { type: 'export_results' });
      const stats = (await waitFor(presenter.ws, 'results_export')).statistics;
      assert.strictEqual(stats.questions[0].correctCount, 1);
      assert.ok(!bob.ws.inbox.some((m) => m.type === 'results'), 'nothing was re-scored');
      assert.ok(!alice.ws.inbox.some((m) => m.type === 'results'));
    });

    it('ignores a click that arrives after the quiz has moved on, without an error', async () => {
      const { presenter, bob } = await closedQuestion();
      send(presenter.ws, { type: 'next_question' });
      await waitFor(presenter.ws, 'game_ended');
      await waitFor(bob.ws, 'game_ended');

      send(presenter.ws, { type: 'accept_answer', questionIndex: 0, answer: 'Overload' });
      send(presenter.ws, { type: 'export_results' });
      const reply = await waitFor(presenter.ws, 'results_export');
      assert.strictEqual(reply.statistics.questions[0].correctCount, 1);
      const unexpected = presenter.ws.inbox.filter((m) => m.type === 'error' || m.type === 'question_results');
      assert.deepStrictEqual(unexpected, []);
    });
  });

  describe('ordering questions', () => {
    const ORDER = {
      title: 'Literals',
      secret: 'high-entropy-secret',
      questions: [{
        type: 'ordering',
        text: 'Order by value (ascending).',
        options: ['<code>7</code>', '<code>0xB</code>', '<code>0x12</code>']
      }]
    };

    it('sends the items shuffled, maps the answer back, and scores it', async () => {
      const presenter = await openRoom(tokenFor('michael', ORDER), ORDER);
      const roomId = presenter.created.roomId;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const bob = await joinRoom(roomId, 'Bob Brown');
      send(presenter.ws, { type: 'start_game' });
      const { question } = await waitFor(alice.ws, 'question');
      assert.deepStrictEqual((await waitFor(bob.ws, 'question')).question, question);
      assert.notDeepStrictEqual(question.options, ORDER.questions[0].options);
      assert.deepStrictEqual([...question.options].sort(), [...ORDER.questions[0].options].sort());

      // Malformed: refused, and the participant may still answer.
      send(bob.ws, { type: 'submit_answer', answer: [0, 0, 1] });
      assert.strictEqual((await waitFor(bob.ws, 'error')).code, 'invalid_answer');

      const right = ORDER.questions[0].options.map((item) => question.options.indexOf(item));
      send(alice.ws, { type: 'submit_answer', answer: right });
      send(bob.ws, { type: 'submit_answer', answer: [0, 1, 2] });

      const alices = (await waitFor(alice.ws, 'results')).feedback;
      assert.deepStrictEqual(alices, {
        question: { type: 'ordering', text: ORDER.questions[0].text, options: question.options },
        answered: true,
        answer: right,
        isCorrect: true
      });
      const bobs = (await waitFor(bob.ws, 'results')).feedback;
      assert.strictEqual(bobs.isCorrect, false);
      assert.deepStrictEqual(bobs.answer, [0, 1, 2]);

      // The presenter gets the answers as items of the quiz: 0, 1, 2 is right.
      const control = await waitFor(presenter.ws, 'question_results');
      const row = (name) => control.answers.find((a) => a.name === name);
      assert.deepStrictEqual(row('Alice Adams').answer, [0, 1, 2]);
      assert.strictEqual(row('Alice Adams').points, 100);
      assert.strictEqual(row('Bob Brown').points, 0);
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
      assert.strictEqual(refusal.code, 'already_joined');
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
      // A second answer from the socket is now Alice changing her own answer,
      // which is allowed while the question is open -- never a second one.
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
      const aliceRows = msg.answers.filter((a) => a.name === 'Alice Adams');
      assert.strictEqual(aliceRows.length, 1);
      assert.deepStrictEqual(aliceRows[0].answer, [1], 'her changed answer, as her own');
      assert.strictEqual(msg.leaderboard.length, 2, 'and still two people on the board');
    });
  });

  describe('rejoining after a dropped connection', () => {
    const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
    const closed = (ws) => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve({ code: null });
      else ws.once('close', (code) => resolve({ code }));
    });

    async function rejoin(roomId, resumeToken) {
      const ws = await connect();
      send(ws, { type: 'rejoin_room', roomId, resumeToken });
      return { ws, reply: await next(ws) };
    }

    /** Drop a participant's socket the way a wifi handover does, and wait for the server to notice. */
    async function drop(ws, presenterWs) {
      const left = presenterWs ? waitFor(presenterWs, 'participant_left') : null;
      ws.terminate();
      return left ? left : settle();
    }

    it('hands the joining participant a resume token, and nobody else', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const token = alice.reply.resumeToken;
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);

      const bob = await joinRoom(roomId, 'Bob Brown');
      const joinedNote = await waitFor(presenter.ws, 'participant_joined');
      send(presenter.ws, { type: 'get_participants' });
      const list = await waitFor(presenter.ws, 'participants_list');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(bob.ws, 'question');
      send(bob.ws, { type: 'submit_answer', answer: [0] });
      send(alice.ws, { type: 'submit_answer', answer: [0] });
      const results = await waitFor(bob.ws, 'results');

      for (const msg of [joinedNote, list, results, bob.reply]) {
        assert.ok(!JSON.stringify(msg).includes(token), `token leaked in ${msg.type}`);
      }
    });

    it('brings a dropped participant back with their id and score', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const bob = await joinRoom(roomId, 'Bob Brown');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(alice.ws, 'question');
      await waitFor(bob.ws, 'question');
      send(alice.ws, { type: 'submit_answer', answer: [0, 2] });
      send(bob.ws, { type: 'submit_answer', answer: [1] });
      await waitFor(alice.ws, 'results');
      await waitFor(presenter.ws, 'question_results');
      presenter.ws.inbox.length = 0;

      const left = await drop(alice.ws, presenter.ws);
      assert.strictEqual(left.detached, true);
      assert.strictEqual(left.count, 1, 'count stays "connected right now"');
      assert.strictEqual(left.reconnecting, 1);
      const room = quizServer.roomManager.getRoom(roomId);
      assert.strictEqual(room.getLeaderboard().find((e) => e.name === 'Alice Adams').score, 100,
        'still on the board while away');

      const back = await rejoin(roomId, alice.reply.resumeToken);
      assert.strictEqual(back.reply.type, 'rejoined');
      assert.strictEqual(back.reply.participantId, alice.reply.participantId);
      assert.strictEqual(back.reply.state, 'results');
      assert.deepStrictEqual(back.reply.answeredQuestions, [0]);

      const replay = await waitFor(back.ws, 'results');
      assert.strictEqual(replay.leaderboard.find((e) => e.id === alice.reply.participantId).score, 100);

      const note = await waitFor(presenter.ws, 'participant_joined');
      assert.strictEqual(note.rejoined, true);
      assert.strictEqual(note.count, 2);
      assert.strictEqual(note.reconnecting, 0);
      assert.strictEqual(room.getLeaderboard().length, 2, 'a rejoin must not mint a second participant');
    });

    it('scores an answer given just before the drop', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const bob = await joinRoom(roomId, 'Bob Brown');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(alice.ws, 'question');
      send(alice.ws, { type: 'submit_answer', answer: [0, 2] });
      await waitFor(alice.ws, 'answer_accepted');
      await drop(alice.ws, presenter.ws);

      send(bob.ws, { type: 'submit_answer', answer: [1] });
      const results = await waitFor(presenter.ws, 'question_results');
      assert.strictEqual(results.answers.find((a) => a.name === 'Alice Adams').points, 100);
      assert.strictEqual(results.leaderboard.find((e) => e.name === 'Alice Adams').score, 100);
    });

    it('gives an answered-then-dropped participant their answer back, and takes a changed one', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const bob = await joinRoom(roomId, 'Bob Brown');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(alice.ws, 'question');
      send(alice.ws, { type: 'submit_answer', answer: [1] });
      await waitFor(alice.ws, 'answer_accepted');
      await drop(alice.ws, presenter.ws);

      const back = await rejoin(roomId, alice.reply.resumeToken);
      const question = await waitFor(back.ws, 'question');
      assert.strictEqual(question.alreadyAnswered, true);
      assert.strictEqual(question.questionIndex, 0);
      assert.deepStrictEqual(question.yourAnswer, [1], 'so the page can show it again');

      presenter.ws.inbox.length = 0;
      send(back.ws, { type: 'submit_answer', answer: [0, 2] });
      const accepted = await waitFor(back.ws, 'answer_accepted');
      assert.strictEqual(accepted.replaced, true);
      await settle();
      assert.ok(!presenter.ws.inbox.some((m) => m.type === 'answer_count'),
        'a replacement does not change the count of answers');

      const results = waitFor(presenter.ws, 'question_results');
      send(bob.ws, { type: 'submit_answer', answer: [1] });
      const msg = await results;
      assert.deepStrictEqual(msg.answers.find((a) => a.name === 'Alice Adams').answer, [0, 2],
        'the changed answer counts');
      assert.strictEqual(msg.answers.find((a) => a.name === 'Alice Adams').points, 100);
      assert.strictEqual(msg.answers.length, 2);
    });

    it('refuses a changed answer once the question has closed, and says which one counted', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const bob = await joinRoom(roomId, 'Bob Brown');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(alice.ws, 'question');
      send(alice.ws, { type: 'submit_answer', answer: [1] });
      await waitFor(alice.ws, 'answer_accepted');
      send(bob.ws, { type: 'submit_answer', answer: [1] });
      const results = await waitFor(alice.ws, 'results');
      assert.deepStrictEqual(results.feedback.answer, [1]);

      send(alice.ws, { type: 'submit_answer', answer: [0, 2] });
      const refusal = await waitFor(alice.ws, 'error');
      assert.strictEqual(refusal.code, 'no_open_question');
      const room = quizServer.roomManager.getRoom(roomId);
      assert.deepStrictEqual(room.currentAnswers.get(alice.reply.participantId).answer, [1]);
    });

    it('offers the open question again to somebody who had not answered yet', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      send(presenter.ws, { type: 'start_game' });
      await waitFor(alice.ws, 'question');
      await drop(alice.ws, presenter.ws);

      const back = await rejoin(roomId, alice.reply.resumeToken);
      const question = await waitFor(back.ws, 'question');
      assert.strictEqual(question.alreadyAnswered, false);
      send(back.ws, { type: 'submit_answer', answer: [0, 2] });
      // Alice is the only one present, so her answer closes the question.
      const results = await waitFor(back.ws, 'results');
      assert.strictEqual(results.leaderboard[0].score, 100);
    });

    it('refuses an unknown token and an unknown room alike, without spending the failure budget', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const ws = await connect();

      // The budget in this suite is 3; a whole hall's tokens can expire at
      // once, and that must not lock the hall's one address out.
      const replies = [];
      for (let i = 0; i < 6; i++) {
        send(ws, { type: 'rejoin_room', roomId: i % 2 ? roomId : 'ZZZZZZ', resumeToken: `bogus-${i}` });
        replies.push(await next(ws));
      }
      for (const reply of replies) {
        assert.deepStrictEqual(reply, { type: 'rejoin_failed', message: REJOIN_FAILED },
          'an unknown room and a wrong token must look the same');
      }
      assert.strictEqual(ws.readyState, WebSocket.OPEN);

      // ...and the same socket can then join as somebody new.
      send(ws, { type: 'join_room', roomId, name: 'Carol Clark' });
      assert.strictEqual((await next(ws)).type, 'joined');
    });

    it('refuses a token whose retention window has passed', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      await drop(alice.ws, presenter.ws);

      const room = quizServer.roomManager.getRoom(roomId);
      room.detached.get(alice.reply.participantId).detachedAt = 0; // long ago

      const back = await rejoin(roomId, alice.reply.resumeToken);
      assert.strictEqual(back.reply.type, 'rejoin_failed');
      assert.strictEqual(room.getLeaderboard().length, 0, 'and the record is gone');
    });

    it('closes the socket it supersedes, and frees its quota at once', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const oldClosed = closed(alice.ws);

      const quota = () => [...quizServer.ipState.values()].reduce((n, s) => n + s.sockets, 0);
      const fresh = await connect();
      const before = quota();
      send(fresh, { type: 'rejoin_room', roomId, resumeToken: alice.reply.resumeToken });
      assert.strictEqual((await next(fresh)).type, 'rejoined');
      assert.strictEqual(quota(), before - 1, 'the superseded socket still counts against the address');

      const { code } = await oldClosed;
      assert.strictEqual(code, SUPERSEDED_CLOSE_CODE);
      await settle();
      assert.strictEqual(quota(), before - 1, 'released twice');

      const room = quizServer.roomManager.getRoom(roomId);
      assert.strictEqual(room.getParticipantCount(), 1,
        'the old socket closing must not detach the participant who just came back');
      assert.strictEqual(room.getReconnectingCount(), 0);
    });

    it('does not let a kick be undone by reconnecting', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      await waitFor(presenter.ws, 'participant_joined');

      send(presenter.ws, { type: 'kick_participant', participantId: alice.reply.participantId });
      await waitFor(alice.ws, 'kicked');
      const left = await waitFor(presenter.ws, 'participant_left');
      assert.strictEqual(left.count, 0);
      assert.strictEqual(left.reconnecting, 0);

      const back = await rejoin(roomId, alice.reply.resumeToken);
      assert.strictEqual(back.reply.type, 'rejoin_failed');
    });

    it('refuses a rejoin on a socket that already speaks for somebody', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      const bob = await joinRoom(roomId, 'Bob Brown');

      send(bob.ws, { type: 'rejoin_room', roomId, resumeToken: alice.reply.resumeToken });
      assert.match((await waitFor(bob.ws, 'error')).message, /already joined/i);
      assert.strictEqual(alice.ws.readyState, WebSocket.OPEN, 'Alice must not have been superseded');
    });

    it('shows a participant who returns after the end their final result', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      await drop(alice.ws, presenter.ws);
      send(presenter.ws, { type: 'end_game' });
      await waitFor(presenter.ws, 'game_ended');

      const back = await rejoin(roomId, alice.reply.resumeToken);
      assert.strictEqual(back.reply.type, 'rejoined');
      assert.strictEqual(back.reply.state, 'ended');
      const final = await waitFor(back.ws, 'game_ended');
      assert.strictEqual(final.leaderboard[0].name, 'Alice Adams');
    });

    it('lists reconnecting participants to the presenter, flagged as such', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      await joinRoom(roomId, 'Bob Brown');
      await drop(alice.ws, presenter.ws);

      send(presenter.ws, { type: 'get_participants' });
      const { participants } = await waitFor(presenter.ws, 'participants_list');
      const byName = Object.fromEntries(participants.map((p) => [p.name, p.connected]));
      assert.deepStrictEqual(byName, { 'Alice Adams': false, 'Bob Brown': true });

      const control = await connect();
      send(control, { type: 'control_connect', presenterToken: tokenFor('michael'), roomId });
      const connected = await waitFor(control, 'control_connected');
      assert.strictEqual(connected.participantCount, 1);
      assert.strictEqual(connected.reconnectingCount, 1);
    });

    it('keeps room_status about who is actually there', async () => {
      const presenter = await openRoom();
      const { roomId } = presenter.created;
      const alice = await joinRoom(roomId, 'Alice Adams');
      await drop(alice.ws, presenter.ws);

      const ws = await connect();
      send(ws, { type: 'room_status', roomId });
      assert.strictEqual((await next(ws)).participantCount, 0);
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

  describe('consent to named results', () => {
    const NAMED_QUIZ = { ...QUIZ, recordNamedResults: true };
    const openNamedRoom = () => openRoom(tokenFor('michael', NAMED_QUIZ), NAMED_QUIZ);

    async function joinWithConsent(roomId, name, consent) {
      const ws = await connect();
      send(ws, { type: 'join_room', roomId, name, consent });
      return { ws, reply: await next(ws) };
    }

    async function statusOf(roomId) {
      const ws = await connect();
      send(ws, { type: 'room_status', roomId });
      return next(ws);
    }

    it('tells the join page whether the quiz asks for consent', async () => {
      const named = await openNamedRoom();
      assert.strictEqual((await statusOf(named.created.roomId)).recordsNamedResults, true);
      const plain = await openRoom();
      assert.strictEqual((await statusOf(plain.created.roomId)).recordsNamedResults, false);
    });

    it('records consent only when given as true, and says what it recorded', async () => {
      const { created } = await openNamedRoom();
      const alice = await joinWithConsent(created.roomId, 'Alice Adams', true);
      assert.strictEqual(alice.reply.type, 'joined');
      assert.strictEqual(alice.reply.recordsNamedResults, true);
      assert.strictEqual(alice.reply.consent, true);

      const bob = await joinWithConsent(created.roomId, 'Bob Brown', 'yes');
      assert.strictEqual(bob.reply.consent, false);
      const carol = await joinRoom(created.roomId, 'Carol Clark');
      assert.strictEqual(carol.reply.consent, false);
    });

    it('ignores consent, and refuses to change it, when the quiz does not ask', async () => {
      const { created } = await openRoom();
      const alice = await joinWithConsent(created.roomId, 'Alice Adams', true);
      assert.strictEqual(alice.reply.recordsNamedResults, false);
      assert.strictEqual(alice.reply.consent, false);

      send(alice.ws, { type: 'set_consent', consent: true });
      const refused = await next(alice.ws);
      assert.strictEqual(refused.type, 'error');
      assert.match(refused.message, /does not record named results/);
      assert.strictEqual(refused.code, 'consent_not_requested');
      assert.strictEqual(quizServer.roomManager.getRoom(created.roomId).participants.values().next().value.consent, false);
    });

    it('lets consent change until the end, and exports only those who gave it', async () => {
      const presenter = await openNamedRoom();
      const { roomId } = presenter.created;
      const alice = await joinWithConsent(roomId, 'Alice Adams', true);
      const bob = await joinWithConsent(roomId, 'Bob Brown', true);
      const carol = await joinRoom(roomId, 'Carol Clark');

      send(bob.ws, { type: 'set_consent', consent: false });
      assert.deepStrictEqual(await next(bob.ws), { type: 'consent_updated', consent: false });
      send(carol.ws, { type: 'set_consent', consent: 'please' });
      assert.strictEqual((await next(carol.ws)).code, 'consent_invalid');

      send(presenter.ws, { type: 'start_game' });
      await waitFor(presenter.ws, 'game_started');
      send(alice.ws, { type: 'submit_answer', answer: [0, 2] }); // correct
      send(bob.ws, { type: 'submit_answer', answer: [0, 2] });   // correct
      send(carol.ws, { type: 'submit_answer', answer: [1] });    // wrong
      await waitFor(presenter.ws, 'question_results');

      const midGame = await connect();
      send(midGame, { type: 'control_connect', presenterToken: tokenFor('michael', NAMED_QUIZ), roomId });
      await next(midGame);
      send(midGame, { type: 'export_results' });
      assert.strictEqual((await waitFor(midGame, 'results_export')).statistics.namedResults, null,
        'no names before the quiz has ended');

      const ended = waitFor(presenter.ws, 'game_ended');
      send(presenter.ws, { type: 'end_game' });
      const stats = (await ended).statistics;
      assert.strictEqual(stats.recordsNamedResults, true);
      assert.deepStrictEqual(stats.namedResults, [{ name: 'Alice Adams', score: 100 }]);
      assert.ok(!JSON.stringify(stats).includes('Bob'));
      assert.ok(!JSON.stringify(stats).includes('Carol'));

      await waitFor(alice.ws, 'game_ended');
      send(alice.ws, { type: 'set_consent', consent: false });
      const tooLate = await waitFor(alice.ws, 'error');
      assert.match(tooLate.message, /finished/);
      assert.strictEqual(tooLate.code, 'consent_closed');
      send(midGame, { type: 'export_results' });
      assert.deepStrictEqual((await waitFor(midGame, 'results_export')).statistics.namedResults,
        [{ name: 'Alice Adams', score: 100 }]);
    });

    it('gives the choice back on a rejoin', async () => {
      const presenter = await openNamedRoom();
      const { roomId } = presenter.created;
      const alice = await joinWithConsent(roomId, 'Alice Adams', true);
      const left = waitFor(presenter.ws, 'participant_left');
      alice.ws.terminate();
      await left;

      const ws = await connect();
      send(ws, { type: 'rejoin_room', roomId, resumeToken: alice.reply.resumeToken });
      const rejoined = await next(ws);
      assert.strictEqual(rejoined.type, 'rejoined');
      assert.strictEqual(rejoined.recordsNamedResults, true);
      assert.strictEqual(rejoined.consent, true);
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
      MAX_SOCKETS_PER_IP: '1200',
      MAX_PRACTICE_GAMES_PER_IP: '600'
    }), {
      maxMessagesPerWindow: 120,
      messageWindowMs: 5000,
      maxFailedAttemptsPerWindow: 80,
      failedAttemptWindowMs: 30000,
      maxRoomsPerIp: 40,
      maxSocketsPerIp: 1200,
      maxPracticeGamesPerIp: 600
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
    assert.ok(DEFAULT_LIMITS.maxPracticeGamesPerIp >= 200,
      'a hall practising before an exam shares one egress address');
  });
});
