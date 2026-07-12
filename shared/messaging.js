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

  global.TPS.messaging = {
    MSG: MSG,
    requestQuote: requestQuote,
    requestFxRate: requestFxRate,
    requestSignalsFromTab: requestSignalsFromTab
  };
})(typeof self !== 'undefined' ? self : this);
