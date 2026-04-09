const express = require('express');
const path = require('path');
const { nanoid } = require('nanoid');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const geoip = require('geoip-lite');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// POST /api/shorten
app.post('/api/shorten', async (req, res) => {
  const { url, alias, max_clicks, expires_at, password } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'URL inválida. Incluye http:// o https://' });
  }
  if (alias && !/^[a-zA-Z0-9_-]{3,30}$/.test(alias)) {
    return res.status(400).json({ error: 'El alias solo puede contener letras, números, - y _  (3-30 caracteres)' });
  }
  if (max_clicks !== undefined && max_clicks !== null) {
    const n = parseInt(max_clicks);
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: 'El límite de clics debe ser un número entero mayor a 0' });
    }
  }
  if (expires_at) {
    const d = new Date(expires_at);
    if (isNaN(d.getTime()) || d <= new Date()) {
      return res.status(400).json({ error: 'La fecha de expiración debe ser futura' });
    }
  }
  if (password && password.length < 4) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });
  }

  const code = nanoid(7);
  const password_hash = password ? await bcrypt.hash(password, 10) : null;

  try {
    db.createUrl(code, url, {
      alias: alias || null,
      max_clicks: max_clicks ? parseInt(max_clicks) : null,
      expires_at: expires_at || null,
      password_hash,
    });
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
    max_clicks: max_clicks || null,
    expires_at: expires_at || null,
    protected: !!password,
  });
});

// POST /api/unlock/:code  — verify password, return original URL
app.post('/api/unlock/:code', async (req, res) => {
  const entry = db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });

  const status = urlStatus(entry);
  if (status === 'expired') return res.status(410).json({ error: 'Este enlace ha expirado' });
  if (!entry.password_hash) return res.status(400).json({ error: 'Este enlace no tiene contraseña' });

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' });

  const match = await bcrypt.compare(password, entry.password_hash);
  if (!match) return res.status(401).json({ error: 'Contraseña incorrecta' });

  // Record click after successful unlock
  const geo = getGeo(req);
  db.recordClick(entry.code, {
    referrer:  req.headers.referer || '',
    userAgent: req.headers['user-agent'] || '',
    ...geo,
  });

  res.json({ url: entry.original });
});

// GET /api/urls?q=&status=all|active|expired|protected|limited&sort=newest|oldest|most|least|alpha
app.get('/api/urls', (req, res) => {
  const { q = '', status = 'all', sort = 'newest' } = req.query;
  const urls = db.getAll({ q: q.trim(), status, sort });
  res.json(urls.map(u => ({
    ...u,
    short: `${BASE_URL}/${u.alias || u.code}`,
    status: urlStatus(u),
    protected: !!u.password_hash,
    password_hash: undefined,
  })));
});

// GET /api/stats/:code
app.get('/api/stats/:code', (req, res) => {
  const entry = db.getStats(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  res.json({
    ...entry,
    short: `${BASE_URL}/${entry.alias || entry.code}`,
    status: urlStatus(entry),
    protected: !!entry.password_hash,
    password_hash: undefined,
  });
});

// GET /api/analytics/:code
app.get('/api/analytics/:code', (req, res) => {
  const entry = db.getStats(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  const analytics = db.getAnalytics(entry.code);
  res.json({
    ...entry,
    short: `${BASE_URL}/${entry.alias || entry.code}`,
    status: urlStatus(entry),
    protected: !!entry.password_hash,
    password_hash: undefined,
    ...analytics,
  });
});

// GET /api/qr/:code
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

// GET /api/export/csv?q=&status=&sort=
app.get('/api/export/csv', (req, res) => {
  const { q = '', status = 'all', sort = 'newest' } = req.query;
  const urls = db.getAll({ q: q.trim(), status, sort });

  const escape = v => {
    if (v === null || v === undefined) return '';
    const str = String(v);
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const headers = ['Enlace corto', 'URL original', 'Código', 'Alias', 'Clics', 'Límite clics', 'Expira el', 'Protegida', 'Estado', 'Creada el'];
  const rows = urls.map(u => {
    const shortUrl = `${BASE_URL}/${u.alias || u.code}`;
    const status   = urlStatus(u);
    return [
      shortUrl,
      u.original,
      u.code,
      u.alias || '',
      u.clicks,
      u.max_clicks || '',
      u.expires_at || '',
      u.password_hash ? 'Sí' : 'No',
      status === 'expired' ? 'Expirada' : 'Activa',
      u.created_at,
    ].map(escape).join(',');
  });

  const csv = [headers.join(','), ...rows].join('\r\n');
  const filename = `labshorturl-export-${new Date().toISOString().slice(0, 10)}.csv`;

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compatibility
});

// GET /api/analytics
app.get('/api/analytics', (req, res) => {
  const global = db.getGlobalStats();
  const top = db.getTopUrls().map(u => ({
    ...u,
    short: `${BASE_URL}/${u.alias || u.code}`,
    status: urlStatus(u),
    protected: !!u.password_hash,
    password_hash: undefined,
  }));
  res.json({ ...global, topUrls: top });
});

// GET /:code  — redirect (or show password page)
app.get('/:code', (req, res) => {
  const { code } = req.params;
  const entry = db.findByCode(code);
  if (!entry) return res.status(404).sendFile(path.join(__dirname, '..', 'public', 'expired.html'));

  const status = urlStatus(entry);
  if (status === 'expired') {
    return res.status(410).sendFile(path.join(__dirname, '..', 'public', 'expired.html'));
  }

  // Password-protected: show unlock page
  if (entry.password_hash) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'unlock.html'));
  }

  const geo = getGeo(req);
  db.recordClick(entry.code, {
    referrer:  req.headers.referer || req.headers.referrer || '',
    userAgent: req.headers['user-agent'] || '',
    ...geo,
  });
  res.redirect(302, entry.original);
});

app.listen(PORT, () => {
  console.log(`LabShortURL corriendo en ${BASE_URL}`);
});

function getGeo(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  // Strip IPv6 prefix from IPv4-mapped addresses
  const clean = ip?.replace(/^::ffff:/, '') || '';
  const geo = geoip.lookup(clean);
  return {
    country:      geo?.country ? isoToName(geo.country) : null,
    country_code: geo?.country || null,
    city:         geo?.city    || null,
  };
}

// ISO 3166-1 alpha-2 to country name (common subset)
function isoToName(code) {
  const map = {
    AR:'Argentina', BO:'Bolivia', BR:'Brasil', CL:'Chile', CO:'Colombia',
    CR:'Costa Rica', CU:'Cuba', DO:'Rep. Dominicana', EC:'Ecuador',
    SV:'El Salvador', GT:'Guatemala', HN:'Honduras', MX:'México',
    NI:'Nicaragua', PA:'Panamá', PY:'Paraguay', PE:'Perú', PR:'Puerto Rico',
    ES:'España', UY:'Uruguay', VE:'Venezuela',
    US:'Estados Unidos', CA:'Canadá', GB:'Reino Unido', DE:'Alemania',
    FR:'Francia', IT:'Italia', PT:'Portugal', NL:'Países Bajos',
    CN:'China', JP:'Japón', KR:'Corea del Sur', IN:'India',
    AU:'Australia', RU:'Rusia', ZA:'Sudáfrica', NG:'Nigeria', EG:'Egipto',
  };
  return map[code] || code;
}

function urlStatus(entry) {
  if (entry.expires_at && new Date(entry.expires_at) < new Date()) return 'expired';
  if (entry.max_clicks && entry.clicks >= entry.max_clicks) return 'expired';
  return 'active';
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
