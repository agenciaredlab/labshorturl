const Sentry = require('@sentry/node');
const express = require('express');
const path = require('path');
const { nanoid } = require('nanoid');
const QRCode = require('qrcode');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const geoip = require('geoip-lite');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const db = require('./database');
const { checkOne, checkStale, startBackgroundChecker } = require('./health');
const pay = require('./payments');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ── LOGGING ──
const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

morgan.token('real-ip', req => {
  const fwd = req.headers['x-forwarded-for'];
  return fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress;
});
const LOG_FORMAT = ':real-ip :method :url :status :response-time ms - :res[content-length]';

let morganMiddleware;
if (process.env.NODE_ENV === 'production') {
  function getDailyLogStream() {
    const date = new Date().toISOString().slice(0, 10);
    return fs.createWriteStream(path.join(LOG_DIR, `access-${date}.log`), { flags: 'a' });
  }
  let logStream = getDailyLogStream();
  setInterval(() => { logStream = getDailyLogStream(); }, 60 * 60 * 1000);
  morganMiddleware = morgan(LOG_FORMAT, { stream: { write: msg => logStream.write(msg) } });
} else {
  morganMiddleware = morgan('dev');
}

function logError(context, err) {
  const line = `[${new Date().toISOString()}] ERROR ${context}: ${err?.message || err}\n`;
  process.stderr.write(line);
  if (process.env.NODE_ENV === 'production') {
    fs.appendFile(path.join(LOG_DIR, 'error.log'), line, () => {});
  }
  if (SENTRY_DSN && err instanceof Error) Sentry.captureException(err, { tags: { context } });
}

// ── ADMIN CREDENTIALS ──
function readSecret(envVar, fallback) {
  try { return fs.readFileSync(`/run/secrets/${envVar}`, 'utf8').trim(); } catch {}
  return process.env[envVar] || fallback;
}

const ADMIN_USER = readSecret('ADMIN_USER', 'admin');
const ADMIN_PASS = readSecret('ADMIN_PASS', 'admin123');
if (!process.env.ADMIN_PASS && !fs.existsSync('/run/secrets/ADMIN_PASS')) {
  console.warn('⚠️  ADVERTENCIA: Usando contraseña de admin por defecto.');
  console.warn('   Define ADMIN_PASS como env var o Docker secret en producción.');
}

// PIN exclusivo para el Super Admin (opcional pero recomendado)
const SUPERADMIN_PASS = readSecret('SUPERADMIN_PASS', '');

// ── PAYMENT PROVIDERS ──
const STRIPE_SECRET_KEY     = readSecret('STRIPE_SECRET_KEY', '');
const STRIPE_WEBHOOK_SECRET = readSecret('STRIPE_WEBHOOK_SECRET', '');
const MP_ACCESS_TOKEN       = readSecret('MP_ACCESS_TOKEN', '');
const MP_WEBHOOK_SECRET     = readSecret('MP_WEBHOOK_SECRET', '');

let _stripe = null;
function getStripe() {
  if (!STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = require('stripe')(STRIPE_SECRET_KEY);
  return _stripe;
}

let _mpClient = null;
function getMPClient() {
  if (!MP_ACCESS_TOKEN) return null;
  if (!_mpClient) {
    const { MercadoPagoConfig } = require('mercadopago');
    _mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
  }
  return _mpClient;
}

// ── PLAN DEFINITIONS ──
const PLANS = {
  free: {
    maxUrls:        5,
    customAlias:    false,
    password:       false,
    expiration:     false,
    utm:            false,
    qr:             false,
    analyticsDetail: false,
    csvExport:      false,
  },
  pro: {
    maxUrls:        Infinity,
    customAlias:    true,
    password:       true,
    expiration:     true,
    utm:            true,
    qr:             true,
    analyticsDetail: true,
    csvExport:      true,
  },
};

function getPlan(planName) {
  return PLANS[planName] || PLANS.free;
}

// ── SENTRY ──
const SENTRY_DSN = readSecret('SENTRY_DSN', '');
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
  console.log('✓ Sentry inicializado');
}

// ── STRIPE WEBHOOK (must be before express.json() to receive raw body) ──
app.post('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logError('stripe webhook verify', err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      if (s.mode === 'subscription') {
        const userId = parseInt(s.metadata?.user_id);
        if (userId) await db.activateProPlan(userId, 'stripe', s.subscription, null);
      }
    } else if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.paused') {
      const sub = event.data.object;
      const userId = parseInt(sub.metadata?.user_id);
      if (userId) await db.deactivateProPlan(userId);
      else {
        // Fallback: look up by subscription ID
        const user = await db.findUserByStripeSubscription(sub.id);
        if (user) await db.deactivateProPlan(user.id);
      }
    } else if (event.type === 'invoice.payment_failed') {
      // Grace period: don't immediately downgrade on first failure
      // Stripe will retry; 'customer.subscription.deleted' fires after all retries fail
    }
  } catch (err) {
    logError('stripe webhook process', err);
    return res.status(500).json({ error: 'Error procesando webhook' });
  }
  res.json({ received: true });
});

