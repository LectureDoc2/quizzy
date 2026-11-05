import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PracticeStats,
  openPracticeStats,
  questionExcerpt,
  GAMES_FILE,
  QUESTIONS_FILE,
  PENDING_FILE
} from '../src/practice-stats.js';

const ENTRY = { id: 'two', title: 'Two Questions', questionLabels: ['Which?', 'How many?'] };

/** A clock the test moves by hand. */
function clock(year, month, day, hour = 12) {
  const time = { now: new Date(year, month - 1, day, hour) };
  time.next = () => { time.now = new Date(time.now.getTime() + 24 * 60 * 60 * 1000); };
  return time;
}

describe('Practice statistics: counting', () => {
  it('counts games and puts final scores into quarter bands', () => {
    const stats = new PracticeStats({ now: () => new Date(2026, 9, 28) });
    for (let i = 0; i < 9; i++) stats.gameStarted(ENTRY);
    // 0 %, 24.5 %, 25 %, 49.5 %, 50 %, 75 %, 100 %
    for (const score of [0, 49, 50, 99, 100, 150, 200]) {
      stats.gameFinished(ENTRY, { score, maxScore: 200 });
    }
    stats.gameAbandoned(ENTRY);

    assert.deepStrictEqual(stats.games['2026-10-28'].two, {
      title: 'Two Questions', started: 9, finished: 7, abandoned: 1, scoreBands: [2, 2, 1, 2]
    });
  });

  it('counts questions shown, answered and fully correct', () => {
    const stats = new PracticeStats({ now: () => new Date(2026, 9, 28) });
    stats.questionClosed(ENTRY, 0, { answered: true, points: 100 });
    stats.questionClosed(ENTRY, 0, { answered: true, points: 0 });
    stats.questionClosed(ENTRY, 0, { answered: false, points: 0 });
    stats.questionClosed(ENTRY, 1, { answered: true, points: 50 });

    assert.deepStrictEqual(stats.questions['2026-10-28'].two, [
      { index: 0, text: 'Which?', shown: 3, answered: 2, correct: 1 },
      { index: 1, text: 'How many?', shown: 1, answered: 1, correct: 0 }
    ]);
  });

  it('keeps an edited question apart from the version before it', () => {
    const stats = new PracticeStats({ now: () => new Date(2026, 9, 28) });
    stats.questionClosed(ENTRY, 0, { answered: true, points: 100 });
    stats.questionClosed({ ...ENTRY, questionLabels: ['Which one?'] }, 0, { answered: true, points: 100 });

    const { rows } = stats.completedQuestions('2026-10-29');
    assert.deepStrictEqual(rows, [
      ['2026-10-28', 'two', 1, 'Which?', 1, 1, 1],
      ['2026-10-28', 'two', 1, 'Which one?', 1, 1, 1]
    ]);
  });

  it('records nothing but the totals', () => {
    const stats = new PracticeStats({ now: () => new Date(2026, 9, 28) });
    stats.gameStarted(ENTRY);
    stats.questionClosed(ENTRY, 0, { answered: true, points: 100 });
    stats.gameFinished(ENTRY, { score: 100, maxScore: 200 });
    assert.deepStrictEqual(Object.keys(JSON.parse(JSON.stringify(stats))), ['version', 'games', 'questions']);
  });
});

describe('Practice statistics: question excerpts', () => {
  it('strips markup, folds whitespace and cuts long text short', () => {
    assert.strictEqual(questionExcerpt('Pick <b>one</b>\n of   these'), 'Pick one of these');
    const long = questionExcerpt('x'.repeat(200));
    assert.strictEqual(long.length, 80);
    assert.ok(long.endsWith('…'));
    assert.strictEqual(questionExcerpt(undefined), '');
  });
});

