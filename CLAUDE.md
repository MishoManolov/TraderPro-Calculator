# CLAUDE.md

Guidance for AI coding agents (and future-you) working in this repository. See `README.md` for the user-facing description; this file is about how the code is built and why.

## What this is

A Manifest V3 Chrome extension, no build step, no bundler, no package.json, no test framework. Plain scripts loaded directly by the browser. It reads buy and rebalance-to-% signals off `login.traderpro.bg` and computes position sizes (share count + cost, or a buy/sell/hold trade for rebalance signals) from a user-entered account balance, live price/FX data, and a configurable rounding rule — with a per-signal pencil-icon correction for a malformed ticker or for sizing off a manually-entered target price instead of the live quote.

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
| `shared/classify.js` | **Pure** text interpretation — `classifySignal(goalText, quantityRaw)` decides `open`/`close`/`rebalance`/`unknown` and a target %, plus `parseTickerAliases()`/`normalizeTickerKey()` for `"TICKER_A / TICKER_B"`-style symbols. No I/O. See "Rebalance signals" below |
| `shared/positions.js` | `chrome.storage.sync`-backed per-ticker holdings (`holdings`) and per-signal manual classification corrections (`signalOverrides`) — own storage key (`tpsPositions`), separate from `shared/storage.js`'s settings blob. Same `getX()`/`setX()`/`onXChanged()` shape as `shared/storage.js` |
| `shared/sizing.js` | **Pure** calculation module — `computePositionSize()`, `roundShares()`, and `computeRebalanceTrade()` (buy/sell/hold delta for a rebalance-to-% signal). No I/O. This is the single source of truth used identically by `content.js` and `popup.js`; never duplicate this math elsewhere |
| `shared/quotes.js` | `fetchQuote(ticker)` — Yahoo primary, Stooq fallback. Only ever called from `background/background.js` (needs `host_permissions` to bypass CORS) |
| `shared/fx.js` | `fetchFxRate(from, to)` — Yahoo pseudo-ticker → Frankfurter.app → EUR/BGN peg. Same caller restriction as `quotes.js` |
| `shared/scrape.js` | DOM scraping for TraderPRO signal cards — content-script context only |
| `shared/format.js` | Currency/number/percent display formatting |
| `shared/messaging.js` | Message type constants (`TPS_GET_QUOTE`, `TPS_GET_FX_RATE`, `TPS_GET_SIGNALS`) + `chrome.runtime`/`chrome.tabs` wrapper functions, including `requestQuoteForAliasesOrThrow()` (tries each ticker alias in turn) |
| `background/background.js` | Routes `TPS_GET_QUOTE`/`TPS_GET_FX_RATE` messages to `shared/quotes.js`/`shared/fx.js`, through an in-memory 60s cache (`Map`, not persisted — fine if the service worker unloads, just costs an extra fetch) |
| `content/content.js` | Finds `.t09.t09_open_position`/`.t09.t09_close_position` cards, classifies each via `TPS.classify.classifySignal()`, and appends type-appropriate computed fields (see "Rebalance signals" below) as native-looking `.t09_bl` rows (see "Injection styling" below) without touching the site's own "Количество" field, reacts to settings/positions changes, runs a self-healing `MutationObserver` for dynamically-loaded cards, and responds to `TPS_GET_SIGNALS` messages from the popup |
| `content/widget.js` | Injects the floating, fixed-position settings panel (docked to the right edge, minimize/expand) that owns `accountBalance` and `strategyWeightPercent` editing — see "Floating on-page widget" below. Writes go straight through `TPS.storage.setSettings()`; it never touches card DOM itself, relying on `content.js`'s own `onSettingsChanged` listener (same page context) to recompute cards |
| `content/widget.css` | Styling for the floating widget, deliberately matching TraderPRO's own visual language (brand blue, card radius/shadow, Montserrat) rather than the extension's popup palette — see "Floating on-page widget" below |
| `popup/popup.js` | Messages the active tab's content script for the current signal list (falls back to `chrome.scripting.executeScript` re-injection if the content script isn't loaded), fetches quote/FX per signal via the background worker, renders using `TPS.sizing`. The header shows a **read-only** summary of `accountBalance`/`strategyWeightPercent` — editing happens only in the on-page floating widget (see "Floating on-page widget" below) |
| `options/options.js` | Auto-saving settings form bound to `TPS.storage` |

