const redis = require('redis');
const { REDIS_URL } = require('./env');

if (!REDIS_URL) throw new Error('REDIS_URL env is not set');

const redisClient = redis.createClient({
  url: REDIS_URL,  // ✅ no fallback
  socket: {
    reconnectStrategy: (retries) => {
      const delay = Math.min(Math.pow(2, retries) * 100, 10000);
      console.log(`[Redis] Reconnecting in ${delay}ms...`);
      return delay;
    },
  },
});

redisClient.connect().catch(err => console.error('[Redis] Connection error:', err));
redisClient.on('error', err => console.error('[Redis] Error:', err));
redisClient.on('ready', () => console.log('[Redis] Connected'));

module.exports = redisClient;