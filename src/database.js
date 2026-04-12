const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ||
    'postgresql://labshorturl:labshorturl@localhost:5432/labshorturl',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ── SCHEMA ──
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      id            SERIAL PRIMARY KEY,
      code          TEXT    NOT NULL UNIQUE,
      original      TEXT    NOT NULL,
      alias         TEXT    UNIQUE,
      clicks        INTEGER NOT NULL DEFAULT 0,
      max_clicks    INTEGER,
      expires_at    TIMESTAMPTZ,
      password_hash TEXT,
      utm_source    TEXT,
      utm_medium    TEXT,
      utm_campaign  TEXT,
      utm_term      TEXT,
      utm_content   TEXT,
      show_preview  BOOLEAN NOT NULL DEFAULT FALSE,
      health_status TEXT    NOT NULL DEFAULT 'unknown',
      health_code   INTEGER,
      last_checked  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_code  ON urls(code);
    CREATE INDEX IF NOT EXISTS idx_alias ON urls(alias);

    CREATE TABLE IF NOT EXISTS clicks (
      id           SERIAL PRIMARY KEY,
      url_code     TEXT    NOT NULL,
      clicked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      referrer     TEXT,
      ua_browser   TEXT,
      ua_device    TEXT,
      country      TEXT,
      country_code TEXT,
      city         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks(url_code);
    CREATE INDEX IF NOT EXISTS idx_clicks_at   ON clicks(clicked_at);

    CREATE TABLE IF NOT EXISTS api_keys (
      id         SERIAL PRIMARY KEY,
      key_hash   TEXT    NOT NULL UNIQUE,
      prefix     TEXT    NOT NULL,
      name       TEXT    NOT NULL,
      last_used  TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_api_key_hash ON api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT        NOT NULL UNIQUE,
      password_hash TEXT        NOT NULL,
      name          TEXT,
      plan          TEXT        NOT NULL DEFAULT 'free',
      active        BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  `);

  // Idempotent column migrations — ADD COLUMN IF NOT EXISTS (PostgreSQL 9.6+)
  const migrations = [
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS max_clicks    INTEGER`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS expires_at    TIMESTAMPTZ`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS password_hash TEXT`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS utm_source    TEXT`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS utm_medium    TEXT`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS utm_campaign  TEXT`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS utm_term      TEXT`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS utm_content   TEXT`,
    `ALTER TABLE clicks ADD COLUMN IF NOT EXISTS country_code TEXT`,
    `ALTER TABLE clicks ADD COLUMN IF NOT EXISTS city         TEXT`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS show_preview  BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS health_status TEXT    NOT NULL DEFAULT 'unknown'`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS health_code   INTEGER`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS last_checked  TIMESTAMPTZ`,
    `ALTER TABLE urls ADD COLUMN IF NOT EXISTS user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL`,
    // Payment / subscription columns
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id      VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id  VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_subscription_id      VARCHAR(255)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at         TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS payment_provider        VARCHAR(50)`,
  ];
  for (const sql of migrations) {
    await pool.query(sql);
  }
}

// ── HELPERS ──
async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function queryAll(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

function parseUA(ua = '') {
  let browser = 'Otro';
  if (/Edg\//i.test(ua))          browser = 'Edge';
  else if (/OPR\//i.test(ua))     browser = 'Opera';
  else if (/Chrome\//i.test(ua))  browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua))  browser = 'Safari';
  else if (/curl|wget|python|axios|node/i.test(ua)) browser = 'Bot/API';

  let device = 'Desktop';
  if (/Mobi|Android|iPhone|iPad/i.test(ua)) device = 'Mobile';
  else if (/Tablet|iPad/i.test(ua))          device = 'Tablet';

  return { browser, device };
}

function cleanReferrer(ref = '') {
  if (!ref) return null;
  try {
    return new URL(ref).hostname.replace(/^www\./, '');
  } catch {
    return ref.slice(0, 100);
  }
}

// ── EXPORTS ──
module.exports = {
  init,
  pool, // exposed for health check

  async createUrl(code, original, {
    alias = null, max_clicks = null, expires_at = null, password_hash = null,
    utm_source = null, utm_medium = null, utm_campaign = null,
    utm_term = null, utm_content = null, show_preview = false, user_id = null,
  } = {}) {
    return pool.query(
      `INSERT INTO urls
         (code, original, alias, max_clicks, expires_at, password_hash,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content, show_preview, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [code, original, alias || null, max_clicks || null, expires_at || null,
       password_hash || null, utm_source || null, utm_medium || null,
       utm_campaign || null, utm_term || null, utm_content || null,
       !!show_preview, user_id || null],
    );
  },

  async findByCode(code) {
    return queryOne(
      `SELECT * FROM urls WHERE code = $1 OR alias = $1 LIMIT 1`,
      [code],
    );
  },

  async recordClick(code, { referrer, userAgent, country = null, country_code = null, city = null } = {}) {
    const { browser, device } = parseUA(userAgent);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE urls SET clicks = clicks + 1 WHERE code = $1', [code]);
      await client.query(
        `INSERT INTO clicks (url_code, referrer, ua_browser, ua_device, country, country_code, city)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [code, cleanReferrer(referrer), browser, device, country, country_code, city],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async getAll({ q = '', status = 'all', sort = 'newest', user_id = null } = {}) {
    const conditions = [];
    const params = [];
    let i = 1;

    // Scope to user if user_id provided (omit for admin = see all)
    if (user_id !== null) {
      conditions.push(`user_id = $${i}`);
      params.push(user_id);
      i++;
    }

    if (q) {
      conditions.push(`(original ILIKE $${i} OR code ILIKE $${i+1} OR alias ILIKE $${i+2})`);
      const like = `%${q}%`;
      params.push(like, like, like);
      i += 3;
    }

    if (status === 'active') {
      conditions.push(`(expires_at IS NULL OR expires_at > NOW())`);
      conditions.push(`(max_clicks IS NULL OR clicks < max_clicks)`);
      conditions.push(`password_hash IS NULL`);
    } else if (status === 'expired') {
      conditions.push(`(
        (expires_at IS NOT NULL AND expires_at <= NOW())
        OR (max_clicks IS NOT NULL AND clicks >= max_clicks)
      )`);
    } else if (status === 'protected') {
      conditions.push(`password_hash IS NOT NULL`);
    } else if (status === 'limited') {
      conditions.push(`(expires_at IS NOT NULL OR max_clicks IS NOT NULL)`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderMap = {
      newest: 'created_at DESC',
      oldest: 'created_at ASC',
      most:   'clicks DESC',
      least:  'clicks ASC',
      alpha:  'original ASC',
    };
    const order = orderMap[sort] || 'created_at DESC';

    return queryAll(`SELECT * FROM urls ${where} ORDER BY ${order} LIMIT 200`, params);
  },

  async getStats(code) {
    return queryOne(
      `SELECT code, alias, original, clicks, max_clicks, expires_at, password_hash,
              utm_source, utm_medium, utm_campaign, utm_term, utm_content,
              show_preview, created_at
       FROM urls WHERE code = $1 OR alias = $1 LIMIT 1`,
      [code],
    );
  },

  async getAnalytics(code) {
    const [byDay, byBrowser, byDevice, byReferrer, byCountry, recent] = await Promise.all([
      queryAll(
        `SELECT TO_CHAR(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
         FROM clicks WHERE url_code = $1
         GROUP BY day ORDER BY day DESC LIMIT 30`, [code]),
      queryAll(
        `SELECT ua_browser AS label, COUNT(*)::int AS count
         FROM clicks WHERE url_code = $1
         GROUP BY ua_browser ORDER BY count DESC LIMIT 10`, [code]),
      queryAll(
        `SELECT ua_device AS label, COUNT(*)::int AS count
         FROM clicks WHERE url_code = $1
         GROUP BY ua_device ORDER BY count DESC LIMIT 10`, [code]),
      queryAll(
        `SELECT COALESCE(referrer, 'Directo') AS label, COUNT(*)::int AS count
         FROM clicks WHERE url_code = $1
         GROUP BY referrer ORDER BY count DESC LIMIT 10`, [code]),
      queryAll(
        `SELECT COALESCE(country, 'Desconocido') AS label, country_code, COUNT(*)::int AS count
         FROM clicks WHERE url_code = $1
         GROUP BY country, country_code ORDER BY count DESC LIMIT 15`, [code]),
      queryAll(
        `SELECT clicked_at, referrer, ua_browser, ua_device, country, country_code, city
         FROM clicks WHERE url_code = $1
         ORDER BY clicked_at DESC LIMIT 20`, [code]),
    ]);
    return { byDay, byBrowser, byDevice, byReferrer, byCountry, recent };
  },

  async getTopUrls() {
    return queryAll(
      `SELECT code, alias, original, clicks, created_at, max_clicks, expires_at, password_hash
       FROM urls ORDER BY clicks DESC LIMIT 10`,
    );
  },

  async getGlobalStats() {
    const [summary, byDay, byCountry] = await Promise.all([
      queryOne(`
        SELECT
          (SELECT COUNT(*)::int FROM urls)   AS total_urls,
          (SELECT COUNT(*)::int FROM clicks) AS total_clicks,
          (SELECT COUNT(*)::int FROM clicks WHERE clicked_at >= NOW() - INTERVAL '1 day')  AS clicks_24h,
          (SELECT COUNT(*)::int FROM clicks WHERE clicked_at >= NOW() - INTERVAL '7 days') AS clicks_7d
      `),
      queryAll(`
        SELECT TO_CHAR(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
        FROM clicks GROUP BY day ORDER BY day DESC LIMIT 30
      `),
      queryAll(`
        SELECT COALESCE(country, 'Desconocido') AS label, country_code, COUNT(*)::int AS count
        FROM clicks GROUP BY country, country_code ORDER BY count DESC LIMIT 15
      `),
    ]);
    return { summary, byDay, byCountry };
  },

  // ── HEALTH ──
  async updateHealth(code, status, httpCode = null) {
    await pool.query(
      `UPDATE urls SET health_status = $1, health_code = $2, last_checked = NOW() WHERE code = $3`,
      [status, httpCode, code],
    );
  },

  async getAllForHealth() {
    return queryAll(`
      SELECT code, original FROM urls
      WHERE last_checked IS NULL OR last_checked <= NOW() - INTERVAL '1 hour'
      ORDER BY last_checked ASC NULLS FIRST LIMIT 50
    `);
  },

  // ── URL CRUD ──
  async updateUrl(code, { original, alias = null, max_clicks = null, expires_at = null, show_preview = false } = {}) {
    return pool.query(
      `UPDATE urls
       SET original     = $1,
           alias        = $2,
           max_clicks   = $3,
           expires_at   = $4,
           show_preview = $5
       WHERE code = $6`,
      [original, alias || null, max_clicks || null, expires_at || null, !!show_preview, code],
    );
  },

  async deleteUrl(code) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM clicks WHERE url_code = $1', [code]);
      const result = await client.query('DELETE FROM urls WHERE code = $1', [code]);
      await client.query('COMMIT');
      return { changes: result.rowCount };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  // ── API KEYS ──
  async createApiKey(key_hash, prefix, name) {
    return pool.query(
      `INSERT INTO api_keys (key_hash, prefix, name) VALUES ($1, $2, $3)`,
      [key_hash, prefix, name],
    );
  },

  async findApiKey(key_hash) {
    return queryOne(`SELECT * FROM api_keys WHERE key_hash = $1 LIMIT 1`, [key_hash]);
  },

  async touchApiKey(key_hash) {
    await pool.query(`UPDATE api_keys SET last_used = NOW() WHERE key_hash = $1`, [key_hash]);
  },

  async listApiKeys() {
    return queryAll(`SELECT id, prefix, name, last_used, created_at FROM api_keys ORDER BY created_at DESC`);
  },

  async revokeApiKey(id) {
    const result = await pool.query(`DELETE FROM api_keys WHERE id = $1`, [id]);
    return { changes: result.rowCount };
  },

  // ── SUPER ADMIN ──
  async getGlobalAnalyticsFull() {
    const [summary, byDay, byHour, byCountry, byBrowser, byDevice, byReferrer, recent, topUrls] =
      await Promise.all([
        queryOne(`
          SELECT
            (SELECT COUNT(*)::int FROM urls)                                                        AS total_urls,
            (SELECT COUNT(*)::int FROM urls
              WHERE (expires_at IS NULL OR expires_at > NOW())
                AND (max_clicks IS NULL OR clicks < max_clicks)
                AND password_hash IS NULL)                                                          AS active_urls,
            (SELECT COUNT(*)::int FROM urls
              WHERE (expires_at IS NOT NULL AND expires_at <= NOW())
                 OR (max_clicks IS NOT NULL AND clicks >= max_clicks))                              AS expired_urls,
            (SELECT COUNT(*)::int FROM urls WHERE password_hash IS NOT NULL)                        AS protected_urls,
            (SELECT COUNT(*)::int FROM clicks)                                                      AS total_clicks,
            (SELECT COUNT(*)::int FROM clicks WHERE clicked_at >= CURRENT_DATE)                     AS clicks_today,
            (SELECT COUNT(*)::int FROM clicks WHERE clicked_at >= NOW() - INTERVAL '1 day')         AS clicks_24h,
            (SELECT COUNT(*)::int FROM clicks WHERE clicked_at >= NOW() - INTERVAL '7 days')        AS clicks_7d,
            (SELECT COUNT(*)::int FROM clicks WHERE clicked_at >= NOW() - INTERVAL '30 days')       AS clicks_30d
        `),
        queryAll(`
          SELECT TO_CHAR(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
          FROM clicks GROUP BY day ORDER BY day DESC LIMIT 30
        `),
        queryAll(`
          SELECT EXTRACT(HOUR FROM clicked_at AT TIME ZONE 'UTC')::int AS hour, COUNT(*)::int AS count
          FROM clicks WHERE clicked_at >= CURRENT_DATE
          GROUP BY hour ORDER BY hour
        `),
        queryAll(`
          SELECT COALESCE(country, 'Desconocido') AS label, country_code, COUNT(*)::int AS count
          FROM clicks GROUP BY country, country_code ORDER BY count DESC LIMIT 15
        `),
        queryAll(`
          SELECT ua_browser AS label, COUNT(*)::int AS count
          FROM clicks GROUP BY ua_browser ORDER BY count DESC LIMIT 10
        `),
        queryAll(`
          SELECT ua_device AS label, COUNT(*)::int AS count
          FROM clicks GROUP BY ua_device ORDER BY count DESC LIMIT 10
        `),
        queryAll(`
          SELECT COALESCE(referrer, 'Directo') AS label, COUNT(*)::int AS count
          FROM clicks GROUP BY referrer ORDER BY count DESC LIMIT 10
        `),
        queryAll(`
          SELECT c.clicked_at, c.url_code, u.alias, u.original,
                 c.referrer, c.ua_browser, c.ua_device,
                 c.country, c.country_code, c.city
          FROM clicks c LEFT JOIN urls u ON u.code = c.url_code
          ORDER BY c.clicked_at DESC LIMIT 50
        `),
        queryAll(`
          SELECT code, alias, original, clicks, max_clicks, expires_at,
                 password_hash, health_status, created_at
          FROM urls ORDER BY clicks DESC LIMIT 20
        `),
      ]);
    return { summary, byDay, byHour, byCountry, byBrowser, byDevice, byReferrer, recent, topUrls };
  },

  // ── SUPER ADMIN: USERS LIST ──
  async getAllUsers() {
    return queryAll(`
      SELECT u.id, u.email, u.name, u.plan, u.active, u.created_at,
             COUNT(ur.id)::int AS url_count,
             COALESCE(SUM(ur.clicks), 0)::int AS total_clicks
      FROM users u
      LEFT JOIN urls ur ON ur.user_id = u.id
      GROUP BY u.id ORDER BY u.created_at DESC
    `);
  },

  async updateUserPlan(id, plan) {
    return pool.query(`UPDATE users SET plan = $1 WHERE id = $2`, [plan, id]);
  },

  async toggleUserActive(id, active) {
    return pool.query(`UPDATE users SET active = $1 WHERE id = $2`, [active, id]);
  },

  // ── USER AUTH ──
  async createUser(email, password_hash, name) {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *`,
      [email.toLowerCase().trim(), password_hash, name?.trim() || null],
    );
    return result.rows[0];
  },

  async findUserByEmail(email) {
    return queryOne(`SELECT * FROM users WHERE email = $1 LIMIT 1`, [email.toLowerCase().trim()]);
  },

  async findUserById(id) {
    return queryOne(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
  },

  async countUserUrls(user_id) {
    const r = await queryOne(`SELECT COUNT(*)::int AS n FROM urls WHERE user_id = $1`, [user_id]);
    return r?.n || 0;
  },

  // User-scoped analytics (clicks on the user's URLs)
  async getUserAnalytics(user_id) {
    const [summary, byDay, byCountry, byBrowser, byDevice] = await Promise.all([
      queryOne(`
        SELECT
          (SELECT COUNT(*)::int FROM urls WHERE user_id = $1) AS total_urls,
          COALESCE((SELECT SUM(clicks)::int FROM urls WHERE user_id = $1), 0) AS total_clicks,
          (SELECT COUNT(*)::int FROM clicks c JOIN urls u ON u.code = c.url_code
           WHERE u.user_id = $1 AND c.clicked_at >= CURRENT_DATE) AS clicks_today,
          (SELECT COUNT(*)::int FROM clicks c JOIN urls u ON u.code = c.url_code
           WHERE u.user_id = $1 AND c.clicked_at >= NOW() - INTERVAL '7 days') AS clicks_7d,
          (SELECT COUNT(*)::int FROM clicks c JOIN urls u ON u.code = c.url_code
           WHERE u.user_id = $1 AND c.clicked_at >= NOW() - INTERVAL '30 days') AS clicks_30d
      `, [user_id]),
      queryAll(`
        SELECT TO_CHAR(c.clicked_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day, COUNT(*)::int AS count
        FROM clicks c JOIN urls u ON u.code = c.url_code
        WHERE u.user_id = $1
        GROUP BY day ORDER BY day DESC LIMIT 30
      `, [user_id]),
      queryAll(`
        SELECT COALESCE(c.country,'Desconocido') AS label, c.country_code, COUNT(*)::int AS count
        FROM clicks c JOIN urls u ON u.code = c.url_code
        WHERE u.user_id = $1
        GROUP BY c.country, c.country_code ORDER BY count DESC LIMIT 10
      `, [user_id]),
      queryAll(`
        SELECT c.ua_browser AS label, COUNT(*)::int AS count
        FROM clicks c JOIN urls u ON u.code = c.url_code
        WHERE u.user_id = $1
        GROUP BY c.ua_browser ORDER BY count DESC LIMIT 8
      `, [user_id]),
      queryAll(`
        SELECT c.ua_device AS label, COUNT(*)::int AS count
        FROM clicks c JOIN urls u ON u.code = c.url_code
        WHERE u.user_id = $1
        GROUP BY c.ua_device ORDER BY count DESC LIMIT 5
      `, [user_id]),
    ]);
    return { summary, byDay, byCountry, byBrowser, byDevice };
  },

  async updateUserPassword(id, password_hash) {
    return pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [password_hash, id]);
  },

  // ── PAYMENTS ──

  async updateStripeCustomer(userId, stripeCustomerId) {
    return pool.query(
      `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
      [stripeCustomerId, userId]
    );
  },

  async activateProPlan(userId, provider, subscriptionId, expiresAt = null) {
    return pool.query(
      `UPDATE users
          SET plan = 'pro',
              payment_provider       = $1,
              stripe_subscription_id = CASE WHEN $1 = 'stripe' THEN $2 ELSE stripe_subscription_id END,
              mp_subscription_id     = CASE WHEN $1 = 'mercadopago' THEN $2 ELSE mp_subscription_id END,
              plan_expires_at        = $3
        WHERE id = $4`,
      [provider, subscriptionId, expiresAt, userId]
    );
  },

  async deactivateProPlan(userId) {
    return pool.query(
      `UPDATE users
          SET plan = 'free',
              stripe_subscription_id = NULL,
              mp_subscription_id     = NULL,
              plan_expires_at        = NULL,
              payment_provider       = NULL
        WHERE id = $1`,
      [userId]
    );
  },

  async expireOverduePlans() {
    // Downgrade users whose time-limited plan has expired
    return pool.query(
      `UPDATE users SET plan = 'free', plan_expires_at = NULL, payment_provider = NULL
        WHERE plan = 'pro' AND plan_expires_at IS NOT NULL AND plan_expires_at < NOW()`
    );
  },

  async findUserByStripeCustomer(stripeCustomerId) {
    return queryOne(`SELECT * FROM users WHERE stripe_customer_id = $1 LIMIT 1`, [stripeCustomerId]);
  },

  async findUserByStripeSubscription(subscriptionId) {
    return queryOne(`SELECT * FROM users WHERE stripe_subscription_id = $1 LIMIT 1`, [subscriptionId]);
  },

  async findUserByMPSubscription(mpSubId) {
    return queryOne(`SELECT * FROM users WHERE mp_subscription_id = $1 LIMIT 1`, [mpSubId]);
  },

  async updateMPSubscription(userId, mpSubId, expiresAt) {
    return pool.query(
      `UPDATE users SET mp_subscription_id = $1, plan_expires_at = $2 WHERE id = $3`,
      [mpSubId, expiresAt, userId]
    );
  },
};
