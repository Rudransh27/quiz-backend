// src/models/ModuleResetLog.js
// Lightweight audit trail for the learner-facing "Reset/Reattempt Module"
// action — no reset-like action existed anywhere in this codebase before,
// so there was nowhere to record that one happened. Purely for support/audit
// visibility; nothing else in the app reads from this collection.
const mongoose = require('mongoose');

const ModuleResetLogSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  module_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module',
    required: true
  },
  // Present only when the reset was scoped to a single topic inside a
  // STANDARD (topic-hierarchy) module.
  topic_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Topic',
    default: null
  },
  xpClawedBack: {
    type: Number,
    default: 0
  },
  cardsAffected: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

ModuleResetLogSchema.index({ user_id: 1, module_id: 1 });

module.exports = mongoose.model('ModuleResetLog', ModuleResetLogSchema);
