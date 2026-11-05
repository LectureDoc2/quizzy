/**
 * Short-answer questions: the participant types a term, and the question lists
 * the answers it accepts.
 *
 *   "acceptedAnswers": ["Overloading [of Methods]", "Überladen [von Methoden]"]
 *
 * A part in square brackets is optional, so the first entry accepts both
 * "Overloading" and "Overloading of Methods". `\[` and `\]` are literal
 * brackets (`int\[\]`), `\\` a literal backslash; any other backslash is just
 * a backslash, so that "\n" can be an answer.
 *
 * How forgiving the comparison is, the question's `match` says:
 *
 *   "fuzzy"   (the default) Case, umlauts written out ("ue" for "ü"), other
 *             diacritics, hyphens, underscores, slashes, quotes and spacing do
 *             not matter, and one typo is forgiven in a term of eight
 *             characters or more. One typo and no more, because two already
 *             turn "Encryption" into "Decryption".
 *   "strict"  The same, without the typo: for terms that differ from a wrong
 *             answer by a single letter.
 *   "exact"   Only spacing does not matter; case does. For answers made of
 *             symbols ("//", "/*") or whose case is the point ("hashCode"),
 *             which the other two modes would reduce to nothing, or to
 *             something else ("/*" to "*").
 *
 * Every mode first undoes what a keyboard does to text on its own -- smart
 * quotes and dashes, an ellipsis character, no-break and zero-width spaces,
 * decomposed umlauts -- since none of that is the participant's answer. See
 * cleanUp(). There is no "contains" matching in any mode: "Overloading or
 * Overriding" is not a right answer.
 *
 * Shared by the validator (and through it by the authoring tools), by the API
 * server's scoring, and by the join and control pages, so that all of them
 * agree on what an answer is and how long it may be. Pure JavaScript for that
 * reason: no Node imports.
 *
 * The quiz is untrusted input as far as the server is concerned (see
 * quiz-pipeline.js), and matching runs in the API server process. So there are
 * no regular expressions from the quiz, the number of variants the optional
 * parts expand to is bounded before anything is expanded, and matching an
 * answer is linear in its length per variant.
 */

/** Bounds. Generous for a term, finite for an attacker. */
export const SHORT_ANSWER_LIMITS = {
  maxAcceptedAnswers: 50,
  maxAcceptedAnswerLength: 200,
  maxOptionalParts: 4, // per accepted answer: at most 16 variants each
  maxAnswerVariants: 256 // per question
};

/** The values of a short-answer question's `match`; the first is the default. */
export const MATCH_MODES = ['fuzzy', 'strict', 'exact'];

/** How a question compares answers; tolerates an unvalidated question. */
export function matchOf(question) {
  return MATCH_MODES.includes(question?.match) ? question.match : MATCH_MODES[0];
}

/** The shortest term, after normalization, that forgives a typo. */
const FUZZY_MIN_LENGTH = 8;

const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ẞ: 'SS' };

const foldUmlauts = (text) => text.replace(/[äöüßÄÖÜẞ]/g, (c) => UMLAUTS[c]);

const collapseWhitespace = (text) => text.replace(/\s+/g, ' ').trim();

/*
 * What keyboards and operating systems substitute on their own: iOS and macOS
 * "smart punctuation" turns " into “ and -- into —, and a pasted answer can
 * bring a no-break or a zero-width space along. Mapped back to what was typed.
 */
const KEYBOARD_SUBSTITUTES = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2014': '--', '\u2013': '-', '\u2010': '-', '\u2011': '-', '\u2212': '-',
  '\u2026': '...'
};
const SUBSTITUTED = /[\u2018-\u201F\u2010\u2011\u2013\u2014\u2212\u2026]/g;
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/**
 * The answer as the participant meant to type it: composed (NFC), keyboard
 * substitutions undone, invisible characters removed, spacing collapsed. The
 * whole of the comparison in "exact" mode, and the first step in the others.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanUp(text) {
  return collapseWhitespace(
    String(text)
      .normalize('NFC')
      .replace(INVISIBLE, '')
      .replace(SUBSTITUTED, (c) => KEYBOARD_SUBSTITUTES[c] ?? c)
  );
}

/**
 * Split an accepted answer into its fixed and optional parts.
 *
 * @param {string} source
 * @returns {{parts: {text: string, optional: boolean}[]} | {error: string}}
 */
