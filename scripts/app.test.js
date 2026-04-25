#!/usr/bin/env node
'use strict';

// ── Test suite para lógica de la app (sin servidor ni DB) ────────────────────
// Cubre: payments.js, consistencia de credenciales, archivos de despliegue
// Uso: node scripts/app.test.js

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const green  = s => `\x1b[32m${s}\x1b[0m`;
const red    = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const bold   = s => `\x1b[1m${s}\x1b[0m`;
const dim    = s => `\x1b[2m${s}\x1b[0m`;
const cyan   = s => `\x1b[36m${s}\x1b[0m`;

let passed = 0, failed = 0;
const failures = [];

const pass = name => { console.log(`  ${green('✓')} ${name}`); passed++; };
const fail = (name, reason) => {
  console.log(`  ${red('✗')} ${name}`);
  console.log(`    ${dim(reason)}`);
  failed++; failures.push({ name, reason });
};
const section = title => {
  console.log();
  console.log(bold(`  ── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`));
};

// ── helpers ──────────────────────────────────────────────────────────────────
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

// ── 1. payments.js — DEFAULT_PRICING structure ───────────────────────────────
function testPaymentsPricing() {
  section('1. payments.js — DEFAULT_PRICING');

  const pay = require('../src/payments');
  const p   = pay.DEFAULT_PRICING;

  // Top-level structure
  p.stripe      ? pass('DEFAULT_PRICING tiene sección stripe')      : fail('DEFAULT_PRICING stripe', 'Falta clave stripe');
  p.mercadopago ? pass('DEFAULT_PRICING tiene sección mercadopago') : fail('DEFAULT_PRICING mercadopago', 'Falta clave mercadopago');

  // Stripe periods
  for (const period of ['monthly', 'yearly']) {
    p.stripe?.[period]
      ? pass(`Stripe tiene período ${period}`)
      : fail(`Stripe ${period}`, 'Período faltante');
  }

  // Stripe currencies
  for (const currency of ['USD', 'EUR', 'GBP']) {
    const m = p.stripe?.monthly?.[currency];
    m && m.unit_amount > 0 && m.currency && m.display
      ? pass(`Stripe monthly ${currency}: unit_amount=${m.unit_amount}, display="${m.display}"`)
      : fail(`Stripe monthly ${currency}`, 'Falta o inválido');
  }

  // Stripe yearly has saving
  for (const currency of ['USD', 'EUR', 'GBP']) {
    const y = p.stripe?.yearly?.[currency];
    y?.saving
      ? pass(`Stripe yearly ${currency} tiene saving="${y.saving}"`)
      : fail(`Stripe yearly ${currency} saving`, 'Falta campo saving');
  }

  // MercadoPago countries
  const MP_COUNTRIES = ['AR', 'BR', 'CL', 'CO', 'MX', 'PE', 'UY'];
  for (const country of MP_COUNTRIES) {
    const m = p.mercadopago?.monthly?.[country];
    m && m.amount > 0 && m.currency && m.display
      ? pass(`MP monthly ${country}: amount=${m.amount} ${m.currency}`)
      : fail(`MP monthly ${country}`, 'Falta o inválido');
  }

  // MercadoPago yearly has saving
  for (const country of MP_COUNTRIES) {
    const y = p.mercadopago?.yearly?.[country];
    y?.saving
      ? pass(`MP yearly ${country} tiene saving`)
      : fail(`MP yearly ${country} saving`, 'Falta campo saving');
  }

  // Stripe cents: yearly should be less than 12×monthly (discount)
  for (const cur of ['USD', 'EUR', 'GBP']) {
    const monthly12 = (p.stripe.monthly[cur].unit_amount) * 12;
    const yearly    = p.stripe.yearly[cur].unit_amount;
    yearly < monthly12
      ? pass(`Stripe ${cur}: anual (${yearly}¢) < 12×mensual (${monthly12}¢)`)
      : fail(`Stripe ${cur} descuento anual`, `Anual=${yearly} no es menor que 12×mensual=${monthly12}`);
  }
}

