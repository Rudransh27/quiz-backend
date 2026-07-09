// src/controllers/notificationController.js
const UserNotification = require('../models/UserNotification');

const resolveUser = (req) => {
  const ctx = req.user && req.user.user ? req.user.user : req.user;
  return ctx ? (ctx.id || ctx._id) : null;
};

exports.getNotifications = async (req, res) => {
  try {
    const userId = resolveUser(req);
    if (!userId) return res.status(401).json({ success: false });

    const notifications = await UserNotification.find({ user_id: userId })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    const unreadCount = notifications.filter(n => !n.read).length;

    return res.status(200).json({ success: true, notifications, unreadCount });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.markNotificationRead = async (req, res) => {
  try {
    const userId = resolveUser(req);
    if (!userId) return res.status(401).json({ success: false });

    const { id } = req.params;
    await UserNotification.findOneAndUpdate(
      { _id: id, user_id: userId },
      { read: true }
    );
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.markAllRead = async (req, res) => {
  try {
    const userId = resolveUser(req);
    if (!userId) return res.status(401).json({ success: false });

    await UserNotification.updateMany({ user_id: userId, read: false }, { read: true });
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
