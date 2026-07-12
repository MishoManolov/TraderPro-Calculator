// content/content.js — card discovery, injection, live pricing, MutationObserver
//
// Injection philosophy: new/changed values are rendered as ordinary ".t09_bl" rows
// (the same label/value block the site itself uses for every other field), so they
// inherit the site's own typography/spacing and read as a natural continuation of
// the card — not a bolted-on box. To still make clear this content isn't part of the
// original signal: (1) a single small header row introduces the appended section,
// (2) every extension-touched row (including the "Количество" field, which is turned
// into an editable input in place rather than duplicated) carries a thin accent bar
// and a marker icon with an explanatory tooltip on hover.
(function () {
  var TOOLTIP_ADDED = 'Добавено от разширението TraderPRO Position Sizer — не е част от оригиналния сигнал';
  var TOOLTIP_EDITABLE = 'Стойността може да се редактира — добавено от TraderPRO Position Sizer';

  var cardStates = new Map(); // cardId -> state
  var cardIdCounter = 0;
  var observerRoot = null;
  var mutationDebounceTimer = null;
  var bootstrapObserver = null;
  var scopedObserver = null;

  // ---------- bootstrap ----------

  function init() {
    scanForNewCards(document);
    attachObserver();
    TPS.storage.onSettingsChanged(handleSettingsChanged);
  }

  function scanForNewCards(root) {
    var cards = TPS.scrape.findCards(root);
    for (var i = 0; i < cards.length; i++) {
      var cardEl = cards[i];
      if (cardEl.hasAttribute('data-tps-processed')) continue;
      processCard(cardEl);
    }
  }

  function findObserverRoot() {
    var anyCard = document.querySelector('.t09_open_position, .t09_close_position');
    return anyCard ? anyCard.parentElement : null;
  }

  function attachObserver() {
    observerRoot = findObserverRoot();
    if (observerRoot) {
      attachScopedObserver(observerRoot);
      return;
    }
    // No signal cards on the page yet — watch the whole body until the real
    // container appears, then switch to the scoped observer.
    bootstrapObserver = new MutationObserver(function () {
      var root = findObserverRoot();
      if (root) {
        bootstrapObserver.disconnect();
        bootstrapObserver = null;
        attachScopedObserver(root);
        scanForNewCards(document);
      }
    });
    bootstrapObserver.observe(document.body, { childList: true, subtree: true });
  }

  function attachScopedObserver(root) {
    observerRoot = root;
    scopedObserver = new MutationObserver(function () {
      if (!observerRoot || !observerRoot.isConnected) {
        scopedObserver.disconnect();
        scopedObserver = null;
        attachObserver(); // self-heal: the site replaced the container, re-bootstrap
        return;
      }
      if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = setTimeout(function () {
        scanForNewCards(observerRoot);
      }, 200);
    });
    scopedObserver.observe(root, { childList: true, subtree: true });
  }

  // ---------- per-card processing ----------

  function processCard(cardEl) {
    cardEl.setAttribute('data-tps-processed', '1');
    var cardId = 'tps-' + (cardIdCounter++);
    cardEl.setAttribute('data-tps-card-id', cardId);

    var scraped = TPS.scrape.scrapeCard(cardEl);
    if (!scraped) return; // malformed card — skip silently, don't break the page

    TPS.storage.getSettings().then(function (settings) {
      var initialPercent = settings.positionSizingMode === 'fixed' ? settings.fixedPercent : scraped.statedPercent;
      var state = {
        cardId: cardId,
        cardEl: cardEl,
        ticker: scraped.ticker,
        instrument: scraped.instrument,
        exchange: scraped.exchange,
        date: scraped.date,
        statedPercent: scraped.statedPercent,
        currentPercent: initialPercent,
        quantityBlockEl: scraped.quantityBlockEl,
        quantityValueEl: scraped.quantityValueEl,
        percentInputEl: null,
        status: 'loading', // 'loading' | 'ready' | 'error'
        quote: null,
        fx: null,
        errorMessage: null
      };
      cardStates.set(cardId, state);

      makeQuantityFieldEditable(state); // turns the site's own "Количество" row into an input, if found

      var body = TPS.scrape.getCardBody(cardEl);
      if (body) {
        var group = buildFieldsGroup(state);
        body.appendChild(group);
        if (!state.percentInputEl) {
          // Fallback: the "Количество" row wasn't found (unexpected markup) — the
          // fields group itself included a percent input so editing still works.
          state.percentInputEl = group.querySelector('.tps-percent-input');
        }
      }

      bindPercentInputHandler(cardId);

      if (!settings.accountBalance) {
        setMeta(cardId, 'hint', 'Задайте наличност по сметка в настройките на добавката.');
      }

      loadPriceAndRender(cardId);
    });
  }

  function loadPriceAndRender(cardId) {
    var state = cardStates.get(cardId);
    if (!state) return;

    Promise.all([
      TPS.messaging.requestQuote(state.ticker),
      TPS.storage.getSettings()
    ]).then(function (results) {
      var quoteResponse = results[0];
      var settings = results[1];
      if (!quoteResponse || !quoteResponse.ok) {
        throw new Error((quoteResponse && quoteResponse.error) || 'Неуспешно зареждане на цена');
      }
      var quote = quoteResponse.data;
      state.quote = quote;

      if (quote.currency === settings.accountCurrency) {
        return { rate: 1, source: 'identity' };
      }
      return TPS.messaging.requestFxRate(quote.currency, settings.accountCurrency).then(function (fxResponse) {
        if (!fxResponse || !fxResponse.ok) {
          throw new Error((fxResponse && fxResponse.error) || 'Неуспешно зареждане на валутен курс');
        }
        return fxResponse.data;
      });
    }).then(function (fx) {
      state.fx = fx;
      state.status = 'ready';
      state.errorMessage = null;
      renderCardResult(cardId);
    }).catch(function (err) {
      state.status = 'error';
      state.errorMessage = String((err && err.message) || err);
      renderCardError(cardId, state.errorMessage);
    });
  }

  function loadFxOnly(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.quote) return Promise.resolve();
    return TPS.storage.getSettings().then(function (settings) {
      if (state.quote.currency === settings.accountCurrency) {
        state.fx = { rate: 1, source: 'identity' };
        return;
      }
      return TPS.messaging.requestFxRate(state.quote.currency, settings.accountCurrency).then(function (fxResponse) {
        if (!fxResponse || !fxResponse.ok) throw new Error((fxResponse && fxResponse.error) || 'FX error');
        state.fx = fxResponse.data;
      });
    }).then(function () {
      renderCardResult(cardId);
    }).catch(function (err) {
      state.status = 'error';
      state.errorMessage = String((err && err.message) || err);
      renderCardError(cardId, state.errorMessage);
    });
  }

  // ---------- DOM building ----------

  function markerHtml(title, glyph) {
    return '<span class="tps-marker" title="' + escapeAttr(title) + '">' + glyph + '</span>';
  }

  function escapeAttr(text) {
    return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function fieldRowHtml(fieldKey, label, valueHtml, extraClass, hiddenByDefault) {
    return '<div class="t09_bl tps-field' + (extraClass ? ' ' + extraClass : '') + '" data-tps-field="' + fieldKey + '"' + (hiddenByDefault ? ' hidden' : '') + '>' +
      '<p class="lbl">' + label + '</p>' +
      '<p class="val">' + valueHtml + '</p>' +
      '</div>';
  }

  // Turns the site's own "Количество" (position size %) field into a live input,
  // instead of adding a separate row — the most native-feeling place for it to live,
  // since it's literally the field that already shows the position size.
  function makeQuantityFieldEditable(state) {
    var blockEl = state.quantityBlockEl;
    var valueEl = state.quantityValueEl;
    if (!blockEl || !valueEl) return;
    blockEl.classList.add('tps-field', 'tps-field-editable');
    var lblEl = blockEl.querySelector('.lbl');
    if (lblEl && !lblEl.querySelector('.tps-marker')) {
      lblEl.insertAdjacentHTML('beforeend', ' ' + markerHtml(TOOLTIP_EDITABLE, '✎'));
    }
    valueEl.innerHTML = '<input class="tps-percent-input" type="number" min="0" max="100" step="0.1" value="' + state.currentPercent + '">%';
    state.percentInputEl = valueEl.querySelector('.tps-percent-input');
  }

  function buildFieldsGroup(state) {
    var wrapper = document.createElement('div');
    wrapper.className = 'tps-fields-group';
    wrapper.setAttribute('data-tps-block-for', state.cardId);

    var html = fieldRowHtml(
      'header',
      markerHtml(TOOLTIP_ADDED, '⚡') + ' Изчислено от Position Sizer',
      '',
      'tps-field-header'
    );

    if (!state.percentInputEl) {
      // Fallback path — see processCard(): only used if the site's "Количество" row wasn't found.
      html += fieldRowHtml('percent', 'Позиция %',
        '<input class="tps-percent-input" type="number" min="0" max="100" step="0.1" value="' + state.currentPercent + '">%');
    }

    html += fieldRowHtml('price', 'Цена / бр.', '<span class="tps-price-value">…</span>');
    html += fieldRowHtml('shares', 'Брой акции', '<span class="tps-shares-value">—</span>');
    html += fieldRowHtml('total-position', 'Сума (вал. на акцията)', '<span class="tps-total-position-value">—</span>');
    html += fieldRowHtml('total-account', 'Сума (моята валута)', '<span class="tps-total-account-value">—</span>');
    html += fieldRowHtml('meta', 'Инфо', '<span class="tps-meta-value">—</span>', 'tps-field-meta', true);

    wrapper.innerHTML = html;
    return wrapper;
  }

  function getGroupEl(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.cardEl) return null;
    return state.cardEl.querySelector('[data-tps-block-for="' + cardId + '"]');
  }

  function setMeta(cardId, kind, text) {
    var group = getGroupEl(cardId);
    if (!group) return;
    var metaRow = group.querySelector('[data-tps-field="meta"]');
    var metaValueEl = group.querySelector('.tps-meta-value');
    if (!metaRow || !metaValueEl) return;
    if (!text) {
      metaRow.hidden = true;
      return;
    }
    metaValueEl.textContent = text;
    metaRow.hidden = false;
    metaRow.classList.remove('tps-meta-hint', 'tps-meta-error', 'tps-meta-badge');
    metaRow.classList.add('tps-meta-' + kind);
  }

  // ---------- rendering ----------

  function renderCardResult(cardId) {
    var state = cardStates.get(cardId);
    var group = getGroupEl(cardId);
    if (!state || !group || !state.quote || !state.fx) return;

    TPS.storage.getSettings().then(function (settings) {
      var result = TPS.sizing.computePositionSize({
        accountBalance: settings.accountBalance,
        percent: state.currentPercent,
        priceInPositionCurrency: state.quote.price,
        fxRate: state.fx.rate,
        roundingMode: settings.roundingMode,
        roundUpThresholdAmount: settings.roundUpThresholdAmount
      });

      group.querySelector('.tps-price-value').textContent = TPS.format.formatMoney(state.quote.price, state.quote.currency);
      group.querySelector('.tps-shares-value').textContent = TPS.format.formatShares(result.shares, settings.roundingMode);
      group.querySelector('.tps-total-position-value').textContent = TPS.format.formatMoney(result.totalPositionCurrency, state.quote.currency);
      group.querySelector('.tps-total-account-value').textContent = TPS.format.formatMoney(result.totalAccountCurrency, settings.accountCurrency);

      var badgeParts = [];
      if (state.quote.source !== 'yahoo') badgeParts.push('цена: ' + state.quote.source + ' (прибл.)');
      if (state.fx.source && state.fx.source !== 'yahoo' && state.fx.source !== 'identity') badgeParts.push('курс: ' + state.fx.source);

      if (!settings.accountBalance) {
        setMeta(cardId, 'hint', 'Задайте наличност по сметка в настройките на добавката.');
      } else if (badgeParts.length) {
        setMeta(cardId, 'badge', badgeParts.join(' · '));
      } else {
        setMeta(cardId, null, '');
      }
    });
  }

  function renderCardError(cardId, message) {
    setMeta(cardId, 'error', 'Грешка: ' + message);
  }

  // ---------- percent editing ----------

  function bindPercentInputHandler(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.percentInputEl) return;
    var input = state.percentInputEl;
    var debounceTimer = null;
    input.addEventListener('input', function () {
      var value = parseFloat(input.value);
      if (!isFinite(value)) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        var s = cardStates.get(cardId);
        if (!s) return;
        s.currentPercent = value;
        if (s.status === 'ready') renderCardResult(cardId);
      }, 150);
    });
  }

  // ---------- settings reactivity ----------

  function handleSettingsChanged(newSettings, oldSettings) {
    var currencyChanged = newSettings.accountCurrency !== oldSettings.accountCurrency;
    cardStates.forEach(function (state, cardId) {
      if (state.status !== 'ready') return;
      if (currencyChanged) {
        loadFxOnly(cardId);
      } else {
        renderCardResult(cardId);
      }
    });
  }

  // ---------- popup messaging ----------

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (message.type === TPS.messaging.MSG.GET_SIGNALS) {
      var data = [];
      cardStates.forEach(function (state) {
        data.push({
          cardId: state.cardId,
          ticker: state.ticker,
          instrument: state.instrument,
          exchange: state.exchange,
          date: state.date,
          statedPercent: state.statedPercent,
          currentPercent: state.currentPercent
        });
      });
      sendResponse({ ok: true, data: data });
      return true;
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
