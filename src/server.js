// src/server.js
const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const cors = require('cors');
const { createClient } = require('redis');

// Import routes using require syntax
const moduleRoutes = require('./routes/moduleRoutes');
const topicRoutes = require('./routes/topicRoutes');
const progressRoutes = require('./routes/progressRoutes');
const validatorRoutes = require('./routes/validatorApi');
const imageRoutes = require('./routes/imageRoutes');
const authRoutes = require('./routes/authRoutes');

dotenv.config();
connectDB();

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
    console.log("Missing Redis url");
    process.exit(1);
}

const redisClient = createClient({
    url: redisUrl
});

redisClient.connect()
    .then(() => console.log("Connected to Redis"))
    .catch(console.error);

const app = express();
app.use(express.json());
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
}));

// Routes
app.use('/api/modules', moduleRoutes);
app.use('/api/topics', topicRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api', validatorRoutes);
app.use('/api/image', imageRoutes);
app.use('/api/auth', authRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
