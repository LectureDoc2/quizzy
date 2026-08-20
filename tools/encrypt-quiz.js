import { readFileSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { encryptAESGCMPBKDF } from '@lecturedoc2/libcrypto';

const ITERATIONS = 100000;

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.log('Usage: node encrypt-quiz.js <input.json> <output.txt>');
    console.log('You will be prompted for a password.');
    process.exit(1);
  }

  const [inputFile, outputFile] = args;
  const quizData = readFileSync(inputFile, 'utf-8');
  
  // Validate JSON
  JSON.parse(quizData);

  const password = process.stdin.isTTY ? 
    await promptPassword() : 
    (await readStdin()).trim();

  const encrypted = await encryptAESGCMPBKDF(quizData, password, ITERATIONS);
  writeFileSync(outputFile, encrypted);
  console.log(`Encrypted quiz written to ${outputFile}`);
}

function promptPassword() {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question('Enter password: ', (password) => {
      rl.close();
      resolve(password);
    });
  });
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
  });
}

main().catch(console.error);
