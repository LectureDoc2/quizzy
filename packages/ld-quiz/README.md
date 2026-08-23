# @lecturedoc2/quizzy

The `<ld-quiz>` web component: a real-time, embeddable quiz for HTML-based
presentation systems. It handles presenter authentication, quiz decryption,
participant management and the game flow; the scoring, the rooms and the
WebSocket live in the [quiz server](https://github.com/LectureDoc2/quizzy).

This package is the *client half*. It is useless on its own — every instance
talks to a running quiz server, which it discovers through `GET /api/config`.

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
take down a page that happens to load two copies of the component. The second
copy warns to the console and yields instead.

### This package ships source, not a bundle

The entry point is unminified ES module source with a bare import of
[`@lecturedoc2/libcrypto`](https://www.npmjs.com/package/@lecturedoc2/libcrypto).
That resolves under any bundler, and under nothing else — a browser cannot
resolve a bare specifier without an import map.

If the embedding page is produced by something that cannot build — a Moodle
course, a CMS, a hand-written HTML file — do not reach for this package. Use the
pre-bundled script the quiz server publishes:

```html
<script type="module"
        src="https://quiz.example.com/component/1.0.0/ld-quiz.js"></script>
```

`/component/<version>/ld-quiz.js` is immutable and may be pinned with Subresource
Integrity; `/component/ld-quiz.js` tracks whatever the server was last deployed
with. `/component/version.json` reports the deployed version.

## Attributes

| Attribute | Meaning |
|---|---|
| `quiz` | the quiz itself: JSON, or the encrypted payload when `encrypted` is present |
| `encrypted` | present ⇒ `quiz` is an AES-GCM/PBKDF2 payload; the presenter is prompted for the password |
| `server-url` | origin of the quiz server; defaults to the embedding page's origin |
| `presenter-name` | prefills the presenter name from the slide set, beating the value remembered in `localStorage` |

## Exports

| Specifier | Contents |
|---|---|
| `@lecturedoc2/quizzy` | `defineLdQuiz`, `QuizHost`, `PROTOCOL_VERSION`; registers `<ld-quiz>` on import |
| `@lecturedoc2/quizzy/protocol` | the wire contract — `PROTOCOL_VERSION`, `PROTOCOL_MISMATCH`, `isCompatibleProtocol`, `protocolMismatchMessage` |
| `@lecturedoc2/quizzy/styles` | the component's stylesheet, as a JS template string |

`PROTOCOL_VERSION` describes the wire format and is deliberately decoupled from
this package's version: a UI-only release must not invalidate every embedded
copy in the wild. A server rejects a handshake it cannot speak with a
`protocol_mismatch` error naming both versions, and a *missing* version is a
mismatch like any other.

## What the component asks of the host page

| Requirement | Why |
|---|---|
| a secure context (`https`, or `localhost`) | Web Crypto is used for hashing and decryption |
| `script-src` allowing the quiz host | the module may be loaded from there |
| `connect-src` allowing `wss://<quiz-host>` | the game runs over a WebSocket |
| `style-src` allowing the quiz host | the KaTeX stylesheet is linked into the shadow root |
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

KaTeX is linked rather than inlined: its `@font-face` rules use relative URLs,
so an inlined copy would resolve the fonts against the embedding page and
silently replace every formula with a fallback font — in precisely the
cross-origin setup this component exists for.

## Third-party code

`src/qrcode.js` is the QR Code Generator for JavaScript by Kazuhiko Arase
(<http://www.d-project.com/>), used under the MIT license; the notice is
preserved at the top of the file. "QR Code" is a registered trademark of DENSO
WAVE INCORPORATED.

## License

BSD-3-Clause. See [LICENSE](./LICENSE).
