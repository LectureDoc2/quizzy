/**
 * `JSON.parse` with an error message a person can act on: the line, the
 * column, the reason in plain words, and the offending line with a caret.
 *
 * ## Why not just read the engine's message
 *
 * V8 adds `(line L column C)` to most of its JSON errors, but not to the
 * "Unexpected token" family -- and that family holds the mistakes people
 * actually make by hand: a trailing comma in an array, `tru` for `true`, a
 * byte-order mark, a no-break space or a typographic quote pasted from a
 * slide. Browsers word their messages differently again, and the tools page
 * runs in the browser. So the position is not something to parse out of a
 * message; it has to be found.
 *
 * ## How
 *
 * `JSON.parse` stays the parser; nothing here runs for a file that is valid.
 * Only when it throws does `locateJsonError` scan the same text with a strict
 * RFC 8259 recognizer that builds no values and stops at the first error. If
 * the two ever disagree -- the scanner finds nothing wrong, or a pathological
 * nesting depth overflows its stack -- the engine's own error is rethrown, so
 * the result is never worse than plain `JSON.parse`.
 *
 * `locateJsonPath` does the same for a file that parses but does not
 * validate: it turns "question 21" into the line it is written on.
 *
 * Pure JavaScript with no imports: the server, the command line tools and
 * the browser tools page (bundled by esbuild) share this one module.
 */

/** Thrown by parseJson; `message` is one line, `excerpt` the caret block. */
class JsonSyntaxError extends SyntaxError {
  constructor({ offset, line, column, reason, excerpt }) {
    super(`invalid JSON at line ${line}, column ${column}: ${reason}`);
    this.name = 'JsonSyntaxError';
    this.offset = offset;
    this.line = line;
    this.column = column;
    this.reason = reason;
    this.excerpt = excerpt;
  }
}

