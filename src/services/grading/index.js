// src/services/grading/index.js
//
// Server-side grading for quiz, code and html_sandbox cards. The browser
// sends ANSWERS only; correctness, points, XP and progress are decided here.
//
// Rules (agreed for launch):
//  • XP is earned only on the learner's FIRST answer per card (quiz/code) or
//    per question (html_sandbox) within an attempt generation. Retries are
//    allowed for learning and earn 0 XP. Pass/complete status follows the
//    latest attempt.
//  • First-ness is claimed atomically by GradeAttempt's partial unique index
//    (isFirst:true per user/card/generation/question); XP itself goes through
//    the idempotent ledger, so concurrent duplicates can never double-award.
//  • Module and topic are always derived from the CARD, and every call
//    enforces visibility (department/team/region) and the sequential lock.
//  • A card the learner already completed under the old client-graded flow
//    (an active UserCardProgress doc without gradeGeneration) earns no new
//    XP — it was already rewarded.
const mongoose = require('mongoose');
const Card = require('../../models/Card');
const Topic = require('../../models/Topic');
const Module = require('../../models/Module');
const GradeAttempt = require('../../models/GradeAttempt');
const UserCardProgress = require('../../models/UserCardProgress');
const UserCardGeneration = require('../../models/UserCardGeneration');
const { assertModuleLearnerAccess } = require('../../utils/moduleAccess');
const { awardXp, ledgerNetForCard, isDuplicateKey } = require('../xpLedger');
const { buildAnswerKey } = require('./answerKey');
const { gradeQuiz, gradeCode, gradeSandboxQuestion, correctAnswerText } = require('./graders');

class GradingError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const userIdOf = (req) => {
  const u = req.user && req.user.user ? req.user.user : req.user;
  return u ? (u.id || u._id) : null;
};

// Lazily required to avoid a require cycle (progressController → services).
const scopeProgress = (...args) => require('../../controllers/progressController').updateScopeProgress(...args);

async function loadCardContext(req, cardId, expectedTypes) {
  if (!cardId || !mongoose.Types.ObjectId.isValid(String(cardId))) {
    throw new GradingError(400, 'Invalid card id.');
  }
  const card = await Card.findById(cardId).select('+answerKey').lean();
  if (!card) throw new GradingError(404, 'Card not found.');
  if (!expectedTypes.includes(card.card_type)) {
    throw new GradingError(400, `This endpoint does not grade ${card.card_type} cards.`);
  }

  let moduleId = card.module_id || null;
  const topicId = card.topic_id || null;
  if (!moduleId && topicId) {
    const topic = await Topic.findById(topicId, 'module_id').lean();
    moduleId = topic?.module_id || null;
  }
  const moduleDoc = moduleId ? await Module.findById(moduleId).lean() : null;
  if (!moduleDoc) throw new GradingError(404, 'Module not found.');

  const access = await assertModuleLearnerAccess(moduleDoc, req);
  if (!access.ok) throw new GradingError(access.status, access.message, access.locked ? { locked: true } : {});

  // Cards saved before answerKey existed (pre-migration) derive it on the fly.
  let answerKey = card.answerKey;
  if (!answerKey) {
    const built = buildAnswerKey(card.card_type, card.content);
    if (!built.ok || !built.answerKey) {
      throw new GradingError(409, 'This card has no gradable answer key yet. Please contact your admin.');
    }
    answerKey = built.answerKey;
  }

  return { card, answerKey, moduleId, topicId, moduleDoc };
}

async function currentGeneration(userId, cardId) {
  const doc = await UserCardGeneration.findOne({ user_id: userId, card_id: cardId }, 'generation').lean();
  return doc?.generation || 0;
}

