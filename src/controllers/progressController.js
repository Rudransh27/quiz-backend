// src/controllers/progressController.js
const UserCardProgress = require('../models/UserCardProgress');
const UserTopicProgress = require('../models/UserTopicProgress');
const UserModuleProgress = require('../models/UserModuleProgress');
const ModuleResetLog = require('../models/ModuleResetLog');
const User = require('../models/User');
const Card = require('../models/Card');
const Module = require('../models/Module');
const Topic = require('../models/Topic');
const Department = require('../models/Department');
const UserNotification = require('../models/UserNotification');
const { parseHtmlSandboxPoints } = require('../utils/pointsCalculator');
const { resolveClientToday, shiftDateKey } = require('../utils/localDate');

/*
 * STANDARD HTML SANDBOX postMessage FORMAT
 * Every html_sandbox card MUST call window.parent.postMessage() with this exact shape:
 *
 * window.parent.postMessage({
 *   fromSandboxEngine: true,
 *   type: "HTML_SIMULATION_SUBMIT",
 *   score: <number>,              // points user scored
 *   maxPossibleScore: <number>,   // total points available
 *   textResponses: {
 *     questions: [
 *       {
 *         id: "q1",                        // unique within this card
 *         questionText: "What is XBRL?",
 *         type: "mcq" | "text" | "true_false" | "code",
 *         userAnswer: "...",               // exactly what the user submitted
 *         correctAnswer: "...",            // the expected correct answer
 *         isCorrect: true | false,
 *         options: ["A","B","C","D"],      // only for mcq / true_false
 *         points: 1,                       // points awarded for this question
 *         maxPoints: 1                     // max points for this question
 *       }
 *     ]
 *   }
 * }, "*");
 */

// 🚀 UPDATED HELPER: Added clear tracking weight definitions for the HTML Sandbox
//
// 🎯 BUG FIX (quiz reattempt/lives audit): wrong quiz/code answers used to
// dock -2 XP on top of costing a life — a double-penalty for one mistake in
// a 5-lives system, where losing the life IS the punishment. That -2 also
// polluted the "clean" completion-XP total: get it wrong then right on retry
// used to net +3 (-2 then +5) instead of a clean +5, since the wrong
// attempt's award and the eventual-correct award are two separate
// increments (see recordCardCompletion's isFirstTime / wrong->correct
// transition guard below — that guard already correctly prevents re-award
// on a THIRD/later resubmission, but couldn't undo the first wrong
// attempt's own penalty). Now a wrong answer awards 0, so no matter how
// many attempts a card takes, the total awarded for it is always exactly
// its one correct-completion value — never more, never less.
const calculateXp = (cardType, isCorrect) => {
  if (cardType === 'knowledge') return 2;
  if (cardType === 'pdf') return 5;
  if (cardType === 'ppt' || cardType === 'pptx') return 5;
  if (cardType === 'video') return 10;
  if (cardType === 'html_sandbox') return 15; // 🎯 Fixed baseline award weight for completing an interactive simulator task
  if (cardType === 'quiz') return isCorrect ? 5 : 0;
  if (cardType === 'code') return isCorrect ? 10 : 0;
  return 0;
};

// 🎯 Daily streak point payout — only ever applied once per day, at the exact
// moment engagementHistory's today-entry first crosses qualifiesForStreak
// (see verifyDailyStreak below). Whichever of the 3 actions the user
// completes FIRST that day pays out its own value; later actions the same
// day just extend todayActions with no further XP.
const POINTS_BY_ACTION = {
  daily_read:      10,
  module_progress: 15,
  idea_submission: 10,
};

// 🌐 HTML SANDBOX MODULE XP: score-proportional (vs the flat calculateXp() baseline used
// by html_sandbox cards embedded inside topic/express-flat modules). Only used when the
// card's parent Module has moduleType==='html_sandbox'.
//
// 🎯 maxPoints is now derived by parsing the card's authored HTML for its
// embedded quiz (5pt) / descriptive (10pt) questions, instead of trusting a
// single flat admin-set number regardless of how many questions the sandbox
// actually contains — falls back to the admin field only if parsing finds
// nothing (e.g. an empty/not-yet-authored sandbox).
const computeSandboxModuleXp = (card, answeredScore, totalPossibleWeight) => {
  const parsed = parseHtmlSandboxPoints(card?.content?.htmlSource);
  const maxPoints = parsed.total > 0 ? parsed.total : (Number(card?.content?.maxPoints) || 10);
  const maxScore = Number(totalPossibleWeight) || 0;
  if (maxScore <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (Number(answeredScore) || 0) / maxScore));
  return Math.round(ratio * maxPoints);
};

