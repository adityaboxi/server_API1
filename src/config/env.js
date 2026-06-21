require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 4000,
  MONGODB_URI: process.env.MONGODB_URI,
  REDIS_URL: process.env.REDIS_URL,
  HOST: process.env.HOST || 'localhost:4000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  SUPPORTED_PROTOCOLS: process.env.SUPPORTED_PROTOCOLS
    ? process.env.SUPPORTED_PROTOCOLS.split(',').map(p => p.trim().toLowerCase())
    : ['http'],
  PROJECT_ID: process.env.PROJECT_ID,
};