/**
 * Advice about a quiz's `secret` field -- the one check the server deliberately
 * does not make.
 *
 * `quiz-validator.js` next door answers "is this thing shaped like a quiz at
 * all", and the server refuses a room when the answer is no. This module
 * answers a question the server has no business refusing over: "is this quiz
 * safe to *publish*". A plaintext quiz has no use for a secret, so requiring one
 * would be wrong. An author, though, almost always wants to be told.
 *
 * It lives here, next to the validator, because two front ends now ask it:
 * `tools/validate-quiz.js` on the command line and the browser tools page. The
 * advice a lecturer gets must not depend on which one they happened to use, so
 * there is one implementation and no second copy to drift.
 *
 * Deliberately free of any Node API: this module is bundled into the browser
 * page by esbuild, and an `import` of `node:fs` here would break that build.
 */

/**
 * A `secret` is what stops a student who watched the lecture from
 * reconstructing the quiz file.
 *
 * The presenter token is `SHA-256(presenterName ‖ JSON.stringify(quiz))`.
 * Everything else that goes into that hash is visible: the questions and
 * options appear on the projector, and the presenter's name is guessable in
 * about one attempt. Without a high-entropy field inside the quiz, a
 * participant can rebuild the exact JSON, compute the hash, and hold the
 * presenter's credential for that quiz -- not just today, but for every future
 * session of it.
 *
 * For an encrypted quiz the same field does a second job: participants hold the
 * ciphertext, so they can attack the password offline, and being unable to
 * recognise a correct guess by regenerating the plaintext is what makes that
 * attack expensive.
 *
 * 128 bits is the target. `openssl rand -base64 24` produces 32 characters.
 */
export const SECRET_ADVICE =
  'Add a high-entropy "secret" field at the top level of the quiz:\n' +
  '      "secret": "' + '<32 random characters>' + '"\n' +
  '    Generate one with:  openssl rand -base64 24';

export const RECOMMENDED_SECRET_LENGTH = 32;
export const MINIMUM_SECRET_LENGTH = 16;

/** Bytes of randomness behind a generated secret; 24 bytes -> 32 base64 chars. */
const SECRET_BYTES = 24;

/** @returns {string[]} warnings about the `secret` field, worst first. */
export function checkSecret(quiz) {
  if (!Object.prototype.hasOwnProperty.call(quiz, 'secret')) {
    return [
      'No "secret" field.\n' +
      '    The presenter token is SHA-256(your name + the quiz JSON). Every other\n' +
      '    ingredient is on the projector or easy to guess, so without a secret a\n' +
      '    participant who watched the lecture can rebuild the file, compute the\n' +
      '    token, and act as presenter in this and every future session of it.\n' +
      '    ' + SECRET_ADVICE
    ];
  }

  const secret = quiz.secret;
  if (typeof secret !== 'string') {
    return [`"secret" has the wrong type: ${Array.isArray(secret) ? 'array' : typeof secret}; string expected. ` + SECRET_ADVICE];
  }
  if (secret.trim() === '') {
    return ['"secret" is empty, which is the same as not having one. ' + SECRET_ADVICE];
  }
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    return [
      `"secret" is only ${secret.length} characters. That is short enough to\n` +
      '    enumerate, which defeats the point of having one. ' + SECRET_ADVICE
    ];
  }
  // Before the length check: a placeholder that happens to be long is still a
  // placeholder, and one that is short deserves the more useful complaint.
  if (/^(?:secret|changeme|change-me|password|todo|xxx+|test|example|placeholder)/i.test(secret)) {
    return ['"secret" looks like a placeholder rather than random data. ' + SECRET_ADVICE];
  }
  if (secret.length < RECOMMENDED_SECRET_LENGTH) {
    return [
      `"secret" is ${secret.length} characters; ${RECOMMENDED_SECRET_LENGTH} is the ` +
      'recommended length for roughly 128 bits.'
    ];
  }
  return [];
}

/**
 * A fresh secret, in the same shape `openssl rand -base64 24` produces.
 *
 * `crypto.getRandomValues` rather than `Math.random`: the whole value of this
 * field is that it cannot be guessed, and `Math.random` is seeded from state an
 * attacker can often recover. Both the browser and Node (>= 19) expose the Web
 * Crypto global, so this is the one implementation for both front ends.
 *
 * @returns {string} 32 base64 characters, ~192 bits of entropy.
 */
export function generateSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return btoa(String.fromCharCode(...bytes));
}