app.use(express.json());
app.use(morganMiddleware);

// ── SECURITY HEADERS ──
app.use(helmet({
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
  noSniff: true,
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31536000, includeSubDomains: true } : false,
  hidePoweredBy: true,
  frameguard: { action: 'deny' },
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ── SESSION (PostgreSQL store — survives restarts and multi-replica) ──
app.use(session({
  store: new PgSession({
    pool: db.pool,           // reuse the existing pg pool
    tableName: 'sessions',   // auto-created by connect-pg-simple
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 15, // prune expired sessions every 15 min
  }),
  secret: readSecret('SESSION_SECRET', crypto.randomBytes(32).toString('hex')),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// Static files — but handle root and /dashboard explicitly before static
app.get('/', (req, res) => {
  if (req.session?.admin)  return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  if (req.session?.userId) return res.redirect('/dashboard');
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  if (req.session?.admin)  return res.redirect('/');
  if (req.session?.userId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session?.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '..', 'public', 'app.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// ── RATE LIMITING ──
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

const rateLimitHandler = (req, res) => {
  res.status(429).json({
    error: 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.',
    retryAfter: Math.ceil(req.rateLimit.resetTime / 1000 - Date.now() / 1000),
  });
};

function makeStrictLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    handler: rateLimitHandler, skipSuccessfulRequests: true,
  });
}
const loginLimiter  = makeStrictLimiter();
const unlockLimiter = makeStrictLimiter();

const shortenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});
const redirectLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120,
  standardHeaders: true, legacyHeaders: false, handler: rateLimitHandler,
});

// ── AUTH MIDDLEWARES ──
function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  res.status(401).json({ error: 'No autenticado', redirect: '/login' });
}

function requireSuperAdmin(req, res, next) {
  if (!req.session?.admin) return res.status(401).json({ error: 'No autenticado', redirect: '/login' });
  if (SUPERADMIN_PASS && !req.session?.superadmin) {
    return res.status(403).json({ error: 'PIN de Super Admin requerido', locked: true });
  }
  next();
}

function requireUser(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'No autenticado', redirect: '/login' });
}

function requireUserOrAdmin(req, res, next) {
  if (req.session?.userId || req.session?.admin) return next();
  res.status(401).json({ error: 'No autenticado', redirect: '/login' });
}

async function requireApiKey(req, res, next) {
  const header = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const raw    = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (!raw) return res.status(401).json({ error: 'API key requerida. Usa el header Authorization: Bearer <key>' });
  const entry = await db.findApiKey(hashKey(raw));
  if (!entry)  return res.status(401).json({ error: 'API key inválida o revocada' });
  await db.touchApiKey(hashKey(raw));
  req.apiKey = entry;
  next();
}

function requireAdminOrKey(req, res, next) {
  if (req.session?.admin) return next();
  return requireApiKey(req, res, next);
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function isDuplicateKey(err) {
  // PostgreSQL: "duplicate key value violates unique constraint"
  return err.code === '23505' || err.message?.includes('duplicate key');
}

// ── ADMIN AUTH ROUTES ──
app.post('/api/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });
  if (username !== ADMIN_USER || password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Credenciales incorrectas' });
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

// ── USER AUTH ROUTES ──
app.post('/api/auth/register', loginLimiter, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email inválido' });
  if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  if (name && name.trim().length > 60) return res.status(400).json({ error: 'Nombre demasiado largo' });
  const exists = await db.findUserByEmail(email);
  if (exists) return res.status(409).json({ error: 'Ya existe una cuenta con ese email' });
  const password_hash = await bcrypt.hash(password, 10);
  const user = await db.createUser(email, password_hash, name);
  req.session.userId = user.id;
  req.session.userPlan = user.plan;
  res.status(201).json({ ok: true, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const user = await db.findUserByEmail(email);
  if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' });
  if (!user.active) return res.status(403).json({ error: 'Cuenta desactivada. Contacta al soporte.' });
  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Credenciales incorrectas' });
  req.session.userId = user.id;
  req.session.userPlan = user.plan;
  res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, plan: user.plan } });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ authenticated: false });
  let user = await db.findUserById(req.session.userId);
  if (!user || !user.active) return res.status(401).json({ authenticated: false });
  // Auto-expire time-limited plans (MercadoPago one-time)
  if (user.plan === 'pro' && user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
    await db.deactivateProPlan(user.id);
    user = await db.findUserById(user.id);
  }
  req.session.userPlan = user.plan;
  const plan = getPlan(user.plan);
  const urlCount = await db.countUserUrls(user.id);
  res.json({
    authenticated: true,
    user: {
      id: user.id, email: user.email, name: user.name, plan: user.plan,
      plan_expires_at: user.plan_expires_at || null,
      payment_provider: user.payment_provider || null,
    },
    limits: { ...plan, urlCount, maxUrls: plan.maxUrls === Infinity ? null : plan.maxUrls },
  });
});

