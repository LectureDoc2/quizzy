class QuizClient {
  constructor() {
    this.ws = null;
    this.roomId = null;
    this.participantId = null;
    this.state = 'join'; // join, question, results, ended
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
    this.renderJoinForm();
  }

  renderJoinForm() {
    const content = document.getElementById('content');
    content.innerHTML = `
      <form id="join-form">
        <input type="text" id="name" class="input" placeholder="Enter your name" maxlength="50" required>
        <button type="submit" class="btn btn--primary btn--full">Join Quiz</button>
        <div id="name-error" class="error-text" style="display:none;margin-top:0.5rem;color:var(--error-color)"></div>
      </form>
    `;

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
      this.connect(validation.name);
    });
  }

  connect(name) {
    const wsUrl = window.location.origin.replace(/^http/, 'ws');
    this.ws = new WebSocket(`${wsUrl}/ws`);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        type: 'join_room',
        roomId: this.roomId,
        name: name
      }));
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      this.handleMessage(msg);
    };

    this.ws.onclose = () => {
      if (this.state !== 'ended') {
        this.showError('Connection lost. Please refresh the page.');
      }
    };

    this.ws.onerror = () => {
      this.showError('Connection error');
    };
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'joined':
        this.participantId = msg.participantId;
        this.state = 'joined';
        this.renderWaiting();
        break;

      case 'question':
        this.state = 'question';
        this.renderQuestion(msg.question, msg.questionIndex, msg.totalQuestions, msg.startTime);
        break;

      case 'results':
        this.state = 'results';
        this.renderResults(msg.leaderboard, msg.questionIndex, msg.waiting);
        break;

      case 'game_ended':
        this.state = 'ended';
        this.renderFinalResults(msg.leaderboard);
        break;

      case 'answer_accepted':
        // Ignore if results are already shown (e.g., question auto-ended)
        if (this.state !== 'results' && this.state !== 'ended') {
          this.renderWaiting('Answer submitted! Waiting for results...');
        }
        break;

      case 'kicked':
        this.showError('You have been removed from the quiz');
        break;

      case 'error':
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

  renderResults(leaderboard, questionIndex, waiting) {
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
        <div class="my-stats">Your rank: ${myRank} | Score: ${myEntry ? myEntry.score : 0}</div>
        <div class="leaderboard">${listHtml}</div>
        <p class="waiting-text">${waiting ? 'Waiting for next question...' : 'Quiz complete!'}</p>
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
