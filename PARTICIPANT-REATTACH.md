# Participant Reattach — Design Note

Decision record for letting a participant whose connection drops mid-quiz come
back to the room they were in, with their name, score and answers intact.

**Status: implemented (2026-10-15)**, covering all four stages in §9. Where the
implementation departs from the original design, the section says so and why.
§11 collects the departures. The 2026-08-22 review listed this as an open item
("Participants never reconnect ... feature-sized, not a patch").

---

## 1. The problem (before this change)

Two independent things broke, and only one of them was the wifi.

**Server** — `handleDisconnect()` called `room.removeParticipant(ws)`, which
deleted the record outright. Name, score and answer history were gone the
instant the socket closed.

**Client** — `quiz-client.js` showed "Connection lost. Please refresh the
page." on `onclose` and did nothing else. A refresh gave a join form, and typing
the same name created a **new** participant with score 0.

An Eduroam handover kills the *socket*, but the page stays loaded and the
`QuizClient` instance still holds the participant's identity. The client simply
refused to use it, and the server-side deletion made that irreversible.

The presenter already survived exactly this failure (`RoomManager.openRoom()`
is create-or-resume, keyed on `presenterToken`). Participants had no equivalent
credential, and that asymmetry was the whole bug. In the lecture that prompted
this note, some students also pressed the **reload button**, so a reload has to
be covered as well, not just a dropped socket.

---

## 2. The credential

At `join_room` the server creates

```js
resumeToken = randomBytes(32).toString('base64url')
```

and returns it **once**, in the `joined` message. It is never broadcast and
never logged. The handshake message `rejoin_room` carries it back:

```js
{ type: 'rejoin_room', protocolVersion, roomId, resumeToken }
```

**`participantId` cannot be the credential.** It is public: leaderboards go to
every participant in the room and contain it.

**Implemented:** the token is not stored on the participant record. `Room`
keeps it in two private maps (`resumeTokens`, `resumeTokenById`), because
leaderboards and participant lists are built from the record, and a token stored
there would be one careless spread away from being broadcast. A unit test checks
that the token appears in none of: the record, the leaderboard, the participant
list, the summary, the statistics.

---

## 3. Server: detach instead of delete

`Room` gains `detached: Map<participantId, { participant, detachedAt }>`.

- **disconnect** → `detachParticipant(ws)` moves the record from `participants`
  to `detached`.
- **`rejoin_room`** → `reattachParticipant(token, ws)` looks in `detached`
  first, then in `participants` (for a half-open socket the heartbeat has not yet
  caught, or a second tab with the same token). It moves the record to the new
  socket and returns the socket it replaced, if any.
- **purge** → `purgeParticipant(id)` removes the record from both maps and drops
  the token. Used by the TTL sweep, the cap, and `kick_participant`.

Invariants, each covered by a test:

1. **`countAwaitedAnswers()` iterates `participants` only.** Detached people
   are not waited for, so a question never stalls because somebody's phone is in
   a lift.
2. **`currentAnswers` is keyed by `participantId` and is untouched by
   detach/attach.** A student who answered, dropped and came back gets the
   question replayed with `alreadyAnswered: true`, and the page shows "Answer
   submitted", not the question again.
3. **A kick purges before it closes the socket**, so the page's own automatic
   reconnect cannot undo it.
4. **One socket, one role.** The `if (ws.role)` guard of `join_room` also
   applies to `rejoin_room`.

Four further problems turned up while implementing, and the original design
missed all of them:

5. **Answers given just before a drop were worth nothing.** `endQuestion()`
   credits points through `getParticipantById()`, which looked only at
   `participants`. It now also looks in `detached`.
6. **Superseding needs a fixed order.** The record moves to the new socket, and
   the old socket is stripped of its role, *before* the old socket is closed.
   Otherwise the old socket's `close` event would detach the participant who has
   just come back.
7. **A failed rejoin needs its own reply type.** Every failure used to be
   `{type:'error'}`, and the page has to tell "forget the token and show the join
   form" apart from everything else. Unknown room, unknown token and expired
   token all get the same `{type:'rejoin_failed', message}`. That keeps it no
   better an oracle for room ids than `room_status`.
