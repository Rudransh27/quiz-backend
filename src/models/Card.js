const mongoose = require('mongoose');

const cardSchema = new mongoose.Schema({
  topic_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Topic',
    required: true,
  },
  card_type: {
    type: String,
    enum: ['quiz', 'knowledge', 'code'], // Define allowed card types
    required: true,
  },
  imageUrl: String,
  cardOrder: {
    type: Number,
    required: true,
  },
  content: {
    // We store the whole card data as a flexible object
    type: Object, 
    required: true,
  }
});

module.exports = mongoose.model('Card', cardSchema);