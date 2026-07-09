// quiz-backend/seedModule.js
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const Module = require("./src/models/Module"); // Adjust path if needed
const Topic = require("./src/models/Topic");   // Adjust path if needed
const Card = require("./src/models/Card");    // Adjust path if needed

dotenv.config();

const seedCurriculumData = async () => {
  try {
    console.log("📡 Connecting to database cluster...");
    await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/xbrl_app");
    console.log("✅ Database connected successfully.");

    // 🧹 Clean cleanup loop to prevent duplicate entries while testing
    console.log("🧹 Purging old test entries for this specific module track...");
    const existingModule = await Module.findOne({ title: "IRIS DM - Disclosure Management" });
    if (existingModule) {
      const topics = await Topic.find({ module_id: existingModule._id });
      const topicIds = topics.map(t => t._id);
      await Card.deleteMany({ topic_id: { $in: topicIds } });
      await Topic.deleteMany({ module_id: existingModule._id });
      await Module.deleteOne({ _id: existingModule._id });
    }

    // =========================================================================
    // 📦 TIER 1: CREATE MODULE WRAPPER
    // =========================================================================
    console.log("📦 Creating Module entry...");
    const nextModule = new Module({
      title: "IRIS DM - Disclosure Management",
      description: "Master US SEC reporting compliance parameters, forms timelines, EDGAR platform navigation matrices, and foundational inline XBRL data-tagging rules.",
      imageUrl: "https://res.cloudinary.com/daug1ayvk/image/upload/v1781346788/xbrl-app/default-module.png",
      visibility: "Global",
      department: null, // Global access tier
      targetTeams: []
    });
    const savedModule = await nextModule.save();

    // =========================================================================
    // 🗂️ TIER 2: CREATE TOPIC LESSON TRACK
    // =========================================================================
    console.log("🗂️ Creating Topic folder...");
    const nextTopic = new Topic({
      module_id: savedModule._id,
      title: "Your Investors Read the 10-K. Do You?",
      description: "Comprehensive run-through covering 7 critical SEC files, interactive EDGAR verification drills, and practical XBRL mechanics.",
      topicOrder: 1,
      xpReward: 250
    });
    const savedTopic = await nextTopic.save();

    // =========================================================================
    // 📄 TIER 3: SEED DYNAMIC TEMPLATE AND STANDALONE ACTIVITY CARDS
    // =========================================================================
    console.log("📄 Crafting and injecting cards data matrix stack...");

    const cardsPayloadStack = [
      // ═══════ SCREEN 0: WELCOME SPLASH ═══════
      {
        topic_id: savedTopic._id,
        cardOrder: 0,
        card_type: "learning_screen",
        templateType: "welcome_splash",
        payload: {
          title: "Your Investors Read the 10-K. Do You?",
          subtitle: "10 screens · ~10 minutes · Quizzes you can't skip · Real EDGAR tasks",
          badgeTag: "IRIS Carbon · US SEC Module",
          buttonText: "Let's Start →",
          metaBullets: [
            "7 SEC forms explained — one screen at a time",
            "Step-by-step EDGAR walkthrough with visual guide",
            "XBRL explained like you're 12 — no jargon",
            "NYSE vs NASDAQ vs OTC — and why companies choose each",
            "Every quiz is mandatory — no skipping, score tracked live"
          ]
        }
      },

      // ═══════ SCREEN 1: FORMS OVERVIEW GRID ═══════
      {
        topic_id: savedTopic._id,
        cardOrder: 1,
        card_type: "learning_screen",
        templateType: "interactive_grid",
        payload: {
          title: "The 7 SEC Forms — Your Map",
          subtitle: "Tap each card to learn what it is. Then the quiz unlocks.",
          layoutStyle: "grid",
          tiles: [
            { tag: "Annual", name: "10-K", description: "Full annual report. US companies only.", expandedContent: "<strong>Who:</strong> US domestic public companies only<br><strong>Deadline:</strong> 60–90 days after fiscal year end.<br><strong>Contents:</strong> Audited financials, Risk Factors (Item 1A), MD&A (Item 7), Internal Controls (Item 9A).", colorTheme: "coral" },
            { tag: "Quarterly", name: "10-Q", description: "Quarterly update. Q1, Q2, Q3 only.", expandedContent: "<strong>Who:</strong> US domestic companies.<br><strong>Key rule:</strong> Only explains what CHANGED since the last 10-K — no repeating stable disclosures.<br><strong>Audited?</strong> No — reviewed only.", colorTheme: "teal" },
            { tag: "Current", name: "8-K", description: "Breaking news. 4 business days.", expandedContent: "<strong>Who:</strong> All US domestic companies.<br><strong>Deadline:</strong> Within 4 business days of any material event.<br><strong>Examples:</strong> CEO departure, M&A completed, earnings release, bankruptcy.", colorTheme: "purple" },
            { tag: "FPI Annual", name: "20-F", description: "Annual for foreign companies on US exchanges.", expandedContent: "<strong>Who:</strong> Foreign Private Issuers (non-US companies) on NYSE/NASDAQ.<br><strong>IFRS:</strong> Allowed without US GAAP reconciliation rules.", colorTheme: "blue" },
            { tag: "🍁 Canada", name: "40-F", description: "Simplified annual for Canadian companies.", expandedContent: "<strong>Who:</strong> Eligible Canadian companies under MJDS treaty rules.<br><strong>Benefit:</strong> File Canadian AIF + MD&A as-is without reformatting to SEC configurations.", colorTheme: "amber" },
            { tag: "Proxy", name: "DEF 14A", description: "AGM voting — pay, board, auditors.", expandedContent: "<strong>Who:</strong> All US public companies before annual AGM.<br><strong>Contents:</strong> Board elections, Say-on-Pay metrics, auditor ratifications.", colorTheme: "navy" },
            { tag: "FPI Interim", name: "6-K", description: "FPI equivalent of 8-K+10-Q combined.", expandedContent: "<strong>Who:</strong> Foreign Private Issuers.<br><strong>What:</strong> Whatever interim reports the company publishes at home — press releases, half-year results. No fixed format.", colorTheme: "teal" }
          ]
        }
      },
      // STANDALONE SCREEN 1 CHECKPOINT QUIZ
      {
        topic_id: savedTopic._id,
        cardOrder: 2,
        card_type: "quiz",
        quizData: {
          question: "PagSeguro is a Brazilian company listed on the NYSE. Which form is their annual SEC filing requirement?",
          options: ["10-K", "20-F", "40-F", "6-K"],
          correctOption: 1,
          explanation: "FPIs (non-US incorporated companies) always file a Form 20-F for their annual disclosures, not a 10-K. 10-K is strictly for US domestic tracking rows.",
          topicTag: "Forms Map"
        }
      },

      // ═══════ SCREEN 2: 10-K STRUCTURAL ACCORDION ═══════
      {
        topic_id: savedTopic._id,
        cardOrder: 3,
        card_type: "learning_screen",
        templateType: "interactive_grid",
        payload: {
          title: "Form 10-K — The Annual Bible",
          subtitle: "US domestic companies. Once a year. Fully audited. Everything an investor needs.",
          layoutStyle: "accordion_list",
          tiles: [
            { tag: "Item 1", name: "Business", description: "What the company does, products, markets, and competition.", colorTheme: "coral" },
            { tag: "Item 1A", name: "Risk Factors", description: "Every material risk — often 30–50 pages. Investors read this first to audit structural threats.", colorTheme: "purple" },
            { tag: "Item 7", name: "MD&A", description: "Management's Discussion & Analysis — their narrative on why results fluctuated.", colorTheme: "teal" },
            { tag: "Item 8", name: "Financial Statements", description: "Audited P&L, Balance Sheet, Cash Flow + extensive Footnotes under US GAAP rules.", colorTheme: "blue" },
            { tag: "Item 9A", name: "Internal Controls", description: "SOX 302 + 404 certifications validating the security of financial data compilation controls.", colorTheme: "amber" }
          ]
        }
      },
      // LIVE RESEARCH TASK ATTACHED TO SCREEN 2
      {
        topic_id: savedTopic._id,
        cardOrder: 4,
        card_type: "learning_screen",
        templateType: "research_task",
        payload: {
          title: "Live Task — Open Apple's 10-K on EDGAR",
          taskInstructions: "Click the secure button below to launch Apple's live filings register matrix window. Open their most recent 10-K report and audit the operational metadata items on the header title page.",
          externalLinkUrl: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K",
          linkButtonText: "📄 Launch Apple's 10-K on SEC EDGAR ↗"
        }
      },
      // STANDALONE SCREEN 2 QUIZZES
      {
        topic_id: savedTopic._id,
        cardOrder: 5,
        card_type: "quiz",
        quizData: {
          question: "Which designated Item block inside an SEC Form 10-K houses the MD&A (Management's Discussion & Analysis)?",
          options: ["Item 1A", "Item 5", "Item 7", "Item 9A"],
          correctOption: 2,
          explanation: "Item 7 is explicitly designated for the MD&A. Item 1A covers Risk Factors, and Item 9A covers SOX internal compliance signatures.",
          topicTag: "10-K Structure"
        }
      },
      {
        topic_id: savedTopic._id,
        cardOrder: 6,
        card_type: "quiz",
        quizData: {
          question: "True or False: A domestic US corporation filing a 10-K can cleanly submit financial files under IFRS rules without converting to US GAAP.",
          options: ["True — any public company can choose their standards framework", "False — 10-K logs strictly require full US GAAP reporting matrices"],
          correctOption: 1,
          explanation: "False! 10-K filers must report under US GAAP. Only foreign private entities using a 20-F sheet can leverage raw IFRS tracks.",
          topicTag: "10-K Rules"
        }
      },

      // ═══════ SCREEN 5: XBRL TAGGING MECHANICS ═══════
      {
        topic_id: savedTopic._id,
        cardOrder: 7,
        card_type: "learning_screen",
        templateType: "interactive_grid",
        payload: {
          title: "XBRL — The Barcode for Corporate Finance",
          subtitle: "You know how a product barcode lets any scanner in the world read the same item? XBRL does that for financial data structures.",
          layoutStyle: "columns",
          tiles: [
            { tag: "❌ WITHOUT XBRL", name: "Manual PDF Blobs", description: "Revenue values are trapped inside static files. Analysts copy-paste every cell row manually. 10,000 filings = 10,000 manual lookups.", colorTheme: "coral" },
            { tag: "✅ WITH XBRL", name: "Machine-Readable Data", description: "Every number has a standard barcode label tag. Automated routines pull data from thousands of files instantly with single API calls.", colorTheme: "teal" }
          ]
        }
      },
      // STANDALONE SCREEN 5 QUIZZES
      {
        topic_id: savedTopic._id,
        cardOrder: 8,
        card_type: "quiz",
        quizData: {
          question: "What is the primary operational advantage of implementing Inline XBRL (iXBRL) rules?",
          options: ["It completely encrypts tax files away from public access tracking", "It embeds machine-readable metadata tags cleanly inside a single, human-readable HTML web document"],
          correctOption: 1,
          explanation: "iXBRL provides a single unified document interface. Humans read it seamlessly in a standard browser window while engines read the data tags concurrently.",
          topicTag: "XBRL"
        }
      },

      // ═══════ SCREEN 6: EDGAR SEARCH WALKTHROUGH TIMELINE ═══════
      {
        topic_id: savedTopic._id,
        cardOrder: 9,
        card_type: "learning_screen",
        templateType: "task_timeline",
        payload: {
          title: "Visual Walkthrough — Finding a 10-K on EDGAR",
          subtitle: "Step-by-step guidance to traverse the official SEC registry tracking system like a pro.",
          steps: [
            { stepNumber: 1, title: "Access the Registry Trunk", text: "Open the primary search gateway index path: https://www.sec.gov/cgi-bin/browse-edgar", codeSnippetMock: "SEC EDGAR Interface v1 // Ready for entry" },
            { stepNumber: 2, title: "Input Unique Corporate Identifiers", text: "Search by entering the company name. Notice how every entity yields a 10-digit Central Index Key (CIK) number. Apple = 0000320193.", codeSnippetMock: "CIK Resolved Object Match -> Apple Inc. // [0000320193]" },
            { stepNumber: 3, title: "Isolate Target Forms and Sub-files", text: "Filter by form text parameter string '10-K' to display chronological rows and access main .htm layout pages cleanly.", codeSnippetMock: "Index Load Match:\n - aapl-20240928.htm (Main Document)\n - ex311.htm (CEO Certifications)" }
          ]
        }
      },

      // ═══════ SCREEN 8: SCAVENGER HUNT TRIPLE CHECK ═══════
      {
        topic_id: savedTopic._id,
        cardOrder: 10,
        card_type: "learning_screen",
        templateType: "research_task",
        payload: {
          title: "EDGAR Scavenger Hunt 🔎",
          subtitle: "Real company. Real SEC registry data layers. Zero hints.",
          taskInstructions: "Open the live SEC EDGAR register matrix for Ternium S.A. Audit their profile metadata rows carefully to answer the tracking criteria blocks below.",
          externalLinkUrl: "https://www.sec.gov/cgi-bin/browse-edgar?company=ternium&type=20-F",
          linkButtonText: "🔍 Open Live Ternium S.A. Records Panel ↗",
          isScavengerHunt: true,
          scavengerQuestions: [
            { fieldLabel: "What is Ternium's official 10-digit SEC CIK Identification code?", expectedAnswer: "0001346517", explanationHint: "Look in the primary top banner header metadata array string after page load finishes." },
            { fieldLabel: "What country is Ternium legally incorporated in? (Check the 20-F page cover details)", expectedAnswer: "Luxembourg", explanationHint: "Foreign holding structures often register context boundaries in Luxembourg to handle cross-border tax pipelines." },
            { fieldLabel: "What annual form code layout does Ternium deploy for its reports?", expectedAnswer: "20-F", explanationHint: "Non-US entity trading via NYSE ADR parameters = Foreign Private Issuer framework allocation." }
          ]
        }
      }
    ];

    console.log(`🚀 Dispatching ${cardsPayloadStack.length} formatted card nodes to database...`);
    await Card.insertMany(cardsPayloadStack);

    console.log("\n==================================================");
    console.log("🏆 SUCCESS: Curriculum Architecture Seeding Resolved!");
    console.log(`📦 Module ID: ${savedModule._id}`);
    console.log(`🗂️ Topic ID:  ${savedTopic._id}`);
    console.log(`📄 Total Templates Cards Bound: ${cardsPayloadStack.length}`);
    console.log("==================================================\n");

    process.exit(0);
  } catch (err) {
    console.error("❌ CRITICAL SEED PIPELINE FAILURE:", err.message);
    process.exit(1);
  }
};

seedCurriculumData();