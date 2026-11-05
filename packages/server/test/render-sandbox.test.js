/**
 * The render sandbox: KaTeX and highlight.js run in a worker process, and the
 * API server treats what comes back as untrusted.
 *
 * Most tests substitute scripted-render-worker.js, which misbehaves in the way
 * the quiz title asks for. It runs under the real worker's flags, so the
 * `probe` test is also a test of the sandbox itself.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import {
  createRenderSandbox, renderOptionsFromEnv, workerArguments, DEFAULT_RENDER_OPTIONS
} from '../src/render-sandbox.js';
import { prepareQuiz } from '../src/quiz-pipeline.js';
import { createQuizServer } from '../src/server.js';
import { PROTOCOL_VERSION } from '../../ld-quiz/src/protocol.js';
import { loopbackHost, originFor } from './loopback.js';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCES = resolve(here, '../src');
const SCRIPTED = join(here, 'scripted-render-worker.js');
const REAL_WORKER = join(SOURCES, 'render-worker.js');

const demoQuiz = (name) =>
  JSON.parse(readFileSync(resolve(here, '../../../quizzes/demo', name), 'utf8'));

/** A valid quiz; the scripted worker reads its title as a stage direction. */
const quiz = (title) => ({
  title,
  questions: [
    { type: 'multiple-choice', text: 'Pick $x$', options: ['A', 'B'], correctIndices: [0], timeLimit: 20 },
    { type: 'estimation', text: 'How many?', correctAnswer: 42 }
  ]
});

const scripted = (overrides = {}) =>
  createRenderSandbox({ workerPath: SCRIPTED, timeoutMs: 2000, ...overrides });