// ── 2. payments.js — helper functions ────────────────────────────────────────
function testPaymentsHelpers() {
  section('2. payments.js — funciones helper');

  const pay = require('../src/payments');

  // MP_COUNTRIES set
  for (const c of ['AR','BR','CL','CO','MX','PE','UY']) {
    pay.MP_COUNTRIES.has(c)
      ? pass(`MP_COUNTRIES contiene ${c}`)
      : fail(`MP_COUNTRIES ${c}`, 'País LATAM faltante');
  }
  !pay.MP_COUNTRIES.has('US')
    ? pass('MP_COUNTRIES no contiene US')
    : fail('MP_COUNTRIES no contiene US', 'US no debería estar');

  // COUNTRY_CURRENCY map
  const { COUNTRY_CURRENCY } = pay;
  COUNTRY_CURRENCY['GB'] === 'GBP' ? pass('GB → GBP') : fail('GB → GBP', `Actual: ${COUNTRY_CURRENCY['GB']}`);
  COUNTRY_CURRENCY['DE'] === 'EUR' ? pass('DE → EUR') : fail('DE → EUR', `Actual: ${COUNTRY_CURRENCY['DE']}`);
  COUNTRY_CURRENCY['FR'] === 'EUR' ? pass('FR → EUR') : fail('FR → EUR', `Actual: ${COUNTRY_CURRENCY['FR']}`);
  !COUNTRY_CURRENCY['US']          ? pass('US usa USD por defecto (sin entrada en mapa)') : fail('US default USD', 'No debería tener entrada');

  // getStripePrice
  const usdMonthly = pay.getStripePrice('US', 'monthly');
  usdMonthly && usdMonthly.currency === 'usd' && usdMonthly.unit_amount > 0
    ? pass(`getStripePrice(US, monthly) → ${usdMonthly.unit_amount}¢ USD`)
    : fail('getStripePrice US monthly', 'Resultado inválido');

  const gbpYearly = pay.getStripePrice('GB', 'yearly');
  gbpYearly && gbpYearly.currency === 'gbp'
    ? pass(`getStripePrice(GB, yearly) → ${gbpYearly.unit_amount}¢ GBP`)
    : fail('getStripePrice GB yearly', 'Debería retornar GBP');

  const deMonthly = pay.getStripePrice('DE', 'monthly');
  deMonthly && deMonthly.currency === 'eur'
    ? pass(`getStripePrice(DE, monthly) → EUR`)
    : fail('getStripePrice DE monthly', 'Debería retornar EUR');

  // getMPPrice — LATAM
  const arMonthly = pay.getMPPrice('AR', 'monthly');
  arMonthly && arMonthly.currency === 'ARS' && arMonthly.amount > 0
    ? pass(`getMPPrice(AR, monthly) → ${arMonthly.amount} ARS`)
    : fail('getMPPrice AR monthly', 'Resultado inválido');

  // getMPPrice — non-LATAM returns null
  const usMP = pay.getMPPrice('US', 'monthly');
  usMP === null
    ? pass('getMPPrice(US) → null (no LATAM)')
    : fail('getMPPrice US', `Debería ser null, obtuvo: ${JSON.stringify(usMP)}`);

  const deMP = pay.getMPPrice('DE', 'monthly');
  deMP === null
    ? pass('getMPPrice(DE) → null (no LATAM)')
    : fail('getMPPrice DE', 'Debería ser null');

  // buildDisplay
  const d1 = pay.buildDisplay(7000, 'ARS');
  d1.includes('7.000') || d1.includes('7000')
    ? pass(`buildDisplay(7000, ARS) → "${d1}"`)
    : fail('buildDisplay ARS', `Resultado inesperado: "${d1}"`);

  const d2 = pay.buildDisplay(35, 'BRL');
  d2.includes('35')
    ? pass(`buildDisplay(35, BRL) → "${d2}"`)
    : fail('buildDisplay BRL', `Resultado inesperado: "${d2}"`);

  // mpExpiresAt
  const { MP_DAYS, mpExpiresAt } = pay;
  MP_DAYS.monthly === 32  ? pass('MP_DAYS.monthly = 32')  : fail('MP_DAYS.monthly', `Actual: ${MP_DAYS.monthly}`);
  MP_DAYS.yearly  === 366 ? pass('MP_DAYS.yearly = 366')  : fail('MP_DAYS.yearly',  `Actual: ${MP_DAYS.yearly}`);

  const now    = Date.now();
  const expM   = mpExpiresAt('monthly').getTime();
  const expY   = mpExpiresAt('yearly').getTime();
  const diffM  = Math.round((expM - now) / 86400000);
  const diffY  = Math.round((expY - now) / 86400000);
  Math.abs(diffM - 32)  <= 1 ? pass(`mpExpiresAt(monthly) ≈ +32 días (actual: +${diffM})`)  : fail('mpExpiresAt monthly', `+${diffM} días, esperado ~32`);
  Math.abs(diffY - 366) <= 1 ? pass(`mpExpiresAt(yearly)  ≈ +366 días (actual: +${diffY})`) : fail('mpExpiresAt yearly',  `+${diffY} días, esperado ~366`);
}

