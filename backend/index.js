// index.js — ReplyMate Pro Backend Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// ── CORS: allow extension + dashboards ───────────────────────────────────
app.use(cors({
  origin: [
    'https://www.ebay.com',
    'https://www.ebay.co.uk',
    'chrome-extension://',
    process.env.CUSTOMER_DASHBOARD_URL,
    process.env.ADMIN_DASHBOARD_URL,
    process.env.LANDING_URL,
    'http://localhost:3000',
    'http://localhost:5173'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-license-key', 'x-admin-secret']
}));

// Raw body needed for Stripe webhooks (must be before express.json)
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ReplyMate Pro API running', version: '1.0.0', time: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/auth',     require('./routes/auth'));
app.use('/stripe',   require('./routes/stripe'));
app.use('/license',  require('./routes/license'));
app.use('/usage',    require('./routes/usage'));
app.use('/admin',    require('./routes/admin'));
app.use('/customer', require('./routes/customer'));
app.use('/ebay',     require('./routes/ebay'));

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Error handler ─────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✦ ReplyMate Pro API running on port ${PORT}`);
});
