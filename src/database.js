const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'urls.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS urls (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    code      TEXT    NOT NULL UNIQUE,
    original  TEXT    NOT NULL,
    alias     TEXT    UNIQUE,
    clicks    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT   NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_code ON urls(code);
  CREATE INDEX IF NOT EXISTS idx_alias ON urls(alias);
`);

const stmts = {
  insert: db.prepare(`
    INSERT INTO urls (code, original, alias)
    VALUES (@code, @original, @alias)
  `),
  findByCode: db.prepare(`SELECT * FROM urls WHERE code = ? OR alias = ? LIMIT 1`),
  incrementClicks: db.prepare(`UPDATE urls SET clicks = clicks + 1 WHERE code = ?`),
  getAll: db.prepare(`SELECT * FROM urls ORDER BY created_at DESC LIMIT 100`),
  getStats: db.prepare(`SELECT code, alias, original, clicks, created_at FROM urls WHERE code = ? OR alias = ? LIMIT 1`),
};

module.exports = {
  createUrl(code, original, alias = null) {
    return stmts.insert.run({ code, original, alias: alias || null });
  },
  findByCode(code) {
    return stmts.findByCode.get(code, code);
  },
  incrementClicks(code) {
    stmts.incrementClicks.run(code);
  },
  getAll() {
    return stmts.getAll.all();
  },
  getStats(code) {
    return stmts.getStats.get(code, code);
  },
};