// ── 3. server.js — credenciales estáticas ────────────────────────────────────
function testServerCredentials() {
  section('3. server.js — credenciales y consistencia');

  const src = read('src/server.js');

  // _creds tiene los 9 campos esperados
  const expectedKeys = [
    'adminUser', 'adminPass', 'superadminPass',
    'baseUrl', 'sentryDsn',
    'stripeSecretKey', 'stripeWebhookSecret',
    'mpAccessToken', 'mpWebhookSecret',
  ];
  for (const key of expectedKeys) {
    src.includes(`${key}:`)
      ? pass(`_creds tiene clave "${key}"`)
      : fail(`_creds clave "${key}"`, 'No encontrada en server.js');
  }

  // ALL_CRED_KEYS declarado
  src.includes('ALL_CRED_KEYS')
    ? pass('ALL_CRED_KEYS declarado')
    : fail('ALL_CRED_KEYS', 'No encontrado en server.js');

  // maskCredential implementado
  src.includes('function maskCredential')
    ? pass('maskCredential definida')
    : fail('maskCredential', 'Función no encontrada');

  // applyCredentials implementado
  src.includes('function applyCredentials')
    ? pass('applyCredentials definida')
    : fail('applyCredentials', 'Función no encontrada');

  // loadCredentialsFromDB llamado en start()
  src.includes('await loadCredentialsFromDB()')
    ? pass('loadCredentialsFromDB() llamado en start()')
    : fail('loadCredentialsFromDB en start', 'No encontrado');

  // BASE_URL es let (mutable)
  src.includes('let BASE_URL')
    ? pass('BASE_URL declarado como let (mutable)')
    : fail('BASE_URL let', 'Debería ser let, no const');

  // ADMIN_USER y ADMIN_PASS son let
  src.includes('let ADMIN_USER') && src.includes('let ADMIN_PASS')
    ? pass('ADMIN_USER y ADMIN_PASS declarados como let')
    : fail('ADMIN_USER/PASS let', 'Deberían ser let, no const');

  // Consistencia: ALL_CRED_KEYS en server.js == CRED_KEYS en superadmin.html
  const serverMatch = src.match(/ALL_CRED_KEYS\s*=\s*\[([\s\S]*?)\]/);
  const html        = read('public/superadmin.html');
  const htmlMatch   = html.match(/CRED_KEYS\s*=\s*\[([\s\S]*?)\]/);

  if (!serverMatch) { fail('ALL_CRED_KEYS parseable', 'No se pudo extraer del server.js'); }
  else if (!htmlMatch) { fail('CRED_KEYS parseable', 'No se pudo extraer del superadmin.html'); }
  else {
    const parseKeys = str => str.match(/'([^']+)'/g)?.map(s => s.replace(/'/g, '')) || [];
    const serverKeys = parseKeys(serverMatch[1]).sort();
    const htmlKeys   = parseKeys(htmlMatch[1]).sort();
    JSON.stringify(serverKeys) === JSON.stringify(htmlKeys)
      ? pass(`ALL_CRED_KEYS (server) === CRED_KEYS (html): [${serverKeys.join(', ')}]`)
      : fail('Consistencia CRED_KEYS', `server=[${serverKeys}] html=[${htmlKeys}]`);
  }

  // checkoutLimiter aplicado a ambos endpoints
  src.includes("app.post('/api/payments/stripe/checkout', checkoutLimiter")
    ? pass('checkoutLimiter en Stripe checkout')
    : fail('checkoutLimiter Stripe', 'No aplicado');
  src.includes("app.post('/api/payments/mercadopago/checkout', checkoutLimiter")
    ? pass('checkoutLimiter en MercadoPago checkout')
    : fail('checkoutLimiter MercadoPago', 'No aplicado');
}

// ── 4. database.js — retry logic ─────────────────────────────────────────────
function testDatabaseRetry() {
  section('4. database.js — retry de conexión');

  const src = read('src/database.js');

  src.includes('attempt <= 10')
    ? pass('Máximo 10 intentos')
    : fail('Retry 10 intentos', 'No encontrado');

  src.includes('retrying in')
    ? pass('Mensaje de retry en consola')
    : fail('Mensaje retry', 'No encontrado');

  src.includes('setTimeout')
    ? pass('setTimeout para espera entre intentos')
    : fail('setTimeout retry', 'No encontrado');

  // Métodos del objeto db (definidos como `async nombre(` sin la palabra "function")
  for (const method of ['getSetting', 'setSetting', 'expireOverduePlans', 'activateProPlan', 'deactivateProPlan']) {
    src.includes(`async ${method}(`)
      ? pass(`${method} definida`)
      : fail(method, 'Método no encontrado en database.js');
  }
}

