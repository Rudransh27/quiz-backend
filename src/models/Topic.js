const mongoose = require('mongoose');

const topicSchema = new mongoose.Schema({
  module_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module',
    required: true,
  },
  title: { type: String, required: true },
  description: String,
  topicOrder: { type: Number, required: true },
  // Admin-set estimate, in minutes — feeds computePointsReward() alongside this
  // topic's card count (see src/utils/pointsCalculator.js).
  estimatedTime: { type: Number, default: 0 }
}, { timestamps: true });

// 🚨 Indexing for Lightning Fast Queries
topicSchema.index({ module_id: 1, topicOrder: 1 });

module.exports = mongoose.model('Topic', topicSchema);