// src/routes/progress.js
const express = require('express');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');
const upload = require('../middleware/multer');
const progressController = require('../controllers/progressController');

const router = express.Router();

// @route    POST /api/progress/card-completed
// @desc     Records card completion with retake & gamification sync
// @access   Private
router.post('/card-completed', auth, progressController.recordCardCompletion);

// @route    GET /api/progress
// @desc     Fetch computed flat analytics (arrays + counts) for frontend hydration
// @access   Private
router.get('/', auth, progressController.getUserProgress);

// @route    GET /api/progress/admin/users
// @desc     Admin: list all users with basic stats (XP, cards completed)
// @access   Admin / Superadmin
router.get('/admin/users', auth, admin, progressController.getAdminUsersList);

// @route    GET /api/progress/sandbox/:cardId
// @desc     Logged-in user gets their own full question-by-question results for a sandbox card
// @access   Private
router.get('/sandbox/:cardId', auth, progressController.getSandboxDetail);

// @route    GET /api/progress/admin/sandbox/:cardId
// @desc     Admin: all users' answers + accuracy stats for a specific sandbox card
// @access   Admin / Superadmin
router.get('/admin/sandbox/:cardId', auth, admin, progressController.getAdminSandboxResults);

// @route    GET /api/progress/admin/user/:userId/sandbox-answers
// @desc     Admin: all sandbox question answers for a specific user across all cards
// @access   Admin / Superadmin
router.get('/admin/user/:userId/sandbox-answers', auth, admin, progressController.getUserSandboxAnswersForAdmin);

// @route    GET /api/progress/admin/user/:userId
// @desc     Admin: full analytics breakdown for a specific user (quiz accuracy, sandbox scores, progress)
// @access   Admin / Superadmin
router.get('/admin/user/:userId', auth, admin, progressController.getAdminUserAnalytics);

// @route    POST /api/progress/admin/import-grades
// @desc     Admin: bulk import assigned scores from grading template, update user XP
// @access   Admin / Superadmin
router.post('/admin/import-grades', auth, admin, progressController.importGrades);

// @route    PUT /api/progress/admin/card/:cardId/user/:userId/grade
// @desc     Admin: grade a single user's sandbox submission (slider/entry UI), update user XP
// @access   Admin / Superadmin
router.put('/admin/card/:cardId/user/:userId/grade', auth, admin, progressController.gradeSingleSubmission);

// @route    GET /api/progress/admin/dept-sandbox-answers
// @desc     Admin: all sandbox answers for all users in the admin's own department
// @access   Admin / Superadmin
router.get('/admin/dept-sandbox-answers', auth, admin, progressController.getDeptSandboxAnswers);

// @route    GET /api/progress/my-sandbox-results
// @desc     User: all of the logged-in user's sandbox submissions with admin grading
// @access   Private
router.get('/my-sandbox-results', auth, progressController.getMySandboxResults);

// @route    GET /api/progress/admin/platform-stats
// @desc     Platform-wide XP totals, daily activity charts, card type breakdown
// @access   Admin / Superadmin
router.get('/admin/platform-stats', auth, admin, progressController.getAdminPlatformStats);

// @route    GET /api/progress/admin/module-engagement
// @desc     Per-module users started, completion counts, sandbox avg score
// @access   Admin / Superadmin
router.get('/admin/module-engagement', auth, admin, progressController.getAdminModuleEngagement);

// @route    GET /api/progress/admin/department-stats
// @desc     Department-level XP totals, avg XP, cards/topics completed, top earner
// @access   Admin / Superadmin
router.get('/admin/department-stats', auth, admin, progressController.getAdminDepartmentStats);

// @route    POST /api/progress/admin/module/:moduleId/import-grades-csv
// @desc     Admin: import a single module's graded submissions from a re-uploaded CSV
// @access   Admin / Superadmin
router.post('/admin/module/:moduleId/import-grades-csv', auth, admin, upload.single('file'), progressController.importModuleGradesCsv);

// @route    GET /api/progress/admin/module-progress-table
// @desc     Admin: unified per-user/per-module progress table (standard % + sandbox grading status)
// @access   Admin / Superadmin
router.get('/admin/module-progress-table', auth, admin, progressController.getAdminModuleProgressTable);

// @route    POST /api/progress/streak/verify
// @desc     Record a daily engagement action and apply the 2/3 streak rule
// @access   Private
router.post('/streak/verify', auth, progressController.verifyDailyStreak);

// @route    GET /api/progress/streak
// @desc     Get the authenticated user's streak counters + last-30-day engagement history
// @access   Private
router.get('/streak', auth, progressController.getMyStreak);

// @route    GET /api/progress/module-scope-state
// @desc     Ordered per-card progress + submitted answers for one module/topic
//           scope — powers Linear Locking + Review Mode on the frontend
// @access   Private
router.get('/module-scope-state', auth, progressController.getModuleScopeState);

// @route    POST /api/progress/module-reset
// @desc     Learner self-service reset/reattempt — archives this user's
//           progress for a module (or topic), claws back its XP, clean slate
// @access   Private
router.post('/module-reset', auth, progressController.resetModuleProgress);

module.exports = router;