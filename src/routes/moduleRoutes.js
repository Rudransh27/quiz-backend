// src/routes/moduleRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Module = require("../models/Module");
const Topic = require("../models/Topic");
const Card = require("../models/Card");
const Team = require("../models/Team");
const ModuleRating = require("../models/ModuleRating");
const progressController = require("../controllers/progressController");
const { computePointsReward } = require("../utils/pointsCalculator");
const { moduleHasDept, moduleDeptIds } = require("../utils/moduleDepartments");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

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

// 🛡️ GRANULAR SECURITY HANDSHAKE FIREWALL — shared by GET /:id and the
// review endpoints below (GET /:id/reviews, GET /:id/my-review) so viewing
// a module's reviews is gated by the exact same visibility rules as viewing
// the module itself. Returns { ok: true } or { ok: false, status, message }
// rather than throwing, matching this file's existing control-flow style.
const assertModuleViewAccess = (moduleData, req) => {
  if (req.user.role === "superadmin") return { ok: true };

  const contextUser = req.user.user ? req.user.user : req.user;
  const userDeptStr = contextUser.department?.toString();
  const userTeamStr = contextUser.team?.toString();

  if (moduleData.visibility === "Departmental" && !moduleHasDept(moduleData, userDeptStr)) {
    return { ok: false, status: 403, message: "Access Denied: Foreign Department content locked." };
  }

  if (moduleData.visibility === "Team-Specific") {
    if (!moduleHasDept(moduleData, userDeptStr)) {
      return { ok: false, status: 403, message: "Access Denied: Foreign Department content locked." };
    }
    const hasTeamAccess = moduleData.targetTeams.some(tId => tId.toString() === userTeamStr);
    if (!hasTeamAccess) {
      return { ok: false, status: 403, message: "Access Denied: Locked for your specific team scope." };
    }
  }

  return { ok: true };
};


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

    const workspaceModules = await Module.aggregate([
      { $match: matchCriteria },
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
              in: { card_type: "$$c.card_type", content: "$$c.content" }
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
    const dataWithPoints = workspaceModules.map((mod) => ({
      ...mod,
      pointsReward: computePointsReward(mod.cardsForPoints),
    }));

    return res.json({ success: true, data: dataWithPoints });
  } catch (err) {
    console.error("Workspace Curriculum API Failure:", err.message);
    return res.status(500).json({ success: false, message: err.message });
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
        },
      },
    ]);

    console.log(`🎯 Compiled ${modulesWithRatings.length} modules for User Context role: ${req.user.role}`);
    return res.json(modulesWithRatings);
  } catch (err) {
    console.error("Fetch Modules Aggregation Failure:", err.message);
    return res.status(500).json({ message: err.message });
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

      const normalizedCards = directCards.map(card => {
        const contentObj = card.content || {};
        let safeOptions = contentObj.options;
        let safeCorrectIndex = contentObj.correctIndex;
        let safeExplanation = contentObj.explanation;

        if (card.card_type === "quiz" && contentObj.text) {
          try {
            const parsedQuiz = JSON.parse(contentObj.text);
            safeOptions = parsedQuiz.options || safeOptions;
            safeCorrectIndex = parsedQuiz.correctAnswerIndex !== undefined ? parsedQuiz.correctAnswerIndex : safeCorrectIndex;
            safeExplanation = parsedQuiz.explanationHint || safeExplanation;
          } catch (e) {}
        }

        return {
          ...card,
          id: card._id.toString(),
          content: {
            ...contentObj,
            title: contentObj.title || "",
            text: contentObj.text || "",
            // Extract code directly out of 'htmlSource' or fallback content structures
            htmlSource: card.card_type === "html_sandbox" ? (contentObj.htmlSource || contentObj.text || "") : "",
            options: safeOptions || [],
            correctIndex: safeCorrectIndex !== undefined ? safeCorrectIndex : 0,
            explanation: safeExplanation || ""
          }
        };
      });

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
          .map((card) => {
            const contentObj = card.content || {};
            let safeOptions = contentObj.options;
            let safeCorrectIndex = contentObj.correctIndex;
            let safeExplanation = contentObj.explanation;

            if (card.card_type === "quiz" && contentObj.text) {
              try {
                const parsedQuiz = JSON.parse(contentObj.text);
                safeOptions = parsedQuiz.options || safeOptions;
                safeCorrectIndex = parsedQuiz.correctAnswerIndex !== undefined ? parsedQuiz.correctAnswerIndex : safeCorrectIndex;
                safeExplanation = parsedQuiz.explanationHint || safeExplanation;
              } catch (e) {}
            }

            return {
              ...card,
              id: card._id.toString(),
              content: {
                ...contentObj,
                title: contentObj.title || "",
                text: contentObj.text || "",
                // Support standalone sandboxes safely inside a multi-topic syllabus timeline deck node context
                htmlSource: card.card_type === "html_sandbox" ? (contentObj.htmlSource || contentObj.text || "") : "",
                options: safeOptions || [],
                correctIndex: safeCorrectIndex !== undefined ? safeCorrectIndex : 0,
                explanation: safeExplanation || ""
              }
            };
          });

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
    return res.status(500).json({ message: err.message });
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
      return res.status(400).json({ message: err.message });
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
    return res.status(500).json({ success: false, message: err.message });
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
    return res.status(500).json({ success: false, message: err.message });
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

    const newModule = new Module({
      ...req.body,
      departments: visibility === "Global" ? [] : finalDepartments,
      visibility,
      targetTeams: processedTeams,
      engineStrategy: cleanStrategy,
      hasTopics: cleanHasTopics,
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
            maxPoints: Number(req.body.maxPoints) || 10,
            baseTimeThresholdSec: Number(req.body.baseTimeThresholdSec) || 0,
            estimatedDurationMin: Number(req.body.estimatedDurationMin) || 0,
          }
        });
      } catch (cardErr) {
        await module.deleteOne();
        return res.status(400).json({ message: 'Failed to create sandbox card: ' + cardErr.message });
      }
    }

    return res.status(201).json(module);
  } catch (err) {
    return res.status(400).json({ message: err.message });
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
    Object.assign(targetModule, req.body);
    const updatedModule = await targetModule.save();

    if (isHtmlSandboxModule) {
      const cardContentUpdate = {};
      if (req.body.htmlSource !== undefined) cardContentUpdate['content.htmlSource'] = req.body.htmlSource;
      if (req.body.maxPoints !== undefined) cardContentUpdate['content.maxPoints'] = Number(req.body.maxPoints);
      if (req.body.baseTimeThresholdSec !== undefined) cardContentUpdate['content.baseTimeThresholdSec'] = Number(req.body.baseTimeThresholdSec);
      if (req.body.estimatedDurationMin !== undefined) cardContentUpdate['content.estimatedDurationMin'] = Number(req.body.estimatedDurationMin);
      if (req.body.title !== undefined) cardContentUpdate['content.title'] = req.body.title;

      if (Object.keys(cardContentUpdate).length > 0) {
        await Card.findOneAndUpdate(
          { module_id: targetModule._id, card_type: 'html_sandbox' },
          { $set: cardContentUpdate }
        );
      }
    }

    return res.json(updatedModule);
  } catch (err) {
    return res.status(400).json({ message: err.message });
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

    await module.deleteOne();
    return res.json({ success: true, message: "Purge execution resolved successfully." });
  } catch (err) {
    return res.status(500).json({ message: err.message });
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
    return res.status(400).json({ message: err.message });
  }
});

// =========================================================================
// ⭐ 9. PATCH /api/modules/:id/popular — "Popular Modules" row toggle, capped at 4
// =========================================================================
router.patch("/:id/popular", [auth, admin], async (req, res) => {
  try {
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
    return res.status(400).json({ message: err.message });
  }
});

module.exports = router;