app.post('/api/auth/change-password', requireUser, async (req, res) => {
  const { current, newPassword } = req.body || {};
  if (!current || !newPassword) return res.status(400).json({ error: 'Contraseñas requeridas' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  const user = await db.findUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const match = await bcrypt.compare(current, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
  const password_hash = await bcrypt.hash(newPassword, 10);
  await db.updateUserPassword(user.id, password_hash);
  res.json({ ok: true });
});

// ── PAYMENTS ──

// GET /api/payments/pricing — returns pricing for the user's detected country
app.get('/api/payments/pricing', (req, res) => {
  const country = pay.getCountryFromReq(req);
  const stripeActive  = !!STRIPE_SECRET_KEY;
  const mpActive      = !!MP_ACCESS_TOKEN;
  res.json({
    country,
    stripe: stripeActive ? {
      monthly: pay.getStripePrice(country, 'monthly'),
      yearly:  pay.getStripePrice(country, 'yearly'),
    } : null,
    mercadopago: (mpActive && pay.getMPPrice(country, 'monthly')) ? {
      monthly: pay.getMPPrice(country, 'monthly'),
      yearly:  pay.getMPPrice(country, 'yearly'),
    } : null,
  });
});

// POST /api/payments/stripe/checkout — create Stripe Checkout session
app.post('/api/payments/stripe/checkout', requireUser, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado en este servidor.' });
  const { period } = req.body;
  if (!['monthly', 'yearly'].includes(period))
    return res.status(400).json({ error: 'period debe ser monthly o yearly' });
  const user    = await db.findUserById(req.session.userId);
  const country = pay.getCountryFromReq(req);
  const price   = pay.getStripePrice(country, period);

  // Get or create Stripe customer
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name:  user.name  || undefined,
      metadata: { user_id: String(user.id) },
    });
    customerId = customer.id;
    await db.updateStripeCustomer(user.id, customerId);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{
      price_data: {
        currency:   price.currency,
        unit_amount: price.unit_amount,
        recurring:  { interval: period === 'monthly' ? 'month' : 'year' },
        product_data: {
          name:        'LabShortURL Pro',
          description: period === 'monthly' ? 'Plan Pro Mensual' : 'Plan Pro Anual',
        },
      },
      quantity: 1,
    }],
    success_url: `${BASE_URL}/upgrade?success=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${BASE_URL}/upgrade?cancelled=1`,
    metadata:          { user_id: String(user.id), period },
    subscription_data: { metadata: { user_id: String(user.id), period } },
    allow_promotion_codes: true,
  });
  res.json({ url: session.url });
});

// POST /api/payments/mercadopago/checkout — create MercadoPago Preference (one-time)
app.post('/api/payments/mercadopago/checkout', requireUser, async (req, res) => {
  const mpClient = getMPClient();
  if (!mpClient) return res.status(503).json({ error: 'MercadoPago no configurado en este servidor.' });
  const { period } = req.body;
  if (!['monthly', 'yearly'].includes(period))
    return res.status(400).json({ error: 'period debe ser monthly o yearly' });
  const user    = await db.findUserById(req.session.userId);
  const country = pay.getCountryFromReq(req);
  const price   = pay.getMPPrice(country, period);
  if (!price) return res.status(400).json({ error: 'MercadoPago no está disponible en tu región. Usa Stripe.' });

  const { Preference } = require('mercadopago');
  const preference = new Preference(mpClient);
  const result = await preference.create({
    body: {
      items: [{
        title:        `LabShortURL Pro — Plan ${period === 'monthly' ? 'Mensual' : 'Anual'}`,
        quantity:     1,
        unit_price:   price.amount,
        currency_id:  price.currency,
      }],
      payer:              { email: user.email },
      back_urls: {
        success: `${BASE_URL}/upgrade?success=1&provider=mp`,
        failure: `${BASE_URL}/upgrade?cancelled=1`,
        pending: `${BASE_URL}/upgrade?pending=1`,
      },
      auto_return:        'approved',
      external_reference: `user_${user.id}_${period}_${Date.now()}`,
      notification_url:   `${BASE_URL}/api/payments/mercadopago/webhook`,
      metadata:           { user_id: String(user.id), period },
    },
  });
  res.json({ url: result.init_point });
});

