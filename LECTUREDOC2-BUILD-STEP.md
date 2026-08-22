# The LectureDoc2 build step

Applied 2026-08-22. Everything here was run against the real repositories, not
sketched; where something is unverified it says so.

The prize is not the quiz component as such. It is that LectureDoc2 stops having
to keep private copies of code that already exists as a package.
`src/js/ld-crypto.js` was the first such copy; the quiz component would have
been the second.

---

## 1. What changed

### `Quizzy26`

| File | Change |
|---|---|
| `packages/ld-quiz/README.md` | usage, attributes, exports, CSP requirements, third-party notice |
| `packages/ld-quiz/LICENSE` | copy of the repository's BSD-3 licence |
| `packages/ld-quiz/package.json` | `repository`+`directory`, `homepage`, `bugs`, `keywords`, `engines`, `publishConfig.access: public`, `LICENSE` in `files` |
| `packages/ld-quiz/src/qrcode.js` | renamed from `qrcode.min.js` (it was never minified); its MIT header turned into a `/*! @license */` block — see below |
| `packages/ld-quiz/package.json` | package renamed to **`@lecturedoc2/quizzy`**; `repository`/`homepage`/`bugs` now point at the **LectureDoc2** org |
| `.github/workflows/{ci,release}.yml` | tests on every push, provenance-signed publish on a `v*` tag (see §5) |
| root `package.json` | `packageManager: pnpm@11.22.0`, so CI does not guess the pnpm version |
| `DEPLOY.md`, `packages/ld-quiz/README.md` | repository moved from `Delors/quizzy` to `LectureDoc2/quizzy` (DEPLOY.md still said `Delors/quiz.git`, an older name still) |

`npm pack` → 7 files, 24 kB. Installed into a throwaway project, all four export
paths bundle cleanly.

### `LectureDoc2`

| File | Change |
|---|---|
| `build.js` | new — esbuild bundle of the seven deck-loadable entry points |
| `package.json` | `files: ["dist"]`; `build` / `build:dev` / `watch` / `prepare` scripts; `esbuild` devDep; `@lecturedoc2/quizzy` + `@lecturedoc2/libcrypto` deps |
| `.gitignore` | `dist/` |
| `src/ld.js` | `ldCrypto()` now does `import("@lecturedoc2/libcrypto")` |
| `src/js/ld-crypto.js` | **removed** (moved to `_to_delete/`) |
| `components/ld-quizzy.js` | rewritten — see §4 |
| `.publish` | **retired** (moved to `_to_delete/publish-list-obsolete`) — see §3 |

### `Lectures-Myst`

| File | Change |
|---|---|
| `myst.yml` | `ld.path` → `LectureDoc2/dist/src`; every `ld.modules` url → `dist/`; new `ld-quiz` module; the five icon substitutions → `/LectureDoc2/dist/ext/…` |
| `ld.config.json` | new `assets` rule publishing the `lecturedoc2` package |

### The QR library's MIT notice was being stripped from every bundle

`src/qrcode.js` carries Kazuhiko Arase's copyright and MIT notice as an ordinary
`//---` comment block. esbuild keeps only *legal* comments — ones marked `//!`,
`/*!`, `@license` or `@preserve` — and discards the rest, so the attribution was
absent from `dist/client/ld-quiz.js`, from anything a consumer bundled, and now
from LectureDoc2's `dist` as well. MIT requires the notice in all copies.

The header is now a `/*! @license */` block. Verified: the notice survives both
a plain and a `--minify` bundle. Nothing else changed in that file.

**`pnpm build` in Quizzy26 should be re-run on macOS before the quiz server is
deployed again**, so the hosted `/client/<version>/ld-quiz.js` carries it too.

---

## 2. Three things that would have broken silently

Each of these was found by checking the output, not by reading the source.

### `import.meta.resolve` and the chunk directory

`ld.js` locates the toolbar icons and the help fragment with

```js
const base = import.meta.resolve("./css/ui/icons/2025/");
const helpFrag = import.meta.resolve("./js/ld-help.frag.html");
```

which resolves against the URL of whichever file the code ends up in. With
esbuild's default chunk placement that file is `dist/chunk-*.js`, so every
toolbar icon and the help dialog 404 — and a missing `<img>` is not an error
anyone notices before standing in front of a lecture hall.

`chunkNames: "src/[name]-[hash]"` puts the chunks beside `dist/src/ld.js`, where
those relative URLs point back into the copied `src/css` and `src/js` trees.
Verified by resolving each URL against the built tree:

