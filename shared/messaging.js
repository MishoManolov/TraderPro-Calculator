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
    resolveFxRate: resolveFxRate
  };
})(typeof self !== 'undefined' ? self : this);
