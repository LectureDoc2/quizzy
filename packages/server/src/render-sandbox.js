/**
 * Turn a quiz as authored into the quiz a room plays -- without running the
 * renderers in this process.
 *
 * quiz-pipeline.js does the actual work, and it does it with KaTeX and
 * highlight.js. Both parse input from strangers (`create_room` is open to
 * anyone who can reach the WebSocket), and both run whatever their latest
 * release contains the moment they are imported. Neither belongs in the
 * process that holds every running lecture: a parser that loops freezes all
 * of them, a polluted Object.prototype corrupts all of them, and a compromised
 * package owns all of them. So this process never imports either. Each quiz is
 * rendered by a fresh render-worker.js, which is thrown away afterwards.
 *
 * ## What the worker may and may not do
 *
 * Child mode (the default) spawns the worker with Node's permission model:
 * read access to its own sources and to the two packages, nothing else -- no
 * writes, no child processes, no workers, no native addons -- plus frozen
 * intrinsics (prototype pollution throws) and no code generation from strings.
 *
 * The Node permission model is a seat belt, not a wall: its documentation is
 * explicit that it does not stop code that is already malicious. And Node 24
 * cannot restrict the network at all. Socket mode (`RENDER_SOCKET`) is the
 * wall: the worker runs as its own systemd unit, under a throwaway user, with
 * no network and a file system that contains only its code. DEPLOY.md §11c.
 *
 * ## What this side trusts
 *
 * Nothing but strings. The quiz is validated here first; the worker's reply is
 * held to the shape of the quiz that was sent; and the final quiz is built from
 * this side's own copy with only `text` and `options` taken from the reply. A
 * worker that has been subverted can therefore produce ugly or hostile *markup*
 * -- which the browsers' CSP is there for -- but cannot make a quiz score
 * differently, crash the auto-end timer, or hand this process anything but
 * plain data.
 *
 * Every failure fails closed: the quiz is refused with a sentence the
 * presenter can act on. There is no in-process fallback.
 */

import { spawn } from 'child_process';
import { connect } from 'net';
import { existsSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { validateQuiz } from './quiz-validator.js';

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(SOURCE_DIRECTORY, 'render-worker.js');

/** Generous for a lecture, finite for an attacker; see renderOptionsFromEnv(). */
const DEFAULT_RENDER_OPTIONS = {
  // A real quiz renders in well under a second.
  timeoutMs: 10_000,
  // KaTeX output is large -- \frac{a}{b} becomes over a kilobyte -- so this
  // is far above the 1 MB a quiz may arrive in.
  maxOutputBytes: 16 * 1024 * 1024,
  // Rooms are opened a few times per lecture, not per second. Two workers at a
  // time keep a flood of `create_room` from taking every core from the
  // lectures that are already running.
  maxConcurrency: 2,
  maxQueue: 16,
  memoryMb: 128
};

/** Kept for the log when a worker fails, so that a broken setup says why. */
const MAX_STDERR_BYTES = 4096;

const MAX_REPLY_ERRORS = 20;
const MAX_REPLY_WARNINGS = 200;
const MAX_MESSAGE_LENGTH = 1000;

/**
 * What the presenter is told, by failure. Specific enough to act on, vague
 * about the machinery: it goes to whoever sent the quiz.
 */
const FAILURE_MESSAGES = {
  timeout: 'Rendering the formulas and code blocks of this quiz took too long. Please simplify them.',
  'too-large': 'This quiz is too large once its formulas and code blocks are rendered.',
  busy: 'The server is busy preparing other quizzes. Please try again in a moment.',
  failed: 'The quiz could not be prepared for display. Please try again.'
};

class RenderError extends Error {
  constructor(reason, detail) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
  }
}

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Per-deployment overrides, read like limitsFromEnv() in server.js: only
 * positive finite values are accepted, anything else keeps the default.
 */