```
OK   ./css/ui/icons/2025/
OK   ./js/ld-help.frag.html
```

### `splitting` is a correctness requirement

Every component does `import { ldEvents } from "../src/ld.js"`, and today they
share one instance only because a browser fetches a given URL once. Bundle each
entry point independently and each gets a *private* copy of `ld.js`: the event
bus fragments, `customElements.define` runs several times, and nothing announces
the problem. Verified that all six entry points import the same chunk.

### `timeline.js` resolves its own stylesheet

`components/timeline/timeline.js:196` does
`import.meta.resolve("./timeline.css")`. Bundling inlines it into
`components/ld-timeline.js`, one directory up, so the URL becomes
`components/timeline.css`. The build publishes the stylesheet under both names —
the bundle finds the first, an unbundled checkout still finds the second.

---

## 3. What the build produces

```
dist/
├── src/ld.js, src/chunk-*.js        runtime + 12 lazily loaded chunks
├── src/libcrypto.min-*.js           crypto, fetched only by a deck that decrypts
├── src/ld.css, src/css/             stylesheets, minified in place
├── src/js/ld-help.frag.html
├── components/*.js                  the modules a deck can pull in
├── components/timeline.css
└── ext/, favicon/
```

`tryLoadModule`'s `import(\`./js/${name}.js\`)` is resolved by esbuild as a glob
into twelve separate lazy chunks, so on-demand loading is unchanged. No bare
specifiers survive anywhere in the output. `window.lectureDoc2` and
`prepareForPrinting` land in the shared chunk, so `LectureDoc2Author`'s PDF
renderer is unaffected. LectureDoc2Author's 129 tests still pass.

### CSS is minified, not bundled

`npm run build` minifies each stylesheet in place and leaves the `@import` graph
alone (840 kB → 512 kB). Flattening it would be wrong twice over: `ld.css` is a
chain of `@import`s carrying `layer()` annotations and a deck selects its theme
by importing one more of them into `layer(theme)`, so inlining hands an ordering
the themes depend on to the bundler; and bundled CSS brings asset hashing with
it, which is incompatible with the runtime resolving `./css/ui/icons/2025/`
against its own module URL. Per-file minification buys the size with neither
risk — `esbuild.transform` rewrites no `@import` and no `url()`.

If the ~30 requests per deck ever matter, the fix is HTTP/2 push or a
hand-maintained concatenation order, not the bundler.

### `.publish` is gone

`LectureDoc2/.publish` listed ~151 files by hand. Now that `dist/` is a build
product with a proper `files` field, `ld.config.json` publishes the package
directly — which is exactly what `assets.js` was written for, and its own
docstring warns the two may not both claim the `LectureDoc2` folder:

```json
"assets": [{ "package": "lecturedoc2", "to": "LectureDoc2" }]
```

Verified: the rule resolves to 193 files, all under `dist/`, including
`dist/src/ld.js`, `dist/components/ld-quizzy.js`, `dist/components/timeline.css`
and `dist/src/css/ui/icons/2025/view.svg`.

This also settles the dev-versus-publish asymmetry from the earlier draft. An
npm package installed under `node_modules/` would have had one path locally and
another on the site; `dist/` sits inside the submodule, so the source path and
the site path are the same string, exactly as `src/` used to be.

Deck head verified for a deck one level below the root:

```html
<script src="../LectureDoc2/dist/src/ld.js" type="module"></script>
<link rel="stylesheet" href="../LectureDoc2/dist/src/ld.css" />
<style>@import url("../LectureDoc2/dist/src/css/themes/dhbw.css") layer(theme);</style>
<script src="../LectureDoc2/dist/components/ld-quizzy.js" type="module"></script>
```

All four resolve on disk.

---

## 4. The bridge, and the one open question

`components/ld-quizzy.js` now follows the `ld-timeline` house style: `ldEvents`
imported rather than sniffed off the global object, the component imported for
its side effect, no `typeof` fallback.

The old bridge read `moduleElement.dataset.ldQuizServer`, and **that could never
have worked**: the `{module}` directive
(`LectureDoc2Author/src/directives/layout.js:261`) accepts only `class` and
`scope`, and `handlers.js` emits `<ld-module class name scope>`. There is no
`data-*` passthrough.

So the rewrite takes a JSON envelope in the directive body, exactly as
`{module} timeline` already does:

````
```{module} ld-quiz
{
    "server-url": "https://quiz.example.com",
    "presenter-name": "Michael Eichberg",
    "encrypted": true,
    "quiz": "NjAwMDAw:9Xk2...:pQ7f...:Lm4z..."
}
```
````

