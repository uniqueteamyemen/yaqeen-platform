const express = require('express');
const app = express();

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

const PAYLOCK_URL = process.env.PAYLOCK_URL || 'https://paylock-core-production.up.railway.app';

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

    // 1) session
    const sessionRes = await fetch(`${PAYLOCK_URL}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id, device_id })
    });

    const sessionData = await sessionRes.json();
    const h0 = sessionData.h0;

    // 2) signal
    await fetch(`${PAYLOCK_URL}/v1/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        h0,
        signal_type: "provider_ack",
        signal_ref: "auto"
      })
    });

    // 3) resolve
    const resolveRes = await fetch(`${PAYLOCK_URL}/v1/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ h0 })
    });

    const resolveData = await resolveRes.json();

    res.json({
      h0,
      result: resolveData
    });

  } catch (error) {
    res.status(500).json({
      error: "execution failed"
    });
  }
});
const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yaqeen Platform running on port ${PORT}`);
});