function parseAcceptedAnswer(source) {
  const parts = [];
  let text = '';
  let open = false;
  let optionalCount = 0;

  const flush = (optional) => {
    if (text !== '') parts.push({ text, optional });
    text = '';
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '\\' && (next === '[' || next === ']' || next === '\\')) {
      text += next;
      i++;
    } else if (c === '[') {
      if (open) return { error: 'has nested optional parts, which are not supported.' };
      flush(false);
      open = true;
    } else if (c === ']') {
      if (!open) return { error: 'has a "]" without a matching "[" (write \\] for a literal bracket).' };
      if (text.trim() === '') {
        return { error: 'has an empty optional part "[]" (write \\[\\] for literal brackets).' };
      }
      flush(true);
      open = false;
      // Checked here, before anything is expanded: 2^n variants.
      if (++optionalCount > SHORT_ANSWER_LIMITS.maxOptionalParts) {
        return { error: `has more than ${SHORT_ANSWER_LIMITS.maxOptionalParts} optional parts.` };
      }
    } else {
      text += c;
    }
  }
  if (open) return { error: 'has a "[" without a matching "]" (write \\[ for a literal bracket).' };
  flush(false);
  return { parts };
}

/**
 * Every spelling an accepted answer stands for, and its base form -- the one
 * with all optional parts left out.
 *
 * The variants are trimmed and their spacing collapsed: leaving out
 * "[of Methods]" must not leave the space in front of it behind.
 *
 * @param {string} source
 * @param {string} [match] the question's `match`
 * @returns {{variants: string[], base: string} | {error: string}}
 */
export function expandAcceptedAnswer(source, match = MATCH_MODES[0]) {
  if (typeof source !== 'string') return { error: 'must be a string.' };
  const parsed = parseAcceptedAnswer(source);
  if (parsed.error) return parsed;

  let variants = [''];
  for (const part of parsed.parts) {
    variants = part.optional
      ? variants.flatMap((v) => [v, v + part.text])
      : variants.map((v) => v + part.text);
  }
  variants = [...new Set(variants.map((v) => collapseWhitespace(v.normalize('NFC'))))];

  // The first variant leaves out every optional part.
  const base = variants[0];
  if (normalizeAnswer(base, match) === '') {
    if (cleanUp(base) !== '') {
      // "//": not empty as written, only once hyphens, slashes and quotes go.
      return {
        error: `is empty once the characters that "match": "${match}" ignores (- _ / and quotes) are left out; ` +
          'use "match": "exact" for answers made of symbols.'
      };
    }
    return { error: 'is empty, or empty once its optional parts are left out.' };
  }
  return { variants, base };
}

/**
 * The form two answers are compared in.
 *
 * Applied to the accepted answers and to what the participant typed alike,
 * in the question's `match` mode (see the top of this file).
 *
 * @param {string} text
 * @param {string} [match] the question's `match`
 * @returns {string}
 */
