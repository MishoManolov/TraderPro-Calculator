// shared/sizing.js — pure calculation module, no I/O. Single source of truth for
// content.js and popup.js so inline cards and the popup never diverge.
//
// FX convention: fxRate = units of account currency per 1 unit of position currency,
// i.e. priceInAccountCurrency = priceInPositionCurrency * fxRate. This matches Yahoo's
// FROMTO=X pseudo-ticker semantics directly (from=account, to=position -> wrong way),
// so callers must fetch the rate as position->account (from=positionCurrency,
// to=accountCurrency) and pass that here unmodified.
(function (global) {
  global.TPS = global.TPS || {};

  function roundShares(rawShares, priceInAccountCurrency, mode, thresholdAmount) {
    if (mode === 'raw') return rawShares;
    if (mode === 'roundDown') return Math.floor(rawShares);
    if (mode === 'roundUpThreshold') {
      var floor = Math.floor(rawShares);
      var ceil = Math.ceil(rawShares);
      if (ceil === floor) return floor;
      var extraCost = (ceil - rawShares) * priceInAccountCurrency;
      var threshold = typeof thresholdAmount === 'number' ? thresholdAmount : 0;
      return extraCost <= threshold ? ceil : floor;
    }
    throw new Error('Unknown rounding mode: ' + mode);
  }

  /**
   * @param {Object} p
   * @param {number} p.accountBalance
   * @param {number} p.percent - 0-100
   * @param {number} p.priceInPositionCurrency
   * @param {number} p.fxRate - accountCurrency per 1 unit of positionCurrency
   * @param {'raw'|'roundDown'|'roundUpThreshold'} p.roundingMode
   * @param {number} [p.roundUpThresholdAmount] - accountCurrency, required for roundUpThreshold
   * @returns {{rawShares:number, shares:number, priceInAccountCurrency:number,
   *            totalPositionCurrency:number, totalAccountCurrency:number}}
   */
  function computePositionSize(p) {
    var priceInAccountCurrency = p.priceInPositionCurrency * p.fxRate;
    var budgetAccountCurrency = p.accountBalance * (p.percent / 100);
    var rawShares = priceInAccountCurrency > 0 ? budgetAccountCurrency / priceInAccountCurrency : 0;
    var shares = roundShares(rawShares, priceInAccountCurrency, p.roundingMode, p.roundUpThresholdAmount);
    return {
      rawShares: rawShares,
      shares: shares,
      priceInAccountCurrency: priceInAccountCurrency,
      totalPositionCurrency: shares * p.priceInPositionCurrency,
      totalAccountCurrency: shares * priceInAccountCurrency
    };
  }

  // The one place "empty = TraderPRO's own %, otherwise = my global %" is decided.
  // There is no per-signal override — globalOverride comes from
  // settings.positionPercentOverride (set once in the popup, applies to every
  // signal uniformly). Both content.js and popup.js call this instead of each
  // re-implementing the same null-check, so they can't drift apart.
  function resolveEffectivePercent(statedPercent, globalOverride) {
    return globalOverride !== null && globalOverride !== undefined && isFinite(globalOverride) ? globalOverride : statedPercent;
  }

  global.TPS.sizing = {
    computePositionSize: computePositionSize,
    roundShares: roundShares,
    resolveEffectivePercent: resolveEffectivePercent
  };
})(typeof self !== 'undefined' ? self : this);
