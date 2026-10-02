// src/routes/categoryRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Category = require("../models/Category");
const Module = require("../models/Module");
const Region = require("../models/Region");
const { getOrCreateUncategorizedCategory } = require("../utils/defaultCategory");
const { toIdArray, resolveOwnedTeamIds, buildRegionMatch, passesRegionScope } = require("../utils/scopeHelpers");
// Generic "does this doc's .departments array contain X" helpers — written
// against Module originally, but the shape (a plain `departments` array of
// ObjectId refs) is identical on Category, so they're reused as-is rather
// than duplicated.
const { moduleHasDept: docHasDept, moduleDeptIds: docDeptIds } = require("../utils/moduleDepartments");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const { handleError } = require("../utils/safeError");

// 🛡️ Same visibility gate as Module's assertModuleViewAccess, applied to a
// Category doc instead — a Department Admin/learner can only see a
// Departmental/Team-Specific tag that actually targets their own
// department/team; Superadmin unrestricted.
const assertCategoryViewAccess = (categoryData, req) => {
  if (req.user.role === "superadmin") return { ok: true };

  const contextUser = req.user.user ? req.user.user : req.user;
  const userDeptStr = contextUser.department?.toString();
  const userTeamStr = contextUser.team?.toString();

  if (categoryData.visibility === "Departmental" && !docHasDept(categoryData, userDeptStr)) {
    return { ok: false, status: 403, message: "Access Denied: Foreign Department tag locked." };
  }

  if (categoryData.visibility === "Team-Specific") {
    if (!docHasDept(categoryData, userDeptStr)) {
      return { ok: false, status: 403, message: "Access Denied: Foreign Department tag locked." };
    }
    const hasTeamAccess = (categoryData.targetTeams || []).some((tId) => tId.toString() === userTeamStr);
    if (!hasTeamAccess) {
      return { ok: false, status: 403, message: "Access Denied: Locked for your specific team scope." };
    }
  }

  if (!passesRegionScope(categoryData, req)) {
    return { ok: false, status: 403, message: "Access Denied: Not available in your region." };
  }

  return { ok: true };
};

