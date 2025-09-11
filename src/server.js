// src/server.js
import express from 'express';
import dotenv from 'dotenv';
import connectDB from './config/db.js'; // Added .js extension
import cors from 'cors';

// Import routes using import syntax
import moduleRoutes from './routes/moduleRoutes.js'; // Assuming these are also ES Modules
import topicRoutes from './routes/topicRoutes.js';   // Assuming these are also ES Modules
import progressRoutes from './routes/progressRoutes.js'; // Assuming these are also ES Modules
import validatorRoutes from './routes/validatorApi.js'; // Assuming these are also ES Modules
import imageRoutes from './routes/imageRoutes.js';   // Assuming these are also ES Modules
import authRoutes from './routes/authRoutes.js';     // This is the one we specifically know should be an ES Module

dotenv.config();
connectDB(); // Ensure connectDB is an async function if it performs async operations

const app = express();
app.use(express.json());
app.use(cors());

// Use all routes
app.use('/api/modules', moduleRoutes);
app.use('/api/topics', topicRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api', validatorRoutes); // Adjusted path if validatorRoutes don't need a prefix
app.use('/api/image', imageRoutes);
app.use('/api/auth', authRoutes); // Correctly mounted auth routes

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));