describe('Render sandbox', () => {
  it('renders exactly what the in-process pipeline renders', async () => {
    const sandbox = createRenderSandbox();
    for (const name of ['math-demo-quiz.en.json', 'code-demo-quiz.en.json']) {
      const authored = demoQuiz(name);
      assert.deepStrictEqual(await sandbox.prepareQuiz(authored), prepareQuiz(authored), name);
    }
  });

  it('refuses a malformed quiz before starting a worker', async () => {
    // A worker path that cannot run proves no worker was needed.
    const sandbox = createRenderSandbox({ workerPath: '/nonexistent/worker.js' });
    assert.deepStrictEqual(await sandbox.prepareQuiz({ questions: 'none' }), prepareQuiz({ questions: 'none' }));
  });

  it('confines the worker: no files, no processes, no prototype pollution, no eval, no environment', async () => {
    const result = await scripted().prepareQuiz(quiz('probe'));
    assert.strictEqual(result.valid, true);
    const { env, ...probe } = JSON.parse(result.quiz.questions[0].text);
    assert.deepStrictEqual(probe, {
      read: 'ERR_ACCESS_DENIED',
      write: 'ERR_ACCESS_DENIED',
      spawn: 'ERR_ACCESS_DENIED',
      pollute: 'TypeError',
      evaluate: 'EvalError'
    });
    // macOS hands every process __CF_USER_TEXT_ENCODING; nothing of ours.
    assert.deepStrictEqual(env.filter((name) => !name.startsWith('__CF_')), []);
  });

  it('kills a worker that never answers, without stalling this process', async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20);
    const started = Date.now();
    const result = await scripted({ timeoutMs: 400 }).prepareQuiz(quiz('spin'));
    clearInterval(ticker);

    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /took too long/);
    assert.ok(Date.now() - started < 2000, 'the timeout was not enforced');
    assert.ok(ticks >= 10, `the event loop stalled (${ticks} ticks)`);
  });

  it('stops reading a reply that will not end', async () => {
    const result = await scripted({ maxOutputBytes: 200_000 }).prepareQuiz(quiz('flood'));
    assert.strictEqual(result.valid, false);
    assert.match(result.errors[0], /too large/);
  });

  for (const title of ['not-json', 'too-few', 'bad-options', 'not-strings']) {
    it(`refuses a reply that does not fit the quiz (${title})`, async () => {
      const result = await scripted().prepareQuiz(quiz(title));
      assert.deepStrictEqual(result, {
        valid: false,
        errors: ['The quiz could not be prepared for display. Please try again.']
      });
    });
  }

  it('carries recordNamedResults through to the room, and refuses anything but a boolean', async () => {
    const sandbox = createRenderSandbox();
    const prepared = await sandbox.prepareQuiz({ ...quiz('Named'), recordNamedResults: true });
    assert.strictEqual(prepared.valid, true);
    assert.strictEqual(prepared.quiz.recordNamedResults, true);

    // Refused before a worker is needed, like any other shape error.
    const refused = await createRenderSandbox({ workerPath: '/nonexistent/worker.js' })
      .prepareQuiz({ ...quiz('Named'), recordNamedResults: 'false' });
    assert.strictEqual(refused.valid, false);
    assert.ok(refused.errors.some((e) => e.includes('recordNamedResults')), refused.errors.join('; '));
  });

  it('takes only the rendered strings from the worker', async () => {
    const authored = quiz('tamper');
    const result = await scripted().prepareQuiz(authored);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.quiz, {
      ...authored,
      questions: [
        { ...authored.questions[0], text: 'tampered', options: ['tampered', 'tampered'] },
        { ...authored.questions[1], text: 'tampered' }
      ]
    });
  });

  it('passes a refusal on, bounded', async () => {
    const result = await scripted().prepareQuiz(quiz('refuse'));
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].length, 1000);
  });

  it('runs at most maxConcurrency workers and turns away the overflow', async () => {
    const sandbox = scripted({ maxConcurrency: 1, maxQueue: 1, timeoutMs: 300 });
    const started = Date.now();
    const results = await Promise.all([
      sandbox.prepareQuiz(quiz('silent')),
      sandbox.prepareQuiz(quiz('silent')),
      sandbox.prepareQuiz(quiz('silent'))
    ]);
    assert.match(results[0].errors[0], /took too long/);
    assert.match(results[1].errors[0], /took too long/);
    assert.match(results[2].errors[0], /busy/);
    assert.ok(Date.now() - started >= 600, 'the second worker did not wait for the first');
  });

  describe('socket mode', () => {
    let directory;
    let server;
    let socketPath;

    /* Stands in for systemd's Accept=yes: one worker per connection, the
       connection as its stdin and stdout. */
    before(async () => {
      directory = mkdtempSync(join(tmpdir(), 'quizzy-render-'));
      socketPath = join(directory, 'render.sock');
      server = createServer({ allowHalfOpen: true }, (connection) => {
        const worker = spawn(process.execPath, workerArguments({
          memoryMb: DEFAULT_RENDER_OPTIONS.memoryMb, workerPath: REAL_WORKER
        }), { env: {}, stdio: ['pipe', 'pipe', 'inherit'] });
        connection.pipe(worker.stdin);
        worker.stdout.pipe(connection);
      });
      await new Promise((done) => server.listen(socketPath, done));
    });

    after(async () => {
      await new Promise((done) => server.close(done));
      rmSync(directory, { recursive: true, force: true });
    });

    it('renders through the socket exactly as in child mode', async () => {
      const authored = demoQuiz('math-demo-quiz.en.json');
      const result = await createRenderSandbox({ socketPath }).prepareQuiz(authored);
      assert.deepStrictEqual(result, prepareQuiz(authored));
    });

    it('fails closed when the socket is not there', async () => {
      const result = await createRenderSandbox({ socketPath: join(directory, 'missing.sock') }).prepareQuiz(quiz('x'));
      assert.strictEqual(result.valid, false);
      assert.match(result.errors[0], /could not be prepared/);
    });
  });

  it('reads its limits and its socket from the environment', () => {
    assert.deepStrictEqual(renderOptionsFromEnv({
      RENDER_TIMEOUT_MS: '2500',
      RENDER_MAX_CONCURRENCY: '0', // ignored: a limit of zero would refuse everything
      RENDER_SOCKET: '/run/quizzy-render.sock'
    }), { timeoutMs: 2500, socketPath: '/run/quizzy-render.sock' });
  });
});

