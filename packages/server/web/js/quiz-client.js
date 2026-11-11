import { PROTOCOL_VERSION, PROTOCOL_MISMATCH } from '../../../ld-quiz/src/protocol.js';
import { createI18n, detectLocale, translatePage } from './i18n.js';
import { measuredLength } from '../../src/short-answer.js';
import { attachSortable } from './sortable-list.js';

/** This page's language: ?lang= if given, else the browser's; see i18n.js. */
const i18n = createI18n(detectLocale(window.location.search, navigator.languages));
const { t, html } = i18n;

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

/** Where a practice game sends the student to pick another quiz. */
const PRACTICE_LIST_URL = 'practice.html';

/** The practice estimate bands (see Room.getAnswerFeedback()) with a verdict. */
const PRACTICE_BANDS = new Set([10, 25, 50]);

/**
 * "Expected length: 9–18 characters", from the range the server derived from
 * the accepted answers; empty when the range is unusable.
 */
function expectedLengthText(answerLength) {
  const min = answerLength?.min;
  const max = answerLength?.max;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) return '';
  return min === max
    ? t('question.expectedLengthExact', { count: min })
    : t('question.expectedLength', { min, max });
}

/**
 * Whether two answers are the same: an answer on screen and one already sent.
 * Answers are numbers, strings and arrays of numbers -- in the same form on
 * both sides, see renderQuestion() -- so their JSON is a fair comparison.
 */
