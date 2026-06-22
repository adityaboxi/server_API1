const express = require('express');
const router = express.Router();
const { findMatch } = require('../services/registryService');
const { makeKey } = require('../utils/patternUtils');
const { getDefinitionRedisKey, getGeneratedRedisKey } = require('../services/cacheService');
const checkRateLimit = require('../services/rateLimitService');
const generateFakeResponse = require('../services/fakerService');
const sendMockResponse = require('../services/responseService');
const redisClient = require('../config/redis');
const { DEFINITION_TTL_SECONDS, GENERATED_RESPONSE_TTL_SECONDS } = require('../config/constants');

router.all(/^\/([^\/]+)\/([^\/]+)\/(.*)$/, async (req, res, next) => {
  const projectId = req.params[0];
  const version = req.params[1];
  const urlpath = '/' + (req.params[2] || '');
  const method = req.method;

  const match = findMatch(projectId, version, method, urlpath);
  if (!match) return next();

  const definition = match.def.apihistorydata;
  const routeKey = `${makeKey(projectId, version, method)}:${match.def.urlPath}`;
  const clientId = req.ip;

  const defRedisKey = getDefinitionRedisKey(projectId, version, method, match.def.urlPath);
  redisClient.expire(defRedisKey, DEFINITION_TTL_SECONDS).catch(err => {
    console.error('[Redis] Failed to refresh TTL:', err.message);
  });

  const rl = await checkRateLimit(routeKey, clientId, definition.rateLimit);
  if (rl.limit !== undefined) {
    res.set('X-RateLimit-Limit', String(rl.limit));
    res.set('X-RateLimit-Remaining', String(rl.remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(rl.resetIn / 1000)));
  }
  if (!rl.allowed) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfterSeconds: Math.ceil(rl.resetIn / 1000),
    });
  }

  // (Auth, query, body validation placeholders – add if needed)

  let finalBody = definition.responseBody;
  if (definition.airesponse) {
    const genKey = getGeneratedRedisKey(projectId, version, method, match.def.urlPath);
    console.log(`[Faker] Checking cache for ${genKey}...`);
    try {
      const cached = await redisClient.get(genKey);
      if (cached) {
        finalBody = JSON.parse(cached);
        console.log(`[Faker] ✅ Serving cached generated response for ${method} ${projectId}/${version}${urlpath}`);
        await redisClient.expire(genKey, GENERATED_RESPONSE_TTL_SECONDS);
      } else {
        finalBody = generateFakeResponse(definition.responseBody);
        await redisClient.setEx(genKey, GENERATED_RESPONSE_TTL_SECONDS, JSON.stringify(finalBody));
        console.log(`[Faker] 🆕 Generated and cached fresh response for ${method} ${projectId}/${version}${urlpath}`);
      }
    } catch (err) {
      console.error('[Faker] Redis error, falling back to fresh generation:', err.message);
      finalBody = generateFakeResponse(definition.responseBody);
    }
  }

  console.log(`[Mock] ${method} ${projectId}/${version}${urlpath} → ${definition.statusCode || 200}`);
  sendMockResponse(req, res, definition, finalBody);
});

module.exports = router;