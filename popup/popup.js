// popup/popup.js
(function () {
  var CONTENT_SCRIPT_FILES = [
    'shared/storage.js',
    'shared/messaging.js',
    'shared/sizing.js',
    'shared/scrape.js',
    'shared/format.js',
    'content/content.js',
    'content/widget.js'
  ];

  var els = {
    settingsSummary: document.getElementById('settingsSummary'),
    emptyState: document.getElementById('emptyState'),
    signalsList: document.getElementById('signalsList'),
    openOptionsBtn: document.getElementById('openOptionsBtn')
  };

  els.openOptionsBtn.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  // accountBalance and positionPercentOverride are edited exclusively in the
  // floating widget injected onto the TraderPRO page (content/widget.js) — the
  // popup only shows a read-only summary of their current values.
  function renderSettingsSummary(settings) {
    var balanceText = TPS.format.formatMoney(settings.accountBalance, settings.accountCurrency);
    var percentText = (settings.positionPercentOverride !== null && settings.positionPercentOverride !== undefined)
      ? TPS.format.formatPercent(settings.positionPercentOverride) + ' (ръчно)'
      : 'от сигнала';
    els.settingsSummary.textContent = 'Наличност: ' + balanceText + ' · Позиция %: ' + percentText;
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

  var escapeHtmlScratchDiv = document.createElement('div');

  function escapeHtml(text) {
    escapeHtmlScratchDiv.textContent = text || '';
    return escapeHtmlScratchDiv.innerHTML;
  }

  function loadAndRenderSignal(item, signal, settings) {
    var state = { quote: null, fx: null, statedPercent: signal.statedPercent };

    TPS.messaging.requestQuoteOrThrow(signal.ticker, 'Грешка при цена').then(function (quote) {
      state.quote = quote;
      return TPS.messaging.resolveFxRate(quote.currency, settings.accountCurrency, 'Грешка при валутен курс');
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
    var computed = TPS.sizing.computeAndFormat(state, settings);

    item.querySelector('.tps-percent-value').textContent = computed.percentText;
    item.querySelector('.tps-price-value').textContent = computed.priceText;
    item.querySelector('.tps-shares-value').textContent = computed.sharesText;
    item.querySelector('.tps-total-account-value').textContent = computed.totalAccountText;

    var badgeEl = item.querySelector('.tps-source-badge');
    var badgeText = TPS.format.describeSourceBadge(state.quote, state.fx);
    badgeEl.textContent = badgeText;
    badgeEl.hidden = badgeText.length === 0;
  }

  function init() {
    TPS.storage.getSettings().then(function (settings) {
      renderSettingsSummary(settings);

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
