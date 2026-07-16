// shared/storage.js — settings schema + get/set/onChanged
// Works in window (content script, popup, options) and service-worker (self) contexts.
(function (global) {
  global.TPS = global.TPS || {};

  var SETTINGS_KEY = 'tpsSettings';
  var SCHEMA_VERSION = 1;

  var SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'BGN', 'CHF', 'JPY', 'CAD', 'AUD'];

  var DEFAULT_SETTINGS = {
    schemaVersion: SCHEMA_VERSION,
    accountBalance: 0,
    accountCurrency: 'USD',
    // Global position-size override, applied to every buy signal. null = not
    // set (each signal uses its own TraderPRO-stated %); a number overrides
    // every signal uniformly. There is deliberately no per-signal override —
    // this single setting is the only way to size positions differently from
    // what TraderPRO states, configured in the floating on-page widget next to
    // accountBalance (see content/widget.js).
    positionPercentOverride: null,
    roundingMode: 'roundDown', // 'raw' | 'roundDown' | 'roundUpThreshold'
    roundUpThresholdAmount: 5,
    // Collapsed/expanded state of the floating on-page widget (content/widget.js).
    // Synced like everything else here so it stays consistent across the user's
    // own Chrome instances.
    widgetMinimized: false
  };

  function mergeWithDefaults(stored) {
    var merged = {};
    for (var key in DEFAULT_SETTINGS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) {
        merged[key] = DEFAULT_SETTINGS[key];
      }
    }
    if (stored && typeof stored === 'object') {
      for (var k in stored) {
        if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) {
          merged[k] = stored[k];
        }
      }
    }
    merged.schemaVersion = SCHEMA_VERSION;
    return merged;
  }

  function getSettings() {
    return new Promise(function (resolve) {
      chrome.storage.sync.get([SETTINGS_KEY], function (result) {
        resolve(mergeWithDefaults(result ? result[SETTINGS_KEY] : null));
      });
    });
  }

  function setSettings(partial) {
    return getSettings().then(function (current) {
      var next = {};
      for (var k in current) next[k] = current[k];
      for (var p in partial) {
        if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, p)) next[p] = partial[p];
      }
      next.schemaVersion = SCHEMA_VERSION;
      return new Promise(function (resolve) {
        var toStore = {};
        toStore[SETTINGS_KEY] = next;
        chrome.storage.sync.set(toStore, function () {
          resolve(next);
        });
      });
    });
  }

  function onSettingsChanged(callback) {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'sync' || !changes[SETTINGS_KEY]) return;
      var oldValue = mergeWithDefaults(changes[SETTINGS_KEY].oldValue);
      var newValue = mergeWithDefaults(changes[SETTINGS_KEY].newValue);
      callback(newValue, oldValue);
    });
  }

  global.TPS.storage = {
    SUPPORTED_CURRENCIES: SUPPORTED_CURRENCIES,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    getSettings: getSettings,
    setSettings: setSettings,
    onSettingsChanged: onSettingsChanged
  };
})(typeof self !== 'undefined' ? self : this);
