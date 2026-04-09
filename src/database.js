const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'urls.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS urls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT    NOT NULL UNIQUE,
    original   TEXT    NOT NULL,
    alias      TEXT    UNIQUE,
    clicks     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
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
    country    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks(url_code);
  CREATE INDEX IF NOT EXISTS idx_clicks_at   ON clicks(clicked_at);
`);

const stmts = {
  insert: db.prepare(`INSERT INTO urls (code, original, alias) VALUES (@code, @original, @alias)`),
  findByCode: db.prepare(`SELECT * FROM urls WHERE code = ? OR alias = ? LIMIT 1`),
  incrementClicks: db.prepare(`UPDATE urls SET clicks = clicks + 1 WHERE code = ?`),
  getAll: db.prepare(`SELECT * FROM urls ORDER BY created_at DESC LIMIT 100`),
  getStats: db.prepare(`SELECT code, alias, original, clicks, created_at FROM urls WHERE code = ? OR alias = ? LIMIT 1`),

  insertClick: db.prepare(`
    INSERT INTO clicks (url_code, referrer, ua_browser, ua_device)
    VALUES (@code, @referrer, @browser, @device)
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
    SELECT u.code, u.alias, u.original, u.clicks, u.created_at
    FROM urls u ORDER BY u.clicks DESC LIMIT 10
  `),

  recentClicks: db.prepare(`
    SELECT clicked_at, referrer, ua_browser, ua_device
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
};

function parseUA(ua = '') {
  let browser = 'Otro';
  if (/Edg\//i.test(ua))         browser = 'Edge';
  else if (/OPR\//i.test(ua))    browser = 'Opera';
  else if (/Chrome\//i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua)) browser = 'Safari';
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
  createUrl(code, original, alias = null) {
    return stmts.insert.run({ code, original, alias: alias || null });
  },
  findByCode(code) {
    return stmts.findByCode.get(code, code);
  },
  recordClick(code, { referrer, userAgent } = {}) {
    const { browser, device } = parseUA(userAgent);
    stmts.incrementClicks.run(code);
    stmts.insertClick.run({ code, referrer: cleanReferrer(referrer), browser, device });
  },
  getAll() {
    return stmts.getAll.all();
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
      recent:     stmts.recentClicks.all(code),
    };
  },
  getTopUrls() {
    return stmts.topUrls.all();
  },
  getGlobalStats() {
    return {
      summary: stmts.globalStats.get(),
      byDay:   stmts.globalClicksByDay.all(),
    };
  },
};
