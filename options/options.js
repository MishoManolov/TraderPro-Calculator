// options/options.js
(function () {
  var els = {
    accountBalance: document.getElementById('accountBalance'),
    accountCurrency: document.getElementById('accountCurrency'),
    fixedPercent: document.getElementById('fixedPercent'),
    fixedPercentRow: document.getElementById('fixedPercentRow'),
    roundUpThresholdAmount: document.getElementById('roundUpThresholdAmount'),
    thresholdRow: document.getElementById('thresholdRow'),
    saveStatus: document.getElementById('saveStatus')
  };

  var positionSizingRadios = document.querySelectorAll('input[name="positionSizingMode"]');
  var roundingRadios = document.querySelectorAll('input[name="roundingMode"]');

  var saveTimer = null;
  var saveStatusTimer = null;
  var isPopulating = false;

  function populateCurrencyOptions() {
    var currencies = TPS.storage.SUPPORTED_CURRENCIES;
    els.accountCurrency.innerHTML = '';
    currencies.forEach(function (code) {
      var opt = document.createElement('option');
      opt.value = code;
      opt.textContent = code;
      els.accountCurrency.appendChild(opt);
    });
  }

  function getRadioValue(radios) {
    for (var i = 0; i < radios.length; i++) {
      if (radios[i].checked) return radios[i].value;
    }
    return null;
  }

  function setRadioValue(radios, value) {
    for (var i = 0; i < radios.length; i++) {
      radios[i].checked = radios[i].value === value;
    }
  }

  function updateConditionalVisibility() {
    els.fixedPercentRow.hidden = getRadioValue(positionSizingRadios) !== 'fixed';
    els.thresholdRow.hidden = getRadioValue(roundingRadios) !== 'roundUpThreshold';
  }

  function populateForm(settings) {
    isPopulating = true;
    els.accountBalance.value = settings.accountBalance;
    els.accountCurrency.value = settings.accountCurrency;
    setRadioValue(positionSizingRadios, settings.positionSizingMode);
    els.fixedPercent.value = settings.fixedPercent;
    setRadioValue(roundingRadios, settings.roundingMode);
    els.roundUpThresholdAmount.value = settings.roundUpThresholdAmount;
    updateConditionalVisibility();
    isPopulating = false;
  }

  function readFormAsPartialSettings() {
    return {
      accountBalance: parseFloat(els.accountBalance.value) || 0,
      accountCurrency: els.accountCurrency.value,
      positionSizingMode: getRadioValue(positionSizingRadios) || 'signal',
      fixedPercent: parseFloat(els.fixedPercent.value) || 0,
      roundingMode: getRadioValue(roundingRadios) || 'roundDown',
      roundUpThresholdAmount: parseFloat(els.roundUpThresholdAmount.value) || 0
    };
  }

  function showSavedToast() {
    els.saveStatus.hidden = false;
    if (saveStatusTimer) clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(function () {
      els.saveStatus.hidden = true;
    }, 1500);
  }

  function scheduleSave() {
    if (isPopulating) return;
    updateConditionalVisibility();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      TPS.storage.setSettings(readFormAsPartialSettings()).then(showSavedToast);
    }, 300);
  }

  function bindFormListeners() {
    var inputs = [els.accountBalance, els.accountCurrency, els.fixedPercent, els.roundUpThresholdAmount];
    inputs.forEach(function (el) {
      el.addEventListener('input', scheduleSave);
      el.addEventListener('change', scheduleSave);
    });
    positionSizingRadios.forEach(function (el) { el.addEventListener('change', scheduleSave); });
    roundingRadios.forEach(function (el) { el.addEventListener('change', scheduleSave); });
  }

  function init() {
    populateCurrencyOptions();
    TPS.storage.getSettings().then(function (settings) {
      populateForm(settings);
      bindFormListeners();
    });
  }

  init();
})();
