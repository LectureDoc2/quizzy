/**
 * Changing an answer after Submit, end to end: a real join page in Chromium and
 * the real server behind the same /ws proxy production uses.
 *
 * Students press Submit by accident. While somebody else is still answering,
 * the question stays open, and the page lets the student change their answer
 * and send it again; the server takes the last one. What these guard: that the
 * page never shows an answer as counted that the server does not hold, and
 * that the colour that asks to resubmit is not the one that says time is up.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createQuizServer } from '../../src/server.js';
import { startStaticServer, launchBrowser, openPage, tokenFor, connectSocket } from './harness.js';
import { loopbackHost, originFor } from '../loopback.js';

/** --quiz-resubmit and --quiz-danger in styles/quiz-ui.css. */
const ORANGE = 'rgb(249, 115, 22)';
const DANGER = 'rgb(220, 38, 38)';

const QUESTIONS = {
  'multiple-choice': { type: 'multiple-choice', text: 'Pick UDP', options: ['TCP', 'UDP', 'QUIC'], correctIndices: [1], timeLimit: 60 },
  estimation: { type: 'estimation', text: 'Bits in an IPv4 address?', correctAnswer: 32, timeLimit: 60 },
  'short-answer': { type: 'short-answer', text: 'Same name, different parameters?', acceptedAnswers: ['Overloading'], timeLimit: 60 },
  ordering: { type: 'ordering', text: 'Order by size', options: ['byte', 'short', 'int', 'long'], timeLimit: 60 }
};

