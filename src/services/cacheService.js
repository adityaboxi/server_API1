const redisClient = require('../config/redis');

function getDefinitionRedisKey(projectId, version, method, urlpath) {
  return `mockapi:def:${projectId}:${version}:${method.toUpperCase()}:${urlpath}`;
}

function getGeneratedRedisKey(projectId, version, method, urlpath) {
  return `mockapi:gen:${projectId}:${version}:${method.toUpperCase()}:${urlpath}`;
}

function clearGeneratedCache(projectId, version, method, urlpath) {
  const genKey = getGeneratedRedisKey(projectId, version, method, urlpath);
  redisClient.del(genKey).catch(err => {
    console.error('[Redis] Failed to clear generated cache:', err.message);
  });
}

module.exports = {
  getDefinitionRedisKey,
  getGeneratedRedisKey,
  clearGeneratedCache,
};