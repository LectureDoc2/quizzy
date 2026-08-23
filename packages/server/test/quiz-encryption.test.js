/**
 * The parameters of a published quiz blob.
 *
 * `encryptQuiz` runs in Node here and in the browser on the tools page, from
 * the same source. What is worth asserting is not that AES works -- libcrypto's
 * own tests cover that -- but that this wrapper keeps handing it the iteration
 * count it is supposed to. A blob encrypted with fewer iterations decrypts
 * exactly like a correct one and is cheaper to attack, so nothing downstream
 * would ever notice the regression.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { decryptAESGCMPBKDF } from '@lecturedoc2/libcrypto';
import { encryptQuiz, PBKDF2_ITERATIONS } from '../src/quiz-encryption.js';

const QUIZ = JSON.stringify({
  title: 'Round trip',
  secret: 'DTd8pOnQ9pYrxg2FwUVhLGH4mn3sKbEa',
  questions: [{ type: 'multiple-choice', text: 'Does it come back?', options: ['yes', 'no'], correctIndices: [0] }],
});

test('the iteration count is OWASP\'s floor for PBKDF2-HMAC-SHA256', () => {
  assert.strictEqual(PBKDF2_ITERATIONS, 600000);
});

test('an encrypted quiz decrypts back to exactly what went in', async () => {
  const blob = await encryptQuiz(QUIZ, 'the quiz password');
  assert.notStrictEqual(blob, QUIZ);
  assert.strictEqual(await decryptAESGCMPBKDF(blob, 'the quiz password'), QUIZ);
});

test('the iteration count travels inside the blob', async () => {
  // Decryption is given no iteration count, so it can only be reading one out
  // of the file -- which is what lets the constant be raised later without
  // breaking quizzes already published. The blob is `iterations:salt:iv:data`,
  // each field base64, so the count is checked where it actually lives rather
  // than by searching the ciphertext for a digit string.
  const blob = await encryptQuiz(QUIZ, 'pw');
  const [iterations, salt, iv, data] = blob.split(':');
  assert.strictEqual(Buffer.from(iterations, 'base64').toString(), String(PBKDF2_ITERATIONS));
  assert.ok(salt && iv && data, 'blob is not the expected four fields');
  assert.strictEqual(await decryptAESGCMPBKDF(blob, 'pw'), QUIZ);
});

test('the same input twice gives different ciphertext', async () => {
  // A fresh salt and IV per file. Equal blobs would mean one of them is reused,
  // and a reused GCM nonce is a break, not an inefficiency.
  const [a, b] = await Promise.all([encryptQuiz(QUIZ, 'pw'), encryptQuiz(QUIZ, 'pw')]);
  assert.notStrictEqual(a, b);
});

test('the wrong password does not silently return garbage', async () => {
  const blob = await encryptQuiz(QUIZ, 'right');
  await assert.rejects(() => decryptAESGCMPBKDF(blob, 'wrong'));
});
