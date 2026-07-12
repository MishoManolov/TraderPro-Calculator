// shared/fx.js — FX rate fetching: Yahoo pseudo-ticker primary, Frankfurter.app
// fallback, EUR<->BGN fixed peg as a last resort. Used only from the background
// service worker (needs host_permissions to avoid CORS).
(function (global) {
  global.TPS = global.TPS || {};

  // BGN is fixed to EUR by Bulgarian currency-board law: 1 EUR = 1.95583 BGN.
  // Public, static, well-known legal constant — not a secret — used only if both
  // network FX sources fail for this specific pair (relevant since BGN is one of
  // the supported account currencies for this Bulgarian-market extension).
  var EUR_BGN_PEG = 1.95583;

  /** @returns {Promise<{from,to,rate:number,source:'identity'|'yahoo'|'frankfurter'|'bgn-peg',asOf:string}>} */
  function fetchFxRate(from, to) {
    if (from === to) {
      return Promise.resolve({ from: from, to: to, rate: 1, source: 'identity', asOf: new Date().toISOString() });
    }
    return fetchFxRateYahoo(from, to).catch(function (yahooErr) {
      return fetchFxRateFrankfurter(from, to).catch(function (frankfurterErr) {
        return fetchFxRateBgnPeg(from, to).catch(function (pegErr) {
          // Surface all three underlying errors — see the matching note in quotes.js.
          throw new Error('Yahoo: ' + TPS.format.describeError(yahooErr) + ' | Frankfurter: ' + TPS.format.describeError(frankfurterErr) + ' | ' + TPS.format.describeError(pegErr));
        });
      });
    });
  }

  function fetchFxRateYahoo(from, to) {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + from + to + '=X';
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Yahoo FX HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      var result = json && json.chart && json.chart.result && json.chart.result[0];
      var rate = result && result.meta && result.meta.regularMarketPrice;
      if (typeof rate !== 'number') throw new Error('Yahoo FX: malformed meta');
      return { from: from, to: to, rate: rate, source: 'yahoo', asOf: new Date().toISOString() };
    });
  }

  function fetchFxRateFrankfurter(from, to) {
    var url = 'https://api.frankfurter.app/latest?from=' + from + '&to=' + to;
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Frankfurter HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      var rate = json && json.rates && json.rates[to];
      if (typeof rate !== 'number') throw new Error('Frankfurter: unsupported pair/malformed response');
      return { from: from, to: to, rate: rate, source: 'frankfurter', asOf: new Date().toISOString() };
    });
  }

  function fetchFxRateBgnPeg(from, to) {
    if (from === 'EUR' && to === 'BGN') {
      return Promise.resolve({ from: from, to: to, rate: EUR_BGN_PEG, source: 'bgn-peg', asOf: new Date().toISOString() });
    }
    if (from === 'BGN' && to === 'EUR') {
      return Promise.resolve({ from: from, to: to, rate: 1 / EUR_BGN_PEG, source: 'bgn-peg', asOf: new Date().toISOString() });
    }
    return Promise.reject(new Error('No FX source available for ' + from + '->' + to));
  }

  global.TPS.fx = {
    fetchFxRate: fetchFxRate,
    fetchFxRateYahoo: fetchFxRateYahoo,
    fetchFxRateFrankfurter: fetchFxRateFrankfurter,
    fetchFxRateBgnPeg: fetchFxRateBgnPeg,
    EUR_BGN_PEG: EUR_BGN_PEG
  };
})(typeof self !== 'undefined' ? self : this);
