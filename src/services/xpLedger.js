// src/services/xpLedger.js
//
// The one way the grading service changes a user's XP:
//   1. insert an XpTransaction under a unique idempotencyKey;
//   2. only if that insert succeeded, apply the amount to User.xp.
// A duplicate-key error on step 1 means the award already happened, so the
// call is a no-op — repeated or concurrent submissions can't double-award.
//
// No multi-document transaction is used (the deployed mongo is standalone).
// If the process dies between steps 1 and 2 the ledger holds an entry
// User.xp doesn't reflect; scripts/xp-reconciliation-report.js surfaces it.
const mongoose = require('mongoose');
const XpTransaction = require('../models/XpTransaction');
const User = require('../models/User');

const isDuplicateKey = (err) => err && (err.code === 11000 || err.code === 11001);

async function awardXp({
  userId, amount, source, idempotencyKey,
  sourceId = null, cardId = null, moduleId = null, generation = null, questionId = null, meta,
}) {
  const value = Math.round(Number(amount) || 0);
  if (!value) return { awarded: false, amount: 0 };
  if (!idempotencyKey) throw new Error('awardXp requires an idempotencyKey');

  try {
    await XpTransaction.create({
      user_id: userId,
      amount: value,
      source,
      idempotencyKey,
      sourceId,
      card_id: cardId,
      module_id: moduleId,
      generation,
      questionId,
      meta,
    });
  } catch (err) {
    if (isDuplicateKey(err)) return { awarded: false, amount: 0, duplicate: true };
    throw err;
  }

  if (value > 0) {
    await User.updateOne({ _id: userId }, { $inc: { xp: value } });
  } else {
    // User.xp has min:0, which $inc doesn't enforce — clamp at 0 atomically.
    await User.updateOne(
      { _id: userId },
      [{ $set: { xp: { $max: [0, { $add: [{ $ifNull: ['$xp', 0] }, value] }] } } }],
    );
  }
  return { awarded: true, amount: value };
}

// Net XP the ledger holds for one (user, card, generation) — what a reset of
// that generation must reverse.
async function ledgerNetForCard(userId, cardId, generation) {
  const rows = await XpTransaction.aggregate([
    {
      $match: {
        user_id: new mongoose.Types.ObjectId(String(userId)),
        card_id: new mongoose.Types.ObjectId(String(cardId)),
        generation,
        source: { $ne: 'reset_clawback' },
      },
    },
    { $group: { _id: null, net: { $sum: '$amount' }, n: { $sum: 1 } } },
  ]);
  return { net: rows[0]?.net || 0, entries: rows[0]?.n || 0 };
}

function emitToUser(userId, event, payload) {
  const uid = String(userId);
  if (global.activeUserSockets?.has(uid) && global.io) {
    global.activeUserSockets.get(uid).forEach((socketId) => global.io.to(socketId).emit(event, payload));
  }
}

module.exports = { awardXp, ledgerNetForCard, emitToUser, isDuplicateKey };
