// options/options.js
(function () {
  var els = {
    accountCurrency: document.getElementById('accountCurrency'),
    roundUpThresholdAmount: document.getElementById('roundUpThresholdAmount'),
    thresholdRow: document.getElementById('thresholdRow'),
    saveStatus: document.getElementById('saveStatus')
  };

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
    els.thresholdRow.hidden = getRadioValue(roundingRadios) !== 'roundUpThreshold';
  }

  function populateForm(settings) {
    isPopulating = true;
    els.accountCurrency.value = settings.accountCurrency;
    setRadioValue(roundingRadios, settings.roundingMode);
    els.roundUpThresholdAmount.value = settings.roundUpThresholdAmount;
    updateConditionalVisibility();
    isPopulating = false;
  }

  // Deliberately omits accountBalance — it's edited only in the popup now (see
  // popup/popup.js). TPS.storage.setSettings() merges partial updates onto the
  // existing stored settings, so leaving it out here preserves whatever the
  // popup last saved instead of resetting it.
  function readFormAsPartialSettings() {
    return {
      accountCurrency: els.accountCurrency.value,
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
    var inputs = [els.accountCurrency, els.roundUpThresholdAmount];
    inputs.forEach(function (el) {
      el.addEventListener('input', scheduleSave);
      el.addEventListener('change', scheduleSave);
    });
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
