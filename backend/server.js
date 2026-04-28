const express = require('express');
const app = express();
app.use(express.json());

const PAYLOCK_URL = process.env.PAYLOCK_URL || 'https://paylock-core-production.up.railway.app';

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'yaqeen-platform' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Yaqeen Platform running on port ${PORT}`);
});