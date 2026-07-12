// popup/popup.js
(function () {
  var CONTENT_SCRIPT_FILES = [
    'shared/storage.js',
    'shared/messaging.js',
    'shared/sizing.js',
    'shared/scrape.js',
    'shared/format.js',
    'content/content.js'
  ];

  var els = {
    accountBalanceInput: document.getElementById('accountBalanceInput'),
    balanceCurrencyPrefix: document.getElementById('balanceCurrencyPrefix'),
    balanceSavedIndicator: document.getElementById('balanceSavedIndicator'),
    positionPercentInput: document.getElementById('positionPercentInput'),
    percentSavedIndicator: document.getElementById('percentSavedIndicator'),
    emptyState: document.getElementById('emptyState'),
    signalsList: document.getElementById('signalsList'),
    openOptionsBtn: document.getElementById('openOptionsBtn')
  };

  var renderedItems = []; // {item, state} for every signal currently rendered, so a balance/% edit can re-render them all

  els.openOptionsBtn.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  function bindBalanceInput(settings) {
    els.balanceCurrencyPrefix.textContent = TPS.format.currencySymbol(settings.accountCurrency);
    els.accountBalanceInput.value = settings.accountBalance;

    var saveTimer = null;
    var indicatorTimer = null;

    els.accountBalanceInput.addEventListener('input', function () {
      var value = parseFloat(els.accountBalanceInput.value);
      if (!isFinite(value) || value < 0) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        settings.accountBalance = value; // shared reference — every closure below sees the update immediately
        TPS.storage.setSettings({ accountBalance: value }).then(function () {
          els.balanceSavedIndicator.hidden = false;
          if (indicatorTimer) clearTimeout(indicatorTimer);
          indicatorTimer = setTimeout(function () {
            els.balanceSavedIndicator.hidden = true;
          }, 1200);
        });
        renderedItems.forEach(function (entry) {
          renderResult(entry.item, entry.state, settings);
        });
      }, 300);
    });

    // Single click to open the popup is enough to start editing — no extra click needed.
    els.accountBalanceInput.focus();
    els.accountBalanceInput.select();
  }

  // The one global position-size override, applied to every signal — see
  // TPS.sizing.resolveEffectivePercent(). Left empty, each signal uses its own
  // TraderPRO-stated %; a number here overrides all of them uniformly. No
  // per-signal override exists anymore (deliberately removed).
  function bindPositionPercentInput(settings) {
    if (settings.positionPercentOverride !== null && settings.positionPercentOverride !== undefined) {
      els.positionPercentInput.value = settings.positionPercentOverride;
    }

    var saveTimer = null;
    var indicatorTimer = null;

    els.positionPercentInput.addEventListener('input', function () {
      var raw = els.positionPercentInput.value.trim();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        var value = raw === '' ? null : parseFloat(raw);
        if (value !== null && !isFinite(value)) return;
        settings.positionPercentOverride = value; // shared reference
        TPS.storage.setSettings({ positionPercentOverride: value }).then(function () {
          els.percentSavedIndicator.hidden = false;
          if (indicatorTimer) clearTimeout(indicatorTimer);
          indicatorTimer = setTimeout(function () {
            els.percentSavedIndicator.hidden = true;
          }, 1200);
        });
        renderedItems.forEach(function (entry) {
          updatePercentDisplay(entry.item, entry.state, settings);
          renderResult(entry.item, entry.state, settings);
        });
      }, 300);
    });
  }

  function getActiveTab() {
    return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      return tabs && tabs[0];
    });
  }

  function getSignals(tabId, settings) {
    return TPS.messaging.requestSignalsFromTab(tabId).catch(function () {
      return chrome.scripting.executeScript({ target: { tabId: tabId }, files: CONTENT_SCRIPT_FILES })
        .then(function () {
          return TPS.messaging.requestSignalsFromTab(tabId);
        });
    });
  }

  function renderEmptyState() {
    els.emptyState.hidden = false;
    els.signalsList.hidden = true;
  }

  function renderSignals(signals, settings) {
    els.emptyState.hidden = true;
    els.signalsList.hidden = false;
    els.signalsList.innerHTML = '';
    renderedItems = [];
    signals.forEach(function (signal) {
      var item = buildSignalItem(signal, settings);
      els.signalsList.appendChild(item);
      loadAndRenderSignal(item, signal, settings);
    });
  }

  function buildSignalItem(signal, settings) {
    var li = document.createElement('li');
    li.className = 'tps-signal-item';
    var effectivePercent = TPS.sizing.resolveEffectivePercent(signal.statedPercent, settings.positionPercentOverride);

    li.innerHTML =
      '<div class="tps-signal-title"><span class="tps-signal-ticker">' + escapeHtml(signal.ticker) + '</span>' +
        '<span>' + escapeHtml(signal.instrument || '') + '</span></div>' +
      '<div class="tps-row"><span class="tps-label">Цена / бр.</span><span class="tps-value tps-price-value">…</span></div>' +
      '<div class="tps-row"><span class="tps-label">Позиция %</span><span class="tps-value tps-percent-value">' + TPS.format.formatPercent(effectivePercent) + '</span></div>' +
      '<div class="tps-row"><span class="tps-label">Брой акции</span><span class="tps-value tps-shares-value">—</span></div>' +
      '<div class="tps-row"><span class="tps-label">Сума (моята валута)</span><span class="tps-value tps-total-account-value">—</span></div>' +
      '<div class="tps-source-badge" hidden></div>' +
      '<div class="tps-error-message" hidden></div>';

    return li;
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function updatePercentDisplay(item, state, settings) {
    var el = item.querySelector('.tps-percent-value');
    if (!el) return;
    el.textContent = TPS.format.formatPercent(TPS.sizing.resolveEffectivePercent(state.statedPercent, settings.positionPercentOverride));
  }

  function loadAndRenderSignal(item, signal, settings) {
    var state = { quote: null, fx: null, statedPercent: signal.statedPercent };
    renderedItems.push({ item: item, state: state });

    TPS.messaging.requestQuote(signal.ticker).then(function (quoteResponse) {
      if (!quoteResponse || !quoteResponse.ok) throw new Error((quoteResponse && quoteResponse.error) || 'Грешка при цена');
      state.quote = quoteResponse.data;
      if (state.quote.currency === settings.accountCurrency) return { rate: 1, source: 'identity' };
      return TPS.messaging.requestFxRate(state.quote.currency, settings.accountCurrency).then(function (fxResponse) {
        if (!fxResponse || !fxResponse.ok) throw new Error((fxResponse && fxResponse.error) || 'Грешка при валутен курс');
        return fxResponse.data;
      });
    }).then(function (fx) {
      state.fx = fx;
      renderResult(item, state, settings);
    }).catch(function (err) {
      var errorEl = item.querySelector('.tps-error-message');
      errorEl.textContent = 'Грешка: ' + String((err && err.message) || err);
      errorEl.hidden = false;
    });
  }

  function renderResult(item, state, settings) {
    if (!state.quote || !state.fx) return;
    var effectivePercent = TPS.sizing.resolveEffectivePercent(state.statedPercent, settings.positionPercentOverride);
    var result = TPS.sizing.computePositionSize({
      accountBalance: settings.accountBalance,
      percent: effectivePercent,
      priceInPositionCurrency: state.quote.price,
      fxRate: state.fx.rate,
      roundingMode: settings.roundingMode,
      roundUpThresholdAmount: settings.roundUpThresholdAmount
    });

    item.querySelector('.tps-percent-value').textContent = TPS.format.formatPercent(effectivePercent);
    item.querySelector('.tps-price-value').textContent = TPS.format.formatMoney(state.quote.price, state.quote.currency);
    item.querySelector('.tps-shares-value').textContent = TPS.format.formatShares(result.shares, settings.roundingMode);
    item.querySelector('.tps-total-account-value').textContent = TPS.format.formatMoney(result.totalAccountCurrency, settings.accountCurrency);

    var badgeEl = item.querySelector('.tps-source-badge');
    var badgeParts = [];
    if (state.quote.source !== 'yahoo') badgeParts.push('цена: ' + state.quote.source + ' (прибл.)');
    if (state.fx.source && state.fx.source !== 'yahoo' && state.fx.source !== 'identity') badgeParts.push('курс: ' + state.fx.source);
    badgeEl.textContent = badgeParts.join(' · ');
    badgeEl.hidden = badgeParts.length === 0;
  }

  function init() {
    TPS.storage.getSettings().then(function (settings) {
      bindBalanceInput(settings);
      bindPositionPercentInput(settings);

      getActiveTab().then(function (tab) {
        if (!tab || !tab.id) {
          renderEmptyState();
          return;
        }
        getSignals(tab.id, settings).then(function (response) {
          var signals = response && response.ok ? response.data : [];
          if (!signals || !signals.length) {
            renderEmptyState();
            return;
          }
          renderSignals(signals, settings);
        }).catch(function () {
          renderEmptyState();
        });
      });
    });
  }

  init();
})();
