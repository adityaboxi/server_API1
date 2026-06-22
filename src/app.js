const express = require('express');
const cookieParser = require('cookie-parser');
const adminRoutes = require('./routes/adminRoutes');
const mockRoutes = require('./routes/mockRoutes');

const app = express();
app.set('trust proxy', true);
app.use(cookieParser());
app.use(express.json());

app.use(adminRoutes);
app.use(mockRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'No mock definition found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[App] Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

module.exports = app;