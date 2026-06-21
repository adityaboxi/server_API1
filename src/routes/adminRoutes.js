const express = require('express');
const router = express.Router();
const { mockRoutes, addDefinitionToMemory, removeDefinitionFromMemory } = require('../services/registryService');

router.post('/api/definitions', (req, res) => {
  const { project_id, version, urlpath, apihistorydata } = req.body;
  if (!project_id || !version || !urlpath || !apihistorydata || !apihistorydata.method) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  addDefinitionToMemory(project_id, version, apihistorydata.method, urlpath, apihistorydata);
  res.status(201).json({ success: true });
});

router.get('/api/definitions', (req, res) => {
  const entries = [];
  for (const [key, bucket] of mockRoutes.entries()) {
    const [projectId, version, method] = key.split(':');
    entries.push({
      key,
      projectId,
      version,
      method,
      routes: bucket.map(d => ({
        urlPath: d.urlPath,
        statusCode: d.apihistorydata.statusCode,
        isAuthEnabled: d.apihistorydata.isAuthEnabled,
        authScheme: d.apihistorydata.authScheme,
        rateLimit: d.apihistorydata.rateLimit,
        airesponse: d.apihistorydata.airesponse,
      })),
    });
  }
  res.json({ total: entries.length, entries });
});

router.delete('/api/definitions', (req, res) => {
  const { project_id, version, method, urlpath } = req.body;
  if (!project_id || !version || !method || !urlpath) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  removeDefinitionFromMemory(project_id, version, method, urlpath);
  res.json({ success: true });
});

router.get('/health', (req, res) => {
  res.json({ status: 'OK', routes: mockRoutes.size, uptime: process.uptime() });
});

module.exports = router;