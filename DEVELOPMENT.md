# Quizzy — Local Development

How to run the Quizzy server on your own machine and how to test it. Installing it
on a production host is described in [DEPLOY.md](DEPLOY.md), keeping that host up to
date in [UPDATE.md](UPDATE.md).

A Quizzy server is two programs, the backend and Caddy
([ARCHITECTURE.md](ARCHITECTURE.md) explains the division). Development runs both,
exactly as production does.

---

## 1. Prerequisites

- **Node.js 24**, the version CI tests against. Any installation works here, `nvm`
  included.
- **pnpm**, in the version pinned by `packageManager` in `package.json`.
  `corepack enable` provides it.
- **Caddy** — on macOS `brew install caddy`.
- **mkcert**, only for HTTPS (§4) — on macOS `brew install mkcert`.

---

## 2. Install and build

From the repository root, which installs the workspace and both packages at once:

```bash
pnpm install
pnpm build            # writes dist/
```

`dist/` is git-ignored, so build after every checkout and every pull. Variants:

| Command | Effect |
|---|---|
| `pnpm build` | Full build: the component (versioned and moving URL) and the application pages |
| `pnpm build --minify` | The same, minified — as with `NODE_ENV=production` |
| `pnpm watch` | Rebuilds the browser code on every change |
| `pnpm clean` | Removes `dist/` |

Two limits of `pnpm watch`: HTML, CSS, KaTeX and the highlighting stylesheet are
copied **once** at start, so restart it after changing them; and it writes only the
moving `/component/ld-quiz.js`, not the versioned `/component/<version>/` copy.
The pages in `packages/server/web/` use the moving URL; for anything that pins the
versioned one, run `pnpm build`.

---

## 3. Run it over HTTP on localhost

The simplest setup needs no certificate. Browsers treat `http://localhost` as a
secure context, so the Web Crypto API that the presenter's side needs is available.

Terminal 1, the backend (port 3000 by default):

```bash
pnpm start
```

`pnpm dev` does `pnpm build` first and then the same. To restart the backend
automatically whenever its sources change, use
`pnpm --filter ld-quiz-server dev` (Node's `--watch`).

Terminal 2, Caddy, from the repository root:

```bash
CADDY_HOST=http://localhost:8080 HTTP_PORT=8080 caddy run --config Caddyfile
```

Open http://localhost:8080/demo.html.

The two configurations in `.claude/launch.json` run the same setup, with the
backend on port 3100 instead (`PORT=3100` for the backend, `BACKEND_PORT=3100` for
Caddy).

---

## 4. Run it over HTTPS (other devices on the network)

To try a lecture with real phones on the same Wi-Fi, the server has to be reached by
its LAN address instead of `localhost` — and there browsers grant the Web Crypto API
only over HTTPS. The snippet `caddy/tls-mkcert.txt` gives Caddy a locally trusted
certificate for that.

**Create the certificate once.** The snippet loads `192.168.178.161+4.pem` and
`192.168.178.161+4-key.pem` from the repository root (both git-ignored), so write
the certificate under exactly these names, whatever addresses it covers. Replace
`192.168.178.161` by your machine's LAN address (`ipconfig getifaddr en0` on macOS):

```bash
mkcert -install       # once per machine: creates a local CA and trusts it here
mkcert -cert-file 192.168.178.161+4.pem -key-file 192.168.178.161+4-key.pem \
  192.168.178.161 localhost 127.0.0.1 ::1
```

**Run Caddy** with the backend from §3 still running:

```bash
# https://localhost/demo.html
CADDY_HOST=localhost TLS_CONFIG=caddy/tls-mkcert.txt caddy run --config Caddyfile

# https://192.168.178.161/demo.html, also from other devices
CADDY_HOST=192.168.178.161 TLS_CONFIG=caddy/tls-mkcert.txt caddy run --config Caddyfile
```

A phone trusts the certificate only once mkcert's root CA is installed on it;
`mkcert -CAROOT` prints the directory containing `rootCA.pem`. Never copy the
`rootCA-key.pem` next to it anywhere: it lets its holder issue certificates your
machine trusts.

---

## 5. Try it out

- **`/demo.html`** offers encrypted demo quizzes (password `test123`) and an
  unencrypted one. Starting one opens the control window; join as a participant
  through the QR code or the join link, e.g. from a phone (§4) or a second browser
  window.
- **`/practice.html`** lists the quizzes of the practice catalog (see "Practice
  Mode" in the README). After editing the catalog, restart the backend or send it
  `kill -HUP <pid>` to make it read the catalog again.
- **`/tools.html`** is the authoring tool; it and its command-line counterparts are
  described under "Validate and Encrypt the Quiz" in the README.

To embed `<ld-quiz>` in a page served from elsewhere — a LectureDoc2 deck on its own
development server, say — point its `server-url` attribute at the Caddy address
from §3 or §4. With the default `ALLOWED_ORIGINS` nothing else needs configuring.

---

## 6. Tests

The server package uses Node's built-in test runner:

```bash
pnpm test                                   # unit and integration tests
pnpm --filter ld-quiz-server test:watch     # the same, re-run on change
pnpm test:browser                           # Playwright tests of the pages
pnpm test:all                               # both suites
```

The unit and integration tests cover room state (participant lifecycle, game flow,
scoring), math rendering, syntax highlighting and the order the two run in, name
validation, network address discovery, the server's HTTP API, CORS headers and
WebSocket message flow, and the integration contract (`/api/config` and the
protocol handshake). Encryption is tested in
[`@lecturedoc2/libcrypto`](https://github.com/LectureDoc2/ld-libcrypto), where it
is implemented.

The browser tests need Chromium, which a fresh checkout does **not** have, because
Playwright's postinstall is blocked (see "About dependency build scripts" in
DEPLOY.md §9). Install it once, explicitly:

```bash
pnpm --filter ld-quiz-server exec playwright install chromium
```

Or point the tests at a browser that is already on the machine:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome pnpm test:browser
```

Neither suite needs Caddy or a running backend; the tests start their own servers.
CI (`.github/workflows/ci.yml`) runs both suites and the build on every push to
`main` and on every pull request.

---

## 7. Configuration

Development and production read the same variables. The complete lists are in
DEPLOY.md: Caddy's in [§10c](DEPLOY.md#10c-create-the-environment-file), the
backend's in [§13](DEPLOY.md#13-backend-configuration).
