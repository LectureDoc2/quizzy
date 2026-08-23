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
 *
 * The structural checks live in `packages/server/src/quiz-validator.js` and the
 * `secret` advice in `packages/server/src/quiz-secret-advice.js`, both of which
 * the browser tools page bundles as well -- so a quiz gets the same verdict
 * here and at /tools.html. What is left in this file is the command line.
 */
import { readFileSync } from 'node:fs';
import { validateQuiz } from '../packages/server/src/quiz-validator.js';
import { checkSecret } from '../packages/server/src/quiz-secret-advice.js';

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
