/**
 * Practice mode in the browser: the list of practice quizzes, and a game
 * played on the join page with nobody presenting.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createQuizServer } from '../../src/server.js';
import { buildPracticeCatalog } from '../../src/practice-catalog.js';
import { startStaticServer, launchBrowser } from './harness.js';
import { loopbackHost } from '../loopback.js';

const QUIZZES = {
  geo: {
    title: 'Geo <b>graphy</b>',
    questions: [{ type: 'multiple-choice', text: 'Capital?', options: ['Bonn', 'Berlin'], correctIndices: [1] }]
  },
  net: {
    title: 'Networks',
    questions: [
      { type: 'multiple-choice', text: 'Pick TCP', options: ['TCP', 'UDP'], correctIndices: [0] },
      { type: 'estimation', text: 'Bits in an IPv6 address?', correctAnswer: 128 }
    ]
  },
  tor: { title: 'Onion Routing', questions: [{ type: 'estimation', text: 'Hops?', correctAnswer: 3 }] },
  misc: { title: 'Miscellany', questions: [{ type: 'estimation', text: 'Answer?', correctAnswer: 42 }] }
};

function catalog(entries, resultsSeconds = 30) {
  return buildPracticeCatalog({ resultsSeconds, quizzes: entries }, (file) => QUIZZES[file]).catalog;
}

const FULL = [
  { id: 'geo', category: 'Geography', file: 'geo', description: 'Cities <i>and</i> rivers' },
  { id: 'net', category: 'Security', file: 'net' },
  { id: 'misc', file: 'misc' },
  { id: 'tor', category: 'Security', file: 'tor' }
];

describe('Practice (browser, full stack)', () => {
  let quizServer;
  let statics;
  let browser;
  const pages = [];

  before(async () => {
    quizServer = createQuizServer({ heartbeatIntervalMs: 60_000 });
    const backendPort = await quizServer.listen(0, loopbackHost());
    statics = await startStaticServer(backendPort);
    browser = await launchBrowser();
  });

  after(async () => {
    await browser.close();
    await statics.close();
    await quizServer.close();
  });

  beforeEach(async () => {
    for (const page of pages.splice(0)) await page.close();
    for (const id of [...quizServer.roomManager.rooms.keys()]) {
      quizServer.roomManager.removeRoom(id);
    }
    quizServer.setPracticeCatalog(catalog(FULL));
  });

  async function open(path) {
    const page = await browser.newPage();
    pages.push(page);
    await page.goto(`${statics.origin}/${path}`);
    return page;
  }

  const listView = (page) => page.evaluate(() =>
    [...document.querySelectorAll('details.practice-category')].map((details) => ({
      name: details.querySelector('.practice-category__name').textContent,
      count: details.querySelector('.practice-category__count').textContent,
      open: details.open,
      cards: [...details.querySelectorAll('.practice-card')].map((card) => ({
        href: card.getAttribute('href'),
        title: card.querySelector('.practice-card__title').textContent,
        markup: card.querySelector('.practice-card__title').children.length +
          (card.querySelector('.practice-card__description')?.children.length ?? 0),
        meta: card.querySelector('.practice-card__meta').textContent
      }))
    })));

  it('groups the quizzes by category, in catalog order, uncategorised last', async () => {
    const page = await open('practice.html');
    await page.waitForSelector('details.practice-category');
    const groups = await listView(page);

    assert.deepStrictEqual(groups.map((g) => [g.name, g.count, g.open]), [
      ['Geography', '1 quiz', false],
      ['Security', '2 quizzes', false],
      ['Other', '1 quiz', false]
    ]);
    assert.deepStrictEqual(groups[1].cards.map((c) => c.href), [
      'join.html?practice=net',
      'join.html?practice=tor'
    ]);
    assert.strictEqual(groups[1].cards[0].meta, '2 questions');
    assert.strictEqual(groups[0].cards[0].title, 'Geo <b>graphy</b>', 'catalog text is text, never markup');
    assert.strictEqual(groups[0].cards[0].markup, 0);
  });

  it('opens the only category when there is just one', async () => {
    quizServer.setPracticeCatalog(catalog([FULL[1], FULL[3]]));
    const page = await open('practice.html');
    await page.waitForSelector('details.practice-category');
    const groups = await listView(page);
    assert.deepStrictEqual(groups.map((g) => [g.name, g.open]), [['Security', true]]);
  });

  it('says when there is nothing to practise', async () => {
    quizServer.setPracticeCatalog(catalog([]));
    const page = await open('practice.html');
    await page.waitForSelector('.practice-empty');
  });

  it('plays a game from the list to the final score', async () => {
    const page = await open('practice.html');
    await page.waitForSelector('details.practice-category');
    await page.click('details.practice-category:nth-of-type(2) summary');
    await page.click('a[href="join.html?practice=net"]');

    await page.waitForSelector('.option');
    const start = await page.evaluate(() => ({
      heading: document.getElementById('page-title').textContent,
      roomCodeHidden: document.querySelector('.room-code').hidden,
      url: location.search
    }));
    assert.strictEqual(start.heading, 'Networks');
    assert.ok(start.roomCodeHidden, 'nobody else can join, so there is no code to show');
    assert.match(start.url, /^\?practice=net&room=[A-Z2-9]{6}$/);

    await page.click('.option[data-index="0"]');
    await page.click('#submit-btn');
    await page.waitForSelector('#practice-countdown');
    const results = await page.evaluate(() => ({
      verdict: document.querySelector('.feedback__verdict').textContent.trim(),
      countdown: document.getElementById('practice-countdown').textContent,
      button: document.getElementById('practice-next-btn').textContent,
      leaderboard: !!document.querySelector('.leaderboard')
    }));
    assert.strictEqual(results.verdict, 'Correct!');
    assert.match(results.countdown, /^Next question in (30|29) s$/);
    assert.strictEqual(results.button, 'Next question');
    assert.ok(!results.leaderboard, 'a board of one says nothing');

    await page.click('#practice-next-btn');
    await page.waitForSelector('#answer');
    await page.fill('#answer', '150');
    await page.click('#answer-form button');
    await page.waitForSelector('#practice-countdown');
    const estimate = await page.evaluate(() => ({
      verdict: document.querySelector('.feedback__verdict').textContent.trim(),
      text: document.getElementById('content').textContent,
      button: document.getElementById('practice-next-btn').textContent
    }));
    assert.strictEqual(estimate.verdict, 'Within 25 % of the correct answer: 50 points');
    assert.ok(!estimate.text.includes('128'), 'the correct answer is never shown');
    assert.strictEqual(estimate.button, 'Show final score');

    await page.click('#practice-next-btn');
    await page.waitForSelector('.practice-summary__score');
    const final = await page.evaluate(() => ({
      score: document.querySelector('.practice-summary__score').textContent.trim(),
      stats: document.querySelector('.my-stats').textContent.trim(),
      links: [...document.querySelectorAll('.practice-actions a')]
        .map((a) => [a.textContent, a.getAttribute('href')])
    }));
    assert.strictEqual(final.score, '150 of 200 points');
    assert.strictEqual(final.stats, '1 of 2 questions answered correctly');
    assert.deepStrictEqual(final.links, [
      ['Play again', '/join.html?practice=net'],
      ['All practice quizzes', 'practice.html']
    ]);
  });

  it('comes back to the same game after a reload', async () => {
    const page = await open('join.html?practice=net');
    await page.waitForSelector('.option');
    const before = await page.evaluate(() => location.search);
    await page.reload();
    await page.waitForSelector('.option');
    const after = await page.evaluate(() => ({
      url: location.search,
      text: document.getElementById('question-text').textContent
    }));
    assert.strictEqual(after.url, before);
    assert.strictEqual(after.text, 'Pick TCP');
    assert.strictEqual(quizServer.roomManager.practiceRoomCount, 1, 'rejoined rather than started another');
  });

  it('points back to the list for a quiz that is not offered', async () => {
    const page = await open('join.html?practice=gone');
    await page.waitForSelector('.practice-actions');
    const seen = await page.evaluate(() => ({
      error: document.querySelector('.error').textContent,
      links: [...document.querySelectorAll('.practice-actions a')].map((a) => a.textContent)
    }));
    assert.match(seen.error, /not available/);
    assert.deepStrictEqual(seen.links, ['All practice quizzes']);
  });
});
