const crypto = require('crypto');
const express = require('express');
const Redis = require('ioredis');
const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

const runtimeMode = process.env.NODE_ENV || 'development';
const configuredApiKey = process.env.API_KEY;

if (runtimeMode === 'production' && (!configuredApiKey || configuredApiKey === 'test-key')) {
  console.error('FATAL: API_KEY must be explicitly configured and must not equal "test-key" in production.');
  process.exit(1);
}

const API_KEY = configuredApiKey || 'test-key';
const REDIS_URL = process.env.REDIS_URL;
let redis;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL);
  redis.on('connect', () => console.log('✅ Yaqeen connected to Redis'));
  redis.on('error', (err) => console.error('Redis connection error:', err.message));
} else {
  console.log('ℹ️  No REDIS_URL set — logging to console only');
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];

  // This is an instance-scoped server credential. It protects Yaqeen's API
  // boundary and is never emitted in a response or served to a browser.
  const received = typeof key === 'string' ? Buffer.from(key) : null;
  const expected = Buffer.from(API_KEY);
  const valid = received && received.length === expected.length && crypto.timingSafeEqual(received, expected);

  if (!valid) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const rateLimitWindowMs = 60 * 1000;
const rateLimitMax = 20;
const rateLimitHits = new Map();

function apiLimiter(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const current = rateLimitHits.get(key);

  if (!current || current.resetAt <= now) {
    rateLimitHits.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
    res.setHeader('RateLimit-Limit', rateLimitMax);
    res.setHeader('RateLimit-Remaining', rateLimitMax - 1);
    return next();
  }

  current.count += 1;
  const remaining = Math.max(rateLimitMax - current.count, 0);
  res.setHeader('RateLimit-Limit', rateLimitMax);
  res.setHeader('RateLimit-Remaining', remaining);
  res.setHeader('RateLimit-Reset', Math.ceil(current.resetAt / 1000));

  if (current.count > rateLimitMax) {
    return res.status(429).json({ error: 'Too many requests, please try again later.' });
  }

  next();
}

async function saveLog(entry) {
  const record = { time: new Date().toISOString(), ...entry };
  if (redis) {
    try {
      await redis.lpush('yaqeen:logs', JSON.stringify(record));
      await redis.ltrim('yaqeen:logs', 0, 999);
    } catch (e) {
      console.error('Redis log error:', e.message);
    }
  }
  console.log(JSON.stringify(record));
}

app.use(express.json({
  verify: (req, res, buf, encoding) => {
    try {
      JSON.parse(buf.toString(encoding));
    } catch (e) {
      res.status(400).json({ error: 'Invalid JSON in request body' });
      throw new Error('Invalid JSON');
    }
  }
}));

// Yaqeen is a server-side reference platform. It has no browser-facing asset
// route that could carry the API key; trusted provider backends call /api.
const PAYLOCK_URL = process.env.PAYLOCK_URL || 'https://paylock-core-production.up.railway.app';

app.use('/api', requireApiKey);
app.use('/api', apiLimiter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'yaqeen-platform' });
});

app.post('/api/session', async (req, res) => {
  try {
    const response = await fetch(`${PAYLOCK_URL}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    saveLog({ type: 'session_created', h0: data.h0 });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.post('/api/signal', async (req, res) => {
  try {
    const response = await fetch(`${PAYLOCK_URL}/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to send signal' });
  }
});

app.post('/api/resolve', async (req, res) => {
  try {
    const response = await fetch(`${PAYLOCK_URL}/v1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to resolve' });
  }
});

app.post('/api/verify', async (req, res) => {
  try {
    const { h0, h1 } = req.body;
    if (!h0 || !h1) {
      return res.status(400).json({ error: 'Missing h0 or h1' });
    }
    const response = await fetch(`${PAYLOCK_URL}/v1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ h0 })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    const valid = data.h1 === h1;
    await saveLog({ type: 'verification', h0, provided_h1: h1, expected_h1: data.h1, valid });
    res.json({ valid, expected_h1: data.h1, provided_h1: h1 });
  } catch (error) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

app.post('/api/execute', async (req, res) => {
  try {
    const { service_id, device_id } = req.body;
    const sessionRes = await fetch(`${PAYLOCK_URL}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ service_id, device_id })
    });
    const sessionData = await sessionRes.json();
    if (!sessionRes.ok) return res.status(sessionRes.status).json(sessionData);
    const h0 = sessionData.h0;
    saveLog({ type: 'session_created', h0 });

    const signalRes = await fetch(`${PAYLOCK_URL}/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ h0, signal_type: 'provider_ack', signal_ref: 'auto' })
    });
    const signalData = await signalRes.json();
    if (!signalRes.ok) return res.status(signalRes.status).json(signalData);

    res.json({
      h0,
      status: 'PENDING_CLIENT_OPEN',
      provider_signal_recorded: true
    });
  } catch (error) {
    res.status(500).json({ error: 'Execution failed' });
  }
});

app.post('/api/unlock', async (req, res) => {
  try {
    const { h0, device_fingerprint } = req.body;
    const unlockResponse = await fetch(`${PAYLOCK_URL}/v1/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ h0, device_fingerprint: device_fingerprint || 'web-demo' })
    });
    const unlockData = await unlockResponse.json();
    if (!unlockResponse.ok) return res.status(unlockResponse.status).json(unlockData);

    let h1 = unlockData.h1;
    let resolveData = null;

    if (!h1) {
      const resolveRes = await fetch(`${PAYLOCK_URL}/v1/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ h0 })
      });
      resolveData = await resolveRes.json();
      if (!resolveRes.ok) return res.status(resolveRes.status).json(resolveData);
      h1 = resolveData.h1;
    }

    if (!h1) {
      return res.status(409).json({
        error: 'H1 was not generated',
        h0,
        unlock: unlockData,
        resolve: resolveData
      });
    }

    await saveLog({ type: 'execution_proven', h0, h1 });

    res.json({
      h0,
      h1,
      status: 'EXECUTION_PROVEN',
      proof_status: 'EXECUTION_PROVEN',
      client_open_signal_recorded: true,
      unlock: unlockData,
      resolve: resolveData || { h1, status: 'EXECUTION_PROVEN' }
    });
  } catch (error) {
    res.status(500).json({ error: 'Unlock failed' });
  }
});

app.get('/api/logs', async (req, res) => {
  if (!redis) {
    return res.json({ message: 'Redis not configured. Logs are console-only.' });
  }
  try {
    const rawLogs = await redis.lrange('yaqeen:logs', 0, 99);
    const logs = rawLogs.map(log => JSON.parse(log));
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: 'failed to read logs' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yaqeen Platform running on port ${PORT}`);
});