// POST /api/payments/mercadopago/webhook — IPN from MercadoPago
app.post('/api/payments/mercadopago/webhook', async (req, res) => {
  const mpClient = getMPClient();
  if (!mpClient) return res.status(503).end();
  try {
    const { type, data } = req.body;
    if (type === 'payment' && data?.id) {
      const { Payment } = require('mercadopago');
      const paymentApi  = new Payment(mpClient);
      const payment     = await paymentApi.get({ id: data.id });
      if (payment.status === 'approved') {
        const ref    = payment.external_reference || '';
        // external_reference format: "user_{id}_{period}_{ts}"
        const match  = ref.match(/^user_(\d+)_(monthly|yearly)_/);
        if (match) {
          const userId   = parseInt(match[1]);
          const period   = match[2];
          const expiresAt = pay.mpExpiresAt(period);
          await db.activateProPlan(userId, 'mercadopago', String(data.id), expiresAt);
        }
      }
    }
  } catch (err) {
    logError('mp webhook', err);
  }
  res.status(200).end();
});

// GET /upgrade — serve upgrade page
app.get('/upgrade', (req, res) => {
  if (!req.session?.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '..', 'public', 'upgrade.html'));
});

// ── API KEY MANAGEMENT ──
app.post('/api/keys', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'El nombre de la API key es requerido' });
  const raw    = `lsu_${nanoid(32)}`;
  const prefix = raw.slice(0, 10) + '…';
  await db.createApiKey(hashKey(raw), prefix, name.trim());
  res.status(201).json({ key: raw, prefix, name: name.trim(), note: 'Guarda esta clave ahora, no se mostrará de nuevo.' });
});

app.get('/api/keys', requireAdmin, async (req, res) => {
  res.json(await db.listApiKeys());
});

app.delete('/api/keys/:id', requireAdmin, async (req, res) => {
  const info = await db.revokeApiKey(parseInt(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'Key no encontrada' });
  res.json({ ok: true });
});

// ── SHORTEN (admin/key OR user) ──
app.post('/api/shorten', shortenLimiter, async (req, res, next) => {
  // Accept admin session, API key, OR user session
  if (!req.session?.admin && !req.session?.userId) {
    // Try API key fallback
    const header = req.headers['authorization'] || req.headers['x-api-key'] || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!raw) return res.status(401).json({ error: 'No autenticado' });
    const entry = await db.findApiKey(hashKey(raw));
    if (!entry) return res.status(401).json({ error: 'API key inválida o revocada' });
    await db.touchApiKey(hashKey(raw));
    req.apiKey = entry;
  }
  next();
}, async (req, res) => {
  const isUser  = !!req.session?.userId;
  const isAdmin = !!req.session?.admin || !!req.apiKey;

  const { url, alias, max_clicks, expires_at, password,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          show_preview } = req.body;

  if (!url || !isValidUrl(url))
    return res.status(400).json({ error: 'URL inválida. Incluye http:// o https://' });
  if (alias && !/^[a-zA-Z0-9_-]{3,30}$/.test(alias))
    return res.status(400).json({ error: 'El alias solo puede contener letras, números, - y _  (3-30 caracteres)' });
  if (max_clicks != null && max_clicks !== '') {
    const n = parseInt(max_clicks);
    if (!Number.isInteger(n) || n < 1)
      return res.status(400).json({ error: 'El límite de clics debe ser un número entero mayor a 0' });
  }
  if (expires_at) {
    const d = new Date(expires_at);
    if (isNaN(d.getTime()) || d <= new Date())
      return res.status(400).json({ error: 'La fecha de expiración debe ser futura' });
  }
  if (password && password.length < 4)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 4 caracteres' });

  // ── Plan enforcement for users ──
  let user_id = null;
  if (isUser && !isAdmin) {
    const user = await db.findUserById(req.session.userId);
    if (!user || !user.active) return res.status(403).json({ error: 'Cuenta inválida' });
    const plan = getPlan(user.plan);
    user_id = user.id;

    const urlCount = await db.countUserUrls(user_id);
    if (plan.maxUrls !== Infinity && urlCount >= plan.maxUrls) {
      return res.status(403).json({
        error: `Has alcanzado el límite de ${plan.maxUrls} URLs del plan gratuito.`,
        plan_limit: true, feature: 'maxUrls',
      });
    }
    if (alias && !plan.customAlias)
      return res.status(403).json({ error: 'El alias personalizado requiere plan Pro.', plan_required: 'pro', feature: 'customAlias' });
    if (password && !plan.password)
      return res.status(403).json({ error: 'La protección con contraseña requiere plan Pro.', plan_required: 'pro', feature: 'password' });
    if (expires_at && !plan.expiration)
      return res.status(403).json({ error: 'La fecha de expiración requiere plan Pro.', plan_required: 'pro', feature: 'expiration' });
    const hasUtmInput = [utm_source, utm_medium, utm_campaign, utm_term, utm_content].some(v => v?.trim());
    if (hasUtmInput && !plan.utm)
      return res.status(403).json({ error: 'Los parámetros UTM requieren plan Pro.', plan_required: 'pro', feature: 'utm' });
  }

  const code = nanoid(7);
  const password_hash = password ? await bcrypt.hash(password, 10) : null;

  let finalUrl = url;
  const utmParams = { utm_source, utm_medium, utm_campaign, utm_term, utm_content };
  const hasUtm = Object.values(utmParams).some(v => v?.trim());
  if (hasUtm) {
    const u = new URL(url);
    for (const [k, v] of Object.entries(utmParams)) {
      if (v?.trim()) u.searchParams.set(k, v.trim());
    }
    finalUrl = u.toString();
  }

  try {
    await db.createUrl(code, finalUrl, {
      alias: alias || null,
      max_clicks: max_clicks ? parseInt(max_clicks) : null,
      expires_at: expires_at || null,
      password_hash,
      ...utmParams,
      show_preview: !!show_preview,
      user_id,
    });
  } catch (err) {
    if (isDuplicateKey(err))
      return res.status(409).json({ error: 'El alias ya está en uso. Elige otro.' });
    logError('POST /api/shorten', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }

  const shortCode = alias || code;
  res.json({
    short: `${BASE_URL}/${shortCode}`, code: shortCode, original: finalUrl,
    max_clicks: max_clicks || null, expires_at: expires_at || null,
    protected: !!password, show_preview: !!show_preview,
    utm: hasUtm ? utmParams : null,
  });
});