// =========================================================================
// @route   GET /api/categories
// @desc    Categories ("tags") visible to the requesting user — same
//          three-layer visibility RBAC as GET /api/modules. Guarantees the
//          permanent "Uncategorized" bucket exists (Global, so always
//          included for everyone).
// @access  Private (any authenticated user)
// =========================================================================
router.get("/", auth, async (req, res) => {
  try {
    await getOrCreateUncategorizedCategory();

    const isSuperAdmin = req.user.role === "superadmin";
    const isAdmin = req.user.role === "admin";
    const contextUser = req.user.user ? req.user.user : req.user;
    const userDepartmentId = contextUser.department;
    const userTeamId = contextUser.team;

    let matchCriteria = {};

    if (isSuperAdmin) {
      matchCriteria = {};
    } else if (isAdmin) {
      if (!userDepartmentId) {
        return res.status(400).json({ success: false, message: "Admin department context is missing." });
      }
      matchCriteria = {
        $or: [
          { visibility: "Global" },
          { departments: new mongoose.Types.ObjectId(userDepartmentId.toString()) },
        ],
      };
    } else {
      if (!userDepartmentId) {
        return res.status(400).json({ success: false, message: "User department context is missing." });
      }
      const targetDeptObjectId = new mongoose.Types.ObjectId(userDepartmentId.toString());
      const conditions = [
        { visibility: "Global" },
        { visibility: "Departmental", departments: targetDeptObjectId },
      ];
      if (userTeamId && userTeamId.toString().trim() !== "") {
        conditions.push({
          visibility: "Team-Specific",
          departments: targetDeptObjectId,
          targetTeams: new mongoose.Types.ObjectId(userTeamId.toString()),
        });
      }
      matchCriteria = { $or: conditions };
    }

    // 🌍 Narrow further by the requesting user's own region(s), if any —
    // combined via $and so it never disturbs the visibility $or above.
    const regionMatch = buildRegionMatch(contextUser.regions);
    if (regionMatch) {
      matchCriteria = Object.keys(matchCriteria).length > 0
        ? { $and: [matchCriteria, regionMatch] }
        : regionMatch;
    }

    const categories = await Category.find(matchCriteria).sort({ order: 1, name: 1 }).lean();
    return res.json({ success: true, data: categories });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// @route   GET /api/categories/:id
// =========================================================================
router.get("/:id", auth, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id).lean();
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }
    const accessCheck = assertCategoryViewAccess(category, req);
    if (!accessCheck.ok) {
      return res.status(accessCheck.status).json({ success: false, message: accessCheck.message });
    }
    return res.json({ success: true, data: category });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// @route   POST /api/categories
// @desc    Create a category/tag. Any Admin or Superadmin may create one —
//          scoped to their own department the same way module creation is
//          (Superadmin's submitted department list is trusted; a Department
//          Admin is always anchored to their own single department).
// @access  Private (Admin / Superadmin)
// =========================================================================
router.post("/", [auth, admin], async (req, res) => {
  try {
    const { name, description, order, visibility, departments, targetTeams, sequentialUnlock } = req.body;
    if (!name) {
      return res.status(400).json({ success: false, message: "Please provide a category name." });
    }

    const isSuperAdmin = req.user.role === "superadmin";
    const finalVisibility = visibility || "Global";
    const finalDepartments = isSuperAdmin ? toIdArray(departments) : [req.user.department.toString()];

    if (finalVisibility !== "Global" && finalDepartments.length === 0) {
      return res.status(400).json({ success: false, message: "At least one target department is required." });
    }

    const processedTeams = finalVisibility === "Team-Specific"
      ? await resolveOwnedTeamIds(targetTeams, finalDepartments)
      : [];

    const category = await Category.create({
      name: name.trim(),
      description: description ? description.trim() : "",
      order: Number.isFinite(order) ? order : 0,
      visibility: finalVisibility,
      departments: finalVisibility === "Global" ? [] : finalDepartments,
      targetTeams: processedTeams,
      sequentialUnlock: sequentialUnlock === undefined ? true : Boolean(sequentialUnlock),
      createdBy: req.user.id,
    });

    return res.status(201).json({ success: true, data: category });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "A category with this name already exists." });
    }
    return handleError(res, err, 400);
  }
});

