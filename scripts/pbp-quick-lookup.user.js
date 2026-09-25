// ==UserScript==
// @name         Pizza Boy Pro – Quick Lookup
// @namespace    https://pizzaboypro.de/
// @version      1.16.0
// @description  Highlight any item name on Neopets to see its itemdb price, check Trading Post instant-buy lots vs itemdb on demand, open the SSW with the name filled in, jump to your SDB, log past buys to the Tracker, watch lots and items, see what you own and paid (via the Tracker), or pop open a keypad calculator
// @author       Pizza Boy Pro
// @match        https://www.neopets.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      itemdb.com.br
// ==/UserScript==

(function () {
  'use strict';

  // ─── PUBLIC BUILD ──────────────────────────────────────────────────────────
  // Display only. The script never buys, bids, searches or submits anything
  // (its only click is opening the SSW panel), and never sends a request to
  // Neopets you didn't ask for:
  //   • Highlighting an item asks itemdb only
  //   • The Trading Post is checked when you press 🏝️ Check TP: one page, once
  //   • 🔍 SSW opens the Super Shop Wizard with the name typed in; you press Search

  // ─── CONSTANTS ─────────────────────────────────────────────────────────────
  const TOOLTIP_ID = 'idb-tooltip';
  const TP_API_URL = 'https://www.neopets.com/np-templates/ajax/island/tradingpost/tradingpost-list.php';
  const MIN_CHARS = 3;
  const MAX_CHARS = 80;
  // Highlighted lot numbers: "12345", "#12345", "Lot 12345", "lot #12345"
  const LOT_RE = /^(?:lot\s*(?:no\.?|number)?\s*)?#?\s*(\d{3,10})$/i;
  // TP search criteria value for "Lot Number". If the link lands on the wrong
  // search, do a Lot Number search by hand and copy the criteria= value here.
  const TP_LOT_CRITERIA = 'id';
  let hideTimer = null;
  let currentQuery = null;
  let lastX = 0, lastY = 0;

  // ─── INJECT STYLES ─────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500;700&display=swap');

    #idb-tooltip {
      position: fixed;
      z-index: 999999;
      /* Hidden = truly gone: no clicks caught, not focusable. Visibility
         flips after the fade-out so the animation still plays. */
      pointer-events: none;
      visibility: hidden;
      opacity: 0;
      transform: translateY(6px) scale(0.97);
      transition: opacity 0.18s ease, transform 0.18s ease, visibility 0s linear 0.18s;
      width: 300px;
    }

    #idb-tooltip.idb-visible {
      pointer-events: auto;
      visibility: visible;
      opacity: 1;
      transform: translateY(0) scale(1);
      transition: opacity 0.18s ease, transform 0.18s ease, visibility 0s;
    }

    #idb-tooltip .idb-card {
      background: #3a3a3a;
      border: 2px solid #1c1c1c;
      border-radius: 6px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.6), inset 0 0 0 1px #2c2c2c;
      font-family: 'Ubuntu', Arial, sans-serif;
      color: #dddddd;
      overflow: hidden;
    }

    /* amber title bar */
    #idb-tooltip .idb-titlebar {
      background: #e8a800;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-bottom: 2px solid #b07800;
    }
    #idb-tooltip .idb-tb-pizza { font-size: 12px; line-height: 1; }
    #idb-tooltip .idb-tb-name {
      color: #fff8dd;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      flex: 1;
    }
    /* pin indicator + close button (pinned = stays open when the mouse leaves) */
    #idb-tooltip .idb-tb-pin { display: none; font-size: 10px; line-height: 1; }
    #idb-tooltip.idb-pinned .idb-tb-pin { display: inline; }
    #idb-tooltip .idb-tb-close {
      background: none; border: none; padding: 0 0 0 4px; margin: 0;
      color: #7a5600; font-size: 13px; font-weight: 700; line-height: 1;
      cursor: pointer;
    }
    #idb-tooltip .idb-tb-close:hover { color: #fff8dd; }
    #idb-tooltip.idb-pinned .idb-card {
      max-height: calc(100vh - 24px);
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    #idb-tooltip .idb-tb-tag {
      color: #7a5600;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    /* dark screen body */
    #idb-tooltip .idb-body {
      background: #2c2c2c;
      padding: 10px 11px;
    }

    #idb-tooltip .idb-item-name {
      font-size: 14px;
      font-weight: 700;
      color: #ffd88a;
      margin-bottom: 8px;
      line-height: 1.25;
      word-break: break-word;
    }

    #idb-tooltip .idb-price-row {
      display: flex;
      align-items: baseline;
      gap: 5px;
      margin-bottom: 5px;
    }

    #idb-tooltip .idb-price {
      font-size: 22px;
      font-weight: 700;
      color: #ffaa00;
      line-height: 1;
    }

    #idb-tooltip .idb-np {
      font-size: 11px;
      color: #b07800;
      font-weight: 700;
      letter-spacing: 1px;
    }

    #idb-tooltip .idb-meta {
      font-size: 12px;
      color: #888888;
      margin-bottom: 8px;
      line-height: 1.4;
    }

    #idb-tooltip .idb-inflated {
      display: inline-block;
      background: #3a1614;
      border: 1px solid #7a2a22;
      border-radius: 3px;
      color: #e98b80;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 7px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    #idb-tooltip .idb-footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #444444;
    }

    #idb-tooltip .idb-link {
      font-size: 11px;
      color: #ffaa00;
      text-decoration: none;
      font-weight: 700;
      letter-spacing: 0.3px;
      transition: color 0.15s;
    }
    #idb-tooltip .idb-link:hover { color: #ffd88a; }

    #idb-tooltip .idb-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #999999;
      font-size: 13px;
    }

    #idb-tooltip .idb-spinner {
      width: 13px; height: 13px;
      border: 2px solid #444444;
      border-top-color: #e8a800;
      border-radius: 50%;
      animation: idb-spin 0.7s linear infinite;
      flex-shrink: 0;
    }

    @keyframes idb-spin {
      to { transform: rotate(360deg); }
    }

    #idb-tooltip .idb-error {
      color: #999999;
      font-size: 13px;
      line-height: 1.4;
    }

    #idb-tooltip .idb-not-found {
      color: #999999;
      font-size: 13px;
      line-height: 1.4;
    }

    #idb-tooltip .idb-rarity {
      font-size: 11px;
      color: #888888;
    }
    /* Trading Post price row */
    #idb-tooltip .idb-tp-row {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #444444;
      font-size: 12px;
      line-height: 1.4;
    }
    #idb-tooltip .idb-tp-label {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: #8a6a20;
      margin-bottom: 3px;
    }
    #idb-tooltip .idb-tp-price {
      font-size: 17px;
      font-weight: 700;
      color: #5fc48a;
      line-height: 1;
    }
    #idb-tooltip .idb-tp-np {
      font-size: 10px;
      color: #3a7a55;
      font-weight: 700;
      letter-spacing: 1px;
    }
    #idb-tooltip .idb-tp-lots {
      font-size: 11px;
      color: #888888;
      margin-top: 3px;
    }
    #idb-tooltip .idb-tp-lots a {
      color: #ffaa00;
      text-decoration: none;
      font-weight: 700;
    }
    #idb-tooltip .idb-tp-lots a:hover { color: #ffd88a; }
    #idb-tooltip .idb-tp-none {
      color: #999999;
      font-size: 12px;
    }
    #idb-tooltip .idb-tp-err {
      color: #e98b80;
      font-size: 12px;
    }
    #idb-tooltip .idb-tp-list {
      margin-top: 4px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    #idb-tooltip .idb-tp-lot {
      display: flex;
      align-items: baseline;
      gap: 6px;
      font-size: 11px;
      color: #bbbbbb;
    }
    #idb-tooltip .idb-tp-lot .idb-tp-lot-price {
      font-weight: 700;
      color: #dddddd;
      min-width: 78px;
      text-align: right;
    }
    #idb-tooltip .idb-tp-lot .idb-tp-lot-who {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #888888;
    }
    #idb-tooltip .idb-tp-lot a {
      color: #ffaa00;
      text-decoration: none;
      font-weight: 700;
    }
    #idb-tooltip .idb-tp-lot a:hover { color: #ffd88a; }
    #idb-tooltip .idb-tp-lot a.idb-seller {
      color: #cfcfcf;
      font-weight: 500;
    }
    #idb-tooltip .idb-tp-lot a.idb-seller:hover { color: #ffd88a; text-decoration: underline; }
    #idb-tooltip .idb-tp-lot a.idb-seller-ico {
      font-size: 10px;
      margin-left: 3px;
      opacity: 0.7;
    }
    #idb-tooltip .idb-tp-lot a.idb-seller-ico:hover { opacity: 1; }
    #idb-tooltip .idb-tp-lotid { color: #777777; }
    /* listing age tag: fresh < 1 day, stale > 14 days, seen = first-seen fallback */
    #idb-tooltip .idb-age {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      background: #444444;
      color: #cccccc;
      white-space: nowrap;
      cursor: help;
    }
    #idb-tooltip .idb-age.fresh { background: #1f4d2e; color: #7ee2a0; }
    #idb-tooltip .idb-age.stale { background: #333333; color: #777777; }
    #idb-tooltip .idb-age.seen  { background: transparent; border: 1px dashed #555555; color: #999999; }
    /* 👁 watch-this-lot toggle on TP rows */
    #idb-tooltip .idb-tp-watch {
      background: none;
      border: 1px solid #555555;
      border-radius: 3px;
      padding: 0 3px;
      font-size: 10px;
      line-height: 14px;
      cursor: pointer;
      opacity: 0.55;
      filter: grayscale(1);
    }
    #idb-tooltip .idb-tp-watch:hover { opacity: 1; filter: none; }
    #idb-tooltip .idb-tp-watch.on {
      opacity: 1;
      filter: none;
      background: #e8a800;
      border-color: #b07800;
    }
    #idb-tooltip .idb-hist {
      max-height: 340px;
      overflow-y: auto;
      overscroll-behavior: contain;
      margin: 8px -2px 0;
      padding: 0 2px 4px;
      border-top: 1px solid #2c2c2c;
      scrollbar-width: thin;
      scrollbar-color: #e8a800 #2c2c2c;
    }
    #idb-tooltip .idb-hist-h {
      font-size: 11px;
      font-weight: 700;
      color: #e8a800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 10px 0 2px;
    }
    #idb-tooltip .idb-hist .idb-tp-lot-price { min-width: 70px; }
    #idb-tooltip .idb-when {
      font-size: 10px;
      color: #777777;
      white-space: nowrap;
    }
    #idb-tooltip .idb-tag {
      font-size: 9px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      white-space: nowrap;
    }
    #idb-tooltip .idb-tag.sold   { background: #2e4a5a; color: #9fd0ea; }
    #idb-tooltip .idb-tag.nobid  { background: #444444; color: #999999; }
    #idb-tooltip .idb-tag.nf     { background: #4a3a1a; color: #e8c070; }
    #idb-tooltip .idb-tag.bundle { background: #3f3552; color: #c8b4ec; cursor: help; }
    #idb-tooltip .idb-spark {
      display: block;
      width: 100%;
      height: 46px;
      margin-top: 4px;
      background: #2c2c2c;
      border-radius: 3px;
    }
    #idb-tooltip .idb-ssw-btn.hist { background: #5a5a5a; }
    #idb-tooltip .idb-pct {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
      white-space: nowrap;
    }
    #idb-tooltip .idb-pct.under { background: #1f4d2e; color: #7ee2a0; }
    #idb-tooltip .idb-pct.over  { background: #5a2323; color: #f0a0a0; }
    #idb-tooltip .idb-pct.even  { background: #444444; color: #cccccc; }
    /* Your stock row (from Trading Post Tracker snapshot) */
    #idb-tooltip .idb-own-row {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #444444;
      font-size: 12px;
      line-height: 1.45;
      color: #cccccc;
    }
    #idb-tooltip .idb-own-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    #idb-tooltip .idb-own-toggle {
      background: none;
      border: none;
      color: #ffaa00;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      padding: 0;
    }
    #idb-tooltip .idb-own-toggle:hover { color: #ffd88a; }
    #idb-tooltip .idb-own-line b { color: #ffffff; }
    #idb-tooltip .idb-own-pos { color: #7ee2a0; font-weight: 700; }
    #idb-tooltip .idb-own-neg { color: #f0a0a0; font-weight: 700; }
    #idb-tooltip .idb-own-detail {
      display: none;
      margin-top: 5px;
      font-size: 11px;
      color: #aaaaaa;
    }
    #idb-tooltip .idb-own-row.open .idb-own-detail { display: block; }
    #idb-tooltip .idb-own-sub {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 1px;
      text-transform: uppercase;
      color: #777777;
      margin: 4px 0 1px;
    }
    #idb-tooltip .idb-own-item {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    #idb-tooltip .idb-own-foot {
      font-size: 10px;
      color: #666666;
      margin-top: 4px;
    }
    #idb-tooltip .idb-tp-note {
      font-size: 10px;
      color: #888888;
      margin-top: 3px;
    }
    #idb-tooltip .idb-tp-loading {
      display: flex;
      align-items: center;
      gap: 7px;
      color: #999999;
      font-size: 12px;
    }
    /* Watch (item) status line + form */
    #idb-tooltip .idb-watch-line {
      margin-top: 6px;
      font-size: 11px;
      color: #cccccc;
    }
    #idb-tooltip .idb-watch-line b { color: #ffd88a; }
    #idb-tooltip .idb-watch-hit {
      display: inline-block;
      background: #e8a800;
      color: #2c2c2c;
      font-weight: 700;
      border-radius: 3px;
      padding: 0 5px;
    }
    #idb-tooltip .idb-watch-form {
      display: none;
      margin-top: 8px;
      padding: 7px 8px;
      background: #232323;
      border: 1px solid #444444;
      border-radius: 4px;
      font-size: 11px;
    }
    #idb-tooltip .idb-watch-form.open { display: block; }
    #idb-tooltip .idb-watch-form-row {
      display: flex;
      gap: 4px;
      align-items: center;
      margin-top: 5px;
    }
    #idb-tooltip .idb-watch-target {
      flex: 1;
      min-width: 0;
      background: #2c2c2c;
      border: 1px solid #555555;
      border-radius: 3px;
      color: #dddddd;
      font-family: 'Ubuntu', Arial, sans-serif;
      font-size: 11px;
      padding: 3px 5px;
    }
    #idb-tooltip .idb-watch-target:focus { outline: none; border-color: #e8a800; }
    #idb-tooltip .idb-ssw-btn {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      border: 1px solid #1c1c1c;
      border-radius: 3px;
      font-family: 'Ubuntu', Arial, sans-serif;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.3px;
      padding: 4px 7px;
      cursor: pointer;
      text-decoration: none;
      transition: filter 0.15s, transform 0.1s;
      white-space: nowrap;
      color: #ffffff;
    }
    #idb-tooltip .idb-ssw-btn.tp      { background: #b07800; }
    #idb-tooltip .idb-ssw-btn.tp-open { background: #7a5400; padding: 4px 5px; }
    #idb-tooltip .idb-ssw-btn.sw      { background: #3a6ea5; }
    #idb-tooltip .idb-ssw-btn.ah      { background: #6b4e9e; }
    #idb-tooltip .idb-ssw-btn.sdb     { background: #4a7a8c; }
    #idb-tooltip .idb-ssw-btn.ssw     { background: #2c8a5a; }
    #idb-tooltip .idb-ssw-btn.tracker { background: #b35400; }
    #idb-tooltip .idb-ssw-btn.watch   { background: #3d6b4f; }
    #idb-tooltip .idb-ssw-btn.watch.on { background: #e8a800; color: #2c2c2c; }
    #idb-tooltip .idb-ssw-btn.unwatch { background: #6b3a3a; }
    #idb-tooltip .idb-ssw-btn.calc    { background: #4d4d4d; padding: 4px 5px; }
    #idb-tooltip .idb-ssw-btn:disabled { opacity: 0.6; cursor: default; transform: none; }
    #idb-tooltip .idb-ssw-btn:hover {
      filter: brightness(1.15);
      transform: translateY(-1px);
    }

    /* ── 🧮 Calculator (standalone keypad box, one per click, nothing saved) ── */
    .idb-calc {
      position: fixed;
      z-index: 1000000;
      width: 212px;
      background: #3a3a3a;
      border: 2px solid #1c1c1c;
      border-radius: 6px;
      box-shadow: 0 8px 28px rgba(0,0,0,0.6), inset 0 0 0 1px #2c2c2c;
      font-family: 'Ubuntu', Arial, sans-serif;
      color: #dddddd;
      overflow: hidden;
      outline: none;
      user-select: none;
    }
    .idb-calc:focus-within, .idb-calc:focus { border-color: #b07800; }
    .idb-calc .idb-calc-bar {
      background: #e8a800;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-bottom: 2px solid #b07800;
      cursor: move;
    }
    .idb-calc .idb-calc-title {
      color: #fff8dd;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      flex: 1;
    }
    .idb-calc .idb-calc-close {
      background: none; border: none; padding: 0 0 0 4px; margin: 0;
      color: #7a5600; font-size: 13px; font-weight: 700; line-height: 1;
      cursor: pointer;
    }
    .idb-calc .idb-calc-close:hover { color: #fff8dd; }
    .idb-calc .idb-calc-body {
      background: #2c2c2c;
      padding: 8px;
    }
    .idb-calc .idb-calc-screen {
      background: #1e1e1e;
      border: 1px solid #444444;
      border-radius: 4px;
      padding: 5px 8px 6px;
      margin-bottom: 8px;
      text-align: right;
    }
    .idb-calc .idb-calc-expr {
      font-size: 12px;
      color: #999999;
      min-height: 15px;
      line-height: 15px;
      word-break: break-all;
    }
    .idb-calc .idb-calc-res {
      font-size: 22px;
      font-weight: 700;
      color: #ffaa00;
      line-height: 1.2;
      min-height: 26px;
      word-break: break-all;
      cursor: pointer;
    }
    .idb-calc .idb-calc-res.preview { color: #8a6a20; }
    .idb-calc .idb-calc-keys {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 5px;
    }
    .idb-calc .idb-calc-key {
      font-family: 'Ubuntu', Arial, sans-serif;
      font-size: 15px;
      font-weight: 700;
      padding: 8px 0;
      border: 1px solid #1c1c1c;
      border-radius: 4px;
      background: #4a4a4a;
      color: #ffffff;
      cursor: pointer;
      transition: filter 0.1s, transform 0.05s;
    }
    .idb-calc .idb-calc-key:hover { filter: brightness(1.2); }
    .idb-calc .idb-calc-key:active,
    .idb-calc .idb-calc-key.pressed { filter: brightness(1.4); transform: translateY(1px); }
    .idb-calc .idb-calc-key.fn   { background: #5a5a5a; color: #ffd88a; }
    .idb-calc .idb-calc-key.op   { background: #b07800; }
    .idb-calc .idb-calc-key.eq   { background: #e8a800; color: #2c2c2c; }
    .idb-calc .idb-calc-key.zero { grid-column: span 2; }
  `;
  document.head.appendChild(style);

  // ─── CREATE TOOLTIP ELEMENT ─────────────────────────────────────────────────
  const tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.innerHTML = '<div class="idb-card"></div>';
  document.body.appendChild(tooltip);

  function getCard() { return tooltip.querySelector('.idb-card'); }

  // ─── POSITION TOOLTIP ───────────────────────────────────────────────────────
  function positionTooltip(x, y) {
    if (isPinned()) { refitTooltip(); return; } // pinned cards stay put
    const margin = 12;
    const tw = 320;
    const th = tooltip.offsetHeight || 120;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + margin;
    let top = y + margin;

    // Flip left if too close to right edge
    if (left + tw > vw - margin) left = x - tw - margin;
    // Flip up if too close to bottom
    if (top + th > vh - margin) top = y - th - margin;

    // Clamp
    left = Math.max(margin, left);
    top = Math.max(margin, top);

    tooltip.style.left = left + 'px';
    tooltip.style.top = top + 'px';
  }

  // ─── SHOW / HIDE ────────────────────────────────────────────────────────────
  function showTooltip(x, y) {
    lastX = x; lastY = y;
    clearTimeout(hideTimer);
    tooltip.classList.add('idb-visible');
    positionTooltip(x, y);
  }

  function isShown() { return tooltip.classList.contains('idb-visible'); }
  function isPinned() { return tooltip.classList.contains('idb-pinned'); }

  // Pinned: ignore mouse-leave and page scroll. Only an outside click, Esc or ✕ closes it.
  function pinTooltip() {
    if (!isShown()) return;
    clearTimeout(hideTimer);
    tooltip.classList.add('idb-pinned');
  }

  // Keep the card where it is, just nudge it back inside the window if it
  // has grown past an edge (e.g. History opened). No flipping, so it doesn't
  // jump away from the cursor.
  function refitTooltip() {
    const margin = 12;
    const rect = tooltip.getBoundingClientRect();
    let top = rect.top, left = rect.left;
    if (rect.bottom > window.innerHeight - margin) top = window.innerHeight - margin - rect.height;
    if (rect.right > window.innerWidth - margin) left = window.innerWidth - margin - rect.width;
    tooltip.style.top = Math.max(margin, top) + 'px';
    tooltip.style.left = Math.max(margin, left) + 'px';
  }

  function closeTooltip() {
    tooltip.classList.remove('idb-pinned');
    hideTooltip(0);
  }

  function hideTooltip(delay = 300) {
    clearTimeout(hideTimer);
    if (!isShown()) { currentQuery = null; return; } // already hidden, nothing to do
    if (isPinned()) return; // pinned cards only close via closeTooltip()
    hideTimer = setTimeout(() => {
      tooltip.classList.remove('idb-visible');
      currentQuery = null;
      // Park it off-screen once the fade has finished, so a stale box can
      // never sit over the page even if a style fails to apply.
      setTimeout(() => {
        if (!isShown()) { tooltip.style.left = '-10000px'; tooltip.style.top = '-10000px'; }
      }, 250);
    }, delay);
  }

  // Keep tooltip visible when hovering over it
  tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  tooltip.addEventListener('mouseleave', () => hideTooltip(300)); // no-op while pinned

  // Any click inside the card pins it; ✕ closes it.
  tooltip.addEventListener('mousedown', (e) => {
    if (e.target.closest('.idb-tb-close')) return;
    pinTooltip();
  });
  tooltip.addEventListener('click', (e) => {
    if (e.target.closest('.idb-tb-close')) { e.preventDefault(); closeTooltip(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isShown()) closeTooltip();
  });

  // ─── RENDER STATES ──────────────────────────────────────────────────────────
  function pbpHeader() {
    return `
      <div class="idb-titlebar">
        <span class="idb-tb-pizza">🍕</span>
        <span class="idb-tb-name">Pizza Boy Pro</span>
        <span class="idb-tb-pin" title="Pinned — stays open until you click outside, press Esc or ✕">📌</span>
        <span class="idb-tb-tag">itemdb</span>
        <button class="idb-tb-close" type="button" title="Close (Esc)">✕</button>
      </div>`;
  }

  function renderLoading(itemName) {
    getCard().innerHTML = `
      ${pbpHeader()}
      <div class="idb-body">
        <div class="idb-item-name">${escHtml(itemName)}</div>
        <div class="idb-loading">
          <div class="idb-spinner"></div>
          Looking up price…
        </div>
      </div>
    `;
  }

  function renderResult(data, itemName) {
    const card = getCard();

    if (!data || (!data.price && !data.name)) {
      card.innerHTML = `
        ${pbpHeader()}
        <div class="idb-body">
          <div class="idb-not-found">No results found for<br><em>${escHtml(itemName)}</em></div>
        </div>
      `;
      return;
    }

    const name = data.name || itemName;
    const price = data.price?.value;
    const inflated = data.price?.inflated;
    const rarity = data.rarity ? `r${data.rarity}` : '';
    const category = data.category || '';
    const slug = data.slug || encodeURIComponent(name);
    const link = `https://itemdb.com.br/item/${slug}`;

    // A watched item gets a free price snapshot every time it's looked up
    if (price) recordItemSnap(name, price);
    const watched = !!getWatch().items[itemKey(name)];

    const priceHtml = price
      ? `<div class="idb-price-row">
           <span class="idb-price">${formatNP(price)}</span>
           <span class="idb-np">NP</span>
         </div>`
      : `<div class="idb-meta">No price data available</div>`;

    const inflatedHtml = inflated
      ? `<div class="idb-inflated">⚠ Inflated Price</div>`
      : '';

    const metaParts = [rarity, category].filter(Boolean);
    const metaHtml = metaParts.length
      ? `<div class="idb-rarity">${escHtml(metaParts.join(' · '))}</div>`
      : '';

    const tpUrl = `https://www.neopets.com/island/tradingpost.phtml?type=browse&criteria=item_exact&search_string=${encodeURIComponent(name)}`;
    const swUrl = `https://www.neopets.com/shops/wizard.phtml?string=${encodeURIComponent(name)}`;
    const ahUrl = `https://www.neopets.com/genie.phtml?type=process_genie&criteria=exact&auctiongenie=${encodeURIComponent(name)}`;
    const sdbUrl = `https://www.neopets.com/safetydeposit.phtml?obj_name=${encodeURIComponent(name)}&category=0`;

    card.innerHTML = `
      ${pbpHeader()}
      <div class="idb-body">
        <div class="idb-item-name">${escHtml(name)}</div>
        ${inflatedHtml}
        ${priceHtml}
        ${metaHtml}
        <div class="idb-watch-slot">${renderWatchLine(name, price)}</div>
        ${renderOwned(name, price)}
        <div class="idb-tp-row" data-item="${escHtml(name)}"></div>
        <div class="idb-hist" data-item="${escHtml(name)}" style="display:none;"></div>
        <div class="idb-watch-form"></div>
        <div class="idb-watch-form idb-log-form"></div>
        <div class="idb-footer">
          <a class="idb-link" href="${link}" target="_blank" rel="noopener">itemdb ↗</a>
          <button class="idb-ssw-btn tp" data-item="${escHtml(name)}" title="Check Trading Post instant-buy lots (one search, only when you press it)">🏝️ Check TP</button>
          <a class="idb-ssw-btn tp-open" href="${tpUrl}" target="_blank" rel="noopener" title="Open Trading Post search">↗</a>
          <a class="idb-ssw-btn sw" href="${swUrl}" target="_blank" rel="noopener">🧙 SW</a>
          <a class="idb-ssw-btn ah" href="${ahUrl}" target="_blank" rel="noopener">🔨 AH</a>
          <a class="idb-ssw-btn sdb" href="${sdbUrl}" target="_blank" rel="noopener">🏦 SDB</a>
          <button class="idb-ssw-btn ssw" data-item="${escHtml(name)}" title="Open the Super Shop Wizard with this name typed in — press Search yourself">🔍 SSW</button>
          <button class="idb-ssw-btn hist" data-item="${escHtml(name)}" title="Auction, trade and price history from itemdb">📜 History</button>
          <button class="idb-ssw-btn watch${watched ? ' on' : ''}" data-item="${escHtml(name)}" title="Watch this item's price, with an optional target (shows in the Tracker's Watch tab)">👁 ${watched ? 'Watching' : 'Watch'}</button>
          <button class="idb-ssw-btn tracker" data-item="${escHtml(name)}" title="Queue a past purchase for the Tracker — it opens the Add form next time you're on the Trading Post">＋ Log Buy</button>
          <button class="idb-ssw-btn calc" type="button" title="Open a calculator">🧮</button>
        </div>
      </div>
    `;

    // Attach button events after render
    card.querySelector('.idb-ssw-btn.tp').addEventListener('click', () => renderTP(name, price));
    card.querySelector('.idb-ssw-btn.ssw').addEventListener('click', () => triggerSSW(name));
    card.querySelector('.idb-ssw-btn.tracker').addEventListener('click', () => toggleLogForm(name, price));
    card.querySelector('.idb-ssw-btn.hist').addEventListener('click', () => toggleHistory(name, price));
    card.querySelector('.idb-ssw-btn.watch').addEventListener('click', () => toggleWatchForm(name, price));
    card.querySelector('.idb-ssw-btn.calc').addEventListener('click', () => openCalc());
    const ownToggle = card.querySelector('.idb-own-toggle');
    if (ownToggle) ownToggle.addEventListener('click', () => {
      const row = card.querySelector('.idb-own-row');
      const open = row.classList.toggle('open');
      ownToggle.textContent = open ? '▾ hide' : '▸ details';
      refitTooltip();
    });

    // Public build: the Trading Post is only checked when you press 🏝️ Check TP.
    // A result from earlier this session is shown straight away (no new request).
    const cached = tpCache.get(name.toLowerCase());
    if (cached && Date.now() - cached.ts < TP_CACHE_TTL) showTPResult(name, price, cached.result);
  }

  // ─── YOUR STOCK (Trading Post Tracker bridge) ──────────────────────────────
  // The Tracker publishes a read-only snapshot of its log to localStorage
  // (GM storage is per-script, so this is the only shared channel). Unsold
  // lots = what you still hold; sold records = your realised trades.
  const HOLDINGS_KEY = 'np_tracker_holdings';

  function getHoldings(itemName) {
    try {
      const snap = JSON.parse(localStorage.getItem(HOLDINGS_KEY) || 'null');
      if (!snap || !snap.items) return null;
      const rec = snap.items[String(itemName).trim().toLowerCase()];
      return rec ? { ...rec, updated: snap.updated } : null;
    } catch { return null; }
  }

  function signedNP(n) {
    const cls = n > 0 ? 'idb-own-pos' : n < 0 ? 'idb-own-neg' : '';
    const txt = (n > 0 ? '+' : n < 0 ? '−' : '') + formatNP(Math.abs(n));
    return `<span class="${cls}">${txt} NP</span>`;
  }

  function shortDate(iso) {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleDateString() : '';
  }

  function renderOwned(itemName, idbPrice) {
    const rec = getHoldings(itemName);
    if (!rec || (!rec.lots.length && !rec.sales.length)) return '';

    const lines = [];
    const detail = [];

    // Held stock
    if (rec.lots.length) {
      const qty  = rec.lots.reduce((s, l) => s + l.qty, 0);
      const cost = rec.lots.reduce((s, l) => s + l.price * l.qty, 0);
      const avg  = Math.round(cost / qty);
      let pl = '';
      if (idbPrice) {
        const gain = idbPrice * qty - cost;
        const pct  = Math.round((idbPrice - avg) / avg * 100);
        pl = `<br>Worth ${formatNP(idbPrice * qty)} NP now · ${signedNP(gain)} (${pct > 0 ? '+' : ''}${pct}%)`;
      }
      lines.push(`<div class="idb-own-line">Holding <b>${qty}</b> · avg <b>${formatNP(avg)}</b> NP · ${formatNP(cost)} total${pl}</div>`);

      detail.push(`<div class="idb-own-sub">Held lots</div>`);
      for (const l of rec.lots) {
        detail.push(`<div class="idb-own-item"><span>${l.qty} × ${formatNP(l.price)} NP</span><span>${shortDate(l.date)}</span></div>`);
      }
    }

    // Sales history
    if (rec.sales.length) {
      const tot = rec.salesTotal || rec.sales.reduce((t, x) => ({
        count: t.count + 1,
        qty: t.qty + x.qty,
        profit: t.profit + (x.soldPrice - x.price) * x.qty
      }), { count: 0, qty: 0, profit: 0 });
      const shownQty  = rec.sales.reduce((s, x) => s + x.qty, 0);
      const avgBuy    = Math.round(rec.sales.reduce((s, x) => s + x.price * x.qty, 0) / shownQty);
      const avgSell   = Math.round(rec.sales.reduce((s, x) => s + x.soldPrice * x.qty, 0) / shownQty);
      const recentTag = rec.salesTotal ? ` (last ${rec.sales.length})` : '';
      lines.push(`<div class="idb-own-line">Sold <b>${tot.qty}</b> · bought avg ${formatNP(avgBuy)} → sold avg ${formatNP(avgSell)}${recentTag} · ${signedNP(tot.profit)}</div>`);

      detail.push(`<div class="idb-own-sub">Recent sales</div>`);
      for (const x of rec.sales) {
        const profit = (x.soldPrice - x.price) * x.qty;
        detail.push(`<div class="idb-own-item"><span>${x.qty} × ${formatNP(x.price)} → ${formatNP(x.soldPrice)}</span><span>${signedNP(profit)} · ${shortDate(x.soldDate)}</span></div>`);
      }
    }

    const age = rec.updated ? `Tracker log · synced ${timeAgo(rec.updated)}` : 'Tracker log';
    return `
      <div class="idb-own-row">
        <div class="idb-own-head">
          <div class="idb-tp-label">Your Stock</div>
          <button class="idb-own-toggle" type="button">▸ details</button>
        </div>
        ${lines.join('')}
        <div class="idb-own-detail">${detail.join('')}</div>
        <div class="idb-own-foot">${age}</div>
      </div>
    `;
  }

  // ─── WATCHLIST (shared with Trading Post Tracker) ──────────────────────────
  // localStorage.np_tp_watchlist = { v, updated, lots: {lotId: …}, items: {key: …} }
  // Quick Lookup adds/removes entries and records price snapshots for watched
  // items it happens to look up. The Tracker's 👁 Watch tab does the checking
  // (is the lot still listed, what did itemdb price it at, current item price).
  const WATCH_KEY = 'np_tp_watchlist';
  const WATCH_SNAP_MAX = 90;
  const WATCH_SNAP_GAP = 6 * 3600000;   // same price → one snapshot per 6h

  function itemKey(n) { return String(n).trim().toLowerCase(); }

  function getWatch() {
    try {
      const w = JSON.parse(localStorage.getItem(WATCH_KEY) || 'null');
      if (w && typeof w === 'object') return { ...w, v: 1, lots: w.lots || {}, items: w.items || {} };
    } catch {}
    return { v: 1, lots: {}, items: {} };
  }
  function saveWatch(w) {
    try {
      w.updated = new Date().toISOString();
      localStorage.setItem(WATCH_KEY, JSON.stringify(w));
      // Same-tab nudge for the Tracker (storage events only reach other tabs)
      document.dispatchEvent(new CustomEvent('pbp-watchlist-changed'));
      return true;
    } catch { return false; }
  }

  function recordItemSnap(name, price) {
    const w = getWatch();
    const rec = w.items[itemKey(name)];
    if (!rec || !price) return;
    const snaps = Array.isArray(rec.snaps) ? rec.snaps : [];
    const last = snaps[snaps.length - 1];
    const now = Date.now();
    if (last && last.v === price && now - last.t < WATCH_SNAP_GAP) return;
    snaps.push({ t: now, v: price });
    rec.snaps = snaps.slice(-WATCH_SNAP_MAX);
    rec.price = price;
    rec.checked = new Date(now).toISOString();
    saveWatch(w);
  }

  function renderWatchLine(name, price) {
    const rec = getWatch().items[itemKey(name)];
    if (!rec) return '';
    const bits = [];
    if (rec.target) {
      bits.push(price && price <= rec.target
        ? `<span class="idb-watch-hit">🔔 at/below target ${formatNP(rec.target)}</span>`
        : `target <b>${formatNP(rec.target)}</b> NP`);
    }
    if (rec.addedPrice && price) {
      const pct = Math.round((price - rec.addedPrice) / rec.addedPrice * 100);
      const cls = pct < 0 ? 'under' : pct > 0 ? 'over' : 'even';
      bits.push(`<span class="idb-pct ${cls}" title="vs ${formatNP(rec.addedPrice)} NP when you started watching">${pct > 0 ? '+' : ''}${pct}% since added</span>`);
    }
    return `<div class="idb-watch-line">👁 Watching${bits.length ? ' · ' + bits.join(' · ') : ''}</div>`;
  }

  function toggleWatchForm(name, price) {
    const card = getCard();
    const form = card.querySelector('.idb-watch-form:not(.idb-log-form)');
    if (!form) return;
    pinTooltip();
    if (form.classList.contains('open')) { form.classList.remove('open'); refitTooltip(); return; }
    const rec = getWatch().items[itemKey(name)];
    form.innerHTML = `
      <div class="idb-tp-label">${rec ? 'Watching this item' : 'Watch this item'}</div>
      <div class="idb-tp-note">Flag when the price drops to (NP), optional:</div>
      <div class="idb-watch-form-row">
        <input class="idb-watch-target" type="number" min="1" placeholder="${price ? 'e.g. ' + formatNP(Math.round(price * 0.85)).replace(/,/g, '') : 'Target NP'}" value="${rec && rec.target ? rec.target : ''}">
        <button class="idb-ssw-btn watch on idb-watch-save" type="button">${rec ? 'Update' : '👁 Watch'}</button>
        ${rec ? '<button class="idb-ssw-btn unwatch idb-watch-stop" type="button">Stop</button>' : ''}
      </div>`;
    form.classList.add('open');
    refitTooltip();
    const input = form.querySelector('.idb-watch-target');
    input.focus();
    const save = () => {
      const target = parseInt(input.value, 10) || null;
      const w = getWatch();
      const key = itemKey(name);
      const prev = w.items[key];
      const now = new Date().toISOString();
      w.items[key] = {
        ...(prev || {}),
        name,
        target,
        added: (prev && prev.added) || now,
        addedPrice: prev && prev.addedPrice != null ? prev.addedPrice : (price || null),
        price: price || (prev && prev.price) || null,
        snaps: (prev && prev.snaps) || (price ? [{ t: Date.now(), v: price }] : []),
        checked: price ? now : (prev && prev.checked) || null
      };
      saveWatch(w);
      refreshWatchUI(name, price);
    };
    form.querySelector('.idb-watch-save').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    const stop = form.querySelector('.idb-watch-stop');
    if (stop) stop.addEventListener('click', () => {
      const w = getWatch();
      delete w.items[itemKey(name)];
      saveWatch(w);
      refreshWatchUI(name, price);
    });
  }

  function refreshWatchUI(name, price) {
    const card = getCard();
    const slot = card.querySelector('.idb-watch-slot');
    if (slot) slot.innerHTML = renderWatchLine(name, price);
    const form = card.querySelector('.idb-watch-form:not(.idb-log-form)');
    if (form) form.classList.remove('open');
    const btn = card.querySelector('.idb-ssw-btn.watch');
    const watched = !!getWatch().items[itemKey(name)];
    if (btn) { btn.classList.toggle('on', watched); btn.textContent = watched ? '👁 Watching' : '👁 Watch'; }
    refitTooltip();
  }

  // 👁 on a TP lot row: snapshot the lot so the Tracker can follow it up later
  function toggleWatchLot(lot, itemName, idbPrice) {
    const w = getWatch();
    if (w.lots[lot.lotId]) { delete w.lots[lot.lotId]; saveWatch(w); return false; }
    w.lots[lot.lotId] = {
      lotId: lot.lotId,
      item: itemName,
      owner: lot.owner,
      link: lot.link,
      ibPrice: lot.price,
      idbAtSeen: idbPrice || null,
      wishlist: lot.wishlist || '',
      listedAt: lot.listedAt ? new Date(lot.listedAt).toISOString() : null,
      firstSeen: lot.firstSeen ? new Date(lot.firstSeen).toISOString() : null,
      seen: new Date().toISOString(),
      status: 'listed',
      checked: null
    };
    saveWatch(w);
    return true;
  }

  function renderError(itemName) {
    getCard().innerHTML = `
      ${pbpHeader()}
      <div class="idb-body">
        <div class="idb-error">Couldn't reach itemdb.<br>Check your connection.</div>
      </div>
    `;
  }

  function renderSessionExpired() {
    getCard().innerHTML = `
      ${pbpHeader()}
      <div class="idb-body">
        <div class="idb-error">itemdb session expired.<br>
          <a href="https://itemdb.com.br" target="_blank" rel="noopener" style="color:#ffaa00;">Open itemdb</a> to refresh it, then highlight again.</div>
      </div>
    `;
  }

  // ─── LOT NUMBER CARD ────────────────────────────────────────────────────────
  // A highlighted number is treated as a Trading Post lot number (e.g. from an
  // event message). Shows a card with a button that opens the TP lot search.
  function showLotCard(lotNum, x, y) {
    const key = 'lot:' + lotNum;
    if (currentQuery === key) return;
    currentQuery = key;
    const url = `https://www.neopets.com/island/tradingpost.phtml#/?type=browse&criteria=${TP_LOT_CRITERIA}&search_string=${encodeURIComponent(lotNum)}`;
    getCard().innerHTML = `
      ${pbpHeader()}
      <div class="idb-body">
        <div class="idb-item-name">Lot #${escHtml(lotNum)}</div>
        <div class="idb-meta">Trading Post lot number</div>
        <div class="idb-footer">
          <a class="idb-ssw-btn tp-open" href="${url}" target="_blank" rel="noopener" title="Search the Trading Post for this lot">🏝️ Search TP for lot ↗</a>
        </div>
      </div>
    `;
    showTooltip(x, y);
  }

  // ─── FETCH FROM ITEMDB ──────────────────────────────────────────────────────
  function fetchPrice(itemName, x, y) {
    if (currentQuery === itemName) return; // Already fetching this
    currentQuery = itemName;

    renderLoading(itemName);
    showTooltip(x, y);

    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://itemdb.com.br/api/v1/items/${encodeURIComponent(itemName)}`,
      headers: { 'Accept': 'application/json' },
      onload: function(response) {
        if (currentQuery !== itemName) return; // Stale response
        if (response.status === 401) { renderSessionExpired(); positionTooltip(x, y); return; }
        try {
          const data = JSON.parse(response.responseText);
          renderResult(data, itemName);
          // Re-position after content change
          positionTooltip(x, y);
        } catch(e) {
          renderError(itemName);
        }
      },
      onerror: function() {
        if (currentQuery !== itemName) return;
        renderError(itemName);
      }
    });
  }

  // ─── TRADING POST INSTANT-BUY LOOKUP ────────────────────────────────────────
  // Same-origin POST to the Trading Post's own browse endpoint
  // (criteria=item_exact) — the same search the TP page makes when you search
  // it yourself. Public build: runs only when you press 🏝️ Check TP, and reads
  // the first page only. Results are cached for a few minutes so re-opening
  // the card doesn't search again.
  //
  //  • Separates single-item lots from bundle lots. A bundle's instant-buy
  //    price covers every item in it, so it is never shown as the item price.
  //  • Shows the cheapest TP_SHOW_LOTS single-item lots.
  const TP_SHOW_LOTS  = 5;
  const TP_CACHE_TTL  = 5 * 60 * 1000;   // 5 minutes
  const tpCache = new Map();             // key -> { ts, result }

  function pick(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    return undefined;
  }

  function tpPostPage(itemName, page) {
    return fetch(TP_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      credentials: 'include',
      body: JSON.stringify({
        type: 'browse',
        criteria: 'item_exact',
        search_string: itemName,
        sort: 'newest',
        page: page
      })
    })
      .then(res => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(data => {
        if (!data || data.success !== true) throw new Error('success=false');
        return data;
      });
  }

  // Does the response say there is another page after `page`?
  // Returns true / false, or null if the response has no pagination info.
  function tpHasMore(data, page) {
    const total = Number(pick(data, ['total_pages', 'totalPages', 'pages', 'page_count', 'pageCount', 'last_page', 'lastPage']));
    if (Number.isFinite(total) && total > 0) return page < total;
    const more = pick(data, ['has_more', 'hasMore', 'has_next', 'hasNext', 'more']);
    if (typeof more === 'boolean') return more;
    return null;
  }

  // Inspect a lot's contents. Returns { known, single, count }.
  //   known  = we found an item list in the lot and could judge it
  //   single = the lot is exactly one unit of this item
  function tpLotContents(lot, itemName) {
    const items = pick(lot, ['items', 'lot_items', 'lotItems', 'item_list', 'itemList', 'objects']);
    if (Array.isArray(items) && items.length) {
      const target = itemName.toLowerCase();
      let count = 0, allMatch = true;
      for (const it of items) {
        const qty = Number(pick(it, ['quantity', 'qty', 'amount', 'count'])) || 1;
        count += qty;
        const nm = String(pick(it, ['name', 'item_name', 'itemName', 'obj_name']) || '').toLowerCase();
        if (nm && nm !== target) allMatch = false;
      }
      return { known: true, single: count === 1 && allMatch, count };
    }
    const n = Number(pick(lot, ['item_count', 'itemCount', 'num_items', 'numItems', 'total_items']));
    if (Number.isFinite(n) && n > 0) return { known: true, single: n === 1, count: n };
    return { known: false, single: true, count: 1 };
  }

  // ─── LOT AGE ───────────────────────────────────────────────────────────────
  // The listing-date field isn't pinned yet, so: try likely names first, then
  // scan every field for something that reads as a plausible past date.
  // Neopets times without a zone are NST (US Pacific).
  const LOT_DATE_KEYS = ['created_at', 'createdAt', 'date_created', 'dateCreated', 'created', 'creation_date',
    'date_listed', 'listed_at', 'listedAt', 'list_date', 'date_posted', 'posted_at', 'time_created',
    'date_added', 'added_at', 'start_date', 'timestamp', 'date', 'time'];
  const LOT_DATE_SKIP = /expir|end|updat|modif|last|close|finish/i;
  const LOT_DATE_HINT = /creat|list|post|date|time|added|start|stamp/i;
  const LOT_SEEN_KEY = 'np_tp_lot_seen';   // localStorage: { lotId: first-seen ms } — fallback only
  const LOT_SEEN_MAX = 4000;

  function nstToMs(y, mo, d, h, mi, s) {
    const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0);
    try {
      const la  = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
      const utc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
      return guess + (utc - la);
    } catch { return guess + 8 * 3600000; }
  }
  function parseWhen(v) {
    if (v === undefined || v === null || v === '' || typeof v === 'boolean') return NaN;
    const s = String(v).trim();
    if (/^\d{9,13}$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n; }
    if (typeof v === 'number') return NaN;
    // Zone-less "YYYY-MM-DD HH:MM[:SS]" → NST
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) return nstToMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
    // "MM/DD/YYYY [HH:MM[:SS] [am|pm]]" → NST
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
    if (m) {
      let h = +m[4] || 0;
      if (m[7]) { const pm = /pm/i.test(m[7]); if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
      return nstToMs(+m[3], +m[1], +m[2], h, +m[5], +m[6]);
    }
    return /\d{4}/.test(s) ? Date.parse(s) : NaN;   // ISO with zone, "Sep 20, 2026 …", etc.
  }
  const plausible = ms => Number.isFinite(ms) && ms > Date.UTC(2005, 0, 1) && ms < Date.now() + 86400000;

  function findLotDate(lot) {
    if (!lot || typeof lot !== 'object') return null;
    const tryKey = (k) => { const ms = parseWhen(lot[k]); return plausible(ms) ? { ms, key: k } : null; };
    for (const k of LOT_DATE_KEYS) if (k in lot) { const r = tryKey(k); if (r) return r; }
    for (const k of Object.keys(lot)) {
      if (LOT_DATE_SKIP.test(k) || !LOT_DATE_HINT.test(k)) continue;
      const r = tryKey(k); if (r) return r;
    }
    return null;
  }

  function getLotSeen() {
    try { return JSON.parse(localStorage.getItem(LOT_SEEN_KEY) || '{}') || {}; } catch { return {}; }
  }
  // Remember when we first saw each lot id; returns the map
  function noteLotsSeen(ids) {
    const seen = getLotSeen();
    const now = Date.now();
    let changed = false;
    for (const id of ids) if (id && !seen[id]) { seen[id] = now; changed = true; }
    if (changed) {
      let entries = Object.entries(seen);
      if (entries.length > LOT_SEEN_MAX) {
        entries = entries.sort((a, b) => b[1] - a[1]).slice(0, LOT_SEEN_MAX);
      }
      try { localStorage.setItem(LOT_SEEN_KEY, JSON.stringify(Object.fromEntries(entries))); } catch {}
      return Object.fromEntries(entries);
    }
    return seen;
  }

  function ageText(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
    if (s < 86400) return Math.round(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  // Age tag for a lot: real listing date if the TP gave one, else "first seen" (≥1h only)
  function ageTag(l) {
    if (l.listedAt) {
      const age = Date.now() - l.listedAt;
      const cls = age < 86400000 ? 'fresh' : age > 14 * 86400000 ? 'stale' : '';
      return `<span class="idb-age ${cls}" title="Listed ${escHtml(new Date(l.listedAt).toLocaleString())}">${ageText(l.listedAt)}</span>`;
    }
    if (l.firstSeen && Date.now() - l.firstSeen >= 3600000) {
      return `<span class="idb-age seen" title="Listing date not in the TP data — you first saw this lot ${escHtml(new Date(l.firstSeen).toLocaleString())}">≥${ageText(l.firstSeen)}</span>`;
    }
    return '';
  }

  function tpLotInfo(lot, itemName) {
    const c = tpLotContents(lot, itemName);
    const when = findLotDate(lot);
    return {
      listedAt: when ? when.ms : null,
      price: Number(lot.instant_buy_amount || 0),
      link: tpLotUrl(lot.link),
      owner: String(pick(lot, ['owner', 'username', 'user', 'seller', 'owner_name']) || ''),
      lotId: String(pick(lot, ['lot_id', 'lotId', 'lot_number', 'id']) || ''),
      wishlist: String(pick(lot, ['wishlist', 'wish_list', 'wishList']) || ''),
      known: c.known,
      single: c.single,
      count: c.count
    };
  }

  // One page, one request — only ever called from the 🏝️ Check TP button
  async function tpFetch(itemName) {
    const data = await tpPostPage(itemName, 1);
    const lots = Array.isArray(data.lots) ? data.lots : [];
    const more = tpHasMore(data, 1);

    const ib = lots
      .map(l => tpLotInfo(l, itemName))
      .filter(l => l.price > 0)
      .sort((a, b) => a.price - b.price);

    const seenMap = noteLotsSeen(ib.map(l => l.lotId));
    for (const l of ib) l.firstSeen = seenMap[l.lotId] || null;

    const singles = ib.filter(l => l.single);
    const result = {
      anyDated: ib.some(l => l.listedAt),
      totalLots: lots.length,
      ibCount: ib.length,
      singles: singles.slice(0, TP_SHOW_LOTS),
      singleCount: singles.length,
      bundleCount: ib.length - singles.length,
      contentsKnown: ib.every(l => l.known),
      morePages: more === true
    };

    tpCache.set(itemName.toLowerCase(), { ts: Date.now(), result });
    return result;
  }

  function tpLotUrl(link) {
    const l = String(link || '');
    if (!l) return '';
    if (l.startsWith('//')) return 'https:' + l;
    if (l.startsWith('http')) return l;
    return 'https://www.neopets.com' + l.replace(/^\/+/, '/');
  }

  // Seller name → profile, plus quick links to their trades and auctions.
  // All open in new tabs.
  function sellerLinks(owner) {
    if (!owner) return '';
    const u = encodeURIComponent(owner);
    const profile  = `https://www.neopets.com/userlookup.phtml?user=${u}`;
    // TP is a Vue SPA that reads its search from the hash, not the query string.
    const trades   = `https://www.neopets.com/island/tradingpost.phtml#/?type=browse&criteria=owner&search_string=${u}`;
    const auctions = `https://www.neopets.com/genie.phtml?type=find_user&auction_username=${u}`;
    return `<a class="idb-seller" href="${profile}" target="_blank" rel="noopener" title="${escHtml(owner)}'s profile">${escHtml(owner)}</a>`
         + `<a class="idb-seller-ico" href="${trades}" target="_blank" rel="noopener" title="${escHtml(owner)}'s Trading Post lots">🏝️</a>`
         + `<a class="idb-seller-ico" href="${auctions}" target="_blank" rel="noopener" title="${escHtml(owner)}'s auctions">🔨</a>`;
  }

  // "-18%" badge vs the itemdb price. Green = cheaper than itemdb.
  function pctBadge(tpPrice, idbPrice) {
    if (!idbPrice || !tpPrice) return '';
    const pct = Math.round((tpPrice - idbPrice) / idbPrice * 100);
    const cls = pct < 0 ? 'under' : pct > 0 ? 'over' : 'even';
    const txt = pct > 0 ? `+${pct}%` : `${pct}%`;
    return `<span class="idb-pct ${cls}" title="vs itemdb ${formatNP(idbPrice)} NP">${txt}</span>`;
  }

  // 🏝️ Check TP pressed: search once (or reuse a result from the last few minutes)
  function renderTP(itemName, idbPrice) {
    const slot = getCard().querySelector('.idb-tp-row');
    if (!slot) return;
    pinTooltip();

    const cached = tpCache.get(itemName.toLowerCase());
    if (cached && Date.now() - cached.ts < TP_CACHE_TTL) { showTPResult(itemName, idbPrice, cached.result); return; }

    const btn = getCard().querySelector('.idb-ssw-btn.tp');
    if (btn) btn.disabled = true;
    slot.innerHTML = `
      <div class="idb-tp-label">Trading Post</div>
      <div class="idb-tp-loading"><div class="idb-spinner"></div>Checking lots…</div>
    `;
    refitTooltip();

    tpFetch(itemName)
      .then(r => showTPResult(itemName, idbPrice, r))
      .catch(() => {
        const live = getCard().querySelector('.idb-tp-row');
        if (!live || live.dataset.item !== itemName) return;
        live.innerHTML = `
          <div class="idb-tp-label">Trading Post</div>
          <div class="idb-tp-err">Couldn't reach the Trading Post.</div>
        `;
        refitTooltip();
      })
      .finally(() => {
        const b = getCard().querySelector('.idb-ssw-btn.tp');
        if (b) b.disabled = false;
      });
  }

  function showTPResult(itemName, idbPrice, r) {
    // Tooltip may have moved on to another item mid-flight.
    const live = getCard().querySelector('.idb-tp-row');
    if (!live || live.dataset.item !== itemName) return;

    let body;
    if (r.singles.length) {
      const best = r.singles[0];
      const watchedLots = getWatch().lots;
      const rows = r.singles.map(l => {
        const open = l.link ? `<a href="${escHtml(l.link)}" target="_blank" rel="noopener" title="Open lot">↗</a>` : '';
        const on = l.lotId && watchedLots[l.lotId];
        const watch = l.lotId
          ? `<button class="idb-tp-watch${on ? ' on' : ''}" type="button" data-lot="${escHtml(l.lotId)}" title="${on ? 'Watching — click to stop' : 'Watch this lot: see later if it went and what itemdb priced it at'}">👁</button>`
          : '';
        return `
          <div class="idb-tp-lot">
            <span class="idb-tp-lot-price">${formatNP(l.price)} NP</span>
            ${pctBadge(l.price, idbPrice)}
            <span class="idb-tp-lot-who">${sellerLinks(l.owner)}${l.lotId ? ' <span class="idb-tp-lotid">#' + escHtml(l.lotId) + '</span>' : ''}</span>
            ${ageTag(l)}
            ${watch}
            ${open}
          </div>`;
      }).join('');

      const notes = [];
      notes.push(`${r.singleCount} single-item IB lot${r.singleCount === 1 ? '' : 's'}`);
      if (r.bundleCount) notes.push(`${r.bundleCount} bundle${r.bundleCount === 1 ? '' : 's'} hidden`);
      if (r.morePages) notes.push(`first page only — ↗ opens the full search`);
      if (!r.contentsKnown) notes.push(`bundle check unverified`);
      if (!r.anyDated) notes.push(`listing date not in TP data — ≥ = first seen by you`);

      body = `
        <div>
          <span class="idb-tp-price">${formatNP(best.price)}</span>
          <span class="idb-tp-np">NP</span>
          ${pctBadge(best.price, idbPrice)}
          ${ageTag(best)}
        </div>
        <div class="idb-tp-list">${rows}</div>
        <div class="idb-tp-note">${escHtml(notes.join(' · '))}</div>
      `;
    } else if (r.bundleCount) {
      body = `<div class="idb-tp-none">Only bundle lots with instant-buy (${r.bundleCount}) — no single-item price</div>`;
    } else if (r.totalLots) {
      body = `<div class="idb-tp-none">${r.totalLots} lot${r.totalLots === 1 ? '' : 's'} listed, none with an instant-buy price</div>`;
    } else {
      body = `<div class="idb-tp-none">No lots on the Trading Post</div>`;
    }

    live.innerHTML = `<div class="idb-tp-label">Trading Post</div>${body}`;
    live.querySelectorAll('.idb-tp-watch').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const lot = r.singles.find(l => l.lotId === btn.dataset.lot);
        if (!lot) return;
        const on = toggleWatchLot(lot, itemName, idbPrice);
        btn.classList.toggle('on', on);
        btn.title = on ? 'Watching — click to stop' : 'Watch this lot: see later if it went and what itemdb priced it at';
      });
    });
    refitTooltip();
  }

  // ─── ITEMDB HISTORY PANEL (auctions · trades · price) ───────────────────────
  // Loaded only when 📜 History is clicked: the auction and trade endpoints are
  // metered per record returned, so nothing here runs on a plain highlight.
  // Responses are cached for the page session.
  const HIST_ROWS = 10;
  const histCache = new Map();   // key -> Promise<{auctions, trades, prices}>

  function idbGet(path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://itemdb.com.br/api/v1/items/${path}`,
        headers: { 'Accept': 'application/json' },
        onload: (res) => {
          if (res.status === 401) return reject(new Error('401'));
          if (res.status < 200 || res.status >= 300) return reject(new Error('HTTP ' + res.status));
          try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error('network'))
      });
    });
  }

  // Docs show these wrapped in an array; accept either shape.
  function unwrap(d) { return Array.isArray(d) ? (d[0] || null) : d; }

  // Each section settles on its own, so one failing endpoint doesn't blank the panel.
  function histFetch(itemName) {
    const key = itemName.toLowerCase();
    if (histCache.has(key)) return histCache.get(key);
    const enc = encodeURIComponent(itemName);
    const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
    const p = Promise.all([
      settle(idbGet(`${enc}/auction`).then(unwrap)),
      settle(idbGet(`${enc}/trades`).then(unwrap)),
      settle(idbGet(`${enc}/prices`))
    ]).then(([auctions, trades, prices]) => {
      // Don't cache failures, so a retry after refreshing the session works.
      if (!auctions.ok || !trades.ok || !prices.ok) histCache.delete(key);
      return { auctions, trades, prices };
    });
    histCache.set(key, p);
    return p;
  }

  function timeAgo(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 3600)   return Math.round(s / 60) + 'm ago';
    if (s < 86400)  return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 60) return Math.round(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  function histErr(r) {
    if (r.e && r.e.message === '401') {
      return `<div class="idb-tp-err">itemdb session expired — <a href="https://itemdb.com.br" target="_blank" rel="noopener">open itemdb</a> to refresh, then try again.</div>`;
    }
    return `<div class="idb-tp-err">Couldn't load this from itemdb.</div>`;
  }

  function renderAuctions(r, idbPrice) {
    let html = `<div class="idb-hist-h">🔨 Auctions</div>`;
    if (!r.ok) return html + histErr(r);
    const d = r.v || {};
    const recent = Array.isArray(d.recent) ? d.recent : [];
    const sum = [];
    if (d.total != null) sum.push(`${formatNP(d.total)} auctions`);
    if (d.sold != null) sum.push(`${formatNP(d.sold)} sold`);
    if (d.uniqueOwners != null) sum.push(`${formatNP(d.uniqueOwners)} sellers`);
    if (d.period) sum.push(String(d.period));
    if (sum.length) html += `<div class="idb-tp-note">${escHtml(sum.join(' · '))}</div>`;
    if (!recent.length) return html + `<div class="idb-tp-none">No recorded auctions</div>`;

    html += `<div class="idb-tp-list">` + recent.slice(0, HIST_ROWS).map(a => {
      const price = Number(a.price) || 0;
      const tags = [
        a.hasBuyer ? '<span class="idb-tag sold">sold</span>' : '<span class="idb-tag nobid">no bid</span>',
        a.isNF ? '<span class="idb-tag nf">NF</span>' : ''
      ].join('');
      return `
        <div class="idb-tp-lot">
          <span class="idb-tp-lot-price">${price ? formatNP(price) + ' NP' : '—'}</span>
          ${a.hasBuyer ? pctBadge(price, idbPrice) : ''}
          ${tags}
          <span class="idb-tp-lot-who">${sellerLinks(a.owner || '')}</span>
          <span class="idb-when">${escHtml(timeAgo(a.addedAt))}</span>
        </div>`;
    }).join('') + `</div>`;
    return html;
  }

  function renderTrades(r, itemName, idbPrice) {
    let html = `<div class="idb-hist-h">🏝️ Trades</div>`;
    if (!r.ok) return html + histErr(r);
    const d = r.v || {};
    const recent = Array.isArray(d.recent) ? d.recent : [];
    const sum = [];
    if (d.total != null) sum.push(`${formatNP(d.total)} trades`);
    if (d.priced != null) sum.push(`${formatNP(d.priced)} priced`);
    if (d.uniqueOwners != null) sum.push(`${formatNP(d.uniqueOwners)} sellers`);
    if (d.period) sum.push(String(d.period));
    if (sum.length) html += `<div class="idb-tp-note">${escHtml(sum.join(' · '))}</div>`;
    if (!recent.length) return html + `<div class="idb-tp-none">No recorded trades</div>`;

    const target = itemName.toLowerCase();
    html += `<div class="idb-tp-list">` + recent.slice(0, HIST_ROWS).map(t => {
      const items = Array.isArray(t.items) ? t.items : [];
      const mine = items.find(i => String(i.name || '').toLowerCase() === target);
      const price = mine && t.priced ? Number(mine.price) || 0 : 0;
      const others = Math.max(0, items.length - 1);
      const extra = others ? `<span class="idb-tag bundle" title="${escHtml(items.filter(i => i !== mine).map(i => i.name).join(', '))}">+${others}</span>` : '';
      const wish = t.wishlist ? ` title="Wishlist: ${escHtml(t.wishlist)}"` : '';
      return `
        <div class="idb-tp-lot"${wish}>
          <span class="idb-tp-lot-price">${price ? formatNP(price) + ' NP' : 'unpriced'}</span>
          ${price ? pctBadge(price, idbPrice) : ''}
          ${extra}
          <span class="idb-tp-lot-who">${sellerLinks(t.owner || '')}</span>
          <span class="idb-when">${escHtml(timeAgo(t.addedAt))}</span>
        </div>`;
    }).join('') + `</div>`;
    return html;
  }

  function renderPrices(r) {
    let html = `<div class="idb-hist-h">📈 Price history</div>`;
    if (!r.ok) return html + histErr(r);
    const pts = (Array.isArray(r.v) ? r.v : [])
      .map(p => ({ v: Number(p.value) || 0, t: Date.parse(p.addedAt), inf: !!p.inflated }))
      .filter(p => p.v > 0 && Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t);
    if (pts.length < 2) return html + `<div class="idb-tp-none">Not enough price history</div>`;

    const W = 264, H = 46, pad = 3;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
    const vals = pts.map(p => p.v);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const x = t => pad + (W - 2 * pad) * ((t - t0) / Math.max(1, t1 - t0));
    const y = v => H - pad - (H - 2 * pad) * ((v - lo) / Math.max(1, hi - lo));
    const line = pts.map(p => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const dots = pts.filter(p => p.inf)
      .map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="2.5" fill="#e06060"/>`).join('');

    const latest = pts[pts.length - 1];
    const cutoff = latest.t - 30 * 86400000;
    const old = [...pts].reverse().find(p => p.t <= cutoff);
    let change = '';
    if (old) {
      const pct = Math.round((latest.v - old.v) / old.v * 100);
      const cls = pct < 0 ? 'under' : pct > 0 ? 'over' : 'even';
      change = `<span class="idb-pct ${cls}">${pct > 0 ? '+' : ''}${pct}% / 30d</span>`;
    }

    html += `
      <svg class="idb-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <polyline points="${line}" fill="none" stroke="#e8a800" stroke-width="1.5"/>
        ${dots}
      </svg>
      <div class="idb-tp-note">
        low ${formatNP(lo)} · high ${formatNP(hi)} · ${pts.length} points since ${escHtml(new Date(t0).toLocaleDateString())}
        ${change}${pts.some(p => p.inf) ? ' · <span style="color:#e06060">●</span> inflated' : ''}
      </div>`;
    return html;
  }

  function toggleHistory(itemName, idbPrice) {
    const panel = getCard().querySelector('.idb-hist');
    if (!panel) return;
    pinTooltip(); // History always pins, even if opened via keyboard
    if (panel.style.display === 'block') {
      panel.style.display = 'none';
      refitTooltip();
      return;
    }
    panel.style.display = 'block';
    panel.innerHTML = `<div class="idb-tp-loading"><div class="idb-spinner"></div>Loading itemdb history…</div>`;
    refitTooltip();

    histFetch(itemName).then(h => {
      const live = getCard().querySelector('.idb-hist');
      if (!live || live.dataset.item !== itemName) return;
      live.innerHTML =
        renderAuctions(h.auctions, idbPrice) +
        renderTrades(h.trades, itemName, idbPrice) +
        renderPrices(h.prices);
      refitTooltip();
    });
  }

  // ─── 🧮 CALCULATOR ──────────────────────────────────────────────────────────
  // Each click on 🧮 opens a fresh, independent keypad calculator. Nothing is
  // saved: ✕ or Esc closes it for good. Drag it by the amber bar. Click the
  // keys or type on the keyboard (Enter/= to total, Backspace, C/Delete to
  // clear). After =, a digit starts a new sum and an operator carries on from
  // the answer. Click the answer (or Ctrl+C) to copy it without commas.
  // Keyboard/paste still accept k / m / b and brackets, e.g. "1.2m-850k".
  let calcCount = 0;

  function calcEval(src) {
    const s = String(src).toLowerCase()
      .replace(/,/g, '')
      .replace(/[x×]/g, '*')
      .replace(/÷/g, '/')
      .replace(/\s+/g, '');
    if (!s) return null;
    let i = 0;
    const peek = () => s[i];
    const fail = () => { throw new Error('bad'); };
    function num() {
      const m = s.slice(i).match(/^(\d+\.?\d*|\.\d+)([kmb])?/);
      if (!m) fail();
      i += m[0].length;
      let v = parseFloat(m[1]);
      if (m[2]) v *= { k: 1e3, m: 1e6, b: 1e9 }[m[2]];
      return v;
    }
    function factor() {
      if (peek() === '-') { i++; return -factor(); }
      if (peek() === '+') { i++; return factor(); }
      let v;
      if (peek() === '(') {
        i++;
        v = expr();
        if (peek() !== ')') fail();
        i++;
      } else v = num();
      while (peek() === '%') { i++; v /= 100; }
      return v;
    }
    function term() {
      let v = factor();
      while (peek() === '*' || peek() === '/') {
        const op = s[i++];
        const r = factor();
        v = op === '*' ? v * r : v / r;
      }
      return v;
    }
    function expr() {
      let v = term();
      while (peek() === '+' || peek() === '-') {
        const op = s[i++];
        const r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    const v = expr();
    if (i !== s.length || !Number.isFinite(v)) fail();
    return v;
  }

  function calcFmt(v) {
    return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  // Plain copy/carry value: rounded to 2dp, no commas
  function calcPlain(v) { return String(Math.round(v * 100) / 100); }

  // Internal "1200000-850000*3" → "1,200,000 − 850,000 × 3"
  function calcDisplay(expr) {
    return expr
      .replace(/\d+(\.\d*)?/g, (m) => {
        const [int, dec] = m.split('.');
        return Number(int).toLocaleString('en-US') + (dec !== undefined ? '.' + dec : '');
      })
      .replace(/\*/g, ' × ')
      .replace(/\//g, ' ÷ ')
      .replace(/\+/g, ' + ')
      .replace(/-/g, ' − ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const CALC_KEYS = [
    ['C', 'fn', 'C'], ['⌫', 'fn', 'back'], ['%', 'fn', '%'], ['÷', 'op', '/'],
    ['7', '', '7'], ['8', '', '8'], ['9', '', '9'], ['×', 'op', '*'],
    ['4', '', '4'], ['5', '', '5'], ['6', '', '6'], ['−', 'op', '-'],
    ['1', '', '1'], ['2', '', '2'], ['3', '', '3'], ['+', 'op', '+'],
    ['0', 'zero', '0'], ['.', '', '.'], ['=', 'eq', '=']
  ];

  function openCalc() {
    const box = document.createElement('div');
    box.className = 'idb-calc';
    box.tabIndex = 0;
    box.innerHTML = `
      <div class="idb-calc-bar" title="Drag to move">
        <span class="idb-tb-pizza">🧮</span>
        <span class="idb-calc-title">Calculator</span>
        <button class="idb-calc-close" type="button" title="Close (Esc)">✕</button>
      </div>
      <div class="idb-calc-body">
        <div class="idb-calc-screen">
          <div class="idb-calc-expr"></div>
          <div class="idb-calc-res" title="Click to copy">0</div>
        </div>
        <div class="idb-calc-keys">
          ${CALC_KEYS.map(([label, cls, k]) =>
            `<button class="idb-calc-key ${cls}" type="button" data-k="${escHtml(k)}">${label}</button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(box);

    // Start beside the lookup card if it's open, otherwise near the last cursor spot.
    const margin = 12;
    const offset = (calcCount++ % 6) * 18;
    const bw = box.offsetWidth || 216, bh = box.offsetHeight || 290;
    let left, top;
    if (isShown()) {
      const r = tooltip.getBoundingClientRect();
      left = r.right + 8 <= window.innerWidth - bw - margin ? r.right + 8 : r.left - bw - 8;
      top = r.top;
    } else {
      left = lastX + margin;
      top = lastY + margin;
    }
    left = Math.min(Math.max(margin, left + offset), window.innerWidth - bw - margin);
    top = Math.min(Math.max(margin, top + offset), window.innerHeight - bh - margin);
    box.style.left = left + 'px';
    box.style.top = top + 'px';

    const exprEl = box.querySelector('.idb-calc-expr');
    const resEl = box.querySelector('.idb-calc-res');

    let expr = '';        // internal form: digits . + - * / % (and k m b ( ) if typed)
    let done = false;     // just pressed =
    let lastExpr = '';    // the sum that produced the answer on screen
    let shown = null;     // number currently in the big display

    const tryEval = (s) => { try { const v = calcEval(s); return typeof v === 'number' ? v : null; } catch { return null; } };

    const render = () => {
      if (done) {
        exprEl.textContent = calcDisplay(lastExpr) + ' =';
        shown = tryEval(expr);
        resEl.className = 'idb-calc-res';
        resEl.textContent = shown === null ? 'Error' : calcFmt(shown);
        return;
      }
      exprEl.textContent = calcDisplay(expr);
      const v = tryEval(expr);
      const isSum = /[+\-*/%kmb(]/.test(expr.replace(/^-/, ''));
      if (!expr) {
        shown = 0; resEl.className = 'idb-calc-res'; resEl.textContent = '0';
      } else if (v !== null && isSum) {
        shown = v; resEl.className = 'idb-calc-res preview'; resEl.textContent = calcFmt(v);
      } else if (v !== null) {
        shown = v; resEl.className = 'idb-calc-res'; resEl.textContent = calcFmt(v);
      } else {
        resEl.className = 'idb-calc-res preview'; // incomplete (e.g. "5 +"): keep last preview
      }
    };

    const press = (k) => {
      const endsOp = /[+\-*/]$/.test(expr);
      if (k === 'C') { expr = ''; done = false; }
      else if (k === 'back') {
        if (done) { expr = ''; done = false; } else expr = expr.slice(0, -1);
      }
      else if (k === '=') {
        const v = tryEval(expr);
        if (v === null) return;
        lastExpr = expr;
        expr = calcPlain(v);
        done = true;
      }
      else if (/^[0-9.]$/.test(k)) {
        if (done) { expr = ''; done = false; }
        if (k === '.' && /\d*\.\d*$/.test(expr)) return;           // one dot per number
        if (k === '.' && !/\d$/.test(expr)) expr += '0';
        if (expr.length < 40) expr += k;
      }
      else if (/^[+\-*/]$/.test(k)) {
        done = false;
        if (!expr) { if (k === '-') expr = '-'; return render(); }
        if (endsOp) expr = expr.slice(0, -1);
        if (expr) expr += k;
      }
      else if (k === '%') {
        done = false;
        if (/[\d)kmb]$/.test(expr)) expr += '%';
      }
      else if (/^[kmb()]$/.test(k)) {                                // keyboard-only extras
        if (done && k !== '(') done = false;
        else if (done) { expr = ''; done = false; }
        expr += k;
      }
      render();
    };

    const flash = (k) => {
      const btn = box.querySelector(`.idb-calc-key[data-k="${CSS.escape(k)}"]`);
      if (!btn) return;
      btn.classList.add('pressed');
      setTimeout(() => btn.classList.remove('pressed'), 110);
    };

    const copy = () => {
      if (shown === null) return;
      try { navigator.clipboard.writeText(calcPlain(shown)); } catch (e) {}
      const was = exprEl.textContent;
      exprEl.textContent = 'copied ' + calcPlain(shown) + ' ✓';
      setTimeout(() => { if (exprEl.textContent.startsWith('copied ')) exprEl.textContent = was; }, 900);
    };

    const close = () => box.remove();

    // Keypad clicks (mousedown is swallowed so focus stays on the box for typing)
    box.querySelectorAll('.idb-calc-key').forEach(btn => {
      btn.addEventListener('mousedown', (e) => { e.preventDefault(); box.focus({ preventScroll: true }); });
      btn.addEventListener('click', () => press(btn.dataset.k));
    });
    resEl.addEventListener('click', copy);
    box.querySelector('.idb-calc-close').addEventListener('click', close);
    box.addEventListener('mousedown', (e) => {
      if (!e.target.closest('.idb-calc-key, .idb-calc-close')) box.focus({ preventScroll: true });
    });

    // Keyboard typing works too while the box is focused
    box.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(); }
        return; // leave Ctrl+V etc. to the paste handler / browser
      }
      const map = { Enter: '=', '=': '=', Backspace: 'back', Delete: 'C', c: 'C', C: 'C', x: '*', X: '*' };
      let k = map[e.key] || e.key;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (!/^([0-9.+\-*/%=]|C|back|[kmb()])$/.test(k)) return;
      e.preventDefault();
      e.stopPropagation();
      press(k);
      flash(k);
    });
    box.addEventListener('paste', (e) => {
      const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
      const clean = text.toLowerCase().replace(/,/g, '').replace(/[x×]/g, '*').replace(/÷/g, '/').replace(/−/g, '-')
        .replace(/[^0-9.+\-*/%kmb()]/g, '');
      if (!clean) return;
      e.preventDefault();
      if (done) { expr = ''; done = false; }
      expr = (expr + clean).slice(0, 40);
      render();
    });

    // Drag by the amber bar
    const bar = box.querySelector('.idb-calc-bar');
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.idb-calc-close')) return;
      e.preventDefault();
      box.focus({ preventScroll: true });
      const r = box.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        const l = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - r.width);
        const t = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - r.height);
        box.style.left = l + 'px';
        box.style.top = t + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up, true);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up, true);
    });

    render();
    box.focus({ preventScroll: true });
  }

  // ─── SSW (fill only) ────────────────────────────────────────────────────────
  // Opens the Super Shop Wizard widget and types the item name in. It does NOT
  // press Search — you do that yourself, so every search is your own click.
  function triggerSSW(itemName) {
    const sswEl = document.querySelector('#ssw__2020');

    // Check visibility via computed style (handles both inline and class-based hiding)
    function sswIsHidden() {
      if (!sswEl) return true;
      return window.getComputedStyle(sswEl).display === 'none';
    }

    // Open the widget if it's hidden
    if (sswIsHidden()) {
      const toggleBtn = document.querySelector('.navsub-ssw-icon__2020, [onclick*="toggleSSW"]');
      if (toggleBtn) toggleBtn.click();
      else {
        try { unsafeWindow.toggleSSW__2020(); } catch(e) {
          try { unsafeWindow.toggleSSW_2020(); } catch(e2) {}
        }
      }
    }

    // Poll until the input is present and the widget is open, then fill it in
    const start = Date.now();
    const poll = setInterval(() => {
      if (Date.now() - start > 6000) { clearInterval(poll); return; }

      const widget = document.querySelector('#ssw__2020');
      if (sswIsHidden()) return; // still closed

      // Try new widget input first, fall back to old standalone #searchstr
      const searchInput = (widget && widget.querySelector('#searchstr, input[type="text"]'))
                       || document.querySelector('#searchstr');
      if (!searchInput) return;
      clearInterval(poll);

      searchInput.value = itemName;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      searchInput.focus();
    }, 100);
  }

  // ─── TRACKER HANDOFF (＋ Log Buy) ───────────────────────────────────────────
  // For a past purchase that never reached the Tracker. A small form takes
  // price, qty and the date you bought it, then queues it in the shared inbox
  // and stays on the page. On the Trading Post the Tracker picks it up at once
  // (same-tab event); anywhere else, the Add form opens pre-filled next time
  // you load the Trading Post. A backdated buy lands in that day's P&L.
  const TRACKER_INBOX_KEY = 'np_tracker_inbox';

  function toDateInput(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  // Today → now; any other day → that day at 12:00 local
  function fromDateInput(val) {
    if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val) || val === toDateInput()) return new Date().toISOString();
    const [y, m, d] = val.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0).toISOString();
  }

  function toggleLogForm(name, price) {
    const card = getCard();
    const form = card.querySelector('.idb-log-form');
    if (!form) return;
    pinTooltip();
    if (form.classList.contains('open')) { form.classList.remove('open'); refitTooltip(); return; }
    const today = toDateInput();
    form.innerHTML = `
      <div class="idb-tp-label">Log a past purchase</div>
      <div class="idb-watch-form-row">
        <input class="idb-watch-target idb-log-price" type="number" min="0" placeholder="${price ? 'Paid (itemdb ' + formatNP(price) + ')' : 'Price paid (NP)'}" title="Price paid per item — leave blank to fill in later">
        <input class="idb-watch-target idb-log-qty" type="number" min="1" value="1" style="flex:0 0 42px" title="Quantity">
      </div>
      <div class="idb-watch-form-row">
        <input class="idb-watch-target idb-log-date" type="date" value="${today}" max="${today}" title="Date bought — sets which day's P&L it counts in" style="color-scheme:dark">
        <button class="idb-ssw-btn tracker idb-log-save" type="button">＋ Queue</button>
      </div>
      <div class="idb-tp-note">Opens pre-filled in the Tracker on the Trading Post for you to Save.</div>`;
    form.classList.add('open');
    refitTooltip();
    const priceEl = form.querySelector('.idb-log-price');
    priceEl.focus();
    const go = () => {
      const saveBtn = form.querySelector('.idb-log-save');
      const ok = sendToTracker(name, {
        price: parseInt(priceEl.value, 10) || null,
        qty: Math.max(1, parseInt(form.querySelector('.idb-log-qty').value, 10) || 1),
        date: fromDateInput(form.querySelector('.idb-log-date').value)
      });
      const btn = card.querySelector('.idb-ssw-btn.tracker:not(.idb-log-save)');
      if (btn) {
        btn.textContent = ok ? '✓ Queued for Tracker' : '⚠ Couldn\'t queue';
        btn.title = ok ? 'The Add form opens pre-filled next time you\'re on the Trading Post' : 'Browser storage unavailable';
      }
      if (ok) { form.classList.remove('open'); refitTooltip(); }
      else if (saveBtn) saveBtn.textContent = '⚠ Failed';
    };
    form.querySelector('.idb-log-save').addEventListener('click', go);
    form.querySelectorAll('input').forEach(i => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
  }

  function sendToTracker(itemName, opts) {
    const o = opts || {};
    const payload = [{ item: itemName, price: o.price || null, qty: o.qty || 1, date: o.date || new Date().toISOString(),
                       notes: 'Quick Lookup · logged ' + new Date().toLocaleDateString() }];
    let ok = true;
    try {
      const existing = JSON.parse(localStorage.getItem(TRACKER_INBOX_KEY) || '[]');
      localStorage.setItem(TRACKER_INBOX_KEY, JSON.stringify(existing.concat(payload)));
    } catch {
      try { localStorage.setItem(TRACKER_INBOX_KEY, JSON.stringify(payload)); } catch { ok = false; }
    }
    if (ok) document.dispatchEvent(new CustomEvent('pbp-tracker-inbox'));
    return ok;
  }

  // ─── SELECTION HANDLER ──────────────────────────────────────────────────────
  document.addEventListener('mouseup', function(e) {
    if (tooltip.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.idb-calc')) return; // typing/selecting in a calculator
    // Small delay to let the browser finalise the selection
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection) return;

      const text = selection.toString().trim();

      // Ignore if too short, too long, or contains newlines (probably not an item name)
      if (!text || text.length < MIN_CHARS || text.length > MAX_CHARS || text.includes('\n')) {
        if (isShown()) hideTooltip(150);
        return;
      }

      // Lot number (digits, optionally "#" or "Lot" in front) → TP lot card
      const lotMatch = text.match(LOT_RE);
      if (lotMatch) { showLotCard(lotMatch[1], e.clientX, e.clientY); return; }

      // Otherwise ignore if it's just numbers or punctuation
      if (!/[a-zA-Z]/.test(text)) {
        if (isShown()) hideTooltip(150);
        return;
      }

      fetchPrice(text, e.clientX, e.clientY);
    }, 100);
  });

  // Hide when clicking elsewhere (clicks in a calculator leave the card alone)
  document.addEventListener('mousedown', function(e) {
    if (!isShown()) return;
    if (e.target.closest && e.target.closest('.idb-calc')) return;
    if (!tooltip.contains(e.target)) {
      if (isPinned()) closeTooltip(); else hideTooltip(100);
    }
  });

  // Hide on page scroll (only when showing)
  document.addEventListener('scroll', () => { if (isShown()) hideTooltip(100); }, { passive: true });

  // ─── UTILITIES ──────────────────────────────────────────────────────────────
  function formatNP(n) { return Number(n).toLocaleString('en-US'); }
  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

})();
