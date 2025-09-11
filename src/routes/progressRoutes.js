// src/routes/progress.js

const express = require('express');
const auth = require('../middleware/auth');
const UserProgress = require('../models/UserProgress');
const User = require('../models/User');
const Card = require('../models/Card');
const Topic = require('../models/Topic');

const router = express.Router();

// Helper function to calculate XP for a card
const calculateXp = (cardType, isCorrect) => {
    if (cardType === 'knowledge') {
        return 1;
    }
    if (cardType === 'quiz') {
        return isCorrect ? 5 : -2;
    }
    else if(cardType === 'code'){
        return isCorrect ? 10 : -2;
    }
    return 0;
};

// @route   POST /api/progress/card-completed
// @desc    Records a card as completed, awards XP, and handles topic completion
// @access  Private
router.post('/card-completed', auth, async (req, res) => {
    const { cardId, topicId, moduleId, isCorrect } = req.body;
    const userId = req.user.id;

    if (!cardId || !topicId || !moduleId) {
        return res.status(400).json({ message: 'Missing card, topic, or module ID.' });
    }

    try {
        // Find the card to get its type
        const card = await Card.findById(cardId);
        if (!card) {
            return res.status(404).json({ message: 'Card not found.' });
        }

        // Find or create user progress document in a single, atomic operation
        let userProgress = await UserProgress.findOne({ user: userId });
        if (!userProgress) {
            userProgress = new UserProgress({ user: userId, modules: [] });
        }

        let moduleProgress = userProgress.modules.find(m => m.moduleId.toString() === moduleId);
        if (!moduleProgress) {
            moduleProgress = { moduleId: moduleId, topics: [] };
            userProgress.modules.push(moduleProgress);
        }

        let topicProgress = moduleProgress.topics.find(t => t.topicId.toString() === topicId);
        if (!topicProgress) {
            topicProgress = { topicId: topicId, cardsCovered: [], isCompleted: false, xpEarned: 0 };
            moduleProgress.topics.push(topicProgress);
        }

        let xpChange = 0;
        let isTopicCompleted = topicProgress.isCompleted;

        // Ensure a card is only counted once
        if (!topicProgress.cardsCovered.includes(cardId)) {
            xpChange = calculateXp(card.card_type, isCorrect);
            topicProgress.cardsCovered.push(cardId);
            
            // Add XP to the topic's running total
            topicProgress.xpEarned = (topicProgress.xpEarned || 0) + xpChange;

            // Update the user's total XP directly on the User model
            await User.findByIdAndUpdate(userId, { $inc: { xp: xpChange } });
        }

        // Check if all cards in the topic are now covered
        const topic = await Topic.findById(topicId);
        const totalCardsInTopic = topic?.cards?.length || 0;
        
        if (!isTopicCompleted && topicProgress.cardsCovered.length >= totalCardsInTopic && totalCardsInTopic > 0) {
            topicProgress.isCompleted = true;
            isTopicCompleted = true;

            // --- Consolidated Logic: Find and unlock the next topic ---
            const moduleTopics = await Topic.find({ moduleId }).sort({ order: 1 });
            const currentTopicIndex = moduleTopics.findIndex(t => t._id.toString() === topicId);

            if (currentTopicIndex !== -1 && currentTopicIndex < moduleTopics.length - 1) {
                const nextTopicId = moduleTopics[currentTopicIndex + 1]._id;

                let nextTopicProgress = moduleProgress.topics.find(t => t.topicId.toString() === nextTopicId);
                if (!nextTopicProgress) {
                    nextTopicProgress = { topicId: nextTopicId, cardsCovered: [], isCompleted: false, xpEarned: 0 };
                    moduleProgress.topics.push(nextTopicProgress);
                }
            }
        }

        await userProgress.save();

        res.json({
            message: 'Progress updated successfully.',
            xpChange: xpChange,
            cardsCovered: topicProgress.cardsCovered.length,
            totalCardsInTopic,
            isTopicCompleted,
        });

    } catch (err) {
        console.error(err);
        if (err.name === 'VersionError') {
            return res.status(409).json({ message: 'Concurrency error. Please try again.' });
        }
        res.status(500).json({ message: 'Server error' });
    }
});

// @route   GET /api/progress
// @desc    Get all user progress data, including card completion status per topic
// @access  Private
router.get('/', auth, async (req, res) => {
    try {
        let progress = await UserProgress.findOne({ user: req.user.id });
        if (!progress) {
            progress = new UserProgress({ user: req.user.id, modules: [] });
            await progress.save();
        }
        res.json(progress);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});

// The separate /topic-completed route is no longer needed.
// Its logic has been merged into the /card-completed route.

module.exports = router;