// routes/topicRoutes.js
const express = require('express');
const router = express.Router();
const Topic = require('../models/Topic');
const Card = require('../models/Card');
const Module = require('../models/Module');

// Topic CRUD Operations
// GET /api/topics/:id - Fetch a single topic by ID
router.get('/:id', async (req, res) => {
    try {
        const topic = await Topic.findById(req.params.id).populate({
            path: 'cards',
            options: { sort: { 'cardOrder': 1 } }
        });

        if (!topic) {
            return res.status(404).json({ message: 'Topic not found' });
        }
        res.json(topic);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const topic = await Topic.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!topic) return res.status(404).json({ message: 'Topic not found' });
        res.json(topic);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const topic = await Topic.findById(req.params.id);
        if (!topic) return res.status(404).json({ message: 'Topic not found' });
        await Module.findByIdAndUpdate(topic.module_id, { $pull: { topics: topic._id } });
        await Card.deleteMany({ topic_id: topic._id });
        await topic.deleteOne();
        res.json({ message: 'Topic and all its cards deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Card CRUD Operations
// NEW: GET /api/topics/cards/:id - Fetch a single card by ID
router.get('/cards/:id', async (req, res) => {
    try {
        const card = await Card.findById(req.params.id);
        if (!card) return res.status(404).json({ message: 'Card not found' });
        res.json(card);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// POST /api/topics/:topicId/cards - Create a new card
router.post('/:topicId/cards', async (req, res) => {
    try {
        const newCard = new Card({ ...req.body, topic_id: req.params.topicId });
        const card = await newCard.save();
        await Topic.findByIdAndUpdate(req.params.topicId, { $push: { cards: card._id } });
        res.status(201).json(card);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// PUT /api/topics/cards/:cardId - Update a card
router.put('/cards/:cardId', async (req, res) => {
    try {
        const card = await Card.findByIdAndUpdate(req.params.cardId, req.body, { new: true, runValidators: true });
        if (!card) return res.status(404).json({ message: 'Card not found' });
        res.json(card);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// DELETE /api/topics/cards/:cardId - Delete a card
router.delete('/cards/:cardId', async (req, res) => {
    try {
        const card = await Card.findById(req.params.cardId);
        if (!card) return res.status(404).json({ message: 'Card not found' });
        await Topic.findByIdAndUpdate(card.topic_id, { $pull: { cards: card._id } });
        await card.deleteOne();
        res.json({ message: 'Card deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;