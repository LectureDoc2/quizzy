import { PROTOCOL_VERSION, PROTOCOL_MISMATCH } from '../../../ld-quiz/src/protocol.js';

/**
 * Close code the server uses when another connection has taken over this
 * participant with the same resume token (a duplicated tab, say). Final: two
 * tabs that both reconnected on it would take the identity from each other
 * forever. Mirrors SUPERSEDED_CLOSE_CODE in src/server.js.
 */
const SUPERSEDED_CLOSE_CODE = 4000;

/**
 * Reconnect backoff: 1 s, 2 s, 4 s, ... capped at 30 s, each with +-50 %
 * jitter. The jitter is not decoration. A hall-wide wifi blip drops every phone
 * at the same instant, and without it they would all come back at the same
 * instant too -- from one egress address, while the server still counts their
 * old, half-open sockets against that address.
 */
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Where the resume token is kept across a reload. sessionStorage, not
 * localStorage or a cookie: it is per tab, never leaves the page unless this
 * code sends it, and is gone when the tab closes -- which is what keeps it
 * within "strictly necessary for the service the user asked for" (see
 * PARTICIPANT-REATTACH.md). Keyed by room, written only once the student has
 * pressed Join, and removed when the quiz ends or the token is refused.
 */
const STORAGE_PREFIX = 'quizzy:resume:';

/** States after which the page never reconnects. */
const FINAL_STATES = new Set(['ended', 'kicked', 'superseded', 'fatal']);

class QuizClient {
  constructor() {
    this.ws = null;
    this.roomId = null;
    this.participantId = null;
    this.quizTitle = null;
    this.state = 'join'; // join, joined, question, results, ended, kicked, superseded, fatal
    // The credential that lets this participant come back after a drop. Held
    // in memory for the life of the page, which already survives the common
    // case -- the socket dies, the page does not -- and mirrored to
    // sessionStorage for a reload.
    this.resumeToken = null;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    // Index of the last question this page showed, or null before the page
    // has seen the room (a fresh load). Together with answerSubmitted, it is
    // how a rejoin works out what happened while the page was away.
    this.questionIndex = null;
    this.answerSubmitted = false;
    this.rejoinContext = null;
  }

  // Client-side validation (must match server-side)
  static NAME_PATTERN = /^[\p{L}][\p{L}'\- ]{0,48}[\p{L}]$/u;
  static NAME_MIN_LENGTH = 2;
  static NAME_MAX_LENGTH = 50;

  static validateName(name) {
    if (!name || typeof name !== 'string') {
      return { valid: false, error: 'Name is required' };
    }

    const trimmed = name.trim();

    if (trimmed.length < QuizClient.NAME_MIN_LENGTH) {
      return { valid: false, error: `Name must be at least ${QuizClient.NAME_MIN_LENGTH} characters` };
    }

    if (trimmed.length > QuizClient.NAME_MAX_LENGTH) {
      return { valid: false, error: `Name must be at most ${QuizClient.NAME_MAX_LENGTH} characters` };
    }

    if (!QuizClient.NAME_PATTERN.test(trimmed)) {
      return { valid: false, error: 'Name must contain only letters, spaces, hyphens, and apostrophes' };
    }

    return { valid: true, name: trimmed };
  }

  init() {
    const urlParams = new URLSearchParams(window.location.search);
    this.roomId = urlParams.get('room');

    if (!this.roomId) {
      this.showError('No room ID provided');
      return;
    }

    document.getElementById('room-id').textContent = this.roomId;
    // A reload, a restored tab or a re-opened link in the same tab: try to
    // carry on as the participant this tab already was.
    this.resumeToken = this.loadResumeToken();
    this.renderConnecting(this.resumeToken ? 'Reconnecting to the quiz...' : 'Checking the quiz...');
    // One socket for the whole visit: the room's state is fetched over it
    // before the name is asked for, and the join then reuses it.
    this.connect();
  }

  /**
   * Set the page heading and the browser tab title together.
   *
   * The heading is outside #content, so none of the render* methods touch it;
   * it therefore has to be updated explicitly at each state change. Missing
   * that is what left "Join Quiz" above a question the student was answering.
   */
  setHeading(text) {
    const heading = document.getElementById('page-title');
    if (heading) heading.textContent = text;
    document.title = text;
  }

  renderConnecting(message = 'Checking the quiz...') {
    const content = document.getElementById('content');
    content.innerHTML = `
      <div class="waiting">
        <div class="spinner"></div>
        <p></p>
      </div>
    `;
    content.querySelector('p').textContent = message;
  }

  connect() {
    const wsUrl = window.location.origin.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      if (this.resumeToken) {
        ws.send(JSON.stringify({
          type: 'rejoin_room',
          protocolVersion: PROTOCOL_VERSION,
          roomId: this.roomId,
          resumeToken: this.resumeToken
        }));
      } else {
        ws.send(JSON.stringify({
          type: 'room_status',
          protocolVersion: PROTOCOL_VERSION,
          roomId: this.roomId
        }));
      }
    };

    // Events from a socket this page has already given up on are ignored, so
    // a late close from the old connection cannot tear down the new one.
    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      this.handleMessage(JSON.parse(event.data));
    };

