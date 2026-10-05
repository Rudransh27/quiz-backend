#!/usr/bin/env node
// scripts/migrate-answer-keys.js
//
// Backfills Card.answerKey for every quiz / code / html_sandbox card from its
// existing content. Idempotent: a card whose stored key already equals the
// freshly derived one is left alone, so re-running is a no-op.
//
// DRY RUN BY DEFAULT — prints what it would do and writes nothing.
//   node scripts/migrate-answer-keys.js                 # dry run (local .env MONGO_URI)
//   node scripts/migrate-answer-keys.js --apply         # write keys
//   node scripts/migrate-answer-keys.js --uri <uri>     # different database
// A non-localhost database additionally requires --allow-remote.
//
// Only `answerKey` is ever written (raw driver $set, bypassing the model
// hooks); card `content` is never modified. html_sandbox cards whose key
// can't be extracted are reported and left without a key — the module
// keeps working, but grading answers it with a clear "no answer key" error
// until an admin fixes and re-saves the HTML.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const { buildAnswerKey, GRADED_TYPES } = require('../src/services/grading/answerKey');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const APPLY = flag('--apply');
const uri = opt('--uri') || process.env.MONGO_URI;

const deepStable = (v) => JSON.stringify(v, (k, val) => (val && typeof val === 'object' && !Array.isArray(val)
  ? Object.keys(val).sort().reduce((o, key) => { o[key] = val[key]; return o; }, {})
  : val));

async function main() {
  if (!uri) throw new Error('No MONGO_URI (set it in .env or pass --uri).');
  const isLocal = /^mongodb(\+srv)?:\/\/([^@]*@)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri);
  if (!isLocal && !flag('--allow-remote')) {
    throw new Error(`Refusing to touch a non-local database (${uri.replace(/\/\/[^@]*@/, '//***@')}) without --allow-remote.`);
  }

  await mongoose.connect(uri);
  const cards = mongoose.connection.collection('cards');
  const modules = mongoose.connection.collection('modules');
  const topics = mongoose.connection.collection('topics');

  const docs = await cards.find({ card_type: { $in: [...GRADED_TYPES] } }).toArray();
  const counts = { total: docs.length, unchanged: 0, written: 0, wouldWrite: 0, failed: 0 };
  const failures = [];

  for (const card of docs) {
    const built = buildAnswerKey(card.card_type, card.content);
    if (!built.ok || !built.answerKey) {
      counts.failed++;
      let moduleId = card.module_id;
      if (!moduleId && card.topic_id) moduleId = (await topics.findOne({ _id: card.topic_id }, { projection: { module_id: 1 } }))?.module_id;
      const mod = moduleId ? await modules.findOne({ _id: moduleId }, { projection: { title: 1 } }) : null;
      failures.push({ cardId: String(card._id), type: card.card_type, module: mod?.title || '?', error: built.error });
      continue;
    }
    if (card.answerKey && deepStable(card.answerKey) === deepStable(built.answerKey)) {
      counts.unchanged++;
      continue;
    }
    if (APPLY) {
      await cards.updateOne({ _id: card._id }, { $set: { answerKey: built.answerKey } });
      counts.written++;
    } else {
      counts.wouldWrite++;
    }
    if (card.card_type === 'html_sandbox') {
      console.log(`  ${APPLY ? 'wrote' : 'would write'} ${card._id} (html_sandbox): ${built.summary.label}`);
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN (nothing written — pass --apply to write)'}`);
  console.log(JSON.stringify(counts, null, 2));
  if (failures.length) {
    console.log('\nCards without an extractable key:');
    failures.forEach((f) => console.log(`  ✗ ${f.cardId} [${f.type}] "${f.module}": ${f.error}`));
  }
  await mongoose.disconnect();
  process.exitCode = failures.length ? 2 : 0;
}

main().catch(async (err) => {
  console.error('❌', err.message);
  try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
  process.exit(1);
});

