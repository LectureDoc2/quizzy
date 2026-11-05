import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateQuiz, QUIZ_LIMITS, quizMessagePath, locateQuizMessages } from '../src/quiz-validator.js';

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
    assert.match(errors[0], /multiple-choice, estimation, short-answer, ordering/);
  });
});

describe('validateQuiz: ordering questions', () => {
  const orderingWith = (question) => ({
    title: 'Test',
    questions: [{ type: 'ordering', text: 'Order by value (ascending).', ...question }]
  });

  it('accepts 2 to 10 distinct items, markup and code included', () => {
    assert.deepStrictEqual(
      validateQuiz(orderingWith({ options: ['<code>7</code>', '<code>0xB</code>', '<code>0x12</code>'], timeLimit: 30 })),
      { valid: true, errors: [] }
    );
    assert.strictEqual(validateQuiz(orderingWith({ options: ['a', 'b'] })).valid, true);
    const ten = Array.from({ length: QUIZ_LIMITS.maxOrderingItems }, (_, i) => `item ${i}`);
    assert.strictEqual(validateQuiz(orderingWith({ options: ten })).valid, true);
  });

  it('requires an array of at least two and at most ten strings', () => {
    assert.match(validateQuiz(orderingWith({})).errors[0], /options must be an array, listing the items in the correct order/);
    assert.match(validateQuiz(orderingWith({ options: ['only'] })).errors[0], /needs at least 2 options to order/);
    const eleven = Array.from({ length: QUIZ_LIMITS.maxOrderingItems + 1 }, (_, i) => `item ${i}`);
    assert.match(validateQuiz(orderingWith({ options: eleven })).errors[0], /11 options, more than the limit of 10/);
    assert.match(validateQuiz(orderingWith({ options: ['a', 7] })).errors[0], /option 2: must be a string/);
    assert.match(
      validateQuiz(orderingWith({ options: ['a', 'x'.repeat(QUIZ_LIMITS.maxOptionLength + 1)] })).errors[0],
      /option 2: is longer than/
    );
  });

  it('refuses two items that look the same, since nobody could tell their order', () => {
    assert.match(
      validateQuiz(orderingWith({ options: ['<code>int</code>', 'long', ' <code>int</code> '] })).errors[0],
      /option 3: is the same as option 1/
    );
  });

  it('refuses correctIndices, which would suggest it says what is right', () => {
    assert.match(
      validateQuiz(orderingWith({ options: ['a', 'b'], correctIndices: [1, 0] })).errors[0],
      /correctIndices does not apply to ordering questions; list the options in the correct order instead/
    );
  });

  it('refuses match, like every type but short-answer', () => {
    assert.match(
      validateQuiz(orderingWith({ options: ['a', 'b'], match: 'exact' })).errors[0],
      /match only applies to short-answer questions/
    );
  });
});

describe('locateQuizMessages', () => {
  it('reads the part of the quiz a message is about', () => {
    assert.deepStrictEqual(quizMessagePath('question 21: acceptedAnswers must be an array of strings.'),
      ['questions', 20, 'acceptedAnswers']);
    assert.deepStrictEqual(quizMessagePath('question 3, option 2: must be a string.'), ['questions', 2, 'options', 1]);
    assert.deepStrictEqual(quizMessagePath('question 1, accepted answer 4 "//" is empty ...'),
      ['questions', 0, 'acceptedAnswers', 3]);
    assert.deepStrictEqual(quizMessagePath('question 2: needs at least two options.'), ['questions', 1, 'needs']);
    assert.deepStrictEqual(quizMessagePath('title must be a string.'), ['title']);
  });

  it('names the line of each problem and shows it, using the quiz validateQuiz rejected', () => {
    const text = [
      '{',
      '  "title": 7,',
      '  "questions": [',
      '    { "type": "estimation", "text": "?", "correctAnswer": 1 },',
      '    {',
      '      "type": "short-answer",',
      '      "text": "?",',
      '      "acceptedAnswers": "oops"',
      '    },',
      '    { "type": "multiple-choice", "text": "?", "correctIndices": [0],',
      '      "options": ["a", 2] },',
      '    { "type": "estimation", "text": "?" }',
      '  ]',
      '}'
    ].join('\n');
    const { errors } = validateQuiz(JSON.parse(text));
    assert.deepStrictEqual(locateQuizMessages(text, errors), [
      'line 2: title must be a string.\n  2 |   "title": 7,\n    |   ^',
      'line 8: question 2: acceptedAnswers must be an array of strings.\n' +
        '  8 |       "acceptedAnswers": "oops"\n    |       ^',
      'line 11: question 3, option 2: must be a string.\n' +
        '  11 |       "options": ["a", 2] },\n' +
        '     |                        ^',
      // The property is missing, so the message points at the question it is missing from.
      'line 12: question 4: correctAnswer must be a finite number.\n' +
        '  12 |     { "type": "estimation", "text": "?" }\n     |     ^'
    ]);
  });

  it('leaves a message alone when the text does not parse', () => {
    assert.deepStrictEqual(locateQuizMessages('{', ['question 1: odd.']), ['question 1: odd.']);
  });
});
