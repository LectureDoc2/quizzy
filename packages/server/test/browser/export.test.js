/**
 * Full-stack check of the post-game export: a real server, a real control page,
 * and three participants answering over real WebSockets. Asserts that the CSV
 * the lecturer actually receives matches what was submitted.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createQuizServer } from '../../src/server.js';
import { startStaticServer, launchBrowser, openPage, tokenFor, connectSocket } from './harness.js';
import { loopbackHost, originFor } from '../loopback.js';

const QUIZ = {
  title: 'Networking Basics',
  secret: 'high-entropy',
  questions: [
    {
      type: 'multiple-choice',
      text: 'Which of these are <b>connection-oriented</b>?',
      options: ['TCP', 'UDP', 'SCTP'],
      correctIndices: [0, 2]
    },
    { type: 'estimation', text: 'How many bits in an IPv6 address?', correctAnswer: 128 }
  ]
};

describe('Results export (browser, full stack)', () => {
  let quizServer;
  let backendPort;
  let statics;
  let browser;
  const sockets = [];

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

  async function socket() {
    const ws = connectSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
    sockets.push(ws);
    await ws.opened;
    return ws;
  }

  /**
   * Take the CSV through the page's own copy-to-clipboard path rather than
   * reimplementing the formatting here.
   */
  function copyCsv(page) {
    return page.evaluate(async () => {
      let captured = null;
      navigator.clipboard.writeText = async (text) => { captured = text; };
      document.getElementById('btn-copy').click();
      await new Promise((r) => setTimeout(r, 200));
      return captured;
    });
  }

  it('produces a CSV whose numbers match the submitted answers', async () => {
    const token = tokenFor('michael', QUIZ);

    const presenter = await socket();
    presenter.sendJson({ type: 'create_room', presenterToken: token, quiz: QUIZ });
    const room = await presenter.take('room_created');

    const students = [];
    for (const name of ['Alice Adams', 'Bob Brown', 'Carol Clark']) {
      const ws = await socket();
      ws.sendJson({ type: 'join_room', roomId: room.roomId, name });
      await ws.take('joined');
      students.push(ws);
    }

    // The presenter's control window watches the live session.
    const page = await openPage(browser);
    page.on('pageerror', (e) => assert.fail(`control page error: ${e.message}`));
    await page.goto(`${statics.origin}/control.html?token=${token}&room=${room.roomId}`);
    // The control container is the first thing rendered once the socket
    // reports control_connected. (#question-panel starts hidden, so waiting
    // for it with the default 'visible' state would never resolve.)
    await page.waitForSelector('.control__container');

    presenter.sendJson({ type: 'start_game' });
    await presenter.take('game_started');

    students[0].sendJson({ type: 'submit_answer', answer: [0, 2] }); // correct
    students[1].sendJson({ type: 'submit_answer', answer: [0, 2] }); // correct
    students[2].sendJson({ type: 'submit_answer', answer: [1] });    // wrong
    await presenter.take('question_results');

    presenter.sendJson({ type: 'next_question' });
    await presenter.take('question_started');
    students[0].sendJson({ type: 'submit_answer', answer: 128 });
    students[1].sendJson({ type: 'submit_answer', answer: 120 });
    students[2].sendJson({ type: 'submit_answer', answer: 64 });
    await presenter.take('question_results');

    presenter.sendJson({ type: 'next_question' }); // ends the quiz
    await presenter.take('game_ended');
    await page.waitForFunction(
      () => document.getElementById('export-panel').style.display === 'block'
    );

    const csv = await copyCsv(page);
    assert.ok(typeof csv === 'string' && csv.length > 0, 'no CSV was produced');

    const lines = csv.split('\r\n');
    assert.ok(csv.includes('Networking Basics'), 'quiz title missing');
    assert.ok(!/Alice|Bob|Carol/.test(csv), 'CSV must not contain participant names');
    assert.ok(!csv.includes('Final results'), 'a quiz that does not ask for consent names nobody');
    assert.ok(!/<b>|<p>/.test(csv), 'question HTML should be reduced to plain text');

    const tcp = lines.find((l) => l.includes('1. TCP'));
    assert.match(tcp, /,yes,2,66\.7%/, `TCP chosen twice and correct: ${tcp}`);
    const udp = lines.find((l) => l.includes('2. UDP'));
    assert.match(udp, /,no,1,33\.3%/, `UDP chosen once and wrong: ${udp}`);
    const sctp = lines.find((l) => l.includes('3. SCTP'));
    assert.match(sctp, /,yes,2,66\.7%/, `SCTP chosen twice and correct: ${sctp}`);

    assert.ok(lines.some((l) => l.includes('correct: 128')), 'estimation answer missing');
    assert.ok(
      lines.some((l) => l.includes('min 64 / median 120')),
      'estimation spread missing'
    );

    await page.close();
  });

  it('lists the short answers grouped by spelling, marks those accepted in class, and keeps a formula inert', async () => {
    const quiz = {
      title: 'Java Terms',
      secret: 'high-entropy',
      questions: [{
        type: 'short-answer',
        text: 'Same name, <i>different</i> parameter lists?',
        acceptedAnswers: ['Overloading [of Methods]', 'Überladen']
      }]
    };
    const token = tokenFor('michael-terms', quiz);
    const presenter = await socket();
    presenter.sendJson({ type: 'create_room', presenterToken: token, quiz });
    const room = await presenter.take('room_created');

    const students = [];
    for (const name of ['Alice Adams', 'Bob Brown', 'Carol Clark', 'Dave Dunn']) {
      const ws = await socket();
      ws.sendJson({ type: 'join_room', roomId: room.roomId, name });
      await ws.take('joined');
      students.push(ws);
    }

    const page = await openPage(browser);
    page.on('pageerror', (e) => assert.fail(`control page error: ${e.message}`));
    await page.goto(`${statics.origin}/control.html?token=${token}&room=${room.roomId}`);
    await page.waitForSelector('.control__container');

    presenter.sendJson({ type: 'start_game' });
    await presenter.take('game_started');
    students[0].sendJson({ type: 'submit_answer', answer: 'Overloading' });
    students[1].sendJson({ type: 'submit_answer', answer: 'overloading' });
    students[2].sendJson({ type: 'submit_answer', answer: '=HYPERLINK("x")' });
    students[3].sendJson({ type: 'submit_answer', answer: 'Overload' });
    await presenter.take('question_results');

    // The lecturer counts "Overload" as right after all, from the control view.
    await page.waitForSelector('.answer-group__toggle');
    await page.evaluate(() => {
      const group = [...document.querySelectorAll('.answer-group')]
        .find((n) => n.querySelector('.answer-group__text').textContent === 'Overload');
      group.querySelector('.answer-group__toggle').click();
    });
    await presenter.take('question_results');

    presenter.sendJson({ type: 'next_question' }); // ends the quiz
    await presenter.take('game_ended');
    await page.waitForFunction(
      () => document.getElementById('export-panel').style.display === 'block'
    );

    const csv = await copyCsv(page);
    const lines = csv.split('\r\n');
    assert.ok(!/Alice|Bob|Carol/.test(csv), 'CSV must not contain participant names');

    const question = lines.find((l) => l.includes('short-answer'));
    assert.match(question, /accepted: Overloading \[of Methods\] \| Überladen,,,,3,75\.0%/, question);
    const right = lines.find((l) => l.includes('1. Overloading'));
    assert.match(right, /,yes,2,50\.0%/, `two right answers, one spelling: ${right}`);
    const accepted = lines.find((l) => /\d\. Overload,/.test(l));
    assert.match(accepted, /,yes \(accepted by presenter\),1,25\.0%/, accepted);
    const formula = lines.find((l) => l.includes('HYPERLINK'));
    assert.match(formula, /"\d\. =HYPERLINK\(""x""\)",no,1,25\.0%/, formula);
    assert.ok(!/(^|,)"?[=+@-]/.test(formula), `a field starts like a formula: ${formula}`);

    await page.close();
  });

  it('adds name and final score of those who agreed, and of nobody else', async () => {
    const quiz = { ...QUIZ, recordNamedResults: true };
    const token = tokenFor('named', quiz);

    const presenter = await socket();
    presenter.sendJson({ type: 'create_room', presenterToken: token, quiz });
    const room = await presenter.take('room_created');

    async function join(name, consent) {
      const ws = await socket();
      ws.sendJson({ type: 'join_room', roomId: room.roomId, name, consent });
      await ws.take('joined');
      return ws;
    }
    const alice = await join('Alice Adams', true);
    const bob = await join('Bob Brown', true);
    const carol = await join('Carol Clark', false);
    // Bob changes his mind before the end.
    bob.sendJson({ type: 'set_consent', consent: false });
    await bob.take('consent_updated');

    const page = await openPage(browser);
    page.on('pageerror', (e) => assert.fail(`control page error: ${e.message}`));
    await page.goto(`${statics.origin}/control.html?token=${token}&room=${room.roomId}`);
    await page.waitForSelector('.control__container');

    presenter.sendJson({ type: 'start_game' });
    await presenter.take('game_started');
    alice.sendJson({ type: 'submit_answer', answer: [0, 2] }); // correct: 100
    bob.sendJson({ type: 'submit_answer', answer: [0, 2] });   // correct: 100
    carol.sendJson({ type: 'submit_answer', answer: [1] });    // wrong: 0
    await presenter.take('question_results');

    presenter.sendJson({ type: 'next_question' });
    await presenter.take('question_started');
    alice.sendJson({ type: 'submit_answer', answer: 128 }); // closest: 100
    bob.sendJson({ type: 'submit_answer', answer: 120 });   // second: 50
    carol.sendJson({ type: 'submit_answer', answer: 64 });  // third: 25
    await presenter.take('question_results');

    presenter.sendJson({ type: 'next_question' }); // ends the quiz
    await presenter.take('game_ended');
    await page.waitForFunction(
      () => document.getElementById('export-panel').style.display === 'block'
    );

    const hint = await page.evaluate(() => document.getElementById('export-hint').textContent);
    assert.match(hint, /names and final scores of the 1 participant\(s\) who agreed/);

    const csv = await copyCsv(page);
    const lines = csv.split('\r\n');
    const section = lines.indexOf('Final results (participants who agreed to be named)');
    assert.ok(section > 0, `named section missing:\n${csv}`);
    assert.deepStrictEqual(lines.slice(section + 1), ['Name,Final score', 'Alice Adams,200']);
    assert.ok(!/Bob|Carol/.test(csv), 'only those who agreed may be named');
    // The per-question part is unchanged and still anonymous.
    assert.ok(lines.find((l) => l.includes('1. TCP')).match(/,yes,2,66\.7%/));

    await page.close();
  });
});
