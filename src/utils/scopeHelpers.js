// src/utils/scopeHelpers.js
// Shared by moduleRoutes.js and categoryRoutes.js — both Module and Category
// carry the exact same three-layer visibility scope (Global / Departmental /
// Team-Specific), so the id-normalization and team-ownership-validation
// helpers live here once instead of being copy-pasted per resource.
const mongoose = require("mongoose");

// Normalizes a single ID / array of IDs / falsy value down to a flat array
// of ObjectId-valid strings.
const toIdArray = (value) => {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((v) => (v && v._id ? v._id : v))
    .filter((v) => v && mongoose.Types.ObjectId.isValid(v.toString()))
    .map((v) => v.toString());
};

// 🔒 Resolves a requested targetTeams value (single ID, array, or falsy) down
// to only the team IDs that actually belong to ONE OF the given department(s)
// — never trusts client-submitted team IDs outright.
const resolveOwnedTeamIds = async (requestedTeams, departmentIds) => {
  const Team = require("../models/Team");
  const validObjectIds = toIdArray(requestedTeams).map((id) => new mongoose.Types.ObjectId(id));
  if (validObjectIds.length === 0) return [];

  const deptIdList = toIdArray(departmentIds).map((id) => new mongoose.Types.ObjectId(id));
  if (deptIdList.length === 0) return [];

  const ownedTeams = await Team.find({
    _id: { $in: validObjectIds },
    department_id: { $in: deptIdList },
  }).select("_id").lean();
  return ownedTeams.map((t) => t._id);
};

// 🌍 REGION SCOPE — a second, independent filter dimension layered on top of
// the department/team visibility RBAC above. Shape is symmetric on purpose:
// a User with no `regions` set is unrestricted (sees every region); a
// Category/Module with no `regions` set is unrestricted (visible in every
// region). Only when BOTH sides have something set does the intersection
// actually matter. Superadmin always bypasses this entirely, same as every
// other RBAC check in this codebase.
//
// buildRegionMatch(userRegions) — a Mongo match fragment to $and onto an
// existing visibility matchCriteria object (or null, meaning "no extra
// filter needed" — the caller should skip the $and rather than inject an
// empty object). Deliberately tolerant of `regions` being absent on older
// documents (not just an empty array) — `$exists:false` covers docs saved
// before this field existed, `$size:0` covers ones explicitly set empty.
const buildRegionMatch = (userRegions) => {
  const ids = toIdArray(userRegions);
  if (ids.length === 0) return null;
  return {
    $or: [
      { regions: { $exists: false } },
      { regions: { $size: 0 } },
      { regions: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } },
    ],
  };
};

// passesRegionScope(doc, req) — the single-document equivalent of
// buildRegionMatch, for gates like assertModuleViewAccess/
// assertCategoryViewAccess that check one already-fetched doc rather than
// building a Mongo query.
const passesRegionScope = (doc, req) => {
  if (req.user.role === "superadmin") return true;
  const contextUser = req.user.user ? req.user.user : req.user;
  const userRegionIds = toIdArray(contextUser.regions);
  if (userRegionIds.length === 0) return true;
  const docRegionIds = toIdArray(doc.regions);
  if (docRegionIds.length === 0) return true;
  return docRegionIds.some((id) => userRegionIds.includes(id));
};

module.exports = { toIdArray, resolveOwnedTeamIds, buildRegionMatch, passesRegionScope };
