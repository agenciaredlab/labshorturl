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

// ── STRIPE PRICING (amounts in smallest currency unit: cents for USD/EUR/GBP) ──
const STRIPE_PRICES = {
  monthly: {
    USD: { unit_amount: 700,  currency: 'usd', display: 'USD $7',    period: 'mes' },
    EUR: { unit_amount: 650,  currency: 'eur', display: 'EUR €6,50', period: 'mes' },
    GBP: { unit_amount: 550,  currency: 'gbp', display: 'GBP £5,50', period: 'mes' },
  },
  yearly: {
    USD: { unit_amount: 5900,  currency: 'usd', display: 'USD $59',   period: 'año', saving: '30%' },
    EUR: { unit_amount: 5500,  currency: 'eur', display: 'EUR €55',   period: 'año', saving: '30%' },
    GBP: { unit_amount: 4700,  currency: 'gbp', display: 'GBP £47',  period: 'año', saving: '30%' },
  },
};

// ── MERCADOPAGO PRICING (real amounts, not cents) ──
// Monthly ~$7 USD equivalent | Yearly ~$59 USD equivalent (30% off)
const MP_PRICES = {
  monthly: {
    AR: { amount: 7000,  currency: 'ARS', display: 'ARS $7.000',   period: 'mes' },
    BR: { amount: 35,    currency: 'BRL', display: 'BRL R$35',     period: 'mês' },
    CL: { amount: 6500,  currency: 'CLP', display: 'CLP $6.500',   period: 'mes' },
    CO: { amount: 28000, currency: 'COP', display: 'COP $28.000',  period: 'mes' },
    MX: { amount: 129,   currency: 'MXN', display: 'MXN $129',     period: 'mes' },
    PE: { amount: 26,    currency: 'PEN', display: 'PEN S/26',     period: 'mes' },
    UY: { amount: 270,   currency: 'UYU', display: 'UYU $270',     period: 'mes' },
  },
  yearly: {
    AR: { amount: 59000,  currency: 'ARS', display: 'ARS $59.000',  period: 'año', saving: '30%' },
    BR: { amount: 299,    currency: 'BRL', display: 'BRL R$299',    period: 'ano', saving: '30%' },
    CL: { amount: 55000,  currency: 'CLP', display: 'CLP $55.000',  period: 'año', saving: '30%' },
    CO: { amount: 239000, currency: 'COP', display: 'COP $239.000', period: 'año', saving: '30%' },
    MX: { amount: 1099,   currency: 'MXN', display: 'MXN $1.099',  period: 'año', saving: '30%' },
    PE: { amount: 219,    currency: 'PEN', display: 'PEN S/219',    period: 'año', saving: '30%' },
    UY: { amount: 2300,   currency: 'UYU', display: 'UYU $2.300',  period: 'año', saving: '30%' },
  },
};

// Days added to plan_expires_at for MercadoPago one-time payments
const MP_DAYS = { monthly: 32, yearly: 366 };

function getCountryFromReq(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress;
  const clean = ip?.replace(/^::ffff:/, '') || '';
  const geo = geoip.lookup(clean);
  return geo?.country || 'US';
}

function getStripePrice(country, period) {
  const currency = COUNTRY_CURRENCY[country] || 'USD';
  return STRIPE_PRICES[period]?.[currency] || STRIPE_PRICES[period].USD;
}

function getMPPrice(country, period) {
  if (!MP_COUNTRIES.has(country)) return null;
  return MP_PRICES[period]?.[country] || null;
}

function mpExpiresAt(period) {
  const d = new Date();
  d.setDate(d.getDate() + MP_DAYS[period]);
  return d;
}

module.exports = {
  MP_COUNTRIES,
  MP_PRICES,
  STRIPE_PRICES,
  getCountryFromReq,
  getStripePrice,
  getMPPrice,
  mpExpiresAt,
};
