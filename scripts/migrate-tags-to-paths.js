#!/usr/bin/env node
// scripts/migrate-tags-to-paths.js
//
// Creates Paths from the existing Tag → Region → journey setup so learners
// see exactly the modules they see today, in the same order:
//   • For each Tag, work out the module list each region sees (modules with
//     no regions are in every region's list), in Module.order.
//   • Regions that see the SAME list share ONE Path (audience = those
//     regions); the biggest group keeps the Tag's name, others are named
//     "<Tag> – <Region, Region>".
//   • A Tag with no region-specific modules gets one Path for everyone.
//   • If learners in other regions would still see some modules (the
//     "All regions" ones), they get a Path too.
// Paths are created PUBLISHED, with the Tag's sequentialUnlock setting and
// Pre/Post off. Progress is untouched (it's stored per module).
//
// DRY RUN BY DEFAULT.
//   node scripts/migrate-tags-to-paths.js            # show the plan, write nothing
//   node scripts/migrate-tags-to-paths.js --apply    # create the Paths
//   --uri <uri>  other database;  a non-localhost database also needs --allow-remote
// Idempotent: each Path carries a migrationKey; re-running skips existing ones.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const mongoose = require('mongoose');
const Category = require('../src/models/Category');
const Module = require('../src/models/Module');
const Region = require('../src/models/Region');
const Path = require('../src/models/Path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = flag('--apply');
const uri = opt('--uri') || process.env.MONGO_URI;

const ids = (arr) => (arr || []).map((x) => String(x && x._id ? x._id : x));

function planForCategory(category, modules, regionNames, allRegionIds) {
  if (!modules.length) return [];
  const used = [...new Set(modules.flatMap((m) => ids(m.regions)))];
  const base = { categoryId: category._id, sequentialUnlock: category.sequentialUnlock !== false };

  if (!used.length) {
    return [{ ...base, name: category.name, regionIds: [], moduleIds: modules.map((m) => m._id) }];
  }

  // Module list per region → group regions with identical lists.
  const listFor = (rid) => modules.filter((m) => !ids(m.regions).length || ids(m.regions).includes(rid));
  const groups = new Map();
  for (const rid of used) {
    const list = listFor(rid);
    const key = list.map((m) => String(m._id)).join(',');
    const g = groups.get(key) || { moduleIds: list.map((m) => m._id), regionIds: [] };
    g.regionIds.push(rid);
    groups.set(key, g);
  }
  // Everyone in a region with no region-specific modules here.
  const others = allRegionIds.filter((r) => !used.includes(r));
  const shared = modules.filter((m) => !ids(m.regions).length);
  if (others.length && shared.length) {
    const key = shared.map((m) => String(m._id)).join(',');
    const g = groups.get(key) || { moduleIds: shared.map((m) => m._id), regionIds: [] };
    g.regionIds.push(...others);
    groups.set(key, g);
  }

  const list = [...groups.values()].sort((a, b) => b.regionIds.length - a.regionIds.length || b.moduleIds.length - a.moduleIds.length);
  if (list.length === 1) {
    // One list for everybody who sees anything here: one Path, no region
    // restriction needed (module-level regions still filter what each
    // learner sees inside it).
    return [{ ...base, name: category.name, regionIds: [], moduleIds: list[0].moduleIds }];
  }
  return list.map((g, i) => ({
    ...base,
    name: i === 0 ? category.name : `${category.name} – ${g.regionIds.map((r) => regionNames.get(r) || r).join(', ')}`,
    regionIds: g.regionIds,
    moduleIds: g.moduleIds,
  }));
}

async function main() {
  if (!uri) throw new Error('No MONGO_URI (set it in .env or pass --uri).');
  const isLocal = /^mongodb(\+srv)?:\/\/([^@]*@)?(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri);
  if (!isLocal && !flag('--allow-remote')) {
    throw new Error('Refusing to touch a non-local database without --allow-remote.');
  }
  await mongoose.connect(uri);

  const [categories, regions] = await Promise.all([
    Category.find({}).sort({ order: 1, name: 1 }).lean(),
    Region.find({ isDefault: { $ne: true } }).lean(),
  ]);
  const regionNames = new Map(regions.map((r) => [String(r._id), r.name]));
  const allRegionIds = regions.map((r) => String(r._id));

  const counts = { tags: categories.length, planned: 0, created: 0, existing: 0 };
  for (const category of categories) {
    const modules = await Module.find({ categoryId: category._id }, 'title order regions').sort({ order: 1, _id: 1 }).lean();
    const plan = planForCategory(category, modules, regionNames, allRegionIds);
    if (!plan.length) continue;
    console.log(`\n# ${category.name}`);
    for (const [i, p] of plan.entries()) {
      counts.planned++;
      const migrationKey = `${category._id}:${p.regionIds.length ? [...p.regionIds].sort().join('+') : 'all'}`;
      const exists = await Path.exists({ migrationKey });
      const audienceLabel = p.regionIds.length ? p.regionIds.map((r) => regionNames.get(r)).join(', ') : 'everyone';
      const titles = p.moduleIds.map((id) => modules.find((m) => String(m._id) === String(id))?.title);
      console.log(`  ${exists ? '= exists ' : APPLY ? '+ create ' : '~ would create '}"${p.name}" · ${p.moduleIds.length} module(s) · audience: ${audienceLabel}${p.sequentialUnlock ? '' : ' · open order'}`);
      titles.forEach((t, n) => console.log(`      ${n + 1}. ${t}`));
      if (exists) { counts.existing++; continue; }
      if (APPLY) {
        await Path.create({
          categoryId: p.categoryId,
          name: p.name,
          order: i,
          moduleIds: p.moduleIds,
          audience: { regions: p.regionIds, departments: [], teams: [] },
          sequentialUnlock: p.sequentialUnlock,
          status: 'published',
          assessment: { enabled: false },
          migrationKey,
        });
        counts.created++;
      }
    }
  }

  const orphans = await Module.countDocuments({ categoryId: { $nin: categories.map((c) => c._id) } });
  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN (nothing written — pass --apply to create the paths)'}`);
  console.log(JSON.stringify(counts, null, 2));
  if (orphans) console.log(`⚠ ${orphans} module(s) have no valid tag and are in no path.`);
  await mongoose.disconnect();
}

// Only when run as a script — tests import planForCategory, and must not
// connect to (or exit on) the real database.
if (require.main === module) {
  main().catch(async (err) => {
    console.error('❌', err.message);
    try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
    process.exit(1);
  });
}

module.exports = { planForCategory };
