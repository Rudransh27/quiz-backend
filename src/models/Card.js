// src/models/Card.js
const mongoose = require('mongoose');

const cardSchema = new mongoose.Schema({
  // If the card belongs to a topic
  topic_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Topic',
    required: function() { return !this.module_id; } // Required ONLY IF module_id is absent
  },
  // If the card belongs directly to a module (skipping topics)
  module_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module',
    required: function() { return !this.topic_id; } // Required ONLY IF topic_id is absent
  },
  card_type: {
    type: String,
    // 🚀 UPDATED ENUM: Added 'html_sandbox' as an individual card type option
    enum: ['quiz', 'knowledge', 'code', 'video', 'pdf', 'ppt', 'html_sandbox'],
    required: true,
  },
  cardOrder: { type: Number, required: true },
  imageUrl: { type: String, default: "" },
  content: { type: Object, required: true }
}, { timestamps: true });

// 🚀 Optimized Compound Indexes for both query paths
cardSchema.index({ topic_id: 1, cardOrder: 1 });
cardSchema.index({ module_id: 1, cardOrder: 1 });

module.exports = mongoose.model('Card', cardSchema);