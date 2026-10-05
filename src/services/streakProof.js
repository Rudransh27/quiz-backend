// src/services/streakProof.js
//
// POST /api/progress/streak/verify used to accept any actionType on the
// client's word, so a streak (and its daily XP) could be claimed without
// doing anything. Each action must now be backed by a server-side record
// from the last day:
//   daily_read      — the learner opened a Daily Read (DailyReadOpen) at
//                     least MIN_READ_SECONDS ago (the reader's own threshold
//                     is 30s; a little slack covers network latency)
//   module_progress — a topic or module completed (UserTopicProgress /
//                     UserModuleProgress isCompleted, updated in the window)
//   idea_submission — an idea submitted (Idea.createdAt in the window)
// The window is 24h back from now, which covers "today" in every timezone
// for an action that just happened; the ledger's one-key-per-day already
// stops a second payout on the same day.
const UserTopicProgress = require('../models/UserTopicProgress');
const UserModuleProgress = require('../models/UserModuleProgress');
const DailyReadOpen = require('../models/DailyReadOpen');
const Idea = require('../models/Idea');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_READ_SECONDS = 25;

const MESSAGES = {
  daily_read: "Open today's read and spend a little time on it first.",
  module_progress: 'Finish a topic or module first.',
  idea_submission: 'Submit an idea first.',
};

async function hasActivityProof(userId, actionType, now = new Date()) {
  const since = new Date(now.getTime() - WINDOW_MS);
  let ok = false;
  if (actionType === 'daily_read') {
    const latestAllowedOpen = new Date(now.getTime() - MIN_READ_SECONDS * 1000);
    ok = !!(await DailyReadOpen.exists({ user_id: userId, openedAt: { $gte: since, $lte: latestAllowedOpen } }));
  } else if (actionType === 'module_progress') {
    ok = !!(await UserTopicProgress.exists({ user_id: userId, isCompleted: true, updatedAt: { $gte: since } }))
      || !!(await UserModuleProgress.exists({ user_id: userId, isCompleted: true, updatedAt: { $gte: since } }));
  } else if (actionType === 'idea_submission') {
    ok = !!(await Idea.exists({ userId, createdAt: { $gte: since } }));
  }
  return ok ? { ok: true } : { ok: false, message: MESSAGES[actionType] || 'No matching activity found.' };
}

module.exports = { hasActivityProof, MIN_READ_SECONDS, WINDOW_MS };
