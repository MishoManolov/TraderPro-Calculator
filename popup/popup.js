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
    balanceSummary: document.getElementById('balanceSummary'),
    emptyState: document.getElementById('emptyState'),
    signalsList: document.getElementById('signalsList'),
    openOptionsBtn: document.getElementById('openOptionsBtn')
  };

  els.openOptionsBtn.addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

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
    var initialPercent = settings.positionSizingMode === 'fixed'
      ? settings.fixedPercent
      : (typeof signal.currentPercent === 'number' ? signal.currentPercent : signal.statedPercent);

    li.innerHTML =
      '<div class="tps-signal-title"><span class="tps-signal-ticker">' + escapeHtml(signal.ticker) + '</span>' +
        '<span>' + escapeHtml(signal.instrument || '') + '</span></div>' +
      '<div class="tps-row"><span class="tps-label">Цена / бр.</span><span class="tps-value tps-price-value">…</span></div>' +
      '<div class="tps-row"><span class="tps-label">Позиция %</span>' +
        '<input class="tps-percent-input" type="number" min="0" max="100" step="0.1" value="' + initialPercent + '"></div>' +
      '<div class="tps-row"><span class="tps-label">Брой акции</span><span class="tps-value tps-shares-value">—</span></div>' +
      '<div class="tps-row"><span class="tps-label">Сума (моята валута)</span><span class="tps-value tps-total-account-value">—</span></div>' +
      '<div class="tps-source-badge" hidden></div>' +
      '<div class="tps-error-message" hidden></div>';

    li.dataset.percent = String(initialPercent);
    return li;
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function loadAndRenderSignal(item, signal, settings) {
    var state = { quote: null, fx: null };

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
      bindPercentInput(item, state, settings);
    }).catch(function (err) {
      var errorEl = item.querySelector('.tps-error-message');
      errorEl.textContent = 'Грешка: ' + String((err && err.message) || err);
      errorEl.hidden = false;
    });
  }

  function bindPercentInput(item, state, settings) {
    var input = item.querySelector('.tps-percent-input');
    var timer = null;
    input.addEventListener('input', function () {
      var value = parseFloat(input.value);
      if (!isFinite(value)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        item.dataset.percent = String(value);
        renderResult(item, state, settings);
      }, 150);
    });
  }

  function renderResult(item, state, settings) {
    if (!state.quote || !state.fx) return;
    var percent = parseFloat(item.dataset.percent) || 0;
    var result = TPS.sizing.computePositionSize({
      accountBalance: settings.accountBalance,
      percent: percent,
      priceInPositionCurrency: state.quote.price,
      fxRate: state.fx.rate,
      roundingMode: settings.roundingMode,
      roundUpThresholdAmount: settings.roundUpThresholdAmount
    });

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
      els.balanceSummary.textContent = TPS.format.formatMoney(settings.accountBalance, settings.accountCurrency) + ' наличност';

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
