// src/server.js
const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const { attachSocketSessions } = require('./utils/socketSession');

// 🚀 INITIALIZE REDIS ENGINE CONFIGURATION
dotenv.config();
connectDB();
require('./config/redisConfig'); 

// Import routes using require syntax
const moduleRoutes = require('./routes/moduleRoutes');
const topicRoutes = require('./routes/topicRoutes');
const progressRoutes = require('./routes/progressRoutes');
const imageRoutes = require('./routes/imageRoutes');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes'); 
const dailyReadRoutes = require('./routes/dailyReadRoutes');
const newsRoutes = require('./routes/newsRoutes');
const departmentRoutes = require('./routes/departmentRoutes');
const teamRoutes = require('./routes/teamRoutes');
const ideaRoutes = require("./routes/ideaRoutes");
const notificationRoutes = require('./routes/notificationRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const regionRoutes = require('./routes/regionRoutes');
const gradingRoutes = require('./routes/gradingRoutes');
const learnRoutes = require('./routes/learnRoutes');
const pathRoutes = require('./routes/pathRoutes');
const assessmentRoutes = require('./routes/assessmentRoutes');
const bankRoutes = require('./routes/bankRoutes');
const reportRoutes = require('./routes/reportRoutes');
const authActivityRoutes = require('./routes/authActivityRoutes');

const app = express();

// Node sits behind nginx (TLS-terminating reverse proxy) in production —
// without this, req.secure/req.protocol always read "http" regardless of
// what the real client connection used, which would make the session-
// binding cookie below (auth.js) never set the Secure/SameSite=None
// attributes it needs on an actual HTTPS deployment.
app.set('trust proxy', 1);

// VAPT findings #8 (Missing HTTP Security Headers) / #9 (Server Version
// Disclosure) — applies to this API's own responses. helmet also removes
// X-Powered-By on its own; app.disable is kept too as an explicit, obvious
// statement of intent that doesn't depend on helmet's internals.
// Permissions-Policy isn't part of helmet's default set, so it's added
// separately below.
app.disable('x-powered-by');
app.use(helmet());
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

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
// 🔒 1 MB everywhere (public routes like /api/auth/login included — a 50 MB
// JSON body there was a cheap memory/CPU DoS). Only the admin authoring
// routes, where a full HTML module or a bank import is posted, get 5 MB
// (largest stored HTML module ≈ 110 KB). Files go through multer, not here.
// The larger parser runs first on those prefixes; the global one then skips
// already-parsed bodies.
const AUTHORING_PREFIXES = ['/api/modules', '/api/topics', '/api/bank', '/api/progress/admin'];
app.use(AUTHORING_PREFIXES, express.json({ limit: '5mb' }));
app.use(AUTHORING_PREFIXES, express.urlencoded({ limit: '5mb', extended: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));
app.use(cookieParser());

// =========================================================================
// 📡 ALLOCATION ROUTES PIPELINES
// =========================================================================
app.use('/api/modules', moduleRoutes);
app.use('/api/topics', topicRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/image', imageRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes); 
app.use('/api/daily-reads', dailyReadRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/teams', teamRoutes);
app.use("/api/ideas", ideaRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/regions', regionRoutes);
app.use('/api/grading', gradingRoutes);
app.use('/api/learn', learnRoutes);
app.use('/api/paths', pathRoutes);
app.use('/api/assessments', assessmentRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/admin/auth', authActivityRoutes);

// HTTPS when a certificate is configured (SSL_KEY_PATH + SSL_CERT_PATH);
// otherwise plain HTTP for deployments where the reverse proxy (nginx)
// terminates TLS in front of this process — never expose that port directly.
function createAppServer(expressApp) {
    const { SSL_KEY_PATH, SSL_CERT_PATH } = process.env;
    if (SSL_KEY_PATH && SSL_CERT_PATH) {
        return https.createServer(
            { key: fs.readFileSync(SSL_KEY_PATH), cert: fs.readFileSync(SSL_CERT_PATH) },
            expressApp
        );
    }
    return http.createServer(expressApp);
}
const server = createAppServer(app);
const io = new Server(server, {
    // Under the API prefix so the API-scoped session cookie (path=/api) is
    // sent with the handshake. Clients use SOCKET_PATH from config.js.
    path: '/api/socket.io',
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Using Map memory structure for lightning lookup tracks
const activeUserSockets = new Map();

// 🔐 Authenticated sockets: the handshake must carry the JWT + the browser's
// session cookie, and each socket is bound to the user from the database —
// never to a user id the client claims (see utils/socketSession.js).
attachSocketSessions(io, activeUserSockets);

// Setting up system engines cross access layer bindings
global.io = io;
global.activeUserSockets = activeUserSockets;

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => console.log(`🚀 Hybrid Server is running successfully on port ${PORT}`));