// =========================================================================
// CONTROLLER 1: Record Card Completion Logs
// =========================================================================
exports.recordCardCompletion = async (req, res) => {
  // 🚀 INJECTED EXTBOY: Added structural score allocations and custom text responses arrays
  const { cardId, topicId, moduleId, isCorrect, answeredScore, totalPossibleWeight, textResponses, timeSpentDelta, selectedOption, userCodeAnswer } = req.body;

  // Clamp against a stuck/backgrounded tab reporting an inflated elapsed time
  // (e.g. laptop left open overnight on this card) inflating the total.
  const clampedTimeDelta = Math.min(1800, Math.max(0, Number(timeSpentDelta) || 0));
  
  // ✅ Resilient User ID Extraction mapping layers safely
  const contextUser = req.user && req.user.user ? req.user.user : req.user;
  const userId = contextUser ? (contextUser.id || contextUser._id) : null;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized: User parsing failed.' });
  }

  if (!cardId || !moduleId) {
    return res.status(400).json({ success: false, message: 'Missing critical identifiers: cardId or moduleId.' });
  }

  const isExpressFlatTrack = !topicId || topicId === "undefined" || topicId.toString().trim() === "";

  try {
    const card = await Card.findById(cardId);
    if (!card) return res.status(404).json({ success: false, message: 'Card not found.' });

    // 🎯 BUG FIX (html_sandbox card always awarding a flat 15 instead of its
    // real parsed content total): this used to also require the PARENT
    // MODULE's own moduleType to be 'html_sandbox' before using the
    // content-aware calculation — but parseHtmlSandboxPoints only ever reads
    // the CARD's own content.htmlSource, so that extra condition was wrong.
    // An html_sandbox card embedded as a plain card inside a 'standard'
    // module (built via the Curriculum Map's generic Module → Cards flow,
    // e.g. "Carbon NITI AI Module 1") fell through to calculateXp's flat
    // `if (cardType === 'html_sandbox') return 15;` baseline instead — any
    // html_sandbox card, regardless of its parent module's type, must use
    // the same real-content calculation.
    const isHtmlSandboxCard = card.card_type === 'html_sandbox';

    const existingProgress = await UserCardProgress.findOne({ user_id: userId, card_id: cardId, isArchived: { $ne: true } });
    const isFirstTime = !existingProgress;
    let xpChange = 0;

    if (isFirstTime) {
      xpChange = isHtmlSandboxCard
        ? computeSandboxModuleXp(card, answeredScore, totalPossibleWeight)
        : calculateXp(card.card_type, isCorrect);
    } else {
      if (isCorrect && !existingProgress.isCorrect) {
        xpChange = calculateXp(card.card_type, true);
      }
    }

    // =========================================================================
    // ⚙️ TELEMETRY CONTEXT PAYLOAD COMPILATION
    // =========================================================================
    const cardProgressUpdate = {
      module_id: moduleId,
      topic_id: isExpressFlatTrack ? null : topicId,
      isCorrect: isCorrect,
      isArchived: false,
      $inc: { timesAttempted: 1, xpAwarded: xpChange }
    };

    // 🎯 REVIEW MODE: persist the actual submitted answer so a later revisit
    // can rehydrate a genuine read-only replay instead of a blank card.
    if (selectedOption !== undefined && selectedOption !== null) {
      cardProgressUpdate.selectedOption = Number(selectedOption);
    }
    if (userCodeAnswer !== undefined && userCodeAnswer !== null) {
      cardProgressUpdate.userCodeAnswer = String(userCodeAnswer);
    }

    // If the card is an HTML simulation, append the score numbers and text responses into the DB record
    if (card.card_type === 'html_sandbox') {
      cardProgressUpdate.score = answeredScore !== undefined ? Number(answeredScore) : 0;
      cardProgressUpdate.maxScore = totalPossibleWeight !== undefined ? Number(totalPossibleWeight) : 3;
      // Normalize: HTML cards may send textResponses as a direct array OR as { questions: [...] }
      const rawResponses = textResponses;
      cardProgressUpdate.metaFeedbackLogs = Array.isArray(rawResponses)
        ? { questions: rawResponses }
        : (rawResponses || {});
    }

    // 🎯 RESET/REATTEMPT: filtering the upsert match on isArchived:false means
    // a prior reset (which flips the old doc's isArchived to true) can never
    // collide with this upsert — a brand-new active doc gets created instead
    // of resurrecting the archived one, matching the partial unique index.
    await UserCardProgress.findOneAndUpdate(
      { user_id: userId, card_id: cardId, isArchived: false },
      cardProgressUpdate,
      { upsert: true, new: true }
    );

    // ✅ Use the verified context identity variable cleanly
    if (xpChange !== 0) {
      await User.findByIdAndUpdate(userId, { $inc: { xp: xpChange } });
    }

    let totalCardsInScope = 0;
    let userCompletedCardsInScope = 0;
    let currentCalculatedScopeXP = 0;
    // Hoisted out of the branch-local `isModuleCompletedNow`/`isTopicCompletedNow`
    // consts below (each declared with `const` inside its own `if`/`else` block,
    // so they don't exist by that name once execution reaches the shared code
    // after the if/else) — this is what the post-branch socket emit reads.
    let isScopeCompletedNow = false;

    if (isExpressFlatTrack) {
      totalCardsInScope = await Card.countDocuments({ module_id: moduleId });
      userCompletedCardsInScope = await UserCardProgress.countDocuments({ user_id: userId, module_id: moduleId, isArchived: { $ne: true } });

      const userModuleProgressList = await UserCardProgress.find({ user_id: userId, module_id: moduleId, isArchived: { $ne: true } }).lean();
      const completedCardIds = userModuleProgressList.map(p => p.card_id);
      const targetCardsDetailsList = await Card.find({ _id: { $in: completedCardIds } }).lean();

      const cardMap = {};
      targetCardsDetailsList.forEach(c => {
        cardMap[c._id.toString()] = c;
      });

      for (const record of userModuleProgressList) {
        const cardMeta = cardMap[record.card_id.toString()];
        if (!cardMeta) continue;
        if (cardMeta.card_type === 'html_sandbox') {
          currentCalculatedScopeXP += computeSandboxModuleXp(cardMeta, record.score, record.maxScore);
        } else {
          currentCalculatedScopeXP += calculateXp(cardMeta.card_type, record.isCorrect);
        }
      }

      // 🎯 BUG FIX (41 points awarded as 88): this used to ALSO award
      // computePointsReward(targetCardsDetailsList, ...) as a "module
      // completion bonus" here — on top of the per-card XP each of those
      // same cards already received individually as they were completed
      // (the $inc above, and the identical per-card sum accumulating in
      // currentCalculatedScopeXP). Once every card in the module is done,
      // the sum of individually-awarded XP already EQUALS the module's
      // total worth — a separate "bonus" of that same total again is a
      // straight double-count, not a real bonus. Removed entirely; only the
      // completion/dedupe bookkeeping below remains (still useful for
      // "is this module completed" tracking elsewhere), with no XP attached.
      const isModuleCompletedNow = (userCompletedCardsInScope === totalCardsInScope && totalCardsInScope > 0);
      isScopeCompletedNow = isModuleCompletedNow;
      const existingModuleProgress = await UserModuleProgress.findOne({ user_id: userId, module_id: moduleId });

      await UserModuleProgress.findOneAndUpdate(
        { user_id: userId, module_id: moduleId },
        {
          isCompleted: isModuleCompletedNow,
          pointsAwarded: isModuleCompletedNow ? true : (existingModuleProgress?.pointsAwarded || false),
          bestXP: currentCalculatedScopeXP,
          $inc: { timeSpentSeconds: clampedTimeDelta }
        },
        { upsert: true, new: true }
      );
    } else {
      totalCardsInScope = await Card.countDocuments({ topic_id: topicId });
      userCompletedCardsInScope = await UserCardProgress.countDocuments({ user_id: userId, topic_id: topicId, isArchived: { $ne: true } });

      const isTopicCompletedNow = (userCompletedCardsInScope === totalCardsInScope && totalCardsInScope > 0);
      isScopeCompletedNow = isTopicCompletedNow;

      const userCardsProgressList = await UserCardProgress.find({ user_id: userId, topic_id: topicId, isArchived: { $ne: true } }).lean();
      const completedCardIds = userCardsProgressList.map(p => p.card_id);
      const targetCardsDetailsList = await Card.find({ _id: { $in: completedCardIds } }).lean();
      
      const cardMap = {};
      targetCardsDetailsList.forEach(c => {
        cardMap[c._id.toString()] = c;
      });

      // 🎯 Same fix as the EXPRESS_FLAT branch above — an html_sandbox card
      // nested under a Topic must also use the real-content calculation,
      // not the flat calculateXp('html_sandbox', ...) baseline. This branch
      // previously had no such case at all.
      for (const record of userCardsProgressList) {
        const cardMeta = cardMap[record.card_id.toString()];
        if (!cardMeta) continue;
        if (cardMeta.card_type === 'html_sandbox') {
          currentCalculatedScopeXP += computeSandboxModuleXp(cardMeta, record.score, record.maxScore);
        } else {
          currentCalculatedScopeXP += calculateXp(cardMeta.card_type, record.isCorrect);
        }
      }

      // 🎯 BUG FIX (41 points awarded as 88): same double-count as the module
      // branch above — this used to ALSO award computePointsReward(...) as a
      // "topic completion bonus" on top of the per-card XP each card already
      // received individually. Removed entirely; pointsAwarded/isCompleted
      // bookkeeping stays (still useful for completion-tracking elsewhere),
      // just no longer gates an XP award since there isn't one anymore.
      const existingTopicProgress = await UserTopicProgress.findOne({ user_id: userId, topic_id: topicId });

      await UserTopicProgress.findOneAndUpdate(
        { user_id: userId, topic_id: topicId },
        {
          module_id: moduleId,
          isCompleted: isTopicCompletedNow,
          bestXP: currentCalculatedScopeXP,
          pointsAwarded: isTopicCompletedNow ? true : (existingTopicProgress?.pointsAwarded || false),
          $inc: { timeSpentSeconds: clampedTimeDelta }
        },
        { upsert: true, new: true }
      );
    }

    // 🎯 Live-update channel for the Learn/module-card grid — this handler
    // previously had zero Socket.IO emit, so a module card open in another
    // tab (or the Learn grid sitting mounted while progress happens
    // elsewhere) had no way to learn its progress changed except a manual
    // refresh. Reuses the exact activeUserSockets/io.to(socketId) pattern
    // already established for the 'xp_award' event below in this file.
    const strUidForProgress = userId.toString();
    if (global.activeUserSockets?.has(strUidForProgress)) {
      global.activeUserSockets.get(strUidForProgress).forEach(socketId => {
        global.io.to(socketId).emit('module_progress_update', {
          moduleId,
          cardsCovered: userCompletedCardsInScope,
          totalCards: totalCardsInScope,
          isCompleted: isScopeCompletedNow,
        });
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Progress synchronized successfully.',
      xpChange: xpChange,
      cardsCovered: userCompletedCardsInScope,
      totalCards: totalCardsInScope,
      totalCardsInTopic: totalCardsInScope,
      isTopicCompleted: isExpressFlatTrack ? false : (userCompletedCardsInScope === totalCardsInScope),
    });

  } catch (err) {
    console.error("Progress Error Sync Failure:", err.message);
    return res.status(500).json({ success: false, message: 'Server error processing analytics log' });
  }
};

// =========================================================================
// Shared helper: computes the same card/topic/module completion stats used
// by getUserProgress below — also reused by achievements.js's "Module
// Master" badge check, so both stay in sync off a single query path.
// =========================================================================
exports.getProgressStats = async (userId) => {
    const [cardRecords, topicRecords, moduleRecords] = await Promise.all([
      // 🎯 CURRENT-STATE query — archived (reset) cards must not still count
      // as "completed" toward dashboard/Learn/Progress-page checkmarks.
      UserCardProgress.find({ user_id: userId, isArchived: { $ne: true } }).lean(),
      UserTopicProgress.find({ user_id: userId }).lean(),
      UserModuleProgress.find({ user_id: userId }).lean()
    ]);

    if (!cardRecords || cardRecords.length === 0) {
      return {
        completedCardsCount: 0,
        completedTopicsCount: 0,
        completedModulesCount: 0,
        completedCardIds: [],
        correctCardIds: [],
        completedTopicIds: [],
        completedModuleIds: [],
        topicXpMap: {},
        moduleXpMap: {},
        moduleDatesMap: {}
      };
    }

    const completedCardIds = cardRecords.map(rec => rec.card_id.toString());

    // 🎯 ACCURACY FIX: completedCardIds is "attempted" (a UserCardProgress doc
    // exists the moment a card is first submitted, right or wrong) — it is
    // NOT "answered correctly". A module's completion % must not credit a
    // wrongly-answered quiz/code card as "done". correctCardIds filters to
    // rec.isCorrect === true; passive card types (knowledge/video/pdf/ppt)
    // are always recorded with isCorrect: true by the existing frontend call
    // sites, so this only ever excludes genuinely wrong quiz/code attempts.
    const correctCardIds = cardRecords
      .filter(rec => rec.isCorrect === true)
      .map(rec => rec.card_id.toString());

    const completedTopicIds = topicRecords
      .filter(rec => rec.isCompleted === true)
      .map(rec => rec.topic_id.toString());

    // 🎯 BUG FIX: this used to be derived ONLY from UserTopicProgress, so a
    // fully-finished EXPRESS_FLAT (flat-card, no topic hierarchy) module
    // could never appear as "completed" here — that model has no topic
    // records at all (see UserModuleProgress.js's own comment: it exists
    // specifically for EXPRESS_FLAT modules, which complete at the whole-
    // module level, not the topic level). Merge in module-level completions
    // from UserModuleProgress (already fetched above as `moduleRecords`).
    const completedModuleIds = [...new Set([
      ...topicRecords
        .filter(rec => rec.isCompleted === true)
        .map(rec => rec.module_id ? rec.module_id.toString() : ''),
      ...moduleRecords
        .filter(rec => rec.isCompleted === true)
        .map(rec => rec.module_id ? rec.module_id.toString() : ''),
    ])].filter(id => id !== '');

    const topicXpMap = {};
    topicRecords.forEach(rec => {
      if (rec.topic_id) {
        topicXpMap[rec.topic_id.toString()] = rec.bestXP || 0;
      }
    });

    // 🎯 BUG FIX: this was never computed before, so EXPRESS_FLAT modules had
    // no resume value — the frontend's `userProgressInApp.moduleXpMap` check
    // (useQuizEngine.jsx) always fell through to 0 no matter how much XP a
    // learner had actually earned in that module previously.
    const moduleXpMap = {};
    moduleRecords.forEach(rec => {
      if (rec.module_id) {
        moduleXpMap[rec.module_id.toString()] = rec.bestXP || 0;
      }
    });

    // 🎯 Real (non-fabricated) per-module "date started" / "date finished" for
    // the Progress tab's activity table — derived from each card's own
    // createdAt rather than a separate tracked field, since none exists yet.
    // startedAt = earliest card attempt in that module; lastActivityAt = most
    // recent one, which doubles as "date finished" the moment the module
    // actually reaches 100% (the frontend gates on that, not this endpoint).
    const moduleDatesMap = {};
    cardRecords.forEach(rec => {
      if (!rec.module_id) return;
      const modId = rec.module_id.toString();
      const ts = rec.createdAt;
      if (!moduleDatesMap[modId]) {
        moduleDatesMap[modId] = { startedAt: ts, lastActivityAt: ts };
      } else {
        if (ts < moduleDatesMap[modId].startedAt) moduleDatesMap[modId].startedAt = ts;
        if (ts > moduleDatesMap[modId].lastActivityAt) moduleDatesMap[modId].lastActivityAt = ts;
      }
    });

    return {
      completedCardsCount: completedCardIds.length,
      completedTopicsCount: completedTopicIds.length,
      completedModulesCount: completedModuleIds.length,
      completedCardIds,
      correctCardIds,
      completedTopicIds,
      completedModuleIds,
      topicXpMap,
      moduleXpMap,
      moduleDatesMap
    };
};

