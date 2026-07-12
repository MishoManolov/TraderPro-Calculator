# CLAUDE.md

Guidance for AI coding agents (and future-you) working in this repository. See `README.md` for the user-facing description; this file is about how the code is built and why.

## What this is

A Manifest V3 Chrome extension, no build step, no bundler, no package.json, no test framework. Plain scripts loaded directly by the browser. It reads buy signals off `login.traderpro.bg` and computes position sizes (share count + cost) from a user-entered account balance, live price/FX data, and a configurable rounding rule.

## Non-negotiable constraints

- **No secrets, ever.** This extension is meant to be shared/published publicly. Never hardcode an API key, token, or credential anywhere in this repo. Every external data source used (Yahoo Finance chart endpoint, Stooq CSV, Frankfurter.app) was deliberately chosen because it's free and keyless — keep it that way. If a feature needs an authenticated API, it needs a design conversation first (see "IBKR" below).
- **No build step.** Don't introduce a bundler, TypeScript, or `import`/`export` syntax without discussing it first — the whole codebase currently relies on plain `<script>`/`content_scripts`/`importScripts` ordering (see "Module system" below). Adding a build step changes how every file loads.

## Module system (read this before adding a new shared module)

There's no bundler, so cross-file sharing happens via a single global namespace object, `TPS`, hung off `window` (page contexts: content script, popup, options) or `self` (the background service worker — no `window` there). Every file in `shared/` follows this pattern:

```js
(function (global) {
  global.TPS = global.TPS || {};
  // ...define stuff...
  global.TPS.someModule = { someFunction: someFunction };
})(typeof self !== 'undefined' ? self : this);
```

Consequences:
- **Load order matters.** A file can only use `TPS.xxx` if the module defining `TPS.xxx` was loaded earlier in the same context. Check `manifest.json`'s `content_scripts[0].js` array and the `<script>` tag order in `popup/popup.html` / `options/options.html` when adding a new shared module or a new dependency between existing ones.
- **`background/background.js`** pulls in shared modules via `importScripts('../shared/x.js', ...)` at the top of the file — service workers can't use `<script>` tags.
- Code style is deliberately ES5-ish (`var`, function expressions, no arrow functions required but not forbidden, no `import`/`export`) for consistency with the existing files — match it rather than mixing styles.

## Architecture map

| File | Responsibility |
|---|---|
| `manifest.json` | MV3 config: permissions, `host_permissions` (TraderPRO + Yahoo + Stooq + Frankfurter), content script registration |
| `shared/storage.js` | `chrome.storage.sync` settings schema (`DEFAULT_SETTINGS`), `getSettings()`/`setSettings()`/`onSettingsChanged()` |
| `shared/sizing.js` | **Pure** calculation module — `computePositionSize()` and `roundShares()`. No I/O. This is the single source of truth used identically by `content.js` and `popup.js`; never duplicate this math elsewhere |
| `shared/quotes.js` | `fetchQuote(ticker)` — Yahoo primary, Stooq fallback. Only ever called from `background/background.js` (needs `host_permissions` to bypass CORS) |
| `shared/fx.js` | `fetchFxRate(from, to)` — Yahoo pseudo-ticker → Frankfurter.app → EUR/BGN peg. Same caller restriction as `quotes.js` |
| `shared/scrape.js` | DOM scraping for TraderPRO signal cards — content-script context only |
| `shared/format.js` | Currency/number/percent display formatting |
| `shared/messaging.js` | Message type constants (`TPS_GET_QUOTE`, `TPS_GET_FX_RATE`, `TPS_GET_SIGNALS`) + `chrome.runtime`/`chrome.tabs` wrapper functions |
| `background/background.js` | Routes `TPS_GET_QUOTE`/`TPS_GET_FX_RATE` messages to `shared/quotes.js`/`shared/fx.js`, through an in-memory 60s cache (`Map`, not persisted — fine if the service worker unloads, just costs an extra fetch) |
| `content/content.js` | Finds `.t09.t09_open_position` cards, injects computed fields as native-looking `.t09_bl` rows (see "Injection styling" below), turns the site's own "Количество" row into the editable % input, reacts to settings changes, runs a self-healing `MutationObserver` for dynamically-loaded cards, and responds to `TPS_GET_SIGNALS` messages from the popup |
| `popup/popup.js` | Messages the active tab's content script for the current signal list (falls back to `chrome.scripting.executeScript` re-injection if the content script isn't loaded), fetches quote/FX per signal via the background worker, renders using `TPS.sizing`. Also owns the inline, auto-focused account-balance input in the popup header (see below) |
| `options/options.js` | Auto-saving settings form bound to `TPS.storage` |

