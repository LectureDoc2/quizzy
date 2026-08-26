/**
 * The integration contract with anything that is not this repository.
 *
 * These tests exist because the component and the server ship on different
 * schedules once the component is embeddable: a slide deck pins a bundled copy
 * and is re-published when its author feels like it, and an institutional quiz
 * server is updated when its administrator feels like it. Everything asserted
 * here is what keeps those two from meeting badly.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { WebSocket } from 'ws';
import { createHash } from 'crypto';
import { createQuizServer } from '../src/server.js';
import { PROTOCOL_VERSION, PROTOCOL_MISMATCH } from '../../ld-quiz/src/protocol.js';
import { loopbackHost, originFor } from './loopback.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'packages', 'server', 'web');

const QUIZ = {
  title: 'Protocol Quiz',
  questions: [
    { type: 'multiple-choice', text: 'Ping?', options: ['Pong', 'Nope'], correctIndices: [0] }
  ]
};

function tokenFor(name) {
  return createHash('sha256').update(`${name} ${JSON.stringify(QUIZ)}`).digest('hex');
}

describe('Integration contract', () => {
  let quizServer;
  let port;
  const host = loopbackHost();
  const sockets = [];

  before(async () => {
    quizServer = createQuizServer({ heartbeatIntervalMs: 60_000 });
    port = await quizServer.listen(0, host);
  });

  after(async () => {
    for (const ws of sockets) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    await quizServer.close();
  });

  async function connectTo(targetPort) {
    const ws = new WebSocket(`${originFor('ws', host, targetPort)}/ws`);
    sockets.push(ws);
    ws.inbox = [];
    ws.on('message', (data) => ws.inbox.push(JSON.parse(data)));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  }

  const connect = () => connectTo(port);

  /** First reply to `msg`, or null if the server closed without saying anything. */
  function replyTo(ws, msg, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for a reply to ${msg.type}`)),
        timeoutMs
      );
      const settle = (value) => { clearTimeout(timer); resolve(value); };
      if (ws.inbox.length > 0) return settle(ws.inbox.shift());
      ws.on('message', (data) => settle(JSON.parse(data)));
      ws.once('close', () => settle(null));
      ws.send(JSON.stringify(msg));
    });
  }

  describe('/api/config', () => {
    it('publishes everything an embedder would otherwise have to hardcode', async () => {
      const res = await fetch(`${originFor('http', host, port)}/api/config`);
      assert.strictEqual(res.status, 200);
      const config = await res.json();

      assert.strictEqual(config.protocolVersion, PROTOCOL_VERSION);
      assert.strictEqual(typeof config.serverVersion, 'string');
      assert.ok(config.maxQuizSize > 0);
      for (const key of ['ws', 'join', 'control', 'katexCss', 'highlightCss']) {
        assert.strictEqual(typeof config[key], 'string', `${key} must be published`);
        assert.ok(config[key].length > 0, `${key} must not be empty`);
      }
    });

    it('publishes stylesheet paths that a built deployment actually serves', async () => {
      /* Both stylesheets fail silently: a 404 leaves formulas in a fallback
         font and code in no colour at all, on a projector, mid-lecture. Two
         things have to line up for them not to -- the file exists under web/,
         and build.js copies its directory into dist/app -- and neither is
         checked anywhere else. */
      const res = await fetch(`${originFor('http', host, port)}/api/config`);
      const config = await res.json();
      const build = readFileSync(join(REPO_ROOT, 'build.js'), 'utf8');

      for (const key of ['katexCss', 'highlightCss']) {
        const path = config[key];
        assert.ok(path.startsWith('/'), `${key} default should be a server-relative path`);
        assert.ok(
          existsSync(join(WEB_ROOT, path)),
          `${key} is published as ${path}, but packages/server/web${path} does not exist`
        );
        const directory = path.split('/')[1];
        assert.ok(
          build.includes(`"packages/server/web/${directory}"`),
          `build.js does not copy packages/server/web/${directory}, so ${path} would 404 in dist/`
        );
      }
    });

    it('lets a deployment swap the stylesheets it serves', async () => {
      /* Both are a deployment's choice, not the component's: the highlighting
         theme especially, which an institution may want to match to its own
         slide template without rebuilding every embedded <ld-quiz>. */
      const relocated = createQuizServer({
        heartbeatIntervalMs: 60_000,
        publicPaths: {
          katexCss: 'https://cdn.example.com/katex.min.css',
          highlightCss: '/assets/github-dark.min.css'
        }
      });
      const relocatedPort = await relocated.listen(0, host);
      try {
        const url = `${originFor('http', host, relocatedPort)}/api/config`;
        const config = await (await fetch(url)).json();
        assert.strictEqual(config.katexCss, 'https://cdn.example.com/katex.min.css');
        assert.strictEqual(config.highlightCss, '/assets/github-dark.min.css');
      } finally {
        await relocated.close();
      }
    });

    it('is readable cross-origin, which is the only case it exists for', async () => {
      const res = await fetch(`${originFor('http', host, port)}/api/config`, {
        headers: { Origin: 'https://slides.example.com' }
      });
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
    });

    it('lets a deployment relocate its endpoints', async () => {
      // The point of the endpoint: a server that does not own a domain root can
      // still be found, without every embedded component being rebuilt.
      const relocated = createQuizServer({
        heartbeatIntervalMs: 60_000,
        publicPaths: { ws: '/quiz/ws', join: '/quiz/join.html' }
      });
      const relocatedPort = await relocated.listen(0, host);
      try {
        const url = `${originFor('http', host, relocatedPort)}/api/config`;
        const config = await (await fetch(url)).json();
        assert.strictEqual(config.ws, '/quiz/ws');
        assert.strictEqual(config.join, '/quiz/join.html');
        // Untouched keys keep their defaults rather than disappearing.
        assert.strictEqual(config.control, '/control.html');
      } finally {
        await relocated.close();
      }
    });
  });

  describe('protocol handshake', () => {
    it('accepts a client announcing the current version', async () => {
      const ws = await connect();
      const reply = await replyTo(ws, {
        type: 'create_room',
        protocolVersion: PROTOCOL_VERSION,
        presenterToken: tokenFor('current'),
        quiz: QUIZ
      });
      assert.strictEqual(reply.type, 'room_created');
    });

    it('refuses a client that announces no version at all', async () => {
      // Nothing predates the handshake, so there is no population of older
      // clients to accommodate -- and defaulting the field away would only mean
      // the first real incompatibility surfaces as something less legible.
      const ws = await connect();
      const reply = await replyTo(ws, {
        type: 'create_room',
        presenterToken: tokenFor('silent'),
        quiz: QUIZ
      });
      assert.strictEqual(reply.type, 'error');
      assert.strictEqual(reply.code, PROTOCOL_MISMATCH);
      assert.match(reply.message, /no version at all/);
    });

    it('refuses a version it does not speak, and names both sides', async () => {
      const ws = await connect();
      const reply = await replyTo(ws, {
        type: 'create_room',
        protocolVersion: PROTOCOL_VERSION + 1,
        presenterToken: tokenFor('future'),
        quiz: QUIZ
      });
      assert.strictEqual(reply.type, 'error');
      assert.strictEqual(reply.code, PROTOCOL_MISMATCH);
      // A lecturer reading this in a lecture hall has to learn which half is
      // stale, so both numbers have to be in the text.
      assert.match(reply.message, new RegExp(`\\b${PROTOCOL_VERSION}\\b`));
      assert.match(reply.message, new RegExp(`\\b${PROTOCOL_VERSION + 1}\\b`));
    });

    it('checks participants and control windows too, not only presenters', async () => {
      for (const type of ['join_room', 'control_connect', 'room_status']) {
        const ws = await connect();
        const reply = await replyTo(ws, {
          type,
          protocolVersion: 999,
          roomId: 'ABCD',
          name: 'Ada',
          presenterToken: tokenFor('whoever')
        });
        assert.strictEqual(reply.code, PROTOCOL_MISMATCH, `${type} must be version-checked`);
      }
    });

    it('does not leave a refused client hanging on a dead socket', async () => {
      const ws = await connect();
      await replyTo(ws, {
        type: 'create_room',
        protocolVersion: 999,
        presenterToken: tokenFor('doomed'),
        quiz: QUIZ
      });
      // Closed by the server: retrying a mismatch cannot succeed, so the client
      // must not be left believing it is still connected.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('socket stayed open after a refused handshake')),
          3000
        );
        if (ws.readyState === WebSocket.CLOSED) {
          clearTimeout(timer);
          return resolve();
        }
        ws.once('close', () => { clearTimeout(timer); resolve(); });
      });
    });

    it('does not spend the failure budget on a version mismatch', async () => {
      // A stale deployment is not a prober. Counting it would let one outdated
      // lecture hall lock out everyone sharing its address.
      const strict = createQuizServer({
        heartbeatIntervalMs: 60_000,
        limits: { maxFailedAttemptsPerWindow: 1 }
      });
      const strictPort = await strict.listen(0, host);
      try {
        for (let i = 0; i < 3; i++) {
          const ws = await connectTo(strictPort);
          const reply = await replyTo(ws, {
            type: 'create_room',
            protocolVersion: 999,
            presenterToken: tokenFor(`stale-${i}`),
            quiz: QUIZ
          });
          assert.strictEqual(
            reply.code,
            PROTOCOL_MISMATCH,
            `attempt ${i} should still be answered plainly`
          );
        }
      } finally {
        await strict.close();
      }
    });
  });
});
