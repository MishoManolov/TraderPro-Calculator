# TraderPRO Position Sizer

An unofficial Chrome extension (Manifest V3) that adds live position-sizing math directly onto [TraderPRO](https://login.traderpro.bg)'s buy signals: current price, the position-size % being used, the resulting share count, and the total cost — in both the stock's own currency and your account currency.

**Not affiliated with TraderPRO. Not financial advice. Always double-check the numbers before placing a trade.**

## What it does

For every **buy** ("КУПУВА" / open-position) signal card on the TraderPRO signals page, the extension appends a few rows right below the existing ones — separated from them by a single thin divider line — styled like every other field on the card (same fonts/spacing) so they read as a natural part of it rather than a bolted-on box:

- **Позиция %** — a static (non-editable) value showing the position size actually being used for that signal: your global % override if you've set one (see below), otherwise the signal's own stated %. The site's own "Количество" field is never touched — this is a separate, read-only display.
- Current price per share, the resulting share count (per your chosen rounding mode), total cost in the stock's own trading currency, and total cost converted into your account currency.

The same information is also available in the extension's popup (click the toolbar icon) for a quick summary without scrolling through the page.

Sell/close-position signals ("ПРОДАВА") are left untouched — they don't carry a meaningful position-size percentage.

## Installation (unpacked — not yet on the Chrome Web Store)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project folder.
4. Click the extension's icon and type your account balance into the field right there in the popup (see below) — that's the only place it's set.
5. Log into `login.traderpro.bg` and open the strategy/signals page — buy-signal cards should now show live pricing and share counts.

## Editing your balance and position size (popup)

Both your account balance and your position-size override are configured in **exactly one place: the popup** — click the toolbar icon and both fields are right there.

- **Наличност (balance)** is auto-focused and ready to type into as soon as the popup opens, since it's the one that changes daily.
- **Позиция % (position-size override)** sits right next to it. Leave it empty and every signal uses its own TraderPRO-stated %; type a number and *every* buy signal is sized at that % instead — this is a single global setting, not a per-signal one. There is no way to override the % for just one signal; if that's what you need, clear the global override, note the number for that trade, and set it back afterward.

Both fields save automatically as you type (debounced ~300ms, with a small ✓ confirming the save) and instantly recompute every share count/total, both in the popup and on the TraderPRO page itself. Neither has a field on the Options page.

The account currency and rounding mode change far less often, so those stay on the Options page (click **Настройки** in the popup, or right-click the toolbar icon → Options).

## Configuring (Options page)

| Setting | What it does |
|---|---|
| **Account currency** | The currency your balance (set in the popup, see above) is denominated in. |
| **Rounding mode** | See below. |

### Rounding modes

- **Raw** — show the exact, unrounded share count (e.g. `41.87`). Useful if you trade fractional shares manually.
- **Always round down** — floor to the nearest whole share (conservative, never overspends your target allocation).
- **Round up if the extra cost is below a threshold** — you set a threshold amount in your account currency. If rounding up to the next whole share costs less than that threshold, it rounds up; otherwise it rounds down. Example: raw = 41.87 shares at $50/share. Rounding up to 42 costs `(42 − 41.87) × $50 = $6.50` extra. If your threshold is $10, it rounds up to 42; if your threshold is $5, it rounds down to 41.

## How prices and FX rates are fetched

- **Price**: [Yahoo Finance's public chart endpoint](https://query1.finance.yahoo.com/v8/finance/chart/) (unofficial, no API key) is tried first. If it fails, the extension falls back to [Stooq](https://stooq.com/)'s free CSV quote endpoint.
- **FX conversion**: Yahoo's currency-pair pseudo-tickers (e.g. `EURUSD=X`) are tried first, falling back to [Frankfurter.app](https://api.frankfurter.app/) (free ECB reference rates), and — only for the EUR↔BGN pair — a fixed fallback using Bulgaria's legal currency-board peg (1 EUR = 1.95583 BGN) if both network sources fail.
- When a fallback source is used, a small "source: stooq (approx.)" style badge appears next to the numbers so you know it isn't the primary, higher-confidence source.

## Privacy / security

- No API keys, credentials, or secrets are embedded in this extension, and none are required to use it — the Yahoo/Stooq/Frankfurter endpoints used are all free and keyless.
- Your account balance and preferences are stored only in your browser via `chrome.storage.sync` (which syncs across your own signed-in Chrome instances) — nothing is sent to any server the extension's authors control, because there isn't one.
- This is a deliberate design choice so the extension can be shared/published without anyone needing to trust a backend or hand over secrets.

## Known limitations

- Yahoo Finance's chart endpoint is unofficial and could change or start blocking requests without notice — the Stooq fallback exists for this reason but only covers US-listed tickers and doesn't report currency (assumed USD).
- Tickers are used as-is (no exchange-suffix mapping like `.L` for London), since TraderPRO's strategies currently trade only US-listed S&P 500 stocks.
- The position-size % override is global only — there's no way to size one particular signal differently from the rest without temporarily changing (and then changing back) the global value.
- Icons are placeholders — swap `icons/icon16.png`, `icon48.png`, `icon128.png` before any public release.

## Roadmap

- **Live IBKR balance** — pull your real account balance from Interactive Brokers via their Client Portal Gateway (a small app IBKR provides that you'd run and log into locally), instead of manually entering it. Deferred because it requires the user to run that local gateway; manual entry works today with zero setup.
- Non-US ticker support if TraderPRO ever signals non-S&P-500 instruments.

## Project structure

```
manifest.json              MV3 manifest — permissions, host permissions, content script registration
shared/                    Plain-JS modules shared across contexts (storage, quotes, fx, sizing, scrape, format, messaging)
background/background.js   Service worker — routes quote/FX requests, caches responses for 60s
content/                   Content script — scrapes signal cards, injects the sizing UI, watches for DOM changes
popup/                     Toolbar popup — mirrors the signals list with the same calculations
options/                   Settings page — currency, rounding mode (balance is popup-only, see above)
icons/                     Extension icons (currently placeholders)
```

See `CLAUDE.md` for a deeper architecture/conventions reference aimed at whoever (human or AI) works on this codebase next.
