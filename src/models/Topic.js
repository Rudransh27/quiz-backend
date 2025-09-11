const mongoose = require('mongoose');

const topicSchema = new mongoose.Schema({
  // Reference to the parent Module
  module_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Module', // This references the 'Module' model
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  description: String,
  imageUrl: String,
  topicOrder: {
    type: Number,
    required: true,
  },
  // Array of ObjectIds to reference the Cards within this topic
  cards: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Card' // This references the 'Card' model
  }]
});

module.exports = mongoose.model('Topic', topicSchema);