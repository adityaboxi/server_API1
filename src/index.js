const app = require('./app');
const mongoose = require('mongoose');
const { PORT, MONGODB_URI } = require('./config/env');
const redisClient = require('./config/redis');
const syncDatabaseDefinitions = require('./services/syncService');
const { createWorker } = require('./workers/mockSyncWorker');
const { addDefinitionToMemory, removeDefinitionFromMemory } = require('./services/registryService');

if (!PORT) throw new Error('PORT env is not set');
if (!MONGODB_URI) throw new Error('MONGODB_URI env is not set');

mongoose.connect(MONGODB_URI)
  .then(() => console.log('[MongoDB] Connected'))
  .catch(err => { console.error('[MongoDB] Connection error:', err); process.exit(1); });

const worker = createWorker({}, addDefinitionToMemory, removeDefinitionFromMemory);

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

let synced = false; // ✅ prevent double sync

async function startSync() {
  if (synced) return;
  synced = true;
  await syncDatabaseDefinitions();
  console.log('[Mock Server] Ready.');
}

app.listen(PORT, '0.0.0.0', ()=>{
  console.log(`[Mock Server] listening on port ${PORT}`);
  if (redisClient.isReady) {
    startSync();
  } else {
    redisClient.once('ready', startSync); // ✅ once not on
  }
});