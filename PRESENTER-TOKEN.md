# Presenter Token Handling — Current State and Proposed Change

Working note for a piece of security work that is **designed but not implemented**:
moving the presenter token out of the control window's URL and into an HttpOnly
cookie.

Everything in "Already shipped" is in the code today. Everything in "Proposed
change" is a decision record, not a description of the repository.

---

## 1. What the token is, and why it matters

`presenterToken` is a **bearer credential**: whoever holds the string controls the
quiz — start, advance and end questions, kick participants, and steer the scoring.
There is no session, no origin binding, no expiry, and no "only one controller at a
time". The server's entire check is:

```js
if (room.presenterToken !== presenterToken) { /* rejected */ }
```

It is derived client-side in `ld-quiz.js`:

```js
presenterToken = SHA-256( normalize(presenterName) ‖ NUL ‖ JSON.stringify(quiz) )
```

Two consequences worth keeping in mind:

- **The quiz file is the secret.** Students receive the encrypted quiz inside the
  slide deck, so they hold the ciphertext and can attack the password offline. The
  `secret` field in the quiz JSON stops them reconstructing the plaintext from the
  questions they watched on screen; the *password strength* is what stops them
  decrypting it. Both must hold. (PBKDF2 is at 600 000 iterations.)
- **The presenter name is isolation, not confidentiality.** It stops two lecturers
  sharing a quiz file from sharing a session. The server only ever receives the
  hash, but it also holds the quiz, and names are low-entropy — so it could recover
  the name trivially if it wanted to. Do not treat that field as secret.

---

## 2. Already shipped

Relevant because it changes what the cookie still has to solve.

- **Injection closed.** Participant answers are validated server-side
  (`Room.validateAnswer`) and the control view builds its DOM with `textContent`.
  Previously an estimation answer of `<img src=x onerror=…>` executed in the control
  page and could read the token out of `location.search`.
- **CSP on `control.html`.** `script-src 'self'` blocks inline event handlers — the
  only route to execution through `innerHTML` — and `img-src`/`connect-src` block
  exfiltration by image, fetch and WebSocket. Verified in a real browser.
- **`Referrer-Policy: no-referrer`** and a matching `<meta name="referrer">`.
- **No room enumeration.** `/api/sessions` and the `sessions_list` message are gone;
  probing gets one opaque message and is rate limited per client (IPv6 bucketed by
  /64, see `client-address.js`).

**What remains:** the token still travels in the URL —

```js
// ld-quiz.js, openControlWindow()
`${serverUrl}/control.html?token=${presenterToken}&room=${roomId}`
```

so it sits in the address bar, in browser history, and — the exposure that actually
matters in a lecture hall — **on the projector**, any time the presenter's screen is
shared or the control window is opened in front of the room.

---

## 3. Proposed change

Take the token out of the URL and hold the session in a cookie:

```
Set-Cookie: control=<random>; HttpOnly; Secure; SameSite=Strict; Path=/
```

with **no `Max-Age` / `Expires`** — a session cookie.

`HttpOnly` is the substantive win, and it is a different property from "not visible
in the address bar": JavaScript cannot read the cookie at all, so a future injection
bug cannot exfiltrate the session even if it executes. Hiding the token from the
address bar is the secondary benefit.

### Flow

1. Presenter clicks "open control window" on the slide.
2. `window.open(serverUrl + '/control.html?room=…')` — **no token**. The room id is
   not secret; every participant has it.
3. The opener hands the token to the popup with `postMessage`, targeted at the quiz
   server's origin.
4. The popup POSTs the token to `/api/control-session` — **same-origin** — and the
   server replies with the `Set-Cookie`.

---

## 4. Constraints discovered (the non-obvious ones)

**The POST must come from the popup, not from the slide.** A LectureDoc deck
normally lives on a different origin from the quiz server (that is the whole point of
`server-url`). A `fetch` from the slide would therefore be cross-origin, and the
cookie it sets is a **third-party cookie** — Safari blocks those outright and Firefox
partitions them. The popup is a top-level document on the quiz server's origin, so
its cookie is first-party and `SameSite=Strict` is fine.

**A POST *navigation* is the wrong tool.** A form cannot send `application/json` at
all (only the three "simple" content types), and a document produced by a POST
triggers "Confirm Form Resubmission" on reload. Neither applies here: `control.html`
is fetched with GET and the POST is a separate `fetch` that never enters the
navigation history. **Reload therefore just works** — the cookie rides along
automatically. This is easier than the current URL scheme, not harder.

