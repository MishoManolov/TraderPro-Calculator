// background/background.js — service worker: message router + in-memory quote/FX cache
importScripts(
  '../shared/storage.js',
  '../shared/messaging.js',
  '../shared/quotes.js',
  '../shared/fx.js'
);

var CACHE_TTL_MS = 60 * 1000;
var quoteCache = new Map(); // TICKER -> {data, expiresAt}
var fxCache = new Map(); // "FROM_TO" -> {data, expiresAt}

var MSG = self.TPS.messaging.MSG;

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  handle(message).then(sendResponse).catch(function (err) {
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  });
  return true; // keep the message channel open for the async response
});

function handle(message) {
  if (message.type === MSG.GET_QUOTE) {
    return cachedQuote(String(message.ticker).toUpperCase()).then(function (data) {
      return { ok: true, data: data };
    });
  }
  if (message.type === MSG.GET_FX_RATE) {
    return cachedFx(message.from, message.to).then(function (data) {
      return { ok: true, data: data };
    });
  }
  return Promise.reject(new Error('Unknown message type: ' + message.type));
}

function cachedQuote(ticker) {
  var hit = quoteCache.get(ticker);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.data);
  return self.TPS.quotes.fetchQuote(ticker).then(function (data) {
    quoteCache.set(ticker, { data: data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  });
}

function cachedFx(from, to) {
  var key = from + '_' + to;
  var hit = fxCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.data);
  return self.TPS.fx.fetchFxRate(from, to).then(function (data) {
    fxCache.set(key, { data: data, expiresAt: Date.now() + CACHE_TTL_MS });
    return data;
  });
}
