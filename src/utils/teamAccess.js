// src/utils/teamAccess.js
// Team-scoped write gate for user scores/grades. Read access to another
// team's data within the same department is unchanged (still department-
// wide, exactly like today) — this only gates the handful of endpoints
// that actually MUTATE a specific user's progress/XP: an admin has full
// read/write for their own team's users, and read-only for other teams'
// users in the same department. Superadmins and Council-team admins
// (department-wide by design — see Team.js's `isCouncil`) bypass this
// entirely.
const Team = require('../models/Team');

// Resolves once per request whether the acting admin has department-wide
// write access (superadmin, or their own team is the department's Council
// team) — callers should call this ONCE before looping over many target
// users, then use canWriteUserProgress() (sync, no DB call) per user.
async function resolveIsCouncilAdmin(actingAdminUser) {
  if (actingAdminUser.role === 'superadmin') return true;
  if (!actingAdminUser.team) return false;
  const team = await Team.findById(actingAdminUser.team).select('isCouncil').lean();
  return !!(team && team.isCouncil);
}

// Pure/sync — call after resolveIsCouncilAdmin() has been resolved once.
function canWriteUserProgress({ isSuperAdminOrCouncil, actingTeamId, targetTeamId }) {
  if (isSuperAdminOrCouncil) return true;
  if (!actingTeamId || !targetTeamId) return false;
  return actingTeamId.toString() === targetTeamId.toString();
}

module.exports = { resolveIsCouncilAdmin, canWriteUserProgress };
