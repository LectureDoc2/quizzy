import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { pathToFileURL } from 'url';
import { RoomManager } from './rooms.js';
import { matchOf } from './short-answer.js';
// Not quiz-pipeline.js: KaTeX and highlight.js never run in this process. See
// render-sandbox.js.
import { createRenderSandbox, renderOptionsFromEnv } from './render-sandbox.js';
import { loadPracticeCatalog, emptyPracticeCatalog, DEFAULT_PRACTICE_CATALOG_PATH } from './practice-catalog.js';
import { openPracticeStats } from './practice-stats.js';
import { validateName } from './name-validator.js';
import { getServerAddresses } from './network-addresses.js';
import { clientKey, parseForwardedFor, isLoopbackAddress, DEFAULT_IPV6_PREFIX_BITS } from './client-address.js';
// Imported by path rather than as a dependency: the wire format has to be one
// file, and that file has to live inside the package that is published to npm,
// so that the component's tarball is self-contained. The server is private and
// always ships with the whole workspace, so it is the side that reaches across.
import {
  PROTOCOL_VERSION,
  PROTOCOL_MISMATCH,
  isCompatibleProtocol,
  protocolMismatchMessage
} from '../../ld-quiz/src/protocol.js';
import { readFileSync } from 'fs';

const MAX_QUIZ_SIZE = 1024 * 1024; // 1MB

const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

/**
 * Messages that open a conversation, and therefore have to agree on a version.
 *
 * Only these are checked. Re-verifying every `submit_answer` would cost a
 * comparison per answer to re-establish something that cannot have changed since
 * the socket was accepted.
 */
const HANDSHAKE_TYPES = new Set([
  'create_room', 'join_room', 'rejoin_room', 'control_connect', 'room_status', 'start_practice'
]);

/**
 * WebSocket close code for a participant socket that another connection has
 * taken over with the same resume token -- the same student on a newer socket,
 * or a duplicated tab. The join page treats it as final and does not
 * reconnect: two tabs sharing one identity would otherwise take it from each
 * other forever. Mirrored in web/js/quiz-client.js.
 */
const SUPERSEDED_CLOSE_CODE = 4000;

/** Said when a resume token is unknown, expired, or for an unknown room. */
const REJOIN_FAILED = 'Your previous session has expired. Please join again.';

// There is deliberately no endpoint that lists rooms. This application has no
// administrator role and no way to enumerate sessions: a room can only be
// reached by knowing its id, and it can only be controlled by presenting the
// token derived from the presenter's name plus the quiz.

/**
 * A single opaque failure message for everything a stranger could probe.
 *
 * "Room not found" and "Access denied" used to be distinguishable, which told
 * anyone guessing room ids which of their guesses had hit a real room. There is
 * nothing a legitimate user can do with that distinction that they cannot do
 * with this message.
 */
const GENERIC_REJECTION = 'Unable to open that session. Please check the room code and try again.';

/**
 * Said only to someone who has already supplied a valid name, so that arriving
 * late to a finished quiz reads as what it is rather than as a typo.
 */
const QUIZ_FINISHED = 'This quiz has already finished.';

/** Said for a practice quiz id that is not (or no longer) in the catalog. */
const PRACTICE_UNAVAILABLE = 'This practice quiz is not available. Please pick one from the list.';

/**
 * The name a practice player is recorded under. Practice is anonymous -- there
 * is nobody to show a name to -- but a participant record always has one.
 */
const PRACTICE_PLAYER_NAME = 'Practice';

// --- Abuse limits ------------------------------------------------------------
//
// Caddy can rate limit HTTP requests and the WebSocket *handshake*, but it
// cannot see the messages that flow inside an established socket -- and that is
// exactly where room-id probing happens (one upgrade, then thousands of
// join_room messages). So the limits that matter live here.
//
// Exposed as defaults so that tests can tighten them instead of having to send
// sixty messages to observe the limiter.
//
// ## Every "per IP" limit is really "per egress address"
//
// The sizing below follows from one fact that is easy to forget while writing
// the code and impossible to ignore in a lecture hall: **a whole audience
// usually shares one address.** Several hundred students on campus wifi leave
// through one NATed IPv4 address, or out of one IPv6 /64 -- and this server
// buckets IPv6 by /64 precisely so that a client cannot escape a limit by
// picking a new address (see client-address.js). Either way the room, the
// lecturer and every participant land in the same bucket.
//
// So these numbers are sized for an institution rather than for a household,
// and the thing actually holding abuse down is elsewhere: a room id is six
// characters from a 32-symbol alphabet, so there are about 10^9 of them and
// only a few are live at any moment. Guessing one is hopeless whether an
// attacker gets ten tries a minute or fifty.
//
// All of them can be overridden per deployment; see limitsFromEnv().

const DEFAULT_LIMITS = {
  // Per socket, not per address: this one bounds a single chatty client.
  maxMessagesPerWindow: 60,
  messageWindowMs: 10_000,
  // Wrong room ids per address per minute. A six-character code is easy to
  // mistype, and in the first minute of a large lecture a good number of people
  // will -- all from the same egress address.
  maxFailedAttemptsPerWindow: 50,
  failedAttemptWindowMs: 60_000,
  // Concurrent rooms per address. One per lecture in progress, and a university
  // behind one NAT may well be running a dozen at once.
  maxRoomsPerIp: 25,
  // Concurrent sockets per address: one per participant, plus the presenter and
  // the control window. Sized for a few hundred people in one hall.
  maxSocketsPerIp: 500,
  // Concurrent practice games per address, counted apart from maxRoomsPerIp so
  // that practising cannot use up the lectures' allowance. A game lingers for
  // DETACHED_RETENTION_MINUTES after its student leaves mid-game, so this is
  // sized for a hall practising at once, behind one address.
  maxPracticeGamesPerIp: 300
};

/**
 * Per-deployment overrides, so that a site is not stuck with numbers chosen for
 * a lecture hall it does not have.
 *
 * Only positive finite values are accepted; anything else keeps the default
 * rather than silently disabling a limit, because `MAX_SOCKETS_PER_IP=` (empty,
 * a very easy thing to leave in a unit file) would otherwise read as zero and
 * refuse every connection.
 */
function limitsFromEnv(env = process.env) {
  const names = {
    MAX_MESSAGES_PER_WINDOW: 'maxMessagesPerWindow',
    MESSAGE_WINDOW_MS: 'messageWindowMs',
    MAX_FAILED_ATTEMPTS_PER_WINDOW: 'maxFailedAttemptsPerWindow',
    FAILED_ATTEMPT_WINDOW_MS: 'failedAttemptWindowMs',
    MAX_ROOMS_PER_IP: 'maxRoomsPerIp',
    MAX_SOCKETS_PER_IP: 'maxSocketsPerIp',
    MAX_PRACTICE_GAMES_PER_IP: 'maxPracticeGamesPerIp'
  };

  const limits = {};
  for (const [variable, key] of Object.entries(names)) {
    if (env[variable] === undefined) continue;
    const value = Number(env[variable]);
    if (Number.isFinite(value) && value > 0) {
      limits[key] = value;
    } else {
      console.warn(`Ignoring ${variable}=${JSON.stringify(env[variable])}: expected a positive number.`);
    }
  }
  return limits;
}

