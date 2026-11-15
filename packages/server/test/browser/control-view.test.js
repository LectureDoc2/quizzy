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
    await browser?.close();
    await statics.close();
  });

  /**
   * Open the control page with a stubbed socket that the test drives.
   *
   * @param {object} [connected] Fields of `control_connected` to set or replace.
   */
  async function openControlPage(connected = {}) {
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

    await page.evaluate((connected) =>
      window.__push({
        type: 'control_connected',
        roomId: 'ROOM01',
        state: 'results',
        quizTitle: 'Quiz',
        totalQuestions: 2,
        currentQuestionIndex: 0,
        question: null,
        participantCount: 1,
        leaderboard: [],
        ...connected
      }),
      connected
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

  it('shows an ordering question\'s correct order, and each answer as its items', async () => {
    const { page, dialogs } = await openControlPage();
    await page.evaluate((payload) => {
      window.__push({
        type: 'game_started',
        questionIndex: 0,
        question: {
          type: 'ordering',
          text: 'Order by value range',
          options: ['<code>byte</code>', '<code>short</code>', '<code>int</code>']
        }
      });
      window.__push({
        type: 'question_results',
        questionIndex: 0,
        answers: [
          { participantId: 'p1', name: 'Alice', answer: [0, 1, 2], points: 100 },
          { participantId: 'p2', name: 'Bob', answer: [2, 0, 1], points: 0 },
          // Malformed, as only a subverted server could send it.
          { participantId: 'p3', name: 'Carol', answer: [payload, '1', 7], points: 0 }
        ],
        leaderboard: []
      });
    }, PAYLOAD);
    await page.waitForTimeout(200);

    const view = await page.evaluate(() => ({
      hits: window.__hits,
      label: document.querySelector('.question__correct-answer').textContent,
      order: [...document.querySelectorAll('.question__option')].map((n) => ({
        text: n.textContent.trim(),
        code: !!n.querySelector('code')
      })),
      answers: [...document.querySelectorAll('.answer-value')].map((n) => n.textContent),
      injected: document.querySelectorAll('#results-content img').length
    }));

    assert.strictEqual(view.label, 'Correct order:');
    assert.deepStrictEqual(view.order, [
      { text: 'byte', code: true },
      { text: 'short', code: true },
      { text: 'int', code: true }
    ]);
    assert.deepStrictEqual(view.answers, ['byte → short → int', 'int → byte → short', '? → ? → ?']);
    assert.deepStrictEqual(view.hits, []);
    assert.deepStrictEqual(dialogs, []);
    assert.strictEqual(view.injected, 0);
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
  describe('ending the quiz', () => {
    const dialogState = (page) => page.evaluate(() => {
      const dialog = document.querySelector('dialog.confirm-dialog');
      if (!dialog) return null;
      return {
        open: dialog.open,
        modal: dialog.matches(':modal'),
        title: dialog.querySelector('.confirm-dialog__title').textContent,
        text: dialog.querySelector('.confirm-dialog__text').textContent,
        buttons: [...dialog.querySelectorAll('button')].map((b) => b.textContent),
        focused: document.activeElement?.textContent ?? null
      };
    });
    const sentEndGame = (page) => page.evaluate(() => window.__sent.filter((m) => m.type === 'end_game').length);

    it('asks before ending a quiz that has questions left, and ends it only on a yes', async () => {
      // On the results of question 1 of 3.
      const { page } = await openControlPage({ totalQuestions: 3 });
      await page.click('#btn-end-game');
      assert.deepStrictEqual(await dialogState(page), {
        open: true,
        modal: true,
        title: 'End the quiz now?',
        text: 'Questions 2 to 3 have not been played yet. Ending the quiz cannot be undone.',
        buttons: ['Continue quiz', 'End quiz'],
        // A stray Enter must not end the quiz.
        focused: 'Continue quiz'
      });
      assert.strictEqual(await sentEndGame(page), 0, 'nothing is sent while the question is open');

      await page.click('#confirm-dialog-cancel');
      assert.strictEqual(await dialogState(page), null, 'the dialog is gone');
      assert.strictEqual(await sentEndGame(page), 0, '"Continue quiz" ends nothing');

      // Escape is a no as well.
      await page.click('#btn-end-game');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.confirm-dialog'));
      assert.strictEqual(await sentEndGame(page), 0);

      await page.click('#btn-end-game');
      await page.click('#confirm-dialog-confirm');
      assert.strictEqual(await dialogState(page), null);
      assert.strictEqual(await sentEndGame(page), 1);
    });

    it('names the one question that is left', async () => {
      const { page } = await openControlPage(); // question 1 of 2
      await page.click('#btn-end-game');
      assert.strictEqual((await dialogState(page)).text,
        'Question 2 has not been played yet. Ending the quiz cannot be undone.');
    });

    it('does not ask after the last question', async () => {
      const { page } = await openControlPage({ currentQuestionIndex: 1 }); // question 2 of 2
      await page.click('#btn-end-game');
      assert.strictEqual(await dialogState(page), null, 'no dialog');
      assert.strictEqual(await sentEndGame(page), 1);
    });
  });

  describe('the options of a quiz', () => {
    const optionLines = (page) => page.evaluate(() => {
      const list = document.getElementById('quiz-options');
      return list.hidden ? null : [...list.querySelectorAll('li')].map((li) => li.textContent);
    });

    it('says nothing for a quiz that sets none, and shows no participant list', async () => {
      for (const options of [undefined, { recordResults: 'none', leaderboard: 'complete', showCorrectAnswers: false }]) {
        const { page } = await openControlPage(options ? { options } : {});
        assert.strictEqual(await optionLines(page), null);
        await page.evaluate(() => window.__push({
          type: 'participants_list',
          participants: [{ id: 'p1', name: 'Alice', score: 0, connected: true }]
        }));
        assert.strictEqual(
          await page.evaluate(() => document.getElementById('participants-panel').style.display), 'none');
      }
    });

    it('says what participants will not see and what is recorded', async () => {
      const { page } = await openControlPage({
        options: { recordResults: 'all', leaderboard: 'rank-only', showCorrectAnswers: true }
      });
      const lines = await optionLines(page);
      assert.strictEqual(lines.length, 3);
      assert.match(lines[0], /^Graded: every participant's name and answers are recorded/);
      assert.match(lines[1], /do not see the leaderboard, only their own score and rank/);
      assert.match(lines[2], /shown the correct answer after each question/);

      const none = await openControlPage({ options: { recordResults: 'named', leaderboard: 'none', showCorrectAnswers: false } });
      const noneLines = await optionLines(none.page);
      assert.strictEqual(noneLines.length, 2);
      assert.match(noneLines[0], /can agree to have their name and final score/);
      assert.match(noneLines[1], /only their own score\.$/);
    });
  });

  describe('the participants of a graded quiz', () => {
    const GRADED = { options: { recordResults: 'all', leaderboard: 'complete', showCorrectAnswers: false } };
    const PARTICIPANTS = [
      { id: 'p2', name: 'Bob Brown', score: 0, connected: false },
      { id: 'p1', name: 'Alice Adams', score: 100, connected: true },
      { id: 'p3', name: 'Carol Clark', score: 100, connected: false, left: true },
      { id: 'p4', name: 'Dave Dunn', score: 0, connected: false, left: true, removed: true },
      { id: 'p5', name: PAYLOAD, score: 0, connected: true }
    ];
    const rows = (page) => page.evaluate(() =>
      [...document.querySelectorAll('.participants-list__item')].map((item) => ({
        name: item.querySelector('.participants-list__name').textContent,
        state: item.querySelector('.participants-list__state').textContent,
        score: item.querySelector('.participants-list__score').textContent,
        remove: !!item.querySelector('.participants-list__remove')
      })));

    it('lists everybody with a record, by name, and never parses a name as markup', async () => {
      const { page, dialogs } = await openControlPage(GRADED);
      await page.evaluate((participants) => window.__push({ type: 'participants_list', participants }), PARTICIPANTS);
      assert.deepStrictEqual(await rows(page), [
        { name: PAYLOAD, state: 'connected', score: '0', remove: true },
        { name: 'Alice Adams', state: 'connected', score: '100', remove: true },
        { name: 'Bob Brown', state: 'reconnecting', score: '0', remove: true },
        { name: 'Carol Clark', state: 'left', score: '100', remove: true },
        // Already removed: nothing left to do.
        { name: 'Dave Dunn', state: 'removed', score: '0', remove: false }
      ]);
      assert.deepStrictEqual(await page.evaluate(() => window.__hits), []);
      assert.deepStrictEqual(dialogs, []);
      // Somebody who left for good is not "reconnecting".
      assert.strictEqual(
        await page.evaluate(() => document.getElementById('participants-reconnecting').textContent),
        ' \u00b7 1 reconnecting');
    });

    it('removes a participant only after asking, and says what happens to their answers', async () => {
      const { page } = await openControlPage(GRADED);
      await page.evaluate((participants) => window.__push({ type: 'participants_list', participants }), PARTICIPANTS);
      const clickRemove = (name) => page.evaluate((name) => {
        [...document.querySelectorAll('.participants-list__item')]
          .find((item) => item.querySelector('.participants-list__name').textContent === name)
          .querySelector('.participants-list__remove').click();
      }, name);
      const kicks = () => page.evaluate(() => window.__sent.filter((m) => m.type === 'kick_participant'));

      await clickRemove('Carol Clark');
      const dialog = await page.evaluate(() => ({
        title: document.querySelector('.confirm-dialog__title').textContent,
        text: document.querySelector('.confirm-dialog__text').textContent
      }));
      assert.strictEqual(dialog.title, 'Remove Carol Clark?');
      assert.match(dialog.text, /name becomes free/);
      assert.match(dialog.text, /stay in the results file, marked as removed/);
      await page.click('#confirm-dialog-cancel');
      assert.deepStrictEqual(await kicks(), []);

      await clickRemove('Carol Clark');
      await page.click('#confirm-dialog-confirm');
      assert.deepStrictEqual(await kicks(), [{ type: 'kick_participant', participantId: 'p3' }]);
      // And the list is asked for again, to show what the server made of it.
      await page.waitForFunction(() => window.__sent.filter((m) => m.type === 'get_participants').length >= 2);
    });

    it('offers no removal once the quiz has ended', async () => {
      const { page } = await openControlPage({ ...GRADED, state: 'ended' });
      await page.evaluate((participants) => window.__push({ type: 'participants_list', participants }), PARTICIPANTS);
      assert.ok((await rows(page)).every((row) => !row.remove));
    });
  });
});
