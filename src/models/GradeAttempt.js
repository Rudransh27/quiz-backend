// src/models/GradeAttempt.js
//
// Immutable record of every graded submission the server has ever seen —
// one doc per quiz/code attempt, per first-answer capture of a sandbox
// question, and per sandbox submit. Never updated after insert (manual
// grading writes XpTransaction deltas + UserCardProgress.metaFeedbackLogs,
// it does not rewrite history here).
//
// `isFirst` + the partial unique index below is how "XP only for the
// learner's FIRST answer" is enforced atomically: the first insert for a
// (user, card, generation, questionId) slot with isFirst:true wins; any
// concurrent or later attempt fails that index and is stored with
// isFirst:false instead.
const mongoose = require('mongoose');

const QuestionResultSchema = new mongoose.Schema({
  id: String,
  type: String,
  answer: mongoose.Schema.Types.Mixed,
  isCorrect: { type: Boolean, default: null }, // null = pending manual grading
  points: { type: Number, default: 0 },
  maxPoints: { type: Number, default: 0 },
  recognized: { type: Boolean, default: true },
}, { _id: false });

const GradeAttemptSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  card_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Card', required: true },
  module_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Module', required: true },
  topic_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Topic', default: null },
  kind: { type: String, enum: ['card', 'sandbox_answer', 'sandbox_submit'], required: true },
  attemptGeneration: { type: Number, required: true, default: 0 },
  // '' for whole-card attempts; the sandbox question id for sandbox_answer.
  questionId: { type: String, default: '' },
  isFirst: { type: Boolean, default: false },
  answer: mongoose.Schema.Types.Mixed,
  results: { type: [QuestionResultSchema], default: undefined },
  isCorrect: { type: Boolean, default: null },
  score: { type: Number, default: 0 },
  maxScore: { type: Number, default: 0 },
  xpAwarded: { type: Number, default: 0 },
  gradedBy: { type: String, enum: ['auto', 'manual'], default: 'auto' },
  contentHash: { type: String, default: null },
  // Client-supplied, scoped per user: a retried request with the same key
  // returns the stored result instead of grading again.
  idempotencyKey: { type: String, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

GradeAttemptSchema.index(
  { user_id: 1, card_id: 1, attemptGeneration: 1, questionId: 1 },
  { unique: true, partialFilterExpression: { isFirst: true } },
);
GradeAttemptSchema.index(
  { user_id: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
GradeAttemptSchema.index({ card_id: 1, createdAt: -1 });

// Immutability guard: history rows are append-only.
const refuse = function () {
  throw new Error('GradeAttempt records are immutable.');
};
GradeAttemptSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], refuse);
GradeAttemptSchema.pre('save', function () {
  if (!this.isNew) refuse();
});

module.exports = mongoose.model('GradeAttempt', GradeAttemptSchema);
