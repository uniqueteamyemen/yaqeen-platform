const express = require('express');
const app = express();
app.use(express.json());

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

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yaqeen Platform running on port ${PORT}`);
});