/**
 * The control view holds the presenter token, so anything a participant can put
 * on that page must stay inert.
 *
 * The WebSocket is stubbed inside the page, which puts these tests in exactly
 * the position an attacker holds *after* defeating the server-side validation:
 * complete control over every field of every message. Nothing that arrives over
 * that channel may become executable markup.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { startStaticServer, launchBrowser, openPage } from './harness.js';

const PAYLOAD = '<img src=x onerror="__hit(\'fired\')">';

describe('Control view rendering (browser)', () => {
  let statics;
  let browser;

  before(async () => {
    statics = await startStaticServer();
    browser = await launchBrowser();
  });

  after(async () => {
    await browser.close();
    await statics.close();
  });

  /** Open the control page with a stubbed socket that the test drives. */
  async function openControlPage() {
    const page = await openPage(browser);
    const dialogs = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });

    await page.addInitScript(() => {
      window.__sent = [];
      window.__hits = [];
      window.__hit = (what) => window.__hits.push(what);
      class FakeWS {
        constructor() {
          this.readyState = 1;
          window.__ws = this;
          setTimeout(() => this.onopen && this.onopen(), 0);
        }
        send(data) { window.__sent.push(JSON.parse(data)); }
        close() {}
      }
      window.WebSocket = FakeWS;
      window.__push = (msg) => window.__ws.onmessage({ data: JSON.stringify(msg) });
    });

    await page.goto(`${statics.origin}/control.html?token=SECRET-TOKEN-a1b2c3&room=ROOM01`);
    await page.waitForFunction(() => window.__ws && window.__sent.length > 0);

    await page.evaluate(() =>
      window.__push({
        type: 'control_connected',
        roomId: 'ROOM01',
        state: 'results',
        quizTitle: 'Quiz',
        totalQuestions: 2,
        currentQuestionIndex: 0,
        question: null,
        participantCount: 1,
        leaderboard: []
      })
    );

    return { page, dialogs };
  }

  it('never executes markup arriving in answers, names, scores or points', async () => {
    const { page, dialogs } = await openControlPage();

    await page.evaluate((payload) =>
      window.__push({
        type: 'question_results',
        questionIndex: 0,
        answers: [
          { participantId: 'p1', name: 'Alice', answer: payload, points: 100 },
          { participantId: 'p2', name: payload, answer: 42, points: 0 },
          { participantId: 'p3', name: 'Carol', answer: [payload], points: 0 },
          // A string index: `"x" + 1` concatenates rather than adds, which is
          // what made the multiple-choice branch exploitable.
          { participantId: 'p4', name: 'Dave', answer: ['0'], points: 0 },
          { participantId: 'p5', name: 'Eve', answer: { toString: () => 'x' }, points: '<b>9</b>' }
        ],
        leaderboard: [
          { id: 'p1', name: payload, score: 100 },
          { id: 'p2', name: 'Bob', score: '<i>50</i>' }
        ]
      }, payload),
      PAYLOAD
    );
    await page.waitForTimeout(300);

    const report = await page.evaluate(() => ({
      hits: window.__hits,
      injected: document.querySelectorAll(
        '#content img, #content svg, #content script, #content iframe'
      ).length,
      resultsHtml: document.getElementById('results-content').innerHTML,
      leaderboardHtml: document.getElementById('leaderboard-content').innerHTML,
      answers: [...document.querySelectorAll('.answer-value')].map((n) => n.textContent)
    }));

    assert.deepStrictEqual(report.hits, [], 'an injected event handler executed');
    assert.deepStrictEqual(dialogs, [], 'an injected payload opened a dialog');
    assert.strictEqual(report.injected, 0, 'a payload became a live element');
    assert.ok(!report.resultsHtml.includes('<img'), 'answer payload was parsed as markup');
    assert.ok(!report.leaderboardHtml.includes('<img'), 'name payload was parsed as markup');
    // A string is a short answer: shown as the text it is, never as markup.
    // Malformed answers are shown as placeholders rather than raw values.
    assert.deepStrictEqual(report.answers, [PAYLOAD, '42', '?', '?', '(invalid answer)']);
    assert.ok(report.resultsHtml.includes('&lt;img'), 'the short answer is escaped text');

    await page.close();
  });

  it('escapes the quiz title rather than parsing it', async () => {
    const { page } = await openControlPage();
    const title = await page.evaluate(() => ({
      text: document.getElementById('quiz-title').textContent,
      html: document.getElementById('quiz-title').innerHTML
    }));
    // Set from a fixed skeleton via textContent, so markup stays visible as text.
    await page.evaluate(() =>
      window.__push({
        type: 'control_connected',
        roomId: 'ROOM01', state: 'lobby',
        quizTitle: '<img src=x onerror="__hit(\'title\')">Quiz',
        totalQuestions: 1, currentQuestionIndex: -1, question: null,
        participantCount: 0, leaderboard: []
      })
    );
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({
      html: document.getElementById('quiz-title').innerHTML,
      hits: window.__hits
    }));
    assert.ok(after.html.includes('&lt;img'), 'title was not escaped');
    assert.deepStrictEqual(after.hits, []);
    assert.ok(typeof title.text === 'string');
    await page.close();
  });

  it('renders the answer options with the correct ones marked', async () => {
    const { page } = await openControlPage();
    await page.evaluate(() =>
      window.__push({
        type: 'game_started',
        questionIndex: 0,
        question: {
          type: 'multiple-choice',
          text: 'Which are <b>connection-oriented</b>?',
          options: ['TCP', 'UDP', 'SCTP'],
          correctIndices: [0, 2]
        }
      })
    );
    await page.waitForTimeout(200);

    const view = await page.evaluate(() => ({
      bold: !!document.querySelector('#question-text b'),
      options: [...document.querySelectorAll('.question__option')].map((n) => ({
        text: n.querySelector('.question__option-text').textContent.trim(),
        correct: n.classList.contains('question__option--correct')
      }))
    }));

    assert.ok(view.bold, 'lecturer HTML in the question was not rendered');
    assert.deepStrictEqual(view.options.map((o) => o.text), ['TCP', 'UDP', 'SCTP']);
    assert.deepStrictEqual(view.options.map((o) => o.correct), [true, false, true]);
    await page.close();
  });

  it('shows the accepted answers, and groups short answers by spelling', async () => {
    const { page, dialogs } = await openControlPage();
    await page.evaluate((payload) => {
      window.__push({
        type: 'game_started',
        questionIndex: 0,
        question: {
          type: 'short-answer',
          text: 'Same name, different parameter lists?',
          acceptedAnswers: ['Overloading [of Methods]', '<b>Überladen</b>']
        }
      });
      window.__push({
        type: 'question_results',
        questionIndex: 0,
        answers: [
          { participantId: 'p1', name: 'Alice', answer: 'Overloading', points: 100 },
          { participantId: 'p2', name: 'Bob', answer: 'overloading', points: 100 },
          { participantId: 'p3', name: 'Carol', answer: 'Overloading', points: 100 },
          { participantId: 'p4', name: 'Dave', answer: 'Overriding', points: 0 },
          { participantId: 'p5', name: 'Erin', answer: 'overriding', points: 0 },
          { participantId: 'p6', name: 'Frank', answer: payload, points: 0 }
        ],
        leaderboard: []
      });
    }, PAYLOAD);
    await page.waitForTimeout(200);

    const view = await page.evaluate(() => ({
      hits: window.__hits,
      accepted: document.querySelector('.question__correct-answer').textContent,
      acceptedMarkup: !!document.querySelector('.question__correct-answer b'),
      groups: [...document.querySelectorAll('.answer-group')].map((n) => ({
        count: n.querySelector('.answer-group__count').textContent,
        text: n.querySelector('.answer-group__text').textContent,
        correct: n.classList.contains('answer-group--correct')
      })),
      injected: document.querySelectorAll('#results-content img').length,
      perParticipant: document.querySelectorAll('.answer-item').length
    }));

    assert.strictEqual(view.accepted, 'Accepted: Overloading [of Methods] · <b>Überladen</b>');
    assert.ok(!view.acceptedMarkup, 'accepted answers are plain text, not markup');
    assert.deepStrictEqual(view.groups, [
      { count: '3×', text: 'Overloading', correct: true },
      { count: '2×', text: 'Overriding', correct: false },
      { count: '1×', text: PAYLOAD, correct: false }
    ]);
    assert.strictEqual(view.perParticipant, 6, 'the per-participant list stays below the groups');
    assert.deepStrictEqual(view.hits, [], 'an injected event handler executed');
    assert.deepStrictEqual(dialogs, []);
    assert.strictEqual(view.injected, 0, 'a payload became a live element');
    await page.close();
  });

  it('lets the presenter accept a wrong group, and take that back, until the quiz moves on', async () => {
    const { page } = await openControlPage();
    const results = (acceptedByPresenter) => ({
      type: 'question_results',
      questionIndex: 0,
      answers: [
        { participantId: 'p1', name: 'Alice', answer: 'Overloading', points: 100 },
        { participantId: 'p2', name: 'Bob', answer: 'Overload', points: acceptedByPresenter ? 100 : 0,
          ...(acceptedByPresenter ? { acceptedByPresenter: true } : {}) },
        { participantId: 'p3', name: 'Carol', answer: 'Overriding', points: 0 }
      ],
      leaderboard: []
    });
    const groups = () => page.evaluate(() =>
      [...document.querySelectorAll('.answer-group')].map((n) => ({
        text: n.querySelector('.answer-group__text').textContent,
        correct: n.classList.contains('answer-group--correct'),
        note: n.querySelector('.answer-group__note')?.textContent ?? null,
        button: n.querySelector('.answer-group__toggle')?.textContent ?? null
      })));
    const clickOn = (text) => page.evaluate((text) => {
      const group = [...document.querySelectorAll('.answer-group')]
        .find((n) => n.querySelector('.answer-group__text').textContent === text);
      group.querySelector('.answer-group__toggle').click();
      return group.querySelector('.answer-group__toggle').disabled;
    }, text);

    await page.evaluate((msg) => {
      window.__push({
        type: 'game_started',
        questionIndex: 0,
        question: { type: 'short-answer', text: 'Same name?', acceptedAnswers: ['Overloading'] }
      });
      window.__push(msg);
    }, results(false));
    assert.deepStrictEqual(await groups(), [
      { text: 'Overload', correct: false, note: null, button: 'Accept' },
      { text: 'Overloading', correct: true, note: null, button: null },
      { text: 'Overriding', correct: false, note: null, button: 'Accept' }
    ]);

    // Nothing changes on screen until the server has re-scored.
    assert.strictEqual(await clickOn('Overload'), true, 'the button waits for the server');
    assert.deepStrictEqual(await page.evaluate(() => window.__sent.at(-1)),
      { type: 'accept_answer', questionIndex: 0, answer: 'Overload', accepted: true });

    await page.evaluate((msg) => window.__push(msg), results(true));
    assert.deepStrictEqual((await groups())[0],
      { text: 'Overload', correct: true, note: 'accepted by you', button: 'Undo' });

    await clickOn('Overload');
    assert.deepStrictEqual(await page.evaluate(() => window.__sent.at(-1)),
      { type: 'accept_answer', questionIndex: 0, answer: 'Overload', accepted: false });

    await page.evaluate(() => window.__push({
      type: 'question_started',
      questionIndex: 1,
      question: { type: 'short-answer', text: 'Next?', acceptedAnswers: ['x'] }
    }));
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.answer-group__toggle').length), 0,
      'the last results can no longer be re-scored');
    await page.close();
  });
});
