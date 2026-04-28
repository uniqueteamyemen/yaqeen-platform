const express = require('express');
const app = express();

// تحليل JSON مع معالجة أفضل للأخطاء
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
    console.log('Received body:', JSON.stringify(req.body));
    
    if (!req.body || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: 'Request body is empty' });
    }
    
    const response = await fetch(`${PAYLOCK_URL}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    console.log('PayLock response:', JSON.stringify(data));
    res.json(data);
  } catch (error) {
    console.error('Session error:', error.message);
    res.status(500).json({ error: 'Failed to create session', details: error.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yaqeen Platform running on port ${PORT}`);
});