**HttpOnly forces authentication to move to the WebSocket handshake.** This is the
largest code consequence and is easy to miss. Today the page reads the token from
the URL and puts it in a message:

```js
ws.send(JSON.stringify({ type: 'control_connect', presenterToken, roomId }))
```

With an HttpOnly cookie the page *cannot read the token*, so it cannot send it. The
server must instead read the cookie from the WebSocket **upgrade request** and bind
the authenticated presenter to the socket at that point. `control_connect` then
carries only `roomId`.

**Check `Origin` on the WebSocket upgrade.** Cookies are sent with the WS handshake,
and `SameSite` is not a dependable CSRF control there.

**Content type.** Use `application/json` for the POST. `text/plain` and
`multipart/form-data` are the CORS "simple" types that skip preflight — the opposite
of what is wanted.

---

## 5. Cookie banner: not required

Checked against § 25 TDDDG (the renamed TTDSG) and current guidance.

An authentication cookie for someone who has just deliberately authenticated in
order to run their own quiz is **strictly necessary for a service the user expressly
requested** — § 25 Abs. 2 Nr. 2. WP29 Opinion 04/2012, still the reference for what
"strictly necessary" means, names session authentication cookies as exempt outright.
The EU Digital Omnibus (in trilogue as of mid-2026) would codify the same exemptions
under GDPR Art. 88a, so this does not depend on how that lands.

The exemption attaches to the **purpose**, so it holds only while all of these do:

| condition | why |
|---|---|
| Sole purpose is authenticating the presenter | Any analytics or correlation use voids the exemption for the whole cookie |
| Set **only** on the authentication act, never on a bare page load | Issuing a session id merely because someone loaded a page is specifically *not* strictly necessary |
| **Session cookie, not persistent** | WP29 draws the line here: a persistent login cookie ("remember me") requires opt-in consent |

The session-cookie constraint costs nothing here. A session cookie survives closing
the *popup* — which is the stated requirement ("I want to reopen the control view
after accidentally closing it") — and dies only with the browser. Browser-crash
recovery is already covered by a different path: reload the slide, re-enter the quiz
password, the component recomputes the hash, and the server re-authenticates.

No consent ≠ no transparency: Art. 13 GDPR still requires a sentence in the
Datenschutzerklärung (legal basis Art. 6(1)(b) or (f)).

> Out of scope here but noted: the **participant** side — student names, answers and
> scores, in a context where results may feed bonus points — is the materially harder
> data-protection question, and the one for the Datenschutzbeauftragte(r).

---

## 6. Open questions

- **Second device.** A cookie is per-browser. Controlling from a phone while the
  slide is on the projector would need a deliberate pairing mechanism — e.g. a
  short-lived code displayed in the *control window*. It must not be a QR code on the
  projector, which would hand the session to the room. Undecided; the server already
  supports several presenter sockets on one room.
- **Server-minted control secret.** Optionally, `create_room` could mint a random
  secret and the cookie could hold *that*, with `SHA-256(name ‖ quiz)` demoted to a
  recovery credential used only when the cookie is gone. This bounds the damage of a
  leak to one room's lifetime instead of every future session of that quiz. Judged
  the smallest of the available wins, and compatible with the reopen requirement —
  worth doing after the cookie, not instead of it.
- **Where the room id lives.** Assumed to stay in the URL, since participants have it
  anyway. Confirm before implementing.

---

## 7. Implementation surface

| file | change |
|---|---|
| `packages/server/src/server.js` | `POST /api/control-session`; cookie parsing; authenticate the WS **upgrade** from the cookie; `Origin` check on upgrade; `control_connect` no longer carries a token |
| `packages/server/web/js/quiz-control.js` | Receive the token by `postMessage`, POST it, drop `?token=` handling |
| `packages/ld-quiz/src/ld-quiz.js` | `openControlWindow()` opens without the token, then `postMessage`s it |
| `packages/server/test/server.test.js` | Cookie issuance; upgrade authentication; rejected `Origin`; no token accepted in `control_connect` |
| `packages/server/test/browser/*` | The token never appears in `location.search`; reload keeps the session |

Existing tests that assert `control.html?token=…` will need updating — they encode
the current scheme.

---

## 8. Starting the follow-up conversation

Open a new Cowork session with this repository connected and begin with something
like:

> Read `PRESENTER-TOKEN.md`. I want to implement section 3 (the HttpOnly cookie).
> Start with the open questions in section 6.

The relevant background is all in this file; the chat it came from is not needed.
