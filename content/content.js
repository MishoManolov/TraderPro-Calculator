// content/content.js — card discovery, injection, live pricing, MutationObserver
//
// Injection philosophy: appended values are rendered as ordinary ".t09_bl" rows
// (the same label/value block the site itself uses for every other field), so they
// inherit the site's own typography/spacing and read as a natural continuation of
// the card. The site's own "Количество" field is left completely untouched.
//
// Position sizing is NOT per-signal: there is a single global strategy-weight
// multiplier (settings.strategyWeightPercent, configured once in the floating
// on-page widget — see content/widget.js — next to the account balance),
// applied uniformly to every signal type's own target % (TPS.sizing.
// applyStrategyWeight — statedPercent/targetPercent * weight/100, weight
// defaulting to 100 when unset) — the same idea as "this strategy only gets
// X% of my portfolio" for both plain opens and rebalance targets. 'open'-type
// cards show the resulting effective % as a static value, not an editable
// input, so all cards always agree with whatever's currently configured
// globally; 'rebalance'-type cards weight their target % the same way before
// computing the trade (see buildRebalanceFieldsGroup/renderRebalanceResult).
//
// Signal type (open/close/rebalance) is decided by TPS.classify.classifySignal()
// reading the card's "Цел" (goal) text — the t09_open_position/t09_close_position
// CSS class alone is not authoritative (a rebalance-down signal can render under
// either class). When the heuristic can't confidently classify a card, it comes
// back as 'unknown' and this file shows a manual fallback control instead of
// guessing; the user's choice is persisted via TPS.positions.setSignalOverride()
// so it survives reloads and doesn't need to be re-picked every time.
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
    TPS.positions.onPositionsChanged(handlePositionsChanged);
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

  // Reconciles the heuristic classification with any saved manual correction —
  // the single place that decides what a card "really" means. A saved override
  // always wins (it exists specifically because the heuristic got this one
  // wrong or couldn't tell), but a fresh classifySignal() result is what a card
  // starts with before any override is loaded.
  function effectiveClassification(state) {
    // state.override may hold only a ticker/target-price correction (no `type`)
    // if the user never touched the fallback classification controls — in that
    // case fall through to the raw heuristic result, same as no override at all.
    if (state.override && state.override.type) return { type: state.override.type, targetPercent: state.override.targetPercent };
    return { type: state.rawType, targetPercent: state.rawTargetPercent };
  }

  function processCard(cardEl) {
    cardEl.setAttribute('data-tps-processed', '1');
    var cardId = 'tps-' + (cardIdCounter++);
    cardEl.setAttribute('data-tps-card-id', cardId);

    var scraped = TPS.scrape.scrapeCard(cardEl);
    if (!scraped) return; // malformed card — skip silently, don't break the page

    var classification = TPS.classify.classifySignal(scraped.goalText, scraped.quantityRaw);
    var tickerKey = TPS.classify.normalizeTickerKey(scraped.tickerAliases);
    var signalKey = TPS.positions.makeSignalKey(tickerKey, scraped.date);

    Promise.all([TPS.storage.getSettings(), TPS.positions.getPositions()]).then(function (results) {
      var settings = results[0];
      var positions = results[1];

      var state = {
        cardId: cardId,
        cardEl: cardEl,
        ticker: scraped.tickerAliases[0] || scraped.ticker,
        tickerAliases: scraped.tickerAliases,
        tickerKey: tickerKey,
        signalKey: signalKey,
        instrument: scraped.instrument,
        exchange: scraped.exchange,
        date: scraped.date,
        goalText: scraped.goalText,
        quantityRaw: scraped.quantityRaw,
        rawType: classification.type,
        rawTargetPercent: classification.targetPercent,
        override: positions.signalOverrides[signalKey] || null,
        currentShares: positions.holdings[tickerKey],
        status: 'loading', // 'loading' | 'ready' | 'error'
        quote: null,
        fx: null,
        errorMessage: null,
        dom: null,
        // Field keys ('ticker'|'price'|'classification') with a local edit
        // that's applied in memory but not yet confirmed written to
        // chrome.storage — see handlePositionsChanged for why this matters.
        dirtyOverride: {}
      };
      state.tickerOverride = (state.override && state.override.tickerOverride) || null;
      state.targetPriceOverride = (state.override && typeof state.override.targetPrice === 'number') ? state.override.targetPrice : null;
      state.effectiveTickerAliases = state.tickerOverride ? TPS.classify.parseTickerAliases(state.tickerOverride) : state.tickerAliases;
      cardStates.set(cardId, state);

      renderForType(cardId, settings);
    });
  }

  // (Re)builds the appended fields for a card according to its current
  // effective classification, and kicks off price loading if needed. Called
  // once from processCard() and again whenever a fallback selection resolves
  // an 'unknown' card into a real type (see bindFallbackControls below) —
  // structurally different types need different rows, so the group is rebuilt
  // rather than trying to toggle every possible row's visibility in place.
  function renderForType(cardId, settings) {
    var state = cardStates.get(cardId);
    if (!state) return;

    var effective = effectiveClassification(state);
    state.effectiveType = effective.type;
    state.effectiveTargetPercent = effective.targetPercent;

    if (state.dom && state.dom.group && state.dom.group.parentNode) {
      state.dom.group.parentNode.removeChild(state.dom.group);
    }
    state.dom = null;

    if (effective.type === 'close') {
      // Plain full close: nothing to size, nothing to append — same as this
      // extension's original behavior for close-position cards.
      return;
    }

    var body = TPS.scrape.getCardBody(state.cardEl);
    if (!body) return;

    var group = effective.type === 'unknown'
      ? buildFallbackFieldsGroup(state, settings)
      : (effective.type === 'rebalance' ? buildRebalanceFieldsGroup(state, settings) : buildOpenFieldsGroup(state, settings));
    body.appendChild(group);

    state.dom = {
      group: group,
      percentEl: group.querySelector('.tps-percent-value'),
      priceEl: group.querySelector('.tps-price-value'),
      sharesEl: group.querySelector('.tps-shares-value'),
      totalPositionEl: group.querySelector('.tps-total-position-value'),
      totalAccountEl: group.querySelector('.tps-total-account-value'),
      targetPercentEl: group.querySelector('.tps-target-percent-value'),
      currentSharesInput: group.querySelector('.tps-current-shares-input'),
      targetSharesEl: group.querySelector('.tps-target-shares-value'),
      actionEl: group.querySelector('.tps-action-value'),
      tradeValueEl: group.querySelector('.tps-trade-value-value'),
      metaRow: group.querySelector('[data-tps-field="meta"]'),
      metaValueEl: group.querySelector('.tps-meta-value'),
      tickerEditBtn: group.querySelector('.tps-ticker-edit-btn'),
      tickerDisplay: group.querySelector('.tps-ticker-display'),
      tickerInput: group.querySelector('.tps-ticker-input'),
      tickerOriginal: group.querySelector('.tps-ticker-original'),
      tickerSaved: group.querySelector('.tps-ticker-saved'),
      priceEditBtn: group.querySelector('.tps-price-edit-btn'),
      priceInput: group.querySelector('.tps-price-input'),
      priceOriginal: group.querySelector('.tps-price-original'),
      priceSaved: group.querySelector('.tps-price-saved')
    };

    if (state.dom.currentSharesInput) bindCurrentSharesInput(cardId);
    if (effective.type === 'unknown') bindFallbackControls(cardId);
    if (effective.type !== 'unknown') {
      bindTickerOverrideControls(cardId);
      bindTargetPriceOverrideControls(cardId);
      renderTickerOverrideDisplay(cardId);
    }

    if (!settings.accountBalance) {
      setMeta(cardId, 'hint', 'Задайте наличност по сметка в плаващия панел вдясно.');
    }

    if (effective.type === 'unknown') return; // nothing to price until classified

    if (state.quote && state.fx) {
      // Ticker hasn't changed across a rebuild (only classification did) — the
      // already-loaded quote/fx are still valid, no need to refetch.
      state.status = 'ready';
      renderCardResult(cardId, settings);
    } else {
      loadPriceAndRender(cardId);
    }
  }

  function loadPriceAndRender(cardId) {
    var state = cardStates.get(cardId);
    if (!state) return;

    var loadedSettings;

    Promise.all([
      TPS.messaging.requestQuoteForAliasesOrThrow(state.effectiveTickerAliases, 'Неуспешно зареждане на цена'),
      TPS.storage.getSettings()
    ]).then(function (results) {
      var quote = results[0];
      var settings = results[1];
      loadedSettings = settings;
      state.quote = quote;
      return TPS.messaging.resolveFxRate(quote.currency, settings.accountCurrency, 'Неуспешно зареждане на валутен курс');
    }).then(function (fx) {
      state.fx = fx;
      state.status = 'ready';
      state.errorMessage = null;
      renderCardResult(cardId, loadedSettings);
    }).catch(function (err) {
      state.status = 'error';
      state.errorMessage = String((err && err.message) || err);
      renderCardError(cardId, state.errorMessage);
    });
  }

  function loadFxOnly(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.quote) return Promise.resolve();
    var loadedSettings;
    return TPS.storage.getSettings().then(function (settings) {
      loadedSettings = settings;
      return TPS.messaging.resolveFxRate(state.quote.currency, settings.accountCurrency, 'FX error');
    }).then(function (fx) {
      state.fx = fx;
      renderCardResult(cardId, loadedSettings);
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

  function metaRowHtml() {
    return fieldRowHtml('meta', 'Инфо', '<span class="tps-meta-value">—</span>', 'tps-field-meta', true);
  }

  var escapeHtmlScratchDiv = document.createElement('div');

  function escapeHtml(text) {
    escapeHtmlScratchDiv.textContent = text || '';
    return escapeHtmlScratchDiv.innerHTML;
  }

  // Markup for a single "pencil icon + display text + hidden input + hidden
  // struck-through original + hidden saved-checkmark" field, wrapped in one
  // element so it's the sole child of its .val (content.css's single-child
  // rule — see "Injection styling" in CLAUDE.md). Used for both the ticker-
  // override row and the price row; `displayClass` lets a caller keep an
  // existing selector (e.g. `.tps-price-value`) working on the display span.
  function editableValueHtml(prefix, displayClass, displayText, inputAttrs, disabled) {
    return '<span class="tps-editable-value">' +
      '<button type="button" class="tps-edit-icon tps-' + prefix + '-edit-btn" aria-label="Редактирай"' + (disabled ? ' disabled' : '') + '>✎</button>' +
      '<span class="tps-' + prefix + '-display' + (displayClass ? ' ' + displayClass : '') + '">' + displayText + '</span>' +
      '<input class="tps-input tps-' + prefix + '-input" ' + (inputAttrs || '') + ' hidden>' +
      '<span class="tps-original-value tps-' + prefix + '-original" hidden></span>' +
      '<span class="tps-inline-saved tps-' + prefix + '-saved" hidden>✓</span>' +
      '</span>';
  }

  // Plain open/buy card — unchanged from the original single-type version,
  // just fed by TPS.classify's targetPercent (renamed from the old
  // scrape.js-owned "statedPercent") instead of scrape.js parsing "%" inline.
  function buildOpenFieldsGroup(state, settings) {
    var wrapper = document.createElement('div');
    wrapper.className = 'tps-fields-group';
    wrapper.setAttribute('data-tps-block-for', state.cardId);

    var effectivePercent = TPS.sizing.applyStrategyWeight(state.effectiveTargetPercent, settings.strategyWeightPercent);

    var html = '<div class="tps-divider"></div>';
    html += fieldRowHtml('ticker-override', 'Използван символ', editableValueHtml('ticker', '', escapeHtml(state.ticker), 'type="text"'));
    html += fieldRowHtml('percent', 'Позиция %', '<span class="tps-percent-value">' + TPS.format.formatPercent(effectivePercent) + '</span>');
    html += fieldRowHtml('price', 'Цена / бр.', editableValueHtml('price', 'tps-price-value', '…', 'type="number" step="any" min="0"', true));
    html += fieldRowHtml('shares', 'Брой акции', '<span class="tps-shares-value">—</span>');
    html += fieldRowHtml('total-position', 'Сума (вал. на акцията)', '<span class="tps-total-position-value">—</span>');
    html += fieldRowHtml('total-account', 'Сума (моята валута)', '<span class="tps-total-account-value">—</span>');
    html += metaRowHtml();

    wrapper.innerHTML = html;
    return wrapper;
  }

  // Rebalance card: shows the signal's target % (from text or a resolved
  // override, scaled by the strategy weight — same TPS.sizing.
  // applyStrategyWeight() used for 'open' cards, see file-header comment), an
  // editable "current shares held" input (the one piece of portfolio state
  // this extension can't observe on its own — see shared/positions.js), and
  // the resulting buy/sell/hold trade.
  function buildRebalanceFieldsGroup(state, settings) {
    var wrapper = document.createElement('div');
    wrapper.className = 'tps-fields-group';
    wrapper.setAttribute('data-tps-block-for', state.cardId);

    var currentShares = isFinite(state.currentShares) ? state.currentShares : 0;
    var weightedTargetPercent = TPS.sizing.applyStrategyWeight(state.effectiveTargetPercent, settings.strategyWeightPercent);

    var html = '<div class="tps-divider"></div>';
    html += fieldRowHtml('ticker-override', 'Използван символ', editableValueHtml('ticker', '', escapeHtml(state.ticker), 'type="text"'));
    html += fieldRowHtml('rebalance-target-percent', 'Целеви %', '<span class="tps-target-percent-value">' + TPS.format.formatPercent(weightedTargetPercent) + '</span>');
    html += fieldRowHtml('price', 'Цена / бр.', editableValueHtml('price', 'tps-price-value', '…', 'type="number" step="any" min="0"', true));
    html += fieldRowHtml(
      'rebalance-current-shares',
      'Текущи акции',
      '<input type="number" min="0" step="1" class="tps-input tps-current-shares-input" value="' + currentShares + '">'
    );
    html += fieldRowHtml('rebalance-target-shares', 'Целеви акции', '<span class="tps-target-shares-value">—</span>');
    html += fieldRowHtml('rebalance-action', 'Действие', '<span class="tps-action-value">—</span>');
    html += fieldRowHtml('rebalance-trade-value', 'Стойност на сделката', '<span class="tps-trade-value-value">—</span>');
    html += metaRowHtml();

    wrapper.innerHTML = html;
    return wrapper;
  }

  var FALLBACK_TYPE_OPTIONS = [
    { value: 'open', label: 'Отваря позиция' },
    { value: 'close', label: 'Затваря позиция' },
    { value: 'rebalance', label: 'Ребаланс до %' }
  ];

  // Shown when TPS.classify couldn't confidently read a card's "Цел"/
  // "Количество" text (type 'unknown'). Deliberately doesn't guess — the user
  // picks the real type and, for rebalance, the target %; that choice is
  // persisted per-signal via TPS.positions.setSignalOverride() (see
  // bindFallbackControls) so it isn't re-asked on every reload.
  function buildFallbackFieldsGroup(state, settings) {
    var wrapper = document.createElement('div');
    wrapper.className = 'tps-fields-group';
    wrapper.setAttribute('data-tps-block-for', state.cardId);

    var optionsHtml = '<option value="">— избери —</option>';
    for (var i = 0; i < FALLBACK_TYPE_OPTIONS.length; i++) {
      optionsHtml += '<option value="' + FALLBACK_TYPE_OPTIONS[i].value + '">' + FALLBACK_TYPE_OPTIONS[i].label + '</option>';
    }

    var html = '<div class="tps-divider"></div>';
    html += fieldRowHtml(
      'fallback-hint',
      'Инфо',
      '<span class="tps-meta-value">Неразпознат сигнал — избери ръчно какво означава</span>',
      'tps-field-meta tps-meta-hint'
    );
    html += fieldRowHtml('fallback-type', 'Тип сигнал', '<select class="tps-select tps-fallback-type-select">' + optionsHtml + '</select>');
    html += fieldRowHtml(
      'fallback-percent',
      'Целеви % (ръчно)',
      '<input type="number" min="0" max="100" step="0.1" class="tps-input tps-fallback-percent-input" placeholder="%">',
      null,
      true
    );

    wrapper.innerHTML = html;
    return wrapper;
  }

  function setMeta(cardId, kind, text) {
    var state = cardStates.get(cardId);
    if (!state || !state.dom) return;
    var metaRow = state.dom.metaRow;
    var metaValueEl = state.dom.metaValueEl;
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

  // ---------- inline editing (current shares, fallback classification) ----------

  var saveTimers = {}; // cardId -> timer, per-field keys below

  function debounceSave(timerKey, delay, fn) {
    if (saveTimers[timerKey]) clearTimeout(saveTimers[timerKey]);
    saveTimers[timerKey] = setTimeout(fn, delay);
  }

  // Same debounce(300ms)-then-flash-checkmark(1200ms) shape as content/widget.js's
  // flashSaved, reused here for the ticker/target-price overrides below.
  function flashSaved(el) {
    if (!el) return;
    el.hidden = false;
    if (el._tpsSavedTimer) clearTimeout(el._tpsSavedTimer);
    el._tpsSavedTimer = setTimeout(function () {
      el.hidden = true;
    }, 1200);
  }

  // TPS.positions.setSignalOverride() merges on the storage side, but state.override
  // is also read locally (effectiveClassification, handlePositionsChanged's diff
  // check) — merge here too so a ticker/price edit doesn't clobber an in-memory
  // classification override (or vice versa) between now and the next storage sync.
  function mergeLocalOverride(state, patch) {
    var merged = {};
    for (var k in state.override) merged[k] = state.override[k];
    for (var pk in patch) merged[pk] = patch[pk];
    state.override = merged;
  }

  // Current shares held is per-ticker portfolio state (TPS.positions.holdings),
  // not per-card — editing it here updates every other visible card for the
  // same ticker via TPS.positions.onPositionsChanged (see
  // handlePositionsChanged), the same propagation shape settings changes use.
  function bindCurrentSharesInput(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.dom || !state.dom.currentSharesInput) return;
    var input = state.dom.currentSharesInput;

    input.addEventListener('input', function () {
      var value = parseFloat(input.value);
      if (!isFinite(value) || value < 0) return;
      state.currentShares = value;
      renderRebalanceResult(cardId);
      debounceSave('shares-' + cardId, 300, function () {
        TPS.positions.setHolding(state.tickerKey, value);
      });
    });
  }

  function bindFallbackControls(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.dom || !state.dom.group) return;
    var group = state.dom.group;
    var typeSelect = group.querySelector('.tps-fallback-type-select');
    var percentRow = group.querySelector('[data-tps-field="fallback-percent"]');
    var percentInput = group.querySelector('.tps-fallback-percent-input');
    if (!typeSelect || !percentInput) return;

    function maybeSaveOverride() {
      var type = typeSelect.value;
      if (!type) return;
      percentRow.hidden = type !== 'rebalance';
      if (type !== 'rebalance') {
        saveOverride(cardId, { type: type, targetPercent: null });
        return;
      }
      var percent = parseFloat(percentInput.value);
      if (!isFinite(percent) || percent < 0 || percent > 100) return;
      saveOverride(cardId, { type: type, targetPercent: percent });
    }

    typeSelect.addEventListener('change', maybeSaveOverride);
    percentInput.addEventListener('input', function () {
      debounceSave('fallback-percent-' + cardId, 300, maybeSaveOverride);
    });
  }

  function saveOverride(cardId, override) {
    var state = cardStates.get(cardId);
    if (!state) return;
    mergeLocalOverride(state, override);
    state.dirtyOverride.classification = true;
    TPS.positions.setSignalOverride(state.signalKey, override).then(function () {
      delete state.dirtyOverride.classification;
      TPS.storage.getSettings().then(function (settings) {
        renderForType(cardId, settings);
      });
    });
  }

  // ---------- inline editing (ticker override, target price) ----------

  // Reflects state.tickerOverride into the ticker-override row's display/
  // struck-through-original spans. Called right after (re)building a card's
  // fields group and after every commit/remote update — never assumes the
  // freshly-built markup (which always starts by showing the native ticker)
  // already matches the current override.
  function renderTickerOverrideDisplay(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.dom || !state.dom.tickerDisplay) return;
    if (state.tickerOverride) {
      state.dom.tickerDisplay.textContent = state.tickerOverride;
      if (state.dom.tickerOriginal) {
        state.dom.tickerOriginal.textContent = state.ticker;
        state.dom.tickerOriginal.hidden = false;
      }
    } else {
      state.dom.tickerDisplay.textContent = state.ticker;
      if (state.dom.tickerOriginal) state.dom.tickerOriginal.hidden = true;
    }
  }

  // Ticker override corrects a malformed/unrecognized ticker for THIS card's
  // own quote lookup only — it never touches the site's own native "Символ"
  // field/DOM (see file header + CLAUDE.md "Injection styling"). Persisted
  // per-signal-instance via TPS.positions.setSignalOverride (same map/lifetime
  // as the fallback-classification override above), so a later signal for the
  // same ticker starts fresh rather than inheriting a stale correction.
  function bindTickerOverrideControls(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.dom || !state.dom.tickerEditBtn) return;
    var btn = state.dom.tickerEditBtn;
    var display = state.dom.tickerDisplay;
    var input = state.dom.tickerInput;

    function enterEditMode() {
      input.value = state.tickerOverride || state.ticker;
      display.hidden = true;
      btn.hidden = true;
      if (state.dom.tickerOriginal) state.dom.tickerOriginal.hidden = true;
      input.hidden = false;
      input.focus();
      input.select();
    }

    function exitEditMode() {
      input.hidden = true;
      display.hidden = false;
      btn.hidden = false;
    }

    function commit() {
      var value = input.value.trim();
      exitEditMode();

      var isSame = !value || value.toUpperCase() === state.ticker.toUpperCase();
      var newOverride = isSame ? null : value;
      if (newOverride === state.tickerOverride) {
        renderTickerOverrideDisplay(cardId);
        return;
      }

      state.tickerOverride = newOverride;
      state.effectiveTickerAliases = state.tickerOverride
        ? TPS.classify.parseTickerAliases(state.tickerOverride)
        : state.tickerAliases;
      mergeLocalOverride(state, { tickerOverride: state.tickerOverride });
      state.dirtyOverride.ticker = true;
      renderTickerOverrideDisplay(cardId);

      // Ticker changed — the loaded quote (and FX, since currency may differ
      // under the corrected symbol) is for the wrong instrument now; refetch.
      state.quote = null;
      state.fx = null;
      state.status = 'loading';
      loadPriceAndRender(cardId);

      debounceSave('ticker-' + cardId, 300, function () {
        TPS.positions.setSignalOverride(state.signalKey, { tickerOverride: state.tickerOverride }).then(function () {
          delete state.dirtyOverride.ticker;
          flashSaved(state.dom.tickerSaved);
        });
      });
    }

    btn.addEventListener('click', enterEditMode);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = state.tickerOverride || state.ticker;
        input.blur();
      }
    });
    input.addEventListener('blur', commit);
  }

  // Target price overrides the live quote price as the input to this card's
  // position-size calculation (TPS.sizing.resolveSizingPrice) — the live quote
  // is still fetched/shown (struck through, for comparison) and still drives
  // FX. Only reachable once a quote has loaded (button starts `disabled` in
  // the markup, re-enabled in renderCardResult once state.quote/state.fx exist).
  function bindTargetPriceOverrideControls(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.dom || !state.dom.priceEditBtn) return;
    var btn = state.dom.priceEditBtn;
    var input = state.dom.priceInput;

    function enterEditMode() {
      if (btn.disabled) return;
      input.value = (typeof state.targetPriceOverride === 'number') ? state.targetPriceOverride : '';
      state.dom.priceEl.hidden = true;
      btn.hidden = true;
      if (state.dom.priceOriginal) state.dom.priceOriginal.hidden = true;
      input.hidden = false;
      input.focus();
      input.select();
    }

    function exitEditMode() {
      input.hidden = true;
      state.dom.priceEl.hidden = false;
      btn.hidden = false;
    }

    function commit() {
      var raw = input.value.trim();
      exitEditMode();

      var value = raw === '' ? null : parseFloat(raw);
      var invalid = value !== null && (!isFinite(value) || value <= 0);
      if (invalid) value = state.targetPriceOverride; // ignore bad input, keep prior override

      var changed = value !== state.targetPriceOverride;
      state.targetPriceOverride = value;
      if (changed) {
        mergeLocalOverride(state, { targetPrice: value });
        state.dirtyOverride.price = true;
      }

      // Always re-render, even when unchanged — enterEditMode() hid the
      // struck-through original/edit button, which only renderCardResult
      // knows how to correctly restore (whether an override is still active).
      TPS.storage.getSettings().then(function (settings) { renderCardResult(cardId, settings); });

      if (changed) {
        debounceSave('price-' + cardId, 300, function () {
          TPS.positions.setSignalOverride(state.signalKey, { targetPrice: state.targetPriceOverride }).then(function () {
            delete state.dirtyOverride.price;
            flashSaved(state.dom.priceSaved);
          });
        });
      }
    }

    btn.addEventListener('click', enterEditMode);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = (typeof state.targetPriceOverride === 'number') ? state.targetPriceOverride : '';
        input.blur();
      }
    });
    input.addEventListener('blur', commit);
  }

  // ---------- rendering ----------

  function renderCardResult(cardId, settings) {
    var state = cardStates.get(cardId);
    if (!state || !state.dom || !state.quote || !state.fx) return;

    if (state.dom.priceEditBtn) state.dom.priceEditBtn.disabled = false;
    if (state.dom.priceOriginal) {
      if (typeof state.targetPriceOverride === 'number') {
        state.dom.priceOriginal.textContent = TPS.format.formatMoney(state.quote.price, state.quote.currency);
        state.dom.priceOriginal.hidden = false;
      } else {
        state.dom.priceOriginal.hidden = true;
      }
    }
    var displayPriceText = TPS.format.formatMoney(
      typeof state.targetPriceOverride === 'number' ? state.targetPriceOverride : state.quote.price,
      state.quote.currency
    );

    if (state.effectiveType === 'rebalance') {
      state.dom.priceEl.textContent = displayPriceText;
      renderRebalanceResult(cardId);
    } else {
      var computed = TPS.sizing.computeAndFormat({
        statedPercent: state.effectiveTargetPercent,
        quote: state.quote,
        fx: state.fx,
        targetPriceOverride: state.targetPriceOverride
      }, settings);
      state.dom.percentEl.textContent = computed.percentText;
      state.dom.priceEl.textContent = displayPriceText;
      state.dom.sharesEl.textContent = computed.sharesText;
      state.dom.totalPositionEl.textContent = TPS.format.formatMoney(computed.result.totalPositionCurrency, state.quote.currency);
      state.dom.totalAccountEl.textContent = computed.totalAccountText;
    }

    var badgeText = TPS.format.describeSourceBadge(state.quote, state.fx);

    if (!settings.accountBalance) {
      setMeta(cardId, 'hint', 'Задайте наличност по сметка в плаващия панел вдясно.');
    } else if (badgeText) {
      setMeta(cardId, 'badge', badgeText);
    } else {
      setMeta(cardId, null, '');
    }
  }

  // Recomputes just the rebalance trade rows (target shares / action / trade
  // value) — called both after a fresh quote load and on every "current
  // shares" keystroke, which never needs a new quote.
  function renderRebalanceResult(cardId) {
    var state = cardStates.get(cardId);
    if (!state || !state.dom || !state.quote || !state.fx) return;

    TPS.storage.getSettings().then(function (settings) {
      var weightedTargetPercent = TPS.sizing.applyStrategyWeight(state.effectiveTargetPercent, settings.strategyWeightPercent);
      var trade = TPS.sizing.computeRebalanceTrade({
        accountBalance: settings.accountBalance,
        targetPercent: weightedTargetPercent,
        currentShares: isFinite(state.currentShares) ? state.currentShares : 0,
        priceInPositionCurrency: state.quote.price,
        fxRate: state.fx.rate,
        roundingMode: settings.roundingMode,
        roundUpThresholdAmount: settings.roundUpThresholdAmount,
        targetPriceOverride: state.targetPriceOverride
      });

      if (state.dom.targetPercentEl) state.dom.targetPercentEl.textContent = TPS.format.formatPercent(weightedTargetPercent);
      state.dom.targetSharesEl.textContent = TPS.format.formatShares(trade.targetShares, settings.roundingMode);

      var tradeValue = Math.abs(trade.deltaShares) * trade.priceInAccountCurrency;

      state.dom.actionEl.classList.remove('tps-action-buy', 'tps-action-sell', 'tps-action-hold');
      if (trade.action === 'buy') {
        state.dom.actionEl.textContent = 'Купи ' + TPS.format.formatShares(trade.deltaShares, settings.roundingMode) + ' акции';
        state.dom.actionEl.classList.add('tps-action-buy');
      } else if (trade.action === 'sell') {
        state.dom.actionEl.textContent = 'Продай ' + TPS.format.formatShares(Math.abs(trade.deltaShares), settings.roundingMode) + ' акции';
        state.dom.actionEl.classList.add('tps-action-sell');
      } else {
        state.dom.actionEl.textContent = 'Без промяна';
        state.dom.actionEl.classList.add('tps-action-hold');
      }
      state.dom.tradeValueEl.textContent = TPS.format.formatMoney(tradeValue, settings.accountCurrency);
    });
  }

  function renderCardError(cardId, message) {
    setMeta(cardId, 'error', 'Грешка: ' + message);
  }

  // ---------- settings / positions reactivity ----------

  function handleSettingsChanged(newSettings, oldSettings) {
    var currencyChanged = newSettings.accountCurrency !== oldSettings.accountCurrency;
    var weightChanged = newSettings.strategyWeightPercent !== oldSettings.strategyWeightPercent;

    cardStates.forEach(function (state, cardId) {
      // The static "Позиция %"/"Целеви %" value must reflect the new strategy
      // weight even for cards still loading/errored (not just 'ready' ones) —
      // it doesn't depend on a loaded quote, unlike the rest of a rebalance
      // card's computed rows (target shares/action/trade value).
      if (weightChanged && state.effectiveType === 'open') {
        var percentEl = state.dom && state.dom.percentEl;
        if (percentEl) {
          percentEl.textContent = TPS.format.formatPercent(
            TPS.sizing.applyStrategyWeight(state.effectiveTargetPercent, newSettings.strategyWeightPercent)
          );
        }
      }
      if (weightChanged && state.effectiveType === 'rebalance') {
        var targetPercentEl = state.dom && state.dom.targetPercentEl;
        if (targetPercentEl) {
          targetPercentEl.textContent = TPS.format.formatPercent(
            TPS.sizing.applyStrategyWeight(state.effectiveTargetPercent, newSettings.strategyWeightPercent)
          );
        }
      }
      if (state.effectiveType === 'rebalance' && state.status === 'ready') {
        renderRebalanceResult(cardId);
      }
      if (state.status !== 'ready') return;
      if (currencyChanged) {
        loadFxOnly(cardId);
      } else {
        renderCardResult(cardId, newSettings);
      }
    });
  }

  // A holdings edit on one card (or the Options page, once/if that's ever
  // added) must be reflected on every other visible card for the same ticker —
  // matched by tickerKey, not cardId, since holdings are per-ticker state.
  function handlePositionsChanged(newPositions) {
    cardStates.forEach(function (state, cardId) {
      var newShares = newPositions.holdings[state.tickerKey];
      if (isFinite(newShares) && newShares !== state.currentShares) {
        state.currentShares = newShares;
        if (state.dom && state.dom.currentSharesInput && document.activeElement !== state.dom.currentSharesInput) {
          state.dom.currentSharesInput.value = newShares;
        }
        if (state.effectiveType === 'rebalance' && state.status === 'ready') {
          renderRebalanceResult(cardId);
        }
      }

      // All cards share one 'tpsPositions' storage key, so ANY card's write
      // fires onChanged for EVERY card. If this card has its own ticker/price/
      // classification edit applied locally but not yet confirmed written
      // (debounced, or the write itself still in flight), the freshly-read
      // blob here doesn't include it yet — treating that as "changed
      // remotely" would silently revert the user's pending edit. Skip this
      // card until its own write resolves; that resolution's own onChanged
      // firing will correctly see storage caught up with memory.
      if (state.dirtyOverride.ticker || state.dirtyOverride.price || state.dirtyOverride.classification) {
        return;
      }

      var newOverride = newPositions.signalOverrides[state.signalKey] || null;
      var overrideChanged = JSON.stringify(newOverride) !== JSON.stringify(state.override);
      if (overrideChanged) {
        var newTickerOverride = (newOverride && newOverride.tickerOverride) || null;
        var tickerChangedRemotely = newTickerOverride !== state.tickerOverride;

        state.override = newOverride;
        state.tickerOverride = newTickerOverride;
        state.targetPriceOverride = (newOverride && typeof newOverride.targetPrice === 'number') ? newOverride.targetPrice : null;
        state.effectiveTickerAliases = state.tickerOverride
          ? TPS.classify.parseTickerAliases(state.tickerOverride)
          : state.tickerAliases;

        if (tickerChangedRemotely) {
          // The already-loaded quote/fx (if any) were fetched under the old
          // ticker — renderForType's "quote/fx already loaded, just re-render"
          // shortcut must not reuse them for the newly-corrected symbol.
          state.quote = null;
          state.fx = null;
          state.status = 'loading';
        }

        TPS.storage.getSettings().then(function (settings) {
          renderForType(cardId, settings);
        });
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
          tickerAliases: state.effectiveTickerAliases,
          instrument: state.instrument,
          exchange: state.exchange,
          date: state.date,
          signalType: state.effectiveType,
          targetPercent: state.effectiveTargetPercent,
          currentShares: state.currentShares,
          targetPriceOverride: state.targetPriceOverride
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