/** Internal: unwinds the scanner to the first error. */
class Found {
  constructor(offset, reason) {
    this.offset = offset;
    this.reason = reason;
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const LITERALS = ['true', 'false', 'null'];
const VALUE_START = /[{["\-0-9tfn]/;

/*
 * Characters that are invisible, or look like the ones JSON wants, and so are
 * exactly the ones nobody can find by reading the file.
 */
const NAMED = {
  '\u00A0': 'a no-break space (U+00A0)',
  '\u00AD': 'a soft hyphen (U+00AD)',
  '\u200B': 'a zero-width space (U+200B)',
  '\u200C': 'a zero-width non-joiner (U+200C)',
  '\u200D': 'a zero-width joiner (U+200D)',
  '\u2028': 'a line separator (U+2028)',
  '\u2029': 'a paragraph separator (U+2029)',
  '\u2060': 'a word joiner (U+2060)',
  '\u202F': 'a narrow no-break space (U+202F)',
  '\u3000': 'an ideographic space (U+3000)',
  '\uFEFF': 'a zero-width no-break space (U+FEFF)',
  '\u201C': 'a typographic quote “ (U+201C)',
  '\u201D': 'a typographic quote ” (U+201D)',
  '\u201E': 'a typographic quote „ (U+201E)',
  '\u2018': 'a typographic quote ‘ (U+2018)',
  '\u2019': 'a typographic quote ’ (U+2019)',
  '\u00AB': 'a guillemet « (U+00AB)',
  '\u00BB': 'a guillemet » (U+00BB)'
};
const NEEDS_STRAIGHT_QUOTE = /[\u201C\u201D\u201E\u2018\u2019\u00AB\u00BB]/;
const CONTROL_NAMES = { 0x09: 'tab', 0x0A: 'line feed', 0x0D: 'carriage return', 0x00: 'NUL' };

const hex = (code) => 'U+' + code.toString(16).toUpperCase().padStart(4, '0');

/** How a character is named in a message: `'x'`, or by code point when it cannot be seen. */
function describeChar(text, offset) {
  const ch = String.fromCodePoint(text.codePointAt(offset));
  if (NAMED[ch]) return NAMED[ch];
  const code = ch.codePointAt(0);
  if (code < 0x20 || code === 0x7F) {
    return `a control character (${hex(code)}${CONTROL_NAMES[code] ? ', ' + CONTROL_NAMES[code] : ''})`;
  }
  if (/\s/u.test(ch) || /\p{Cf}/u.test(ch)) return `an invisible character (${hex(code)})`;
  return `'${ch}'`;
}

/**
 * The offset and reason of the first syntax error in `text`, or null if
 * there is none (or the nesting is too deep to scan).
 */
function locateJsonError(text) {
  const length = text.length;
  let i = 0;

  const fail = (offset, reason) => { throw new Found(offset, reason); };
  const skipWhitespace = () => { while (i < length && WHITESPACE.has(text[i])) i++; };

  /** The end of the last thing that is not whitespace: where a truncated file stops. */
  const endOfContent = () => {
    let j = length;
    while (j > 0 && WHITESPACE.has(text[j - 1])) j--;
    return j;
  };

  /** Something other than `expected` is at `i`; say what it is as helpfully as possible. */
  const unexpected = (expected) => {
    if (i >= length) fail(endOfContent(), `unexpected end of input, expected ${expected}`);
    const ch = text[i];
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) fail(i, 'comments are not allowed in JSON');
    if (ch === '﻿' && i === 0) {
      fail(i, 'the file starts with a byte-order mark (U+FEFF); save it as UTF-8 without BOM');
    }
    const hint = NEEDS_STRAIGHT_QUOTE.test(ch) ? '; JSON needs a straight "' : '';
    fail(i, `found ${describeChar(text, i)} where ${expected} should be${hint}`);
  };

  /** Where a bracket was opened, for "never closed" messages. */
  const where = (offset) => {
    const { line, column } = lineAndColumn(text, offset);
    return `line ${line}, column ${column}`;
  };

  const string = () => {
    const start = i;
    i++; // the opening quote
    for (;;) {
      if (i >= length) fail(start, 'unterminated string: the closing " is missing');
      const code = text.charCodeAt(i);
      if (code === 0x22) { i++; return; }
      if (code === 0x5C) {
        const escaped = text[i + 1];
        if (escaped === undefined) fail(start, 'unterminated string: the closing " is missing');
        if ('"\\/bfnrt'.includes(escaped)) { i += 2; continue; }
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            fail(i, 'invalid \\u escape: it needs exactly four hexadecimal digits');
          }
          i += 6;
          continue;
        }
        fail(i, `invalid escape "\\${escaped}"; write a backslash itself as "\\\\"`);
      }
      if (code === 0x0A || code === 0x0D) {
        fail(i, 'line break inside a string; write it as \\n, or add the missing closing "');
      }
      if (code === 0x09) fail(i, 'tab character inside a string; write it as \\t');
      if (code < 0x20) fail(i, `${describeChar(text, i)} inside a string; write it as \\u${code.toString(16).padStart(4, '0')}`);
      i++;
    }
  };

  const isDigit = (ch) => ch >= '0' && ch <= '9';

  const number = () => {
    const start = i;
    if (text[i] === '-') i++;
    if (text[i] === '0') {
      i++;
      if (isDigit(text[i])) fail(start, 'numbers must not have leading zeros');
    } else if (isDigit(text[i])) {
      while (isDigit(text[i])) i++;
    } else {
      fail(start, 'invalid number: expected a digit after "-"');
    }
    if (text[i] === '.') {
      i++;
      if (!isDigit(text[i])) fail(i, 'invalid number: expected a digit after "."');
      while (isDigit(text[i])) i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!isDigit(text[i])) fail(i, 'invalid number: expected a digit in the exponent');
      while (isDigit(text[i])) i++;
    }
  };

  /** A bare word: `true`, `false` and `null` are the only ones JSON has. */
  const word = () => {
    const start = i;
    while (i < length && /[A-Za-z0-9_$]/.test(text[i])) i++;
    const found = text.slice(start, i);
    if (LITERALS.includes(found)) return;
    if (LITERALS.some((literal) => literal.startsWith(found) || found.startsWith(literal))) {
      fail(start, `misspelled literal "${found}"; expected true, false or null`);
    }
    fail(start, `unquoted text "${found}"; strings must be in double quotes`);
  };

  const array = () => {
    const open = i;
    i++;
    skipWhitespace();
    if (text[i] === ']') { i++; return; }
    for (;;) {
      value();
      const end = i;
      skipWhitespace();
      if (text[i] === ',') {
        const comma = i;
        i++;
        skipWhitespace();
        if (text[i] === ']') fail(comma, 'trailing comma before "]"');
        continue;
      }
      if (text[i] === ']') { i++; return; }
      if (i >= length) fail(endOfContent(), `unexpected end of input: the "[" at ${where(open)} is never closed`);
      if (VALUE_START.test(text[i])) fail(end, 'missing "," after this value');
      unexpected('"," or "]"');
    }
  };

  const object = () => {
    const open = i;
    i++;
    skipWhitespace();
    if (text[i] === '}') { i++; return; }
    for (;;) {
      skipWhitespace();
      if (text[i] !== '"') {
        if (text[i] === "'") fail(i, 'property names must be in double quotes ("), not single quotes');
        if (i < length && /[A-Za-z_$]/.test(text[i])) fail(i, 'property names must be in double quotes');
        unexpected('a property name in double quotes');
      }
      string();
      skipWhitespace();
      if (text[i] !== ':') unexpected('":" after the property name');
      i++;
      value();
      const end = i;
      skipWhitespace();
      if (text[i] === ',') {
        const comma = i;
        i++;
        skipWhitespace();
        if (text[i] === '}') fail(comma, 'trailing comma before "}"');
        continue;
      }
      if (text[i] === '}') { i++; return; }
      if (i >= length) fail(endOfContent(), `unexpected end of input: the "{" at ${where(open)} is never closed`);
      if (text[i] === '"') fail(end, 'missing "," after this value');
      unexpected('"," or "}"');
    }
  };

  const value = () => {
    skipWhitespace();
    const ch = text[i];
    if (ch === '{') return object();
    if (ch === '[') return array();
    if (ch === '"') return string();
    if (ch === '-' || isDigit(ch)) return number();
    if (ch !== undefined && /[A-Za-z_$]/.test(ch)) return word();
    if (ch === "'") fail(i, 'strings must be in double quotes ("), not single quotes');
    if (ch === '.') fail(i, 'numbers must start with a digit: write 0.5, not .5');
    if (ch === '+') fail(i, 'numbers must not start with "+"');
    return unexpected('a value');
  };

  try {
    skipWhitespace();
    if (i >= length) {
      // An empty file, or one with only a BOM-less blank: say so plainly.
      fail(0, 'the text is empty');
    }
    value();
    skipWhitespace();
    if (i < length) {
      if (text[i] === ',') fail(i, 'unexpected "," after the end of the JSON value');
      fail(i, `found ${describeChar(text, i)} after the end of the JSON value`);
    }
    return null;
  } catch (err) {
    if (err instanceof Found) return { offset: err.offset, reason: err.reason };
    if (err instanceof RangeError) return null; // nested too deeply to scan
    throw err;
  }
}

/** 1-based line and column of `offset`; a CR before an LF does not count as a column. */
function lineAndColumn(text, offset) {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < offset && k < text.length; k++) {
    if (text[k] === '\n') { line++; lineStart = k + 1; }
  }
  return { line, column: offset - lineStart + 1, lineStart };
}

