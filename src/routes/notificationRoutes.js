// src/routes/notificationRoutes.js
const express = require('express');
const auth = require('../middleware/auth');
const notificationController = require('../controllers/notificationController');

const router = express.Router();

// @route    GET /api/notifications
// @desc     Fetch logged-in user's notifications (latest 30, sorted newest first)
// @access   Private
router.get('/', auth, notificationController.getNotifications);

// @route    PUT /api/notifications/read-all
// @desc     Mark all of the user's notifications as read
// @access   Private
router.put('/read-all', auth, notificationController.markAllRead);

// @route    PUT /api/notifications/:id/read
// @desc     Mark a single notification as read
// @access   Private
router.put('/:id/read', auth, notificationController.markNotificationRead);

module.exports = router;
