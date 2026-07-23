// shared/positions.js — chrome.storage.sync-backed state for rebalance signals.
// Separate storage key from shared/storage.js's settings blob (different
// concern, different growth shape: this grows per-ticker/per-signal, settings
// don't). Same get/set/onChanged shape as shared/storage.js so callers already
// familiar with that module don't need to learn a new pattern.
(function (global) {
  global.TPS = global.TPS || {};

  var POSITIONS_KEY = 'tpsPositions';

  var DEFAULT_POSITIONS = {
    // tickerKey (TPS.classify.normalizeTickerKey) -> shares currently held.
    // Persists across signals/dates for that ticker — this is portfolio state,
    // not tied to any one signal card.
    holdings: {},
    // (tickerKey + '__' + date) -> { type, targetPercent, tickerOverride, targetPrice }.
    // All four keys are independently optional. `type`/`targetPercent` correct a
    // failed heuristic classification (TPS.classify type 'unknown'); `tickerOverride`
    // corrects a malformed/unrecognized ticker for this card's own quote lookup
    // (never touches the site's own native ticker text); `targetPrice` overrides
    // the live quote price for this card's position-size calculation. Keyed per
    // signal instance, not per ticker, so a later signal for the same ticker
    // still gets a fresh shot at the heuristic parser / a clean slate instead of
    // inheriting a stale manual correction.
    signalOverrides: {}
  };

  function mergeWithDefaults(stored) {
    var merged = { holdings: {}, signalOverrides: {} };
    if (stored && typeof stored === 'object') {
      if (stored.holdings && typeof stored.holdings === 'object') {
        for (var hk in stored.holdings) merged.holdings[hk] = stored.holdings[hk];
      }
      if (stored.signalOverrides && typeof stored.signalOverrides === 'object') {
        for (var ok in stored.signalOverrides) merged.signalOverrides[ok] = stored.signalOverrides[ok];
      }
    }
    return merged;
  }

  function getPositions() {
    return new Promise(function (resolve) {
      chrome.storage.sync.get([POSITIONS_KEY], function (result) {
        resolve(mergeWithDefaults(result ? result[POSITIONS_KEY] : null));
      });
    });
  }

  function setPositions(next) {
    return new Promise(function (resolve) {
      var toStore = {};
      toStore[POSITIONS_KEY] = next;
      chrome.storage.sync.set(toStore, function () {
        resolve(next);
      });
    });
  }

  function setHolding(tickerKey, shares) {
    return getPositions().then(function (current) {
      current.holdings[tickerKey] = shares;
      return setPositions(current);
    });
  }

  // Shallow-merges onto whatever's already stored at this key — ticker/target-
  // price corrections (see content.js's bindTickerOverrideControls/
  // bindTargetPriceOverrideControls) can be set independently of, and later
  // than, a classification correction for the same signal, so a full replace
  // would silently drop one when the other is saved.
  function setSignalOverride(signalKey, patch) {
    return getPositions().then(function (current) {
      var existing = current.signalOverrides[signalKey] || {};
      var merged = {};
      for (var k in existing) merged[k] = existing[k];
      for (var pk in patch) merged[pk] = patch[pk];
      current.signalOverrides[signalKey] = merged;
      return setPositions(current);
    });
  }

  function makeSignalKey(tickerKey, date) {
    return tickerKey + '__' + date;
  }

  function onPositionsChanged(callback) {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'sync' || !changes[POSITIONS_KEY]) return;
      var oldValue = mergeWithDefaults(changes[POSITIONS_KEY].oldValue);
      var newValue = mergeWithDefaults(changes[POSITIONS_KEY].newValue);
      callback(newValue, oldValue);
    });
  }

  global.TPS.positions = {
    DEFAULT_POSITIONS: DEFAULT_POSITIONS,
    getPositions: getPositions,
    setHolding: setHolding,
    setSignalOverride: setSignalOverride,
    makeSignalKey: makeSignalKey,
    onPositionsChanged: onPositionsChanged
  };
})(typeof self !== 'undefined' ? self : this);
