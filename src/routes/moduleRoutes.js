// src/routes/moduleRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Module = require("../models/Module");
const Topic = require("../models/Topic");
const Card = require("../models/Card");
const Team = require("../models/Team");
const ModuleRating = require("../models/ModuleRating");
const Category = require("../models/Category");
require("../models/Path");
require("../models/BankQuestion");
const progressController = require("../controllers/progressController");
const { computePointsReward } = require("../utils/pointsCalculator");
const { moduleHasDept, moduleDeptIds } = require("../utils/moduleDepartments");
const { buildRegionMatch, passesRegionScope } = require("../utils/scopeHelpers");
const { getOrCreateUncategorizedCategory } = require("../utils/defaultCategory");
const { computeModuleCompletionMap, walkSequentialUnlock, isModuleUnlockedForUser } = require("../utils/moduleLock");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const { handleError } = require("../utils/safeError");

const getDepartmentIdString = (doc) => {
  if (!doc) return null;
  return doc._id ? doc._id.toString() : doc.toString();
};

// Normalizes a single ID / array of IDs / falsy value down to a flat array
// of ObjectId-valid strings — shared by the department and team normalizers
// below so create/update always deal with a consistent shape.
const toIdArray = (value) => {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((v) => (v && v._id ? v._id : v))
    .filter((v) => v && mongoose.Types.ObjectId.isValid(v.toString()))
    .map((v) => v.toString());
};

// 🔒 Resolves a requested targetTeams value (single ID, array, or falsy) down
// to only the team IDs that actually belong to ONE OF the given department(s)
// — never trusts client-submitted team IDs outright. Used for BOTH module
// creation and updates, for BOTH Department Admins (whose departmentIds is
// always just their own single department) and Superadmins (whose
// departmentIds may span several selected departments) — so nobody can
// target a team outside the module's own target-department set just by
// knowing/guessing its ID.
const resolveOwnedTeamIds = async (requestedTeams, departmentIds) => {
  const validObjectIds = toIdArray(requestedTeams).map((id) => new mongoose.Types.ObjectId(id));
  if (validObjectIds.length === 0) return [];

  const deptIdList = toIdArray(departmentIds).map((id) => new mongoose.Types.ObjectId(id));
  if (deptIdList.length === 0) return [];

  const ownedTeams = await Team.find({
    _id: { $in: validObjectIds },
    department_id: { $in: deptIdList },
  }).select("_id").lean();
  return ownedTeams.map((t) => t._id);
};

// 🏷️ Resolves whatever `categoryId` the client submitted down to a real,
// existing Category id — falling back to the permanent "Uncategorized"
// bucket if none was submitted, or if the submitted id doesn't resolve to a
// real category (e.g. stale/tampered value). Used by BOTH the create and
// update routes so a module always ends up with a real categoryId, never
// null.
const resolveCategoryId = async (requestedCategoryId) => {
  if (requestedCategoryId && mongoose.Types.ObjectId.isValid(requestedCategoryId)) {
    const exists = await Category.exists({ _id: requestedCategoryId });
    if (exists) return requestedCategoryId;
  }
  const fallback = await getOrCreateUncategorizedCategory();
  return fallback._id;
};

// 📶 SEQUENTIAL LOCK ORDERING — resolves whatever `order` the client
// submitted for a module within its (already-resolved) category, falling
// back to "append at the end of this category's existing chain" (max
// existing order + 1, or 0 if the category is empty) when the client didn't
// submit a finite number. Used by both create and update so a module is
// never left with a meaningless order value.
const resolveModuleOrder = async (categoryId, requestedOrder) => {
  const parsed = Number(requestedOrder);
  if (Number.isFinite(parsed)) return parsed;
  const lastInCategory = await Module.findOne({ categoryId }).sort({ order: -1 }).select("order").lean();
  return lastInCategory ? (Number(lastInCategory.order) || 0) + 1 : 0;
};

// 🛡️ GRANULAR SECURITY HANDSHAKE FIREWALL — shared by GET /:id and the
// review endpoints below (GET /:id/reviews, GET /:id/my-review) so viewing
// a module's reviews is gated by the exact same visibility rules as viewing
// the module itself. Lives in utils/moduleAccess.js so the topic routes and
// the grading endpoints apply the identical rule.
const { assertModuleViewAccess } = require("../utils/moduleAccess");
const { normalizeCardForClient, isAuthorRole } = require("../utils/learnerCard");
const { extractSandboxKey } = require("../services/grading/sandboxKey");


