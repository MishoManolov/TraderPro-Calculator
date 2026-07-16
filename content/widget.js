// content/widget.js — floating, always-visible balance / position-%-override panel
//
// Docked to the right edge of the viewport so both settings are visible and
// editable without opening the toolbar popup — see CLAUDE.md "Floating on-page
// widget" for why this replaced the old popup-only inputs. Runs in the same
// page context as content.js; a storage write here is picked up by content.js's
// own TPS.storage.onSettingsChanged listener (already wired up there) to
// recompute every card, so this file never touches card DOM directly.
(function () {
  var WIDGET_ID = 'tps-widget';
  var els = null;
  var saveTimers = { balance: null, percent: null };
  var indicatorTimers = { balance: null, percent: null };

  function buildWidget(settings) {
    var root = document.createElement('div');
    root.id = WIDGET_ID;
    root.className = 'tps-widget';
    if (settings.widgetMinimized) root.classList.add('is-collapsed');

    root.innerHTML =
      '<button type="button" class="tps-widget-tab" aria-label="Разгъни TraderPro Calculator" aria-expanded="false">' +
        '<span aria-hidden="true">$</span>' +
      '</button>' +
      '<div class="tps-widget-panel">' +
        '<div class="tps-widget-header">' +
          '<span class="tps-widget-title">TraderPro Calculator</span>' +
          '<button type="button" class="tps-widget-minimize" aria-label="Минимизирай панела" title="Минимизирай">–</button>' +
        '</div>' +
        '<div class="tps-widget-body">' +
          '<div class="tps-widget-row">' +
            '<label for="tpsWidgetBalanceInput" class="tps-widget-label">Наличност</label>' +
            '<div class="tps-widget-input-wrap">' +
              '<span id="tpsWidgetCurrencyPrefix" class="tps-widget-prefix"></span>' +
              '<input id="tpsWidgetBalanceInput" class="tps-widget-input" type="number" min="0" step="0.01" inputmode="decimal">' +
            '</div>' +
            '<span id="tpsWidgetBalanceSaved" class="tps-widget-saved" hidden>✓</span>' +
          '</div>' +
          '<div class="tps-widget-row" title="Празно = използва се % от сигнала на TraderPRO за всяка позиция. Число тук = използва се за всички позиции вместо това.">' +
            '<label for="tpsWidgetPercentInput" class="tps-widget-label">Позиция %</label>' +
            '<div class="tps-widget-input-wrap">' +
              '<input id="tpsWidgetPercentInput" class="tps-widget-input" type="number" min="0" max="100" step="0.1" placeholder="от сигнала">' +
              '<span class="tps-widget-suffix">%</span>' +
            '</div>' +
            '<span id="tpsWidgetPercentSaved" class="tps-widget-saved" hidden>✓</span>' +
          '</div>' +
        '</div>' +
      '</div>';

    return root;
  }

  function cacheEls(root) {
    return {
      root: root,
      tab: root.querySelector('.tps-widget-tab'),
      minimizeBtn: root.querySelector('.tps-widget-minimize'),
      currencyPrefix: root.querySelector('#tpsWidgetCurrencyPrefix'),
      balanceInput: root.querySelector('#tpsWidgetBalanceInput'),
      balanceSaved: root.querySelector('#tpsWidgetBalanceSaved'),
      percentInput: root.querySelector('#tpsWidgetPercentInput'),
      percentSaved: root.querySelector('#tpsWidgetPercentSaved')
    };
  }

  function flashSaved(el, key) {
    el.hidden = false;
    if (indicatorTimers[key]) clearTimeout(indicatorTimers[key]);
    indicatorTimers[key] = setTimeout(function () {
      el.hidden = true;
    }, 1200);
  }

  function bindBalanceInput(settings) {
    els.currencyPrefix.textContent = TPS.format.currencySymbol(settings.accountCurrency);
    els.balanceInput.value = settings.accountBalance;

    els.balanceInput.addEventListener('input', function () {
      var value = parseFloat(els.balanceInput.value);
      if (!isFinite(value) || value < 0) return;
      if (saveTimers.balance) clearTimeout(saveTimers.balance);
      saveTimers.balance = setTimeout(function () {
        TPS.storage.setSettings({ accountBalance: value }).then(function () {
          flashSaved(els.balanceSaved, 'balance');
        });
      }, 300);
    });
  }

  // The one global position-size override, applied to every signal — see
  // TPS.sizing.resolveEffectivePercent(). Left empty, each signal uses its own
  // TraderPRO-stated %; a number here overrides all of them uniformly. No
  // per-signal override exists (deliberately removed, see CLAUDE.md).
  function bindPercentInput(settings) {
    if (settings.positionPercentOverride !== null && settings.positionPercentOverride !== undefined) {
      els.percentInput.value = settings.positionPercentOverride;
    }

    els.percentInput.addEventListener('input', function () {
      var raw = els.percentInput.value.trim();
      if (saveTimers.percent) clearTimeout(saveTimers.percent);
      saveTimers.percent = setTimeout(function () {
        var value = raw === '' ? null : parseFloat(raw);
        if (value !== null && !isFinite(value)) return;
        TPS.storage.setSettings({ positionPercentOverride: value }).then(function () {
          flashSaved(els.percentSaved, 'percent');
        });
      }, 300);
    });
  }

  function setCollapsed(collapsed) {
    els.root.classList.toggle('is-collapsed', collapsed);
    els.tab.setAttribute('aria-expanded', String(!collapsed));
  }

  function bindMinimize() {
    els.minimizeBtn.addEventListener('click', function () {
      setCollapsed(true);
      TPS.storage.setSettings({ widgetMinimized: true });
    });
    els.tab.addEventListener('click', function () {
      setCollapsed(false);
      TPS.storage.setSettings({ widgetMinimized: false });
    });
  }

  // Reflect changes made elsewhere (Options page currency, chrome.storage.sync
  // pulling in a value from another of the user's signed-in Chrome instances,
  // or this same widget's own writes echoing back) without clobbering an input
  // the user is actively typing into.
  function bindExternalUpdates() {
    TPS.storage.onSettingsChanged(function (newSettings) {
      els.currencyPrefix.textContent = TPS.format.currencySymbol(newSettings.accountCurrency);

      if (document.activeElement !== els.balanceInput) {
        els.balanceInput.value = newSettings.accountBalance;
      }
      if (document.activeElement !== els.percentInput) {
        els.percentInput.value = (newSettings.positionPercentOverride === null || newSettings.positionPercentOverride === undefined)
          ? ''
          : newSettings.positionPercentOverride;
      }
      setCollapsed(!!newSettings.widgetMinimized);
    });
  }

  function init() {
    if (document.getElementById(WIDGET_ID)) return; // already injected (e.g. popup's re-injection fallback)

    TPS.storage.getSettings().then(function (settings) {
      var root = buildWidget(settings);
      document.body.appendChild(root);
      els = cacheEls(root);

      bindBalanceInput(settings);
      bindPercentInput(settings);
      bindMinimize();
      bindExternalUpdates();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