8. **`submit_answer` checks `room.participants.has(ws)`.** Checking only
   `ws.role` let a kicked or superseded socket deliver an answer in the moment
   before it finished closing.

**Leaderboard:** includes detached participants with their real score, so ranks
don't jump around while one person reconnects. The board does **not** say who
is offline, because it goes to every participant. The presenter gets that
through `get_participants`, whose entries carry `connected`.

**Counts:** `count`, `participantCount`, `room_status.participantCount` and the
`totalParticipants` in `answer_count` all stay *connected right now*.
`reconnecting` / `reconnectingCount` are the second number.

**A rejoin to an ended room** succeeds and replays `game_ended`. A student
whose phone dropped as the quiz finished still sees their result. A first
`join_room` to an ended room is still refused.

**Retention:** `DETACHED_RETENTION_MINUTES`, default **15**, checked both at
rejoin time and by the room sweep. The detached map is capped at
`max(30, 3 × peak attendance)`, evicting the oldest first, so a
join-drop-join loop cannot grow it without bound. A whole hall dropping at once
evicts nobody (tested with 300). The room's own TTLs stay the outer bound. A room
with only detached participants counts as empty for expiry.

---

## 4. Client

### Tier 1 — reconnect from memory

On `onclose`, if the page holds a resume token, it does not show the dead end.
It shows a "Connection lost — reconnecting…" banner, keeps the last screen
dimmed and `inert` underneath, and retries. When the socket reopens it sends
`rejoin_room`. If the question on screen is the one the server replays, the DOM
is kept, including any options the student had already selected.

### Tier 2 — `sessionStorage`, for the reload button

`sessionStorage['quizzy:resume:' + roomId] = resumeToken`, written when
`joined` arrives. On load, a stored token makes the page send `rejoin_room`
instead of `room_status`. The token is cleared on `game_ended`, `kicked`,
`rejoin_failed` and when the tab is superseded. Every storage access is wrapped
in try/catch: without storage, reconnecting still works and only the reload
case is lost.

**Correction to the original note:** it claimed Tier 2 also covers "scanning the
QR code again". It generally does not. A phone's camera usually opens the link
in a **new** tab, and a new tab has empty `sessionStorage`. Rescanning gives a
fresh join, the same as before this change. Covering that would need
`localStorage` (see §7).

### After a rejoin, say what happened

`rejoined` carries `answeredQuestions`: the participant's own scored history,
sent only to them. The page compares it with the last question it had seen and
says, for example, "Question 1 closed while you were reconnecting, so it scores
nothing for you." It does not silently jump ahead. If an answer was sent into a
socket that was already dead (`alreadyAnswered: false` for a question the page
thought it had answered), the question is offered again with a notice. After a
reload there is no "before" to compare against, so nothing is said.

### Backoff and jitter

Backoff is 1 s, 2 s, 4 s … capped at 30 s, each step with ±50 % jitter. Without
the jitter, a hall-wide blip would bring every phone back at the same instant,
from one egress address, while the server still counts their half-open sockets
against `maxSocketsPerIp`.

The server half: a successful `rejoin_room` that supersedes a socket releases
that socket's per-address quota **immediately** (`releaseSocketQuota`, which is
idempotent) instead of waiting up to a minute for the heartbeat. It then closes
the socket with code **4000**.

### Two tabs, one identity

Chromium's "Duplicate tab" copies `sessionStorage`, so two tabs sharing one
token is possible. The newer rejoin wins. The older tab receives close code
4000, shows "This quiz was continued in another tab or window", forgets its
token, and **does not reconnect**. Without that, the two tabs would take the
identity from each other forever. A protocol-mismatch error also stops
reconnecting, since retrying cannot fix it.

### Errors while reconnecting

"Too many connections" and similar errors that arrive while reconnecting are
not rendered. The server closes the socket next, and that close schedules the
next attempt.

---

## 5. Cookies, storage and § 25 TDDDG

