import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateQuiz, QUIZ_LIMITS } from '../src/quiz-validator.js';

const quizWith = (question) => ({
  title: 'Test',
  questions: [{ type: 'short-answer', text: 'Which concept?', ...question }]
});

describe('validateQuiz: short-answer questions', () => {
  it('accepts a question with optional parts and literal brackets', () => {
    const result = validateQuiz(quizWith({
      acceptedAnswers: ['Overloading [of Methods]', 'Überladen [von Methoden]', 'int\\[\\]'],
      match: 'strict',
      timeLimit: 40
    }));
    assert.deepStrictEqual(result, { valid: true, errors: [] });
  });

  it('requires a non-empty array of strings', () => {
    assert.match(validateQuiz(quizWith({})).errors[0], /acceptedAnswers must be an array/);
    assert.match(validateQuiz(quizWith({ acceptedAnswers: 'Overloading' })).errors[0], /must be an array/);
    assert.match(validateQuiz(quizWith({ acceptedAnswers: [] })).errors[0], /acceptedAnswers is empty/);
    assert.match(
      validateQuiz(quizWith({ acceptedAnswers: ['ok', 7] })).errors[0],
      /question 1, accepted answer 2: must be a string/
    );
  });

  it('names the answer whose brackets are malformed', () => {
    const { valid, errors } = validateQuiz(quizWith({ acceptedAnswers: ['ok', 'int[]', 'a [b'] }));
    assert.strictEqual(valid, false);
    assert.strictEqual(errors.length, 2);
    assert.match(errors[0], /accepted answer 2 "int\[\]" has an empty optional part/);
    assert.match(errors[1], /accepted answer 3 "a \[b" has a "\["/);
  });

  it('rejects an answer that is nothing but optional parts', () => {
    assert.match(validateQuiz(quizWith({ acceptedAnswers: ['[Overloading]'] })).errors[0], /is empty/);
  });

  it('bounds the number and length of answers, and what they expand to', () => {
    const many = Array.from({ length: QUIZ_LIMITS.maxAcceptedAnswers + 1 }, (_, i) => `answer ${i}`);
    assert.match(validateQuiz(quizWith({ acceptedAnswers: many })).errors[0], /more than the limit of 50/);

    const long = 'x'.repeat(QUIZ_LIMITS.maxAcceptedAnswerLength + 1);
    assert.match(validateQuiz(quizWith({ acceptedAnswers: [long] })).errors[0], /longer than 200 characters/);

    // 17 answers with 4 optional parts each: 17 * 16 = 272 spellings.
    const branching = Array.from({ length: 17 }, (_, i) => `t${i}[ a][ b][ c][ d]`);
    assert.match(validateQuiz(quizWith({ acceptedAnswers: branching })).errors[0], /expand to 272 spellings/);
  });

  it('takes match only as one of the three modes', () => {
    for (const match of ['fuzzy', 'strict', 'exact']) {
      assert.deepStrictEqual(validateQuiz(quizWith({ acceptedAnswers: ['x'], match })).errors, [], match);
    }
    assert.match(
      validateQuiz(quizWith({ acceptedAnswers: ['x'], match: 'Exact' })).errors[0],
      /match must be one of "fuzzy", "strict", "exact"/
    );
  });

  it('refuses a leftover fuzzy, which would otherwise be ignored silently', () => {
    for (const fuzzy of [false, true]) {
      assert.match(
        validateQuiz(quizWith({ acceptedAnswers: ['x'], fuzzy })).errors[0],
        /fuzzy was replaced by match: write "match": "strict"/
      );
    }
  });

  it('refuses match on a question that is not a short answer', () => {
    const quiz = { title: 'T', questions: [
      { type: 'multiple-choice', text: 'Q', options: ['a', 'b'], correctIndices: [0], match: 'exact' }
    ] };
    assert.match(validateQuiz(quiz).errors[0], /match only applies to short-answer questions/);
  });

  it('accepts an answer made of symbols only in exact mode, and says so otherwise', () => {
    assert.deepStrictEqual(validateQuiz(quizWith({ acceptedAnswers: ['//'], match: 'exact' })).errors, []);
    for (const match of [undefined, 'strict']) {
      assert.match(
        validateQuiz(quizWith({ acceptedAnswers: ['//'], match })).errors[0],
        /accepted answer 1 "\/\/" is empty once .* use "match": "exact" for answers made of symbols/
      );
    }
  });

  it('lists short-answer among the question types', () => {
    const { errors } = validateQuiz({ questions: [{ type: 'free-text', text: 'x' }] });
    assert.match(errors[0], /multiple-choice, estimation, short-answer/);
  });
});
