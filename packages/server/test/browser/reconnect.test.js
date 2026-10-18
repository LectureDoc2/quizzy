/**
 * Participant reattach, end to end: a real join page in Chromium, the real
 * server behind the same /ws proxy production uses, and connections dropped the
 * way a wifi handover drops them -- from the server's side, with the page left
 * loaded.
 *
 * What these guard: before reattach, any dropped socket ended the quiz for that
 * student ("Connection lost. Please refresh the page."), and refreshing made
 * them a new participant with a score of zero. See PARTICIPANT-REATTACH.md.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createQuizServer } from '../../src/server.js';
import { startStaticServer, launchBrowser, tokenFor, connectSocket } from './harness.js';
import { loopbackHost, originFor } from '../loopback.js';

const QUIZ = {
  title: 'Reconnect Quiz',
  secret: 'high-entropy',
  questions: [
    { type: 'multiple-choice', text: 'Pick TCP', options: ['TCP', 'UDP'], correctIndices: [0] },
    { type: 'multiple-choice', text: 'Pick UDP', options: ['TCP', 'UDP'], correctIndices: [1] },
    { type: 'estimation', text: 'Bits in an IPv4 address?', correctAnswer: 32 }
  ]
};

/** Long enough for the first backoff step (at most 1.5 s) plus some slack. */
const RECONNECT_TIMEOUT = 6000;

