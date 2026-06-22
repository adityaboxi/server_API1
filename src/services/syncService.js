const ProjectApiHistory = require('../models/ProjectApiHistory');
const { addDefinitionToMemory, mockRoutes } = require('./registryService');
const redisClient = require('../config/redis');
const { SUPPORTED_PROTOCOLS } = require('../config/constants');
const { makeKey } = require('../utils/patternUtils');
const { getProjectFilter, isProjectFiltered } = require('../utils/projectId');

async function syncDatabaseDefinitions() {
  const filter = getProjectFilter();
  try {
    const docs = await ProjectApiHistory.find(filter);
    let count = 0;
    for (const doc of docs) {
      const projectId = doc.projectID;
      for (const endpoint of doc.endpoints) {
        const baseUrlPath = endpoint.baseUrlPath;
        for (const ver of endpoint.versions) {
          if (SUPPORTED_PROTOCOLS.includes(ver.protocol)) {
            const apiData = {
              protocol: ver.protocol,
              method: ver.method,
              urlPath: ver.urlPath,
              pathParams: ver.pathParams || [],
              queryParams: ver.queryParams || [],
              requestBody: ver.requestBody,
              responseBody: ver.responseBody,
              isAuthEnabled: ver.isAuthEnabled,
              authScheme: ver.authScheme,
              latency: ver.latency,
              rateLimit: ver.rateLimit,
              statusCode: ver.statusCode,
              headers: ver.headers || [],
              responseHeaders: ver.responseHeaders || [],
              cookies: ver.cookies || [],
              expectedToken: ver.expectedToken || '',
              expectedApiKey: ver.expectedApiKey || '',
              airesponse: ver.airesponse || false,
            };
            addDefinitionToMemory(projectId, ver.version, ver.method, baseUrlPath, apiData);
            count++;
          }
        }
      }
    }
    console.log(`[Sync] Loaded ${count} definitions from MongoDB${isProjectFiltered() ? ` for project ${process.env.PROJECT_ID}` : ''}.`);
  } catch (err) {
    console.error('[Sync] MongoDB error:', err.message);
  }

  try {
    let keys;
    if (isProjectFiltered()) {
      keys = await redisClient.keys(`mockapi:def:${process.env.PROJECT_ID}:*`);
    } else {
      keys = await redisClient.keys('mockapi:def:*');
    }
    let count = 0;
    for (const key of keys) {
      const data = await redisClient.get(key);
      if (!data) continue;
      try {
        const { projectId, version, method, urlpath, apihistorydata } = JSON.parse(data);
        if (projectId && version && method && urlpath && apihistorydata) {
          if (SUPPORTED_PROTOCOLS.includes(apihistorydata.protocol)) {
            if (isProjectFiltered() && projectId !== process.env.PROJECT_ID) continue;
            const registryKey = makeKey(projectId, version, method);
            const bucket = mockRoutes.get(registryKey);
            const exists = bucket && bucket.some(d => d.urlPath === urlpath);
            if (!exists) {
              addDefinitionToMemory(projectId, version, method, urlpath, apihistorydata);
              count++;
            }
          }
        }
      } catch {
        console.warn(`[Sync] Skipping corrupted Redis key: ${key}`);
      }
    }
    console.log(`[Sync] Loaded ${count} additional definitions from Redis.`);
  } catch (err) {
    console.error('[Sync] Redis error:', err.message);
  }
}

module.exports = syncDatabaseDefinitions;