// =========================================================================
// 🚀 GET /api/modules/workspace-curriculum
// @desc    Get modules with precise topic/card counts for the Orbit Workspace
// =========================================================================
router.get("/workspace-curriculum", auth, async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === "superadmin";
    const isAdmin = req.user.role === "admin";
    
    const contextUser = req.user.user ? req.user.user : req.user;
    const userDepartmentId = contextUser.department;
    const userTeamId = contextUser.team;

    let matchCriteria = {};

    // Apply your standard visibility firewall rules
    if (isSuperAdmin) {
      matchCriteria = {};
    } 
    else if (isAdmin) {
      if (!userDepartmentId) {
        return res.status(400).json({ success: false, message: "Admin department context is missing." });
      }
      matchCriteria = {
        $or: [
          { visibility: "Global" },
          { departments: new mongoose.Types.ObjectId(userDepartmentId.toString()) }
        ]
      };
    }
    else {
      if (!userDepartmentId) {
        return res.status(400).json({ success: false, message: "User department context is missing." });
      }

      const targetDeptObjectId = new mongoose.Types.ObjectId(userDepartmentId.toString());
      const conditions = [
        { visibility: "Global" },
        { visibility: "Departmental", departments: targetDeptObjectId }
      ];

      if (userTeamId && userTeamId.toString().trim() !== "") {
        conditions.push({
          visibility: "Team-Specific",
          departments: targetDeptObjectId,
          targetTeams: new mongoose.Types.ObjectId(userTeamId.toString())
        });
      }

      matchCriteria = { $or: conditions };
    }

    // 🌍 Narrow further by the requesting user's own region(s), if any.
    const regionMatchWC = buildRegionMatch(contextUser.regions);
    if (regionMatchWC) {
      matchCriteria = Object.keys(matchCriteria).length > 0
        ? { $and: [matchCriteria, regionMatchWC] }
        : regionMatchWC;
    }

    // 🏷️ Optional ?categoryId= filter — powers the Learn page's "modules in
    // this category/tag" view. Combined with the RBAC $or above via $and
    // rather than merged into the same object, so it narrows results
    // without disturbing the existing visibility logic.
    const { categoryId, regionId } = req.query;
    if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
      const categoryFilter = { categoryId: new mongoose.Types.ObjectId(categoryId) };
      matchCriteria = Object.keys(matchCriteria).length > 0
        ? { $and: [matchCriteria, categoryFilter] }
        : categoryFilter;
    }

    // 🌍 Optional explicit ?regionId= filter — powers the Learn page's
    // Tag → Region → Journey drill-down (the learner EXPLICITLY picks a
    // region to browse, distinct from the implicit per-user regionMatchWC
    // filter above which is always applied regardless). A module with no
    // `regions` set ("All") always matches every region; one with `regions`
    // set only matches when it lists this exact region — same semantics as
    // buildRegionMatch, just pinned to one specific id instead of the
    // caller's own region list.
    if (regionId && mongoose.Types.ObjectId.isValid(regionId)) {
      const regionObjectId = new mongoose.Types.ObjectId(regionId);
      const regionFilter = {
        $or: [
          { regions: { $exists: false } },
          { regions: { $size: 0 } },
          { regions: regionObjectId },
        ],
      };
      matchCriteria = Object.keys(matchCriteria).length > 0
        ? { $and: [matchCriteria, regionFilter] }
        : regionFilter;
    }

    const workspaceModules = await Module.aggregate([
      { $match: matchCriteria },
      // 🔢 Sequence modules by their admin-set order (same field the
      // sequential-lock system and the Tag -> Region -> Journey path both
      // rely on) — ties broken deterministically by _id, matching
      // moduleLock.js's own tie-break rule. Without this the aggregation's
      // natural Mongo order (not guaranteed to mean anything) decided what
      // "the path" looked like, making Module.order effectively unused by
      // this endpoint regardless of how an admin set it elsewhere.
      { $sort: { order: 1, _id: 1 } },
      // 📚 Look up topics count for STANDARD strategy modules
      {
        $lookup: {
          from: "topics",
          localField: "_id",
          foreignField: "module_id",
          as: "allocatedTopics"
        }
      },
      // 🚀 Cards attached directly to the module (EXPRESS_FLAT / hasTopics:false)
      {
        $lookup: {
          from: "cards",
          localField: "_id",
          foreignField: "module_id",
          as: "directCards"
        }
      },
      // 🔧 Cards inside a hierarchy module (STANDARD / hasTopics:true) attach
      // to their TOPIC, not the module directly — the direct-module_id
      // lookup above misses them entirely. This was the exact cause of a
      // topic-based module (e.g. "Introduction to XBRL") showing 0 total
      // cards and 0 Plasma here: its 88 cards all carry topic_id, none carry
      // module_id, so `directCards` alone was always empty for it. Union
      // both sources into the real card list this module actually has.
      {
        $lookup: {
          from: "cards",
          let: { topicIds: "$allocatedTopics._id" },
          pipeline: [
            { $match: { $expr: { $in: ["$topic_id", "$$topicIds"] } } }
          ],
          as: "topicCards"
        }
      },
      {
        $addFields: {
          allocatedCards: { $concatArrays: ["$directCards", "$topicCards"] }
        }
      },
      {
        $project: {
          title: 1,
          description: 1,
          imageUrl: 1,
          visibility: 1,
          engineStrategy: 1,
          hasTopics: 1,
          isHotModule: 1,
          isPopular: 1,
          estimatedTime: 1,
          categoryId: 1,
          order: 1,
          // 🌍 So the frontend's Tag→Region→Journey drill-down can compute
          // "which regions does this tag actually offer" from the already-
          // fetched (unfiltered-by-region) module list, and render module
          // region badges — see ?regionId= below for the actual filter.
          regions: 1,
          topicCount: {
            $cond: {
              if: { $or: [ { $eq: ["$engineStrategy", "EXPRESS_FLAT"] }, { $eq: ["$hasTopics", false] } ] },
              then: { $size: "$allocatedCards" },
              else: { $size: "$allocatedTopics" }
            }
          },
          // Card IDs for all cards in this module (for per-module progress calc in frontend)
          allCardIds: { $map: { input: "$allocatedCards", as: "c", in: "$$c._id" } },
          // Total card count (always the real card count regardless of strategy)
          totalCardCount: { $size: "$allocatedCards" },
          // 🎯 Lightweight per-card type info (not the full card documents) so
          // computePointsReward can sum real per-type point values instead of
          // just multiplying a raw count by a flat rate.
          cardsForPoints: {
            $map: {
              input: "$allocatedCards",
              as: "c",
              in: {
                card_type: "$$c.card_type",
                // 🔒 Only the sandbox HTML (needed for its point parse) —
                // never the rest of `content`, which for quiz/code cards
                // carries the answer key. Stripped from the response below.
                content: { htmlSource: { $cond: [{ $eq: ["$$c.card_type", "html_sandbox"] }, "$$c.content.htmlSource", null] } }
              }
            }
          }
        }
      }
    ]);

    // pointsReward is derived (not stored) from the real per-card-type sum +
    // estimatedTime — computed here in JS rather than as a second Mongo
    // aggregation expression so the formula only ever lives in one place.
    // NOTE: this listing view sums the module's cards directly regardless of
    // whether it's a flat or topic-hierarchy module — a reasonable preview
    // approximation for a listing page; the per-topic/whole-module Type A/B
    // split (topics summed for a hierarchy module) is computed precisely on
    // the single-module GET route below, which has the real topic structure.
    const dataWithPoints = workspaceModules.map(({ cardsForPoints, ...mod }) => ({
      ...mod,
      pointsReward: computePointsReward(cardsForPoints),
    }));

    // 🔒 SEQUENTIAL MODULE LOCK — attach `locked` per module. Admin/
    // superadmin bypass entirely (every module always unlocked for them,
    // regardless of a category's sequentialUnlock flag or completion
    // state). For a regular user, batch every module in this response
    // through ONE completion computation (regardless of how many
    // categories it spans), then walk each category's chain in pure JS
    // against that shared map — no per-module/per-category DB round-trips.
    const isPrivilegedForLock = req.user.role === "admin" || req.user.role === "superadmin";

    // 🧭 PATHS: once Paths are published, a learner sees only the modules of
    // the Paths meant for them (a module in no visible Path is hidden, like a
    // draft), and lock state comes from those Paths' own order — the same
    // rule GET /:id and the grading endpoints enforce.
    const pathsSvc = require("../services/paths");
    if (!isPrivilegedForLock && await pathsSvc.pathsEnabled()) {
      const states = await pathsSvc.visiblePathStates(req);
      const inPath = new Set();
      const unlockedInPath = new Set();
      states.forEach((s) => s.modules.forEach((m) => {
        const id = m.module._id.toString();
        inPath.add(id);
        if (m.unlocked) unlockedInPath.add(id);
      }));
      const visibleData = dataWithPoints.filter((m) => inPath.has(m._id.toString()));
      visibleData.forEach((m) => { m.locked = !unlockedInPath.has(m._id.toString()); });
      return res.json({ success: true, data: visibleData });
    }

    if (isPrivilegedForLock) {
      dataWithPoints.forEach((m) => { m.locked = false; });
    } else {
      const contextUserForLock = req.user.user ? req.user.user : req.user;
      const lockUserId = contextUserForLock.id || contextUserForLock._id;

      const categoryIdsForLock = [...new Set(
        dataWithPoints.map((m) => (m.categoryId ? m.categoryId.toString() : null)).filter(Boolean)
      )];
      const categoriesForLock = categoryIdsForLock.length
        ? await Category.find({ _id: { $in: categoryIdsForLock } }, "sequentialUnlock").lean()
        : [];
      const sequentialFlagMap = new Map(
        categoriesForLock.map((c) => [c._id.toString(), c.sequentialUnlock !== false])
      );

      const completionMap = await computeModuleCompletionMap({ modules: dataWithPoints, userId: lockUserId });

      const byCategory = new Map();
      dataWithPoints.forEach((m) => {
        const key = m.categoryId ? m.categoryId.toString() : "__none__";
        if (!byCategory.has(key)) byCategory.set(key, []);
        byCategory.get(key).push(m);
      });

      const unlockedIds = new Set();
      for (const [key, mods] of byCategory.entries()) {
        const sequentialUnlock = key === "__none__" ? true : (sequentialFlagMap.get(key) ?? true);
        if (!sequentialUnlock) {
          mods.forEach((m) => unlockedIds.add(m._id.toString()));
        } else {
          walkSequentialUnlock(mods, completionMap).forEach((id) => unlockedIds.add(id));
        }
      }

      dataWithPoints.forEach((m) => { m.locked = !unlockedIds.has(m._id.toString()); });
    }

    return res.json({ success: true, data: dataWithPoints });
  } catch (err) {
    console.error("Workspace Curriculum API Failure:", err.message);
    return handleError(res, err, 500);
  }
});

