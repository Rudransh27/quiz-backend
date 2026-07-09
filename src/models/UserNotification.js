// src/models/UserNotification.js
const mongoose = require('mongoose');

const UserNotificationSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: { type: String, default: 'xp_award' },
    message: { type: String, required: true },
    xpAwarded: { type: Number, default: 0 },
    moduleTitle: { type: String, default: '' },
    cardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Card', default: null },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

UserNotificationSchema.index({ user_id: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('UserNotification', UserNotificationSchema);
