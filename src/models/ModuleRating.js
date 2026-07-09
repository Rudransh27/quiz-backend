// src/models/ModuleRating.js
const mongoose = require('mongoose');

const moduleRatingSchema = new mongoose.Schema({
  user_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  module_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Module', 
    required: true 
  },
  
  // 🎯 SAAS ANALYTICS ACCELERATOR
  // Storing the department direct allows the admin panel reports to aggregate 
  // star ratings by business line instantly without complex database joins.
  department_id: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Department', 
    required: true 
  },
  
  rating: { 
    type: Number, 
    required: [true, "Please provide a rating value"], 
    min: 1, 
    max: 5 
  }, 
  reviewText: { 
    type: String, 
    default: "" 
  }
}, { timestamps: true });

// Indexing: One user can only rate an individual module exactly once
moduleRatingSchema.index({ user_id: 1, module_id: 1 }, { unique: true });

// High-speed index for corporate dashboard average metric aggregation
moduleRatingSchema.index({ department_id: 1, rating: 1 });

module.exports = mongoose.model('ModuleRating', moduleRatingSchema);