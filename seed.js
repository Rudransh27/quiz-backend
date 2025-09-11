const mongoose = require('mongoose');
const dotenv = require('dotenv');
const fs = require('fs');

// Load environment variables from .env file
dotenv.config();

// Import Mongoose Models
const Module = require('./src/models/Module');
const Topic = require('./src/models/Topic');
const Card = require('./src/models/Card');

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected for seeding...');
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
};

// Function to import data
const importData = async () => {
  try {
    // Delete all existing data to prevent duplicates
    await Module.deleteMany();
    await Topic.deleteMany();
    await Card.deleteMany();

    // Read the data from the JSON file
    const data = JSON.parse(fs.readFileSync(`${__dirname}/src/data/learningData.json`, 'utf-8'));

    for (const moduleData of data) {
      // Create a new Module
      const newModule = await Module.create({
        title: moduleData.title,
        description: moduleData.description,
        department: moduleData.department, // ADD THIS LINE
        imageUrl: moduleData.imageUrl,
        topics: []
      });

      const topicIds = [];
      for (const topicData of moduleData.topics) {
        // Create a new Topic, referencing the new Module's ID
        const newTopic = await Topic.create({
          title: topicData.title,
          description: topicData.description,
          imageUrl: topicData.imageUrl,
          topicOrder: topicData.topicOrder,
          module_id: newModule._id,
          cards: []
        });

        const cardIds = [];
        for (const cardData of topicData.cards) {
          // Create a new Card, referencing the new Topic's ID
          const newCard = await Card.create({
            card_type: cardData.card_type,
            cardOrder: cardData.cardOrder,
            imageUrl: cardData.imageUrl,
            topic_id: newTopic._id,
            content: cardData.content
          });
          cardIds.push(newCard._id);
        }
        
        // Update the Topic with the Card IDs
        newTopic.cards = cardIds;
        await newTopic.save();
        topicIds.push(newTopic._id);
      }
      
      // Update the Module with the Topic IDs
      newModule.topics = topicIds;
      await newModule.save();
    }

    console.log('Data imported successfully!');
    process.exit();
  } catch (error) {
    console.error(`Error with data import: ${error.message}`);
    process.exit(1);
  }
};  

// Function to delete all data
const deleteData = async () => {
  try {
    await Module.deleteMany();
    await Topic.deleteMany();
    await Card.deleteMany();
    console.log('Data deleted successfully!');
    process.exit();
  } catch (error) {
    console.error(`Error with data deletion: ${error.message}`);
    process.exit(1);
  }
};

// Connect to the database and then run the appropriate function
connectDB().then(() => {
  if (process.argv[2] === '-d') {
    deleteData();
  } else {
    importData();
  }
});