// Inserts the attempt; claims the first-answer slot if it's still free.
// Returns { attempt, isFirst } or { duplicateOf } for a repeated idempotencyKey.
async function insertAttempt(doc) {
  try {
    const attempt = await GradeAttempt.create({ ...doc, isFirst: true });
    return { attempt, isFirst: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    if (doc.idempotencyKey && /idempotencyKey/.test(err.message || '')) {
      return { duplicateOf: await GradeAttempt.findOne({ user_id: doc.user_id, idempotencyKey: doc.idempotencyKey }).lean() };
    }
  }
  try {
    const attempt = await GradeAttempt.create({ ...doc, isFirst: false });
    return { attempt, isFirst: false };
  } catch (err) {
    if (isDuplicateKey(err) && doc.idempotencyKey) {
      return { duplicateOf: await GradeAttempt.findOne({ user_id: doc.user_id, idempotencyKey: doc.idempotencyKey }).lean() };
    }
    throw err;
  }
}

// Active progress doc written by the pre-ledger, client-graded flow?
async function isLegacyCompleted(userId, cardId) {
  const doc = await UserCardProgress.findOne(
    { user_id: userId, card_id: cardId, isArchived: { $ne: true } },
    'gradeGeneration',
  ).lean();
  return !!doc && (doc.gradeGeneration === undefined || doc.gradeGeneration === null);
}

const cleanKey = (k) => (typeof k === 'string' && k.length > 0 && k.length <= 100 ? k : null);

// ===========================================================================
// quiz / code
// ===========================================================================
async function submitCardAttempt(req, cardId, { answer, idempotencyKey, timeSpentDelta }) {
  const userId = userIdOf(req);
  const { card, answerKey, moduleId, topicId } = await loadCardContext(req, cardId, ['quiz', 'code']);

  const graded = card.card_type === 'quiz' ? gradeQuiz(answerKey, answer) : gradeCode(answerKey, answer);
  if (!graded.ok) throw new GradingError(graded.status || 400, graded.error);

  const generation = await currentGeneration(userId, card._id);
  const legacy = await isLegacyCompleted(userId, card._id);
  const ins = await insertAttempt({
    user_id: userId,
    card_id: card._id,
    module_id: moduleId,
    topic_id: topicId,
    kind: 'card',
    attemptGeneration: generation,
    questionId: '',
    answer: graded.stored,
    isCorrect: graded.isCorrect,
    score: graded.points,
    maxScore: card.card_type === 'quiz' ? 5 : 10,
    contentHash: null,
    idempotencyKey: cleanKey(idempotencyKey),
  });

  if (ins.duplicateOf) {
    // Same request retried — answer with the stored verdict, change nothing.
    return buildCardResponse(card, answerKey, {
      isCorrect: ins.duplicateOf.isCorrect,
      error: null,
      xpChange: 0,
      firstAttempt: ins.duplicateOf.isFirst,
      scope: null,
    });
  }

  let xpChange = 0;
  if (ins.isFirst && graded.isCorrect && !legacy) {
    const award = await awardXp({
      userId,
      amount: graded.points,
      source: 'card',
      idempotencyKey: `card:${userId}:${card._id}:g${generation}`,
      sourceId: card._id,
      cardId: card._id,
      moduleId,
      generation,
    });
    xpChange = award.amount;
  }

  const progressUpdate = {
    module_id: moduleId,
    topic_id: topicId,
    isCorrect: graded.isCorrect,
    isArchived: false,
    $inc: { timesAttempted: 1, xpAwarded: xpChange },
  };
  if (!legacy) progressUpdate.gradeGeneration = generation;
  if (graded.stored.selectedOption !== undefined) progressUpdate.selectedOption = graded.stored.selectedOption;
  if (graded.stored.userCodeAnswer !== undefined) progressUpdate.userCodeAnswer = graded.stored.userCodeAnswer;

  await UserCardProgress.findOneAndUpdate(
    { user_id: userId, card_id: card._id, isArchived: false },
    progressUpdate,
    { upsert: true, new: true },
  );

  const scope = await scopeProgress({ userId, moduleId, topicId, timeSpentDelta });
  return buildCardResponse(card, answerKey, {
    isCorrect: graded.isCorrect,
    error: graded.error || null,
    xpChange,
    firstAttempt: ins.isFirst && !legacy,
    scope,
  });
}

function buildCardResponse(card, answerKey, { isCorrect, error, xpChange, firstAttempt, scope }) {
  const out = { success: true, cardId: card._id, cardType: card.card_type, isCorrect, xpChange, firstAttempt, ...(scope || {}) };
  if (card.card_type === 'quiz') {
    // Revealed only AFTER grading — never part of the card's content.
    out.correctIndex = answerKey.correctIndex;
    out.explanation = answerKey.explanation || '';
  } else {
    out.validationError = isCorrect ? null : error;
    out.explanation = isCorrect ? (answerKey.explanation || '') : null;
  }
  return out;
}

// ===========================================================================
// html_sandbox — one answer at a time (from the in-page bridge)
// ===========================================================================
async function recordSandboxAnswer(req, cardId, { qid, chosen }) {
  const userId = userIdOf(req);
  const { card, answerKey, moduleId, topicId } = await loadCardContext(req, cardId, ['html_sandbox']);

  const q = (answerKey.questions || []).find((x) => x.id === String(qid));
  if (!q) throw new GradingError(400, `Unknown question id "${qid}".`);
  if (q.type === 'descriptive') {
    // Descriptive answers are graded by an admin from the final submission.
    return { success: true, recorded: false, pending: true };
  }

  const generation = await currentGeneration(userId, card._id);
  const legacy = await isLegacyCompleted(userId, card._id);
  const result = gradeSandboxQuestion(q, chosen);

  const ins = await insertAttempt({
    user_id: userId,
    card_id: card._id,
    module_id: moduleId,
    topic_id: topicId,
    kind: 'sandbox_answer',
    attemptGeneration: generation,
    questionId: q.id,
    answer: result.answer,
    results: [{ id: q.id, type: q.type, answer: result.answer, isCorrect: result.isCorrect, points: result.points, maxPoints: q.points, recognized: result.recognized }],
    isCorrect: result.isCorrect,
    score: result.points,
    maxScore: q.points,
    contentHash: answerKey.contentHash || null,
  });

  let xpChange = 0;
  if (ins.isFirst && result.isCorrect && !legacy) {
    const award = await awardXp({
      userId,
      amount: q.points,
      source: 'sandbox_question',
      idempotencyKey: `sbq:${userId}:${card._id}:g${generation}:${q.id}`,
      sourceId: card._id,
      cardId: card._id,
      moduleId,
      generation,
      questionId: q.id,
    });
    xpChange = award.amount;
  }

  // The right answer is revealed only AFTER the attempt is recorded (the
  // first answer is the one that counts), so a "server feedback" module can
  // show the learner what was correct without ever shipping the key.
  return {
    success: true, recorded: true, firstAnswer: ins.isFirst, isCorrect: result.isCorrect, xpChange,
    correct: { key: q.correctKey || null, text: q.correctText || null },
  };
}

// ===========================================================================
// html_sandbox — final submission (HTML_SIMULATION_SUBMIT)
// ===========================================================================
async function submitSandbox(req, cardId, { questions, timeSpentDelta }) {
  const userId = userIdOf(req);
  const { card, answerKey, moduleId, topicId } = await loadCardContext(req, cardId, ['html_sandbox']);

  // Only {id, userAnswer} (and the module's own type label / text, for
  // display) are read from the client. score / isCorrect / points /
  // correctAnswer in the payload are ignored entirely.
  const submitted = new Map();
  (Array.isArray(questions) ? questions : []).slice(0, 500).forEach((item) => {
    if (item && typeof item.id === 'string') submitted.set(item.id, item);
  });

  const generation = await currentGeneration(userId, card._id);
  const legacy = await isLegacyCompleted(userId, card._id);

  const existingFirsts = await GradeAttempt.find(
    { user_id: userId, card_id: card._id, attemptGeneration: generation, kind: 'sandbox_answer', isFirst: true },
    'questionId isCorrect',
  ).lean();
  const firstById = new Map(existingFirsts.map((a) => [a.questionId, a]));

  const results = [];
  const feedbackQuestions = [];
  let score = 0;
  let xpChange = 0;
  let pendingManual = 0;

  for (const q of answerKey.questions || []) {
    const item = submitted.get(q.id) || {};
    const userAnswer = item.userAnswer ?? null;
    const result = gradeSandboxQuestion(q, userAnswer);
    if (result.pending) pendingManual++;
    if (result.isCorrect) score += result.points;
    results.push({ id: q.id, type: q.type, answer: result.answer, isCorrect: result.isCorrect, points: result.points, maxPoints: q.points, recognized: result.recognized });

    // First answer for XP: the bridge-captured one if any, otherwise this
    // submission's answer becomes the first (Family B modules and modules
    // without in-page answer capture).
    if (!result.pending) {
      let first = firstById.get(q.id);
      if (!first) {
        const ins = await insertAttempt({
          user_id: userId, card_id: card._id, module_id: moduleId, topic_id: topicId,
          kind: 'sandbox_answer', attemptGeneration: generation, questionId: q.id,
          answer: result.answer,
          results: [{ id: q.id, type: q.type, answer: result.answer, isCorrect: result.isCorrect, points: result.points, maxPoints: q.points, recognized: result.recognized }],
          isCorrect: result.isCorrect, score: result.points, maxScore: q.points,
          contentHash: answerKey.contentHash || null,
        });
        first = ins.isFirst
          ? { isCorrect: result.isCorrect }
          : await GradeAttempt.findOne({ user_id: userId, card_id: card._id, attemptGeneration: generation, questionId: q.id, isFirst: true }, 'isCorrect').lean();
      }
      if (first?.isCorrect && !legacy) {
        const award = await awardXp({
          userId,
          amount: q.points,
          source: 'sandbox_question',
          idempotencyKey: `sbq:${userId}:${card._id}:g${generation}:${q.id}`,
          sourceId: card._id, cardId: card._id, moduleId, generation, questionId: q.id,
        });
        xpChange += award.amount;
      }
    }

    // metaFeedbackLogs entry — same shape admin views/CSV export already
    // read, with server values in place of the client's.
    feedbackQuestions.push({
      id: q.id,
      questionText: typeof item.questionText === 'string' ? item.questionText.slice(0, 2000) : (q.questionText || ''),
      type: typeof item.type === 'string' ? item.type.slice(0, 40) : (q.type === 'descriptive' ? 'text' : q.type),
      userAnswer: q.type === 'descriptive' ? result.answer : (typeof userAnswer === 'string' ? userAnswer.slice(0, 2000) : userAnswer),
      correctAnswer: correctAnswerText(q),
      isCorrect: result.isCorrect,
      options: Array.isArray(q.options) ? q.options : undefined,
      points: result.pending ? null : result.points,
      maxPoints: q.points,
    });
  }

  const maxScore = answerKey.autoPoints ?? (answerKey.questions || []).filter((q) => q.type !== 'descriptive').reduce((s, q) => s + q.points, 0);

  await GradeAttempt.create({
    user_id: userId, card_id: card._id, module_id: moduleId, topic_id: topicId,
    kind: 'sandbox_submit', attemptGeneration: generation, questionId: '',
    isFirst: false, answer: null, results, isCorrect: null, score, maxScore, xpAwarded: xpChange,
    contentHash: answerKey.contentHash || null,
  });

  const progressUpdate = {
    module_id: moduleId,
    topic_id: topicId,
    isCorrect: true, // submitting the module completes the card
    isArchived: false,
    score,
    maxScore,
    'metaFeedbackLogs.questions': feedbackQuestions,
    $inc: { timesAttempted: 1 },
  };
  if (legacy) {
    // Pre-ledger completion: keep its recorded XP, award nothing new.
  } else {
    progressUpdate.gradeGeneration = generation;
  }
  await UserCardProgress.findOneAndUpdate(
    { user_id: userId, card_id: card._id, isArchived: false },
    progressUpdate,
    { upsert: true, new: true },
  );
  if (!legacy) {
    // xpAwarded mirrors exactly what the ledger holds for this generation
    // (bridge-time awards included), which is what a reset reverses.
    const { net } = await ledgerNetForCard(userId, card._id, generation);
    await UserCardProgress.updateOne({ user_id: userId, card_id: card._id, isArchived: false }, { $set: { xpAwarded: net } });
  }

  const scope = await scopeProgress({ userId, moduleId, topicId, timeSpentDelta });
  return {
    success: true,
    cardId: card._id,
    score,
    maxScore,
    xpChange,
    pendingManual,
    results: results.map(({ id, isCorrect, points, maxPoints }) => ({ id, isCorrect, points, maxPoints })),
    ...scope,
  };
}

// Admin preview: what would grading detect in this HTML? (No save.)
function previewSandboxKey(htmlSource) {
  const built = buildAnswerKey('html_sandbox', { htmlSource });
  return built.ok ? { ok: true, summary: built.summary } : { ok: false, error: built.error };
}

module.exports = {
  submitCardAttempt,
  recordSandboxAnswer,
  submitSandbox,
  previewSandboxKey,
  currentGeneration,
  GradingError,
};
