const https = require('https');
const http  = require('http');
const db    = require('./database');

const TIMEOUT_MS  = 7000;
const CHECK_EVERY = 60 * 60 * 1000; // 1 hour

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
        finish(res.statusCode < 400 ? 'ok' : 'down', res.statusCode);
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

async function checkOne(code, originalUrl) {
  const { status, code: httpCode } = await checkUrl(originalUrl);
  await db.updateHealth(code, status, httpCode);
  return { code, status, httpCode };
}

async function checkStale() {
  const rows = await db.getAllForHealth();
  for (const row of rows) {
    await checkOne(row.code, row.original);
    await new Promise(r => setTimeout(r, 300));
  }
  return rows.length;
}

function startBackgroundChecker() {
  checkStale().catch(() => {});
  setInterval(() => { checkStale().catch(() => {}); }, CHECK_EVERY);
}

module.exports = { checkOne, checkStale, startBackgroundChecker };
