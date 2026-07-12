// shared/format.js — currency/number formatting helpers
(function (global) {
  global.TPS = global.TPS || {};

  var CURRENCY_SYMBOLS = {
    USD: '$', EUR: '€', GBP: '£', BGN: 'лв',
    CHF: 'CHF', JPY: '¥', CAD: 'CA$', AUD: 'A$'
  };

  var MONEY_LOCALE_OPTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  var SHARES_RAW_LOCALE_OPTS = { maximumFractionDigits: 4 };
  var PERCENT_LOCALE_OPTS = { maximumFractionDigits: 2 };

  function currencySymbol(code) {
    return CURRENCY_SYMBOLS[code] || (code + ' ');
  }

  function formatMoney(amount, currencyCode) {
    if (!isFinite(amount)) return '—';
    var symbol = currencySymbol(currencyCode);
    var formatted = amount.toLocaleString(undefined, MONEY_LOCALE_OPTS);
    return symbol + formatted;
  }

  function formatShares(shares, roundingMode) {
    if (!isFinite(shares)) return '—';
    if (roundingMode === 'raw') return shares.toLocaleString(undefined, SHARES_RAW_LOCALE_OPTS);
    return String(Math.round(shares));
  }

  function formatPercent(percent) {
    if (!isFinite(percent)) return '—';
    return percent.toLocaleString(undefined, PERCENT_LOCALE_OPTS) + '%';
  }

  // Identical logic previously duplicated in content.js and popup.js.
  function describeSourceBadge(quote, fx) {
    var parts = [];
    if (quote.source !== 'yahoo') parts.push('цена: ' + quote.source + ' (прибл.)');
    if (fx.source && fx.source !== 'yahoo' && fx.source !== 'identity') parts.push('курс: ' + fx.source);
    return parts.join(' · ');
  }

  // Identical logic previously duplicated in shared/quotes.js and shared/fx.js.
  function describeError(err) {
    return (err && err.message) || String(err);
  }

  global.TPS.format = {
    CURRENCY_SYMBOLS: CURRENCY_SYMBOLS,
    currencySymbol: currencySymbol,
    formatMoney: formatMoney,
    formatShares: formatShares,
    formatPercent: formatPercent,
    describeSourceBadge: describeSourceBadge,
    describeError: describeError
  };
})(typeof self !== 'undefined' ? self : this);
