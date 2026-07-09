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
  }
}, { timestamps: true });

UserModuleProgressSchema.index({ user_id: 1, module_id: 1 }, { unique: true });

module.exports = mongoose.model('UserModuleProgress', UserModuleProgressSchema);
