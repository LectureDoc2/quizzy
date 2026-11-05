/**
 * Ordering questions on the join page, against a real server: mouse, touch and
 * keyboard, and what happens to a drag when the connection drops under it.
 *
 * Touch is driven through the DevTools protocol, which feeds the browser's
 * real input pipeline -- touch-action, pointer capture and all -- because
 * Playwright has no touch-drag API of its own.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createQuizServer } from '../../src/server.js';
import { startStaticServer, launchBrowser, openPage, tokenFor, connectSocket } from './harness.js';
import { loopbackHost, originFor } from '../loopback.js';

const ITEMS = ['byte', 'short', 'int', 'long'];
const QUIZ = {
  title: 'Java Types',
  secret: 'high-entropy',
  questions: [{
    type: 'ordering',
    text: 'Order the data types by value range (ascending).',
    options: ITEMS.map((t) => `<code>${t}</code>`),
    timeLimit: 0
  }]
};

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 };
const RECONNECT_TIMEOUT = 8000;

describe('Ordering questions (browser, full stack)', () => {
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
    await browser.close();
    await statics.close();
    await quizServer.close();
  });

  beforeEach(async () => {
    for (const page of pages.splice(0)) await page.close();
    for (const id of [...quizServer.roomManager.rooms.keys()]) {
      quizServer.roomManager.removeRoom(id);
    }
    presenter = connectSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
    sockets.push(presenter);
    await presenter.opened;
    presenter.sendJson({ type: 'create_room', presenterToken: tokenFor(`order-${sockets.length}`, QUIZ), quiz: QUIZ });
    roomId = (await presenter.take('room_created')).roomId;
  });

  /** A participant on the question, in a page with the given options. */
  async function onQuestion(options = {}) {
    const page = await openPage(browser, options);
    pages.push(page);
    await page.goto(`${statics.origin}/join.html?room=${roomId}`);
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Alice Adams');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');
    presenter.sendJson({ type: 'start_game' });
    await page.waitForSelector('#ordering');
    return page;
  }

  const settled = (page) =>
    page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));

  const shownOrder = (page) =>
    page.$$eval('#ordering .ordering__content', (nodes) => nodes.map((n) => n.textContent.trim()));

  /** Where each item, its handle and its content are, in viewport pixels. */
  async function boxes(page) {
    await settled(page);
    return page.$$eval('#ordering .ordering__item', (items) => items.map((item) => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      return {
        ...box(item),
        handle: box(item.querySelector('.ordering__handle')),
        content: box(item.querySelector('.ordering__content'))
      };
    }));
  }

  /** From the centre of `grip` in item `from`, onto the place of item `to`. */
  async function dragPath(page, from, to, grip) {
    const all = await boxes(page);
    const source = all[from];
    const target = all[to];
    const x = source[grip].x + source[grip].width / 2;
    const y = source.y + source.height / 2;
    // A little past the target's top edge, so the centre crosses its middle.
    const dy = target.y - source.y + (to < from ? -6 : 6);
    return { x, y, dy };
  }

  async function mouseDrag(page, from, to) {
    // The item's body, not the handle: with a mouse the whole item drags.
    const { x, y, dy } = await dragPath(page, from, to, 'content');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + dy, { steps: 12 });
    await page.mouse.up();
  }

  async function touchDrag(page, from, to, grip = 'handle') {
    const { x, y, dy } = await dragPath(page, from, to, grip);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / 12 }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }

  /** Puts the items into the correct order, one drag per misplaced item. */
  async function sortWith(page, drag) {
    for (let k = 0; k < ITEMS.length; k++) {
      const from = (await shownOrder(page)).indexOf(ITEMS[k]);
      if (from === k) continue;
      await drag(page, from, k);
      assert.strictEqual((await shownOrder(page)).indexOf(ITEMS[k]), k, `${ITEMS[k]} did not move to ${k}`);
    }
    await settled(page);
  }

  const verdict = (page) => page.$eval('.feedback__verdict', (n) => n.textContent.trim());

  it('shows the items shuffled, numbered, with a handle and arrows each', async () => {
    const page = await onQuestion();
    const order = await shownOrder(page);
    assert.notDeepStrictEqual(order, ITEMS, 'the correct order was sent');
    assert.deepStrictEqual([...order].sort(), [...ITEMS].sort());
    const view = await page.evaluate(() => ({
      numbers: [...document.querySelectorAll('.ordering__number')]
        .map((n) => getComputedStyle(n, '::before').content),
      firstUp: document.querySelector('.ordering__item:first-child [data-move="-1"]').disabled,
      lastDown: document.querySelector('.ordering__item:last-child [data-move="1"]').disabled,
      enabled: [...document.querySelectorAll('.ordering__move')].filter((b) => !b.disabled).length,
      labels: [...document.querySelectorAll('.ordering__item:first-child .ordering__move')]
        .map((b) => b.getAttribute('aria-label'))
    }));
    // Computed style keeps the counter unresolved; the numbers follow the DOM order.
    assert.deepStrictEqual(view.numbers, Array(4).fill('counter(ordering-position) "."'));
    assert.strictEqual(view.firstUp, true);
    assert.strictEqual(view.lastDown, true);
    assert.strictEqual(view.enabled, 6);
    assert.deepStrictEqual(view.labels, ['Move up', 'Move down']);
  });

  it('puts the items in order with the mouse, and scores it', async () => {
    const page = await onQuestion();
    await sortWith(page, mouseDrag);
    assert.deepStrictEqual(await shownOrder(page), ITEMS);
    assert.strictEqual(await page.$('.ordering__item--dragging'), null);

    await page.click('#submit-btn');
    await page.waitForSelector('.feedback__verdict');
    assert.strictEqual(await verdict(page), 'Correct!');
    assert.deepStrictEqual(
      await page.$$eval('.ordering--feedback .ordering__content', (n) => n.map((e) => e.textContent.trim())),
      ITEMS
    );
    assert.match(await page.$eval('.my-stats', (n) => n.textContent), /Score: 100/);
  });

  it('drags by the handle with a finger on a phone', async () => {
    const page = await onQuestion(PHONE);
    assert.strictEqual(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
    await sortWith(page, (p, from, to) => touchDrag(p, from, to, 'handle'));
    assert.deepStrictEqual(await shownOrder(page), ITEMS);

    await page.tap('#submit-btn');
    await page.waitForSelector('.feedback__verdict');
    assert.strictEqual(await verdict(page), 'Correct!');
  });

  it('leaves a finger on an item\'s body to scroll the page, not to drag', async () => {
    const page = await onQuestion(PHONE);
    const touchAction = await page.evaluate(() => ({
      handle: getComputedStyle(document.querySelector('.ordering__handle')).touchAction,
      content: getComputedStyle(document.querySelector('.ordering__content')).touchAction,
      item: getComputedStyle(document.querySelector('.ordering__item')).touchAction
    }));
    assert.deepStrictEqual(touchAction, { handle: 'none', content: 'auto', item: 'auto' });

    const before = await shownOrder(page);
    await touchDrag(page, 0, 2, 'content');
    await settled(page);
    assert.deepStrictEqual(await shownOrder(page), before, 'a swipe over an item moved it');
  });

  it('moves an item with the keyboard, keeps the focus on it, and says where it went', async () => {
    const page = await onQuestion();
    const first = (await shownOrder(page))[0];

    await page.focus('.ordering__item:first-child [data-move="1"]');
    await page.keyboard.press('Enter');
    assert.strictEqual((await shownOrder(page)).indexOf(first), 1);
    assert.strictEqual(
      await page.$eval('#ordering-status', (n) => n.textContent),
      `${first}: now at position 2 of 4`
    );
    const focused = () => page.evaluate(() => ({
      item: document.activeElement.closest('.ordering__item')?.querySelector('.ordering__content').textContent.trim(),
      move: document.activeElement.dataset.move
    }));
    assert.deepStrictEqual(await focused(), { item: first, move: '1' });

    // To the bottom: the down arrow is used up, and the focus moves to "up".
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    assert.strictEqual((await shownOrder(page)).indexOf(first), 3);
    assert.deepStrictEqual(await focused(), { item: first, move: '-1' });
    assert.strictEqual(
      await page.$eval('#ordering-status', (n) => n.textContent),
      `${first}: now at position 4 of 4`
    );
  });

  it('shows a wrong order back with its verdict, not the correct order', async () => {
    const page = await onQuestion();
    let order = await shownOrder(page);
    // Make sure it is wrong whatever the shuffle: byte last.
    while (order.indexOf('byte') !== 3) {
      await page.click(`.ordering__item:nth-child(${order.indexOf('byte') + 1}) [data-move="1"]`);
      order = await shownOrder(page);
    }
    await page.click('#submit-btn');
    await page.waitForSelector('.feedback__verdict');
    assert.strictEqual(await verdict(page), 'Not quite.');
    assert.deepStrictEqual(
      await page.$$eval('.ordering--feedback .ordering__content', (n) => n.map((e) => e.textContent.trim())),
      order
    );
  });

  describe('when the connection drops', () => {
    const room = () => quizServer.roomManager.getRoom(roomId);
    function dropConnection() {
      for (const [ws, p] of room().participants) {
        if (p.name === 'Alice Adams') return ws.terminate();
      }
      assert.fail('Alice is not connected');
    }
    const bannerShown = (page) =>
      page.waitForFunction(() => !document.getElementById('connection-banner').hidden, null, { timeout: 3000 });
    const reconnected = (page) =>
      page.waitForFunction(
        () => document.getElementById('connection-banner').hidden &&
          !document.getElementById('content').classList.contains('content--stale'),
        null,
        { timeout: RECONNECT_TIMEOUT }
      );

    it('keeps the order the student had made', async () => {
      const page = await onQuestion();
      await page.click('.ordering__item:first-child [data-move="1"]');
      const order = await shownOrder(page);

      dropConnection();
      await bannerShown(page);
      await reconnected(page);
      assert.deepStrictEqual(await shownOrder(page), order);

      await page.click('#submit-btn');
      await page.waitForSelector('.feedback__verdict');
      assert.deepStrictEqual(
        await page.$$eval('.ordering--feedback .ordering__content', (n) => n.map((e) => e.textContent.trim())),
        order
      );
    });

    it('ends a drag cleanly when the page goes stale under it', async () => {
      const page = await onQuestion();
      const { x, y, dy } = await dragPath(page, 0, 2, 'content');
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + dy / 2, { steps: 6 });
      assert.ok(await page.$('.ordering__item--dragging'), 'the drag did not start');

      dropConnection();
      await bannerShown(page);
      await page.mouse.move(x, y + dy, { steps: 6 });
      await page.mouse.up();
      await settled(page);

      const state = await page.evaluate(() => ({
        dragging: document.querySelectorAll('.ordering__item--dragging').length,
        transforms: [...document.querySelectorAll('.ordering__item')].map((n) => n.style.transform).filter(Boolean)
      }));
      assert.deepStrictEqual(state, { dragging: 0, transforms: [] });
      await reconnected(page);
    });
  });
});
