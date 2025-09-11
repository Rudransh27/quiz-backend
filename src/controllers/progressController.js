const Progress = require('../models/UserProgress');
const User = require('../models/User');

// @desc    Get user's progress
// @route   GET /api/v1/progress
// @access  Private
exports.getUserProgress = async (req, res, next) => {
  try {
    const progress = await Progress.findOne({ user: req.user.id })
      .populate('modules.moduleId')
      .populate('modules.topics.topicId');

    if (!progress) {
      const newProgress = await Progress.create({ user: req.user.id });
      return res.status(200).json({
        success: true,
        data: newProgress,
      });
    }

    res.status(200).json({
      success: true,
      data: progress,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// ❌ Old: Awarded XP per card
// ✅ New: Track card completion, award XP only when topic is completed
exports.cardCompleted = async (req, res, next) => {
  try {
    const { cardId, topicId, moduleId } = req.body;
    const userId = req.user.id;

    let userProgress = await Progress.findOne({ user: userId });

    if (!userProgress) {
      userProgress = await Progress.create({ user: userId });
    }

    // Find or create module
    let module = userProgress.modules.find(m => m.moduleId.toString() === moduleId);
    if (!module) {
      module = { moduleId, topics: [] };
      userProgress.modules.push(module);
    }

    // Find or create topic
    let topic = module.topics.find(t => t.topicId.toString() === topicId);
    if (!topic) {
      topic = { topicId, cardsCovered: [], bestXP: 0, isCompleted: false };
      module.topics.push(topic);
    }

    // Track card completion (no XP yet!)
    if (!topic.cardsCovered.includes(cardId)) {
      topic.cardsCovered.push(cardId);
    }

    await userProgress.save();

    res.status(200).json({
      success: true,
      message: 'Card marked as completed. XP not awarded yet.',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Mark topic completed and award XP
// @route   POST /api/v1/progress/topic-completed
// @access  Private
exports.topicCompleted = async (req, res, next) => {
  try {
    const { topicId, moduleId, earnedXP } = req.body; // earnedXP calculated from frontend test/quiz
    const userId = req.user.id;

    let userProgress = await Progress.findOne({ user: userId });
    if (!userProgress) {
      return res.status(404).json({ success: false, error: 'Progress not found' });
    }

    // Find module
    let module = userProgress.modules.find(m => m.moduleId.toString() === moduleId);
    if (!module) {
      return res.status(404).json({ success: false, error: 'Module not found in progress' });
    }

    // Find topic
    let topic = module.topics.find(t => t.topicId.toString() === topicId);
    if (!topic) {
      return res.status(404).json({ success: false, error: 'Topic not found in progress' });
    }

    let xpToAdd = 0;
    if (earnedXP > topic.bestXP) {
      xpToAdd = earnedXP - topic.bestXP;
      topic.bestXP = earnedXP;
      topic.isCompleted = true;
      topic.lastAttemptedAt = new Date();

      // Update user's global XP only with the difference
      await User.findByIdAndUpdate(userId, { $inc: { xp: xpToAdd } });
    }

    await userProgress.save();

    res.status(200).json({
      success: true,
      xpAdded: xpToAdd,
      newBestXP: topic.bestXP,
      message:
        xpToAdd > 0
          ? `Topic completed! XP updated (+${xpToAdd})`
          : 'Topic completed, but no new XP (not better than previous attempt).',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};
