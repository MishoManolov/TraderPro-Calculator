# Publishing checklist — Chrome Web Store

Reference material for the Developer Dashboard submission. This is copy-paste text and a packaging command, not app code — nothing here is loaded by the extension itself.

## Store listing

**Short description** (132 char limit):
```
Live position sizing for TraderPRO buy/rebalance signals: price, shares, cost, currency conversion, and inline corrections.
```

**Detailed description** (include the trademark disclaimer verbatim — this mirrors README.md):
```
TraderPro Calculator adds live position-sizing math directly onto TraderPRO's buy and rebalance-to-% signals:
current price, the position-size % being used, the resulting share count, and the total cost — in both the
stock's own currency and your account currency.

For every buy or rebalance signal, the extension appends a few fields below the site's own fields, styled to
match the page. If a signal's ticker is malformed or its price should come from a manually-entered target
instead of the live quote, a small pencil icon next to each field lets you correct it right there — the
correction applies only to that one signal and is remembered across reloads. A floating panel on the page (dock
to the right edge, minimize any time) is where you set your account balance and an optional global strategy-
weight multiplier. Sell/close-position signals are left untouched.

Prices come from Yahoo Finance's public chart endpoint (falling back to Stooq), currency conversion from Yahoo's
FX pseudo-tickers (falling back to Frankfurter.app) — all free, keyless, public data sources. Nothing is sent to
any server the developer controls, because there isn't one; your balance, settings, and per-signal corrections
stay in your own browser (chrome.storage.sync).

Not affiliated with, endorsed by, or sponsored by TraderPRO. Not financial advice — always double-check the
numbers before placing a trade.
```

**Category suggestion:** Productivity (or Tools, depending on what's available at submission time).

**Screenshots:** ready-made 1280×800 PNGs for the listing's screenshot slots are in `store-assets/screenshots/`
(generated from a sanitized saved copy of a real signals page — no real account name/data). Upload them in this
order for a natural progression: `01-position-sizing.png` (core feature — sizing on a buy card), then
`02-ticker-price-override.png` (the ticker/target-price correction feature), then `03-floating-widget.png`
(where balance/strategy weight are configured). This folder is dev-only reference material, same as `CLAUDE.md`
— see "Packaging the release zip" below, it's excluded from the uploaded package.

## Privacy practices tab

- **Does this item collect or transmit personal or sensitive user data?** No.
- **Data collection disclosure:** This extension collects nothing and has no backend server. `chrome.storage.sync`
  is used only to store the user's own account balance, currency, rounding preference, strategy-weight
  multiplier, and per-signal ticker/target-price/classification corrections locally (synced by Chrome across the
  user's own signed-in browsers) — never transmitted anywhere by this extension. See the "Privacy / security"
  section of the README for the full explanation.
- **Privacy policy URL:**
  ```
  https://github.com/MishoManolov/TraderPro-Calculator#privacy--security
  ```
  (If that anchor ever stops resolving after a README edit, the plain repo URL — `https://github.com/MishoManolov/TraderPro-Calculator` — also works; the Privacy / security section is near the bottom of the rendered README.)

## Permission justifications

Paste one of these into the corresponding field for each permission the dashboard asks about.

| Permission | Justification |
|---|---|
| `storage` | Stores the user's account balance, currency, rounding preference, strategy-weight multiplier, and per-signal ticker/target-price/classification corrections locally via `chrome.storage.sync`, so their settings follow them across their own signed-in Chrome instances. No data leaves the browser. |
| `scripting` | Used only as a fallback: if the toolbar popup can't reach an already-loaded content script on the active TraderPRO tab (e.g. right after installing, before the tab is reloaded), it re-injects the content script via `chrome.scripting.executeScript` so the popup still works immediately. |
| `host_permissions: https://*.traderpro.bg/*` | The extension's content script runs here to read buy and rebalance-to-% signal cards on the page and append position-sizing fields next to them. This is the extension's core function. |
| `host_permissions: https://query1.finance.yahoo.com/*`, `https://query2.finance.yahoo.com/*` | Fetches live share prices and FX rates from Yahoo Finance's public chart endpoint (no API key) to compute position sizes. |
| `host_permissions: https://stooq.com/*` | Fallback price source used only if Yahoo Finance is unreachable. |
| `host_permissions: https://api.frankfurter.app/*` | Fallback FX-rate source (free ECB reference rates) used only if Yahoo's FX data is unreachable. |

**Single purpose description:** Adds live position-sizing calculations (price, share count, total cost, or a buy/sell/hold rebalance trade) to buy and rebalance signals on the TraderPRO trading-signals website, based on a user-entered account balance.

## Packaging the release zip

The repo working directory has dev-only files (`.git/`, `.claude/`, `CLAUDE.md`, `README.md`, `PUBLISHING.md`,
`store-assets/`, and gitignored local copies of TraderPRO pages used for design reference/screenshots) that must
**not** go into the uploaded package. Build the zip from a clean file list instead of zipping the whole folder:

```bash
cd TraderPro-Calculator
zip -r ../traderpro-calculator-v$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])").zip \
  manifest.json background content help icons options popup shared \
  -x "*.DS_Store" -x "icons/*-source.svg"
```

This produces a zip one directory above the repo containing only the six runtime folders + `manifest.json` — verify
with `unzip -l` before uploading that no dev files snuck in (in particular, `icons/icon-source.svg` is a design
reference, not used by `manifest.json`'s icon declarations — the `-x` above excludes it).

## Post-approval follow-up

Once the listing is live, update `README.md`'s "Installation" heading and steps 1–7 — they currently describe
**unpacked-only** installation ("not yet on the Chrome Web Store"); add a "install from the Chrome Web Store" path
once there's a real listing URL to link.
