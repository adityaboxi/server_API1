const express = require('express');
const Docker = require('dockerode');
const mongoose = require('mongoose');
const { createProxyMiddleware } = require('http-proxy-middleware');
const redis = require('redis');
const { Worker } = require('bullmq');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

const MONGODB_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;
const MOCK_IMAGE = process.env.MOCK_IMAGE || 'adityaisme/mock:latest';
const NETWORK_NAME = process.env.NETWORK_NAME || 'mock-network';
const SHARED_CONTAINER_NAME = 'shared-mock';

// -------------------------------------------------------------------
// Database connections
// -------------------------------------------------------------------
mongoose.connect(MONGODB_URI).then(() => console.log('[MongoDB] Connected'));
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.connect().then(() => console.log('[Redis] Connected'));

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// -------------------------------------------------------------------
// Project model
// -------------------------------------------------------------------
const ProjectSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  subscribed: { type: Boolean, default: false },
});
const Project = mongoose.model('Project', ProjectSchema);

function getContainerName(projectId) {
  return `project-${projectId}`;
}

// -------------------------------------------------------------------
// Docker helpers
// -------------------------------------------------------------------
async function ensureNetwork() {
  try {
    await docker.getNetwork(NETWORK_NAME).inspect();
  } catch {
    await docker.createNetwork({ Name: NETWORK_NAME });
  }
}

async function ensureContainer(projectId) {
  const name = getContainerName(projectId);
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return container;
  } catch (err) {
    await docker.createContainer({
      Image: MOCK_IMAGE,
      name,
      Env: [
        `PROJECT_ID=${projectId}`,
        `MONGODB_URI=${MONGODB_URI}`,
        `REDIS_URL=${REDIS_URL}`,
        `HOST=${process.env.HOST || 'http://localhost:4000'}`,
        `SUPPORTED_PROTOCOLS=${process.env.SUPPORTED_PROTOCOLS || 'http'}`,
        `NODE_ENV=${process.env.NODE_ENV || 'production'}`,
      ],
      HostConfig: {
        NetworkMode: NETWORK_NAME,
        RestartPolicy: { Name: 'unless-stopped' }, // auto-restart on crash
      },
      ExposedPorts: { '4000/tcp': {} },
    });
    const container = docker.getContainer(name);
    await container.start();
    return container;
  }
}

async function ensureSharedContainer() {
  try {
    const container = docker.getContainer(SHARED_CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    return container;
  } catch {
    await docker.createContainer({
      Image: MOCK_IMAGE,
      name: SHARED_CONTAINER_NAME,
      Env: [
        `MONGODB_URI=${MONGODB_URI}`,
        `REDIS_URL=${REDIS_URL}`,
        `HOST=${process.env.HOST || 'http://localhost:4000'}`,
        `SUPPORTED_PROTOCOLS=${process.env.SUPPORTED_PROTOCOLS || 'http'}`,
        `NODE_ENV=${process.env.NODE_ENV || 'production'}`,
      ],
      HostConfig: {
        NetworkMode: NETWORK_NAME,
        RestartPolicy: { Name: 'unless-stopped' },
      },
      ExposedPorts: { '4000/tcp': {} },
    });
    const container = docker.getContainer(SHARED_CONTAINER_NAME);
    await container.start();
    return container;
  }
}

function createProjectProxy(target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path, req) => {
      const parts = path.split('/');
      parts.splice(1, 1);
      return parts.join('/') || '/';
    },
  });
}

