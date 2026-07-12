// shared/quotes.js — price fetching: Yahoo Finance primary, Stooq fallback.
// Used only from the background service worker (needs host_permissions to avoid CORS).
(function (global) {
  global.TPS = global.TPS || {};

  /**
   * @param {string} ticker
   * @returns {Promise<{ticker:string, price:number, currency:string, source:'yahoo'|'stooq', asOf:string}>}
   */
  function fetchQuote(ticker) {
    return fetchQuoteYahoo(ticker).catch(function () {
      return fetchQuoteStooq(ticker);
    });
  }

  function fetchQuoteYahoo(ticker) {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker);
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      var result = json && json.chart && json.chart.result && json.chart.result[0];
      var meta = result && result.meta;
      var price = meta && meta.regularMarketPrice;
      var currency = meta && meta.currency;
      if (typeof price !== 'number' || !currency) throw new Error('Yahoo: malformed/missing meta');
      return { ticker: ticker, price: price, currency: currency, source: 'yahoo', asOf: new Date().toISOString() };
    });
  }

  // Stooq's free CSV endpoint has no currency field and only reliably covers
  // .us-suffixed (US-listed) tickers — a documented limitation. Callers should
  // surface `source === 'stooq'` to the user as an approximate/fallback quote.
  function fetchQuoteStooq(ticker) {
    var url = 'https://stooq.com/q/l/?s=' + encodeURIComponent(ticker.toLowerCase()) + '.us&f=sd2t2ohlcv&e=csv';
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Stooq HTTP ' + res.status);
      return res.text();
    }).then(function (text) {
      var rows = text.trim().split('\n');
      if (rows.length < 2) throw new Error('Stooq: no data row');
      var cols = rows[1].split(','); // Symbol,Date,Time,Open,High,Low,Close,Volume
      var close = parseFloat(cols[6]);
      if (!isFinite(close) || close <= 0) throw new Error('Stooq: symbol not found / no price');
      return { ticker: ticker, price: close, currency: 'USD', source: 'stooq', asOf: new Date().toISOString() };
    });
  }

  global.TPS.quotes = {
    fetchQuote: fetchQuote,
    fetchQuoteYahoo: fetchQuoteYahoo,
    fetchQuoteStooq: fetchQuoteStooq
  };
})(typeof self !== 'undefined' ? self : this);
