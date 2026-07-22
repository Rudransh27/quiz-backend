// src/models/UserTopicProgress.js
const mongoose = require('mongoose');

const UserTopicProgressSchema = new mongoose.Schema({
  user_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  topic_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Topic', 
    required: true 
  },
  module_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Module', 
    required: true 
  },
  bestXP: { 
    type: Number, 
    default: 0 
  },
  isCompleted: {
    type: Boolean,
    default: false
  },
  // Guards the one-time topic-completion pointsReward bonus (see
  // progressController.recordCardCompletion) so re-completing an
  // already-finished topic never re-awards it.
  pointsAwarded: {
    type: Boolean,
    default: false
  },
  // Accumulated active time (seconds) spent on cards inside this topic —
  // accrued incrementally by recordCardCompletion via $inc, never overwritten.
  timeSpentSeconds: {
    type: Number,
    default: 0
  },
  // 🎯 RESET/REATTEMPT: singleton doc per (user, topic) — reset resets these
  // fields in place rather than archiving (no multi-row history problem here
  // the way there is for UserCardProgress). Incremented each reset.
  resetCount: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

// 🎯 INDEX 1: Composite Unique Index (Ek user ek topic ko ek hi baar record karega)
UserTopicProgressSchema.index({ user_id: 1, topic_id: 1 }, { unique: true });

// ⚡ INDEX 2: Module Level Analytics Optimization
// Jab hum pure Module ka progress bar ya analytics metrics nikalenge, tab ye query ko 10x fast karega
UserTopicProgressSchema.index({ user_id: 1, module_id: 1 });

module.exports = mongoose.model('UserTopicProgress', UserTopicProgressSchema);