const ROOM_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30_000;
// How much of a day's practice statistics a crash can cost; see practice-stats.js.
const PRACTICE_STATS_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Build a quiz server without starting it.
 *
 * Everything stateful -- the room manager, the per-address counters, the
 * timers -- is created per instance rather than at module scope, so that a test
 * can spin up an isolated server (and several of them) instead of inheriting
 * whatever the previous test left behind. The module only listens when it is
 * executed directly; see the bottom of this file.
 *
 * @param {object} [options]
 * @param {RoomManager} [options.roomManager]
 * @param {string[]} [options.allowedOrigins]
 * @param {boolean|'loopback'} [options.trustProxy] Whether X-Forwarded-For may
 *   be believed. `'loopback'` (the default) believes it only on a connection
 *   from this machine -- see resolveTrustProxy.
 * @param {object} [options.limits] Overrides for DEFAULT_LIMITS.
 * @param {number} [options.sweepIntervalMs]
 * @param {import('./practice-catalog.js').PracticeCatalog} [options.practiceCatalog]
 *   The quizzes offered for practice. Empty unless given: loading it from disk
 *   is the entry point's job, so that a test server never picks up the
 *   deployment's catalog.
 * @param {number} [options.practiceResultsMs] Overrides the catalog's
 *   `resultsSeconds`, so that tests need not wait thirty seconds.
 * @param {import('./practice-stats.js').PracticeStats} [options.practiceStats]
 *   Where practice games are counted. None unless given, for the same reason
 *   as the catalog: a test server must not count into the deployment's
 *   statistics.
 * @param {(quiz: unknown) => Promise<object>|object} [options.prepareQuiz]
 *   Turns an uploaded quiz into a playable one. Defaults to a fresh render
 *   sandbox (render-sandbox.js); the entry point passes the process-wide one.
 *   Tests that are not about rendering may pass quiz-pipeline.js's in-process
 *   function instead. Deliberately not configurable from the environment:
 *   there is no switch that puts the renderers back into this process.
 */
/**
 * How much to believe `X-Forwarded-For`, defaulting to the safe useful answer.
 *
 * This used to be `TRUST_PROXY === 'true'`, i.e. off unless someone remembered.
 * Forgetting was silent and expensive: behind a reverse proxy on the same host
 * every connection arrives from 127.0.0.1, so every client landed in one
 * bucket and `maxRoomsPerIp` -- five -- became a limit on the whole
 * deployment. The sixth lecture of the day could not start a room, and nothing
 * said why. The deployment guide even shipped a unit file without the variable.
 *
 * The default is now `'loopback'`: believe the header when the immediate peer
 * is this machine, ignore it otherwise. That is safe because the socket address
 * is chosen by the kernel rather than the peer, so nothing off-box can claim to
 * be the local proxy -- and it is right for every deployment in DEPLOY.md,
 * where Caddy and the API server share a host.
 *
 *   TRUST_PROXY=true    believe the header from anywhere. Only correct when a
 *                       proxy you control is the sole route to this port.
 *   TRUST_PROXY=false   never believe it; bucket by the socket address.
 *   unset               believe it on loopback only.
 */
function resolveTrustProxy(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return 'loopback';
}

