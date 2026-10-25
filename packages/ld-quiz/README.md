# @lecturedoc2/quizzy

The `<ld-quiz>` web component enables the embedding of real-time quizzes 
in any HTML authoring system. This package is the *client half*; it requires
a running [quizzy server](https://github.com/LectureDoc2/quizzy).

## Install

```bash
pnpm add @lecturedoc2/quizzy     # or npm / yarn
```

```js
import "@lecturedoc2/quizzy"; // registers <ld-quiz>
```

```html
<ld-quiz quiz='{"title":"Demo","questions":[]}'
         server-url="https://quiz.example.com"></ld-quiz>
```

The import has a side effect on purpose: the custom element registers itself.
To choose the tag name instead, import the registrar and call it:

```js
import { defineLdQuiz } from "@lecturedoc2/quizzy";
defineLdQuiz("my-quiz");
```

Registration is guarded. `customElements.define` throws on a name that is
already taken, and the throw aborts the module doing the defining — which would
take down a page that happens to load two copies of the component, e.g. a
LectureDoc2 deck bundling it, embedded in a Moodle course that loads the hosted
script. The second copy warns to the console and yields instead. Call
`defineLdQuiz("other-tag")` if both copies genuinely need to be live.

### This package ships source, not a bundle

The entry point is unminified ES module source with bare imports of
[`@lecturedoc2/libcrypto`](https://www.npmjs.com/package/@lecturedoc2/libcrypto)
and [`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator). Those
resolve under any bundler, and under nothing else — a browser cannot resolve a
bare specifier without an import map.

If the embedding page is produced by something that cannot build — a Moodle
course, a CMS, a hand-written HTML file — do not reach for this package. Use the
pre-bundled script the quiz server publishes:

```html
<script type="module"
        src="https://quiz.example.com/component/1.0.1/ld-quiz.js"></script>
```

Prefer this **versioned** URL. `/component/<version>/ld-quiz.js` is immutable: it
is served with a one-year `immutable` cache header and its bytes never change, so
it can be pinned with Subresource Integrity and will still mean the same thing next
term. `/component/ld-quiz.js` tracks whatever the server was last deployed with,
which is convenient for the pages served alongside it and a poor promise to make to
anyone else. `/component/version.json` reports the deployed version.

## Attributes

| Attribute | Meaning |
|---|---|
| `quiz` | the quiz itself: JSON, or the encrypted payload when `encrypted` is present. Omit it to get a file picker instead |
| `encrypted` | present ⇒ `quiz` is an AES-GCM/PBKDF2 payload; the presenter is prompted for the password. Requires `quiz` |
| `server-url` | origin of the quiz server; defaults to the embedding page's origin, so it is needed whenever the deck is served from elsewhere |
| `presenter-name` | prefills the presenter name; see below |

The three ways to supply the quiz:

- **Plain JSON** in `quiz`, as in the example above. The quiz title is shown with a
  *Start Quiz* button; no password is required.
- **Encrypted**: add `encrypted`, and the presenter is prompted for the password
  that decrypts it:

  ```html
  <ld-quiz encrypted quiz="MTAwMDAw:abc123...encrypted-data..."
           server-url="https://quiz.example.com"></ld-quiz>
  ```

- **No `quiz` attribute**: the presenter selects a `.json` file, and its title is
  shown with a *Start Quiz* button.

The quiz format and how to encrypt a quiz are described in the
[repository README](https://github.com/LectureDoc2/quizzy#quiz-json-format).

### `presenter-name`

The presenter name is an isolation key, not a secret: it is what separates two
lecturers running the same quiz file, and reproducing it exactly is what lets a
presenter reattach to their own running session after a crash or a reload.
Typing it slightly differently — `Michael` one week, `michael ` the next — is
therefore the failure this attribute exists to prevent. Since a slide set is
nearly always presented by the person who wrote it, the slide set is the right
place to state the name:

```html
<ld-quiz encrypted quiz="..." presenter-name="Michael Eichberg"></ld-quiz>
```

It only prefills the field; the presenter can still change it before starting.
The attribute takes precedence over the name remembered in `localStorage`,
because it is a deliberate statement about this deck whereas the remembered
value is whatever the last person at this lectern happened to type.

## Exports

| Specifier | Contents |
|---|---|
| `@lecturedoc2/quizzy` | `defineLdQuiz`, `QuizHost`, `PROTOCOL_VERSION`; registers `<ld-quiz>` on import |
| `@lecturedoc2/quizzy/protocol` | the wire contract — `PROTOCOL_VERSION`, `PROTOCOL_MISMATCH`, `isCompatibleProtocol`, `protocolMismatchMessage` |
| `@lecturedoc2/quizzy/styles` | the component's stylesheet, as a JS template string |

`PROTOCOL_VERSION` describes the wire format, not this package's version; see
[Protocol versioning](https://github.com/LectureDoc2/quizzy#protocol-versioning)
for what a server does with it.

## What the component asks of the host page

| Requirement | Why |
|---|---|
| a secure context (`https`, or `localhost`) | Web Crypto is used for hashing and decryption |
| `script-src` allowing the quiz host | the module may be loaded from there |
| `connect-src` allowing `wss://<quiz-host>` | the game runs over a WebSocket |
| `style-src` allowing the quiz host | the KaTeX and highlighting stylesheets are linked into the shadow root ([why linked](https://github.com/LectureDoc2/quizzy/blob/main/ARCHITECTURE.md#which-files-belong-to-which-part)) |
| `img-src data:` | the join QR code is drawn to a canvas |

Note what is **not** on that list: `style-src 'unsafe-inline'`. The component's
own styles are applied as a constructed stylesheet (`adoptedStyleSheets`) — a
JavaScript object rather than markup, and therefore outside the reach of
`style-src`. A host with a strict policy needs no concession for it. Browsers
without constructed stylesheets fall back to a `<style>` element, and there the
old requirement returns.

The stylesheet is authored as a plain JavaScript module rather than a `.css`
file, so consumers need no CSS import plugin, import attribute or asset
pipeline — and get no silent `undefined` when one is forgotten.

## Moodle

Nothing Moodle-specific is required: a filter or editor plugin that emits the
`<ld-quiz>` element and the hosted `<script type="module">` above is enough, plus
the CSP directives listed above. Results stay in the quiz session — there is no
LTI integration and no grade passback, and the server persists nothing.

## Third-party code

The QR code is generated by [`qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator),
the QR Code Generator for JavaScript by Kazuhiko Arase
(<http://www.d-project.com/>), used under the MIT license. It is a normal
dependency rather than a vendored copy, so it updates with `npm update` like
anything else. "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

Its MIT notice is restated as an `@license` block at the top of
`src/qr-canvas.js` (the module that draws the symbol onto a canvas). That is not
decoration: the package's own header is an ordinary line-comment block, which
esbuild strips, so without the first-party copy the attribution would be missing
from every bundle.

## License

BSD-3-Clause. See [LICENSE](./LICENSE).
