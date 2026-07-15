// src/utils/pointsCalculator.js
//
// Canonical per-card-type point table + html_sandbox question parsing, used
// to compute a Topic's or Module's "how much is this worth" figure as a TRUE
// sum of what each of its cards is actually worth — replacing the old flat
// `Math.max(50, cardCount * 10)` estimate, which showed the exact same
// number (e.g. 130) for any 13-card module regardless of what those 13
// cards actually were.

// Base point value per ordinary (non-html_sandbox) card type.
// 🎯 SYNC FIX: knowledge (Text Card) was 1 here but 2 in calculateXp
// (progressController.js) — the two tables MUST agree, since this one
// drives the "how much is this worth" preview shown before a topic starts,
// and calculateXp drives what's actually awarded per card as it's
// completed. Canonical value is 2, matching calculateXp.
const CARD_TYPE_POINTS = {
  knowledge: 2, // "Text Card"
  quiz: 5,
  code: 10,
  pdf: 5,
  ppt: 5,
  pptx: 5,
  video: 10,
};

const QUIZ_QUESTION_POINTS = 5;        // mcq / true_false, inside an html_sandbox card
const DESCRIPTIVE_QUESTION_POINTS = 10; // text / code / any other type — admin-graded, capped at 10

// 🎯 Recognized MCQ-type `type:` values. `mcq`/`true_false` come from the
// platform's documented postMessage contract (progressController.js);
// `mc` was added after finding a real authored sandbox ("Carbon Niti AI")
// that uses that shorthand for the exact same kind of question — anything
// NOT in this set (text, code, or any other/unrecognized type) is treated
// as a descriptive question.
const QUIZ_QUESTION_TYPES = new Set(['mcq', 'mc', 'true_false']);

