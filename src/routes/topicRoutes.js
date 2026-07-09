// src/routes/topicRoutes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Module = require("../models/Module");
const Topic = require("../models/Topic");
const Card = require("../models/Card");
const cloudinary = require("../config/cloudinary");
const upload = require("../middleware/multer");

const auth = require("../middleware/auth");
const admin = require("../middleware/admin");

const getDepartmentIdString = (doc) => {
  if (!doc) return null;
  return doc._id ? doc._id.toString() : doc.toString();
};

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

      if (
        moduleData.visibility === "Departmental" &&
        modDeptStr !== userDeptStr
      ) {
        return res
          .status(403)
          .json({
            success: false,
            message: "Access Denied: Foreign Department content locked.",
          });
      }

      if (moduleData.visibility === "Team-Specific") {
        if (modDeptStr !== userDeptStr) {
          return res
            .status(403)
            .json({
              success: false,
              message: "Access Denied: Foreign Department content locked.",
            });
        }
        const hasTeamAccess = moduleData.targetTeams.some(
          (tId) => tId.toString() === userTeamStr,
        );
        if (!hasTeamAccess) {
          return res
            .status(403)
            .json({
              success: false,
              message: "Access Denied: Locked for your specific team scope.",
            });
        }
      }
    }

    let structuralPayload = {
      ...moduleData.toObject(),
      id: moduleData._id.toString(),
    };

    // 🔀 ADAPTIVE RENDERING MATRIX STRATEGY
    const strategy = moduleData.engineStrategy || 'STANDARD';
    const isExpressFlatPipeline = strategy === 'EXPRESS_FLAT' || moduleData.hasTopics === false;

    if (!isExpressFlatPipeline) {
      // Pathway A: Standard layout loader path maps nested sub-topics
      const topics = await Topic.find({ module_id: moduleData._id })
        .sort({ topicOrder: 1 })
        .lean();
      const topicIds = topics.map((t) => t._id);

      const allCards = await Card.find({ topic_id: { $in: topicIds } })
        .sort({ cardOrder: 1 })
        .lean();

      structuralPayload.topics = topics.map((topic) => ({
        ...topic,
        id: topic._id.toString(),
        cards: allCards
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
                // Support standalone inline sandboxes safely inside a multi-topic syllabus mapping structure
                htmlSource: card.card_type === "html_sandbox" ? (contentObj.htmlSource || contentObj.text || "") : "",
                options: safeOptions || [],
                correctIndex: safeCorrectIndex !== undefined ? safeCorrectIndex : 0,
                explanation: safeExplanation || ""
              }
            };
          }),
      }));
      structuralPayload.cards = [];
    } else {
      // 🚀 Pathway B: Compact Express layout pathway pulls card arrays tied directly to module root
      const directCards = await Card.find({ module_id: moduleData._id })
        .sort({ cardOrder: 1 })
        .lean();

      structuralPayload.cards = directCards.map((card) => {
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
            // Extract code directly out of 'htmlSource' or fallback content structures for flat tracks
            htmlSource: card.card_type === "html_sandbox" ? (contentObj.htmlSource || contentObj.text || "") : "",
            options: safeOptions || [],
            correctIndex: safeCorrectIndex !== undefined ? safeCorrectIndex : 0,
            explanation: safeExplanation || ""
          }
        };
      });
      structuralPayload.topics = []; // Emptied cleanly so front-end avoids type exceptions
    }

    return res.json(structuralPayload);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// =========================================================================
