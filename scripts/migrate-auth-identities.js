#!/usr/bin/env node
// scripts/migrate-auth-identities.js
//
// Copies every existing Microsoft link (User.microsoftId) into AuthIdentity,
// the provider-neutral table that SSO sign-ins are matched on
// (services/auth/identity.js). Users, roles, progress and sessions are not
// touched, and User.microsoftId stays in place.
//
// Optional: the app already falls back to User.microsoftId and adds the
// AuthIdentity row on the user's next Microsoft sign-in, so this can run
// before or after the deploy (or never). Also reports any email used by
// more than one account, which a person should look at.
//
// DRY RUN BY DEFAULT.
//   node scripts/migrate-auth-identities.js            # show the plan, write nothing
//   node scripts/migrate-auth-identities.js --apply    # write the AuthIdentity rows
//   --uri <uri>  other database;  a non-localhost database also needs --allow-remote
// Idempotent: existing rows are left as they are.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const User = require('../src/models/User');
const AuthIdentity = require('../src/models/AuthIdentity');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = flag('--apply');
const uri = opt('--uri') || process.env.MONGO_URI;
const tenantId = process.env.MICROSOFT_TENANT_ID || '';

async function main() {
  if (!uri) throw new Error('No MONGO_URI (set it in .env or pass --uri).');
  const isLocal = /^mongodb(\+srv)?:\/\/([^@]*@)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri);
  if (!isLocal && !flag('--allow-remote')) {
    throw new Error('Refusing to touch a non-local database without --allow-remote.');
  }
  await mongoose.connect(uri, { serverApi: { version: '1', strict: true, deprecationErrors: true } });
  await AuthIdentity.init();

  const linked = await User.find({ microsoftId: { $exists: true, $nin: [null, ''] } }, 'email microsoftId').lean();
  const existing = await AuthIdentity.find({ provider: 'microsoft' }, 'subject tenantId user_id').lean();
  const have = new Set(existing.map((e) => `${e.tenantId}:${e.subject}`));
  const todo = linked.filter((u) => !have.has(`${tenantId}:${u.microsoftId}`));

  console.log(`Users with a Microsoft link: ${linked.length}`);
  console.log(`Already in AuthIdentity:     ${linked.length - todo.length}`);
  console.log(`To add:                      ${todo.length}${APPLY ? '' : '  (dry run — pass --apply to write)'}`);

  const dupes = await User.aggregate([
    { $group: { _id: { $toLower: '$email' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  if (dupes.length) console.log(`⚠️  Emails used by more than one account (review by hand): ${dupes.map((d) => d._id).join(', ')}`);

  if (APPLY && todo.length) {
    const res = await AuthIdentity.bulkWrite(todo.map((u) => ({
      updateOne: {
        filter: { provider: 'microsoft', tenantId, subject: u.microsoftId },
        update: { $setOnInsert: { user_id: u._id, emailAtLink: u.email, linkedAt: new Date() } },
        upsert: true,
      },
    })), { ordered: false });
    console.log(`Added: ${res.upsertedCount}`);
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('❌', err.message);
  try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
  process.exit(1);
});
