const express = require('express');
const path = require('path');
const { nanoid } = require('nanoid');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const geoip = require('geoip-lite');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const db = require('./database');
const { checkOne, checkStale, startBackgroundChecker } = require('./health');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── LOGGING ──
const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// Formato personalizado: timestamp + método + url + status + tiempo + ip
morgan.token('real-ip', req => {
  const fwd = req.headers['x-forwarded-for'];
  return fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress;
});

const LOG_FORMAT = ':real-ip :method :url :status :response-time ms - :res[content-length]';

// En producción: archivo rotativo diario. En dev: consola coloreada.
let morganMiddleware;
if (process.env.NODE_ENV === 'production') {
  // Nuevo archivo de log por día: logs/access-YYYY-MM-DD.log
  function getDailyLogStream() {
    const date = new Date().toISOString().slice(0, 10);
    return fs.createWriteStream(path.join(LOG_DIR, `access-${date}.log`), { flags: 'a' });
  }
  // Recrear el stream cada hora para capturar cambio de día
  let logStream = getDailyLogStream();
  setInterval(() => { logStream = getDailyLogStream(); }, 60 * 60 * 1000);
  morganMiddleware = morgan(LOG_FORMAT, { stream: { write: msg => logStream.write(msg) } });
} else {
  morganMiddleware = morgan('dev');
}

// Logger centralizado para errores de aplicación
function logError(context, err) {
  const line = `[${new Date().toISOString()}] ERROR ${context}: ${err?.message || err}\n`;
  process.stderr.write(line);
  if (process.env.NODE_ENV === 'production') {
    fs.appendFile(path.join(LOG_DIR, 'error.log'), line, () => {});
  }
}

// ── ADMIN CREDENTIALS (set via env in production) ──
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
if (!process.env.ADMIN_PASS) {
  console.warn('⚠️  ADVERTENCIA: Usando contraseña de admin por defecto.');
  console.warn('   Define ADMIN_USER y ADMIN_PASS en tus variables de entorno.');
}

app.use(express.json());
app.use(morganMiddleware);

// ── SECURITY HEADERS ──
app.use(helmet({
  // CSP: permite Tailwind CDN, Google Fonts, Chart.js CDN y nuestras APIs
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", 'cdn.tailwindcss.com', 'cdn.jsdelivr.net'],
      styleSrc:       ["'self'", "'unsafe-inline'", 'cdn.tailwindcss.com', 'fonts.googleapis.com'],
      fontSrc:        ["'self'", 'fonts.gstatic.com'],
      imgSrc:         ["'self'", 'data:'],
      connectSrc:     ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  // Evita que el navegador haga MIME-type sniffing
  noSniff: true,
  // Fuerza HTTPS si NODE_ENV=production
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true }
    : false,
  // Oculta el header X-Powered-By: Express
  hidePoweredBy: true,
  // Evita clickjacking
  frameguard: { action: 'deny' },
  // Evita XSS reflejado en IE (legacy, pero gratis)
  xssFilter: true,
  // No cachear respuestas de la API (previene cache de datos sensibles)
  noCache: false, // manejado manualmente donde aplica
  // Controla qué información de referrer se envía
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// No cachear respuestas de la API
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── SESSION ──
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
  },
}));

app.use(express.static(path.join(__dirname, '..', 'public')));

// ── RATE LIMITING ──
// Trusts the X-Forwarded-For header when behind a reverse proxy (nginx, etc.)
// Set to the number of proxies in front of the app (1 for typical nginx setup)
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

const rateLimitHandler = (req, res) => {
  res.status(429).json({
    error: 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.',
    retryAfter: Math.ceil(req.rateLimit.resetTime / 1000 - Date.now() / 1000),
  });
};

// Fábrica: 5 intentos cada 15 min, solo cuenta los fallidos (401/429)
// Cada ruta crítica recibe su propia instancia para contadores independientes
function makeStrictLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
    skipSuccessfulRequests: true, // solo cuenta los fallidos
  });
}
const loginLimiter  = makeStrictLimiter();
const unlockLimiter = makeStrictLimiter();

