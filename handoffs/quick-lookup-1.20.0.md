# Quick Lookup 1.18.0 – 1.20.0 — our own price list (handoff)

Script: `scripts/pbp-quick-lookup.user.js` (public build, also Ben's build). Nov 2026.

## What it does
- **Passive capture**: on Trading Post browse pages, one-item lots whose price per item is at or above a threshold (default 1m) are saved as you browse. A debounced MutationObserver (600 ms) plus `hashchange` reads `.tp-border-frame` boxes. Each box is marked with `data-pbp-lot` so a lot is read once (Vue reuses boxes between pages). Zero Neopets requests.
- Pages where the hash has `type=` other than `browse` (Your Trades, offers) are skipped, so Ben's own lots stay out. No `type=` counts as browse (assumed).
- **🏝️ Check TP**: `recordTPLots()` saves every one-item-type lot from the page it already fetched, at any price.
- **Sold prices**: read live from the Tracker's `np_tracker_holdings` sales (not copied). They count double.
- **Price source** (⚙ on the 🍕 Ours line): `idb` (itemdb only), `ours-first` (default: ours when weight ≥ minN within `days`), `ours-only` (no itemdb call; "Look up on itemdb" button when there's no data; falls back to all-time median if nothing is recent). Also passive on/off and threshold (`1m`, `500k`…).
- Our price = weighted median (sold ×2). Card shows an "ours" tag, with the itemdb price underneath when ours is used.
- **📜 History** starts with 🍕 Our prices: sparkline (amber IB, light yellow wishlist ask, green sold) and the last 8 entries with lot links.
- Wishlist asks count only when clear: marked ab/ib/bin, or a wishlist that's nothing but a price ("3.795 million NP"). c/o is ignored. Min 1,000.
- Highlighting a lot number does **not** save (removed by Ben's choice). It only shows 🏝️ Search TP for lot.
- **1.19.0 — auctions**: when 📜 History loads, sold auctions from itemdb's `/auction` response (`recent[]`: `price`, `hasBuyer`, `isNF`, `addedAt`) are saved as `k:'auc'` with the auction date as `t`, id `auc:<id>` (or `auc:<t>-<price>`). No-bid and NF auctions are skipped. They count double, like your sales. Ben chose save-on-History only: auctions are never fetched just for this, since itemdb meters that endpoint per record. A weekly background fetch was considered and deferred.

- 1.20.0 — graph hover: both 📜 History sparklines (🍕 Our prices and itemdb 📈 Price history) snap to the nearest point by date and show a readout with price and date. Ours adds kind (coloured), ×qty and time; itemdb adds "inflated". Clicking an Ours point from a TP lot opens that lot search. Built by `sparkWrap()` (points JSON in `data-spark`) plus delegated mousemove/mouseleave/click on the tooltip. No extra requests.

- 1.20.1 — ✉️ Neomail link after 🏝️ 🔨 in `sellerLinks()` (Check TP, History auctions/trades); skipped for itemdb-masked names (contain `*`).

## Storage
- `GM_getValue/GM_setValue('pbp_price_log')` = `{ v:1, items: { key: { name, u, e: [{ p, t, k:'ib'|'ask'|'auc', id, q }] } } }`. 50 entries per item, 5000 items max (least recently updated dropped). The 1.17.0 localStorage copy is migrated once and removed.
- `localStorage.pbp_price_settings` = `{ mode, minN, days, passive, minPx }`.
- New grants: `GM_getValue`, `GM_setValue`.

## Lot box markup (from Ben's paste, Nov 2026)
`.tp-border-frame` → `p.text-cafeteria` "Lot N"; item rows `.flex.gap-4` with `p.item-name-text`; `p.wishlist-text`; an "Instant Buy" `p` (not inside a button) whose parent holds `p.text-museo-bold` "3,795,000 NP". The lot search link uses `criteria=id`, now confirmed.

## Unverified
1. The quantity badge for lots holding several of one item (assumed digits inside the `.relative` next to the image). Otherwise rows are counted.
2. That the TP landing page (no `type=` in the hash) is a browse view.
3. Check TP response item field names (same `pick()` ladders as before).

## Not built / ideas
- Exporting or importing the price list.
- Tracker using our prices: deferred until the Tracker cleanup (Ben's choice: Quick Lookup only for now).
