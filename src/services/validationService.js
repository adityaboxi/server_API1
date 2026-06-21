function validateQueryParams(req, definition) {
  const queryParams = definition.queryParams || [];
  for (const qp of queryParams) {
    if (!qp || !qp.key) continue;
    const required = qp.required !== false;
    const value = req.query[qp.key];
    if (required && (value === undefined || value === '')) {
      return { ok: false, error: `Missing required query parameter: ${qp.key}` };
    }
  }
  return { ok: true };
}

function validateRequestBody(req, definition) {
  const expected = definition.requestBody;
  if (expected === null || expected === undefined) return { ok: true };
  const method = (definition.method || req.method || '').toUpperCase();
  if (['GET', 'HEAD'].includes(method)) return { ok: true };
  const body = req.body;
  if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
    if (body === undefined || body === null || typeof body !== 'object') {
      return { ok: false, error: 'Request body is required and must be a JSON object' };
    }
    const missingKeys = Object.keys(expected).filter(k => !(k in body));
    if (missingKeys.length > 0) {
      return { ok: false, error: `Request body missing required fields: ${missingKeys.join(', ')}` };
    }
  }
  return { ok: true };
}

function validateAuth(req, definition) {
  if (!definition.isAuthEnabled) return { ok: true };

  const { authScheme, expectedToken, expectedApiKey, headers = [], cookies = [] } = definition;
  const scheme = (authScheme || '').toLowerCase();

  if (scheme === 'bearer' || scheme === 'jwt') {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { ok: false, status: 401, error: 'Missing or malformed Bearer token' };
    }
    const token = authHeader.slice(7);
    if (token !== expectedToken) {
      return { ok: false, status: 401, error: 'Invalid Bearer token' };
    }
  } else if (scheme === 'apikey' || scheme === 'api key' || scheme === 'api-key') {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (!apiKey) {
      return { ok: false, status: 401, error: 'Missing API Key' };
    }
    if (apiKey !== expectedApiKey) {
      return { ok: false, status: 401, error: 'Invalid API Key' };
    }
  }

  for (const h of headers) {
    if (h.key && h.key.toLowerCase() === 'authorization' && definition.isAuthEnabled) continue;
    const incoming = req.headers[h.key.toLowerCase()] || req.headers[h.key];
    if (incoming !== h.value) {
      return { ok: false, status: 403, error: `Invalid header: ${h.key}` };
    }
  }

  for (const c of cookies) {
    if (!c.key) continue;
    const incoming = req.cookies[c.key];
    if (incoming !== c.value) {
      return { ok: false, status: 403, error: `Invalid cookie: ${c.key}` };
    }
  }

  return { ok: true };
}

module.exports = { validateQueryParams, validateRequestBody, validateAuth };