// =========================================================================
// @route   PUT /api/categories/:id
// @desc    Same scope-change RBAC as PUT /api/modules/:id: Superadmin
//          unrestricted; a Department Admin can only touch a tag solely
//          scoped to their own department (or Global), and may only cross
//          the Global boundary on a tag they created themselves.
// @access  Private (Admin / Superadmin)
// =========================================================================
router.put("/:id", [auth, admin], async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    // The permanent default bucket can't be renamed, or ever pulled out of
    // Global — it must always be usable/visible by everyone.
    if (category.isDefault) {
      if (req.body.name !== undefined && req.body.name.trim() !== category.name) {
        return res.status(400).json({ success: false, message: "The default Uncategorized bucket can't be renamed." });
      }
      if (req.body.visibility !== undefined && req.body.visibility !== "Global") {
        return res.status(400).json({ success: false, message: "The default Uncategorized bucket must stay Global." });
      }
    }

    const isSuperAdmin = req.user.role === "superadmin";
    const incomingVisibility = req.body.visibility || category.visibility;

    if (!isSuperAdmin) {
      const existingDeptIds = docDeptIds(category);
      const ownDeptId = req.user.department.toString();
      const isSolelyOwnDept = existingDeptIds.length === 0
        || (existingDeptIds.length === 1 && existingDeptIds[0] === ownDeptId);
      if (!isSolelyOwnDept) {
        return res.status(403).json({ success: false, message: "Access Denied: Cannot modify foreign assets." });
      }

      const wasGlobal = category.visibility === "Global";
      const isVisibilityChanging = incomingVisibility !== category.visibility;
      const crossesGlobalBoundary = isVisibilityChanging && (incomingVisibility === "Global" || wasGlobal);
      const isOwner = category.createdBy && category.createdBy.toString() === req.user.id.toString();

      if (crossesGlobalBoundary && !isOwner) {
        return res.status(403).json({
          success: false,
          message: "Access Denied: Only this tag's creator can change its scope to or from Global.",
        });
      }

      if (incomingVisibility === "Global") {
        req.body.departments = [];
        req.body.targetTeams = [];
      } else {
        req.body.departments = [req.user.department];
        if (incomingVisibility === "Team-Specific") {
          req.body.targetTeams = await resolveOwnedTeamIds(req.body.targetTeams, req.user.department);
        } else {
          req.body.targetTeams = [];
        }
      }
    } else {
      if (incomingVisibility === "Global") {
        req.body.departments = [];
        req.body.targetTeams = [];
      } else {
        req.body.departments = toIdArray(req.body.departments);
        if (incomingVisibility === "Team-Specific" && req.body.targetTeams) {
          req.body.targetTeams = await resolveOwnedTeamIds(req.body.targetTeams, req.body.departments);
        } else if (incomingVisibility === "Departmental") {
          req.body.targetTeams = [];
        }
      }
    }

    if (req.body.name !== undefined) category.name = req.body.name.trim();
    if (req.body.description !== undefined) category.description = req.body.description;
    if (req.body.order !== undefined) category.order = req.body.order;
    if (req.body.sequentialUnlock !== undefined) category.sequentialUnlock = Boolean(req.body.sequentialUnlock);
    category.visibility = incomingVisibility;
    category.departments = req.body.departments;
    category.targetTeams = req.body.targetTeams;

    const updated = await category.save();
    return res.json({ success: true, data: updated });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "A category with this name already exists." });
    }
    return handleError(res, err, 400);
  }
});

// =========================================================================
// @route   DELETE /api/categories/:id
// @desc    Deletes the category. Never deletes any Module — every module
//          currently tagged with it is reassigned to the permanent
//          "Uncategorized" bucket. A Department Admin may only delete a tag
//          solely scoped to their own department (or Global).
// @access  Private (Admin / Superadmin)
// =========================================================================
router.delete("/:id", [auth, admin], async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }
    if (category.isDefault) {
      return res.status(400).json({ success: false, message: "The default Uncategorized bucket can't be deleted." });
    }

    if (req.user.role !== "superadmin") {
      const existingDeptIds = docDeptIds(category);
      const isSolelyOwnDept = existingDeptIds.length === 0
        || (existingDeptIds.length === 1 && existingDeptIds[0] === req.user.department.toString());
      if (!isSolelyOwnDept) {
        return res.status(403).json({ success: false, message: "Forbidden: Deleting foreign department tags is banned." });
      }
    }

    const fallback = await getOrCreateUncategorizedCategory();
    await Module.updateMany(
      { categoryId: category._id },
      { $set: { categoryId: fallback._id } }
    );
    await category.deleteOne();

    return res.json({ success: true, message: "Category removed; its modules moved to Uncategorized." });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// @route   PUT /api/categories/:id/modules/order
