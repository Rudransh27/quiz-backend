// src/validators/index.js — the complete server-side code-card validator set:
// the rules generated from the frontend's validators.js, plus the validators
// that only ever existed on the server.
module.exports = {
  ...require('./xbrlValidators'),
  ...require('./serverOnlyValidators'),
};
