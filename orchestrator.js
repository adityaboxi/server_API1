const express = require('express');
const Docker = require('dockerode');
const mongoose = require('mongoose');
const { createProxyMiddleware } = require('http-proxy-middleware');
const redis = require('redis');
const { Worker } = require('bullmq');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT;

// -------------------- CONFIGURATION --------------------
const REDIS_URL = process.env.REDIS_URL;
const MONGODB_URI = process.env.MONGODB_URI;
const MOCK_IMAGE = process.env.MOCK_IMAGE;
const NETWORK_NAME = process.env.NETWORK_NAME;
const HOST = process.env.HOST;
const SUPPORTED_PROTOCOLS = process.env.SUPPORTED_PROTOCOLS;
const NODE_ENV = process.env.NODE_ENV;

if (!PORT) throw new Error('PORT env is not set');
if (!REDIS_URL) throw new Error('REDIS_URL env is not set');
if (!MONGODB_URI) throw new Error('MONGODB_URI env is not set');
if (!MOCK_IMAGE) throw new Error('MOCK_IMAGE env is not set');
if (!NETWORK_NAME) throw new Error('NETWORK_NAME env is not set');
if (!HOST) throw new Error('HOST env is not set');
if (!SUPPORTED_PROTOCOLS) throw new Error('SUPPORTED_PROTOCOLS env is not set');
if (!NODE_ENV) throw new Error('NODE_ENV env is not set');

console.log(`[Orchestrator] Using Redis at: ${REDIS_URL}`);

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

async function createContainer(projectId) {
  const name = getContainerName(projectId);
  await docker.createContainer({
    Image: MOCK_IMAGE,
    name,
    Env: [
      `PROJECT_ID=${projectId}`,
      `MONGODB_URI=${MONGODB_URI}`,
      `REDIS_URL=${REDIS_URL}`,
      `HOST=${HOST}`,
      `SUPPORTED_PROTOCOLS=${SUPPORTED_PROTOCOLS}`,
      `NODE_ENV=${NODE_ENV}`,
    ],
    HostConfig: {
      NetworkMode: NETWORK_NAME,
      RestartPolicy: { Name: 'unless-stopped' },
    },
    ExposedPorts: { '4000/tcp': {} },
  });
  console.log(`[Docker] Created container ${name}`);
  return docker.getContainer(name);
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
    const container = await createContainer(projectId);
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
    const info = await container.inspect();
    if (info.State.Running) await container.stop();
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
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }
  if (!project.isActive) {
    return res.status(403).json({ error: 'Project is inactive. Please activate it to use the API.' });
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

  const allProjects = await Project.find({});
  console.log(`[Init] Found ${allProjects.length} total projects`);

  for (const proj of allProjects) {
    try {
      const name = getContainerName(proj.id);
      let containerExists = false;

      try {
        await docker.getContainer(name).inspect();
        containerExists = true;
      } catch {
        containerExists = false;
      }

      if (!containerExists) {
        await createContainer(proj.id);
        console.log(`[Init] Created container ${name}`);
      }

      const container = docker.getContainer(name);
      const info = await container.inspect();

      if (proj.isActive && !info.State.Running) {
        await container.start();
        console.log(`[Init] Started container ${name}`);
      } else if (!proj.isActive && info.State.Running) {
        await container.stop();
        console.log(`[Init] Stopped container ${name} (isActive=false)`);
      } else {
        console.log(`[Init] Container ${name} already in correct state`);
      }

    } catch (err) {
      console.error(`[Init] Error handling project ${proj.id}:`, err.message);
    }
  }

  startProjectWorker();
  app.listen(PORT, () => {
    console.log(`[Orchestrator] Listening on port ${PORT}`);
    console.log('[Orchestrator] Project worker started');
  });
}

init();