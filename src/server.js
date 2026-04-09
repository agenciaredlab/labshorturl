const express = require('express');
const path = require('path');
const { nanoid } = require('nanoid');
const QRCode = require('qrcode');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// POST /api/shorten
app.post('/api/shorten', (req, res) => {
  const { url, alias } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'URL inválida. Incluye http:// o https://' });
  }

  if (alias && !/^[a-zA-Z0-9_-]{3,30}$/.test(alias)) {
    return res.status(400).json({ error: 'El alias solo puede contener letras, números, - y _  (3-30 caracteres)' });
  }

  const code = nanoid(7);

  try {
    db.createUrl(code, url, alias || null);
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'El alias ya está en uso. Elige otro.' });
    }
    return res.status(500).json({ error: 'Error interno del servidor' });
  }

  const shortCode = alias || code;
  res.json({
    short: `${BASE_URL}/${shortCode}`,
    code: shortCode,
    original: url,
  });
});

// GET /api/urls
app.get('/api/urls', (req, res) => {
  const urls = db.getAll();
  res.json(urls.map(u => ({ ...u, short: `${BASE_URL}/${u.alias || u.code}` })));
});

// GET /api/stats/:code
app.get('/api/stats/:code', (req, res) => {
  const entry = db.getStats(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ...entry, short: `${BASE_URL}/${entry.alias || entry.code}` });
});

// GET /api/analytics/:code  — detailed analytics for one URL
app.get('/api/analytics/:code', (req, res) => {
  const entry = db.getStats(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  const analytics = db.getAnalytics(entry.code);
  res.json({ ...entry, short: `${BASE_URL}/${entry.alias || entry.code}`, ...analytics });
});

// GET /api/qr/:code  — QR code as PNG or SVG
app.get('/api/qr/:code', async (req, res) => {
  const entry = db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });

  const shortUrl = `${BASE_URL}/${entry.alias || entry.code}`;
  const format   = req.query.format === 'svg' ? 'svg' : 'png';
  const size     = Math.min(Math.max(parseInt(req.query.size) || 300, 100), 1000);

  try {
    if (format === 'svg') {
      const svg = await QRCode.toString(shortUrl, { type: 'svg', width: size, margin: 2 });
      res.set('Content-Type', 'image/svg+xml');
      return res.send(svg);
    }
    const buffer = await QRCode.toBuffer(shortUrl, {
      type: 'png', width: size, margin: 2,
      color: { dark: '#4f46e5', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="qr-${entry.alias || entry.code}.png"`);
    res.send(buffer);
  } catch {
    res.status(500).json({ error: 'Error generando QR' });
  }
});

// GET /api/analytics  — global dashboard stats
app.get('/api/analytics', (req, res) => {
  const global = db.getGlobalStats();
  const top = db.getTopUrls().map(u => ({ ...u, short: `${BASE_URL}/${u.alias || u.code}` }));
  res.json({ ...global, topUrls: top });
});

// GET /:code  — redirect
app.get('/:code', (req, res) => {
  const { code } = req.params;
  const entry = db.findByCode(code);
  if (!entry) return res.status(404).send('URL no encontrada');
  db.recordClick(entry.code, {
    referrer: req.headers.referer || req.headers.referrer || '',
    userAgent: req.headers['user-agent'] || '',
  });
  res.redirect(301, entry.original);
});

app.listen(PORT, () => {
  console.log(`LabShortURL corriendo en ${BASE_URL}`);
});

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