function renderOptionsFromEnv(env = process.env) {
  const names = {
    RENDER_TIMEOUT_MS: 'timeoutMs',
    RENDER_MAX_OUTPUT_BYTES: 'maxOutputBytes',
    RENDER_MAX_CONCURRENCY: 'maxConcurrency',
    RENDER_MAX_QUEUE: 'maxQueue',
    RENDER_MEMORY_MB: 'memoryMb'
  };

  const options = {};
  for (const [variable, key] of Object.entries(names)) {
    if (env[variable] === undefined) continue;
    const value = Number(env[variable]);
    if (Number.isFinite(value) && value > 0) {
      options[key] = value;
    } else {
      console.warn(`Ignoring ${variable}=${JSON.stringify(env[variable])}: expected a positive number.`);
    }
  }
  if (env.RENDER_SOCKET) options.socketPath = env.RENDER_SOCKET;
  return options;
}

/**
 * The paths a package occupies, for `--allow-fs-read`.
 *
 * Both of them: the module resolver reads `node_modules/<name>/package.json`
 * by the path it walked to (a pnpm symlink), and the files themselves by
 * their real path in the store.
 */
function packagePaths(name) {
  for (let directory = SOURCE_DIRECTORY; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name);
    if (existsSync(candidate)) return [candidate, realpathSync(candidate)];
    if (dirname(directory) === directory) {
      throw new Error(`render sandbox: cannot locate the ${name} package`);
    }
  }
}

/** The node flags the worker runs under in child mode. */
function workerArguments({ memoryMb, workerPath }) {
  const readable = [
    SOURCE_DIRECTORY,
    workerPath,
    join(SOURCE_DIRECTORY, '..', 'package.json'), // "type": "module"
    ...packagePaths('katex'),
    ...packagePaths('highlight.js')
  ];
  return [
    '--permission',
    ...readable.map((path) => `--allow-fs-read=${path}`),
    '--frozen-intrinsics',
    '--disallow-code-generation-from-strings',
    `--max-old-space-size=${memoryMb}`,
    '--disable-warning=ExperimentalWarning', // --frozen-intrinsics announces itself
    workerPath
  ];
}

/**
 * Send `payload` down `writable`, read `readable` to its end, and give up on a
 * reply that is late or too big. `dispose` is called however it ends, and must
 * leave no worker behind.
 */
