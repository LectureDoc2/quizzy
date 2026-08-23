/**
 * Structural validation of a quiz, before it is allowed to create a room.
 *
 * The sanitizer next door answers a different question: it scrubs *markup* the
 * lecturer wrote, on the assumption that the lecturer is trusted and merely
 * fallible. This module answers "is this thing shaped like a quiz at all", and
 * it exists because the answer used to be discovered much later and much worse.
 *
 * A quiz reaches the server as arbitrary JSON. Scoring, the results view and the
 * auto-end timer all assume a particular shape -- `correctIndices` is an array,
 * `options` is an array of strings, `timeLimit` is a number. When that
 * assumption failed it failed inside a `setTimeout`, outside every `try`, which
 * in Node means the process exits: one lecturer's malformed JSON took down every
 * other lecture running on the same host.
 *
 * So the shape is checked once, here, at the only door a quiz can come through,
 * and a quiz that does not pass never becomes a room. The caller reports the
 * problems to the presenter, who is the one person able to fix them.
 *
 * Every limit below is also a denial-of-service bound. They are deliberately far
 * above anything a real lecture needs -- the point is to make the memory a
 * single `create_room` can pin down finite, not to be opinionated about teaching.
 */

/** Bounds. Generous for a lecture, finite for an attacker. */
const LIMITS = {
  maxQuestions: 200,
  maxOptions: 26, // one per letter, which is already absurd on a projector
  maxTitleLength: 500,
  maxTextLength: 20000,
  maxOptionLength: 5000,
  maxTimeLimitSeconds: 3600,
};

const QUESTION_TYPES = new Set(['multiple-choice', 'estimation']);

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {unknown} quiz
 * @returns {{valid: boolean, errors: string[]}} `errors` is empty iff valid.
 */
export function validateQuiz(quiz) {
  const errors = [];

  /* Report several problems at once. A lecturer fixing a quiz five minutes
     before a lecture should not have to rediscover the next error by trying
     again, so validation continues after the first failure wherever it can
     still make sense of the structure. */
  const fail = (message) => {
    if (errors.length < 20) errors.push(message);
  };

  if (!isPlainObject(quiz)) {
    return { valid: false, errors: ['The quiz must be a JSON object.'] };
  }

  if (quiz.title !== undefined) {
    if (typeof quiz.title !== 'string') {
      fail('title must be a string.');
    } else if (quiz.title.length > LIMITS.maxTitleLength) {
      fail(`title is longer than ${LIMITS.maxTitleLength} characters.`);
    }
  }

  if (!Array.isArray(quiz.questions)) {
    return { valid: false, errors: [...errors, 'questions must be an array.'] };
  }
  if (quiz.questions.length === 0) {
    fail('questions is empty; a quiz needs at least one question.');
  }
  if (quiz.questions.length > LIMITS.maxQuestions) {
    return {
      valid: false,
      errors: [...errors, `questions has ${quiz.questions.length} entries, more than the limit of ${LIMITS.maxQuestions}.`],
    };
  }

  quiz.questions.forEach((question, index) => {
    const at = `question ${index + 1}`;

    if (!isPlainObject(question)) {
      fail(`${at}: must be a JSON object.`);
      return;
    }

    if (!QUESTION_TYPES.has(question.type)) {
      fail(`${at}: type must be one of ${[...QUESTION_TYPES].join(', ')} (got ${JSON.stringify(question.type)}).`);
      return; // the remaining checks are type-specific
    }

    if (typeof question.text !== 'string') {
      fail(`${at}: text must be a string.`);
    } else if (question.text.length > LIMITS.maxTextLength) {
      fail(`${at}: text is longer than ${LIMITS.maxTextLength} characters.`);
    }

    /* A missing time limit means "the presenter ends it", which is a normal way
       to run a question -- only a present-but-nonsensical value is an error. */
    if (question.timeLimit !== undefined && question.timeLimit !== null) {
      const limit = question.timeLimit;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0) {
        fail(`${at}: timeLimit must be a non-negative number of seconds.`);
      } else if (limit > LIMITS.maxTimeLimitSeconds) {
        fail(`${at}: timeLimit of ${limit}s exceeds the maximum of ${LIMITS.maxTimeLimitSeconds}s.`);
      }
    }

    if (question.type === 'multiple-choice') {
      if (!Array.isArray(question.options)) {
        fail(`${at}: options must be an array.`);
        return;
      }
      if (question.options.length < 2) {
        fail(`${at}: needs at least two options.`);
      }
      if (question.options.length > LIMITS.maxOptions) {
        fail(`${at}: has ${question.options.length} options, more than the limit of ${LIMITS.maxOptions}.`);
        return;
      }
      question.options.forEach((option, optionIndex) => {
        if (typeof option !== 'string') {
          fail(`${at}, option ${optionIndex + 1}: must be a string.`);
        } else if (option.length > LIMITS.maxOptionLength) {
          fail(`${at}, option ${optionIndex + 1}: is longer than ${LIMITS.maxOptionLength} characters.`);
        }
      });

      /* This is the field whose absence used to kill the process. */
      if (!Array.isArray(question.correctIndices)) {
        fail(`${at}: correctIndices must be an array of option indices.`);
        return;
      }
      for (const correctIndex of question.correctIndices) {
        if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= question.options.length) {
          fail(`${at}: correctIndices contains ${JSON.stringify(correctIndex)}, which is not an index of its options.`);
          break;
        }
      }
    }

    if (question.type === 'estimation') {
      if (typeof question.correctAnswer !== 'number' || !Number.isFinite(question.correctAnswer)) {
        fail(`${at}: correctAnswer must be a finite number.`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

export { LIMITS as QUIZ_LIMITS };