// =========================================================================
// 👁️ 1. GET /api/modules
// @desc    Get all modules matching user's permissions tier cleanly
// =========================================================================
router.get("/", auth, async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === "superadmin";
    const isAdmin = req.user.role === "admin";
    
    const contextUser = req.user.user ? req.user.user : req.user;
    const userDepartmentId = contextUser.department;
    const userTeamId = contextUser.team;

    let matchCriteria = {};

    if (isSuperAdmin) {
      matchCriteria = {};
    } 
    else if (isAdmin) {
      if (!userDepartmentId) {
        return res.status(400).json({ success: false, message: "Admin department context is missing." });
      }
      
      matchCriteria = {
        $or: [
          { visibility: "Global" },
          { departments: new mongoose.Types.ObjectId(userDepartmentId.toString()) }
        ]
      };
    }
    else {
      if (!userDepartmentId) {
        return res.status(400).json({ success: false, message: "User department context is missing." });
      }

      const targetDeptObjectId = new mongoose.Types.ObjectId(userDepartmentId.toString());

      const conditions = [
        { visibility: "Global" },
        { visibility: "Departmental", departments: targetDeptObjectId }
      ];

      if (userTeamId && userTeamId.toString().trim() !== "") {
        conditions.push({
          visibility: "Team-Specific",
          departments: targetDeptObjectId,
          targetTeams: new mongoose.Types.ObjectId(userTeamId.toString())
        });
      }

      matchCriteria = { $or: conditions };
    }

    // 🌍 Narrow further by the requesting user's own region(s), if any.
    const regionMatchList = buildRegionMatch(contextUser.regions);
    if (regionMatchList) {
      matchCriteria = Object.keys(matchCriteria).length > 0
        ? { $and: [matchCriteria, regionMatchList] }
        : regionMatchList;
    }

    const modulesWithRatings = await Module.aggregate([
      { $match: matchCriteria },
      {
        $lookup: {
          from: "moduleratings",
          localField: "_id",
          foreignField: "module_id",
          as: "allRatings",
        },
      },
      {
        // 📚 departments is now an array — this $lookup naturally returns
        // the matching Department doc for every element, no per-doc $unwind
        // needed (that only made sense back when department was singular).
        $lookup: {
          from: "departments",
          localField: "departments",
          foreignField: "_id",
          as: "departmentDetails",
        },
      },
      {
        $project: {
          title: 1,
          description: 1,
          imageUrl: 1,
          visibility: 1,
          targetTeams: 1,
          hasTopics: 1,
          engineStrategy: 1,
          moduleType: 1,
          isHotModule: 1,
          isPopular: 1,
          estimatedTime: 1,
          // 👤 Needed by the admin edit forms to determine ownership for the
          // Global-scope RBAC gate — without this, editData.createdBy would
          // always be undefined and every Department Admin would look like
          // a non-owner regardless of who actually created the module.
          createdBy: 1,
          // 🏢 Full array of {_id, name, ...} department docs — the admin
          // form and any learner-facing badge now render one-or-more
          // department names instead of assuming exactly one.
          departments: "$departmentDetails",
          avgRating: { $ifNull: [{ $avg: "$allRatings.rating" }, 0] },
          totalReviews: { $size: "$allRatings" },
          // 🏷️ Needed by AdminModuleForm to pre-select the module's current
          // category/tag when editing.
          categoryId: 1,
          // 🔒 Needed by the admin reorder-modules panel to sort a category's
          // modules into their current sequence before any drag happens.
          order: 1,
        },
      },
    ]);

    console.log(`🎯 Compiled ${modulesWithRatings.length} modules for User Context role: ${req.user.role}`);
    return res.json(modulesWithRatings);
  } catch (err) {
    console.error("Fetch Modules Aggregation Failure:", err.message);
    return handleError(res, err, 500);
  }
});