// Every html_sandbox card's own authored JS is expected to build an array
// of question objects, each declaring a `type` alongside SOME corroborating
// question-shaped key. We deliberately do NOT execute the sandbox's JS to
// find these — running arbitrary admin-authored script server-side just to
// count questions would be a real security risk. Instead this statically
// scans the raw source text: every `type: "..."` that appears within
// CONTEXT_WINDOW characters of one of the QUESTION_ANCHOR_KEYS below is
// treated as one question declaration. The window+anchor check exists
// specifically so this does NOT match ordinary HTML attributes like
// `<input type="text">`, which never appear near any of these keys.
//
// Two authoring conventions are known and both anchor correctly:
//  - the documented postMessage contract: `type`, `questionText`
//  - a real authored sandbox ("Carbon Niti AI"): `type`, `q`, `opts`, `correct`
// This is a best-effort static scan, not true parsing or execution — a
// sandbox authored with entirely different key names won't be found, and
// falls back to the admin-typed Card.content.maxPoints (see
// computeCardBasePoints below).
const CONTEXT_WINDOW = 200;
const TYPE_DECLARATION_PATTERN = /\btype\s*:\s*["'`](\w+)["'`]/g;
const QUESTION_ANCHOR_PATTERN = /\b(?:questionText|q|opts|correct)\s*:/;

// A sandbox's own runtime scoring/postMessage-construction code inevitably
// mirrors the SAME key names as the real question bank (it has to — it's
// built by reading `.type`/`.q`/`.opts`/`.correct` off each real item to
// build the postMessage payload), so scanning the whole file would double
// count: once for each real item in the data array, and AGAIN for the one
// generic `type: 'mcq'` / `type: 'text'` literal inside that mapping
// function. To avoid this, the scan is restricted to the actual question
// BANK array literal — e.g. `const Q = [ {type:'mc', ...}, ... ]` — found
// by locating an `= [` array declaration whose contents contain a `type:`
// declaration near one of the question-anchor keys, then bracket-matching
// to its closing `]`. Any later code outside that span (mapping/scoring
// logic, unrelated arrays) is never scanned.
const ARRAY_DECL_PATTERN = /(?:const|let|var)\s+\w+\s*=\s*\[/g;

function findQuestionBankSpan(htmlSource) {
  ARRAY_DECL_PATTERN.lastIndex = 0;
  let declMatch;
  while ((declMatch = ARRAY_DECL_PATTERN.exec(htmlSource)) !== null) {
    const openBracketIndex = declMatch.index + declMatch[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = openBracketIndex; i < htmlSource.length; i++) {
      if (htmlSource[i] === '[') depth++;
      else if (htmlSource[i] === ']') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) break; // unbalanced brackets — stop rather than mis-scan

    const span = htmlSource.slice(declMatch.index, end);
    if (TYPE_DECLARATION_PATTERN.test(span) && QUESTION_ANCHOR_PATTERN.test(span)) {
      TYPE_DECLARATION_PATTERN.lastIndex = 0; // .test() above advanced it
      return span;
    }
    TYPE_DECLARATION_PATTERN.lastIndex = 0;
    ARRAY_DECL_PATTERN.lastIndex = end; // this array wasn't it — resume after it
  }
  return null;
}

function parseHtmlSandboxPoints(htmlSource) {
  const empty = { total: 0, quizCount: 0, descriptiveCount: 0 };
  if (!htmlSource || typeof htmlSource !== 'string') return empty;

  const questionBank = findQuestionBankSpan(htmlSource);
  if (!questionBank) return empty;

  let quizCount = 0;
  let descriptiveCount = 0;
  let match;

  TYPE_DECLARATION_PATTERN.lastIndex = 0;
  while ((match = TYPE_DECLARATION_PATTERN.exec(questionBank)) !== null) {
    const contextStart = Math.max(0, match.index - CONTEXT_WINDOW);
    const contextEnd = Math.min(questionBank.length, match.index + match[0].length + CONTEXT_WINDOW);
    const context = questionBank.slice(contextStart, contextEnd);

    if (!QUESTION_ANCHOR_PATTERN.test(context)) continue; // not a question object — likely an unrelated HTML attribute

    const typeValue = match[1].toLowerCase();
    if (QUIZ_QUESTION_TYPES.has(typeValue)) quizCount++;
    else descriptiveCount++; // text, code, or any other/unrecognized type
  }

  const total = quizCount * QUIZ_QUESTION_POINTS + descriptiveCount * DESCRIPTIVE_QUESTION_POINTS;
  return { total, quizCount, descriptiveCount };
}

// How much a single card is worth. html_sandbox cards derive their worth by
// parsing the authored HTML source; if parsing finds no questions at all
// (empty or not-yet-authored sandbox), fall back to the admin-configured
// Card.content.maxPoints so the card isn't silently worth 0.
function computeCardBasePoints(card) {
  if (!card) return 0;
  if (card.card_type === 'html_sandbox') {
    const parsed = parseHtmlSandboxPoints(card.content?.htmlSource);
    if (parsed.total > 0) return parsed.total;
    return Number(card.content?.maxPoints) || 0;
  }
  return CARD_TYPE_POINTS[card.card_type] ?? 0;
}

// Sum of computeCardBasePoints across every card in a scope (a Topic's
// cards, or a flat Module's direct cards).
function computeAggregatedCardPoints(cards) {
  const cardList = Array.isArray(cards) ? cards : [];
  return cardList.reduce((sum, card) => sum + computeCardBasePoints(card), 0);
}

// A Topic's or flat Module's total "pointsReward" — the true sum of what its
// cards are worth. No artificial floor, no separate time-based bonus: this
// MUST be the exact same number that ends up in the user's XP once every
// card in scope is completed (see recordCardCompletion, which sums the
// identical per-card values incrementally as each card finishes — nothing
// else adds to the total once the topic/module is done). Previously this
// also added a rounded estimatedTime*2 "time bonus", which was ONLY ever
// applied via a separate completion-bonus award in recordCardCompletion —
// that whole mechanism has been removed (see recordCardCompletion's
// comments) because it double-counted the per-card total on top of itself.
// Dropping the time bonus here too keeps the displayed "worth" and the
// actually-awarded total identical, matching the platform rule that a
// topic/module's XP is exactly the sum of its cards — nothing more.
function computePointsReward(cards) {
  return computeAggregatedCardPoints(cards);
}

module.exports = {
  computePointsReward,
  computeCardBasePoints,
  computeAggregatedCardPoints,
  parseHtmlSandboxPoints,
  CARD_TYPE_POINTS,
  QUIZ_QUESTION_POINTS,
  DESCRIPTIVE_QUESTION_POINTS,
};