describe('The API server process', () => {
  /** Every module server.js loads, by following its static and dynamic imports. */
  function importGraph(entry) {
    const files = new Set();
    const packages = new Set();
    const visit = (file) => {
      if (files.has(file)) return;
      files.add(file);
      const source = readFileSync(file, 'utf8');
      const specifiers = [
        ...source.matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s+['"]([^'"]+)['"]/gms),
        ...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
        ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
        else packages.add(specifier);
      }
    };
    visit(entry);
    return { files, packages };
  }

  it('never imports KaTeX, highlight.js or the pipeline that uses them', () => {
    const { files, packages } = importGraph(join(SOURCES, 'server.js'));

    // The walk works: it found what server.js does need.
    assert.ok(files.has(join(SOURCES, 'render-sandbox.js')));
    assert.ok(files.has(join(SOURCES, 'quiz-validator.js')));
    assert.ok(packages.has('express'));

    for (const name of ['quiz-pipeline.js', 'math-renderer.js', 'code-renderer.js', 'quiz-sanitizer.js']) {
      assert.ok(!files.has(join(SOURCES, name)), `server.js reaches ${name}`);
    }
    for (const name of packages) {
      assert.ok(!/^(katex|highlight\.js)(\/|$)/.test(name), `server.js reaches ${name}`);
    }
  });

  describe('create_room', () => {
    let quizServer;
    let port;
    const host = loopbackHost();
    const sockets = [];
    let renders = 0;

    before(async () => {
      const sandbox = scripted({ timeoutMs: 500 });
      quizServer = createQuizServer({
        limits: { maxRoomsPerIp: 1 },
        heartbeatIntervalMs: 60_000,
        prepareQuiz: (authored) => {
          renders++;
          return sandbox.prepareQuiz(authored);
        }
      });
      port = await quizServer.listen(0, host);
    });

    after(async () => {
      for (const ws of sockets) ws.terminate();
      await quizServer.close();
    });

    async function connect() {
      const ws = new WebSocket(`${originFor('ws', host, port)}/ws`);
      sockets.push(ws);
      ws.inbox = [];
      ws.on('message', (data) => ws.inbox.push(JSON.parse(data)));
      await new Promise((done, fail) => { ws.once('open', done); ws.once('error', fail); });
      return ws;
    }

    async function reply(ws, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (ws.inbox.length === 0) {
        if (Date.now() > deadline) throw new Error('no reply');
        await new Promise((done) => setTimeout(done, 10));
      }
      return ws.inbox.shift();
    }

    const send = (ws, msg) => ws.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...msg }));
    const token = (n) => String(n).repeat(64);

    it('refuses a quiz whose render hangs, keeps answering others, and gives the room slot back', async () => {
      const presenter = await connect();
      send(presenter, { type: 'create_room', presenterToken: token(1), quiz: quiz('spin') });

      // While the worker spins, the server still answers everybody else.
      const bystander = await connect();
      const asked = Date.now();
      send(bystander, { type: 'room_status', roomId: 'ABCDEF' });
      await reply(bystander);
      assert.ok(Date.now() - asked < 300, 'the server stalled while a quiz was rendering');

      const refusal = await reply(presenter);
      assert.strictEqual(refusal.code, 'invalid_quiz');
      assert.match(refusal.message, /took too long/);

      // maxRoomsPerIp is 1: this only works if the failed render released it.
      send(presenter, { type: 'create_room', presenterToken: token(2), quiz: quiz('fine') });
      assert.strictEqual((await reply(presenter)).type, 'room_created');
    });

    it('renders once for a burst of create_room with the same token', async () => {
      for (const roomId of [...quizServer.roomManager.rooms.keys()]) quizServer.roomManager.removeRoom(roomId);
      renders = 0;

      const first = await connect();
      const second = await connect();
      send(first, { type: 'create_room', presenterToken: token(3), quiz: quiz('fine') });
      send(second, { type: 'create_room', presenterToken: token(3), quiz: quiz('fine') });
      const [a, b] = [await reply(first), await reply(second)];

      assert.strictEqual(renders, 1);
      assert.strictEqual(a.type, 'room_created');
      assert.strictEqual(b.type, 'room_created');
      assert.strictEqual(a.roomId, b.roomId);
      assert.deepStrictEqual([a.resumed, b.resumed].sort(), [false, true]);
    });
  });
});
