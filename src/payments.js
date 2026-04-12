'use strict';

const geoip = require('geoip-lite');

// Countries where MercadoPago operates
const MP_COUNTRIES = new Set(['AR', 'BR', 'CL', 'CO', 'MX', 'PE', 'UY']);

// Country → Stripe currency (default USD)
const COUNTRY_CURRENCY = {
  GB: 'GBP',
  DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', PT: 'EUR',
  NL: 'EUR', BE: 'EUR', AT: 'EUR', IE: 'EUR', FI: 'EUR',
  CH: 'EUR', SE: 'EUR', NO: 'EUR', DK: 'EUR', PL: 'EUR',
};

// ── DEFAULT PRICING (used when DB has no overrides yet) ──
// Stripe: unit_amount in cents (USD 700 = $7.00), display = what user sees
// MercadoPago: amount in local currency (ARS 7000 = $7.000 ARS)
const DEFAULT_PRICING = {
  stripe: {
    monthly: {
      USD: { unit_amount: 700,  currency: 'usd', display: '$7 USD',    period: 'mes' },
      EUR: { unit_amount: 650,  currency: 'eur', display: '€6,50 EUR', period: 'mes' },
      GBP: { unit_amount: 550,  currency: 'gbp', display: '£5,50 GBP', period: 'mes' },
    },
    yearly: {
      USD: { unit_amount: 5900,  currency: 'usd', display: '$59 USD',   period: 'año', saving: '30%' },
      EUR: { unit_amount: 5500,  currency: 'eur', display: '€55 EUR',   period: 'año', saving: '30%' },
      GBP: { unit_amount: 4700,  currency: 'gbp', display: '£47 GBP',  period: 'año', saving: '30%' },
    },
  },
  mercadopago: {
    monthly: {
      AR: { amount: 7000,  currency: 'ARS', display: 'ARS $7.000',  period: 'mes' },
      BR: { amount: 35,    currency: 'BRL', display: 'BRL R$35',    period: 'mês' },
      CL: { amount: 6500,  currency: 'CLP', display: 'CLP $6.500',  period: 'mes' },
      CO: { amount: 28000, currency: 'COP', display: 'COP $28.000', period: 'mes' },
      MX: { amount: 129,   currency: 'MXN', display: 'MXN $129',   period: 'mes' },
      PE: { amount: 26,    currency: 'PEN', display: 'PEN S/26',   period: 'mes' },
      UY: { amount: 270,   currency: 'UYU', display: 'UYU $270',   period: 'mes' },
    },
    yearly: {
      AR: { amount: 59000,  currency: 'ARS', display: 'ARS $59.000',  period: 'año', saving: '30%' },
      BR: { amount: 299,    currency: 'BRL', display: 'BRL R$299',    period: 'ano', saving: '30%' },
      CL: { amount: 55000,  currency: 'CLP', display: 'CLP $55.000',  period: 'año', saving: '30%' },
      CO: { amount: 239000, currency: 'COP', display: 'COP $239.000', period: 'año', saving: '30%' },
      MX: { amount: 1099,   currency: 'MXN', display: 'MXN $1.099',  period: 'año', saving: '30%' },
      PE: { amount: 219,    currency: 'PEN', display: 'PEN S/219',   period: 'año', saving: '30%' },
      UY: { amount: 2300,   currency: 'UYU', display: 'UYU $2.300',  period: 'año', saving: '30%' },
    },
  },
};

// Days added to plan_expires_at for MercadoPago one-time payments
const MP_DAYS = { monthly: 32, yearly: 366 };

// ── IN-MEMORY CACHE ──
let _pricing = null; // null = not loaded yet

async function loadPricing(db) {
  const saved = await db.getSetting('pricing');
  _pricing = saved || JSON.parse(JSON.stringify(DEFAULT_PRICING));
}

function getPricing() {
  return _pricing || JSON.parse(JSON.stringify(DEFAULT_PRICING));
}

function invalidateCache() {
  _pricing = null;
}

// ── HELPERS ──
function getCountryFromReq(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress;
  const clean = ip?.replace(/^::ffff:/, '') || '';
  const geo = geoip.lookup(clean);
  return geo?.country || 'US';
}

function getStripePrice(country, period) {
  const pricing = getPricing();
  const currency = COUNTRY_CURRENCY[country] || 'USD';
  return pricing.stripe?.[period]?.[currency] || pricing.stripe?.[period]?.USD || null;
}

function getMPPrice(country, period) {
  if (!MP_COUNTRIES.has(country)) return null;
  const pricing = getPricing();
  return pricing.mercadopago?.[period]?.[country] || null;
}

function mpExpiresAt(period) {
  const d = new Date();
  d.setDate(d.getDate() + MP_DAYS[period]);
  return d;
}

// Build display string from amount + currency symbol mapping
const CURRENCY_SYMBOLS = {
  usd: '$', eur: '€', gbp: '£',
  ARS: '$', BRL: 'R$', CLP: '$', COP: '$', MXN: '$', PEN: 'S/', UYU: '$',
};
function buildDisplay(amount, currencyKey, prefix = '') {
  const sym = CURRENCY_SYMBOLS[currencyKey] || '';
  const num = amount >= 1000
    ? amount.toLocaleString('es-CO')
    : String(amount);
  return `${prefix}${sym}${num}`;
}

module.exports = {
  MP_COUNTRIES,
  MP_DAYS,
  DEFAULT_PRICING,
  COUNTRY_CURRENCY,
  loadPricing,
  getPricing,
  invalidateCache,
  getCountryFromReq,
  getStripePrice,
  getMPPrice,
  mpExpiresAt,
  buildDisplay,
};
