// src/models/UserModuleProgress.js
// Mirrors UserTopicProgress's shape — the module-level analog used only for
// EXPRESS_FLAT modules (STANDARD modules complete at the topic level, tracked
// by UserTopicProgress; there's no whole-module completion record for those).
const mongoose = require('mongoose');

const UserModuleProgressSchema = new mongoose.Schema({
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
  isCompleted: {
    type: Boolean,
    default: false
  },
  // Guards the one-time module-completion pointsReward bonus so re-completing
  // an already-finished module never re-awards it.
  pointsAwarded: {
    type: Boolean,
    default: false
  },
  // Running per-card XP total for this module scope — mirrors
  // UserTopicProgress.bestXP. Without this, reopening a partially-completed
  // EXPRESS_FLAT module had nowhere to read a resume value from, so the
  // in-session XP counter always restarted at 0.
  bestXP: {
    type: Number,
    default: 0
  },
  // Accumulated active time (seconds) spent on cards inside this module —
  // accrued incrementally by recordCardCompletion via $inc, never overwritten.
  timeSpentSeconds: {
    type: Number,
    default: 0
  },
  // 🎯 RESET/REATTEMPT: this is a singleton doc per (user, module) — a reset
  // resets its fields in place (isCompleted/pointsAwarded/bestXP back to
  // fresh) rather than archiving, since there's no multi-row history problem
  // here the way there is for UserCardProgress. Incremented each reset.
  resetCount: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

UserModuleProgressSchema.index({ user_id: 1, module_id: 1 }, { unique: true });

module.exports = mongoose.model('UserModuleProgress', UserModuleProgressSchema);
