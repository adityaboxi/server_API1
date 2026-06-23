const ProjectApiHistory = require('../models/ProjectApiHistory');
const { addDefinitionToMemory, mockRoutes } = require('./registryService');
const redisClient = require('../config/redis');
const { SUPPORTED_PROTOCOLS } = require('../config/constants');
const { makeKey } = require('../utils/patternUtils');

const PROJECT_ID = process.env.PROJECT_ID;

async function syncDatabaseDefinitions() {
  // Load from MongoDB
  try {
    const docs = await ProjectApiHistory.find({});
    let count = 0;

    for (const doc of docs) {
      for (const endpoint of doc.endpoints) {
        const baseUrlPath = endpoint.baseUrlPath;
        for (const ver of endpoint.versions) {
          if (!SUPPORTED_PROTOCOLS.includes(ver.protocol)) continue;

          // Use projectID from actualFullUrl to extract custom project id
          // actualFullUrl format: protocol://host/customProjectId/version/path
          let projectId = doc.projectID;
          if (ver.actualFullUrl) {
            try {
              const urlParts = ver.actualFullUrl.split('/');
              // http://host/projectId/version/path → index 3
              if (urlParts.length >= 4) projectId = urlParts[3];
            } catch {}
          }

          // If PROJECT_ID env is set, only load matching project
          if (PROJECT_ID && projectId !== PROJECT_ID) continue;

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

    console.log(`[Sync] Loaded ${count} definitions from MongoDB${PROJECT_ID ? ` for project ${PROJECT_ID}` : ''}.`);
  } catch (err) {
    console.error('[Sync] MongoDB error:', err.message);
  }

  // Load from Redis
  try {
    const pattern = PROJECT_ID ? `mockapi:def:${PROJECT_ID}:*` : 'mockapi:def:*';
    const keys = await redisClient.keys(pattern);
    let count = 0;

    for (const key of keys) {
      const data = await redisClient.get(key);
      if (!data) continue;
      try {
        const { projectId, version, method, urlpath, apihistorydata } = JSON.parse(data);
        if (!projectId || !version || !method || !urlpath || !apihistorydata) continue;
        if (!SUPPORTED_PROTOCOLS.includes(apihistorydata.protocol)) continue;
        if (PROJECT_ID && projectId !== PROJECT_ID) continue;

        const registryKey = makeKey(projectId, version, method);
        const bucket = mockRoutes.get(registryKey);
        const exists = bucket && bucket.some(d => d.urlPath === urlpath);
        if (!exists) {
          addDefinitionToMemory(projectId, version, method, urlpath, apihistorydata);
          count++;
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