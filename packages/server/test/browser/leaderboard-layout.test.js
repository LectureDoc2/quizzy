/**
 * Layout regression tests for the leaderboard and the per-answer rows.
 *
 * These assert measured geometry rather than the presence of CSS rules, because
 * the bug they exist to catch was a selector that parsed fine and simply never
 * matched: `&.leaderboard__item` inside `.leaderboard` compiles to
 * `.leaderboard.leaderboard__item`, one element with both classes, while the
 * markup has them as parent and child. Every rule in that block was dead, the
 * row never became a flex container, and the score ended up flush against the
 * name. Nothing short of rendering it would have noticed.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { startStaticServer, launchBrowser } from './harness.js';

describe('Leaderboard layout (browser)', () => {
  let statics;
  let browser;
  let page;

  const LEADERBOARD = [
    { id: 'p1', name: 'Alice Adams', score: 1000 },
    { id: 'p2', name: 'Bob Brown', score: 50 },
    { id: 'p3', name: 'Christina Wharton-Fitzgerald', score: 5 }
  ];

  before(async () => {
    statics = await startStaticServer();
    browser = await launchBrowser();
    page = await browser.newPage();

    await page.addInitScript(() => {
      window.__sent = [];
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

    await page.goto(`${statics.origin}/control.html?token=TOKEN&room=ROOM01`);
    await page.waitForFunction(() => window.__ws && window.__sent.length > 0);
    await page.evaluate((leaderboard) =>
      window.__push({
        type: 'control_connected',
        roomId: 'ROOM01',
        state: 'results',
        quizTitle: 'Layout',
        totalQuestions: 1,
        currentQuestionIndex: 0,
        question: null,
        participantCount: 3,
        leaderboard
      }), LEADERBOARD
    );
    await page.waitForSelector('.leaderboard__item');
  });

  after(async () => {
    await browser.close();
    await statics.close();
  });

  function rows() {
    return page.evaluate(() =>
      [...document.querySelectorAll('.leaderboard__item')].map((item) => {
        const box = item.getBoundingClientRect();
        const name = item.querySelector('.leaderboard__name').getBoundingClientRect();
        const score = item.querySelector('.leaderboard__score').getBoundingClientRect();
        return {
          display: getComputedStyle(item).display,
          gap: score.left - name.right,
          rightInset: box.right - score.right,
          scoreRight: score.right,
          textAlign: getComputedStyle(item.querySelector('.leaderboard__score')).textAlign,
          numeric: getComputedStyle(item.querySelector('.leaderboard__score')).fontVariantNumeric
        };
      })
    );
  }

  it('lays each row out as a flex container', async () => {
    for (const row of await rows()) {
      assert.strictEqual(row.display, 'flex', 'the leaderboard row rules are not being applied');
    }
  });

  it('separates the score from the name', async () => {
    for (const row of await rows()) {
      assert.ok(
        row.gap > 4,
        `score is butted against the name (gap ${row.gap.toFixed(1)}px)`
      );
    }
  });

  it('right-aligns the scores on a common edge', async () => {
    const measured = await rows();
    const edges = measured.map((r) => r.scoreRight);
    const spread = Math.max(...edges) - Math.min(...edges);
    assert.ok(spread < 1, `score right edges differ by ${spread.toFixed(2)}px`);

    for (const row of measured) {
      assert.strictEqual(row.textAlign, 'right');
      // Proportional digits would make 1000 and 50 sit on different columns.
      assert.match(row.numeric, /tabular-nums/);
    }
  });

  it('keeps a long name from pushing the score out of the row', async () => {
    const measured = await rows();
    for (const row of measured) {
      assert.ok(row.rightInset >= 0, 'the score overflowed the row');
    }
    // The third entry has a deliberately long name; its score must still align.
    assert.ok(Math.abs(measured[2].scoreRight - measured[0].scoreRight) < 1);
  });

  it('right-aligns the points on the presenter answer rows too', async () => {
    await page.evaluate(() =>
      window.__push({
        type: 'question_results',
        questionIndex: 0,
        answers: [
          { participantId: 'p1', name: 'Alice Adams', answer: 42, points: 100 },
          { participantId: 'p2', name: 'Bob Brown', answer: 7, points: 0 }
        ],
        leaderboard: []
      })
    );
    await page.waitForSelector('.answer-item');

    const edges = await page.evaluate(() =>
      [...document.querySelectorAll('.answer-item')].map((item) => {
        const points = item.querySelector('.answer-points').getBoundingClientRect();
        const value = item.querySelector('.answer-value').getBoundingClientRect();
        return { right: points.right, gap: points.left - value.right };
      })
    );

    const spread = Math.max(...edges.map((e) => e.right)) - Math.min(...edges.map((e) => e.right));
    assert.ok(spread < 1, `points right edges differ by ${spread.toFixed(2)}px`);
    for (const edge of edges) assert.ok(edge.gap > 4, 'points butted against the answer');
  });
});
