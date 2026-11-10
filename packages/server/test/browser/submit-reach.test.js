/**
 * The question screen on a phone: Submit at the end of a long question, the
 * space above the question, and the time left.
 *
 * The bug this guards: students on iPhones tapped Submit and nothing happened;
 * Safari's toolbar popped up instead. Safari draws the page on underneath its
 * bottom toolbar, but a tap below the page's viewport -- below innerHeight --
 * goes to Safari, not to the page. Measured in the iOS 27.2 Simulator: with the
 * toolbar shrunk, that is the bottom 58pt of the screen.
 *
 * What the page does about it, and these tests hold on to:
 *  - Scrolled to the end, Submit ends well clear of the bottom edge. The
 *    footer under it (room and progress) provides the space.
 *  - Little is spent above the question, so that more questions fit the
 *    screen and need no scrolling at all. The progress went to the footer, the
 *    time left into Submit.
 *
 * Playwright's browsers have no toolbar, so the lost tap itself cannot be
 * reproduced here; these are checks on the layout that avoids it. Halfway
 * down, Submit can still pass through the strip -- nothing that stays in place
 * can prevent that. A sticky Submit did, but it moved with Safari's toolbar,
 * away from under the finger about to press it.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createQuizServer } from '../../src/server.js';
import { startStaticServer, launchBrowser, openPage, tokenFor, connectSocket } from './harness.js';
import { loopbackHost, originFor } from '../loopback.js';

/** How far above the viewport's bottom edge Submit must end, at the end of the page. */
const CLEARANCE_PX = 72; // the 58pt strip, and a margin

/** How far down a phone may start the question text, scrolled to the top. */
const QUESTION_TOP_PX = 100;

