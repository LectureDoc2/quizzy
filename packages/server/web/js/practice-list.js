/**
 * The practice page: every quiz the Quizzy server offers for practice, grouped
 * by category, each a link that starts a game on the join page.
 *
 * Every piece of catalog text goes in through textContent. Titles and
 * descriptions are written by the operator and the lecturer, and none of them
 * pass through the quiz sanitizer on their way here.
 */

/** The group for quizzes without a category; shown last. */
const UNCATEGORISED = 'Other';

/** Where a quiz card leads. */
const PLAY_URL = 'join.html';

/**
 * Group quizzes by category: categories in the order of their first quiz,
 * quizzes in catalog order within each, and uncategorised quizzes last under
 * UNCATEGORISED (merged into an explicit category of that name, if there is
 * one). The catalog's order is the operator's way of laying out this page.
 *
 * @param {{category: string|null}[]} quizzes
 * @returns {{category: string, quizzes: object[]}[]}
 */
function groupByCategory(quizzes) {
  const groups = new Map();
  const uncategorised = [];
  for (const quiz of quizzes) {
    if (typeof quiz.category !== 'string' || quiz.category === '') {
      uncategorised.push(quiz);
      continue;
    }
    if (!groups.has(quiz.category)) groups.set(quiz.category, []);
    groups.get(quiz.category).push(quiz);
  }
  if (uncategorised.length > 0) {
    if (!groups.has(UNCATEGORISED)) groups.set(UNCATEGORISED, []);
    groups.get(UNCATEGORISED).push(...uncategorised);
  }
  return Array.from(groups, ([category, list]) => ({ category, quizzes: list }));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderCard(quiz) {
  const card = element('a', 'practice-card');
  card.href = `${PLAY_URL}?${new URLSearchParams({ practice: quiz.id })}`;
  card.append(element('div', 'practice-card__title', quiz.title));
  if (quiz.description) {
    card.append(element('div', 'practice-card__description', quiz.description));
  }
  const count = Number(quiz.questionCount) || 0;
  card.append(element('div', 'practice-card__meta', `${count} question${count === 1 ? '' : 's'}`));
  const item = element('li');
  item.append(card);
  return item;
}

/**
 * One category as a <details>: collapsed, so the page opens as an overview of
 * what there is, unless it is the only category -- then there is nothing to
 * get an overview of.
 */
function renderGroup({ category, quizzes }, open) {
  const details = element('details', 'practice-category');
  details.open = open;
  const summary = element('summary', 'practice-category__summary');
  summary.append(
    element('span', 'practice-category__name', category),
    element('span', 'practice-category__count', `${quizzes.length} quiz${quizzes.length === 1 ? '' : 'zes'}`)
  );
  const list = element('ul', 'practice-category__list');
  list.append(...quizzes.map(renderCard));
  details.append(summary, list);
  return details;
}

async function loadPracticeList() {
  const container = document.getElementById('practice-list');
  let quizzes;
  try {
    const response = await fetch('/api/practice', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    ({ quizzes } = await response.json());
  } catch {
    container.replaceChildren(element('div', 'error', 'The practice quizzes could not be loaded. Please try again later.'));
    return;
  }

  if (!Array.isArray(quizzes) || quizzes.length === 0) {
    container.replaceChildren(element('p', 'practice-empty', 'There are no practice quizzes on this server yet.'));
    return;
  }

  const groups = groupByCategory(quizzes);
  container.replaceChildren(...groups.map((group) => renderGroup(group, groups.length === 1)));
}

loadPracticeList();