## Data flow for one signal card

1. `content.js` finds a `.t09.t09_open_position` or `.t09.t09_close_position` card not yet marked `data-tps-processed`.
2. `shared/scrape.js` extracts `{ticker, tickerAliases, instrument, exchange, date, goalText, quantityRaw}` by matching Bulgarian `.lbl` text (see "DOM scraping" below), not by the numbered CSS classes. `goalText`/`quantityRaw` are returned raw — interpretation happens next, not here. The site's own "Количество" field is only *read*, never modified.
3. `content.js` calls `TPS.classify.classifySignal(goalText, quantityRaw)` to get `{type, targetPercent}` (`open`/`close`/`rebalance`/`unknown`), reconciles it with any saved `TPS.positions` override for this signal (`effectiveClassification()`), and branches (see "Rebalance signals" above): `close` appends nothing; `open` calls `buildOpenFieldsGroup()` (a static, read-only "Позиция %" value — `TPS.sizing.applyStrategyWeight(targetPercent, settings.strategyWeightPercent)` — + price/shares/total-position/total-account/meta); `rebalance` calls `buildRebalanceFieldsGroup()` (a static "Целеви %" value — also run through `applyStrategyWeight()` — + editable current-shares input, computed target shares/action/trade value); `unknown` calls `buildFallbackFieldsGroup()` (manual type/percent picker, nothing computed yet). All are ordinary `.t09_bl` rows preceded by one divider (see "Injection styling") appended to `.t09_1`.
4. For `open`/`rebalance` cards, `content.js` asks the background worker for a quote (`TPS_GET_QUOTE`, tried across `tickerAliases` via `TPS.messaging.requestQuoteForAliasesOrThrow`) and, if the quote's currency differs from the account currency, an FX rate (`TPS_GET_FX_RATE`).
5. `background.js` serves these from its 60s cache or fetches fresh via `shared/quotes.js`/`shared/fx.js`.
6. `content.js` renders the result: `open` cards via `TPS.sizing.computeAndFormat()` (uses `applyStrategyWeight` internally); `rebalance` cards via `TPS.sizing.computeRebalanceTrade()`, fed a weighted target percent (`applyStrategyWeight(state.effectiveTargetPercent, settings.strategyWeightPercent)`), into the appended `.tps-*-value` spans.
7. Settings changes (`TPS.storage.onSettingsChanged`) recompute all `ready` cards immediately; a currency change also re-fetches the FX leg; a `strategyWeightPercent` change updates the static "Позиция %"/"Целеви %" display for every `open`/`rebalance` card respectively, including ones still loading or errored (that value doesn't depend on a loaded quote). `TPS.positions.onPositionsChanged` similarly recomputes `rebalance` cards when current-shares or a classification override changes (possibly from a different card for the same ticker).

## Strategy weight — global multiplier, no per-signal override

There is no per-signal position-size editing. The only two inputs to any card's position size are the signal's own target %, scraped and classified as `state.effectiveTargetPercent` (an `open` card's stated %, or a `rebalance` card's target %), and a single **global** multiplier, `settings.strategyWeightPercent` (`null` = not set, treated as `100`), configured once in the floating on-page widget (`content/widget.js`, see "Floating on-page widget" below) next to `accountBalance` — never per-card. This used to be a *substitute* (a set value replaced the signal's own %); it's now a *multiplier* — it scales the signal's % rather than replacing it, so "run this whole strategy at half size" is a single weight change instead of manually halving every signal's stated %. It applies to **every signal type's own target %** — plain `open` and `rebalance` alike (a deliberate decision: each strategy/signal provider may warrant a different slice of the portfolio, and that shouldn't depend on whether a given signal happens to be a fresh buy or a rebalance). The two are reconciled by the single shared helper `TPS.sizing.applyStrategyWeight()` (in `shared/sizing.js`, not duplicated in `content.js`/`widget.js`/`popup.js`):

```js
function applyStrategyWeight(statedPercent, weightPercent) {
  var weight = (weightPercent !== null && weightPercent !== undefined && isFinite(weightPercent)) ? weightPercent : 100;
  return statedPercent * (weight / 100);
}
```

- The injected "Позиция %"/"Целеви %" field on each *card* is **static text** (`.tps-percent-value` for `open`, `.tps-target-percent-value` for `rebalance`), not an input — there is nothing to click or edit on an individual card. It just reflects whatever the global weight currently resolves to for that signal. The one editable control lives in the floating widget instead (see "Floating on-page widget" below), not on any card.
- `widget.js`'s `tpsWidgetWeightInput` is the only editable control: empty → `strategyWeightPercent: null` (saved via `TPS.storage.setSettings`) → every card is sized at its own `effectiveTargetPercent` unscaled (weight defaults to 100); a number → every card's % is multiplied by `weight/100`, both `open` (`buildOpenFieldsGroup`/`handleSettingsChanged`) and `rebalance` (`buildRebalanceFieldsGroup`/`renderRebalanceResult`, which weights the target before calling `TPS.sizing.computeRebalanceTrade()`, and updates the displayed "Целеви %" independently of price so it stays correct even on a card whose quote hasn't loaded yet). There's no upper-bound clamp on the input (a weight above 100 legitimately overweights the strategy) — only `>= 0` is enforced.
- If you're asked for "let me set a % on this one signal" again, that's a per-signal override — it was deliberately removed in favor of this single global one. Confirm with the user before reintroducing per-card editing; don't assume the two requests are the same.

## Rebalance signals — text classification, not a fixed enum

The provider sends a third signal kind beyond plain open/close: "adjust this position to become X% of the portfolio" (e.g. "Ребалансира" / "до 10%"). The card's own `t09_open_position`/`t09_close_position` CSS class is **not** authoritative for this — a real saved example shows a rebalance-to-10% signal rendered under `t09_open_position` (same class as a plain buy) while a plain full close rendered under `t09_close_position`. So every card, regardless of class, is scraped and its actual meaning is decided by reading the `Цел` (goal) field as text.

- `TPS.classify.classifySignal(goalText, quantityRaw)` (`shared/classify.js`) is a hand-written keyword/regex heuristic, deliberately **not** a fixed enum lookup — there's no closed set of provider phrasings to match exactly. Goal-text keyword stems (`затваря` → close, `ребаланс` → rebalance, anything else → open) decide the type; quantity-text regex handles `"20%"`, `"до 10%"`, `"с 35%"`, comma decimals, and `"Всичко"`. If a new phrasing shows up that this doesn't cover, extend the stem lists / regex here rather than adding a special case elsewhere.
- If the quantity text doesn't match any known pattern for the goal's type, `classifySignal()` deliberately returns `type: 'unknown'` rather than guessing. `content.js` then renders a manual fallback control on the card itself (type selector + target-% input) instead of computing anything — the user's choice is saved via `TPS.positions.setSignalOverride(tickerKey + '__' + date, {type, targetPercent})` so it persists across reloads without needing to be re-picked, but only for that one signal instance (a later signal for the same ticker gets a fresh shot at the heuristic).
- **Ticker aliases:** the `Символ` field can be `"ETL2 / COMF"` — `TPS.classify.parseTickerAliases()` splits it into an ordered list; `TPS.messaging.requestQuoteForAliasesOrThrow()` tries each alias in turn for a quote, stopping at the first that resolves (mirrors `shared/quotes.js`'s own Yahoo→Stooq fallback shape, one level up). `TPS.classify.normalizeTickerKey()` builds a case/order-insensitive storage key from the alias list so the same instrument maps to one key regardless of how a given signal orders/formats its aliases.
- **Current shares held** — the one piece of state needed to turn a target % into an actual buy/sell trade that this extension has no way to observe on its own — is entered **inline on the rebalance card itself**, in shares (not %, so it doesn't drift as price/balance move), via `shared/positions.js`'s `holdings` map (keyed by `tickerKey`, not per-card: editing it on one card updates every other visible card for the same ticker through `TPS.positions.onPositionsChanged`). `TPS.sizing.computeRebalanceTrade()` turns `{accountBalance, targetPercent, currentShares, price, fxRate}` into `{targetShares, deltaShares, action: 'buy'|'sell'|'hold'}`.
- The global `strategyWeightPercent` widget setting (see "Strategy weight" above) applies to `rebalance` targets too, same as `open` cards — a rebalance signal's raw target % (from the signal text or a resolved override) is scaled by the weight before being used, so "this strategy only gets X% of my portfolio" holds uniformly across both signal types.
- Current-shares editing is deliberately **page-only**, not in the popup — same precedent as `accountBalance`/`strategyWeightPercent` (see "Floating on-page widget" below). The popup's signal list shows `signalType`/target %/computed action read-only.

## Per-signal ticker override and target price — the one place per-signal editing IS allowed

The "Strategy weight" section above is about *target %* specifically ("let me set a % on this one signal" was deliberately removed). Two other fields got per-signal editing anyway, because they solve a different problem — correcting *this card's own* malformed/unrecognized data, not overriding a global policy:

- **Ticker override** (row "Използван символ", first appended row on every `open`/`rebalance` card): lets the user type a replacement ticker when the scraped one is malformed or the site's own symbol doesn't resolve to a quote. It only changes which symbol *this extension* uses for its own quote lookup (`state.effectiveTickerAliases`, fed into `TPS.messaging.requestQuoteForAliasesOrThrow`) — it never touches the site's own native "Символ" DOM node (see "Injection styling" below for why: overlaying/wrapping a native cell was rejected as too fragile). The corrected value displays in place; the original scraped ticker shows struck through alongside it.
- **Target price** (the existing "Цена / бр." row, now editable): lets the user size a position off a manually-entered price instead of the live quote — useful when a signal specifies "buy at X" rather than "at market." The live quote is still fetched (needed for FX and for the struck-through comparison value) and still drives every *other* computed field; only which price feeds `TPS.sizing.resolveSizingPrice()` (used inside `computeAndFormat`/`computeRebalanceTrade`) changes.
- Both are stored in `shared/positions.js`'s `signalOverrides` map (`tickerOverride`, `targetPrice` keys, alongside the existing `type`/`targetPercent` classification-correction keys) — same per-signal-instance lifetime as classification overrides, so a later signal for the same ticker starts fresh. `setSignalOverride()` merges onto whatever's already stored at that key rather than replacing it, since these can be set independently of a classification correction.
- Same interaction shape as everywhere else in this file: pencil icon → click swaps display for an input → commit on Enter/blur (Escape cancels) → debounce(300ms) the storage write → flash a checkmark (1200ms), mirroring `content/widget.js`'s `flashSaved`/`bindBalanceInput` pattern.
- Page-only, like current-shares/fallback-classification — the popup consumes the resolved values (`effectiveTickerAliases`, `targetPriceOverride`) read-only so its numbers agree with the page, but has no edit UI of its own.
- If asked to make *target percent* editable per-signal too, that's the thing that was already removed once (see "Strategy weight" above) — don't conflate the two asks.

## DOM scraping notes (this is the most fragile part of the codebase)

TraderPRO's markup (confirmed from a real saved page) looks like:

```html
<div class="t09 t09_open_position">  <!-- both classes are scraped now — see "Rebalance signals" below for why -->
  <div class="t09_1">
    <div class="t09_11"><p class="cap">КУПУВА</p><p class="scap">ОТВАРЯ ПОЗИЦИЯ</p></div>
    <div class="t09_bl t09_15"><p class="lbl">Символ</p><p class="val">TKO</p></div>
    <div class="t09_bl t09_17"><p class="lbl">Цел</p><p class="val">Отваря позиция</p></div>
    <div class="t09_bl t09_18"><p class="lbl">Количество</p><p class="val">20%</p></div>
    <!-- ...more t09_bl rows... -->
  </div>
</div>
```

`shared/scrape.js` matches on the Bulgarian `.lbl` text (`Дата`, `Инструмент`, `Борса`, `Символ`, `Цел`, `Количество`) rather than the numbered `t09_12`..`t09_21` classes, because the label text is the semantically stable anchor — the numbered classes are positional and could shift if TraderPRO reorders fields. If TraderPRO changes its markup and the extension stops finding cards, check `TPS.scrape.CARD_SELECTOR` and `TPS.scrape.LABELS` first.

`scrapeCard()` returns `goalText`/`quantityRaw` **raw and unparsed** — interpreting them is `shared/classify.js`'s job, not `scrape.js`'s (see below).

## Injection styling — fit natively, but stay distinguishable

**Key layout fact, learned by shipping a version that looked broken and fixing it:** `.t09_1` is a CSS grid (5 columns in the observed layout), and each `.t09_bl` is exactly **one grid cell** containing a label line over a value line — it is not an independent full-width row. This matters a lot for anything appended here:

- A cell that isn't a real label/value pair doesn't fit the grid. An earlier version added a standalone "header" cell (just a label, no value) to introduce the appended section — it rendered as an orphaned label with a dangling empty gap underneath it (where its hidden value would have been), because the grid row's height is set by its tallest cell. **Don't reintroduce a header cell** — every appended `.t09_bl` must be a genuine label+value pair.
- `.val` may lay its children out with `justify-content: space-between` or similar (it's normally a single text node, so this is invisible on native fields). Giving `.val` two direct children — e.g. an `<input>` followed by a literal `%` — gets them shoved apart with a visible gap. If a future field needs more than one node inside `.val`, wrap them in a single child element first (this bit us once with an editable %-input-plus-"%"-text field; that field is gone now, but the gotcha applies to anything similar).

With that constraint respected, appended fields are individual `.t09_bl` cells (the exact class the site uses for every field), wrapped in a `div.tps-fields-group { display: contents; }` — the wrapper contributes no box of its own, so its `.t09_bl` children slot directly into `.t09_1`'s grid like native fields, inheriting the site's real `.lbl`/`.val` typography instead of a hand-guessed style (we don't have the site's actual CSS, so matching by reusing its classes is more reliable than trying to replicate colors/fonts).

**Distinguishability history — two approaches were tried and dropped before landing on the current one:**
1. Per-cell marker icons ("⚡"/"✎" spans with `title` tooltips) on every label, plus a `box-shadow: inset` accent bar and a `border-top` on every appended cell. Removed on request — it read as visual noise/a rendering glitch (the accent bar in particular appeared on the "wrong" side at grid-cell boundaries), and per-cell borders pieced together into an uneven line rather than a clean one.
2. What's used now: **one single full-width divider**, `.tps-divider` (`grid-column: 1 / -1`, a plain `border-top` in a neutral gray — not the extension's own accent color, so it reads as an ordinary section rule rather than a branded element), inserted once as the first child of `.tps-fields-group`. `grid-column: 1 / -1` spans from the grid's first line to its last regardless of the actual column count, so it doesn't hardcode "5 columns" anywhere. No icons, no tooltips, no per-cell decoration — the divider alone marks where native fields end and appended ones begin.

If you're asked to make this "more distinguishable" again, prefer adjusting the divider (thickness/color/spacing) over reintroducing per-cell decoration — that's the part that kept looking broken.

**Narrow exception, added later:** the ticker-override and target-price rows (see "Per-signal ticker override and target price" above) do carry a small `.tps-edit-icon` pencil each. This isn't a reversal of point 1 above — that icon marked *every* appended field purely to separate "ours" from "native," decoration with no function, and that's what looked like noise. These two icons instead mark the two specific fields that are actually editable, so they carry information the divider alone doesn't. Don't generalize this back to "an icon on every field" — that's the exact thing that was reverted.

**Column alignment nudge:** appended cells rendered slightly left of the native columns above them (`.tps-fields-group > .t09_bl { margin-left: 6px; }` in `content.css`). This is an *empirical* fix, not a principled one — without the site's real CSS there's no way to know the exact root cause (a good guess: native `.t09_bl` cells may carry some inner structure/padding this extension's plain-div cells don't reproduce). If TraderPRO's layout changes and this starts looking off again, re-measure and adjust the `6px` rather than assuming it's still correct.

A follow-up request to instead right-align the appended cells' text (`text-align: right` on `.lbl`/`.val`) was tried and then explicitly reverted back to this `margin-left` approach — don't reintroduce the text-align version without checking that it's actually wanted again.

## Floating on-page widget — the ONLY place accountBalance and strategyWeightPercent are set

**History:** this used to live in the popup header (`accountBalanceInput`/`positionPercentInput`, auto-focused on open). It was moved to a floating widget injected directly onto the TraderPRO page on request, so both values are visible and editable without opening the toolbar icon at all. The `positionPercentOverride`/`Позиция %` field was later redesigned into `strategyWeightPercent`/`Тегло на стратегия %` — a portfolio-wide *multiplier* on `open` signals' own %, not a substitute for them (empty = 100% = no scaling); see "Strategy weight" above. If you're asked to move it back to the popup, or to add either field to Options, treat that as a real design change to confirm, not a revert to "the way it always was" — the popup-header version is gone, not commented out.

Both `accountBalance` and `strategyWeightPercent` are edited **exclusively** in `content/widget.js`'s floating panel (`tpsWidgetBalanceInput` / `tpsWidgetWeightInput`), which `content/widget.js` injects into `document.body` on every `https://login.traderpro.bg/*` page load, docked to the right edge of the viewport (`position: fixed`, vertically centered, `z-index: 999999` — the right edge was picked because TraderPRO's own header/sidebar aren't fixed and nothing else on the page is ever pinned there on desktop; the off-canvas mobile nav drawer opens from the *left* at ≤991px, which is also why the widget only shrinks rather than repositions at that breakpoint, see `content/widget.css`). There is still deliberately no balance or strategy-weight field on the Options page (`options/options.html`/`options.js` only handle `accountCurrency` and rounding), and the popup (`popup/popup.html`) now shows only a **read-only** summary line (`renderSettingsSummary()` in `popup.js`) — no inputs.

- `content/widget.js` is a standalone content-script file (own `js` entry in `manifest.json`, loaded alongside but independent of `content.js` — same self-bootstrapping `DOMContentLoaded`-or-immediate pattern, own IIFE, no cross-file calls between the two). It does **not** touch card DOM itself.
- `bindBalanceInput()`/`bindWeightInput()` debounce (300ms) and write straight through `TPS.storage.setSettings({...})`, then flash a `.tps-widget-saved` ✓ for 1200ms — the same debounce/save/indicator shape the old popup version used, just without the `renderedItems` re-render loop, because that loop is unnecessary here: `content.js`'s own `TPS.storage.onSettingsChanged` listener (already registered, see "Data flow" above) runs in the *same page context* and picks up the storage write on its own, recomputing every card without `widget.js` needing to know about card DOM at all. This is the main reason the move to on-page injection simplified the code rather than complicating it — the popup needed the manual re-render loop only because it's a *separate* document from the injected cards; the widget isn't.
- `bindExternalUpdates()` also listens via `TPS.storage.onSettingsChanged` to reflect changes made elsewhere (Options page currency, `chrome.storage.sync` pulling a value from another of the user's Chrome instances, or the widget's own writes echoing back) — guarded by `document.activeElement !== <input>` so it never clobbers a field the user is mid-typing in.
- Minimize/expand is persisted in `settings.widgetMinimized` (boolean, synced like everything else) rather than local/session state, so the collapsed/expanded choice follows the user across reloads and their other signed-in Chrome instances. Toggling calls `TPS.storage.setSettings({ widgetMinimized: ... })`; the collapsed state renders as a small docked tab (`.tps-widget-tab`) instead of the full panel.
- `options.js`'s `readFormAsPartialSettings()` only returns the three keys it actually manages (`accountCurrency`, `roundingMode`, `roundUpThresholdAmount`) — `accountBalance`, `strategyWeightPercent`, and `widgetMinimized` are never included. `TPS.storage.setSettings()` merges partial updates onto existing settings, so leaving them out preserves whatever the widget last saved instead of stomping it back to whatever stale value the Options form last saw.

If you add another frequently-changing setting later, follow this same pattern (inline in the widget + `chrome.storage` propagation) rather than adding it to Options.

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
4. On the TraderPRO page, confirm the floating widget appears docked to the right edge. Edit the balance in it and confirm every card's totals update; edit the % override (set a number, then clear it back to empty) and confirm every card's "Позиция %" and totals switch between the override and each signal's own stated % accordingly. In Options, change currency/rounding and confirm already-rendered cards *and* the widget's currency prefix update.
5. Click the widget's minimize button, confirm it collapses to a small docked tab; click the tab, confirm it re-expands. Reload the page and confirm the collapsed/expanded state persisted (`settings.widgetMinimized`).
6. Block `query1/query2.finance.yahoo.com` in DevTools' Network conditions to force the Stooq fallback path and confirm the "source: stooq" badge appears.
7. Open the popup and confirm its read-only summary line matches the widget/in-page numbers.
8. Rebalance signals: a saved real signals page with a plain-close card and a rebalance-to-% card is the easiest way to test this without waiting for both signal shapes to appear live. Such a page (`TraderPRO - etf_strategy (rebalancing).html`, plus `TraderPRO - example page.html` and `TraderPRO - safe_page.html`, used for store-screenshot generation) is gitignored — it's the contributor's own saved copy of a real page and may contain their strategy/session data, so it's never assumed to be in the repo. Ask the contributor for one, or save a fresh copy from a live signals page yourself, then paste that markup into a real signals page via DevTools (or adapt it into a page the content script matches) and confirm: the close card gets no appended fields, the rebalance card shows "Целеви %"/an editable "Текущи акции" input/computed "Действие", editing the shares input recomputes buy/sell/hold live, and the value persists (and propagates to any other card for the same ticker) after reload. Confirm a `"TICKER_A / TICKER_B"`-style symbol still loads a price (alias fallback). Craft an unrecognized `Цел`/`Количество` combo and confirm the manual fallback selector appears and its resolution persists.
9. Ticker override / target price (see "Per-signal ticker override and target price" above): click the pencil next to "Използван символ", type a different resolvable ticker, confirm the card refetches and recomputes under the new symbol, the original scraped ticker shows struck through, and it survives a reload. Click the price pencil (enabled only once a quote has loaded) and enter a target price — confirm it becomes the main "Цена / бр." value, the live quote shows struck through beside it, and shares/totals (or target shares/action/trade value on a rebalance card) recompute off the target price; clear it back to empty and confirm everything reverts to the live quote. Confirm neither override leaks into the popup's edit surface (still read-only there) and that a different signal (different date) for the same ticker doesn't inherit either override.

## IBKR (do not implement without a design discussion)

Live brokerage balance sync is intentionally deferred. IBKR has no simple embeddable REST API — the realistic path is their **Client Portal Gateway**, a local app the user runs and authenticates through interactively, exposing `https://localhost:5000/v1/api/...`. This is architecturally different from the current keyless-public-API pattern (needs `host_permissions` for `localhost`, session/auth-refresh handling, a settings toggle for "manual" vs. "IBKR live" balance) and should reuse `shared/sizing.js` unchanged. Don't half-implement this — confirm the approach with the user first, same as was done for the rest of this extension's design.

## Where the original design rationale lives

The full architecture writeup (message contracts, build milestones, alternatives considered) was produced as a plan-mode document during initial development. This file and `README.md` are the durable summary — keep them updated as the source of truth going forward rather than relying on that session-local plan file.
