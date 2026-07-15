// tests/setup/inMemoryMongo.js
//
// Shared lifecycle helper for tests that need a REAL MongoDB to run against
// — not a mock of Mongoose, an actual mongod process, just an ephemeral
// in-memory one. This matters specifically for this bug: the whole point is
// proving that a real Mongoose query (findById + save, or findOneAndUpdate)
// only ever touches the one document it's supposed to. A mocked Model would
// only prove "the code called the function we told it to expect" — it can't
// catch a filter that's subtly wrong (e.g. an empty {} filter that matches
// every document) the way an actual database execution can.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod = null;

async function connect() {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
}

async function closeDatabase() {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  if (mongod) await mongod.stop();
}

async function clearCollections() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

module.exports = { connect, closeDatabase, clearCollections };
