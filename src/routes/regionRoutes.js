// src/routes/regionRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Region = require("../models/Region");
const Category = require("../models/Category");
const Module = require("../models/Module");
const User = require("../models/User");
const { moduleHasDept: docHasDept } = require("../utils/moduleDepartments");
const { getOrCreateAllRegion } = require("../utils/defaultRegion");

// A doc's `regions` array may be entirely absent on old documents, not just
// empty — this fragment covers both, matching buildRegionMatch's tolerance.
const UNRESTRICTED_MATCH = { $or: [{ regions: { $exists: false } }, { regions: { $size: 0 } } ] };

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");
const superadmin = require("../middleware/superadmin");
const { handleError } = require("../utils/safeError");

// 🛡️ "Can this admin manage this Category/Module doc at all" — the SAME
// Global-or-own-department authority GET /api/categories and GET /api/modules
// already grant an Admin over their own inventory (Team-Specific narrowing
// is intentionally not re-checked here, matching how those list endpoints
// already treat "own department" as sufficient management authority).
// Deliberately independent of the doc's `regions` field and of the
// requesting admin's own `req.user.regions` — region-mapping authority comes
// from department ownership, not from which region the admin personally
// consumes content in.
const canAdminAccessDoc = (doc, req) => {
  if (req.user.role === "superadmin") return true;
  if (!req.user.department) return false;
  if (doc.visibility === "Global") return true;
  return docHasDept(doc, req.user.department.toString());
};

// Same Global-or-own-department $or fragment as the doc-level check above,
// expressed as a Mongo match — powers the "available to assign" pickers.
const adminScopeMatch = (req) => {
  if (req.user.role === "superadmin") return {};
  return {
    $or: [
      { visibility: "Global" },
      { departments: new mongoose.Types.ObjectId(req.user.department.toString()) },
    ],
  };
};

// =========================================================================
// @route   GET /api/regions
// @desc    List every region with its assigned tag/module counts. Public —
//          same as GET /api/departments — since the registration form needs
//          this list BEFORE the visitor has an account/token, not just the
//          logged-in admin mapping tool and profile page.
// @access  Public
// =========================================================================
router.get("/", async (req, res) => {
  try {
    await getOrCreateAllRegion();
    const regions = await Region.find().sort({ isDefault: -1, order: 1, name: 1 }).lean();
    const regionIds = regions.map((r) => r._id);

    const [tagCounts, moduleCounts, unrestrictedTagCount, unrestrictedModuleCount] = await Promise.all([
      Category.aggregate([
        { $match: { regions: { $in: regionIds } } },
        { $unwind: "$regions" },
        { $group: { _id: "$regions", count: { $sum: 1 } } },
      ]),
      Module.aggregate([
        { $match: { regions: { $in: regionIds } } },
        { $unwind: "$regions" },
        { $group: { _id: "$regions", count: { $sum: 1 } } },
      ]),
      // "All"'s own id is never stored on a doc (see the model comment) —
      // its count is instead every doc with NO specific region set.
      Category.countDocuments(UNRESTRICTED_MATCH),
      Module.countDocuments(UNRESTRICTED_MATCH),
    ]);
    const tagCountMap = new Map(tagCounts.map((c) => [c._id.toString(), c.count]));
    const moduleCountMap = new Map(moduleCounts.map((c) => [c._id.toString(), c.count]));

    const data = regions.map((r) => ({
      ...r,
      tagCount: r.isDefault ? unrestrictedTagCount : (tagCountMap.get(r._id.toString()) || 0),
      moduleCount: r.isDefault ? unrestrictedModuleCount : (moduleCountMap.get(r._id.toString()) || 0),
    }));

    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// @route   GET /api/regions/:id
// =========================================================================
router.get("/:id", auth, async (req, res) => {
  try {
    const region = await Region.findById(req.params.id).lean();
    if (!region) {
      return res.status(404).json({ success: false, message: "Region not found" });
    }
    return res.json({ success: true, data: region });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// @route   POST /api/regions
// @desc    Create a region — a strategic, platform-wide construct like
//          Department, so this is Superadmin-only (not delegated to
//          Department Admins the way tag/module creation is).
// @access  Private (Superadmin)
// =========================================================================
router.post("/", [auth, superadmin], async (req, res) => {
  try {
    const { name, code, description, color, order } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Please provide a region name." });
    }

    const region = await Region.create({
      name: name.trim(),
      code: code ? code.trim().toUpperCase() : "",
      description: description ? description.trim() : "",
      color: color || "#6366f1",
      order: Number.isFinite(order) ? order : 0,
      createdBy: req.user.id,
    });

    return res.status(201).json({ success: true, data: region });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "A region with this name already exists." });
    }
    return handleError(res, err, 400);
  }
});

// =========================================================================
// @route   PUT /api/regions/:id
// @access  Private (Superadmin)
// =========================================================================
router.put("/:id", [auth, superadmin], async (req, res) => {
  try {
    const region = await Region.findById(req.params.id);
    if (!region) {
      return res.status(404).json({ success: false, message: "Region not found" });
    }

    const { name, code, description, color, order } = req.body;
    if (region.isDefault) {
      if (name !== undefined && name.trim() !== region.name) {
        return res.status(400).json({ success: false, message: "The permanent \"All\" region can't be renamed." });
      }
      if (code !== undefined && code.trim().toUpperCase() !== region.code) {
        return res.status(400).json({ success: false, message: "The permanent \"All\" region's code can't be changed." });
      }
    } else if (name !== undefined) {
      region.name = name.trim();
    }
    if (!region.isDefault && code !== undefined) region.code = code.trim().toUpperCase();
    if (description !== undefined) region.description = description;
    if (color !== undefined) region.color = color;
    if (order !== undefined) region.order = order;

    const updated = await region.save();
    return res.json({ success: true, data: updated });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "A region with this name already exists." });
    }
    return handleError(res, err, 400);
  }
});

