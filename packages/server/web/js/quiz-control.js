import { PROTOCOL_VERSION } from "../../../ld-quiz/src/protocol.js";
import { groupAnswers } from "../../src/short-answer.js";

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

/**
 * Ask before doing something that cannot be undone, in a modal dialog.
 *
 * A native <dialog>: it traps the focus, dims the page, and closes on Escape
 * without any of that being written here. The focus starts on the button that
 * changes nothing, so that a stray Enter does not end a quiz. No <form
 * method="dialog">: the page's CSP says `form-action 'none'`.
 *
 * @param {{title: string, text: string, confirmLabel: string, cancelLabel: string}} options
 * @returns {Promise<boolean>} whether the presenter confirmed.
 */
function confirmDialog({ title, text, confirmLabel, cancelLabel }) {
  return new Promise((resolve) => {
    const dialog = el("dialog", "confirm-dialog");
    dialog.setAttribute("aria-labelledby", "confirm-dialog-title");
    const heading = el("h3", "confirm-dialog__title", title);
    heading.id = "confirm-dialog-title";
    const actions = el("div", "confirm-dialog__actions");
    const cancel = el("button", "btn btn--secondary", cancelLabel);
    cancel.type = "button";
    cancel.id = "confirm-dialog-cancel";
    const confirm = el("button", "btn btn--danger", confirmLabel);
    confirm.type = "button";
    confirm.id = "confirm-dialog-confirm";
    actions.append(cancel, confirm);
    dialog.append(heading, el("p", "confirm-dialog__text", text), actions);

    // Settled by the click itself rather than by the `close` event, which the
    // browser only delivers later: the page is back as it was by the time the
    // click handler returns. What is left for `close` is Escape, a "no".
    let settled = false;
    const settle = (confirmed) => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(confirmed);
    };
    cancel.addEventListener("click", () => settle(false));
    confirm.addEventListener("click", () => settle(true));
    dialog.addEventListener("close", () => settle(false));

    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

/** How long joins and leaves are collected before the list is asked for again. */
const PARTICIPANTS_REFRESH_MS = 300;

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
    // Everybody the server lists, as `participants_list` last said. Shown
    // only in a quiz that records all answers; see renderParticipants().
    this.participants = [];
    this.participantsRefresh = null;
    // Ids of those who are out of the quiz for good -- removed by the
    // presenter, or gone longer than they can reconnect -- but still listed in
    // a graded quiz. The last leaderboard the server sent may still name them.
    this.goneIds = new Set();
  }

  /** The quiz's options, as the server applies them. */
  get options() {
    return (this.roomState && this.roomState.options) || {};
  }

  /** A quiz that records name and every answer of every participant. */
  get graded() {
    return this.options.recordResults === "all";
  }

  /**
   * Ask for the list of participants again, soon. Only a graded quiz shows
   * the list; a hall joining at once asks once, not once per join.
   */
  refreshParticipants() {
    if (!this.graded || this.participantsRefresh) return;
    this.participantsRefresh = setTimeout(() => {
      this.participantsRefresh = null;
      // 1 is OPEN; a list asked for on a closed socket would throw in a timer.
      if (this.ws && this.ws.readyState === 1) {
        this.ws.send(JSON.stringify({ type: "get_participants" }));
      }
    }, PARTICIPANTS_REFRESH_MS);
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
        this.refreshParticipants(); // the scores have changed
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
        this.refreshParticipants();
        break;

      case "participants_list":
        this.participants = Array.isArray(msg.participants) ? msg.participants : [];
        // `left` is somebody who is gone for good and only still listed for
        // the record they left (a graded quiz); they are not coming back.
        this.reconnectingIds = new Set(
          this.participants.filter((p) => p.connected === false && !p.left).map((p) => p.id),
        );
        this.goneIds = new Set(this.participants.filter((p) => p.left).map((p) => p.id));
        this.roomState.reconnectingCount = this.reconnectingIds.size;
        this.updateParticipantCount();
        this.renderLeaderboard();
        this.renderParticipants();
        break;

      case "game_ended":
        this.roomState.state = "ended";
        this.roomState.leaderboard = msg.leaderboard;
        this.statistics = msg.statistics || this.statistics;
        this.updateControlUI();
        this.renderLeaderboard(msg.leaderboard);
        this.renderExportPanel();
        this.renderParticipants(); // nobody can be removed any more
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
        <ul class="quiz-options" id="quiz-options" hidden></ul>

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

        <div class="panel participants-panel" id="participants-panel" style="display:none">
          <h3>Participants</h3>
          <p class="participants-hint">
            This quiz records every participant's name and answers, and a name can be used only once.
            Removing a participant frees their name, for somebody who cannot get back in under it;
            what they answered so far stays in the results, marked as removed.
          </p>
          <div id="participants-content"></div>
        </div>
      </div>
    `;

    document.getElementById("quiz-title").textContent = this.roomState.quizTitle || "Quiz";
    document.getElementById("room-label").textContent = `Room: ${this.roomState.roomId}`;
    this.updateParticipantCount();

    this.updateControlUI();
    this.renderOptions();
    this.renderLeaderboard();
    this.renderParticipants();
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
      btnEndGame.addEventListener("click", () => this.endGame());
    }
  }

  /**
   * End the quiz -- after asking, if there are questions left.
   *
   * The button sits next to "Next Question", on every results screen, and
   * ending cannot be undone: the room stops taking joins and answers. After
   * the last question there is nothing to lose, and nothing is asked.
   */
  async endGame() {
    const { currentQuestionIndex, totalQuestions } = this.roomState;
    const next = currentQuestionIndex + 2; // 1-based number of the next question
    if (next <= totalQuestions) {
      const unplayed = next === totalQuestions
        ? `Question ${next} has not been played yet.`
        : `Questions ${next} to ${totalQuestions} have not been played yet.`;
      const confirmed = await confirmDialog({
        title: "End the quiz now?",
        text: `${unplayed} Ending the quiz cannot be undone.`,
        confirmLabel: "End quiz",
        cancelLabel: "Continue quiz",
      });
      if (!confirmed) return;
    }
    this.ws.send(JSON.stringify({ type: "end_game" }));
  }

  /**
   * Say which of the quiz's options are in effect, where the presenter sees it
   * before starting: these decide what participants are shown and what is
   * recorded about them, and a typo in the quiz file should not be discovered
   * on the students' phones. Nothing is shown for a quiz that sets none.
   */
  renderOptions() {
    const list = document.getElementById("quiz-options");
    if (!list) return;
    const { recordResults, leaderboard, showCorrectAnswers } = this.options;
    const lines = [];
    if (recordResults === "all") {
      lines.push("Graded: every participant's name and answers are recorded for the results file. Names are unique.");
    } else if (recordResults === "named") {
      lines.push("Participants can agree to have their name and final score in the results file.");
    }
    if (leaderboard === "none") {
      lines.push("Participants do not see the leaderboard, only their own score.");
    } else if (leaderboard === "rank-only") {
      lines.push("Participants do not see the leaderboard, only their own score and rank.");
    }
    if (showCorrectAnswers) {
      lines.push("Participants are shown the correct answer after each question.");
    }
    replaceChildren(list, ...lines.map((line) => el("li", "quiz-options__item", line)));
    list.hidden = lines.length === 0;
  }

  /**
   * The participants of a graded quiz, with a way to remove one.
   *
   * Only there, because only there a name stays taken: somebody whose phone
   * died cannot join again under their name until their old entry is removed.
   * That is also why this lists people who are long gone (`left`) -- the
   * leaderboard above drops them once they can no longer reconnect.
   */
  renderParticipants() {
    const panel = document.getElementById("participants-panel");
    const content = document.getElementById("participants-content");
    if (!panel || !content) return;
    if (!this.graded) {
      panel.style.display = "none";
      return;
    }
    panel.style.display = "block";

    if (this.participants.length === 0) {
      replaceChildren(content, el("p", "empty", "No participants yet"));
      return;
    }

    const ended = this.roomState.state === "ended";
    const sorted = [...this.participants].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const list = el("ul", "participants-list");
    for (const participant of sorted) {
      const state = participant.removed ? "removed"
        : participant.left ? "left"
        : participant.connected === false ? "reconnecting"
        : "connected";
      const item = el("li", `participants-list__item participants-list__item--${state}`);
      item.append(el("span", "participants-list__name", participant.name));
      item.append(el("span", "participants-list__state", state));
      item.append(el("span", "participants-list__score", Number(participant.score) || 0));
      if (!participant.removed && !ended) {
        const remove = el("button", "btn btn--secondary participants-list__remove", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => this.removeParticipant(participant));
        item.append(remove);
      }
      list.append(item);
    }
    replaceChildren(content, list);
  }

  async removeParticipant(participant) {
    const confirmed = await confirmDialog({
      title: `Remove ${participant.name}?`,
      text: "They are disconnected, and the name becomes free for somebody to join under again. " +
        "The answers recorded so far stay in the results file, marked as removed.",
      confirmLabel: "Remove",
      cancelLabel: "Keep",
    });
    if (!confirmed) return;
    this.ws.send(JSON.stringify({ type: "kick_participant", participantId: participant.id }));
    // The server answers with participant_left only if somebody was still
    // there to leave; ask for the list either way.
    this.refreshParticipants();
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

    // The last results stay on screen during the next question, but they can
    // only be re-scored while they are the current ones.
    if (state !== "results") {
      for (const button of document.querySelectorAll(".answer-group__toggle")) button.remove();
    }

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
    } else if (q.type === "ordering" && Array.isArray(q.options)) {
      // The author lists the items in the correct order; participants see
      // them shuffled (see Room.getPublicQuestion()).
      optionsEl.append(el("div", "question__correct-answer", "Correct order:"));
      const list = el("ol", "question__options");
      for (const option of q.options) {
        const item = el("li", "question__option question__option--correct");
        const body = el("span", "question__option-text");
        body.innerHTML = option;
        item.append(body);
        list.append(item);
      }
      optionsEl.append(list);
    } else if (q.type === "estimation" && q.correctAnswer !== undefined) {
      optionsEl.append(el("div", "question__correct-answer", `Correct answer: ${q.correctAnswer}`));
    } else if (q.type === "short-answer" && Array.isArray(q.acceptedAnswers)) {
      // As written in the quiz, [optional parts] included: plain text, not
      // markup, so textContent like everything else.
      optionsEl.append(
        el("div", "question__correct-answer", `Accepted: ${q.acceptedAnswers.map(String).join(" · ")}`),
      );
    }

    panel.style.display = "block";
  }

  /**
   * Format a participant's answer for display.
   *
   * Answers originate from participants, who are untrusted. The server rejects
   * malformed answers (see Room.validateAnswer), but this view does not depend
   * on that: the result is plain text and is inserted via textContent.
   *
   * @param {unknown} answer
   * @param {object} [question] the question answered; an ordering answer is
   *   shown as its items, in the participant's order
   */
  formatAnswer(answer, question) {
    if (Array.isArray(answer) && question?.type === "ordering" && Array.isArray(question.options)) {
      return answer
        .map((index) =>
          Number.isInteger(index) && index >= 0 && index < question.options.length
            ? QuizControl.toPlainText(question.options[index])
            : "?",
        )
        .join(" → ");
    }
    if (Array.isArray(answer)) {
      // Number() matters: with a string index, `index + 1` would concatenate
      // rather than add, carrying the participant's payload through unchanged.
      return answer
        .map((index) => (Number.isInteger(index) ? `Opt ${index + 1}` : "?"))
        .join(", ");
    }
    if (typeof answer === "number" && Number.isFinite(answer)) return String(answer);
    if (typeof answer === "string") return answer; // a short answer
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
      item.append(el("span", "answer-value", this.formatAnswer(a.answer, this.currentQuestion)));
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

    if (this.currentQuestion?.type === "short-answer") {
      replaceChildren(content, this.renderAnswerGroups(msg), list);
    } else {
      replaceChildren(content, list);
    }
    panel.style.display = "block";

    this.renderLeaderboard(msg.leaderboard);
  }

  /**
   * The answers to a short-answer question, grouped by spelling as the server
   * compares them, most frequent first: "12× Overloading", "5× Overriding".
   * This is where the common misconceptions show. Participant text, so
   * textContent only.
   *
   * While the results are up, a wrong group can be accepted as right after
   * all, and an acceptance taken back. The list changes only once the server
   * has re-scored and sent the results again, so it never shows a verdict the
   * participants did not get.
   */
  renderAnswerGroups(msg) {
    const { groups } = groupAnswers(
      msg.answers.map((a) => ({
        answer: a.answer,
        correct: Number(a.points) > 0,
        acceptedByPresenter: a.acceptedByPresenter === true,
      })),
      { match: msg.match },
    );
    const list = el("ol", "answer-groups");
    for (const group of groups) {
      const item = el("li", group.isCorrect ? "answer-group answer-group--correct" : "answer-group");
      item.append(el("span", "answer-group__count", `${group.count}×`));
      item.append(el("span", "answer-group__text", group.text));
      if (group.acceptedByPresenter) {
        item.append(el("span", "answer-group__note", "accepted by you"));
        item.append(this.acceptButton(msg.questionIndex, group.text, false));
      } else if (!group.isCorrect) {
        item.append(this.acceptButton(msg.questionIndex, group.text, true));
      }
      list.append(item);
    }
    return list;
  }

  /**
   * Accept a group of short answers as right, or take that back. The spelling
   * stands for its whole group: the server re-scores every answer in the same
   * normalized form. Removed once the quiz moves on; see updateControlUI().
   */
  acceptButton(questionIndex, answer, accepted) {
    const button = el("button", "btn btn--secondary answer-group__toggle", accepted ? "Accept" : "Undo");
    button.type = "button";
    button.title = accepted
      ? "Count this answer as correct for everybody who gave it"
      : "Count this answer as wrong again";
    // One per group, so the label says which; an attribute, never markup.
    button.setAttribute("aria-label", accepted ? `Accept "${answer}"` : `Undo accepting "${answer}"`);
    button.addEventListener("click", () => {
      button.disabled = true;
      this.ws.send(JSON.stringify({ type: "accept_answer", questionIndex, answer, accepted }));
    });
    return button;
  }

  renderLeaderboard(leaderboard) {
    const content = document.getElementById("leaderboard-content");
    if (!content) return;

    // Without those who have just been removed: the server leaves them off the
    // next leaderboard, and until then this one would still show them.
    const list = (leaderboard || this.roomState.leaderboard || []).filter((entry) => !this.goneIds.has(entry.id));
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
    const named = this.statistics.recordsNamedResults && Array.isArray(this.statistics.namedResults)
      ? this.statistics.namedResults.length
      : null;
    const individual = Array.isArray(this.statistics.individualResults)
      ? this.statistics.individualResults
      : null;
    const dropped = Number(this.statistics.droppedIndividualResults) || 0;
    hint.textContent =
      `${answered} of ${this.statistics.totalQuestions} question(s) played. ` +
      "The summary shows how each question was answered, so you can see which " +
      "topics need revisiting. " +
      (individual !== null
        ? `It also lists every participant by name (${individual.length} row(s)), with every answer they gave ` +
          "and the points it scored, for grading. Download it now: the server stores nothing " +
          "permanently and discards these results shortly after this window is closed." +
          (dropped > 0
            ? ` Warning: the records of ${dropped} participant(s) who had left were dropped, ` +
              "because the room held more records than it keeps."
            : "")
        : named === null
          ? "It contains no participant names."
          : `It also lists the names and final scores of the ${named} participant(s) ` +
            "who agreed to this; everyone else is left out, and no individual answers are included.");

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

  /**
   * When the quiz was played, in the lecturer's own time zone: YYYY-MM-DD and
   * HH:MM, which a spreadsheet reads as a date and a time whatever its locale.
   */
  static localDate(epochMs) {
    const d = new Date(epochMs);
    if (!Number.isFinite(d.getTime())) return "";
    const two = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  }

  static localTime(epochMs) {
    const d = new Date(epochMs);
    if (!Number.isFinite(d.getTime())) return "";
    const two = (n) => String(n).padStart(2, "0");
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
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
   * Text a participant typed, as a cell of its own. A spreadsheet reads a
   * cell that starts with = + - or @ as a formula, so such a cell gets the
   * apostrophe that tells it not to; the answer is what follows it.
   */
  static csvText(value) {
    const text = String(value);
    return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  }

  /**
   * One participant's answer to one question, for a cell of the individual
   * results. Options and items by the numbers the summary above gives them:
   * "1 | 3" is the first and third option, "2 > 1 > 3" the order the items
   * were put in (the correct one is 1 > 2 > 3). Empty when not answered.
   *
   * @param {string} type The question's type.
   * @param {unknown} answer As the server recorded it; see
   *   Room.getIndividualResults().
   */
  static recordedAnswer(type, answer) {
    if (answer === undefined || answer === null) return "";
    if (type === "multiple-choice") {
      if (!Array.isArray(answer)) return "";
      return answer.length === 0 ? "(nothing selected)" : answer.map((i) => i + 1).join(" | ");
    }
    if (type === "ordering") {
      return Array.isArray(answer) ? answer.map((i) => i + 1).join(" > ") : "";
    }
    if (type === "estimation") return typeof answer === "number" ? answer : "";
    return QuizControl.csvText(answer);
  }

  /**
   * Build the results summary.
   *
   * One row per answer option for multiple-choice questions, one per distinct
   * answer to a short-answer question, one per item of an ordering question,
   * and one per estimation question, so
   * the whole thing opens as a flat table in a
   * spreadsheet and sorts by "percent correct" to surface the weak topics.
   */
  buildCsv() {
    const stats = this.statistics;
    const rows = [];

    rows.push(QuizControl.csvRow(["Quiz", stats.quizTitle]));
    rows.push(QuizControl.csvRow(["Room", stats.roomId]));
    // The name the session was started under -- typically the course.
    rows.push(QuizControl.csvRow(["Session", QuizControl.csvText(stats.sessionName || "")]));
    rows.push(QuizControl.csvRow(["Date", QuizControl.localDate(stats.playedAt)]));
    rows.push(QuizControl.csvRow(["Time", QuizControl.localTime(stats.playedAt)]));
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
      } else if (q.type === "short-answer") {
        const percentCorrect = q.responseCount
          ? `${((q.correctCount / q.responseCount) * 100).toFixed(1)}%`
          : "";
        rows.push(
          QuizControl.csvRow([
            number, "short-answer", text, q.responseCount,
            `accepted: ${(q.acceptedAnswers || []).join(" | ")}`, "", "", "",
            q.correctCount, percentCorrect,
          ]),
        );
        // One row per distinct answer, numbered like the options of a
        // multiple-choice question. The number in front is also what keeps a
        // participant's "=HYPERLINK(...)" from being read as a formula. The
        // answers accepted in class are marked: they belong in the quiz's
        // acceptedAnswers next time.
        (q.answers || []).forEach((answer, i) => {
          rows.push(
            QuizControl.csvRow([
              "", "", "", "",
              `${i + 1}. ${answer.text}`,
              answer.acceptedByPresenter ? "yes (accepted by presenter)" : answer.isCorrect ? "yes" : "no",
              answer.count,
              share(answer.count),
              "", "",
            ]),
          );
        });
        if (q.otherAnswerCount) {
          rows.push(
            QuizControl.csvRow([
              "", "", "", "", "(other answers)", "", q.otherAnswerCount, share(q.otherAnswerCount), "", "",
            ]),
          );
        }
      } else if (q.type === "ordering") {
        const percentCorrect = q.responseCount
          ? `${((q.correctCount / q.responseCount) * 100).toFixed(1)}%`
          : "";
        // One row per item, in the correct order, with how many answers put
        // it in its place ("Times chosen"): the item misplaced most is the
        // misconception.
        (q.items || []).forEach((item, i) => {
          rows.push(
            QuizControl.csvRow([
              number,
              "ordering",
              i === 0 ? text : "",
              i === 0 ? q.responseCount : "",
              `${i + 1}. ${QuizControl.toPlainText(item.text)}`,
              `position ${i + 1}`,
              item.placedCorrectly,
              share(item.placedCorrectly),
              i === 0 ? q.correctCount : "",
              i === 0 ? percentCorrect : "",
            ]),
          );
        });
      } else if (q.type === "estimation") {
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

    // Only in a quiz that asked for consent, and only the participants who
    // gave it: name and final score, nothing per question. The server sends
    // this list only once the game has ended. Names cannot start a formula --
    // the server accepts only letters, spaces, hyphens and apostrophes, and
    // the first character must be a letter (name-validator.js).
    if (stats.recordsNamedResults && Array.isArray(stats.namedResults)) {
      rows.push("");
      rows.push(QuizControl.csvRow(["Final results (participants who agreed to be named)"]));
      if (stats.namedResults.length === 0) {
        rows.push(QuizControl.csvRow(["No participant agreed to be named."]));
      } else {
        rows.push(QuizControl.csvRow(["Name", "Final score"]));
        for (const entry of stats.namedResults) {
          rows.push(QuizControl.csvRow([entry.name, Number(entry.score) || 0]));
        }
      }
    }

    // Only in a quiz that records all answers (recordResults: "all"), and only
    // once it has ended: everybody by name, with each answer and its points.
    // One row per participant, two columns per played question.
    if (Array.isArray(stats.individualResults)) {
      rows.push("");
      rows.push(QuizControl.csvRow(["Individual results (every participant, recorded for grading)"]));
      const dropped = Number(stats.droppedIndividualResults) || 0;
      if (dropped > 0) {
        rows.push(QuizControl.csvRow([
          `Warning: the records of ${dropped} participant(s) who had left were dropped.`,
        ]));
      }
      if (stats.individualResults.length === 0) {
        rows.push(QuizControl.csvRow(["Nobody took part."]));
      } else {
        const header = ["Name", "Status", "Final score"];
        for (const q of stats.questions) {
          header.push(`Q${q.questionIndex + 1} answer`, `Q${q.questionIndex + 1} points`);
        }
        rows.push(QuizControl.csvRow(header));
        for (const entry of stats.individualResults) {
          const answers = new Map((entry.answers || []).map((a) => [a.questionIndex, a]));
          const row = [
            entry.name,
            entry.removed ? "removed by lecturer" : "",
            Number(entry.score) || 0,
          ];
          for (const q of stats.questions) {
            const given = answers.get(q.questionIndex);
            row.push(
              given ? QuizControl.recordedAnswer(q.type, given.answer) : "",
              given ? Number(given.points) || 0 : 0,
            );
          }
          rows.push(QuizControl.csvRow(row));
        }
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
