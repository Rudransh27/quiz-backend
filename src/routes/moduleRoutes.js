// routes/moduleRoutes.js
const express = require('express');
const router = express.Router();
const Module = require('../models/Module');
const Topic = require('../models/Topic');
const Card = require('../models/Card'); // Card model is not needed here

// All routes here should be prefixed with `/api/modules` from server.js

// GET /api/modules -> Get all modules
router.get('/', async (req, res) => {
  try {
    // Select only the fields needed for the module list view
    const modules = await Module.find({}, 'title description imageUrl department topicOrder');
    res.json(modules);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/modules/:id -> Get a single module
router.get('/:id', async (req, res) => {
  try {
    const module = await Module.findById(req.params.id).populate({
      path: 'topics',
      options: { sort: { 'topicOrder': 1 } },
      populate: {
        path: 'cards',
        options: { sort: { 'cardOrder': 1 } }
      }
    });
    if (!module) return res.status(404).json({ message: 'Module not found' });
    res.json(module);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/modules -> Create a new module
router.post('/', async (req, res) => {
  try {
    const newModule = new Module(req.body);
    const module = await newModule.save();
    res.status(201).json(module);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// PUT /api/modules/:id -> Update a module
router.put('/:id', async (req, res) => {
  try {
    const module = await Module.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!module) return res.status(404).json({ message: 'Module not found' });
    res.json(module);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// DELETE /api/modules/:id -> Delete a module
router.delete('/:id', async (req, res) => {
  try {
    const module = await Module.findById(req.params.id);
    if (!module) return res.status(404).json({ message: 'Module not found' });
    
    // Manually delete associated topics to ensure data integrity
    await Topic.deleteMany({ module_id: module._id });

    await module.deleteOne();
    res.json({ message: 'Module and all its content deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/modules/:moduleId/topics -> Create a new topic for a module
router.post('/:moduleId/topics', async (req, res) => {
  try {
    const newTopic = new Topic({ ...req.body, module_id: req.params.moduleId });
    const topic = await newTopic.save();
    
    // Link topic to module
    await Module.findByIdAndUpdate(req.params.moduleId, { $push: { topics: topic._id } });
    
    res.status(201).json(topic);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = router;