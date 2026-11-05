import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { parseJson, locateJsonError, formatJsonError, JsonSyntaxError } from '../src/json-location.js';

const QUIZZES = fileURLToPath(new URL('../../../quizzes/', import.meta.url));

/** The JsonSyntaxError that parseJson throws for `text`. */
function errorOf(text) {
  try {
    parseJson(text);
  } catch (err) {
    assert.ok(err instanceof JsonSyntaxError, `expected a JsonSyntaxError, got ${err}`);
    return err;
  }
  assert.fail(`parsed without an error: ${JSON.stringify(text)}`);
}

function assertAt(text, line, column, reason) {
  const err = errorOf(text);
  assert.deepStrictEqual({ line: err.line, column: err.column }, { line, column }, err.message);
  assert.match(err.reason, reason);
}

describe('parseJson', () => {
  it('returns what JSON.parse returns for valid input', () => {
    const text = '{ "a": [1, -2.5e3, true, false, null, "x\\n\\u00e9"], "b": {} }';
    assert.deepStrictEqual(parseJson(text), JSON.parse(text));
  });

  it('points at the trailing comma, not at the bracket after it', () => {
    // The bug that started this: the comma is on line 12, the "]" on line 13.
    const text = [
      '{', '  "questions": [', '    {', '      "options": [',
      '        "<code>int</code>",', '        "<code>long</code>",',
      '        "<code>String</code>",', '        "<code>Integer</code>",', '      ]', '    }', '  ]', '}'
    ].join('\n');
    const err = errorOf(text);
    assert.strictEqual(err.message, 'invalid JSON at line 8, column 31: trailing comma before "]"');
    assert.strictEqual(err.excerpt, [
      '8 |         "<code>Integer</code>",',
      '  |                               ^'
    ].join('\n'));
    assertAt('{\n  "a": 1,\n}', 2, 9, /trailing comma before "\}"/);
  });

  it('names the common hand-editing mistakes', () => {
    assertAt('{\n  "a": 1\n  "b": 2\n}', 2, 9, /missing "," after this value/);
    assertAt('[1 2]', 1, 3, /missing "," after this value/);
    assertAt('{ "a" 1 }', 1, 7, /":" after the property name/);
    assertAt("{\n  'a': 1\n}", 2, 3, /double quotes.*not single quotes/);
    assertAt('{ a: 1 }', 1, 3, /property names must be in double quotes/);
    assertAt("[ 'x' ]", 1, 3, /strings must be in double quotes/);
    assertAt('{\n  // note\n  "a": 1\n}', 2, 3, /comments are not allowed/);
    assertAt('[1, /* x */ 2]', 1, 5, /comments are not allowed/);
    assertAt('{ "a": tru }', 1, 8, /misspelled literal "tru"/);
    assertAt('{ "a": Null }', 1, 8, /unquoted text "Null"/);
    assertAt('{ "type": multiple-choice }', 1, 11, /unquoted text "multiple"/);
    assertAt('[NaN]', 1, 2, /unquoted text "NaN"/);
    assertAt('{}\n}', 2, 1, /after the end of the JSON value/);
    assertAt('  \n', 1, 1, /the text is empty/);
  });

  it('explains broken strings', () => {
    assertAt('{ "a": "abc\n}', 1, 12, /line break inside a string/);
    assertAt('{ "a": "x\ty" }', 1, 10, /tab character inside a string; write it as \\t/);
    assertAt('{ "a": "x\u0001" }', 1, 10, /U\+0001.*inside a string/);
    assertAt('{ "a": "c:\\temp\\x" }', 1, 16, /invalid escape "\\x"/);
    assertAt('{ "a": "\\u12" }', 1, 9, /four hexadecimal digits/);
    assertAt('{ "a": "never closed }', 1, 8, /unterminated string/);
  });

  it('explains broken numbers', () => {
    assertAt('[01]', 1, 2, /leading zeros/);
    assertAt('[1.]', 1, 4, /digit after "\."/);
    assertAt('[1e]', 1, 4, /exponent/);
    assertAt('[-]', 1, 2, /digit after "-"/);
    assertAt('[.5]', 1, 2, /write 0\.5, not \.5/);
    assertAt('[+1]', 1, 2, /must not start with "\+"/);
  });

  it('names invisible and look-alike characters by code point', () => {
    assertAt('\uFEFF{}', 1, 1, /byte-order mark \(U\+FEFF\)/);
    assertAt('{\n  "a":\u00A01\n}', 2, 7, /no-break space \(U\+00A0\)/);
    assertAt('[1,\u200B2]', 1, 4, /zero-width space \(U\+200B\)/);
    assertAt('{ \u201Ca\u201D: 1 }', 1, 3, /typographic quote “ \(U\+201C\).*straight "/);
    assertAt('{ "a": \u201Ex\u201C }', 1, 8, /typographic quote „ .*straight "/);
  });

  it('reports a truncated file where its content stops, and where the bracket opened', () => {
    assertAt('{\n  "a": [1, 2\n\n', 2, 13, /end of input: the "\[" at line 2, column 8 is never closed/);
    assertAt('{ "a": 1', 1, 9, /end of input: the "\{" at line 1, column 1 is never closed/);
    assertAt('{ "a": ', 1, 7, /unexpected end of input, expected a value/);
  });

  it('counts columns the same with CRLF line endings', () => {
    const lf = errorOf('{\n  "a": [1,\n  ]\n}');
    const crlf = errorOf('{\r\n  "a": [1,\r\n  ]\r\n}');
    assert.deepStrictEqual([crlf.line, crlf.column, crlf.excerpt], [lf.line, lf.column, lf.excerpt]);
  });

  it('keeps the caret under the column with tabs and long lines', () => {
    const tabbed = errorOf('{\n\t"a": [1,\n\t]\n}');
    assert.strictEqual(tabbed.excerpt, '2 |  "a": [1,\n  |         ^');

    const long = `{ "text": "${'x'.repeat(200)}", "b": tru }`;
    const err = errorOf(long);
    const [source, caret] = err.excerpt.split('\n');
    assert.ok(source.length < 100, source);
    assert.ok(source.includes('…'), source);
    assert.strictEqual(source.slice(caret.indexOf('^'), caret.indexOf('^') + 3), 'tru');
  });

  it('passes on errors that are not about syntax', () => {
    assert.throws(() => parseJson(undefined), (err) => !(err instanceof JsonSyntaxError));
  });
});

describe('formatJsonError', () => {
  it('puts the excerpt under the message, indented', () => {
    assert.strictEqual(formatJsonError(errorOf('[1,]')), [
      'invalid JSON at line 1, column 3: trailing comma before "]"',
      '  1 | [1,]',
      '    |   ^'
    ].join('\n'));
  });

  it('shows any other error as the engine reported it', () => {
    assert.strictEqual(formatJsonError(new SyntaxError('odd')), 'invalid JSON: odd');
  });
});

describe('locateJsonError agrees with JSON.parse', () => {
  const quizFiles = readdirSync(QUIZZES, { recursive: true })
    .filter((file) => file.endsWith('.json'))
    .map((file) => join(QUIZZES, file));

  const parses = (text) => {
    try { JSON.parse(text); return true; } catch { return false; }
  };

  it('on every quiz shipped in quizzes/', () => {
    assert.ok(quizFiles.length > 5, `only ${quizFiles.length} quiz files found`);
    for (const file of quizFiles) {
      const text = readFileSync(file, 'utf8');
      assert.strictEqual(locateJsonError(text) === null, parses(text), file);
    }
  });

  it('on every single-character edit of a real quiz', () => {
    // Code, escapes, nested arrays: the demo quiz with the most syntax in it.
    const text = readFileSync(join(QUIZZES, 'demo/code-demo-quiz.en.json'), 'utf8');
    assert.ok(parses(text));
    const inserts = [',', '"', '}', ']', '{', '\\', ':', 'x', '\n', '\u00A0'];
    let broken = 0;
    for (let k = 0; k < text.length; k++) {
      const variants = [text.slice(0, k) + text.slice(k + 1)];
      for (const ch of inserts) variants.push(text.slice(0, k) + ch + text.slice(k));
      for (const variant of variants) {
        const valid = parses(variant);
        if (!valid) broken++;
        assert.strictEqual(locateJsonError(variant) === null, valid,
          `disagreement at offset ${k}: ${JSON.stringify(variant.slice(Math.max(0, k - 20), k + 20))}`);
      }
    }
    assert.ok(broken > text.length, `only ${broken} variants were invalid`);
  });

  it('gives up quietly on nesting too deep to scan, leaving the engine its say', () => {
    const deep = '['.repeat(200000) + ']'.repeat(199999);
    assert.strictEqual(locateJsonError(deep), null);
    assert.throws(() => parseJson(deep), (err) => err instanceof SyntaxError && !(err instanceof JsonSyntaxError));
  });
});