// =========================================================================
// @route   GET /api/modules/:id
// @desc    Get single module details with filtered structural verification gates
// @access  Private (Logged-in Trainees & Admins)
// =========================================================================
router.get("/:id", auth, async (req, res) => {
  try {
    const moduleData = await Module.findById(req.params.id);
    if (!moduleData) {
      return res.status(404).json({ message: "Module not found" });
    }

    // 🛡️ GRANULAR SECURITY HANDSHAKE FIREWALL
    const accessCheck = assertModuleViewAccess(moduleData, req);
    if (!accessCheck.ok) {
      return res.status(accessCheck.status).json({ success: false, message: accessCheck.message });
    }

    // 🔒 SEQUENTIAL MODULE LOCK — role 'user' only; admin/superadmin bypass
    // entirely regardless of the category's sequentialUnlock flag or this
    // module's completion state. Runs BEFORE any content (cards/topics) is
    // assembled below — this is the actual content-serving route used by
    // both TopicTrail.jsx and the Quiz player, so a locked module's real
    // content must never be built into the response at all.
    if (req.user.role !== "admin" && req.user.role !== "superadmin") {
      const contextUserForLock = req.user.user ? req.user.user : req.user;
      const lockUserId = contextUserForLock.id || contextUserForLock._id;
      const unlocked = await isModuleUnlockedForUser({
        moduleId: moduleData._id,
        categoryId: moduleData.categoryId,
        userId: lockUserId,
        // Same chain the Learn page walks: only modules this user can see.
        isVisible: (m) => assertModuleViewAccess(m, req).ok,
        req,
      });
      if (!unlocked) {
        return res.status(403).json({
          success: false,
          message: "This module is locked. Complete the previous module in this category first.",
          locked: true,
        });
      }
    }

    // 🌟 Rating aggregate — mirrors the same $avg/$size computation the
    // module LIST endpoint already does, just never returned here before
    // (every screen that fetches a single module had no way to show this).
    const ratingAgg = await ModuleRating.aggregate([
      { $match: { module_id: moduleData._id } },
      { $group: { _id: null, avgRating: { $avg: "$rating" }, totalReviews: { $sum: 1 } } },
    ]);

    let structuralPayload = {
      ...moduleData.toObject(),
      id: moduleData._id.toString(),
      avgRating: ratingAgg[0]?.avgRating || 0,
      totalReviews: ratingAgg[0]?.totalReviews || 0,
    };

    // 🔬 HYBRID DATA NORMALIZATION STRATEGY
    const strategy = moduleData.engineStrategy || 'STANDARD';
    const isExpressFlatPipeline = strategy === 'EXPRESS_FLAT' || moduleData.hasTopics === false;

    if (isExpressFlatPipeline) {
      console.log(`⚡ Loading Compact Direct Express Pipeline for Module: ${moduleData.title}`);
      
      const directCards = await Card.find({ module_id: moduleData._id })
        .sort({ cardOrder: 1 })
        .lean();

      const normalizedCards = directCards.map(card => normalizeCardForClient(card, { includeAnswers: isAuthorRole(req) }));

      structuralPayload.cards = normalizedCards;
      structuralPayload.topics = [];
      // Module Type B (direct cards, no topic hierarchy) — aggregate the
      // card XPs directly.
      structuralPayload.pointsReward = computePointsReward(normalizedCards);
    }
    else {
      console.log(`📚 Loading Standard 3-Layer Course Architecture for Module: ${moduleData.title}`);
      
      const topics = await Topic.find({ module_id: moduleData._id }).sort({ topicOrder: 1 }).lean();
      const topicIds = topics.map((t) => t._id);

      const allCards = await Card.find({ topic_id: { $in: topicIds } })
        .sort({ cardOrder: 1 })
        .lean();

      structuralPayload.topics = topics.map((topic) => {
        const matchingCards = allCards
          .filter((card) => card.topic_id && card.topic_id.toString() === topic._id.toString())
          .map((card) => normalizeCardForClient(card, { includeAnswers: isAuthorRole(req) }));

        return {
          ...topic,
          id: topic._id.toString(),
          cards: matchingCards,
          // Topic Card — its own calculated XP, aggregated from the cards it contains.
          pointsReward: computePointsReward(matchingCards)
        };
      });

      structuralPayload.cards = [];
      // Module Type A (contains Topics) — aggregate the XP of all its
      // underlying Topics (each of which already includes its own time
      // bonus) rather than recomputing directly from the raw card list +
      // the module's own estimatedTime — those are two different numbers
      // whenever individual topics have their own estimatedTime set.
      structuralPayload.pointsReward = structuralPayload.topics.reduce(
        (sum, t) => sum + (t.pointsReward || 0),
        0
      );
    }

    return res.json(structuralPayload);
  } catch (err) {
    console.error("❌ Single Module Fetch Fatal Error:", err.message);
    return handleError(res, err, 500);
  }
});

