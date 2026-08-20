
class QuizControl {
  constructor() {
    this.ws = null;
    this.presenterToken = null;
    this.roomId = null;
    this.state = "login"; // login, sessions, control
    this.roomState = null;
    this.currentQuestion = null;
  }

  async init() {
    const urlParams = new URLSearchParams(window.location.search);
    this.roomId = urlParams.get("room");
    const providedToken = urlParams.get("token");

    if (providedToken) {
      this.presenterToken = providedToken;
      this.connectControl();
    } else {
      this.renderLogin();
    }
  }

  renderLogin() {
    const content = document.getElementById("content");
    content.innerHTML = `
      <div class="card login__container">
        <h2>Presenter Login</h2>
        <form id="login-form">
          <input type="password" id="password" class="input" placeholder="Enter your password" required>
          <button type="submit" class="btn btn--primary btn--full">Login</button>
        </form>
        <div id="error" class="error" style="display:none"></div>
      </div>
    `;

    document.getElementById("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const password = document.getElementById("password").value;
      this.presenterToken = await this.hashPassword(password);
      this.connectControl();
    });
  }

  async hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  connectControl() {
    const wsUrl = window.location.origin.replace(/^http/, "ws");
    this.ws = new WebSocket(`${wsUrl}/ws`);

    this.ws.onopen = () => {
      this.ws.send(
        JSON.stringify({
          type: "control_connect",
          presenterToken: this.presenterToken,
          roomId: this.roomId,
        }),
      );
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      this.handleMessage(msg);
    };

    this.ws.onclose = () => {
      this.showError("Connection lost. Please refresh to reconnect.");
    };

    this.ws.onerror = () => {
      this.showError("Connection error");
    };
  }

  handleMessage(msg) {
    switch (msg.type) {
      case "control_connected":
        this.roomState = msg;
        this.currentQuestion = msg.question || null;
        this.state = "control";
        this.renderControl();
        break;

      case "sessions_list":
        this.state = "sessions";
        this.renderSessions(msg.sessions);
        break;

      case "game_started":
        this.roomState.state = "question";
        this.roomState.currentQuestionIndex = msg.questionIndex;
        this.currentQuestion = msg.question || null;
        this.updateControlUI();
        this.renderCurrentQuestion();
        break;

      case "question_started":
        this.roomState.state = "question";
        this.roomState.currentQuestionIndex = msg.questionIndex;
        this.currentQuestion = msg.question || null;
        this.updateControlUI();
        this.renderCurrentQuestion();
        break;

      case "question_results":
        this.roomState.state = "results";
        this.roomState.leaderboard = msg.leaderboard;
        this.updateControlUI();
        this.renderResults(msg);
        break;

      case "answer_count":
        this.updateAnswerCount(msg.count, msg.totalParticipants);
        break;

      case "participant_joined":
      case "participant_left":
        this.roomState.participantCount = msg.count;
        this.updateParticipantCount(msg.count);
        break;

      case "error":
        this.showError(msg.message);
        break;
    }
  }

  renderSessions(sessions) {
    const content = document.getElementById("content");
    if (sessions.length === 0) {
      content.innerHTML = `
        <div class="card login__container">
          <h2>No Active Sessions</h2>
          <p>No active quiz sessions found for this account.</p>
          <button class="btn btn--secondary" onclick="location.reload()">Refresh</button>
        </div>
      `;
      return;
    }

    const listHtml = sessions
      .map(
        (s) => `
      <div class="card session-card">
        <div class="session-info">
          <h3>${this.escapeHtml(s.title)}</h3>
          <p>Room: ${s.roomId} | Participants: ${s.participantCount}</p>
          <p>State: ${s.state} | Question: ${s.currentQuestionIndex + 1}/${s.totalQuestions}</p>
        </div>
        <button class="btn btn--primary" onclick="location.href='?token=${this.presenterToken}&room=${s.roomId}'">
          Control
        </button>
      </div>
    `,
      )
      .join("");

    content.innerHTML = `
      <div class="sessions-container">
        <h2>Your Sessions</h2>
        <div class="sessions-list">${listHtml}</div>
      </div>
    `;
  }

  renderControl() {
    const content = document.getElementById("content");
    content.innerHTML = `
      <div class="card control__container">
        <div class="control__header">
          <h2>${this.escapeHtml(this.roomState.quizTitle)}</h2>
          <div class="room-info">
            <span>Room: ${this.roomState.roomId}</span>
            <span class="participant-count">Participants: <span id="participants">${this.roomState.participantCount}</span></span>
          </div>
        </div>

        <div class="control__panel">
          <div class="panel status-panel">
            <div class="status-item">
              <span class="status-label">State:</span>
              <span class="status-value" id="state">${this.roomState.state}</span>
            </div>
            <div class="status-item">
              <span class="status-label">Question:</span>
              <span class="status-value" id="question">${this.roomState.currentQuestionIndex + 1} / ${this.roomState.totalQuestions}</span>
            </div>
            <div class="status-item" id="answer-count-panel" style="display:none">
              <span class="status-label">Answers:</span>
              <span class="status-value" id="answers">0 / 0</span>
            </div>
          </div>

          <div class="actions-panel">
            <div id="lobby-actions">
              <button class="btn btn--success" id="btn-start">Start Game</button>
            </div>
            <div id="question-actions" style="display:none">
              <button class="btn btn--danger" id="btn-end">End Question</button>
            </div>
            <div id="results-actions" style="display:none">
              <button class="btn btn--primary" id="btn-next">Next Question</button>
              <button class="btn btn--danger" id="btn-end-game">End Game</button>
            </div>
          </div>
        </div>

        <div class="card question-panel" id="question-panel" style="display:none">
          <h3>Current Question</h3>
          <div class="question__text" id="question-text"></div>
        </div>

        <div class="panel results-panel" id="results-panel" style="display:none">
          <h3>Results</h3>
          <div id="results-content"></div>
        </div>

        <div class="panel leaderboard-panel">
          <h3>Leaderboard</h3>
          <div id="leaderboard-content"></div>
        </div>
      </div>
    `;

    this.updateControlUI();
    this.renderLeaderboard();
    this.renderCurrentQuestion();

    // Event listeners
    const btnStart = document.getElementById("btn-start");
    if (btnStart) {
      btnStart.addEventListener("click", () => {
        this.ws.send(JSON.stringify({ type: "start_game" }));
      });
    }

    const btnEnd = document.getElementById("btn-end");
    if (btnEnd) {
      btnEnd.addEventListener("click", () => {
        this.ws.send(JSON.stringify({ type: "end_question" }));
      });
    }

    const btnNext = document.getElementById("btn-next");
    if (btnNext) {
      btnNext.addEventListener("click", () => {
        this.ws.send(JSON.stringify({ type: "next_question" }));
      });
    }

    const btnEndGame = document.getElementById("btn-end-game");
    if (btnEndGame) {
      btnEndGame.addEventListener("click", () => {
        this.ws.send(JSON.stringify({ type: "next_question" })); // Will end if no more questions
      });
    }
  }

  updateControlUI() {
    const state = this.roomState.state;

    const lobbyActions = document.getElementById("lobby-actions");
    const questionActions = document.getElementById("question-actions");
    const resultsActions = document.getElementById("results-actions");
    const stateEl = document.getElementById("state");
    const questionEl = document.getElementById("question");
    const answerCountPanel = document.getElementById("answer-count-panel");

    if (lobbyActions) lobbyActions.style.display = state === "lobby" ? "block" : "none";
    if (questionActions)
      questionActions.style.display = state === "question" ? "block" : "none";
    if (resultsActions)
      resultsActions.style.display = state === "results" ? "block" : "none";
    if (stateEl) stateEl.textContent = state;
    if (questionEl)
      questionEl.textContent = `${this.roomState.currentQuestionIndex + 1} / ${this.roomState.totalQuestions}`;
    if (answerCountPanel)
      answerCountPanel.style.display = state === "question" ? "flex" : "none";

    // Disable "Next Question" button on the last question
    const btnNext = document.getElementById("btn-next");
    if (btnNext) {
      const isLastQuestion =
        this.roomState.currentQuestionIndex + 1 >= this.roomState.totalQuestions;
      if (isLastQuestion) {
        btnNext.classList.add("btn--disabled");
        btnNext.disabled = true;
      } else {
        btnNext.classList.remove("btn--disabled");
        btnNext.disabled = false;
      }
    }
  }

  updateParticipantCount(count) {
    const el = document.getElementById("participants");
    if (el) el.textContent = count;
  }

  updateAnswerCount(count, total) {
    const el = document.getElementById("answers");
    if (el) el.textContent = `${count} / ${total}`;
  }

  renderCurrentQuestion() {
    const panel = document.getElementById("question-panel");
    const content = document.getElementById("question-text");
    if (!panel || !content) return;

    if (this.currentQuestion && this.currentQuestion.text) {
      content.innerHTML = this.currentQuestion.text;
      panel.style.display = "block";
    } else {
      content.innerHTML = "";
      panel.style.display = "none";
    }
  }

  renderResults(msg) {
    const panel = document.getElementById("results-panel");
    const content = document.getElementById("results-content");
    if (!panel || !content) return;

    const answersHtml = msg.answers
      .map(
        (a) => {
          const answerValue = Array.isArray(a.answer)
            ? a.answer.map(i => `Opt ${i + 1}`).join(", ")
            : a.answer;
          return `
      <div class="answer-item">
        <span class="answer-name">${this.escapeHtml(a.name)}</span>
        <span class="answer-value">${answerValue}</span>
        <span class="answer-points ${a.points > 0 ? "answer-points--positive" : ""}">${a.points} pts</span>
      </div>
    `;
        },
      )
      .join("");

    content.innerHTML = `
      <div class="answers-list">${answersHtml}</div>
    `;
    panel.style.display = "block";

    this.renderLeaderboard(msg.leaderboard);
  }

  renderLeaderboard(leaderboard) {
    const content = document.getElementById("leaderboard-content");
    if (!content) return;

    const list = leaderboard || this.roomState.leaderboard || [];
    if (list.length === 0) {
      content.innerHTML = '<p class="empty">No participants yet</p>';
      return;
    }

    const listHtml = list
      .map(
        (entry, i) => `
      <div class="leaderboard__item">
        <span class="leaderboard__rank">${i + 1}</span>
        <span class="leaderboard__name">${this.escapeHtml(entry.name)}</span>
        <span class="leaderboard__score">${entry.score}</span>
      </div>
    `,
      )
      .join("");

    content.innerHTML = `<div class="leaderboard">${listHtml}</div>`;
  }

  showError(message) {
    const content = document.getElementById("content");
    content.innerHTML = `<div class="error">${this.escapeHtml(message)}</div>`;
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    const control = new QuizControl();
    control.init();
  });
} else {
  const control = new QuizControl();
  control.init();
}
