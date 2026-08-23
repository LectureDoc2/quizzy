# Changelog

`@lecturedoc2/quizzy` — the `<ld-quiz>` web component.

Versions here describe **the component's public surface**: the element, its
attributes, and the package's exports. They are deliberately not tied to the
quiz server's version, nor to `PROTOCOL_VERSION` in `src/protocol.js`; see
[PUBLISH.md](../../PUBLISH.md) for why the three numbers move independently.

## 1.0.1 — 2026-08-23

No change to the element, its attributes, or the wire protocol. A deck pinned to
1.0.0 keeps working against a current server, and `PROTOCOL_VERSION` is still 1.

### Fixed

- **The published README pointed at a URL the server no longer serves.** It
  described the pre-bundled script as `/client/<version>/ld-quiz.js`; the quiz
  server publishes it at `/component/<version>/ld-quiz.js`, and has no `/client/`
  route at all. Anyone following the instructions on npmjs.com got a 404. This is
  the reason this release exists — a README fix only reaches the registry through
  a publish.

### Changed

- **The QR code generator is a dependency instead of a vendored file.**
  `src/qrcode.js` (a copy of Kazuhiko Arase's QR Code Generator for JavaScript)
  is gone; the package now depends on
  [`qrcode-generator`](https://www.npmjs.com/package/qrcode-generator) and draws
  the symbol in a new module, `src/qr-canvas.js`. The rendered QR code is
  unchanged. This is a maintenance change, not a size one: the bundled component
  grows from roughly 63 kB to 76 kB (36 kB to 42 kB minified), because the
  published package ships renderers the trimmed local copy did not.

  Consumers gain one transitive dependency. Anyone who imported
  `@lecturedoc2/quizzy/src/qrcode.js` directly — which was never an exported
  path — has to stop.

- The MIT notice for that code is restated as a `/*! @license */` block at the
  top of `src/qr-canvas.js`. `qrcode-generator`'s own header is an ordinary
  line-comment block, which esbuild discards, so without a first-party copy the
  attribution would be missing from every bundle built from this package.

- A tag-name collision in `defineLdQuiz()` is now reported with `console.error`
  rather than `console.warn`. The condition means one of the two copies of the
  component silently will not run, which is an error rather than a caution.

### Removed

- A long-commented-out popup-blocker fallback in `openControlWindow()`. The
  control window has had an explicit button for some time.

## 1.0.0 — 2026-08-22

First release. The `<ld-quiz>` element, published from GitHub Actions with a
provenance attestation.
