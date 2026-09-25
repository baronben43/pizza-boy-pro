# Pizza Boy Pro

Two Tampermonkey userscripts for Neopets traders: a price lookup and a Trading Post purchase tracker.

Both are display-only. They never buy, bid, search or submit anything for you, and they only send a request to Neopets when you press a button yourself. Everything they save stays in your own browser. The one outside site they talk to is [itemdb](https://itemdb.com.br), for prices.

As with any userscript, Neopets doesn't officially approve these, so use them at your own risk. They are built to stay well on the safe side.

## The scripts

### Quick Lookup
Highlight any item name anywhere on Neopets and a card pops up with:

- itemdb price, rarity and category
- auction, trade and price history (the History button)
- links to the Trading Post, Shop Wizard, Auction House and your SDB
- a Check TP button that shows the cheapest single-item Trading Post lots against the itemdb price
- an SSW button that opens the Super Shop Wizard with the name filled in (you press Search)
- a Watch button for tracking an item's price against a target
- what you hold and what you paid, if you use the Tracker
- a small calculator

### Trading Post Tracker
Logs what you buy and works out profit and loss.

- picks up Trading Post instant buys, accepted offers and user shop purchases automatically, and lets you add anything else by hand
- List or Grouped view: Grouped puts every purchase of the same item under one row that you can expand
- market value and unrealised P&L from itemdb
- a P&L tab by day, week, month, year or custom range
- an Offers tab that values the offers you've made
- a Watch tab for items and lots you're keeping an eye on
- CSV import and export, and an automatic backup

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Firefox or Chrome).
2. Open a script file in `scripts/` and click **Raw**. Tampermonkey will offer to install it.
3. The Tracker button shows up on the Trading Post. Quick Lookup works on every Neopets page.

The two scripts work fine on their own, but they're better together: Quick Lookup shows your Tracker holdings, and its Log Buy and Watch buttons feed into the Tracker.

## Notes

- itemdb prices need an itemdb session. If a lookup says the session has expired, open itemdb.com.br once and try again.
- Your data lives in Tampermonkey's storage for this browser. Use Export CSV in the Tracker to keep a copy.
