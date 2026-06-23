module.exports = {
  PORT: process.env.PORT,
  MONGODB_URI: process.env.MONGODB_URI,
  REDIS_URL: process.env.REDIS_URL,
  HOST: process.env.HOST,
  NODE_ENV: process.env.NODE_ENV,
  SUPPORTED_PROTOCOLS: process.env.SUPPORTED_PROTOCOLS
    ? process.env.SUPPORTED_PROTOCOLS.split(',').map(p => p.trim().toLowerCase())
    : null,
  PROJECT_ID: process.env.PROJECT_ID,
};