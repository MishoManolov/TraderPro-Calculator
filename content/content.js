// content/content.js — card discovery, injection, live pricing, MutationObserver
(function () {
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
        status: 'loading', // 'loading' | 'ready' | 'error'
        quote: null,
        fx: null,
        errorMessage: null
      };
      cardStates.set(cardId, state);

      var body = TPS.scrape.getCardBody(cardEl);
      if (!body) return;
      var block = buildSizingBlockDom(state);
      body.appendChild(block);
      bindPercentInputHandler(cardId);

      if (!settings.accountBalance) {
        setBlockHint(cardId, 'Задайте наличност по сметка в настройките на добавката.');
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

  // ---------- rendering ----------

  function buildSizingBlockDom(state) {
    var block = document.createElement('div');
    block.className = 'tps-sizing-block tps-state-loading';
    block.setAttribute('data-tps-block-for', state.cardId);

    block.innerHTML =
      '<div class="tps-row"><span class="tps-label">Цена / бр.</span><span class="tps-value tps-price-value">…</span></div>' +
      '<div class="tps-row"><label class="tps-label" for="tps-percent-input-' + state.cardId + '">Позиция %</label>' +
        '<input id="tps-percent-input-' + state.cardId + '" class="tps-percent-input" type="number" min="0" max="100" step="0.1" value="' + state.currentPercent + '"></div>' +
      '<div class="tps-row"><span class="tps-label">Брой акции</span><span class="tps-value tps-shares-value">—</span></div>' +
      '<div class="tps-row"><span class="tps-label">Сума (валута на акцията)</span><span class="tps-value tps-total-position-value">—</span></div>' +
      '<div class="tps-row"><span class="tps-label">Сума (моята валута)</span><span class="tps-value tps-total-account-value">—</span></div>' +
      '<div class="tps-source-badge" hidden></div>' +
      '<div class="tps-hint-message" hidden></div>' +
      '<div class="tps-error-message" hidden></div>';

    return block;
  }

  function getBlockEl(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.cardEl) return null;
    return state.cardEl.querySelector('[data-tps-block-for="' + cardId + '"]');
  }

  function setBlockHint(cardId, text) {
    var block = getBlockEl(cardId);
    if (!block) return;
    var hintEl = block.querySelector('.tps-hint-message');
    hintEl.textContent = text;
    hintEl.hidden = !text;
  }

  function renderCardResult(cardId) {
    var state = cardStates.get(cardId);
    var block = getBlockEl(cardId);
    if (!state || !block || !state.quote || !state.fx) return;

    TPS.storage.getSettings().then(function (settings) {
      var result = TPS.sizing.computePositionSize({
        accountBalance: settings.accountBalance,
        percent: state.currentPercent,
        priceInPositionCurrency: state.quote.price,
        fxRate: state.fx.rate,
        roundingMode: settings.roundingMode,
        roundUpThresholdAmount: settings.roundUpThresholdAmount
      });

      block.className = 'tps-sizing-block tps-state-ready';
      block.querySelector('.tps-price-value').textContent = TPS.format.formatMoney(state.quote.price, state.quote.currency);
      block.querySelector('.tps-shares-value').textContent = TPS.format.formatShares(result.shares, settings.roundingMode);
      block.querySelector('.tps-total-position-value').textContent = TPS.format.formatMoney(result.totalPositionCurrency, state.quote.currency);
      block.querySelector('.tps-total-account-value').textContent = TPS.format.formatMoney(result.totalAccountCurrency, settings.accountCurrency);

      var errorEl = block.querySelector('.tps-error-message');
      errorEl.hidden = true;

      var badgeEl = block.querySelector('.tps-source-badge');
      var badgeParts = [];
      if (state.quote.source !== 'yahoo') badgeParts.push('цена: ' + state.quote.source + ' (прибл.)');
      if (state.fx.source && state.fx.source !== 'yahoo' && state.fx.source !== 'identity') badgeParts.push('курс: ' + state.fx.source);
      if (badgeParts.length) {
        badgeEl.textContent = badgeParts.join(' · ');
        badgeEl.hidden = false;
      } else {
        badgeEl.hidden = true;
      }

      setBlockHint(cardId, settings.accountBalance ? '' : 'Задайте наличност по сметка в настройките на добавката.');
    });
  }

  function renderCardError(cardId, message) {
    var block = getBlockEl(cardId);
    if (!block) return;
    block.className = 'tps-sizing-block tps-state-error';
    var errorEl = block.querySelector('.tps-error-message');
    errorEl.textContent = 'Грешка: ' + message;
    errorEl.hidden = false;
  }

  // ---------- percent editing ----------

  function bindPercentInputHandler(cardId) {
    var block = getBlockEl(cardId);
    if (!block) return;
    var input = block.querySelector('.tps-percent-input');
    var debounceTimer = null;
    input.addEventListener('input', function () {
      var value = parseFloat(input.value);
      if (!isFinite(value)) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        var state = cardStates.get(cardId);
        if (!state) return;
        state.currentPercent = value;
        if (state.status === 'ready') renderCardResult(cardId);
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
