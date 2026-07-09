// src/models/Department.js
const mongoose = require('mongoose');

const DepartmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true // e.g., "IFile", "Carbon", "Ideal"
  },
  code: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true // e.g., "ifile", "carbon", "ideal" (Taaki routing system safe rahe)
  },
  description: {
    type: String,
    default: ""
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  // 🎯 Enables virtual populate mapping fields to dynamically pull child teams
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// =========================================================================
// 🔗 VIRTUAL RELATIONSHIP INTERCEPTOR
// =========================================================================
// Automatically maps all Teams belonging to this department when populating
DepartmentSchema.virtual('teams', {
  ref: 'Team',
  localField: '_id',
  foreignField: 'department_id'
});

module.exports = mongoose.model('Department', DepartmentSchema);