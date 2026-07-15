// src/controllers/newsController.js
//
// Thin — parses the request, delegates to the service layer, returns JSON.
// No business logic here (visibility rules, scope/permission resolution all
// live in newsService.js) — mirrors the Controller/Service split the whole
// feature is built around.
const newsService = require("../services/newsService");

function getRequestUser(req) {
  return req.user && req.user.user ? req.user.user : req.user;
}

exports.getDashboardNews = async (req, res) => {
  try {
    const user = getRequestUser(req);
    const news = await newsService.getDashboardNews(user);
    return res.status(200).json({ success: true, data: news || null });
  } catch (err) {
    console.error("News dashboard fetch failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load news." });
  }
};

exports.getNewsFeed = async (req, res) => {
  try {
    const user = getRequestUser(req);
    const news = await newsService.getNewsFeed(user);
    return res.status(200).json({ success: true, data: news });
  } catch (err) {
    console.error("News feed fetch failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load news feed." });
  }
};

exports.getManageableNews = async (req, res) => {
  try {
    const user = getRequestUser(req);
    const news = await newsService.getManageableNews(user);
    return res.status(200).json({ success: true, data: news });
  } catch (err) {
    console.error("News manage-list fetch failed:", err.message);
    return res.status(500).json({ success: false, message: "Failed to load news list." });
  }
};

exports.createNewsPost = async (req, res) => {
  try {
    const user = getRequestUser(req);
    const created = await newsService.createNewsPost(user, req.body);
    return res.status(201).json({ success: true, data: created });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error("News post creation failed:", err.message);
    return res.status(status).json({ success: false, message: err.message || "Failed to create news post." });
  }
};
