# Handoff — Festival of Fears / Haunted Woods dailies auto

**Script:** `scripts/personal/pbp-fof-dailies.user.js` — **v1.0.0** (24 Oct 2026). Built, syntax-checked and parse-tested against Ben's pasted HTML; **not yet run live**. Festival of Fears 2026 runs to 31 Oct; most activities are year-round dailies.

## What it does
One **▶ Run dailies** button (🎃 PBP Dailies, bottom-right on any `/halloween/` page) runs, in order:

| # | Activity | How | Status |
|---|---|---|---|
| 1 | Apple Bobbing | goes to `applebobbing.phtml?bobbing=1`; "already let you have a go…today" = done | pinned; **prize popup `#apple_bobbing_popup` unseen** |
| 2 | Test Your Strength | `GET /np-templates/ajax/process_strtest.php` (exactly what the hammer sends, no params), up to 4/day; reply `{height, score, message}` | pinned from `strtestH5.js` + Ben's popup ("You scored 5 out of 100", "You have won a Scary Soup!"); **limit reply unseen** (stops on any reply without "scored N") |
| 3 | Wheel of Misfortune | free daily spin only (skips if Cost > 0). Clicks `#wheelButtonSpin` (prize decided by `getResult.php` there), waits for `#clickToShowPrize`, clicks the canvas centre, reads `#spinMessage/#itemName` or `#failMessage` | pinned from `wheelgame.js` + pastes; canvas click untested live — falls back to "spun, prize not read" |
| 4 | Haunted Woods Hunt | reads `overlays` (5 items, fresh `key` per load) from the inline script, opens a random item's URL, logs the popup, repeats until "You may need a special item"; safety cap 10/day | pinned; **win popup unseen**. Check: Ben's first paste already showed the "special item" message — if it's always shown, the Hunt would never play |
| 5 | Grave Danger | sends the petpet chosen in the panel (click card → `button.select` → `#gd-selectppPopup2021 button.select`, confirm line must name the petpet); stores `GDActive.target` as return time; if the tab stays open, a mini-run comes back 1–3 min after return | send + timer pinned; **return/claim page unseen** — presses a button matching claim/collect (never cookie/NC), logs raw text, resends |
| 6 | Scratchcards | buys 1 at the kiosk (1,200 NP), tops up from the SSW to 5 scratchable cards (cheapest first, ticked cards only, max NP per card default 100k), scratches 6 random squares (`process_scratch.phtml?type=scratch&loc=1–9`) per card | kiosk, dropdown, squares, loss ("You sscratched the wrong thingss!!") pinned; **win page unseen** |
| 7 | Brain Tree | `#acceptquest` → reads `#person` → does 2 Esophagor quests → fills `#answer_1`/`#answer_2` (Firefox-safe setter, verified) → `#submit_brain_answer`; reward NP + item read | fully pinned |
| 8 | Esophagor | `#startquest` → price every item on SSW (re-roll a missing/over-limit slot up to 3× via `.esophagor-item-reroll`) → buy → reload → `#gotingredients` → reads reveal | fully pinned; **"done for today" text unseen** |
| 9 | Edna | same flow, no re-roll (abandons if any item missing/over limit) | fully pinned; **limit text unseen** |

## Decisions (Ben's)
- Standalone script, own PBP panel; one Run dailies button; run once a day
- Esophagor stops at a daily count (default 5); Brain Tree's 2 Esophagor quests run even past it
- Separate max NP per item for Esophagor and Edna (default 10,000 each); Edna daily count default 10 (points cap)
- Brain Tree answers come only from the Esophagor reveals (answers are random per quest — no lookup list). Year entered as number + era, no space: `33BN` (accepted live)
- Esophagor inventory alert (>60 items): Quickstock-deposit everything once; if the alert is still there, cancel the run
- Grave Danger petpet picked beforehand in the panel (dropdown filled from the GD page's petpet list); equipment ignored
- Scratchcards: tick which card types to buy; **never scratch Pustravanganza or Rotting Riches** (keep ticks, logged with itemdb value); no waiting on the kiosk cooldown — top up from the SSW instead (up to 100k/card is fine)
- Wheel: free daily spin only
- Prize log: every activity logs items, NP won, NP spent and Fright Track points; panel shows today, event total and net (won − spent); CSV export
- SSW buying follows Kitchen Quest rules (price everything first, abandon if anything's missing/over limit, ~30 min pause on SSW refusal, up to 5 shops + one re-search per item)

## Storage (GM)
`pbp_fof_settings`, `pbp_fof_run` (state machine incl. `buy` hop and `buyResult`), `pbp_fof_days` (per NST day: done flags, counts, Brain Tree answers, GD return time, scratch flags; 7 days kept), `pbp_fof_log` (prize log), `pbp_fof_itemdb` (24h cache), `pbp_fof_petpets`, `pbp_fof_livelog`, `pbp_fof_ui`.

## Safety nets
Per-activity visit guard (skips an activity that keeps reloading), "odd page" counters (an unrecognised page logs its text and moves on), shop buyer only acts on the shop it navigated to, Stop button aborts every wait.

## Next session — what to collect from Ben's first live run
1. **Diagnose DOM** (panel button, copies page + run state) on any step that misbehaves
2. Unseen pages: Grave Danger return/claim, Apple Bobbing prize popup, scratchcard win, Hunt win popup, Esophagor/Edna/Strength "done for today"
3. Confirm the Wheel canvas click opens the prize popup, and whether the Hunt "special item" message only appears once plays are used up

## Build notes
- SSW code is `lib/ssw-buy.js` inlined. Don't read the Auto Trainer (~50k tokens) — not needed.
- Neopets blocks Claude's browser; the public game JS on `images.neopets.com` (e.g. `strtestH5.js`, `wheelgame.js`) can be read with WebFetch.

## Sources
- Jellyneo, "Festival of Fears Live!" (23 Oct 2026); SunnyNeo Brain Tree guide; Neopets Wiki, Scratchcard (kiosk card list)