function converse({ writable, readable, emitters, dispose }, payload, { timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dispose();
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new RenderError('timeout', `no reply within ${timeoutMs} ms`)),
      timeoutMs
    );

    readable.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxOutputBytes) {
        finish(new RenderError('too-large', `reply exceeds ${maxOutputBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    readable.on('end', () => {
      let reply;
      try {
        reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(new RenderError('failed', 'the reply is not JSON'));
        return;
      }
      finish(null, reply);
    });

    // EPIPE on a worker that died before reading, ENOENT on a socket that is
    // not there, a spawn that failed: all the same to the presenter.
    for (const emitter of [readable, writable, ...emitters]) {
      emitter.on('error', (err) => finish(new RenderError('failed', err.message)));
    }

    writable.end(payload);
  });
}

function viaChild(payload, options) {
  const child = spawn(process.execPath, workerArguments(options), {
    cwd: SOURCE_DIRECTORY,
    // Not this process's environment: nothing in it is the worker's business,
    // and NODE_OPTIONS in particular could undo the flags above.
    env: {},
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8');
  });

  return converse({
    writable: child.stdin,
    readable: child.stdout,
    emitters: [child],
    // Also after a good reply: a worker that closed stdout and kept running
    // has no reason left to exist.
    dispose: () => child.kill('SIGKILL')
  }, payload, options).catch((err) => {
    if (stderr) err.message += `\n  worker stderr: ${stderr.trim().slice(0, MAX_STDERR_BYTES)}`;
    throw err;
  });
}

function viaSocket(payload, options) {
  // allowHalfOpen: the request ends with our end-of-file; the reply follows it.
  const socket = connect({ path: options.socketPath, allowHalfOpen: true });
  return converse({
    writable: socket,
    readable: socket,
    emitters: [],
    dispose: () => socket.destroy()
  }, payload, options);
}

/** Bound a list of strings that came from the worker before anyone sees it. */
function boundedMessages(value, max) {
  if (!Array.isArray(value)) return null;
  if (!value.every((message) => typeof message === 'string')) return null;
  return value.slice(0, max).map((message) => message.slice(0, MAX_MESSAGE_LENGTH));
}

/**
 * Build the playable quiz from this side's validated copy and the worker's
 * strings -- and nothing else from the worker.
 */
function adoptReply(quiz, reply) {
  if (!isPlainObject(reply)) throw new RenderError('failed', 'the reply is not an object');

  if (reply.ok === false) {
    const errors = boundedMessages(reply.errors, MAX_REPLY_ERRORS);
    if (!errors || errors.length === 0) throw new RenderError('failed', 'a refusal without reasons');
    return { valid: false, errors };
  }

  const warnings = boundedMessages(reply.warnings, MAX_REPLY_WARNINGS);
  if (reply.ok !== true || warnings === null || !Array.isArray(reply.questions) ||
      reply.questions.length !== quiz.questions.length) {
    throw new RenderError('failed', 'the reply does not match the quiz');
  }

  const questions = quiz.questions.map((question, index) => {
    const rendered = reply.questions[index];
    if (!isPlainObject(rendered) || typeof rendered.text !== 'string') {
      throw new RenderError('failed', `question ${index + 1} of the reply is malformed`);
    }
    const playable = { ...question, text: rendered.text };
    if (Array.isArray(question.options)) {
      const options = rendered.options;
      if (!Array.isArray(options) || options.length !== question.options.length ||
          !options.every((option) => typeof option === 'string')) {
        throw new RenderError('failed', `the options of question ${index + 1} of the reply are malformed`);
      }
      playable.options = [...options];
    }
    return playable;
  });

  return { valid: true, quiz: { ...quiz, questions }, warnings };
}

/**
 * A renderer with its own concurrency limit. One per process is the intent:
 * the entry point in server.js creates it and hands the same one to the room
 * server and to the practice catalog.
 *
 * @param {object} [overrides] See DEFAULT_RENDER_OPTIONS; also `socketPath`
 *   (socket mode) and `workerPath` (tests substitute a misbehaving worker).
 * @returns {{prepareQuiz: (quiz: unknown) => Promise<object>, options: object}}
 *   `prepareQuiz` resolves to what quiz-pipeline.js's prepareQuiz returns, and
 *   never rejects.
 */
function createRenderSandbox(overrides = {}) {
  const options = { ...DEFAULT_RENDER_OPTIONS, workerPath: WORKER_PATH, ...overrides };

  let active = 0;
  const waiting = [];

  function acquire() {
    if (active < options.maxConcurrency) {
      active++;
      return Promise.resolve();
    }
    if (waiting.length >= options.maxQueue) {
      return Promise.reject(new RenderError('busy', `${waiting.length} quizzes already waiting`));
    }
    return new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next in line
    else active--;
  }

  async function render(quiz) {
    await acquire();
    try {
      const payload = JSON.stringify(quiz);
      return await (options.socketPath ? viaSocket(payload, options) : viaChild(payload, options));
    } finally {
      release();
    }
  }

  async function prepareQuiz(quiz) {
    // Shape first, and here: it is cheap, it is our own code, and a quiz that
    // fails it is not worth a process.
    const structure = validateQuiz(quiz);
    if (!structure.valid) return { valid: false, errors: structure.errors };

    try {
      return adoptReply(quiz, await render(quiz));
    } catch (err) {
      const reason = err instanceof RenderError ? err.reason : 'failed';
      console.warn(`Rendering a quiz failed -- ${err.message}`);
      return { valid: false, errors: [FAILURE_MESSAGES[reason]] };
    }
  }

  return { prepareQuiz, options };
}

export { createRenderSandbox, renderOptionsFromEnv, workerArguments, DEFAULT_RENDER_OPTIONS };