## Data flow for one signal card

1. `content.js` finds a `.t09.t09_open_position` card not yet marked `data-tps-processed`.
2. `shared/scrape.js` extracts `{ticker, instrument, exchange, date, statedPercent, quantityBlockEl, quantityValueEl}` by matching Bulgarian `.lbl` text (see "DOM scraping" below), not by the numbered CSS classes. `quantityBlockEl`/`quantityValueEl` point at the site's own "Количество" row.
3. `content.js` calls `makeQuantityFieldEditable(state)`, which turns that existing row's value into a live `<input>` in place (state.percentInputEl), then `buildFieldsGroup(state)` builds the *appended* rows (a header row + price/shares/total-position/total-account/meta, each an ordinary `.t09_bl` — see "Injection styling") and appends them to `.t09_1`. Only if `quantityBlockEl` wasn't found does the fields group fall back to including its own percent-input row.
4. `content.js` asks the background worker for a quote (`TPS_GET_QUOTE`) and, if the quote's currency differs from the account currency, an FX rate (`TPS_GET_FX_RATE`).
5. `background.js` serves these from its 60s cache or fetches fresh via `shared/quotes.js`/`shared/fx.js`.
6. `content.js` calls `TPS.sizing.computePositionSize()` with the settings + quote + fx and renders the result into the appended `.tps-*-value` spans. Editing the %-input recomputes locally (debounced, no refetch) since price/fx are already cached in the card's in-memory state.
7. Settings changes (`TPS.storage.onSettingsChanged`) recompute all `ready` cards immediately; a currency change also re-fetches the FX leg. A card's user-set % is **never** overwritten by a settings change — only newly-appearing cards pick up a new global default (signal-stated vs. fixed-override).

## DOM scraping notes (this is the most fragile part of the codebase)

TraderPRO's markup (confirmed from a real saved page) looks like:

```html
<div class="t09 t09_open_position">  <!-- buy card; t09_close_position = sell, never touched -->
  <div class="t09_1">
    <div class="t09_11"><p class="cap">КУПУВА</p><p class="scap">ОТВАРЯ ПОЗИЦИЯ</p></div>
    <div class="t09_bl t09_15"><p class="lbl">Символ</p><p class="val">TKO</p></div>
    <div class="t09_bl t09_18"><p class="lbl">Количество</p><p class="val">20%</p></div>
    <!-- ...more t09_bl rows... -->
  </div>
</div>
```

`shared/scrape.js` matches on the Bulgarian `.lbl` text (`Дата`, `Инструмент`, `Борса`, `Символ`, `Количество`) rather than the numbered `t09_12`..`t09_21` classes, because the label text is the semantically stable anchor — the numbered classes are positional and could shift if TraderPRO reorders fields. If TraderPRO changes its markup and the extension stops finding cards, check `TPS.scrape.CARD_SELECTOR` and `TPS.scrape.LABELS` first.

## Injection styling — fit natively, but stay distinguishable

Earlier versions appended one visually separate `<div>` with its own box/border that visibly "extended" each card. That was replaced deliberately: appended fields are now individual `.t09_bl` rows (the exact class the site uses for every other field), wrapped in a `div.tps-fields-group { display: contents; }` — the wrapper contributes no box of its own, so its `.t09_bl` children slot into the card's existing row flow exactly like native fields, inheriting the site's real `.lbl`/`.val` typography instead of a hand-guessed style (we don't have the site's actual CSS, so matching by reusing its classes is more reliable than trying to replicate colors/fonts).