const EXCERPT_WIDTH = 76;
const EXCERPT_BEFORE = 50;

/**
 * The offending line and a caret under the column:
 *
 *   12 |         "<code>Integer</code>",
 *      |                               ^
 *
 * Tabs and other control characters become single spaces so the caret lines
 * up; a long line is cut to a window around the column, with `…` marking the
 * cuts.
 */
function excerptAt(text, offset) {
  const { line, column, lineStart } = lineAndColumn(text, offset);
  let lineEnd = text.indexOf('\n', lineStart);
  if (lineEnd < 0) lineEnd = text.length;
  let source = text.slice(lineStart, lineEnd).replace(/\r$/, '').replace(/[\x00-\x1F]/g, ' ');
  let caret = column - 1;

  if (source.length > EXCERPT_WIDTH) {
    let from = Math.max(0, caret - EXCERPT_BEFORE);
    const to = Math.min(source.length, from + EXCERPT_WIDTH);
    from = Math.max(0, to - EXCERPT_WIDTH);
    let shown = source.slice(from, to);
    caret -= from;
    if (from > 0) { shown = '…' + shown; caret += 1; }
    if (to < source.length) shown += '…';
    source = shown;
  }

  const number = String(line);
  return `${number} | ${source}\n${' '.repeat(number.length)} | ${' '.repeat(caret)}^`;
}