// =========================================================================
// 🔒 3. POST /api/modules/:id/rate
// =========================================================================
router.post("/:id/rate", auth, async (req, res) => {
  const { rating, reviewText } = req.body;
  const moduleId = req.params.id;
  const contextUser = req.user.user ? req.user.user : req.user;
  const userId = contextUser.id || contextUser._id;

  try {
    const targetModule = await Module.findById(moduleId);
    if (!targetModule) {
      return res.status(404).json({ message: "Module not found" });
    }

    if (req.user.role !== "superadmin" && targetModule.visibility !== "Global") {
      if (!moduleHasDept(targetModule, contextUser.department)) {
        return res.status(403).json({ message: "Forbidden: Rating cross-department modules is restricted." });
      }
    }

    const ratingDeptIds = moduleDeptIds(targetModule);
    const raterDeptId = contextUser.department?.toString();
    const ratingDepartmentId = ratingDeptIds.includes(raterDeptId) ? raterDeptId : (ratingDeptIds[0] || contextUser.department);

    // 🎯 The saved doc is now returned (not just a bare success message) so
    // the frontend can update its own UI immediately without a refetch.
    // runValidators:true is added here — without it, findOneAndUpdate
    // silently skips the schema's rating min:1/max:5/required checks on
    // upsert, letting an out-of-range or missing rating slip straight in.
    const savedReview = await ModuleRating.findOneAndUpdate(
      { user_id: userId, module_id: moduleId },
      {
        rating,
        reviewText,
        department_id: ratingDepartmentId
      },
      { upsert: true, new: true, runValidators: true },
    );
    return res.json({ success: true, message: "Thank you for rating this module!", review: savedReview });
  } catch (err) {
    if (err.name === "ValidationError") {
      return handleError(res, err, 400);
    }
    return res.status(500).json({ message: "Rating submission failed." });
  }
});