describe('Practice statistics: files', () => {
  let dir;
  const read = (file) => readFileSync(join(dir, file), 'utf8');

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'quizzy-stats-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a day to the CSV files only once it is over', () => {
    const time = clock(2026, 10, 28);
    const { stats, flush } = openPracticeStats(dir, { now: () => time.now });
    stats.gameStarted(ENTRY);
    stats.questionClosed(ENTRY, 0, { answered: true, points: 100 });
    stats.gameFinished(ENTRY, { score: 100, maxScore: 100 });
    flush();
    assert.ok(!existsSync(join(dir, GAMES_FILE)));
    assert.ok(!existsSync(join(dir, QUESTIONS_FILE)));
    assert.ok(JSON.parse(read(PENDING_FILE)).games['2026-10-28']);

    time.next();
    stats.gameStarted(ENTRY);
    flush();
    assert.strictEqual(read(GAMES_FILE),
      'date,quiz,title,started,finished,abandoned,score_0_25,score_25_50,score_50_75,score_75_100\n' +
      '2026-10-28,two,Two Questions,1,1,0,0,0,0,1\n');
    assert.strictEqual(read(QUESTIONS_FILE),
      'date,quiz,question,text,shown,answered,correct\n' +
      '2026-10-28,two,1,Which?,1,1,1\n');
    const pending = JSON.parse(read(PENDING_FILE));
    assert.deepStrictEqual(Object.keys(pending.games), ['2026-10-29']);
    assert.deepStrictEqual(pending.questions, {});

    // A second flush the same day adds nothing.
    flush();
    assert.strictEqual(read(GAMES_FILE).trim().split('\n').length, 2);
  });

  it('picks up the pending day after a restart, and writes it out once it is over', () => {
    const time = clock(2026, 10, 28);
    const first = openPracticeStats(dir, { now: () => time.now });
    first.stats.gameStarted(ENTRY);
    first.flush();

    const second = openPracticeStats(dir, { now: () => time.now });
    assert.deepStrictEqual(second.stats.toJSON(), first.stats.toJSON());
    second.stats.gameStarted(ENTRY);
    second.flush();

    time.next();
    openPracticeStats(dir, { now: () => time.now });
    assert.match(read(GAMES_FILE), /^2026-10-28,two,Two Questions,2,0,0,/m);
  });

  it('quotes CSV cells and keeps spreadsheets from reading them as formulas', () => {
    const time = clock(2026, 10, 28);
    const { stats, flush } = openPracticeStats(dir, { now: () => time.now });
    const entry = { id: 'odd', title: 'Commas, "quotes"', questionLabels: ['=SUM(A1)', '-5 or more?'] };
    stats.gameStarted(entry);
    stats.questionClosed(entry, 0, { answered: false, points: 0 });
    stats.questionClosed(entry, 1, { answered: false, points: 0 });
    time.next();
    flush();

    assert.match(read(GAMES_FILE), /^2026-10-28,odd,"Commas, ""quotes""",1,/m);
    assert.match(read(QUESTIONS_FILE), /^2026-10-28,odd,1,'=SUM\(A1\),1,0,0$/m);
    assert.match(read(QUESTIONS_FILE), /^2026-10-28,odd,2,'-5 or more\?,1,0,0$/m);
  });

  it('survives a file it cannot write, and tries again later without duplicating', (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const time = clock(2026, 10, 28);
    const { stats, flush } = openPracticeStats(dir, { now: () => time.now });
    stats.gameStarted(ENTRY);
    stats.questionClosed(ENTRY, 0, { answered: true, points: 100 });
    time.next();

    // A directory where the games file should be: appending to it fails.
    mkdirSync(join(dir, GAMES_FILE));
    assert.doesNotThrow(flush);
    assert.ok(errors.mock.calls.some((call) => String(call.arguments[0]).includes(GAMES_FILE)));
    // The other file is written regardless, and the games wait for the next try.
    assert.match(read(QUESTIONS_FILE), /^2026-10-28,two,1,Which\?,1,1,1$/m);
    assert.ok(JSON.parse(read(PENDING_FILE)).games['2026-10-28']);
    assert.deepStrictEqual(JSON.parse(read(PENDING_FILE)).questions, {});

    rmSync(join(dir, GAMES_FILE), { recursive: true });
    flush();
    assert.match(read(GAMES_FILE), /^2026-10-28,two,Two Questions,1,0,0,/m);
    assert.strictEqual(read(QUESTIONS_FILE).trim().split('\n').length, 2);
  });

  it('starts afresh from a pending file it cannot read', (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    writeFileSync(join(dir, PENDING_FILE), '{ not json');
    const { stats } = openPracticeStats(dir, { now: () => new Date(2026, 9, 28) });
    assert.deepStrictEqual(stats.games, {});
    assert.strictEqual(errors.mock.callCount(), 1);
  });
});
