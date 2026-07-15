// seedNews.js (Run once: node seedNews.js)
//
// Seeds 2 demo News/Broadcast posts so the dashboard carousel has real,
// factual content to show instead of placeholder text. Both posts are
// original text paraphrasing real, publicly stated facts from
// https://iriscarbon.com/ (organizations served, filings processed,
// regulator count, acceptance rate) — no copied marketing copy, no
// hotlinked external images/video.
const mongoose = require("mongoose");
require("dotenv").config();

const News = require("./src/models/News");
const Department = require("./src/models/Department");
const User = require("./src/models/User");

const demoPosts = [
  {
    title: "IRIS CARBON: One Platform for Global Disclosure & XBRL Reporting",
    content:
      "IRIS CARBON unifies financial and regulatory disclosure workflows across multiple jurisdictions in a single platform — connecting data sources, automating XBRL/iXBRL tagging, and enabling direct submission to over 40 regulators worldwide. AI-assisted validation helps finance, legal, compliance, audit, and sustainability teams cut manual tagging work and reduce filing errors, all from one auditable layer.",
    contentType: "text",
    isBreaking: false,
    scope: "Global",
  },
  {
    title: "Milestone: 7,000+ Filings, 500+ Organizations Served",
    content:
      "The Carbon team has now supported 500+ organizations through more than 7,000 regulatory filings, maintaining a first-time acceptance rate of roughly 99%. Great work from everyone contributing to this platform's accuracy and reliability.",
    contentType: "text",
    isBreaking: true,
    scope: "Departmental",
    departmentCode: "CARBON",
  },
];

async function seedNews() {
  try {
    console.log("📡 Connecting to MongoDB...");
    await mongoose.connect(
      process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://localhost:27017/xbrl_app"
    );
    console.log("✅ Connection established.");

    const author =
      (await User.findOne({ role: "superadmin" })) || (await User.findOne({ role: "admin" }));
    if (!author) {
      console.error(
        "❌ No superadmin or admin user found — cannot seed News posts without a createdBy author. Create an admin user first."
      );
      return process.exit(1);
    }

    for (const post of demoPosts) {
      const existing = await News.findOne({ title: post.title });
      if (existing) {
        console.log(`⏭️  Skipping (already exists): "${post.title}"`);
        continue;
      }

      let departmentId = null;
      if (post.scope === "Departmental") {
        const dept = await Department.findOne({ code: post.departmentCode });
        if (!dept) {
          console.warn(
            `⚠️  Department code "${post.departmentCode}" not found — skipping "${post.title}". Run seedDepartments.js first.`
          );
          continue;
        }
        departmentId = dept._id;
      }

      await News.create({
        title: post.title,
        content: post.content,
        contentType: post.contentType,
        isBreaking: post.isBreaking,
        scope: post.scope,
        department: departmentId,
        createdBy: author._id,
      });
      console.log(`🚀 Seeded: "${post.title}"`);
    }

    console.log("🎉 News seeding complete.");
    process.exit();
  } catch (error) {
    console.error("❌ Seeding failure exception:", error);
    process.exit(1);
  }
}

seedNews();