// =========================================================================
// 🔒 3b. GET /api/modules/:id/reviews — list every review for a module.
// Same visibility gate as GET /:id (a learner must be able to see the
// module to see its reviews; a Department Admin is scoped to modules
// already visible to them; Superadmin unrestricted).
// =========================================================================
router.get("/:id/reviews", auth, async (req, res) => {
  try {
    const targetModule = await Module.findById(req.params.id);
    if (!targetModule) {
      return res.status(404).json({ success: false, message: "Module not found" });
    }

    const accessCheck = assertModuleViewAccess(targetModule, req);
    if (!accessCheck.ok) {
      return res.status(accessCheck.status).json({ success: false, message: accessCheck.message });
    }

    const reviews = await ModuleRating.find({ module_id: targetModule._id })
      .sort({ createdAt: -1 })
      .populate("user_id", "username avatarUrl")
      .lean();

    const totalReviews = reviews.length;
    const avgRating = totalReviews > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / totalReviews
      : 0;

    return res.json({
      success: true,
      avgRating,
      totalReviews,
      reviews: reviews.map(r => ({
        _id: r._id,
        rating: r.rating,
        reviewText: r.reviewText,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        user: r.user_id ? { _id: r.user_id._id, username: r.user_id.username, avatarUrl: r.user_id.avatarUrl } : null,
      })),
    });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// 🔒 3c. GET /api/modules/:id/my-review — the requesting user's own
// existing rating/review for this module (or null), so the frontend can
// pre-fill an edit form instead of always showing a blank "submit" state.
// =========================================================================
router.get("/:id/my-review", auth, async (req, res) => {
  try {
    const contextUser = req.user.user ? req.user.user : req.user;
    const userId = contextUser.id || contextUser._id;

    const review = await ModuleRating.findOne({ user_id: userId, module_id: req.params.id }).lean();
    return res.json({ success: true, review: review || null });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// 🔒 4. POST /api/modules (ADMIN STRAT LOADER)
// =========================================================================
router.post("/", [auth, admin], async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === "superadmin";
    const { visibility, departments, targetTeams, engineStrategy } = req.body;

    // 🔐 SCOPE RBAC (create path): a Department Admin's module is always
    // anchored to their OWN single department regardless of what (if
    // anything) they submit in `departments` — only a Super Admin's
    // submitted department LIST is trusted, and may span several
    // departments. Matches the identical rule enforced on the update route
    // below.
    const finalDepartments = isSuperAdmin ? toIdArray(departments) : [req.user.department.toString()];

    if (visibility !== "Global" && finalDepartments.length === 0) {
      return res.status(400).json({ success: false, message: "At least one target department is required." });
    }

    // 🔒 Teams must belong to one of the module's own target departments —
    // enforced the same way for both Department Admins and Superadmins now
    // that a module can span multiple departments.
    const processedTeams = visibility === "Team-Specific"
      ? await resolveOwnedTeamIds(targetTeams, finalDepartments)
      : [];

    const isHtmlSandboxModule = req.body.moduleType === 'html_sandbox';
    const cleanStrategy = isHtmlSandboxModule ? 'EXPRESS_FLAT' : (engineStrategy || 'STANDARD');
    const cleanHasTopics = isHtmlSandboxModule ? false : cleanStrategy === 'STANDARD';

    // 🔒 SERVER-SIDE GRADING: an HTML module must carry a gradable answer key
    // (no ungradable module goes live). Checked BEFORE anything is saved, so
    // a rejected module never leaves a half-created record behind.
    let gradingSummary = null;
    if (isHtmlSandboxModule) {
      const keyCheck = extractSandboxKey(req.body.htmlSource || '');
      if (!keyCheck.ok) {
        return res.status(400).json({ success: false, message: `HTML module cannot be graded: ${keyCheck.error}`, gradingError: keyCheck.error });
      }
      gradingSummary = keyCheck.summary;
    }

    // 🏷️ Always resolves to a real Category — falls back to "Uncategorized"
    // if the admin didn't pick one (or picked something that doesn't exist).
    const resolvedCategoryId = await resolveCategoryId(req.body.categoryId);
    // 🔒 Appends this module at the end of its category's current unlock
    // chain unless an explicit order was submitted (the drag-and-drop
    // reorder endpoint sends explicit values; ordinary module creation does
    // not, so it always lands last).
    const resolvedModuleOrder = await resolveModuleOrder(resolvedCategoryId, req.body.order);

    const newModule = new Module({
      ...req.body,
      departments: visibility === "Global" ? [] : finalDepartments,
      visibility,
      targetTeams: processedTeams,
      engineStrategy: cleanStrategy,
      hasTopics: cleanHasTopics,
      categoryId: resolvedCategoryId,
      order: resolvedModuleOrder,
      // 🔧 An html_sandbox module's real admin-entered duration only ever
      // arrived as `estimatedDurationMin` (saved below onto the sandbox
      // Card's own content) — the Module's own `estimatedTime` field was
      // never populated from it, so it silently stayed at its schema
      // default (0), which then made the frontend's duration display fall
      // through to its `estimateDuration()` estimate — a flat "~5 min" for
      // any single-card module, regardless of what was actually entered.
      // Sync the two here so the real value is what gets displayed.
      ...(isHtmlSandboxModule ? { estimatedTime: Number(req.body.estimatedDurationMin) || 0 } : {}),
      // 👤 Whoever creates a module is its owner — this is what lets a
      // Department Admin freely choose Global for their OWN new module
      // (they trivially satisfy the ownership check below on any future
      // scope change) while being blocked from doing the same to a
      // colleague's or Superadmin's module.
      createdBy: req.user.id,
    });

    const module = await newModule.save();

    if (isHtmlSandboxModule) {
      try {
        await Card.create({
          module_id: module._id,
          card_type: 'html_sandbox',
          cardOrder: 1,
          content: {
            title: module.title,
            htmlSource: req.body.htmlSource || '',
            // 🔒 Trusted = the module iframe keeps allow-same-origin (needed
            // for embedded SharePoint video sign-in). Superadmin-only.
            sandboxTrusted: req.user.role === 'superadmin' && req.body.sandboxTrusted === true,
            maxPoints: Number(req.body.maxPoints) || 10,
            baseTimeThresholdSec: Number(req.body.baseTimeThresholdSec) || 0,
            estimatedDurationMin: Number(req.body.estimatedDurationMin) || 0,
          }
        });
      } catch (cardErr) {
        await module.deleteOne();
        console.error('Sandbox card creation failed:', cardErr.message);
        return res.status(400).json({ message: 'Failed to create the HTML module card. Check the HTML and try again.' });
      }
    }

    return res.status(201).json(gradingSummary ? { ...module.toObject(), gradingSummary } : module);
  } catch (err) {
    return handleError(res, err, 400);
  }
});

// =========================================================================
// 🔒 5. PUT /api/modules/:id
// =========================================================================
router.put("/:id", [auth, admin], async (req, res) => {
  try {
    const targetModule = await Module.findById(req.params.id);
    if (!targetModule) {
      return res.status(404).json({ message: "Module not found" });
    }

    // =========================================================================
    // 🔐 SCOPE-CHANGE RBAC
    // Super Admin:    unrestricted — any visibility, any department(s), any teams.
    // Department Admin: may only ever leave a module scoped to Global, or to
    //   JUST their own single department (never another department, and
    //   never a module that already spans more than one). This block is the
    //   single source of truth for departments/targetTeams on this route;
    //   nothing below re-touches those two fields.
    // =========================================================================
    const isSuperAdmin = req.user.role === "superadmin";
    const incomingVisibility = req.body.visibility || targetModule.visibility;

    if (!isSuperAdmin) {
      // A Department Admin may only ever touch a module that already belongs
      // SOLELY to their own department (a Global module has departments:[],
      // so it passes this check too — promoting it INTO their department
      // below is allowed; reassigning an already-departmental module that
      // belongs to someone else's department, OR that spans more than one
      // department (which only a Superadmin could have set up), is not).
      const existingDeptIds = moduleDeptIds(targetModule);
      const ownDeptId = req.user.department.toString();
      const isSolelyOwnDept = existingDeptIds.length === 0
        || (existingDeptIds.length === 1 && existingDeptIds[0] === ownDeptId);
      if (!isSolelyOwnDept) {
        return res.status(403).json({ message: "Access Denied: Cannot modify foreign assets." });
      }

      // 🔒 OWNERSHIP GATE: a Department Admin may only cross the Global
      // boundary — pushing a module OUT to Global, or pulling a Global
      // module BACK into their own department — if they created it. This is
      // only checked when a transition is actually happening (visibility is
      // genuinely changing AND either side of that change is Global); simply
      // re-saving a module that's already Global without touching its scope
      // isn't "changing it to Global", so it isn't gated here. Departmental
      // <-> Team-Specific reshuffles that never touch Global are never
      // ownership-gated at all, per spec ("allowed to change its scope to
      // team-wise within their own department" regardless of who created it).
      const wasGlobal = targetModule.visibility === "Global";
      const isVisibilityChanging = incomingVisibility !== targetModule.visibility;
      const crossesGlobalBoundary = isVisibilityChanging && (incomingVisibility === "Global" || wasGlobal);
      const isOwner = targetModule.createdBy && targetModule.createdBy.toString() === req.user.id.toString();

      if (crossesGlobalBoundary && !isOwner) {
        return res.status(403).json({
          message: "Access Denied: Only this module's creator can change its scope to or from Global.",
        });
      }

      if (incomingVisibility === "Global") {
        req.body.departments = [];
        req.body.targetTeams = [];
      } else {
        // Departmental or Team-Specific — ALWAYS just the admin's own
        // department. Multi-department assignment is a Superadmin-only
        // capability; a Department Admin can never expand a module beyond
        // their own single department, regardless of what the client sent.
        req.body.departments = [req.user.department];

        if (incomingVisibility === "Team-Specific") {
          // 🔒 Never trust client-submitted team IDs outright — silently
          // keep only the ones that actually belong to this admin's own
          // department, so a Department Admin can't target another
          // department's team just by knowing/guessing its ID.
          req.body.targetTeams = await resolveOwnedTeamIds(req.body.targetTeams, req.user.department);
        } else {
          req.body.targetTeams = [];
        }
      }
    } else {
      // Super Admin — fully trusted; still normalize shape/consistency.
      if (incomingVisibility === "Global") {
        req.body.departments = [];
        req.body.targetTeams = [];
      } else {
        req.body.departments = toIdArray(req.body.departments);
        if (incomingVisibility === "Team-Specific" && req.body.targetTeams) {
          // 🔒 Same team-ownership integrity check as the create route —
          // teams must actually belong to one of the selected departments.
          req.body.targetTeams = await resolveOwnedTeamIds(req.body.targetTeams, req.body.departments);
        } else if (incomingVisibility === "Departmental") {
          req.body.targetTeams = [];
        }
      }
    }

    if (req.body.engineStrategy) {
      req.body.hasTopics = req.body.engineStrategy === 'STANDARD';
    }

    // 🏷️ Same fallback rule as create — a module is never left with no
    // category. Only touched when the client actually submitted the field
    // (the admin form always does, but a partial PATCH-style caller that
    // omits it entirely leaves the existing categoryId untouched).
    if (req.body.categoryId !== undefined) {
      req.body.categoryId = await resolveCategoryId(req.body.categoryId);
    }

    // 📶 Resolve order only when the client explicitly sent one, OR when the
    // module's category is changing (its old order value is meaningless in
    // a new category's chain) — otherwise leave req.body.order absent so
    // Object.assign below never touches the existing stored order.
    const categoryIsChanging = req.body.categoryId !== undefined
      && req.body.categoryId.toString() !== (targetModule.categoryId ? targetModule.categoryId.toString() : null);
    if (req.body.order !== undefined || categoryIsChanging) {
      req.body.order = await resolveModuleOrder(
        req.body.categoryId !== undefined ? req.body.categoryId : targetModule.categoryId,
        req.body.order
      );
    }

    const isHtmlSandboxModule = targetModule.moduleType === 'html_sandbox';
    if (isHtmlSandboxModule) {
      req.body.engineStrategy = 'EXPRESS_FLAT';
      req.body.hasTopics = false;
      // 🔧 Same sync as the create route above — keep Module.estimatedTime
      // in step with the sandbox card's own estimatedDurationMin instead of
      // leaving it stale/0 on every edit.
      if (req.body.estimatedDurationMin !== undefined) {
        req.body.estimatedTime = Number(req.body.estimatedDurationMin) || 0;
      }
    }

    // 🎯 STRUCTURAL FIX: switched from findByIdAndUpdate to assign+save.
    // Module.js's conditional `validate` on `departments` (requires at
    // least one entry unless `this.visibility === 'Global'`) needs `this` to
    // be the full, merged document to evaluate correctly — that's exactly
    // how `.save()` works.
    // findByIdAndUpdate's update-validators run with `this` bound to the
    // query object instead, so a conditional validator reading a SIBLING
    // field's new value is unreliable there even with `runValidators: true`
    // — this is a well-documented Mongoose limitation, not specific to this
    // schema. Reusing the targetModule already fetched above for the
    // permission check also saves a second DB round-trip.
    // 🔒 SERVER-SIDE GRADING: validate a changed HTML source's answer key
    // BEFORE saving anything (see the create route).
    let gradingSummary = null;
    if (isHtmlSandboxModule && req.body.htmlSource !== undefined) {
      const keyCheck = extractSandboxKey(req.body.htmlSource || '');
      if (!keyCheck.ok) {
        return res.status(400).json({ success: false, message: `HTML module cannot be graded: ${keyCheck.error}`, gradingError: keyCheck.error });
      }
      gradingSummary = keyCheck.summary;
    }

    // 🔒 Never let the request body set ownership, identity or the
    // platform-wide featured flags (those have their own superadmin-only
    // routes below). Copying `createdBy` from the body used to let any admin
    // make themselves a module's "creator" and then pass the ownership gate.
    const PROTECTED_FIELDS = ["_id", "__v", "createdBy", "createdAt", "updatedAt", "isHotModule", "isPopular", "moduleType"];
    const changes = Object.fromEntries(
      Object.entries(req.body || {}).filter(([k]) => !PROTECTED_FIELDS.includes(k) && !k.startsWith("$")),
    );
    Object.assign(targetModule, changes);
    const updatedModule = await targetModule.save();

    if (isHtmlSandboxModule) {
      const cardContentUpdate = {};
      if (req.body.htmlSource !== undefined) cardContentUpdate['content.htmlSource'] = req.body.htmlSource;
      if (req.body.maxPoints !== undefined) cardContentUpdate['content.maxPoints'] = Number(req.body.maxPoints);
      if (req.body.baseTimeThresholdSec !== undefined) cardContentUpdate['content.baseTimeThresholdSec'] = Number(req.body.baseTimeThresholdSec);
      if (req.body.estimatedDurationMin !== undefined) cardContentUpdate['content.estimatedDurationMin'] = Number(req.body.estimatedDurationMin);
      if (req.body.title !== undefined) cardContentUpdate['content.title'] = req.body.title;
      // 🔒 Only a superadmin can (un)trust a module. If anyone else changes
      // its HTML, the trust is dropped — a superadmin must re-approve it.
      if (req.user.role === 'superadmin' && req.body.sandboxTrusted !== undefined) {
        cardContentUpdate['content.sandboxTrusted'] = req.body.sandboxTrusted === true;
      } else if (req.user.role !== 'superadmin' && req.body.htmlSource !== undefined) {
        cardContentUpdate['content.sandboxTrusted'] = false;
      }

      if (Object.keys(cardContentUpdate).length > 0) {
        await Card.findOneAndUpdate(
          { module_id: targetModule._id, card_type: 'html_sandbox' },
          { $set: cardContentUpdate }
        );
      }
    }

    return res.json(gradingSummary ? { ...updatedModule.toObject(), gradingSummary } : updatedModule);
  } catch (err) {
    return handleError(res, err, 400);
  }
});

// =========================================================================
// 🔒 6. DELETE /api/modules/:id (COMPREHENSIVE CASCADING PURGE)
// =========================================================================
router.delete("/:id", [auth, admin], async (req, res) => {
  try {
    const module = await Module.findById(req.params.id);
    if (!module) return res.status(404).json({ message: "Module not found" });

    if (req.user.role !== "superadmin") {
      const existingDeptIds = moduleDeptIds(module);
      const isSolelyOwnDept = existingDeptIds.length === 0
        || (existingDeptIds.length === 1 && existingDeptIds[0] === req.user.department.toString());
      if (!isSolelyOwnDept) {
        return res.status(403).json({ message: "Forbidden: Deleting foreign department models is banned." });
      }
      // 🔒 A Global module is shared by every department — only its creator
      // (or a superadmin) may delete it, since the purge below also wipes
      // every learner's progress in it.
      const isOwner = module.createdBy && module.createdBy.toString() === req.user.id.toString();
      if (existingDeptIds.length === 0 && !isOwner) {
        return res.status(403).json({ message: "Only this module's creator or a superadmin can delete a Global module." });
      }
    }

    const topics = await Topic.find({ module_id: module._id });
    const topicIds = topics.map((t) => t._id);

    console.log(`🧹 Initiating master cascading purge for module: ${module._id}`);

    await Card.deleteMany({
      $or: [
        { topic_id: { $in: topicIds } },
        { module_id: module._id }
      ]
    });

    await Topic.deleteMany({ module_id: module._id });
    await ModuleRating.deleteMany({ module_id: module._id });

    if (mongoose.models.UserTopicProgress) {
      await mongoose.models.UserTopicProgress.deleteMany({ module_id: module._id });
    }

    if (mongoose.models.UserCardProgress) {
      await mongoose.models.UserCardProgress.deleteMany({
        $or: [
          { topic_id: { $in: topicIds } },
          { module_id: module._id }
        ]
      });
    }

    // 🧭 Take it out of every Path. Its bank questions are retired, not
    // deleted — past Pre/Post attempts still reference them.
    await mongoose.model("Path").updateMany({ moduleIds: module._id }, { $pull: { moduleIds: module._id } });
    await mongoose.model("BankQuestion").updateMany({ moduleId: module._id }, { $set: { status: "retired" } });
    await module.deleteOne();
    return res.json({ success: true, message: "Purge execution resolved successfully." });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// 🔒 7. GET /api/modules/:id/submissions — CSV export of html_sandbox submissions
// =========================================================================
router.get("/:id/submissions", [auth, admin], progressController.exportModuleSubmissionsCsv);

// =========================================================================
// 🔥 8. PATCH /api/modules/:id/hot-module — singleton platform-wide "Hot Module" flag
// =========================================================================
router.patch("/:id/hot-module", [auth, admin], async (req, res) => {
  try {
    // 🔒 Platform-wide flag — it changes what every department sees.
    if (req.user.role !== "superadmin") {
      return res.status(403).json({ message: "Only a superadmin can feature modules platform-wide." });
    }
    const { isHotModule } = req.body;
    const target = await Module.findById(req.params.id);
    if (!target) return res.status(404).json({ message: "Module not found" });

    if (isHotModule) {
      await Module.updateMany({ isHotModule: true }, { isHotModule: false });
    }
    target.isHotModule = !!isHotModule;
    await target.save();

    return res.json(target);
  } catch (err) {
    return handleError(res, err, 400);
  }
});

// =========================================================================
// ⭐ 9. PATCH /api/modules/:id/popular — "Popular Modules" row toggle, capped at 4
// =========================================================================
router.patch("/:id/popular", [auth, admin], async (req, res) => {
  try {
    // 🔒 Platform-wide flag — it changes what every department sees.
    if (req.user.role !== "superadmin") {
      return res.status(403).json({ message: "Only a superadmin can feature modules platform-wide." });
    }
    const { isPopular } = req.body;
    const target = await Module.findById(req.params.id);
    if (!target) return res.status(404).json({ message: "Module not found" });

    if (isPopular && !target.isPopular) {
      const count = await Module.countDocuments({ isPopular: true });
      if (count >= 4) {
        return res.status(400).json({ message: "Popular Modules row is capped at 4 — unfeature one first." });
      }
    }
    target.isPopular = !!isPopular;
    await target.save();

    return res.json(target);
  } catch (err) {
    return handleError(res, err, 400);
  }
});

module.exports = router;