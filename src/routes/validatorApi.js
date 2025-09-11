// server/routes/api.js
const express = require('express');
const router = express.Router();
const Module = require('../models/Module');

// Import all your validator functions
const validators = require('../validators/codeValidator');

// ... (Your existing GET, POST, PUT, DELETE routes for modules) ...

// New endpoint for code validation
router.post('/validate-code', (req, res) => {
  const { validatorName, userCode } = req.body;

  // Basic security check to ensure the validator exists and is a function
  if (!validatorName || typeof validators[validatorName] !== 'function') {
    return res.status(400).json({ isCorrect: false, error: "Invalid validator specified." });
  }

  try {
    const result = validators[validatorName](userCode);
    res.json(result);
  } catch (error) {
    console.error(`Validation failed for ${validatorName}:`, error);
    res.status(500).json({ isCorrect: false, error: "An unexpected server error occurred during validation." });
  }
});

module.exports = router;