// shared/scrape.js — DOM scraping for TraderPRO signal cards. Content-script context only.
(function (global) {
  global.TPS = global.TPS || {};

  // Both open- and close-position cards are scanned: a rebalance-down signal can
  // render under t09_close_position, and the "Цел" (goal) field — not the card's
  // open/close class — is what actually decides a card's meaning. See
  // TPS.classify.classifySignal(), which interprets goalText/quantityRaw.
  var CARD_SELECTOR = '.t09.t09_open_position, .t09.t09_close_position';
  var BLOCK_SELECTOR = '.t09_bl';
  var BODY_SELECTOR = '.t09_1';

  // Label-based extraction (not the numbered t09_12..t09_21 classes): the numbered
  // classes are positional and could shift if the site reorders fields, whereas the
  // Bulgarian .lbl text is the semantically stable anchor.
  var LABELS = {
    date: 'Дата',
    instrument: 'Инструмент',
    exchange: 'Борса',
    ticker: 'Символ',
    goal: 'Цел',
    quantityPercent: 'Количество'
  };

  /**
   * @param {Element} cardEl
   * @returns {{ticker:string, tickerAliases:string[], instrument:string, exchange:string,
   *            date:string, goalText:string, quantityRaw:string}|null}
   *          null if ticker is missing (malformed card — caller should skip it, not break the page).
   *          goalText/quantityRaw are returned raw and unparsed — TPS.classify.classifySignal()
   *          owns interpreting them into a signal type + target %, not this module. The site's
   *          own "Количество" field is only ever read here, never modified.
   */
  function scrapeCard(cardEl) {
    var fields = {};
    var blocks = cardEl.querySelectorAll(BLOCK_SELECTOR);
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var lblEl = block.querySelector('.lbl');
      var valEl = block.querySelector('.val');
      var lbl = lblEl && lblEl.textContent ? lblEl.textContent.trim() : '';
      var val = valEl && valEl.textContent ? valEl.textContent.trim() : '';
      if (lbl === LABELS.date) fields.date = val;
      else if (lbl === LABELS.instrument) fields.instrument = val;
      else if (lbl === LABELS.exchange) fields.exchange = val;
      else if (lbl === LABELS.ticker) fields.ticker = val;
      else if (lbl === LABELS.goal) fields.goalText = val;
      else if (lbl === LABELS.quantityPercent) fields.quantityRaw = val;
    }
    if (!fields.ticker) return null;
    return {
      ticker: fields.ticker,
      tickerAliases: TPS.classify.parseTickerAliases(fields.ticker),
      instrument: fields.instrument || '',
      exchange: fields.exchange || '',
      date: fields.date || '',
      goalText: fields.goalText || '',
      quantityRaw: fields.quantityRaw || ''
    };
  }

  function findCards(root) {
    root = root || document;
    return root.querySelectorAll(CARD_SELECTOR);
  }

  function getCardBody(cardEl) {
    return cardEl.querySelector(BODY_SELECTOR);
  }

  global.TPS.scrape = {
    CARD_SELECTOR: CARD_SELECTOR,
    BLOCK_SELECTOR: BLOCK_SELECTOR,
    BODY_SELECTOR: BODY_SELECTOR,
    LABELS: LABELS,
    scrapeCard: scrapeCard,
    findCards: findCards,
    getCardBody: getCardBody
  };
})(typeof self !== 'undefined' ? self : this);