// -------------------------------------------------------------------
// BullMQ Worker for project jobs
// -------------------------------------------------------------------
function startProjectWorker() {
  const worker = new Worker(
    'projectQueue',
    async (job) => {
      const { action, projectId, subscribed, isActive } = job.data;
      console.log(`[ProjectWorker] Job ${job.id}: action=${action}, projectId=${projectId}, subscribed=${subscribed}, isActive=${isActive}`);

      if (!projectId) {
        throw new Error('Missing projectId');
      }

      // Ensure the project exists in DB (upsert)
      await Project.findOneAndUpdate(
        { id: projectId },
        { subscribed: subscribed || false },
        { upsert: true }
      );

      if (action === 'create' || action === 'update') {
        if (subscribed) {
          await ensureContainer(projectId);
          console.log(`[ProjectWorker] Dedicated container ensured for ${projectId}`);
        } else {
          await ensureSharedContainer();
          const name = getContainerName(projectId);
          try {
            const container = docker.getContainer(name);
            await container.stop();
            await container.remove();
            console.log(`[ProjectWorker] Removed dedicated container for ${projectId} (now free)`);
          } catch {
            // container doesn't exist, ignore
          }
        }
      } else if (action === 'toggle') {
        const name = getContainerName(projectId);
        try {
          const container = docker.getContainer(name);
          const info = await container.inspect();
          if (isActive) {
            if (!info.State.Running) {
              await container.start();
              console.log(`[ProjectWorker] Started container for ${projectId}`);
            } else {
              console.log(`[ProjectWorker] Container for ${projectId} is already running`);
            }
          } else {
            if (info.State.Running) {
              await container.stop();
              console.log(`[ProjectWorker] Stopped container for ${projectId}`);
            } else {
              console.log(`[ProjectWorker] Container for ${projectId} is already stopped`);
            }
          }
        } catch (err) {
          // Container doesn't exist – if isActive is true, create it
          if (isActive) {
            await ensureContainer(projectId);
            console.log(`[ProjectWorker] Created container for ${projectId} (was missing)`);
          } else {
            console.log(`[ProjectWorker] No container to stop for ${projectId}`);
          }
        }
      } else if (action === 'delete') {
        await Project.deleteOne({ id: projectId });
        const name = getContainerName(projectId);
        try {
          const container = docker.getContainer(name);
          await container.stop();
          await container.remove();
          console.log(`[ProjectWorker] Removed dedicated container for ${projectId}`);
        } catch {
          // container doesn't exist, ignore
        }
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
    },
    {
      connection: {
        url: REDIS_URL,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        socket: {
          tls: true,
          rejectUnauthorized: false,
        },
      },
    }
  );

  worker.on('completed', (job) => console.log(`[ProjectWorker] Job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`[ProjectWorker] Job ${job.id} failed: ${err.message}`));
  worker.on('error', (err) => console.error('[ProjectWorker] Error:', err.message));

  return worker;
}

// -------------------------------------------------------------------
// ROUTES – explicit routes FIRST, then wildcard
// -------------------------------------------------------------------

// 1. Health check
app.get('/health', (req, res) => res.json({ status: 'OK' }));

// 2. Project management (HTTP fallback, also used by Nginx)
app.post('/api/projects', async (req, res) => {
  const { projectId, subscribed } = req.body;
  await Project.findOneAndUpdate(
    { id: projectId },
    { subscribed: subscribed || false },
    { upsert: true }
  );
  if (subscribed) {
    await ensureContainer(projectId);
  } else {
    const name = getContainerName(projectId);
    try {
      const container = docker.getContainer(name);
      await container.stop();
      await container.remove();
    } catch {}
  }
  res.json({ success: true });
});

// 3. Routing endpoint for Nginx to resolve container target
app.get('/api/routing/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const project = await Project.findOne({ id: projectId });
  const isSubscribed = project ? project.subscribed : false;

  let target;
  if (isSubscribed) {
    await ensureContainer(projectId);
    target = `http://${getContainerName(projectId)}:4000`;
  } else {
    await ensureSharedContainer();
    target = `http://${SHARED_CONTAINER_NAME}:4000`;
  }

  res.json({ target });
});

// 4. Wildcard – proxy all other requests to the appropriate mock container
app.all('/:projectId/*', async (req, res, next) => {
  const { projectId } = req.params;
  const project = await Project.findOne({ id: projectId });
  const isSubscribed = project ? project.subscribed : false;

  let target;
  if (isSubscribed) {
    await ensureContainer(projectId);
    target = `http://${getContainerName(projectId)}:4000`;
  } else {
    await ensureSharedContainer();
    target = `http://${SHARED_CONTAINER_NAME}:4000`;
  }

  const proxy = createProjectProxy(target);
  proxy(req, res, next);
});

// 5. Fallback 404 (if nothing matches)
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// -------------------------------------------------------------------
// Init
// -------------------------------------------------------------------
async function init() {
  await ensureNetwork();
  await ensureSharedContainer();
  const subscribedProjects = await Project.find({ subscribed: true });
  for (const proj of subscribedProjects) {
    await ensureContainer(proj.id);
  }

  const worker = startProjectWorker();

  app.listen(PORT, () => {
    console.log(`Orchestrator listening on port ${PORT}`);
    console.log('Project worker started');
  });
}

init();