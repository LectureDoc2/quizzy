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
import { startStaticServer, launchBrowser, openPage, tokenFor, connectSocket } from './harness.js';
import { loopbackHost, originFor } from '../loopback.js';

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
    presenter = connectSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
    sockets.push(presenter);
    await presenter.opened;
    presenter.sendJson({
      type: 'create_room',
      presenterToken: tokenFor(`p${quizServer.roomManager.rooms.size}-${sockets.length}`, QUIZ),
      quiz: QUIZ
    });
    roomId = (await presenter.take('room_created')).roomId;
  });

  async function openJoinPage(room = roomId, { locale, query = '' } = {}) {
    const page = await openPage(browser, { locale });
    pages.push(page);
    await page.goto(`${statics.origin}/join.html?room=${room}${query}`);
    return page;
  }

  /** Replace the room from beforeEach with one whose quiz asks for consent. */
  async function openNamedRoom() {
    const quiz = { ...QUIZ, recordNamedResults: true };
    presenter = connectSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
    sockets.push(presenter);
    await presenter.opened;
    presenter.sendJson({ type: 'create_room', presenterToken: tokenFor(`named-${sockets.length}`, quiz), quiz });
    roomId = (await presenter.take('room_created')).roomId;
  }

  /** Replace the room from beforeEach with one that asks for terms. */
  async function openShortAnswerRoom() {
    const quiz = {
      title: 'Java Terms',
      secret: 'high-entropy',
      questions: [
        {
          type: 'short-answer',
          text: 'Same name, different parameter lists?',
          acceptedAnswers: ['Overloading [of Methods]', 'Überladen [von Methoden]']
        },
        { type: 'short-answer', text: 'Which word?', acceptedAnswers: ['Größe'] }
      ]
    };
    presenter = connectSocket(`${originFor('ws', loopbackHost(), backendPort)}/ws`);
    sockets.push(presenter);
    await presenter.opened;
    presenter.sendJson({ type: 'create_room', presenterToken: tokenFor(`terms-${sockets.length}`, quiz), quiz });
    roomId = (await presenter.take('room_created')).roomId;
  }

  /** The state of a short-answer question's input. */
  const termField = (page) =>
    page.evaluate(() => {
      const input = document.getElementById('answer');
      const hint = document.getElementById('answer-length');
      return {
        type: input.type,
        autocorrect: input.getAttribute('autocorrect'),
        autocapitalize: input.getAttribute('autocapitalize'),
        spellcheck: input.getAttribute('spellcheck'),
        maxlength: input.getAttribute('maxlength'),
        hint: hint.textContent,
        exceeded: hint.classList.contains('answer-length--exceeded'),
        disabled: document.getElementById('submit-btn').disabled
      };
    });

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

  it('shows the closed question with the verdict on the student\'s answer', async () => {
    const page = await openJoinPage();
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Curious Student');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');

    presenter.sendJson({ type: 'start_game' });
    await page.waitForSelector('.option');
    await page.click('.option[data-index="1"]');
    await page.click('#submit-btn'); // the only participant: the question closes
    await page.waitForSelector('.feedback');

    const choice = await page.evaluate(() => ({
      question: document.querySelector('.feedback__question').textContent.trim(),
      verdict: document.querySelector('.feedback__verdict').textContent.trim(),
      selected: [...document.querySelectorAll('.feedback__option')]
        .map((o) => o.classList.contains('option--selected')),
      verdictBelowOptions: !!document.querySelector('.feedback__options + .feedback__verdict'),
      verdictColor: getComputedStyle(document.querySelector('.feedback__verdict')).color
    }));
    assert.strictEqual(choice.question, 'Pick one');
    assert.strictEqual(choice.verdict, 'Not quite.');
    assert.deepStrictEqual(choice.selected, [false, true],
      'only the student\'s own choice is marked, never the correct one');
    assert.ok(choice.verdictBelowOptions, 'the verdict goes below the options');
    assert.strictEqual(choice.verdictColor, 'rgb(185, 28, 28)', '"Not quite." is red');

    presenter.sendJson({ type: 'next_question' });
    await page.waitForSelector('#answer');
    await page.fill('#answer', '120');
    await page.click('#answer-form button');
    await page.waitForSelector('.feedback__estimate');

    const estimate = await page.evaluate(() => ({
      verdict: document.querySelector('.feedback__verdict').textContent.trim(),
      detail: document.querySelector('.feedback__estimate').textContent.trim(),
      verdictColor: getComputedStyle(document.querySelector('.feedback__verdict')).color
    }));
    assert.strictEqual(estimate.verdict, 'Yours was the only estimate.');
    assert.strictEqual(estimate.verdictColor, 'rgb(21, 128, 61)', 'a scoring estimate is green');
    assert.strictEqual(estimate.detail, 'Your answer: 120');
  });

  it('asks for a term with its expected length, and holds back one that is too long', async () => {
    await openShortAnswerRoom();
    const page = await openJoinPage();
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Curious Student');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');

    presenter.sendJson({ type: 'start_game' });
    await page.waitForSelector('#answer-length');

    let field = await termField(page);
    assert.deepStrictEqual(field, {
      type: 'text',
      autocorrect: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      maxlength: null, // it would count the raw input, spaces included
      // "Überladen" 9, "Overloading" 11.
      hint: 'Expected length: 9–11 characters',
      exceeded: false,
      disabled: false
    });

    // maxLength is 26: "Ueberladen von Methoden", 23, plus 10 %.
    await page.fill('#answer', 'x'.repeat(27));
    field = await termField(page);
    assert.strictEqual(field.hint, 'Longer than any expected answer');
    assert.ok(field.exceeded && field.disabled, 'a too-long answer cannot be sent');

    // The space a phone keyboard leaves after a word does not count.
    await page.fill('#answer', 'x'.repeat(26) + ' ');
    field = await termField(page);
    assert.strictEqual(field.hint, 'Expected length: 9–11 characters');
    assert.ok(!field.exceeded && !field.disabled);

    await page.fill('#answer', 'Ueberladen ');
    await page.click('#submit-btn'); // the only participant: the question closes
    await page.waitForSelector('.feedback__answer');
    const right = await page.evaluate(() => ({
      detail: document.querySelector('.feedback__answer').textContent.trim(),
      verdict: document.querySelector('.feedback__verdict').textContent.trim()
    }));
    assert.deepStrictEqual(right, { detail: 'Your answer: Ueberladen', verdict: 'Correct!' });

    // A single expected length, and room for the umlaut written out.
    presenter.sendJson({ type: 'next_question' });
    await page.waitForFunction(() => document.getElementById('answer-length')?.textContent.includes('5'));
    await page.fill('#answer', 'Groesse');
    field = await termField(page);
    assert.strictEqual(field.hint, 'Expected length: 5 characters');
    assert.ok(!field.disabled, '"Groesse" fits wherever "Größe" does');
  });

  it('shows a student their own short answer as text, in German', async () => {
    await openShortAnswerRoom();
    const page = await openJoinPage(roomId, { locale: 'de-DE' });
    const hits = [];
    await page.exposeFunction('_h', (what) => hits.push(what));
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Neugierige Studentin');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');

    presenter.sendJson({ type: 'start_game' });
    await page.waitForSelector('#answer-length');
    assert.strictEqual((await termField(page)).hint, 'Erwartete Länge: 9–11 Zeichen');

    const payload = '<img src=x onerror=_h(1)>'; // within maxLength (26)
    await page.fill('#answer', payload);
    await page.click('#submit-btn');
    await page.waitForSelector('.feedback__answer');
    const wrong = await page.evaluate(() => ({
      detail: document.querySelector('.feedback__answer').textContent.trim(),
      verdict: document.querySelector('.feedback__verdict').textContent.trim(),
      injected: document.querySelectorAll('.feedback img').length
    }));
    assert.deepStrictEqual(wrong, {
      detail: `Ihre Antwort: ${payload}`,
      verdict: 'Leider nicht ganz.',
      injected: 0
    });
    assert.deepStrictEqual(hits, []);
  });

  it('turns the verdict round when the lecturer accepts the answer after all', async () => {
    await openShortAnswerRoom();
    const page = await openJoinPage();
    await page.waitForSelector('#join-form');
    await page.fill('#name', 'Curious Student');
    await page.click('#join-btn');
    await page.waitForSelector('.waiting');

    presenter.sendJson({ type: 'start_game' });
    await page.waitForSelector('#answer-length');
    await page.fill('#answer', 'Overload');
    await page.click('#submit-btn');
    await page.waitForSelector('.feedback__verdict--wrong');
    const verdict = () => page.evaluate(() => ({
      verdict: document.querySelector('.feedback__verdict').textContent.trim(),
      stats: document.querySelector('.my-stats').textContent.trim()
    }));
    assert.deepStrictEqual(await verdict(), { verdict: 'Not quite.', stats: 'Your rank: 1 | Score: 0' });

    presenter.sendJson({ type: 'accept_answer', questionIndex: 0, answer: 'overload' });
    await page.waitForSelector('.feedback__verdict--correct');
    assert.deepStrictEqual(await verdict(), {
      verdict: 'Correct! Your lecturer accepted this answer.',
      stats: 'Your rank: 1 | Score: 100'
    });
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

  describe('consent to named results', () => {
    const consentShows = (page, fragment) =>
      page.waitForFunction(
        (f) => {
          const el = document.getElementById('consent-status');
          return !el.hidden && el.textContent.includes(f);
        },
        fragment,
        { timeout: 3000 }
      );

    async function joinNamed(name, tick) {
      const page = await openJoinPage();
      await page.waitForSelector('#join-form');
      if (tick) await page.check('#consent');
      await page.fill('#name', name);
      await page.click('#join-btn');
      await page.waitForSelector('.waiting');
      return page;
    }

    it('is not offered unless the quiz asks for it', async () => {
      const page = await openJoinPage();
      await page.waitForSelector('#join-form');
      assert.strictEqual(await page.$('#consent'), null);
      await page.fill('#name', 'Plain Student');
      await page.click('#join-btn');
      await page.waitForSelector('.waiting');
      assert.strictEqual(await page.evaluate(() => document.getElementById('consent-status').hidden), true);
    });

    it('is offered unticked, and optional', async () => {
      await openNamedRoom();
      const page = await openJoinPage();
      await page.waitForSelector('#join-form');
      const box = await page.evaluate(() => {
        const input = document.getElementById('consent');
        return { checked: input.checked, required: input.required, label: input.closest('label').textContent };
      });
      assert.strictEqual(box.checked, false, 'consent must never be pre-ticked');
      assert.strictEqual(box.required, false);
      assert.match(box.label, /name and final score/);
      assert.match(box.label, /individual questions are\s+not recorded/);
    });

    it('shows the choice for the whole quiz, lets it change, and says what it was at the end', async () => {
      await openNamedRoom();
      const page = await joinNamed('Agreeing Student', true);
      await consentShows(page, 'will be included');
      const participant = () => [...quizServer.roomManager.getRoom(roomId).participants.values()][0];
      assert.strictEqual(participant().consent, true);

      await page.click('#consent-toggle');
      await consentShows(page, 'will not be recorded');
      assert.strictEqual(participant().consent, false);
      await page.click('#consent-toggle');
      await consentShows(page, 'will be included');
      assert.strictEqual(participant().consent, true);

      // Survives the question screens, which replace everything in #content.
      presenter.sendJson({ type: 'start_game' });
      await page.waitForSelector('.question__text');
      await consentShows(page, 'will be included');

      presenter.sendJson({ type: 'end_game' });
      await page.waitForSelector('.results h2');
      await consentShows(page, 'were included');
      assert.strictEqual(await page.$('#consent-toggle'), null, 'nothing left to change after the end');
    });

    it('says the result is not recorded when the box is left unticked', async () => {
      await openNamedRoom();
      const page = await joinNamed('Private Student', false);
      await consentShows(page, 'will not be recorded');
      assert.strictEqual(
        [...quizServer.roomManager.getRoom(roomId).participants.values()][0].consent,
        false
      );
      presenter.sendJson({ type: 'start_game' });
      await page.waitForSelector('.question__text');
      presenter.sendJson({ type: 'end_game' });
      await consentShows(page, 'was not recorded');
    });
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

  describe('in the student\'s language', () => {
    it('speaks German to a German browser, the consent and privacy texts included', async () => {
      await openNamedRoom();
      const page = await openJoinPage(roomId, { locale: 'de-DE' });
      await page.waitForSelector('#join-form');
      const seen = await page.evaluate(() => ({
        lang: document.documentElement.lang,
        title: document.title,
        heading: document.getElementById('page-title').textContent,
        room: document.querySelector('.room-code').textContent.replace(/\s+/g, ' ').trim(),
        button: document.getElementById('join-btn').textContent,
        placeholder: document.getElementById('name').placeholder,
        consent: document.getElementById('consent').closest('label').textContent.trim(),
        privacy: document.getElementById('join-privacy').textContent.replace(/\s+/g, ' ').trim()
      }));
      assert.deepStrictEqual(
        { lang: seen.lang, title: seen.title, heading: seen.heading, button: seen.button },
        { lang: 'de', title: 'Am Quiz teilnehmen', heading: 'Am Quiz teilnehmen', button: 'Teilnehmen' }
      );
      assert.strictEqual(seen.room, `Raum: ${roomId}`);
      assert.strictEqual(seen.placeholder, 'Geben Sie Ihren Namen ein');
      assert.match(seen.consent, /^Optional: Ich willige ein, dass mein Name und meine Endpunktzahl/);
      assert.match(seen.privacy, /zufälligen Sitzungsschlüssel/);
      assert.match(seen.privacy, /wenn Sie das Kästchen oben ankreuzen\.$/);

      // Refused by the server, which sends a code; the page says it in German.
      await page.fill('#name', 'Adolf Hitler');
      await page.click('#join-btn');
      await page.waitForFunction(
        () => document.getElementById('name-error').textContent === 'Dieser Name ist nicht erlaubt.',
        { timeout: 3000 }
      );

      await page.check('#consent');
      await page.fill('#name', 'Erika Mustermann');
      await page.click('#join-btn');
      await page.waitForFunction(
        () => document.getElementById('consent-status').textContent.includes('werden in die Ergebnisse aufgenommen'),
        { timeout: 3000 }
      );
      assert.strictEqual(
        await page.evaluate(() => document.getElementById('consent-toggle').textContent),
        'Einwilligung widerrufen'
      );
    });

    it('says how much a latecomer has missed, in German', async () => {
      presenter.sendJson({ type: 'start_game' });
      await presenter.take('game_started');
      presenter.sendJson({ type: 'next_question' });
      await presenter.take('question_started');
      const page = await openJoinPage(roomId, { locale: 'de-DE' });
      await page.waitForSelector('.room-state__detail--live');
      const seen = await view(page);
      assert.strictEqual(seen.heading, 'Das Quiz läuft bereits');
      assert.strictEqual(seen.button, 'Jetzt teilnehmen');
      assert.match(seen.detail, /^Frage 2 von 3 – Sie haben 1 Frage verpasst/);
    });

    it('lets ?lang= override the browser', async () => {
      const page = await openJoinPage(roomId, { locale: 'de-DE', query: '&lang=en' });
      await page.waitForSelector('#join-form');
      const seen = await view(page);
      assert.strictEqual(await page.evaluate(() => document.documentElement.lang), 'en');
      assert.strictEqual(seen.heading, 'Join Quiz');
      assert.strictEqual(seen.detail, 'Waiting for the quiz to start.');
    });
  });
});