Every key other than `quiz` is one of the component's own attributes, spelled
the same way and meaning the same thing, so the envelope describes the
`<ld-quiz>` element it produces rather than introducing a second vocabulary.

| key | attribute | meaning |
|---|---|---|
| `quiz` | `quiz` | the payload: an encrypted string, or the quiz object itself |
| `encrypted` | `encrypted` | `true` ⇒ `quiz` must be decrypted first |
| `server-url` | `server-url` | quiz server; defaults to the origin the deck came from |
| `presenter-name` | `presenter-name` | prefills the presenter name, beating `localStorage` |

`encrypted` mirrors the attribute, so omitting it means a plaintext quiz — which
is what a simple one wants. An earlier draft inverted this into a `plaintext`
key defaulting to encrypted, on the grounds that it was the safer mistake. It is
not: the flag says how to *read* the payload, and a quiz is encrypted by
`tools/encrypt-quiz.js` long before it reaches a deck. Getting it wrong fails
loudly at the first slide — a JSON parse error, or a password prompt nothing
satisfies — and leaks nothing either way.

A plaintext quiz may be written as a nested JSON object rather than a string,
which spares the author escaping a whole quiz into a string inside the envelope.
Setting `encrypted` on a nested object is refused rather than guessed at.

Verified against the built bundle with a stubbed DOM — four accepted shapes and
three rejected ones, each with its own message:

```
encrypted quiz          -> {"quiz":"NjAw:aa:bb:cc","encrypted":"","server-url":"https://q.example.com"}
plaintext string        -> {"quiz":"{\"title\":\"T\",\"questions\":[]}"}
plaintext nested obj    -> {"quiz":"{\"title\":\"T\",\"questions\":[]}","presenter-name":"Michael"}
all four keys           -> {"quiz":"a:b:c:d","encrypted":"","server-url":"https://q","presenter-name":"M"}
ERR encrypted+object    -> "encrypted" is set, but "quiz" is not an encrypted string
ERR missing quiz        -> the "quiz" key is missing or empty
ERR not json            -> SyntaxError: ... is not valid JSON
```

Should the envelope ever grate, the alternative is teaching the `{module}`
directive a generic option passthrough onto `<ld-module>` as `data-*` — "a
module needs configuration" is a general need, not a quiz-specific one — at the
cost of a LectureDoc2Author change.

---

## 5. Releasing: CI, provenance, and why v1.0.0 still needs a token

*The operational runbook — what to do for each release, and what to redo
when the token expires — lives in [PUBLISH.md](PUBLISH.md). This section is the
reasoning behind it.*

Two workflows:

```
.github/workflows/ci.yml
.github/workflows/release.yml
```

`ci.yml` runs on pushes and pull requests: unit tests, browser tests, a build,
and `npm pack --dry-run` so a broken manifest surfaces before a release rather
than during one. It also declares `workflow_call`, so the release runs that same
suite against the exact commit being published instead of trusting that CI
passed earlier.

`release.yml` fires on a `v*` tag and publishes `packages/ld-quiz` with
`--provenance`.

### The constraint: the first publish cannot use OIDC

Trusted publishing is the end state — GitHub mints a short-lived OIDC token, npm
accepts it, and no long-lived credential exists anywhere. It cannot do a
package's *first* release. A trusted publisher is configured per package on
npmjs.com, and `npm trust` states the prerequisite plainly: *"The package you're
configuring must already exist on the npm registry."* npm/cli#8544 tracks
lifting this; it is still open, and PyPI's ability to pre-configure is cited
there as the precedent npm lacks.

This does **not** cost v1.0.0 its provenance. Provenance and trusted publishing
are separate mechanisms: a token-authenticated publish from a GitHub-hosted
runner with `id-token: write` and `--provenance` produces exactly the same
signed attestation, recorded in the same public transparency log. Only the
authentication is interim.

**Stage one — v1.0.0, token plus provenance**

1. On npmjs.com create a **granular access token**: read-and-write, scoped to
   the `@lecturedoc2` scope, short expiry. Store it as the repository secret
   `NPM_TOKEN` under the LectureDoc2 org.
2. Create a repository environment named `npm-publish`. `release.yml` pins the
   publish job to it, which gives you one place to add a required reviewer, and
   it is also what npm's trusted publisher config will match in stage two.
3. Rehearse: run the workflow manually (`workflow_dispatch`) with **dry-run**
   left on. It resolves, tests, packs, and stops.
