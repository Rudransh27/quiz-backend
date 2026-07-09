// src/routes/moduleRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Module = require("../models/Module");
const Topic = require("../models/Topic");
const Card = require("../models/Card");
const ModuleRating = require("../models/ModuleRating");
const progressController = require("../controllers/progressController");
const { computePointsReward } = require("../utils/pointsCalculator");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

const getDepartmentIdString = (doc) => {
  if (!doc) return null;
  return doc._id ? doc._id.toString() : doc.toString();
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
          { department: new mongoose.Types.ObjectId(userDepartmentId.toString()) }
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
        { visibility: "Departmental", department: targetDeptObjectId }
      ];

      if (userTeamId && userTeamId.toString().trim() !== "") {
        conditions.push({
          visibility: "Team-Specific",
          department: targetDeptObjectId,
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
      // 🚀 Look up cards count for EXPRESS_FLAT strategy modules
      {
        $lookup: {
          from: "cards",
          localField: "_id",
          foreignField: "module_id",
          as: "allocatedCards"
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
          totalCardCount: { $size: "$allocatedCards" }
        }
      }
    ]);

    // pointsReward is derived (not stored) from totalCardCount + estimatedTime,
    // both already computed above — computed here in JS rather than as a second
    // Mongo aggregation expression so the formula only ever lives in one place.
    const dataWithPoints = workspaceModules.map((mod) => ({
      ...mod,
      pointsReward: computePointsReward(mod.totalCardCount, mod.estimatedTime),
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
          { department: new mongoose.Types.ObjectId(userDepartmentId.toString()) }
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
        { visibility: "Departmental", department: targetDeptObjectId }
      ];

      if (userTeamId && userTeamId.toString().trim() !== "") {
        conditions.push({
          visibility: "Team-Specific",
          department: targetDeptObjectId,
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
        $lookup: {
          from: "departments",
          localField: "department",
          foreignField: "_id",
          as: "departmentDetails",
        },
      },
      {
        $unwind: {
          path: "$departmentDetails",
          preserveNullAndEmptyArrays: true,
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
          department: "$departmentDetails",
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
    if (req.user.role !== "superadmin") {
      const contextUser = req.user.user ? req.user.user : req.user;
      const userDeptStr = contextUser.department?.toString();
      const userTeamStr = contextUser.team?.toString();
      const modDeptStr = moduleData.department?.toString();

      if (moduleData.visibility === "Departmental" && modDeptStr !== userDeptStr) {
        return res.status(403).json({ success: false, message: "Access Denied: Foreign Department content locked." });
      }

      if (moduleData.visibility === "Team-Specific") {
        if (modDeptStr !== userDeptStr) {
          return res.status(403).json({ success: false, message: "Access Denied: Foreign Department content locked." });
        }
        const hasTeamAccess = moduleData.targetTeams.some(tId => tId.toString() === userTeamStr);
        if (!hasTeamAccess) {
          return res.status(403).json({ success: false, message: "Access Denied: Locked for your specific team scope." });
        }
      }
    }

    let structuralPayload = {
      ...moduleData.toObject(),
      id: moduleData._id.toString()
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
      structuralPayload.pointsReward = computePointsReward(normalizedCards.length, moduleData.estimatedTime);
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
          pointsReward: computePointsReward(matchingCards.length, topic.estimatedTime)
        };
      });

      structuralPayload.cards = [];
      structuralPayload.pointsReward = computePointsReward(allCards.length, moduleData.estimatedTime);
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
      if (targetModule.department.toString() !== contextUser.department.toString()) {
        return res.status(403).json({ message: "Forbidden: Rating cross-department modules is restricted." });
      }
    }

    await ModuleRating.findOneAndUpdate(
      { user_id: userId, module_id: moduleId },
      { 
        rating, 
        reviewText,
        department_id: targetModule.department || contextUser.department 
      },
      { upsert: true, new: true },
    );
    return res.json({ success: true, message: "Thank you for rating this module!" });
  } catch (err) {
    return res.status(500).json({ message: "Rating submission failed." });
  }
});

// =========================================================================
// 🔒 4. POST /api/modules (ADMIN STRAT LOADER)
// =========================================================================
router.post("/", [auth, admin], async (req, res) => {
  try {
    const isSuperAdmin = req.user.role === "superadmin";
    const { visibility, department, targetTeams, engineStrategy } = req.body;

    const finalDepartment = isSuperAdmin ? department : req.user.department;

    if (visibility !== "Global" && !finalDepartment) {
      return res.status(400).json({ success: false, message: "Department reference ID field is missing." });
    }

    let processedTeams = [];
    if (visibility === "Team-Specific" && targetTeams) {
      processedTeams = Array.isArray(targetTeams) 
        ? targetTeams.map(t => new mongoose.Types.ObjectId(t.toString()))
        : [new mongoose.Types.ObjectId(targetTeams.toString())];
    }

    const isHtmlSandboxModule = req.body.moduleType === 'html_sandbox';
    const cleanStrategy = isHtmlSandboxModule ? 'EXPRESS_FLAT' : (engineStrategy || 'STANDARD');
    const cleanHasTopics = isHtmlSandboxModule ? false : cleanStrategy === 'STANDARD';

    const newModule = new Module({
      ...req.body,
      department: visibility === "Global" ? null : finalDepartment,
      visibility,
      targetTeams: processedTeams,
      engineStrategy: cleanStrategy,
      hasTopics: cleanHasTopics
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
            maxPoints: Number(req.body.maxPoints) || 15,
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

    if (req.user.role !== "superadmin") {
      if (targetModule.department && targetModule.department.toString() !== req.user.department.toString()) {
        return res.status(403).json({ message: "Access Denied: Cannot modify foreign assets." });
      }
      req.body.department = targetModule.department;
    }

    if (req.body.visibility === "Team-Specific" && req.body.targetTeams) {
      req.body.targetTeams = Array.isArray(req.body.targetTeams)
        ? req.body.targetTeams.map(t => new mongoose.Types.ObjectId(t.toString()))
        : [new mongoose.Types.ObjectId(req.body.targetTeams.toString())];
    } else if (req.body.visibility === "Departmental") {
      req.body.targetTeams = []; 
    }

    if (req.body.engineStrategy) {
      req.body.hasTopics = req.body.engineStrategy === 'STANDARD';
    }

    const isHtmlSandboxModule = targetModule.moduleType === 'html_sandbox';
    if (isHtmlSandboxModule) {
      req.body.engineStrategy = 'EXPRESS_FLAT';
      req.body.hasTopics = false;
    }

    const updatedModule = await Module.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true },
    );

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
      if (module.department && module.department.toString() !== req.user.department.toString()) {
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