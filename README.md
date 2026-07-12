# TraderPRO Position Sizer

An unofficial Chrome extension (Manifest V3) that adds live position-sizing math directly onto [TraderPRO](https://login.traderpro.bg)'s buy signals: current price, an editable position-size %, the resulting share count, and the total cost — in both the stock's own currency and your account currency.

**Not affiliated with TraderPRO. Not financial advice. Always double-check the numbers before placing a trade.**

## What it does

For every **buy** ("КУПУВА" / open-position) signal card on the TraderPRO signals page, the extension adds:

- Its existing "Количество" (position size %) field becomes directly editable in place — click it and type a new %.
- A few extra rows appended right below the existing ones, styled like every other field on the card (same fonts/spacing) so they read as a natural part of it rather than a bolted-on box: current price per share, the resulting share count (per your chosen rounding mode), total cost in the stock's own trading currency, and total cost converted into your account currency.

Since these rows aren't part of the original signal, they're still easy to tell apart from TraderPRO's own content: a small "⚡ Изчислено от Position Sizer" header introduces them, each has a thin accent-colored bar along its left edge, and the editable % field carries a small "✎" marker — hover any of these for a tooltip explaining it's extension-added.

The same information is also available in the extension's popup (click the toolbar icon) for a quick summary without scrolling through the page.

Sell/close-position signals ("ПРОДАВА") are left untouched — they don't carry a meaningful position-size percentage.

## Installation (unpacked — not yet on the Chrome Web Store)

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project folder.
4. Click the extension's icon → **Настройки** (Settings) to open the Options page and configure your account balance/currency and rounding preferences (see below). Everything defaults to sensible placeholders (0 balance, USD, round-down) if you skip this.
5. Log into `login.traderpro.bg` and open the strategy/signals page — buy-signal cards should now show live pricing and share counts.

## Editing your account balance

Since your available balance changes often, it doesn't live behind the Options page — **click the toolbar icon and the balance field is right there, auto-focused and ready to type into.** Type a new number, click away (or just stop typing), and it saves automatically (debounced ~300ms, with a small ✓ confirming the save) and instantly recomputes every share count/total both in the popup and on the TraderPRO page itself. One click to open the popup is all it takes.

The account currency, position-sizing mode, and rounding mode change far less often, so those stay on the Options page (click **Настройки** in the popup, or right-click the toolbar icon → Options).

## Configuring (Options page)

| Setting | What it does |
|---|---|
| **Account balance / currency** | Your available capital and the currency it's denominated in. Manually entered — there is no live brokerage connection yet (see Roadmap). The balance itself can also be edited directly from the popup, see above. |
| **Position sizing mode** | *Use each signal's stated %* (default) or *Override all with a fixed %* — e.g. always size every position at 10% regardless of what the signal says. You can still hand-edit any individual card's % afterward regardless of this setting. |
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
- The popup's % inputs are independent of the in-page cards' % inputs (edits in one don't sync to the other) — a deliberate simplification, see Roadmap.
- Icons are placeholders — swap `icons/icon16.png`, `icon48.png`, `icon128.png` before any public release.

## Roadmap

- **Live IBKR balance** — pull your real account balance from Interactive Brokers via their Client Portal Gateway (a small app IBKR provides that you'd run and log into locally), instead of manually entering it. Deferred because it requires the user to run that local gateway; manual entry works today with zero setup.
- Two-way sync between the popup's and the in-page cards' % overrides.
- Non-US ticker support if TraderPRO ever signals non-S&P-500 instruments.

## Project structure

```
manifest.json              MV3 manifest — permissions, host permissions, content script registration
shared/                    Plain-JS modules shared across contexts (storage, quotes, fx, sizing, scrape, format, messaging)
background/background.js   Service worker — routes quote/FX requests, caches responses for 60s
content/                   Content script — scrapes signal cards, injects the sizing UI, watches for DOM changes
popup/                     Toolbar popup — mirrors the signals list with the same calculations
options/                   Settings page — balance, currency, sizing mode, rounding mode
icons/                     Extension icons (currently placeholders)
```

See `CLAUDE.md` for a deeper architecture/conventions reference aimed at whoever (human or AI) works on this codebase next.
