// src/routes/gradingRoutes.js
//
// Server-side grading endpoints. The client sends answers only — see
// services/grading/index.js for the rules. Every route requires auth, is
// rate-limited per user, and derives module/topic from the card itself.
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const { handleError } = require('../utils/safeError');
const grading = require('../services/grading');

const router = express.Router();

// Keyed per authenticated user (not per IP): a whole office can sit behind
// one NAT address. Generous enough for a learner clicking through a
// 15-question module quickly; tight enough to stop scripted spraying.
const perUser = (max, message) => rateLimit({
  windowMs: 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `u:${req.user.id}`,
  message: { success: false, message },
});
const attemptLimiter = perUser(60, 'Too many answers submitted in a short time. Please slow down.');
const sandboxAnswerLimiter = perUser(240, 'Too many answers submitted in a short time. Please slow down.');
const sandboxSubmitLimiter = perUser(20, 'Too many module submissions in a short time. Please wait a moment.');

const sendGradingError = (res, err) => {
  if (err instanceof grading.GradingError) {
    return res.status(err.status).json({ success: false, message: err.message, ...err.extra });
  }
  return handleError(res, err, 500);
};

// POST /api/grading/cards/:cardId/attempt
// Body: { answer: { selectedOption } | { userCodeAnswer }, idempotencyKey?, timeSpentDelta? }
router.post('/cards/:cardId/attempt', auth, attemptLimiter, async (req, res) => {
  try {
    const { answer, idempotencyKey, timeSpentDelta } = req.body || {};
    const out = await grading.submitCardAttempt(req, req.params.cardId, { answer, idempotencyKey, timeSpentDelta });
    return res.status(200).json(out);
  } catch (err) {
    return sendGradingError(res, err);
  }
});

// POST /api/grading/cards/:cardId/sandbox-answer   Body: { qid, chosen }
router.post('/cards/:cardId/sandbox-answer', auth, sandboxAnswerLimiter, async (req, res) => {
  try {
    const { qid, chosen } = req.body || {};
    if (typeof qid !== 'string' || !qid || qid.length > 100) {
      return res.status(400).json({ success: false, message: 'qid is required.' });
    }
    const out = await grading.recordSandboxAnswer(req, req.params.cardId, {
      qid,
      chosen: typeof chosen === 'string' ? chosen.slice(0, 2000) : chosen,
    });
    return res.status(200).json(out);
  } catch (err) {
    return sendGradingError(res, err);
  }
});

// POST /api/grading/cards/:cardId/sandbox-submit   Body: { questions: [{id, userAnswer, ...}], timeSpentDelta? }
router.post('/cards/:cardId/sandbox-submit', auth, sandboxSubmitLimiter, async (req, res) => {
  try {
    const { questions, timeSpentDelta } = req.body || {};
    const out = await grading.submitSandbox(req, req.params.cardId, { questions, timeSpentDelta });
    return res.status(200).json(out);
  } catch (err) {
    return sendGradingError(res, err);
  }
});

// POST /api/grading/admin/preview-key   Body: { htmlSource }
// Lets the admin module form show "12 questions · 12 MCQ · 60 pts" (or the
// reason it can't be graded) before saving.
router.post('/admin/preview-key', auth, admin, (req, res) => {
  try {
    const { htmlSource } = req.body || {};
    return res.status(200).json(grading.previewSandboxKey(typeof htmlSource === 'string' ? htmlSource : ''));
  } catch (err) {
    return handleError(res, err, 500);
  }
});

module.exports = router;
