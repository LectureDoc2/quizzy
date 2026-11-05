import { readFileSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createRenderSandbox } from './render-sandbox.js';
import { questionExcerpt } from './practice-stats.js';
import { parseJson, formatJsonError, JsonSyntaxError } from './json-location.js';
import { locateQuizMessages } from './quiz-validator.js';

/**
 * The quizzes a student may play on their own, without a presenter.
 *
 * The catalog is a JSON file the operator keeps on the Quizzy server:
 *
 *   {
 *     "resultsSeconds": 30,
 *     "quizzes": [
 *       { "id": "germany", "category": "Geography", "file": "demo/germany-quiz.en.json",
 *         "description": "Warm-up" }
 *     ]
 *   }
 *
 * Every quiz goes through the same pipeline as an uploaded one, in the same
 * render sandbox (see render-sandbox.js), once, when the catalog is loaded --
 * not once per game. The
 * result is frozen and shared by every practice room playing it, which is what
 * keeps a game cheap enough that a lecture hall can practise at once.
 *
 * A broken entry is skipped and reported, never fatal: the catalog is loaded
 * by the same process that holds every running lecture, and a typo in one
 * practice quiz must not be what stops the server from starting.
 */

/** The catalog shipped with the repository; override with PRACTICE_CATALOG. */
const DEFAULT_PRACTICE_CATALOG_PATH = fileURLToPath(
  new URL('../../../quizzes/practice.json', import.meta.url)
);

/** How long a practice results screen stays up before the game moves on. */
const DEFAULT_RESULTS_SECONDS = 30;
const MAX_RESULTS_SECONDS = 600;

/** Ids end up in URLs (`join.html?practice=<id>`), so they are kept plain. */
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const MAX_CATEGORY_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ENTRIES = 500;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Shared by every room playing the quiz, so nothing may write to it. */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

class PracticeCatalog {
  /**
   * @param {object} options
   * @param {number} options.resultsMs
   * @param {Map<string, object>} options.entries id -> entry, in file order.
   */
  constructor({ resultsMs = DEFAULT_RESULTS_SECONDS * 1000, entries = new Map() } = {}) {
    this.resultsMs = resultsMs;
    this.entries = entries;
  }

  get size() {
    return this.entries.size;
  }

  /** The entry for `id`, or undefined. `id` comes off the wire, so it may be anything. */
  get(id) {
    return typeof id === 'string' ? this.entries.get(id) : undefined;
  }

  /**
   * What the practice page lists, in file order. Grouping by category is the
   * page's job; the order here is what lets the operator control it.
   */
  publicList() {
    return Array.from(this.entries.values(), ({ id, category, title, description, questionCount }) => ({
      id, category, title, description, questionCount
    }));
  }
}

function emptyPracticeCatalog() {
  return new PracticeCatalog();
}

/**
 * Build a catalog from its parsed definition.
 *
 * @param {unknown} definition The parsed catalog file.
 * @param {(file: string) => unknown} loadQuiz Returns the parsed quiz named by
 *   an entry's `file`; throws if it cannot.
 * @param {object} [options]
 * @param {(quiz: unknown) => Promise<object>|object} [options.prepareQuiz]
 *   Defaults to a render sandbox of its own; the server passes the shared one.
 * @param {(file: string) => string|undefined} [options.sourceOf] The text of
 *   an entry's file as loaded, so that the reasons a quiz is invalid can name
 *   the lines they are about.
 * @returns {Promise<{catalog: PracticeCatalog, errors: string[], warnings: string[]}>}
 */
