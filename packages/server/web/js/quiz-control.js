import { PROTOCOL_VERSION } from "../../../ld-quiz/src/protocol.js";

/**
 * Create an element. `text` is always assigned via textContent, so callers
 * cannot inject markup by accident.
 *
 * @param {string} tag
 * @param {string|null} className
 * @param {string|number|null} text
 */
function el(tag, className = null, text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

/** Replace all children of `parent` with `nodes`. */
function replaceChildren(parent, ...nodes) {
  parent.replaceChildren(...nodes);
}

class QuizControl {
  constructor() {
    this.ws = null;
    this.presenterToken = null;
    this.roomId = null;
    this.state = "login"; // login, sessions, control
    this.roomState = null;
    this.currentQuestion = null;
    this.statistics = null;
    // Ids of participants whose connection dropped and who may still come
    // back. They keep their place on the leaderboard, marked as reconnecting.
    this.reconnectingIds = new Set();
  }

  async init() {
    const urlParams = new URLSearchParams(window.location.search);
    this.roomId = urlParams.get("room");
    const providedToken = urlParams.get("token");

    // Both are required: there is no session listing to fall back on, by
    // design -- this application has no administrator and no way to enumerate
    // rooms. Without a room id there is nothing this page can do.
    if (providedToken && this.roomId) {
      this.presenterToken = providedToken;
      this.connectControl();
    } else {
      this.renderLogin();
    }
  }

  /**
   * There is nothing useful this page can do without a room id and a token.
   *
   * The old password form hashed the password and offered it as a presenter
   * token, which could never match: tokens are derived from the presenter name
   * plus the quiz, not from a password. Rather than leave a login that cannot
   * succeed, say plainly where the control window comes from.
   */
  renderLogin() {
    const content = document.getElementById("content");
    const card = el("div", "card login__container");
    card.append(el("h2", null, "Open this window from your slides"));
    card.append(
      el(
        "p",
        null,
        "The control view is opened by the quiz on your slide deck, which passes " +
          "the session details along. Open it from there; if you closed this " +
          "window, use the same presenter name to reattach.",
      ),
    );
    replaceChildren(content, card);
  }

  connectControl() {
    const wsUrl = window.location.origin.replace(/^http/, "ws");
    this.ws = new WebSocket(`${wsUrl}/ws`);

    this.ws.onopen = () => {
      this.ws.send(
        JSON.stringify({
          type: "control_connect",
          protocolVersion: PROTOCOL_VERSION,
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
        this.roomState.reconnectingCount = msg.reconnectingCount || 0;
        this.currentQuestion = msg.question || null;
        this.state = "control";
        this.renderControl();
        // Which of the people on the board are away right now; the board
        // itself does not say, because participants receive it too.
        this.ws.send(JSON.stringify({ type: "get_participants" }));
        // Reopening the control view after the quiz finished should still
        // offer the export.
        if (msg.state === "ended") {
          this.ws.send(JSON.stringify({ type: "export_results" }));
        }
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
        // `detached` marks a dropped connection that may come back; a
        // participant_left without it (a kick) is final, and a
        // participant_joined -- first join or rejoin -- means present.
        if (msg.type === "participant_left" && msg.detached) {
          this.reconnectingIds.add(msg.participantId);
        } else {
          this.reconnectingIds.delete(msg.participantId);
        }
        this.roomState.participantCount = msg.count;
        if (typeof msg.reconnecting === "number") this.roomState.reconnectingCount = msg.reconnecting;
        this.updateParticipantCount();
        this.renderLeaderboard();
        break;

      case "participants_list":
        this.reconnectingIds = new Set(
          (msg.participants || []).filter((p) => p.connected === false).map((p) => p.id),
        );
        this.roomState.reconnectingCount = this.reconnectingIds.size;
        this.updateParticipantCount();
        this.renderLeaderboard();
        break;

      case "game_ended":
        this.roomState.state = "ended";
        this.roomState.leaderboard = msg.leaderboard;
        this.statistics = msg.statistics || this.statistics;
        this.updateControlUI();
        this.renderLeaderboard(msg.leaderboard);
        this.renderExportPanel();
        break;

      case "results_export":
        this.statistics = msg.statistics;
        this.renderExportPanel();
        break;

      case "error":
        this.showError(msg.message);
        break;
    }
  }

  renderControl() {
    const content = document.getElementById("content");
    // This template is a fixed skeleton: it interpolates nothing. Every dynamic
    // value is written afterwards via textContent, so no data -- neither the
    // lecturer's nor a participant's -- is ever parsed as markup here.
    content.innerHTML = `
      <div class="card control__container">
        <div class="control__header">
          <h2 id="quiz-title"></h2>
          <div class="room-info">
            <span id="room-label"></span>
            <span class="participant-count">Participants: <span id="participants"></span><span id="participants-reconnecting" class="participant-count__reconnecting"></span></span>
          </div>
        </div>

        <div class="control__panel">
          <div class="panel status-panel">
            <div class="status-item">
              <span class="status-label">State:</span>
              <span class="status-value" id="state"></span>
            </div>
            <div class="status-item">
              <span class="status-label">Question:</span>
              <span class="status-value" id="question"></span>
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
          <div class="question__options-container" id="question-options"></div>
        </div>

        <div class="panel export-panel" id="export-panel" style="display:none">
          <h3>Results summary</h3>
          <p class="export-hint" id="export-hint"></p>
          <div class="export-actions">
            <button class="btn btn--primary" id="btn-copy">Copy to clipboard</button>
            <button class="btn btn--secondary" id="btn-download">Download CSV</button>
          </div>
          <div id="export-status" class="export-status"></div>
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

    document.getElementById("quiz-title").textContent = this.roomState.quizTitle || "Quiz";
    document.getElementById("room-label").textContent = `Room: ${this.roomState.roomId}`;
    this.updateParticipantCount();

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
        this.ws.send(JSON.stringify({ type: "end_game" }));
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

  /**
   * "38 connected · 2 reconnecting". The first number is who is here now --
   * the people a question waits for; the second is who dropped and may still
   * come back with their score.
   */
  updateParticipantCount() {
    const connected = document.getElementById("participants");
    const reconnecting = document.getElementById("participants-reconnecting");
    const away = this.roomState.reconnectingCount || 0;
    if (connected) {
      connected.textContent = away > 0
        ? `${this.roomState.participantCount} connected`
        : this.roomState.participantCount;
    }
    if (reconnecting) reconnecting.textContent = away > 0 ? ` \u00b7 ${away} reconnecting` : "";
  }

  updateAnswerCount(count, total) {
    const el = document.getElementById("answers");
    if (el) el.textContent = `${count} / ${total}`;
  }

  renderCurrentQuestion() {
    const panel = document.getElementById("question-panel");
    const content = document.getElementById("question-text");
    const optionsEl = document.getElementById("question-options");
    if (!panel || !content || !optionsEl) return;

    if (!this.currentQuestion || !this.currentQuestion.text) {
      content.replaceChildren();
      optionsEl.replaceChildren();
      panel.style.display = "none";
      return;
    }

    // These two innerHTML assignments are the deliberate exceptions in this
    // view. Question text and options are authored by the lecturer and may
    // contain HTML, inline SVG and KaTeX output, so they cannot be escaped.
    // They are scrubbed server-side (see quiz-sanitizer.js) and never contain
    // participant input.
    content.innerHTML = this.currentQuestion.text;

    optionsEl.replaceChildren();
    const q = this.currentQuestion;

    if (q.type === "multiple-choice" && Array.isArray(q.options)) {
      // The presenter's copy of the question retains correctIndices, so the
      // correct options can be marked here -- this view is never sent to
      // participants.
      const correct = new Set(q.correctIndices || []);
      const list = el("ol", "question__options");
      q.options.forEach((option, index) => {
        const item = el("li", correct.has(index) ? "question__option question__option--correct" : "question__option");
        const marker = el("span", "question__option-marker", correct.has(index) ? "correct" : "");
        item.append(marker);
        const body = el("span", "question__option-text");
        body.innerHTML = option;
        item.append(body);
        list.append(item);
      });
      optionsEl.append(list);
    } else if (q.type === "estimation" && q.correctAnswer !== undefined) {
      optionsEl.append(el("div", "question__correct-answer", `Correct answer: ${q.correctAnswer}`));
    }

    panel.style.display = "block";
  }

  /**
   * Format a participant's answer for display.
   *
   * Answers originate from participants, who are untrusted. The server rejects
   * malformed answers (see Room.validateAnswer), but this view does not depend
   * on that: the result is plain text and is inserted via textContent.
   */
  formatAnswer(answer) {
    if (Array.isArray(answer)) {
      // Number() matters: with a string index, `index + 1` would concatenate
      // rather than add, carrying the participant's payload through unchanged.
      return answer
        .map((index) => (Number.isInteger(index) ? `Opt ${index + 1}` : "?"))
        .join(", ");
    }
    if (typeof answer === "number" && Number.isFinite(answer)) return String(answer);
    return "(invalid answer)";
  }

  renderResults(msg) {
    const panel = document.getElementById("results-panel");
    const content = document.getElementById("results-content");
    if (!panel || !content) return;

    const list = el("div", "answers-list");
    for (const a of msg.answers) {
      const item = el("div", "answer-item");
      item.append(el("span", "answer-name", a.name));
      item.append(el("span", "answer-value", this.formatAnswer(a.answer)));
      const points = Number(a.points) || 0;
      item.append(
        el(
          "span",
          `answer-points${points > 0 ? " answer-points--positive" : ""}`,
          `${points} pts`,
        ),
      );
      list.append(item);
    }

    replaceChildren(content, list);
    panel.style.display = "block";

    this.renderLeaderboard(msg.leaderboard);
  }

  renderLeaderboard(leaderboard) {
    const content = document.getElementById("leaderboard-content");
    if (!content) return;

    const list = leaderboard || this.roomState.leaderboard || [];
    if (list.length === 0) {
      replaceChildren(content, el("p", "empty", "No participants yet"));
      return;
    }

    const board = el("div", "leaderboard");
    list.forEach((entry, i) => {
      const away = this.reconnectingIds.has(entry.id);
      const item = el("div", away ? "leaderboard__item leaderboard__item--away" : "leaderboard__item");
      item.append(el("span", "leaderboard__rank", i + 1));
      const name = el("span", "leaderboard__name", entry.name);
      if (away) name.append(el("span", "leaderboard__away", "reconnecting"));
      item.append(name);
      item.append(el("span", "leaderboard__score", Number(entry.score) || 0));
      board.append(item);
    });

    replaceChildren(content, board);
  }

  /**
   * Show the export controls once the quiz has finished.
   *
   * The statistics arrive with `game_ended`, so they are already in hand when
   * the lecturer needs them -- reopening the control view later re-requests
   * them, but only for as long as the room lives on the server.
   */
  renderExportPanel() {
    const panel = document.getElementById("export-panel");
    const hint = document.getElementById("export-hint");
    if (!panel || !this.statistics) return;

    const answered = this.statistics.questions.length;
    hint.textContent =
      `${answered} of ${this.statistics.totalQuestions} question(s) played. ` +
      "The summary shows how each question was answered, so you can see which " +
      "topics need revisiting. It contains no participant names.";

    panel.style.display = "block";

    const status = document.getElementById("export-status");
    const btnCopy = document.getElementById("btn-copy");
    const btnDownload = document.getElementById("btn-download");

    btnCopy.onclick = async () => {
      const csv = this.buildCsv();
      try {
        await navigator.clipboard.writeText(csv);
        status.textContent = "Copied to clipboard.";
      } catch {
        // Clipboard access can be refused (permissions, insecure context).
        // Fall back to a selectable textarea rather than losing the data.
        status.textContent = "Clipboard unavailable - select and copy manually:";
        const area = document.createElement("textarea");
        area.className = "export-fallback";
        area.value = csv;
        area.rows = 12;
        area.readOnly = true;
        status.after(area);
        area.select();
      }
    };

    btnDownload.onclick = () => {
      const csv = this.buildCsv();
      const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `quiz-results-${this.statistics.roomId}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      status.textContent = `Downloaded quiz-results-${this.statistics.roomId}.csv`;
    };
  }

  /**
   * Reduce lecturer-authored HTML to readable plain text for the CSV.
   * Uses a detached element, so nothing is parsed into the live document.
   */
  static toPlainText(html) {
    const holder = document.createElement("div");
    holder.innerHTML = String(html == null ? "" : html);
    return holder.textContent.replace(/\s+/g, " ").trim();
  }

  /** Quote a CSV field per RFC 4180. */
  static csvField(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  static csvRow(fields) {
    return fields.map(QuizControl.csvField).join(",");
  }

  /**
   * Build the results summary.
   *
   * One row per answer option for multiple-choice questions and one row per
   * estimation question, so the whole thing opens as a flat table in a
   * spreadsheet and sorts by "percent correct" to surface the weak topics.
   */
  buildCsv() {
    const stats = this.statistics;
    const rows = [];

    rows.push(QuizControl.csvRow(["Quiz", stats.quizTitle]));
    rows.push(QuizControl.csvRow(["Room", stats.roomId]));
    rows.push(QuizControl.csvRow(["Questions played", `${stats.questions.length} of ${stats.totalQuestions}`]));
    rows.push("");

    rows.push(
      QuizControl.csvRow([
        "Question #", "Type", "Question", "Responses", "Option", "Correct option?",
        "Times chosen", "Share of responses", "Fully correct", "Percent correct",
      ]),
    );

    for (const q of stats.questions) {
      const number = q.questionIndex + 1;
      const text = QuizControl.toPlainText(q.text);
      const share = (n) => (q.responseCount ? `${((n / q.responseCount) * 100).toFixed(1)}%` : "");

      if (q.type === "multiple-choice") {
        const percentCorrect = q.responseCount
          ? `${((q.correctCount / q.responseCount) * 100).toFixed(1)}%`
          : "";
        (q.options || []).forEach((option, i) => {
          rows.push(
            QuizControl.csvRow([
              number,
              "multiple-choice",
              i === 0 ? text : "",
              i === 0 ? q.responseCount : "",
              `${i + 1}. ${QuizControl.toPlainText(option.text)}`,
              option.isCorrect ? "yes" : "no",
              option.count,
              share(option.count),
              i === 0 ? q.correctCount : "",
              i === 0 ? percentCorrect : "",
            ]),
          );
        });
      } else {
        const withinShare = q.withinTenPercent === null ? "" : share(q.withinTenPercent);
        rows.push(
          QuizControl.csvRow([
            number, "estimation", text, q.responseCount,
            `correct: ${q.correctAnswer}`, "", "", "",
            q.withinTenPercent === null ? "" : `${q.withinTenPercent} within 10%`,
            withinShare,
          ]),
        );
        rows.push(
          QuizControl.csvRow([
            "", "", "", "",
            `min ${q.min} / median ${q.median} / mean ${q.mean === null ? "" : q.mean.toFixed(2)} / max ${q.max}`,
            "", "", "", "", "",
          ]),
        );
      }
    }

    return rows.join("\r\n");
  }

  showError(message) {
    const content = document.getElementById("content");
    replaceChildren(content, el("div", "error", message));
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
