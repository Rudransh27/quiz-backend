// src/controllers/progressController.js
const UserCardProgress = require('../models/UserCardProgress');
const UserTopicProgress = require('../models/UserTopicProgress');
const UserModuleProgress = require('../models/UserModuleProgress');
const User = require('../models/User');
const Card = require('../models/Card');
const Module = require('../models/Module');
const Topic = require('../models/Topic');
const Department = require('../models/Department');
const UserNotification = require('../models/UserNotification');
const { computePointsReward } = require('../utils/pointsCalculator');

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
const calculateXp = (cardType, isCorrect) => {
  if (cardType === 'knowledge') return 2;
  if (cardType === 'pdf') return 5;
  if (cardType === 'ppt' || cardType === 'pptx') return 5;
  if (cardType === 'video') return 10;
  if (cardType === 'html_sandbox') return 15; // 🎯 Fixed baseline award weight for completing an interactive simulator task
  if (cardType === 'quiz') return isCorrect ? 5 : -2;
  if (cardType === 'code') return isCorrect ? 10 : -2;
  return 0;
};

// 🌐 HTML SANDBOX MODULE XP: score-proportional (vs the flat calculateXp() baseline used
// by html_sandbox cards embedded inside topic/express-flat modules). Only used when the
// card's parent Module has moduleType==='html_sandbox'.
const computeSandboxModuleXp = (card, answeredScore, totalPossibleWeight) => {
  const maxPoints = Number(card?.content?.maxPoints) || 15;
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
  const { cardId, topicId, moduleId, isCorrect, answeredScore, totalPossibleWeight, textResponses } = req.body;
  
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

    const parentModuleDoc = await Module.findById(moduleId, 'moduleType estimatedTime').lean();
    const isSandboxModuleType = card.card_type === 'html_sandbox' && parentModuleDoc?.moduleType === 'html_sandbox';

    const existingProgress = await UserCardProgress.findOne({ user_id: userId, card_id: cardId });
    const isFirstTime = !existingProgress;
    let xpChange = 0;

    if (isFirstTime) {
      xpChange = isSandboxModuleType
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
      $inc: { timesAttempted: 1 } 
    };

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

    await UserCardProgress.findOneAndUpdate(
      { user_id: userId, card_id: cardId },
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

    if (isExpressFlatTrack) {
      totalCardsInScope = await Card.countDocuments({ module_id: moduleId });
      userCompletedCardsInScope = await UserCardProgress.countDocuments({ user_id: userId, module_id: moduleId });

      const userModuleProgressList = await UserCardProgress.find({ user_id: userId, module_id: moduleId }).lean();
      const completedCardIds = userModuleProgressList.map(p => p.card_id);
      const targetCardsDetailsList = await Card.find({ _id: { $in: completedCardIds } }).lean();

      const cardMap = {};
      targetCardsDetailsList.forEach(c => {
        cardMap[c._id.toString()] = c;
      });

      for (const record of userModuleProgressList) {
        const cardMeta = cardMap[record.card_id.toString()];
        if (!cardMeta) continue;
        if (isSandboxModuleType && cardMeta.card_type === 'html_sandbox') {
          currentCalculatedScopeXP += computeSandboxModuleXp(cardMeta, record.score, record.maxScore);
        } else {
          currentCalculatedScopeXP += calculateXp(cardMeta.card_type, record.isCorrect);
        }
      }

      // 🏁 One-time module-completion pointsReward bonus (EXPRESS_FLAT only —
      // STANDARD modules get the equivalent bonus per-topic below instead).
      // Dedupe-guarded via UserModuleProgress.pointsAwarded so re-POSTing an
      // already-complete module never re-awards the bonus.
      const isModuleCompletedNow = (userCompletedCardsInScope === totalCardsInScope && totalCardsInScope > 0);
      const existingModuleProgress = await UserModuleProgress.findOne({ user_id: userId, module_id: moduleId });

      if (isModuleCompletedNow && !existingModuleProgress?.pointsAwarded) {
        const moduleBonus = computePointsReward(totalCardsInScope, parentModuleDoc?.estimatedTime);
        await User.findByIdAndUpdate(userId, { $inc: { xp: moduleBonus } });
      }

      await UserModuleProgress.findOneAndUpdate(
        { user_id: userId, module_id: moduleId },
        {
          isCompleted: isModuleCompletedNow,
          pointsAwarded: isModuleCompletedNow ? true : (existingModuleProgress?.pointsAwarded || false)
        },
        { upsert: true, new: true }
      );
    } else {
      totalCardsInScope = await Card.countDocuments({ topic_id: topicId });
      userCompletedCardsInScope = await UserCardProgress.countDocuments({ user_id: userId, topic_id: topicId });
      
      const isTopicCompletedNow = (userCompletedCardsInScope === totalCardsInScope && totalCardsInScope > 0);

      const userCardsProgressList = await UserCardProgress.find({ user_id: userId, topic_id: topicId }).lean();
      const completedCardIds = userCardsProgressList.map(p => p.card_id);
      const targetCardsDetailsList = await Card.find({ _id: { $in: completedCardIds } }).lean();
      
      const cardMap = {};
      targetCardsDetailsList.forEach(c => {
        cardMap[c._id.toString()] = c.card_type;
      });

      for (const record of userCardsProgressList) {
        const type = cardMap[record.card_id.toString()];
        if (type) {
          currentCalculatedScopeXP += calculateXp(type, record.isCorrect);
        }
      }

      // 🏁 One-time topic-completion pointsReward bonus — on top of the
      // per-card XP already summed above, awarded exactly once via the
      // pointsAwarded dedupe flag (fetched BEFORE the upsert below so we see
      // its prior state, not the value we're about to write).
      const existingTopicProgress = await UserTopicProgress.findOne({ user_id: userId, topic_id: topicId });

      if (isTopicCompletedNow && !existingTopicProgress?.pointsAwarded) {
        const topicDoc = await Topic.findById(topicId, 'estimatedTime').lean();
        const topicBonus = computePointsReward(totalCardsInScope, topicDoc?.estimatedTime);
        await User.findByIdAndUpdate(userId, { $inc: { xp: topicBonus } });
      }

      await UserTopicProgress.findOneAndUpdate(
        { user_id: userId, topic_id: topicId },
        {
          module_id: moduleId,
          isCompleted: isTopicCompletedNow,
          bestXP: currentCalculatedScopeXP,
          pointsAwarded: isTopicCompletedNow ? true : (existingTopicProgress?.pointsAwarded || false)
        },
        { upsert: true, new: true }
      );
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
// CONTROLLER 2: Fetch Computed Analytics for Frontend Hydration
// =========================================================================
exports.getUserProgress = async (req, res) => {
  try {
    const contextUser = req.user && req.user.user ? req.user.user : req.user;
    const userId = contextUser ? (contextUser.id || contextUser._id) : null;

    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized: User parsing failed.' });
    }

    const [cardRecords, topicRecords] = await Promise.all([
      UserCardProgress.find({ user_id: userId }).lean(),
      UserTopicProgress.find({ user_id: userId }).lean() 
    ]);

    if (!cardRecords || cardRecords.length === 0) {
      return res.status(200).json({
        success: true,
        completedCardsCount: 0,
        completedTopicsCount: 0,
        completedModulesCount: 0,
        completedCardIds: [],
        completedTopicIds: [],
        completedModuleIds: [],
        topicXpMap: {} 
      });
    }

    const completedCardIds = cardRecords.map(rec => rec.card_id.toString());
    
    const completedTopicIds = topicRecords
      .filter(rec => rec.isCompleted === true)
      .map(rec => rec.topic_id.toString());
      
    const completedModuleIds = [...new Set(
      topicRecords
        .filter(rec => rec.isCompleted === true)
        .map(rec => rec.module_id ? rec.module_id.toString() : '')
    )].filter(id => id !== '');

    const topicXpMap = {};
    topicRecords.forEach(rec => {
      if (rec.topic_id) {
        topicXpMap[rec.topic_id.toString()] = rec.bestXP || 0;
      }
    });

    return res.status(200).json({
      success: true,
      completedCardsCount: completedCardIds.length,
      completedTopicsCount: completedTopicIds.length,
      completedModulesCount: completedModuleIds.length,
      completedCardIds,   
      completedTopicIds,  
      completedModuleIds,
      topicXpMap          
    });

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
    // Fetch users without populate — department may contain legacy strings, not ObjectIds
    const users = await User.find({ isVerified: true }, 'username email xp role createdAt department').lean();

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
      UserCardProgress.findOne({ user_id: userId, card_id: cardId }).lean()
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

    const card = await Card.findById(cardId).lean();
    if (!card) return res.status(404).json({ success: false, message: 'Card not found.' });
    if (card.card_type !== 'html_sandbox') {
      return res.status(400).json({ success: false, message: 'This endpoint is only for html_sandbox cards.' });
    }

    const allProgress = await UserCardProgress.find({ card_id: cardId }).lean();

    const userIds = allProgress.map(p => p.user_id);
    const users = await User.find({ _id: { $in: userIds } }, 'username email department').lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id.toString()] = u; });

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
        questions
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

    const user = await User.findById(userId, 'username email').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

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

  const progress = await UserCardProgress.findOne({ user_id: userId, card_id: cardId });
  if (!progress) return { userId, cardId, status: 'not_found' };

  // Delta is against the PREVIOUS admin score — makes re-grading/re-upload idempotent
  const oldAdminScore = Number(progress.metaFeedbackLogs?.adminScore ?? 0);
  const xpDelta = Math.round(score) - Math.round(oldAdminScore);

  // Store admin grading inside metaFeedbackLogs without touching the questions array
  await UserCardProgress.findOneAndUpdate(
    { user_id: userId, card_id: cardId },
    {
      $set: {
        'metaFeedbackLogs.adminScore':    Math.round(score),
        'metaFeedbackLogs.adminFeedback': adminFeedback || '',
        'metaFeedbackLogs.adminGradedAt': new Date(),
        'metaFeedbackLogs.moduleTitle':   moduleTitle || '',
      },
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

    const results = [];
    for (const grade of grades) {
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

    const card = await Card.findOne({ module_id: moduleId, card_type: 'html_sandbox' }).lean();
    if (!card) return res.status(404).json({ success: false, message: 'No html_sandbox card found for this module.' });

    const submissions = await UserCardProgress.find({ card_id: card._id }).lean();
    const userIds = submissions.map(s => s.user_id);
    const users = await User.find({ _id: { $in: userIds } }, 'username email').lean();
    const userMap = {};
    users.forEach(u => { userMap[u._id.toString()] = u; });

    const headers = ['User ID', 'Name', 'Objective Score', 'Text Question ID', 'Raw Written Text Response', 'Assigned Points Manually'];
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
        rows.push([sub.user_id.toString(), userName, objectiveScore, '', '', assignedManually]);
      } else {
        textQuestions.forEach(q => {
          rows.push([sub.user_id.toString(), userName, objectiveScore, q.id || '', q.userAnswer || '', assignedManually]);
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
// CONTROLLER 9: Department-level analytics — XP totals, avg XP, completions, top earner
// GET /api/progress/admin/department-stats
// =========================================================================
exports.getAdminDepartmentStats = async (req, res) => {
  try {
    const departments = await Department.find().lean();

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
// CONTROLLER 11: User-facing — all of the logged-in user's sandbox results
// GET /api/progress/my-sandbox-results
// =========================================================================
exports.getMySandboxResults = async (req, res) => {
  try {
    const contextUser = req.user && req.user.user ? req.user.user : req.user;
    const userId = contextUser ? (contextUser.id || contextUser._id) : null;
    if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized.' });

    const progressRecords = await UserCardProgress.find({ user_id: userId }).lean();
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

    const { actionType } = req.body;
    const VALID_ACTIONS = ['daily_read', 'module_progress', 'idea_submission'];
    if (!VALID_ACTIONS.includes(actionType)) {
      return res.status(400).json({ success: false, message: `Invalid actionType. Must be one of: ${VALID_ACTIONS.join(', ')}.` });
    }

    // Use local date string "YYYY-MM-DD" — avoids timezone drift between server and client
    const today = new Date().toISOString().split('T')[0];

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

    // Only mutate streak counters at the exact moment the threshold is first crossed
    if (qualifiesNow && !wasAlreadyQualified) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().split('T')[0];

      const streakContinues = user.lastActiveDate === yesterdayStr || user.lastActiveDate === today;
      user.currentStreak = streakContinues ? (user.currentStreak || 0) + 1 : 1;

      if (user.currentStreak > (user.longestStreak || 0)) {
        user.longestStreak = user.currentStreak;
      }
      user.lastActiveDate = today;
    }

    await user.save();

    return res.status(200).json({
      success:            true,
      actionType,
      todayActions:       todayEntry.actions,
      qualifiesForStreak: qualifiesNow,
      currentStreak:      user.currentStreak,
      longestStreak:      user.longestStreak,
      lastActiveDate:     user.lastActiveDate,
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

    const today     = new Date().toISOString().split('T')[0];
    const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; })();

    // Auto-break: if the user missed a day (lastActiveDate is neither today nor yesterday), reset streak to 0
    const streakExpired = user.lastActiveDate && user.lastActiveDate !== today && user.lastActiveDate !== yesterday;
    if (streakExpired && user.currentStreak > 0) {
      user.currentStreak = 0;
      await user.save();
    }

    const todayEntry = (user.engagementHistory || []).find(e => e.date === today);

    const cutoff = (() => { const d = new Date(); d.setDate(d.getDate() - 29); return d.toISOString().split('T')[0]; })();
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