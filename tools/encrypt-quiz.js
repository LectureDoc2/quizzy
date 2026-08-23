#!/usr/bin/env node
/**
 * Encrypts a quiz JSON file for embedding in a deck.
 *
 * Usage:  node tools/encrypt-quiz.js <input.json> <output.txt> [password]
 *
 * With no password argument the value is read from the QUIZ_PASSWORD
 * environment variable. Passing it on the command line is convenient and
 * leaves it in the shell history and in `ps` output for every other user on
 * the machine, so prefer the variable for anything that is not a throwaway:
 *
 *     QUIZ_PASSWORD=… node tools/encrypt-quiz.js quiz.json quiz.txt
 *
 * The cipher and its parameters live in
 * `packages/server/src/quiz-encryption.js`, which the browser tools page
 * bundles as well, so both routes produce equally strong files.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { encryptQuiz } from '../packages/server/src/quiz-encryption.js';

const [inputFile, outputFile, passwordArg] = process.argv.slice(2);
const password = passwordArg ?? process.env.QUIZ_PASSWORD;

if (!inputFile || !outputFile || !password) {
  console.error('Usage: node tools/encrypt-quiz.js <input.json> <output.txt> [password]');
  console.error('       (without the argument, the password is read from QUIZ_PASSWORD)');
  process.exit(2);
}

const quizData = readFileSync(inputFile, 'utf-8');
JSON.parse(quizData); // reject a malformed quiz here rather than in a lecture hall

writeFileSync(outputFile, await encryptQuiz(quizData, password));
console.log(`Encrypted quiz written to ${outputFile}`);