4. Tag and push:

   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```

   The workflow refuses if the tag and `packages/ld-quiz/package.json` disagree.

**Stage two — every release after that, OIDC**

5. Configure the trusted publisher, from a local checkout:

   ```bash
   npm trust github @lecturedoc2/quizzy \
       --file .github/workflows/release.yml \
       --env npm-publish
   ```

   (Or the same thing through *Settings -> Trusted publisher* on the package
   page.) Repository, workflow filename and environment must match what
   `release.yml` actually uses.
6. Delete the two lines in `release.yml` marked `BOOTSTRAP ONLY`, and revoke the
   `NPM_TOKEN`. From then on nothing long-lived exists to leak.

### Details worth knowing

- **npm, not pnpm, does the publishing.** OIDC token exchange is implemented in
  the npm CLI; pnpm installs the workspace but does not perform the exchange.
  The workflow also pins `npm@latest` — trusted publishing needs npm >= 11.5.1
  and provenance needs >= 9.5.0, and neither should depend on whatever the
  runner happened to ship.
- **`provenance` is a flag, not `publishConfig`.** Putting `"provenance": true`
  in the manifest reads better but makes every local `npm publish --dry-run`
  fail, because npm refuses to generate provenance outside a supported CI. The
  flag stays in the workflow.
- **`repository` must match, case-sensitively**, where the publish runs from. It
  now reads `git+https://github.com/LectureDoc2/quizzy.git`, which is why the
  org move had to land before any of this.
- **`packageManager: "pnpm@11.22.0"`** was added to the root manifest;
  `pnpm/action-setup@v4` reads the version from there rather than guessing.
- **`engines.node` on the package went `>=20` -> `>=24`.** It depends on
  `@lecturedoc2/libcrypto`, which requires `>=24`, so the old claim was untrue.
  Say if you would rather drop the field — for a browser component it only ever
  described the toolchain anyway.
- **Verify afterwards** with `npm audit signatures`, and look for the
  *Provenance* panel on the package page: it should name the workflow, the
  commit and the runner.

## 6. The rest of what you have to do

Git writes do not work through the Cowork bridge — it cannot unlink, so every
`git status` leaves a `.git/index.lock` behind and object writes fail halfway.
All the file changes are on disk and correct; none of them are committed. On
macOS the lock disappears on the first native git command (`rm .git/index.lock`
if one is in the way).

```bash
# 1. Quizzy26 -- drop in the two workflow files, review, commit
cd ~/Code/Quizzy26
rm -rf _to_delete                # stale dist trees + two 0-byte temp files
mkdir -p .github/workflows       # then save ci.yml and release.yml there
git status
git add -A && git commit -m "publish the client component as @lecturedoc2/quizzy"
git push                         # remote already repointed at LectureDoc2/quizzy

# 2. release -- see section 5 for the token and environment setup first
git tag v1.0.0 && git push origin v1.0.0

# 3. rebuild the quiz server's own bundle, so the hosted copy
#    carries the QR licence notice too
pnpm build

# 4. LectureDoc2 -- clean install now that the dependency resolves
cd ~/Teaching/Lectures-Myst
rm -rf LectureDoc2/_to_delete    # ld-crypto.js, the old .publish, stale dist
rm -rf node_modules              # I side-loaded tarballs and a linux esbuild
npm install                      # LectureDoc2's prepare hook builds dist/
git -C LectureDoc2 add -A && git -C LectureDoc2 commit -m "bundle the browser runtime; take libcrypto and quizzy from npm"
git add -A && git commit -m "load LectureDoc2 from dist/; publish it as package assets"

# 5. look at a real deck
./ld2 build
```

The one thing nobody has checked in a browser: the **toolbar icons and the help
dialog**. They are what §2's chunk-path fix was about, and the failure mode is
silence. Open any built deck and look at the bottom bar first.

`ld2 build` and `ld2 status` could not be run from here at all — both validate
`ld.config.json`'s `target` (`~/Sites/delors.github.io`), which is outside the
folders shared with this session.

## 7. Optional, later

- `LectureDoc2Author/src/crypto.js` reimplements libcrypto's wire format for the
  Node side and says so in its header. libcrypto runs in Node too, so it could
  collapse onto the package the way `ld-crypto.js` just did.
- The `{module}` directive could learn a generic option passthrough onto
  `<ld-module>` as `data-*`, which would let a deck write `:server-url:` instead
  of wrapping the quiz in a JSON envelope. See §4.
- LectureDoc2 itself now has a `files`-based `dist/`, so the same release
  workflow would work there once it is ready to go to npm.
