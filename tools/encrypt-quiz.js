#!/usr/bin/env node
/**
 * Encrypts a quiz JSON file for embedding in a slide deck.
 *
 * Usage:  node tools/encrypt-quiz.js <input.json> <output.txt> [password]
 *
 * With no password argument the value is read from the QUIZ_PASSWORD
 * environment variable. Passing it on the command line is convenient and
 * leaves it in the shell history and in `ps` output for every other user on
 * the machine, so prefer the variable for anything that is not a throwaway:
 *
 *     QUIZ_PASSWORD=… node tools/encrypt-quiz.js quiz.json quiz.txt
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { encryptAESGCMPBKDF } from '@lecturedoc2/libcrypto';

// OWASP's current floor for PBKDF2-HMAC-SHA256. This matters more than it
// looks: the encrypted quiz ships inside the slide deck, so every participant
// holds the ciphertext and can attack the password offline at their leisure --
// and the password protects the "secret" that keeps the presenter token
// underivable. The iteration count is stored in the encrypted blob and read
// back at decryption time, so it is a property of each file rather than a
// constant both ends have to agree on.
const ITERATIONS = 600000;

const [inputFile, outputFile, passwordArg] = process.argv.slice(2);
const password = passwordArg ?? process.env.QUIZ_PASSWORD;

if (!inputFile || !outputFile || !password) {
  console.error('Usage: node tools/encrypt-quiz.js <input.json> <output.txt> [password]');
  console.error('       (without the argument, the password is read from QUIZ_PASSWORD)');
  process.exit(2);
}

const quizData = readFileSync(inputFile, 'utf-8');
JSON.parse(quizData); // reject a malformed quiz here rather than in a lecture hall

writeFileSync(outputFile, await encryptAESGCMPBKDF(quizData, password, ITERATIONS));
console.log(`Encrypted quiz written to ${outputFile}`);
