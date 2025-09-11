module.exports = function(req, res, next) {
  // Assuming the user object is already populated by a previous authentication middleware
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Forbidden: Admin access required' });
  }
};