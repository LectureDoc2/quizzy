# ld-quiz

A real-time, embeddable quiz application designed for integration with any HTML-based presentation system (e.g., **LectureDoc2**). The core is a vanilla JavaScript **Web Component** (`<ld-quiz>`) that handles presenter authentication, quiz decryption, participant management, and real-time game flow.

## Features

- **Web Component Architecture**: Embeddable in any HTML document using Shadow DOM for style isolation
- **Real-time Gameplay**: Native WebSocket communication for live quiz sessions
- **Secure Quiz Content**: Client-side AES-GCM encryption with PBKDF2 key derivation ([`@lecturedoc2/libcrypto`](https://www.npmjs.com/package/@lecturedoc2/libcrypto))
- **Presenter Control**: Separate control window with session management and reconnection support
- **Participant QR Code Join**: Participants scan a QR code or use a short link to join
- **Participant Reconnect**: A participant whose connection drops, or who reloads the page, carries on with the same name and score
- **Changing an Answer**: After Submit the question stays on screen. Until everybody has answered (or the time is up, or the presenter ends the question), a participant can change their answer and resubmit it; the last answer that reaches the server counts
- **Results Export**: After the quiz, the control window exports a per-question summary as CSV. A quiz can also ask participants for consent to include their name and final score ([`recordNamedResults`](#quiz-json-format))
- **Practice Mode**: Students play quizzes from a server-side catalog on their own, without a presenter; the server runs the game ([below](#practice-mode))
- **Math Formula Support**: Server-based KaTeX rendering for quiz questions and answers
- **Syntax-highlighted Code**: Server-based highlight.js rendering of fenced code blocks in 14 languages
- **Minimal Dependencies**: Express.js and `ws` (WebSocket) on the server; the crypto library - part of LectureDoc2 without additional transitive dependencies - is the client's only dependency

## Supported Question Types

1. **Multiple Choice**: Standard A/B/C selection
2. **Estimation**: Numeric answers with rank-based scoring:
   - 1st closest: 100 points
   - 2nd closest: 50 points
   - 3rd closest: 25 points
   - Ties: equally close estimates (the same estimate, or the same distance
     on the other side) share a place, and the places after them are skipped,
     as in sport. Two tied for first both get 100, the next one gets 25, and
     nobody gets 50. Submission time plays no part.

   In [practice mode](#practice-mode) there is nobody to rank against, so an
   estimate scores by its relative error instead: within 10 % → 100, within
   25 % → 50, within 50 % → 25 points.
3. **Short Answer**: The participant types a term; 100 points if it is one of
   the question's `acceptedAnswers`, 0 otherwise. By default the comparison
   ignores case, spacing, hyphens, slashes, quotes and diacritics, treats `ue`
   like `ü` (and `ae`, `oe`, `ss` alike), and forgives one typo in a term of
   eight characters or more; the question's `match` can make it stricter, down
   to an exact comparison for answers such as `//`. It never accepts an answer
   for *containing* a right one. The join page
   shows the expected length (the range of the accepted answers without their
   optional parts) and refuses input that is longer than the longest accepted
   answer plus 10 %.

   Short answers test recall rather than recognition, and the presenter's
   results view groups them by spelling, so the common wrong answers show. The
   price is that a right answer the author did not foresee — a synonym, a
   compound, the other language — scores 0: list the variants, and keep the
   type for terms with a well-defined answer. In a live quiz the presenter can
   still accept such an answer while the results are shown: **Accept** next to
   a group in the control window gives everybody who wrote it the points and a
   corrected verdict, and **Undo** takes that back. The CSV export marks these
   answers as accepted by the presenter, ready to be added to
   `acceptedAnswers`. Typing takes longer than tapping;
   allow 30–45 seconds. Answers are free text and cannot be moderated: they
   appear, without names, in the control window and the CSV export.
4. **Ordering**: The participant puts 2–10 items in order — data types by value
   range, literals by value, steps of an algorithm. 100 points for exactly the
   right order, 0 otherwise. The author lists the `options` in the correct
   order; every participant sees them in the same shuffled order, which is never
   the correct one. Items are dragged by their handle (with a mouse, anywhere on
   the item), or moved with their ↑/↓ buttons, which also work from the
   keyboard and with a screen reader. A touch on an item outside its handle
   scrolls the page as usual. The results screen shows participants their own
   order and a verdict, not the correct order; the control window shows the
   correct order, and the CSV export counts per item how many participants put
   it in its place.

## Practice Mode

`/practice.html` lists the quizzes the Quizzy server offers for practice,
grouped by category. A student picks one and plays it alone: each question runs
on its own `timeLimit` (or until they answer), the results screen shows their
verdict for 30 seconds with a *Next question* button to skip the wait, and the
game ends with their score. There is no name to enter, no room code and no
leaderboard. As in a lecture, the results screen says whether an answer was
right but never what the correct answer is.

The catalog is a JSON file on the server, `quizzes/practice.json` by default
(set `PRACTICE_CATALOG` to use another):

```json
{
  "resultsSeconds": 30,
  "quizzes": [
    { "id": "germany", "category": "Geography", "file": "demo/germany-quiz.en.json",
      "description": "Capitals, rivers, mountains and states." },
    { "id": "tor", "category": "IT Security",
      "file": "practice/it_security/tor-quiz.en.json" }
  ]
}
```

- `id` — appears in the link (`join.html?practice=<id>`); lowercase letters,
  digits and hyphens.
- `category` — optional; quizzes without one are listed under "Other", last.
  Categories appear in the order of their first quiz in the file.
- `file` — a plain (unencrypted) quiz JSON file, relative to the catalog and
  inside its directory; subdirectories are fine.
- `description` — optional, shown under the title.
- `resultsSeconds` — how long each results screen stays up (default 30).

Every quiz is validated and rendered once when the catalog is loaded; an entry
that fails is skipped and logged. List only quizzes meant for practice: students
can replay a quiz as often as they like, and with a right/wrong verdict after each
answer a determined one can work out the multiple-choice answers by trial.
Changing the catalog on a running server is described in
[UPDATE.md §3](UPDATE.md#3-changing-the-practice-quizzes).

### Usage statistics

Set `PRACTICE_STATS_DIR` to a directory, and the server keeps anonymous daily
totals of how the practice quizzes are used. They hold no personal data:
nothing about who played, and no time finer than the day
([DEPLOY.md §13a](DEPLOY.md#13a-data-protection) explains why that keeps them
out of the GDPR). Two CSV files receive one row per day, once that day is over:

- `practice-games.csv`: `date,quiz,title,started,finished,abandoned,score_0_25,score_25_50,score_50_75,score_75_100`.
  Abandoned games are those whose student left and did not come back in time.
  The score columns count finished games by their share of the maximum score;
  the lower bound is inclusive, and 100 % falls in the last band.
- `practice-questions.csv`: `date,quiz,question,text,shown,answered,correct`.
  `question` is the position in the quiz, and `text` the beginning of its
  wording. A question edited during the day gets a row of its own.

The day in progress is kept in `practice-stats-pending.json` and saved every
five minutes and on shutdown. Days follow the server's time zone. The files are
UTF-8 CSV with comma separators; LibreOffice and Excel open them directly.

## Project Structure

This is a **pnpm workspace** with two packages: the embeddable web component and the
backend that hosts a quiz session. How the build turns them into the files the
Quizzy server publishes is described in
[ARCHITECTURE.md](ARCHITECTURE.md#which-files-belong-to-which-part).

```
.
├── package.json                    # workspace root: build + dev scripts
├── pnpm-workspace.yaml
├── build.js                        # esbuild: bundles the browser code into dist/
├── Caddyfile, caddy/               # reverse proxy / static file server
│
├── packages/
│   ├── ld-quiz/                    # the embeddable component (publishable to npm)
│   │   ├── src/ld-quiz.js          #   the <ld-quiz> custom element
│   │   ├── src/protocol.js         #   the wire contract; shared with the server
│   │   ├── src/qr-canvas.js        #   draws the join QR code onto a <canvas>
│   │   ├── src/quiz-styles.js      #   Shadow DOM styles
│   │   └── package.json            #   deps: @lecturedoc2/libcrypto, qrcode-generator
│   │
│   └── server/                     # the backend and the pages it serves
│       ├── src/server.js           #   Express + WebSocket server
│       ├── src/rooms.js            #   room state management and scoring
│       ├── src/render-sandbox.js   #   renders each quiz in a sandboxed worker process
│       ├── src/render-worker.js    #   the worker: the only process running KaTeX/highlight.js
│       ├── src/math-renderer.js    #   server-side KaTeX rendering (in the worker)
│       ├── src/code-renderer.js    #   server-side syntax highlighting (in the worker)
│       ├── src/name-validator.js   #   participant name validation
│       ├── src/network-addresses.js
│       ├── web/                    #   join/control/demo pages (HTML, CSS, page scripts)
│       ├── test/
│       └── package.json            #   deps: express, ws, katex, highlight.js
│
├── tools/encrypt-quiz.js           # CLI utility to encrypt quiz JSON
├── tools/validate-quiz.js          # CLI utility to check a quiz file
├── quizzes/
│   ├── practice.json               # the practice catalog
│   ├── demo/                       # the quizzes of the demo page, and other demonstrations
│   └── practice/<category>/        # practice quizzes, one directory per category
└── dist/                           # build output served by Caddy (git-ignored)
```

## Documentation

| Document | What it covers |
|---|---|
| [DEVELOPMENT.md](DEVELOPMENT.md) | Running and testing Quizzy on your own machine |
| [DEPLOY.md](DEPLOY.md) | Installing a production server, and the reference of all Caddy and backend settings |
| [UPDATE.md](UPDATE.md) | Keeping a production server up to date |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the parts fit together: which file is served by whom, why there is a build step, service discovery, a round of play, practice games |
| [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) | What is protected against whom: trust boundaries, tokens, the render sandbox, deployment hardening, supply chain, known gaps |
| [packages/ld-quiz/README.md](packages/ld-quiz/README.md) | Embedding the `<ld-quiz>` component: as an npm package or a hosted script, its attributes, and what it asks of the host page |
| [PUBLISH.md](PUBLISH.md) | Releasing the npm package |
| [PRESENTER-TOKEN.md](PRESENTER-TOKEN.md), [PARTICIPANT-REATTACH.md](PARTICIPANT-REATTACH.md), [LECTUREDOC2-BUILD-STEP.md](LECTUREDOC2-BUILD-STEP.md) | Design notes and decision records |

## Quick Start

### 1. Run a Quizzy Server

Locally, follow [DEVELOPMENT.md](DEVELOPMENT.md) §2–§3: install, build, and start
the backend and Caddy. For a production server, follow [DEPLOY.md](DEPLOY.md).

### 2. Create a Quiz

Write the quiz as a JSON file in the format described under
[Quiz JSON Format](#quiz-json-format).

### 3. Validate and Encrypt the Quiz

Either on the command line:

```bash
pnpm validate quizzes/my-quiz.json

QUIZ_PASSWORD='the quiz password' \
  pnpm encrypt quizzes/my-quiz.json quizzes/my-quiz-encrypted.txt
```

…or in a browser, at **`https://<host>/tools.html`**, which does the same two
things plus generating a `secret`. Both run entirely on the author's machine;
[ARCHITECTURE.md](ARCHITECTURE.md#authoring-runs-in-the-browser-not-on-the-server)
explains why, and why the page needs HTTPS or `localhost`.

`pnpm validate` applies the same rules as the server, so a quiz it accepts is a
quiz that will start. It additionally warns when the quiz has no `secret` field,
which the server cannot require but an author almost always wants: see
[PRESENTER-TOKEN.md](PRESENTER-TOKEN.md). Add `--strict` to turn those warnings
into a non-zero exit for CI.

The password may also be given as a third argument, which is handier and leaves
it in the shell history and in `ps` output — fine for a throwaway, not for the
password that also gates the presenter token.

### 4. Embed the Quiz

Put an `<ld-quiz>` element into the deck and load the component, either from npm
or as a script hosted by the Quizzy server.
[packages/ld-quiz/README.md](packages/ld-quiz/README.md) describes both ways, the
attributes — encrypted or plain quiz, `server-url`, `presenter-name` — and what the
component asks of the host page.

### 5. Run the Quiz

1. Open the page containing the quiz component
2. Enter your password to decrypt and start the quiz
3. The control window opens automatically
4. Participants join by scanning the QR code or visiting the join URL
5. Use the control window to start rounds, end rounds, and advance questions

## Quiz JSON Format

```json
{
  "title": "Quiz Title",
  "recordNamedResults": true,
  "questions": [
    {
      "type": "multiple-choice",
      "text": "Question text with optional \\( LaTeX \\) math",
      "options": ["Option A", "Option B", "Option C"],
      "correctIndices": [0],
      "timeLimit": 30
    },
    {
      "type": "estimation",
      "text": "Question text",
      "correctAnswer": 42.0,
      "timeLimit": 45
    },
    {
      "type": "short-answer",
      "text": "Same name, different parameter lists: what is this called?",
      "acceptedAnswers": ["Overloading [of Methods]", "Method Overloading",
                          "Überladen [von Methoden]", "Methodenüberladung"],
      "timeLimit": 40
    },
    {
      "type": "ordering",
      "text": "Order the data types by value range (ascending).",
      "options": ["<code>byte</code>", "<code>long</code>", "<code>float</code>"],
      "timeLimit": 30
    }
  ]
}
```

- `text`: Question text. Rendered as HTML, and preprocessed on the server for
  KaTeX math (`\(...\)`, `\[...\]`, `$...$`, `$$...$$`) and for fenced code
  blocks — see [Code blocks](#code-blocks) below.
- `options`: Array of strings (for multiple-choice), or for ordering 2–10
  distinct strings **in the correct order** — participants get them shuffled
- `correctIndices`: Array of zero-based indices of correct options (for multiple-choice). Single-answer questions use a one-element array, e.g. `[0]`. Multi-select questions use multiple indices, e.g. `[0, 2]`.
- `correctAnswer`: Numeric value (for estimation)
- `acceptedAnswers`: Array of 1–50 strings (for short-answer), each at most 200
  characters of plain text — not HTML, not math. A part in square brackets is
  optional: `"Overloading [of Methods]"` accepts "Overloading" and "Overloading
  of Methods". At most 4 optional parts per answer, 256 spellings per question;
  brackets cannot be nested. Write `\[` and `\]` for literal brackets (in JSON:
  `"int\\[\\]"`).
- `match`: Optional, for short-answer: how an answer is compared with the
  accepted ones.
  - `"fuzzy"` (default): ignores case, spacing, hyphens, underscores, slashes,
    quotes and diacritics, treats `ue` like `ü`, and forgives one typo in a term
    of eight characters or more.
  - `"strict"`: the same without the typo, for terms that differ from a wrong
    answer by a single letter (`"break"`, `"12"`).
  - `"exact"`: only spacing is ignored; case, hyphens, slashes and quotes count.
    For answers made of symbols (`"//"`, `"/*"`) — which the other modes reduce
    to nothing, or to something else — and for answers whose case matters
    (`"hashCode"`).

  Every mode first undoes what keyboards substitute on their own: typographic
  quotes and dashes (iOS and macOS "smart punctuation"), `…`, and no-break or
  zero-width spaces.
- `timeLimit`: Optional countdown timer in seconds
- `recordNamedResults`: Optional, `true` or `false` (default `false`). When `true`, the join page
  offers an **unticked, optional** checkbox by which a participant agrees that their name and final
  score appear in the results CSV. Participants can see their choice throughout the quiz and change it
  until the quiz ends. The CSV then gets a section listing name and final score of those who agreed,
  and nobody else; answers to individual questions are never included. Has no effect in practice mode.

### Code blocks

Code in a question or an option is written as a Markdown fence, and highlighted
on the server before anything is sent to a participant:

```json
{
  "type": "multiple-choice",
  "text": "What does this print?\n```java\nSystem.out.println(1 / 2);\n```",
  "options": ["0", "0.5", "It does not compile"],
  "correctIndices": [0]
}
```

Supported languages, by the name you write after the opening fence:

| Language | Write | Also accepted |
|---|---|---|
| Bash / shell | `bash` | `sh`, `shell`, `zsh`, `console` |
| C | `c` | `h` |
| C++ | `cpp` | `c++`, `cxx`, `cc`, `hpp` |
| CSS | `css` | |
| Go | `go` | `golang` |
| HTML / XML | `html` | `xml`, `xhtml`, `svg` |
| Java | `java` | |
| JavaScript | `javascript` | `js`, `mjs`, `jsx`, `node` |
| JSON | `json` | `jsonc` |
| Markdown | `markdown` | `md` |
| Python | `python` | `py`, `python3` |
| Rust | `rust` | `rs` |
| TypeScript | `typescript` | `ts`, `tsx` |
| YAML | `yaml` | `yml` |

HTML and XML share one grammar; `html` is an alias of `xml`, not a separate
language.

Three rules are worth knowing before a lecture rather than during one:

- **The opening fence must start a line.** A ``` inside a sentence is a
  backtick, not the start of a code block.
- **The language is never guessed.** A fence with no language — or with
  `text`/`plain` — is shown as unhighlighted code. An *unrecognised* language is
  also shown unhighlighted, and the presenter is told which one it was. Nothing
  is ever dropped.
- **A longer fence carries a shorter one**, so a Markdown example containing a
  three-backtick block is written with four backticks.

Code is escaped before anything else looks at it, so a sample containing
`<script>`, an `onclick=` attribute or a `$` is shown as written — the markup
safety net and the math renderer both leave code blocks alone. See
`packages/server/src/code-renderer.js` for the ordering and why it matters.

### Stylesheets for math and code

Math formulas and code blocks are both rendered to HTML **on the server**, before
anything is sent to a client. Neither KaTeX nor highlight.js is shipped to a
participant's browser; each needs only a stylesheet to display the result.

The `<ld-quiz>` component links both stylesheets itself, from the paths
`/api/config` reports (see [Service discovery](#service-discovery)). A standalone
page such as `demo.html` includes them directly:

```html
<link rel="stylesheet" href="/katex/katex.min.css">
<link rel="stylesheet" href="/highlight/highlight.min.css">
```

Both are vendored under `packages/server/web/`. The highlighting theme is
highlight.js's **`1c-light`**, kept under a theme-neutral filename on purpose:
`/api/config` publishes it as `highlightCss`, so a deployment swaps the theme by
replacing that one file (or by pointing `PUBLIC_HIGHLIGHT_CSS_PATH` elsewhere)
without touching the component, the `<link>` tags, or any embedder's cached
configuration.

A dark theme is deliberately not shipped yet.

## Security Model

- The quiz JSON is encrypted on the client side using the presenter's password
- The server receives the **decrypted** quiz only after the presenter decrypts it
- The server never persists quiz data to disk; all data is ephemeral (in-memory only). The one exception is the optional, anonymous [practice usage statistics](#usage-statistics)
- The presenter is identified by a SHA-256 hash of the quiz; see [PRESENTER-TOKEN.md](PRESENTER-TOKEN.md)
- Participants require no authentication; they join via a random room code
- **Cross-origin**: which origins may use the API is set with `ALLOWED_ORIGINS`; see [DEPLOY.md §13](DEPLOY.md#13-backend-configuration)

## Server API

### HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/config` | Endpoint discovery and protocol version. See [Service discovery](#service-discovery). |
| `GET` | `/api/practice` | The practice catalog: `{ quizzes: [{ id, category, title, description, questionCount }] }`, in catalog order. No answers. |

There is deliberately no endpoint that lists rooms or sessions: the application
has no administrator role, and a room can only be reached by knowing its id.

### Service discovery

The component asks the server where its own endpoints are, once per origin:

```
GET /api/config
```

```json
{
  "protocolVersion": 1,
  "serverVersion": "1.0.0",
  "maxQuizSize": 1048576,
  "ws": "/ws",
  "join": "/join.html",
  "control": "/control.html",
  "katexCss": "/katex/katex.min.css",
  "highlightCss": "/highlight/highlight.min.css"
}
```

Paths are relative to the URL used to reach the endpoint, so nothing has to know
the public origin — which, behind a reverse proxy, it generally does not. Each
can be overridden with an environment variable (`PUBLIC_WS_PATH`,
`PUBLIC_JOIN_PATH`, `PUBLIC_CONTROL_PATH`, `PUBLIC_KATEX_CSS_PATH`,
`PUBLIC_HIGHLIGHT_CSS_PATH`) or with absolute URLs, which is what lets the quiz
server live under a path prefix rather than owning a domain root.

Every key listed above is **required**. A component that does not find one of
them refuses to start rather than falling back to a hardcoded layout: a silently
wrong path is the failure mode this endpoint exists to remove.

### Protocol versioning

The component and the server ship on different schedules: a slide deck pins a
bundled copy and is re-published when its author feels like it, and an
institutional quiz server is updated when its administrator feels like it.
`PROTOCOL_VERSION` (see `packages/ld-quiz/src/protocol.js`) is what keeps a stale
pairing from failing obscurely.

- Clients send `protocolVersion` on `create_room`, `join_room`,
  `control_connect` and `room_status`.
- A server that does not speak the announced version replies with
  `{ "type": "error", "code": "protocol_mismatch", "message": ... }` naming both
  versions, and closes the socket. It does not count against the abuse limits: a
  stale deployment is not a prober.
- A **missing** `protocolVersion` is a mismatch like any other. Defaulting it
  away would only mean that the first real incompatibility surfaces as a
  confusing runtime failure instead of as this error.

The version describes the wire format, not the release, and is deliberately
decoupled from the package version so that a UI-only release does not invalidate
every embedded copy in the wild. Optional fields and new message types that an
older peer can ignore, such as the consent fields below, do not bump it.

### WebSocket Messages

All messages are JSON objects with a `type` field.

Messages that open a conversation (`create_room`, `join_room`, `rejoin_room`,
`control_connect`, `room_status`, `start_practice`) also carry `protocolVersion`; see
[Protocol versioning](#protocol-versioning).

**Presenter → Server:**
- `create_room`: Create a new quiz room
  - `protocolVersion`: The wire-format version the client speaks
  - `presenterToken`: SHA-256 hash of the quiz data or password
  - `quiz`: The quiz object (rendered server-side)
- `start_game`: Begin the quiz
- `end_question`: End the current question and show results
- `next_question`: Advance to the next question or end the game
- `accept_answer`: While a short-answer question's results are shown, count an answer as correct after
  all. Every answer in the same normalized form is re-scored, and `results` and `question_results` are
  sent again. Ignored, without an error, once the quiz has moved on
  - `questionIndex`: The question whose results are shown
  - `answer`: Any spelling of the answer, as listed in `question_results`
  - `accepted`: Optional, default `true`; `false` takes an earlier acceptance back. Answers the server
    matched itself cannot be counted as wrong this way
- `control_connect`: Connect to a room as presenter
  - With `roomId`: join the control channel for that room
  - Without `roomId`: receive a `sessions_list` of all rooms for this presenter

**Participant → Server:**
- `join_room`: Join a room with a name
  - `roomId`: Room to join
  - `name`: Participant display name
  - `consent`: Optional; only `true` counts, and only if the quiz sets `recordNamedResults`. Agrees to
    name and final score appearing in the results export
- `set_consent`: Give or withdraw that consent; allowed until the quiz ends
  - `consent`: `true` or `false`
- `rejoin_room`: Come back as an existing participant after a dropped connection or a reload
  - `roomId`: Room to rejoin
  - `resumeToken`: The token received in `joined`
- `submit_answer`: Submit an answer, or a changed one: while the question is open, a second
  answer replaces the first. The question closes once every connected participant has answered,
  so a change made before that counts; one that arrives later is refused with `no_open_question`
  - `answer`: Array of option indices (multiple-choice), a number (estimation), a string
    (short-answer; no longer than the question's `maxLength`, spacing collapsed and umlauts written out),
    or for ordering every index of the question's `options` as received, once each, in the
    participant's order
- `start_practice`: Start a [practice game](#practice-mode) on this connection
  - `protocolVersion`: The wire-format version the client speaks
  - `quizId`: A catalog `id`
- `practice_next`: In a practice game, skip the rest of the results countdown

**Server → Presenter (`ld-quiz` component):**
- `room_created`: Room was created; includes `roomId`, `quizTitle`, `totalQuestions`
- `participant_joined` / `participant_left`: Lobby participant count updates. `count` is
  the number connected right now; `reconnecting` is the number whose connection dropped
  and who may still come back. `participant_left` carries `detached: true` for a dropped
  connection, `participant_joined` carries `rejoined: true` for a return.

**Server → Control Window (`quiz-control.js`):**
- `control_connected`: Initial state after connecting; includes `roomId`, `state`, `quizTitle`, `totalQuestions`, `currentQuestionIndex`, `question`, `participantCount`, `reconnectingCount`, `leaderboard`
- `sessions_list`: List of active sessions when no `roomId` was provided
- `game_started`: Quiz started; includes `questionIndex` and `question`
- `question_started`: Next question is active; includes `questionIndex` and `question`
- `question_results`: Question ended; includes `questionIndex`, `answers`, and `leaderboard`. Sent
  again after `accept_answer`; an answer the presenter accepted carries `acceptedByPresenter: true`
- `answer_count`: Live count of submitted answers during a question. A changed answer does not
  change the count, and sends none
- `participant_joined` / `participant_left`: Participant count updates, as above
- `participants_list`: Reply to `get_participants`; each entry has `id`, `name`, `score` and `connected`
- `game_ended` / `results_export`: The quiz ended, or reply to `export_results`; `statistics` holds the
  per-question summary, `recordsNamedResults`, and `namedResults` — `{ name, score }` of the participants
  who consented, or `null` before the quiz has ended or when the quiz does not ask

**Server → Participant (`quiz-client.js`):**
- `room_status`: Reply to `room_status`; includes `state`, `quizTitle`, `totalQuestions`,
  `currentQuestionIndex`, `participantCount` and `recordsNamedResults` (whether to offer consent)
- `joined`: Successfully joined; includes `participantId`, `quizTitle` and `resumeToken` (a secret
  sent only to this participant, kept in the tab's `sessionStorage`, and used by `rejoin_room`), and
  `recordsNamedResults` and `consent` as the server recorded them
- `rejoined`: Reply to a successful `rejoin_room`; includes `participantId`, `quizTitle`, `state`,
  `answeredQuestions`, `recordsNamedResults` and `consent`, followed by the current `question`,
  `results` or `game_ended`
- `consent_updated`: Reply to an accepted `set_consent`; includes `consent`
- `rejoin_failed`: The token is unknown or expired, or the room is gone. Join again as a new participant
- `question`: New question available; includes `questionIndex`, `totalQuestions`, `question`, `startTime`,
  and `alreadyAnswered` when it is replayed to somebody who has already answered, with `yourAnswer`,
  their answer as they gave it (for ordering, in the shown order), so the page can show it again and
  offer to change it. `question` carries
  `type`, `text`, `options` and `timeLimit`, and for a short-answer question `answerLength: { min, max }`
  and `maxLength`, derived from the accepted answers — never the answers themselves. An ordering
  question's `options` are shuffled, the same for everybody in the room and never in the correct
  order
- `answer_accepted`: The answer arrived while the question was open; `replaced: true` if it replaced
  an earlier one. Not sent for the answer that closes the question: `results` follows instead
- `results`: Round results with `leaderboard`, `questionIndex`, and `waiting`. In a practice game
  also `practice: true`, `totalQuestions` and `advanceInMs` (time left on the countdown), and an estimate's
  `feedback` carries `band` (10, 25, 50 or `null`) and `points` instead of a rank. Sent again when the
  presenter accepts a short answer after all; the `feedback` of those who gave it then carries
  `acceptedByPresenter: true`. For an ordering question, `feedback.question.options` are the items
  as they were shown and `feedback.answer` the participant's order as indices into them
- `game_ended`: Final results; includes `leaderboard`, and in a practice game
  `summary: { score, maxScore, correct, total }`

A practice game answers `start_practice` with `joined` (plus `practice: true` and
`practiceQuizId`) and then the first `question`; `rejoined` carries the same two fields.
An unknown quiz id is refused with an `error` whose `code` is `practice_unavailable`.

**Server → Broadcast:**
- `game_ended`: Sent to all connected clients when the quiz ends

**Server → Any Client:**
- `error`: Error message from the server

A participant socket that another connection takes over with the same resume token is
closed with code `4000`; the join page does not reconnect after it.

## Browser Support

This application targets modern browsers (released within the last year). It uses:
- Web Components (Custom Elements, Shadow DOM)
- ES Modules
- Web Crypto API
- Native WebSocket
- CSS Custom Properties

## License

BSD-3-Clause (same as the underlying crypto library and LectureDoc2)
