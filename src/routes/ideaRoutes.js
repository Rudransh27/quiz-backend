// src/routes/ideaRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const Idea = require("../models/Idea");
const mongoose = require("mongoose");
const { handleError } = require("../utils/safeError");

// 📥 1. POST A NEW CONCEPT (Private - Trainee Entry)
// @route   POST /api/ideas
// =========================================================================
router.post("/", auth, async (req, res) => {
  const { title, details, userName, userEmail, tag } = req.body;

  if (!title || !details || !tag) {
    return res.status(400).json({ success: false, message: "Missing required parameters." });
  }

  try {
    // Extract verified tenant identity parameters from user profile session
    const contextUser = req.user && req.user.user ? req.user.user : req.user;
    const userId = contextUser ? (contextUser.id || contextUser._id) : null;
    const departmentId = req.user.department;

    if (!departmentId) {
      return res.status(400).json({ success: false, message: "Tenant Error: User profile has no assigned department." });
    }

    const newIdea = new Idea({
      title: title.trim(),
      details: details.trim(),
      userName: userName.trim(),
      userEmail: userEmail.trim(),
      tag,
      userId,
      departmentId: new mongoose.Types.ObjectId(departmentId.toString())
    });

    await newIdea.save();

    res.status(201).json({
      success: true,
      message: "Idea submitted to the Product Council registry successfully!",
      data: newIdea
    });
  } catch (err) {
    console.error("❌ Idea Submission Error:", err.message);
    handleError(res, err, 500);
  }
});

// 📋 2. GET USER'S SUBMISSION HISTORY (Private - Trainee Personal Feed)
// @route   GET /api/ideas/my-history
// =========================================================================
router.get("/my-history", auth, async (req, res) => {
  try {
    const contextUser = req.user && req.user.user ? req.user.user : req.user;
    const userId = contextUser ? (contextUser.id || contextUser._id) : null;

    // Pull personal logs sorted with latest submissions appearing at the top
    const history = await Idea.find({ userId }).sort({ createdAt: -1 });
    res.json({ success: true, data: history });
  } catch (err) {
    console.error("❌ Fetch Personal Ideas History Fault:", err.message);
    handleError(res, err, 500);
  }
});

// 🏛️ 3. GET ALL PENDING IDEAS FOR PRODUCT COUNCIL REVIEW (Admin/Superadmin Only)
// @route   GET /api/ideas/council-board
// =========================================================================
router.get("/council-board", [auth, admin], async (req, res) => {
  try {
    let searchFilter = {};
    
    // Standard admins only see ideas originating within their explicit business line
    if (req.user.role === "admin") {
      searchFilter = { departmentId: new mongoose.Types.ObjectId(req.user.department.toString()) };
    }

    const boardReviewItems = await Idea.find(searchFilter).sort({ createdAt: -1 });
    res.json({ success: true, data: boardReviewItems });
  } catch (err) {
    handleError(res, err, 500);
  }
});

// ✏️ 4. ADMIN CURATOR FEEDBACK & STATUS TRANSITION (Admin/Superadmin Only)
// @route   PUT /api/ideas/:ideaId/curate
// =========================================================================
// src/routes/ideaRoutes.js
// Update your curation route handler block to include the XP gamification trigger:

router.put("/:ideaId/curate", [auth, admin], async (req, res) => {
  const { status, curatorFeedback } = req.body;
  const { ideaId } = req.params;

  try {
    // 1. Fetch the original idea log first to check its author ID / existence
    const originalIdea = await Idea.findById(ideaId);
    if (!originalIdea) {
      return res.status(404).json({ success: false, message: "Target idea log entity not found." });
    }

    // 1b. Department Admins may only curate ideas submitted within their own
    // department — mirrors the scoping /council-board already applies to the
    // idea listing itself. Without this, a Department Admin from Dept A could
    // approve/reject (and trigger XP payout for) an idea from Dept B just by
    // knowing/guessing its ideaId.
    if (req.user.role === "admin") {
      if (!req.user.department || originalIdea.departmentId.toString() !== req.user.department.toString()) {
        return res.status(403).json({ success: false, message: "Forbidden: This idea belongs to a different department." });
      }
    }

    // 2. Perform the update on the Idea document
    const updatedIdea = await Idea.findByIdAndUpdate(
      ideaId,
      { $set: { status, curatorFeedback: curatorFeedback.trim() } },
      { new: true, runValidators: true }
    );

    // 3. 🎯 THE XP GAMIFICATION ENGINE TRIGGER — made atomic and permanent:
    // `xpAwarded` is a persistent one-time flag (not a "current status"
    // check), so this closes two bugs at once — (a) two concurrent curate
    // requests racing on a stale `originalIdea.status` read could both pass
    // the old check, and (b) rejecting then re-approving the same idea used
    // to re-award +25 XP every single time. The findOneAndUpdate's filter
    // only matches (and only one caller can ever win it) if the flag hasn't
    // been set yet — this is the actual compare-and-swap, not the earlier
    // `originalIdea` read.
    if (status === "building") {
      const claimedAward = await Idea.findOneAndUpdate(
        { _id: ideaId, xpAwarded: { $ne: true } },
        { $set: { xpAwarded: true } }
      );

      if (claimedAward) {
        console.log(`🚀 [XP Engine] Awarding +25 XP to User ID: ${originalIdea.userId} for approved innovation.`);
        // 🔒 XP LEDGER: one award per idea, ever (idempotency key = idea id).
        const { awardXp } = require("../services/xpLedger");
        await awardXp({
          userId: originalIdea.userId,
          amount: 25,
          source: "idea",
          idempotencyKey: `idea:${ideaId}`,
          sourceId: ideaId,
        });
      }
    }

    res.json({
      success: true,
      message: status === "building" 
        ? "Idea accepted into development registry! +25 XP awarded to the trainee." 
        : "Curator changes saved cleanly.",
      data: updatedIdea
    });
  } catch (err) {
    console.error("❌ Curation processing error:", err.message);
    handleError(res, err, 500);
  }
});

module.exports = router;