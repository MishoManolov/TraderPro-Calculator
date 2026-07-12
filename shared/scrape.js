// shared/scrape.js — DOM scraping for TraderPRO signal cards. Content-script context only.
(function (global) {
  global.TPS = global.TPS || {};

  // Buy/open-position cards only. Sell/close-position cards (.t09_close_position)
  // are never selected — they don't carry a meaningful position-size % and are
  // intentionally left untouched by this extension.
  var CARD_SELECTOR = '.t09.t09_open_position';
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
    quantityPercent: 'Количество'
  };

  function parsePercent(text) {
    if (!text) return 0;
    var n = parseFloat(String(text).replace(',', '.').replace('%', '').trim());
    return isFinite(n) ? n : 0;
  }

  /**
   * @param {Element} cardEl
   * @returns {{ticker:string, instrument:string, exchange:string, date:string, statedPercent:number}|null}
   *          null if ticker is missing (malformed card — caller should skip it, not break the page).
   *          The site's own "Количество" field is read here for its stated % but is never
   *          modified by the extension — there is no per-signal override, only a global
   *          one in settings.positionPercentOverride. See TPS.sizing.resolveEffectivePercent().
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
      else if (lbl === LABELS.quantityPercent) fields.statedPercentRaw = val;
    }
    if (!fields.ticker) return null;
    return {
      ticker: fields.ticker,
      instrument: fields.instrument || '',
      exchange: fields.exchange || '',
      date: fields.date || '',
      statedPercent: parsePercent(fields.statedPercentRaw)
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
    parsePercent: parsePercent,
    scrapeCard: scrapeCard,
    findCards: findCards,
    getCardBody: getCardBody
  };
})(typeof self !== 'undefined' ? self : this);
