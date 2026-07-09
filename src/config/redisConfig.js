// src/config/redisConfig.js
const { createClient } = require('redis');

// Redis Connection Factory Engine
const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    // 🧠 AUTOMATED RECONNECT STRATEGY (Mahesh Sir Bulletproof Criteria)
    socket: {
        reconnectStrategy: (retries) => {
            if (retries > 10) {
                console.error('❌ Redis Connection Fault: Max reconnection retries reached.');
                return new Error('Redis connection lost permanently.');
            }
            // Delay badhate jao har retry ke sath (Exponential Backoff)
            return Math.min(retries * 500, 2000); 
        }
    }
});

redisClient.on('connect', () => {
    console.log('⚡ Redis Cache Engine: Connecting to memory container...');
});

redisClient.on('ready', () => {
    console.log('🚀 Redis Cache Engine: Active and Ready for high-concurrency caching!');
});

redisClient.on('error', (err) => {
    console.error('❌ Redis Cache Runtime Error:', err);
});

redisClient.on('end', () => {
    console.warn('⚠️ Redis Cache Connection closed.');
});

// Immediately Invoked Execution Loop for Async Connection Handshake
(async () => {
    try {
        await redisClient.connect();
        // Global runtime instance wrapper layer assign karo
        global.redisClient = redisClient;
    } catch (err) {
        console.error('❌ Critical: Failed to boot Redis connection pool:', err);
    }
})();

module.exports = redisClient;