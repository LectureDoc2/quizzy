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
  constructor() {
    super();
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
      this.showError("Quizzy requires a secure context (https or localhost/127.0.0.1).");
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
        this.presenterToken = await this.hashQuiz(this.quiz);
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
        <input type="password" class="quiz-input" id="password" placeholder="Enter your password" autocomplete="off">
        <button type="submit" class="quiz-btn quiz-btn-primary">Start Quiz</button>
      </form>
      <div id="error" class="quiz-error" style="display:none"></div>
    `;

    const form = this.shadowRoot.getElementById("login-form");
    const passwordInput = this.shadowRoot.getElementById("password");
    const errorEl = this.shadowRoot.getElementById("error");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = passwordInput.value;
      if (!password) return;

      errorEl.style.display = "none";
      passwordInput.disabled = true;
      form.querySelector("button").textContent = "Decrypting...";

      try {
        this.quiz = JSON.parse(await decryptAESGCMPBKDF(this.quiz, password));
        this.presenterToken = await this.hashQuiz(this.quiz);
        this.connectWebSocket();
      } catch (e) {
        console.error("decrypting quiz failed", e);
        errorEl.textContent = "Invalid password or corrupted quiz data";
        errorEl.style.display = "block";
        passwordInput.disabled = false;
        form.querySelector("button").textContent = "Start Quiz";
      }
    });
  }

  async hashQuiz(quiz) {
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(quiz));
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16)).join("");
  }

  renderQuizPreview() {
    this.currentState = "preview";
    this.contentEl.innerHTML = `
      <div class="quiz-preview">
        <h2 class="quiz-title">${this.escapeHtml(this.quiz.title || "Quiz")}</h2>
        <div class="quiz-meta">${this.quiz.questions.length} questions</div>
        <button class="quiz-btn quiz-btn-primary" id="btn-start">Start Quiz</button>
      </div>
    `;

    const btnStart = this.shadowRoot.getElementById("btn-start");
    btnStart.addEventListener("click", () => {
      this.connectWebSocket();
    });
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
        this.presenterToken = await this.hashQuiz(quiz);

        // Show preview
        previewContainer.style.display = "block";
        previewContainer.innerHTML = `
          <h3 class="quiz-title">${this.escapeHtml(quiz.title || "Quiz")}</h3>
          <div class="quiz-meta">${quiz.questions.length} questions</div>
          <button class="quiz-btn quiz-btn-primary" id="btn-start-upload">Start Quiz</button>
        `;

        const btnStart = this.shadowRoot.getElementById("btn-start-upload");
        btnStart.addEventListener("click", () => {
          this.connectWebSocket();
        });
      } catch (e) {
        console.error("failed processing JSON file", e);
        errorEl.textContent = "Invalid JSON file";
        errorEl.style.display = "block";
        previewContainer.style.display = "none";
      }
    });
  }

  connectWebSocket() {
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
          this.connectWebSocket();
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
