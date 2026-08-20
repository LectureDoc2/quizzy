# ld-quiz

A real-time, embeddable quiz application designed for integration with any HTML-based presentation system (e.g., **LectureDoc2**). The core is a vanilla JavaScript **Web Component** (`<ld-quiz>`) that handles presenter authentication, quiz decryption, participant management, and real-time game flow.

## Features

- **Web Component Architecture**: Embeddable in any HTML document using Shadow DOM for style isolation
- **Real-time Gameplay**: Native WebSocket communication for live quiz sessions
- **Secure Quiz Content**: Client-side AES-GCM encryption with PBKDF2 key derivation ([`@lecturedoc2/libcrypto`](https://www.npmjs.com/package/@lecturedoc2/libcrypto))
- **Presenter Control**: Separate control window with session management and reconnection support
- **Participant QR Code Join**: Participants scan a QR code or use a short link to join
- **Math Formula Support**: Server-based KaTeX rendering for quiz questions and answers
- **Minimal Dependencies**: Express.js and `ws` (WebSocket) on the server; the crypto library - part of LectureDoc2 without additional transitive dependencies - is the client's only dependency

## Supported Question Types

1. **Multiple Choice**: Standard A/B/C selection
2. **Estimation**: Numeric answers with rank-based scoring:
   - 1st closest: 100 points
   - 2nd closest: 50 points
   - 3rd closest: 25 points
   - Tie-breaker: earliest submission wins

## Project Structure

This is a **pnpm workspace** with two packages: the embeddable web component and the
backend that hosts a quiz session.

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
│   │   ├── src/qrcode.min.js       #   minimal QR code generator (zero deps)
│   │   ├── src/quiz-styles.css     #   Shadow DOM styles
│   │   └── package.json            #   dep: @lecturedoc2/libcrypto
│   │
│   └── server/                     # the backend and the pages it serves
│       ├── src/server.js           #   Express + WebSocket server
│       ├── src/rooms.js            #   room state management and scoring
│       ├── src/math-renderer.js    #   server-side KaTeX rendering
│       ├── src/name-validator.js   #   participant name validation
│       ├── src/network-addresses.js
│       ├── web/                    #   join/control/demo pages (HTML, CSS, page scripts)
│       ├── test/
│       └── package.json            #   deps: express, ws, katex
│
├── tools/encrypt-quiz.js           # CLI utility to encrypt quiz JSON
├── quizzes/                        # example quizzes (plain and encrypted)
└── dist/                           # build output served by Caddy (git-ignored)
```

### Why there is a build step

The browser code imports the crypto library by its **bare specifier**
(`@lecturedoc2/libcrypto`), which browsers cannot resolve on their own.
`build.js` uses esbuild to bundle each browser entry point — inlining the library —
and assembles `dist/` so that its layout matches the public URLs one-to-one:

| Source | URL |
|--------|-----|
| `packages/ld-quiz/src/ld-quiz.js` | `/client/ld-quiz.js` |
| `packages/ld-quiz/src/quiz-styles.css` | `/client/quiz-styles.css` |
| `packages/server/web/js/quiz-client.js` | `/client/quiz-client.js` |
| `packages/server/web/js/quiz-control.js` | `/client/quiz-control.js` |
| `packages/server/web/*.html` | `/*.html` |
| `packages/server/web/styles/` | `/styles/` |
| `packages/server/web/katex/` | `/katex/` |

Consumers that use a bundler themselves can instead import the component's sources
directly and let their own bundler resolve the dependency.

## Quick Start

### 1. Install Dependencies

From the repository root — this installs the workspace and both packages at once:

```bash
pnpm install
```

### 2. Build the Static Files

```bash
pnpm build            # writes dist/
pnpm watch            # rebuilds the browser code on change
pnpm build --minify   # minified output (implied by NODE_ENV=production)
```

`dist/` is git-ignored and must be rebuilt after every checkout and every deployment.

### 3. Create a Quiz

Create a JSON file with your quiz questions:

```json
{
  "title": "Mathematics Quiz",
  "questions": [
    {
      "type": "multiple-choice",
      "text": "What is the derivative of \\( x^2 \\)?",
      "options": [
        "\\( 2x \\)",
        "\\( x \\)",
        "\\( x^2 \\)"
      ],
      "correctIndices": [0],
      "timeLimit": 30
    },
    {
      "type": "estimation",
      "text": "Estimate the value of \\( \\sqrt{2} \\) to 2 decimal places.",
      "correctAnswer": 1.41,
      "timeLimit": 45
    }
  ]
}
```

### 4. Encrypt the Quiz

```bash
pnpm encrypt quizzes/my-quiz.json quizzes/my-quiz-encrypted.txt
# Enter your password when prompted
```

### 5. Start the Backend

The Node backend exposes only the API and WebSocket endpoint. In production it should sit behind Caddy and not be reached directly from browsers.

```bash
pnpm start
# Backend listens on http://localhost:3000
```

### 6. Start Caddy

Caddy serves the contents of `dist/` and proxies API/WebSocket traffic to the backend. Run it from the repository root:

```bash
# Local development with HTTPS (uses the mkcert certificate in the repo root)
CADDY_HOST=localhost TLS_CONFIG=caddy/tls-mkcert.txt caddy run --config Caddyfile

# Local-network development (e.g. for phones on the same Wi-Fi)
CADDY_HOST=192.168.178.161 TLS_CONFIG=caddy/tls-mkcert.txt caddy run --config Caddyfile

# Production (automatic HTTPS via Let's Encrypt / ZeroSSL)
CADDY_HOST=quiz.example.com caddy run --config Caddyfile
```

Open `https://<host>/demo.html` in your browser.

### 7. Embed the Quiz

The `<ld-quiz>` component supports both **encrypted** and **unencrypted** quizzes.

#### Encrypted Quiz (password required)

Add the `encrypted` attribute and provide the encrypted quiz data:

```html
<ld-quiz encrypted quiz="MTAwMDAw:abc123...encrypted-data..." server-url="https://quiz.example.com"></ld-quiz>
<script type="module" src="https://quiz.example.com/client/ld-quiz.js"></script>
```

The presenter will be prompted for a password to decrypt the quiz.

#### Unencrypted Quiz — Inline JSON

Provide the quiz JSON directly via the `quiz` attribute:

```html
<ld-quiz quiz='{"title":"My Quiz","questions":[...]}' server-url="https://quiz.example.com"></ld-quiz>
```

The quiz title is shown with a "Start Quiz" button. No password is required.

#### Unencrypted Quiz — File Upload

If no `quiz` attribute is provided, a file picker is shown:

```html
<ld-quiz server-url="https://quiz.example.com"></ld-quiz>
```

The presenter selects a `.json` file, and the quiz title is shown with a "Start Quiz" button.

> **Note:** The `server-url` attribute is required when the quiz server is hosted on a different domain than the slide set. If omitted, it defaults to the current page's origin.

### 8. Cross-Origin Deployment

When the slide server and quiz server are on different origins, the quiz server must allow cross-origin requests.

Caddy adds permissive CORS headers (`Access-Control-Allow-Origin: *`) to all static-file responses, so stylesheets and ES modules can be loaded from any origin.

For the API, CORS is handled by the Node backend. It allows all origins by default, but you can restrict it:

```bash
# Allow any origin (default, for development)
ALLOWED_ORIGINS="*" pnpm start

# Restrict to specific origins
ALLOWED_ORIGINS="https://slides.example.com,https://presenter.example.com" pnpm start
```

### Caddy Configuration

The `Caddyfile` in the repository root is configured through environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CADDY_HOST` | `localhost` | Site address (e.g. `localhost`, `192.168.178.161`, `quiz.example.com`) |
| `BACKEND_HOST` | `localhost` | Host of the Node backend |
| `BACKEND_PORT` | `3000` | Port of the Node backend |
| `TLS_CONFIG` | `caddy/tls-auto.txt` | Path to a TLS snippet file. Empty file = automatic HTTPS. Set to `caddy/tls-mkcert.txt` for local HTTPS. |
| `ALLOWED_ORIGINS` | `*` | Origins allowed by the Node API CORS middleware |

### 9. Production Deployment

See [DEPLOY.md](DEPLOY.md) for the full walkthrough. In short:

- Caddy is the public entry point: it terminates TLS and serves `dist/`.
- API requests (`/api/*`) and WebSocket connections (`/ws`) are proxied to the Node backend.
- The backend runs on `localhost:3000` (configurable via `BACKEND_HOST`/`BACKEND_PORT`).
- After every `git pull`, run `pnpm install && pnpm build` — `dist/` is not committed.

TLS is required because the Web Crypto API (used for hashing and decryption) only works in a secure context.

### 10. Run the Quiz

1. Open the page containing the quiz component
2. Enter your password to decrypt and start the quiz
3. The control window opens automatically
4. Participants join by scanning the QR code or visiting the join URL
5. Use the control window to start rounds, end rounds, and advance questions

## Quiz JSON Format

```json
{
  "title": "Quiz Title",
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
    }
  ]
}
```

- `text`: Question text (supports KaTeX math with `\(...\)` and `\[...\]` delimiters)
- `options`: Array of strings (for multiple-choice)
- `correctIndices`: Array of zero-based indices of correct options (for multiple-choice). Single-answer questions use a one-element array, e.g. `[0]`. Multi-select questions use multiple indices, e.g. `[0, 2]`.
- `correctAnswer`: Numeric value (for estimation)
- `timeLimit`: Optional countdown timer in seconds

## `<ld-quiz>` Element Attributes

| Attribute | Required | Description |
|-----------|----------|-------------|
| `encrypted` | No | Presence attribute. If set, the `quiz` value is treated as encrypted ciphertext |
| `quiz` | Yes | The quiz data: encrypted ciphertext (when `encrypted` is present) or inline JSON string |
| `server-url` | No | The quiz server URL. Defaults to `window.location.origin` |

## Security Model

- The quiz JSON is encrypted on the client side using the presenter's password
- The server receives the **decrypted** quiz only after the presenter decrypts it
- The server never persists quiz data to disk; all data is ephemeral (in-memory only)
- The presenter uses a SHA-256 hash of the quiz to identify himself.
- Participants require no authentication; they join via a random room code
- **Cross-origin**: The quiz server allows CORS from any origin by default. For production, restrict with `ALLOWED_ORIGINS`

## Server API

### WebSocket Messages

All messages are JSON objects with a `type` field.

**Presenter → Server:**
- `create_room`: Create a new quiz room
  - `presenterToken`: SHA-256 hash of the quiz data or password
  - `quiz`: The quiz object (rendered server-side)
- `start_game`: Begin the quiz
- `end_question`: End the current question and show results
- `next_question`: Advance to the next question or end the game
- `control_connect`: Connect to a room as presenter
  - With `roomId`: join the control channel for that room
  - Without `roomId`: receive a `sessions_list` of all rooms for this presenter

**Participant → Server:**
- `join_room`: Join a room with a name
  - `roomId`: Room to join
  - `name`: Participant display name
- `submit_answer`: Submit an answer
  - `answer`: Selected option index, array of indices, or estimation value

**Server → Presenter (`ld-quiz` component):**
- `room_created`: Room was created; includes `roomId`, `quizTitle`, `totalQuestions`
- `participant_joined` / `participant_left`: Lobby participant count updates

**Server → Control Window (`quiz-control.js`):**
- `control_connected`: Initial state after connecting; includes `roomId`, `state`, `quizTitle`, `totalQuestions`, `currentQuestionIndex`, `question`, `participantCount`, `leaderboard`
- `sessions_list`: List of active sessions when no `roomId` was provided
- `game_started`: Quiz started; includes `questionIndex` and `question`
- `question_started`: Next question is active; includes `questionIndex` and `question`
- `question_results`: Question ended; includes `questionIndex`, `answers`, and `leaderboard`
- `answer_count`: Live count of submitted answers during a question
- `participant_joined` / `participant_left`: Participant count updates

**Server → Participant (`quiz-client.js`):**
- `joined`: Successfully joined; includes `participantId` and `quizTitle`
- `question`: New question available; includes `questionIndex`, `totalQuestions`, `question`, `startTime`
- `results`: Round results with `leaderboard`, `questionIndex`, and `waiting`
- `game_ended`: Final results; includes `leaderboard`

**Server → Broadcast:**
- `game_ended`: Sent to all connected clients when the quiz ends

**Server → Any Client:**
- `error`: Error message from the server

## Development

### Testing

The server package uses Node.js's built-in test runner:

```bash
pnpm test                            # from the repository root
pnpm --filter ld-quiz-server test:watch
```

Tests cover:
- **Room state management**: Participant lifecycle, game flow, scoring logic
- **Math rendering**, **name validation** and **network address discovery**
- **Server integration**: CORS headers, HTTP API, WebSocket message flow

Crypto is no longer tested here; it lives in and is tested by
[`@lecturedoc2/libcrypto`](https://github.com/LectureDoc2/ld-libcrypto).

### Manual Testing

```bash
# Terminal 1
pnpm build && pnpm start

# Terminal 2 (repo root)
CADDY_HOST=localhost TLS_CONFIG=caddy/tls-mkcert.txt caddy run --config Caddyfile

# Open https://localhost/demo.html
# Use password: test123
```

Go to, e.g.,: https://192.168.178.161/demo.html to open the application.

### KaTeX Integration

Math formulas in quiz questions and answers are rendered to HTML on the server before they are sent to clients. The client only needs the KaTeX stylesheet to display the rendered math correctly.

When using the `ld-quiz` web component, the stylesheet is fetched automatically from the configured `server-url` and injected into the shadow DOM, so no manual setup is required.

For standalone pages (such as `demo.html`), include the stylesheet in the host page:

```html
<link rel="stylesheet" href="/katex/katex.min.css">
```

The KaTeX distribution is vendored in `packages/server/web/katex/` and copied to
`dist/katex/` by the build.

## Browser Support

This application targets modern browsers (released within the last year). It uses:
- Web Components (Custom Elements, Shadow DOM)
- ES Modules
- Web Crypto API
- Native WebSocket
- CSS Custom Properties

## License

BSD-3-Clause (same as the underlying crypto library and LectureDoc2)
