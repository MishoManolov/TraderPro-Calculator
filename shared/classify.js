// shared/classify.js — pure text interpretation for signal cards. No I/O.
//
// The provider's "Цел" (goal) field decides what a card actually means, not the
// t09_open_position/t09_close_position CSS class — a rebalance-down signal can
// render under either class. There's no fixed enum for the phrasing, so this is
// a hand-written heuristic (keyword + regex) parser, not a classifier trained on
// or backed by a fixed set of known strings. When it can't confidently read a
// card it returns type 'unknown' rather than guessing — content.js shows a manual
// fallback control in that case instead of silently misclassifying the signal.
(function (global) {
  global.TPS = global.TPS || {};

  // Substring match against the (lowercased) goal text, not exact equality, so
  // conjugations like "ребалансира"/"ребалансиране" all match "ребаланс". Add
  // more stems here as new phrasings are observed on real signals.
  var CLOSE_GOAL_STEMS = ['затваря'];
  var REBALANCE_GOAL_STEMS = ['ребаланс'];

  var ALL_QUANTITY_TEXT = ['всичко'];

  function normalizeText(text) {
    return (text || '').trim().toLowerCase();
  }

  function goalMatchesAny(normalizedGoal, stems) {
    for (var i = 0; i < stems.length; i++) {
      if (normalizedGoal.indexOf(stems[i]) !== -1) return true;
    }
    return false;
  }

  // Handles "20%", "до 10%", "с 35%", "10,5%" — any text with a number directly
  // followed by "%" — plus the "Всичко" (everything) special case. Returns
  // { matched:false } when nothing recognizable is found, which is the signal
  // for classifySignal() to fall back to 'unknown' rather than guess.
  function parseQuantityText(quantityRaw) {
    var normalized = normalizeText(quantityRaw);
    if (!normalized) return { matched: false, percent: null, isAll: false };
    if (ALL_QUANTITY_TEXT.indexOf(normalized) !== -1) {
      return { matched: true, percent: null, isAll: true };
    }
    var m = normalized.match(/(\d+(?:[.,]\d+)?)\s*%/);
    if (m) {
      var n = parseFloat(m[1].replace(',', '.'));
      if (isFinite(n)) return { matched: true, percent: n, isAll: false };
    }
    return { matched: false, percent: null, isAll: false };
  }

  /**
   * @param {string} goalText - raw "Цел" field text
   * @param {string} quantityRaw - raw "Количество" field text
   * @returns {{type:'open'|'close'|'rebalance'|'unknown', targetPercent:number|null}}
   */
  function classifySignal(goalText, quantityRaw) {
    var normalizedGoal = normalizeText(goalText);
    var q = parseQuantityText(quantityRaw);

    if (goalMatchesAny(normalizedGoal, CLOSE_GOAL_STEMS)) {
      return { type: 'close', targetPercent: null };
    }

    if (goalMatchesAny(normalizedGoal, REBALANCE_GOAL_STEMS)) {
      if (q.matched) return { type: 'rebalance', targetPercent: q.isAll ? 100 : q.percent };
      return { type: 'unknown', targetPercent: null };
    }

    // Default: plain open/buy (preserves today's behavior for existing cards).
    if (q.matched) return { type: 'open', targetPercent: q.isAll ? 100 : q.percent };
    return { type: 'unknown', targetPercent: null };
  }

  /**
   * @param {string} rawTicker - e.g. "ETL2 / COMF"
   * @returns {string[]} trimmed, non-empty aliases in original order, e.g. ["ETL2", "COMF"]
   */
  function parseTickerAliases(rawTicker) {
    if (!rawTicker) return [];
    var parts = String(rawTicker).split('/');
    var aliases = [];
    for (var i = 0; i < parts.length; i++) {
      var trimmed = parts[i].trim();
      if (trimmed) aliases.push(trimmed);
    }
    return aliases;
  }

  /**
   * Stable storage key for a ticker regardless of alias order/case/whitespace
   * across different signals for the same instrument.
   * @param {string[]} aliases
   * @returns {string}
   */
  function normalizeTickerKey(aliases) {
    var lowered = [];
    for (var i = 0; i < aliases.length; i++) lowered.push(aliases[i].toLowerCase());
    lowered.sort();
    return lowered.join('/');
  }

  global.TPS.classify = {
    classifySignal: classifySignal,
    parseQuantityText: parseQuantityText,
    parseTickerAliases: parseTickerAliases,
    normalizeTickerKey: normalizeTickerKey
  };
})(typeof self !== 'undefined' ? self : this);