function createQuizServer(options = {}) {
  const {
    roomManager = new RoomManager(),
    allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim()),
    trustProxy = resolveTrustProxy(process.env.TRUST_PROXY),
    sweepIntervalMs = ROOM_SWEEP_INTERVAL_MS,
    ipv6PrefixBits = Number(process.env.IPV6_PREFIX_BITS) || DEFAULT_IPV6_PREFIX_BITS,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    prepareQuiz = createRenderSandbox().prepareQuiz
  } = options;

  // Replaced wholesale on reload (see setPracticeCatalog); running games keep
  // the quiz object they started with.
  let practiceCatalog = options.practiceCatalog || emptyPracticeCatalog();
  const practiceResultsMs = () => options.practiceResultsMs ?? practiceCatalog.resultsMs;
  const practiceStats = options.practiceStats || null;

  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };

  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_QUIZ_SIZE });

  /** client key (see client-address.js) -> { failures, ... , rooms, sockets } */
  const ipState = new Map();

  function corsMiddleware(req, res, next) {
    const origin = req.headers.origin;
    if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  }

  app.use(corsMiddleware);

  /**
   * Where the browser code should look for everything else.
   *
   * The component used to hardcode `/ws`, `/join.html`, `/control.html` and
   * `/katex/`, which silently required the quiz server to own a domain root --
   * the one thing an institutional deployment usually cannot promise. Publishing
   * the layout means the server can move without every embedded copy of the
   * component having to be rebuilt and re-published to follow it.
   *
   * Paths are relative on purpose: the client resolves them against the URL it
   * already used to reach this endpoint, so nothing here has to know the public
   * origin -- which, behind a reverse proxy, it generally does not. Absolute URLs
   * are accepted for the split-host case (static files on a CDN, say).
   */
  const publicPaths = {
    ws: process.env.PUBLIC_WS_PATH || '/ws',
    join: process.env.PUBLIC_JOIN_PATH || '/join.html',
    control: process.env.PUBLIC_CONTROL_PATH || '/control.html',
    katexCss: process.env.PUBLIC_KATEX_CSS_PATH || '/katex/katex.min.css',
    highlightCss: process.env.PUBLIC_HIGHLIGHT_CSS_PATH || '/highlight/highlight.min.css',
    ...(options.publicPaths || {})
  };

  /**
   * Service discovery for embedders. Deliberately free of anything session- or
   * room-specific: it is world-readable, cacheable, and says only what any page
   * that is allowed to embed a quiz would learn by trying.
   */
  app.get('/api/config', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      maxQuizSize: MAX_QUIZ_SIZE,
      ...publicPaths
    });
  });

  /**
   * The practice catalog, for the practice page. Public by design -- it lists
   * what anyone may play -- and free of answers: titles, descriptions and
   * counts only. Not cached, so a reloaded catalog shows up at once.
   */
  app.get('/api/practice', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json({ quizzes: practiceCatalog.publicList() });
  });

  function stateForKey(key) {
    let state = ipState.get(key);
    if (!state) {
      state = { failures: 0, failureWindowStart: Date.now(), rooms: 0, sockets: 0, practiceGames: 0 };
      ipState.set(key, state);
    }
    return state;
  }

  /**
   * Drop a key's state once nothing is counted under it any more.
   *
   * The per-socket and per-room counts are meaningless with no sockets and no
   * rooms left, but the failure budget is not: rejectAndMaybeClose() closes
   * the socket the moment the budget runs out, so discarding the whole entry
   * here handed every prober a fresh budget on their next connection and made
   * room-code guessing effectively free. The counters are therefore kept for
   * the remainder of their window -- the same window recordFailure() would
   * have reset them at anyway, so an honest client that reconnects after a
   * dropped connection is no worse off than one that stayed.
   */
  function releaseKeyState(key) {
    const state = ipState.get(key);
    if (!state || state.sockets > 0 || state.rooms > 0 || state.practiceGames > 0) return;
    if (withinFailureWindow(state)) return;
    ipState.delete(key);
  }

  /** Whether a key's failure counters still say anything about right now. */
  function withinFailureWindow(state, now = Date.now()) {
    return state.failures > 0 && now - state.failureWindowStart < limits.failedAttemptWindowMs;
  }

  /**
   * Forget the failure counters that releaseKeyState() held on to.
   *
   * Swept rather than expired lazily on next access, because nothing
   * guarantees a next access: an address that spends its budget and never
   * returns is exactly the case worth remembering and exactly the case that
   * would never be looked at again, so lazy expiry would leave one entry per
   * prober for the lifetime of the process. Riding the room sweep below costs
   * no additional timer.
   */
  function sweepIpState(now = Date.now()) {
    for (const [key, state] of ipState) {
      if (state.sockets > 0 || state.rooms > 0 || state.practiceGames > 0) continue;
      if (withinFailureWindow(state, now)) continue;
      ipState.delete(key);
    }
  }

  /**
   * The key this connection is counted under by the abuse limits.
   *
   * Not simply the address. On IPv6 a client normally holds a whole /64 and can
   * use a fresh source address per connection at no cost, so counting addresses
   * would leave every limit below evadable by an ordinary client on an ordinary
   * connection. See client-address.js.
   *
   * Caddy terminates TLS and proxies, so the socket address is the proxy's;
   * X-Forwarded-For is believed only when explicitly configured, otherwise a
   * client could spoof the header and choose its own bucket.
   */
  function clientKeyFor(req) {
    const peer = req.socket.remoteAddress;
    const believeHeader = trustProxy === true || (trustProxy === 'loopback' && isLoopbackAddress(peer));

    if (believeHeader) {
      const forwarded = parseForwardedFor(req.headers['x-forwarded-for']);
      if (forwarded !== '') return clientKey(forwarded, { ipv6PrefixBits });
    }

    /* A loopback peer with no usable forwarded address means every client is
       about to share one bucket, which turns each per-client limit into a
       deployment-wide one. That is a misconfiguration rather than an attack,
       and it is invisible until a lecture fails to start -- so say it once. */
    if (isLoopbackAddress(peer)) warnAboutCollapsedBuckets();

    return clientKey(peer, { ipv6PrefixBits });
  }

  let warnedAboutBuckets = false;
  function warnAboutCollapsedBuckets() {
    if (warnedAboutBuckets) return;
    warnedAboutBuckets = true;
    console.warn(
      'Every connection is arriving from this machine without a usable ' +
      'X-Forwarded-For header, so all clients count as one: the per-client ' +
      `limits (maxRoomsPerIp=${limits.maxRoomsPerIp}, maxSocketsPerIp=` +
      `${limits.maxSocketsPerIp}) now apply to the whole deployment. ` +
      'Configure the reverse proxy to send X-Forwarded-For.'
    );
  }

  function withinMessageRate(ws) {
    const now = Date.now();
    if (now - ws.messageWindowStart >= limits.messageWindowMs) {
      ws.messageWindowStart = now;
      ws.messageCount = 0;
    }
    ws.messageCount++;
    return ws.messageCount <= limits.maxMessagesPerWindow;
  }

  function recordFailure(ws) {
    const state = stateForKey(ws.clientKey);
    const now = Date.now();
    if (now - state.failureWindowStart >= limits.failedAttemptWindowMs) {
      state.failureWindowStart = now;
      state.failures = 0;
    }
    state.failures++;
    if (state.failures > limits.maxFailedAttemptsPerWindow) {
      noteLimitHit('MAX_FAILED_ATTEMPTS_PER_WINDOW', limits.maxFailedAttemptsPerWindow);
      return true;
    }
    return false;
  }

  /**
   * Stop counting `ws` against its address's socket quota. Idempotent, because
   * a superseded socket is released the moment it is superseded -- not when the
   * heartbeat eventually notices it is dead -- and then closes later.
   */
  function releaseSocketQuota(ws) {
    if (!ws.clientKey || ws.quotaReleased) return;
    ws.quotaReleased = true;
    const state = ipState.get(ws.clientKey);
    if (state) {
      state.sockets = Math.max(0, state.sockets - 1);
      releaseKeyState(ws.clientKey);
    }
  }

  /**
   * @param {{code?: string, message: string}} [error] What to say. `code` lets
   *   the join page show the message in the participant's language.
   */
  function rejectAndMaybeClose(ws, error = { code: 'session_unavailable', message: GENERIC_REJECTION }) {
    ws.send(JSON.stringify({ type: 'error', ...error }));
    if (recordFailure(ws)) {
      ws.send(JSON.stringify({ type: 'error', code: 'rate_limited', message: 'Too many attempts. Please wait a minute.' }));
      ws.close();
    }
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.clientKey = clientKeyFor(req);
    ws.messageWindowStart = Date.now();
    ws.messageCount = 0;
    ws.createdRooms = 0;

    const state = stateForKey(ws.clientKey);
    if (state.sockets >= limits.maxSocketsPerIp) {
      noteLimitHit('MAX_SOCKETS_PER_IP', limits.maxSocketsPerIp);
      ws.send(JSON.stringify({ type: 'error', code: 'too_many_connections', message: 'Too many connections. Please try again later.' }));
      ws.close();
      return;
    }
    state.sockets++;

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', (err) => {
      if (err.message?.includes('Payload')) {
        console.warn('WebSocket payload too large');
        return;
      }
      console.error('WebSocket error:', err);
    });
    ws.on('message', (data) => handleMessage(ws, data));
  });

  /**
   * Send without letting the send become the failure.
   *
   * `ws.send` throws if the socket has closed between the check and the call,
   * which is a race no amount of guarding upstream can remove. Several call
   * sites are themselves inside `catch` blocks reporting an earlier problem;
   * there, a throw would escape the handler entirely and reach the process.
   * Nothing useful can be done about a message that cannot be delivered to a
   * socket that is gone, so it is dropped.
   */
  /**
   * Say, in the log, which limit just refused someone.
   *
   * Without this a full lecture hall hitting `maxSocketsPerIp` looks exactly
   * like a broken server from the outside: some people are in, the rest get
   * "try again later", and nothing on the host explains why. The refusal text
   * sent to the client is deliberately vague -- it goes to strangers -- so the
   * specific number has to surface here instead.
   *
   * Throttled per limit, because the situation that makes this worth logging is
   * also the situation that would otherwise write a line per rejected student.
   */
  const lastLimitReport = new Map();
  function noteLimitHit(name, value) {
    const now = Date.now();
    if (now - (lastLimitReport.get(name) ?? -Infinity) < 60_000) return;
    lastLimitReport.set(name, now);
    console.warn(
      `Refused a client: ${name} (${value}) reached for one address. ` +
      'Remember this counts a whole NATed network or IPv6 /64 as one client; ' +
      'see "Sizing the abuse limits" in DEPLOY.md.'
    );
  }

  function safeSend(ws, payload) {
    if (ws.readyState !== ws.OPEN) return false;
    try {
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return true;
    } catch (err) {
      console.warn('dropping a message to a socket that went away:', err.message);
      return false;
    }
  }

  /** Give back a room slot reserved by openRoomOnce() that no room took. */
  function releaseRoomSlot(key) {
    const state = ipState.get(key);
    if (!state) return;
    state.rooms = Math.max(0, state.rooms - 1);
    releaseKeyState(key);
  }

  /**
   * presenterToken -> the room being opened for it, while its quiz renders.
   *
   * The presenter page re-sends `create_room` on every reconnect, and a deck
   * with a flaky connection can do so several times before the first render
   * is back. They all carry the same quiz (the token is derived from it), so
   * they all wait for the same opening rather than each starting one -- and
   * rather than each needing a room slot of its own.
   */
  const openingRooms = new Map();

  /**
   * Render the quiz and open its room, once per token however many sockets ask.
   *
   * The room slot is reserved before the render, not after: otherwise a client
   * could have any number of renders in flight while it still "has" no rooms.
   * The room is opened even if every socket that asked has gone by the time
   * the render is back -- a presenter that reconnects resumes it, exactly as
   * after any other disconnect, and the room TTLs clear it otherwise.
   *
   * @returns {{opening: Promise<{room: object, created: boolean, warnings: string[]} |
   *   {errors: string[]} | {capacity: true}>, initiated: boolean}}
   */
  function openRoomOnce(presenterToken, quiz, creatorKey) {
    const pending = openingRooms.get(presenterToken);
    if (pending) return { opening: pending, initiated: false };

    stateForKey(creatorKey).rooms++;
    const opening = (async () => {
      let prepared;
      try {
        // Validated, then code, markup and math -- in that order, in a worker
        // process; see render-sandbox.js. The warnings go back to the presenter.
        prepared = await prepareQuiz(quiz);
      } catch (err) {
        releaseRoomSlot(creatorKey);
        throw err;
      }
      if (!prepared.valid) {
        releaseRoomSlot(creatorKey);
        return { errors: prepared.errors };
      }

      let opened;
      try {
        opened = roomManager.openRoom(presenterToken, prepared.quiz);
      } catch {
        releaseRoomSlot(creatorKey);
        return { capacity: true };
      }
      if (opened.resumed) {
        // Opened meanwhile by an earlier render of the same quiz; that room
        // already counts against its creator.
        releaseRoomSlot(creatorKey);
        return { room: opened.room, created: false, warnings: [] };
      }

      opened.room.creatorKey = creatorKey;
      if (prepared.warnings.length > 0) {
        console.warn(`Quiz "${prepared.quiz.title}" needed changes before it could be shown:`);
        for (const warning of prepared.warnings) console.warn(`  - ${warning}`);
      }
      return { room: opened.room, created: true, warnings: prepared.warnings };
    })().finally(() => openingRooms.delete(presenterToken));

    openingRooms.set(presenterToken, opening);
    return { opening, initiated: true };
  }

  // Create-or-resume. The presenter page re-sends this on every reconnect,
  // so it must be idempotent: see RoomManager.openRoom() and openRoomOnce().
  async function handleCreateRoom(ws, msg) {
    const { presenterToken, quiz } = msg;

    if (typeof presenterToken !== 'string' || presenterToken.length < 32) {
      rejectAndMaybeClose(ws, { message: 'Invalid presenter token.' });
      return;
    }

    // Resuming: keep the room, its code, its participants and its scores.
    // The quiz in the message is ignored -- the running room's copy wins.
    let room = roomManager.openRoomIfPresent(presenterToken);
    let resumed = room !== undefined;
    let warnings = [];

    if (!room) {
      // Joining an opening already under way costs no slot; starting one does.
      if (!openingRooms.has(presenterToken) && stateForKey(ws.clientKey).rooms >= limits.maxRoomsPerIp) {
        noteLimitHit('MAX_ROOMS_PER_IP', limits.maxRoomsPerIp);
        rejectAndMaybeClose(ws, { message: 'Too many open sessions from this address.' });
        return;
      }

      const { opening, initiated } = openRoomOnce(presenterToken, quiz, ws.clientKey);
      const outcome = await opening;

      if (outcome.errors) {
        safeSend(ws, {
          type: 'error',
          code: 'invalid_quiz',
          message: 'The quiz was rejected:\n  ' + outcome.errors.join('\n  ')
        });
        return;
      }
      if (outcome.capacity) {
        safeSend(ws, { type: 'error', code: 'server_at_capacity', message: 'The server is at capacity. Please try again later.' });
        return;
      }
      // The presenter may have given up while the quiz was rendering; the
      // room is there for them when they come back.
      if (ws.readyState !== ws.OPEN) return;

      room = outcome.room;
      resumed = !(initiated && outcome.created);
      if (!resumed) warnings = outcome.warnings;
    }

    room.addPresenter(ws);
    ws.roomId = room.roomId;
    ws.role = 'presenter';

    room.onAutoEnd = (results) => announceResults(room, results);

    safeSend(ws, {
      type: 'room_created',
      roomId: room.roomId,
      quizTitle: room.quiz.title,
      totalQuestions: room.quiz.questions.length,
      warnings,
      // Lets the presenter page say "reattached to RUNNING session" rather
      // than pretending a fresh room was made.
      resumed,
      state: room.state,
      currentQuestionIndex: room.currentQuestionIndex,
      participantCount: room.getParticipantCount()
    });
  }

  function handleMessage(ws, data) {
    const dataSize = Buffer.byteLength(data);
    if (dataSize > MAX_QUIZ_SIZE) {
      ws.send(JSON.stringify({ type: 'error', message: 'Quiz data exceeds maximum size of 1MB' }));
      return;
    }

    if (!withinMessageRate(ws)) {
      ws.send(JSON.stringify({ type: 'error', code: 'too_many_messages', message: 'Too many messages. Slowing you down.' }));
      ws.close();
      return;
    }

    try {
      const msg = JSON.parse(data);

      // Refuse a version we cannot speak -- including none at all -- and say so
      // in terms the lecturer can act on. See protocol.js for why absence is
      // treated as a mismatch rather than defaulted away.
      if (HANDSHAKE_TYPES.has(msg.type) && !isCompatibleProtocol(msg.protocolVersion)) {
        ws.send(JSON.stringify({
          type: 'error',
          code: PROTOCOL_MISMATCH,
          message: protocolMismatchMessage(msg.protocolVersion)
        }));
        // Not counted against the failure budget: this is a stale deployment,
        // not a probe, and the socket is closed anyway.
        ws.close();
        return;
      }

      switch (msg.type) {
        // Asynchronous, because rendering a new quiz happens in another
        // process. Nothing after this point may assume the room exists yet.
        case 'create_room':
          handleCreateRoom(ws, msg).catch((err) => {
            console.error('create_room failed:', err);
            safeSend(ws, { type: 'error', code: 'invalid_message', message: 'Invalid message' });
          });
          break;

        /**
         * State of a room, so the join page can say "quiz in progress" before a
         * participant types their name.
         *
         * Answers generically for anything a prober could sweep -- unknown and
         * finished rooms look identical here -- and counts against the same
         * per-address failure budget as a bad join. A live room is not a
         * secret: anyone holding the code is meant to be able to walk in.
         */
        case 'room_status': {
          const room = roomManager.getRoom(msg.roomId);
          // A practice game belongs to its one student; to anybody else its
          // id is as unknown as one that was never issued.
          if (!room || room.practice || room.state === 'ended') {
            rejectAndMaybeClose(ws);
            return;
          }

          ws.send(JSON.stringify({
            type: 'room_status',
            roomId: room.roomId,
            state: room.state,
            quizTitle: room.quiz.title,
            totalQuestions: room.quiz.questions.length,
            // -1 while the room is still in the lobby.
            currentQuestionIndex: room.currentQuestionIndex,
            participantCount: room.getParticipantCount(),
            // Whether the join form offers consent to being named in the export.
            recordsNamedResults: room.recordsNamedResults()
          }));
          break;
        }

        case 'join_room': {
          const { roomId, name } = msg;

          // One socket is one participant, for the life of that socket.
          // Without this, a client that re-sent join_room -- a retry after a
          // reply it thought was lost, a page that wires the button up twice --
          // was minted a second participant id on the same connection, which
          // let it answer the open question again and left the presenter's
          // results listing a row whose id no longer resolved to anybody. The
          // socket is deliberately left open and not counted as a failed
          // attempt: this is a confused client rather than a prober, and
          // dropping it would cost a real participant their place in a running
          // quiz over somebody else's bug.
          if (ws.role) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'already_joined',
              message: 'This connection has already joined a quiz. Reload the page to join again.'
            }));
            return;
          }
        
          // Validate name first
          const nameValidation = validateName(name);
          if (!nameValidation.valid) {
            ws.send(JSON.stringify({
              type: 'error',
              code: nameValidation.code,
              params: nameValidation.params,
              message: nameValidation.error
            }));
            return;
          }
        
          const room = roomManager.getRoom(roomId);
          if (!room || room.practice) {
            // Opaque: a mistyped code and a code that was never issued must
            // look the same, or room ids become enumerable. A practice game
            // cannot be joined, so its id answers the same way.
            rejectAndMaybeClose(ws);
            return;
          }

          if (room.state === 'ended') {
            // Past the name check, so say something useful. This does confirm
            // the room existed, which is why it is not said before a join is
            // actually attempted -- and it still costs a failure budget slot.
            ws.send(JSON.stringify({ type: 'error', code: 'quiz_finished', message: QUIZ_FINISHED }));
            recordFailure(ws);
            return;
          }

          // Consent is opt-in: only a literal `true` counts, and only in a room
          // whose quiz asks for it (Room.addParticipant() checks that too).
          const participant = room.addParticipant(ws, nameValidation.name, msg.consent === true);
          ws.roomId = roomId;
          ws.role = 'participant';
          ws.participantId = participant.id;

          ws.send(JSON.stringify({
            type: 'joined',
            participantId: participant.id,
            roomId: roomId,
            quizTitle: room.quiz.title,
            // The only time the token is sent. It goes to its owner alone and
            // is never logged; see Room.resumeTokenFor().
            resumeToken: room.resumeTokenFor(participant.id),
            // Echoed, so the page shows what was recorded rather than what it
            // meant to send.
            recordsNamedResults: room.recordsNamedResults(),
            consent: participant.consent
          }));

          // Notify presenter
          room.sendToPresenter({
            type: 'participant_joined',
            participantId: participant.id,
            name: participant.name,
            count: room.getParticipantCount(),
            reconnecting: room.getReconnectingCount()
          });

          sendRoomState(ws, room, participant.id);
          break;
        }

        /**
         * Come back as an existing participant after a dropped connection or a
         * reload, by presenting the resume token handed out in `joined`.
         *
         * Every failure -- unknown room, unknown token, expired token -- gets
         * the same reply, so this is no better an oracle for room ids than
         * `room_status`. It is deliberately *not* charged to the failure
         * budget: tokens are 256 bits, so there is nothing to guess, and the
         * moment a whole hall's tokens expire together (an outage longer than
         * the retention window) is the moment every phone behind the hall's one
         * address presents a dead token at once. Charging those would burn the
         * budget and lock the hall out of joining again. The socket stays open,
         * so the page can fall back to `room_status` and a fresh join on it.
         */
        case 'rejoin_room': {
          if (ws.role) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'already_joined',
              message: 'This connection has already joined a quiz. Reload the page to join again.'
            }));
            return;
          }

          const room = roomManager.getRoom(msg.roomId);
          const reattached = room ? room.reattachParticipant(msg.resumeToken, ws) : null;
          if (!reattached) {
            ws.send(JSON.stringify({ type: 'rejoin_failed', message: REJOIN_FAILED }));
            return;
          }

          const { participant, supersededWs } = reattached;
          ws.roomId = room.roomId;
          ws.role = 'participant';
          ws.participantId = participant.id;

          if (supersededWs) {
            // The participant record has already moved to `ws`, and the old
            // socket is stripped of its role here, so its eventual close event
            // finds nothing to detach. Its quota is released now rather than
            // when it closes: a half-open socket can take the heartbeat a full
            // minute to notice, and a hall reconnecting at once would otherwise
            // be refused with "Too many connections" by its own dead sockets.
            supersededWs.roomId = undefined;
            supersededWs.role = undefined;
            supersededWs.participantId = undefined;
            releaseSocketQuota(supersededWs);
            try {
              supersededWs.close(SUPERSEDED_CLOSE_CODE, 'Continued on another connection');
            } catch { /* already gone */ }
          }

          ws.send(JSON.stringify({
            type: 'rejoined',
            participantId: participant.id,
            roomId: room.roomId,
            quizTitle: room.quiz.title,
            state: room.state,
            // The participant's own history, so the page can say which
            // questions closed while it was away rather than silently skipping
            // ahead. Only ever sent to its owner.
            answeredQuestions: participant.answers.map((a) => a.questionIndex),
            // So that a reload shows the choice again; the page keeps no copy.
            recordsNamedResults: room.recordsNamedResults(),
            consent: participant.consent,
            ...(room.practice ? { practice: true, practiceQuizId: room.practiceQuizId } : {})
          }));

          // A practice game waits on its results screen while its student is
          // away (see handleDisconnect); now that they are back, the countdown
          // starts again. Armed before sendRoomState so that the results it
          // sends carry the countdown. A timer that is still running -- the
          // student never actually detached -- is left alone.
          if (room.practice && room.state === 'results' && !room.advanceTimer) {
            schedulePracticeAdvance(room);
          }

          room.sendToPresenter({
            type: 'participant_joined',
            participantId: participant.id,
            name: participant.name,
            count: room.getParticipantCount(),
            reconnecting: room.getReconnectingCount(),
            rejoined: true
          });

          sendRoomState(ws, room, participant.id);
          break;
        }

        case 'control_connect': {
          const { presenterToken, roomId } = msg;

          // A room id is now mandatory. Previously, omitting it returned a list
          // of the token's sessions; that listing is gone, because this
          // application has no administrator and no legitimate need to enumerate.
          const room = roomId ? roomManager.getRoom(roomId) : undefined;

          // One message for "no such room", "wrong token" and "already finished".
          // A practice game has no presenter: its token is random and never
          // handed out, and it is refused here before any comparison.
          // timingSafeEqual is not used here on purpose: the token is compared
          // against a value the prober would have to know in the first place, and
          // the rate limit -- not constant time -- is what makes guessing futile.
          if (!room || room.practice || room.presenterToken !== presenterToken) {
            rejectAndMaybeClose(ws);
            return;
          }

          room.addPresenter(ws);
          ws.roomId = roomId;
          ws.role = 'presenter';

          ws.send(JSON.stringify({
            type: 'control_connected',
            roomId: room.roomId,
            state: room.state,
            quizTitle: room.quiz.title,
            totalQuestions: room.quiz.questions.length,
            currentQuestionIndex: room.currentQuestionIndex,
            question: room.getCurrentQuestion(),
            participantCount: room.getParticipantCount(),
            reconnectingCount: room.getReconnectingCount(),
            leaderboard: room.getLeaderboard()
          }));
          break;
        }

        case 'start_game': {
          const room = getRoomForPresenter(ws);
          if (!room) return;
        
          room.startGame();
          broadcastQuestion(room);

          room.sendToPresenter({
            type: 'game_started',
            questionIndex: 0,
            question: room.getCurrentQuestion(),
            participantCount: room.getParticipantCount()
          });
          break;
        }

        case 'end_question': {
          const room = getRoomForPresenter(ws);
          if (!room) return;
        
          announceResults(room, room.endQuestion());
          break;
        }

        case 'next_question': {
          const room = getRoomForPresenter(ws);
          if (!room) return;
        
          if (room.nextQuestion()) {
            broadcastQuestion(room);

            room.sendToPresenter({
              type: 'question_started',
              questionIndex: room.currentQuestionIndex,
              question: room.getCurrentQuestion()
            });
          } else {
            endGame(room);
          }
          break;
        }

        // Stop the quiz where it stands, whichever question it is on.
        // `next_question` also ends the game, but only once there is no next
        // question, and the control view's End Game button used to send
        // exactly that -- so pressing it early advanced the quiz for everyone
        // instead of finishing it. Presenter-only, by the same
        // getRoomForPresenter() check as every other control message.
        case 'end_game': {
          const room = getRoomForPresenter(ws);
          if (!room) return;

          endGame(room);
          break;
        }

        /**
         * The presenter counts a short answer as right after all -- or, with
         * `accepted: false`, takes that back. See Room.setAnswerAccepted().
         * Everybody gets the results again: the participants concerned a new
         * verdict, everybody the leaderboard it changed.
         *
         * A click that no longer applies -- from a results view that another
         * window has moved past -- is ignored rather than answered with an
         * error, which the control view would show in place of the room.
         */
        case 'accept_answer': {
          const room = getRoomForPresenter(ws);
          if (!room) return;

          const accepted = msg.accepted === undefined ? true : msg.accepted;
          const results = room.setAnswerAccepted(msg.questionIndex, msg.answer, accepted);
          if (results) announceResults(room, results);
          break;
        }

        /**
         * Start a practice game: one student, a quiz from the catalog, and no
         * presenter -- the server runs it (see schedulePracticeAdvance()).
         *
         * Anonymous, so there is no name to validate. An unknown quiz id is
         * not charged to the failure budget: the catalog is public, so there is
         * nothing to probe for. The game is charged to its address's practice
         * allowance, never to the lectures' maxRoomsPerIp.
         */
        case 'start_practice': {
          if (ws.role) {
            ws.send(JSON.stringify({
              type: 'error',
              code: 'already_joined',
              message: 'This connection has already joined a quiz. Reload the page to join again.'
            }));
            return;
          }

          const entry = practiceCatalog.get(msg.quizId);
          if (!entry) {
            safeSend(ws, { type: 'error', code: 'practice_unavailable', message: PRACTICE_UNAVAILABLE });
            return;
          }

          const ipLimits = stateForKey(ws.clientKey);
          if (ipLimits.practiceGames >= limits.maxPracticeGamesPerIp) {
            noteLimitHit('MAX_PRACTICE_GAMES_PER_IP', limits.maxPracticeGamesPerIp);
            safeSend(ws, { type: 'error', code: 'practice_rate_limited', message: 'Too many practice games from this address. Please try again later.' });
            return;
          }

          let room;
          try {
            room = roomManager.openPracticeRoom(entry.quiz);
          } catch {
            safeSend(ws, { type: 'error', code: 'server_at_capacity', message: 'The server is at capacity. Please try again later.' });
            return;
          }
          ipLimits.practiceGames++;
          room.creatorKey = ws.clientKey;
          room.practiceQuizId = entry.id;
          // What the game is counted under; see practice-stats.js.
          room.practiceEntry = entry;
          practiceStats?.gameStarted(entry);
          // Fixed for the game, like its quiz: a catalog reloaded mid-game
          // does not change how long this game's results stay up.
          room.practiceResultsMs = practiceResultsMs();
          // Results first arm the countdown, so that the results message can
          // carry it.
          room.onAutoEnd = (results) => {
            countPracticeQuestion(room, results);
            schedulePracticeAdvance(room);
            announceResults(room, results);
          };

          const participant = room.addParticipant(ws, PRACTICE_PLAYER_NAME);
          ws.roomId = room.roomId;
          ws.role = 'participant';
          ws.participantId = participant.id;

          safeSend(ws, {
            type: 'joined',
            participantId: participant.id,
            roomId: room.roomId,
            quizTitle: room.quiz.title,
            practice: true,
            practiceQuizId: entry.id,
            // As for join_room: sent once, to its owner, never logged.
            resumeToken: room.resumeTokenFor(participant.id)
          });

          room.startGame();
          broadcastQuestion(room);
          break;
        }

        // The practice student skips the rest of the countdown.
        case 'practice_next': {
          const room = roomManager.getRoom(ws.roomId);
          if (!room || !room.practice || ws.role !== 'participant' || !room.participants.has(ws)) return;
          if (room.state !== 'results') return;
          advancePractice(room);
          break;
        }

        case 'submit_answer': {
          const room = roomManager.getRoom(ws.roomId);
          // `participants.has(ws)` as well as the role: a socket that has just
          // been kicked or superseded may still deliver a message or two before
          // it finishes closing, and it no longer speaks for anybody.
          if (!room || ws.role !== 'participant' || !room.participants.has(ws)) return;

          // Participants are untrusted; reject anything that is not a well-formed
          // answer for the current question rather than storing it and letting it
          // reach the presenter's results view.
          const validation = room.validateAnswer(msg.answer);
          if (!validation.valid) {
            ws.send(JSON.stringify({ type: 'error', code: validation.code, message: validation.error }));
            return;
          }

          const success = room.submitAnswer(ws.participantId, msg.answer);
          if (success) {
            // Only send answer_accepted if the question is still active.
            // If auto-end triggered, the client will receive 'results' instead.
            if (room.state === 'question') {
              ws.send(JSON.stringify({ type: 'answer_accepted' }));
            }

            // Notify presenter of answer count
            room.sendToPresenter({
              type: 'answer_count',
              count: room.currentAnswers.size,
              totalParticipants: room.getParticipantCount()
            });
          }
          break;
        }

        /**
         * A participant gives or withdraws consent to having their name and
         * final score in the export. Possible until the game ends; the reply
         * is what the page shows, so it never displays a choice the server
         * did not record.
         */
        case 'set_consent': {
          const room = roomManager.getRoom(ws.roomId);
          // The same guard as submit_answer: a kicked or superseded socket no
          // longer speaks for anybody.
          if (!room || ws.role !== 'participant' || !room.participants.has(ws)) return;

          if (room.setConsent(ws.participantId, msg.consent)) {
            ws.send(JSON.stringify({ type: 'consent_updated', consent: msg.consent }));
          } else {
            const refusal = !room.recordsNamedResults()
              ? { code: 'consent_not_requested', message: 'This quiz does not record named results.' }
              : room.state === 'ended'
                ? { code: 'consent_closed', message: 'The quiz has finished, so your choice can no longer be changed.' }
                : { code: 'consent_invalid', message: 'Invalid consent value' };
            ws.send(JSON.stringify({ type: 'error', ...refusal }));
          }
          break;
        }

        case 'export_results': {
          const room = getRoomForPresenter(ws);
          if (!room) return;

          ws.send(JSON.stringify({
            type: 'results_export',
            statistics: room.getStatistics()
          }));
          break;
        }

        case 'get_participants': {
          const room = getRoomForPresenter(ws);
          if (!room) return;
        
          ws.send(JSON.stringify({
            type: 'participants_list',
            // Reconnecting participants included, flagged `connected: false`.
            participants: room.getParticipantList()
          }));
          break;
        }

        case 'kick_participant': {
          const room = getRoomForPresenter(ws);
          if (!room) return;

          let target = null;
          for (const [pws, p] of room.participants) {
            if (p.id === msg.participantId) {
              target = pws;
              break;
            }
          }

          // Purged -- record and resume token both -- before the socket is
          // closed. Closing alone would now merely detach them, and a kick would
          // be undone by the page's own automatic reconnect.
          if (!room.purgeParticipant(msg.participantId)) break;

          if (target) {
            safeSend(target, { type: 'kicked' });
            target.close();
          }

          room.sendToPresenter({
            type: 'participant_left',
            participantId: msg.participantId,
            count: room.getParticipantCount(),
            reconnecting: room.getReconnectingCount()
          });
          break;
        }

        default:
          console.log('Unknown message type:', msg.type);
      }
    } catch (err) {
      /* Reaching here means an untrusted message got past the per-case checks.
         That is a bug worth seeing in the log, but never a reason to drop the
         other lectures running in this process. */
      console.error('WebSocket message error:', err);
      safeSend(ws, { type: 'error', code: 'invalid_message', message: 'Invalid message' });
    }
  }

  function getRoomForPresenter(ws) {
    if (ws.role !== 'presenter') return null;
    return roomManager.getRoom(ws.roomId);
  }

  /** Send the room's current question to every participant. */
  function broadcastQuestion(room) {
    room.broadcastToParticipants({
      type: 'question',
      questionIndex: room.currentQuestionIndex,
      totalQuestions: room.quiz.questions.length,
      question: room.getPublicQuestion(),
      startTime: room.currentQuestionStartTime
    });
  }

  /**
   * Move a practice game on: the next question, or the end.
   *
   * Only from a results screen, so that a late timer or a double-pressed
   * Continue can never skip a question that is still open.
   */
  function advancePractice(room) {
    room.clearAdvanceTimer();
    if (room.state !== 'results') return;
    if (room.nextQuestion()) {
      broadcastQuestion(room);
    } else {
      endGame(room);
    }
  }

  /**
   * Count a closed practice question into the statistics. Every practice
   * question closes through onAutoEnd -- answered, or at its time limit, even
   * with the student gone -- so this sees each one exactly once.
   */
  function countPracticeQuestion(room, results) {
    if (!practiceStats) return;
    const [points = 0] = results.scores.values();
    practiceStats.questionClosed(room.practiceEntry, room.currentQuestionIndex, {
      answered: room.currentAnswers.size > 0,
      points
    });
  }

  /**
   * Leave a practice results screen up for the game's practiceResultsMs, then
   * move on.
   *
   * Only while the student is connected. A game nobody is watching would
   * otherwise play itself to the end while a phone sits in a pocket, and the
   * student would come back to a finished quiz. So it waits on the results
   * screen instead, and `rejoin_room` starts the countdown again.
   */
  function schedulePracticeAdvance(room) {
    room.clearAdvanceTimer();
    if (room.participants.size === 0) return;
    const delay = room.practiceResultsMs;
    room.advanceAt = Date.now() + delay;
    room.advanceTimer = setTimeout(() => {
      // Runs with no caller to catch it, like the question timer; see
      // Room.startQuestion().
      try {
        advancePractice(room);
      } catch (err) {
        console.error(`advancing practice game ${room.roomId} failed:`, err);
      }
    }, delay);
  }

  /**
   * Bring a participant's page up to where the room is: the open question,
   * the latest results, or the final board. Shared by a first join (a
   * latecomer) and a rejoin.
   *
   * `alreadyAnswered` is what keeps a student who answered, dropped and came
   * back from being shown a question they can no longer answer -- the server
   * would refuse a second answer, so the page must not invite one.
   */
  function sendRoomState(ws, room, participantId) {
    if (room.state === 'question') {
      safeSend(ws, {
        type: 'question',
        questionIndex: room.currentQuestionIndex,
        totalQuestions: room.quiz.questions.length,
        question: room.getPublicQuestion(),
        startTime: room.currentQuestionStartTime,
        alreadyAnswered: room.currentAnswers.has(participantId)
      });
    } else if (room.state === 'results') {
      const results = room.scoreQuestion(room.getCurrentQuestion());
      safeSend(ws, resultsMessage(room, participantId, results, room.getLeaderboard()));
    } else if (room.state === 'ended') {
      // Only reachable by a rejoin: a first join to a finished room is refused.
      safeSend(ws, {
        type: 'game_ended',
        leaderboard: room.getLeaderboard(),
        ...(room.practice ? { summary: room.getPracticeSummary() } : {})
      });
    }
  }

  /**
   * A participant's view of a closed question: the shared leaderboard plus
   * their own answer feedback (see Room.getAnswerFeedback()).
   */
  function resultsMessage(room, participantId, results, leaderboard) {
    const message = {
      type: 'results',
      questionIndex: room.currentQuestionIndex,
      leaderboard,
      waiting: room.currentQuestionIndex < room.quiz.questions.length - 1,
      feedback: room.getAnswerFeedback(participantId, results)
    };
    if (room.practice) {
      // Relative rather than a timestamp, so that a phone whose clock is off
      // still counts down the right number of seconds.
      message.practice = true;
      // A reload lands on a results screen without having seen a question.
      message.totalQuestions = room.quiz.questions.length;
      message.advanceInMs = room.advanceAt === null ? null : Math.max(0, room.advanceAt - Date.now());
    }
    return message;
  }

  /**
   * Tell everybody that the current question has closed. Shared by the
   * presenter's End Question and by the room closing a question by itself
   * (timer, or everybody answered), and sent again whenever the presenter
   * accepts a short answer after all. Each participant gets a message of their
   * own, since the feedback in it is about their answer.
   */
  function announceResults(room, results) {
    for (const [ws, participant] of room.participants) {
      safeSend(ws, resultsMessage(room, participant.id, results, results.leaderboard));
    }

    room.sendToPresenter({
      type: 'question_results',
      questionIndex: room.currentQuestionIndex,
      // How the control view groups the answers: the way they were compared.
      // The presenter's alone; participants have no use for it.
      match: matchOf(room.getCurrentQuestion()),
      answers: Array.from(room.currentAnswers.entries()).map(([pid, data]) => {
        const p = room.getParticipantById(pid);
        return {
          participantId: pid,
          name: p?.name || 'Unknown',
          answer: data.answer,
          points: results.scores.get(pid) || 0,
          timestamp: data.timestamp,
          // What the control view offers to take back; see accept_answer.
          ...(data.acceptedByPresenter ? { acceptedByPresenter: true } : {})
        };
      }),
      leaderboard: results.leaderboard
    });
  }

  /**
   * Finish the quiz and hand out the final results.
   *
   * Shared by `next_question` running out of questions and by the explicit
   * `end_game`, so that a quiz stopped early and one played to the last
   * question leave the room in the same state -- in particular 'ended', which
   * is what turns away late joins and starts the shorter retention clock.
   */
  function endGame(room) {
    // The presenter may stop the quiz with a question still open, and that
    // question's timer would otherwise sit there waiting to fire on a room
    // that no longer has a question to close.
    room.clearQuestionTimer();
    room.clearAdvanceTimer();
    room.state = 'ended';
    // Consent is frozen from here on; see Room.snapshotNamedResults().
    room.snapshotNamedResults();
    if (room.practice) practiceStats?.gameFinished(room.practiceEntry, room.getPracticeSummary());
    const finalLeaderboard = room.getLeaderboard();

    room.broadcastToParticipants({
      type: 'game_ended',
      leaderboard: finalLeaderboard,
      ...(room.practice ? { summary: room.getPracticeSummary() } : {})
    });

    // The presenter additionally gets the aggregate statistics, so the export
    // is ready the moment the quiz finishes rather than requiring the room to
    // still be alive later.
    room.sendToPresenter({
      type: 'game_ended',
      leaderboard: finalLeaderboard,
      statistics: room.getStatistics()
    });
  }

  function handleDisconnect(ws) {
    if (ws.roomId) {
      const room = roomManager.getRoom(ws.roomId);
      if (room) {
        if (ws.role === 'participant') {
          // Detached, not removed: the participant may come back with their
          // resume token. See Room.detachParticipant().
          const participant = room.detachParticipant(ws);
          if (participant && room.practice) {
            // Nobody else can ever reach a practice game. Finished, it is
            // gone at once; unfinished, it waits on its next results screen
            // (see schedulePracticeAdvance) until its student comes back or
            // their resume token expires.
            if (room.state === 'ended') {
              roomManager.removeRoom(room.roomId);
            } else {
              room.clearAdvanceTimer();
            }
          } else if (participant) {
            // Still `participant_left`, not a new message type: decks in the
            // wild bundle a component that updates its lobby count on exactly
            // this message, and `count` keeps meaning "connected right now".
            room.sendToPresenter({
              type: 'participant_left',
              participantId: participant.id,
              name: participant.name,
              count: room.getParticipantCount(),
              reconnecting: room.getReconnectingCount(),
              detached: true
            });
          }
        } else if (ws.role === 'presenter') {
          // Don't close the room, just note that presenter is offline.
          // They can reconnect and will be reattached to this same room.
          room.removePresenter(ws);
          room.sendToPresenter({
            type: 'presenter_disconnected',
            roomId: room.roomId
          });
        }
      }
    }

    releaseSocketQuota(ws);
  }

  roomManager.onRoomRemoved = (room) => {
    // A finished game is removed too, as soon as its student leaves; only one
    // that never ended was abandoned.
    if (room.practice && room.state !== 'ended') practiceStats?.gameAbandoned(room.practiceEntry);
    if (!room.creatorKey) return;
    const state = ipState.get(room.creatorKey);
    if (state) {
      if (room.practice) {
        state.practiceGames = Math.max(0, state.practiceGames - 1);
      } else {
        state.rooms = Math.max(0, state.rooms - 1);
      }
      releaseKeyState(room.creatorKey);
    }
  };
  // Keep connections alive. unref() so that an imported server never by itself
  // keeps a test process alive.
  /* Both intervals run with no caller. `ws.ping()` throws on a socket that
     closed since `wss.clients` was read, and a sweep walks room state that a
     message handler may have left half-updated -- neither is worth the process.
     See also the `uncaughtException` handler, which is the net below this one. */
  const heartbeat = setInterval(() => {
    try {
      wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        ws.ping();
      });
    } catch (err) {
      console.error('heartbeat failed:', err);
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  // Discard expired rooms, and the abuse counters that outlived their
  // sockets. Without this, every room ever created -- and every address that
  // ever failed an attempt -- stays in memory for the lifetime of the process.
  const sweepTimer = setInterval(() => {
    try {
      const removed = roomManager.sweep();
      if (removed.length > 0) {
        console.log(`Swept ${removed.length} expired room(s): ${removed.join(', ')}`);
      }
      sweepIpState();
    } catch (err) {
      console.error('sweep failed:', err);
    }
  }, sweepIntervalMs);
  sweepTimer.unref();


  return {
    app,
    server,
    wss,
    roomManager,
    limits,
    // The abuse counters, so that a test can assert they are both retained
    // across a reconnect and eventually released. Nothing in the running
    // server reads them through here.
    ipState,
    /** The catalog practice games are started from right now. */
    get practiceCatalog() {
      return practiceCatalog;
    },
    /**
     * Swap in a reloaded catalog. Games already running keep the quiz they
     * started with; only new games see the change.
     */
    setPracticeCatalog(catalog) {
      practiceCatalog = catalog || emptyPracticeCatalog();
    },
    /** Start listening; resolves with the bound port. */
    listen(port = 0, host) {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address().port));
      });
    },
    /** Shut everything down so a test process can exit cleanly. */
    async close() {
      clearInterval(heartbeat);
      clearInterval(sweepTimer);
      for (const client of wss.clients) client.terminate();
      for (const roomId of [...roomManager.rooms.keys()]) roomManager.removeRoom(roomId);
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

// Only listen when this file is the entry point. Importing it -- which the
// integration tests do -- must not bind a port or leave timers running.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  /*
   * The net below every other net.
   *
   * Everything reachable from a WebSocket message is validated and wrapped, so
   * in principle nothing gets here. In practice a lecture hall is a bad place
   * to discover that "in principle" was doing real work: Node's default for an
   * uncaught exception is to exit, and this process holds every room on the
   * host in memory, so one unanticipated throw ends every concurrent lecture.
   *
   * Staying up with one broken room beats taking down twenty working ones. The
   * trade -- a process may keep running in a state its author did not foresee
   * -- is acceptable here because rooms are independent and hold nothing that
   * outlives them: no database to corrupt, no file to half-write. The log line
   * is what turns this from hiding a bug into recording one.
   *
   * Installed only when this file is the entry point. A test importing the
   * module must still be allowed to fail loudly.
   */
  process.on('uncaughtException', (err) => {
    console.error('uncaught exception -- the server is staying up:', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('unhandled promise rejection -- the server is staying up:', reason);
  });

  const PORT = Number(process.env.PORT) || 3000;

  /*
   * `HOST` narrows what the backend binds to. Unset means every interface,
   * which is what a bare `pnpm dev` wants; a deployment behind Caddy should set
   * `HOST=127.0.0.1`, so that the only route to this port is through the proxy
   * that terminates TLS and adds X-Forwarded-For.
   */
  const HOST = process.env.HOST || undefined;

  /*
   * The practice catalog. Loaded here rather than inside createQuizServer, so
   * that a test server never picks up the deployment's quizzes, and reloaded on
   * SIGHUP (`systemctl reload`): restarting instead would end every lecture
   * running in this process.
   */
  const PRACTICE_CATALOG = process.env.PRACTICE_CATALOG || DEFAULT_PRACTICE_CATALOG_PATH;

  /*
   * One render sandbox for the process, shared by the rooms and the catalog,
   * so that its concurrency limit is a limit on the host and not per caller.
   */
  const renderSandbox = createRenderSandbox(renderOptionsFromEnv());
  const { prepareQuiz } = renderSandbox;
  console.log(renderSandbox.options.socketPath
    ? `Quizzes are rendered by the worker service at ${renderSandbox.options.socketPath}.`
    : 'Quizzes are rendered in sandboxed child processes.');

  const readPracticeCatalog = async () => {
    const { catalog, errors, warnings, missing } = await loadPracticeCatalog(PRACTICE_CATALOG, { prepareQuiz });
    if (missing) {
      console.log(`No practice catalog at ${PRACTICE_CATALOG}; practice mode is off.`);
    } else {
      console.log(`Practice catalog ${PRACTICE_CATALOG}: ${catalog.size} quiz(zes) available.`);
    }
    for (const error of errors) console.error(`  practice catalog: ${error}`);
    for (const warning of warnings) console.warn(`  practice catalog: ${warning}`);
    return catalog;
  };

  /*
   * Anonymous usage totals of the practice quizzes; see practice-stats.js.
   * Off unless PRACTICE_STATS_DIR names a directory to keep them in -- the
   * one place this process writes to.
   */
  const PRACTICE_STATS_DIR = process.env.PRACTICE_STATS_DIR || '';
  const practiceStatsStore = PRACTICE_STATS_DIR ? openPracticeStats(PRACTICE_STATS_DIR) : null;
  console.log(practiceStatsStore
    ? `Practice statistics are kept in ${PRACTICE_STATS_DIR}.`
    : 'Practice statistics are off (PRACTICE_STATS_DIR is not set).');

  const quizServer = createQuizServer({
    limits: limitsFromEnv(),
    practiceCatalog: await readPracticeCatalog(),
    practiceStats: practiceStatsStore?.stats,
    prepareQuiz
  });

  if (practiceStatsStore) {
    const flushPracticeStats = () => {
      try {
        practiceStatsStore.flush();
      } catch (err) {
        console.error('flushing the practice statistics failed:', err);
      }
    };
    setInterval(flushPracticeStats, PRACTICE_STATS_FLUSH_INTERVAL_MS).unref();
    // Node's default for these is to exit on the spot, which would lose the
    // totals since the last flush on every `systemctl restart`.
    for (const signal of ['SIGTERM', 'SIGINT']) {
      process.on(signal, () => {
        flushPracticeStats();
        process.exit(0);
      });
    }
  }

  /* Rendering the catalog takes a moment now. Until the new one is complete
     the old one stays in service, and a second SIGHUP in the meantime is
     ignored rather than racing the first. */
  let reloading = false;
  process.on('SIGHUP', () => {
    if (reloading) {
      console.log('SIGHUP: a reload of the practice catalog is already running.');
      return;
    }
    reloading = true;
    console.log('SIGHUP: reloading the practice catalog.');
    readPracticeCatalog()
      .then((catalog) => quizServer.setPracticeCatalog(catalog))
      .catch((err) => console.error('reloading the practice catalog failed:', err))
      .finally(() => { reloading = false; });
  });
  quizServer.listen(PORT, HOST).then(() => {
    console.log(`Quizzy backend listening on ${HOST ? `${HOST}:${PORT}` : `port ${PORT}`}`);
    console.log('Caddy (or another reverse proxy) should be the public entry point.');
    if (HOST) {
      console.log('  backend: bound to this host only; reachable through the proxy.');
    } else {
      for (const { url } of getServerAddresses(PORT)) {
        console.log(`  backend: ${url}`);
      }
    }
  });
}

export {
  createQuizServer,
  limitsFromEnv,
  GENERIC_REJECTION,
  QUIZ_FINISHED,
  REJOIN_FAILED,
  PRACTICE_UNAVAILABLE,
  SUPERSEDED_CLOSE_CODE,
  DEFAULT_LIMITS,
  MAX_QUIZ_SIZE,
  SERVER_VERSION,
  PROTOCOL_VERSION
};
