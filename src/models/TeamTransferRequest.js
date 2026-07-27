// src/models/TeamTransferRequest.js
// Records every attempt to move a user between two teams in the same
// department (see teamRoutes.js's POST /transfer-request). If the target
// team has an admin, this starts life as "pending" and needs that admin's
// approval before the user's actual `team` field changes; if the target
// team has no admin, the move happens immediately and this is written
// straight to "auto_approved" — kept either way as the audit trail of who
// moved whom, when, and on whose authority.
const mongoose = require('mongoose');

const TeamTransferRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fromTeam: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
    toTeam: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
    // Denormalized so pending-request lookups don't need to join through
    // the user or either team just to scope by department.
    department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'auto_approved'],
      default: 'pending',
    },
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

TeamTransferRequestSchema.index({ toTeam: 1, status: 1 });

module.exports = mongoose.model('TeamTransferRequest', TeamTransferRequestSchema);
