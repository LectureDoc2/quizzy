import { decryptAESGCMPBKDF } from "@lecturedoc2/libcrypto";
import QRCode from "./qrcode.min.js"; // TODO load from Quiz-Server!

const MAX_QUIZ_SIZE = 1024 * 1024; // 1MB

function randomToken() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// TODO add method origin and pass the origin to loadStyles and loadKatexCSS

async function loadStyles(serverUrl) {
  // Load CSS from the quiz server if specified, otherwise from the script's base URL
  const cssUrl = serverUrl
    ? new URL("/client/quiz-styles.css", serverUrl)
    : new URL("./quiz-styles.css", import.meta.url); // window.location.origin
  const response = await fetch(cssUrl);
  const css = await response.text();
  return css;
}

async function loadKatexCSS(serverUrl) {
  const cssUrl = serverUrl
    ? new URL("/katex/katex.min.css", serverUrl)
    : new URL("/katex/katex.min.css", window.location.origin);
  const response = await fetch(cssUrl);
  const css = await response.text();
  return css;
}

class QuizHost extends HTMLElement {
  /**
   * Minimum length of the presenter name. The name is what separates two
   * lecturers running the same quiz file, so it has to be long enough to be
   * deliberate -- but it is an isolation key, not a secret.
   */
  static MIN_PRESENTER_NAME_LENGTH = 4;

  constructor() {
    super();
    this.presenterName = null;
    this.presenterToken = null;
    this.attachShadow({ mode: "open" });
    this.quiz = null;
    this.isEncrypted = undefined;
    this.ws = null;
    this.roomId = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.currentState = "login";
    this.serverUrl = "";
  }

  async connectedCallback() {
    this.quiz = this.getAttribute("quiz");
    this.isEncrypted = this.hasAttribute("encrypted");
    this.serverUrl = this.getAttribute("server-url") || window.location.origin;

    const [css, katexCss] = await Promise.all([
      loadStyles(this.serverUrl),
      loadKatexCSS(this.serverUrl),
    ]);
    const template = document.createElement("template");
    template.innerHTML = `
      <style>${css}</style>
      <style>${katexCss}</style>
      <div class="quiz-container"><div id="content"></div></div>`;
    this.shadowRoot.appendChild(template.content);
    this.contentEl = this.shadowRoot.getElementById("content");

    if (!window.isSecureContext) {
      this.showError("Quizzy requires a secure context (https, or localhost / 127.0.0.1 / [::1]).");
      return;
    }

    if (this.isEncrypted) {
      // Encrypted inline quiz
      if (!this.quiz) {
        this.showError("No encrypted quiz provided.");
        return;
      }
      this.renderLogin();
    } else if (this.quiz) {
      // Unencrypted inline quiz
      try {
        this.quiz = JSON.parse(this.quiz);
        this.renderQuizPreview();
      } catch (e) {
        this.showError("Invalid quiz JSON");
        console.error("processing json failed", this.quiz, e);
      }
    } else {
      // Unencrypted file upload
      this.renderFileUpload();
    }
  }

  disconnectedCallback() {
    try {
      if (this.ws) {
        this.ws.close();
      }
    } catch (e) {
      console.error("closing websocket connection failed", e);
    }
  }

