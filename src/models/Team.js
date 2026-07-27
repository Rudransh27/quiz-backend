// src/models/Team.js
const mongoose = require('mongoose');

const TeamSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: [true, "Please provide a team name"], 
    trim: true // e.g., 'Sales', 'DevOps', 'Developer'
  }, 
  code: { 
    type: String, 
    required: [true, "Please provide a unique team code"], 
    uppercase: true, // Automatically forces uniform code streams (e.g., 'SALES', 'DEVOPS')
    trim: true 
  }, 
  department_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    required: [true, "A team must be assigned to a specific business line parent"]
  },
  // 🏛️ COUNCIL DESIGNATION — exactly one per department, auto-created
  // alongside it (see departmentRoutes.js). Admins assigned to this team
  // are department-wide admins (full read/write across every team in the
  // department) rather than being scoped to a single team — this replaces
  // the old "admin with no team at all" state so every admin always has a
  // real team reference, never null.
  isCouncil: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

// =========================================================================
// 🎯 COMPOSITE COMPANION SECURITY INDEX
// =========================================================================
// Ensures that team codes are strictly unique within a single department scope, 
// but allows different departments to use the same team code safely (e.g., Carbon:SALES and iFile:SALES).
TeamSchema.index({ department_id: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Team', TeamSchema);