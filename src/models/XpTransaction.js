// src/models/XpTransaction.js
//
// The XP ledger. Every XP change made by the grading service is recorded
// here FIRST, under a unique idempotencyKey; only if that insert succeeds is
// User.xp incremented (services/xpLedger.js). A duplicate key therefore
// means "already awarded", which makes concurrent / repeated submissions
// safe without needing Mongo transactions (the docker-compose mongo is a
// standalone server, not a replica set).
//
// User.xp stays the cached running total (leaderboards, badges and tiers
// read it); this collection is the audit trail that explains it.
const mongoose = require('mongoose');

const XP_SOURCES = [
  'card',              // quiz / code card, first attempt
  'sandbox_question',  // one auto-graded question inside an html_sandbox card
  'manual_grade',      // admin grade (or regrade delta) of descriptive answers
  'reset_clawback',    // module/topic reset reversing this generation's awards
  'passive_card',      // knowledge / video / pdf / ppt completion
  'streak',
  'daily_login',
  'idea',
  'adjustment',
];

const XpTransactionSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true },
  source: { type: String, enum: XP_SOURCES, required: true },
  // What the award is for (a Card id, an Idea id, ...).
  sourceId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Card-scoped entries carry these so a reset can sum and reverse exactly
  // what one attempt generation earned.
  card_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Card', default: null },
  module_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Module', default: null },
  generation: { type: Number, default: null },
  questionId: { type: String, default: null },
  idempotencyKey: { type: String, required: true },
  meta: { type: Object, default: undefined },
}, { timestamps: { createdAt: true, updatedAt: false } });

XpTransactionSchema.index({ idempotencyKey: 1 }, { unique: true });
XpTransactionSchema.index({ user_id: 1, card_id: 1, generation: 1 });
XpTransactionSchema.index({ user_id: 1, createdAt: -1 });

XpTransactionSchema.statics.SOURCES = XP_SOURCES;

module.exports = mongoose.model('XpTransaction', XpTransactionSchema);
