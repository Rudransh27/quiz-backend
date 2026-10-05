// src/models/DailyReadOpen.js
//
// When a learner opened a Daily Read (first open per user, read and UTC day).
// The reading timer itself runs in the browser; this server-side timestamp is
// what lets POST /api/progress/streak/verify check that a "daily_read" claim
// comes after a real open, at least the reading threshold ago.
const mongoose = require('mongoose');

const DailyReadOpenSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  read_id: { type: mongoose.Schema.Types.ObjectId, ref: 'DailyRead', required: true },
  dayKey: { type: String, required: true }, // UTC YYYY-MM-DD of the open
  openedAt: { type: Date, required: true },
}, { timestamps: false });

DailyReadOpenSchema.index({ user_id: 1, read_id: 1, dayKey: 1 }, { unique: true });
DailyReadOpenSchema.index({ user_id: 1, openedAt: -1 });

module.exports = mongoose.model('DailyReadOpen', DailyReadOpenSchema);
