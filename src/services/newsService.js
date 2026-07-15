// src/services/newsService.js
//
// Business-logic layer for the News/Broadcast feature — the Controller stays
// thin (parse req, call here, return res); this file owns visibility-query
// construction and permission/scope resolution. No separate "repository"
// file: Mongoose models already are this backend's data-access layer
// (matching how every other feature here treats them — a repository
// wrapper around a Mongoose model that adds no behavior of its own would be
// pure ceremony).
const mongoose = require("mongoose");
const News = require("../models/News");
const Department = require("../models/Department");

// 🔒 THE actual read-side security boundary — the department value used to
// filter always comes from `user.department` (the JWT-verified identity
// attached by the `auth` middleware), never from any client-supplied query
// param or body field. A regular user has no request field that could ask
// for a different department's posts; the query below is built without
// touching req.query/req.body at all.
function buildVisibilityQuery(user) {
  if (user.role === "superadmin") return {};

  const conditions = [{ scope: "Global" }];
  if (user.department) {
    conditions.push({
      scope: "Departmental",
      department: new mongoose.Types.ObjectId(user.department.toString()),
    });
  }
  return { $or: conditions };
}

async function getDashboardNews(user) {
  const query = buildVisibilityQuery(user);

  // Prioritize the most recent breaking post in scope; otherwise fall back
  // to the single most recent post in scope (News isn't inherently daily
  // like Daily Read, so there's no "today's" date cutoff — just "latest").
  const breaking = await News.findOne({ ...query, isBreaking: true })
    .sort({ createdAt: -1 })
    .populate("department", "name")
    .lean();
  if (breaking) return breaking;

  return News.findOne(query)
    .sort({ createdAt: -1 })
    .populate("department", "name")
    .lean();
}

async function getNewsFeed(user, limit = 12) {
  const query = buildVisibilityQuery(user);
  return News.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("department", "name")
    .lean();
}

async function getManageableNews(user) {
  const query = buildVisibilityQuery(user);
  return News.find(query)
    .sort({ createdAt: -1 })
    .populate("department", "name")
    .populate("createdBy", "username")
    .lean();
}

// 🔒 THE actual write-side security boundary — see the scope/department
// resolution block below. Nothing here trusts a client-supplied department
// for a regular admin's own posts.
async function createNewsPost(user, payload) {
  const { title, content, isBreaking } = payload;
  let { contentType, mediaUrl, scope, departmentId } = payload;

  if (!title || !title.trim()) {
    const err = new Error("A news post title is required.");
    err.status = 400;
    throw err;
  }
  if (!content || !content.trim()) {
    const err = new Error("News post content is required.");
    err.status = 400;
    throw err;
  }

  contentType = ["text", "image", "video"].includes(contentType) ? contentType : "text";
  // A text post has no media — ignore any stray mediaUrl the client sent.
  mediaUrl = contentType === "text" ? "" : (mediaUrl || "").trim();

  if (!["Global", "Departmental"].includes(scope)) {
    const err = new Error('scope must be "Global" or "Departmental".');
    err.status = 400;
    throw err;
  }

  let resolvedDepartmentId = null;

  if (scope === "Departmental") {
    if (user.role === "superadmin") {
      // Superadmin must explicitly name a real department — never inferred.
      if (!departmentId) {
        const err = new Error("Superadmin must provide a departmentId for a Departmental broadcast.");
        err.status = 400;
        throw err;
      }
      const dept = await Department.findById(departmentId).lean();
      if (!dept) {
        const err = new Error("The specified department does not exist.");
        err.status = 404;
        throw err;
      }
      resolvedDepartmentId = dept._id;
    } else {
      // 🔒 Regular admin: ALWAYS their own department, regardless of
      // whatever departmentId the request body might contain — mirrors the
      // exact anti-spoofing rule Daily Read's POST route already applies.
      if (!user.department) {
        const err = new Error("Your account has no department context — cannot broadcast Departmental news.");
        err.status = 400;
        throw err;
      }
      resolvedDepartmentId = user.department;
    }
  }
  // scope === "Global": resolvedDepartmentId stays null for BOTH admin and
  // superadmin — per spec, Department Admins may broadcast Global too, no
  // extra restriction beyond already being admin/superadmin (the route-level
  // [auth, admin] gate already enforced that before this function runs).

  const created = await News.create({
    title: title.trim(),
    content: content.trim(),
    contentType,
    mediaUrl,
    isBreaking: !!isBreaking,
    scope,
    department: resolvedDepartmentId,
    createdBy: user.id || user._id,
  });

  return created;
}

module.exports = {
  buildVisibilityQuery,
  getDashboardNews,
  getNewsFeed,
  getManageableNews,
  createNewsPost,
};