describe('Participant reattach (browser, full stack)', () => {
  let quizServer;
  let backendPort;
  let statics;
  let browser;
  let presenter;
  let presenterToken;
  let roomId;
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
    await browser.close();
    await statics.close();
    await quizServer.close();
  });

  beforeEach(async () => {
    for (const page of pages.splice(0)) await page.close();
    for (const id of [...quizServer.roomManager.rooms.keys()]) {
      quizServer.roomManager.removeRoom(id);
    }
    presenter = await socket();
    presenterToken = tokenFor(`reconnect-${roomCounter++}`, QUIZ);
    presenter.sendJson({ type: 'create_room', presenterToken, quiz: QUIZ });
    roomId = (await presenter.take('room_created')).roomId;
  });

  async function socket() {
    const ws = connectSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
    sockets.push(ws);
    await ws.opened;
    return ws;
  }

  /** A second participant on a plain socket, so a question is not closed by the page's answer alone. */
  async function joinBob() {
    const bob = await socket();
    bob.sendJson({ type: 'join_room', roomId, name: 'Bob Brown' });
    await bob.take('joined');
    return bob;
  }

  async function newPage() {
    const page = await browser.newPage();
    pages.push(page);
    return page;
  }

  async function joinInPage(name = 'Alice Adams', page = null) {
    page = page || await newPage();
    await page.goto(`${statics.origin}/join.html?room=${roomId}`);
    await page.waitForSelector('#join-form');
    await page.fill('#name', name);
    await page.click('#join-btn');
    await page.waitForFunction(() => !document.getElementById('join-form'));
    return page;
  }

  const room = () => quizServer.roomManager.getRoom(roomId);

  function participantNamed(name) {
    for (const [ws, p] of room().participants) {
      if (p.name === name) return { ws, participant: p };
    }
    return null;
  }

  /** Drop the page's connection from the far end, the way a wifi handover does. */
  function dropConnection(name = 'Alice Adams') {
    const found = participantNamed(name);
    assert.ok(found, `${name} is not connected`);
    found.ws.terminate();
    return found.participant;
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

  const text = (page, selector) =>
    page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', selector);

  const stored = (page) =>
    page.evaluate(() => ({
      session: Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])),
      local: Object.keys(localStorage),
      cookie: document.cookie
    }));

  async function startGame() {
    presenter.sendJson({ type: 'start_game' });
    await presenter.take('game_started');
  }

  it('reconnects by itself mid-question, as the same participant, keeping the selection', async () => {
    const bob = await joinBob();
    const page = await joinInPage();
    await startGame();
    await page.waitForSelector('.option');
    await page.click('.option[data-index="0"]');

    const before = dropConnection();
    await bannerShown(page);
    assert.strictEqual(
      await page.evaluate(() => document.getElementById('content').inert),
      true,
      'the stale screen must not take an answer it cannot send'
    );
    await reconnected(page);

    const after = participantNamed('Alice Adams');
    assert.ok(after, 'the page did not come back');
    assert.strictEqual(after.participant.id, before.id, 'came back as somebody new');
    assert.strictEqual(room().getLeaderboard().length, 2, 'a reconnect minted a second participant');
    assert.deepStrictEqual(
      await page.evaluate(() => [...document.querySelectorAll('.option--selected')].map((n) => n.dataset.index)),
      ['0'],
      'the student lost the option they had already picked'
    );

    await page.click('#submit-btn');
    bob.sendJson({ type: 'submit_answer', answer: [1] });
    await page.waitForSelector('.results');
    assert.match(await text(page, '.my-stats'), /Score: 100/);
  });

  it('lands an answered-then-dropped student on "waiting", not on the question again', async () => {
    await joinBob();
    const page = await joinInPage();
    await startGame();
    await page.waitForSelector('.option');
    await page.click('.option[data-index="0"]');
    await page.click('#submit-btn');
    await page.waitForFunction(() => /Answer submitted/.test(document.getElementById('content').textContent));

    dropConnection();
    await bannerShown(page);
    await reconnected(page);

    assert.match(await text(page, '#content'), /Answer submitted/);
    assert.strictEqual(await page.$('.option'), null, 'the answered question was offered again');
  });

  it('says which question closed while it was away', async () => {
    await joinBob();
    const page = await joinInPage();
    await startGame();
    await page.waitForSelector('.option');

    // The quiz moves on before the page's first reconnect attempt, which the
    // backoff puts at least half a second out.
    dropConnection();
    presenter.sendJson({ type: 'end_question' });
    await presenter.take('question_results');
    presenter.sendJson({ type: 'next_question' });
    await presenter.take('question_started');

    await reconnected(page);
    await page.waitForFunction(() => /Pick UDP/.test(document.getElementById('content').textContent));
    assert.match(await text(page, '#notice'), /Question 1 closed while you were reconnecting/);
    assert.match(await text(page, '.question__counter'), /Question 2 of 3/);
  });

  it('survives the reload button with name and score intact', async () => {
    const bob = await joinBob();
    const page = await joinInPage();
    await startGame();
    await page.waitForSelector('.option');
    await page.click('.option[data-index="0"]');
    await page.click('#submit-btn');
    bob.sendJson({ type: 'submit_answer', answer: [1] });
    await page.waitForSelector('.results');
    const id = participantNamed('Alice Adams').participant.id;

    const before = await stored(page);
    const key = `quizzy:resume:${roomId}`;
    assert.deepStrictEqual(Object.keys(before.session), [key], 'exactly one session key, scoped to the room');
    assert.match(before.session[key], /^[A-Za-z0-9_-]{43}$/);
    assert.deepStrictEqual(before.local, [], 'nothing persistent');
    assert.strictEqual(before.cookie, '', 'no cookie');
    assert.ok(!page.url().includes(before.session[key]), 'the token must never be in the URL');

    await page.reload();
    await page.waitForSelector('.results');

    assert.match(await text(page, '.my-stats'), /Score: 100/);
    assert.strictEqual(await text(page, '#page-title'), 'Reconnect Quiz');
    assert.strictEqual(participantNamed('Alice Adams').participant.id, id);
    assert.strictEqual(room().getLeaderboard().length, 2, 'the reload minted a second participant');
    assert.ok(!page.url().includes(before.session[key]), 'the token must never be in the URL');
  });

  it('reloads onto "waiting" if the student had already answered the open question', async () => {
    await joinBob();
    const page = await joinInPage();
    await startGame();
    await page.waitForSelector('.option');
    await page.click('.option[data-index="0"]');
    await page.click('#submit-btn');
    await page.waitForFunction(() => /Answer submitted/.test(document.getElementById('content').textContent));

    await page.reload();
    await page.waitForFunction(() => /Answer submitted/.test(document.getElementById('content').textContent));
    assert.strictEqual(await page.$('.option'), null);
  });

  it('forgets the session key once the quiz has ended', async () => {
    const page = await joinInPage();
    await startGame();
    await page.waitForSelector('.option');
    presenter.sendJson({ type: 'end_game' });
    await page.waitForSelector('.results h2');

    assert.deepStrictEqual((await stored(page)).session, {});
  });

  it('falls back to a fresh join, and says why, when the session has expired', async () => {
    const page = await newPage();
    await page.goto(`${statics.origin}/join.html?room=${roomId}`);
    await page.waitForSelector('#join-form');
    await page.evaluate((key) => sessionStorage.setItem(key, 'A'.repeat(43)), `quizzy:resume:${roomId}`);

    await page.reload();
    await page.waitForSelector('#join-form');
    assert.match(await text(page, '#notice'), /expired/i);
    assert.deepStrictEqual((await stored(page)).session, {}, 'a refused token must be forgotten at once');

    await page.fill('#name', 'Alice Adams');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');
    assert.strictEqual(room().getParticipantCount(), 1);
  });

  it('hands the identity to a duplicated tab and stops the original from fighting back', async () => {
    const original = await joinInPage();
    const key = `quizzy:resume:${roomId}`;
    const token = (await stored(original)).session[key];

    // Chromium's "Duplicate tab" copies sessionStorage; this is that, by hand.
    const duplicate = await newPage();
    await duplicate.goto(`${statics.origin}/join.html?room=${roomId}`);
    await duplicate.evaluate(([k, t]) => sessionStorage.setItem(k, t), [key, token]);
    await duplicate.reload();
    await duplicate.waitForFunction(() => /Waiting for the quiz/.test(document.getElementById('content').textContent));

    await original.waitForSelector('.error');
    assert.match(await text(original, '.error'), /continued in another tab/);

    // Give a misbehaving original ample time to reconnect and take it back.
    await new Promise((r) => setTimeout(r, 2500));
    assert.strictEqual(room().getParticipantCount(), 1);
    assert.match(await text(original, '.error'), /continued in another tab/);
    await startGame();
    await duplicate.waitForSelector('.option');
  });

  it('does not reconnect after being removed by the presenter', async () => {
    const page = await joinInPage();
    const { participant } = participantNamed('Alice Adams');
    presenter.sendJson({ type: 'kick_participant', participantId: participant.id });
    await page.waitForSelector('.error');

    await new Promise((r) => setTimeout(r, 2500));
    assert.match(await text(page, '.error'), /removed/);
    assert.strictEqual(room().getLeaderboard().length, 0, 'the kick was undone by a reconnect');
    assert.deepStrictEqual((await stored(page)).session, {});
  });

  it('writes nothing to the device before the student presses Join', async () => {
    const page = await newPage();
    await page.goto(`${statics.origin}/join.html?room=${roomId}`);
    await page.waitForSelector('#join-form');
    assert.deepStrictEqual(await stored(page), { session: {}, local: [], cookie: '' });
    assert.match(await text(page, '#join-privacy'), /random session key/);
  });

  it('shows the presenter who is reconnecting, and when they are back', async () => {
    await joinBob();
    const page = await joinInPage();

    const control = await newPage();
    await control.goto(`${statics.origin}/control.html?token=${presenterToken}&room=${roomId}`);
    await control.waitForFunction(() => document.getElementById('participants')?.textContent === '2');

    dropConnection();
    await control.waitForFunction(
      () => document.getElementById('participants-reconnecting').textContent.includes('1 reconnecting'),
      null,
      { timeout: 3000 }
    );
    assert.strictEqual(await text(control, '#participants'), '1 connected');
    assert.match(await text(control, '.leaderboard__item--away .leaderboard__name'), /Alice Adams.*reconnecting/);

    await reconnected(page);
    await control.waitForFunction(
      () => document.getElementById('participants').textContent === '2' &&
        document.getElementById('participants-reconnecting').textContent === '',
      null,
      { timeout: RECONNECT_TIMEOUT }
    );
    assert.strictEqual(await control.$('.leaderboard__item--away'), null);
  });
});