// 👁️ 2. GET /api/topics/cards/:id (SECURED HYBRID PATHWAYS)
// =========================================================================
router.get("/cards/:id", auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Card Resource Token format.",
      });
    }

    const card = await Card.findById(req.params.id).lean();
    if (!card) return res.status(404).json({ message: "Card not found" });

    let linkedModule = null;
    if (card.topic_id) {
      const targetTopic = await Topic.findById(card.topic_id);
      if (!targetTopic)
        return res
          .status(404)
          .json({ message: "Orphaned reference structural segment." });
      linkedModule = await Module.findById(targetTopic.module_id);
    } else {
      linkedModule = await Module.findById(card.module_id);
    }

    if (!linkedModule)
      return res
        .status(404)
        .json({ message: "Target lineage module context missing." });

    if (req.user.role !== "superadmin") {
      const userDeptStr = req.user.department?.toString();
      const userTeamStr = req.user.team?.toString();
      const modDeptStr = getDepartmentIdString(linkedModule.department);

      if (linkedModule.visibility !== "Global" && modDeptStr !== userDeptStr) {
        return res.status(403).json({
          success: false,
          message: "Access Denied: Cross tenant data mapping is forbidden.",
        });
      }

      if (linkedModule.visibility === "Team-Specific") {
        const hasTeamAccess = linkedModule.targetTeams.some(
          (tId) => tId.toString() === userTeamStr,
        );
        if (!hasTeamAccess) {
          return res.status(403).json({
            success: false,
            message:
              "Access Denied: This card resource is locked for your team scope.",
          });
        }
      }
    }

    // Include baseline parameters fallback structures for single individual fetches
    const contentObj = card.content || {};
    const augmentedCard = {
      ...card,
      id: card._id.toString(),
      content: {
        ...contentObj,
        htmlSource: card.card_type === "html_sandbox" ? (contentObj.htmlSource || contentObj.text || "") : ""
      }
    };

    return res.json(augmentedCard);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// =========================================================================
// 🔒 3. POST /api/topics (TENANT LOCKED GUARD)
// =========================================================================
router.post("/", [auth, admin], async (req, res) => {
  const { module_id } = req.body;
  try {
    if (!mongoose.Types.ObjectId.isValid(module_id)) {
      return res.status(400).json({
        success: false,
        message: "Validation Exception: Invalid Parent Module structural code.",
      });
    }

    const targetModule = await Module.findById(module_id);
    if (!targetModule)
      return res.status(404).json({ message: "Parent module not found." });

    if (targetModule.hasTopics === false || targetModule.engineStrategy === 'EXPRESS_FLAT') {
      return res.status(400).json({
        success: false,
        message:
          "System Rejection: Cannot append sub-topics to flat direct-to-card express module topologies.",
      });
    }

    const targetDeptId = getDepartmentIdString(targetModule.department);
    if (
      req.user.role !== "superadmin" &&
      targetDeptId !== req.user.department.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Cannot create content outside your department.",
      });
    }

    const topic = new Topic(req.body);
    await topic.save();
    return res
      .status(201)
      .json({ ...topic.toObject(), id: topic._id.toString() });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// =========================================================================
// 🔒 4. PUT /api/topics/:id
// =========================================================================
router.put("/:id", [auth, admin], async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Topic Identity Sequence allocation.",
      });
    }

    const topic = await Topic.findById(req.params.id);
    if (!topic) return res.status(404).json({ message: "Topic not found" });

    const linkedModule = await Module.findById(topic.module_id);
    const targetDeptId = getDepartmentIdString(linkedModule.department);
    if (
      req.user.role !== "superadmin" &&
      targetDeptId !== req.user.department.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Modification of external assets is restricted.",
      });
    }

    const updatedTopic = await Topic.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true },
    ).lean();
    return res.json({ ...updatedTopic, id: updatedTopic._id.toString() });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// =========================================================================
