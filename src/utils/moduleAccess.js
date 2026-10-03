// src/utils/moduleAccess.js
// The module visibility gate (department / team / region), shared by every
// route that serves or grades a module's content: GET /api/modules/:id and
// its review endpoints, GET /api/topics/:id + /cards/:id, and the grading
// endpoints. Kept in one place so the rule can't drift between "can view"
// and "can submit answers to".
const { moduleHasDept } = require("./moduleDepartments");
const { passesRegionScope } = require("./scopeHelpers");
const { isModuleUnlockedForUser } = require("./moduleLock");

// Returns { ok: true } or { ok: false, status, message }.
const assertModuleViewAccess = (moduleData, req) => {
  if (req.user.role === "superadmin") return { ok: true };

  const contextUser = req.user.user ? req.user.user : req.user;
  const userDeptStr = contextUser.department?.toString();
  const userTeamStr = contextUser.team?.toString();

  if (moduleData.visibility === "Departmental" && !moduleHasDept(moduleData, userDeptStr)) {
    return { ok: false, status: 403, message: "Access Denied: Foreign Department content locked." };
  }

  if (moduleData.visibility === "Team-Specific") {
    if (!moduleHasDept(moduleData, userDeptStr)) {
      return { ok: false, status: 403, message: "Access Denied: Foreign Department content locked." };
    }
    const hasTeamAccess = (moduleData.targetTeams || []).some((tId) => tId.toString() === userTeamStr);
    if (!hasTeamAccess) {
      return { ok: false, status: 403, message: "Access Denied: Locked for your specific team scope." };
    }
  }

  if (!passesRegionScope(moduleData, req)) {
    return { ok: false, status: 403, message: "Access Denied: Not available in your region." };
  }

  return { ok: true };
};

const LOCKED_MESSAGE = "This module is locked. Complete the previous module in this category first.";

// Visibility + sequential lock in one call (admin/superadmin bypass the lock,
// matching GET /api/modules/:id). Returns the same { ok, status, message }.
const assertModuleLearnerAccess = async (moduleData, req) => {
  const view = assertModuleViewAccess(moduleData, req);
  if (!view.ok) return view;
  if (req.user.role === "admin" || req.user.role === "superadmin") return { ok: true };

  const contextUser = req.user.user ? req.user.user : req.user;
  const unlocked = await isModuleUnlockedForUser({
    moduleId: moduleData._id,
    categoryId: moduleData.categoryId,
    userId: contextUser.id || contextUser._id,
    isVisible: (m) => assertModuleViewAccess(m, req).ok,
  });
  if (!unlocked) return { ok: false, status: 403, message: LOCKED_MESSAGE, locked: true };
  return { ok: true };
};

module.exports = { assertModuleViewAccess, assertModuleLearnerAccess, LOCKED_MESSAGE };
