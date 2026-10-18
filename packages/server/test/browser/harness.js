/**
 * Shared harness for the browser tests.
 *
 * These tests exist because the most valuable properties of the control view
 * cannot be asserted in Node: whether the browser *executes* injected markup,
 * and whether the CSP actually blocks what it claims to. Both depend on a real
 * HTML parser and a real policy engine.
 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';
import { createHash } from 'crypto';
import { loopbackHost, hostForUrl, originFor } from '../loopback.js';
import { PROTOCOL_VERSION } from '../../../ld-quiz/src/protocol.js';

/** Handshake messages carry a version; see packages/ld-quiz/src/protocol.js. */
const HANDSHAKE_TYPES = new Set(['create_room', 'join_room', 'rejoin_room', 'control_connect', 'room_status']);

export const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

/**
 * The component package, which the page scripts share the wire protocol with.
 *
 * Production bundles the two together, so the import is resolved at build time
 * and never becomes a request. This harness serves the sources unbundled, so it
 * has to answer for the specifier the browser actually asks for.
 */
export const LD_QUIZ_ROOT = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ld-quiz', 'src'
);

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
};

/**
 * Serve packages/server/web the way Caddy does in production: the application
 * at the root with its page scripts under /js/, the embeddable component under
 * /component/, and /ws proxied to the backend.
 *
 * @param {number|null} backendPort Port to proxy /ws to, or null for no proxy.
 */
export async function startStaticServer(backendPort = null) {
  const server = createServer((req, res) => {
    let path = req.url.split('?')[0];
    let root = WEB_ROOT;
    if (path.startsWith('/component/')) {
      // The component is bundled into dist/component/ in production; the tests
      // serve its source directly, which is why protocol.js resolves below.
      root = LD_QUIZ_ROOT;
      path = path.slice('/component'.length);
    } else if (path.startsWith('/ld-quiz/src/')) {
      // Shared sources (protocol.js) resolve to here once the browser has
      // walked the relative specifier up out of the component directory.
      root = LD_QUIZ_ROOT;
      path = path.slice('/ld-quiz/src'.length);
    }
    try {
      const body = readFileSync(join(root, path));
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(path)] || 'text/plain' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  // Upgraded sockets are tracked so that close() can tear them down: an
  // http server will not finish closing while a hijacked connection is open,
  // which otherwise hangs the whole test process at teardown.
  const upgraded = new Set();

  if (backendPort !== null) {
    server.on('upgrade', (req, socket, head) => {
      upgraded.add(socket);
      socket.on('close', () => upgraded.delete(socket));
      // Tearing a proxied socket down mid-flight raises ECONNRESET on both
      // ends. Without a listener that becomes an uncaughtException and fails
      // the run even though every assertion passed.
      socket.on('error', () => {});
      const upstream = new WebSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
      upgraded.add(upstream);
      upstream.on('open', () => {
        const accept = createHash('sha1')
          .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
          `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        const raw = upstream._socket;
        socket.pipe(raw);
        raw.pipe(socket);
        if (head && head.length) raw.write(head);
      });
      upstream.on('error', () => { try { socket.destroy(); } catch { /* gone */ } });
    });
  }

  const host = loopbackHost();
  await new Promise((resolve) => server.listen(0, host, resolve));
  return {
    server,
    origin: `http://${hostForUrl(host)}:${server.address().port}`,
    async close() {
      for (const item of upgraded) {
        try {
          if (typeof item.terminate === 'function') item.terminate();
          else item.destroy();
        } catch { /* already gone */ }
      }
      upgraded.clear();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

/**
 * Launch Chromium.
 *
 * PLAYWRIGHT_CHROMIUM_PATH lets a sandbox or CI image point at a preinstalled
 * browser instead of one downloaded by `playwright install`.
 */
export async function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  try {
    return await chromium.launch(executablePath ? { executablePath } : {});
  } catch (cause) {
    // A missing browser is the expected state of a fresh checkout, because
    // pnpm-workspace.yaml blocks Playwright's postinstall on purpose. Left
    // alone, it surfaces as a failed `before` hook -- which the test runner
    // reports by cancelling every test beneath it, so the output is a column of
    // crosses against test names that are all perfectly fine. Say what actually
    // happened instead.
    throw new Error(
      'Chromium is not available, so the browser tests cannot run.\n' +
      '  Install it once:   pnpm --filter ld-quiz-server exec playwright install chromium\n' +
      '  Or use an existing build:\n' +
      '                     PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome pnpm test:browser\n' +
      `  (Playwright said: ${cause.message.split('\n')[0]})`,
      { cause }
    );
  }
}

/** Mirrors ld-quiz.js hashQuiz(quiz, presenterName). */
export function tokenFor(name, quiz) {
  return createHash('sha256').update(`${name}\u0000${JSON.stringify(quiz)}`).digest('hex');
}

/** Await a specific message type on a buffered socket. */
export function connectSocket(url) {
  const ws = new WebSocket(url);
  ws.inbox = [];
  ws.waiters = [];
  // Swallow the reset that arrives when the server is closed at teardown; the
  // opening handshake still surfaces its own failure through ws.opened below.
  ws.on('error', () => {});
  ws.on('message', (data) => {
    ws.inbox.push(JSON.parse(data));
    for (const waiter of [...ws.waiters]) waiter();
  });
  ws.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.take = (type, timeoutMs = 3000) =>
    new Promise((resolve, reject) => {
      const grab = () => {
        const i = ws.inbox.findIndex((m) => !type || m.type === type);
        return i === -1 ? undefined : ws.inbox.splice(i, 1)[0];
      };
      const immediate = grab();
      if (immediate) return resolve(immediate);
      const timer = setTimeout(() => {
        ws.waiters = ws.waiters.filter((w) => w !== check);
        reject(new Error(`timed out waiting for ${type || 'a message'}`));
      }, timeoutMs);
      const check = () => {
        const msg = grab();
        if (!msg) return;
        clearTimeout(timer);
        ws.waiters = ws.waiters.filter((w) => w !== check);
        resolve(msg);
      };
      ws.waiters.push(check);
    });
  ws.sendJson = (msg) => ws.send(JSON.stringify(
    HANDSHAKE_TYPES.has(msg.type) && msg.protocolVersion === undefined
      ? { protocolVersion: PROTOCOL_VERSION, ...msg }
      : msg
  ));
  return ws;
}
