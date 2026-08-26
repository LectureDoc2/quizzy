import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { pathToFileURL } from 'url';
import { RoomManager } from './rooms.js';
import { renderQuiz } from './math-renderer.js';
import { renderCodeInQuiz } from './code-renderer.js';
import { sanitizeQuiz } from './quiz-sanitizer.js';
import { validateQuiz } from './quiz-validator.js';
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
const HANDSHAKE_TYPES = new Set(['create_room', 'join_room', 'control_connect', 'room_status']);

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
  maxSocketsPerIp: 500
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
    MAX_SOCKETS_PER_IP: 'maxSocketsPerIp'
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
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS
  } = options;

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

  function stateForKey(key) {
    let state = ipState.get(key);
    if (!state) {
      state = { failures: 0, failureWindowStart: Date.now(), rooms: 0, sockets: 0 };
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
    if (!state || state.sockets > 0 || state.rooms > 0) return;
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
      if (state.sockets > 0 || state.rooms > 0) continue;
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

  function rejectAndMaybeClose(ws, message = GENERIC_REJECTION) {
    ws.send(JSON.stringify({ type: 'error', message }));
    if (recordFailure(ws)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Too many attempts. Please wait a minute.' }));
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
      ws.send(JSON.stringify({ type: 'error', message: 'Too many connections. Please try again later.' }));
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

  function handleMessage(ws, data) {
    const dataSize = Buffer.byteLength(data);
    if (dataSize > MAX_QUIZ_SIZE) {
      ws.send(JSON.stringify({ type: 'error', message: 'Quiz data exceeds maximum size of 1MB' }));
      return;
    }

    if (!withinMessageRate(ws)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Too many messages. Slowing you down.' }));
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
        // Create-or-resume. The presenter page re-sends this on every reconnect,
        // so it must be idempotent: see RoomManager.openRoom().
        case 'create_room': {
          const { presenterToken, quiz } = msg;

          if (typeof presenterToken !== 'string' || presenterToken.length < 32) {
            rejectAndMaybeClose(ws, 'Invalid presenter token.');
            return;
          }

          const existing = roomManager.openRoomIfPresent(presenterToken);
          let room;
          let resumed;
          let warnings = [];

          if (existing) {
            // Resuming: keep the room, its code, its participants and its scores.
            // The quiz in the message is ignored -- the running room's copy wins.
            room = existing;
            resumed = true;
          } else {
            const ipLimits = stateForKey(ws.clientKey);
            if (ipLimits.rooms >= limits.maxRoomsPerIp) {
              noteLimitHit('MAX_ROOMS_PER_IP', limits.maxRoomsPerIp);
              rejectAndMaybeClose(ws, 'Too many open sessions from this address.');
              return;
            }

            /* Shape first, markup second. A quiz that is not shaped like a
               quiz must never reach a room: the assumptions it would break are
               checked in scoring and in the auto-end timer, and the timer runs
               outside every try/catch. See quiz-validator.js. */
            const structure = validateQuiz(quiz);
            if (!structure.valid) {
              safeSend(ws, {
                type: 'error',
                code: 'invalid_quiz',
                message: 'The quiz was rejected:\n  ' + structure.errors.join('\n  ')
              });
              return;
            }

            /* Quiz markup is authored by the lecturer and rendered as HTML, so it
               is scrubbed (not escaped): the author is trusted, but should not be
               able to break their own quiz by accident. See quiz-sanitizer.js for
               the exact threat model.

               The three passes run in this order, and the order is load-bearing:

                 1. code   -- fenced blocks become <pre><code>, with every `&`,
                              `<` and `>` inside them escaped.
                 2. markup -- the sanitizer scrubs what the author wrote *around*
                              the code. It runs second precisely because step 1
                              has already escaped the code: a Java sample
                              containing <script>, or an HTML snippet being
                              taught, would otherwise be swallowed by the
                              blocklist.
                 3. math   -- KaTeX runs last and skips the code regions step 1
                              produced, so `echo $PATH` is not read as a formula.

               Steps 1 and 2 both report to the presenter through `warnings`. */
            const highlighted = renderCodeInQuiz(quiz);
            const sanitized = sanitizeQuiz(highlighted.quiz);
            warnings = [...highlighted.warnings, ...sanitized.warnings];
            if (warnings.length > 0) {
              console.warn(`Quiz "${sanitized.quiz.title}" needed changes before it could be shown:`);
              for (const warning of warnings) console.warn(`  - ${warning}`);
            }

            try {
              ({ room } = roomManager.openRoom(presenterToken, renderQuiz(sanitized.quiz)));
            } catch {
              ws.send(JSON.stringify({ type: 'error', message: 'The server is at capacity. Please try again later.' }));
              return;
            }
            resumed = false;
            ipLimits.rooms++;
            room.creatorKey = ws.clientKey;
          }

          room.addPresenter(ws);
          ws.roomId = room.roomId;
          ws.role = 'presenter';

          room.onAutoEnd = (results) => {
            room.broadcastToParticipants({
              type: 'results',
              questionIndex: room.currentQuestionIndex,
              leaderboard: results.leaderboard,
              waiting: room.currentQuestionIndex < room.quiz.questions.length - 1
            });
            room.sendToPresenter({
              type: 'question_results',
              questionIndex: room.currentQuestionIndex,
              answers: Array.from(room.currentAnswers.entries()).map(([pid, data]) => {
                const p = room.getParticipantById(pid);
                return {
                  participantId: pid,
                  name: p?.name || 'Unknown',
                  answer: data.answer,
                  points: results.scores.get(pid) || 0,
                  timestamp: data.timestamp
                };
              }),
              leaderboard: results.leaderboard
            });
          };
        
          ws.send(JSON.stringify({
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
          }));
          break;
        }

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
          if (!room || room.state === 'ended') {
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
            participantCount: room.getParticipantCount()
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
              message: 'This connection has already joined a quiz. Reload the page to join again.'
            }));
            return;
          }
        
          // Validate name first
          const nameValidation = validateName(name);
          if (!nameValidation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: nameValidation.error }));
            return;
          }
        
          const room = roomManager.getRoom(roomId);
          if (!room) {
            // Opaque: a mistyped code and a code that was never issued must
            // look the same, or room ids become enumerable.
            rejectAndMaybeClose(ws);
            return;
          }

          if (room.state === 'ended') {
            // Past the name check, so say something useful. This does confirm
            // the room existed, which is why it is not said before a join is
            // actually attempted -- and it still costs a failure budget slot.
            ws.send(JSON.stringify({ type: 'error', message: QUIZ_FINISHED }));
            recordFailure(ws);
            return;
          }

          const participant = room.addParticipant(ws, nameValidation.name);
          ws.roomId = roomId;
          ws.role = 'participant';
          ws.participantId = participant.id;
        
          ws.send(JSON.stringify({
            type: 'joined',
            participantId: participant.id,
            roomId: roomId,
            quizTitle: room.quiz.title
          }));

          // Notify presenter
          room.sendToPresenter({
            type: 'participant_joined',
            participantId: participant.id,
            name: participant.name,
            count: room.getParticipantCount()
          });

          // Send current question if game is in progress
          if (room.state === 'question') {
            const question = room.getPublicQuestion();
            ws.send(JSON.stringify({
              type: 'question',
              questionIndex: room.currentQuestionIndex,
              totalQuestions: room.quiz.questions.length,
              question: question,
              startTime: room.currentQuestionStartTime
            }));
          } else if (room.state === 'results') {
            // Send results
            const results = room.getLeaderboard();
            ws.send(JSON.stringify({
              type: 'results',
              questionIndex: room.currentQuestionIndex,
              leaderboard: results,
              waiting: room.currentQuestionIndex < room.quiz.questions.length - 1
            }));
          }
          break;
        }

        case 'control_connect': {
          const { presenterToken, roomId } = msg;

          // A room id is now mandatory. Previously, omitting it returned a list
          // of the token's sessions; that listing is gone, because this
          // application has no administrator and no legitimate need to enumerate.
          const room = roomId ? roomManager.getRoom(roomId) : undefined;

          // One message for "no such room", "wrong token" and "already finished".
          // timingSafeEqual is not used here on purpose: the token is compared
          // against a value the prober would have to know in the first place, and
          // the rate limit -- not constant time -- is what makes guessing futile.
          if (!room || room.presenterToken !== presenterToken) {
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
            leaderboard: room.getLeaderboard()
          }));
          break;
        }

        case 'start_game': {
          const room = getRoomForPresenter(ws);
          if (!room) return;
        
          room.startGame();
          const question = room.getPublicQuestion();
        
          room.broadcastToParticipants({
            type: 'question',
            questionIndex: 0,
            totalQuestions: room.quiz.questions.length,
            question: question,
            startTime: room.currentQuestionStartTime
          });
        
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
        
          const results = room.endQuestion();
        
          room.broadcastToParticipants({
            type: 'results',
            questionIndex: room.currentQuestionIndex,
            leaderboard: results.leaderboard,
            waiting: room.currentQuestionIndex < room.quiz.questions.length - 1
          });
        
          room.sendToPresenter({
            type: 'question_results',
            questionIndex: room.currentQuestionIndex,
            answers: Array.from(room.currentAnswers.entries()).map(([pid, data]) => {
              const p = room.getParticipantById(pid);
              return {
                participantId: pid,
                name: p?.name || 'Unknown',
                answer: data.answer,
                points: results.scores.get(pid) || 0,
                timestamp: data.timestamp
              };
            }),
            leaderboard: results.leaderboard
          });
          break;
        }

        case 'next_question': {
          const room = getRoomForPresenter(ws);
          if (!room) return;
        
          if (room.nextQuestion()) {
            const question = room.getPublicQuestion();
          
            room.broadcastToParticipants({
              type: 'question',
              questionIndex: room.currentQuestionIndex,
              totalQuestions: room.quiz.questions.length,
              question: question,
              startTime: room.currentQuestionStartTime
            });
          
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

        case 'submit_answer': {
          const room = roomManager.getRoom(ws.roomId);
          if (!room || ws.role !== 'participant') return;

          // Participants are untrusted; reject anything that is not a well-formed
          // answer for the current question rather than storing it and letting it
          // reach the presenter's results view.
          const validation = room.validateAnswer(msg.answer);
          if (!validation.valid) {
            ws.send(JSON.stringify({ type: 'error', message: validation.error }));
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
            participants: Array.from(room.participants.values()).map(p => ({
              id: p.id,
              name: p.name,
              score: p.score
            }))
          }));
          break;
        }

        case 'kick_participant': {
          const room = getRoomForPresenter(ws);
          if (!room) return;
        
          const participant = room.getParticipantById(msg.participantId);
          if (participant) {
            // Find the websocket
            for (const [pws, p] of room.participants) {
              if (p.id === msg.participantId) {
                pws.send(JSON.stringify({ type: 'kicked' }));
                pws.close();
                break;
              }
            }
          }
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
      safeSend(ws, { type: 'error', message: 'Invalid message' });
    }
  }

  function getRoomForPresenter(ws) {
    if (ws.role !== 'presenter') return null;
    return roomManager.getRoom(ws.roomId);
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
    room.state = 'ended';
    const finalLeaderboard = room.getLeaderboard();

    room.broadcastToParticipants({
      type: 'game_ended',
      leaderboard: finalLeaderboard
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
          const participant = room.removeParticipant(ws);
          if (participant) {
            room.sendToPresenter({
              type: 'participant_left',
              participantId: participant.id,
              name: participant.name,
              count: room.getParticipantCount()
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

    if (ws.clientKey) {
      const state = ipState.get(ws.clientKey);
      if (state) {
        state.sockets = Math.max(0, state.sockets - 1);
        releaseKeyState(ws.clientKey);
      }
    }
  }

  roomManager.onRoomRemoved = (room) => {
    if (!room.creatorKey) return;
    const state = ipState.get(room.creatorKey);
    if (state) {
      state.rooms = Math.max(0, state.rooms - 1);
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
  const quizServer = createQuizServer({ limits: limitsFromEnv() });
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
  DEFAULT_LIMITS,
  MAX_QUIZ_SIZE,
  SERVER_VERSION,
  PROTOCOL_VERSION
};
