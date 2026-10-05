// src/services/grading/answerKey.js
//
// Builds Card.answerKey from a card's authored content. This is the only
// place answer keys are derived; Card.js's save/update hooks call it so a
// key can never drift from the content it was taken from, and the
// migration script calls it to backfill existing cards.
const { extractSandboxKey } = require('./sandboxKey');

const GRADED_TYPES = new Set(['quiz', 'code', 'html_sandbox']);

// Admin-form quiz cards store their key as JSON inside content.text
// ({options, correctAnswerIndex, explanationHint}); seeded ones store
// content.{options, correctIndex, explanation}. Same precedence the
// learner-facing normalizer in topicRoutes.js has always used.
function readQuizContent(content = {}) {
  let options = content.options;
  let correctIndex = content.correctIndex;
  let explanation = content.explanation;
  if (typeof content.text === 'string' && content.text.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(content.text);
      options = parsed.options || options;
      if (parsed.correctAnswerIndex !== undefined) correctIndex = parsed.correctAnswerIndex;
      explanation = parsed.explanationHint || explanation;
    } catch (e) { /* not JSON — plain text question body */ }
  }
  return { options: Array.isArray(options) ? options : [], correctIndex, explanation: explanation || '' };
}

// Returns { ok: true, answerKey, summary? } | { ok: false, error } | { ok: true, answerKey: null }
function buildAnswerKey(cardType, content) {
  const c = content || {};
  if (!GRADED_TYPES.has(cardType)) return { ok: true, answerKey: null };

  if (cardType === 'quiz') {
    const { options, correctIndex, explanation } = readQuizContent(c);
    const idx = Number(correctIndex);
    if (!Number.isInteger(idx) || idx < 0 || (options.length && idx >= options.length)) {
      return { ok: false, error: 'Quiz card has no valid correct option.' };
    }
    return { ok: true, answerKey: { correctIndex: idx, explanation } };
  }

  if (cardType === 'code') {
    if (!c.validator || typeof c.validator !== 'string') {
      return { ok: false, error: 'Code card has no validator selected.' };
    }
    return { ok: true, answerKey: { validator: c.validator, explanation: c.explanation || '' } };
  }

  // html_sandbox
  const html = c.htmlSource || c.html || c.text || '';
  return extractSandboxKey(html);
}

module.exports = { buildAnswerKey, readQuizContent, GRADED_TYPES };
