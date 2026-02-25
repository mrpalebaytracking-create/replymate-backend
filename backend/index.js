// index.js — ReplyMate Pro Backend Server
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (extensions, curl)
    if (!origin) return callback(null, true);
    const allowed = [
      'https://www.ebay.com', 'https://www.ebay.co.uk', 'https://www.ebay.com.au',
      'https://www.ebay.de', 'https://www.ebay.fr',
      process.env.CUSTOMER_DASHBOARD_URL, process.env.ADMIN_DASHBOARD_URL, process.env.LANDING_URL,
      'http://localhost:3000', 'http://localhost:5173'
    ];
    if (allowed.includes(origin) || origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }
    callback(null, true); // permissive for now
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-license-key', 'x-admin-secret']
}));

app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ReplyMate Pro API running', version: '1.2.0', time: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────────────────────────
app.use('/auth',     require('./routes/auth'));
app.use('/stripe',   require('./routes/stripe'));
app.use('/license',  require('./routes/license'));
app.use('/usage',    require('./routes/usage'));
app.use('/admin',    require('./routes/admin'));
app.use('/customer', require('./routes/customer'));
app.use('/ebay',     require('./routes/ebay'));
app.use('/reply',    require('./routes/reply'));

app.use((req, res) => { res.status(404).json({ error: 'Route not found' }); });
app.use((err, req, res, next) => { console.error('Server error:', err); res.status(500).json({ error: 'Internal server error' }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✦ ReplyMate Pro API running on port ${PORT}`));
