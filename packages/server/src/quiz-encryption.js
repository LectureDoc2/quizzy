/**
 * Encrypting a quiz for publication -- the parameters, in one place.
 *
 * Two front ends encrypt: `tools/encrypt-quiz.js` on the command line, and the
 * browser tools page. They must agree, and not loosely. The iteration count is
 * the entire cost of an offline attack on the published blob, so a browser path
 * that quietly used a smaller number would produce files that *look* identical
 * to the ones the CLI makes and are cheaper to break -- a difference nobody
 * would notice until it mattered. One constant, imported by both.
 *
 * It sits beside `quiz-validator.js` for the same reason that one does: this is
 * where the modules shared by the server package's web pages and the root
 * `tools/` scripts live. The API server itself imports nothing from here.
 *
 * `@lecturedoc2/libcrypto` is pure Web Crypto, so this module runs unchanged in
 * Node and in the browser. In the browser that means a secure context: outside
 * HTTPS and localhost, `crypto.subtle` is undefined and encryption cannot work
 * at all. Callers on a page should check `window.isSecureContext` and say so,
 * rather than let it fail as a TypeError.
 */
import { encryptAESGCMPBKDF } from '@lecturedoc2/libcrypto';

/**
 * OWASP's current floor for PBKDF2-HMAC-SHA256.
 *
 * This matters more than it looks: the encrypted quiz ships inside the deck, so
 * every participant holds the ciphertext and can attack the password offline at
 * their leisure -- and the password protects the "secret" that keeps the
 * presenter token underivable. The count is stored in the encrypted blob and
 * read back at decryption time, so it is a property of each file rather than a
 * constant both ends have to agree on; raising it here only affects new files,
 * and old ones keep opening.
 */
export const PBKDF2_ITERATIONS = 600000;

/**
 * @param {string} quizJson  the quiz file's text, verbatim.
 * @param {string} password
 * @returns {Promise<string>} the encrypted blob, ready to be written as-is.
 */
export function encryptQuiz(quizJson, password) {
  return encryptAESGCMPBKDF(quizJson, password, PBKDF2_ITERATIONS);
}