// =========================================================================
// @route   DELETE /api/regions/:id
// @desc    Deletes the region. Never deletes any Category/Module/User — it
//          just $pulls the region id out of every doc that referenced it,
//          which naturally falls back to "unrestricted" everywhere (empty
//          `regions` array), exactly like removing any other optional tag.
// @access  Private (Superadmin)
// =========================================================================
router.delete("/:id", [auth, superadmin], async (req, res) => {
  try {
    const region = await Region.findById(req.params.id);
    if (!region) {
      return res.status(404).json({ success: false, message: "Region not found" });
    }
    if (region.isDefault) {
      return res.status(400).json({ success: false, message: "The permanent \"All\" region can't be deleted." });
    }

    await Promise.all([
      Category.updateMany({ regions: region._id }, { $pull: { regions: region._id } }),
      Module.updateMany({ regions: region._id }, { $pull: { regions: region._id } }),
      User.updateMany({ regions: region._id }, { $pull: { regions: region._id } }),
    ]);
    await region.deleteOne();

    return res.json({ success: true, message: "Region removed; assigned tags/modules/users are now unrestricted." });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// @route   GET /api/regions/:id/tag-breakdown
// @desc    For one region, every tag that actually has ≥1 module a learner
//          in that region would see (same "All ∪ region-specific" union as
//          GET /by-tag/:categoryId, just pivoted — fixed region, varying
//          tag). Read-only — powers the "By Region" view's content
//          overview. Editing which modules land in a bucket always happens
//          through the "By Tag" view (POST/DELETE .../modules/:moduleId
//          above), not here.
// @access  Private (Admin / Superadmin)
// =========================================================================
router.get("/:id/tag-breakdown", [auth, admin], async (req, res) => {
  try {
    const region = await Region.findById(req.params.id).lean();
    if (!region) {
      return res.status(404).json({ success: false, message: "Region not found" });
    }
    const tags = await Category.find().select("name").lean();
    const regionFilter = region.isDefault ? UNRESTRICTED_MATCH : { $or: [...UNRESTRICTED_MATCH.$or, { regions: region._id }] };

    const counts = await Promise.all(
      tags.map((t) => Module.countDocuments({ categoryId: t._id, ...regionFilter }))
    );

    const data = tags
      .map((t, i) => ({ _id: t._id, name: t.name, moduleCount: counts[i] }))
      .filter((t) => t.moduleCount > 0)
      .sort((a, b) => b.moduleCount - a.moduleCount);

    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// TAG (Category) MAPPING
// =========================================================================

// GET /api/regions/:id/tags — every tag actually VISIBLE to a learner
// scoped to this region — i.e. the same union GET /api/categories itself
// uses to decide tag-grid visibility: unrestricted (Global-region) tags
// ALWAYS included, plus any tag specifically restricted to this region.
// Showing only the specific-assignment subset here (the old behavior)
// directly contradicted the "Content in this region, by tag" panel, which
// already used the full union — a tag with real modules in this region
// would show 0 in "assigned tags" while still showing up with a real count
// in the content breakdown right next to it. For the permanent "All"
// region this is just every unrestricted tag (nothing ever stores All's
// own id — see the model comment).
router.get("/:id/tags", [auth, admin], async (req, res) => {
  try {
    const region = await Region.findById(req.params.id).lean();
    if (!region) {
      return res.status(404).json({ success: false, message: "Region not found" });
    }
    const matchCriteria = region.isDefault
      ? UNRESTRICTED_MATCH
      : { $or: [...UNRESTRICTED_MATCH.$or, { regions: region._id }] };
    const tags = await Category.find(matchCriteria).sort({ order: 1, name: 1 }).lean();
    return res.json({ success: true, data: tags });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// GET /api/regions/:id/available-tags — tags this admin controls that are
// NOT yet assigned to this region (the "+ Add tag" picker's source list).
// For "All", that's every tag this admin controls that IS currently
// restricted to at least one specific region — adding one here clears it.
router.get("/:id/available-tags", [auth, admin], async (req, res) => {
  try {
    const region = await Region.findById(req.params.id).lean();
    if (!region) {
      return res.status(404).json({ success: false, message: "Region not found" });
    }
    const matchCriteria = region.isDefault
      ? { ...adminScopeMatch(req), regions: { $exists: true, $not: { $size: 0 } } }
      : { ...adminScopeMatch(req), regions: { $ne: region._id } };
    const tags = await Category.find(matchCriteria).sort({ order: 1, name: 1 }).lean();
    return res.json({ success: true, data: tags });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// POST /api/regions/:id/tags/:tagId — assign one tag to this region. For
// "All" this CLEARS the tag's `regions` array instead of storing an id —
// making it unrestricted is exactly what "belongs to All" means here.
router.post("/:id/tags/:tagId", [auth, admin], async (req, res) => {
  try {
    const [region, tag] = await Promise.all([
      Region.findById(req.params.id).lean(),
      Category.findById(req.params.tagId),
    ]);
    if (!region) return res.status(404).json({ success: false, message: "Region not found" });
    if (!tag) return res.status(404).json({ success: false, message: "Tag not found" });
    if (!canAdminAccessDoc(tag, req)) {
      return res.status(403).json({ success: false, message: "Access Denied: You don't control this tag." });
    }

    if (region.isDefault) {
      await Category.updateOne({ _id: tag._id }, { $set: { regions: [] } });
      return res.json({ success: true, message: "Tag is now visible in every region." });
    }
    await Category.updateOne({ _id: tag._id }, { $addToSet: { regions: region._id } });
    return res.json({ success: true, message: "Tag assigned to region." });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// DELETE /api/regions/:id/tags/:tagId — unassign one tag from this region.
// Doesn't apply to "All": there's nothing to $pull (its id is never
// stored) — to move a tag OUT of "All", assign it to a specific region
// instead, which naturally removes it from All's own (computed) list.
router.delete("/:id/tags/:tagId", [auth, admin], async (req, res) => {
  try {
    const [region, tag] = await Promise.all([
      Region.findById(req.params.id).lean(),
      Category.findById(req.params.tagId),
    ]);
    if (!region) return res.status(404).json({ success: false, message: "Region not found" });
    if (!tag) return res.status(404).json({ success: false, message: "Tag not found" });
    if (region.isDefault) {
      return res.status(400).json({ success: false, message: "Assign this tag to a specific region instead of removing it from \"All\"." });
    }
    if (!canAdminAccessDoc(tag, req)) {
      return res.status(403).json({ success: false, message: "Access Denied: You don't control this tag." });
    }

    await Category.updateOne({ _id: tag._id }, { $pull: { regions: region._id } });
    return res.json({ success: true, message: "Tag removed from region." });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// MODULE MAPPING
// =========================================================================

// Optional ?categoryId= narrowing shared by the two list endpoints below —
// powers the admin's Tag x Region bucket view ("Onboarding-US"): within one
// region, only show/offer modules that already belong to the selected tag.
const categoryFilterFromQuery = (req) => {
  const { categoryId } = req.query;
  if (categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
    return { categoryId: new mongoose.Types.ObjectId(categoryId) };
  }
  return {};
};

// GET /api/regions/:id/modules — modules currently assigned to this region.
// For "All" this means every UNRESTRICTED module (see the tags version above
// for why — nothing ever stores All's own id). Optional ?categoryId=.
router.get("/:id/modules", [auth, admin], async (req, res) => {
  try {
    const region = await Region.findById(req.params.id).lean();
    if (!region) {
      return res.status(404).json({ success: false, message: "Region not found" });
    }
    const matchCriteria = {
      ...(region.isDefault ? UNRESTRICTED_MATCH : { regions: region._id }),
      ...categoryFilterFromQuery(req),
    };
    const modules = await Module.find(matchCriteria)
      .select("title description imageUrl categoryId visibility order")
      .sort({ order: 1, title: 1 })
      .lean();
    return res.json({ success: true, data: modules });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// GET /api/regions/:id/available-modules — modules this admin controls that
// are NOT yet assigned to this region. For "All", that's every module this
// admin controls that IS currently restricted to at least one region.
// Optional ?categoryId=.
router.get("/:id/available-modules", [auth, admin], async (req, res) => {
  try {
    const region = await Region.findById(req.params.id).lean();
    if (!region) {
      return res.status(404).json({ success: false, message: "Region not found" });
    }
    const matchCriteria = {
      ...adminScopeMatch(req),
      ...(region.isDefault ? { regions: { $exists: true, $not: { $size: 0 } } } : { regions: { $ne: region._id } }),
      ...categoryFilterFromQuery(req),
    };
    const modules = await Module.find(matchCriteria)
      .select("title description imageUrl categoryId visibility")
      .sort({ title: 1 })
      .lean();
    return res.json({ success: true, data: modules });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// =========================================================================
// @route   GET /api/regions/by-tag/:categoryId
// @desc    For one tag, the module count EACH region would actually show a
//          learner (the "All" union, same semantics as the ?regionId=
//          filter on workspace-curriculum) — powers the admin's Tag x
//          Region bucket grid ("Onboarding-US: 7 modules", "Onboarding-
//          Europe: 5 modules", ...) so admins can see/manage a tag's whole
//          regional spread at a glance instead of one region at a time.
// @access  Private (Admin / Superadmin)
// =========================================================================
router.get("/by-tag/:categoryId", [auth, admin], async (req, res) => {
  try {
    const { categoryId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({ success: false, message: "Invalid tag id." });
    }
    await getOrCreateAllRegion();
    const regions = await Region.find().sort({ isDefault: -1, order: 1, name: 1 }).lean();
    const categoryObjectId = new mongoose.Types.ObjectId(categoryId);

    const counts = await Promise.all(
      regions.map((r) => {
        const regionFilter = r.isDefault ? UNRESTRICTED_MATCH : { $or: [...UNRESTRICTED_MATCH.$or, { regions: r._id }] };
        return Module.countDocuments({ categoryId: categoryObjectId, ...regionFilter });
      })
    );

    const data = regions.map((r, i) => ({ ...r, moduleCount: counts[i] }));
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// POST /api/regions/:id/modules/:moduleId — assign one module to this
// region. For "All" this CLEARS the module's `regions` array instead of
// storing an id.
router.post("/:id/modules/:moduleId", [auth, admin], async (req, res) => {
  try {
    const [region, mod] = await Promise.all([
      Region.findById(req.params.id).lean(),
      Module.findById(req.params.moduleId),
    ]);
    if (!region) return res.status(404).json({ success: false, message: "Region not found" });
    if (!mod) return res.status(404).json({ success: false, message: "Module not found" });
    if (!canAdminAccessDoc(mod, req)) {
      return res.status(403).json({ success: false, message: "Access Denied: You don't control this module." });
    }

    if (region.isDefault) {
      await Module.updateOne({ _id: mod._id }, { $set: { regions: [] } });
      return res.json({ success: true, message: "Module is now visible in every region." });
    }
    await Module.updateOne({ _id: mod._id }, { $addToSet: { regions: region._id } });
    return res.json({ success: true, message: "Module assigned to region." });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

// DELETE /api/regions/:id/modules/:moduleId — unassign one module. Doesn't
// apply to "All" — see the tags version above.
router.delete("/:id/modules/:moduleId", [auth, admin], async (req, res) => {
  try {
    const [region, mod] = await Promise.all([
      Region.findById(req.params.id).lean(),
      Module.findById(req.params.moduleId),
    ]);
    if (!region) return res.status(404).json({ success: false, message: "Region not found" });
    if (!mod) return res.status(404).json({ success: false, message: "Module not found" });
    if (region.isDefault) {
      return res.status(400).json({ success: false, message: "Assign this module to a specific region instead of removing it from \"All\"." });
    }
    if (!canAdminAccessDoc(mod, req)) {
      return res.status(403).json({ success: false, message: "Access Denied: You don't control this module." });
    }

    await Module.updateOne({ _id: mod._id }, { $pull: { regions: region._id } });
    return res.json({ success: true, message: "Module removed from region." });
  } catch (err) {
    return handleError(res, err, 500);
  }
});

module.exports = router;
