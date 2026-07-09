// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

module.exports = async function (req, res, next) {
  const token = req.header('Authorization');

  if (!token) {
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  try {
    const cleanToken = token.replace('Bearer ', '');
    const decoded = jwt.verify(cleanToken, process.env.JWT_SECRET);
    
    const contextUser = decoded.user ? decoded.user : decoded;

    // Normalize user token context layer with safe Mongoose ObjectId cast wrappers
    req.user = {
      id: mongoose.Types.ObjectId.createFromHexString(contextUser.id),
      role: contextUser.role || 'user',
      username: contextUser.username,
      sessionId: contextUser.sessionId,
      department: contextUser.department 
        ? mongoose.Types.ObjectId.createFromHexString(contextUser.department) 
        : null,
      // 👥 NEW SCOPE: Cast team identifiers cleanly if assigned
      team: contextUser.team 
        ? mongoose.Types.ObjectId.createFromHexString(contextUser.team) 
        : null
    };

    // REDIS SINGLE LOGIN ENFORCEMENT CHECKER
    if (global.redisClient && global.redisClient.isOpen && global.redisClient.isReady && req.user.sessionId) {
      const activeValidSessionId = await global.redisClient.get(`session:${req.user.id.toString()}`);

      if (!activeValidSessionId || activeValidSessionId !== req.user.sessionId) {
        console.warn(`🚨 MULTI-LOGIN DETECTED: Revoking server access for User: ${req.user.id}`);
        return res.status(401).json({ 
          message: 'Security Alert: Your session has been terminated because this account logged in on another machine/browser.' 
        });
      }
      
      await global.redisClient.expire(`session:${req.user.id.toString()}`, 86400);
    }

    next();
  } catch (err) {
    console.error("❌ Auth Token Validation Failure:", err.message);
    res.status(401).json({ message: 'Token is not valid' });
  }
};