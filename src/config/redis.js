const redis = require('redis');
const { REDIS_URL } = require('./env');

const redisClient = redis.createClient({
  url: REDIS_URL || 'redis://localhost:6379',
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