// 30 req/hora — para creación de URLs (evita spam)
const shortenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// 60 req/min — para la API pública en general
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// 120 req/min — para los redirects (alta frecuencia esperada)
const redirectLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

// ── AUTH MIDDLEWARES ──
function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  res.status(401).json({ error: 'No autenticado', redirect: '/login' });
}

// Acepta sesión de admin O API key válida
function requireAdminOrKey(req, res, next) {
  if (req.session?.admin) return next();
  return requireApiKey(req, res, next);
}

// ── ADMIN AUTH ROUTES ──
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  }
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  req.session.admin = true;
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  if (req.session?.admin) return res.json({ authenticated: true, user: ADMIN_USER });
  res.status(401).json({ authenticated: false });
});

// ── API KEY AUTH MIDDLEWARE ──
function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function requireApiKey(req, res, next) {
  const header = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const raw    = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!raw) return res.status(401).json({ error: 'API key requerida. Usa el header Authorization: Bearer <key>' });
  const entry = db.findApiKey(hashKey(raw));
  if (!entry)  return res.status(401).json({ error: 'API key inválida o revocada' });
  db.touchApiKey(hashKey(raw));
  req.apiKey = entry;
  next();
}

// ── API KEY MANAGEMENT ──

// POST /api/keys  — create a new key
app.post('/api/keys', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre de la API key es requerido' });

  const raw    = `lsu_${nanoid(32)}`;
  const prefix = raw.slice(0, 10) + '…';
  db.createApiKey(hashKey(raw), prefix, name.trim());

  // Return full key ONCE — never stored in plain text
  res.status(201).json({ key: raw, prefix, name: name.trim(), note: 'Guarda esta clave ahora, no se mostrará de nuevo.' });
});

// GET /api/keys  — list keys (no plain-text, only prefix + metadata)
app.get('/api/keys', requireAdmin, (req, res) => {
  res.json(db.listApiKeys());
});

// DELETE /api/keys/:id  — revoke a key
app.delete('/api/keys/:id', requireAdmin, (req, res) => {
  const info = db.revokeApiKey(parseInt(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Key no encontrada' });
  res.json({ ok: true });
});

// POST /api/shorten
app.post('/api/shorten', requireAdminOrKey, shortenLimiter, async (req, res) => {
  const { url, alias, max_clicks, expires_at, password,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          show_preview } = req.body;

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

  // Build final URL with UTM params appended
  let finalUrl = url;
  const utmParams = { utm_source, utm_medium, utm_campaign, utm_term, utm_content };
  const hasUtm = Object.values(utmParams).some(v => v && v.trim());
  if (hasUtm) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(utmParams)) {
      if (v && v.trim()) u.searchParams.set(k, v.trim());
    }
    finalUrl = u.toString();
  }

  try {
    db.createUrl(code, finalUrl, {
      alias: alias || null,
      max_clicks: max_clicks ? parseInt(max_clicks) : null,
      expires_at: expires_at || null,
      password_hash,
      utm_source:   utm_source   || null,
      utm_medium:   utm_medium   || null,
      utm_campaign: utm_campaign || null,
      utm_term:     utm_term     || null,
      utm_content:  utm_content  || null,
      show_preview: !!show_preview,
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'El alias ya está en uso. Elige otro.' });
    }
    logError('POST /api/shorten', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }

  const shortCode = alias || code;
  res.json({
    short:      `${BASE_URL}/${shortCode}`,
    code:       shortCode,
    original:   finalUrl,
    max_clicks: max_clicks || null,
    expires_at: expires_at || null,
    protected:    !!password,
    show_preview: !!show_preview,
    utm:          hasUtm ? utmParams : null,
  });
});

// ── API v1 (key-protected) ──
app.get('/api/v1/urls', requireApiKey, (req, res) => {
  const { q = '', status = 'all', sort = 'newest' } = req.query;
  const urls = db.getAll({ q: q.trim(), status, sort });
  res.json(urls.map(u => ({
    ...u, short: `${BASE_URL}/${u.alias || u.code}`,
    status: urlStatus(u), protected: !!u.password_hash, password_hash: undefined,
  })));
});

