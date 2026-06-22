const mongoose = require('mongoose');
const app = require('./app');
const { PORT, MONGODB_URI } = require('./config/env');
const redisClient = require('./config/redis');
const syncDatabaseDefinitions = require('./services/syncService');
const { createWorker } = require('./workers/mockSyncWorker');
const { addDefinitionToMemory, removeDefinitionFromMemory } = require('./services/registryService');

mongoose.connect(MONGODB_URI)
  .then(() => console.log('[MongoDB] Connected'))
  .catch(err => {
    console.error('[MongoDB] Connection error:', err);
    process.exit(1);
  });

const worker = createWorker(
  {
    connection: {
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    },
  },
  addDefinitionToMemory,
  removeDefinitionFromMemory
);

process.on('SIGINT', async () => {
  console.log('[Server] Shutting down gracefully...');
  try { await mongoose.disconnect(); } catch (e) {}
  try { if (redisClient.isOpen) await redisClient.quit(); } catch (e) {}
  try { await worker.close(); } catch (e) {}
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

app.listen(PORT, async () => {
  console.log(`[Mock Server] listening on port ${PORT}`);
  await syncDatabaseDefinitions();
  console.log('[Mock Server] Ready.');
});