/**
 * Where the value at `path` (property names and array indices, e.g.
 * `['questions', 20, 'acceptedAnswers']`) is written in the valid JSON `text`.
 *
 * A validation message names a part of the quiz, not a place in the file;
 * this finds the place. A property points at its name, an array element at
 * its first character. A path that runs into something that is not there --
 * a missing property, an index past the end -- stops at the deepest part that
 * is, so a "missing field" message points at the object it is missing from.
 * With a duplicate property name the last one counts, as in `JSON.parse`.
 *
 * @returns {{offset: number, line: number, column: number, excerpt: string,
 *            path: Array<string|number>} | null} `path` is the part found;
 *   null if `text` is not valid JSON.
 */
function locateJsonPath(text, path) {
  const length = text.length;
  let i = 0;
  const skipWhitespace = () => { while (i < length && WHITESPACE.has(text[i])) i++; };
  const skipString = () => {
    i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
  };
  const skipValue = () => {
    skipWhitespace();
    if (text[i] === '"') return skipString();
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      for (;;) {
        const ch = text[i];
        if (ch === '"') { skipString(); continue; }
        if (ch === '{' || ch === '[') depth++;
        else if ((ch === '}' || ch === ']') && --depth === 0) { i++; return; }
        i++;
      }
    }
    while (i < length && !WHITESPACE.has(text[i]) && !',]}'.includes(text[i])) i++;
  };

  try {
    JSON.parse(text);
  } catch {
    return null;
  }

  skipWhitespace();
  let offset = i;
  const found = [];
  for (const step of path) {
    skipWhitespace();
    let target = null; // { at, value }: where to point, and where the value starts
    if (text[i] === '{' && typeof step === 'string') {
      i++;
      skipWhitespace();
      while (text[i] !== '}') {
        skipWhitespace();
        const keyStart = i;
        skipString();
        const key = JSON.parse(text.slice(keyStart, i));
        skipWhitespace();
        i++; // ':'
        skipWhitespace();
        if (key === step) target = { at: keyStart, value: i };
        skipValue();
        skipWhitespace();
        if (text[i] === ',') i++;
      }
    } else if (text[i] === '[' && Number.isInteger(step) && step >= 0) {
      i++;
      skipWhitespace();
      for (let index = 0; text[i] !== ']'; index++) {
        skipWhitespace();
        if (index === step) { target = { at: i, value: i }; break; }
        skipValue();
        skipWhitespace();
        if (text[i] === ',') i++;
        skipWhitespace();
      }
    }
    if (!target) break;
    offset = target.at;
    i = target.value;
    found.push(step);
  }

  const { line, column } = lineAndColumn(text, offset);
  return { offset, line, column, excerpt: excerptAt(text, offset), path: found };
}

/**
 * `JSON.parse(text)`, throwing a JsonSyntaxError with the position of the
 * first error. Errors that are not syntax errors pass through untouched.
 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError) || typeof text !== 'string') throw err;
    const found = locateJsonError(text);
    if (!found) throw err;
    const { line, column } = lineAndColumn(text, found.offset);
    throw new JsonSyntaxError({
      offset: found.offset,
      line,
      column,
      reason: found.reason,
      excerpt: excerptAt(text, found.offset)
    });
  }
}

/**
 * A JSON error as text for a log, a terminal or the tools page: the one-line
 * message, then the excerpt indented under it. Any other error is shown as
 * `invalid JSON: <engine message>`.
 */
function formatJsonError(err) {
  if (err instanceof JsonSyntaxError) {
    return `${err.message}\n${err.excerpt.replace(/^/gm, '  ')}`;
  }
  return `invalid JSON: ${err.message}`;
}

export { parseJson, locateJsonError, locateJsonPath, formatJsonError, JsonSyntaxError };
