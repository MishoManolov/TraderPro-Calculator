// shared/messaging.js — message-type constants + thin sendMessage wrappers
(function (global) {
  global.TPS = global.TPS || {};

  var MSG = {
    GET_QUOTE: 'TPS_GET_QUOTE',
    GET_FX_RATE: 'TPS_GET_FX_RATE',
    GET_SIGNALS: 'TPS_GET_SIGNALS'
  };

  function requestQuote(ticker) {
    return chrome.runtime.sendMessage({ type: MSG.GET_QUOTE, ticker: ticker });
  }

  function requestFxRate(from, to) {
    return chrome.runtime.sendMessage({ type: MSG.GET_FX_RATE, from: from, to: to });
  }

  function requestSignalsFromTab(tabId) {
    return chrome.tabs.sendMessage(tabId, { type: MSG.GET_SIGNALS });
  }

  function requestQuoteOrThrow(ticker, fallbackMessage) {
    return requestQuote(ticker).then(function (response) {
      if (!response || !response.ok) throw new Error((response && response.error) || fallbackMessage);
      return response.data;
    });
  }

  // Tries each ticker alias in order (see TPS.classify.parseTickerAliases —
  // the site can show a symbol as "ETL2 / COMF"), stopping at the first one
  // that resolves. Mirrors the shape of shared/quotes.js's own Yahoo->Stooq
  // fallback, just one level up (across aliases instead of across sources).
  function requestQuoteForAliasesOrThrow(aliases, fallbackMessage) {
    if (!aliases || !aliases.length) return Promise.reject(new Error(fallbackMessage));
    var lastError = null;
    function tryAt(i) {
      if (i >= aliases.length) return Promise.reject(lastError || new Error(fallbackMessage));
      return requestQuoteOrThrow(aliases[i], fallbackMessage).catch(function (err) {
        lastError = err;
        return tryAt(i + 1);
      });
    }
    return tryAt(0);
  }

  function resolveFxRate(quoteCurrency, accountCurrency, fallbackMessage) {
    if (quoteCurrency === accountCurrency) {
      return Promise.resolve({ rate: 1, source: 'identity' });
    }
    return requestFxRate(quoteCurrency, accountCurrency).then(function (response) {
      if (!response || !response.ok) throw new Error((response && response.error) || fallbackMessage);
      return response.data;
    });
  }

  global.TPS.messaging = {
    MSG: MSG,
    requestQuote: requestQuote,
    requestFxRate: requestFxRate,
    requestSignalsFromTab: requestSignalsFromTab,
    requestQuoteOrThrow: requestQuoteOrThrow,
    requestQuoteForAliasesOrThrow: requestQuoteForAliasesOrThrow,
    resolveFxRate: resolveFxRate
  };
})(typeof self !== 'undefined' ? self : this);
