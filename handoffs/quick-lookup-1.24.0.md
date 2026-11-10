# Quick Lookup 1.18.0 – 1.24.0 — our own price list (handoff)

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

- 1.21.0 — our price picks a method, shown as a tag ("ours · live TP / sold / low asks"):
  1. **live TP**: a 🏝️ Check TP within the 5-min cache where every priced single lot is IB (no wishlist-only single lots) → cheapest IB; the cheapest is skipped if >25% under the next. Stored as `result.live` in `tpCache`.
  2. **sold**: ≥ minN sold prices (your sales + `auc`) in `days` → weighted median of those.
  3. **low asks**: otherwise 25th percentile of IB + wishlist asks (Ben: wishlists must count, esp. 20m+ items where IB is rare).
  Old method (weighted median of everything) overpriced: overpriced lots sit unsold, so all-asks median ≈ middle of the asking range (Void Paint Brush: 1.4m vs live 1.1m). `refreshOursLine(name, canSwitch)` now updates the main price in place when ours is in use, and after Check TP redraws the card if ours newly qualifies.
  Hidden itemdb names (`tay***`): grey text, no links; if the prefix matches exactly one owner from this item's Check TP (`result.owners` → `knownSellers`), shows `≈fullname` with all links. Partial masks were never handled before (the Tracker only greys fully masked `*****`).

- 1.22.0 — Ben: 1.21.0's "cheapest IB" made Ours useless for judging a buy (lowest lot vs itself = 0%). Ours is now a **blend** (`blendOurPrice`): sold median × wSold (scaled by sales/minN), live TP floor × wLive, low-asks P25 × wAsks; missing parts share weight. Weights in ⚙ (`wSold/wLive/wAsks`, default 50/30/20) so Ben can tune on live items before we fix them. Ours line shows the parts, e.g. `1.12m (sold 1m · live 1.1m · asks 1.25m)`. Check TP % badges compare to ours when ours is the card price ("vs ours" in the title), else itemdb. Void Paint Brush: 1.12m with a fresh Check TP, 1.14m without. Being trialled over a couple of builds.

- 1.23.0 — after Highland Chia War Paint (Ours 16.6m from 2 overpriced lots vs itemdb 4.2m; real trades 4.0–5.5m):
  1. **live** needs ≥ `LIVE_MIN_LOTS` (3) single IB lots.
  2. **sold** reaches back `SOLD_LOOKBACK_DAYS` (90) at half weight (`e.dw`) when fewer than minN in `days`.
  3. **itemdb trades saved on 📜 History** (`recordTrades`): priced one-item, qty-1 trades → `k:'trd'` (counts as an ask), or `k:'gone'` (counts as a sale at weight 1 and as an ask) when a fresh Check TP doesn't list the lot (and the check covered that price: `!morePages || price <= maxPrice`). An existing `ib`/`trd` entry with the same id is upgraded to `gone`. Check TP result now carries `lotIds`, `maxPrice`. **Unverified:** the trade id field (`trade_id/tradeId/lot_id/lotId/id`); without an id, entries use `trd:<t>-<price>`, can't become `gone`, and can duplicate an `ib` entry.
  4. **⚠ warning** next to "itemdb X NP" when ours is >2× or <½ itemdb (`oursWarn`).
  Graph: trade = lavender, trade gone = teal. Test (HCWP): History + Check TP → 4.15m; History, no check → 4.55m; neither → 13.4m with ⚠ 3.2× itemdb.

- 1.24.0 — **Your Stock** "Worth" shows both itemdb and ours (gain/loss follows the card's price). **Quantity badge confirmed** (Ben's paste): `.item-count` inside the `.relative` beside the image — passive capture reads it first. **Posted date**: passive lots dated from "Posted N days/hours ago" (`postedAgo`, approximate) instead of when seen. **🏝️ Check TP lists multi-quantity lots of the one item** as "X NP each ×N" (badge vs per-item price); they are kept OUT of the live rate (Ben agreed: bulk lots price differently). Result carries `multis`, `multiCount`; `tpLotContents` returns `same`.

## Storage
- `GM_getValue/GM_setValue('pbp_price_log')` = `{ v:1, items: { key: { name, u, e: [{ p, t, k:'ib'|'ask'|'auc', id, q }] } } }`. 50 entries per item, 5000 items max (least recently updated dropped). The 1.17.0 localStorage copy is migrated once and removed.
- `localStorage.pbp_price_settings` = `{ mode, minN, days, passive, minPx }`.
- New grants: `GM_getValue`, `GM_setValue`.

## Lot box markup (from Ben's paste, Nov 2026)
`.tp-border-frame` → `p.text-cafeteria` "Lot N"; item rows `.flex.gap-4` with `p.item-name-text`; `p.wishlist-text`; an "Instant Buy" `p` (not inside a button) whose parent holds `p.text-museo-bold` "3,795,000 NP". The lot search link uses `criteria=id`, now confirmed.

## Unverified
1. ~~Quantity badge~~ confirmed in 1.24.0 (`.item-count`).
2. That the TP landing page (no `type=` in the hash) is a browse view.
3. Check TP response item field names (same `pick()` ladders as before).

## Not built / ideas
- Exporting or importing the price list.
- Tracker using our prices: deferred until the Tracker cleanup (Ben's choice: Quick Lookup only for now).
