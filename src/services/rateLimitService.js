const redisClient = require('../config/redis');
const { RATE_LIMIT_WINDOW_SECONDS } = require('../config/constants');

async function checkRateLimit(routeKey, clientId, limit) {
  if (!limit || limit <= 0) return { allowed: true };

  const key = `ratelimit:${routeKey}:${clientId}`;
  const script = `
    local current = redis.call('incr', KEYS[1])
    if current == 1 then
      redis.call('expire', KEYS[1], ARGV[1])
    end
    return current
  `;

  try {
    const count = await redisClient.eval(script, 1, key, RATE_LIMIT_WINDOW_SECONDS);
    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    const ttl = await redisClient.ttl(key);
    const resetIn = ttl > 0 ? ttl * 1000 : 0;
    return { allowed, remaining, resetIn, limit };
  } catch (err) {
    console.error('[RateLimit] Redis error, allowing request (no fallback):', err.message);
    return { allowed: true };
  }
}

module.exports = checkRateLimit;