// @desc    Sets the sequential-unlock order of modules in this category —
//          also the exact sequence the Tag -> Region -> Journey path lays
//          nodes out in (ModuleJourney.jsx), since neither the path nor the
//          old sequential-lock feature had their own separate ordering
//          concept; both simply read Module.order.
//
//          Two modes, both in one endpoint:
//          - Whole-category (no `regionId` in body): `moduleIds` must be
//            the FULL, newly-ordered array of every module in this
//            category — the original behavior, still what
//            AdminModuleReorderModal.jsx uses.
//          - One region bucket (`regionId` in body): `moduleIds` must be
//            exactly this region's CURRENT module subset for this category
//            (same set GET /api/regions/:id/modules?categoryId= returns),
//            in its desired new relative order. Modules outside that
//            bucket keep their existing relative order to each other —
//            only the bucket's own members get reshuffled among
//            themselves, wherever they currently sit in the category's
//            overall sequence. This is deliberately NOT a second,
//            independent per-region order field: Module.order stays the
//            one source of truth for a tag's sequence, and picking a
//            region bucket to reorder from is just a convenient FILTERED
//            view onto that same sequence — reordering it from India's
//            bucket and reordering the same shared modules from the "All"
//            bucket both edit the exact same underlying values.
// @access  Private (Admin / Superadmin)
// =========================================================================
router.put("/:id/modules/order", [auth, admin], async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    if (!category) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    if (req.user.role !== "superadmin") {
      const existingDeptIds = docDeptIds(category);
      const isSolelyOwnDept = existingDeptIds.length === 0
        || (existingDeptIds.length === 1 && existingDeptIds[0] === req.user.department.toString());
      if (!isSolelyOwnDept) {
        return res.status(403).json({ success: false, message: "Access Denied: Cannot reorder foreign assets." });
      }
    }

    const { moduleIds, regionId } = req.body;
    if (!Array.isArray(moduleIds) || moduleIds.length === 0) {
      return res.status(400).json({ success: false, message: "moduleIds must be a non-empty array." });
    }
    if (!moduleIds.every((id) => mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({ success: false, message: "moduleIds contains an invalid id." });
    }

    // Current full sequence for this category — the base we edit on top of
    // either way, so a partial (bucket) reorder has something to splice
    // the new subsequence into.
    const categoryModules = await Module.find({ categoryId: category._id }, "_id order regions")
      .sort({ order: 1, _id: 1 })
      .lean();
    const allIds = categoryModules.map((m) => m._id.toString());
    const submittedIds = moduleIds.map((id) => id.toString());

    let finalOrderIds;

    if (regionId && mongoose.Types.ObjectId.isValid(regionId)) {
      const region = await Region.findById(regionId).lean();
      if (!region) {
        return res.status(404).json({ success: false, message: "Region not found." });
      }

      // The bucket's actual current subset — same membership rule as
      // regionRoutes.js's GET /:id/modules.
      const bucketIdSet = new Set(
        categoryModules
          .filter((m) => (region.isDefault
            ? !(Array.isArray(m.regions) && m.regions.length > 0)
            : (m.regions || []).some((r) => r.toString() === region._id.toString())))
          .map((m) => m._id.toString())
      );
      const submittedSet = new Set(submittedIds);
      const matchesBucket = bucketIdSet.size === submittedSet.size
        && [...bucketIdSet].every((id) => submittedSet.has(id));
      if (!matchesBucket) {
        return res.status(400).json({
          success: false,
          message: "moduleIds must be exactly the set of modules currently in this region bucket.",
        });
      }

      // Walk the category's existing sequence; every time we pass a bucket
      // member, substitute the next id from the admin's new subsequence
      // instead — everything else stays exactly where it already was.
      const newSubsequence = [...submittedIds];
      finalOrderIds = allIds.map((id) => (bucketIdSet.has(id) ? newSubsequence.shift() : id));
    } else {
      // 🔒 Every submitted id must actually belong to THIS category —
      // rejects the whole request on a stale/tampered client payload
      // rather than silently moving a module into another category's chain.
      const submittedSet = new Set(submittedIds);
      const belongsToCategory = allIds.length === submittedSet.size
        && allIds.every((id) => submittedSet.has(id));
      if (!belongsToCategory) {
        return res.status(400).json({
          success: false,
          message: "moduleIds must be exactly the set of modules currently in this category.",
        });
      }
      finalOrderIds = submittedIds;
    }

    await Module.bulkWrite(
      finalOrderIds.map((id, index) => ({
        updateOne: { filter: { _id: id }, update: { $set: { order: index } } },
      }))
    );

    const reordered = await Module.find({ categoryId: category._id }, "_id title order")
      .sort({ order: 1 })
      .lean();

    return res.json({ success: true, data: reordered });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

module.exports = router;