describe('Resubmitting a changed answer (browser, full stack)', () => {
  let quizServer;
  let backendPort;
  let statics;
  let browser;
  let roomCounter = 0;
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

  async function socket() {
    const ws = connectSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
    sockets.push(ws);
    await ws.opened;
    return ws;
  }

  /**
   * Alice in a page and Bob on a plain socket, on the room's only question:
   * Bob keeps it open until he answers.
   */
  async function onQuestion(question, { beforeLoad } = {}) {
    const quiz = { title: 'Resubmit Quiz', secret: 'high-entropy', questions: [question] };
    const presenter = await socket();
    presenter.sendJson({ type: 'create_room', presenterToken: tokenFor(`resubmit-${roomCounter++}`, quiz), quiz });
    const { roomId } = await presenter.take('room_created');

    const bob = await socket();
    bob.sendJson({ type: 'join_room', roomId, name: 'Bob Brown' });
    await bob.take('joined');

    const page = await openPage(browser);
    pages.push(page);
    if (beforeLoad) await beforeLoad(page);
    await page.goto(`${statics.origin}/join.html?room=${roomId}`);
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Alice Adams');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');
    presenter.sendJson({ type: 'start_game' });
    await page.waitForSelector('#submit-btn');

    const room = quizServer.roomManager.getRoom(roomId);
    const alice = [...room.participants.values()].find((p) => p.name === 'Alice Adams');
    return { page, bob, room, aliceId: alice.id };
  }

  const button = (page) => page.$eval('#submit-btn', (el) => ({
    text: el.textContent,
    disabled: el.disabled,
    resubmit: el.classList.contains('submit--resubmit'),
    urgent: el.classList.contains('submit--urgent'),
    time: el.querySelector('.submit__time') !== null,
    background: getComputedStyle(el).backgroundColor
  }));

  const labelled = (page, text) =>
    page.waitForFunction((t) => document.getElementById('submit-btn')?.textContent === t, text, { timeout: 3000 });

  it('keeps the question after Submit, without the time, and says the answer may still change', async () => {
    const { page, room, aliceId } = await onQuestion(QUESTIONS['multiple-choice']);
    assert.ok((await button(page)).time, 'a timed question shows the time in Submit');
    await page.click('.option[data-index="0"]');
    await page.click('#submit-btn');
    await labelled(page, 'Submitted ✓');

    const now = await button(page);
    assert.deepStrictEqual(
      { disabled: now.disabled, resubmit: now.resubmit, urgent: now.urgent, time: now.time },
      { disabled: true, resubmit: false, urgent: false, time: false }
    );
    assert.strictEqual(await page.$$eval('.option', (els) => els.length), 3, 'the question was taken away');
    const note = await page.$eval('#resubmit-note', (el) => ({ hidden: el.hidden, text: el.textContent }));
    assert.strictEqual(note.hidden, false);
    assert.match(note.text, /You can still change your answer while others are answering\. The round may end at any moment\./);
    assert.deepStrictEqual(room.getShownAnswer(aliceId), [0]);
  });

  it('turns orange for a changed answer, and the resubmitted one is what counts', async () => {
    const { page, bob, room, aliceId } = await onQuestion(QUESTIONS['multiple-choice']);
    await page.click('.option[data-index="0"]');
    await page.click('#submit-btn');
    await labelled(page, 'Submitted ✓');

    await page.click('.option[data-index="0"]');
    await page.click('.option[data-index="1"]');
    // Buttons fade their background (.btn's transition); read it once settled.
    await page.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 3000 });
    const changed = await button(page);
    assert.deepStrictEqual(
      { text: changed.text, disabled: changed.disabled, resubmit: changed.resubmit, background: changed.background },
      { text: 'Resubmit', disabled: false, resubmit: true, background: ORANGE }
    );
    assert.notStrictEqual(changed.background, DANGER);

    // Back to what was sent: nothing to resubmit.
    await page.click('.option[data-index="1"]');
    await page.click('.option[data-index="0"]');
    assert.strictEqual((await button(page)).text, 'Submitted ✓');

    await page.click('.option[data-index="0"]');
    await page.click('.option[data-index="1"]');
    await page.click('#submit-btn');
    await labelled(page, 'Resubmitted ✓');
    assert.deepStrictEqual(room.getShownAnswer(aliceId), [1]);

    bob.sendJson({ type: 'submit_answer', answer: [0] });
    await page.waitForSelector('.results');
    assert.match(await page.$eval('.my-stats', (el) => el.textContent), /Score: 100/);
    assert.deepStrictEqual(
      await page.$$eval('.feedback__option', (els) => els.flatMap((el, i) => (el.classList.contains('option--selected') ? [i] : []))),
      [1],
      'the results show the answer that counted'
    );
  });

  it('takes a changed estimate, by Enter as well', async () => {
    const { page, room, aliceId } = await onQuestion(QUESTIONS.estimation);
    await page.fill('#answer', '30');
    await page.press('#answer', 'Enter');
    await labelled(page, 'Submitted ✓');
    await page.press('#answer', 'Enter'); // unchanged: nothing is sent
    await page.fill('#answer', '32');
    assert.strictEqual((await button(page)).text, 'Resubmit');
    await page.press('#answer', 'Enter');
    await labelled(page, 'Resubmitted ✓');
    assert.strictEqual(room.getShownAnswer(aliceId), 32);
  });

  it('compares a short answer as the server stores it', async () => {
    const { page, room, aliceId } = await onQuestion(QUESTIONS['short-answer']);
    await page.fill('#answer', 'Overriding');
    await page.click('#submit-btn');
    await labelled(page, 'Submitted ✓');
    await page.fill('#answer', '  Overriding ');
    assert.strictEqual((await button(page)).text, 'Submitted ✓', 'spacing alone is no change');
    await page.fill('#answer', 'Overloading');
    await page.click('#submit-btn');
    await labelled(page, 'Resubmitted ✓');
    assert.strictEqual(room.getShownAnswer(aliceId), 'Overloading');
    assert.strictEqual(room.currentAnswers.get(aliceId).correct, true);
  });

  it('takes a changed order', async () => {
    const { page, room, aliceId } = await onQuestion(QUESTIONS.ordering);
    const order = () => page.$$eval('.ordering__item', (els) => els.map((el) => Number(el.dataset.index)));
    await page.click('#submit-btn');
    await labelled(page, 'Submitted ✓');
    const sent = await order();
    assert.deepStrictEqual(room.getShownAnswer(aliceId), sent);

    await page.click('.ordering__item:first-child .ordering__move--down');
    assert.strictEqual((await button(page)).text, 'Resubmit');
    await page.click('#submit-btn');
    await labelled(page, 'Resubmitted ✓');
    assert.deepStrictEqual(room.getShownAnswer(aliceId), await order());
    assert.notDeepStrictEqual(await order(), sent);
  });

  it('keeps the results on screen when a resubmission crosses the question closing', async () => {
    const { page, bob } = await onQuestion(QUESTIONS['multiple-choice'], {
      // The page's socket, to send on it after the question is gone, and the
      // types of the messages that reached the page.
      beforeLoad: (p) => p.addInitScript(() => {
        const Native = window.WebSocket;
        window.__received = [];
        window.WebSocket = class extends Native {
          constructor(...args) {
            super(...args);
            window.__quizSocket = this;
            this.addEventListener('message', (event) => window.__received.push(JSON.parse(event.data).type));
          }
        };
      })
    });
    await page.click('.option[data-index="0"]');
    await page.click('#submit-btn');
    await labelled(page, 'Submitted ✓');
    bob.sendJson({ type: 'submit_answer', answer: [0] });
    await page.waitForSelector('.results');

    // As if Resubmit had been pressed just before the results arrived.
    await page.evaluate(() => window.__quizSocket.send(JSON.stringify({ type: 'submit_answer', answer: [1] })));
    await page.waitForFunction(() => window.__received.includes('error'), null, { timeout: 3000 });
    assert.ok(await page.$('.results'), 'the refusal replaced the results');
    assert.strictEqual(await page.$('.error'), null);
  });
});