// 🔒 5. DELETE /api/topics/:id (CASCADING PURGE)
// =========================================================================
router.delete("/:id", [auth, admin], async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid target resource code configuration rules.",
      });
    }

    const topic = await Topic.findById(req.params.id);
    if (!topic) return res.status(404).json({ message: "Topic not found" });

    const linkedModule = await Module.findById(topic.module_id);
    if (!linkedModule)
      return res
        .status(404)
        .json({ message: "Associated parent module not found" });

    const targetDeptId = getDepartmentIdString(linkedModule.department);
    if (
      req.user.role !== "superadmin" &&
      targetDeptId !== req.user.department.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Cross-tenant data purging is banned.",
      });
    }

    console.log(`🧹 Initiating cascading purge for Topic: ${topic._id}`);

    await Card.deleteMany({ topic_id: topic._id });

    if (mongoose.models.UserTopicProgress) {
      await mongoose.models.UserTopicProgress.deleteMany({
        topic_id: topic._id,
      });
    }
    if (mongoose.models.UserCardProgress) {
      await mongoose.models.UserCardProgress.deleteMany({
        topic_id: topic._id,
      });
    }

    await topic.deleteOne();
    return res.json({
      success: true,
      message:
        "Topic, its structural flashcards, and all matching user analytics matching logs deleted successfully.",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// =========================================================================
// 🔒 6. POST /api/topics/:targetId/cards (HYBRID INTEGRATION ENGINE)
// =========================================================================
router.post("/:targetId/cards", [auth, admin], async (req, res) => {
  try {
    const { card_type, cardOrder, imageUrl, content } = req.body;
    const targetId = req.params.targetId;

    if (!card_type || !cardOrder || !content) {
      return res.status(400).json({ message: "Missing required card fields." });
    }

    let topicId = null;
    let moduleId = null;
    let linkedModule = null;

    const isObjectIdValid = mongoose.Types.ObjectId.isValid(targetId);

    if (isObjectIdValid) {
      const possibleTopic = await Topic.findById(targetId);
      if (possibleTopic) {
        topicId = possibleTopic._id;
        linkedModule = await Module.findById(possibleTopic.module_id);
      } else {
        const possibleModule = await Module.findById(targetId);
        if (!possibleModule)
          return res
            .status(404)
            .json({ message: "Lineage parent component not tracked." });
        moduleId = possibleModule._id;
        linkedModule = possibleModule;
      }
    } else {
      const bodyModuleId = req.body.module_id || req.headers["x-module-id"];
      if (bodyModuleId && mongoose.Types.ObjectId.isValid(bodyModuleId)) {
        linkedModule = await Module.findById(bodyModuleId);
        if (!linkedModule)
          return res
            .status(404)
            .json({
              message:
                "Parent dynamic layout module tracking reference missing.",
            });
        moduleId = linkedModule._id;
      } else {
        return res.status(400).json({
          success: false,
          message:
            "Target sub-topic context allocation scope is required for Standard module layouts.",
        });
      }
    }

    const targetDeptId = getDepartmentIdString(linkedModule.department);
    if (
      req.user.role !== "superadmin" &&
      targetDeptId !== req.user.department.toString()
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Forbidden: Target structure falls into a different tenant grid.",
      });
    }

    const newCard = new Card({
      card_type,
      cardOrder: parseInt(cardOrder, 10),
      imageUrl: imageUrl || "",
      content: content,
      ...(topicId && { topic_id: topicId }),
      ...(moduleId && { module_id: moduleId }),
    });

    const card = await newCard.save();
    return res.status(201).json({
      success: true,
      card: { ...card.toObject(), id: card._id.toString() },
    });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// =========================================================================
// 🔒 7. PUT /api/topics/cards/:cardId
// =========================================================================
router.put("/cards/:cardId", [auth, admin], async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.cardId)) {
      return res.status(400).json({
        success: false,
        message: "Target card configuration matrix allocation is invalid.",
      });
    }

    const card = await Card.findById(req.params.cardId);
    if (!card) return res.status(404).json({ message: "Card not found" });

    let linkedModule = null;
    if (card.topic_id) {
      const targetTopic = await Topic.findById(card.topic_id);
      linkedModule = await Module.findById(targetTopic.module_id);
    } else {
      linkedModule = await Module.findById(card.module_id);
    }

    const targetDeptId = getDepartmentIdString(linkedModule.department);
    if (
      req.user.role !== "superadmin" &&
      targetDeptId !== req.user.department.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Modification of external assets is restricted.",
      });
    }

    const updatedCard = await Card.findByIdAndUpdate(
      req.params.cardId,
      req.body,
      { new: true, runValidators: true },
    ).lean();
    return res.json({ ...updatedCard, id: updatedCard._id.toString() });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
});

