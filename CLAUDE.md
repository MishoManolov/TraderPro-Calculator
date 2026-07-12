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
| `content/content.js` | Finds `.t09.t09_open_position` cards, appends computed fields (including a *static, read-only* effective-% display) as native-looking `.t09_bl` rows (see "Injection styling" below) without touching the site's own "Количество" field, reacts to settings changes, runs a self-healing `MutationObserver` for dynamically-loaded cards, and responds to `TPS_GET_SIGNALS` messages from the popup |
| `popup/popup.js` | Messages the active tab's content script for the current signal list (falls back to `chrome.scripting.executeScript` re-injection if the content script isn't loaded), fetches quote/FX per signal via the background worker, renders using `TPS.sizing`. Also owns the popup header's two global inputs: `accountBalanceInput` (auto-focused) and `positionPercentInput` (see "Position % override" below) |
| `options/options.js` | Auto-saving settings form bound to `TPS.storage` |

## Data flow for one signal card

1. `content.js` finds a `.t09.t09_open_position` card not yet marked `data-tps-processed`.
2. `shared/scrape.js` extracts `{ticker, instrument, exchange, date, statedPercent}` by matching Bulgarian `.lbl` text (see "DOM scraping" below), not by the numbered CSS classes. The site's own "Количество" field is only *read* here, never modified — see "Position % override" below.
3. `content.js` resolves `TPS.sizing.resolveEffectivePercent(scraped.statedPercent, settings.positionPercentOverride)` and calls `buildFieldsGroup(state, settings)`, which builds the *appended* rows (a static, read-only "Позиция %" value + price/shares/total-position/total-account/meta, each an ordinary `.t09_bl` preceded by one divider — see "Injection styling") and appends them to `.t09_1`.
4. `content.js` asks the background worker for a quote (`TPS_GET_QUOTE`) and, if the quote's currency differs from the account currency, an FX rate (`TPS_GET_FX_RATE`).
5. `background.js` serves these from its 60s cache or fetches fresh via `shared/quotes.js`/`shared/fx.js`.
6. `content.js` calls `TPS.sizing.computePositionSize()` with `percent: TPS.sizing.resolveEffectivePercent(state.statedPercent, settings.positionPercentOverride)` (see "Position % override") and renders the result into the appended `.tps-*-value` spans.
7. Settings changes (`TPS.storage.onSettingsChanged`) recompute all `ready` cards immediately; a currency change also re-fetches the FX leg; a `positionPercentOverride` change updates the static "Позиция %" display for *every* card, including ones still loading or errored (not just `ready` ones — that value doesn't depend on quote/fx).

## Position % override — global only, no per-signal override

There is no per-signal position-size editing. The only two inputs to position size are the signal's own stated %, scraped as `state.statedPercent`, and a single **global** override, `settings.positionPercentOverride` (`null` = not set), configured once in the popup next to `accountBalance` — never per-card, never on the injected page. The two are reconciled by the single shared helper `TPS.sizing.resolveEffectivePercent()` (in `shared/sizing.js`, not duplicated in `content.js`/`popup.js`):

```js
function resolveEffectivePercent(statedPercent, globalOverride) {
  return globalOverride !== null && globalOverride !== undefined && isFinite(globalOverride) ? globalOverride : statedPercent;
}
```

- The injected "Позиция %" field on each card is **static text** (`.tps-percent-value`), not an input — there is nothing to click or edit on the TraderPRO page itself. It just reflects whatever the global override currently resolves to for that signal.
- `popup.js`'s `positionPercentInput` is the only editable control: empty → `positionPercentOverride: null` (saved via `TPS.storage.setSettings`) → every card falls back to its own `statedPercent`; a number → every card uses that same number.
- If you're asked for "let me set a % on this one signal" again, that's a per-signal override — it was deliberately removed in favor of this single global one. Confirm with the user before reintroducing per-card editing; don't assume the two requests are the same.

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

**Key layout fact, learned by shipping a version that looked broken and fixing it:** `.t09_1` is a CSS grid (5 columns in the observed layout), and each `.t09_bl` is exactly **one grid cell** containing a label line over a value line — it is not an independent full-width row. This matters a lot for anything appended here:

- A cell that isn't a real label/value pair doesn't fit the grid. An earlier version added a standalone "header" cell (just a label, no value) to introduce the appended section — it rendered as an orphaned label with a dangling empty gap underneath it (where its hidden value would have been), because the grid row's height is set by its tallest cell. **Don't reintroduce a header cell** — every appended `.t09_bl` must be a genuine label+value pair.
- `.val` may lay its children out with `justify-content: space-between` or similar (it's normally a single text node, so this is invisible on native fields). Giving `.val` two direct children — e.g. an `<input>` followed by a literal `%` — gets them shoved apart with a visible gap. If a future field needs more than one node inside `.val`, wrap them in a single child element first (this bit us once with an editable %-input-plus-"%"-text field; that field is gone now, but the gotcha applies to anything similar).

With that constraint respected, appended fields are individual `.t09_bl` cells (the exact class the site uses for every field), wrapped in a `div.tps-fields-group { display: contents; }` — the wrapper contributes no box of its own, so its `.t09_bl` children slot directly into `.t09_1`'s grid like native fields, inheriting the site's real `.lbl`/`.val` typography instead of a hand-guessed style (we don't have the site's actual CSS, so matching by reusing its classes is more reliable than trying to replicate colors/fonts).

**Distinguishability history — two approaches were tried and dropped before landing on the current one:**
1. Per-cell marker icons ("⚡"/"✎" spans with `title` tooltips) on every label, plus a `box-shadow: inset` accent bar and a `border-top` on every appended cell. Removed on request — it read as visual noise/a rendering glitch (the accent bar in particular appeared on the "wrong" side at grid-cell boundaries), and per-cell borders pieced together into an uneven line rather than a clean one.
2. What's used now: **one single full-width divider**, `.tps-divider` (`grid-column: 1 / -1`, a plain `border-top` in a neutral gray — not the extension's own accent color, so it reads as an ordinary section rule rather than a branded element), inserted once as the first child of `.tps-fields-group`. `grid-column: 1 / -1` spans from the grid's first line to its last regardless of the actual column count, so it doesn't hardcode "5 columns" anywhere. No icons, no tooltips, no per-cell decoration — the divider alone marks where native fields end and appended ones begin.

If you're asked to make this "more distinguishable" again, prefer adjusting the divider (thickness/color/spacing) over reintroducing per-cell decoration — that's the part that kept looking broken.

**Column alignment nudge:** appended cells rendered slightly left of the native columns above them (`.tps-fields-group > .t09_bl { margin-left: 6px; }` in `content.css`). This is an *empirical* fix, not a principled one — without the site's real CSS there's no way to know the exact root cause (a good guess: native `.t09_bl` cells may carry some inner structure/padding this extension's plain-div cells don't reproduce). If TraderPRO's layout changes and this starts looking off again, re-measure and adjust the `6px` rather than assuming it's still correct.

A follow-up request to instead right-align the appended cells' text (`text-align: right` on `.lbl`/`.val`) was tried and then explicitly reverted back to this `margin-left` approach — don't reintroduce the text-align version without checking that it's actually wanted again.

## Inline popup editing — the ONLY place accountBalance and positionPercentOverride are set

Both `accountBalance` and `positionPercentOverride` are edited **exclusively** in the popup header (`accountBalanceInput` and `positionPercentInput` in `popup/popup.html`, stacked in `.tps-header-main`) — there is deliberately no balance or global-%-override field on the Options page (`options/options.html`/`options.js` only handle `accountCurrency` and rounding). If you're asked to add either somewhere else (Options, or — for the %-override — per-signal on the injected page), check first whether the intent is really "another place" or "move it back": both were explicitly consolidated to this single popup location on request. `popup.js`:

- `bindBalanceInput()` auto-focuses and selects `accountBalanceInput` on popup open, so opening the popup (one click) is enough to start typing a new balance — no second click to find/enter an edit field. `bindPositionPercentInput()` does the equivalent for `positionPercentInput` (same debounce/save/indicator pattern) but does **not** auto-focus — balance is the field that changes daily, the % override doesn't.
- Both debounce (300ms) writes through `TPS.storage.setSettings({...})`, mutate the shared in-memory `settings` object in place (the same object reference is threaded through the whole render chain — `buildSignalItem` → `loadAndRenderSignal` → `renderResult` — so later calls automatically see the new value), and re-render every currently-displayed signal from a `renderedItems` array (`{item, state}` pairs pushed in `loadAndRenderSignal`) without refetching price/FX. The %-override handler additionally calls `updatePercentDisplay()` directly, since `renderResult()` only updates items whose quote/fx has already loaded.
- Because this goes through `chrome.storage.sync`, `content.js`'s `TPS.storage.onSettingsChanged` listener picks up both changes too — editing either field in the popup also live-updates the in-page injected cards on the TraderPRO tab, for free, via the existing settings-reactivity path.
- `options.js`'s `readFormAsPartialSettings()` deliberately omits both `accountBalance` and `positionPercentOverride` from the object it saves — `TPS.storage.setSettings()` merges partial updates onto existing settings, so omitting them there preserves whatever the popup last saved instead of stomping them back to whatever stale value the Options form last saw.

If you add another frequently-changing setting later, follow this same pattern (inline in the popup + `chrome.storage` propagation) rather than adding it to Options.

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
4. In the popup, edit the balance and confirm every card's totals update; edit the % override (set a number, then clear it back to empty) and confirm every card's "Позиция %" and totals switch between the override and each signal's own stated % accordingly. In Options, change currency/rounding and confirm already-rendered cards update.
5. Block `query1/query2.finance.yahoo.com` in DevTools' Network conditions to force the Stooq fallback path and confirm the "source: stooq" badge appears.
6. Open the popup and confirm it matches the in-page numbers.

## IBKR (do not implement without a design discussion)

Live brokerage balance sync is intentionally deferred. IBKR has no simple embeddable REST API — the realistic path is their **Client Portal Gateway**, a local app the user runs and authenticates through interactively, exposing `https://localhost:5000/v1/api/...`. This is architecturally different from the current keyless-public-API pattern (needs `host_permissions` for `localhost`, session/auth-refresh handling, a settings toggle for "manual" vs. "IBKR live" balance) and should reuse `shared/sizing.js` unchanged. Don't half-implement this — confirm the approach with the user first, same as was done for the rest of this extension's design.

## Where the original design rationale lives

The full architecture writeup (message contracts, build milestones, alternatives considered) was produced as a plan-mode document during initial development. This file and `README.md` are the durable summary — keep them updated as the source of truth going forward rather than relying on that session-local plan file.