    ws.onclose = (event) => {
      if (ws !== this.ws) return;
      this.handleClose(event);
    };

    // `error` is always followed by `close`, and the close handler decides what
    // happens next. Rendering an error here would wipe the very screen a
    // reconnect is about to restore.
    ws.onerror = () => {};
  }

  /**
   * The socket is gone. Reconnect if this page holds a participant's resume
   * token; otherwise there is nobody to come back as.
   */
  handleClose(event) {
    if (FINAL_STATES.has(this.state)) return;

    if (event.code === SUPERSEDED_CLOSE_CODE) {
      this.state = 'superseded';
      // The identity has moved to the other connection. Forgetting it here
      // means reloading this tab offers a fresh join instead of taking the
      // identity back.
      this.clearResumeToken();
      this.setReconnecting(false);
      this.showError('This quiz was continued in another tab or window.');
      return;
    }

    if (!this.resumeToken) {
      this.setReconnecting(false);
      this.showError('Connection lost. Please refresh the page.');
      return;
    }

    this.scheduleReconnect();
  }

  scheduleReconnect() {
    this.setReconnecting(true);
    clearTimeout(this.reconnectTimer);
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * 2 ** this.reconnectAttempt);
    const delay = base * (0.5 + Math.random());
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * Show or hide the "reconnecting" state. The last screen stays visible but
   * dimmed and inert underneath: re-rendering it would invite an answer that
   * cannot be sent, and blanking it would lose the student's place.
   */
  setReconnecting(on) {
    this.reconnecting = on;
    const banner = document.getElementById('connection-banner');
    if (banner) banner.hidden = !on;
    const content = document.getElementById('content');
    if (content) {
      content.classList.toggle('content--stale', on);
      content.inert = on;
    }
  }

  /** A short message above the content that outlives the next render. */
  showNotice(message) {
    const notice = document.getElementById('notice');
    if (!notice) return;
    notice.textContent = message || '';
    notice.hidden = !message;
  }

  storageKey() {
    return STORAGE_PREFIX + this.roomId;
  }

  // Every storage access is guarded: sessionStorage can be missing or throw
  // (blocked site data, some private modes), and the page must then simply
  // work without surviving a reload.
  loadResumeToken() {
    try {
      const token = window.sessionStorage.getItem(this.storageKey());
      return typeof token === 'string' && token.length > 0 && token.length <= 128 ? token : null;
    } catch {
      return null;
    }
  }

  saveResumeToken() {
    if (!this.resumeToken) return;
    try {
      window.sessionStorage.setItem(this.storageKey(), this.resumeToken);
    } catch { /* no storage: reconnecting still works, reloading does not */ }
  }

  clearResumeToken() {
    this.resumeToken = null;
    try {
      window.sessionStorage.removeItem(this.storageKey());
    } catch { /* nothing to remove */ }
  }

  /**
   * Render the join form, adapted to what the room is currently doing.
   *
   * The page used to offer a bare "Join Quiz" whatever the state, so a student
   * arriving late had no idea the quiz was already running -- nor how much of
   * it they had missed.
   *
   * @param {object|null} status The room_status payload, or null in the lobby.
   */
  renderJoinForm(status = null) {
    this.state = 'join';
    if (status && status.quizTitle) this.quizTitle = status.quizTitle;
    const content = document.getElementById('content');
    const inProgress = status && status.state !== 'lobby';
    const missed = inProgress ? Math.max(0, status.currentQuestionIndex) : 0;

    content.innerHTML = `
      <div id="room-state" class="room-state"></div>
      <form id="join-form">
        <input type="text" id="name" class="input" placeholder="Enter your name" maxlength="50" required>
        <button type="submit" class="btn btn--primary btn--full" id="join-btn"></button>
        <div id="name-error" class="error-text" style="display:none;margin-top:0.5rem;color:var(--error-color)"></div>
      </form>
      <p class="join-privacy" id="join-privacy">
        So that you can carry on with your score if your connection drops, this
        tab keeps a random session key. Nothing else is stored, and the key is
        deleted when the quiz ends or the tab is closed.
      </p>
    `;

    // Built with textContent: the quiz title is written by the lecturer and is
    // not put through the HTML sanitizer, so it must not be parsed as markup.
    const stateEl = document.getElementById('room-state');
    if (status && status.quizTitle) {
      const title = document.createElement('div');
      title.className = 'room-state__title';
      title.textContent = status.quizTitle;
      stateEl.append(title);
    }

    this.setHeading(inProgress ? 'Quiz in progress' : 'Join Quiz');

    const detail = document.createElement('div');
    detail.className = inProgress ? 'room-state__detail room-state__detail--live' : 'room-state__detail';
    if (inProgress) {
      detail.textContent =
        `Question ${Math.min(status.currentQuestionIndex + 1, status.totalQuestions)} of ${status.totalQuestions}` +
        (missed > 0
          ? ` — you have missed ${missed} question${missed === 1 ? '' : 's'} and cannot score on those.`
          : '.');
    } else {
      detail.textContent = 'Waiting for the quiz to start.';
    }
    if (status) stateEl.append(detail);

    document.getElementById('join-btn').textContent = inProgress ? 'Join now' : 'Join Quiz';

    document.getElementById('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('name');
      const name = nameInput.value.trim();
      const errorEl = document.getElementById('name-error');

      const validation = QuizClient.validateName(name);
      if (!validation.valid) {
        errorEl.textContent = validation.error;
        errorEl.style.display = 'block';
        return;
      }

      errorEl.style.display = 'none';
      this.join(validation.name);
    });
  }

  join(name) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showError('Connection lost. Please refresh the page.');
      return;
    }
    this.ws.send(JSON.stringify({
      type: 'join_room',
      protocolVersion: PROTOCOL_VERSION,
      roomId: this.roomId,
      name: name
    }));
  }

  /**
   * After a rejoin, say which questions closed while this page was away and
   * scored nothing for this participant -- rather than silently jumping ahead.
   *
   * Only meaningful when the page has seen the room before the drop; after a
   * reload there is no "before" to compare with, and nothing is said.
   *
   * @param {number} currentIndex The question the room is on now.
   * @param {boolean} currentOpen Whether that question is still taking answers.
   */
  noteMissedQuestions(currentIndex, currentOpen) {
    const context = this.rejoinContext;
    this.rejoinContext = null;
    if (!context || context.previousIndex === null) return;

    // The question open at the drop counts as missed only if it has since
    // closed without an answer from us; the server's answer history decides,
    // since an answer sent into a dying socket may never have arrived.
    const from = context.previousOpen ? context.previousIndex : context.previousIndex + 1;
    const to = currentOpen ? currentIndex - 1 : currentIndex;
    const missed = [];
    for (let i = Math.max(0, from); i <= to; i++) {
      if (!context.answered.has(i)) missed.push(i + 1);
    }
    if (missed.length === 0) return;

    const list = missed.length === 1
      ? `Question ${missed[0]}`
      : `Questions ${missed.slice(0, -1).join(', ')} and ${missed[missed.length - 1]}`;
    this.showNotice(
      `${list} closed while you were reconnecting, so ` +
      `${missed.length === 1 ? 'it scores' : 'they score'} nothing for you.`
    );
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        this.participantId = msg.participantId;
        this.resumeToken = typeof msg.resumeToken === 'string' ? msg.resumeToken : null;
        // Written now -- after the student typed a name and pressed Join --
        // and never on a bare page load.
        this.saveResumeToken();
        this.state = 'joined';
        this.questionIndex = -1;
        this.answerSubmitted = false;
        if (msg.quizTitle) this.quizTitle = msg.quizTitle;
        // Past the join screen the heading has no business still reading
        // "Join Quiz" -- from here on it names the quiz being played.
        this.setHeading(this.quizTitle || 'Quiz');
        this.showNotice(null);
        this.renderWaiting();
        break;

      case 'rejoined':
        clearTimeout(this.reconnectTimer);
        this.reconnectAttempt = 0;
        this.setReconnecting(false);
        this.participantId = msg.participantId;
        if (msg.quizTitle) this.quizTitle = msg.quizTitle;
        this.setHeading(this.quizTitle || 'Quiz');
        this.rejoinContext = {
          previousIndex: this.questionIndex,
          previousOpen: this.state === 'question',
          answered: new Set(Array.isArray(msg.answeredQuestions) ? msg.answeredQuestions : [])
        };
        if (msg.state === 'lobby') {
          this.rejoinContext = null;
          this.state = 'joined';
          this.questionIndex = -1;
          this.renderWaiting();
        }
        // Otherwise the server follows up with the question, results or final
        // board, and those handlers take it from here.
        break;

      case 'rejoin_failed':
        // The token is dead -- expired, kicked, or the room is gone. Forget it
        // at once, so this page never sits retrying a credential that cannot
        // work, and offer a fresh join on the same socket.
        clearTimeout(this.reconnectTimer);
        this.reconnectAttempt = 0;
        this.clearResumeToken();
        this.participantId = null;
        this.questionIndex = null;
        this.answerSubmitted = false;
        this.rejoinContext = null;
        this.setReconnecting(false);
        this.state = 'join';
        this.showNotice(msg.message || 'Your previous session has expired. Please join again.');
        this.renderConnecting();
        this.ws.send(JSON.stringify({
          type: 'room_status',
          protocolVersion: PROTOCOL_VERSION,
          roomId: this.roomId
        }));
        break;

      case 'question': {
        if (this.rejoinContext) {
          this.showNotice(null);
          this.noteMissedQuestions(msg.questionIndex, true);
        } else if (msg.questionIndex !== this.questionIndex) {
          this.showNotice(null);
        }
        const sameQuestion = this.state === 'question' && this.questionIndex === msg.questionIndex;
        const answerWasLost = sameQuestion && this.answerSubmitted && !msg.alreadyAnswered;
        this.state = 'question';
        this.questionIndex = msg.questionIndex;

        if (msg.alreadyAnswered) {
          // Answered, dropped, came back: the server would refuse a second
          // answer, so the question must not be offered again.
          this.answerSubmitted = true;
          this.renderWaiting('Answer submitted! Waiting for results...');
          break;
        }
        if (sameQuestion && !this.answerSubmitted && document.getElementById('question-text')) {
          // Back on the question that was on screen when the connection
          // dropped: keep it, and whatever the student had already selected.
          break;
        }
        if (answerWasLost) {
          this.showNotice('Your answer did not reach the server before the connection dropped. Please answer again.');
        }
        this.answerSubmitted = false;
        this.renderQuestion(msg.question, msg.questionIndex, msg.totalQuestions, msg.startTime);
        break;
      }

      case 'results':
        if (this.rejoinContext) {
          this.showNotice(null);
          this.noteMissedQuestions(msg.questionIndex, false);
        }
        this.state = 'results';
        this.questionIndex = msg.questionIndex;
        this.renderResults(msg.leaderboard, msg.questionIndex, msg.waiting, msg.feedback);
        break;

      case 'game_ended':
        this.state = 'ended';
        this.rejoinContext = null;
        // Nothing left to come back to.
        this.clearResumeToken();
        this.renderFinalResults(msg.leaderboard);
        break;

      case 'answer_accepted':
        // Ignore if results are already shown (e.g., question auto-ended)
        if (this.state !== 'results' && this.state !== 'ended') {
          this.renderWaiting('Answer submitted! Waiting for results...');
        }
        break;

      case 'kicked':
        this.state = 'kicked';
        this.clearResumeToken();
        this.setReconnecting(false);
        this.showError('You have been removed from the quiz');
        break;

      case 'room_status':
        this.renderJoinForm(msg);
        break;

      case 'error':
        // A version mismatch cannot be fixed by trying again.
        if (msg.code === PROTOCOL_MISMATCH) {
          this.state = 'fatal';
          clearTimeout(this.reconnectTimer);
          this.setReconnecting(false);
          this.showError(msg.message);
          break;
        }
        // While coming back -- "Too many connections" as a whole hall
        // reconnects, say -- the server closes the socket next, and the close
        // schedules the next attempt. The screen underneath stays as it is.
        if (this.reconnecting || (this.resumeToken && !this.participantId)) {
          break;
        }
        // Before joining, an error belongs next to the form -- the student can
        // fix a mistyped name and try again without reloading.
        if (this.state === 'join') {
          const errorEl = document.getElementById('name-error');
          if (errorEl) {
            errorEl.textContent = msg.message;
            errorEl.style.display = 'block';
            break;
          }
        }
        this.showError(msg.message);
        break;
    }
  }

  renderWaiting(message = 'Waiting for the quiz to start...') {
    const content = document.getElementById('content');
    content.innerHTML = `
      <div class="waiting">
        <div class="spinner"></div>
        <p>${message}</p>
      </div>
    `;
  }

  renderQuestion(question, index, total, startTime) {
    const content = document.getElementById('content');
    const timeLimit = question.timeLimit || 0;
    let timerHtml = '';

    if (timeLimit > 0) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const remaining = Math.max(0, timeLimit - elapsed);
      timerHtml = `<div class="timer ${remaining <= 5 ? 'timer--urgent' : ''}" id="timer">${remaining}</div>`;
    }

    let inputHtml = '';
    if (question.type === 'multiple-choice') {
      inputHtml = `
        <div class="options" id="options">
          ${question.options.map((opt, i) => `
            <div class="option" data-index="${i}">${opt}</div>
          `).join('')}
        </div>
        <button class="btn btn--primary btn--full" id="submit-btn" style="margin-top:1rem">Submit</button>
      `;
    } else if (question.type === 'estimation') {
      inputHtml = `
        <form id="answer-form">
          <input type="number" id="answer" class="input" placeholder="Your estimate" step="any" required>
          <button type="submit" class="btn btn--primary btn--full">Submit</button>
        </form>
      `;
    }

    content.innerHTML = `
      <div class="question">
        <div class="question__counter">Question ${index + 1} of ${total}</div>
        ${timerHtml}
        <div class="question__text" id="question-text">${question.text}</div>
        ${inputHtml}
      </div>
    `;

    if (timeLimit > 0) {
      const timerEl = document.getElementById('timer');
      const interval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const remaining = Math.max(0, timeLimit - elapsed);
        if (timerEl) {
          timerEl.textContent = remaining;
          if (remaining <= 5)           timerEl.classList.add('timer--urgent');
        }
        if (remaining <= 0) {
          clearInterval(interval);
        }
      }, 1000);
    }

    if (question.type === 'multiple-choice') {
      const selected = new Set();
      const optionsEl = document.getElementById('options');
      const submitBtn = document.getElementById('submit-btn');
      optionsEl.querySelectorAll('.option').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index);
          if (selected.has(idx)) {
            selected.delete(idx);
            btn.classList.remove('option--selected');
          } else {
            selected.add(idx);
            btn.classList.add('option--selected');
          }
        });
      });
      submitBtn.addEventListener('click', () => {
        const answer = Array.from(selected).sort((a, b) => a - b);
        this.submitAnswer(answer);
      });
    } else if (question.type === 'estimation') {
      document.getElementById('answer-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const answer = parseFloat(document.getElementById('answer').value);
        if (isNaN(answer)) return;
        this.submitAnswer(answer);
      });
    }
  }

  renderResults(leaderboard, questionIndex, waiting, feedback) {
    const content = document.getElementById('content');
    const myEntry = leaderboard.find(e => e.id === this.participantId);
    const myRank = myEntry ? leaderboard.indexOf(myEntry) + 1 : '-';

    const listHtml = leaderboard.slice(0, 5).map((entry, i) => `
      <div class="leaderboard__item ${entry.id === this.participantId ? 'leaderboard__item--highlight' : ''}">
        <span class="leaderboard__rank">${i + 1}</span>
        <span class="leaderboard__name">${this.escapeHtml(entry.name)}</span>
        <span class="leaderboard__score">${entry.score}</span>
      </div>
    `).join('');

    content.innerHTML = `
      <div class="results">
        <div class="question__counter">Results - Question ${questionIndex + 1}</div>
        ${this.renderFeedback(feedback)}
        <div class="my-stats">Your rank: ${myRank} | Score: ${myEntry ? myEntry.score : 0}</div>
        <div class="leaderboard">${listHtml}</div>
        <p class="waiting-text">${waiting ? 'Waiting for next question...' : 'Quiz complete!'}</p>
      </div>
    `;
  }

  /**
   * The closed question again, with how this participant's answer fared.
   * The server sends only a verdict, never the correct answer -- revealing it
   * is the presenter's call. Question text and options are server-rendered
   * HTML (math, code), the same markup renderQuestion() shows; everything else
   * is escaped or numeric.
   */
  renderFeedback(feedback) {
    if (!feedback || !feedback.question) return '';
    const question = feedback.question;
    let detailHtml = '';
    let verdict = 'You did not answer this question.';
    let verdictClass = 'feedback__verdict--none';

    if (question.type === 'multiple-choice') {
      const chosen = new Set(Array.isArray(feedback.answer) ? feedback.answer : []);
      detailHtml = `
        <div class="options feedback__options">
          ${(question.options || []).map((opt, i) => `
            <div class="option feedback__option ${chosen.has(i) ? 'option--selected' : ''}">${opt}</div>
          `).join('')}
        </div>
      `;
      if (feedback.answered) {
        verdict = feedback.isCorrect ? 'Correct!' : 'Not quite.';
        verdictClass = feedback.isCorrect ? 'feedback__verdict--correct' : 'feedback__verdict--wrong';
      }
    } else if (question.type === 'estimation') {
      if (feedback.answered) {
        const answer = Number(feedback.answer);
        detailHtml = `
          <div class="feedback__estimate">Your answer: <strong>${
            Number.isFinite(answer) ? answer.toLocaleString() : '-'
          }</strong></div>
        `;
        const rank = Number(feedback.rank);
        const count = Number(feedback.answerCount);
        if (Number.isInteger(rank) && rank > 0 && Number.isInteger(count)) {
          if (count === 1) verdict = 'Yours was the only estimate.';
          else if (rank === 1) verdict = `Closest of all ${count} estimates!`;
          else verdict = `#${rank} closest of ${count} estimates`;
          // The top three score (see Room.scoreQuestion()).
          verdictClass = rank <= 3 ? 'feedback__verdict--correct' : 'feedback__verdict--wrong';
        } else {
          verdict = 'Your answer was recorded.';
        }
      }
    }

    return `
      <div class="feedback">
        <div class="question__text feedback__question">${question.text}</div>
        ${detailHtml}
        <div class="feedback__verdict ${verdictClass}">${this.escapeHtml(verdict)}</div>
      </div>
    `;
  }

  renderFinalResults(leaderboard) {
    const content = document.getElementById('content');
    const myEntry = leaderboard.find(e => e.id === this.participantId);
    const myRank = myEntry ? leaderboard.indexOf(myEntry) + 1 : '-';

    const listHtml = leaderboard.slice(0, 10).map((entry, i) => `
      <div class="leaderboard__item ${entry.id === this.participantId ? 'leaderboard__item--highlight' : ''}">
        <span class="leaderboard__rank">${i + 1}</span>
        <span class="leaderboard__name">${this.escapeHtml(entry.name)}</span>
        <span class="leaderboard__score">${entry.score}</span>
      </div>
    `).join('');

    content.innerHTML = `
      <div class="results">
        <h2>Final Results</h2>
        <div class="my-stats">Your rank: ${myRank} | Score: ${myEntry ? myEntry.score : 0}</div>
        <div class="leaderboard">${listHtml}</div>
        <p class="waiting-text">Thank you for participating!</p>
      </div>
    `;
  }

  submitAnswer(answer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'submit_answer',
        answer: answer
      }));
      // Provisional: a socket can look open and already be dead. If the
      // answer never arrived, the rejoin's `alreadyAnswered: false` says so
      // and the question is offered again.
      this.answerSubmitted = true;
      this.renderWaiting('Answer submitted!');
    }
  }

  showError(message) {
    document.getElementById('content').innerHTML = `
      <div class="error">${this.escapeHtml(message)}</div>
    `;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    const client = new QuizClient();
    client.init();
  });
} else {
  const client = new QuizClient();
  client.init();
}