  renderLogin() {
    this.currentState = "login";
    this.contentEl.innerHTML = `
      <h2 class="quiz-title">Quiz Login</h2>
      <form class="quiz-form" id="login-form">
        <input type="text" class="quiz-input" id="presenter-name" placeholder="Your name (at least 4 characters)"
               autocomplete="off" autocapitalize="off" spellcheck="false" minlength="${QuizHost.MIN_PRESENTER_NAME_LENGTH}">
        <input type="password" class="quiz-input" id="password" placeholder="Enter your password" autocomplete="off">
        <button type="submit" class="quiz-btn quiz-btn-primary">Start Quiz</button>
      </form>
      <div class="quiz-info">Use the same name again to reattach to a running session.</div>
      <div id="error" class="quiz-error" style="display:none"></div>
    `;

    const form = this.shadowRoot.getElementById("login-form");
    const nameInput = this.shadowRoot.getElementById("presenter-name");
    const passwordInput = this.shadowRoot.getElementById("password");
    const errorEl = this.shadowRoot.getElementById("error");

    const savedName = QuizHost.loadPresenterName();
    if (savedName) nameInput.value = savedName;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = passwordInput.value;
      if (!password) return;

      const name = QuizHost.normalizePresenterName(nameInput.value);
      if (name.length < QuizHost.MIN_PRESENTER_NAME_LENGTH) {
        errorEl.textContent = `Please enter a name of at least ${QuizHost.MIN_PRESENTER_NAME_LENGTH} characters.`;
        errorEl.style.display = "block";
        return;
      }

      errorEl.style.display = "none";
      passwordInput.disabled = true;
      nameInput.disabled = true;
      form.querySelector("button").textContent = "Decrypting...";

      try {
        this.quiz = JSON.parse(await decryptAESGCMPBKDF(this.quiz, password));
        this.presenterName = name;
        QuizHost.savePresenterName(nameInput.value);
        await this.connectWebSocket();
      } catch (e) {
        console.error("decrypting quiz failed", e);
        errorEl.textContent = "Invalid password or corrupted quiz data";
        errorEl.style.display = "block";
        passwordInput.disabled = false;
        nameInput.disabled = false;
        form.querySelector("button").textContent = "Start Quiz";
      }
    });
  }

  /**
   * Normalize a presenter name so that trivial typing differences still resolve
   * to the same session. Without this, "Michael " and "michael" would derive
   * different tokens and the second one would silently fail to reattach.
   */
  static normalizePresenterName(name) {
    return String(name || "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  /**
   * Remember the presenter name -- and only the name, never the password or the
   * token -- so that reopening a session is one field shorter.
   *
   * localStorage, not sessionStorage: sessionStorage dies with the browser,
   * which is precisely the crash case this is meant to help with. The name is
   * not a secret (on its own it grants nothing: the token also requires the
   * decrypted quiz, and therefore the password), so persisting it costs nothing
   * in confidentiality and restores the one piece of state a crash destroys.
   *
   * On a shared lecture-hall machine this does leave the previous presenter's
   * name in the field; it is overwritten by simply typing another one.
   */
  static savePresenterName(name) {
    try {
      localStorage.setItem("ld-quiz-presenter-name", name);
    } catch {
      /* storage unavailable or disabled -- not worth failing over */
    }
  }

  static loadPresenterName() {
    try {
      return localStorage.getItem("ld-quiz-presenter-name") || "";
    } catch {
      return "";
    }
  }

  /**
   * Derive the presenter token from the presenter's name *and* the quiz.
   *
   * The name matters for isolation, not for secrecy. Deriving the token from
   * the quiz alone meant that two lecturers running the same quiz file shared
   * one token -- and therefore each other's sessions. Mixing in the name gives
   * colleagues who swap quiz files distinct tokens, while a lecturer who types
   * the same name again reproduces their own token and reattaches.
   *
   * The separator cannot occur in the normalized name, so ("ab", "c...") and
   * ("a", "bc...") cannot collide.
   *
   * The padStart is essential, not cosmetic: without it every byte below 0x10
   * contributes a single hex character, which both shortens the token and makes
   * the encoding ambiguous (distinct digests can map to the same string). It
   * also keeps this in step with the SHA-256 hex encoding used elsewhere
   * (rooms.js).
   */
  async hashQuiz(quiz, presenterName) {
    const encoder = new TextEncoder();
    const name = QuizHost.normalizePresenterName(presenterName);
    const data = encoder.encode(`${name}\u0000${JSON.stringify(quiz)}`);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  renderQuizPreview() {
    this.currentState = "preview";
    this.contentEl.innerHTML = `
      <div class="quiz-preview">
        <h2 class="quiz-title">${this.escapeHtml(this.quiz.title || "Quiz")}</h2>
        <div class="quiz-meta">${this.quiz.questions.length} questions</div>
        ${QuizHost.presenterNameFieldHtml()}
        <button class="quiz-btn quiz-btn-primary" id="btn-start">Start Quiz</button>
        <div id="name-error" class="quiz-error" style="display:none"></div>
      </div>
    `;

    this.bindPresenterNameField();
    const btnStart = this.shadowRoot.getElementById("btn-start");
    btnStart.addEventListener("click", () => this.startWithPresenterName());
  }

  /** The presenter-name input, shared by every entry path. */
  static presenterNameFieldHtml() {
    return `
      <input type="text" class="quiz-input" id="presenter-name"
             placeholder="Your name (at least ${QuizHost.MIN_PRESENTER_NAME_LENGTH} characters)"
             autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="quiz-info">Use the same name again to reattach to a running session.</div>`;
  }

  bindPresenterNameField() {
    const input = this.shadowRoot.getElementById("presenter-name");
    if (!input) return;
    const saved = QuizHost.loadPresenterName();
    if (saved) input.value = saved;
  }

  /**
   * Validate the presenter name and open the session. Shared by the preview and
   * upload paths; the encrypted path validates earlier because it must do so
   * before spending time on key derivation.
   */
  async startWithPresenterName() {
    const input = this.shadowRoot.getElementById("presenter-name");
    const errorEl = this.shadowRoot.getElementById("name-error");
    const name = QuizHost.normalizePresenterName(input ? input.value : "");

    if (name.length < QuizHost.MIN_PRESENTER_NAME_LENGTH) {
      if (errorEl) {
        errorEl.textContent = `Please enter a name of at least ${QuizHost.MIN_PRESENTER_NAME_LENGTH} characters.`;
        errorEl.style.display = "block";
      }
      return;
    }

    if (errorEl) errorEl.style.display = "none";
    this.presenterName = name;
    QuizHost.savePresenterName(input.value);
    await this.connectWebSocket();
  }

  renderFileUpload() {
    this.currentState = "upload";
    this.contentEl.innerHTML = `
      <div class="quiz-upload">
        <h2 class="quiz-title">Upload Quiz</h2>
        <p class="quiz-info">Select a JSON quiz file to upload</p>
        <label class="quiz-file-label">
          <input type="file" class="quiz-file-input" id="quiz-file" accept=".json">
          <span class="quiz-file-btn">Choose File</span>
        </label>
        <div id="quiz-file-name" class="quiz-file-name"></div>
        <div id="quiz-preview" class="quiz-preview-container" style="display:none"></div>
        <div id="error" class="quiz-error" style="display:none"></div>
      </div>
    `;

    const fileInput = this.shadowRoot.getElementById("quiz-file");
    const fileName = this.shadowRoot.getElementById("quiz-file-name");
    const previewContainer = this.shadowRoot.getElementById("quiz-preview");
    const errorEl = this.shadowRoot.getElementById("error");

    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      errorEl.style.display = "none";
      fileName.textContent = file.name;

      try {
        const text = await file.text();
        const quiz = JSON.parse(text);
        this.quiz = quiz;

        // Show preview
        previewContainer.style.display = "block";
        previewContainer.innerHTML = `
          <h3 class="quiz-title">${this.escapeHtml(quiz.title || "Quiz")}</h3>
          <div class="quiz-meta">${quiz.questions.length} questions</div>
          ${QuizHost.presenterNameFieldHtml()}
          <button class="quiz-btn quiz-btn-primary" id="btn-start-upload">Start Quiz</button>
          <div id="name-error" class="quiz-error" style="display:none"></div>
        `;

        this.bindPresenterNameField();
        const btnStart = this.shadowRoot.getElementById("btn-start-upload");
        btnStart.addEventListener("click", () => this.startWithPresenterName());
      } catch (e) {
        console.error("failed processing JSON file", e);
        errorEl.textContent = "Invalid JSON file";
        errorEl.style.display = "block";
        previewContainer.style.display = "none";
      }
    });
  }

  async connectWebSocket() {
    // Derived once, then reused across reconnects. Both inputs are stable for
    // the lifetime of the session, and reproducing the same token is precisely
    // what lets a reconnect reattach instead of opening a second room.
    if (!this.presenterToken) {
      this.presenterToken = await this.hashQuiz(this.quiz, this.presenterName);
    }

    const wsUrl = this.serverUrl.replace(/^http/, "ws");
    this.ws = new WebSocket(`${wsUrl}/ws`);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      const payload = JSON.stringify({
        type: "create_room",
        presenterToken: this.presenterToken,
        quiz: this.quiz,
      });
      const payloadSize = new TextEncoder().encode(payload).length;
      if (payloadSize > MAX_QUIZ_SIZE) {
        this.showError("Quiz data exceeds maximum size of 1MB");
        this.ws.close();
        return;
      }
      this.ws.send(payload);
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      this.handleMessage(msg);
    };

    this.ws.onclose = () => {
      if (
        this.currentState !== "ended" &&
        this.reconnectAttempts < this.maxReconnectAttempts
      ) {
        setTimeout(() => {
          this.reconnectAttempts++;
          // Reconnecting re-sends create_room, which the server treats as
          // create-or-resume, so this reattaches to the same room rather than
          // stranding everyone who already joined.
          this.connectWebSocket().catch((err) =>
            console.error("reconnect failed", err),
          );
        }, this.reconnectDelay * this.reconnectAttempts);
      }
    };

    this.ws.onerror = (err) => {
      console.error("WebSocket error:", err);
    };
  }

  handleMessage(msg) {
    switch (msg.type) {
      case "error":
        this.showError(msg.message || "An error occurred");
        break;

      case "room_created":
        this.roomId = msg.roomId;
        if (msg.resumed) {
          console.info(
            `Reattached to running session ${msg.roomId} ` +
              `(state: ${msg.state}, participants: ${msg.participantCount}).`,
          );
        }
        // The server scrubs quiz markup it considers unsafe. Say so loudly:
        // silently dropping part of a question would be worse than the markup.
        if (Array.isArray(msg.warnings) && msg.warnings.length > 0) {
          console.warn(
            `Quizzy removed markup from this quiz (${msg.warnings.length} item(s)):\n  ` +
              msg.warnings.join("\n  "),
          );
        }
        this.renderLobby();
        this.openControlWindow();
        break;

      case "participant_joined":
        this.updateParticipantCount(msg.count);
        break;

      case "participant_left":
        this.updateParticipantCount(msg.count);
        break;

    }
  }

  renderLobby() {
    this.currentState = "lobby";
    const joinUrl = `${this.serverUrl}/join.html?room=${this.roomId}`;

    this.contentEl.innerHTML = `
      <div class="quiz-lobby">
        <h2 class="quiz-title">${this.quiz.title || "Quiz"}</h2>
        <div class="quiz-participant-count">Participants: <span id="count">0</span></div>
        <div class="quiz-qr-container">
          <canvas id="qr-canvas"></canvas>
        </div>
        <div class="quiz-join-url">${joinUrl}</div>
        <div class="quiz-info">Room: ${this.roomId}</div>
        <div class="quiz-controls">
          <button class="quiz-btn quiz-btn-secondary" id="btn-control">Open Control Window</button>
        </div>
      </div>
    `;

    const canvas = this.shadowRoot.getElementById("qr-canvas");
    QRCode.toCanvas(canvas, joinUrl, {
      width: 256,
      margin: 4,
      errorCorrectionLevel: "Q",
      colorDark: "#1e293b",
      colorLight: "#ffffff",
    });

    const btnControl = this.shadowRoot.getElementById("btn-control");
    btnControl.addEventListener("click", () => this.openControlWindow());
  }

  updateParticipantCount(count) {
    const countElement = this.shadowRoot.getElementById("count");
    if (countElement) countElement.textContent = count;
  }

  openControlWindow() {
    const controlUrl = `${this.serverUrl}/control.html?token=${this.presenterToken}&room=${this.roomId}`;
    console.log(`opening control window`, controlUrl);
    const popup = window.open(
      controlUrl,
      "quiz-control",
      "width=900,height=700,scrollbars=yes",
    );
    /* We already have an explicit button to open the control window.
    if (!popup || popup.closed || typeof popup.closed === "undefined") {
      // Popup blocked - show fallback
      const existingBtn = this.shadowRoot.getElementById("btn-control");
      if (existingBtn) {
        const info = document.createElement("div");
        info.className = "quiz-info";
        info.innerHTML = `Control window blocked. <a href="${controlUrl}" target="_blank">Click here to open control window</a>`;
        existingBtn.parentElement.appendChild(info);
      }
    }
    */
  }

  showError(message) {
    this.contentEl.innerHTML = `<div class="quiz-error">${this.escapeHtml(message)}</div>`;
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

customElements.define("ld-quiz", QuizHost);
