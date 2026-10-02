// src/utils/learnerCard.js
//
// The one card normalizer for content-serving routes (GET /api/modules/:id,
// GET /api/topics/:id, GET /api/topics/cards/:id). Produces the same
// client shape those routes always returned — options pulled out of the
// admin form's JSON-in-content.text format, htmlSource surfaced for
// sandboxes — and, for LEARNERS, strips everything that would reveal an
// answer before the server has graded it:
//   • quiz: correctIndex, explanation (and the JSON key blob in content.text)
//   • code: explanation (shown only after a correct, server-graded attempt)
//   • answerKey: never selected by these routes, and deleted defensively
// The correct option / explanation reach the learner only in the grading
// response, or via Review Mode for cards they have already answered.
//
// Admins/superadmins (content authors) keep the full content so the
// authoring screens that read these routes keep working.
const { readQuizContent } = require('../services/grading/answerKey');

const isAuthorRole = (req) => req?.user?.role === 'admin' || req?.user?.role === 'superadmin';

function normalizeCardForClient(card, { includeAnswers }) {
  const contentObj = card.content || {};
  const quiz = card.card_type === 'quiz' ? readQuizContent(contentObj) : null;
  const textIsKeyBlob = card.card_type === 'quiz' && typeof contentObj.text === 'string' && contentObj.text.trim().startsWith('{');

  const content = {
    ...contentObj,
    title: contentObj.title || '',
    text: contentObj.text || '',
    htmlSource: card.card_type === 'html_sandbox' ? (contentObj.htmlSource || contentObj.text || '') : '',
    options: (quiz ? quiz.options : contentObj.options) || [],
  };

  if (includeAnswers) {
    content.correctIndex = quiz && quiz.correctIndex !== undefined ? quiz.correctIndex : (contentObj.correctIndex !== undefined ? contentObj.correctIndex : 0);
    content.explanation = (quiz ? quiz.explanation : contentObj.explanation) || '';
  } else {
    delete content.correctIndex;
    delete content.correctAnswerIndex;
    delete content.explanation;
    delete content.explanationHint;
    if (textIsKeyBlob) content.text = '';
  }

  const out = { ...card, id: card._id.toString(), content };
  delete out.answerKey;
  return out;
}

module.exports = { normalizeCardForClient, isAuthorRole };
