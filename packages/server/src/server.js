import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { pathToFileURL } from 'url';
import { RoomManager } from './rooms.js';
import { renderQuiz } from './math-renderer.js';
import { sanitizeQuiz } from './quiz-sanitizer.js';
import { validateName } from './name-validator.js';
import { getServerAddresses } from './network-addresses.js';
import { clientKey, parseForwardedFor, DEFAULT_IPV6_PREFIX_BITS } from './client-address.js';
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

const DEFAULT_LIMITS = {
  maxMessagesPerWindow: 60,
  messageWindowMs: 10_000,
  maxFailedAttemptsPerWindow: 10,
  failedAttemptWindowMs: 60_000,
  maxRoomsPerIp: 5,
  maxSocketsPerIp: 50
};

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
 * @param {boolean} [options.trustProxy] Whether X-Forwarded-For may be believed.
 * @param {object} [options.limits] Overrides for DEFAULT_LIMITS.
 * @param {number} [options.sweepIntervalMs]
 */
function createQuizServer(options = {}) {
  const {
    roomManager = new RoomManager(),
    allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(o => o.trim()),
    trustProxy = process.env.TRUST_PROXY === 'true',
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

  function releaseKeyState(key) {
    const state = ipState.get(key);
    if (state && state.sockets <= 0 && state.rooms <= 0) ipState.delete(key);
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
    if (trustProxy) {
      const forwarded = parseForwardedFor(req.headers['x-forwarded-for']);
      if (forwarded !== '') return clientKey(forwarded, { ipv6PrefixBits });
    }
    return clientKey(req.socket.remoteAddress, { ipv6PrefixBits });
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
    return state.failures > limits.maxFailedAttemptsPerWindow;
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
              rejectAndMaybeClose(ws, 'Too many open sessions from this address.');
              return;
            }

            // Quiz markup is authored by the lecturer and rendered as HTML, so it
            // is scrubbed (not escaped) before KaTeX runs: the author is trusted,
            // but should not be able to break their own quiz by accident. See
            // quiz-sanitizer.js for the exact threat model.
            const sanitized = sanitizeQuiz(quiz);
            warnings = sanitized.warnings;
            if (warnings.length > 0) {
              console.warn(`Quiz "${sanitized.quiz.title}" contained markup that was removed:`);
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
            // End game
            room.state = 'ended';
            const finalLeaderboard = room.getLeaderboard();
          
            room.broadcastToParticipants({
              type: 'game_ended',
              leaderboard: finalLeaderboard
            });

            // The presenter additionally gets the aggregate statistics, so the
            // export is ready the moment the quiz finishes rather than requiring
            // the room to still be alive later.
            room.sendToPresenter({
              type: 'game_ended',
              leaderboard: finalLeaderboard,
              statistics: room.getStatistics()
            });
          }
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
      console.error('WebSocket message error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  }

  function getRoomForPresenter(ws) {
    if (ws.role !== 'presenter') return null;
    return roomManager.getRoom(ws.roomId);
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
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, heartbeatIntervalMs);
  heartbeat.unref();

  // Discard expired rooms. Without this, every room ever created stays in
  // memory for the lifetime of the process.
  const sweepTimer = setInterval(() => {
    const removed = roomManager.sweep();
    if (removed.length > 0) {
      console.log(`Swept ${removed.length} expired room(s): ${removed.join(', ')}`);
    }
  }, sweepIntervalMs);
  sweepTimer.unref();


  return {
    app,
    server,
    wss,
    roomManager,
    limits,
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
  const PORT = Number(process.env.PORT) || 3000;
  const quizServer = createQuizServer();
  quizServer.listen(PORT).then(() => {
    console.log(`Quizzy backend listening on port ${PORT}`);
    console.log('Caddy (or another reverse proxy) should be the public entry point.');
    for (const { url } of getServerAddresses(PORT)) {
      console.log(`  backend: ${url}`);
    }
  });
}

export {
  createQuizServer,
  GENERIC_REJECTION,
  QUIZ_FINISHED,
  DEFAULT_LIMITS,
  MAX_QUIZ_SIZE,
  SERVER_VERSION,
  PROTOCOL_VERSION
};
