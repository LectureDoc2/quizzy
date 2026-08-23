/**
 * The `secret` advice, which two front ends now share.
 *
 * It used to live inside `tools/validate-quiz.js`, where it was only ever
 * exercised by running the CLI by hand. Now that the browser tools page gives
 * the same verdicts, "the same" is a property worth pinning: these tests are
 * what stop the two from quietly diverging.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  checkSecret,
  generateSecret,
  MINIMUM_SECRET_LENGTH,
  RECOMMENDED_SECRET_LENGTH,
} from '../src/quiz-secret-advice.js';

const GOOD = 'a'.repeat(RECOMMENDED_SECRET_LENGTH);

test('a long, random-looking secret raises nothing', () => {
  assert.deepStrictEqual(checkSecret({ secret: GOOD }), []);
});

test('a missing secret is reported, with the fix', () => {
  const [warning, ...rest] = checkSecret({});
  assert.strictEqual(rest.length, 0, 'one warning, not several');
  assert.match(warning, /No "secret" field\./);
  // The advice is the useful half; a warning without it just says "no".
  assert.match(warning, /openssl rand -base64 24/);
});

test('a secret of the wrong type names the type it got', () => {
  assert.match(checkSecret({ secret: 42 })[0], /wrong type: number/);
  assert.match(checkSecret({ secret: [] })[0], /wrong type: array/);
  assert.match(checkSecret({ secret: null })[0], /wrong type: object/);
});

test('an empty or whitespace-only secret is treated as absent', () => {
  for (const secret of ['', '   ', '\t\n']) {
    assert.match(checkSecret({ secret })[0], /is empty/);
  }
});

test('a short secret is reported as enumerable', () => {
  const secret = 'x9K2'.repeat(2).slice(0, MINIMUM_SECRET_LENGTH - 1);
  assert.match(checkSecret({ secret })[0], /characters\./);
  assert.match(checkSecret({ secret })[0], /enumerate/);
});

test('a long placeholder is still a placeholder', () => {
  // The point of the ordering in checkSecret: length alone would pass this.
  for (const secret of ['changeme-changeme-changeme-change', 'PLACEHOLDER-'.repeat(3)]) {
    assert.strictEqual(secret.length >= RECOMMENDED_SECRET_LENGTH, true);
    assert.match(checkSecret({ secret })[0], /looks like a placeholder/);
  }
});

test('a short placeholder gets the more useful complaint', () => {
  // "too short to matter" tells the author more than "looks like a placeholder".
  assert.match(checkSecret({ secret: 'changeme' })[0], /enumerate/);
});

test('a real but under-length secret is only nudged', () => {
  const secret = 'q7Fh2LmXpA9dRzW4uYtB'.slice(0, RECOMMENDED_SECRET_LENGTH - 4);
  assert.strictEqual(secret.length >= MINIMUM_SECRET_LENGTH, true);
  const [warning] = checkSecret({ secret });
  assert.match(warning, /recommended length/);
  assert.doesNotMatch(warning, /enumerate|placeholder/);
});

test('generateSecret produces a secret its own checker accepts', () => {
  const values = new Set();
  for (let i = 0; i < 50; i++) {
    const secret = generateSecret();
    assert.strictEqual(secret.length, RECOMMENDED_SECRET_LENGTH);
    assert.deepStrictEqual(checkSecret({ secret }), [], `rejected its own output: ${secret}`);
    values.add(secret);
  }
  // Not a randomness test -- just enough to catch a constant or a reused buffer.
  assert.strictEqual(values.size, 50, 'generateSecret repeated itself');
});