To keep it distinguishable as extension output without a heavy visual break:
- A single header row (`.tps-field-header`, built in `buildFieldsGroup`) introduces the appended section: an accent-colored label with a "⚡" marker and a `title` tooltip explaining it's added by the extension.
- Every extension-touched row — the appended ones *and* the site's own "Количество" row once `makeQuantityFieldEditable` turns it into an input — gets a thin accent bar via `box-shadow: inset 3px 0 0 0 ...` (chosen over `border-left` specifically because it doesn't consume layout space or require compensating padding, so it can't shift the row against the site's own CSS).
- The "Количество" row additionally gets a small "✎" marker appended to its label (not a full header — it's a *modified* native field, not a new one) with its own tooltip.
- The `%` input itself is styled to look like plain text until hovered/focused (transparent border/background, `font: inherit`), so it doesn't read as a foreign form control dropped into the page.

If TraderPRO's own CSS changes such that `.t09_bl`/`.lbl`/`.val` stop existing or mean something different, this whole approach needs re-validating — it depends on those classes staying meaningful.

## Inline balance editing (popup)

Because the account balance changes far more often than currency/sizing-mode/rounding, it's editable directly in the popup header (`accountBalanceInput` in `popup/popup.html`), not just on the Options page. `popup.js`:

- Auto-focuses and selects that input on popup open, so opening the popup (one click) is enough to start typing a new balance — no second click to find/enter an edit field.
- Debounces (300ms) writes through `TPS.storage.setSettings({accountBalance: ...})`, mutates the shared in-memory `settings` object in place (the same object reference is threaded through the whole render chain — `buildSignalItem` → `loadAndRenderSignal` → `renderResult` — so later calls automatically see the new value), and re-renders every currently-displayed signal from a `renderedItems` array (`{item, state}` pairs pushed in `loadAndRenderSignal`) without refetching price/FX.
- Because this goes through `chrome.storage.sync`, `content.js`'s `TPS.storage.onSettingsChanged` listener picks up the change too — editing the balance in the popup also live-updates the in-page injected cards on the TraderPRO tab, for free, via the existing settings-reactivity path.

If you add another frequently-changing setting later, follow this same pattern (inline in the popup + `chrome.storage` propagation) rather than burying it in Options.

## Rounding formula (`shared/sizing.js`)

```
rawShares = (accountBalance * percent/100) / (priceInPositionCurrency * fxRate)
'raw'            -> rawShares, unrounded
'roundDown'      -> floor(rawShares)
'roundUpThreshold' -> ceil if (ceil(rawShares) - rawShares) * priceInAccountCurrency <= roundUpThresholdAmount, else floor
```

`fxRate` convention: units of account currency per 1 unit of position currency (`priceInAccountCurrency = priceInPositionCurrency * fxRate`). This matches Yahoo's `FROMTO=X` semantics directly when you fetch `fetchFxRate(from=positionCurrency, to=accountCurrency)` — don't invert it.

## Testing / verification

There is no automated test suite. Verify manually:

1. `chrome://extensions` → Developer mode → Load unpacked.
2. Log into `login.traderpro.bg`, open the signals page, confirm buy cards get sizing blocks and sell cards don't.
3. Check the service worker's DevTools console (`chrome://extensions` → "service worker" link) for `TPS_GET_QUOTE`/`TPS_GET_FX_RATE` traffic and 60s caching behavior.
4. In Options, change balance/currency/rounding/sizing-mode and confirm already-rendered cards update without losing hand-edited %s.
5. Block `query1/query2.finance.yahoo.com` in DevTools' Network conditions to force the Stooq fallback path and confirm the "source: stooq" badge appears.
6. Open the popup and confirm it matches the in-page numbers.

## IBKR (do not implement without a design discussion)

Live brokerage balance sync is intentionally deferred. IBKR has no simple embeddable REST API — the realistic path is their **Client Portal Gateway**, a local app the user runs and authenticates through interactively, exposing `https://localhost:5000/v1/api/...`. This is architecturally different from the current keyless-public-API pattern (needs `host_permissions` for `localhost`, session/auth-refresh handling, a settings toggle for "manual" vs. "IBKR live" balance) and should reuse `shared/sizing.js` unchanged. Don't half-implement this — confirm the approach with the user first, same as was done for the rest of this extension's design.

## Where the original design rationale lives

The full architecture writeup (message contracts, build milestones, alternatives considered) was produced as a plan-mode document during initial development. This file and `README.md` are the durable summary — keep them updated as the source of truth going forward rather than relying on that session-local plan file.
