// shared/format.js — currency/number formatting helpers
(function (global) {
  global.TPS = global.TPS || {};

  var CURRENCY_SYMBOLS = {
    USD: '$', EUR: '€', GBP: '£', BGN: 'лв',
    CHF: 'CHF', JPY: '¥', CAD: 'CA$', AUD: 'A$'
  };

  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[code] || (code + ' ');
  }

  function formatMoney(amount, currencyCode) {
    if (!isFinite(amount)) return '—';
    var symbol = currencySymbol(currencyCode);
    var formatted = amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return symbol + formatted;
  }

  function formatShares(shares, roundingMode) {
    if (!isFinite(shares)) return '—';
    if (roundingMode === 'raw') return shares.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return String(Math.round(shares));
  }

  function formatPercent(percent) {
    if (!isFinite(percent)) return '—';
    return percent.toLocaleString(undefined, { maximumFractionDigits: 2 }) + '%';
  }

  global.TPS.format = {
    CURRENCY_SYMBOLS: CURRENCY_SYMBOLS,
    currencySymbol: currencySymbol,
    formatMoney: formatMoney,
    formatShares: formatShares,
    formatPercent: formatPercent
  };
})(typeof self !== 'undefined' ? self : this);
