const mongoose = require('mongoose');

const moduleSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  description: String,
  imageUrl: String,
  department: {
    type: String,
    enum: ['ifile', 'ideal', 'carbon'], // This ensures only these values are allowed
    required: true,
  },
  // We can use an array of ObjectId to reference the topics
  topics: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Topic'
  }]
});

module.exports = mongoose.model('Module', moduleSchema);