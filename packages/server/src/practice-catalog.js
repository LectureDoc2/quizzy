import { readFileSync } from 'fs';
import { dirname, isAbsolute, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { prepareQuiz } from './quiz-pipeline.js';

/**
 * The quizzes a student may play on their own, without a presenter.
 *
 * The catalog is a JSON file the operator keeps on the Quizzy server:
 *
 *   {
 *     "resultsSeconds": 30,
 *     "quizzes": [
 *       { "id": "germany", "category": "Geography", "file": "germany-quiz.en.json",
 *         "description": "Warm-up" }
 *     ]
 *   }
 *
 * Every quiz goes through the same pipeline as an uploaded one (see
 * quiz-pipeline.js), once, when the catalog is loaded -- not once per game. The
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
 * @returns {{catalog: PracticeCatalog, errors: string[], warnings: string[]}}
 */
function buildPracticeCatalog(definition, loadQuiz) {
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
  definition.quizzes.slice(0, MAX_ENTRIES).forEach((entry, index) => {
    const at = isPlainObject(entry) && typeof entry.id === 'string'
      ? `entry ${index + 1} ("${entry.id}")`
      : `entry ${index + 1}`;
    const skip = (message) => errors.push(`${at}: ${message} -- skipped.`);

    if (!isPlainObject(entry)) return skip('must be a JSON object');
    if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) {
      return skip('id must be 1-64 lowercase letters, digits or hyphens');
    }
    if (entries.has(entry.id)) return skip('id is already used by an earlier entry');
    if (typeof entry.file !== 'string' || entry.file === '') return skip('file must be a path');

    let category = null;
    if (entry.category !== undefined && entry.category !== null) {
      if (typeof entry.category !== 'string' || entry.category.trim() === '' ||
          entry.category.length > MAX_CATEGORY_LENGTH) {
        return skip(`category must be a non-empty string of at most ${MAX_CATEGORY_LENGTH} characters`);
      }
      category = entry.category.trim();
    }

    let description = null;
    if (entry.description !== undefined && entry.description !== null) {
      if (typeof entry.description !== 'string' || entry.description.length > MAX_DESCRIPTION_LENGTH) {
        return skip(`description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`);
      }
      description = entry.description;
    }

    let quiz;
    try {
      quiz = loadQuiz(entry.file);
    } catch (err) {
      return skip(`cannot read ${entry.file}: ${err.message}`);
    }

    const prepared = prepareQuiz(quiz);
    if (!prepared.valid) return skip(`the quiz is invalid: ${prepared.errors.join('; ')}`);
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
      quiz: deepFreeze(playable)
    });
  });

  return {
    catalog: new PracticeCatalog({ resultsMs: resultsSeconds * 1000, entries }),
    errors,
    warnings
  };
}

/**
 * Load the catalog file at `path`. Quiz files are resolved relative to it and
 * must stay inside its directory.
 *
 * A missing catalog is not an error: it is how a deployment says it offers no
 * practice quizzes.
 *
 * @returns {{catalog: PracticeCatalog, errors: string[], warnings: string[], missing: boolean}}
 */
function loadPracticeCatalog(path = DEFAULT_PRACTICE_CATALOG_PATH) {
  let definition;
  try {
    definition = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { catalog: emptyPracticeCatalog(), errors: [], warnings: [], missing: true };
    }
    return {
      catalog: emptyPracticeCatalog(),
      errors: [`cannot read the catalog: ${err.message}`],
      warnings: [],
      missing: false
    };
  }

  const directory = dirname(resolve(path));
  const loadQuiz = (file) => {
    const target = resolve(directory, file);
    const within = relative(directory, target);
    if (within.startsWith('..') || isAbsolute(within)) {
      throw new Error('the file must be inside the catalog\'s directory');
    }
    return JSON.parse(readFileSync(target, 'utf8'));
  };

  return { ...buildPracticeCatalog(definition, loadQuiz), missing: false };
}

export {
  PracticeCatalog,
  buildPracticeCatalog,
  loadPracticeCatalog,
  emptyPracticeCatalog,
  DEFAULT_PRACTICE_CATALOG_PATH,
  DEFAULT_RESULTS_SECONDS
};