app.get('/api/v1/stats/:code', requireApiKey, (req, res) => {
  const entry = db.getStats(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ...entry, short: `${BASE_URL}/${entry.alias || entry.code}`, status: urlStatus(entry), password_hash: undefined });
});

app.get('/api/v1/analytics', requireApiKey, (req, res) => {
  const global = db.getGlobalStats();
  const top    = db.getTopUrls().map(u => ({ ...u, short: `${BASE_URL}/${u.alias || u.code}`, status: urlStatus(u), password_hash: undefined }));
  res.json({ ...global, topUrls: top });
});

app.post('/api/v1/shorten', requireApiKey, async (req, res) => {
  // Delegate to the same shorten handler logic
  const { url, alias, max_clicks, expires_at, password,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content, show_preview } = req.body;

  if (!url || !isValidUrl(url)) return res.status(400).json({ error: 'URL inválida' });
  if (alias && !/^[a-zA-Z0-9_-]{3,30}$/.test(alias)) return res.status(400).json({ error: 'Alias inválido' });

  const code = nanoid(7);
  const password_hash = password ? await bcrypt.hash(password, 10) : null;
  let finalUrl = url;
  const utmParams = { utm_source, utm_medium, utm_campaign, utm_term, utm_content };
  if (Object.values(utmParams).some(v => v)) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(utmParams)) { if (v) u.searchParams.set(k, v); }
    finalUrl = u.toString();
  }
  try {
    db.createUrl(code, finalUrl, { alias: alias || null, max_clicks: max_clicks ? parseInt(max_clicks) : null, expires_at: expires_at || null, password_hash, show_preview: !!show_preview, ...utmParams });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) return res.status(409).json({ error: 'Alias en uso' });
    return res.status(500).json({ error: 'Error interno' });
  }
  const shortCode = alias || code;
  res.json({ short: `${BASE_URL}/${shortCode}`, code: shortCode, original: finalUrl });
});

// GET /api/preview/:code  — public metadata for the preview page (no password_hash)
app.get('/api/preview/:code', (req, res) => {
  const entry = db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  const status = urlStatus(entry);
  if (status === 'expired') return res.status(410).json({ error: 'Expirado' });
  res.json({
    code:     entry.alias || entry.code,
    original: entry.original,
    short:    `${BASE_URL}/${entry.alias || entry.code}`,
  });
});

// POST /api/record/:code  — record a click from the preview page
app.post('/api/record/:code', apiLimiter, (req, res) => {
  const entry = db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  const geo = getGeo(req);
  db.recordClick(entry.code, {
    referrer:  req.headers.referer || '',
    userAgent: req.headers['user-agent'] || '',
    ...geo,
  });
  res.json({ ok: true });
});

// POST /api/unlock/:code  — verify password, return original URL
app.post('/api/unlock/:code', unlockLimiter, async (req, res) => {
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

// PUT /api/urls/:code  — edit a URL
app.put('/api/urls/:code', requireAdmin, async (req, res) => {
  const entry = db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });

  const { url, alias, max_clicks, expires_at, show_preview } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'URL inválida. Incluye http:// o https://' });
  }
  if (alias && !/^[a-zA-Z0-9_-]{3,30}$/.test(alias)) {
    return res.status(400).json({ error: 'El alias solo puede contener letras, números, - y _ (3-30 caracteres)' });
  }
  if (max_clicks !== undefined && max_clicks !== null && max_clicks !== '') {
    const n = parseInt(max_clicks);
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: 'El límite de clics debe ser un número entero mayor a 0' });
    }
  }
  if (expires_at) {
    const d = new Date(expires_at);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'Fecha de expiración inválida' });
    }
  }

  // If alias changed, check it's not taken by another entry
  const newAlias = alias || null;
  if (newAlias && newAlias !== entry.alias) {
    const existing = db.findByCode(newAlias);
    if (existing && existing.code !== entry.code) {
      return res.status(409).json({ error: 'El alias ya está en uso. Elige otro.' });
    }
  }

  try {
    db.updateUrl(entry.code, {
      original:    url,
      alias:       newAlias,
      max_clicks:  max_clicks ? parseInt(max_clicks) : null,
      expires_at:  expires_at || null,
      show_preview: !!show_preview,
    });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'El alias ya está en uso. Elige otro.' });
    }
    logError('PUT /api/urls/:code', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }

  const updated = db.findByCode(entry.code);
  res.json({
    ...updated,
    short: `${BASE_URL}/${updated.alias || updated.code}`,
    status: urlStatus(updated),
    protected: !!updated.password_hash,
    password_hash: undefined,
  });
});

