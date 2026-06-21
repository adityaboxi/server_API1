const { SUPPORTED_PROTOCOLS } = require('../config/constants');
const { patternToRegex, makeKey } = require('../utils/patternUtils');
const { clearGeneratedCache } = require('./cacheService');
const { getDefinitionRedisKey } = require('./cacheService');
const redisClient = require('../config/redis');
const { DEFINITION_TTL_SECONDS } = require('../config/constants');

const mockRoutes = new Map();

function addDefinitionToMemory(projectId, version, method, urlpath, apihistorydata) {
  if (!SUPPORTED_PROTOCOLS.includes(apihistorydata.protocol)) {
    console.log(`[Memory] Skipping ${apihistorydata.protocol} (not in supported protocols)`);
    return;
  }

  clearGeneratedCache(projectId, version, method, urlpath);

  const key = makeKey(projectId, version, method);
  const regexInfo = patternToRegex(urlpath);
  if (!mockRoutes.has(key)) mockRoutes.set(key, []);
  const bucket = mockRoutes.get(key);
  const idx = bucket.findIndex(d => d.urlPath === urlpath);
  const entry = { urlPath: urlpath, apihistorydata, regexInfo };
  if (idx !== -1) bucket[idx] = entry;
  else bucket.push(entry);
  console.log(`[Memory] ${method} ${projectId}/${version}${urlpath} ${idx === -1 ? 'added' : 'updated'}`);

  const redisKey = getDefinitionRedisKey(projectId, version, method, urlpath);
  const value = JSON.stringify({ projectId, version, method, urlpath, apihistorydata });
  redisClient.setEx(redisKey, DEFINITION_TTL_SECONDS, value).catch(err => {
    console.error('[Redis] Failed to store definition:', err.message);
  });
}

function removeDefinitionFromMemory(projectId, version, method, urlpath) {
  clearGeneratedCache(projectId, version, method, urlpath);

  const key = makeKey(projectId, version, method);
  const bucket = mockRoutes.get(key);
  if (!bucket) return;
  const filtered = bucket.filter(d => d.urlPath !== urlpath);
  if (filtered.length === 0) mockRoutes.delete(key);
  else mockRoutes.set(key, filtered);
  console.log(`[Memory] Removed ${method} ${projectId}/${version}${urlpath}`);

  const redisKey = getDefinitionRedisKey(projectId, version, method, urlpath);
  redisClient.del(redisKey).catch(err => {
    console.error('[Redis] Failed to delete definition:', err.message);
  });
}

function findMatch(projectId, version, method, requestPath) {
  const key = makeKey(projectId, version, method);
  const bucket = mockRoutes.get(key);
  if (!bucket) return null;
  for (const def of bucket) {
    const match = requestPath.match(def.regexInfo.regex);
    if (match) {
      const pathParams = {};
      def.regexInfo.paramNames.forEach((name, i) => {
        pathParams[name] = match[i + 1];
      });
      return { def, pathParams };
    }
  }
  return null;
}

module.exports = {
  mockRoutes,
  addDefinitionToMemory,
  removeDefinitionFromMemory,
  findMatch,
};