// =========================================================================
// 🔒 8. DELETE /api/topics/cards/:cardId
// =========================================================================
router.delete("/cards/:cardId", [auth, admin], async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.cardId)) {
      return res.status(400).json({
        success: false,
        message: "Target card sequence format check mismatch.",
      });
    }

    const card = await Card.findById(req.params.cardId);
    if (!card) return res.status(404).json({ message: "Card not found" });

    let linkedModule = null;
    if (card.topic_id) {
      const targetTopic = await Topic.findById(card.topic_id);
      linkedModule = await Module.findById(targetTopic.module_id);
    } else {
      linkedModule = await Module.findById(card.module_id);
    }

    const targetDeptId = getDepartmentIdString(linkedModule.department);
    if (
      req.user.role !== "superadmin" &&
      targetDeptId !== req.user.department.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: Deleting assets from foreign tenant is blocked.",
      });
    }

    console.log(`🧹 Initiating cascading purge for Card: ${card._id}`);

    if (mongoose.models.UserCardProgress) {
      await mongoose.models.UserCardProgress.deleteMany({ card_id: card._id });
    }

    await card.deleteOne();
    return res.json({
      success: true,
      message: "Card and tracking logs dropped successfully.",
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// =========================================================================
// 🔒 9. POST /api/topics/:targetId/cards/upload-video
// =========================================================================
router.post(
  "/:targetId/cards/upload-video",
  [auth, admin],
  upload.single("video"),
  async (req, res) => {
    try {
      const { title, description, cardOrder } = req.body;
      const targetId = req.params.targetId;

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Missing required raw video binary file stream.",
        });
      }

      let topicId = null;
      let moduleId = null;
      let linkedModule = null;

      const isObjectIdValid = mongoose.Types.ObjectId.isValid(targetId);

      if (isObjectIdValid) {
        const possibleTopic = await Topic.findById(targetId);
        if (possibleTopic) {
          topicId = possibleTopic._id;
          linkedModule = await Module.findById(possibleTopic.module_id);
        } else {
          const possibleModule = await Module.findById(targetId);
          if (!possibleModule)
            return res
              .status(404)
              .json({ message: "Parent lineage layout reference missing." });
          moduleId = possibleModule._id;
          linkedModule = possibleModule;
        }
      } else {
        const bodyModuleId = req.body.module_id;
        if (bodyModuleId && mongoose.Types.ObjectId.isValid(bodyModuleId)) {
          linkedModule = await Module.findById(bodyModuleId);
          if (!linkedModule)
            return res
              .status(404)
              .json({ message: "Module context reference not found." });
          moduleId = linkedModule._id;
        } else {
          return res.status(400).json({
            success: false,
            message:
              "Target sub-topic context allocation scope is required for Standard module layouts.",
          });
        }
      }

      const targetDeptId = getDepartmentIdString(linkedModule.department);
      if (
        req.user.role !== "superadmin" &&
        targetDeptId !== req.user.department.toString()
      ) {
        return res.status(403).json({
          success: false,
          message: "Forbidden Access Grid Tenant allocation.",
        });
      }

      const uploadStream = () => {
        return new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              resource_type: "video",
              folder: "xbrl-app-videos",
              chunk_size: 6000000,
            },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            },
          );
          stream.end(req.file.buffer);
        });
      };

      const cloudinaryResult = await uploadStream();

      const newCard = new Card({
        card_type: "video",
        cardOrder: parseInt(cardOrder || 1, 10),
        content: {
          title: title || "Untitled Video Resource",
          description: description || "Binary upload stream node deployment.",
          videoUrl: cloudinaryResult.secure_url,
          duration: `${Math.floor(cloudinaryResult.duration / 60)}:${Math.floor(cloudinaryResult.duration % 60)}`,
        },
        ...(topicId && { topic_id: topicId }),
        ...(moduleId && { module_id: moduleId }),
      });

      const card = await newCard.save();
      return res.status(201).json({
        success: true,
        card: { ...card.toObject(), id: card._id.toString() },
      });
    } catch (error) {
      console.error("❌ Binary creation error:", error);
      return res.status(500).json({ success: false, message: error.message });
    }
  },
);

