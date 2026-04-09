const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'urls.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS urls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    NOT NULL UNIQUE,
    original      TEXT    NOT NULL,
    alias         TEXT    UNIQUE,
    clicks        INTEGER NOT NULL DEFAULT 0,
    max_clicks    INTEGER,
    expires_at    TEXT,
    password_hash TEXT,
    utm_source    TEXT,
    utm_medium    TEXT,
    utm_campaign  TEXT,
    utm_term      TEXT,
    utm_content   TEXT,
    show_preview  INTEGER NOT NULL DEFAULT 0,
    health_status TEXT    NOT NULL DEFAULT 'unknown',
    health_code   INTEGER,
    last_checked  TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_code  ON urls(code);
  CREATE INDEX IF NOT EXISTS idx_alias ON urls(alias);

  CREATE TABLE IF NOT EXISTS clicks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url_code   TEXT    NOT NULL,
    clicked_at TEXT    NOT NULL DEFAULT (datetime('now')),
    referrer   TEXT,
    ua_browser TEXT,
    ua_device  TEXT,
    country    TEXT,
    country_code TEXT,
    city       TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks(url_code);
  CREATE INDEX IF NOT EXISTS idx_clicks_at   ON clicks(clicked_at);

  CREATE TABLE IF NOT EXISTS api_keys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash   TEXT    NOT NULL UNIQUE,
    prefix     TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    last_used  TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_api_key_hash ON api_keys(key_hash);
`);

// Migrate: add columns if they don't exist yet (idempotent)
for (const col of [
  `ALTER TABLE urls ADD COLUMN max_clicks INTEGER`,
  `ALTER TABLE urls ADD COLUMN expires_at TEXT`,
  `ALTER TABLE urls ADD COLUMN password_hash TEXT`,
  `ALTER TABLE urls ADD COLUMN utm_source TEXT`,
  `ALTER TABLE urls ADD COLUMN utm_medium TEXT`,
  `ALTER TABLE urls ADD COLUMN utm_campaign TEXT`,
  `ALTER TABLE urls ADD COLUMN utm_term TEXT`,
  `ALTER TABLE urls ADD COLUMN utm_content TEXT`,
  `ALTER TABLE clicks ADD COLUMN country_code TEXT`,
  `ALTER TABLE clicks ADD COLUMN city TEXT`,
  `ALTER TABLE urls ADD COLUMN show_preview INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE urls ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown'`,
  `ALTER TABLE urls ADD COLUMN health_code INTEGER`,
  `ALTER TABLE urls ADD COLUMN last_checked TEXT`,
]) {
  try { db.exec(col); } catch { /* already exists */ }
}

