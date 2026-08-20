/**
 * The participant's join page, against a real server.
 *
 * The bug these guard: the page offered a bare "Join Quiz" whatever the room
 * was doing, so a student opening the link ten minutes late had no way to tell
 * the quiz was already running, nor how much they had missed.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createQuizServer } from '../../src/server.js';
import { startStaticServer, launchBrowser, tokenFor, connectSocket } from './harness.js';

const QUIZ = {
  title: 'Networking Basics',
  secret: 'high-entropy',
  questions: [
    { type: 'multiple-choice', text: 'Pick one', options: ['TCP', 'UDP'], correctIndices: [0] },
    { type: 'estimation', text: 'Bits in an IPv6 address?', correctAnswer: 128 },
    { type: 'estimation', text: 'Bits in an IPv4 address?', correctAnswer: 32 }
  ]
};

describe('Join page (browser, full stack)', () => {
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
    backendPort = await quizServer.listen(0, '127.0.0.1');
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
    presenter = connectSocket(`ws://127.0.0.1:${backendPort}/ws`);
    sockets.push(presenter);
    await presenter.opened;
    presenter.sendJson({
      type: 'create_room',
      presenterToken: tokenFor(`p${quizServer.roomManager.rooms.size}-${sockets.length}`, QUIZ),
      quiz: QUIZ
    });
    roomId = (await presenter.take('room_created')).roomId;
  });

  async function openJoinPage(room = roomId) {
    const page = await browser.newPage();
    pages.push(page);
    await page.goto(`${statics.origin}/join.html?room=${room}`);
    return page;
  }

  const view = (page) =>
    page.evaluate(() => ({
      heading: document.getElementById('page-title').textContent.trim(),
      button: (document.getElementById('join-btn') || {}).textContent,
      detail: (document.querySelector('.room-state__detail') || {}).textContent,
      live: !!document.querySelector('.room-state__detail--live'),
      title: (document.querySelector('.room-state__title') || {}).textContent,
      hasForm: !!document.getElementById('join-form'),
      error: (document.querySelector('.error') || {}).textContent
    }));

  it('offers a plain join while the quiz is still in the lobby', async () => {
    const page = await openJoinPage();
    await page.waitForSelector('#join-form');
    const seen = await view(page);

    assert.strictEqual(seen.heading, 'Join Quiz');
    assert.strictEqual(seen.button, 'Join Quiz');
    assert.strictEqual(seen.title, 'Networking Basics');
    assert.match(seen.detail, /Waiting for the quiz to start/);
    assert.strictEqual(seen.live, false);
  });

  it('says the quiz is running, and how much was missed', async () => {
    presenter.sendJson({ type: 'start_game' });
    await presenter.take('game_started');
    presenter.sendJson({ type: 'next_question' }); // now on question 2 of 3
    await presenter.take('question_started');

    const page = await openJoinPage();
    await page.waitForSelector('#join-form');
    const seen = await view(page);

    assert.strictEqual(seen.heading, 'Quiz in progress', 'the heading still said "Join Quiz"');
    assert.strictEqual(seen.button, 'Join now');
    assert.match(seen.detail, /Question 2 of 3/);
    assert.match(seen.detail, /missed 1 question\b/);
    assert.strictEqual(seen.live, true);
  });

  it('lets a latecomer in and shows them the question in progress', async () => {
    presenter.sendJson({ type: 'start_game' });
    await presenter.take('game_started');

    const page = await openJoinPage();
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Late Arrival');
    await page.click('#join-btn');

    await page.waitForSelector('.question__text');
    const question = await page.evaluate(() => ({
      text: document.getElementById('question-text').textContent,
      options: [...document.querySelectorAll('.option')].map((n) => n.textContent.trim())
    }));
    assert.match(question.text, /Pick one/);
    assert.deepStrictEqual(question.options, ['TCP', 'UDP']);
  });

  it('stops saying "Join Quiz" once the student is actually in the quiz', async () => {
    // The heading lives outside #content, so no render* method touches it; it
    // stayed on "Join Quiz" above the question the student was answering.
    const page = await openJoinPage();
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Present Student');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');

    let seen = await view(page);
    assert.strictEqual(seen.heading, 'Networking Basics', 'heading still said "Join Quiz" after joining');

    presenter.sendJson({ type: 'start_game' });
    await page.waitForSelector('.question__text');
    seen = await view(page);
    assert.strictEqual(seen.heading, 'Networking Basics', 'heading reverted while answering');
    assert.strictEqual(
      await page.title(),
      'Networking Basics',
      'the browser tab still said "Join Quiz"'
    );
  });

  it('keeps the quiz name in the heading through to the final results', async () => {
    const page = await openJoinPage();
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Steady Student');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');

    presenter.sendJson({ type: 'start_game' });
    await page.waitForSelector('.question__text');
    for (let i = 0; i < 2; i++) {
      presenter.sendJson({ type: 'next_question' });
      await presenter.take('question_started');
    }
    presenter.sendJson({ type: 'next_question' }); // ends the quiz
    await page.waitForSelector('.results');

    const seen = await view(page);
    assert.strictEqual(seen.heading, 'Networking Basics');
  });

  it('tells a student the quiz has finished rather than blaming the room code', async () => {
    presenter.sendJson({ type: 'start_game' });
    await presenter.take('game_started');
    for (let i = 0; i < 2; i++) {
      presenter.sendJson({ type: 'next_question' });
      await presenter.take('question_started');
    }
    const ended = presenter.take('game_ended');
    presenter.sendJson({ type: 'next_question' });
    await ended;

    const page = await openJoinPage();
    await page.waitForSelector('.error');
    const seen = await view(page);
    // The status query stays opaque, so this is the generic message; the
    // specific one is reserved for a real join attempt (see server.test.js).
    assert.ok(!seen.hasForm, 'a finished quiz must not offer a join form');
    assert.match(seen.error, /Unable to open that session/);
  });

  it('shows an unknown room code the same generic message', async () => {
    const page = await openJoinPage('ZZZZZZ');
    await page.waitForSelector('.error');
    const seen = await view(page);
    assert.match(seen.error, /Unable to open that session/);
  });

  it('keeps a rejected name on the form instead of wiping the page', async () => {
    const page = await openJoinPage();
    await page.waitForSelector('#join-form');
    // Passes the client-side pattern check but is refused by the server.
    await page.fill('#name', 'Adolf Hitler');
    await page.click('#join-btn');
    await page.waitForFunction(
      () => {
        const el = document.getElementById('name-error');
        return el && el.style.display === 'block' && el.textContent.length > 0;
      },
      { timeout: 3000 }
    );
    const stillThere = await page.evaluate(() => !!document.getElementById('join-form'));
    assert.ok(stillThere, 'the form should survive a rejected name');
  });
});