// =========================================================================
// 🔒 10. POST /api/topics/:targetId/cards/upload-document
// =========================================================================
router.post(
  "/:targetId/cards/upload-document",
  [auth, admin],
  upload.single("document"),
  async (req, res) => {
    try {
      const { title, description, cardOrder, card_type } = req.body;
      const targetId = req.params.targetId;

      const normalType = (card_type || "pdf").toLowerCase().trim();
      if (!["pdf", "ppt"].includes(normalType)) {
        return res.status(400).json({
          success: false,
          message:
            "Validation Mismatch: Typology must be either 'pdf' or 'ppt'.",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "Missing document structural file binary buffer payload.",
        });
      }

      let topicId = null;
      let moduleId = null;
      let linkedModule = null;

      const isObjectIdValid = mongoose.Types.ObjectId.isValid(targetId);

      if (isObjectIdValid) {
        const possibleTopic = await Topic.findById(targetId);
        if (possibleTopic) {
          topicId = possibleTopic._id;
          linkedModule = await Module.findById(possibleTopic.module_id);
        } else {
          const possibleModule = await Module.findById(targetId);
          if (!possibleModule)
            return res
              .status(404)
              .json({
                message: "Parent lineage layout system target missing.",
              });
          moduleId = possibleModule._id;
          linkedModule = possibleModule;
        }
      } else {
        const bodyModuleId = req.body.module_id;
        if (bodyModuleId && mongoose.Types.ObjectId.isValid(bodyModuleId)) {
          linkedModule = await Module.findById(bodyModuleId);
          if (!linkedModule)
            return res
              .status(404)
              .json({ message: "Module infrastructure context missing." });
          moduleId = linkedModule._id;
        } else {
          return res.status(400).json({
            success: false,
            message:
              "Target sub-topic context allocation scope is required for Standard module layouts.",
          });
        }
      }

      const targetDeptId = getDepartmentIdString(linkedModule.department);
      if (
        req.user.role !== "superadmin" &&
        targetDeptId !== req.user.department?.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Forbidden Access Tenant boundary security loop rejected access.",
        });
      }

      const uploadStream = () => {
        return new Promise((resolve, reject) => {
          const cleanExtension = normalType === "ppt" ? "pptx" : "pdf";
          const stream = cloudinary.uploader.upload_stream(
            {
              resource_type: "raw",
              folder: "xbrl-app-documents",
              public_id: `DOC-${Date.now()}`,
              ext: `.${cleanExtension}`,
              headers: {
                "Content-Type":
                  normalType === "pdf"
                    ? "application/pdf"
                    : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              },
            },
            (error, result) => {
              if (error) return reject(error);
              resolve(result);
            },
          );
          stream.end(req.file.buffer);
        });
      };

      const cloudinaryResult = await uploadStream();
      if (!cloudinaryResult?.secure_url) {
        throw new Error(
          "Cloud bucket failed to generate distribution link location pointer.",
        );
      }

      const contentStructure = {
        title:
          (title || "").trim() || `Untitled ${normalType.toUpperCase()} Node`,
        description:
          (description || "").trim() ||
          "External cloud hosted specifications node reference.",
      };

      if (normalType === "ppt") {
        contentStructure.pptUrl = cloudinaryResult.secure_url;
      } else {
        contentStructure.pdfUrl = cloudinaryResult.secure_url;
      }

      const newCard = new Card({
        card_type: normalType,
        cardOrder: Math.max(1, parseInt(cardOrder || 1, 10)),
        content: contentStructure,
        ...(topicId && { topic_id: topicId }),
        ...(moduleId && { module_id: moduleId }),
      });

      newCard.markModified("content");
      const card = await newCard.save();

      return res.status(201).json({
        success: true,
        message:
          "Dynamic file component resource mounted and successfully active.",
        card: { ...card.toObject(), id: card._id.toString() },
      });
    } catch (error) {
      console.error("❌ Document injection system crashed completely:", error);
      return res.status(500).json({
        success: false,
        message:
          "Internal storage clustering infrastructure failed parameter integration loop.",
        error: error.message,
      });
    }
  },
);