// ── 5. portainer-stack.yml — estructura ──────────────────────────────────────
function testPortainerStack() {
  section('5. portainer-stack.yml — aislamiento y estructura');

  if (!exists('portainer-stack.yml')) {
    fail('portainer-stack.yml existe', 'Archivo no encontrado');
    return;
  }
  pass('portainer-stack.yml existe');
  const yml = read('portainer-stack.yml');

  // Red interna
  yml.includes('driver: bridge')
    ? pass('Red bridge definida')
    : fail('Red bridge', 'No encontrada');

  // DB sin ports: reales (ignorar comentarios que contienen la palabra "ports:")
  const dbSection = yml.slice(yml.indexOf('\n  db:'), yml.indexOf('\n  app:'));
  const dbNonComment = dbSection.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  !dbNonComment.includes('ports:')
    ? pass('db no expone ports: al host (solo comentario explicativo, sin directiva real)')
    : fail('db sin ports', 'La BD expone puertos — rompe aislamiento');

  // App tiene ports
  const appSection = yml.slice(yml.indexOf('app:'));
  appSection.includes('ports:')
    ? pass('app expone ports: al host')
    : fail('app ports', 'La app no expone ningún puerto');

  // depends_on con service_healthy
  yml.includes('condition: service_healthy')
    ? pass('depends_on condition: service_healthy')
    : fail('service_healthy', 'No encontrado');

  // DATABASE_URL construida desde PG_PASSWORD
  yml.includes('postgresql://labshorturl:${PG_PASSWORD}@db:5432')
    ? pass('DATABASE_URL se construye desde PG_PASSWORD')
    : fail('DATABASE_URL construida', 'No encontrada o mal formateada');

  // Variables requeridas con :?
  for (const v of ['PG_PASSWORD', 'BASE_URL', 'ADMIN_PASS', 'SESSION_SECRET']) {
    yml.includes(`${v}:?`)
      ? pass(`${v} requerido con :?`)
      : fail(`${v} requerido`, `No tiene validación :?`);
  }

  // Variables opcionales de pago
  for (const v of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'MP_ACCESS_TOKEN', 'SUPERADMIN_PASS']) {
    yml.includes(v)
      ? pass(`portainer-stack incluye ${v}`)
      : fail(`portainer-stack ${v}`, 'Variable de pago no incluida');
  }

  // Healthcheck en app
  yml.includes('/health')
    ? pass('Healthcheck en app apunta a /health')
    : fail('Healthcheck app', 'No encontrado');
}

