// src/models/UserCardGeneration.js
//
// Attempt generation per (user, card). Starts at 0 (no doc), and a module/
// topic reset bumps it by one — which re-opens a fresh "first attempt" slot
// in GradeAttempt and a fresh set of XP idempotency keys, so a reset learner
// can earn the XP again (after the reset clawed the old award back).
const mongoose = require('mongoose');

const UserCardGenerationSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  card_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Card', required: true },
  generation: { type: Number, required: true, default: 0 },
}, { timestamps: true });

UserCardGenerationSchema.index({ user_id: 1, card_id: 1 }, { unique: true });

module.exports = mongoose.model('UserCardGeneration', UserCardGenerationSchema);