// =========================================================================
// 🔒 11. PUT /api/topics/cards/upload-video/:cardId
// =========================================================================
router.put(
  "/cards/upload-video/:cardId",
  [auth, admin],
  upload.single("video"),
  async (req, res) => {
    try {
      const { title, description, cardOrder } = req.body;
      const cardId = req.params.cardId;

      if (!mongoose.Types.ObjectId.isValid(cardId)) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Target card tracking token descriptor is illegal.",
          });
      }

      const existingCard = await Card.findById(cardId);
      if (!existingCard)
        return res
          .status(404)
          .json({
            success: false,
            message: "Content resource node not found.",
          });

      let linkedModule = null;
      if (existingCard.topic_id) {
        const targetTopic = await Topic.findById(existingCard.topic_id);
        linkedModule = await Module.findById(targetTopic.module_id);
      } else {
        linkedModule = await Module.findById(existingCard.module_id);
      }

      const targetDeptId = getDepartmentIdString(linkedModule.department);
      if (
        req.user.role !== "superadmin" &&
        targetDeptId !== req.user.department.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Forbidden: Cloud streaming mutation is locked to your tenant.",
        });
      }

      if (title) existingCard.content.title = title;
      if (description !== undefined)
        existingCard.content.description = description;
      if (cardOrder) existingCard.cardOrder = parseInt(cardOrder, 10);

      if (req.file) {
        const uploadStream = () => {
          return new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              {
                resource_type: "video",
                folder: "xbrl-app-videos",
                chunk_size: 6000000,
              },
              (error, result) => {
                if (error) return reject(error);
                resolve(result);
              },
            );
            stream.end(req.file.buffer);
          });
        };

        const cloudinaryResult = await uploadStream();
        existingCard.content.videoUrl = cloudinaryResult.secure_url;
        existingCard.content.duration = `${Math.floor(cloudinaryResult.duration / 60)}:${Math.floor(cloudinaryResult.duration % 60)}`;
      }

      existingCard.markModified("content");
      const updatedCard = await existingCard.save();

      return res.status(200).json({
        success: true,
        card: { ...updatedCard.toObject(), id: updatedCard._id.toString() },
      });
    } catch (error) {
      console.error("❌ Video modification compilation error:", error);
      return res
        .status(500)
        .json({
          success: false,
          message: "Internal media cluster alteration engine failed.",
        });
    }
  },
);

// =========================================================================
// 🔒 12. PUT /api/topics/cards/upload-document/:cardId
// =========================================================================
router.put(
  "/cards/upload-document/:cardId",
  [auth, admin],
  upload.single("document"),
  async (req, res) => {
    try {
      const { title, description, cardOrder, card_type } = req.body;
      const cardId = req.params.cardId;

      if (!mongoose.Types.ObjectId.isValid(cardId)) {
        return res
          .status(400)
          .json({
            success: false,
            message: "Target card alteration token is illegal.",
          });
      }

      const existingCard = await Card.findById(cardId);
      if (!existingCard)
        return res
          .status(404)
          .json({
            success: false,
            message: "Document data node context not found.",
          });

      let linkedModule = null;
      if (existingCard.topic_id) {
        const targetTopic = await Topic.findById(existingCard.topic_id);
        linkedModule = await Module.findById(targetTopic.module_id);
      } else {
        linkedModule = await Module.findById(existingCard.module_id);
      }

      const targetDeptId = getDepartmentIdString(linkedModule.department);
      if (
        req.user.role !== "superadmin" &&
        targetDeptId !== req.user.department.toString()
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Forbidden: Cloud document mutation is locked to your tenant department grid.",
        });
      }

      if (card_type) existingCard.card_type = card_type.toLowerCase();
      if (cardOrder) existingCard.cardOrder = parseInt(cardOrder, 10);
      if (title) existingCard.content.title = title;
      if (description !== undefined)
        existingCard.content.description = description;

      if (req.file) {
        const uploadStream = () => {
          return new Promise((resolve, reject) => {
            const normalType = (
              card_type || existingCard.card_type
            ).toLowerCase();
            const stream = cloudinary.uploader.upload_stream(
              {
                resource_type: "raw",
                folder: "xbrl-app-documents",
                public_id: `DOC-${Date.now()}`,
                ...(normalType === "pdf" && { format: "pdf" }),
              },
              (error, result) => {
                if (error) return reject(error);
                resolve(result);
              },
            );
            stream.end(req.file.buffer);
          });
        };

        const cloudinaryResult = await uploadStream();
        const normalType = (card_type || existingCard.card_type).toLowerCase();

        if (normalType === "ppt") {
          existingCard.content.pptUrl = cloudinaryResult.secure_url;
          delete existingCard.content.pdfUrl;
        } else if (normalType === "pdf") {
          existingCard.content.pdfUrl = cloudinaryResult.secure_url;
          delete existingCard.content.pptUrl;
        }
      }

      existingCard.markModified("content");
      const updatedCard = await existingCard.save();

      return res.status(200).json({
        success: true,
        card: { ...updatedCard.toObject(), id: updatedCard._id.toString() },
      });
    } catch (error) {
      console.error("❌ Document modification compilation error:", error);
      return res
        .status(500)
        .json({
          success: false,
          message: "Internal document storage infrastructure mutation failed.",
        });
    }
  },
);

module.exports = router;