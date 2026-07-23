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
  var saveTimers = { balance: null, weight: null };
  var indicatorTimers = { balance: null, weight: null };

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
              '<input id="tpsWidgetBalanceInput" class="tps-widget-input" type="text" inputmode="decimal" autocomplete="off">' +
            '</div>' +
            '<span id="tpsWidgetBalanceSaved" class="tps-widget-saved" hidden>✓</span>' +
          '</div>' +
          '<div class="tps-widget-row" title="Умножава % на всеки сигнал — за отваряне на позиция или за ребаланс до % (сигнал % × тегло). Празно = 100% (без промяна).">' +
            '<label for="tpsWidgetWeightInput" class="tps-widget-label">Тегло на стратегия %</label>' +
            '<div class="tps-widget-input-wrap">' +
              '<input id="tpsWidgetWeightInput" class="tps-widget-input" type="number" min="0" step="0.1" placeholder="100">' +
              '<span class="tps-widget-suffix">%</span>' +
            '</div>' +
            '<span id="tpsWidgetWeightSaved" class="tps-widget-saved" hidden>✓</span>' +
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
      weightInput: root.querySelector('#tpsWidgetWeightInput'),
      weightSaved: root.querySelector('#tpsWidgetWeightSaved')
    };
  }

  function flashSaved(el, key) {
    el.hidden = false;
    if (indicatorTimers[key]) clearTimeout(indicatorTimers[key]);
    indicatorTimers[key] = setTimeout(function () {
      el.hidden = true;
    }, 1200);
  }

  // Balance is a plain text input (not type="number") so it can display
  // thousands separators while typing. Only digits and a single "." are ever
  // kept; commas are re-inserted into the integer part on every keystroke,
  // with the cursor restored by its distance from the end of the string so
  // typing/deleting mid-number doesn't jump the caret.
  function formatBalanceInput(value) {
    var str = String(value);
    if (str === '') return '';
    var parts = str.split('.');
    var intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.length > 1 ? intPart + '.' + parts[1] : intPart;
  }

  function bindBalanceInput(settings) {
    els.currencyPrefix.textContent = TPS.format.currencySymbol(settings.accountCurrency);
    els.balanceInput.value = formatBalanceInput(settings.accountBalance);

    els.balanceInput.addEventListener('input', function () {
      var cursorFromEnd = els.balanceInput.value.length - els.balanceInput.selectionStart;
      var raw = els.balanceInput.value.replace(/[^\d.]/g, '');
      var firstDot = raw.indexOf('.');
      if (firstDot !== -1) raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, '');

      var formatted = formatBalanceInput(raw);
      els.balanceInput.value = formatted;
      var pos = Math.max(0, formatted.length - cursorFromEnd);
      els.balanceInput.setSelectionRange(pos, pos);

      var value = parseFloat(raw);
      if (!isFinite(value) || value < 0) return;
      if (saveTimers.balance) clearTimeout(saveTimers.balance);
      saveTimers.balance = setTimeout(function () {
        TPS.storage.setSettings({ accountBalance: value }).then(function () {
          flashSaved(els.balanceSaved, 'balance');
        });
      }, 300);
    });
  }

  // The one global strategy-weight multiplier, applied to every signal's own
  // target % — open/buy and rebalance-to-% alike — see
  // TPS.sizing.applyStrategyWeight(). Left empty, treated as 100 (no scaling —
  // each signal is sized at its own TraderPRO-stated/target %); a number here
  // multiplies every signal's % by weight/100 instead of replacing it. No
  // per-signal weight exists (deliberately removed, see CLAUDE.md).
  function bindWeightInput(settings) {
    if (settings.strategyWeightPercent !== null && settings.strategyWeightPercent !== undefined) {
      els.weightInput.value = settings.strategyWeightPercent;
    }

    els.weightInput.addEventListener('input', function () {
      var raw = els.weightInput.value.trim();
      if (saveTimers.weight) clearTimeout(saveTimers.weight);
      saveTimers.weight = setTimeout(function () {
        var value = raw === '' ? null : parseFloat(raw);
        if (value !== null && (!isFinite(value) || value < 0)) return;
        TPS.storage.setSettings({ strategyWeightPercent: value }).then(function () {
          flashSaved(els.weightSaved, 'weight');
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
        els.balanceInput.value = formatBalanceInput(newSettings.accountBalance);
      }
      if (document.activeElement !== els.weightInput) {
        els.weightInput.value = (newSettings.strategyWeightPercent === null || newSettings.strategyWeightPercent === undefined)
          ? ''
          : newSettings.strategyWeightPercent;
      }
      setCollapsed(!!newSettings.widgetMinimized);
    });
  }

  // Signal (buy/sell strategy) pages are ?go=strategy&p=detail&courseId=...;
  // course pages use go=courses instead — go is the field that distinguishes
  // them, so that's the only thing checked here.
  function isSignalPage() {
    return new URLSearchParams(window.location.search).get('go') === 'strategy';
  }

  function init() {
    if (!isSignalPage()) return;
    if (document.getElementById(WIDGET_ID)) return; // already injected (e.g. popup's re-injection fallback)

    TPS.storage.getSettings().then(function (settings) {
      var root = buildWidget(settings);
      document.body.appendChild(root);
      els = cacheEls(root);

      bindBalanceInput(settings);
      bindWeightInput(settings);
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
