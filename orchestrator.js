const express = require('express');
const Docker = require('dockerode');
const mongoose = require('mongoose');
const { createProxyMiddleware } = require('http-proxy-middleware');
const redis = require('redis');
const { Worker } = require('bullmq');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

// -------------------- CONFIGURATION --------------------
const REDIS_URL = process.env.REDIS_URL || 'redis://host.docker.internal:6379';
console.log(`[Orchestrator] Using Redis at: ${REDIS_URL}`);

const MONGODB_URI = process.env.MONGODB_URI;
const MOCK_IMAGE = process.env.MOCK_IMAGE || 'adityaisme/mock:latest';
const NETWORK_NAME = process.env.NETWORK_NAME || 'mock-network';

// -------------------- DATABASE CONNECTIONS --------------------
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log('[MongoDB] Connected'))
  .catch(err => console.error('[MongoDB] Connection error:', err.message));

const redisClient = redis.createClient({
  url: REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      const delay = Math.min(Math.pow(2, retries) * 100, 10000);
      console.log(`[Redis] Reconnecting in ${delay}ms...`);
      return delay;
    },
  },
});

redisClient.on('error', (err) => console.error('[Redis] Client error:', err.message));
redisClient.on('ready', () => console.log('[Redis] Client connected'));

redisClient.connect().catch(err => {
  console.error('[Redis] Initial connection failed:', err.message);
});

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

const ProjectSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  isActive: { type: Boolean, default: true },
});
const Project = mongoose.model('Project', ProjectSchema, 'projects');

function getContainerName(projectId) {
  return `project-${projectId}`;
}

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
  } catch {
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
  } catch {
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
  } catch {
    console.log(`[Docker] Container ${name} not found or already removed`);
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

function startProjectWorker() {
  const worker = new Worker(
    'projectQueue',
    async (job) => {
      const { action, projectId, isActive } = job.data;
      console.log(`[ProjectWorker] Job ${job.id}: action=${action}, projectId=${projectId}, isActive=${isActive}`);
      if (!projectId) throw new Error('Missing projectId');
      await Project.findOneAndUpdate(
        { id: projectId },
        { $set: { isActive: isActive !== undefined ? isActive : true } },
        { upsert: true }
      );
      if (action === 'create') {
        await ensureContainer(projectId);
      } else if (action === 'update') {
        if (isActive) {
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
      },
      concurrency: 1,
    }
  );
  worker.on('completed', (job) => console.log(`[ProjectWorker] Job ${job.id} completed`));
  worker.on('failed', (job, err) => console.error(`[ProjectWorker] Job ${job.id} failed: ${err.message}`));
  worker.on('error', (err) => console.error('[ProjectWorker] Error:', err.message));
  return worker;
}

app.get('/health', (req, res) => res.json({ status: 'OK' }));

app.post('/api/projects', async (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: 'Missing projectId' });
  await Project.findOneAndUpdate({ id: projectId }, { isActive: true }, { upsert: true });
  await ensureContainer(projectId);
  res.json({ success: true });
});

app.get('/api/routing/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const project = await Project.findOne({ id: projectId });
  if (!project || !project.isActive) {
    return res.status(404).json({ error: 'Project not found or inactive' });
  }
  await ensureContainer(projectId);
  res.json({ target: `http://${getContainerName(projectId)}:4000` });
});

app.all('/:projectId/*', async (req, res, next) => {
  const { projectId } = req.params;
  const project = await Project.findOne({ id: projectId });
  if (!project || !project.isActive) {
    return res.status(404).json({ error: 'Project not found or inactive' });
  }
  await ensureContainer(projectId);
  const target = `http://${getContainerName(projectId)}:4000`;
  const proxy = createProjectProxy(target);
  proxy(req, res, next);
});

app.use((err, req, res, next) => {
  console.error('[Orchestrator] Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

async function init() {
  await ensureNetwork();
  const allProjects = await Project.find({ isActive: true });
  console.log(`[Init] Found ${allProjects.length} active projects`);
  for (const proj of allProjects) {
    await ensureContainer(proj.id);
  }
  const worker = startProjectWorker();
  app.listen(PORT, () => {
    console.log(`Orchestrator listening on port ${PORT}`);
    console.log('Project worker started');
  });
}

init();