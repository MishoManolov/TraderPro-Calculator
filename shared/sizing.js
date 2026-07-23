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

  // The one place "empty weight = 100% (no scaling), otherwise = statedPercent
  // scaled by weight/100" is decided. This is a multiplier, not a substitute —
  // weightPercent comes from settings.strategyWeightPercent (set once in the
  // widget, applies uniformly to every signal's own target %, both plain
  // open/buy and rebalance-to-%, since each strategy/provider may warrant a
  // different portfolio allocation). Both content.js and popup.js call this
  // for both signal types instead of each re-implementing the same null-check,
  // so they can't drift apart.
  function applyStrategyWeight(statedPercent, weightPercent) {
    var weight = (weightPercent !== null && weightPercent !== undefined && isFinite(weightPercent)) ? weightPercent : 100;
    return statedPercent * (weight / 100);
  }

  // The one place "use the manually-entered target price if there is one,
  // otherwise fall back to the live quote price" is decided — content.js and
  // popup.js both call computeAndFormat()/computeRebalanceTrade() rather than
  // checking this themselves, so sizing math and the two callers can't drift
  // apart on which price actually drove a given number.
  function resolveSizingPrice(quotePrice, targetPriceOverride) {
    return (typeof targetPriceOverride === 'number' && isFinite(targetPriceOverride) && targetPriceOverride > 0)
      ? targetPriceOverride
      : quotePrice;
  }

  // Composes computePositionSize() with the formatted strings every renderer
  // needs (content.js and popup.js both do this exact sequence) — see
  // shared/format.js for the individual formatters this calls into.
  function computeAndFormat(state, settings) {
    var effectivePercent = applyStrategyWeight(state.statedPercent, settings.strategyWeightPercent);
    var result = computePositionSize({
      accountBalance: settings.accountBalance,
      percent: effectivePercent,
      priceInPositionCurrency: resolveSizingPrice(state.quote.price, state.targetPriceOverride),
      fxRate: state.fx.rate,
      roundingMode: settings.roundingMode,
      roundUpThresholdAmount: settings.roundUpThresholdAmount
    });
    return {
      effectivePercent: effectivePercent,
      result: result,
      percentText: TPS.format.formatPercent(effectivePercent),
      priceText: TPS.format.formatMoney(state.quote.price, state.quote.currency),
      sharesText: TPS.format.formatShares(result.shares, settings.roundingMode),
      totalAccountText: TPS.format.formatMoney(result.totalAccountCurrency, settings.accountCurrency)
    };
  }

  /**
   * Rebalance trade math: how many shares to buy/sell to move a position from
   * its current share count to a target % of the account. Reuses
   * computePositionSize() for the target share count so target-shares math
   * never diverges from plain-buy sizing math.
   * @param {Object} p
   * @param {number} p.accountBalance
   * @param {number} p.targetPercent - 0-100
   * @param {number} p.currentShares
   * @param {number} p.priceInPositionCurrency
   * @param {number} p.fxRate
   * @param {'raw'|'roundDown'|'roundUpThreshold'} p.roundingMode
   * @param {number} [p.roundUpThresholdAmount]
   * @param {number} [p.targetPriceOverride] - if a positive finite number, sizes the
   *   trade off this instead of priceInPositionCurrency (see resolveSizingPrice)
   * @returns {{targetShares:number, deltaShares:number, action:'buy'|'sell'|'hold',
   *            priceInAccountCurrency:number}}
   */
  function computeRebalanceTrade(p) {
    var target = computePositionSize({
      accountBalance: p.accountBalance,
      percent: p.targetPercent,
      priceInPositionCurrency: resolveSizingPrice(p.priceInPositionCurrency, p.targetPriceOverride),
      fxRate: p.fxRate,
      roundingMode: p.roundingMode,
      roundUpThresholdAmount: p.roundUpThresholdAmount
    });
    var currentShares = isFinite(p.currentShares) ? p.currentShares : 0;
    var deltaShares = target.shares - currentShares;
    var action = deltaShares > 0 ? 'buy' : (deltaShares < 0 ? 'sell' : 'hold');
    return {
      targetShares: target.shares,
      deltaShares: deltaShares,
      action: action,
      priceInAccountCurrency: target.priceInAccountCurrency
    };
  }

  global.TPS.sizing = {
    computePositionSize: computePositionSize,
    roundShares: roundShares,
    applyStrategyWeight: applyStrategyWeight,
    resolveSizingPrice: resolveSizingPrice,
    computeAndFormat: computeAndFormat,
    computeRebalanceTrade: computeRebalanceTrade
  };
})(typeof self !== 'undefined' ? self : this);
