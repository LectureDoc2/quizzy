/**
 * What a participant of a graded quiz sees, against a real server.
 *
 * Three options of a quiz, each on its own and all together: `recordResults:
 * "all"` (name and every answer recorded, names unique), `leaderboard`
 * (nobody is shown anybody else's result) and `showCorrectAnswers` (the
 * correct answer next to the verdict). What these guard is mostly what must
 * *not* be on the page: another student's name, an unannounced recording, a
 * correct answer nobody asked to show.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createQuizServer } from '../../src/server.js';
import { startStaticServer, launchBrowser, openPage, tokenFor, connectSocket } from './harness.js';
import { loopbackHost, originFor } from '../loopback.js';

const QUESTIONS = [
  { type: 'multiple-choice', text: 'Pick the transport protocols', options: ['TCP', 'HTTP', 'UDP'], correctIndices: [0, 2] },
  { type: 'estimation', text: 'Bits in an IPv6 address?', correctAnswer: 128 },
  {
    type: 'short-answer',
    text: 'Same name, different parameter lists?',
    acceptedAnswers: ['Overloading [of Methods]', 'Überladen [von Methoden]']
  },
  { type: 'ordering', text: 'Order by size', options: ['byte', 'short', 'int'] }
];

describe('Graded quizzes (browser, full stack)', () => {
  let quizServer;
  let backendPort;
  let statics;
  let browser;
  let presenter;
  let roomId;
  const sockets = [];
  const pages = [];

  before(async () => {
    quizServer = createQuizServer({ heartbeatIntervalMs: 60_000 });
    backendPort = await quizServer.listen(0, loopbackHost());
    statics = await startStaticServer(backendPort);
    browser = await launchBrowser();
  });

  after(async () => {
    for (const ws of sockets) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    await browser?.close();
    await statics.close();
    await quizServer.close();
  });

  beforeEach(async () => {
    for (const page of pages.splice(0)) await page.close();
    for (const id of [...quizServer.roomManager.rooms.keys()]) {
      quizServer.roomManager.removeRoom(id);
    }
  });

  /** Open a room for a quiz with these options (and, unless given, all four questions). */
  async function openRoom(options = {}, questions = QUESTIONS) {
    const quiz = { title: 'Exam 1', secret: 'high-entropy', ...options, questions };
    presenter = connectSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
    sockets.push(presenter);
    await presenter.opened;
    presenter.sendJson({ type: 'create_room', presenterToken: tokenFor(`graded-${sockets.length}`, quiz), quiz });
    roomId = (await presenter.take('room_created')).roomId;
  }

  async function openJoinPage({ locale } = {}) {
    const page = await openPage(browser, { locale });
    page.on('pageerror', (e) => assert.fail(`join page error: ${e.message}`));
    pages.push(page);
    await page.goto(`${statics.origin}/join.html?room=${roomId}`);
    await page.waitForSelector('#join-form');
    return page;
  }

  async function join(name, options) {
    const page = await openJoinPage(options);
    await page.fill('#name', name);
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');
    return page;
  }

  const textOf = (page, selector) =>
    page.evaluate((selector) => document.querySelector(selector)?.textContent.trim() ?? null, selector);

  /** Wait until the recording status above the quiz says `text`. */
  const statusShows = (page, text) => page.waitForFunction(
    (text) => {
      const box = document.getElementById('consent-status');
      return box && !box.hidden && box.textContent.includes(text);
    },
    text
  );

  describe('recordResults: "all"', () => {
    it('says before joining that name and answers are recorded, and asks nothing', async () => {
      await openRoom({ recordResults: 'all' });
      const page = await openJoinPage();
      const form = await page.evaluate(() => {
        const notice = document.getElementById('graded-notice');
        const name = document.getElementById('name');
        return {
          notice: notice?.textContent ?? null,
          // Above the name field, where it is read before anything is typed.
          noticeBeforeName: !!notice &&
            !!(notice.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING),
          noticeVisible: !!notice && notice.getBoundingClientRect().height > 0,
          placeholder: name.placeholder,
          consentBox: !!document.getElementById('consent'),
          privacy: document.getElementById('join-privacy').textContent
        };
      });
      assert.match(form.notice, /^This quiz is graded\./);
      assert.match(form.notice, /every answer you give are recorded and handed to your lecturer for grading/);
      assert.ok(form.noticeBeforeName);
      assert.ok(form.noticeVisible);
      assert.strictEqual(form.placeholder, 'Your full name or matriculation number');
      assert.strictEqual(form.consentBox, false, 'there is nothing to consent to: recording is not optional');
      assert.match(form.privacy, /does not store them permanently/);
    });

    it('keeps saying it for the whole quiz, without anything to switch off', async () => {
      await openRoom({ recordResults: 'all' });
      const page = await join('Alice Adams');
      await statusShows(page, 'your name and all your answers are recorded for grading');
      assert.strictEqual(await page.$('#consent-toggle'), null);

      presenter.sendJson({ type: 'start_game' });
      await page.waitForSelector('.question__text');
      await statusShows(page, 'are recorded for grading');

      presenter.sendJson({ type: 'end_game' });
      await page.waitForSelector('.results h2');
      await statusShows(page, 'were recorded for grading');
      assert.strictEqual(await page.$('#consent-toggle'), null);
    });

    it('says none of it in a quiz that does not record everything', async () => {
      for (const options of [{}, { recordResults: 'none' }, { recordResults: 'named' }]) {
        await openRoom(options);
        const page = await openJoinPage();
        assert.strictEqual(await page.$('#graded-notice'), null);
        assert.strictEqual(await page.getAttribute('#name', 'placeholder'), 'Enter your name');
        assert.doesNotMatch(await textOf(page, '#join-privacy'), /lecturer has downloaded/);
      }
    });

    it('turns a second student with the same name away, on the form', async () => {
      await openRoom({ recordResults: 'all' });
      await join('Alice Adams');

      const second = await openJoinPage();
      await second.fill('#name', 'alice adams');
      await second.click('#join-btn');
      await second.waitForFunction(() => {
        const el = document.getElementById('name-error');
        return el && el.style.display === 'block' && el.textContent.length > 0;
      });
      assert.match(await textOf(second, '#name-error'), /^This name is already in use in this quiz\./);
      assert.match(await textOf(second, '#name-error'), /ask your lecturer to release it/);
      assert.ok(await second.$('#join-form'), 'the form survives, for another name');
      assert.ok(await second.$('#graded-notice'), 'and so does the notice');

      // The same socket takes another name.
      await second.fill('#name', 'Alice Adamson');
      await second.click('#join-btn');
      await second.waitForSelector('.waiting');
      assert.strictEqual(quizServer.roomManager.getRoom(roomId).getParticipantCount(), 2);
    });

    it('says it in German to a German browser', async () => {
      await openRoom({ recordResults: 'all' });
      const first = await join('Erika Mustermann', { locale: 'de-DE' });
      await statusShows(first, 'Benotetes Quiz: Ihr Name und alle Ihre Antworten werden zur Bewertung erfasst.');

      const page = await openJoinPage({ locale: 'de-DE' });
      assert.match(await textOf(page, '#graded-notice'), /^Dieses Quiz wird benotet\./);
      assert.strictEqual(await page.getAttribute('#name', 'placeholder'), 'Ihr vollständiger Name oder Ihre Matrikelnummer');
      await page.fill('#name', 'Erika Mustermann');
      await page.click('#join-btn');
      await page.waitForFunction(() => document.getElementById('name-error')?.style.display === 'block');
      assert.match(await textOf(page, '#name-error'), /^Dieser Name wird in diesem Quiz bereits verwendet\./);
    });
  });

  describe('leaderboard', () => {
    /** Alice answers the first question right, Bob wrong; both see its results. */
    async function playFirstQuestion() {
      const alice = await join('Alice Adams');
      const bob = await join('Bob Brown');
      presenter.sendJson({ type: 'start_game' });
      for (const page of [alice, bob]) await page.waitForSelector('.option');
      await alice.click('.option[data-index="0"]');
      await alice.click('.option[data-index="2"]');
      await alice.click('#submit-btn');
      await bob.click('.option[data-index="1"]');
      await bob.click('#submit-btn'); // the last answer closes the question
      for (const page of [alice, bob]) await page.waitForSelector('.feedback');
      return { alice, bob };
    }

    const standing = (page) => page.evaluate(() => ({
      stats: document.querySelector('.my-stats').textContent.trim(),
      board: [...document.querySelectorAll('.leaderboard__name')].map((n) => n.textContent),
      text: document.body.textContent
    }));

    it('shows everybody, as before, unless the quiz says otherwise', async () => {
      await openRoom();
      const { alice, bob } = await playFirstQuestion();
      assert.deepStrictEqual((await standing(alice)).board, ['Alice Adams', 'Bob Brown']);
      assert.strictEqual((await standing(alice)).stats, 'Your rank: 1 | Score: 100');
      assert.strictEqual((await standing(bob)).stats, 'Your rank: 2 | Score: 0');
    });

    it('"none": a student sees their own score and verdict, and nobody else at all', async () => {
      await openRoom({ leaderboard: 'none' });
      const { alice, bob } = await playFirstQuestion();

      const forAlice = await standing(alice);
      assert.strictEqual(forAlice.stats, 'Score: 100');
      assert.deepStrictEqual(forAlice.board, [], 'no leaderboard');
      assert.ok(!forAlice.text.includes('Bob'), 'another student\'s name is nowhere on the page');
      assert.ok(!/rank/i.test(forAlice.stats));
      assert.strictEqual(await textOf(alice, '.feedback__verdict'), 'Correct!');

      const forBob = await standing(bob);
      assert.strictEqual(forBob.stats, 'Score: 0');
      assert.deepStrictEqual(forBob.board, []);
      assert.ok(!forBob.text.includes('Alice'));
      assert.strictEqual(await textOf(bob, '.feedback__verdict'), 'Not quite.');

      // The final screen follows the same rule.
      presenter.sendJson({ type: 'end_game' });
      for (const page of [alice, bob]) await page.waitForSelector('.results h2');
      const finalForBob = await standing(bob);
      assert.strictEqual(finalForBob.stats, 'Score: 0');
      assert.deepStrictEqual(finalForBob.board, []);
      assert.ok(!finalForBob.text.includes('Alice'));
    });

    it('"rank-only": a student also sees their place, and still nobody else', async () => {
      await openRoom({ leaderboard: 'rank-only' });
      const { alice, bob } = await playFirstQuestion();

      const forAlice = await standing(alice);
      assert.strictEqual(forAlice.stats, 'Your rank: 1 of 2 | Score: 100');
      assert.deepStrictEqual(forAlice.board, []);
      assert.ok(!forAlice.text.includes('Bob'));

      const forBob = await standing(bob);
      assert.strictEqual(forBob.stats, 'Your rank: 2 of 2 | Score: 0');
      assert.ok(!forBob.text.includes('Alice'));

      presenter.sendJson({ type: 'end_game' });
      await bob.waitForSelector('.results h2');
      assert.strictEqual((await standing(bob)).stats, 'Your rank: 2 of 2 | Score: 0');
      assert.deepStrictEqual((await standing(bob)).board, []);
    });

    it('"rank-only", in German', async () => {
      await openRoom({ leaderboard: 'rank-only' });
      const page = await join('Erika Mustermann', { locale: 'de-DE' });
      presenter.sendJson({ type: 'start_game' });
      await page.waitForSelector('.option');
      await page.click('#submit-btn');
      await page.waitForSelector('.feedback');
      assert.strictEqual(await textOf(page, '.my-stats'), 'Ihr Rang: 1 von 1 | Punkte: 0');
    });
  });

  describe('showCorrectAnswers', () => {
    /** Join alone and answer all four questions wrong, collecting each results screen. */
    async function answerEverythingWrong(options, pageOptions) {
      await openRoom(options);
      const page = await join('Curious Student', pageOptions);
      const screens = [];
      const snapshot = async () => {
        await page.waitForSelector('.feedback');
        screens.push(await page.evaluate(() => ({
          verdict: document.querySelector('.feedback__verdict').textContent.trim(),
          expected: [...document.querySelectorAll('.feedback__expected')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
          options: [...document.querySelectorAll('.feedback__option')].map((o) => ({
            selected: o.classList.contains('option--selected'),
            marked: o.classList.contains('feedback__option--expected'),
            tag: o.querySelector('.feedback__expected-tag')?.textContent ?? null
          })),
          correctOrder: [...document.querySelectorAll('.ordering--expected .ordering__content')].map((n) => n.textContent.trim()),
          ownOrder: [...document.querySelectorAll('.ordering--feedback:not(.ordering--expected) .ordering__content')].map((n) => n.textContent.trim())
        })));
      };

      presenter.sendJson({ type: 'start_game' });
      await page.waitForSelector('.option');
      await page.click('.option[data-index="1"]');
      await page.click('#submit-btn');
      await snapshot();

      presenter.sendJson({ type: 'next_question' });
      await page.waitForSelector('#answer');
      await page.fill('#answer', '64');
      await page.click('#answer-form button');
      await page.waitForSelector('.feedback__estimate');
      await snapshot();

      presenter.sendJson({ type: 'next_question' });
      await page.waitForSelector('#answer-length');
      await page.fill('#answer', 'Overriding');
      await page.click('#submit-btn');
      await page.waitForSelector('.feedback__answer');
      await snapshot();

      presenter.sendJson({ type: 'next_question' });
      await page.waitForSelector('#ordering');
      // Shuffled, and never shown in the correct order: as it stands, it is wrong.
      await page.click('#submit-btn');
      await page.waitForSelector('.ordering--feedback');
      await snapshot();
      return screens;
    }

    it('shows nothing but the verdict unless the quiz says so', async () => {
      const screens = await answerEverythingWrong({});
      for (const screen of screens) {
        assert.deepStrictEqual(screen.expected, []);
        assert.deepStrictEqual(screen.correctOrder, []);
        assert.ok(screen.options.every((o) => !o.marked && o.tag === null));
      }
    });

    it('shows the correct answer to each kind of question next to the verdict', async () => {
      const [choice, estimate, term, order] = await answerEverythingWrong({ showCorrectAnswers: true });

      assert.strictEqual(choice.verdict, 'Not quite.');
      assert.deepStrictEqual(choice.options, [
        { selected: false, marked: true, tag: 'Correct answer' },
        { selected: true, marked: false, tag: null },
        { selected: false, marked: true, tag: 'Correct answer' }
      ]);

      assert.deepStrictEqual(estimate.expected, ['Correct answer: 128']);

      assert.strictEqual(term.verdict, 'Not quite.');
      // Written out: the brackets are the author's notation, not an answer.
      assert.deepStrictEqual(term.expected, ['Accepted answers: Overloading of Methods · Überladen von Methoden']);

      assert.strictEqual(order.verdict, 'Not quite.');
      assert.deepStrictEqual(order.expected, ['Correct order:']);
      assert.deepStrictEqual(order.correctOrder, ['byte', 'short', 'int']);
      assert.notDeepStrictEqual(order.ownOrder, ['byte', 'short', 'int']);
      assert.strictEqual(order.ownOrder.length, 3);
    });

    it('shows it in German', async () => {
      const [choice, estimate, term, order] =
        await answerEverythingWrong({ showCorrectAnswers: true }, { locale: 'de-DE' });
      assert.strictEqual(choice.options[0].tag, 'Richtige Antwort');
      assert.deepStrictEqual(estimate.expected, ['Richtige Antwort: 128']);
      assert.deepStrictEqual(term.expected, ['Akzeptierte Antworten: Overloading of Methods · Überladen von Methoden']);
      assert.deepStrictEqual(order.expected, ['Richtige Reihenfolge:']);
    });

    it('does not repeat an order that was already the correct one', async () => {
      await openRoom({ showCorrectAnswers: true }, [QUESTIONS[3]]);
      const page = await join('Careful Student');
      presenter.sendJson({ type: 'start_game' });
      await page.waitForSelector('#ordering');
      // Sort the items by moving each one up to its place.
      for (const item of ['byte', 'short', 'int']) {
        for (;;) {
          const order = await page.evaluate(() =>
            [...document.querySelectorAll('#ordering .ordering__content')].map((n) => n.textContent.trim()));
          const from = order.indexOf(item);
          const to = ['byte', 'short', 'int'].indexOf(item);
          if (from <= to) break;
          await page.click(`#ordering .ordering__item:nth-child(${from + 1}) [data-move="-1"]`);
        }
      }
      await page.click('#submit-btn');
      await page.waitForSelector('.feedback__verdict');
      assert.strictEqual(await textOf(page, '.feedback__verdict'), 'Correct!');
      assert.strictEqual(await page.$('.ordering--expected'), null);
      assert.strictEqual(await page.$('.feedback__expected'), null);
    });
  });

  it('all three together: a graded quiz without a leaderboard that shows the correct answers', async () => {
    await openRoom({ recordResults: 'all', leaderboard: 'none', showCorrectAnswers: true });
    const alice = await join('Alice Adams');
    const bob = await join('7654321');
    presenter.sendJson({ type: 'start_game' });
    for (const page of [alice, bob]) await page.waitForSelector('.option');
    await alice.click('.option[data-index="1"]');
    await alice.click('#submit-btn');
    await bob.click('.option[data-index="0"]');
    await bob.click('.option[data-index="2"]');
    await bob.click('#submit-btn');
    await alice.waitForSelector('.feedback');

    await statusShows(alice, 'are recorded for grading');
    assert.strictEqual(await textOf(alice, '.my-stats'), 'Score: 0');
    assert.strictEqual(await alice.$('.leaderboard'), null);
    assert.ok(!(await alice.evaluate(() => document.body.textContent)).includes('7654321'));
    assert.strictEqual(await alice.locator('.feedback__expected-tag').count(), 2);
  });
});
