module.exports = {
  DEFINITION_TTL_SECONDS: 600,
  RATE_LIMIT_WINDOW_SECONDS: 120,
  GENERATED_RESPONSE_TTL_SECONDS: 600,
  SUPPORTED_PROTOCOLS: process.env.SUPPORTED_PROTOCOLS
    ? process.env.SUPPORTED_PROTOCOLS.split(',').map(p => p.trim().toLowerCase())
    : null,
};