// ── API v1 (key-protected) ──
app.get('/api/v1/urls', requireApiKey, async (req, res) => {
  const { q = '', status = 'all', sort = 'newest' } = req.query;
  const urls = await db.getAll({ q: q.trim(), status, sort });
  res.json(urls.map(u => ({
    ...u, short: `${BASE_URL}/${u.alias || u.code}`,
    status: urlStatus(u), protected: !!u.password_hash, password_hash: undefined,
  })));
});

app.get('/api/v1/stats/:code', requireApiKey, async (req, res) => {
  const entry = await db.getStats(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ...entry, short: `${BASE_URL}/${entry.alias || entry.code}`, status: urlStatus(entry), password_hash: undefined });
});

app.get('/api/v1/analytics', requireApiKey, async (req, res) => {
  const [global, top] = await Promise.all([db.getGlobalStats(), db.getTopUrls()]);
  res.json({ ...global, topUrls: top.map(u => ({ ...u, short: `${BASE_URL}/${u.alias || u.code}`, status: urlStatus(u), password_hash: undefined })) });
});

app.post('/api/v1/shorten', requireApiKey, async (req, res) => {
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
    await db.createUrl(code, finalUrl, { alias: alias || null, max_clicks: max_clicks ? parseInt(max_clicks) : null, expires_at: expires_at || null, password_hash, show_preview: !!show_preview, ...utmParams });
  } catch (err) {
    if (isDuplicateKey(err)) return res.status(409).json({ error: 'Alias en uso' });
    return res.status(500).json({ error: 'Error interno' });
  }
  const shortCode = alias || code;
  res.json({ short: `${BASE_URL}/${shortCode}`, code: shortCode, original: finalUrl });
});

// ── PUBLIC ROUTES ──
app.get('/api/preview/:code', async (req, res) => {
  const entry = await db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  if (urlStatus(entry) === 'expired') return res.status(410).json({ error: 'Expirado' });
  res.json({ code: entry.alias || entry.code, original: entry.original, short: `${BASE_URL}/${entry.alias || entry.code}` });
});

app.post('/api/record/:code', apiLimiter, async (req, res) => {
  const entry = await db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  await db.recordClick(entry.code, { referrer: req.headers.referer || '', userAgent: req.headers['user-agent'] || '', ...getGeo(req) });
  res.json({ ok: true });
});