// =========================================================================
// CONTROLLER 2: Fetch Computed Analytics for Frontend Hydration
// GET /api/progress
// =========================================================================
exports.getUserProgress = async (req, res) => {
  try {
    const contextUser = req.user && req.user.user ? req.user.user : req.user;
    const userId = contextUser ? (contextUser.id || contextUser._id) : null;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: User parsing failed.' });
    }

    const stats = await exports.getProgressStats(userId);
    return res.status(200).json({ success: true, ...stats });
  } catch (err) {
    console.error("Analytics Error Compilation Failure:", err.message);
    return res.status(500).json({ success: false, message: 'Server error failed to compile metrics' });
  }
};

// =========================================================================
// CONTROLLER 3: Admin — paginated list of all users with basic stats
// GET /api/progress/admin/users
// =========================================================================
exports.getAdminUsersList = async (req, res) => {
  try {
    // 🔒 DEPARTMENT SCOPING: Department Admins (role 'admin') must only ever see
    // users inside their own department — Super Admins bypass entirely.
    const isSuperAdmin = req.user.role === 'superadmin';
    const adminDept = req.user.department;
    if (!isSuperAdmin && !adminDept) {
      return res.status(400).json({ success: false, message: 'Admin profile missing department mapping.' });
    }

    const userQuery = { isVerified: true };
    if (!isSuperAdmin) userQuery.department = adminDept;

    // Fetch users without populate — department may contain legacy strings, not ObjectIds
    const users = await User.find(userQuery, 'username email xp role createdAt department').lean();

    // Validate ObjectId format before querying Department (avoids CastError on legacy string values)
    const isValidObjectId = (v) => v && /^[a-fA-F0-9]{24}$/.test(String(v));
    const validDeptIds = [...new Set(
      users.map(u => u.department).filter(isValidObjectId).map(String)
    )];

    const [depts, cardCounts, topicCounts] = await Promise.all([
      validDeptIds.length > 0
        ? Department.find({ _id: { $in: validDeptIds } }, 'name').lean()
        : Promise.resolve([]),
      UserCardProgress.aggregate([
        { $group: { _id: '$user_id', count: { $sum: 1 } } }
      ]),
      UserTopicProgress.aggregate([
        { $match: { isCompleted: true } },
        { $group: { _id: '$user_id', count: { $sum: 1 } } }
      ])
    ]);

    const deptMap = {};
    depts.forEach(d => { deptMap[d._id.toString()] = d.name; });
    const countMap = {};
    cardCounts.forEach(c => { countMap[c._id.toString()] = c.count; });
    const topicMap = {};
    topicCounts.forEach(c => { topicMap[c._id.toString()] = c.count; });

    const result = users.map(u => {
      const deptKey = isValidObjectId(u.department) ? String(u.department) : null;
      return {
        _id: u._id,
        username: u.username,
        email: u.email,
        xp: u.xp || 0,
        role: u.role,
        department: deptKey ? (deptMap[deptKey] || 'N/A') : 'N/A',
        joinedAt: u.createdAt,
        cardsCompleted: countMap[u._id.toString()] || 0,
        topicsCompleted: topicMap[u._id.toString()] || 0,
      };
    });

    result.sort((a, b) => b.xp - a.xp);
    return res.status(200).json({ success: true, users: result });
  } catch (err) {
    console.error('getAdminUsersList error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 4: User — get own detailed answers for a single sandbox card
// GET /api/progress/sandbox/:cardId
// =========================================================================
exports.getSandboxDetail = async (req, res) => {
  try {
    const contextUser = req.user && req.user.user ? req.user.user : req.user;
    const userId = contextUser ? (contextUser.id || contextUser._id) : null;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    const { cardId } = req.params;

    const [card, progress] = await Promise.all([
      Card.findById(cardId).lean(),
      // 🎯 CURRENT-STATE query — after a reset, only the fresh (non-archived)
      // attempt should ever be returned to the learner as "my results."
      UserCardProgress.findOne({ user_id: userId, card_id: cardId, isArchived: { $ne: true } }).lean()
    ]);

    if (!card) return res.status(404).json({ success: false, message: 'Card not found.' });
    if (!progress) return res.status(200).json({ success: true, attempted: false });

    const rawLogs = progress.metaFeedbackLogs;
    const questions = Array.isArray(rawLogs) ? rawLogs : (rawLogs?.questions || []);
    const percentage = progress.maxScore > 0
      ? Math.round((progress.score / progress.maxScore) * 100)
      : null;

    return res.status(200).json({
      success: true,
      attempted: true,
      card: { _id: card._id, title: card.content?.title, type: card.card_type },
      attempt: {
        score: progress.score,
        maxScore: progress.maxScore,
        percentage,
        timesAttempted: progress.timesAttempted,
        lastAttempted: progress.updatedAt,
        questions,
        adminScore:    rawLogs?.adminScore    ?? null,
        adminFeedback: rawLogs?.adminFeedback || '',
        adminGradedAt: rawLogs?.adminGradedAt || null,
      }
    });
  } catch (err) {
    console.error('getSandboxDetail error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// =========================================================================
// CONTROLLER 4: Admin — all users' answers for a single sandbox card
// GET /api/progress/admin/sandbox/:cardId
// =========================================================================
exports.getAdminSandboxResults = async (req, res) => {
  try {
    const { cardId } = req.params;

    // 🔒 DEPARTMENT SCOPING: filtering by USER department (not by which module/
    // card authored it) matches the product rule — a Department Admin only ever
    // sees people who belong to their department, even on Global-visibility
    // modules shared across departments. Super Admins bypass entirely.
    const isSuperAdmin = req.user.role === 'superadmin';
    const adminDept = req.user.department;
    if (!isSuperAdmin && !adminDept) {
      return res.status(400).json({ success: false, message: 'Admin profile missing department mapping.' });
    }

    const card = await Card.findById(cardId).lean();
    if (!card) return res.status(404).json({ success: false, message: 'Card not found.' });
    if (card.card_type !== 'html_sandbox') {
      return res.status(400).json({ success: false, message: 'This endpoint is only for html_sandbox cards.' });
    }

    const allProgressRaw = await UserCardProgress.find({ card_id: cardId }).lean();

    const userIds = allProgressRaw.map(p => p.user_id);
    const userQuery = { _id: { $in: userIds } };
    if (!isSuperAdmin) userQuery.department = adminDept;
    const users = await User.find(userQuery, 'username email department').lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id.toString()] = u; });

    // Drop any submission whose user didn't resolve above (i.e. outside this
    // admin's department) — keeps both the results list and the aggregate
    // stats below scoped to exactly the cohort this admin is allowed to see.
    const allProgress = allProgressRaw.filter(p => userMap[p.user_id.toString()]);

    // Build per-question accuracy stats across all submissions
    const questionAccMap = {};

    const results = allProgress.map(p => {
      const user = userMap[p.user_id.toString()] || {};
      const rawLogs = p.metaFeedbackLogs;
      const questions = Array.isArray(rawLogs) ? rawLogs : (rawLogs?.questions || []);
      const percentage = p.maxScore > 0 ? Math.round((p.score / p.maxScore) * 100) : null;

      questions.forEach(q => {
        if (!q.id) return;
        if (!questionAccMap[q.id]) {
          questionAccMap[q.id] = { questionText: q.questionText, correct: 0, incorrect: 0 };
        }
        q.isCorrect ? questionAccMap[q.id].correct++ : questionAccMap[q.id].incorrect++;
      });

      return {
        user: { _id: user._id, username: user.username, email: user.email },
        score: p.score,
        maxScore: p.maxScore,
        percentage,
        timesAttempted: p.timesAttempted,
        lastAttempted: p.updatedAt,
        questions,
        adminScore: rawLogs?.adminScore ?? null,
        adminFeedback: rawLogs?.adminFeedback ?? ''
      };
    });

    // Aggregate stats
    const totalSubmissions = results.length;
    const avgScore = totalSubmissions > 0
      ? Math.round((results.reduce((s, r) => s + (r.score || 0), 0) / totalSubmissions) * 10) / 10
      : 0;
    const avgPercentage = totalSubmissions > 0
      ? Math.round(results.filter(r => r.percentage !== null).reduce((s, r) => s + r.percentage, 0) / totalSubmissions)
      : 0;

    const questionAnalysis = Object.entries(questionAccMap).map(([id, data]) => ({
      questionId: id,
      questionText: data.questionText,
      correctCount: data.correct,
      incorrectCount: data.incorrect,
      totalAnswered: data.correct + data.incorrect,
      accuracy: data.correct + data.incorrect > 0
        ? Math.round((data.correct / (data.correct + data.incorrect)) * 100)
        : 0
    }));

    return res.status(200).json({
      success: true,
      card: { _id: card._id, title: card.content?.title },
      stats: { totalSubmissions, avgScore, avgPercentage, questionAnalysis },
      results
    });
  } catch (err) {
    console.error('getAdminSandboxResults error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// =========================================================================
// CONTROLLER 5: Admin — full analytics for a specific user
// GET /api/progress/admin/user/:userId
// =========================================================================
exports.getAdminUserAnalytics = async (req, res) => {
  try {
    const { userId } = req.params;

    const [user, cardRecords, topicRecords] = await Promise.all([
      User.findById(userId, 'username email xp department team role createdAt').lean(),
      UserCardProgress.find({ user_id: userId }).lean(),
      UserTopicProgress.find({ user_id: userId }).lean()
    ]);

    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // 🔒 DEPARTMENT SCOPING: a Department Admin may only pull analytics for a
    // user inside their own department. Super Admins bypass entirely.
    if (req.user.role !== 'superadmin') {
      const adminDept = req.user.department;
      if (!adminDept || !user.department || user.department.toString() !== adminDept.toString()) {
        console.warn(`SECURITY: Admin ${req.user.id} attempted to read analytics for user ${userId} outside their department.`);
        return res.status(403).json({ success: false, message: 'Forbidden: this user is outside your department.' });
      }
    }

    // Pull card details for type info
    const cardIds = cardRecords.map(r => r.card_id);
    const cards = await Card.find({ _id: { $in: cardIds } }, 'card_type content.title').lean();
    const cardMap = {};
    cards.forEach(c => { cardMap[c._id.toString()] = c; });

    // Separate sandbox cards for deep analysis
    const sandboxRecords = cardRecords.filter(r => {
      const c = cardMap[r.card_id.toString()];
      return c && c.card_type === 'html_sandbox';
    });

    const quizRecords = cardRecords.filter(r => {
      const c = cardMap[r.card_id.toString()];
      return c && (c.card_type === 'quiz' || c.card_type === 'code');
    });

    // Quiz accuracy
    const quizCorrect = quizRecords.filter(r => r.isCorrect).length;
    const quizAccuracy = quizRecords.length > 0
      ? Math.round((quizCorrect / quizRecords.length) * 100)
      : null;

    // Sandbox summary
    // 🎯 BUG FIX: `score`/`maxScore` are the raw fields the sandbox HTML's own
    // JS posts as a single combined number across MCQ + descriptive questions
    // — that raw pair is unreliable (this is the "40/5" bug: maxScore ends up
    // being a question COUNT in some sandbox modules, not a true points sum).
    // adminScore/adminFeedback were also missing entirely here (present on
    // the sibling admin/sandbox and admin/user/:id/sandbox-answers endpoints
    // but not this one) — without them the frontend has no way to know the
    // manually-graded descriptive score at all. Both are now included so the
    // frontend can recompute an accurate total from questions[] instead of
    // trusting the raw score/maxScore pair.
    const sandboxSummary = sandboxRecords.map(r => {
      const c = cardMap[r.card_id.toString()];
      const percentage = r.maxScore > 0 ? Math.round((r.score / r.maxScore) * 100) : null;
      const rawLogs = r.metaFeedbackLogs;
      const questions = Array.isArray(rawLogs) ? rawLogs : (rawLogs?.questions || []);
      return {
        cardId: r.card_id,
        cardTitle: c?.content?.title || 'Untitled',
        score: r.score,
        maxScore: r.maxScore,
        percentage,
        timesAttempted: r.timesAttempted,
        lastAttempted: r.updatedAt,
        questions,
        adminScore: rawLogs?.adminScore ?? null,
        adminFeedback: rawLogs?.adminFeedback || ''
      };
    });

    const completedTopicIds = topicRecords.filter(r => r.isCompleted).map(r => r.topic_id.toString());
    const completedModuleIds = [...new Set(
      topicRecords.filter(r => r.isCompleted).map(r => r.module_id?.toString()).filter(Boolean)
    )];

    return res.status(200).json({
      success: true,
      user: {
        _id: user._id,
        username: user.username,
        email: user.email,
        xp: user.xp,
        joinedAt: user.createdAt
      },
      overview: {
        totalCardsCompleted: cardRecords.length,
        totalTopicsCompleted: completedTopicIds.length,
        totalModulesCompleted: completedModuleIds.length,
        quizCardsAttempted: quizRecords.length,
        quizCorrect,
        quizAccuracy,
        sandboxCardsAttempted: sandboxRecords.length
      },
      sandboxResults: sandboxSummary,
      topicProgress: topicRecords.map(r => ({
        topicId: r.topic_id,
        moduleId: r.module_id,
        isCompleted: r.isCompleted,
        bestXP: r.bestXP
      }))
    });
  } catch (err) {
    console.error('getAdminUserAnalytics error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// =========================================================================
// CONTROLLER 7: Platform-wide stats — XP totals, activity over time, card type breakdown
// GET /api/progress/admin/platform-stats
// =========================================================================
exports.getAdminPlatformStats = async (req, res) => {
  try {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const [totalXpResult, userGrowth, cardActivity, cardTypeBreakdown, xpBuckets] = await Promise.all([
      User.aggregate([{ $match: { isVerified: true } }, { $group: { _id: null, total: { $sum: '$xp' }, avg: { $avg: '$xp' }, max: { $max: '$xp' } } }]),

      User.aggregate([
        { $match: { isVerified: true, createdAt: { $gte: twoWeeksAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),

      UserCardProgress.aggregate([
        { $match: { createdAt: { $gte: twoWeeksAgo } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
      ]),

      UserCardProgress.aggregate([
        { $lookup: { from: 'cards', localField: 'card_id', foreignField: '_id', as: 'c' } },
        { $unwind: { path: '$c', preserveNullAndEmptyArrays: true } },
        { $group: { _id: { $ifNull: ['$c.card_type', 'unknown'] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),

      User.aggregate([
        { $match: { isVerified: true } },
        { $addFields: { xpSafe: { $ifNull: ['$xp', 0] } } },
        { $bucket: { groupBy: '$xpSafe', boundaries: [0, 25, 75, 150, 300, 600], default: '600+', output: { count: { $sum: 1 } } } }
      ])
    ]);

    const xpStats = totalXpResult[0] || { total: 0, avg: 0, max: 0 };
    const labelMap = { 0: '0-24 XP', 25: '25-74 XP', 75: '75-149 XP', 150: '150-299 XP', 300: '300-599 XP', '600+': '600+ XP' };

    return res.status(200).json({
      success: true,
      xpStats: { total: xpStats.total, avg: Math.round(xpStats.avg || 0), max: xpStats.max || 0 },
      userGrowth: userGrowth.map(d => ({ date: d._id, count: d.count })),
      cardActivity: cardActivity.map(d => ({ date: d._id, count: d.count })),
      cardTypeBreakdown: cardTypeBreakdown.map(d => ({ type: d._id, count: d.count })),
      xpDistribution: xpBuckets.map(d => ({ label: labelMap[d._id] || String(d._id), count: d.count }))
    });
  } catch (err) {
    console.error('getAdminPlatformStats error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 8: Per-module engagement — users started, completion counts, sandbox avg
// GET /api/progress/admin/module-engagement
// =========================================================================
exports.getAdminModuleEngagement = async (req, res) => {
  try {
    const modules = await Module.find({}, 'title').lean();

    const stats = await Promise.all(modules.map(async (mod) => {
      const [uniqueUsersResult, totalCompletions, sandboxStats] = await Promise.all([
        // Use aggregate instead of distinct (distinct not allowed in API Version 1)
        UserCardProgress.aggregate([
          { $match: { module_id: mod._id } },
          { $group: { _id: '$user_id' } },
          { $count: 'total' }
        ]),
        UserCardProgress.countDocuments({ module_id: mod._id }),
        UserCardProgress.aggregate([
          { $match: { module_id: mod._id, maxScore: { $gt: 0 } } },
          { $group: { _id: null, avgPct: { $avg: { $multiply: [{ $divide: ['$score', '$maxScore'] }, 100] } }, count: { $sum: 1 } } }
        ])
      ]);
      return {
        moduleId: mod._id,
        title: mod.title,
        usersStarted: uniqueUsersResult[0]?.total || 0,
        totalCompletions,
        sandboxAvgPct: sandboxStats[0] ? Math.round(sandboxStats[0].avgPct) : null
      };
    }));

    stats.sort((a, b) => b.usersStarted - a.usersStarted);
    return res.status(200).json({ success: true, modules: stats });
  } catch (err) {
    console.error('getAdminModuleEngagement error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 9A: Admin — all sandbox answers for a specific user across all cards
// GET /api/progress/admin/user/:userId/sandbox-answers
// =========================================================================
exports.getUserSandboxAnswersForAdmin = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId, 'username email department').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // 🔒 DEPARTMENT SCOPING: a Department Admin may only pull answers for a
    // user inside their own department. Super Admins bypass entirely.
    if (req.user.role !== 'superadmin') {
      const adminDept = req.user.department;
      if (!adminDept || !user.department || user.department.toString() !== adminDept.toString()) {
        console.warn(`SECURITY: Admin ${req.user.id} attempted to read sandbox answers for user ${userId} outside their department.`);
        return res.status(403).json({ success: false, message: 'Forbidden: this user is outside your department.' });
      }
    }

    const progressRecords = await UserCardProgress.find({ user_id: userId }).lean();
    const cardIds = progressRecords.map(r => r.card_id);
    const cards = await Card.find({ _id: { $in: cardIds } }, 'card_type content.title').lean();
    const cardMap = {};
    cards.forEach(c => { cardMap[c._id.toString()] = c; });

    const sandboxResults = progressRecords
      .filter(r => {
        const c = cardMap[r.card_id.toString()];
        return c && c.card_type === 'html_sandbox';
      })
      .map(r => {
        const c = cardMap[r.card_id.toString()];
        const rawLogs = r.metaFeedbackLogs;
        const questions = Array.isArray(rawLogs) ? rawLogs : (rawLogs?.questions || []);
        const percentage = r.maxScore > 0 ? Math.round((r.score / r.maxScore) * 100) : null;
        return {
          cardId: r.card_id,
          cardTitle: c?.content?.title || 'Untitled',
          score: r.score,
          maxScore: r.maxScore,
          percentage,
          timesAttempted: r.timesAttempted,
          lastAttempted: r.updatedAt,
          questions,
          adminScore: rawLogs?.adminScore ?? null,
          adminFeedback: rawLogs?.adminFeedback ?? '',
          moduleTitle: rawLogs?.moduleTitle || c?.content?.title || 'Untitled',
        };
      });

    return res.status(200).json({
      success: true,
      user: { _id: user._id, username: user.username, email: user.email },
      sandboxResults,
    });
  } catch (err) {
    console.error('getUserSandboxAnswersForAdmin error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// SHARED HELPER: apply a manual admin grade to one user's card submission —
// updates metaFeedbackLogs, adjusts User.xp by the delta vs the previous
// admin score, and fires a notification + xp_award socket event on positive
// awards. Used by both importGrades (bulk XLSX) and gradeSingleSubmission
// (single slider/entry UI) so the XP-delta + notification cascade only lives
// in one place.
// =========================================================================
async function applyAdminGrade({ userId, cardId, assignedScore, adminFeedback, moduleTitle }) {
  if (!userId || !cardId || assignedScore === undefined || assignedScore === null) {
    return { userId, cardId, status: 'invalid' };
  }

  const score = Number(assignedScore);
  if (isNaN(score)) return { userId, cardId, status: 'invalid' };

  // 🎯 CURRENT-STATE query — grade the live (non-archived) submission only;
  // a stale, reset-archived doc must never be resurrected/mutated by grading.
  const progress = await UserCardProgress.findOne({ user_id: userId, card_id: cardId, isArchived: { $ne: true } });
  if (!progress) return { userId, cardId, status: 'not_found' };

  // Delta is against the PREVIOUS admin score — makes re-grading/re-upload idempotent
  const oldAdminScore = Number(progress.metaFeedbackLogs?.adminScore ?? 0);
  const xpDelta = Math.round(score) - Math.round(oldAdminScore);

  // Store admin grading inside metaFeedbackLogs without touching the questions array
  await UserCardProgress.findOneAndUpdate(
    { user_id: userId, card_id: cardId, isArchived: { $ne: true } },
    {
      $set: {
        'metaFeedbackLogs.adminScore':    Math.round(score),
        'metaFeedbackLogs.adminFeedback': adminFeedback || '',
        'metaFeedbackLogs.adminGradedAt': new Date(),
        'metaFeedbackLogs.moduleTitle':   moduleTitle || '',
      },
      // 🎯 Keep xpAwarded in lockstep with every XP delta ever applied to
      // this doc, admin-graded or not — this is exactly what a future
      // module reset sums up to compute its clawback amount.
      $inc: { xpAwarded: xpDelta },
    }
  );

  if (xpDelta !== 0) {
    await User.findByIdAndUpdate(userId, { $inc: { xp: xpDelta } });
  }

  // Create a persistent notification + fire real-time socket event for positive awards
  if (xpDelta > 0) {
    const cardTitle = moduleTitle || 'your sandbox submission';
    const notifMsg  = `⚡ You've been awarded ${xpDelta} XP by your Admin for "${cardTitle}"!`;

    const notification = await UserNotification.create({
      user_id:    userId,
      type:       'xp_award',
      message:    notifMsg,
      xpAwarded:  xpDelta,
      moduleTitle: cardTitle,
      cardId,
    });

    const strUid = userId.toString();
    if (global.activeUserSockets && global.activeUserSockets.has(strUid)) {
      global.activeUserSockets.get(strUid).forEach(socketId => {
        global.io.to(socketId).emit('xp_award', {
          notificationId: notification._id,
          message:        notification.message,
          xpAwarded:      xpDelta,
          moduleTitle:    cardTitle,
        });
      });
    }
  }

  return { userId, cardId, score: Math.round(score), xpDelta, status: 'updated' };
}

// =========================================================================
// CONTROLLER 9B: Admin — import graded scores, update UserCardProgress + user XP
// POST /api/progress/admin/import-grades
// Body: { grades: [{ userId, cardId, assignedScore, adminFeedback?, moduleTitle? }] }
// =========================================================================
exports.importGrades = async (req, res) => {
  try {
    const { grades } = req.body;
    if (!Array.isArray(grades) || grades.length === 0) {
      return res.status(400).json({ success: false, message: 'No grade records provided.' });
    }

    // 🔒 DEPARTMENT SCOPING (write path): a Department Admin's bulk import
    // must never be able to award/adjust XP for a user outside their own
    // department, even if their uploaded workbook contains foreign rows
    // (e.g. an old export, a copy-pasted sheet, or a deliberate tamper
    // attempt). Resolve every target user's department up front and only
    // grade the ones that resolve inside this admin's own department —
    // Super Admins bypass this check entirely.
    const isSuperAdmin = req.user.role === 'superadmin';
    let allowedUserIds = null;

    if (!isSuperAdmin) {
      const adminDept = req.user.department ? req.user.department.toString() : null;
      if (!adminDept) {
        return res.status(400).json({ success: false, message: 'Admin profile missing department mapping.' });
      }
      const targetUserIds = [...new Set(grades.map(g => g.userId).filter(Boolean).map(String))];
      const targetUsers = await User.find({ _id: { $in: targetUserIds } }, 'department').lean();
      allowedUserIds = new Set(
        targetUsers
          .filter(u => u.department && u.department.toString() === adminDept)
          .map(u => u._id.toString())
      );
    }

    const results = [];
    for (const grade of grades) {
      if (!isSuperAdmin && !allowedUserIds.has(String(grade.userId))) {
        console.warn(`SECURITY: Admin ${req.user.id} attempted to bulk-grade user ${grade.userId} outside their department.`);
        results.push({ userId: grade.userId, cardId: grade.cardId, status: 'forbidden' });
        continue;
      }
      const result = await applyAdminGrade(grade);
      results.push(result);
    }

    return res.status(200).json({ success: true, results });
  } catch (err) {
    console.error('importGrades error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 9C: Admin — grade a single user's sandbox submission (slider/entry UI)
// PUT /api/progress/admin/card/:cardId/user/:userId/grade
// Body: { assignedScore, adminFeedback?, moduleTitle? }
// =========================================================================
exports.gradeSingleSubmission = async (req, res) => {
  try {
    const { cardId, userId } = req.params;
    const { assignedScore, adminFeedback, moduleTitle } = req.body;

    // 🔒 DEPARTMENT SCOPING (write path): block a Department Admin from
    // awarding/adjusting XP for a user outside their own department by
    // simply editing the :userId in the request. Super Admins bypass.
    if (req.user.role !== 'superadmin') {
      const adminDept = req.user.department ? req.user.department.toString() : null;
      const targetUser = await User.findById(userId, 'department').lean();
      if (!adminDept || !targetUser?.department || targetUser.department.toString() !== adminDept) {
        console.warn(`SECURITY: Admin ${req.user.id} attempted to grade user ${userId} outside their department.`);
        return res.status(403).json({ success: false, message: 'Forbidden: this user is outside your department.' });
      }
    }

    const result = await applyAdminGrade({ userId, cardId, assignedScore, adminFeedback, moduleTitle });

    if (result.status === 'invalid') {
      return res.status(400).json({ success: false, message: 'assignedScore is required and must be a number.' });
    }
    if (result.status === 'not_found') {
      return res.status(404).json({ success: false, message: 'No submission found for this user/card.' });
    }

    return res.status(200).json({ success: true, result });
  } catch (err) {
    console.error('gradeSingleSubmission error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 9D: Admin — CSV export of all submissions for an html_sandbox module
// GET /api/modules/:id/submissions
// Columns: User ID | Name | Objective Score | Text Question ID | Raw Written Text Response | Assigned Points Manually
// =========================================================================
exports.exportModuleSubmissionsCsv = async (req, res) => {
  try {
    const { buildCsv } = require('../utils/csvBuilder');
    const moduleId = req.params.id;

    // 🔒 DEPARTMENT SCOPING: the CSV export must inherit the identical
    // per-user department restriction as the on-screen results — otherwise a
    // Department Admin could pull a full cross-department data dump just by
    // downloading instead of viewing. Super Admins bypass entirely.
    const isSuperAdmin = req.user.role === 'superadmin';
    const adminDept = req.user.department;
    if (!isSuperAdmin && !adminDept) {
      return res.status(400).json({ success: false, message: 'Admin profile missing department mapping.' });
    }

    const card = await Card.findOne({ module_id: moduleId, card_type: 'html_sandbox' }).lean();
    if (!card) return res.status(404).json({ success: false, message: 'No html_sandbox card found for this module.' });

    const submissionsRaw = await UserCardProgress.find({ card_id: card._id }).lean();
    const userIds = submissionsRaw.map(s => s.user_id);
    const userQuery = { _id: { $in: userIds } };
    if (!isSuperAdmin) userQuery.department = adminDept;
    const users = await User.find(userQuery, 'username email').lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id.toString()] = u; });

    // Only export rows for users that resolved above (i.e. inside this
    // admin's department).
    const submissions = submissionsRaw.filter(s => userMap[s.user_id.toString()]);

    // 🎯 Card ID + Module ID are included so a downloaded, admin-edited copy
    // of this CSV can be re-uploaded via importModuleGradesCsv and matched
    // back to the exact submission it came from — the export previously had
    // no way to identify which card/module a row belonged to, so it could
    // never round-trip back into a real grade update.
    const headers = ['User ID', 'Name', 'Module ID', 'Card ID', 'Objective Score', 'Text Question ID', 'Raw Written Text Response', 'Assigned Points Manually'];
    const rows = [];

    submissions.forEach(sub => {
      const user = userMap[sub.user_id.toString()];
      const userName = user?.username || user?.email || 'Unknown User';
      const objectiveScore = sub.score ?? 0;
      const assignedManually = sub.metaFeedbackLogs?.adminScore ?? '';

      const rawLogs = sub.metaFeedbackLogs;
      const questions = Array.isArray(rawLogs) ? rawLogs : (rawLogs?.questions || []);
      const textQuestions = questions.filter(q => q.type === 'text' || q.type === 'code');

      if (textQuestions.length === 0) {
        rows.push([sub.user_id.toString(), userName, moduleId, card._id.toString(), objectiveScore, '', '', assignedManually]);
      } else {
        textQuestions.forEach(q => {
          rows.push([sub.user_id.toString(), userName, moduleId, card._id.toString(), objectiveScore, q.id || '', q.userAnswer || '', assignedManually]);
        });
      }
    });

    const csv = buildCsv(headers, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="module_${moduleId}_submissions.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('exportModuleSubmissionsCsv error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 9E: Admin — CSV import of a single module's graded submissions
// POST /api/progress/admin/module/:moduleId/import-grades-csv
// Body: multipart file field "file" — the CSV downloaded from
// exportModuleSubmissionsCsv, edited to fill in "Assigned Points Manually".
// =========================================================================
exports.importModuleGradesCsv = async (req, res) => {
  try {
    const { parseCsv } = require('../utils/csvBuilder');
    const { moduleId } = req.params;

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, message: 'No CSV file uploaded.' });
    }

    const rows = parseCsv(req.file.buffer.toString('utf-8'));
    if (rows.length === 0) {
      return res.status(400).json({ success: false, message: 'CSV is empty or could not be parsed.' });
    }

    // 🔒 DEPARTMENT SCOPING (write path): identical guard to importGrades —
    // resolve every target user's department up front so a Department
    // Admin's upload can never grade/award XP for a user outside their own
    // department, even if the CSV contains foreign rows.
    const isSuperAdmin = req.user.role === 'superadmin';
    let allowedUserIds = null;
    if (!isSuperAdmin) {
      const adminDept = req.user.department ? req.user.department.toString() : null;
      if (!adminDept) {
        return res.status(400).json({ success: false, message: 'Admin profile missing department mapping.' });
      }
      const targetUserIds = [...new Set(rows.map(r => r['User ID']).filter(Boolean).map(String))];
      const targetUsers = await User.find({ _id: { $in: targetUserIds } }, 'department').lean();
      allowedUserIds = new Set(
        targetUsers.filter(u => u.department && u.department.toString() === adminDept).map(u => u._id.toString())
      );
    }

    const moduleDoc = await Module.findById(moduleId, 'title').lean();

    // Group by (User ID, Card ID) — "Assigned Points Manually" is ONE total
    // per submission, repeated on every one of that submission's question
    // rows (see exportModuleSubmissionsCsv), so the last non-blank value
    // wins rather than being summed (summing would multiply the score by
    // however many question-rows that submission happened to span).
    const graded = {};
    rows.forEach(row => {
      const rawScore = row['Assigned Points Manually'];
      if (!row['User ID'] || !row['Card ID'] || rawScore === '' || rawScore === undefined) return;
      const score = Number(rawScore);
      if (isNaN(score)) return;
      const key = `${row['User ID']}::${row['Card ID']}`;
      graded[key] = { userId: String(row['User ID']), cardId: String(row['Card ID']), assignedScore: score, moduleTitle: moduleDoc?.title || '' };
    });

    const grades = Object.values(graded);
    if (grades.length === 0) {
      return res.status(400).json({ success: false, message: "No valid rows found. Fill in 'Assigned Points Manually' and try again." });
    }

    const results = [];
    for (const grade of grades) {
      if (!isSuperAdmin && !allowedUserIds.has(grade.userId)) {
        console.warn(`SECURITY: Admin ${req.user.id} attempted to bulk-grade user ${grade.userId} outside their department.`);
        results.push({ userId: grade.userId, cardId: grade.cardId, status: 'forbidden' });
        continue;
      }
      results.push(await applyAdminGrade(grade));
    }

    return res.status(200).json({ success: true, moduleId, results });
  } catch (err) {
    console.error('importModuleGradesCsv error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 9: Department-level analytics — XP totals, avg XP, completions, top earner
// GET /api/progress/admin/department-stats
// =========================================================================
exports.getAdminDepartmentStats = async (req, res) => {
  try {
    // 🔒 DEPARTMENT SCOPING: a Department Admin should only ever see their
    // own department's aggregate row, not every department's totals/top
    // earner. Super Admins bypass entirely to keep the platform-wide view.
    const isSuperAdmin = req.user.role === 'superadmin';
    const deptQuery = {};
    if (!isSuperAdmin) {
      const adminDept = req.user.department;
      if (!adminDept) {
        return res.status(400).json({ success: false, message: 'Admin profile missing department mapping.' });
      }
      deptQuery._id = adminDept;
    }

    const departments = await Department.find(deptQuery).lean();

    const stats = await Promise.all(departments.map(async (dept) => {
      const users = await User.find({ department: dept._id, isVerified: true }, '_id xp username').lean();
      const userIds = users.map(u => u._id);
      const totalXp = users.reduce((s, u) => s + (u.xp || 0), 0);
      const avgXp = users.length > 0 ? Math.round(totalXp / users.length) : 0;
      const topEarner = [...users].sort((a, b) => (b.xp || 0) - (a.xp || 0))[0];

      const [cardsCompleted, topicsCompleted] = userIds.length > 0 ? await Promise.all([
        UserCardProgress.countDocuments({ user_id: { $in: userIds } }),
        UserTopicProgress.countDocuments({ user_id: { $in: userIds }, isCompleted: true })
      ]) : [0, 0];

      return {
        deptId: dept._id,
        name: dept.name,
        code: dept.code,
        userCount: users.length,
        totalXp,
        avgXp,
        cardsCompleted,
        topicsCompleted,
        topEarner: topEarner ? { username: topEarner.username, xp: topEarner.xp || 0 } : null
      };
    }));

    stats.sort((a, b) => b.totalXp - a.totalXp);
    return res.status(200).json({ success: true, departments: stats });
  } catch (err) {
    console.error('getAdminDepartmentStats error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 10: Admin — all sandbox answers for every user in admin's dept
// GET /api/progress/admin/dept-sandbox-answers
// =========================================================================
exports.getDeptSandboxAnswers = async (req, res) => {
  try {
    const adminDept = req.user?.department;
    const isValidId = (v) => v && /^[a-fA-F0-9]{24}$/.test(String(v));

    if (!isValidId(adminDept)) {
      return res.status(200).json({ success: true, department: 'Unknown', users: [] });
    }

    const [deptDoc, deptUsers] = await Promise.all([
      Department.findById(adminDept, 'name').lean(),
      User.find({ department: adminDept, isVerified: true }, 'username email xp').lean(),
    ]);

    if (deptUsers.length === 0) {
      return res.status(200).json({ success: true, department: deptDoc?.name || 'N/A', users: [] });
    }

    const userIds = deptUsers.map(u => u._id);

    // Fetch all progress records for these users, then join card metadata
    const allProgress = await UserCardProgress.find({ user_id: { $in: userIds } }).lean();
    const cardIds     = [...new Set(allProgress.map(p => p.card_id.toString()))];
    const cards       = await Card.find({ _id: { $in: cardIds }, card_type: 'html_sandbox' }, 'card_type content.title module_id').lean();
    const cardMap     = {};
    cards.forEach(c => { cardMap[c._id.toString()] = c; });

    const moduleIds = [...new Set(cards.map(c => c.module_id?.toString()).filter(Boolean))];
    const modules   = await Module.find({ _id: { $in: moduleIds } }, 'title').lean();
    const moduleMap = {};
    modules.forEach(m => { moduleMap[m._id.toString()] = m.title; });

    // Build per-user sandbox result bucket
    const userBucket = {};
    deptUsers.forEach(u => {
      userBucket[u._id.toString()] = { _id: u._id, username: u.username, email: u.email, xp: u.xp || 0, sandboxResults: [] };
    });

    allProgress.forEach(p => {
      const card = cardMap[p.card_id.toString()];
      if (!card) return;
      const uid = p.user_id.toString();
      if (!userBucket[uid]) return;

      const rawLogs   = p.metaFeedbackLogs;
      const questions = Array.isArray(rawLogs) ? rawLogs : (rawLogs?.questions || []);
      const moduleTitle = moduleMap[card.module_id?.toString()] || card.content?.title || '';

      userBucket[uid].sandboxResults.push({
        cardId:       p.card_id,
        cardTitle:    card.content?.title || 'Untitled',
        moduleTitle,
        score:        p.score,
        maxScore:     p.maxScore,
        adminScore:   rawLogs?.adminScore    ?? null,
        adminFeedback:rawLogs?.adminFeedback || '',
        questions,
        timesAttempted: p.timesAttempted,
        lastAttempted:  p.updatedAt,
      });
    });

    const users = Object.values(userBucket).filter(u => u.sandboxResults.length > 0);

    return res.status(200).json({ success: true, department: deptDoc?.name || 'N/A', users });
  } catch (err) {
    console.error('getDeptSandboxAnswers error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// Shared helper: computes the same sandbox-results list used by
// getMySandboxResults below — also reused by achievements.js's "Sharp
// Shooter" badge check.
// =========================================================================
exports.getSandboxResultsForUser = async (userId) => {
    // 🎯 CURRENT-STATE query — a reset sandbox result shouldn't reappear in
    // the learner's own "my results" list until they redo it.
    const progressRecords = await UserCardProgress.find({ user_id: userId, isArchived: { $ne: true } }).lean();
    const cardIds = progressRecords.map(r => r.card_id);

    const cards = await Card.find({ _id: { $in: cardIds }, card_type: 'html_sandbox' }, 'card_type content.title module_id').lean();
    const cardMap = {};
    cards.forEach(c => { cardMap[c._id.toString()] = c; });

    const moduleIds = [...new Set(cards.map(c => c.module_id?.toString()).filter(Boolean))];
    const modules   = await Module.find({ _id: { $in: moduleIds } }, 'title').lean();
    const moduleMap = {};
    modules.forEach(m => { moduleMap[m._id.toString()] = m.title; });

    const sandboxResults = progressRecords
      .filter(r => cardMap[r.card_id.toString()])
      .map(r => {
        const card      = cardMap[r.card_id.toString()];
        const rawLogs   = r.metaFeedbackLogs;
        const questions = Array.isArray(rawLogs) ? rawLogs : (rawLogs?.questions || []);
        const percentage = r.maxScore > 0 ? Math.round((r.score / r.maxScore) * 100) : null;
        return {
          cardId:        r.card_id,
          cardTitle:     card.content?.title || 'Untitled',
          moduleTitle:   moduleMap[card.module_id?.toString()] || 'N/A',
          score:         r.score,
          maxScore:      r.maxScore,
          percentage,
          adminScore:    rawLogs?.adminScore    ?? null,
          adminFeedback: rawLogs?.adminFeedback || '',
          adminGradedAt: rawLogs?.adminGradedAt || null,
          questions,
          timesAttempted: r.timesAttempted,
          lastAttempted:  r.updatedAt,
        };
      });

    return sandboxResults;
};

// =========================================================================
// CONTROLLER 11: User-facing — all of the logged-in user's sandbox results
// GET /api/progress/my-sandbox-results
// =========================================================================
exports.getMySandboxResults = async (req, res) => {
  try {
    const contextUser = req.user && req.user.user ? req.user.user : req.user;
    const userId = contextUser ? (contextUser.id || contextUser._id) : null;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    const sandboxResults = await exports.getSandboxResultsForUser(userId);
    return res.status(200).json({ success: true, sandboxResults });
  } catch (err) {
    console.error('getMySandboxResults error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 12: Record a daily engagement action; apply the 2/3 streak rule
// POST /api/progress/streak/verify
// Body: { actionType: 'daily_read' | 'module_progress' | 'idea_submission' }
// =========================================================================
exports.verifyDailyStreak = async (req, res) => {
  try {
    const contextUser = req.user && req.user.user ? req.user.user : req.user;
    const userId = contextUser ? (contextUser.id || contextUser._id) : null;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    const { actionType, localDate } = req.body;
    const VALID_ACTIONS = ['daily_read', 'module_progress', 'idea_submission'];
    if (!VALID_ACTIONS.includes(actionType)) {
      return res.status(400).json({ success: false, message: `Invalid actionType. Must be one of: ${VALID_ACTIONS.join(', ')}.` });
    }

    // The client's own local "YYYY-MM-DD" (falls back to the server's UTC
    // date for any caller that hasn't been updated to send one) — using the
    // server's UTC date unconditionally here used to make "today" resolve
    // to the wrong calendar date for hours at a time for any user not at
    // UTC+0, see utils/localDate.js.
    const today = resolveClientToday(localDate);

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    // Locate or create today's engagement entry
    let todayIdx = user.engagementHistory.findIndex(e => e.date === today);
    if (todayIdx === -1) {
      user.engagementHistory.push({ date: today, qualifiesForStreak: false, actions: [] });
      todayIdx = user.engagementHistory.length - 1;
    }
    const todayEntry = user.engagementHistory[todayIdx];

    // Deduplicate — only record each action type once per day
    if (!todayEntry.actions.includes(actionType)) {
      todayEntry.actions.push(actionType);
    }

    const wasAlreadyQualified = todayEntry.qualifiesForStreak;
    const qualifiesNow        = todayEntry.actions.length >= 1; // any 1 of 3 daily actions = streak day
    todayEntry.qualifiesForStreak = qualifiesNow;

    const previousStreak = user.currentStreak || 0;
    let pointsAwarded = 0;

    // Only mutate streak counters (and pay out points) at the exact moment
    // the threshold is first crossed for today.
    const streakIncremented = qualifiesNow && !wasAlreadyQualified;
    if (streakIncremented) {
      const yesterdayStr = shiftDateKey(today, -1);

      const streakContinues = user.lastActiveDate === yesterdayStr || user.lastActiveDate === today;
      user.currentStreak = streakContinues ? (user.currentStreak || 0) + 1 : 1;

      if (user.currentStreak > (user.longestStreak || 0)) {
        user.longestStreak = user.currentStreak;
      }
      user.lastActiveDate = today;

      pointsAwarded = POINTS_BY_ACTION[actionType] || 0;
      user.xp = (user.xp || 0) + pointsAwarded;
    }

    await user.save();

    return res.status(200).json({
      success:            true,
      actionType,
      todayActions:       todayEntry.actions,
      qualifiesForStreak: qualifiesNow,
      streakIncremented,
      previousStreak,
      currentStreak:      user.currentStreak,
      longestStreak:      user.longestStreak,
      lastActiveDate:     user.lastActiveDate,
      pointsAwarded,
      xp:                 user.xp,
    });
  } catch (err) {
    console.error('verifyDailyStreak error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 13: Get the authenticated user's streak data + engagement history
// GET /api/progress/streak
// =========================================================================
exports.getMyStreak = async (req, res) => {
  try {
    const contextUser = req.user && req.user.user ? req.user.user : req.user;
    const userId = contextUser ? (contextUser.id || contextUser._id) : null;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    const user = await User.findById(userId, 'currentStreak longestStreak lastActiveDate engagementHistory');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    const today     = resolveClientToday(req.query.localDate);
    const yesterday = shiftDateKey(today, -1);

    // Auto-break: if the user missed a day (lastActiveDate is neither today nor yesterday), reset streak to 0
    const streakExpired = user.lastActiveDate && user.lastActiveDate !== today && user.lastActiveDate !== yesterday;
    if (streakExpired && user.currentStreak > 0) {
      user.currentStreak = 0;
      await user.save();
    }

    const todayEntry = (user.engagementHistory || []).find(e => e.date === today);

    const cutoff = shiftDateKey(today, -29);
    const recentHistory = (user.engagementHistory || [])
      .filter(e => e.date >= cutoff)
      .map(e => ({ date: e.date, qualified: e.qualifiesForStreak, actions: e.actions }));

    return res.status(200).json({
      success:            true,
      currentStreak:      user.currentStreak || 0,
      longestStreak:      user.longestStreak || 0,
      lastActiveDate:     user.lastActiveDate || null,
      todayActions:       todayEntry ? todayEntry.actions : [],
      qualifiesForStreak: todayEntry ? todayEntry.qualifiesForStreak : false,
      engagementHistory:  recentHistory,
    });
  } catch (err) {
    console.error('getMyStreak error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 14: Admin — unified per-user/per-module progress table
// GET /api/progress/admin/module-progress-table
// One row per (user, module) the user has actually touched. Standard
// modules report % complete + time spent; html_sandbox modules report a
// grading status so the frontend can conditionally show CSV actions.
// =========================================================================
exports.getAdminModuleProgressTable = async (req, res) => {
  try {
    // 🔒 DEPARTMENT SCOPING: identical pattern to getAdminUsersList — a
    // Department Admin only ever sees their own department's users/rows.
    const isSuperAdmin = req.user.role === 'superadmin';
    const adminDept = req.user.department;
    if (!isSuperAdmin && !adminDept) {
      return res.status(400).json({ success: false, message: 'Admin profile missing department mapping.' });
    }
    const userQuery = { isVerified: true };
    if (!isSuperAdmin) userQuery.department = adminDept;

    const users = await User.find(userQuery, 'username email').lean();
    if (users.length === 0) return res.status(200).json({ success: true, rows: [] });

    const userIds = users.map(u => u._id);
    const userMap = {};
    users.forEach(u => { userMap[u._id.toString()] = u; });

    const [modules, cardRecords, topicRecords, moduleRecords, allCards, allTopics] = await Promise.all([
      Module.find({}, 'title moduleType hasTopics').lean(),
      // 🎯 CURRENT-STATE query — this table computes a per-user completion
      // percentage (cardCountByKey below); including an archived doc
      // alongside its post-reset replacement would double-count that card
      // and could push percent past 100%.
      UserCardProgress.find({ user_id: { $in: userIds }, isArchived: { $ne: true } }).lean(),
      UserTopicProgress.find({ user_id: { $in: userIds } }).lean(),
      UserModuleProgress.find({ user_id: { $in: userIds } }).lean(),
      Card.find({}, 'module_id topic_id card_type').lean(),
      Topic.find({}, 'module_id').lean(),
    ]);

    const moduleMap = {};
    modules.forEach(m => { moduleMap[m._id.toString()] = m; });

    const topicToModule = {};
    allTopics.forEach(t => { topicToModule[t._id.toString()] = t.module_id ? t.module_id.toString() : null; });

    // Total card count per module (direct cards + cards nested under that module's topics)
    const moduleCardTotal = {};
    // One html_sandbox card per html_sandbox module (Module.js's own contract)
    const sandboxCardByModule = {};
    allCards.forEach(c => {
      const modId = c.module_id ? c.module_id.toString() : (c.topic_id ? topicToModule[c.topic_id.toString()] : null);
      if (modId) moduleCardTotal[modId] = (moduleCardTotal[modId] || 0) + 1;
      if (c.card_type === 'html_sandbox' && c.module_id) sandboxCardByModule[c.module_id.toString()] = c._id.toString();
    });

    // Total topic count per module (for STANDARD/hasTopics completion %)
    const moduleTopicTotal = {};
    allTopics.forEach(t => {
      if (!t.module_id) return;
      const modId = t.module_id.toString();
      moduleTopicTotal[modId] = (moduleTopicTotal[modId] || 0) + 1;
    });

    // Group card progress by (user, module) — completed-card counts + the
    // sandbox card's own submission record (for grading status)
    const cardCountByKey = {};
    const sandboxProgressByKey = {};
    cardRecords.forEach(r => {
      if (!r.module_id) return;
      const key = `${r.user_id.toString()}::${r.module_id.toString()}`;
      cardCountByKey[key] = (cardCountByKey[key] || 0) + 1;
      const sandboxCardId = sandboxCardByModule[r.module_id.toString()];
      if (sandboxCardId && r.card_id.toString() === sandboxCardId) sandboxProgressByKey[key] = r;
    });

    // Topic-level completion + time, aggregated up to (user, module)
    const topicAggByKey = {};
    topicRecords.forEach(r => {
      if (!r.module_id) return;
      const key = `${r.user_id.toString()}::${r.module_id.toString()}`;
      if (!topicAggByKey[key]) topicAggByKey[key] = { completedTopics: 0, timeSpentSeconds: 0 };
      if (r.isCompleted) topicAggByKey[key].completedTopics++;
      topicAggByKey[key].timeSpentSeconds += r.timeSpentSeconds || 0;
    });

    const moduleProgressByKey = {};
    moduleRecords.forEach(r => {
      if (!r.module_id) return;
      moduleProgressByKey[`${r.user_id.toString()}::${r.module_id.toString()}`] = r;
    });

    const rows = [];
    Object.keys(cardCountByKey).forEach(key => {
      const [userId, moduleId] = key.split('::');
      const user = userMap[userId];
      const mod = moduleMap[moduleId];
      if (!user || !mod) return;

      const base = {
        userId, username: user.username, email: user.email,
        moduleId, moduleTitle: mod.title, moduleType: mod.moduleType,
      };

      if (mod.moduleType === 'html_sandbox') {
        const sandboxProgress = sandboxProgressByKey[key];
        const rawLogs = sandboxProgress?.metaFeedbackLogs;
        const questions = Array.isArray(rawLogs) ? rawLogs : (rawLogs?.questions || []);
        const hasDescriptive = questions.some(q => q.type !== 'mcq' && q.type !== 'true_false');
        const adminScore = rawLogs?.adminScore;
        const status = (adminScore !== undefined && adminScore !== null)
          ? 'Evaluated'
          : (hasDescriptive ? 'Pending Evaluation' : 'Completed');

        rows.push({
          ...base,
          percent: sandboxProgress ? 100 : 0,
          status,
          timeSpentSeconds: moduleProgressByKey[key]?.timeSpentSeconds || 0,
          cardId: sandboxCardByModule[moduleId] || null,
          hasDescriptive,
        });
      } else if (mod.hasTopics) {
        const agg = topicAggByKey[key] || { completedTopics: 0, timeSpentSeconds: 0 };
        const totalTopics = moduleTopicTotal[moduleId] || 0;
        const percent = totalTopics > 0 ? Math.round((agg.completedTopics / totalTopics) * 100) : 0;

        rows.push({
          ...base,
          percent,
          status: (totalTopics > 0 && agg.completedTopics === totalTopics) ? 'Completed' : 'In Progress',
          timeSpentSeconds: agg.timeSpentSeconds,
        });
      } else {
        const modProgress = moduleProgressByKey[key];
        const completedCards = cardCountByKey[key] || 0;
        const totalCards = moduleCardTotal[moduleId] || completedCards;
        const percent = totalCards > 0 ? Math.round((completedCards / totalCards) * 100) : 0;

        rows.push({
          ...base,
          percent,
          status: modProgress?.isCompleted ? 'Completed' : 'In Progress',
          timeSpentSeconds: modProgress?.timeSpentSeconds || 0,
        });
      }
    });

    rows.sort((a, b) => a.username.localeCompare(b.username) || a.moduleTitle.localeCompare(b.moduleTitle));

    return res.status(200).json({ success: true, rows });
  } catch (err) {
    console.error('getAdminModuleProgressTable error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// =========================================================================
// CONTROLLER 15: Ordered per-card progress + submitted answers for one
// module/topic scope — powers Linear Locking (attempted → unlocks the next
// card) and Review Mode (isCorrect/selectedOption/userCodeAnswer rehydrate a
// revisited card read-only) on the frontend. This is the single hydration
// call useQuizEngine makes on mount, replacing the previously-broken
// `completedCardIds` reference that was never actually populated.
// GET /api/progress/module-scope-state?moduleId=&topicId=
// =========================================================================
exports.getModuleScopeState = async (req, res) => {
  try {
    const userId = req.user.id;
    const { moduleId, topicId } = req.query;

    if (!moduleId) {
      return res.status(400).json({ success: false, message: 'moduleId is required.' });
    }

    // Same string-heuristic branch used everywhere else in this file
    // (recordCardCompletion) — must stay in lockstep with it, not a
    // semantically-similar check against Module.hasTopics.
    const isExpressFlatTrack = !topicId || topicId === "undefined" || topicId.toString().trim() === "";

    const cardQuery = isExpressFlatTrack ? { module_id: moduleId } : { topic_id: topicId };
    const cards = await Card.find(cardQuery, 'card_type cardOrder').sort({ cardOrder: 1 }).lean();

    if (cards.length === 0) {
      return res.status(200).json({ success: true, cards: [] });
    }

    const cardIds = cards.map(c => c._id);
    const progressDocs = await UserCardProgress.find({
      user_id: userId,
      card_id: { $in: cardIds },
      isArchived: { $ne: true },
    }).lean();

    const progressMap = {};
    progressDocs.forEach(p => { progressMap[p.card_id.toString()] = p; });

    const cardsOut = cards.map(c => {
      const p = progressMap[c._id.toString()];
      return {
        cardId: c._id,
        cardType: c.card_type,
        attempted: !!p,
        isCorrect: p ? !!p.isCorrect : false,
        selectedOption: (p && p.selectedOption !== undefined) ? p.selectedOption : null,
        userCodeAnswer: p ? (p.userCodeAnswer || '') : '',
        score: p ? (p.score || 0) : 0,
        maxScore: p ? (p.maxScore || 0) : 0,
        metaFeedbackLogs: p ? (p.metaFeedbackLogs || {}) : {},
        timesAttempted: p ? (p.timesAttempted || 0) : 0,
      };
    });

    return res.status(200).json({ success: true, cards: cardsOut });
  } catch (err) {
    console.error('getModuleScopeState error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// =========================================================================
// CONTROLLER 16: Learner self-service — reset/reattempt a module (or, for a
// STANDARD/topic-hierarchy module, just the current topic) from a clean
// slate. Archives (never deletes) this user's UserCardProgress docs in
// scope, so admin analytics/grading history/CSV round-trips stay intact —
// claws back exactly the XP those docs ever contributed (summed from the
// persisted `xpAwarded` field, never recomputed — see UserCardProgress.js
// for why a recompute would be unsafe for html_sandbox/admin-graded cards).
// POST /api/progress/module-reset   Body: { moduleId, topicId? }
// =========================================================================
exports.resetModuleProgress = async (req, res) => {
  try {
    const userId = req.user.id;
    const { moduleId, topicId } = req.body;

    if (!moduleId) {
      return res.status(400).json({ success: false, message: 'moduleId is required.' });
    }

    const isExpressFlatTrack = !topicId || topicId === "undefined" || topicId.toString().trim() === "";

    const cardQuery = isExpressFlatTrack ? { module_id: moduleId } : { topic_id: topicId };
    const cardIds = (await Card.find(cardQuery, '_id').lean()).map(c => c._id);

    const scopeDocs = await UserCardProgress.find({
      user_id: userId,
      card_id: { $in: cardIds },
      isArchived: { $ne: true },
    }).lean();

    const xpClawedBack = scopeDocs.reduce((sum, d) => sum + (d.xpAwarded || 0), 0);

    if (scopeDocs.length > 0) {
      await UserCardProgress.updateMany(
        { _id: { $in: scopeDocs.map(d => d._id) } },
        { $set: { isArchived: true } }
      );
    }

    if (xpClawedBack !== 0) {
      // Clamp the floor at 0 defensively — a single module's clawback should
      // never be able to push a user's total XP negative.
      const user = await User.findById(userId, 'xp');
      const nextXp = Math.max(0, (user?.xp || 0) - xpClawedBack);
      await User.findByIdAndUpdate(userId, { $set: { xp: nextXp } });
    }

    if (isExpressFlatTrack) {
      await UserModuleProgress.findOneAndUpdate(
        { user_id: userId, module_id: moduleId },
        { isCompleted: false, pointsAwarded: false, bestXP: 0, $inc: { resetCount: 1 } },
        { upsert: true }
      );
    } else {
      // STANDARD modules have no whole-module completion record — only the
      // current topic's UserTopicProgress doc is in scope for this reset.
      await UserTopicProgress.findOneAndUpdate(
        { user_id: userId, topic_id: topicId },
        { module_id: moduleId, isCompleted: false, pointsAwarded: false, bestXP: 0, $inc: { resetCount: 1 } },
        { upsert: true }
      );
    }

    await ModuleResetLog.create({
      user_id: userId,
      module_id: moduleId,
      topic_id: isExpressFlatTrack ? null : topicId,
      xpClawedBack,
      cardsAffected: scopeDocs.length,
    });

    // Live-update channel — reuses the exact activeUserSockets/io.to(socketId)
    // pattern already established for recordCardCompletion's own emit, so
    // any other open tab on this module refreshes to the clean-slate state.
    const strUidForProgress = userId.toString();
    if (global.activeUserSockets?.has(strUidForProgress)) {
      global.activeUserSockets.get(strUidForProgress).forEach(socketId => {
        global.io.to(socketId).emit('module_progress_update', {
          moduleId,
          cardsCovered: 0,
          totalCards: cardIds.length,
          isCompleted: false,
        });
      });
    }

    return res.status(200).json({ success: true, xpClawedBack, cardsAffected: scopeDocs.length });
  } catch (err) {
    console.error('resetModuleProgress error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error.' });
  }
};