export function normalizeAnswer(text, match = MATCH_MODES[0]) {
  const cleaned = cleanUp(text);
  if (match === 'exact') return cleaned;
  return collapseWhitespace(
    foldUmlauts(cleaned.normalize('NFKC').toLowerCase())
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[-_/‐-―]/g, ' ')
      .replace(/["'`«»‘-‟]/g, '')
  );
}

/**
 * How long an answer counts as, for `maxLength`.
 *
 * Umlauts written out, because "Groesse" has to fit wherever "Größe" does, and
 * spacing collapsed, so that the space a phone keyboard puts after a word does
 * not use up the allowance for a typo. The same on both sides: the accepted
 * answers are measured with it, and so is what the participant typed.
 *
 * @param {string} text
 * @returns {number}
 */
export function measuredLength(text) {
  return collapseWhitespace(foldUmlauts(String(text).normalize('NFC'))).length;
}

/**
 * The longest input to allow for a question whose longest accepted answer
 * measures `length`: ten percent more, and at least one character more, so
 * that a typo -- which matching forgives -- still fits.
 */
export function maxLengthFor(length) {
  return length + Math.max(1, Math.ceil(length / 10));
}

/** question -> everything derived from its accepted answers, computed once. */
const compiled = new WeakMap();

/**
 * Derived once per question and cached by the question object, not stored on
 * it: a practice quiz is frozen, and a field on the question would be one
 * careless spread away from being sent to the participants.
 *
 * Tolerates a question that never went through the validator -- it is reached
 * from scoring, which runs in a timer -- by skipping what it cannot use.
 */
function compile(question) {
  let entry = compiled.get(question);
  if (entry) return entry;

  const match = matchOf(question);
  const exact = new Set();
  const bases = [];
  let longest = 0;
  let count = 0;
  const sources = Array.isArray(question.acceptedAnswers) ? question.acceptedAnswers : [];
  for (const source of sources.slice(0, SHORT_ANSWER_LIMITS.maxAcceptedAnswers)) {
    if (typeof source !== 'string' || source.length > SHORT_ANSWER_LIMITS.maxAcceptedAnswerLength) continue;
    const expanded = expandAcceptedAnswer(source, match);
    if (expanded.error) continue;
    if ((count += expanded.variants.length) > SHORT_ANSWER_LIMITS.maxAnswerVariants) break;
    bases.push(expanded.base.length);
    for (const variant of expanded.variants) {
      exact.add(normalizeAnswer(variant, match));
      longest = Math.max(longest, measuredLength(variant));
    }
  }

  entry = {
    match,
    exact,
    fuzzy: match === 'fuzzy' ? [...exact].filter((v) => v.length >= FUZZY_MIN_LENGTH) : [],
    answerLength: bases.length ? { min: Math.min(...bases), max: Math.max(...bases) } : null,
    maxLength: longest > 0 ? maxLengthFor(longest) : 0
  };
  compiled.set(question, entry);
  return entry;
}

/**
 * What a participant is told about the length of the answer.
 *
 * `answerLength` spans the base forms, measured as written -- the hint shows
 * the length one would naturally type. `maxLength` bounds the input; see
 * measuredLength().
 *
 * @param {object} question
 * @returns {{answerLength: {min: number, max: number} | null, maxLength: number}}
 */
export function answerLengths(question) {
  const { answerLength, maxLength } = compile(question);
  return { answerLength: answerLength && { ...answerLength }, maxLength };
}

/**
 * Whether `a` turns into `b` with at most one edit: a substitution, an
 * insertion, a deletion, or swapping two neighbouring characters.
 * Linear, unlike a general edit distance.
 */
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * Answers grouped by the form they are compared in, most frequent first, each
 * group shown in its most frequent spelling. The export and the presenter's
 * results view both list a question's answers this way, which is where the
 * common misconceptions show.
 *
 * A group is all right or all wrong: matching only ever sees the normalized
 * form, and so does the presenter accepting an answer after all (see
 * Room.setAnswerAccepted()). A group the presenter accepted is marked
 * `acceptedByPresenter`, which is worth knowing when the quiz is revised.
 *
 * Grouped in the question's `match` mode, which is the form matching saw: in
 * "exact" mode "/*" and "*" are two answers, in the others one.
 *
 * @param {Iterable<{answer: unknown, correct?: boolean, acceptedByPresenter?: boolean}>} entries
 * @param {object} [options]
 * @param {number} [options.limit] How many groups to list; the rest are only counted.
 * @param {string} [options.match] the question's `match`
 * @returns {{groups: {text: string, count: number, isCorrect: boolean, acceptedByPresenter?: true}[], otherCount: number}}
 */
export function groupAnswers(entries, { limit = Infinity, match = MATCH_MODES[0] } = {}) {
  const byForm = new Map(); // normalized form -> { count, isCorrect, acceptedByPresenter, spellings }
  for (const { answer, correct, acceptedByPresenter } of entries) {
    if (typeof answer !== 'string') continue;
    const form = normalizeAnswer(answer, match);
    let group = byForm.get(form);
    if (!group) {
      group = {
        count: 0,
        isCorrect: correct === true,
        acceptedByPresenter: acceptedByPresenter === true,
        spellings: new Map()
      };
      byForm.set(form, group);
    }
    group.count++;
    group.spellings.set(answer, (group.spellings.get(answer) || 0) + 1);
  }

  const groups = [...byForm.values()]
    .map(({ count, isCorrect, acceptedByPresenter, spellings }) => ({
      text: [...spellings].reduce((best, spelling) => (spelling[1] > best[1] ? spelling : best))[0],
      count,
      isCorrect,
      ...(acceptedByPresenter ? { acceptedByPresenter: true } : {})
    }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

  return {
    groups: groups.slice(0, limit),
    otherCount: groups.slice(limit).reduce((sum, group) => sum + group.count, 0)
  };
}

/**
 * Whether `answer` is one of the answers `question` accepts.
 *
 * @param {object} question
 * @param {string} answer
 * @returns {boolean}
 */
export function matchesAcceptedAnswer(question, answer) {
  if (typeof answer !== 'string') return false;
  const { match, exact, fuzzy } = compile(question);
  const normalized = normalizeAnswer(answer, match);
  if (normalized === '') return false;
  if (exact.has(normalized)) return true;
  return fuzzy.some((variant) => withinOneEdit(normalized, variant));
}