**Decision: `sessionStorage` only. No cookie, no `localStorage`, no banner.**
The overriding goal is to keep the legal surface at an absolute minimum.

§ 25 TDDDG covers *any* storage in the terminal equipment, so `sessionStorage`
is in scope. It is exempt as "strictly necessary for a service the user
expressly requested" (§ 25 Abs. 2 Nr. 2). The exemption attaches to the purpose,
so it holds only while all of the following hold. Each one is enforced in code
and checked by a browser test:

| condition | how it is met |
|---|---|
| Sole purpose is keeping the requested service running | The token identifies one participant to the one room they deliberately joined. No analytics, no correlation across rooms. |
| Written only on the express act, never on a bare page load | Written when `joined` arrives, after the student typed a name and pressed Join. Test: *writes nothing to the device before the student presses Join*. |
| Session-scoped, not persistent | `sessionStorage`, keyed by room, cleared on `game_ended`. Test: one session key, no `localStorage`, no cookie. |
| Strictly necessary in fact | Without it, a reload costs the student their score in a quiz that may carry bonus points. |
| Never leaves the page except to our own server | The token is sent only in `rejoin_room`, never in a URL. Test: the token is never in `page.url()`. |

No consent does not mean no transparency. The join page now says, under the form,
what is kept and for how long. Art. 13 GDPR still wants a sentence in the
Datenschutzerklärung (privacy notice). `DEPLOY.md` says so next to
`DETACHED_RETENTION_MINUTES`.

---

## 6. Data protection beyond the storage question

Reattach changes one thing that matters: the names, answers and scores of people
who are **no longer connected** are now held in RAM for up to
`DETACHED_RETENTION_MINUTES` after they drop. That is a real, if small,
extension of retention, and it belongs in the conversation with the data
protection officer (Datenschutzbeauftragte(r)) that `PRESENTER-TOKEN.md` § 5
already flags. Three properties keep it defensible:

- the window is short, bounded and configurable per deployment;
- nothing is written to disk, and a restart still discards everything;
- the export stays aggregate. `recordQuestionStatistics` records counts and
  distributions, never names, and reattach did not change that.

`DEPLOY.md` describes `DETACHED_RETENTION_MINUTES` as a data-protection knob,
not merely a memory one.

---

## 7. Rejected alternatives

**Reattach by name.** Lets any student take over any other student's score,
because the names are on the leaderboard. Not acceptable where results may
feed bonus points.

**Name plus a short PIN shown at join.** It is a resume token with a worse
interface.

**A cookie.** Rides on every request to the origin, is shared across tabs, and
drags the whole cookie conversation onto a page used by two hundred students.

**`localStorage`, scoped per room, with a server-sent sliding expiry.**
Seriously considered. It is the most general option: it would also cover a
rescanned QR code, a link reopened from history, and a browser restart. It was
set aside **to keep the legal surface minimal**. It is persistent storage, which
is where WP29 draws the consent line, and the case it adds over
`sessionStorage` is the rarer one. If it is ever revisited, the design is:

- the server sends `resumeUntil` and refreshes it with every question;
- the client deletes expired `quizzy:*` entries on every load;
- keys are per room instance, so a reused room code is never probed with a stale token;
- a "Continue as *Anna*?" prompt guards shared devices;
- the close-code-4000 handling above already prevents two tabs from fighting.

**Server-side persistence.** It would additionally survive an API-server
restart. Everything in this system is deliberately in RAM, and a store for this
would be the largest available change for the smallest remaining case.

---

## 8. Implementation surface

