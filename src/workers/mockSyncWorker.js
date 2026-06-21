const { Worker } = require('bullmq');

function createWorker(connectionOpts, addFn, removeFn) {
  const worker = new Worker(
    'mockSyncQueue',
    async (job) => {
      const { action, projectId, version, method, urlpath, apihistorydata } = job.data;
      if (!projectId || !version || !method || !urlpath) {
        throw new Error(`Job ${job.id} missing required fields`);
      }
      if (action === 'set') {
        if (!apihistorydata) throw new Error(`Job ${job.id} missing apihistorydata`);
        addFn(projectId, version, method, urlpath, apihistorydata);
      } else if (action === 'delete') {
        removeFn(projectId, version, method, urlpath);
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
    },
    connectionOpts
  );

  worker.on('completed', (job) => console.log(`[Worker] Job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`[Worker] Job ${job.id} failed: ${err.message}`));
  worker.on('error', (err) => console.error('[Worker] Error:', err.message));

  return worker;
}

module.exports = { createWorker };