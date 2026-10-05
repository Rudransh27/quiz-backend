// src/models/Card.js
const mongoose = require('mongoose');

const cardSchema = new mongoose.Schema({
  // If the card belongs to a topic
  topic_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Topic',
    required: function() { return !this.module_id; } // Required ONLY IF module_id is absent
  },
  // If the card belongs directly to a module (skipping topics)
  module_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module',
    required: function() { return !this.topic_id; } // Required ONLY IF topic_id is absent
  },
  card_type: {
    type: String,
    // 🚀 UPDATED ENUM: Added 'html_sandbox' as an individual card type option
    enum: ['quiz', 'knowledge', 'code', 'video', 'pdf', 'ppt', 'html_sandbox'],
    required: true,
  },
  cardOrder: { type: Number, required: true },
  imageUrl: { type: String, default: "" },
  content: { type: Object, required: true },
  // 🔒 SERVER-SIDE GRADING: the answer key, split out of `content` so it can
  // never ride along on a learner-facing read. select:false means every
  // query must opt in explicitly (`.select('+answerKey')`) — only the
  // grading service and the admin authoring/migration paths do.
  //   quiz:         { correctIndex, explanation }
  //   code:         { validator, explanation }
  //   html_sandbox: { family, questions:[{id,type,points,correctKey,correctText,options,optionKeys}],
  //                   maxPoints, autoPoints, contentHash }
  // Populated by services/grading/answerKey.js on every save (see the hooks
  // below) and backfilled for existing cards by scripts/migrate-answer-keys.js.
  answerKey: { type: Object, select: false, default: undefined }
}, { timestamps: true });

// 🔒 SERVER-SIDE GRADING: answerKey is always DERIVED from content, never
// accepted from a request body. An html_sandbox card whose HTML has no
// gradable key is rejected outright (no ungradable module goes live); a
// quiz/code card with a broken key is saved with answerKey null and a
// warning, matching how those cards were saved before.
const keyError = (message) => Object.assign(new Error(message), { status: 400, expose: true, isAnswerKeyError: true });

function applyDerivedKey(cardType, content, target) {
  // Lazy require: answerKey.js → sandboxKey.js → pointsCalculator.js, none
  // of which need the model, but keep model load order independent anyway.
  const { buildAnswerKey } = require('../services/grading/answerKey');
  const result = buildAnswerKey(cardType, content);
  if (!result.ok) {
    if (cardType === 'html_sandbox') throw keyError(`HTML module cannot be graded: ${result.error}`);
    console.warn(`⚠️ Card saved without an answer key (${cardType}): ${result.error}`);
    target.answerKey = null;
    return;
  }
  target.answerKey = result.answerKey;
}

cardSchema.pre('validate', function () {
  if (this.isNew || this.isModified('content') || this.isModified('card_type')) {
    applyDerivedKey(this.card_type, this.content, this);
  }
});

cardSchema.pre(['findOneAndUpdate', 'updateOne'], async function () {
  const update = this.getUpdate() || {};
  const $set = update.$set || {};
  delete update.answerKey;
  delete $set.answerKey;

  const touchesContent = (obj) => Object.keys(obj).some((k) => k === 'content' || k.startsWith('content.') || k === 'card_type');
  if (!touchesContent(update) && !touchesContent($set)) {
    if (update.$set) update.$set = $set;
    return;
  }

  const existing = await this.model.findOne(this.getQuery()).select('card_type content').lean();
  if (!existing) return;

  const cardType = update.card_type ?? $set.card_type ?? existing.card_type;
  let content = update.content ?? $set.content ?? { ...(existing.content || {}) };
  for (const src of [update, $set]) {
    for (const [k, v] of Object.entries(src)) {
      if (k.startsWith('content.')) content = { ...content, [k.slice('content.'.length)]: v };
    }
  }

  const holder = {};
  applyDerivedKey(cardType, content, holder);
  update.$set = { ...$set, answerKey: holder.answerKey };
  this.setUpdate(update);
});

cardSchema.pre('updateMany', function () {
  const update = this.getUpdate() || {};
  const touches = (obj) => Object.keys(obj || {}).some((k) => k === 'content' || k.startsWith('content.') || k === 'answerKey');
  if (touches(update) || touches(update.$set)) {
    throw new Error('Card.updateMany cannot change content/answerKey — update cards individually so answer keys are re-derived.');
  }
});

// 🚀 Optimized Compound Indexes for both query paths
cardSchema.index({ topic_id: 1, cardOrder: 1 });
cardSchema.index({ module_id: 1, cardOrder: 1 });

module.exports = mongoose.model('Card', cardSchema);