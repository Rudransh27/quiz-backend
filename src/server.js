// src/server.js
const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

// 🚀 INITIALIZE REDIS ENGINE CONFIGURATION
dotenv.config();
connectDB();
require('./config/redisConfig'); 

// Import routes using require syntax
const moduleRoutes = require('./routes/moduleRoutes');
const topicRoutes = require('./routes/topicRoutes');
const progressRoutes = require('./routes/progressRoutes');
const validatorRoutes = require('./routes/validatorApi');
const imageRoutes = require('./routes/imageRoutes');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes'); 
const dailyReadRoutes = require('./routes/dailyReadRoutes');
const newsRoutes = require('./routes/newsRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const teamRoutes = require('./routes/teamRoutes');
const ideaRoutes = require("./routes/ideaRoutes");
const notificationRoutes = require('./routes/notificationRoutes');

const app = express();

// =========================================================================
// 🔒 CRITICAL FIX 1: GLOBAL CORS SECURITY LAYER (MUST RUN AT ABSOLUTE ENTRY)
// =========================================================================
// CLIENT_URL supports a comma-separated list (e.g. VM IP + a domain added
// later) so production doesn't need a code change to add an origin — falls
// back to the local dev addresses only when CLIENT_URL isn't set at all.
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map(o => o.trim())
    .filter(Boolean);

app.use(cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "x-module-id"],
    credentials: true
}));

// =========================================================================
// 🔀 CRITICAL FIX 2: EXPAND PARSER BUFFER LIMITS FOR LARGE INJECTED CODES
// =========================================================================
// Overriding the base 1MB cap to 50MB prevents transactions from breaking on massive file streams
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// =========================================================================
// 📡 ALLOCATION ROUTES PIPELINES
// =========================================================================
app.use('/api/modules', moduleRoutes);
app.use('/api/topics', topicRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api', validatorRoutes);
app.use('/api/image', imageRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes); 
app.use('/api/daily-reads', dailyReadRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/teams', teamRoutes);
app.use("/api/ideas", ideaRoutes);
app.use('/api/notifications', notificationRoutes);

// 🛡️ CREATING HYBRID SERVER TO BRIDGE EXPRESS AND SOCKET.IO TOGETHER CLEANLY
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Using Map memory structure for lightning lookup tracks
const activeUserSockets = new Map();

io.on('connection', (socket) => {
    console.log(`🔌 New WebSocket pipeline established. Socket ID: ${socket.id}`);

    // Register user session to the connection room map
    socket.on('register_session', (userId) => {
        if (!userId) return; // Crash guard parameter check
        
        // Force conversion to clean string parameter to prevent object data type mismatch
        const strUserId = userId.toString();
        
        if (!activeUserSockets.has(strUserId)) {
            activeUserSockets.set(strUserId, []);
        }
        
        // Push socket identifier if it doesn't already exist in user's track array
        if (!activeUserSockets.get(strUserId).includes(socket.id)) {
            activeUserSockets.get(strUserId).push(socket.id);
        }
        
        socket.userId = strUserId;
        console.log(`👤 User bound to active socket arrays. User: ${strUserId} | Socket: ${socket.id}`);
    });

    // 🚀 Robust deep memory cleanup on disconnect to avoid cluster deadlocks
    socket.on('disconnect', () => {
        if (socket.userId && activeUserSockets.has(socket.userId)) {
            let userConnections = activeUserSockets.get(socket.userId);
            userConnections = userConnections.filter(id => id !== socket.id);
            
            if (userConnections.length === 0) {
                activeUserSockets.delete(socket.userId);
                console.log(`🧹 Map Clear: All active socket connections completely dropped for User: ${socket.userId}`);
            } else {
                activeUserSockets.set(socket.userId, userConnections);
            }
        } else {
            // Fallback sweep layer search: Manual search cascade if assignment mismatch happens
            activeUserSockets.forEach((sockets, uid) => {
                if (sockets.includes(socket.id)) {
                    const filtered = sockets.filter(id => id !== socket.id);
                    if (filtered.length === 0) {
                        activeUserSockets.delete(uid);
                    } else {
                        activeUserSockets.set(uid, filtered);
                    }
                }
            });
        }
        console.log(`❌ Pipeline closed safely. Socket ID: ${socket.id}`);
    });
});

// Setting up system engines cross access layer bindings
global.io = io;
global.activeUserSockets = activeUserSockets;

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => console.log(`🚀 Hybrid Server is running successfully on port ${PORT}`));