app.post('/api/unlock/:code', unlockLimiter, async (req, res) => {
  const entry = await db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  if (urlStatus(entry) === 'expired') return res.status(410).json({ error: 'Este enlace ha expirado' });
  if (!entry.password_hash) return res.status(400).json({ error: 'Este enlace no tiene contraseña' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' });
  const match = await bcrypt.compare(password, entry.password_hash);
  if (!match) return res.status(401).json({ error: 'Contraseña incorrecta' });
  await db.recordClick(entry.code, { referrer: req.headers.referer || '', userAgent: req.headers['user-agent'] || '', ...getGeo(req) });
  res.json({ url: entry.original });
});

// ── HELPER: check URL ownership ──
async function ownsUrl(entry, req) {
  if (req.session?.admin) return true;
  if (req.session?.userId && entry.user_id === req.session.userId) return true;
  return false;
}

// ── URL ROUTES (admin OR user-scoped) ──
app.get('/api/urls', requireUserOrAdmin, async (req, res) => {
  const { q = '', status = 'all', sort = 'newest' } = req.query;
  const user_id = req.session?.admin ? null : req.session.userId;
  const urls = await db.getAll({ q: q.trim(), status, sort, user_id });
  res.json(urls.map(u => ({ ...u, short: `${BASE_URL}/${u.alias || u.code}`, status: urlStatus(u), protected: !!u.password_hash, password_hash: undefined })));
});

app.get('/api/stats/:code', requireUserOrAdmin, async (req, res) => {
  const entry = await db.getStats(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  if (!await ownsUrl(entry, req)) return res.status(403).json({ error: 'No autorizado' });
  res.json({ ...entry, short: `${BASE_URL}/${entry.alias || entry.code}`, status: urlStatus(entry), protected: !!entry.password_hash, password_hash: undefined });
});

app.get('/api/analytics/:code', requireUserOrAdmin, async (req, res) => {
  const entry = await db.getStats(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  if (!await ownsUrl(entry, req)) return res.status(403).json({ error: 'No autorizado' });
  // Plan check: full analytics only for pro users (admin always has access)
  if (req.session?.userId && !req.session?.admin) {
    const user = await db.findUserById(req.session.userId);
    if (!getPlan(user?.plan).analyticsDetail) {
      // Return only basic stats
      const analytics = await db.getAnalytics(entry.code);
      return res.json({ ...entry, short: `${BASE_URL}/${entry.alias || entry.code}`, status: urlStatus(entry), protected: !!entry.password_hash, password_hash: undefined, byDay: analytics.byDay, byBrowser: [], byDevice: [], byReferrer: [], byCountry: [], recent: [], plan_limited: true });
    }
  }
  const analytics = await db.getAnalytics(entry.code);
  res.json({ ...entry, short: `${BASE_URL}/${entry.alias || entry.code}`, status: urlStatus(entry), protected: !!entry.password_hash, password_hash: undefined, ...analytics });
});

app.put('/api/urls/:code', requireUserOrAdmin, async (req, res) => {
  const entry = await db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  if (!await ownsUrl(entry, req)) return res.status(403).json({ error: 'No autorizado' });

  // Plan check for users editing
  if (req.session?.userId && !req.session?.admin) {
    const user = await db.findUserById(req.session.userId);
    const plan = getPlan(user?.plan);
    const { alias, expires_at } = req.body;
    if (alias && !plan.customAlias)
      return res.status(403).json({ error: 'El alias personalizado requiere plan Pro.', plan_required: 'pro', feature: 'customAlias' });
    if (expires_at && !plan.expiration)
      return res.status(403).json({ error: 'La fecha de expiración requiere plan Pro.', plan_required: 'pro', feature: 'expiration' });
  }

  const { url, alias, max_clicks, expires_at, show_preview } = req.body;
  if (!url || !isValidUrl(url))
    return res.status(400).json({ error: 'URL inválida. Incluye http:// o https://' });
  if (alias && !/^[a-zA-Z0-9_-]{3,30}$/.test(alias))
    return res.status(400).json({ error: 'El alias solo puede contener letras, números, - y _ (3-30 caracteres)' });
  if (max_clicks != null && max_clicks !== '') {
    const n = parseInt(max_clicks);
    if (!Number.isInteger(n) || n < 1)
      return res.status(400).json({ error: 'El límite de clics debe ser un número entero mayor a 0' });
  }
  if (expires_at && isNaN(new Date(expires_at).getTime()))
    return res.status(400).json({ error: 'Fecha de expiración inválida' });

  const newAlias = alias || null;
  if (newAlias && newAlias !== entry.alias) {
    const existing = await db.findByCode(newAlias);
    if (existing && existing.code !== entry.code)
      return res.status(409).json({ error: 'El alias ya está en uso. Elige otro.' });
  }

  try {
    await db.updateUrl(entry.code, {
      original: url, alias: newAlias,
      max_clicks: max_clicks ? parseInt(max_clicks) : null,
      expires_at: expires_at || null, show_preview: !!show_preview,
    });
  } catch (err) {
    if (isDuplicateKey(err))
      return res.status(409).json({ error: 'El alias ya está en uso. Elige otro.' });
    logError('PUT /api/urls/:code', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }

  const updated = await db.findByCode(entry.code);
  res.json({ ...updated, short: `${BASE_URL}/${updated.alias || updated.code}`, status: urlStatus(updated), protected: !!updated.password_hash, password_hash: undefined });
});

app.delete('/api/urls/:code', requireUserOrAdmin, async (req, res) => {
  const entry = await db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  if (!await ownsUrl(entry, req)) return res.status(403).json({ error: 'No autorizado' });
  const info = await db.deleteUrl(entry.code);
  if (info.changes === 0) return res.status(404).json({ error: 'No encontrado' });
  res.json({ ok: true });
});

// ── USER ANALYTICS (aggregate) ──
app.get('/api/user/analytics', requireUser, async (req, res) => {
  const user = await db.findUserById(req.session.userId);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const plan = getPlan(user.plan);
  const data = await db.getUserAnalytics(req.session.userId);
  if (!plan.analyticsDetail) {
    // Only return summary + byDay for free plan
    return res.json({ ...data, byCountry: [], byBrowser: [], byDevice: [], plan_limited: true });
  }
  res.json(data);
});

// ── EXPORT CSV (user or admin) ──
app.get('/api/export/csv', requireUserOrAdmin, async (req, res) => {
  if (req.session?.userId && !req.session?.admin) {
    const user = await db.findUserById(req.session.userId);
    if (!getPlan(user?.plan).csvExport)
      return res.status(403).json({ error: 'La exportación CSV requiere plan Pro.', plan_required: 'pro', feature: 'csvExport' });
  }
  const { q = '', status = 'all', sort = 'newest' } = req.query;
  const user_id = req.session?.admin ? null : req.session?.userId;
  const urls = await db.getAll({ q: q.trim(), status, sort, user_id });
  const escape = v => {
    if (v == null) return '';
    const str = String(v);
    return str.includes(',') || str.includes('"') || str.includes('\n')
      ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const headers = ['Enlace corto','URL original','Código','Alias','Clics','Límite clics','Expira el','Protegida','Estado','Creada el'];
  const rows = urls.map(u => [
    `${BASE_URL}/${u.alias || u.code}`, u.original, u.code, u.alias || '',
    u.clicks, u.max_clicks || '', u.expires_at || '',
    u.password_hash ? 'Sí' : 'No',
    urlStatus(u) === 'expired' ? 'Expirada' : 'Activa', u.created_at,
  ].map(escape).join(','));
  const csv = [headers.join(','), ...rows].join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="labshorturl-export-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\uFEFF' + csv);
});

// ── ADMIN-ONLY: health, API keys listing, global analytics ──
app.get('/api/urls/:code/health', requireAdmin, async (req, res) => {
  const entry = await db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  res.json({ code: entry.alias || entry.code, health_status: entry.health_status, health_code: entry.health_code, last_checked: entry.last_checked });
});

app.get('/api/qr/:code', apiLimiter, async (req, res) => {
  const entry = await db.findByCode(req.params.code);
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
    const buffer = await QRCode.toBuffer(shortUrl, { type: 'png', width: size, margin: 2, color: { dark: '#4f46e5', light: '#ffffff' } });
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `inline; filename="qr-${entry.alias || entry.code}.png"`);
    res.send(buffer);
  } catch (err) {
    logError('GET /api/qr/:code', err);
    res.status(500).json({ error: 'Error generando QR' });
  }
});

app.post('/api/health/:code', requireAdmin, async (req, res) => {
  const entry = await db.findByCode(req.params.code);
  if (!entry) return res.status(404).json({ error: 'No encontrado' });
  res.json(await checkOne(entry.code, entry.original));
});

app.post('/api/health', requireAdmin, async (req, res) => {
  res.json({ checked: await checkStale() });
});


app.get('/health', async (req, res) => {
  try {
    await db.getGlobalStats();
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()), db: 'ok' });
  } catch (err) {
    logError('GET /health', err);
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

app.get('/api/analytics', requireAdmin, async (req, res) => {
  const [global, top] = await Promise.all([db.getGlobalStats(), db.getTopUrls()]);
  res.json({ ...global, topUrls: top.map(u => ({ ...u, short: `${BASE_URL}/${u.alias || u.code}`, status: urlStatus(u), protected: !!u.password_hash, password_hash: undefined })) });
});

// ── SUPER ADMIN ──
app.get('/superadmin', (req, res) => {
  if (!req.session?.admin) return res.redirect('/login');
  res.sendFile(path.join(__dirname, '..', 'public', 'superadmin.html'));
});

// Unlock: valida el PIN de super admin y lo guarda en sesión
app.post('/api/superadmin/unlock', requireAdmin, (req, res) => {
  if (!SUPERADMIN_PASS) {
    req.session.superadmin = true;
    return res.json({ ok: true });
  }
  const { pin } = req.body;
  if (!pin || pin !== SUPERADMIN_PASS) {
    return res.status(403).json({ error: 'PIN incorrecto' });
  }
  req.session.superadmin = true;
  res.json({ ok: true });
});

// Lock: cierra la sesión super admin sin cerrar la sesión admin normal
app.post('/api/superadmin/lock', requireAdmin, (req, res) => {
  req.session.superadmin = false;
  res.json({ ok: true });
});

app.get('/api/superadmin/stats', requireSuperAdmin, async (req, res) => {
  const stats = await db.getGlobalAnalyticsFull();
  res.json({ ...stats, uptime: Math.floor(process.uptime()) });
});

// Users management for super admin
app.get('/api/superadmin/users', requireSuperAdmin, async (req, res) => {
  const users = await db.getAllUsers();
  res.json(users);
});

app.patch('/api/superadmin/users/:id/plan', requireSuperAdmin, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Plan inválido. Usa: free, pro' });
  await db.updateUserPlan(parseInt(req.params.id), plan);
  res.json({ ok: true });
});

app.patch('/api/superadmin/users/:id/active', requireSuperAdmin, async (req, res) => {
  const { active } = req.body;
  await db.toggleUserActive(parseInt(req.params.id), !!active);
  res.json({ ok: true });
});

// ── PRICE MANAGEMENT ──
app.get('/api/superadmin/prices', requireSuperAdmin, (req, res) => {
  res.json(pay.getPricing());
});

app.put('/api/superadmin/prices', requireSuperAdmin, async (req, res) => {
  const { stripe, mercadopago } = req.body;
  if (!stripe && !mercadopago)
    return res.status(400).json({ error: 'Se requiere stripe o mercadopago en el body' });

  const current = pay.getPricing();
  const def     = pay.DEFAULT_PRICING;

  // Merge + validate Stripe prices
  if (stripe) {
    for (const period of ['monthly', 'yearly']) {
      if (!stripe[period]) continue;
      for (const [currency, entry] of Object.entries(stripe[period])) {
        if (!def.stripe[period]?.[currency]) continue; // unknown currency, skip
        const ua = parseInt(entry.unit_amount);
        if (!Number.isInteger(ua) || ua < 1) return res.status(400).json({ error: `Stripe ${currency} ${period}: unit_amount inválido` });
        const base = def.stripe[period][currency];
        current.stripe[period][currency] = {
          ...base,
          unit_amount: ua,
          display: pay.buildDisplay(ua / 100, base.currency.toUpperCase()),
        };
      }
    }
  }

  // Merge + validate MercadoPago prices
  if (mercadopago) {
    for (const period of ['monthly', 'yearly']) {
      if (!mercadopago[period]) continue;
      for (const [country, entry] of Object.entries(mercadopago[period])) {
        if (!def.mercadopago[period]?.[country]) continue;
        const amount = parseFloat(entry.amount);
        if (isNaN(amount) || amount < 1) return res.status(400).json({ error: `MercadoPago ${country} ${period}: amount inválido` });
        const base = def.mercadopago[period][country];
        current.mercadopago[period][country] = {
          ...base,
          amount,
          display: pay.buildDisplay(amount, base.currency),
        };
      }
    }
  }

  await db.setSetting('pricing', current);
  pay.invalidateCache();
  await pay.loadPricing(db);
  res.json({ ok: true, pricing: pay.getPricing() });
});

app.post('/api/superadmin/prices/reset', requireSuperAdmin, async (req, res) => {
  await db.setSetting('pricing', pay.DEFAULT_PRICING);
  pay.invalidateCache();
  await pay.loadPricing(db);
  res.json({ ok: true, pricing: pay.getPricing() });
});

// ── REDIRECT ──
app.get('/:code', redirectLimiter, async (req, res) => {
  const entry = await db.findByCode(req.params.code);
  if (!entry) return res.status(404).sendFile(path.join(__dirname, '..', 'public', 'expired.html'));
  if (urlStatus(entry) === 'expired') return res.status(410).sendFile(path.join(__dirname, '..', 'public', 'expired.html'));
  if (entry.password_hash) return res.sendFile(path.join(__dirname, '..', 'public', 'unlock.html'));
  if (entry.show_preview)  return res.sendFile(path.join(__dirname, '..', 'public', 'preview.html'));
  await db.recordClick(entry.code, { referrer: req.headers.referer || req.headers.referrer || '', userAgent: req.headers['user-agent'] || '', ...getGeo(req) });
  res.redirect(302, entry.original);
});

// ── ERROR HANDLER ──
if (SENTRY_DSN) Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, _next) => {
  logError(`${req.method} ${req.path}`, err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── STARTUP ──
async function start() {
  await db.init();
  console.log('✓ Base de datos PostgreSQL lista');
  await pay.loadPricing(db);
  console.log('✓ Precios cargados');

  const server = app.listen(PORT, () => {
    console.log(`LabShortURL corriendo en ${BASE_URL}`);
    startBackgroundChecker();
    // Expire overdue MercadoPago one-time plans every hour
    setInterval(() => db.expireOverduePlans().catch(err => logError('expireOverduePlans', err)), 60 * 60 * 1000);
  });

  function shutdown(signal) {
    console.log(`\n${signal} recibido. Cerrando servidor…`);
    server.close(async () => {
      await db.pool.end();
      console.log('Servidor y pool de DB cerrados correctamente.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

process.on('uncaughtException',  err => { logError('uncaughtException',  err); process.exit(1); });
process.on('unhandledRejection', err => { logError('unhandledRejection', err); process.exit(1); });

start().catch(err => { logError('startup', err); process.exit(1); });

// ── HELPERS ──
function getGeo(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  const clean = ip?.replace(/^::ffff:/, '') || '';
  const geo = geoip.lookup(clean);
  return {
    country:      geo?.country ? isoToName(geo.country) : null,
    country_code: geo?.country || null,
    city:         geo?.city    || null,
  };
}

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
  } catch { return false; }
}
