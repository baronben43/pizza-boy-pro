# Handoff — Festival of Fears / Haunted Woods dailies auto (new script, v1.0.0)

**Status:** design agreed 24 Oct 2026, nothing built yet. Ben is collecting page HTML in one text file (one `=== PAGE NAME ===` header per page, DevTools *Copy → Outer HTML* of the main content only).

## Goal
A new standalone PBP userscript automating the Haunted Woods activities that earn Fright Track points (Festival of Fears 2026 runs to 31 Oct). Most are year-round dailies, so the script stays useful after the event.

## Activities (all in v1.0)
| # | Activity | Points (FAQ) | Plan |
|---|---|---|---|
| 1 | Esophagor quests | 15, no limit | Accept → price all food on SSW → buy → feed. Stops at a **daily quest count** (Ben's choice) |
| 2 | Brain Tree | 35, once/day | Accept → do **2 Esophagor quests** (one reveals year of death, one place) → submit within ~1 hour. Brain Tree's 2 Esophagor quests run even if that passes the Esophagor cap |
| 3 | Edna's quests | 10, 10/day | Same SSW flow as #1 (ingredients) |
| 4 | Grave Danger | 5 per end of visit | Send the **main pet's petpet** (Ben's choice, for now), check back when the timer ends, claim, resend |
| 5 | Deserted Fairground Scratchcards | 5, 5/day | Buy at the kiosk, scratch on the website (Companion App scratches don't count). Kiosk cooldown between buys → timed |
| 6 | Apple Bobbing | 10, once/day | One click |
| 7 | Test Your Strength | 10, 4/day | Unseen. Only automate if the page takes a plain submit |

Skipped: trivia, Wheel of Misfortune, Haunted Woods Hunt.

## Decisions (Ben's)
- New standalone script, own PBP panel (not inside the Auto Trainer)
- One **Run dailies** button running everything in order while the tab is open
- Esophagor stops at a daily quest count
- Max NP per item, **separate limits for Esophagor and Edna**
- Grave Danger petpet: the main pet's petpet for now
- Fright Track points tally in the panel
- SSW buying follows the Kitchen Quest rules — see `lib/ssw-buy.js` (price everything first, abandon if any item missing/over limit, 30m pause on SSW refusal)

## Build notes
- Reuse `lib/ssw-buy.js` (lifted from Auto Trainer 1.4.5 Kitchen Quest). The rest of the Trainer is in the project as `claude/Neopets_Auto_Trainer-1_4_5_user.js` — don't read it; it loads whole (~50k tokens). Patterns worth copying are summarised here: GM storage keys per feature, NST day key via `Intl.DateTimeFormat('en-CA', {timeZone:'America/Los_Angeles'})`, abort-aware sleeps/navigation, human delays + distraction pauses, Diagnose DOM button copying a dump to the clipboard, panel excluded from all DOM scans (`isOurs`), per-day ledgers.
- Neopets blocks Claude's browser: selectors are candidate ladders until Ben's HTML pastes / Diagnose DOM output pin them.
- Daily counters reset on NST.

## Sources
- Jellyneo, "Festival of Fears Live!" (23 Oct 2026) — activity list and point values
- The Daily Neopets, Brain Tree / Esophagor / Edna quest guides
