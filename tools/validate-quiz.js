#!/usr/bin/env node
/**
 * Checks the structure of a quiz file as done by the server.
 *
 * Usage:  node tools/validate-quiz.js <quiz.json> [more.json ...] [--strict]
 *
 * This tool additionally checks one thing the server deliberately does
 * not: whether the quiz carries a `secret`. The server cannot require it,
 * because a plaintext quiz has no use for one and refusing to run without it
 * would be wrong. An author, though, almost always wants to be told.
 *
 * Exit codes: 0 all files usable, 1 something is invalid (or, with --strict, a
 * warning was raised), 2 the tool was invoked wrongly.
 */
import { readFileSync } from 'node:fs';
import { validateQuiz } from '../packages/server/src/quiz-validator.js';

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
const SECRET_ADVICE =
  'Add a high-entropy "secret" field at the top level of the quiz:\n' +
  '      "secret": "' + '<32 random characters>' + '"\n' +
  '    Generate one with:  openssl rand -base64 24';

const RECOMMENDED_SECRET_LENGTH = 32;
const MINIMUM_SECRET_LENGTH = 16;

/** @returns {string[]} warnings about the `secret` field, worst first. */
function checkSecret(quiz) {
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

function describe(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    return { errors: [`cannot be read: ${err.message}`], warnings: [] };
  }

  let quiz;
  try {
    quiz = JSON.parse(raw);
  } catch (err) {
    return { errors: [`is not valid JSON: ${err.message}`], warnings: [] };
  }

  const structure = validateQuiz(quiz);
  if (!structure.valid) return { errors: structure.errors, warnings: [] };

  return {
    errors: [],
    warnings: checkSecret(quiz),
    summary: `${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'}` +
             (quiz.title ? ` — ${quiz.title}` : '')
  };
}

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const files = args.filter((a) => !a.startsWith('--'));

if (files.length === 0) {
  console.error('Usage: node tools/validate-quiz.js <quiz.json> [more.json ...] [--strict]');
  console.error('       --strict  treat warnings as failures, for use in CI');
  process.exit(2);
}

let invalid = 0;
let warned = 0;

for (const file of files) {
  const { errors, warnings, summary } = describe(file);

  if (errors.length > 0) {
    invalid++;
    console.error(`✗ ${file}`);
    for (const error of errors) console.error(`    ${error}`);
    continue;
  }

  if (warnings.length > 0) {
    warned += warnings.length;
    console.warn(`! ${file}  (${summary})`);
    for (const warning of warnings) console.warn(`    ${warning}`);
  } else {
    console.log(`✓ ${file}  (${summary})`);
  }
}

if (invalid > 0) {
  console.error(`\n${invalid} of ${files.length} file(s) cannot be used.`);
  process.exit(1);
}
if (warned > 0 && strict) {
  console.error(`\n${warned} warning(s), and --strict was given.`);
  process.exit(1);
}
