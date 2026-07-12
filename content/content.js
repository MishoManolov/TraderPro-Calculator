// content/content.js — card discovery, injection, live pricing, MutationObserver
//
// Injection philosophy: appended values are rendered as ordinary ".t09_bl" rows
// (the same label/value block the site itself uses for every other field), so they
// inherit the site's own typography/spacing and read as a natural continuation of
// the card. The site's own "Количество" field is left completely untouched.
//
// Position sizing is NOT per-signal: there is a single global % override
// (settings.positionPercentOverride, configured once in the popup next to the
// account balance). Each card shows the resulting effective % as a static value
// (TPS.sizing.resolveEffectivePercent) — not an editable input — so all cards
// always agree with whatever's currently configured globally.
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
      var state = {
        cardId: cardId,
        cardEl: cardEl,
        ticker: scraped.ticker,
        instrument: scraped.instrument,
        exchange: scraped.exchange,
        date: scraped.date,
        statedPercent: scraped.statedPercent,
        status: 'loading', // 'loading' | 'ready' | 'error'
        quote: null,
        fx: null,
        errorMessage: null
      };
      cardStates.set(cardId, state);

      var body = TPS.scrape.getCardBody(cardEl);
      if (body) {
        var group = buildFieldsGroup(state, settings);
        body.appendChild(group);
      }

      if (!settings.accountBalance) {
        setMeta(cardId, 'hint', 'Задайте наличност по сметка в изскачащия прозорец на добавката.');
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

  function fieldRowHtml(fieldKey, label, valueHtml, extraClass, hiddenByDefault) {
    return '<div class="t09_bl' + (extraClass ? ' ' + extraClass : '') + '" data-tps-field="' + fieldKey + '"' + (hiddenByDefault ? ' hidden' : '') + '>' +
      '<p class="lbl">' + label + '</p>' +
      '<p class="val">' + valueHtml + '</p>' +
      '</div>';
  }

  // Appended fields are plain .t09_bl cells like every native field (label over
  // value), preceded by a single full-width divider (.tps-divider) that separates
  // them from the card's native fields — see content.css for why per-cell borders
  // were dropped in favor of this one line.
  function buildFieldsGroup(state, settings) {
    var wrapper = document.createElement('div');
    wrapper.className = 'tps-fields-group';
    wrapper.setAttribute('data-tps-block-for', state.cardId);

    var effectivePercent = TPS.sizing.resolveEffectivePercent(state.statedPercent, settings.positionPercentOverride);

    var html = '<div class="tps-divider"></div>';

    html += fieldRowHtml('percent', 'Позиция %', '<span class="tps-percent-value">' + TPS.format.formatPercent(effectivePercent) + '</span>');
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
      var effectivePercent = TPS.sizing.resolveEffectivePercent(state.statedPercent, settings.positionPercentOverride);
      var result = TPS.sizing.computePositionSize({
        accountBalance: settings.accountBalance,
        percent: effectivePercent,
        priceInPositionCurrency: state.quote.price,
        fxRate: state.fx.rate,
        roundingMode: settings.roundingMode,
        roundUpThresholdAmount: settings.roundUpThresholdAmount
      });

      group.querySelector('.tps-percent-value').textContent = TPS.format.formatPercent(effectivePercent);
      group.querySelector('.tps-price-value').textContent = TPS.format.formatMoney(state.quote.price, state.quote.currency);
      group.querySelector('.tps-shares-value').textContent = TPS.format.formatShares(result.shares, settings.roundingMode);
      group.querySelector('.tps-total-position-value').textContent = TPS.format.formatMoney(result.totalPositionCurrency, state.quote.currency);
      group.querySelector('.tps-total-account-value').textContent = TPS.format.formatMoney(result.totalAccountCurrency, settings.accountCurrency);

      var badgeParts = [];
      if (state.quote.source !== 'yahoo') badgeParts.push('цена: ' + state.quote.source + ' (прибл.)');
      if (state.fx.source && state.fx.source !== 'yahoo' && state.fx.source !== 'identity') badgeParts.push('курс: ' + state.fx.source);

      if (!settings.accountBalance) {
        setMeta(cardId, 'hint', 'Задайте наличност по сметка в изскачащия прозорец на добавката.');
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

  // ---------- settings reactivity ----------

  function handleSettingsChanged(newSettings, oldSettings) {
    var currencyChanged = newSettings.accountCurrency !== oldSettings.accountCurrency;
    var percentChanged = newSettings.positionPercentOverride !== oldSettings.positionPercentOverride;

    cardStates.forEach(function (state, cardId) {
      // The static "Позиция %" value must reflect the new global override even
      // for cards still loading/errored (not just 'ready' ones).
      if (percentChanged) {
        var group = getGroupEl(cardId);
        var percentEl = group && group.querySelector('.tps-percent-value');
        if (percentEl) {
          percentEl.textContent = TPS.format.formatPercent(
            TPS.sizing.resolveEffectivePercent(state.statedPercent, newSettings.positionPercentOverride)
          );
        }
      }
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
          statedPercent: state.statedPercent
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