| file | change |
|---|---|
| `packages/server/src/rooms.js` | resume token in private maps; `detached` map; `detachParticipant` / `reattachParticipant` / `purgeParticipant` / `sweepDetached`; cap; `getParticipantById` and `getLeaderboard` include detached; `getReconnectingCount`, `getParticipantList`; `RoomManager.sweep` sweeps detached participants of live rooms |
| `packages/server/src/server.js` | `rejoin_room` (handshake); `resumeToken` in `joined`; `rejoined` / `rejoin_failed`; shared `sendRoomState` with `alreadyAnswered`; disconnect detaches; supersede with close code 4000 and immediate quota release; kick purges; `submit_answer` requires a registered socket; `reconnecting` counts to the presenter |
| `packages/server/web/js/quiz-client.js` | backoff-with-jitter reconnect; reconnecting banner over a dimmed, inert screen; `sessionStorage` resume; missed-question and lost-answer notices; final states (ended, kicked, superseded, protocol mismatch) never reconnect |
| `packages/server/web/join.html`, `styles/join.css` | banner and notice elements; the storage sentence under the form |
| `packages/server/web/js/quiz-control.js`, `styles/control.css` | "N connected · M reconnecting"; reconnecting participants marked on the leaderboard |
| `packages/server/test/rooms.test.js` | 17 tests: token secrecy, detach/reattach, scoring after a drop, TTL, sweep, cap, hall-wide drop, purge |
| `packages/server/test/server.test.js` | 13 tests: the protocol over real sockets, including the failure budget, superseding with quota accounting, kick, ended room |
| `packages/server/test/browser/reconnect.test.js` | 11 end-to-end tests in Chromium through the `/ws` proxy: reconnect mid-question keeping the selection, answered-then-dropped, missed-question notice, reload button, expiry fallback, duplicated tab, kick, nothing stored before Join, presenter view |
| `protocol.test.js`, `robustness.test.js`, `browser/harness.js` | `rejoin_room` is version-checked and survives hostile input |
| `README.md`, `DEPLOY.md`, `ARCHITECTURE.md` | protocol messages, `DETACHED_RETENTION_MINUTES`, one paragraph on resumable participants |

**Nothing in `packages/ld-quiz/` changed, so there is no npm release, no deck
rebuild, and `PROTOCOL_VERSION` stays 1.** `rejoin_room` is purely additive,
and existing messages only gained fields. An old client never sends
`rejoin_room` and ignores the fields it does not know.

---

## 9. Staging (all done)

1. **Server**: detach / reattach / resume token, with tests.
2. **Client Tier 1**: in-memory reconnect.
3. **Client Tier 2**: `sessionStorage`, the join-page sentence.
4. **Presenter view**: the two-number count and the reconnecting marker; docs.

Still to do outside this repository: the sentence in the Datenschutzerklärung.

---

## 10. Resolved questions

- **What does the student see while reconnecting?** The current screen, dimmed
  and inert, under a banner. The question is not re-rendered, and if it is the
  same question the student's selection survives.
- **A question that closes while they are away.** It scores nothing, and the
  page says so on reattach.
- **A "keep this link" URL with the token.** Not done. It is a bearer credential
  in a URL, and the rescan case it would cover was set aside with
  `localStorage`.
- **Two tabs, one student.** Two independently opened tabs are two participants
  (separate `sessionStorage`). A *duplicated* tab shares the token, the newer
  one wins, and the older one stops.
- **Do detached participants count toward `participantCount` in
  `room_status`?** No. That number is about the room's liveness.

---

## 11. Departures from the original design

| original design | implemented | why |
|---|---|---|
| New presenter messages `participant_disconnected` / `participant_reconnected` | `participant_left` with `detached: true` and `participant_joined` with `rejoined: true`, both with `reconnecting` | Decks in the wild bundle a component that updates its lobby count on exactly these two messages. New types would leave that count stale, and the stated goal was no `ld-quiz` release. |
| A `rejoin_room` with an unknown token counts against `maxFailedAttemptsPerWindow` | Not counted; the reply is uniform instead | Tokens are 256 bits, so there is nothing to guess, and the uniform reply makes rejoin no room-id oracle. Counting would lock a hall out exactly when it matters: after an outage longer than the retention window, every phone behind the hall's one address presents a dead token at once. 300 failures against a budget of 50 would also block the `room_status` and `join_room` fallbacks. |
| The resume token is stored on the participant record | Stored in maps private to `Room` | Keeps it out of everything built from the record. |
| Tier 2 covers rescanning the QR code | It does not (new tab, empty `sessionStorage`) | Correction; see §4. |