async function buildPracticeCatalog(definition, loadQuiz, {
  prepareQuiz = createRenderSandbox().prepareQuiz,
  sourceOf = () => undefined
} = {}) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(definition) || !Array.isArray(definition.quizzes)) {
    return {
      catalog: emptyPracticeCatalog(),
      errors: ['the catalog must be a JSON object with a "quizzes" array.'],
      warnings
    };
  }

  let resultsSeconds = DEFAULT_RESULTS_SECONDS;
  if (definition.resultsSeconds !== undefined) {
    const value = definition.resultsSeconds;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_RESULTS_SECONDS) {
      resultsSeconds = value;
    } else {
      errors.push(
        `resultsSeconds must be a number of seconds between 0 and ${MAX_RESULTS_SECONDS}; ` +
        `using ${DEFAULT_RESULTS_SECONDS}.`
      );
    }
  }

  if (definition.quizzes.length > MAX_ENTRIES) {
    errors.push(`only the first ${MAX_ENTRIES} of ${definition.quizzes.length} quizzes are loaded.`);
  }

  const entries = new Map();
  /* One entry after the other, in file order: whether an id is a duplicate
     depends on whether the entry before it made it in. A quiz renders in a
     tenth of a second, so this costs a catalog of ordinary size about a second
     at startup -- spent before the server listens, or, on reload, while the
     old catalog is still in service. */
  for (const [index, entry] of definition.quizzes.slice(0, MAX_ENTRIES).entries()) {
    const at = isPlainObject(entry) && typeof entry.id === 'string'
      ? `entry ${index + 1} ("${entry.id}")`
      : `entry ${index + 1}`;
    /* A JSON syntax error carries its excerpt on further lines; the verdict
       belongs on the first one, not after the caret. */
    const skip = (message) => {
      const [first, ...rest] = message.split('\n');
      errors.push([`${at}: ${first} -- skipped.`, ...rest].join('\n'));
    };

    if (!isPlainObject(entry)) { skip('must be a JSON object'); continue; }
    if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
      skip('id must be 1-64 lowercase letters, digits or hyphens');
      continue;
    }
    if (entries.has(entry.id)) { skip('id is already used by an earlier entry'); continue; }
    if (typeof entry.file !== 'string' || entry.file === '') { skip('file must be a path'); continue; }

    let category = null;
    if (entry.category !== undefined && entry.category !== null) {
      if (typeof entry.category !== 'string' || entry.category.trim() === '' ||
          entry.category.length > MAX_CATEGORY_LENGTH) {
        skip(`category must be a non-empty string of at most ${MAX_CATEGORY_LENGTH} characters`);
        continue;
      }
      category = entry.category.trim();
    }

    let description = null;
    if (entry.description !== undefined && entry.description !== null) {
      if (typeof entry.description !== 'string' || entry.description.length > MAX_DESCRIPTION_LENGTH) {
        skip(`description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`);
        continue;
      }
      description = entry.description;
    }

    let quiz;
    try {
      quiz = loadQuiz(entry.file);
    } catch (err) {
      skip(cannotRead(entry.file, err));
      continue;
    }

    const prepared = await prepareQuiz(quiz);
    if (!prepared.valid) {
      const source = sourceOf(entry.file);
      skip(source === undefined
        ? `the quiz is invalid: ${prepared.errors.join('; ')}`
        : `the quiz is invalid\n${locateQuizMessages(source, prepared.errors).join('\n').replace(/^/gm, '    ')}`);
      continue;
    }
    warnings.push(...prepared.warnings.map((w) => `${at}: ${w}`));

    // The presenter-token secret is of no use to a game nobody presents, so
    // it is not kept in memory at all.
    const { secret: _secret, ...playable } = prepared.quiz;
    entries.set(entry.id, {
      id: entry.id,
      category,
      title: typeof playable.title === 'string' && playable.title !== '' ? playable.title : entry.id,
      description,
      questionCount: playable.questions.length,
      // For the usage statistics (practice-stats.js), taken from the quiz as
      // authored: the rendered text would be KaTeX markup. Never listed.
      questionLabels: quiz.questions.map((q) => questionExcerpt(q.text)),
      quiz: deepFreeze(playable)
    });
  }

  return {
    catalog: new PracticeCatalog({ resultsMs: resultsSeconds * 1000, entries }),
    errors,
    warnings
  };
}

/**
 * `cannot read <what>: <why>` -- or, for a JSON syntax error, the name on the
 * first line and the position, reason and offending line indented below it,
 * so that the line a server log prints is the one to fix.
 */
function cannotRead(what, err) {
  if (err instanceof JsonSyntaxError) {
    return `cannot read ${what}\n${formatJsonError(err).replace(/^/gm, '    ')}`;
  }
  return `cannot read ${what}: ${err.message}`;
}

/**
 * Load the catalog file at `path`. Quiz files are resolved relative to it and
 * must stay inside its directory.
 *
 * A missing catalog is not an error: it is how a deployment says it offers no
 * practice quizzes.
 *
 * @param {string} [path]
 * @param {object} [options] Passed on to buildPracticeCatalog().
 * @returns {Promise<{catalog: PracticeCatalog, errors: string[], warnings: string[], missing: boolean}>}
 */
async function loadPracticeCatalog(path = DEFAULT_PRACTICE_CATALOG_PATH, options = {}) {
  let definition;
  try {
    definition = parseJson(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { catalog: emptyPracticeCatalog(), errors: [], warnings: [], missing: true };
    }
    return {
      catalog: emptyPracticeCatalog(),
      errors: [cannotRead('the catalog', err)],
      warnings: [],
      missing: false
    };
  }

  const directory = dirname(resolve(path));
  const sources = new Map();
  const loadQuiz = (file) => {
    const target = resolve(directory, file);
    const within = relative(directory, target);
    if (within.startsWith('..') || isAbsolute(within)) {
      throw new Error('the file must be inside the catalog\'s directory');
    }
    const text = readFileSync(target, 'utf8');
    const quiz = parseJson(text);
    sources.set(file, text);
    return quiz;
  };

  const sourceOf = (file) => sources.get(file);
  return { ...(await buildPracticeCatalog(definition, loadQuiz, { sourceOf, ...options })), missing: false };
}

export {
  PracticeCatalog,
  buildPracticeCatalog,
  loadPracticeCatalog,
  emptyPracticeCatalog,
  DEFAULT_PRACTICE_CATALOG_PATH,
  DEFAULT_RESULTS_SECONDS
};
