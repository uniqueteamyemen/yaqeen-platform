const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const app = express();

const API_KEY = process.env.API_KEY || 'test-key';

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// --- نظام التسجيل الموحد ---
const LOG_FILE = path.join(__dirname, 'logs.json');

function saveLog(entry) {
  const record = {
    time: new Date().toISOString(),
    ...entry
  };

  try {
    let logs = [];
    if (fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE);
      logs = JSON.parse(raw);
    }
    logs.push(record);
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    console.log(JSON.stringify(record));
  } catch (e) {
    console.error('log error', e.message);
  }
}
// ------------------------

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

app.use(express.static('public'));

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to send signal' });
  }
});

app.post('/api/resolve', async (req, res) => {
  try {
    const response = await fetch(`${PAYLOCK_URL}/v1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to resolve' });
  }
});

app.post('/api/execute', async (req, res) => {
  try {
    const { service_id, device_id } = req.body;

    const sessionRes = await fetch(`${PAYLOCK_URL}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id, device_id })
    });

    const sessionData = await sessionRes.json();
    const h0 = sessionData.h0;
    saveLog({ type: 'session_created', h0 });

    await fetch(`${PAYLOCK_URL}/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ h0, signal_type: 'provider_ack', signal_ref: 'auto' })
    });

    const resolveRes = await fetch(`${PAYLOCK_URL}/v1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ h0 })
    });

    const resolveData = await resolveRes.json();
    saveLog({ type: 'execution_proven', h0, h1: resolveData.h1 });

    res.json({ h0, result: resolveData });
  } catch (error) {
    res.status(500).json({ error: 'Execution failed' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yaqeen Platform running on port ${PORT}`);
});