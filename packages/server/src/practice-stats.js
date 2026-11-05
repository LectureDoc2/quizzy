import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * How the practice quizzes are used, as anonymous daily totals.
 *
 * The operator wants to know which quizzes are played, how often to the end,
 * how well, and which questions are hard -- and must not end up holding
 * personal data for it, which would need a privacy notice, a legal basis and a
 * deletion concept. So this module records nothing that relates to a person:
 *
 *   - no address, client key, room id, resume token or user agent. Practice is
 *     anonymous to begin with: every player is called `Practice`;
 *   - no record per game. Each event -- a game started, a question closed, a
 *     game finished or abandoned -- adds one to a total for its quiz and day,
 *     and is gone;
 *   - no time finer than the day, so that a game cannot be picked out by when
 *     it was played.
 *
 * What is left is anonymous data in the sense of GDPR Recital 26, which the
 * GDPR does not cover. Nothing is stored on the student's device either, so
 * there is nothing to consent to under § 25 TDDDG. Caddy keeps no access log
 * (see the Caddyfile); one switched on later is what would hold addresses, not
 * these files.
 *
 * Two CSV files receive only days that are over, one row per day and quiz (and
 * question), so each row is final and appears once:
 *
 *   practice-games.csv      date,quiz,title,started,finished,abandoned,
 *                           score_0_25,score_25_50,score_50_75,score_75_100
 *   practice-questions.csv  date,quiz,question,text,shown,answered,correct
 *
 * The day in progress waits in practice-stats-pending.json, rewritten whenever
 * the entry point flushes, so that a restart -- or a crash -- costs at most the
 * minutes since the last flush.
 */

const GAMES_FILE = 'practice-games.csv';
const QUESTIONS_FILE = 'practice-questions.csv';
const PENDING_FILE = 'practice-stats-pending.json';

const GAMES_HEADER = [
  'date', 'quiz', 'title', 'started', 'finished', 'abandoned',
  'score_0_25', 'score_25_50', 'score_50_75', 'score_75_100'
];
const QUESTIONS_HEADER = ['date', 'quiz', 'question', 'text', 'shown', 'answered', 'correct'];