// DELETE /api/urls/:code  — delete a URL and its clicks
app.delete('/api/urls/:code', requireAdmin, (req, res) => {
  const entry = db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  const info = db.deleteUrl(entry.code);
  if (info.changes === 0) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ok: true });
});

// GET /api/urls?q=&status=all|active|expired|protected|limited&sort=newest|oldest|most|least|alpha
app.get('/api/urls', requireAdmin, (req, res) => {
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

// GET /api/urls/:code/health  — get stored health for one URL without re-checking
app.get('/api/urls/:code/health', requireAdmin, (req, res) => {
  const entry = db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  res.json({
    code:          entry.alias || entry.code,
    health_status: entry.health_status,
    health_code:   entry.health_code,
    last_checked:  entry.last_checked,
  });
});

// GET /api/stats/:code
app.get('/api/stats/:code', requireAdmin, (req, res) => {
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
app.get('/api/analytics/:code', requireAdmin, (req, res) => {
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
app.get('/api/qr/:code', apiLimiter, async (req, res) => {
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
  } catch (err) {
    logError('GET /api/qr/:code', err);
    res.status(500).json({ error: 'Error generando QR' });
  }
});

// POST /api/health/:code  — check one URL now
app.post('/api/health/:code', requireAdmin, async (req, res) => {
  const entry = db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  const result = await checkOne(entry.code, entry.original);
  res.json(result);
});

// POST /api/health  — check all stale URLs now
app.post('/api/health', requireAdmin, async (req, res) => {
  const count = await checkStale();
  res.json({ checked: count });
});

// GET /api/export/csv?q=&status=&sort=
app.get('/api/export/csv', requireAdmin, (req, res) => {
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
app.get('/api/analytics', requireAdmin, (req, res) => {
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
app.get('/:code', redirectLimiter, (req, res) => {
  const { code } = req.params;
  const entry = db.findByCode(code);
  if (!entry) return res.status(404).sendFile(path.join(__dirname, '..', 'public', 'expired.html'));

  const status = urlStatus(entry);
  if (status === 'expired') {
    return res.status(410).sendFile(path.join(__dirname, '..', 'public', 'expired.html'));
  }

  // Password-protected: show unlock page (takes priority over preview)
  if (entry.password_hash) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'unlock.html'));
  }

  // Preview countdown page
  if (entry.show_preview) {
    return res.sendFile(path.join(__dirname, '..', 'public', 'preview.html'));
  }

  const geo = getGeo(req);
  db.recordClick(entry.code, {
    referrer:  req.headers.referer || req.headers.referrer || '',
    userAgent: req.headers['user-agent'] || '',
    ...geo,
  });
  res.redirect(302, entry.original);
});

// ── EXPRESS ERROR HANDLER (catch-all) ──
app.use((err, req, res, _next) => {
  logError(`${req.method} ${req.path}`, err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const server = app.listen(PORT, () => {
  console.log(`LabShortURL corriendo en ${BASE_URL}`);
  startBackgroundChecker();
});

// ── GRACEFUL SHUTDOWN ──
function shutdown(signal) {
  console.log(`\n${signal} recibido. Cerrando servidor…`);
  server.close(() => {
    console.log('Servidor cerrado correctamente.');
    process.exit(0);
  });
  // Si no cierra en 10s, forzar
  setTimeout(() => { process.exit(1); }, 10_000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Captura excepciones no manejadas para que queden en el log
process.on('uncaughtException',  err => { logError('uncaughtException',  err); process.exit(1); });
process.on('unhandledRejection', err => { logError('unhandledRejection', err); process.exit(1); });

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
