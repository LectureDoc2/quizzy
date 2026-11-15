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
    await browser?.close();
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
    presenter.sendJson({
      type: 'create_room', presenterToken: token, presenterName: '  =Networks\u0000 WS 26/27 ', quiz: QUIZ
    });
    const room = await presenter.take('room_created');
    const before = Date.now();

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
    // The session name as given when the room was opened, tidied, and kept
    // from being read as a formula; then when the game was played, in the
    // browser's local time.
    assert.strictEqual(lines[2], "Session,'=Networks WS 26/27");
    const [, date] = lines[3].match(/^Date,(\d{4}-\d{2}-\d{2})$/) || [];
    const [, time] = lines[4].match(/^Time,(\d{2}:\d{2})$/) || [];
    assert.ok(date && time, `date and time missing: ${lines[3]} / ${lines[4]}`);
    const played = new Date(`${date}T${time}:00`).getTime();
    assert.ok(played > before - 120_000 && played <= Date.now(), `played at ${date} ${time}`);
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

  it('counts per item of an ordering question how many put it in its place', async () => {
    const items = ['<code>byte</code>', '<code>short</code>', '<code>int</code>'];
    const quiz = {
      title: 'Java Types',
      secret: 'high-entropy',
      questions: [{ type: 'ordering', text: 'Order by <b>value range</b>', options: items }]
    };
    const token = tokenFor('michael-order', quiz);
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
    const shown = (await students[0].take('question')).question.options;
    const answer = (order) => order.map((item) => shown.indexOf(items[item]));
    students[0].sendJson({ type: 'submit_answer', answer: answer([0, 1, 2]) }); // right
    students[1].sendJson({ type: 'submit_answer', answer: answer([0, 1, 2]) }); // right
    students[2].sendJson({ type: 'submit_answer', answer: answer([1, 0, 2]) }); // int in place
    students[3].sendJson({ type: 'submit_answer', answer: answer([2, 1, 0]) }); // short in place
    await presenter.take('question_results');

    presenter.sendJson({ type: 'next_question' }); // ends the quiz
    await presenter.take('game_ended');
    await page.waitForFunction(
      () => document.getElementById('export-panel').style.display === 'block'
    );

    const csv = await copyCsv(page);
    const lines = csv.split('\r\n');
    assert.ok(!/Alice|Bob|Carol|Dave/.test(csv), 'CSV must not contain participant names');
    const row = (n, text) => lines.find((l) => l.includes(`${n}. ${text}`));
    assert.match(row(1, 'byte'), /^1,ordering,Order by value range,4,1\. byte,position 1,2,50\.0%,2,50\.0%$/, row(1, 'byte'));
    assert.match(row(2, 'short'), /^1,ordering,,,2\. short,position 2,3,75\.0%,,$/, row(2, 'short'));
    assert.match(row(3, 'int'), /^1,ordering,,,3\. int,position 3,3,75\.0%,,$/, row(3, 'int'));

    await page.close();
  });

  it('adds name and final score of those who agreed, and of nobody else', async () => {
    const quiz = { ...QUIZ, recordResults: 'named' };
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
  it('lists every participant with every answer in a graded quiz, the removed entry included', async () => {
    const quiz = {
      title: 'Graded',
      secret: 'high-entropy',
      recordResults: 'all',
      questions: [
        QUIZ.questions[0],
        { type: 'short-answer', text: 'Which operator compares?', acceptedAnswers: ['=='], match: 'exact' },
        { type: 'ordering', text: 'Order by size', options: ['byte', 'short', 'int'] }
      ]
    };
    const token = tokenFor('graded', quiz);
    const presenter = await socket();
    presenter.sendJson({ type: 'create_room', presenterToken: token, quiz });
    const room = await presenter.take('room_created');

    async function join(name) {
      const ws = await socket();
      ws.sendJson({ type: 'join_room', roomId: room.roomId, name });
      const joined = await ws.take('joined');
      ws.participantId = joined.participantId;
      return ws;
    }
    const alice = await join('Alice Adams');
    const bob = await join('Bob Brown');
    const carol = await join('1234567'); // a matriculation number

    const page = await openPage(browser);
    page.on('pageerror', (e) => assert.fail(`control page error: ${e.message}`));
    await page.goto(`${statics.origin}/control.html?token=${token}&room=${room.roomId}`);
    await page.waitForSelector('.control__container');
    // The control view says what this quiz does, and lists who is in it.
    await page.waitForFunction(() => document.querySelectorAll('.participants-list__item').length === 3);
    assert.match(await page.evaluate(() => document.getElementById('quiz-options').textContent), /^Graded:/);

    presenter.sendJson({ type: 'start_game' });
    await presenter.take('game_started');
    alice.sendJson({ type: 'submit_answer', answer: [0, 2] }); // correct
    bob.sendJson({ type: 'submit_answer', answer: [] });       // nothing selected
    carol.sendJson({ type: 'submit_answer', answer: [1] });    // wrong
    await presenter.take('question_results');

    // Bob is removed by the lecturer, through the page, and comes back under
    // the same name as a new entry.
    await page.waitForFunction(() => document.querySelectorAll('.participants-list__remove').length === 3);
    await page.evaluate(() => {
      [...document.querySelectorAll('.participants-list__item')]
        .find((item) => item.querySelector('.participants-list__name').textContent === 'Bob Brown')
        .querySelector('.participants-list__remove').click();
    });
    await page.click('#confirm-dialog-confirm');
    await bob.take('kicked');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.participants-list__item--removed .participants-list__name')]
        .some((n) => n.textContent === 'Bob Brown'));
    const bobAgain = await join('Bob Brown');

    presenter.sendJson({ type: 'next_question' });
    await presenter.take('question_started');
    alice.sendJson({ type: 'submit_answer', answer: '==' });      // correct, and looks like a formula
    bobAgain.sendJson({ type: 'submit_answer', answer: '=' });    // wrong, likewise
    // Carol does not answer this one.
    await bobAgain.take('answer_accepted');
    presenter.sendJson({ type: 'end_question' });
    await presenter.take('question_results');

    presenter.sendJson({ type: 'next_question' });
    await presenter.take('question_started');
    // Alice's socket still holds the two questions before this one.
    let shown;
    do {
      const { question } = await alice.take('question');
      shown = question.type === 'ordering' ? question.options : undefined;
    } while (!shown);
    const positions = (items) => items.map((item) => shown.indexOf(item));
    alice.sendJson({ type: 'submit_answer', answer: positions(['byte', 'short', 'int']) });    // correct
    bobAgain.sendJson({ type: 'submit_answer', answer: positions(['short', 'byte', 'int']) }); // wrong
    carol.sendJson({ type: 'submit_answer', answer: positions(['int', 'short', 'byte']) });    // wrong
    await presenter.take('question_results');

    presenter.sendJson({ type: 'next_question' }); // ends the quiz
    await presenter.take('game_ended');
    await page.waitForFunction(
      () => document.getElementById('export-panel').style.display === 'block'
    );

    const hint = await page.evaluate(() => document.getElementById('export-hint').textContent);
    assert.match(hint, /lists every participant by name \(4 row\(s\)\), with every answer they gave/);
    assert.match(hint, /Download it now: the server stores nothing permanently/);

    const csv = await copyCsv(page);
    const lines = csv.split('\r\n');
    const section = lines.indexOf('"Individual results (every participant, recorded for grading)"');
    assert.ok(section > 0, `individual section missing:\n${csv}`);
    assert.deepStrictEqual(lines.slice(section + 1), [
      'Name,Status,Final score,Q1 answer,Q1 points,Q2 answer,Q2 points,Q3 answer,Q3 points',
      // The apostrophe keeps a spreadsheet from reading the answer as a formula.
      "1234567,,0,2,0,,0,3 > 2 > 1,0",
      "Alice Adams,,300,1 | 3,100,'==,100,1 > 2 > 3,100",
      'Bob Brown,removed by lecturer,0,(nothing selected),0,,0,,0',
      "Bob Brown,,0,,0,'=,0,2 > 1 > 3,0"
    ]);
    assert.ok(!csv.includes('participants who agreed to be named'), 'no consent section in a graded quiz');
    // The per-question part is unchanged.
    assert.ok(lines.find((l) => l.includes('1. TCP')).match(/,yes,1,33\.3%/));

    await page.close();
  });
});
