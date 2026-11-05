import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadPracticeCatalog,
  buildPracticeCatalog,
  emptyPracticeCatalog,
  DEFAULT_PRACTICE_CATALOG_PATH,
  DEFAULT_RESULTS_SECONDS
} from '../src/practice-catalog.js';

const QUIZ = {
  title: 'Catalog Quiz',
  secret: 'not-for-practice',
  questions: [
    { type: 'multiple-choice', text: 'Pick <b>one</b>', options: ['A', 'B'], correctIndices: [0], timeLimit: 20 },
    { type: 'estimation', text: 'How many?', correctAnswer: 42 }
  ]
};

describe('Practice catalog', () => {
  let dir;
  const write = (name, value) =>
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'quizzy-practice-'));
    write('quiz.json', QUIZ);
    write('broken.json', '{ not json');
    write('invalid.json', { title: 'No questions' });
    mkdirSync(join(dir, 'sub'));
    write('sub/nested.json', { ...QUIZ, title: 'Nested' });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  function load(definition) {
    write('practice.json', definition);
    return loadPracticeCatalog(join(dir, 'practice.json'));
  }

  it('loads entries in file order, with category, description and counts', async () => {
    const { catalog, errors } = await load({
      quizzes: [
        { id: 'b', category: 'Security', file: 'quiz.json', description: 'Second' },
        { id: 'a', file: 'sub/nested.json' }
      ]
    });
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(catalog.publicList(), [
      { id: 'b', category: 'Security', title: 'Catalog Quiz', description: 'Second', questionCount: 2 },
      { id: 'a', category: null, title: 'Nested', description: null, questionCount: 2 }
    ]);
    assert.strictEqual(catalog.resultsMs, DEFAULT_RESULTS_SECONDS * 1000);
  });

  it('serves a quiz that went through the pipeline, frozen and without its secret', async () => {
    const { catalog } = await load({ quizzes: [{ id: 'q', file: 'quiz.json' }] });
    const { quiz } = catalog.get('q');
    assert.strictEqual(quiz.secret, undefined);
    assert.ok(Object.isFrozen(quiz) && Object.isFrozen(quiz.questions[0].options));
    // Same treatment as an uploaded quiz: markup is kept, answers stay.
    assert.match(quiz.questions[0].text, /<b>one<\/b>/);
    assert.deepStrictEqual(quiz.questions[0].correctIndices, [0]);
  });

  it('labels each question in plain text, for the usage statistics', async () => {
    const { catalog } = await load({ quizzes: [{ id: 'q', file: 'quiz.json' }] });
    assert.deepStrictEqual(catalog.get('q').questionLabels, ['Pick one', 'How many?']);
  });

  it('never lists answers', async () => {
    const { catalog } = await load({ quizzes: [{ id: 'q', file: 'quiz.json' }] });
    const listed = JSON.stringify(catalog.publicList());
    assert.ok(!listed.includes('correct'));
    assert.ok(!listed.includes('questions'));
  });

  it('honours resultsSeconds and falls back on a nonsensical one', async () => {
    assert.strictEqual((await load({ resultsSeconds: 12, quizzes: [] })).catalog.resultsMs, 12_000);
    const bad = await load({ resultsSeconds: -1, quizzes: [] });
    assert.strictEqual(bad.catalog.resultsMs, DEFAULT_RESULTS_SECONDS * 1000);
    assert.strictEqual(bad.errors.length, 1);
  });

  it('skips broken entries, reports each, and keeps the rest', async () => {
    const { catalog, errors } = await load({
      quizzes: [
        { id: 'ok', file: 'quiz.json' },
        { id: 'ok', file: 'quiz.json' },               // duplicate id
        { id: 'Not Valid', file: 'quiz.json' },        // id pattern
        { id: 'missing', file: 'nope.json' },
        { id: 'broken', file: 'broken.json' },
        { id: 'invalid', file: 'invalid.json' },
        { id: 'cat', category: 7, file: 'quiz.json' },
        { id: 'long', category: 'x'.repeat(101), file: 'quiz.json' },
        { id: 'blank', category: '   ', file: 'quiz.json' },
        'not an object'
      ]
    });
    assert.deepStrictEqual([...catalog.entries.keys()], ['ok']);
    assert.strictEqual(errors.length, 9);
    // The verdict ends the first line; a JSON error's excerpt follows below it.
    assert.ok(errors.every((e) => e.split('\n')[0].endsWith('skipped.')), errors.join('\n'));
  });

  it('refuses a quiz file outside the catalog directory', async () => {
    const { catalog, errors } = await load({
      quizzes: [
        { id: 'escape', file: '../outside.json' },
        { id: 'absolute', file: '/etc/passwd' }
      ]
    });
    assert.strictEqual(catalog.size, 0);
    assert.ok(errors.every((e) => e.includes('inside the catalog')), errors.join('\n'));
  });

  it('treats a missing catalog as "practice is off", not as an error', async () => {
    const result = await loadPracticeCatalog(join(dir, 'does-not-exist.json'));
    assert.strictEqual(result.missing, true);
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.catalog.size, 0);
  });

  it('reports an unreadable catalog and offers nothing', async () => {
    const result = await load('{ nope');
    assert.strictEqual(result.missing, false);
    assert.strictEqual(result.catalog.size, 0);
    assert.strictEqual(result.errors.length, 1);
  });

  it('names the file, line and column of a JSON syntax error, with the offending line', async () => {
    write('trailing-comma.json', '{\n  "title": "T",\n  "questions": [\n    1,\n  ]\n}\n');
    const { errors } = await load({ quizzes: [{ id: 'tc', file: 'trailing-comma.json' }] });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0], [
      'entry 1 ("tc"): cannot read trailing-comma.json -- skipped.',
      '    invalid JSON at line 4, column 6: trailing comma before "]"',
      '      4 |     1,',
      '        |      ^'
    ].join('\n'));
  });

  it('points into the catalog itself when it is the file that is broken', async () => {
    const { errors } = await load('{\n  "quizzes": [\n    { "id": "a" "file": "quiz.json" }\n  ]\n}');
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /^cannot read the catalog\n    invalid JSON at line 3, column 16: missing "," after this value\n/);
  });

  it('looks up only string ids', async () => {
    const { catalog } = await buildPracticeCatalog({ quizzes: [{ id: 'q', file: 'x' }] }, () => QUIZ);
    assert.ok(catalog.get('q'));
    assert.strictEqual(catalog.get(['q']), undefined);
    assert.strictEqual(catalog.get({ toString: () => 'q' }), undefined);
    assert.strictEqual(emptyPracticeCatalog().get('q'), undefined);
  });

  it('ships an example catalog in which every quiz loads', async () => {
    const { catalog, errors, missing } = await loadPracticeCatalog(DEFAULT_PRACTICE_CATALOG_PATH);
    assert.strictEqual(missing, false);
    assert.deepStrictEqual(errors, []);
    assert.ok(catalog.size > 0);
  });
});
