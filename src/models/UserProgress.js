const mongoose = require('mongoose');

const UserProgressSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  modules: [{
    moduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Module',
      required: true,
    },
    topics: [{
      topicId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Topic',
        required: true,
      },
      cardsCovered: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Card',
      }],
      bestXP: {
        type: Number,
        default: 0,
      },
      isCompleted: {
        type: Boolean,
        default: false,
      },
      lastAttemptedAt: { // helpful for analytics
        type: Date,
      }
    }],
  }],
});

module.exports = mongoose.model('UserProgress', UserProgressSchema);
