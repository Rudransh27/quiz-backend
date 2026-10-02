#!/usr/bin/env node
// scripts/xp-reconciliation-report.js — READ-ONLY. Changes nothing.
//
// Per user, compares the XP recorded for cards (UserCardProgress.xpAwarded,
// i.e. what the old client-graded flow awarded) with what the SERVER graders
// would award for the answers actually stored (selectedOption /
// userCodeAnswer / sandbox metaFeedbackLogs + admin scores), and shows the
// rest of User.xp (streaks, daily login, ideas, history of reset cards) as
// "other". Use it to see how far client-side grading drifted before
// deciding whether any correction should be applied — this script applies
// none.
//
//   node scripts/xp-reconciliation-report.js [--uri <uri>] [--csv out.csv] [--only-diff]
//
// Caveats (printed with the report): the old flow stored only the LATEST
// answer, so a card answered wrong-then-right is regraded as right; the
// regrade is an estimate of "what the server would have awarded", not of
// what the first attempt was.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const { buildAnswerKey } = require('../src/services/grading/answerKey');
const { gradeQuiz, gradeCode, gradeSandboxQuestion } = require('../src/services/grading/graders');

const PASSIVE_XP = { knowledge: 2, pdf: 5, ppt: 5, pptx: 5, video: 10 };

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const uri = opt('--uri') || process.env.MONGO_URI;
const csvPath = opt('--csv');
const onlyDiff = args.includes('--only-diff');

const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function regradeCard(card, key, p) {
  if (PASSIVE_XP[card.card_type] !== undefined) return PASSIVE_XP[card.card_type];
  if (!key) return null;
  if (card.card_type === 'quiz') {
    if (p.selectedOption === null || p.selectedOption === undefined) return null;
    const g = gradeQuiz(key, { selectedOption: p.selectedOption });
    return g.ok ? g.points : null;
  }
  if (card.card_type === 'code') {
    if (!p.userCodeAnswer) return null;
    const g = gradeCode(key, { userCodeAnswer: p.userCodeAnswer });
    return g.ok ? g.points : null;
  }
  if (card.card_type === 'html_sandbox') {
    const logs = p.metaFeedbackLogs || {};
    const submitted = new Map((Array.isArray(logs) ? logs : (logs.questions || [])).map((q) => [q.id, q]));
    let pts = 0;
    for (const q of key.questions || []) {
      const s = submitted.get(q.id);
      if (s) pts += gradeSandboxQuestion(q, s.userAnswer).points;
    }
    return pts + Math.round(Number(logs.adminScore || 0));
  }
  return null;
}

async function main() {
  if (!uri) throw new Error('No MONGO_URI (set it in .env or pass --uri).');
  await mongoose.connect(uri, { readPreference: 'secondaryPreferred' });
  const db = mongoose.connection;

  const cards = await db.collection('cards').find({}).toArray();
  const cardMap = new Map(cards.map((c) => [String(c._id), c]));
  const keyMap = new Map(cards.map((c) => [String(c._id), c.answerKey || buildAnswerKey(c.card_type, c.content).answerKey || null]));

  const users = await db.collection('users').find({}, { projection: { username: 1, email: 1, xp: 1 } }).toArray();
  const progress = await db.collection('usercardprogresses').find({ isArchived: { $ne: true } }).toArray();
  const ledger = await db.collection('xptransactions').aggregate([{ $group: { _id: '$user_id', total: { $sum: '$amount' } } }]).toArray().catch(() => []);
  const ledgerByUser = new Map(ledger.map((l) => [String(l._id), l.total]));

  const byUser = new Map();
  for (const p of progress) {
    const uid = String(p.user_id);
    const card = cardMap.get(String(p.card_id));
    const row = byUser.get(uid) || { recordedCardXp: 0, regradedCardXp: 0, cards: 0, unregradable: 0, diffCards: [] };
    row.cards++;
    row.recordedCardXp += p.xpAwarded || 0;
    const regraded = card ? regradeCard(card, keyMap.get(String(p.card_id)), p) : null;
    if (regraded === null) {
      row.unregradable++;
      row.regradedCardXp += p.xpAwarded || 0; // can't regrade — assume as recorded
    } else {
      row.regradedCardXp += regraded;
      if (regraded !== (p.xpAwarded || 0)) row.diffCards.push(`${card.card_type}:${p.card_id}(${p.xpAwarded || 0}→${regraded})`);
    }
    byUser.set(uid, row);
  }

  const out = users.map((u) => {
    const r = byUser.get(String(u._id)) || { recordedCardXp: 0, regradedCardXp: 0, cards: 0, unregradable: 0, diffCards: [] };
    const recordedXp = u.xp || 0;
    return {
      userId: String(u._id),
      user: u.username || u.email,
      recordedXp,
      recordedCardXp: r.recordedCardXp,
      regradedCardXp: r.regradedCardXp,
      cardDelta: r.regradedCardXp - r.recordedCardXp,
      otherXp: recordedXp - r.recordedCardXp,
      ledgerNet: ledgerByUser.get(String(u._id)) || 0,
      activeCards: r.cards,
      unregradable: r.unregradable,
      differingCards: r.diffCards.join(' '),
    };
  }).filter((r) => !onlyDiff || r.cardDelta !== 0)
    .sort((a, b) => Math.abs(b.cardDelta) - Math.abs(a.cardDelta));

  console.log('user'.padEnd(28), 'xp'.padStart(6), 'cardXP'.padStart(7), 'regraded'.padStart(9), 'delta'.padStart(6), 'other'.padStart(6), 'ledger'.padStart(7));
  out.forEach((r) => console.log(
    String(r.user).slice(0, 27).padEnd(28), String(r.recordedXp).padStart(6), String(r.recordedCardXp).padStart(7),
    String(r.regradedCardXp).padStart(9), String(r.cardDelta).padStart(6), String(r.otherXp).padStart(6), String(r.ledgerNet).padStart(7)));
  const drifted = out.filter((r) => r.cardDelta !== 0);
  console.log(`\n${out.length} user(s) listed; ${drifted.length} with card XP that differs from a server regrade (net ${drifted.reduce((s, r) => s + r.cardDelta, 0)} XP).`);
  console.log('Notes: regrade uses the LATEST stored answer (the old flow kept no first-attempt history); "other" = streak/login/idea XP and XP from reset (archived) cards. Nothing was changed.');

  if (csvPath) {
    const headers = Object.keys(out[0] || { userId: '' });
    fs.writeFileSync(csvPath, [headers.join(','), ...out.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\n'));
    console.log(`CSV written to ${csvPath}`);
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err.message);
  try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
  process.exit(1);
});