const PHONES = {
  'a 6.3" phone': { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
  'a small phone': { hasTouch: true, isMobile: true, viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 }
};

const LONG_TEXT =
  'A server takes requests from many clients at once. Each request is handled by a worker ' +
  'thread from a fixed-size pool; when the pool is exhausted, new requests wait in a bounded ' +
  'queue. Consider the configuration below and decide which of the statements are correct.' +
  '<pre><code>pool.size = 8\nqueue.capacity = 100\nrequest.timeout = 30s\nkeepAlive = true</code></pre>';

const STATEMENTS = [
  'At most eight requests are processed at the same time.',
  'The ninth concurrent request is rejected immediately with an error.',
  'Up to one hundred requests can wait while all workers are busy.',
  'A request that waits longer than thirty seconds in the queue may time out.',
  'Keep-alive means that each request opens a fresh TCP connection.',
  'Increasing the queue capacity always reduces the response time.',
  'A larger pool can increase throughput if requests mostly wait for I/O.',
  'The configuration guarantees that no request is ever dropped.'
];

/** For the questions whose answer is a single field: the length is all in the text. */
const WALL_OF_TEXT = `${LONG_TEXT} ${STATEMENTS.join(' ')} ${STATEMENTS.join(' ')}`;

/** Long enough to scroll on either phone, whatever the type. */
const LONG = {
  'multiple-choice': { type: 'multiple-choice', text: LONG_TEXT, options: STATEMENTS, correctIndices: [0, 2, 3, 6] },
  ordering: { type: 'ordering', text: `${LONG_TEXT} Order the statements as listed.`, options: STATEMENTS },
  'short-answer': {
    type: 'short-answer',
    text: `${WALL_OF_TEXT} Where do waiting requests go?`,
    acceptedAnswers: ['Queue']
  },
  estimation: {
    type: 'estimation',
    text: `${WALL_OF_TEXT} How many requests can be in the system at once?`,
    correctAnswer: 108
  }
};

describe('Question screen on a phone (browser, full stack)', () => {
  let quizServer;
  let backendPort;
  let statics;
  let browser;
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

  /** A participant on the room's only question, in a page with the given options. */
  async function onQuestion(question, options) {
    const quiz = { title: 'Thread Pools', secret: 'high-entropy', questions: [question] };
    const presenter = connectSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
    sockets.push(presenter);
    await presenter.opened;
    presenter.sendJson({ type: 'create_room', presenterToken: tokenFor(`reach-${sockets.length}`, quiz), quiz });
    const { roomId } = await presenter.take('room_created');

    const page = await openPage(browser, options);
    pages.push(page);
    await page.goto(`${statics.origin}/join.html?room=${roomId}`);
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Alice Adams');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');
    presenter.sendJson({ type: 'start_game' });
    await page.waitForSelector('#submit-btn');
    return { page, roomId };
  }

  /** Scrolled to the very end: where Submit is against the viewport. */
  const submitAtEnd = (page) =>
    page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const button = document.getElementById('submit-btn');
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        scrolls: document.documentElement.scrollHeight > window.innerHeight + 100,
        top: box.top,
        bottom: box.bottom,
        innerHeight: window.innerHeight,
        onTop: hit === button || button.contains(hit)
      };
    });

  for (const [phone, options] of Object.entries(PHONES)) {
    for (const [type, question] of Object.entries(LONG)) {
      it(`leaves room under ${type} Submit at the end of a long question on ${phone}`, async () => {
        const { page } = await onQuestion(question, options);
        const at = await submitAtEnd(page);
        assert.ok(at.scrolls, 'the question fits the screen, so nothing is tested');
        assert.ok(at.top >= 0, `Submit starts above the screen (${at.top})`);
        assert.ok(
          at.bottom <= at.innerHeight - CLEARANCE_PX,
          `Submit ends at ${at.bottom}, within ${CLEARANCE_PX}px of the bottom edge (${at.innerHeight}), ` +
          'where Safari takes the tap'
        );
        assert.ok(at.onTop, 'something covers Submit');
      });
    }
  }

  it('takes a tap on Submit at the end of a long question', async () => {
    const { page } = await onQuestion(LONG['multiple-choice'], PHONES['a small phone']);
    await page.tap('#options .option:first-child');
    await page.waitForSelector('#options .option:first-child.option--selected', { timeout: 3000 });
    await submitAtEnd(page);
    // A finger where the button is shown; page.tap() would scroll it first.
    const centre = await page.$eval('#submit-btn', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.touchscreen.tap(centre.x, centre.y);
    await page.waitForFunction(
      () => document.getElementById('content').textContent.includes('Answer submitted'),
      null,
      { timeout: 3000 }
    );
  });

  it('starts the question near the top, with room and progress in the footer', async () => {
    const { page, roomId } = await onQuestion(LONG['multiple-choice'], PHONES['a small phone']);
    const view = await page.evaluate(() => {
      window.scrollTo(0, 0);
      const footer = document.querySelector('.quiz-footer');
      return {
        questionTop: document.getElementById('question-text').getBoundingClientRect().top,
        contentText: document.getElementById('content').textContent,
        progress: document.getElementById('question-progress').textContent,
        progressShown: !document.getElementById('question-progress').hidden,
        room: footer.querySelector('.room-code').textContent.replace(/\s+/g, ' ').trim(),
        footerBelowContent: footer.getBoundingClientRect().top >= document.getElementById('content').getBoundingClientRect().bottom
      };
    });
    assert.ok(view.questionTop <= QUESTION_TOP_PX, `the question starts ${view.questionTop}px down`);
    assert.doesNotMatch(view.contentText, /Question 1 of 1/, 'the progress is still above the question');
    assert.deepStrictEqual(
      { progress: view.progress, progressShown: view.progressShown, room: view.room, footerBelowContent: view.footerBelowContent },
      { progress: 'Question 1 of 1', progressShown: true, room: `Room: ${roomId}`, footerBelowContent: true }
    );
  });

  describe('the time left, in Submit', () => {
    const timed = (timeLimit) => ({ type: 'multiple-choice', text: 'Pick one', options: ['TCP', 'UDP'], correctIndices: [0], timeLimit });
    const button = (page) => page.$eval('#submit-btn', (el) => ({
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      urgent: el.classList.contains('submit--urgent'),
      background: getComputedStyle(el).backgroundColor,
      timeHidden: el.querySelector('.submit__time')?.getAttribute('aria-hidden') ?? null
    }));

    it('counts down in the button and keeps its name "Submit"', async () => {
      const { page } = await onQuestion(timed(60), PHONES['a 6.3" phone']);
      const first = await button(page);
      assert.match(first.text, /^Submit \((\d+) sec\. left\)$/);
      assert.strictEqual(first.timeHidden, 'true');
      assert.strictEqual(first.urgent, false);
      assert.strictEqual(await page.getByRole('button', { name: 'Submit', exact: true }).count(), 1);
      assert.strictEqual(await page.$('.timer, #timer'), null, 'a separate timer is still shown');

      const seconds = Number(first.text.match(/\d+/)[0]);
      await page.waitForFunction(
        (before) => Number(document.querySelector('#submit-btn .submit__time').textContent.match(/\d+/)[0]) < before,
        seconds,
        { timeout: 3000 }
      );
    });

    it('speaks German to a German browser', async () => {
      const { page } = await onQuestion(timed(60), { ...PHONES['a 6.3" phone'], locale: 'de-DE' });
      assert.match((await button(page)).text, /^Absenden \(noch \d+ Sek\.\)$/);
    });

    it('turns red for the last five seconds', async () => {
      const { page } = await onQuestion(timed(5), PHONES['a 6.3" phone']);
      const now = await button(page);
      assert.strictEqual(now.urgent, true);
      assert.strictEqual(now.background, 'rgb(220, 38, 38)');
    });

    it('says just "Submit" without a time limit', async () => {
      const { page } = await onQuestion(timed(0), PHONES['a 6.3" phone']);
      const now = await button(page);
      assert.deepStrictEqual({ text: now.text, timeHidden: now.timeHidden }, { text: 'Submit', timeHidden: null });
    });
  });

  it('leaves Submit in its place under the options of a question that fits the screen', async () => {
    const short = { type: 'multiple-choice', text: 'Pick one', options: ['TCP', 'UDP'], correctIndices: [0] };
    const { page } = await onQuestion(short, PHONES['a 6.3" phone']);
    const gap = await page.evaluate(() => {
      const options = document.querySelectorAll('#options .option');
      return document.getElementById('submit-btn').getBoundingClientRect().top -
        options[options.length - 1].getBoundingClientRect().bottom;
    });
    assert.strictEqual(Math.round(gap), 16);
    assert.strictEqual(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), true);
  });
});
