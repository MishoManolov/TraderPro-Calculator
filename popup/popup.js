// popup/popup.js
(function () {
  var CONTENT_SCRIPT_FILES = [
    'shared/storage.js',
    'shared/messaging.js',
    'shared/classify.js',
    'shared/positions.js',
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

  // accountBalance and strategyWeightPercent are edited exclusively in the
  // floating widget injected onto the TraderPRO page (content/widget.js) — the
  // popup only shows a read-only summary of their current values.
  function renderSettingsSummary(settings) {
    var balanceText = TPS.format.formatMoney(settings.accountBalance, settings.accountCurrency);
    var weightText = (settings.strategyWeightPercent !== null && settings.strategyWeightPercent !== undefined)
      ? TPS.format.formatPercent(settings.strategyWeightPercent)
      : '100% (по подразбиране)';
    els.settingsSummary.textContent = 'Наличност: ' + balanceText + ' · Тегло на стратегия: ' + weightText;
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

  // Signal type/target % are read-only here regardless of type — editing
  // (accountBalance/strategyWeightPercent in the widget, current shares held
  // on rebalance cards, fallback classification for 'unknown' signals) only
  // ever happens on the TraderPRO page itself, never in this popup. See
  // CLAUDE.md "Floating on-page widget" for why that split exists.
  function buildSignalItem(signal, settings) {
    var li = document.createElement('li');
    li.className = 'tps-signal-item';

    var titleHtml = '<div class="tps-signal-title"><span class="tps-signal-ticker">' + escapeHtml(signal.ticker) + '</span>' +
      '<span>' + escapeHtml(signal.instrument || '') + '</span></div>';

    if (signal.signalType === 'close') {
      li.innerHTML = titleHtml +
        '<div class="tps-row"><span class="tps-label">Тип</span><span class="tps-value">Затваря позиция</span></div>';
      return li;
    }

    if (signal.signalType === 'unknown') {
      li.innerHTML = titleHtml +
        '<div class="tps-row"><span class="tps-label">Тип</span><span class="tps-value">Некласифициран — виж на страницата</span></div>';
      return li;
    }

    if (signal.signalType === 'rebalance') {
      var weightedTargetPercent = TPS.sizing.applyStrategyWeight(signal.targetPercent, settings.strategyWeightPercent);
      li.innerHTML = titleHtml +
        '<div class="tps-row"><span class="tps-label">Цена / бр.</span><span class="tps-value tps-price-value">…</span></div>' +
        '<div class="tps-row"><span class="tps-label">Целеви %</span><span class="tps-value tps-target-percent-value">' + TPS.format.formatPercent(weightedTargetPercent) + '</span></div>' +
        '<div class="tps-row"><span class="tps-label">Действие</span><span class="tps-value tps-action-value">—</span></div>' +
        '<div class="tps-source-badge" hidden></div>' +
        '<div class="tps-error-message" hidden></div>';
      return li;
    }

    var effectivePercent = TPS.sizing.applyStrategyWeight(signal.targetPercent, settings.strategyWeightPercent);
    li.innerHTML = titleHtml +
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
    if (signal.signalType === 'close' || signal.signalType === 'unknown') return; // nothing to price

    var state = { quote: null, fx: null, statedPercent: signal.targetPercent, targetPriceOverride: signal.targetPriceOverride };
    var aliases = (signal.tickerAliases && signal.tickerAliases.length) ? signal.tickerAliases : [signal.ticker];

    TPS.messaging.requestQuoteForAliasesOrThrow(aliases, 'Грешка при цена').then(function (quote) {
      state.quote = quote;
      return TPS.messaging.resolveFxRate(quote.currency, settings.accountCurrency, 'Грешка при валутен курс');
    }).then(function (fx) {
      state.fx = fx;
      if (signal.signalType === 'rebalance') {
        renderRebalanceResult(item, signal, state, settings);
      } else {
        renderResult(item, state, settings);
      }
    }).catch(function (err) {
      var errorEl = item.querySelector('.tps-error-message');
      errorEl.textContent = 'Грешка: ' + String((err && err.message) || err);
      errorEl.hidden = false;
    });
  }

  function renderResult(item, state, settings) {
    if (!state.quote || !state.fx) return;
    var computed = TPS.sizing.computeAndFormat(state, settings);

    // Show the same effective price the on-page card uses as its main display
    // (target price override if set, else the live quote) rather than
    // computed.priceText (always the live quote) — otherwise the popup's price
    // would silently disagree with the page while its shares/totals (already
    // resolved via TPS.sizing internally) agree.
    var displayPrice = TPS.format.formatMoney(
      TPS.sizing.resolveSizingPrice(state.quote.price, state.targetPriceOverride),
      state.quote.currency
    );

    item.querySelector('.tps-percent-value').textContent = computed.percentText;
    item.querySelector('.tps-price-value').textContent = displayPrice;
    item.querySelector('.tps-shares-value').textContent = computed.sharesText;
    item.querySelector('.tps-total-account-value').textContent = computed.totalAccountText;

    var badgeEl = item.querySelector('.tps-source-badge');
    var badgeText = TPS.format.describeSourceBadge(state.quote, state.fx);
    badgeEl.textContent = badgeText;
    badgeEl.hidden = badgeText.length === 0;
  }

  function renderRebalanceResult(item, signal, state, settings) {
    if (!state.quote || !state.fx) return;
    item.querySelector('.tps-price-value').textContent = TPS.format.formatMoney(
      TPS.sizing.resolveSizingPrice(state.quote.price, state.targetPriceOverride),
      state.quote.currency
    );

    var weightedTargetPercent = TPS.sizing.applyStrategyWeight(signal.targetPercent, settings.strategyWeightPercent);
    var targetPercentEl = item.querySelector('.tps-target-percent-value');
    if (targetPercentEl) targetPercentEl.textContent = TPS.format.formatPercent(weightedTargetPercent);

    var trade = TPS.sizing.computeRebalanceTrade({
      accountBalance: settings.accountBalance,
      targetPercent: weightedTargetPercent,
      currentShares: isFinite(signal.currentShares) ? signal.currentShares : 0,
      priceInPositionCurrency: state.quote.price,
      fxRate: state.fx.rate,
      roundingMode: settings.roundingMode,
      roundUpThresholdAmount: settings.roundUpThresholdAmount,
      targetPriceOverride: signal.targetPriceOverride
    });

    var actionEl = item.querySelector('.tps-action-value');
    if (trade.action === 'buy') {
      actionEl.textContent = 'Купи ' + TPS.format.formatShares(trade.deltaShares, settings.roundingMode) + ' акции';
    } else if (trade.action === 'sell') {
      actionEl.textContent = 'Продай ' + TPS.format.formatShares(Math.abs(trade.deltaShares), settings.roundingMode) + ' акции';
    } else {
      actionEl.textContent = 'Без промяна';
    }

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