const stmts = {
  insert: db.prepare(`
    INSERT INTO urls (code, original, alias, max_clicks, expires_at, password_hash,
                      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
                      show_preview)
    VALUES (@code, @original, @alias, @max_clicks, @expires_at, @password_hash,
            @utm_source, @utm_medium, @utm_campaign, @utm_term, @utm_content,
            @show_preview)
  `),
  findByCode: db.prepare(`SELECT * FROM urls WHERE code = ? OR alias = ? LIMIT 1`),
  incrementClicks: db.prepare(`UPDATE urls SET clicks = clicks + 1 WHERE code = ?`),
  getAll: db.prepare(`SELECT * FROM urls ORDER BY created_at DESC LIMIT 100`), // kept for internal use
  getStats: db.prepare(`
    SELECT code, alias, original, clicks, max_clicks, expires_at, password_hash,
           utm_source, utm_medium, utm_campaign, utm_term, utm_content,
           show_preview, created_at
    FROM urls WHERE code = ? OR alias = ? LIMIT 1
  `),

  insertClick: db.prepare(`
    INSERT INTO clicks (url_code, referrer, ua_browser, ua_device, country, country_code, city)
    VALUES (@code, @referrer, @browser, @device, @country, @country_code, @city)
  `),

  clicksByDay: db.prepare(`
    SELECT strftime('%Y-%m-%d', clicked_at) AS day, COUNT(*) AS count
    FROM clicks WHERE url_code = ?
    GROUP BY day ORDER BY day DESC LIMIT 30
  `),

  clicksByBrowser: db.prepare(`
    SELECT ua_browser AS label, COUNT(*) AS count
    FROM clicks WHERE url_code = ?
    GROUP BY ua_browser ORDER BY count DESC LIMIT 10
  `),

  clicksByDevice: db.prepare(`
    SELECT ua_device AS label, COUNT(*) AS count
    FROM clicks WHERE url_code = ?
    GROUP BY ua_device ORDER BY count DESC LIMIT 10
  `),

  clicksByReferrer: db.prepare(`
    SELECT COALESCE(referrer, 'Directo') AS label, COUNT(*) AS count
    FROM clicks WHERE url_code = ?
    GROUP BY referrer ORDER BY count DESC LIMIT 10
  `),

  topUrls: db.prepare(`
    SELECT u.code, u.alias, u.original, u.clicks, u.created_at, u.max_clicks, u.expires_at, u.password_hash
    FROM urls u ORDER BY u.clicks DESC LIMIT 10
  `),

  clicksByCountry: db.prepare(`
    SELECT COALESCE(country, 'Desconocido') AS label,
           country_code,
           COUNT(*) AS count
    FROM clicks WHERE url_code = ?
    GROUP BY country ORDER BY count DESC LIMIT 15
  `),

  globalClicksByCountry: db.prepare(`
    SELECT COALESCE(country, 'Desconocido') AS label,
           country_code,
           COUNT(*) AS count
    FROM clicks
    GROUP BY country ORDER BY count DESC LIMIT 15
  `),

  recentClicks: db.prepare(`
    SELECT clicked_at, referrer, ua_browser, ua_device, country, country_code, city
    FROM clicks WHERE url_code = ?
    ORDER BY clicked_at DESC LIMIT 20
  `),

  globalStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM urls)   AS total_urls,
      (SELECT COUNT(*) FROM clicks) AS total_clicks,
      (SELECT COUNT(*) FROM clicks WHERE clicked_at >= datetime('now','-1 day')) AS clicks_24h,
      (SELECT COUNT(*) FROM clicks WHERE clicked_at >= datetime('now','-7 days')) AS clicks_7d
  `),

  globalClicksByDay: db.prepare(`
    SELECT strftime('%Y-%m-%d', clicked_at) AS day, COUNT(*) AS count
    FROM clicks
    GROUP BY day ORDER BY day DESC LIMIT 30
  `),

  updateHealth: db.prepare(`
    UPDATE urls SET health_status = @status, health_code = @code,
                    last_checked = datetime('now')
    WHERE code = @code_id
  `),

  getAllForHealth: db.prepare(`
    SELECT code, original FROM urls
    WHERE last_checked IS NULL
       OR last_checked <= datetime('now', '-1 hour')
    ORDER BY last_checked ASC LIMIT 50
  `),

  updateUrl: db.prepare(`
    UPDATE urls
    SET original     = @original,
        alias        = @alias,
        max_clicks   = @max_clicks,
        expires_at   = @expires_at,
        show_preview = @show_preview
    WHERE code = @code
  `),

  deleteUrl:       db.prepare(`DELETE FROM urls WHERE code = ?`),
  deleteUrlClicks: db.prepare(`DELETE FROM clicks WHERE url_code = ?`),

  // API keys
  insertApiKey: db.prepare(`INSERT INTO api_keys (key_hash, prefix, name) VALUES (@key_hash, @prefix, @name)`),
  findApiKey:   db.prepare(`SELECT * FROM api_keys WHERE key_hash = ? LIMIT 1`),
  touchApiKey:  db.prepare(`UPDATE api_keys SET last_used = datetime('now') WHERE key_hash = ?`),
  listApiKeys:  db.prepare(`SELECT id, prefix, name, last_used, created_at FROM api_keys ORDER BY created_at DESC`),
  revokeApiKey: db.prepare(`DELETE FROM api_keys WHERE id = ?`),
};

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

module.exports = {
  createUrl(code, original, {
    alias = null, max_clicks = null, expires_at = null, password_hash = null,
    utm_source = null, utm_medium = null, utm_campaign = null, utm_term = null, utm_content = null,
    show_preview = 0,
  } = {}) {
    return stmts.insert.run({
      code, original,
      alias: alias || null,
      max_clicks: max_clicks || null,
      expires_at: expires_at || null,
      password_hash: password_hash || null,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
      utm_term: utm_term || null,
      utm_content: utm_content || null,
      show_preview: show_preview ? 1 : 0,
    });
  },
  findByCode(code) {
    return stmts.findByCode.get(code, code);
  },
  recordClick(code, { referrer, userAgent, country = null, country_code = null, city = null } = {}) {
    const { browser, device } = parseUA(userAgent);
    stmts.incrementClicks.run(code);
    stmts.insertClick.run({ code, referrer: cleanReferrer(referrer), browser, device, country, country_code, city });
  },
  getAll({ q = '', status = 'all', sort = 'newest' } = {}) {
    const conditions = [];
    const params = [];

    if (q) {
      conditions.push(`(original LIKE ? OR code LIKE ? OR alias LIKE ?)`);
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    if (status === 'active') {
      conditions.push(`(expires_at IS NULL OR expires_at > datetime('now'))`);
      conditions.push(`(max_clicks IS NULL OR clicks < max_clicks)`);
      conditions.push(`password_hash IS NULL`);
    } else if (status === 'expired') {
      conditions.push(`(
        (expires_at IS NOT NULL AND expires_at <= datetime('now'))
        OR (max_clicks IS NOT NULL AND clicks >= max_clicks)
      )`);
    } else if (status === 'protected') {
      conditions.push(`password_hash IS NOT NULL`);
    } else if (status === 'limited') {
      conditions.push(`(expires_at IS NOT NULL OR max_clicks IS NOT NULL)`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const orderMap = {
      newest:  'created_at DESC',
      oldest:  'created_at ASC',
      most:    'clicks DESC',
      least:   'clicks ASC',
      alpha:   'original ASC',
    };
    const order = orderMap[sort] || 'created_at DESC';

    return db.prepare(`SELECT * FROM urls ${where} ORDER BY ${order} LIMIT 200`).all(...params);
  },
  getStats(code) {
    return stmts.getStats.get(code, code);
  },
  getAnalytics(code) {
    return {
      byDay:      stmts.clicksByDay.all(code),
      byBrowser:  stmts.clicksByBrowser.all(code),
      byDevice:   stmts.clicksByDevice.all(code),
      byReferrer: stmts.clicksByReferrer.all(code),
      byCountry:  stmts.clicksByCountry.all(code),
      recent:     stmts.recentClicks.all(code),
    };
  },
  getTopUrls() {
    return stmts.topUrls.all();
  },
  // API key methods
  createApiKey(key_hash, prefix, name) {
    return stmts.insertApiKey.run({ key_hash, prefix, name });
  },
  findApiKey(key_hash) {
    return stmts.findApiKey.get(key_hash);
  },
  touchApiKey(key_hash) {
    stmts.touchApiKey.run(key_hash);
  },
  listApiKeys() {
    return stmts.listApiKeys.all();
  },
  revokeApiKey(id) {
    return stmts.revokeApiKey.run(id);
  },

  updateUrl(code, { original, alias = null, max_clicks = null, expires_at = null, show_preview = 0 } = {}) {
    return stmts.updateUrl.run({
      code,
      original,
      alias:       alias || null,
      max_clicks:  max_clicks || null,
      expires_at:  expires_at || null,
      show_preview: show_preview ? 1 : 0,
    });
  },
  deleteUrl(code) {
    const del = db.transaction(() => {
      stmts.deleteUrlClicks.run(code);
      return stmts.deleteUrl.run(code);
    });
    return del();
  },

  updateHealth(code, status, httpCode = null) {
    stmts.updateHealth.run({ code_id: code, status, code: httpCode });
  },
  getAllForHealth() {
    return stmts.getAllForHealth.all();
  },
  getGlobalStats() {
    return {
      summary:   stmts.globalStats.get(),
      byDay:     stmts.globalClicksByDay.all(),
      byCountry: stmts.globalClicksByCountry.all(),
    };
  },
};