/** Final scores are counted in this many equal bands of the maximum. */
const SCORE_BANDS = 4;
/** What "correct" means, as in Room.getPracticeSummary(). */
const FULL_POINTS = 100;
const EXCERPT_LENGTH = 80;
const PENDING_VERSION = 1;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `YYYY-MM-DD` in the server's time zone; sorts like the dates it names. */
function localDay(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The band a final score falls into: 0 for under 25 %, ..., 3 for 75 % and up. */
function scoreBand(score, maxScore) {
  const share = maxScore > 0 && Number.isFinite(score) ? score / maxScore : 0;
  return Math.min(SCORE_BANDS - 1, Math.max(0, Math.floor(share * SCORE_BANDS)));
}

/**
 * A question as the operator will recognise it in a spreadsheet: the authored
 * text without markup, on one line, cut short.
 */
function questionExcerpt(text) {
  const plain = String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > EXCERPT_LENGTH ? `${plain.slice(0, EXCERPT_LENGTH - 1)}…` : plain;
}

function csvCell(value) {
  if (typeof value === 'number') return String(value);
  let text = String(value ?? '');
  // A spreadsheet takes a cell that starts like this for a formula.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const csvLine = (cells) => cells.map(csvCell).join(',');

function appendCsv(path, header, rows) {
  const lines = rows.map(csvLine);
  if (!existsSync(path)) lines.unshift(csvLine(header));
  appendFileSync(path, `${lines.join('\n')}\n`);
}

class PracticeStats {
  /**
   * @param {object} [options]
   * @param {() => Date} [options.now] Which day it is; for tests.
   */
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    /** day -> quiz id -> { title, started, finished, abandoned, scoreBands } */
    this.games = {};
    /** day -> quiz id -> [{ index, text, shown, answered, correct }] */
    this.questions = {};
    /** Whether anything changed since the pending file was last written. */
    this.changed = false;
  }

  /** Today's totals for a catalog entry, created on first use. */
  gameTotals(entry) {
    this.changed = true;
    const quizzes = (this.games[localDay(this.now())] ??= {});
    return (quizzes[entry.id] ??= {
      title: entry.title, started: 0, finished: 0, abandoned: 0, scoreBands: new Array(SCORE_BANDS).fill(0)
    });
  }

  gameStarted(entry) {
    this.gameTotals(entry).started++;
  }

  /** @param {{score: number, maxScore: number}} summary See Room.getPracticeSummary(). */
  gameFinished(entry, { score, maxScore }) {
    const totals = this.gameTotals(entry);
    totals.finished++;
    totals.scoreBands[scoreBand(score, maxScore)]++;
  }

  /** A game that was removed before it ended: its student never came back. */
  gameAbandoned(entry) {
    this.gameTotals(entry).abandoned++;
  }

  /**
   * A practice question has closed, answered or not.
   *
   * Kept apart by its text as well as its position, so that a quiz edited in
   * the course of a day gets a row per version of the question rather than
   * one that mixes them.
   */
  questionClosed(entry, questionIndex, { answered, points }) {
    this.changed = true;
    const text = entry.questionLabels?.[questionIndex] ?? '';
    const quizzes = (this.questions[localDay(this.now())] ??= {});
    const questions = (quizzes[entry.id] ??= []);
    let question = questions.find((q) => q.index === questionIndex && q.text === text);
    if (!question) {
      question = { index: questionIndex, text, shown: 0, answered: 0, correct: 0 };
      questions.push(question);
    }
    question.shown++;
    if (answered) question.answered++;
    if (points === FULL_POINTS) question.correct++;
  }

  /**
   * The game rows for the days before `today`, which are over. `forget()`
   * drops them once they are written; until then they stay, so that a failed
   * write loses nothing.
   */
  completedGames(today) {
    return this.completed(this.games, today, (day, quiz, t) => [
      [day, quiz, t.title, t.started, t.finished, t.abandoned, ...t.scoreBands]
    ]);
  }

  /** As completedGames(), for the question rows. */
  completedQuestions(today) {
    return this.completed(this.questions, today, (day, quiz, questions) =>
      [...questions]
        .sort((a, b) => a.index - b.index)
        .map((q) => [day, quiz, q.index + 1, q.text, q.shown, q.answered, q.correct])
    );
  }

  completed(table, today, toRows) {
    const days = Object.keys(table).filter((day) => day < today).sort();
    const rows = days.flatMap((day) =>
      Object.entries(table[day]).flatMap(([quiz, totals]) => toRows(day, quiz, totals))
    );
    const forget = () => {
      for (const day of days) delete table[day];
      this.changed = true;
    };
    return { rows, forget };
  }

  toJSON() {
    return { version: PENDING_VERSION, games: this.games, questions: this.questions };
  }

  /** Take over what toJSON() wrote, before anything is counted. */
  restore(data) {
    if (!isPlainObject(data) || data.version !== PENDING_VERSION ||
        !isPlainObject(data.games) || !isPlainObject(data.questions)) {
      throw new Error('not a practice statistics file');
    }
    this.games = data.games;
    this.questions = data.questions;
  }
}

/**
 * Keep practice statistics in `directory`.
 *
 * Picks up the totals a previous run left pending and writes out the days
 * that have ended since. A file that cannot be read or written is reported
 * and never fatal: the totals stay in memory and are tried again on the next
 * flush, and the process -- which holds every running lecture -- carries on.
 *
 * @param {string} directory
 * @param {object} [options] Passed on to PracticeStats.
 * @returns {{stats: PracticeStats, flush: () => void}}
 */
function openPracticeStats(directory, options = {}) {
  const stats = new PracticeStats(options);
  const pendingPath = join(directory, PENDING_FILE);

  try {
    mkdirSync(directory, { recursive: true });
  } catch (err) {
    console.error(`practice statistics: cannot create ${directory}: ${err.message}`);
  }
  try {
    stats.restore(JSON.parse(readFileSync(pendingPath, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`practice statistics: ignoring ${pendingPath}, which will be replaced: ${err.message}`);
    }
  }

  /** Write out the days that are over, then what is still pending. */
  function flush() {
    const today = localDay(stats.now());
    const outputs = [
      [GAMES_FILE, GAMES_HEADER, stats.completedGames(today)],
      [QUESTIONS_FILE, QUESTIONS_HEADER, stats.completedQuestions(today)]
    ];
    // Each file on its own: one that cannot be written must not hold back,
    // or duplicate, what goes into the other.
    for (const [file, header, { rows, forget }] of outputs) {
      if (rows.length === 0) continue;
      try {
        appendCsv(join(directory, file), header, rows);
        forget();
      } catch (err) {
        console.error(`practice statistics: cannot write ${file}; keeping the totals for the next try: ${err.message}`);
      }
    }

    if (!stats.changed) return;
    try {
      // Write and rename, so that a crash leaves the old file or the new one.
      const temporary = `${pendingPath}.tmp`;
      writeFileSync(temporary, JSON.stringify(stats));
      renameSync(temporary, pendingPath);
      stats.changed = false;
    } catch (err) {
      console.error(`practice statistics: cannot write ${PENDING_FILE}: ${err.message}`);
    }
  }

  flush();
  return { stats, flush };
}

export {
  PracticeStats,
  openPracticeStats,
  questionExcerpt,
  localDay,
  GAMES_FILE,
  QUESTIONS_FILE,
  PENDING_FILE
};
