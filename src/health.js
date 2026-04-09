const https = require('https');
const http  = require('http');
const db    = require('./database');

const TIMEOUT_MS  = 7000;
const CHECK_EVERY = 60 * 60 * 1000; // 1 hour

/**
 * Check a single URL. Returns { status, code }.
 * status: 'ok' | 'down' | 'timeout'
 */
function checkUrl(url) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (status, code = null) => {
      if (done) return;
      done = true;
      resolve({ status, code });
    };

    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);

    try {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.request(url, { method: 'HEAD', timeout: TIMEOUT_MS }, (res) => {
        clearTimeout(timer);
        const code   = res.statusCode;
        const status = code < 400 ? 'ok' : 'down';
        finish(status, code);
      });

      req.on('error',   () => { clearTimeout(timer); finish('down'); });
      req.on('timeout', () => { clearTimeout(timer); req.destroy(); finish('timeout'); });
      req.end();
    } catch {
      clearTimeout(timer);
      finish('down');
    }
  });
}

/**
 * Check one URL by its DB code and persist result.
 */
async function checkOne(code, originalUrl) {
  const { status, code: httpCode } = await checkUrl(originalUrl);
  db.updateHealth(code, status, httpCode);
  return { code, status, httpCode };
}

/**
 * Check all stale URLs (not checked in the last hour).
 * Runs with a small delay between requests to avoid hammering.
 */
async function checkStale() {
  const rows = db.getAllForHealth();
  for (const row of rows) {
    await checkOne(row.code, row.original);
    await new Promise(r => setTimeout(r, 300)); // 300ms between checks
  }
  return rows.length;
}

/**
 * Start the background loop.
 */
function startBackgroundChecker() {
  // Run once on startup (non-blocking)
  checkStale().catch(() => {});

  setInterval(() => {
    checkStale().catch(() => {});
  }, CHECK_EVERY);
}

module.exports = { checkOne, checkStale, startBackgroundChecker };
