// src/middleware/admin.js
const mongoose = require('mongoose');

module.exports = function (req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Unauthorized: User context missing.' });
  }

  // LAYER 1: SUPER ADMIN BYPASS
  // Super Admins bypass departmental bounds completely
  if (req.user.role === 'superadmin') {
    return next();
  }

  // LAYER 2: DEPARTMENT / CONTENT AUTHOR ADMIN
  if (req.user.role === 'admin') {
    // Normalizes parameter intercept lookups from requests safely
    const targetDepartmentId = req.body.departmentId || req.body.department || req.params.departmentId || req.params.department;

    if (targetDepartmentId) {
      if (!req.user.department || req.user.department.toString() !== targetDepartmentId.toString()) {
        console.warn(`SECURITY BREACH: Department Admin ${req.user.id} tried to alter or access external department context: ${targetDepartmentId}`);
        return res.status(403).json({ 
          success: false, 
          message: 'Forbidden: You do not have permission to manage assets outside your own department grid.' 
        });
      }
    }

    return next();
  }

  // LAYER 3: BLOCKED STANDARD USERS
  return res.status(403).json({ 
    success: false, 
    message: 'Forbidden: Access restricted to authorized Department Admins or Super Admins only.' 
  });
};