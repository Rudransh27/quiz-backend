// seeder.js
const fs = require('fs');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment variables from .env file
dotenv.config();
// 🚨 1. Apne Naye Normalized Models Import Karo
const Module = require('./src/models/Module');
const Topic = require('./src/models/Topic');
const Card = require('./src/models/Card');

// Local Database Connection String (Jo humne set ki thi)
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log("🎰 MongoDB Master Pipe Connected!"))
  .catch(err => console.error("Database connection failed:", err));

const importData = async () => {
  try {
    // 📂 2. Nested JSON Data Read Karo
    const rawData = fs.readFileSync(`${__dirname}/learningData.json`, 'utf-8');
    const data = JSON.parse(rawData);

    console.log("⏳ Data normalization aur insertion chalu ho raha hai...");

    // Safe side: Pehle se pada purana course content saaf kar do (Fresh Start)
    await Module.deleteMany();
    await Topic.deleteMany();
    await Card.deleteMany();

    // 🚀 3. Core Normalization Engine Loop
    for (const mod of data) {
      // Step A: Module ka flat structure save karo
      const newModule = new Module({
        title: mod.title,
        description: mod.description,
        imageUrl: mod.imageUrl,
        department: mod.department
      });
      const savedModule = await newModule.save();
      console.log(`📦 Module Inserted: ${savedModule.title}`);

      // Step B: Loop inside Topics
      if (mod.topics && Array.isArray(mod.topics)) {
        for (const top of mod.topics) {
          const newTopic = new Topic({
            module_id: savedModule._id, // ⚡ Link with Parent Module ID (Foreign Key)
            title: top.title,
            description: top.description,
            topicOrder: top.topicOrder
          });
          const savedTopic = await newTopic.save();
          console.log(`   🗒️ Topic Inserted: ${savedTopic.title}`);

          // Step C: Loop inside Cards
          if (top.cards && Array.isArray(top.cards)) {
            const cardsToInsert = top.cards.map(card => ({
              topic_id: savedTopic._id, // ⚡ Link with Parent Topic ID (Foreign Key)
              card_type: card.card_type,
              cardOrder: card.cardOrder,
              imageUrl: card.imageUrl || "",
              content: card.content
            }));

            // Ek jhatke me saare cards bulk insert karo (High Performance!)
            await Card.insertMany(cardsToInsert);
            console.log(`      ⚡ ${cardsToInsert.length} Cards flat-injected under topic!`);
          }
        }
      }
    }

    console.log("🎉 SUCCESS: Poora learning data ekdam standard scale par seed ho chuka hai bhai!");
    process.exit();

  } catch (error) {
    console.error("❌ Seeding Operation Failed:", error.message);
    process.exit(1);
  }
};

// Script trigger points
importData();
