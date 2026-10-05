#!/usr/bin/env node
// scripts/report-sandbox-keys.js — READ-ONLY.
//
// Lists every html_sandbox card and whether server-side grading can extract
// an answer key from it. Intended to be run against PRODUCTION before the
// grading release goes live: anything marked ✗ must be fixed (and re-saved)
// by an admin, or it can't be graded.
//
//   node scripts/report-sandbox-keys.js                    # .env MONGO_URI
//   node scripts/report-sandbox-keys.js --uri <uri> [--csv out.csv]
//
// This script contains no write operations of any kind.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const { extractSandboxKey } = require('../src/services/grading/sandboxKey');
const { parseHtmlSandboxPoints } = require('../src/utils/pointsCalculator');

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const uri = opt('--uri') || process.env.MONGO_URI;
const csvPath = opt('--csv');

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  if (!uri) throw new Error('No MONGO_URI (set it in .env or pass --uri).');
  await mongoose.connect(uri, { readPreference: 'secondaryPreferred' });
  const db = mongoose.connection;
  const cards = await db.collection('cards').find({ card_type: 'html_sandbox' }).toArray();

  const rows = [];
  for (const card of cards) {
    let moduleId = card.module_id;
    if (!moduleId && card.topic_id) moduleId = (await db.collection('topics').findOne({ _id: card.topic_id }, { projection: { module_id: 1 } }))?.module_id;
    const mod = moduleId ? await db.collection('modules').findOne({ _id: moduleId }, { projection: { title: 1, moduleType: 1 } }) : null;
    const html = card.content?.htmlSource || card.content?.html || card.content?.text || '';
    const result = extractSandboxKey(html);
    const preview = parseHtmlSandboxPoints(html).total;
    rows.push({
      cardId: String(card._id),
      module: mod?.title || '?',
      moduleType: mod?.moduleType || '',
      extractable: result.ok,
      family: result.ok ? result.summary.family : '',
      detected: result.ok ? result.summary.label : '',
      gradingPoints: result.ok ? result.summary.maxPoints : '',
      previewPoints: preview,
      pointsAgree: result.ok ? result.summary.maxPoints === preview : '',
      storedKey: !!card.answerKey,
      error: result.ok ? '' : result.error,
    });
  }

  rows.forEach((r) => {
    console.log(`${r.extractable ? '✓' : '✗'} ${r.cardId}  "${r.module}"  ${r.extractable ? r.detected : r.error}${r.extractable && !r.pointsAgree ? `  ⚠ preview shows ${r.previewPoints} pts` : ''}${r.storedKey ? '' : '  (no stored key yet)'}`);
  });
  const bad = rows.filter((r) => !r.extractable).length;
  console.log(`\n${rows.length} html_sandbox card(s): ${rows.length - bad} gradable, ${bad} NOT gradable.`);

  if (csvPath) {
    const headers = Object.keys(rows[0] || { cardId: '' });
    fs.writeFileSync(csvPath, [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\n'));
    console.log(`CSV written to ${csvPath}`);
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err.message);
  try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
  process.exit(1);
});
