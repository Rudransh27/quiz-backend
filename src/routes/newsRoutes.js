// src/routes/newsRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const newsController = require("../controllers/newsController");

// GET /api/news/dashboard — any authenticated user; self-scoped server-side
// to their own department (or everything, for superadmin) inside the
// service layer. No department/scope filter is ever read from the request.
router.get("/dashboard", auth, newsController.getDashboardNews);

// GET /api/news/feed — any authenticated user; same self-scoping as
// /dashboard but returns the full in-scope list (newest first, capped) for
// the dashboard carousel instead of a single prioritized post.
router.get("/feed", auth, newsController.getNewsFeed);

// GET /api/news/manage — admin/superadmin only; same visibility scoping,
// full in-scope list (for the Broadcast admin page's listing view).
router.get("/manage", [auth, admin], newsController.getManageableNews);

// POST /api/news/create — admin/superadmin only; scope/department
// resolution and anti-spoofing rules live in newsService.createNewsPost.
router.post("/create", [auth, admin], newsController.createNewsPost);

module.exports = router;