// ── 6. docker-stack.yml — secrets de pago ────────────────────────────────────
function testDockerStack() {
  section('6. docker-stack.yml — secrets y aislamiento');

  if (!exists('docker-stack.yml')) {
    fail('docker-stack.yml existe', 'Archivo no encontrado');
    return;
  }
  pass('docker-stack.yml existe');
  const yml = read('docker-stack.yml');

  // Secrets de pago
  for (const secret of [
    'labshorturl_superadmin_pass',
    'labshorturl_stripe_secret_key',
    'labshorturl_stripe_webhook_secret',
    'labshorturl_mp_access_token',
  ]) {
    yml.includes(secret)
      ? pass(`Secret "${secret}" declarado`)
      : fail(`Secret ${secret}`, 'No encontrado');
  }

  // Targets inyectados en app
  for (const target of ['SUPERADMIN_PASS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'MP_ACCESS_TOKEN']) {
    yml.includes(`target: ${target}`)
      ? pass(`Secret target "${target}" inyectado`)
      : fail(`target ${target}`, 'No encontrado en secrets del servicio app');
  }
}

// ── 7. docker-compose.yml — variables de pago ────────────────────────────────
function testDockerCompose() {
  section('7. docker-compose.yml — variables de pago');

  if (!exists('docker-compose.yml')) {
    fail('docker-compose.yml existe', 'No encontrado'); return;
  }
  const yml = read('docker-compose.yml');

  for (const v of ['SUPERADMIN_PASS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET']) {
    yml.includes(v)
      ? pass(`docker-compose incluye ${v}`)
      : fail(`docker-compose ${v}`, 'Variable no encontrada');
  }
}

// ── 8. .env.example — documentación completa ─────────────────────────────────
function testEnvExample() {
  section('8. .env.example — documentación completa');

  if (!exists('.env.example')) {
    fail('.env.example existe', 'No encontrado'); return;
  }
  const env = read('.env.example');

  const vars = [
    'PORT', 'BASE_URL', 'DATABASE_URL',
    'ADMIN_USER', 'ADMIN_PASS', 'SUPERADMIN_PASS',
    'SESSION_SECRET', 'NODE_ENV', 'SENTRY_DSN',
    'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET',
  ];
  for (const v of vars)
    env.includes(v)
      ? pass(`.env.example documenta ${v}`)
      : fail(`.env.example ${v}`, 'Variable no documentada');
}

// ── 9. Dockerfile — limpieza ─────────────────────────────────────────────────
function testDockerfile() {
  section('9. Dockerfile — sin artefactos obsoletos');

  if (!exists('Dockerfile')) {
    fail('Dockerfile existe', 'No encontrado'); return;
  }
  const df = read('Dockerfile');

  !df.includes('DB_PATH')
    ? pass('Sin DB_PATH (artefacto SQLite eliminado)')
    : fail('DB_PATH eliminado', 'ENV DB_PATH aún presente en Dockerfile');

  df.includes('FROM node:')
    ? pass('Imagen base node: presente')
    : fail('Imagen base', 'No encontrada');

  df.includes('USER app')
    ? pass('Usuario no-root (USER app)')
    : fail('Usuario no-root', 'Sin USER app');

  df.includes('HEALTHCHECK')
    ? pass('HEALTHCHECK definido')
    : fail('HEALTHCHECK', 'No encontrado');

  df.includes('npm ci --omit=dev')
    ? pass('Solo dependencias de producción (--omit=dev)')
    : fail('--omit=dev', 'No encontrado');
}

// ── 10. superadmin.html — secciones de credenciales ──────────────────────────
function testSuperadminHtml() {
  section('10. superadmin.html — UI de credenciales');

  if (!exists('public/superadmin.html')) {
    fail('superadmin.html existe', 'No encontrado'); return;
  }
  const html = read('public/superadmin.html');

  const fields = [
    'cred_adminUser', 'cred_adminPass', 'cred_superadminPass',
    'cred_baseUrl', 'cred_sentryDsn',
    'cred_stripeSecretKey', 'cred_stripeWebhookSecret',
    'cred_mpAccessToken', 'cred_mpWebhookSecret',
  ];
  for (const f of fields)
    html.includes(f)
      ? pass(`Campo ${f} presente`)
      : fail(`Campo ${f}`, 'Input no encontrado en el HTML');

  html.includes('webhookEndpointHint')
    ? pass('Hint de endpoint Stripe webhook presente')
    : fail('webhookEndpointHint', 'No encontrado');

  html.includes('loadCredentials()')
    ? pass('loadCredentials() llamado en init')
    : fail('loadCredentials init', 'No encontrado');

  html.includes('async function saveCredentials')
    ? pass('saveCredentials definida')
    : fail('saveCredentials', 'Función no encontrada');

  html.includes('/api/superadmin/credentials')
    ? pass('Llama a /api/superadmin/credentials')
    : fail('/api/superadmin/credentials', 'Endpoint no referenciado en el HTML');

  // UI de precios también presente
  html.includes('savePrices') && html.includes('loadPrices')
    ? pass('UI de precios (loadPrices/savePrices) presente')
    : fail('UI de precios', 'Funciones no encontradas');
}

// ── Runner ────────────────────────────────────────────────────────────────────
async function main() {
  console.log();
  console.log(bold(cyan('  ╔══════════════════════════════════════════════════╗')));
  console.log(bold(cyan('  ║       app.test.js — Test Suite                   ║')));
  console.log(bold(cyan('  ╚══════════════════════════════════════════════════╝')));

  testPaymentsPricing();
  testPaymentsHelpers();
  testServerCredentials();
  testDatabaseRetry();
  testPortainerStack();
  testDockerStack();
  testDockerCompose();
  testEnvExample();
  testDockerfile();
  testSuperadminHtml();

  console.log();
  console.log(bold(`  ${'─'.repeat(50)}`));
  console.log(bold('  Resultados'));
  console.log(bold(`  ${'─'.repeat(50)}`));
  console.log(`  ${green(`✓ ${passed} pasaron`)}`);
  if (failed) console.log(`  ${red(`✗ ${failed} fallaron`)}`);

  if (failures.length) {
    console.log();
    console.log(bold(red('  Fallos:')));
    failures.forEach(f => console.log(`  ${red('•')} ${f.name}: ${dim(f.reason)}`));
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(red(`\n  Error fatal: ${err.message}`));
  process.exit(1);
});
