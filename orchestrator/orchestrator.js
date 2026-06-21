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
// Project model – matches the main backend's 'projects' collection
// -------------------------------------------------------------------
const ProjectSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  subscribed: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
});
const Project = mongoose.model('Project', ProjectSchema, 'projects');

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
    console.log('[Docker] Created network', NETWORK_NAME);
  }
}

async function ensureContainer(projectId) {
  const name = getContainerName(projectId);
  console.log(`[Docker] Ensuring container ${name}...`);
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
      console.log(`[Docker] Started existing container ${name}`);
    } else {
      console.log(`[Docker] Container ${name} already running`);
    }
    return container;
  } catch (err) {
    console.log(`[Docker] Container ${name} not found, creating...`);
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
        RestartPolicy: { Name: 'unless-stopped' },
      },
      ExposedPorts: { '4000/tcp': {} },
    });
    const container = docker.getContainer(name);
    await container.start();
    console.log(`[Docker] Created and started new container ${name}`);
    return container;
  }
}

async function stopContainer(projectId) {
  const name = getContainerName(projectId);
  console.log(`[Docker] Stopping container ${name}...`);
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    if (info.State.Running) {
      await container.stop();
      console.log(`[Docker] Stopped container ${name}`);
    } else {
      console.log(`[Docker] Container ${name} already stopped`);
    }
  } catch (err) {
    console.log(`[Docker] Container ${name} does not exist (no action)`);
  }
}

async function removeContainer(projectId) {
  const name = getContainerName(projectId);
  console.log(`[Docker] Removing container ${name}...`);
  try {
    const container = docker.getContainer(name);
    await container.stop();
    await container.remove();
    console.log(`[Docker] Removed container ${name}`);
  } catch (err) {
    console.log(`[Docker] Container ${name} not found or already removed`);
  }
}

async function ensureSharedContainer() {
  console.log('[Docker] Ensuring shared container...');
  try {
    const container = docker.getContainer(SHARED_CONTAINER_NAME);
    const info = await container.inspect();
    if (!info.State.Running) {
      await container.start();
    }
    console.log('[Docker] Shared container is running');
    return container;
  } catch {
    console.log('[Docker] Shared container not found, creating...');
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
    console.log('[Docker] Shared container started');
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

      // Update orchestrator's local DB record
      await Project.findOneAndUpdate(
        { id: projectId },
        { 
          $set: {
            subscribed: subscribed !== undefined ? subscribed : false,
            isActive: isActive !== undefined ? isActive : true,
          }
        },
        { upsert: true }
      );

      if (action === 'create' || action === 'update') {
        const project = await Project.findOne({ id: projectId });
        if (!project) return;

        // ✅ Container only created if subscribed AND active.
        // Unsubscribe removes the container (if exists) and ensures shared.
        if (project.subscribed && project.isActive) {
          await ensureContainer(projectId);
        } else {
          await removeContainer(projectId);
          await ensureSharedContainer();
        }
      } else if (action === 'toggle') {
        // 🔥 Toggle only changes container state based on isActive, not subscription.
        const targetActive = isActive !== undefined ? isActive : true;
        console.log(`[ProjectWorker] Toggle: setting isActive=${targetActive} for project ${projectId}`);

        if (targetActive) {
          await ensureContainer(projectId);
        } else {
          await stopContainer(projectId);
        }
      } else if (action === 'delete') {
        await Project.deleteOne({ id: projectId });
        await removeContainer(projectId);
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
      concurrency: 1,
    }
  );

  worker.on('completed', (job) => console.log(`[ProjectWorker] Job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`[ProjectWorker] Job ${job.id} failed: ${err.message}`));
  worker.on('error', (err) => console.error('[ProjectWorker] Error:', err.message));

  return worker;
}

// -------------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------------

app.get('/health', (req, res) => res.json({ status: 'OK' }));

app.post('/api/projects', async (req, res) => {
  const { projectId, subscribed } = req.body;
  await Project.findOneAndUpdate(
    { id: projectId },
    { subscribed: subscribed || false, isActive: true },
    { upsert: true }
  );
  const project = await Project.findOne({ id: projectId });
  if (project.subscribed && project.isActive) {
    await ensureContainer(projectId);
  } else {
    await removeContainer(projectId);
    await ensureSharedContainer();
  }
  res.json({ success: true });
});

app.get('/api/routing/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const project = await Project.findOne({ id: projectId });
  const isSubscribed = project ? project.subscribed : false;
  const isActive = project ? project.isActive : false;

  let target;
  if (isSubscribed && isActive) {
    await ensureContainer(projectId);
    target = `http://${getContainerName(projectId)}:4000`;
  } else {
    await ensureSharedContainer();
    target = `http://${SHARED_CONTAINER_NAME}:4000`;
  }

  res.json({ target });
});

app.all('/:projectId/*', async (req, res, next) => {
  const { projectId } = req.params;
  const project = await Project.findOne({ id: projectId });
  const isSubscribed = project ? project.subscribed : false;
  const isActive = project ? project.isActive : false;

  let target;
  if (isSubscribed && isActive) {
    await ensureContainer(projectId);
    target = `http://${getContainerName(projectId)}:4000`;
  } else {
    await ensureSharedContainer();
    target = `http://${SHARED_CONTAINER_NAME}:4000`;
  }

  const proxy = createProjectProxy(target);
  proxy(req, res, next);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// -------------------------------------------------------------------
// INIT – full reconciliation on startup
// -------------------------------------------------------------------
async function init() {
  await ensureNetwork();
  await ensureSharedContainer();

  const allProjects = await Project.find({});
  console.log(`[Init] Found ${allProjects.length} projects in DB`);

  for (const proj of allProjects) {
    if (proj.subscribed && proj.isActive) {
      await ensureContainer(proj.id);
      console.log(`[Init] Dedicated container ensured for ${proj.id}`);
    } else {
      await removeContainer(proj.id);
    }
  }

  const worker = startProjectWorker();

  app.listen(PORT, () => {
    console.log(`Orchestrator listening on port ${PORT}`);
    console.log('Project worker started');
  });
}

init();