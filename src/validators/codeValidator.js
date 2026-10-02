// src/validators/codeValidator.js
//
// Kept as a stable require path. Every function in the old version of this
// file was assigned with `module.exports = function …`, so each assignment
// overwrote the last and only validateReferencePart1 was ever exported. The
// real, complete validator set now lives in ./xbrlValidators.js (generated
// from the frontend's original rules by scripts/sync-validators.js).
module.exports = require('./index');