function sameAnswer(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

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
    // The question on screen (see renderQuestion()), and the answer last sent
    // for it: { answer, confirmed, replaced }, or null before Submit.
    this.questionView = null;
    this.submission = null;
    this.rejoinContext = null;
    // A practice game: one student, no presenter, the server moves it on.
    // practiceQuizId comes from `?practice=` and names the catalog entry.
    this.practice = false;
    this.practiceQuizId = null;
    this.totalQuestions = null;
    // Consent to having one's name and final score in the lecturer's export,
    // as the server last confirmed it; null when the quiz does not ask.
    // Never stored on the device: a rejoin gets it back from the server.
    this.recordsNamedResults = false;
    this.consent = null;
    this.consentPending = false;
  }

  // Client-side validation (must match server-side). A refusal carries the
  // same `code` and `params` as the server's, and so the same translation.
  static NAME_PATTERN = /^(([\p{L}][\p{L}'\- ]{0,48}[\p{L}])|([\p{Nd}]{6,16}))$/u;
  static NAME_MIN_LENGTH = 2;
  static NAME_MAX_LENGTH = 50;

  static validateName(name) {
    if (!name || typeof name !== 'string') {
      return { valid: false, code: 'name_required' };
    }

    const trimmed = name.trim();

    if (trimmed.length < QuizClient.NAME_MIN_LENGTH) {
      return { valid: false, code: 'name_too_short', params: { min: QuizClient.NAME_MIN_LENGTH } };
    }

    if (trimmed.length > QuizClient.NAME_MAX_LENGTH) {
      return { valid: false, code: 'name_too_long', params: { max: QuizClient.NAME_MAX_LENGTH } };
    }

    if (!QuizClient.NAME_PATTERN.test(trimmed)) {
      return { valid: false, code: 'name_invalid_characters' };
    }

    return { valid: true, name: trimmed };
  }

  init() {
    translatePage(i18n);
    const urlParams = new URLSearchParams(window.location.search);
    this.roomId = urlParams.get('room');
    this.practiceQuizId = urlParams.get('practice');

    if (this.practiceQuizId) {
      this.enterPracticeMode();
    } else if (!this.roomId) {
      this.showError(t('join.noRoom'));
      return;
    } else {
      document.getElementById('room-id').textContent = this.roomId;
    }

    // A reload, a restored tab or a re-opened link in the same tab: try to
    // carry on as the participant this tab already was. A practice game that
    // has not started yet has no room, and so nothing to carry on with.
    this.resumeToken = this.roomId ? this.loadResumeToken() : null;
    this.renderConnecting(
      t(this.resumeToken ? 'status.reconnecting'
        : this.practiceQuizId ? 'status.startingPractice'
          : 'status.checking')
    );
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

  /**
   * "Question 3 of 10" in the footer, or nothing. Like the heading it is
   * outside #content, so it stays through the results until the next question.
   */
  showProgress(text) {
    const progress = document.getElementById('question-progress');
    if (!progress) return;
    progress.textContent = text || '';
    progress.hidden = !text;
  }

  /**
   * Switch the page to a practice game. There is no room code to show --
   * nobody else can join -- and nothing on the page is about other players.
   */
  enterPracticeMode() {
    this.practice = true;
    const roomCode = document.querySelector('.room-code');
    if (roomCode) roomCode.hidden = true;
    if (this.state === 'join') this.setHeading(t('practice.heading'));
  }

  renderConnecting(message = t('status.checking')) {
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
      } else if (this.practiceQuizId) {
        ws.send(JSON.stringify({
          type: 'start_practice',
          protocolVersion: PROTOCOL_VERSION,
          quizId: this.practiceQuizId
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
      this.updateConsent(false, null);
      this.setReconnecting(false);
      this.showError(t('connection.superseded'));
      return;
    }

    if (!this.resumeToken) {
      this.setReconnecting(false);
      this.showError(t('connection.lost'));
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
    // A consent change cannot be sent while the socket is down.
    this.renderConsentStatus();
  }

  /**
   * Record what the server says about consent and show it.
   *
   * @param {boolean} recordsNamedResults Whether this quiz asks at all.
   * @param {boolean|null} consent The participant's choice, as recorded.
   */
  updateConsent(recordsNamedResults, consent) {
    this.recordsNamedResults = recordsNamedResults === true;
    this.consent = this.recordsNamedResults && consent !== null ? consent === true : null;
    this.consentPending = false;
    this.renderConsentStatus();
  }

  /**
   * Show the participant what they chose about being named in the lecturer's
   * export, and -- until the quiz ends -- let them change it. Withdrawing has
   * to be as easy as agreeing.
   *
   * Only ever shows what the server confirmed: a click sends `set_consent`
   * and the text changes on `consent_updated`, not before.
   */
  renderConsentStatus() {
    const box = document.getElementById('consent-status');
    if (!box) return;
    if (!this.recordsNamedResults || this.consent === null) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }

    const final = this.state === 'ended';
    const text = document.createElement('span');
    text.className = 'consent-status__text';
    if (final) {
      text.textContent = t(this.consent ? 'consent.wereIncluded' : 'consent.wasNotRecorded');
    } else {
      text.textContent = t(this.consent ? 'consent.willBeIncluded' : 'consent.willNotBeRecorded');
    }
    box.replaceChildren(text);
    box.classList.toggle('consent-status--given', this.consent);

    if (!final) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'consent-toggle';
      button.className = 'btn btn--secondary consent-status__toggle';
      button.textContent = t(this.consent ? 'consent.withdraw' : 'consent.give');
      button.disabled = this.consentPending || this.reconnecting;
      button.addEventListener('click', () => this.requestConsent(!this.consent));
      box.append(button);
    }
    box.hidden = false;
  }

  requestConsent(consent) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.consentPending = true;
    this.renderConsentStatus();
    this.ws.send(JSON.stringify({ type: 'set_consent', consent }));
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
    this.showProgress(null);
    if (status && status.quizTitle) this.quizTitle = status.quizTitle;
    const content = document.getElementById('content');
    const inProgress = status && status.state !== 'lobby';
    const missed = inProgress ? Math.max(0, status.currentQuestionIndex) : 0;
    // Only when the quiz's author opted in. Never pre-ticked: consent is
    // something the student gives, not something they have to undo.
    const offerConsent = !!(status && status.recordsNamedResults === true);

    content.innerHTML = `
      <div id="room-state" class="room-state"></div>
      <form id="join-form">
        <input type="text" id="name" class="input" placeholder="${html('join.namePlaceholder')}" maxlength="50" required>
        ${offerConsent ? `
        <label class="consent-option" for="consent">
          <input type="checkbox" id="consent" class="consent-option__box">
          <span>${html('consent.label')}</span>
        </label>` : ''}
        <button type="submit" class="btn btn--primary btn--full" id="join-btn"></button>
        <div id="name-error" class="error-text" style="display:none;margin-top:0.5rem;color:var(--error-color)"></div>
      </form>
      <p class="join-privacy" id="join-privacy">
        ${html('privacy.join')}${offerConsent ? ` ${html('privacy.joinConsent')}` : ''}
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

    this.setHeading(t(inProgress ? 'join.headingInProgress' : 'join.heading'));

    const detail = document.createElement('div');
    detail.className = inProgress ? 'room-state__detail room-state__detail--live' : 'room-state__detail';
    if (inProgress) {
      const progress = {
        current: Math.min(status.currentQuestionIndex + 1, status.totalQuestions),
        total: status.totalQuestions,
        count: missed
      };
      detail.textContent = t(missed > 0 ? 'join.progressMissed' : 'join.progress', progress);
    } else {
      detail.textContent = t('join.waitingForStart');
    }
    if (status) stateEl.append(detail);

    document.getElementById('join-btn').textContent = t(inProgress ? 'join.buttonInProgress' : 'join.button');

    document.getElementById('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('name');
      const name = nameInput.value.trim();
      const errorEl = document.getElementById('name-error');

      const validation = QuizClient.validateName(name);
      if (!validation.valid) {
        errorEl.textContent = t(`error.${validation.code}`, validation.params);
        errorEl.style.display = 'block';
        return;
      }

      errorEl.style.display = 'none';
      const consentBox = document.getElementById('consent');
      this.join(validation.name, !!(consentBox && consentBox.checked));
    });
  }

  join(name, consent = false) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.showError(t('connection.lost'));
      return;
    }
    this.ws.send(JSON.stringify({
      type: 'join_room',
      protocolVersion: PROTOCOL_VERSION,
      roomId: this.roomId,
      name: name,
      consent: consent
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

    this.showNotice(t('connection.missedQuestions', {
      list: i18n.formatList(missed),
      count: missed.length
    }));
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        if (msg.practice) {
          // The room exists from now on. Putting it in the URL is what lets a
          // reload come back to this game rather than start another one; the
          // resume token below is stored under it.
          this.roomId = msg.roomId;
          if (typeof msg.practiceQuizId === 'string') this.practiceQuizId = msg.practiceQuizId;
          this.enterPracticeMode();
          const params = new URLSearchParams({
            practice: this.practiceQuizId,
            room: this.roomId,
            ...i18n.langParam()
          });
          history.replaceState(null, '', `${window.location.pathname}?${params}`);
        }
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
        this.setHeading(this.quizTitle || t('quiz.fallbackTitle'));
        this.showNotice(null);
        this.updateConsent(msg.recordsNamedResults, msg.consent);
        // A practice game starts at once; its first question follows.
        this.renderWaiting(this.practice ? t('status.starting') : undefined);
        break;

      case 'rejoined':
        clearTimeout(this.reconnectTimer);
        this.reconnectAttempt = 0;
        this.setReconnecting(false);
        this.participantId = msg.participantId;
        if (msg.practice) this.enterPracticeMode();
        if (msg.quizTitle) this.quizTitle = msg.quizTitle;
        this.setHeading(this.quizTitle || t('quiz.fallbackTitle'));
        this.rejoinContext = {
          previousIndex: this.questionIndex,
          previousOpen: this.state === 'question',
          answered: new Set(Array.isArray(msg.answeredQuestions) ? msg.answeredQuestions : [])
        };
        // Back from the server, so a reload shows the choice again. On an
        // ended quiz the game_ended that follows turns it final.
        this.updateConsent(msg.recordsNamedResults, msg.consent);
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
        this.updateConsent(false, null);
        this.setReconnecting(false);
        this.state = 'join';
        if (this.practiceQuizId) {
          // Nothing to fall back to: a practice game cannot be joined.
          this.renderPracticeProblem(t('practice.expired'), true);
          break;
        }
        this.showNotice(t('error.rejoin_failed'));
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
        // Back on the question that was on screen when the connection dropped.
        const onScreen = sameQuestion && this.questionView?.isOnScreen() === true;
        // What this page last sent for it, before the connection dropped.
        const sent = sameQuestion ? this.submission : null;
        this.state = 'question';
        this.questionIndex = msg.questionIndex;
        this.totalQuestions = msg.totalQuestions;

        if (msg.alreadyAnswered && msg.yourAnswer === undefined) {
          // A server that does not say what the answer was cannot be offered
          // a changed one either.
          this.answerSubmitted = true;
          this.renderWaiting(t('status.answerSubmittedWaiting'));
          break;
        }
        if (msg.alreadyAnswered) {
          // Answered, dropped, came back: the answer arrived, and may still be
          // changed. What the server holds is what counts.
          this.answerSubmitted = true;
          if (!onScreen) {
            this.renderQuestion(msg.question, msg.questionIndex, msg.totalQuestions, msg.startTime, msg.yourAnswer);
            break;
          }
          // Whatever the student has on screen stays there; if it is not what
          // the server holds, the button offers to resubmit it.
          if (sent && !sameAnswer(sent.answer, msg.yourAnswer)) {
            this.showNotice(t('connection.changeLost'));
          }
          this.submission = {
            answer: msg.yourAnswer,
            confirmed: true,
            replaced: sent?.replaced === true && sameAnswer(sent.answer, msg.yourAnswer)
          };
          this.questionView.refresh();
          break;
        }
        if (onScreen && !this.answerSubmitted) {
          // Not answered yet: keep the question, and whatever the student had
          // already selected.
          break;
        }
        if (answerWasLost) {
          this.showNotice(t('connection.answerLost'));
        }
        this.answerSubmitted = false;
        this.renderQuestion(msg.question, msg.questionIndex, msg.totalQuestions, msg.startTime);
        // The answer that never arrived, back on screen to be sent again.
        if (answerWasLost && sent) {
          this.questionView.setAnswer(sent.answer);
          this.questionView.refresh();
        }
        break;
      }

      case 'results':
        if (this.rejoinContext) {
          this.showNotice(null);
          this.noteMissedQuestions(msg.questionIndex, false);
        }
        this.state = 'results';
        this.questionIndex = msg.questionIndex;
        if (this.practice) {
          if (Number.isInteger(msg.totalQuestions)) this.totalQuestions = msg.totalQuestions;
          this.renderPracticeResults(msg);
        } else {
          this.renderResults(msg.leaderboard, msg.questionIndex, msg.waiting, msg.feedback);
        }
        break;

      case 'game_ended':
        this.state = 'ended';
        this.rejoinContext = null;
        // Nothing left to come back to.
        this.clearResumeToken();
        // The choice is final now; say what it was, without the button.
        this.consentPending = false;
        this.renderConsentStatus();
        if (this.practice) {
          this.renderPracticeFinal(msg.summary);
        } else {
          this.renderFinalResults(msg.leaderboard);
        }
        break;

      case 'answer_accepted':
        // Ignore if results are already shown (e.g., question auto-ended)
        if (this.state !== 'question') break;
        if (this.submission && this.questionView?.isOnScreen()) {
          // Only now "Submitted ✓": an answer sent on a connection that was
          // already dead must not look as if it had counted.
          this.submission.confirmed = true;
          this.submission.replaced = msg.replaced === true;
          this.questionView.refresh();
        } else {
          this.renderWaiting(t('status.answerSubmittedWaiting'));
        }
        break;

      case 'consent_updated':
        this.updateConsent(this.recordsNamedResults, msg.consent === true);
        break;

      case 'kicked':
        this.state = 'kicked';
        this.clearResumeToken();
        this.updateConsent(false, null);
        this.setReconnecting(false);
        this.showError(t('join.kicked'));
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
          this.showError(t('error.protocol_mismatch', { version: PROTOCOL_VERSION }));
          break;
        }
        // An answer that crossed the question closing -- a resubmission sent
        // as the last student answered, say. The results that closed it have
        // already replaced the question, and show which answer counted; an
        // error screen in their place would only hide that.
        if (msg.code === 'no_open_question' && this.state !== 'question') {
          break;
        }
        // A refused consent change (the quiz has just ended, say) belongs in
        // the notice: wiping the screen for it would cost the student the
        // final results they are looking at.
        if (this.consentPending) {
          this.consentPending = false;
          this.showNotice(this.serverMessage(msg));
          this.renderConsentStatus();
          break;
        }
        // While coming back -- "Too many connections" as a whole hall
        // reconnects, say -- the server closes the socket next, and the close
        // schedules the next attempt. The screen underneath stays as it is.
        if (this.reconnecting || (this.resumeToken && !this.participantId)) {
          break;
        }
        // A practice game that could not start: an unknown quiz, a full
        // server. The way on is the list, not this page.
        if (this.practiceQuizId && !this.participantId) {
          this.state = 'fatal';
          this.renderPracticeProblem(this.serverMessage(msg), false);
          break;
        }
        // Before joining, an error belongs next to the form -- the student can
        // fix a mistyped name and try again without reloading.
        if (this.state === 'join') {
          const errorEl = document.getElementById('name-error');
          if (errorEl) {
            errorEl.textContent = this.serverMessage(msg);
            errorEl.style.display = 'block';
            break;
          }
        }
        this.showError(this.serverMessage(msg));
        break;
    }
  }

  /**
   * A server error in this page's language: by its `code` where the resource
   * files know it, else the server's own English text.
   */
  serverMessage(msg) {
    const key = `error.${msg.code}`;
    return msg.code && i18n.has(key) ? t(key, msg.params || {}) : msg.message;
  }

  renderWaiting(message = t('status.waitingForStart')) {
    const content = document.getElementById('content');
    content.innerHTML = `
      <div class="waiting">
        <div class="spinner"></div>
        <p></p>
      </div>
    `;
    content.querySelector('p').textContent = message;
  }

  /**
   * Show a question, ready to be answered.
   *
   * The question stays on screen once it is answered: until everybody has
   * answered (or the timer or the presenter closes it), the student may change
   * their answer and send it again, and the server takes the last one. See
   * Room.submitAnswer(). `submitted`, if given, is an answer the server already
   * holds -- a reload after answering -- shown again in that state.
   */
  renderQuestion(question, index, total, startTime, submitted) {
    const content = document.getElementById('content');
    const timeLimit = question.timeLimit || 0;
    // The time left sits in Submit itself, where the student looks when
    // answering, rather than in a line of its own above the question. Hidden
    // from screen readers, which would otherwise hear the button renamed
    // every second; its name stays "Submit".
    const submitLabel = html('question.submit') +
      (timeLimit > 0 ? ' <span class="submit__time" aria-hidden="true"></span>' : '');
    // Directly above the button, once there is an answer that may be changed.
    const resubmitNote = `<p class="resubmit-note" id="resubmit-note" role="status" hidden>${html('question.resubmitNote')}</p>`;

    let inputHtml = '';
    if (question.type === 'multiple-choice') {
      inputHtml = `
        <div class="options" id="options">
          ${question.options.map((opt, i) => `
            <div class="option" data-index="${i}">${opt}</div>
          `).join('')}
        </div>
        ${resubmitNote}
        <button class="btn btn--primary btn--full question__submit" id="submit-btn">${submitLabel}</button>
      `;
    } else if (question.type === 'estimation') {
      inputHtml = `
        <form id="answer-form">
          <input type="number" id="answer" class="input" placeholder="${html('question.estimatePlaceholder')}" step="any" required>
          ${resubmitNote}
          <button type="submit" class="btn btn--primary btn--full" id="submit-btn">${submitLabel}</button>
        </form>
      `;
    } else if (question.type === 'short-answer') {
      // A term, typed as the lecture spells it: autocorrect would "fix" it.
      // No maxlength attribute -- that counts the raw input, spaces included;
      // the limit is checked as the server measures it, below.
      inputHtml = `
        <form id="answer-form">
          <input type="text" id="answer" class="input" placeholder="${html('question.termPlaceholder')}"
            autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
            aria-describedby="answer-length" required>
          <p class="answer-length" id="answer-length" aria-live="polite"></p>
          ${resubmitNote}
          <button type="submit" class="btn btn--primary btn--full" id="submit-btn">${submitLabel}</button>
        </form>
      `;
    } else if (question.type === 'ordering') {
      // The items arrive shuffled; data-index is their place in that list,
      // which is what the server expects back. See sortable-list.js.
      inputHtml = `
        <p class="ordering-hint" id="ordering-hint">${html('question.orderHint')}</p>
        <ol class="ordering" id="ordering" role="list" aria-describedby="ordering-hint">
          ${question.options.map((opt, i) => `
            <li class="ordering__item" data-index="${i}">
              <span class="ordering__handle" aria-hidden="true"></span>
              <span class="ordering__number" aria-hidden="true"></span>
              <div class="ordering__content">${opt}</div>
              <span class="ordering__moves">
                <button type="button" class="ordering__move ordering__move--up" data-move="-1" aria-label="${html('question.moveUp')}"></button>
                <button type="button" class="ordering__move ordering__move--down" data-move="1" aria-label="${html('question.moveDown')}"></button>
              </span>
            </li>
          `).join('')}
        </ol>
        <p class="ordering__status" id="ordering-status" aria-live="polite"></p>
        ${resubmitNote}
        <button class="btn btn--primary btn--full question__submit" id="submit-btn">${submitLabel}</button>
      `;
    }

    content.innerHTML = `
      <div class="question">
        <div class="question__text" id="question-text">${question.text}</div>
        ${inputHtml}
      </div>
    `;
    // In the footer, not above the question: on a phone every line up there
    // pushes Submit further down.
    this.showProgress(t('question.counter', { current: index + 1, total }));

    const submitBtn = document.getElementById('submit-btn');
    const note = document.getElementById('resubmit-note');

    if (timeLimit > 0) {
      const time = submitBtn.querySelector('.submit__time');
      // False once there is nothing more to count: the time is up, the
      // question has been replaced, or it has been answered -- which takes the
      // time out of the button (see refresh() below).
      const tick = () => {
        if (!time.isConnected) return false;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const remaining = Math.max(0, timeLimit - elapsed);
        time.textContent = t('question.timeLeft', { seconds: remaining });
        submitBtn.classList.toggle('submit--urgent', remaining <= 5);
        return remaining > 0;
      };
      if (tick()) {
        const interval = setInterval(() => {
          if (!tick()) clearInterval(interval);
        }, 1000);
      }
    }

    // Provided by the question type below: the answer as it stands on screen
    // (null while there is none that could be sent), putting an earlier answer
    // back on screen, and whether something else keeps Submit disabled.
    let readAnswer = () => null;
    let setAnswer = () => {};
    let blocked = () => false;

    // null until this question is answered; then the last answer sent, and
    // whether the server has confirmed it. See submitAnswer().
    this.submission = null;

    /**
     * Bring the button (and the note above it) in line with the answer on
     * screen. Before the first answer: Submit, with the time left. Once
     * answered there is no time left to show -- the question may close the
     * moment the last student answers -- and the button says whether what is
     * on screen is what the server holds: "Submitted ✓" (nothing to send), or
     * Resubmit, in its own colour, once the answer has been changed. A changed
     * answer that is never resubmitted does not count, and must not look as if
     * it did.
     */
    const refresh = () => {
      if (!submitBtn.isConnected) return;
      const submission = this.submission;
      if (submission === null) {
        submitBtn.disabled = blocked();
        return;
      }
      submitBtn.classList.remove('submit--urgent');
      submitBtn.classList.add('submit--answered');
      if (!submission.confirmed) {
        submitBtn.classList.remove('submit--resubmit', 'submit--done');
        submitBtn.textContent = t('question.sending');
        submitBtn.disabled = true;
        return;
      }
      note.hidden = false;
      const answer = readAnswer();
      const changed = !sameAnswer(answer, submission.answer);
      submitBtn.classList.toggle('submit--resubmit', changed);
      submitBtn.classList.toggle('submit--done', !changed);
      submitBtn.textContent = changed
        ? t('question.resubmit')
        : t(submission.replaced ? 'question.resubmitted' : 'question.submitted');
      submitBtn.disabled = !changed || answer === null || blocked();
    };

    const send = () => {
      const answer = readAnswer();
      if (answer === null || blocked()) return;
      const submission = this.submission;
      if (submission !== null && (!submission.confirmed || sameAnswer(answer, submission.answer))) return;
      this.submitAnswer(answer);
    };

    if (question.type === 'multiple-choice') {
      const selected = new Set();
      const optionEls = Array.from(document.getElementById('options').querySelectorAll('.option'));
      optionEls.forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index);
          if (selected.has(idx)) {
            selected.delete(idx);
            btn.classList.remove('option--selected');
          } else {
            selected.add(idx);
            btn.classList.add('option--selected');
          }
          refresh();
        });
      });
      // An empty selection is an answer too ("I don't know"), as before.
      readAnswer = () => Array.from(selected).sort((a, b) => a - b);
      setAnswer = (answer) => {
        if (!Array.isArray(answer)) return;
        selected.clear();
        for (const btn of optionEls) {
          const idx = parseInt(btn.dataset.index);
          const on = answer.includes(idx);
          if (on) selected.add(idx);
          btn.classList.toggle('option--selected', on);
        }
      };
      submitBtn.addEventListener('click', send);
    } else if (question.type === 'estimation') {
      const input = document.getElementById('answer');
      readAnswer = () => {
        const answer = parseFloat(input.value);
        return Number.isFinite(answer) ? answer : null;
      };
      setAnswer = (answer) => {
        if (typeof answer === 'number' && Number.isFinite(answer)) input.value = String(answer);
      };
      input.addEventListener('input', refresh);
      document.getElementById('answer-form').addEventListener('submit', (e) => {
        e.preventDefault();
        send();
      });
    } else if (question.type === 'ordering') {
      const status = document.getElementById('ordering-status');
      const sortable = attachSortable(document.getElementById('ordering'), {
        onMove: (item, position, total) => {
          const text = (item.querySelector('.ordering__content')?.textContent || '').replace(/\s+/g, ' ').trim();
          status.textContent = t('question.movedTo', {
            item: text.length > 60 ? `${text.slice(0, 59)}…` : text,
            position: position + 1,
            total
          });
          refresh();
        }
      });
      readAnswer = () => sortable.order();
      setAnswer = (answer) => sortable.setOrder(answer);
      submitBtn.addEventListener('click', send);
    } else if (question.type === 'short-answer') {
      const input = document.getElementById('answer');
      const hint = document.getElementById('answer-length');
      const expected = expectedLengthText(question.answerLength);
      const maxLength = Number.isInteger(question.maxLength) && question.maxLength > 0 ? question.maxLength : null;

      // measuredLength() is the server's own measure (see short-answer.js),
      // so an answer this page lets through is never refused for its length.
      const fits = () => {
        const tooLong = maxLength !== null && measuredLength(input.value) > maxLength;
        hint.textContent = tooLong ? t('question.answerTooLong') : expected;
        hint.classList.toggle('answer-length--exceeded', tooLong);
        return !tooLong;
      };
      fits();
      blocked = () => !fits();
      // Spacing collapsed as the server stores it, so that an answer given
      // before a reload compares equal to the same text typed again.
      readAnswer = () => {
        const answer = input.value.replace(/\s+/g, ' ').trim();
        return answer === '' ? null : answer;
      };
      setAnswer = (answer) => {
        if (typeof answer !== 'string') return;
        input.value = answer;
        fits();
      };
      input.addEventListener('input', () => {
        fits();
        refresh();
      });
      document.getElementById('answer-form').addEventListener('submit', (e) => {
        e.preventDefault();
        send();
      });
    }

    this.questionView = {
      isOnScreen: () => submitBtn.isConnected,
      refresh,
      setAnswer
    };

    if (submitted !== undefined && submitted !== null) {
      setAnswer(submitted);
      this.submission = { answer: submitted, confirmed: true, replaced: false };
    }
    refresh();
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
        <div class="question__counter">${html('results.counter', { number: questionIndex + 1 })}</div>
        ${this.renderFeedback(feedback)}
        <div class="my-stats">${html('results.rankAndScore', { rank: myRank, score: myEntry ? Number(myEntry.score) : 0 })}</div>
        <div class="leaderboard">${listHtml}</div>
        <p class="waiting-text">${html(waiting ? 'results.waitingForNext' : 'results.complete')}</p>
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
    let verdict = t('feedback.notAnswered');
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
        verdict = t(feedback.isCorrect ? 'feedback.correct' : 'feedback.wrong');
        verdictClass = feedback.isCorrect ? 'feedback__verdict--correct' : 'feedback__verdict--wrong';
      }
    } else if (question.type === 'estimation') {
      if (feedback.answered) {
        const answer = Number(feedback.answer);
        detailHtml = `
          <div class="feedback__estimate">${html('feedback.yourAnswer')} <strong>${
            Number.isFinite(answer) ? i18n.formatNumber(answer) : '-'
          }</strong></div>
        `;
      }
      if (feedback.answered && this.practice) {
        // A practice estimate is scored by how far off it is, in bands; the
        // verdict names the band, never the distance or the direction.
        const points = Number(feedback.points) || 0;
        const band = PRACTICE_BANDS.has(feedback.band);
        verdict = band
          ? t('feedback.bandPoints', { band: t(`feedback.band.${feedback.band}`), count: points })
          : t('feedback.bandMissed');
        verdictClass = feedback.band === 10 ? 'feedback__verdict--correct'
          : band ? 'feedback__verdict--partial' : 'feedback__verdict--wrong';
      } else if (feedback.answered) {
        const rank = Number(feedback.rank);
        const count = Number(feedback.answerCount);
        if (Number.isInteger(rank) && rank > 0 && Number.isInteger(count)) {
          if (count === 1) verdict = t('feedback.onlyEstimate');
          else if (rank === 1) verdict = t('feedback.closest', { count });
          else verdict = t('feedback.rank', { rank, count });
          // Places 1 to 3 score; equally close estimates share a place and
          // skip the ones after it (see Room.scoreQuestion()).
          verdictClass = rank <= 3 ? 'feedback__verdict--correct' : 'feedback__verdict--wrong';
        } else {
          verdict = t('feedback.recorded');
        }
      }
    } else if (question.type === 'ordering') {
      // The participant's own order. The server sends the items as they were
      // shown and the answer as positions in that list -- never the correct
      // order, which is the presenter's to reveal.
      const options = Array.isArray(question.options) ? question.options : [];
      const order = Array.isArray(feedback.answer)
        ? feedback.answer.filter((i) => Number.isInteger(i) && i >= 0 && i < options.length)
        : [];
      if (feedback.answered && order.length > 0) {
        detailHtml = `
          <div class="feedback__answer">${html('feedback.yourOrder')}</div>
          <ol class="ordering ordering--feedback" role="list">
            ${order.map((i) => `
              <li class="ordering__item">
                <span class="ordering__number" aria-hidden="true"></span>
                <div class="ordering__content">${options[i]}</div>
              </li>
            `).join('')}
          </ol>
        `;
      }
      if (feedback.answered) {
        verdict = t(feedback.isCorrect ? 'feedback.correct' : 'feedback.wrong');
        verdictClass = feedback.isCorrect ? 'feedback__verdict--correct' : 'feedback__verdict--wrong';
      }
    } else if (question.type === 'short-answer') {
      // The participant's own text: escaped, like every other participant
      // input on this page.
      if (feedback.answered && typeof feedback.answer === 'string') {
        detailHtml = `
          <div class="feedback__answer">${html('feedback.yourAnswer')} <strong>${this.escapeHtml(feedback.answer)}</strong></div>
        `;
      }
      if (feedback.answered) {
        verdict = t(feedback.isCorrect ? 'feedback.correct' : 'feedback.wrong');
        verdictClass = feedback.isCorrect ? 'feedback__verdict--correct' : 'feedback__verdict--wrong';
      }
      // The presenter counted it as right after all; the results arrive
      // again, and without this the verdict would just flip.
      if (feedback.answered && feedback.isCorrect && feedback.acceptedByPresenter === true) {
        verdict = t('feedback.acceptedByPresenter');
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

  /**
   * A practice results screen: the closed question and the verdict, the score
   * so far, and the countdown to the next question -- which the student may
   * cut short. No leaderboard; there is nobody else on it.
   */
  renderPracticeResults(msg) {
    const content = document.getElementById('content');
    const myEntry = (msg.leaderboard || []).find(e => e.id === this.participantId);
    const counter = Number.isInteger(this.totalQuestions)
      ? html('results.counterOfTotal', { number: msg.questionIndex + 1, total: this.totalQuestions })
      : html('results.counter', { number: msg.questionIndex + 1 });

    content.innerHTML = `
      <div class="results">
        <div class="question__counter">${counter}</div>
        ${this.renderFeedback(msg.feedback)}
        <div class="my-stats">${html('results.score', { score: myEntry ? Number(myEntry.score) : 0 })}</div>
        <p class="practice-countdown" id="practice-countdown" aria-live="off"></p>
        <button type="button" class="btn btn--primary btn--full" id="practice-next-btn"></button>
      </div>
    `;

    const button = document.getElementById('practice-next-btn');
    button.textContent = t(msg.waiting ? 'practice.nextQuestion' : 'practice.showFinalScore');
    button.addEventListener('click', () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      button.disabled = true;
      this.ws.send(JSON.stringify({ type: 'practice_next' }));
    });

    const countdown = document.getElementById('practice-countdown');
    const remainingMs = Number(msg.advanceInMs);
    if (!Number.isFinite(remainingMs)) return;
    const deadline = Date.now() + remainingMs;
    const label = msg.waiting ? 'practice.nextQuestionIn' : 'practice.finalScoreIn';
    const tick = () => {
      // The next render replaces this element; the interval goes with it.
      if (!countdown.isConnected) {
        clearInterval(interval);
        return;
      }
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      countdown.textContent = t(label, { seconds });
    };
    const interval = setInterval(tick, 250);
    tick();
  }

  /** The end of a practice game: the tally, and where to go next. */
  renderPracticeFinal(summary) {
    const content = document.getElementById('content');
    const score = Number(summary?.score) || 0;
    const maxScore = Number(summary?.maxScore) || 0;
    const correct = Number(summary?.correct) || 0;
    const total = Number(summary?.total) || 0;

    content.innerHTML = `
      <div class="results">
        <h2>${html('results.finalHeading')}</h2>
        <div class="practice-summary__score">${i18n.formatNumber(score)} <span>${html('practice.ofPoints', { count: maxScore })}</span></div>
        <div class="my-stats">${html('practice.answeredCorrectly', { correct, count: total })}</div>
        <div class="practice-actions" id="practice-actions"></div>
      </div>
    `;
    this.appendPracticeActions(document.getElementById('practice-actions'), true);
  }

  /**
   * Something stopped a practice game from starting or continuing. Offers a
   * fresh start where that makes sense, and the list in any case.
   */
  renderPracticeProblem(message, offerRestart) {
    const content = document.getElementById('content');
    content.innerHTML = `
      <div class="error"></div>
      <div class="practice-actions" id="practice-actions"></div>
    `;
    content.querySelector('.error').textContent = message;
    this.appendPracticeActions(document.getElementById('practice-actions'), offerRestart);
  }

  /**
   * "Play again" and "All practice quizzes". Built with the DOM, not markup:
   * the quiz id comes from the URL, and must never be parsed as HTML.
   */
  appendPracticeActions(container, offerRestart) {
    if (offerRestart && this.practiceQuizId) {
      const again = document.createElement('a');
      again.className = 'btn btn--primary btn--full';
      again.href = `${window.location.pathname}?${new URLSearchParams({
        practice: this.practiceQuizId,
        ...i18n.langParam()
      })}`;
      again.textContent = t('practice.playAgain');
      container.append(again);
    }
    const list = document.createElement('a');
    list.className = 'btn btn--secondary btn--full';
    const langQuery = new URLSearchParams(i18n.langParam()).toString();
    list.href = langQuery ? `${PRACTICE_LIST_URL}?${langQuery}` : PRACTICE_LIST_URL;
    list.textContent = t('practice.allQuizzes');
    container.append(list);
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
        <h2>${html('results.finalHeading')}</h2>
        <div class="my-stats">${html('results.rankAndScore', { rank: myRank, score: myEntry ? Number(myEntry.score) : 0 })}</div>
        <div class="leaderboard">${listHtml}</div>
        <p class="waiting-text">${html('results.thanks')}</p>
      </div>
    `;
  }

  /**
   * Send an answer, or a changed one: the server takes the last answer that
   * arrives while the question is open. The question stays on screen, with the
   * button saying "Sending…" until the server confirms (see answer_accepted).
   */
  submitAnswer(answer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'submit_answer',
        answer: answer
      }));
      // Provisional: a socket can look open and already be dead. If the
      // answer never arrived, the rejoin's `alreadyAnswered: false` says so
      // and the question is offered again; a changed answer that never
      // arrived shows up as a `yourAnswer` other than the one sent.
      this.answerSubmitted = true;
      this.submission = { answer, confirmed: false, replaced: this.submission !== null };
      this.questionView?.refresh();
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
