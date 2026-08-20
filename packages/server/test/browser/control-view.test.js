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
import { startStaticServer, launchBrowser } from './harness.js';

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
    const page = await browser.newPage();
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
    // Malformed answers are shown as placeholders rather than raw values.
    assert.deepStrictEqual(report.answers, ['(invalid answer)', '42', '?', '?', '(invalid answer)']);

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
});
