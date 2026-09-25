// ==UserScript==
// @name         Pizza Boy Pro – Trading Post Tracker
// @namespace    https://pizzaboypro.de/
// @version      2.16.0
// @description  Track items you buy at the Trading Post and user shops for reselling, plus a watchlist for lots and items you didn't buy
// @author       Pizza Boy Pro
// @match        https://www.neopets.com/island/tradingpost.phtml*
// @match        https://www.neopets.com/browseshop.phtml*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      itemdb.com.br
// ==/UserScript==

(function () {
  // ─── PUBLIC BUILD ──────────────────────────────────────────────────────────
  // Display and bookkeeping only. The script never buys, bids, searches or
  // submits anything on Neopets, and never sends a request to Neopets you didn't ask for:
  //   • Trading Post lookups run one at a time, only when you press a button
  //   • itemdb lookups are spaced by a fixed, polite delay (no randomised timing)
  'use strict';

  function getPurchases() {
    const raw = GM_getValue('np_purchases', '[]');
    try { return JSON.parse(raw); } catch { return []; }
  }
  function savePurchases(arr) {
    GM_setValue('np_purchases', JSON.stringify(arr));
    publishHoldings(arr);
  }

  // ─── QUICK LOOKUP BRIDGE ───────────────────────────────────────────────────
  // GM storage is sandboxed per script, so itemdb Quick Lookup can't read
  // np_purchases. We publish a read-only snapshot to localStorage (shared by
  // every script on neopets.com) keyed by lowercased item name. Refreshed on
  // every save and whenever the Tracker loads. Quick Lookup never writes it.
  const HOLDINGS_KEY = 'np_tracker_holdings';
  const HOLDINGS_MAX_SALES = 20;   // most recent sales kept per item

  function publishHoldings(arr) {
    try {
      const items = {};
      for (const p of (arr || getPurchases())) {
        if (!p || !p.item) continue;
        const key = String(p.item).trim().toLowerCase();
        const rec = items[key] || (items[key] = { name: String(p.item).trim(), lots: [], sales: [] });
        if (p.soldPrice === null || p.soldPrice === undefined) {
          rec.lots.push({ price: p.price, qty: p.qty || 1, date: p.date || null });
        } else {
          rec.sales.push({ price: p.price, soldPrice: p.soldPrice, qty: p.soldQty || p.qty || 1, soldDate: p.soldDate || null });
        }
      }
      for (const rec of Object.values(items)) {
        rec.lots.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        rec.sales.sort((a, b) => String(b.soldDate).localeCompare(String(a.soldDate)));
        if (rec.sales.length > HOLDINGS_MAX_SALES) {
          // Keep lifetime totals even though the list itself is trimmed
          rec.salesTotal = rec.sales.reduce((t, x) => ({
            count: t.count + 1,
            qty: t.qty + x.qty,
            profit: t.profit + (x.soldPrice - x.price) * x.qty
          }), { count: 0, qty: 0, profit: 0 });
          rec.sales = rec.sales.slice(0, HOLDINGS_MAX_SALES);
        }
      }
      localStorage.setItem(HOLDINGS_KEY, JSON.stringify({ updated: new Date().toISOString(), items }));
    } catch (e) {
      console.warn('[NP Tracker] Could not publish holdings snapshot:', e);
    }
  }
  function getAlerts() {
    const raw = GM_getValue('np_alerts', '{}');
    try { return JSON.parse(raw); } catch { return {}; }
  }
  function saveAlerts(obj) {
    GM_setValue('np_alerts', JSON.stringify(obj));
  }

  // ─── AUTO-BUYER INBOX HANDOFF ──────────────────────────────────────────────
  // The SW Auto-Buyer drops purchases into localStorage.np_tracker_inbox when
  // the user presses "Track" on a completed purchase. We pop items one at a
  // time, pre-fill the Add form, and the user confirms each with Save.
  const TRACKER_INBOX_KEY = 'np_tracker_inbox';

  function getInbox() {
    try { return JSON.parse(localStorage.getItem(TRACKER_INBOX_KEY) || '[]'); }
    catch { return []; }
  }
  function saveInbox(arr) {
    if (!arr.length) localStorage.removeItem(TRACKER_INBOX_KEY);
    else localStorage.setItem(TRACKER_INBOX_KEY, JSON.stringify(arr));
  }

  // Fill the Add form with the first queued item (if any). Caller must ensure
  // the tracker panel is already rendered.
  function fillFormFromInbox() {
    const inbox = getInbox();
    if (!inbox.length) return false;
    const next = inbox[0];
    const itemEl  = document.getElementById('np-pf-item');
    const priceEl = document.getElementById('np-pf-price');
    const qtyEl   = document.getElementById('np-pf-qty');
    const notesEl = document.getElementById('np-pf-notes');
    const formEl  = document.getElementById('np-panel-manual-form');
    if (!itemEl || !priceEl || !qtyEl || !formEl) return false;

    itemEl.value  = next.item  || '';
    priceEl.value = next.price || '';
    qtyEl.value   = next.qty   || 1;
    if (notesEl) notesEl.value = next.notes || '';
    setAddFormDate(next.date || null);
    formEl.classList.remove('np-hidden');

    // Banner so user knows queue state
    let banner = document.getElementById('np-inbox-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'np-inbox-banner';
      banner.style.cssText = 'background:rgba(0,255,153,0.1);border:1px solid #00ff99;color:#00ff99;padding:6px 10px;margin:6px 0;border-radius:4px;font-size:11px;';
      formEl.parentNode.insertBefore(banner, formEl);
    }
    banner.innerHTML = `📥 <strong>${inbox.length}</strong> purchase(s) queued. Review &amp; click Save to log each.`;
    return true;
  }

  // Add form date: iso = a queued purchase's own date (kept exactly if left
  // on that day), null = today.
  function setAddFormDate(iso) {
    const el = document.getElementById('np-pf-date');
    if (!el) return;
    el.max = toDateInput();
    el.value = toDateInput(iso);
    if (iso) el.dataset.keep = iso; else delete el.dataset.keep;
  }

  function clearInboxBanner() {
    const b = document.getElementById('np-inbox-banner');
    if (b) b.remove();
  }

  // Called on page load. Opens the tracker panel if there's anything queued.
  function processTrackerInbox() {
    if (!getInbox().length) return;
    setTimeout(() => {
      if (!document.getElementById('np-tracker-panel')) showTrackerPanel();
      // Retry until the form element is actually in the DOM
      let attempts = 0;
      const tryFill = () => {
        if (document.getElementById('np-panel-manual-form')) {
          fillFormFromInbox();
        } else if (attempts++ < 20) {
          setTimeout(tryFill, 100);
        }
      };
      setTimeout(tryFill, 100);
    }, 500);
  }

  // ─── CSV IMPORT ────────────────────────────────────────────────────────────
  function importCSV() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const text = ev.target.result;
          const lines = text.trim().split('\n');
          if (lines.length < 2) { alert('CSV appears empty!'); return; }
          const rows = lines.slice(1);
          const imported = [];
          rows.forEach((line, i) => {
            const cols = parseCSVRow(line);
            if (cols.length < 6) return;
            const date = cols[0] || new Date().toISOString();
            const item = cols[1] ? cols[1].trim() : '';
            const qty = parseInt(cols[2]) || 1;
            const price = parseInt(cols[3]) || 0;
            const soldPriceRaw = cols[4] ? cols[4].trim() : '';
            const soldPrice = soldPriceRaw !== '' && soldPriceRaw !== 'null' ? parseInt(soldPriceRaw) : null;
            const notes = cols[6] ? cols[6].trim() : '';
            if (!item) return;
            imported.push({
              id: Date.now() + i,
              item, price, qty, notes,
              date: parseImportDate(date),
              soldPrice,
              soldDate: soldPrice !== null ? new Date().toISOString() : null
            });
          });
          if (imported.length === 0) { alert('No valid rows found in CSV!'); return; }
          if (confirm(`Found ${imported.length} purchases. These will be ADDED to your existing data. Continue?`)) {
            const existing = getPurchases();
            const dupes = imported.filter(imp =>
              existing.some(ex => ex.item === imp.item && ex.price === imp.price && ex.qty === imp.qty && ex.date === imp.date)
            );
            const newEntries = imported.filter(imp => !dupes.includes(imp));
            savePurchases(existing.concat(newEntries));
            renderPanelTable(getPurchases());
            updatePanelStats();
            const dupeNote = dupes.length ? ` (${dupes.length} duplicate${dupes.length > 1 ? 's' : ''} skipped)` : '';
            showToast(`✅ Imported ${newEntries.length} purchases${dupeNote}!`);
          }
        } catch(err) {
          alert('Error reading CSV: ' + err.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  function parseCSVRow(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  function parseImportDate(dateStr) {
    const iso = new Date(dateStr);
    if (!isNaN(iso.getTime())) return iso.toISOString();
    const parts = dateStr.trim().split(' ');
    if (parts.length === 3) {
      const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
      const d = parseInt(parts[0]), m = months[parts[1]], y = parseInt(parts[2]);
      if (!isNaN(d) && m !== undefined && !isNaN(y)) return new Date(y, m, d).toISOString();
    }
    return new Date().toISOString();
  }

  // ─── MARKET PRICES (this page session) ─────────────────────────────────────
  // Filled by 🔄 Refresh Prices and by a row's ↗. Keyed by item name:
  // { value, inflated, slug } — value null = itemdb had no price. Used to
  // redraw the Market / P&L cell after any re-render and to sort by it.
  const marketPrices = {};

  function isSoldRow(p) { return p.soldPrice !== null && p.soldPrice !== undefined; }

  // Unrealised P&L at the itemdb price; null when unknown or already sold
  function marketPL(p) {
    const m = marketPrices[p.item];
    if (!m || !m.value || isSoldRow(p)) return null;
    return (m.value - p.price) * p.qty;
  }
  function anyMarketPrices() { return Object.values(marketPrices).some(m => m && m.value); }

  function marketCellHtml(p) {
    const m = marketPrices[p.item];
    if (!m) return `<button class="np-btn-check-price" data-id="${p.id}" data-item="${escHtml(p.item)}">↗</button>`;
    if (!m.value) return '<span class="np-muted">No data</span>';
    const link = `https://itemdb.com.br/item/${m.slug || encodeURIComponent(p.item)}`;
    const priceHtml = `<a class="np-market-price" href="${link}" target="_blank">${formatNP(m.value)} NP${m.inflated ? ' ⚠️' : ''}</a>`;
    if (isSoldRow(p)) return priceHtml;
    const pl = (m.value - p.price) * p.qty;
    const colour = pl >= 0 ? '#5fc48a' : '#e06060';
    return `${priceHtml}<span style="color:${colour};font-size:11px;display:block;">${pl >= 0 ? '+' : ''}${formatNP(pl)}</span>`;
  }

  // ─── PORTFOLIO REFRESH ─────────────────────────────────────────────────────
  function refreshPortfolio() {
    const purchases = getPurchases().filter(p => p.soldPrice === null);
    if (purchases.length === 0) { showToast('No unsold items to check!'); return; }

    const uniqueItems = [...new Set(purchases.map(p => p.item))];
    const priceMap = {};
    let completed = 0;

    const refreshBtn = document.getElementById('np-panel-refresh');
    if (refreshBtn) { refreshBtn.textContent = `⏳ Checking ${uniqueItems.length} items...`; refreshBtn.disabled = true; }

    uniqueItems.forEach((itemName, i) => {
      setTimeout(() => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: `https://itemdb.com.br/api/v1/items/${encodeURIComponent(itemName)}`,
          headers: { 'Accept': 'application/json' },
          onload: function(response) {
            try {
              const data = JSON.parse(response.responseText);
              if (data && data.price && data.price.value) {
                priceMap[itemName] = data.price.value;
                marketPrices[itemName] = { value: data.price.value, inflated: !!data.price.inflated, slug: data.slug || null };
              } else {
                marketPrices[itemName] = { value: null };
              }
            } catch(e) {}
            completed++;
            if (completed === uniqueItems.length) {
              displayPortfolioResults(purchases, priceMap);
              if (refreshBtn) { refreshBtn.textContent = '🔄 Refresh Prices'; refreshBtn.disabled = false; }
            }
          },
          onerror: function() {
            completed++;
            if (completed === uniqueItems.length) {
              displayPortfolioResults(purchases, priceMap);
              if (refreshBtn) { refreshBtn.textContent = '🔄 Refresh Prices'; refreshBtn.disabled = false; }
            }
          }
        });
      }, i * 800);
    });
  }

  function displayPortfolioResults(purchases, priceMap) {
    let totalSpent = 0, totalMarketValue = 0, itemsWithPrice = 0;
    purchases.forEach(p => {
      totalSpent += p.price * p.qty;
      if (priceMap[p.item]) { totalMarketValue += priceMap[p.item] * p.qty; itemsWithPrice++; }
    });
    const unrealisedPL = totalMarketValue - totalSpent;
    const plPct = totalSpent > 0 ? ((unrealisedPL / totalSpent) * 100).toFixed(1) : 0;
    const plColour = unrealisedPL >= 0 ? '#5fc48a' : '#e06060';
    const plSign = unrealisedPL >= 0 ? '+' : '';

    const summaryEl = document.getElementById('np-portfolio-summary');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="np-portfolio-bar">
          <div class="np-pf-stat">
            <div class="np-pf-label">Market Value</div>
            <div class="np-pf-val">${formatNP(totalMarketValue)} NP</div>
          </div>
          <div class="np-pf-stat">
            <div class="np-pf-label">Unrealised P&L</div>
            <div class="np-pf-val" style="color:${plColour}">${plSign}${formatNP(unrealisedPL)} NP</div>
          </div>
          <div class="np-pf-stat">
            <div class="np-pf-label">Return</div>
            <div class="np-pf-val" style="color:${plColour}">${plSign}${plPct}%</div>
          </div>
          <div class="np-pf-note">${itemsWithPrice} of ${purchases.length} items priced</div>
        </div>
      `;
      summaryEl.classList.remove('hidden');
    }

    // Redraw the table: every Market / P&L cell now reads marketPrices, and
    // a Market / P&L sort picks up the new numbers.
    renderPanelTable(getPurchases());

    showToast(`${plSign}${formatNP(unrealisedPL)} NP unrealised P&L`);
  }

  // ─── BACKGROUND ALERT CHECK ────────────────────────────────────────────────
  function runBackgroundAlertCheck() {
    const now = Date.now();
    const lastRun = GM_getValue('np_last_alert_check', 0);
    if (now - lastRun < 30 * 60 * 1000) return;
    GM_setValue('np_last_alert_check', now);
    const purchases = getPurchases().filter(p => p.soldPrice === null);
    const alerts = getAlerts();
    const toCheck = purchases.filter(p => alerts[p.id]);
    if (toCheck.length === 0) return;
    toCheck.slice(0, 5).forEach((p, i) => setTimeout(() => checkItemForAlerts(p, alerts[p.id]), i * 1200));
  }

  function checkItemForAlerts(purchase, alertConfig) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://itemdb.com.br/api/v1/items/${encodeURIComponent(purchase.item)}`,
      headers: { 'Accept': 'application/json' },
      onload: function(response) {
        try {
          const data = JSON.parse(response.responseText);
          if (!data || !data.price || !data.price.value) return;
          const currentPrice = data.price.value;
          const lastPrice = alertConfig.lastKnownPrice || null;
          const alerts = getAlerts();
          let triggered = [];
          if (alertConfig.targetPrice && currentPrice >= alertConfig.targetPrice)
            triggered.push({ type: 'target', msg: `🟢 <strong>${purchase.item}</strong> hit your target!<br>Market: <strong>${formatNP(currentPrice)} NP</strong>` });
          if (alertConfig.targetMargin && purchase.price > 0) {
            const margin = ((currentPrice - purchase.price) / purchase.price) * 100;
            if (margin >= alertConfig.targetMargin)
              triggered.push({ type: 'margin', msg: `🟢 <strong>${purchase.item}</strong> reached profit target!<br>Margin: <strong>+${margin.toFixed(1)}%</strong>` });
          }
          if (lastPrice !== null) {
            const dropPct = ((lastPrice - currentPrice) / lastPrice) * 100;
            if (dropPct >= 5)
              triggered.push({ type: 'drop', msg: `🔴 <strong>${purchase.item}</strong> dropping!<br>${formatNP(lastPrice)} → <strong>${formatNP(currentPrice)} NP</strong>` });
          }
          alerts[purchase.id] = { ...alertConfig, lastKnownPrice: currentPrice };
          saveAlerts(alerts);
          triggered.forEach((t, i) => setTimeout(() => showAlertPopup(t.msg, t.type), i * 500));
        } catch(e) {}
      }
    });
  }

  function showAlertPopup(message, type) {
    injectStyles();
    const popup = document.createElement('div');
    popup.className = `np-alert-popup np-alert-${type}`;
    popup.innerHTML = `
      <div class="np-alert-icon">${type === 'drop' ? '📉' : '📈'}</div>
      <div class="np-alert-body">
        <div class="np-alert-title">Price Alert</div>
        <div class="np-alert-msg">${message}</div>
        <div class="np-alert-actions">
          <button class="np-alert-dismiss">Dismiss</button>
        </div>
      </div>
    `;
    document.body.appendChild(popup);
    setTimeout(() => popup.classList.add('np-alert-show'), 10);
    popup.querySelector('.np-alert-dismiss').addEventListener('click', () => {
      popup.classList.remove('np-alert-show');
      setTimeout(() => popup.remove(), 400);
    });
    setTimeout(() => {
      if (popup.parentNode) { popup.classList.remove('np-alert-show'); setTimeout(() => popup.remove(), 400); }
    }, 12000);
  }

  // ─── INJECT BUTTON ─────────────────────────────────────────────────────────
  // The 📦 button can be dragged anywhere; a plain click still opens/closes
  // the panel. Position saved in GM np_btn_pos, always kept on screen.
  const BTN_POS_KEY = 'np_btn_pos';
  const BTN_DRAG_THRESHOLD = 5;   // px of movement before a press counts as a drag

  function getBtnPos() {
    try { const p = JSON.parse(GM_getValue(BTN_POS_KEY, '') || 'null'); return p && Number.isFinite(p.left) ? p : null; } catch { return null; }
  }
  function setBtnPos(btn, left, top) {
    const w = btn.offsetWidth || 150, h = btn.offsetHeight || 40;
    btn.style.left = clampN(Math.round(left), 0, Math.max(0, window.innerWidth - w)) + 'px';
    btn.style.top = clampN(Math.round(top), 0, Math.max(0, window.innerHeight - h)) + 'px';
    btn.style.right = 'auto';
  }
  function placeTrackerBtn(btn) {
    const p = getBtnPos();
    if (p) setBtnPos(btn, p.left, p.top);
    else { btn.style.left = ''; btn.style.top = ''; btn.style.right = ''; }
  }

  function injectTrackerButton() {
    if (document.getElementById('np-tracker-btn')) return;
    injectStyles();
    const btn = document.createElement('button');
    btn.id = 'np-tracker-btn';
    btn.textContent = '🍕 PBP Tracker';
    btn.title = 'Click to open · drag to move';
    document.body.appendChild(btn);
    placeTrackerBtn(btn);

    let press = null;      // { x, y, dx, dy } while the mouse is down on the button
    let dragged = false;
    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const r = btn.getBoundingClientRect();
      press = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top };
      dragged = false;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!press) return;
      if (e.buttons === 0) { press = null; return; }   // released outside the window
      if (!dragged && Math.hypot(e.clientX - press.x, e.clientY - press.y) < BTN_DRAG_THRESHOLD) return;
      dragged = true;
      btn.classList.add('np-btn-dragging');
      setBtnPos(btn, e.clientX - press.dx, e.clientY - press.dy);
    });
    document.addEventListener('mouseup', () => {
      if (!press) return;
      press = null;
      btn.classList.remove('np-btn-dragging');
      if (dragged) {
        const r = btn.getBoundingClientRect();
        GM_setValue(BTN_POS_KEY, JSON.stringify({ left: r.left, top: r.top }));
      }
    });
    window.addEventListener('resize', () => { const p = getBtnPos(); if (p) setBtnPos(btn, p.left, p.top); });

    btn.addEventListener('click', (e) => {
      if (dragged) { dragged = false; e.preventDefault(); return; }   // end of a drag, not a click
      const existing = document.getElementById('np-tracker-panel');
      if (existing) { existing.remove(); } else { showTrackerPanel(); }
    });
    updateWatchBadges();
  }

  // ─── PANEL GEOMETRY (dock / float, move, resize) ───────────────────────────
  // Docked  = full-height strip on the right, width adjustable from its left edge.
  // Floating = free window: drag the title bar to move, any edge/corner to resize.
  // Saved in GM: np_panel_geom = { floating, float: {left, top, width, height} };
  // docked width stays in np_panel_width as before.
  const PANEL_GEOM_KEY = 'np_panel_geom';
  const PANEL_MIN_W = 300, PANEL_MIN_H = 240;
  let panelDrag = null;
  let panelGlobalsBound = false;

  function getPanelGeom() {
    try { return JSON.parse(GM_getValue(PANEL_GEOM_KEY, '')) || {}; } catch { return {}; }
  }
  function defaultFloat() {
    const width = Math.min(560, window.innerWidth - 40);
    const height = Math.round(window.innerHeight * 0.8);
    return { left: Math.round((window.innerWidth - width) / 2), top: Math.round((window.innerHeight - height) / 2), width, height };
  }
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Place a floating panel, kept fully on screen
  function placeFloating(panel, g) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = clampN(Math.round(g.width), Math.min(PANEL_MIN_W, vw), vw);
    const height = clampN(Math.round(g.height), Math.min(PANEL_MIN_H, vh), vh);
    panel.style.width = width + 'px';
    panel.style.height = height + 'px';
    panel.style.left = clampN(Math.round(g.left), 0, vw - width) + 'px';
    panel.style.top = clampN(Math.round(g.top), 0, vh - height) + 'px';
    panel.style.right = 'auto';
  }
  function setFloating(panel, g) {
    panel.classList.add('np-floating');
    placeFloating(panel, g);
    updateDockBtn(panel);
  }
  function setDocked(panel) {
    panel.classList.remove('np-floating');
    panel.style.left = panel.style.top = panel.style.height = panel.style.right = '';
    panel.style.width = clampN(GM_getValue('np_panel_width', 380), 280, window.innerWidth) + 'px';
    updateDockBtn(panel);
  }
  function updateDockBtn(panel) {
    const b = panel.querySelector('#np-panel-dock');
    if (!b) return;
    const floating = panel.classList.contains('np-floating');
    b.textContent = floating ? '⇥ Dock' : '⧉ Float';
    b.title = floating ? 'Snap back to the right edge' : 'Pop out as a movable, resizable window (or just drag the title bar)';
  }
  function applyPanelGeom(panel) {
    const g = getPanelGeom();
    if (g.floating && g.float) setFloating(panel, g.float); else setDocked(panel);
  }
  function savePanelGeom(panel) {
    const g = getPanelGeom();
    if (panel.classList.contains('np-floating')) {
      const r = panel.getBoundingClientRect();
      g.floating = true;
      g.float = { left: r.left, top: r.top, width: r.width, height: r.height };
    } else {
      g.floating = false;
      GM_setValue('np_panel_width', panel.offsetWidth);
    }
    GM_setValue(PANEL_GEOM_KEY, JSON.stringify(g));
  }

  function startPanelDrag(panel, kind, e) {
    const r = panel.getBoundingClientRect();
    panelDrag = { panel, kind, x: e.clientX, y: e.clientY, left: r.left, top: r.top, width: r.width, height: r.height };
    panel.style.transition = 'none';
    document.body.style.userSelect = 'none';
  }
  function onPanelDragMove(e) {
    const d = panelDrag;
    if (!d) return;
    if (e.buttons === 0) { endPanelDrag(); return; }   // released outside the window
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    const panel = d.panel;
    if (!panel.classList.contains('np-floating')) {
      // Docked: only the left edge resizes
      if (d.kind === 'w') panel.style.width = clampN(d.width - dx, 280, window.innerWidth - 40) + 'px';
      return;
    }
    let { left, top, width, height } = d;
    if (d.kind === 'move') { left += dx; top += dy; }
    else {
      if (d.kind.includes('e')) width = Math.max(PANEL_MIN_W, d.width + dx);
      if (d.kind.includes('s')) height = Math.max(PANEL_MIN_H, d.height + dy);
      if (d.kind.includes('w')) { width = Math.max(PANEL_MIN_W, d.width - dx); left = d.left + d.width - width; }
    }
    placeFloating(panel, { left, top, width, height });
  }
  function endPanelDrag() {
    const d = panelDrag;
    if (!d) return;
    panelDrag = null;
    d.panel.style.transition = '';
    document.body.style.userSelect = '';
    savePanelGeom(d.panel);
  }
  // Bound once for the page — reopening the panel doesn't stack listeners
  function bindPanelDragGlobals() {
    if (panelGlobalsBound) return;
    panelGlobalsBound = true;
    document.addEventListener('mousemove', onPanelDragMove);
    document.addEventListener('mouseup', endPanelDrag);
    window.addEventListener('blur', endPanelDrag);
    window.addEventListener('resize', () => {
      const p = document.getElementById('np-tracker-panel');
      if (p && p.classList.contains('np-floating')) {
        const r = p.getBoundingClientRect();
        placeFloating(p, { left: r.left, top: r.top, width: r.width, height: r.height });
      }
    });
  }

  // ─── PURCHASES TABLE SORT ──────────────────────────────────────────────────
  const TABLE_SORT_KEY = 'np_table_sort';
  const TABLE_SORT_DEFAULT = { key: 'added', dir: 'desc' };
  function getTableSort() {
    try { return JSON.parse(GM_getValue(TABLE_SORT_KEY, '')) || TABLE_SORT_DEFAULT; } catch { return TABLE_SORT_DEFAULT; }
  }
  // Rows with no value for the column (unsold when sorting by Sold; sold or
  // not yet priced when sorting by Market / P&L) always sink to the bottom.
  function sortPurchases(list, s) {
    const val = {
      added:  p => p.id,
      item:   p => String(p.item || '').toLowerCase(),
      date:   p => Date.parse(p.date) || 0,
      qty:    p => Number(p.qty) || 0,
      paid:   p => Number(p.price) || 0,
      market: p => marketPL(p),
      sold:   p => isSoldRow(p) ? Number(p.soldPrice) || 0 : null
    }[s.key] || (p => p.id);
    const m = s.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === null || y === null) {
        if (x === null && y === null) return b.id - a.id;
        return x === null ? 1 : -1;
      }
      if (x < y) return -m;
      if (x > y) return m;
      return b.id - a.id;
    });
  }

  // ─── LIST / GROUPED VIEW ───────────────────────────────────────────────────
  // Grouped: one summary row per item name (case-insensitive); clicking it
  // expands the individual purchases underneath. Expanded groups are kept for
  // the page's lifetime so re-renders (sell, edit, refresh) don't collapse them.
  const TABLE_VIEW_KEY = 'np_table_view';
  function getTableView() { return GM_getValue(TABLE_VIEW_KEY, 'list') === 'grouped' ? 'grouped' : 'list'; }
  function groupKey(name) { return String(name || '').trim().toLowerCase(); }
  const expandedGroups = new Set();

  // ─── TRACKER PANEL ─────────────────────────────────────────────────────────
  function showTrackerPanel() {
    injectStyles();
    // Only ever one panel. Two copies share every element id, and the one on
    // top ends up with dead buttons (its handlers bind to the hidden copy).
    const existingPanel = document.getElementById('np-tracker-panel');
    if (existingPanel) {
      if (!existingPanel.dataset.closing) return existingPanel;
      existingPanel.remove();                     // mid-close → replace it now
    }
    const panel = document.createElement('div');
    panel.id = 'np-tracker-panel';

    const purchases = getPurchases();
    const totalSpent = purchases.reduce((s, p) => s + (p.price * p.qty), 0);
    const sold = purchases.filter(p => p.soldPrice !== null);
    const totalProfit = sold.reduce((s, p) => s + ((p.soldPrice - p.price) * p.qty), 0);
    const unsold = purchases.filter(p => p.soldPrice === null).length;

    panel.innerHTML = `
      <div class="np-rz" data-dir="w"></div>
      <div class="np-rz" data-dir="e"></div>
      <div class="np-rz" data-dir="s"></div>
      <div class="np-rz" data-dir="se"></div>
      <div class="np-rz" data-dir="sw"></div>
      <div id="np-panel-inner">
        <div class="np-panel-header" title="Drag to move">
          <div class="np-panel-title"><span>🍕</span><span>Pizza Boy Pro</span><span class="np-tb-tag">Tracker</span></div>
          <button id="np-panel-dock" type="button"></button>
          <button id="np-panel-close">✕</button>
        </div>
        <div class="np-tab-bar">
          <button class="np-tab np-tab-active" data-tab="purchases">📦 Purchases</button>
          <button class="np-tab" data-tab="pnl">📊 P&amp;L</button>
          <button class="np-tab" data-tab="offers">📨 Offers</button>
          <button class="np-tab" data-tab="watch">👁 Watch<span id="np-watch-badge" class="np-tab-badge"></span></button>
        </div>

        <!-- PURCHASES TAB -->
        <div id="np-view-purchases">
          <div class="np-panel-stats">
            <div class="np-stat np-stat-clickable" data-filter="all">
              <div class="np-stat-label">Spent</div>
              <div class="np-stat-val">${formatNP(totalSpent)} NP</div>
            </div>
            <div class="np-stat np-stat-clickable" data-filter="unsold">
              <div class="np-stat-label">Unsold</div>
              <div class="np-stat-val">${unsold}</div>
            </div>
            <div class="np-stat np-stat-clickable" data-filter="sold">
              <div class="np-stat-label">Realised</div>
              <div class="np-stat-val ${totalProfit >= 0 ? 'np-green' : 'np-red'}">${totalProfit >= 0 ? '+' : ''}${formatNP(totalProfit)} NP</div>
            </div>
          </div>
          <div id="np-stat-drawer" class="np-hidden"></div>
          <div id="np-portfolio-summary" class="np-hidden"></div>
          <div class="np-panel-toolbar">
            <button class="np-btn-add" id="np-panel-add">+ Add</button>
            <input class="np-panel-search" id="np-panel-search" type="text" placeholder="Search items..." />
            <div class="np-view-toggle" id="np-view-toggle" title="List every purchase, or group them by item name">
              <button type="button" data-view="list">List</button>
              <button type="button" data-view="grouped">Grouped</button>
            </div>
          </div>
          <div class="np-panel-toolbar">
            <button id="np-panel-refresh">🔄 Refresh Prices</button>
            <button id="np-panel-export">📤 Export CSV</button>
            <button id="np-panel-import">📥 Import CSV</button>
          </div>
          <div id="np-panel-manual-form" class="np-hidden">
            <div class="np-form-row">
              <input id="np-pf-item" type="text" placeholder="Item name" />
              <input id="np-pf-price" type="number" placeholder="Price (NP)" />
              <input id="np-pf-qty" type="number" value="1" min="1" style="width:60px" />
            </div>
            <input id="np-pf-notes" type="text" placeholder="Notes (optional)" style="width:100%;margin-top:6px" />
            <div class="np-form-row np-pf-date-row">
              <label for="np-pf-date">Date bought</label>
              <input id="np-pf-date" type="date" />
            </div>
            <div class="np-form-actions">
              <button id="np-pf-save">Save</button>
              <button id="np-pf-cancel">Cancel</button>
            </div>
          </div>
          <div id="np-panel-table-wrap">
            <table id="np-panel-table">
              <thead>
                <tr>
                  <th class="np-sortable" data-sort="item" title="Sort by item">Item</th>
                  <th class="np-sortable" data-sort="date" title="Sort by date bought">Date</th>
                  <th class="np-sortable" data-sort="qty" title="Sort by quantity">Qty</th>
                  <th class="np-sortable" data-sort="paid" title="Sort by price paid">Paid</th>
                  <th class="np-sortable" data-sort="market" title="Sort by unrealised P&amp;L at itemdb price (press 🔄 Refresh Prices first; sold and unpriced rows go last)">Market / P&amp;L</th>
                  <th class="np-sortable" data-sort="sold" title="Sort by sale price (unsold last)">Sold</th>
                  <th class="np-sortable np-sort-reset" data-sort="added" title="Back to newest added first">↺</th>
                </tr>
              </thead>
              <tbody id="np-panel-tbody"></tbody>
            </table>
            <div id="np-panel-empty" class="np-hidden">
              <div style="text-align:center;padding:30px;color:#999999;font-style:italic;">🏝️ No purchases yet!</div>
            </div>
          </div>
        </div>

        <!-- P&L TAB -->
        <div id="np-view-pnl" class="np-hidden">
          <div class="np-pnl-period-bar np-pnl-row1">
            <button class="np-pnl-period np-pnl-period-active" data-period="24h">24h</button>
            <button class="np-pnl-period" data-period="week1">Wk 1</button>
            <button class="np-pnl-period" data-period="week2">Wk 2</button>
            <button class="np-pnl-period" data-period="week3">Wk 3</button>
            <button class="np-pnl-period" data-period="week4">Wk 4</button>
          </div>
          <div class="np-pnl-period-bar np-pnl-row2">
            <button class="np-pnl-period" data-period="monthly">Month</button>
            <button class="np-pnl-period" data-period="yearly">Year</button>
            <button class="np-pnl-period" data-period="alltime">All</button>
            <button class="np-pnl-period" data-period="daterange">📅 Range</button>
          </div>
          <div id="np-pnl-daterange" class="np-hidden">
            <div class="np-pnl-range-row">
              <div class="np-pnl-range-field">
                <label>From</label>
                <input type="date" id="np-pnl-from" />
              </div>
              <div class="np-pnl-range-field">
                <label>To</label>
                <input type="date" id="np-pnl-to" />
              </div>
              <button id="np-pnl-range-apply">Go</button>
            </div>
          </div>
          <div id="np-pnl-content"></div>
        </div>

        <!-- OFFERS TAB -->
        <div id="np-view-offers" class="np-hidden"></div>

        <!-- WATCH TAB -->
        <div id="np-view-watch" class="np-hidden"></div>
      </div>
    `;

    document.body.appendChild(panel);
    setTimeout(() => panel.classList.add('np-panel-show'), 10);
    updateWatchBadges();

    // ─── MOVE / RESIZE ───────────────────────────────────────────────────────
    applyPanelGeom(panel);
    bindPanelDragGlobals();
    panel.querySelector('.np-panel-header').addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button, input, select, a')) return;
      e.preventDefault();
      if (!panel.classList.contains('np-floating')) {
        // First drag off the dock: float it where it is, at a sensible height
        const r = panel.getBoundingClientRect();
        setFloating(panel, { left: r.left, top: r.top, width: r.width, height: Math.round(window.innerHeight * 0.8) });
      }
      startPanelDrag(panel, 'move', e);
    });
    panel.querySelectorAll('.np-rz').forEach(h => h.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      startPanelDrag(panel, h.dataset.dir, e);
    }));
    panel.querySelector('#np-panel-dock').addEventListener('click', () => {
      if (panel.classList.contains('np-floating')) setDocked(panel);
      else setFloating(panel, getPanelGeom().float || defaultFloat());
      savePanelGeom(panel);
    });

    // ─── EVENTS ──────────────────────────────────────────────────────────────
    document.getElementById('np-panel-close').addEventListener('click', () => {
      panel.dataset.closing = '1';
      panel.classList.remove('np-panel-show');
      setTimeout(() => panel.remove(), 350);
    });
    document.getElementById('np-panel-refresh').addEventListener('click', refreshPortfolio);
    document.getElementById('np-panel-export').addEventListener('click', exportCSV);
    document.getElementById('np-panel-import').addEventListener('click', importCSV);
    document.getElementById('np-panel-add').addEventListener('click', () => {
      const form = document.getElementById('np-panel-manual-form');
      form.classList.toggle('np-hidden');
      if (!form.classList.contains('np-hidden')) setAddFormDate(null);
    });

    // ─── STAT CARD DRAWER ────────────────────────────────────────────────────
    let activeFilter = null;
    document.querySelector('.np-panel-stats').addEventListener('click', (e) => {
      const card = e.target.closest('.np-stat-clickable');
      if (!card) return;
      const filter = card.dataset.filter;
      const drawer = document.getElementById('np-stat-drawer');

      if (activeFilter === filter) {
        // toggle off
        activeFilter = null;
        drawer.classList.add('np-hidden');
        drawer.innerHTML = '';
        document.querySelectorAll('.np-stat-clickable').forEach(c => c.classList.remove('np-stat-active'));
        return;
      }

      activeFilter = filter;
      document.querySelectorAll('.np-stat-clickable').forEach(c => c.classList.remove('np-stat-active'));
      card.classList.add('np-stat-active');
      renderStatDrawer(filter, drawer);
      drawer.classList.remove('np-hidden');
    });
    document.getElementById('np-panel-search').addEventListener('input', (e) => {
      renderPanelTable(getPurchases(), e.target.value);
    });
    document.getElementById('np-view-toggle').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (!b || b.dataset.view === getTableView()) return;
      GM_setValue(TABLE_VIEW_KEY, b.dataset.view);
      renderPanelTable(getPurchases());
    });
    panel.querySelector('#np-panel-table thead').addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (!th) return;
      const cur = getTableSort();
      const key = th.dataset.sort;
      if (key === 'market' && !anyMarketPrices()) {
        showToast('🔄 Press Refresh Prices first, then Market / P&L can sort');
        return;
      }
      const next = key === 'added' ? TABLE_SORT_DEFAULT
        : cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'item' ? 'asc' : 'desc' };
      GM_setValue(TABLE_SORT_KEY, JSON.stringify(next));
      renderPanelTable(getPurchases());
    });
    document.getElementById('np-pf-save').addEventListener('click', () => {
      const item = document.getElementById('np-pf-item').value.trim();
      const price = parseInt(document.getElementById('np-pf-price').value) || 0;
      const qty = parseInt(document.getElementById('np-pf-qty').value) || 1;
      const notes = document.getElementById('np-pf-notes').value.trim();
      const dateEl = document.getElementById('np-pf-date');
      if (!item) { alert('Please enter an item name!'); return; }
      const date = fromDateInput(dateEl.value, dateEl.dataset.keep || null);
      const purchases = getPurchases();
      purchases.push({ id: Date.now(), item, price, qty, notes, date, soldPrice: null, soldDate: null });
      savePurchases(purchases);
      document.getElementById('np-panel-manual-form').classList.add('np-hidden');
      document.getElementById('np-pf-item').value = '';
      document.getElementById('np-pf-price').value = '';
      document.getElementById('np-pf-qty').value = '1';
      document.getElementById('np-pf-notes').value = '';
      setAddFormDate(null);
      renderPanelTable(getPurchases());
      updatePanelStats();
      showToast(toDateInput(date) === toDateInput() ? 'Purchase logged!' : `Purchase logged for ${formatDate(date)}`);

      // If this save came from the Auto-Buyer inbox, pop it and refill for the next
      const inbox = getInbox();
      if (inbox.length) {
        saveInbox(inbox.slice(1));
        if (getInbox().length) {
          setTimeout(fillFormFromInbox, 150);
        } else {
          clearInboxBanner();
          showToast('✅ All queued purchases logged!');
        }
      }
    });
    document.getElementById('np-pf-cancel').addEventListener('click', () => {
      document.getElementById('np-panel-manual-form').classList.add('np-hidden');
      // If we're mid-queue, ask whether to skip just this one or dismiss the rest
      const inbox = getInbox();
      if (inbox.length) {
        const choice = confirm(`Skip this purchase and move to the next? (Cancel = discard all ${inbox.length} queued)`);
        if (choice) {
          saveInbox(inbox.slice(1));
          if (getInbox().length) {
            setTimeout(fillFormFromInbox, 150);
          } else {
            clearInboxBanner();
          }
        } else {
          saveInbox([]);
          clearInboxBanner();
          showToast('Queue dismissed.');
        }
      }
    });
    document.getElementById('np-panel-tbody').addEventListener('click', (e) => {
      const grp = e.target.closest('tr.np-grp-row');
      if (grp && !e.target.closest('button, a')) {
        const k = grp.dataset.grp;
        if (expandedGroups.has(k)) expandedGroups.delete(k); else expandedGroups.add(k);
        renderPanelTable(getPurchases());
        return;
      }
      const id = parseInt(e.target.dataset.id);
      if (e.target.classList.contains('np-btn-check-price')) fetchItemdbPrice(e.target.dataset.item, id, e.target.closest('td'));
      if (e.target.classList.contains('np-btn-sell')) { const p = getPurchases().find(p => p.id === id); if (p) showSellModal(p); }
      if (e.target.classList.contains('np-btn-edit')) { const p = getPurchases().find(p => p.id === id); if (p) showEditModal(p); }
      if (e.target.classList.contains('np-btn-alert')) showAlertModal(id, e.target.dataset.item, parseInt(e.target.dataset.price));
      if (e.target.classList.contains('np-btn-delete')) {
        if (!confirm('Delete this entry?')) return;
        const purchases = getPurchases().filter(p => p.id !== id);
        savePurchases(purchases);
        renderPanelTable(purchases);
        updatePanelStats();
      }
    });

    // ─── TAB SWITCHING ────────────────────────────────────────────────────────
    document.querySelectorAll('.np-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.np-tab').forEach(t => t.classList.remove('np-tab-active'));
        btn.classList.add('np-tab-active');
        const tab = btn.dataset.tab;
        document.getElementById('np-view-purchases').classList.toggle('np-hidden', tab !== 'purchases');
        document.getElementById('np-view-pnl').classList.toggle('np-hidden', tab !== 'pnl');
        document.getElementById('np-view-offers').classList.toggle('np-hidden', tab !== 'offers');
        document.getElementById('np-view-watch').classList.toggle('np-hidden', tab !== 'watch');
        if (tab === 'pnl') renderPnlView('24h');
        if (tab === 'offers') renderOffersView();
        if (tab === 'watch') { renderWatchView(); runWatchChecks('auto'); }
      });
    });

    // ─── P&L PERIOD SWITCHING ─────────────────────────────────────────────────
    document.getElementById('np-view-pnl').addEventListener('click', (e) => {
      if (e.target.classList.contains('np-pnl-period')) {
        document.querySelectorAll('.np-pnl-period').forEach(b => b.classList.remove('np-pnl-period-active'));
        e.target.classList.add('np-pnl-period-active');
        const period = e.target.dataset.period;
        const rangeEl = document.getElementById('np-pnl-daterange');
        if (period === 'daterange') {
          rangeEl.classList.remove('np-hidden');
          // pre-fill sensible defaults
          const today = new Date();
          const todayStr = today.toISOString().slice(0, 10);
          const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
          const weekAgoStr = weekAgo.toISOString().slice(0, 10);
          if (!document.getElementById('np-pnl-from').value) document.getElementById('np-pnl-from').value = weekAgoStr;
          if (!document.getElementById('np-pnl-to').value) document.getElementById('np-pnl-to').value = todayStr;
        } else {
          rangeEl.classList.add('np-hidden');
          renderPnlView(period);
        }
      }
      if (e.target.id === 'np-pnl-range-apply') {
        const from = document.getElementById('np-pnl-from').value;
        const to = document.getElementById('np-pnl-to').value;
        if (!from || !to) { return; }
        renderPnlView('daterange', from, to);
      }
    });

    // ─── P&L TOP SALES CLICK → JUMP TO LOG ───────────────────────────────────
    document.getElementById('np-pnl-content').addEventListener('click', (e) => {
      const row = e.target.closest('.np-pnl-sale-row');
      if (row) { jumpToPurchase(parseInt(row.dataset.id)); return; }

      if (e.target.id === 'np-pnl-see-more') {
        const allSales = document.getElementById('np-pnl-all-sales');
        const btn = e.target;
        const isHidden = allSales.classList.contains('np-hidden');
        allSales.classList.toggle('np-hidden', !isHidden);
        btn.textContent = isHidden
          ? '▲ Show less'
          : `▼ See all ${btn.dataset.count || ''} sales`;
        // store count on first open
        if (!btn.dataset.count) btn.dataset.count = btn.textContent.match(/\d+/)?.[0] || '';
      }
    });

    renderPanelTable(purchases);
  }

  function renderPanelTable(purchases, filter) {
    const tbody = document.getElementById('np-panel-tbody');
    const empty = document.getElementById('np-panel-empty');
    const table = document.getElementById('np-panel-table');
    if (!tbody) return;
    // Keep the search box's filter when re-rendering after a save/edit/sell
    if (filter === undefined) { const s = document.getElementById('np-panel-search'); filter = s ? s.value : ''; }

    const alerts = getAlerts();
    const filtered = filter ? purchases.filter(p => String(p.item).toLowerCase().includes(filter.toLowerCase())) : purchases;
    const sortState = getTableSort();
    const sorted = sortPurchases(filtered, sortState);
    table.querySelectorAll('th[data-sort]').forEach(th => {
      const on = th.dataset.sort === sortState.key && sortState.key !== 'added';
      th.classList.toggle('np-sort-on', on);
      // ⇅ = sortable, not in use; ▲/▼ = the active sort
      th.dataset.arrow = th.dataset.sort === 'added' ? '' : on ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅';
    });

    if (sorted.length === 0) {
      table.style.display = 'none';
      empty.classList.remove('np-hidden');
      return;
    }

    table.style.display = '';
    empty.classList.add('np-hidden');

    const rowHtml = (p, cls, grp) => {
      const soldQty = p.soldQty || p.qty;
      const soldTotal = p.soldPrice !== null ? p.soldPrice * soldQty : null;
      const soldDisplay = p.soldPrice !== null
        ? `<span class="np-bright" title="Sold: ${formatDateTime(p.soldDate)}">
            ${soldQty > 1
              ? `<span class="np-sold-ea">${formatNP(p.soldPrice)} ea</span><br>
                 <span class="np-sold-total">${formatNP(soldTotal)} total</span>`
              : formatNP(p.soldPrice)
            }
            <br><span class="np-muted np-date-tiny">${formatDate(p.soldDate)}</span>
           </span>`
        : `<button class="np-btn-sell" data-id="${p.id}">Sell</button>`;

      return `<tr${cls ? ` class="${cls}"` : ''}${grp ? ` data-grp="${escHtml(grp)}"` : ''}>
        <td class="np-item-name" title="${escHtml(p.notes || '')}">${escHtml(p.item)}</td>
        <td class="np-date-cell" title="${formatDateTime(p.date)}">${formatDate(p.date)}</td>
        <td class="np-bright">${p.qty}</td>
        <td class="np-bright">${formatNP(p.price)}</td>
        <td id="market-${p.id}">${marketCellHtml(p)}</td>
        <td>${soldDisplay}</td>
        <td>
          <button class="np-btn-alert ${alerts[p.id] ? 'np-btn-alert-active' : ''}" data-id="${p.id}" data-item="${escHtml(p.item)}" data-price="${p.price}">🔔</button>
          <button class="np-btn-edit" data-id="${p.id}">✎</button>
          <button class="np-btn-delete" data-id="${p.id}">✕</button>
        </td>
      </tr>`;
    };

    const view = getTableView();
    document.querySelectorAll('#np-view-toggle button').forEach(b =>
      b.classList.toggle('np-view-on', b.dataset.view === view));

    if (view === 'list') {
      tbody.innerHTML = sorted.map(p => rowHtml(p)).join('');
      return;
    }

    // Grouped: groups appear in the order their first row appears under the
    // current sort (so Item sorts A→Z, Paid puts the priciest buy's group
    // first, etc.); rows inside a group keep that same sort.
    const groups = new Map();
    sorted.forEach(p => {
      const k = groupKey(p.item);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    });
    const searching = !!(filter && filter.trim());

    tbody.innerHTML = [...groups.entries()].map(([k, rows]) => {
      const open = searching || expandedGroups.has(k);
      // Title uses the most common spelling in the group (manual entries can vary in case)
      const tally = {};
      rows.forEach(p => { tally[p.item] = (tally[p.item] || 0) + 1; });
      const name = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      const qty = rows.reduce((s, p) => s + (Number(p.qty) || 0), 0);
      const spent = rows.reduce((s, p) => s + p.price * p.qty, 0);
      const held = rows.filter(p => !isSoldRow(p)).reduce((s, p) => s + (Number(p.qty) || 0), 0);
      const soldRows = rows.filter(isSoldRow);
      const realised = soldRows.reduce((s, p) => s + (p.soldPrice - p.price) * p.qty, 0);
      const latest = rows.reduce((a, p) => (Date.parse(p.date) || 0) > (Date.parse(a.date) || 0) ? p : a, rows[0]);
      const oldest = rows.reduce((a, p) => (Date.parse(p.date) || 0) < (Date.parse(a.date) || 0) ? p : a, rows[0]);
      const avg = qty ? Math.round(spent / qty) : 0;

      const m = marketPrices[name] || rows.map(p => marketPrices[p.item]).find(Boolean);
      let marketCell;
      if (!m) {
        marketCell = held
          ? `<button class="np-btn-check-price" data-id="${rows[0].id}" data-item="${escHtml(name)}">↗</button>`
          : '<span class="np-muted">—</span>';
      } else if (!m.value) {
        marketCell = '<span class="np-muted">No data</span>';
      } else {
        const link = `https://itemdb.com.br/item/${m.slug || encodeURIComponent(name)}`;
        const unreal = rows.reduce((s, p) => s + (marketPL(p) || 0), 0);
        marketCell = `<a class="np-market-price" href="${link}" target="_blank">${formatNP(m.value)} NP${m.inflated ? ' ⚠️' : ''}</a>`
          + (held ? `<span class="${unreal >= 0 ? 'np-green' : 'np-red'}" style="font-size:11px;display:block;">${unreal >= 0 ? '+' : ''}${formatNP(unreal)}</span>` : '');
      }
      const soldCell = soldRows.length
        ? `<span class="${realised >= 0 ? 'np-green' : 'np-red'}">${realised >= 0 ? '+' : ''}${formatNP(realised)}</span>
           <span class="np-muted np-date-tiny">${soldRows.length} sold</span>`
        : '<span class="np-muted">—</span>';
      const dateCell = rows.length > 1 && toDateInput(oldest.date) !== toDateInput(latest.date)
        ? `${formatDate(oldest.date)}<span class="np-date-tiny">→ ${formatDate(latest.date)}</span>`
        : formatDate(latest.date);

      const head = `<tr class="np-grp-row${open ? ' np-grp-open' : ''}" data-grp="${escHtml(k)}" title="${open ? 'Collapse' : 'Show the individual purchases'}">
        <td class="np-item-name"><span class="np-grp-caret">${open ? '▾' : '▸'}</span>${escHtml(name)} <span class="np-grp-count">×${rows.length}</span></td>
        <td class="np-date-cell">${dateCell}</td>
        <td class="np-bright">${qty}${held !== qty ? `<span class="np-muted np-date-tiny">${held} held</span>` : ''}</td>
        <td class="np-bright">${formatNP(avg)}${qty > 1 ? `<span class="np-muted np-date-tiny">avg ea</span><span class="np-muted np-date-tiny">${formatNP(spent)} total</span>` : ''}</td>
        <td>${marketCell}</td>
        <td>${soldCell}</td>
        <td></td>
      </tr>`;
      return head + (open ? rows.map(p => rowHtml(p, 'np-grp-child', k)).join('') : '');
    }).join('');
  }

  function updatePanelStats() {
    const purchases = getPurchases();
    const totalSpent = purchases.reduce((s, p) => s + (p.price * p.qty), 0);
    const sold = purchases.filter(p => p.soldPrice !== null);
    const totalProfit = sold.reduce((s, p) => s + ((p.soldPrice - p.price) * p.qty), 0);
    const unsold = purchases.filter(p => p.soldPrice === null).length;
    const vals = document.querySelectorAll('.np-stat-val');
    if (vals[0]) vals[0].textContent = formatNP(totalSpent) + ' NP';
    if (vals[1]) vals[1].textContent = unsold;
    if (vals[2]) {
      vals[2].textContent = (totalProfit >= 0 ? '+' : '') + formatNP(totalProfit) + ' NP';
      vals[2].className = 'np-stat-val ' + (totalProfit >= 0 ? 'np-green' : 'np-red');
    }
  }

  // ─── P&L VIEW ──────────────────────────────────────────────────────────────
  function renderPnlView(period, fromDate, toDate) {
    const el = document.getElementById('np-pnl-content');
    if (!el) return;
    const all = getPurchases();
    const now = new Date();

    // Work out the window start and end
    let windowStart = null, windowEnd = null;

    if (period === '24h') {
      windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (period === 'week1') {
      // current calendar week Mon–Sun
      const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7)); mon.setHours(0,0,0,0);
      windowStart = mon;
    } else if (period === 'week2') {
      const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) - 7); mon.setHours(0,0,0,0);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 7);
      windowStart = mon; windowEnd = sun;
    } else if (period === 'week3') {
      const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) - 14); mon.setHours(0,0,0,0);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 7);
      windowStart = mon; windowEnd = sun;
    } else if (period === 'week4') {
      const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) - 21); mon.setHours(0,0,0,0);
      const sun = new Date(mon); sun.setDate(mon.getDate() + 7);
      windowStart = mon; windowEnd = sun;
    } else if (period === 'monthly') {
      windowStart = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (period === 'yearly') {
      windowStart = new Date(now.getFullYear(), 0, 1);
    } else if (period === 'daterange') {
      windowStart = fromDate ? new Date(fromDate) : null;
      windowEnd   = toDate   ? new Date(toDate + 'T23:59:59') : null;
    }
    // alltime: both null

    const inWindow = (iso) => {
      if (!iso) return false;
      const d = new Date(iso);
      if (windowStart && d < windowStart) return false;
      if (windowEnd   && d > windowEnd)   return false;
      return true;
    };

    const bought         = all.filter(p => inWindow(p.date));
    const soldInWindow   = all.filter(p => p.soldDate && inWindow(p.soldDate));
    const unsoldInWindow = bought.filter(p => p.soldPrice === null);

    const totalSpent   = bought.reduce((s, p) => s + p.price * p.qty, 0);
    const totalRevenue = soldInWindow.reduce((s, p) => s + p.soldPrice * (p.soldQty || p.qty), 0);
    const totalCost    = soldInWindow.reduce((s, p) => s + p.price * (p.soldQty || p.qty), 0);
    const realisedPL   = totalRevenue - totalCost;
    const plSign       = realisedPL >= 0 ? '+' : '';
    const plClass      = realisedPL >= 0 ? 'np-green' : 'np-red';
    const roiPct       = totalCost > 0 ? ((realisedPL / totalCost) * 100).toFixed(1) : '0.0';
    const barPct       = totalRevenue > 0
      ? Math.min(100, (totalRevenue / (totalCost || totalRevenue)) * 100)
      : (realisedPL >= 0 && totalCost > 0 ? 100 : 0);

    const periodLabels = {
      '24h': 'Last 24 Hours', week1: 'This Week', week2: 'Last Week',
      week3: '2 Weeks Ago', week4: '3 Weeks Ago',
      monthly: 'This Month', yearly: 'This Year', alltime: 'All Time',
      daterange: fromDate && toDate ? `${formatDate(fromDate)} – ${formatDate(toDate)}` : 'Date Range'
    };

    const soldRows = soldInWindow
      .map(p => ({ id: p.id, item: p.item, profit: (p.soldPrice - p.price) * (p.soldQty || p.qty), date: p.soldDate }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 5);

    el.innerHTML = `
      <div class="np-pnl-heading">${periodLabels[period]}</div>

      <div class="np-pnl-cards">
        <div class="np-pnl-card">
          <div class="np-pnl-card-label">Spent</div>
          <div class="np-pnl-card-val">${formatNP(totalSpent)} NP</div>
        </div>
        <div class="np-pnl-card">
          <div class="np-pnl-card-label">Revenue</div>
          <div class="np-pnl-card-val">${formatNP(totalRevenue)} NP</div>
        </div>
        <div class="np-pnl-card">
          <div class="np-pnl-card-label">Realised P&amp;L</div>
          <div class="np-pnl-card-val ${plClass}">${plSign}${formatNP(realisedPL)} NP</div>
        </div>
        <div class="np-pnl-card">
          <div class="np-pnl-card-label">ROI</div>
          <div class="np-pnl-card-val ${plClass}">${plSign}${roiPct}%</div>
        </div>
        <div class="np-pnl-card">
          <div class="np-pnl-card-label">Buys</div>
          <div class="np-pnl-card-val">${bought.length}</div>
        </div>
        <div class="np-pnl-card">
          <div class="np-pnl-card-label">Sales</div>
          <div class="np-pnl-card-val">${soldInWindow.length}</div>
        </div>
        <div class="np-pnl-card">
          <div class="np-pnl-card-label">Unsold</div>
          <div class="np-pnl-card-val">${unsoldInWindow.length}</div>
        </div>
      </div>

      <div class="np-pnl-bar-wrap">
        <div class="np-pnl-bar-label">Cost vs Revenue</div>
        <div class="np-pnl-bar-track">
          <div class="np-pnl-bar-fill ${realisedPL >= 0 ? 'np-pnl-bar-profit' : 'np-pnl-bar-loss'}" style="width:${barPct}%"></div>
        </div>
        <div class="np-pnl-bar-legend">
          <span style="color:#999999">Cost: ${formatNP(totalCost)} NP</span>
          <span style="color:#e8a800">Rev: ${formatNP(totalRevenue)} NP</span>
        </div>
      </div>

      ${soldRows.length > 0 ? `
      <div class="np-pnl-section-title">Top Sales <span style="color:#999999;font-size:9px;text-transform:none;letter-spacing:0">— click to view in log</span></div>
      <table class="np-pnl-table">
        <thead><tr><th>Item</th><th>Sold</th><th>P&amp;L</th></tr></thead>
        <tbody>
          ${soldRows.map(r => `
            <tr class="np-pnl-sale-row" data-id="${r.id}" title="Jump to purchase log">
              <td class="np-item-name" style="max-width:120px">${escHtml(r.item)}</td>
              <td class="np-date-cell">${formatDate(r.date)}</td>
              <td class="${r.profit >= 0 ? 'np-green' : 'np-red'}">${r.profit >= 0 ? '+' : ''}${formatNP(r.profit)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${soldInWindow.length > 5 ? `
        <div id="np-pnl-all-sales" class="np-hidden">
          <div class="np-pnl-section-title" style="margin-top:14px">All Sales <span style="color:#999999;font-size:9px;text-transform:none;letter-spacing:0">${soldInWindow.length} total</span></div>
          <table class="np-pnl-table">
            <thead><tr><th>Item</th><th>Sold</th><th>P&amp;L</th></tr></thead>
            <tbody>
              ${soldInWindow
                .map(p => ({ id: p.id, item: p.item, profit: (p.soldPrice - p.price) * (p.soldQty || p.qty), date: p.soldDate }))
                .sort((a, b) => b.profit - a.profit)
                .map(r => `
                  <tr class="np-pnl-sale-row" data-id="${r.id}" title="Jump to purchase log">
                    <td class="np-item-name" style="max-width:120px">${escHtml(r.item)}</td>
                    <td class="np-date-cell">${formatDate(r.date)}</td>
                    <td class="${r.profit >= 0 ? 'np-green' : 'np-red'}">${r.profit >= 0 ? '+' : ''}${formatNP(r.profit)}</td>
                  </tr>
                `).join('')}
            </tbody>
          </table>
        </div>
        <button id="np-pnl-see-more" class="np-pnl-see-more">▼ See all ${soldInWindow.length} sales</button>
      ` : ''}
      ` : `<div style="text-align:center;padding:20px;color:#999999;font-style:italic;">No sales in this period.</div>`}
    `;
  }

  // ─── JUMP TO PURCHASE ──────────────────────────────────────────────────────
  function jumpToPurchase(id) {
    // Switch to purchases tab
    document.querySelectorAll('.np-tab').forEach(t => t.classList.remove('np-tab-active'));
    document.querySelector('.np-tab[data-tab="purchases"]').classList.add('np-tab-active');
    document.getElementById('np-view-purchases').classList.remove('np-hidden');
    document.getElementById('np-view-pnl').classList.add('np-hidden');
    document.getElementById('np-view-offers').classList.add('np-hidden');
    document.getElementById('np-view-watch').classList.add('np-hidden');

    // In Grouped view the row may sit inside a collapsed group — open it first
    if (getTableView() === 'grouped') {
      const p = getPurchases().find(x => x.id === id);
      if (p && !expandedGroups.has(groupKey(p.item))) {
        expandedGroups.add(groupKey(p.item));
        renderPanelTable(getPurchases());
      }
    }

    // Find the row and scroll + highlight it
    const row =document.querySelector(`#np-panel-tbody tr td button[data-id="${id}"]`);
    const targetRow = row ? row.closest('tr') : null;

    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetRow.classList.add('np-row-highlight');
      setTimeout(() => targetRow.classList.remove('np-row-highlight'), 2000);
    }
  }

  // ─── STAT DRAWER ───────────────────────────────────────────────────────────
  function renderStatDrawer(filter, drawer) {
    const all = getPurchases();
    let items, title;

    if (filter === 'all') {
      items = [...all].sort((a, b) => new Date(b.date) - new Date(a.date));
      title = `All Purchases (${items.length})`;
    } else if (filter === 'unsold') {
      items = all.filter(p => p.soldPrice === null).sort((a, b) => new Date(b.date) - new Date(a.date));
      title = `Unsold Items (${items.length})`;
    } else {
      items = all.filter(p => p.soldPrice !== null).sort((a, b) => new Date(b.soldDate) - new Date(a.soldDate));
      title = `Sold Items (${items.length})`;
    }

    drawer.innerHTML = `
      <div class="np-drawer-header">${title}</div>
      <table class="np-drawer-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Date</th>
            <th>Qty</th>
            <th>Paid</th>
            ${filter === 'sold' ? '<th>P&L</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${items.map(p => {
            const pl = filter === 'sold' ? (p.soldPrice - p.price) * (p.soldQty || p.qty) : null;
            return `<tr class="np-drawer-row" data-id="${p.id}" title="Jump to item">
              <td class="np-item-name" style="max-width:100px">${escHtml(p.item)}</td>
              <td class="np-date-cell">${formatDate(filter === 'sold' ? p.soldDate : p.date)}</td>
              <td class="np-bright">${p.qty}</td>
              <td class="np-bright">${formatNP(p.price)}</td>
              ${filter === 'sold' ? `<td class="${pl >= 0 ? 'np-green' : 'np-red'}">${pl >= 0 ? '+' : ''}${formatNP(pl)}</td>` : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    drawer.querySelectorAll('.np-drawer-row').forEach(row => {
      row.addEventListener('click', () => jumpToPurchase(parseInt(row.dataset.id)));
    });
  }

  function exportCSV() {
    const purchases = getPurchases();
    const rows = [['Date', 'Item', 'Qty', 'Price Paid', 'Sold Price', 'Profit', 'Notes']];
    purchases.forEach(p => {
      const profit = p.soldPrice !== null ? (p.soldPrice - p.price) * p.qty : '';
      rows.push([formatDate(p.date), p.item, p.qty, p.price, p.soldPrice ?? '', profit, p.notes || '']);
    });
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'np-purchases.csv';
    a.click();
  }

  // ─── ITEMDB PRICE LOOKUP ───────────────────────────────────────────────────
  function fetchItemdbPrice(itemName, id, cellEl) {
    const cell = cellEl || document.getElementById(`market-${id}`);
    if (!cell) return;
    cell.innerHTML = '<span class="np-muted">Loading…</span>';
    // Full redraw: every row of this item (and its group totals) picks up the price
    const redraw = () => renderPanelTable(getPurchases());
    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://itemdb.com.br/api/v1/items/${encodeURIComponent(itemName)}`,
      headers: { 'Accept': 'application/json' },
      onload: function(response) {
        try {
          const data = JSON.parse(response.responseText);
          if (data && data.price && data.price.value) {
            marketPrices[itemName] = { value: data.price.value, inflated: !!data.price.inflated, slug: data.slug || null };
          } else {
            marketPrices[itemName] = { value: null };
          }
          redraw();
        } catch(e) { cell.innerHTML = '<span class="np-muted">Error</span>'; }
      },
      onerror: () => { cell.innerHTML = '<span class="np-muted">Failed</span>'; }
    });
  }

  // ─── MODALS ────────────────────────────────────────────────────────────────
  function showAlertModal(id, itemName, pricePaid) {
    const alerts = getAlerts();
    const existing = alerts[id] || {};
    const overlay = document.createElement('div');
    overlay.className = 'np-modal-overlay';
    overlay.innerHTML = `
      <div class="np-modal-box">
        <div class="np-modal-header">
          <span class="np-modal-star">🔔</span>
          <h2>Set Price Alert</h2>
          <span class="np-modal-star">🔔</span>
        </div>
        <p class="np-modal-sub">${escHtml(itemName)} — bought for ${formatNP(pricePaid)} NP</p>
        <div class="np-field">
          <label>Alert when price reaches (NP)</label>
          <input id="al-target" type="number" value="${existing.targetPrice || ''}" placeholder="e.g. 2000000" />
        </div>
        <div class="np-field">
          <label>Alert when profit margin reaches (%)</label>
          <input id="al-margin" type="number" value="${existing.targetMargin || ''}" placeholder="e.g. 20" />
        </div>
        <div class="np-modal-buttons">
          <button id="al-save">✦ Save Alert</button>
          <button id="al-clear" class="np-btn-danger">Clear</button>
          <button id="al-cancel" class="np-btn-secondary">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('al-save').addEventListener('click', () => {
      const targetPrice = parseInt(document.getElementById('al-target').value) || null;
      const targetMargin = parseFloat(document.getElementById('al-margin').value) || null;
      if (!targetPrice && !targetMargin) { alert('Set at least one condition.'); return; }
      const alerts = getAlerts();
      alerts[id] = { targetPrice, targetMargin, lastKnownPrice: existing.lastKnownPrice || null };
      saveAlerts(alerts);
      overlay.remove();
      renderPanelTable(getPurchases());
    });
    document.getElementById('al-clear').addEventListener('click', () => {
      const alerts = getAlerts();
      delete alerts[id];
      saveAlerts(alerts);
      overlay.remove();
      renderPanelTable(getPurchases());
    });
    document.getElementById('al-cancel').addEventListener('click', () => overlay.remove());
  }

  function showEditModal(purchase) {
    const overlay = document.createElement('div');
    overlay.className = 'np-modal-overlay';
    const hasSale = purchase.soldPrice !== null && purchase.soldPrice !== undefined;
    overlay.innerHTML = `
      <div class="np-modal-box">
        <div class="np-modal-header">
          <span class="np-modal-star">✦</span>
          <h2>Edit Entry</h2>
          <span class="np-modal-star">✦</span>
        </div>
        <div class="np-field">
          <label>Item Name</label>
          <input id="edit-item" type="text" value="${escHtml(purchase.item)}" />
        </div>
        <div class="np-row">
          <div class="np-field">
            <label>Price Paid Per Item (NP)</label>
            <input id="edit-price" type="number" value="${purchase.price}" />
          </div>
          <div class="np-field">
            <label>Quantity</label>
            <input id="edit-qty" type="number" value="${purchase.qty}" min="1" />
          </div>
        </div>
        <div class="np-field">
          <label>Notes</label>
          <input id="edit-notes" type="text" value="${escHtml(purchase.notes || '')}" />
        </div>
        <div class="np-field">
          <label>Date Bought</label>
          ${dateField('edit-date', purchase.date)}
        </div>
        ${hasSale ? `
        <div style="border-top:1px solid #444444;margin:10px 0 14px;padding-top:12px;">
          <div style="font-size:10px;color:#e8a800;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Sale Record</div>
          <div class="np-row">
            <div class="np-field">
              <label>Sale Price Per Item (NP)</label>
              <input id="edit-soldprice" type="number" value="${purchase.soldPrice}" />
            </div>
            <div class="np-field">
              <label>Qty Sold</label>
              <input id="edit-soldqty" type="number" value="${purchase.soldQty || purchase.qty}" min="1" />
            </div>
          </div>
          <div class="np-field">
            <label>Date Sold</label>
            ${dateField('edit-solddate', purchase.soldDate)}
          </div>
          <div id="edit-pnl-preview" style="text-align:center;font-size:13px;padding:6px 0;"></div>
        </div>
        ` : ''}
        <div class="np-modal-buttons">
          <button id="edit-save">✦ Save Changes</button>
          <button id="edit-cancel" class="np-btn-secondary">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Live P&L preview
    function updatePreview() {
      const preview = document.getElementById('edit-pnl-preview');
      if (!preview) return;
      const price = parseInt(document.getElementById('edit-price').value) || 0;
      const soldPrice = parseInt(document.getElementById('edit-soldprice').value) || 0;
      const soldQty = parseInt(document.getElementById('edit-soldqty').value) || 1;
      const pl = (soldPrice - price) * soldQty;
      const sign = pl >= 0 ? '+' : '';
      preview.innerHTML = `P&amp;L preview: <strong class="${pl >= 0 ? 'np-green' : 'np-red'}">${sign}${formatNP(pl)} NP</strong> <span class="np-muted">(${formatNP(soldPrice)} − ${formatNP(price)} × ${soldQty})</span>`;
    }
    if (hasSale) {
      updatePreview();
      ['edit-price','edit-soldprice','edit-soldqty'].forEach(id => {
        document.getElementById(id).addEventListener('input', updatePreview);
      });
    }

    document.getElementById('edit-save').addEventListener('click', () => {
      const item = document.getElementById('edit-item').value.trim();
      const price = parseInt(document.getElementById('edit-price').value) || 0;
      const qty = parseInt(document.getElementById('edit-qty').value) || 1;
      const notes = document.getElementById('edit-notes').value.trim();
      if (!item) { alert('Item name cannot be empty.'); return; }
      const date = fromDateInput(document.getElementById('edit-date').value, purchase.date);
      let updates = { item, price, qty, notes, date };
      if (hasSale) {
        const soldPrice = parseInt(document.getElementById('edit-soldprice').value) || 0;
        const soldQty = parseInt(document.getElementById('edit-soldqty').value) || 1;
        const soldDate = fromDateInput(document.getElementById('edit-solddate').value, purchase.soldDate);
        if (Date.parse(soldDate) < Date.parse(date) && toDateInput(soldDate) !== toDateInput(date)) {
          alert('Date sold is before date bought.'); return;
        }
        updates = { ...updates, soldPrice, soldQty, soldDate };
      }
      const purchases = getPurchases().map(p => p.id === purchase.id ? { ...p, ...updates } : p);
      savePurchases(purchases);
      overlay.remove();
      renderPanelTable(purchases);
      updatePanelStats();
    });
    document.getElementById('edit-cancel').addEventListener('click', () => overlay.remove());
  }

  function showSellModal(purchase) {
    const overlay = document.createElement('div');
    overlay.className = 'np-modal-overlay';
    overlay.innerHTML = `
      <div class="np-modal-box">
        <div class="np-modal-header">
          <span class="np-modal-star">✦</span>
          <h2>Record Sale</h2>
          <span class="np-modal-star">✦</span>
        </div>
        <p class="np-modal-sub">${escHtml(purchase.item)} — ${purchase.qty} @ ${formatNP(purchase.price)} NP each</p>
        <div class="np-field">
          <label>Quantity Sold</label>
          <input id="sell-qty" type="number" value="${purchase.qty}" min="1" max="${purchase.qty}" />
        </div>
        <div class="np-field">
          <label>Sale Price Per Item (NP)</label>
          <input id="sell-price" type="number" placeholder="e.g. 2000000" />
        </div>
        <div class="np-field">
          <label>Date Sold</label>
          ${dateField('sell-date', null)}
        </div>
        <div class="np-modal-buttons">
          <button id="sell-save">✦ Record Sale</button>
          <button id="sell-cancel" class="np-btn-secondary">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('sell-save').addEventListener('click', () => {
      const qtySold = parseInt(document.getElementById('sell-qty').value) || 0;
      const soldPrice = parseInt(document.getElementById('sell-price').value) || 0;
      if (qtySold < 1 || qtySold > purchase.qty) { alert('Invalid quantity.'); return; }
      if (soldPrice < 1) { alert('Please enter a valid sale price.'); return; }
      const soldDate = fromDateInput(document.getElementById('sell-date').value);
      if (Date.parse(soldDate) < Date.parse(purchase.date) && toDateInput(soldDate) !== toDateInput(purchase.date)) {
        alert('Date sold is before the date you bought it.'); return;
      }
      let purchases = getPurchases();
      if (qtySold === purchase.qty) {
        purchases = purchases.map(p => p.id === purchase.id ? { ...p, soldPrice, soldQty: qtySold, soldDate } : p);
      } else {
        purchases = purchases.map(p => p.id === purchase.id ? { ...p, qty: p.qty - qtySold } : p);
        purchases.push({ id: Date.now(), item: purchase.item, price: purchase.price, qty: qtySold, soldQty: qtySold, soldPrice, soldDate, date: purchase.date, notes: purchase.notes || '' });
      }
      savePurchases(purchases);
      overlay.remove();
      renderPanelTable(purchases);
      updatePanelStats();
    });
    document.getElementById('sell-cancel').addEventListener('click', () => overlay.remove());
  }

  // ─── DETECT TRADE ──────────────────────────────────────────────────────────
  function detectTrade() {
    if (window._npTrackerFired) return;
    const popup = document.querySelector('.tp-popup-confirm');
    if (!popup) return;
    if (isLotPurchasedPopup(popup)) return; // handled by the Instant Buy logger below
    if (isOfferAcceptedPopup(popup)) return; // handled by the offer logger below
    const purchaseMatch = popup.innerText.match(/for ([\d,]+) NP\.?\s+(.+?)\s+All items have been placed/is);
    if (!purchaseMatch) return;
    window._npTrackerFired = true;
    let itemName = purchaseMatch[2].trim();
    let qty = 1;
    // Trading post sometimes prepends qty to item name e.g. "4Super Negg" or "4 Super Negg"
    const qtyPrefix = itemName.match(/^(\d+)\s*/);
    if (qtyPrefix) {
      qty = parseInt(qtyPrefix[1], 10);
      itemName = itemName.slice(qtyPrefix[0].length).trim();
    }
    showTradeCapture(itemName, parseInt(purchaseMatch[1].replace(/,/g, ''), 10), qty);
  }

  function showTradeCapture(detectedItem, detectedPrice, detectedQty) {
    injectStyles();
    const overlay = document.createElement('div');
    overlay.className = 'np-modal-overlay';
    overlay.innerHTML = `
      <div class="np-modal-box">
        <div class="np-modal-header">
          <span class="np-modal-star">✦</span>
          <h2>Log This Purchase</h2>
          <span class="np-modal-star">✦</span>
        </div>
        <p class="np-modal-sub">Detected a completed trade! Confirm or edit below.</p>
        <div class="np-field">
          <label>Item Name</label>
          <input id="np-item" type="text" value="${detectedItem}" />
        </div>
        <div class="np-row">
          <div class="np-field">
            <label>Price Paid (NP)</label>
            <input id="np-price" type="number" value="${detectedPrice}" />
          </div>
          <div class="np-field">
            <label>Quantity</label>
            <input id="np-qty" type="number" value="${detectedQty}" min="1" />
          </div>
        </div>
        <div class="np-field">
          <label>Notes (optional)</label>
          <textarea id="np-notes" placeholder="e.g. good deal..."></textarea>
        </div>
        <div class="np-field">
          <label>Date Bought</label>
          ${dateField('np-date', null)}
        </div>
        <div class="np-modal-buttons">
          <button id="np-save-btn">✦ Save Purchase</button>
          <button id="np-cancel-btn" class="np-btn-secondary">Dismiss</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    document.getElementById('np-save-btn').addEventListener('click', () => {
      const item = document.getElementById('np-item').value.trim();
      const price = parseInt(document.getElementById('np-price').value) || 0;
      const qty = parseInt(document.getElementById('np-qty').value) || 1;
      const notes = document.getElementById('np-notes').value.trim();
      const date = fromDateInput(document.getElementById('np-date').value);
      if (!item) { alert('Please enter an item name!'); return; }
      const purchases = getPurchases();
      purchases.push({ id: Date.now(), item, price, qty, notes, date, soldPrice: null, soldDate: null });
      savePurchases(purchases);
      overlay.remove();
      showToast(`"${item}" logged!`);
    });
    document.getElementById('np-cancel-btn').addEventListener('click', () => overlay.remove());
  }

  function showToast(message) {
    injectStyles();
    const toast = document.createElement('div');
    toast.className = 'np-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('np-toast-show'), 10);
    setTimeout(() => { toast.classList.remove('np-toast-show'); setTimeout(() => toast.remove(), 400); }, 3000);
  }

  // ─── UTILITIES ─────────────────────────────────────────────────────────────
  function formatNP(n) { return Number(n).toLocaleString('en-US'); }
  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  }
  function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ─── DATE FIELDS ───────────────────────────────────────────────────────────
  // <input type="date"> value (local day) for an ISO timestamp; no arg = today
  function toDateInput(iso) {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  // Back to ISO: same day as keepIso → keep its exact time; today → now;
  // any other day → that day at 12:00 local (safe from timezone day-slips).
  function fromDateInput(val, keepIso) {
    if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) return keepIso || new Date().toISOString();
    if (keepIso && toDateInput(keepIso) === val) return keepIso;
    if (val === toDateInput()) return new Date().toISOString();
    const [y, m, d] = val.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0).toISOString();
  }
  function dateField(id, iso) {
    return `<input id="${id}" type="date" value="${toDateInput(iso)}" max="${toDateInput()}" />`;
  }

  // ─── STYLES — ALL SCOPED WITH np- PREFIX ───────────────────────────────────
  function injectStyles() {
    if (document.getElementById('np-tracker-styles')) return;
    const s = document.createElement('style');
    s.id = 'np-tracker-styles';
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;500;700&display=swap');

      /* ── Tracker Button ── */
      #np-tracker-btn {
        position: fixed; top: 20px; right: 20px; z-index: 999998;
        background: #e8a800;
        border: none; border-radius: 8px; color: #2c2c2c;
        font-family: 'Ubuntu', Arial, sans-serif; font-weight: bold;
        font-size: 13px; padding: 10px 16px; cursor: pointer;
        box-shadow: 0 4px 20px rgba(232,168,0,0.4);
        transition: opacity 0.2s, box-shadow 0.2s;
        user-select: none; touch-action: none;
      }
      #np-tracker-btn:hover { opacity: 0.85; }
      #np-tracker-btn.np-btn-dragging {
        cursor: grabbing; opacity: 0.9;
        box-shadow: 0 8px 30px rgba(232,168,0,0.65);
      }

      /* ── Panel ── */
      #np-tracker-panel {
        position: fixed; top: 0; right: 0; width: 380px; height: 100vh;
        background: #2c2c2c; border-left: 2px solid #e8a800;
        z-index: 999997; overflow: hidden;
        transition: transform 0.35s cubic-bezier(0.4,0,0.2,1);
        transform: translateX(100%);
        font-family: 'Ubuntu', Arial, sans-serif; color: #dddddd;
        box-shadow: -8px 0 40px rgba(0,0,0,0.6);
        box-sizing: border-box;
      }
      #np-tracker-panel * { box-sizing: border-box; }
      #np-tracker-panel.np-panel-show { transform: translateX(0); }

      /* Floating window */
      #np-tracker-panel.np-floating {
        border: 2px solid #e8a800; border-radius: 10px;
        transform: none; opacity: 0; transition: opacity 0.2s;
        box-shadow: 0 12px 50px rgba(0,0,0,0.7);
      }
      #np-tracker-panel.np-floating.np-panel-show { opacity: 1; transform: none; }

      /* Resize handles — docked shows only the left edge */
      .np-rz { position: absolute; z-index: 10; background: transparent; transition: background 0.2s; }
      .np-rz[data-dir="w"]  { left: 0; top: 0; bottom: 0; width: 6px; cursor: ew-resize; }
      .np-rz[data-dir="e"]  { right: 0; top: 0; bottom: 0; width: 6px; cursor: ew-resize; }
      .np-rz[data-dir="s"]  { left: 0; right: 0; bottom: 0; height: 6px; cursor: ns-resize; }
      .np-rz[data-dir="se"] { right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 11; }
      .np-rz[data-dir="sw"] { left: 0; bottom: 0; width: 16px; height: 16px; cursor: nesw-resize; z-index: 11; }
      .np-rz:hover { background: rgba(232,168,0,0.3); }
      .np-rz[data-dir="se"]::after {
        content: ''; position: absolute; right: 3px; bottom: 3px; width: 8px; height: 8px;
        border-right: 2px solid #e8a800; border-bottom: 2px solid #e8a800; opacity: 0.6;
      }
      #np-tracker-panel:not(.np-floating) .np-rz:not([data-dir="w"]) { display: none; }

      #np-panel-inner { padding: 20px; overflow-x: hidden; overflow-y: auto; height: 100%; }

      #np-panel-dock {
        background: transparent !important; border: 1px solid #666666 !important;
        border-radius: 6px !important; color: #999999 !important;
        padding: 4px 8px !important; cursor: pointer !important; margin-right: 6px;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important; white-space: nowrap;
        transition: color 0.2s, border-color 0.2s;
      }
      #np-panel-dock:hover { color: #fff8dd !important; border-color: #e8a800 !important; }

      /* Sortable column headers: faint ⇅ until in use, then ▲ / ▼ */
      #np-panel-table th.np-sortable { cursor: pointer; user-select: none; }
      #np-panel-table th.np-sortable:hover { color: #ffd88a; }
      #np-panel-table th.np-sort-on { color: #ffd88a; }
      #np-panel-table th.np-sortable::after { content: attr(data-arrow); font-size: 9px; white-space: nowrap; }
      #np-panel-table th.np-sortable:not(.np-sort-on)::after { opacity: 0.45; }
      #np-panel-table th.np-sortable:hover::after { opacity: 1; }
      #np-panel-table th.np-sort-reset { color: #666666; text-align: center; }

      .np-panel-header {
        display: flex; align-items: center; justify-content: space-between;
        /* PBP amber title bar — stays pinned while the panel scrolls, so it can always be dragged */
        position: sticky; top: -20px; margin: -20px -20px 16px; padding: 7px 10px 7px 12px;
        background: #e8a800; border-bottom: 2px solid #b07800; z-index: 5; cursor: move;
      }
      .np-panel-title {
        color: #fff8dd; font-size: 12px; font-weight: 700; letter-spacing: 0.5px;
        flex: 1; user-select: none; display: flex; align-items: center; gap: 6px;
      }
      .np-panel-title .np-tb-tag { color: #7a5600; font-size: 9px; letter-spacing: 1px; text-transform: uppercase; }
      .np-panel-header #np-panel-dock, .np-panel-header #np-panel-close {
        border-color: #b07800 !important; color: #7a5600 !important; background: transparent !important;
        padding: 2px 7px !important; font-size: 11px !important;
      }
      .np-panel-header #np-panel-dock:hover, .np-panel-header #np-panel-close:hover {
        color: #fff8dd !important; border-color: #fff8dd !important;
      }

      #np-panel-close {
        background: transparent !important; border: 1px solid #666666 !important;
        border-radius: 6px !important; color: #999999 !important;
        padding: 4px 10px !important; cursor: pointer !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 13px !important;
        transition: color 0.2s, border-color 0.2s;
      }
      #np-panel-close:hover { color: #fff8dd !important; border-color: #e8a800 !important; }

      .np-panel-stats { display: flex; gap: 8px; margin-bottom: 12px; }
      .np-stat {
        flex: 1; background: #232323; border: 1px solid #444444;
        border-radius: 8px; padding: 10px 8px; text-align: center;
      }
      .np-stat-label { font-size: 10px; color: #999999; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
      .np-stat-val { font-size: 13px; color: #ffd88a; }
      .np-stat-val.np-green { color: #5fc48a; }
      .np-stat-val.np-red { color: #e06060; }
      .np-stat-clickable { cursor: pointer; transition: border-color 0.2s, background 0.2s; }
      .np-stat-clickable:hover { border-color: #e8a800 !important; background: #333333 !important; }
      .np-stat-active { border-color: #e8a800 !important; background: #333333 !important; }
      .np-stat-active .np-stat-label::after { content: ' ▲'; font-size: 8px; }

      #np-stat-drawer {
        background: #262626; border: 1px solid #444444; border-radius: 8px;
        margin-bottom: 12px; max-height: 260px; overflow-y: auto;
      }
      .np-drawer-header {
        font-size: 10px; color: #e8a800; text-transform: uppercase; letter-spacing: 1px;
        padding: 8px 10px; border-bottom: 1px solid #444444; position: sticky; top: 0;
        background: #262626; z-index: 1;
      }
      .np-drawer-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .np-drawer-table th {
        font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: #999999;
        padding: 5px 8px; text-align: left; border-bottom: 1px solid #444444;
      }
      .np-drawer-table td { padding: 5px 8px; border-bottom: 1px solid rgba(68,68,68,0.3); color: #dddddd; }
      .np-drawer-row { cursor: pointer; }
      .np-drawer-row:hover td { background: rgba(232,168,0,0.08); }

      #np-portfolio-summary { margin-bottom: 12px; }
      .np-portfolio-bar {
        background: #232323; border: 1px solid #e8a800;
        border-radius: 8px; padding: 12px;
        display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
      }
      .np-pf-stat { flex: 1; text-align: center; }
      .np-pf-label { font-size: 10px; color: #999999; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 3px; }
      .np-pf-val { font-size: 13px; color: #ffd88a; font-weight: bold; }
      .np-pf-note { width: 100%; text-align: center; font-size: 11px; color: #666666; margin-top: 4px; }

      .np-panel-toolbar { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }

      .np-btn-add {
        background: #e8a800 !important;
        border: none !important; border-radius: 6px !important; color: #2c2c2c !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-weight: bold !important;
        font-size: 12px !important; padding: 7px 12px !important;
        cursor: pointer !important; white-space: nowrap !important;
      }

      .np-panel-search {
        flex: 1; background: #232323; border: 1px solid #444444;
        border-radius: 6px; color: #dddddd; font-family: 'Ubuntu', Arial, sans-serif;
        font-size: 13px; padding: 7px 10px; outline: none;
        transition: border-color 0.2s;
      }
      .np-panel-search:focus { border-color: #e8a800; }
      .np-view-toggle { display: flex; border: 1px solid #444444; border-radius: 6px; overflow: hidden; flex-shrink: 0; }
      .np-view-toggle button {
        background: #232323 !important; border: none !important; color: #999999 !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important;
        padding: 7px 9px !important; cursor: pointer !important; transition: color 0.2s, background 0.2s;
      }
      .np-view-toggle button + button { border-left: 1px solid #444444 !important; }
      .np-view-toggle button:hover { color: #e8a800 !important; }
      .np-view-toggle button.np-view-on { background: #444444 !important; color: #ffd88a !important; }
      #np-panel-table tr.np-grp-row { cursor: pointer; }
      #np-panel-table tr.np-grp-row td { background: rgba(68,68,68,0.35); }
      #np-panel-table tr.np-grp-row:hover td { background: rgba(232,168,0,0.18); }
      #np-panel-table tr.np-grp-open td { border-bottom-color: #c8a84b55; }
      .np-grp-caret { display: inline-block; width: 12px; color: #e8a800; font-size: 11px; }
      .np-grp-count { color: #999999; font-size: 11px; font-weight: normal; }
      #np-panel-table tr.np-grp-child td { background: rgba(0,0,0,0.18); font-size: 12px; }
      #np-panel-table tr.np-grp-child td:first-child { padding-left: 18px; border-left: 2px solid #c8a84b55; }
      #np-panel-table tr.np-grp-child .np-item-name { font-size: 12px; color: #e0c080 !important; }
      .np-panel-search::placeholder { color: #666666; }

      #np-panel-refresh, #np-panel-export, #np-panel-import,
      #np-watch-check, #np-watch-export, #np-watch-import {
        flex: 1; background: #232323 !important; border: 1px solid #444444 !important;
        border-radius: 6px !important; color: #999999 !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important;
        padding: 7px 4px !important; cursor: pointer !important;
        transition: border-color 0.2s, color 0.2s; text-align: center !important;
      }
      #np-panel-refresh:hover, #np-watch-check:hover { border-color: #e8a800 !important; color: #e8a800 !important; }
      #np-panel-export:hover, #np-watch-export:hover { border-color: #5fc48a !important; color: #5fc48a !important; }
      #np-panel-import:hover, #np-watch-import:hover { border-color: #b07800 !important; color: #b07800 !important; }
      #np-panel-refresh:disabled, #np-watch-check:disabled { opacity: 0.5 !important; cursor: not-allowed !important; }

      #np-panel-manual-form {
        background: #232323; border: 1px solid #444444;
        border-radius: 8px; padding: 12px; margin-bottom: 10px;
      }
      .np-form-row { display: flex; gap: 6px; }
      #np-panel-manual-form input {
        background: #2c2c2c !important; border: 1px solid #444444 !important;
        border-radius: 5px !important; color: #dddddd !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 13px !important;
        padding: 6px 8px !important; outline: none !important; flex: 1;
        transition: border-color 0.2s;
      }
      #np-panel-manual-form input:focus { border-color: #e8a800 !important; }
      .np-form-actions { display: flex; gap: 8px; margin-top: 8px; }
      .np-pf-date-row { align-items: center; margin-top: 6px; }
      .np-pf-date-row label {
        font-size: 10px; color: #e8a800; text-transform: uppercase; letter-spacing: 1px; white-space: nowrap;
      }
      #np-tracker-panel input[type="date"], .np-modal-box input[type="date"] { color-scheme: dark; }
      #np-pf-save {
        background: #e8a800 !important;
        border: none !important; border-radius: 6px !important; color: #2c2c2c !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-weight: bold !important;
        font-size: 12px !important; padding: 7px 16px !important; cursor: pointer !important;
      }
      #np-pf-cancel {
        background: transparent !important; border: 1px solid #444444 !important;
        border-radius: 6px !important; color: #999999 !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 12px !important;
        padding: 7px 12px !important; cursor: pointer !important;
      }

      #np-view-purchases, #np-view-pnl, #np-view-watch { width: 100%; overflow-x: hidden; }
      #np-panel-table-wrap { width: 100%; overflow-x: auto; }

      #np-panel-table th {
        font-size: 10px; letter-spacing: 1px; text-transform: uppercase;
        color: #e8a800; padding: 8px 5px; text-align: left;
        border-bottom: 1px solid #444444;
      }
      #np-panel-table td {
        padding: 8px 5px; border-bottom: 1px solid rgba(68,68,68,0.4);
        vertical-align: middle; color: #dddddd;
      }
      #np-panel-table tr:hover td { background: rgba(232,168,0,0.08); }
      /* Item names wrap onto extra lines instead of being cut off */
      .np-item-name {
        color: #ffd88a !important; font-weight: 500; max-width: 100px;
        white-space: normal; overflow-wrap: anywhere; line-height: 1.3;
      }
      #np-panel-table .np-item-name { max-width: none; min-width: 110px; font-size: 13px; }
      .np-date-cell { color: #aaaaaa !important; font-size: 11px; white-space: nowrap; }
      .np-sold-ea { color: #dddddd; font-size: 12px; }
      .np-sold-total { color: #e8a800; font-size: 11px; }
      .np-date-tiny { font-size: 10px; display: block; margin-top: 1px; }
      .np-bright { color: #dddddd !important; }
      .np-muted { color: #999999 !important; }
      .np-green { color: #5fc48a !important; }
      .np-red { color: #e06060 !important; }
      .np-market-price { color: #ffd88a; text-decoration: none; border-bottom: 1px dotted #e8a800; font-size: 12px; white-space: nowrap; }

      .np-btn-sell, .np-btn-check-price, .np-btn-edit, .np-btn-delete, .np-btn-alert {
        background: transparent !important; cursor: pointer !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important;
        padding: 2px 5px !important; border-radius: 4px !important;
        transition: background 0.2s, color 0.2s;
      }
      .np-btn-sell { border: 1px solid #5fc48a !important; color: #5fc48a !important; }
      .np-btn-sell:hover { background: #5fc48a !important; color: #2c2c2c !important; }
      .np-btn-check-price { border: 1px solid #b07800 !important; color: #b07800 !important; }
      .np-btn-check-price:hover { background: #b07800 !important; color: #fff !important; }
      .np-btn-edit { border: none !important; color: #999999 !important; }
      .np-btn-edit:hover { color: #e8a800 !important; }
      .np-btn-delete { border: none !important; color: #999999 !important; }
      .np-btn-delete:hover { color: #e06060 !important; }
      .np-btn-alert { border: none !important; opacity: 0.4; font-size: 13px !important; }
      .np-btn-alert:hover { opacity: 1; }
      .np-btn-alert.np-btn-alert-active { opacity: 1; filter: drop-shadow(0 0 4px gold); }

      .np-hidden { display: none !important; }

      /* ── Offers View ── */
      #np-view-offers .np-pnl-cards { margin-bottom: 8px; }
      .np-offer-sync { font-size: 11px; margin-bottom: 10px; text-align: center; }
      .np-offer-link-inline { color: #e8a800 !important; }
      .np-offers-sort {
        flex: 1; background: #2c2c2c !important; border: 1px solid #444444 !important;
        border-radius: 5px !important; color: #dddddd !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 12px !important; padding: 5px !important;
        color-scheme: dark;
      }
      .np-offer-card {
        background: #232323; border: 1px solid #444444; border-radius: 8px;
        padding: 9px 10px; margin-bottom: 8px; font-size: 12px; color: #dddddd;
      }
      .np-offer-card:hover { border-color: #b07800; }
      .np-offer-gone { opacity: 0.55; }
      .np-offer-head { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; }
      .np-offer-lot { color: #e8a800; font-weight: bold; }
      .np-offer-seller { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .np-offer-age { font-size: 10px; white-space: nowrap; }
      .np-offer-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-bottom: 4px; }
      .np-offer-label {
        font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #999999; width: 26px;
      }
      .np-offer-item {
        background: #333333; border: 1px solid #444444; border-radius: 4px;
        padding: 1px 6px; font-size: 11px;
      }
      .np-offer-np { color: #ffd88a; }
      .np-offer-value { font-size: 11px; margin: 6px 0 2px; }
      .np-offer-tp { color: #b07800; font-size: 10px; }
      .np-offer-link { display: inline-block; margin-top: 4px; font-size: 11px; color: #e8a800 !important; text-decoration: none; }
      .np-offer-link:hover { text-decoration: underline; }
      .np-offers-gone { margin-top: 12px; }
      .np-offers-gone summary { cursor: pointer; font-size: 11px; color: #e8a800; margin-bottom: 8px; }
      .np-offer-gone-note { font-size: 10px; margin-bottom: 8px; }

      /* ── Watch View ── */
      #np-view-watch .np-pnl-cards { grid-template-columns: repeat(2, 1fr); margin-bottom: 10px; }
      .np-tab-badge { color: #e8a800; font-weight: bold; }
      .np-tab.np-tab-active .np-tab-badge { color: #7a1a00; }
      .np-watch-card.np-watch-hit { border-color: #e8a800; box-shadow: inset 0 0 0 1px #e8a800; }
      .np-watch-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; margin-bottom: 4px; }
      .np-watch-price { color: #ffd88a; font-size: 14px; font-weight: bold; }
      .np-watch-target {
        font-size: 11px; color: #aaaaaa; border: 1px solid #444444;
        border-radius: 4px; padding: 0 5px;
      }
      .np-watch-target.on { background: #e8a800; color: #2c2c2c; border-color: #e8a800; font-weight: bold; }
      .np-watch-spark { display: block; width: 100%; height: 34px; margin: 4px 0; background: #262626; border-radius: 4px; }
      .np-watch-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 5px; }
      .np-watch-act {
        background: transparent !important; border: 1px solid #444444 !important;
        border-radius: 4px !important; color: #aaaaaa !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important;
        padding: 2px 7px !important; cursor: pointer !important; text-decoration: none;
      }
      .np-watch-act:hover { border-color: #e8a800 !important; color: #e8a800 !important; }
      .np-watch-act:disabled { opacity: 0.4; cursor: not-allowed !important; }
      .np-watch-pill { font-size: 10px; border-radius: 4px; padding: 1px 6px; font-weight: bold; white-space: nowrap; }
      .np-watch-pill.listed  { background: #1f4d2e; color: #7ee2a0; }
      .np-watch-pill.gone    { background: #2e4a5a; color: #9fd0ea; }
      .np-watch-pill.unknown { background: #555555; color: #c8b4ec; }
      .np-watch-pill.new     { background: #444444; color: #aaaaaa; }
      .np-watch-line { font-size: 11px; margin: 3px 0; line-height: 1.45; }
      .np-watch-wish { font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .np-watch-empty { text-align: center; padding: 16px; color: #999999; font-style: italic; font-size: 12px; }
      .np-watch-foot { font-size: 10px; margin-top: 12px; line-height: 1.45; }

      /* ── Modals ── */
      .np-modal-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.75);
        z-index: 999999; display: flex; align-items: center; justify-content: center;
        font-family: 'Ubuntu', Arial, sans-serif; backdrop-filter: blur(4px);
      }
      .np-modal-box {
        background: #2c2c2c; border: 2px solid #e8a800; border-radius: 12px;
        padding: 28px 32px; width: 420px; max-width: 95vw; color: #fff8dd;
        box-shadow: 0 0 40px rgba(232,168,0,0.3);
      }
      .np-modal-box * { box-sizing: border-box; }
      .np-modal-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .np-modal-star { color: #e8a800; font-size: 18px; }
      .np-modal-header h2 { color: #ffd88a; margin: 0; font-size: 20px; flex: 1; text-align: center; }
      .np-modal-sub { color: #aaaaaa; font-size: 13px; text-align: center; margin: 0 0 18px; }
      .np-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
      .np-field label { font-size: 12px; color: #e8a800; text-transform: uppercase; letter-spacing: 1px; }
      .np-field input, .np-field textarea {
        background: #262626 !important; border: 1px solid #666666 !important;
        border-radius: 6px !important; color: #fff8dd !important;
        padding: 8px 10px !important; font-size: 14px !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; outline: none !important;
        transition: border-color 0.2s;
      }
      .np-field input:focus, .np-field textarea:focus { border-color: #e8a800 !important; }
      .np-field textarea { resize: vertical; min-height: 60px; }
      .np-row { display: flex; gap: 12px; }
      .np-row .np-field { flex: 1; }
      .np-modal-buttons { display: flex; gap: 10px; margin-top: 6px; }
      .np-modal-buttons button:first-child {
        flex: 1; background: #e8a800 !important;
        border: none !important; border-radius: 7px !important; color: #2c2c2c !important;
        font-weight: bold !important; font-size: 14px !important; padding: 10px !important;
        cursor: pointer !important; font-family: 'Ubuntu', Arial, sans-serif !important;
      }
      .np-btn-secondary {
        background: transparent !important; border: 1px solid #666666 !important;
        border-radius: 7px !important; color: #aaaaaa !important;
        padding: 10px 16px !important; cursor: pointer !important;
        font-family: 'Ubuntu', Arial, sans-serif !important;
      }
      .np-btn-danger {
        background: transparent !important; border: 1px solid #e06060 !important;
        border-radius: 7px !important; color: #e06060 !important;
        padding: 10px 14px !important; cursor: pointer !important;
        font-family: 'Ubuntu', Arial, sans-serif !important;
      }

      /* ── Alert Popup ── */
      .np-alert-popup {
        position: fixed; bottom: 30px; left: 30px; z-index: 9999999;
        background: #2c2c2c; border-radius: 12px; padding: 16px 18px;
        width: 300px; display: flex; gap: 12px; align-items: flex-start;
        font-family: 'Ubuntu', Arial, sans-serif; color: #fff8dd;
        opacity: 0; transform: translateX(-20px);
        transition: opacity 0.35s, transform 0.35s;
        box-shadow: 0 4px 30px rgba(0,0,0,0.5);
      }
      .np-alert-popup.np-alert-show { opacity: 1; transform: translateX(0); }
      .np-alert-target, .np-alert-margin { border: 2px solid #5fc48a; }
      .np-alert-drop { border: 2px solid #e06060; }
      .np-alert-icon { font-size: 24px; }
      .np-alert-body { flex: 1; }
      .np-alert-title { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: #e8a800; margin-bottom: 4px; }
      .np-alert-msg { font-size: 13px; line-height: 1.5; margin-bottom: 8px; }
      .np-alert-dismiss {
        background: transparent !important; border: 1px solid #666666 !important;
        border-radius: 5px !important; color: #999999 !important;
        font-size: 11px !important; padding: 3px 10px !important;
        cursor: pointer !important; font-family: 'Ubuntu', Arial, sans-serif !important;
      }

      /* ── Toast ── */
      .np-toast {
        position: fixed; bottom: 30px; left: 30px; z-index: 9999999;
        background: #2c2c2c; border: 1px solid #e8a800; border-radius: 8px;
        color: #ffd88a; padding: 12px 20px; font-family: 'Ubuntu', Arial, sans-serif;
        font-size: 14px; opacity: 0; transform: translateY(10px);
        transition: opacity 0.3s, transform 0.3s;
        box-shadow: 0 4px 20px rgba(232,168,0,0.3);
      }
      .np-toast-show { opacity: 1; transform: translateY(0); }

      /* ── Tabs ── */
      .np-tab-bar {
        display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px;
        border-bottom: 1px solid #444444; padding-bottom: 10px;
      }
      .np-tab {
        background: transparent !important; border: 1px solid #444444 !important;
        border-radius: 6px !important; color: #999999 !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 12px !important;
        padding: 6px 14px !important; cursor: pointer !important;
        transition: all 0.2s;
      }
      .np-tab:hover { border-color: #e8a800 !important; color: #e8a800 !important; }
      .np-tab.np-tab-active {
        background: #e8a800 !important;
        border-color: transparent !important; color: #2c2c2c !important;
        font-weight: bold !important;
      }

      /* ── P&L View ── */
      .np-pnl-period-bar {
        display: flex; gap: 5px; margin-bottom: 6px;
      }
      .np-pnl-row2 { margin-bottom: 12px; }
      .np-pnl-period {
        flex: 1; background: transparent !important; border: 1px solid #444444 !important;
        border-radius: 5px !important; color: #999999 !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important;
        padding: 5px 4px !important; cursor: pointer !important; transition: all 0.2s;
      }
      .np-pnl-period:hover { border-color: #b07800 !important; color: #e8a800 !important; }
      .np-pnl-period.np-pnl-period-active {
        background: #b07800 !important; border-color: #b07800 !important;
        color: #fff8dd !important; font-weight: bold !important;
      }
      #np-pnl-daterange {
        background: #232323; border: 1px solid #444444; border-radius: 8px;
        padding: 10px; margin-bottom: 12px;
      }
      .np-pnl-range-row { display: flex; gap: 8px; align-items: flex-end; }
      .np-pnl-range-field { display: flex; flex-direction: column; gap: 4px; flex: 1; }
      .np-pnl-range-field label { font-size: 10px; color: #e8a800; text-transform: uppercase; letter-spacing: 0.8px; }
      .np-pnl-range-field input[type="date"] {
        background: #2c2c2c !important; border: 1px solid #444444 !important;
        border-radius: 5px !important; color: #dddddd !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important;
        padding: 5px 6px !important; outline: none !important;
        color-scheme: dark;
      }
      .np-pnl-range-field input[type="date"]:focus { border-color: #e8a800 !important; }
      #np-pnl-range-apply {
        background: #e8a800 !important;
        border: none !important; border-radius: 5px !important; color: #2c2c2c !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-weight: bold !important;
        font-size: 12px !important; padding: 6px 12px !important; cursor: pointer !important;
        white-space: nowrap;
      }
      .np-pnl-heading {
        font-size: 14px; color: #e8a800; letter-spacing: 1px;
        text-transform: uppercase; margin-bottom: 12px; text-align: center;
      }
      .np-pnl-cards {
        display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px;
      }
      .np-pnl-card {
        background: #232323; border: 1px solid #444444; border-radius: 8px;
        padding: 10px 8px; text-align: center;
      }
      .np-pnl-card-label { font-size: 10px; color: #999999; text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
      .np-pnl-card-val { font-size: 13px; color: #dddddd; font-weight: bold; }
      .np-pnl-bar-wrap { margin-bottom: 16px; }
      .np-pnl-bar-label { font-size: 10px; color: #999999; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
      .np-pnl-bar-track {
        height: 10px; background: #333333; border-radius: 5px; overflow: hidden; margin-bottom: 5px;
      }
      .np-pnl-bar-fill { height: 100%; border-radius: 5px; transition: width 0.4s ease; }
      .np-pnl-bar-profit { background: #5fc48a; }
      .np-pnl-bar-loss { background: #e06060; }
      .np-pnl-bar-legend { display: flex; justify-content: space-between; font-size: 10px; }
      .np-pnl-section-title {
        font-size: 10px; color: #e8a800; text-transform: uppercase; letter-spacing: 1px;
        margin-bottom: 8px; padding-bottom: 5px; border-bottom: 1px solid #444444;
      }
      .np-pnl-table { width: 100%; border-collapse: collapse; font-size: 12px; }
      .np-pnl-table th {
        font-size: 10px; letter-spacing: 1px; text-transform: uppercase;
        color: #e8a800; padding: 6px 5px; text-align: left;
        border-bottom: 1px solid #444444;
      }
      .np-pnl-table td {
        padding: 6px 5px; border-bottom: 1px solid rgba(68,68,68,0.4);
        vertical-align: middle; color: #dddddd;
      }
      .np-pnl-table tr:hover td { background: rgba(232,168,0,0.08); }
      .np-pnl-see-more {
        display: block; width: 100%; margin-top: 8px;
        background: transparent !important; border: 1px dashed #444444 !important;
        border-radius: 6px !important; color: #999999 !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important;
        padding: 7px !important; cursor: pointer !important;
        transition: all 0.2s; text-align: center;
      }
      .np-pnl-see-more:hover { border-color: #e8a800 !important; color: #e8a800 !important; }
      .np-pnl-sale-row:hover td { background: rgba(232,168,0,0.1) !important; }
      .np-pnl-sale-row:hover .np-item-name { color: #ffd88a !important; text-decoration: underline dotted #e8a800; }

      @keyframes np-highlight-flash {
        0%   { background: rgba(232,168,0,0.35); }
        100% { background: transparent; }
      }
      .np-row-highlight td { animation: np-highlight-flash 2s ease-out forwards; }
    `;
    document.head.appendChild(s);
  }


  // ─── INSTANT BUY: LOG + STAY PUT ───────────────────────────────────────────
  // After an Instant Buy the TP shows a "Lot Purchased!" popup. Its Thanks!
  // button sends the Vue app to Your Lots (#/?type=view). We:
  //   1. read the popup (lot #, price, items) and queue it in np_tracker_inbox
  //   2. on Thanks!, remember the search hash and put it back after the jump
  //   3. then open the panel with the Add form pre-filled from the queue
  // We never touch the buy request itself — only the page after it's done.
  const LOGGED_LOTS_KEY = 'np_tp_logged_lots';   // sessionStorage, dedupe
  const RESTORE_WINDOW_MS = 4000;

  function isLotPurchasedPopup(popup) {
    return [...popup.querySelectorAll('p')].some(p => p.textContent.trim() === 'Lot Purchased!');
  }

  function loggedLots() {
    try { return JSON.parse(sessionStorage.getItem(LOGGED_LOTS_KEY) || '[]'); } catch { return []; }
  }
  function markLotLogged(lot) {
    const arr = loggedLots(); arr.push(lot);
    try { sessionStorage.setItem(LOGGED_LOTS_KEY, JSON.stringify(arr.slice(-50))); } catch {}
  }

  function parseLotPurchased(popup) {
    // The title, summary and button label ALL use p.text-cafeteria, so don't
    // pick one by class — read the whole popup's text and match the sentence.
    const text = (popup.textContent || '').replace(/\s+/g, ' ');
    const m = text.match(/purchased lot\s*#?\s*([\d,]+)\s+for\s+([\d,]+)\s*NP/i);
    if (!m) return null;
    const cards = [...popup.querySelectorAll('div.flex.justify-center.flex-wrap.gap-3 > div.flex.flex-col')];
    const items = cards.map(card => {
      const nameEl = card.querySelector('div.relative + p') || [...card.querySelectorAll('p')].pop();
      const countEl = card.querySelector('.item-count-big');
      const qty = countEl ? (parseInt(countEl.textContent.replace(/\D/g, ''), 10) || 1) : 1;
      return { name: nameEl ? nameEl.textContent.trim() : '', qty };
    }).filter(it => it.name);
    return { lot: m[1].replace(/,/g, ''), total: parseInt(m[2].replace(/,/g, ''), 10), items };
  }

  function queueLot(p) {
    const stamp = new Date().toLocaleDateString();
    const tag = p.via === 'offer' ? ' (offer)' : '';
    let entry;
    if (!p.items.length) {
      entry = { item: '', price: p.total, qty: 1, notes: `TP lot #${p.lot}${tag} · items not read · ${stamp}` };
    } else if (p.items.length === 1) {
      // One item type: log per-unit price × qty so the portfolio maths stays right
      const it = p.items[0];
      entry = { item: it.name, price: Math.round(p.total / it.qty), qty: it.qty,
                notes: `TP lot #${p.lot}${tag}${it.qty > 1 ? ` · ${p.total.toLocaleString('en-US')} NP total` : ''} · ${stamp}` };
    } else {
      // Bundle: full lot price on one line, primary = first card, rest in notes
      const [first, ...rest] = p.items;
      const restTxt = rest.map(it => it.qty > 1 ? `${it.qty}× ${it.name}` : it.name).join(', ');
      entry = { item: first.name, price: p.total, qty: 1,
                notes: `TP lot #${p.lot}${tag} bundle${first.qty > 1 ? ` (${first.qty}× ${first.name})` : ''} + ${restTxt} · ${stamp}` };
    }
    if (p.extra) entry.notes += ` · ${p.extra}`;
    entry.date = new Date().toISOString();   // real buy time, even if saved from the queue later
    const inbox = getInbox(); inbox.push(entry); saveInbox(inbox);
    markLotLogged(p.lot);
    showToast(`📥 Lot #${p.lot}${tag} queued for logging`);
  }

  let lotRetryTimer = null;
  function detectLotPurchased(force = false) {
    const popup = document.querySelector('.tp-popup-confirm');
    if (!popup || !isLotPurchasedPopup(popup)) return;
    let p = parseLotPurchased(popup);
    if (!p) {
      // Couldn't read the sentence — only give up silently until Thanks! is
      // clicked; then queue the raw text so the purchase is never lost.
      if (!force) return;
      const raw = (popup.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const key = 'raw:' + raw;
      if (loggedLots().includes(key)) return;
      const inbox = getInbox();
      inbox.push({ item: '', price: '', qty: 1, notes: `TP purchase (couldn't read popup): ${raw}` });
      saveInbox(inbox); markLotLogged(key);
      showToast('⚠️ Purchase queued — check the details');
      return;
    }
    if (loggedLots().includes(p.lot)) return;
    if (!p.items.length && !force) {
      // Item cards may render a moment after the text — give them a beat
      clearTimeout(lotRetryTimer);
      lotRetryTimer = setTimeout(() => detectLotPurchased(true), 800);
      return;
    }
    clearTimeout(lotRetryTimer);
    queueLot(p);
  }

  function openInboxAfterRedirect() {
    if (getInbox().length) processTrackerInbox();
  }

  // Capture phase: runs before Vue's own handler on the Thanks! button.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (!btn) return;
    const popup = btn.closest('.tp-popup-confirm');
    if (!popup || btn.textContent.trim() !== 'Thanks!' || !isLotPurchasedPopup(popup)) return;

    detectLotPurchased(true); // make sure it's queued even if we hadn't parsed yet
    const savedHash = location.hash;
    const worthRestoring = savedHash && !/type=view/.test(savedHash);

    // Vue Router may use pushState (no hashchange event), so poll the hash.
    const started = Date.now();
    const poll = setInterval(() => {
      const onYourLots = /type=view/.test(location.hash);
      if (onYourLots || Date.now() - started > RESTORE_WINDOW_MS) {
        clearInterval(poll);
        if (onYourLots && worthRestoring) {
          // replace() so Back doesn't bounce you into Your Lots
          location.replace(location.href.split('#')[0] + savedHash);
        }
        setTimeout(openInboxAfterRedirect, 300);
      }
    }, 100);
  }, true);

  // ─── OFFER ACCEPTED: LOG PURCHASE ───────────────────────────────────────────
  // When a lot owner accepts your offer, the TP shows an "Offer Accepted!"
  // popup: "You've successfully traded for lot N." with the lot's item cards
  // plus a neopoint-bag card for the NP you offered. We read it and queue the
  // buy in the inbox (same format as Instant Buy); Thanks! opens the Add form.
  // Price = the NP bag. Items = every card with an /items/ image.
  function isOfferAcceptedPopup(popup) {
    return [...popup.querySelectorAll('p')].some(p => p.textContent.trim() === 'Offer Accepted!');
  }

  function parseOfferAccepted(popup) {
    const text = (popup.textContent || '').replace(/\s+/g, ' ');
    const m = text.match(/traded for lot\s*#?\s*([\d,]+)/i);
    if (!m) return null;
    let total = 0;
    const items = [];
    for (const img of popup.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      const card = img.closest('div.flex.flex-col');
      if (!card) continue;
      const label = [...card.querySelectorAll('p')].pop();
      const txt = label ? label.textContent.trim() : '';
      if (/neopoint-bag/i.test(src)) {
        total += parseInt(txt.replace(/\D/g, ''), 10) || 0;
      } else if (/\/items\//i.test(src) && txt) {
        const countEl = card.querySelector('.item-count-big');
        const qty = countEl ? (parseInt(countEl.textContent.replace(/\D/g, ''), 10) || 1) : 1;
        items.push({ name: txt, qty });
      }
    }
    return { lot: m[1].replace(/,/g, ''), total, items, via: 'offer' };
  }

  // ─── OFFER CACHE ("Offers you have made" page) ─────────────────────────────
  // The "Offer Accepted!" popup only shows the lot's items and your NP — never
  // the items you put in the offer. The #/?type=offer-made page shows both
  // sides, and "Make the Offer" lands there, so we read every offer on that
  // page and remember it by lot number. DOM only, no extra requests.
  const OFFER_CACHE_KEY = 'np_offer_cache';
  const OFFER_CACHE_DAYS = 40;   // offers expire after 28 days
  const OFFER_SCAN_KEY = 'np_offer_cache_scanned';   // last full read of the offer-made page

  function getOfferCache() {
    try { return JSON.parse(GM_getValue(OFFER_CACHE_KEY, '{}')) || {}; } catch { return {}; }
  }
  function saveOfferCache(obj) { GM_setValue(OFFER_CACHE_KEY, JSON.stringify(obj)); }

  function readOfferPanel(header) {
    const panel = header.closest('.tp-border-color') && header.closest('.tp-border-color').parentElement;
    if (!panel) return null;
    let np = 0;
    const items = [];
    for (const nameEl of panel.querySelectorAll('.item-name-text')) {
      const row = nameEl.closest('div.flex.gap-4') || nameEl.parentElement;
      const img = row && row.querySelector('img');
      const txt = nameEl.textContent.trim();
      if (img && /neopoint-bag/i.test(img.getAttribute('src') || '')) {
        np += parseInt(txt.replace(/\D/g, ''), 10) || 0;
      } else if (txt) {
        // Stack count, if Neopets shows one, sits beside the image
        const badge = row && row.querySelector('div.relative');
        const n = badge ? parseInt((badge.textContent || '').replace(/\D/g, ''), 10) : NaN;
        items.push({ name: txt, count: Number.isFinite(n) && n > 0 ? n : 1 });
      }
    }
    const owner = (panel.querySelector('.tp-border-color span') || {}).textContent || '';
    return { np, items, owner: owner.trim() };
  }

  let offerScanTimer = null;
  function scanOffersMade() {
    if (!/type=offer-made/.test(location.hash)) return;
    clearTimeout(offerScanTimer);
    offerScanTimer = setTimeout(() => {
      const cache = getOfferCache();
      const before = JSON.stringify(cache);
      const boxes = document.querySelectorAll('.offer-made-container');
      const onPage = new Set();
      for (const box of boxes) {
        const heads = [...box.querySelectorAll('p.text-cafeteria')];
        const lotHead   = heads.find(h => /^Lot\s+\d+$/.test(h.textContent.trim()));
        const offerHead = heads.find(h => /^Offer\s+\d+$/.test(h.textContent.trim()));
        if (!lotHead || !offerHead) continue;
        const lotId = lotHead.textContent.replace(/\D/g, '');
        const lot = readOfferPanel(lotHead);
        const offer = readOfferPanel(offerHead);
        if (!lot || !offer) continue;
        const prev = cache[lotId];
        onPage.add(lotId);
        cache[lotId] = {
          offerId: offerHead.textContent.replace(/\D/g, ''),
          seller: lot.owner,
          np: offer.np,
          offerItems: offer.items,
          lotItems: lot.items,
          seen: (prev && prev.seen) || new Date().toISOString()
        };
      }
      // Offers no longer on the page were accepted, rejected, withdrawn or
      // expired. Keep them (an accepted one still needs costing when its popup
      // shows) but mark them gone so the Offers tab stops counting them.
      // Only when the page has rendered at least one offer — an empty list
      // may just be still loading.
      if (onPage.size) {
        const now = new Date().toISOString();
        for (const [k, v] of Object.entries(cache)) {
          if (!onPage.has(k) && !v.gone) v.gone = now;
        }
        GM_setValue(OFFER_SCAN_KEY, now);
      }
      const cutoff = Date.now() - OFFER_CACHE_DAYS * 86400000;
      for (const [k, v] of Object.entries(cache)) if (Date.parse(v.seen) < cutoff) delete cache[k];
      if (JSON.stringify(cache) !== before) {
        saveOfferCache(cache);
        const view = document.getElementById('np-view-offers');
        if (view && !view.classList.contains('np-hidden')) renderOffersView();
      }
    }, 400);
  }

  function itemdbPrice(name) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://itemdb.com.br/api/v1/items/${encodeURIComponent(name)}`,
        headers: { 'Accept': 'application/json' },
        timeout: 10000,
        onload: r => { try { const d = JSON.parse(r.responseText); resolve((d && d.price && d.price.value) || null); } catch { resolve(null); } },
        onerror: () => resolve(null),
        ontimeout: () => resolve(null)
      });
    });
  }

  // Value what you gave: Tracker price for units you have logged (oldest
  // first — those lots are marked as traded away at cost, so zero P&L),
  // itemdb price for the rest. Returns { value, parts[] } for the note.
  async function costOfferedItems(offerItems, lotId) {
    let purchases = getPurchases();
    const now = new Date().toISOString();
    let value = 0;
    const parts = [];
    let changed = false;
    for (const it of offerItems) {
      let need = it.count || 1;
      let fromTracker = 0, trackerCost = 0;
      const held = purchases
        .filter(p => p.soldPrice === null && String(p.item).trim().toLowerCase() === it.name.trim().toLowerCase())
        .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      for (const lot of held) {
        if (!need) break;
        const take = Math.min(need, lot.qty || 1);
        const note = `traded away in offer for TP lot #${lotId}`;
        if (take >= (lot.qty || 1)) {
          purchases = purchases.map(p => p.id === lot.id
            ? { ...p, soldPrice: p.price, soldQty: take, soldDate: now, notes: [p.notes, note].filter(Boolean).join(' · ') } : p);
        } else {
          purchases = purchases.map(p => p.id === lot.id ? { ...p, qty: p.qty - take } : p);
          purchases.push({ id: Date.now() + Math.floor(Math.random() * 1000), item: lot.item, price: lot.price, qty: take,
                           soldQty: take, soldPrice: lot.price, soldDate: now, date: lot.date,
                           notes: [lot.notes, note].filter(Boolean).join(' · ') });
        }
        changed = true;
        fromTracker += take; trackerCost += lot.price * take; need -= take;
      }
      let part = `${it.count > 1 ? it.count + '× ' : ''}${it.name}`;
      const bits = [];
      if (fromTracker) { value += trackerCost; bits.push(`Tracker ${trackerCost.toLocaleString('en-US')}`); }
      if (need) {
        const px = await itemdbPrice(it.name);
        if (px) { value += px * need; bits.push(`itemdb ${(px * need).toLocaleString('en-US')}`); }
        else bits.push('no price found — add it yourself');
      }
      parts.push(`${part} (${bits.join(' + ')})`);
    }
    if (changed) savePurchases(purchases);
    return { value, parts };
  }

  const offerInflight = {};
  let offerRetryTimer = null;
  function detectOfferAccepted(force = false) {
    const popup = document.querySelector('.tp-popup-confirm');
    if (!popup || !isOfferAcceptedPopup(popup)) return Promise.resolve();
    const p = parseOfferAccepted(popup);
    if (!p) {
      if (!force) return Promise.resolve();
      const raw = (popup.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const key = 'raw:' + raw;
      if (loggedLots().includes(key)) return Promise.resolve();
      const inbox = getInbox();
      inbox.push({ item: '', price: '', qty: 1, notes: `TP offer accepted (couldn't read popup): ${raw}` });
      saveInbox(inbox); markLotLogged(key);
      showToast('⚠️ Offer trade queued — check the details');
      return Promise.resolve();
    }
    const key = 'offer:' + p.lot;
    if (offerInflight[key]) return offerInflight[key];
    if (loggedLots().includes(key)) return Promise.resolve();

    const cache = getOfferCache();
    const cached = cache[p.lot];

    if (!cached) {
      // Offer made before 2.8.0 or on another device: popup data only
      if (!p.items.length && !force) {
        clearTimeout(offerRetryTimer);
        offerRetryTimer = setTimeout(() => detectOfferAccepted(true), 800);
        return Promise.resolve();
      }
      clearTimeout(offerRetryTimer);
      p.extra = 'offered items unknown (check cost)';
      queueLot(p);
      markLotLogged(key);
      return Promise.resolve();
    }

    offerInflight[key] = (async () => {
      try {
        const np = p.total || cached.np || 0;
        const offered = cached.offerItems || [];
        const { value, parts } = offered.length ? await costOfferedItems(offered, p.lot) : { value: 0, parts: [] };
        const items = (cached.lotItems && cached.lotItems.length)
          ? cached.lotItems.map(i => ({ name: i.name, qty: i.count || 1 }))
          : p.items;
        const gave = [`${np.toLocaleString('en-US')} NP`, ...parts].join(' + ');
        queueLot({ lot: p.lot, total: np + value, items, via: 'offer',
                   extra: `offered ${gave}${cached.seller ? ` · from ${cached.seller}` : ''}` });
        markLotLogged(key);
        const c = getOfferCache(); delete c[p.lot]; saveOfferCache(c);
      } finally {
        delete offerInflight[key];
      }
    })();
    return offerInflight[key];
  }

  // Thanks! on the offer popup: make sure it's queued, then open the Add form
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (!btn) return;
    const popup = btn.closest('.tp-popup-confirm');
    if (!popup || btn.textContent.trim() !== 'Thanks!' || !isOfferAcceptedPopup(popup)) return;
    detectOfferAccepted(true).then(() => setTimeout(openInboxAfterRedirect, 400));
  }, true);

  // ─── OFFERS TAB ────────────────────────────────────────────────────────────
  // Everything here reads np_offer_cache (filled by scanOffersMade). No
  // Neopets requests. "Value offers" asks itemdb for prices, spaced out,
  // cached 12h in GM so reopening the tab doesn't refetch.
  const OFFER_PRICE_KEY = 'np_offer_prices';
  const OFFER_PRICE_TTL = 12 * 3600000;
  const OFFER_SORT_KEY  = 'np_offers_sort';
  let offerValuing = false;

  function getOfferPrices() {
    try { return JSON.parse(GM_getValue(OFFER_PRICE_KEY, '{}')) || {}; } catch { return {}; }
  }
  // Price for an item: itemdb first, else the TP fallback.
  //   number    → priced
  //   null      → looked up, no price found
  //   undefined → not looked up yet (or stale)
  const TP_PRICE_TTL = 6 * 3600000;   // TP asking prices move faster than itemdb's
  function offerPriceFor(name, prices) {
    const e = prices[name.trim().toLowerCase()];
    if (!e || (Date.now() - e.t) >= OFFER_PRICE_TTL) return undefined;
    if (e.v) return e.v;
    if (e.tp && (Date.now() - (e.tpT || 0)) < TP_PRICE_TTL) return e.tp;
    return null;
  }
  function offerPriceIsTp(name, prices) {
    const e = prices[name.trim().toLowerCase()];
    return !!(e && !e.v && e.tp && (Date.now() - (e.tpT || 0)) < TP_PRICE_TTL);
  }


  // ─── TP FALLBACK (borrowed from Quick Lookup) ──────────────────────────────
  // Same-origin POST to Neopets' TP browse endpoint, one page per item.
  // Returns the cheapest instant-buy of a lot that is exactly one unit of the
  // item. The lot schema isn't pinned yet, so field names are candidate lists;
  // a lot whose contents can't be read is skipped rather than guessed (a
  // bundle's instant-buy must never pass as one item's price).
  const TP_LIST_URL = 'https://www.neopets.com/np-templates/ajax/island/tradingpost/tradingpost-list.php';
  function pickKey(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    return undefined;
  }



  function timeAgo(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${Math.max(m, 0)}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  // Tracker cost of `count` units (oldest held lots first) — read only, unlike costOfferedItems
  function trackerCostOf(name, count, purchases) {
    const key = name.trim().toLowerCase();
    const held = purchases
      .filter(p => p.soldPrice === null && String(p.item).trim().toLowerCase() === key)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let need = count, cost = 0, got = 0;
    for (const lot of held) {
      if (!need) break;
      const take = Math.min(need, lot.qty || 1);
      cost += lot.price * take; got += take; need -= take;
    }
    return { got, cost };
  }

  // Offered side: NP + Tracker cost where held, itemdb for the rest.
  // Lot side: itemdb. `missing` counts items with no price yet.
  function valueOffer(o, purchases, prices) {
    let offered = o.np || 0, offeredMissing = 0, lot = 0, lotMissing = 0, lotKnown = 0, tpUsed = 0;
    for (const it of (o.offerItems || [])) {
      const n = it.count || 1;
      const { got, cost } = trackerCostOf(it.name, n, purchases);
      offered += cost;
      if (got < n) {
        const px = offerPriceFor(it.name, prices);
        if (px) { offered += px * (n - got); if (offerPriceIsTp(it.name, prices)) tpUsed++; } else offeredMissing++;
      }
    }
    for (const it of (o.lotItems || [])) {
      const px = offerPriceFor(it.name, prices);
      if (px) { lot += px * (it.count || 1); lotKnown++; if (offerPriceIsTp(it.name, prices)) tpUsed++; } else lotMissing++;
    }
    return { offered, offeredMissing, lot, lotMissing, lotKnown, tpUsed };
  }

  function renderOffersView() {
    const view = document.getElementById('np-view-offers');
    if (!view) return;
    const cache = getOfferCache();
    const purchases = getPurchases();
    const prices = getOfferPrices();
    const all = Object.entries(cache).map(([lot, o]) => ({ lot, ...o }));
    const active = all.filter(o => !o.gone);
    const gone = all.filter(o => o.gone).sort((a, b) => String(b.gone).localeCompare(String(a.gone)));
    const scanned = GM_getValue(OFFER_SCAN_KEY, '');
    const sort = GM_getValue(OFFER_SORT_KEY, 'newest');

    const npTied = active.reduce((s, o) => s + (o.np || 0), 0);
    const itemsTied = active.reduce((s, o) => s + (o.offerItems || []).reduce((t, i) => t + (i.count || 1), 0), 0);
    for (const o of all) o.val = valueOffer(o, purchases, prices);
    const anyValued = active.some(o => o.val.lotKnown);

    const sorters = {
      newest: (a, b) => String(b.seen).localeCompare(String(a.seen)),
      oldest: (a, b) => String(a.seen).localeCompare(String(b.seen)),
      np:     (a, b) => (b.np || 0) - (a.np || 0),
      seller: (a, b) => String(a.seller).localeCompare(String(b.seller), undefined, { sensitivity: 'base' }),
      gap:    (a, b) => (b.val.lot - b.val.offered) - (a.val.lot - a.val.offered),
    };
    active.sort(sorters[sort] || sorters.newest);

    const itemList = (items) => (items || []).map(it =>
      `<span class="np-offer-item">${it.count > 1 ? it.count + '× ' : ''}${escHtml(it.name)}</span>`).join('');

    const valueLine = (v, lotItems) => {
      if (!v.lotKnown && !v.lotMissing) return '';
      if (!v.lotKnown) {
        // Every lot item was looked up and itemdb has no price for any of them
        const tried = (lotItems || []).every(it => offerPriceFor(it.name, prices) === null);
        return tried ? '<div class="np-offer-value np-muted">Lot ≈ ? (no itemdb or TP price)</div>' : '';
      }
      const gap = v.lot - v.offered;
      const pct = v.offered ? Math.round(gap / v.offered * 100) : 0;
      const cls = gap >= 0 ? 'np-green' : 'np-red';
      const warn = (v.offeredMissing || v.lotMissing)
        ? ` <span class="np-muted" title="No itemdb or TP price found">(${v.offeredMissing + v.lotMissing} unpriced)</span>` : '';
      const tp = v.tpUsed
        ? ` <span class="np-offer-tp" title="Cheapest single-item Trading Post instant-buy, used where itemdb has no price. Asking price, so it runs high.">${v.tpUsed} at TP min</span>` : '';
      return `<div class="np-offer-value">You give ≈ ${formatNP(v.offered)} · Lot ≈ ${formatNP(v.lot)} ·
        <span class="${cls}">${gap >= 0 ? '+' : ''}${formatNP(gap)} (${gap >= 0 ? '+' : ''}${pct}%)</span>${warn}${tp}</div>`;
    };

    const card = (o, isGone) => `
      <div class="np-offer-card${isGone ? ' np-offer-gone' : ''}">
        <div class="np-offer-head">
          <span class="np-offer-lot">Lot ${escHtml(o.lot)}</span>
          <span class="np-offer-seller">${escHtml(o.seller || '?')}</span>
          <span class="np-muted np-offer-age" title="First seen ${formatDateTime(o.seen)}">${isGone ? 'gone ' + timeAgo(o.gone) : timeAgo(o.seen)}</span>
        </div>
        <div class="np-offer-row"><span class="np-offer-label">You</span>
          <span class="np-offer-item np-offer-np">${formatNP(o.np || 0)} NP</span>${itemList(o.offerItems)}</div>
        <div class="np-offer-row"><span class="np-offer-label">Lot</span>${itemList(o.lotItems) || '<span class="np-muted">—</span>'}</div>
        ${valueLine(o.val, o.lotItems)}
        <a class="np-offer-link" href="https://www.neopets.com/island/tradingpost.phtml#/?type=makeoffer&lot_id=${encodeURIComponent(o.lot)}" target="_blank" rel="noopener">📍 Open on TP ↗</a>
      </div>`;

    const totalOffered = active.reduce((s, o) => s + o.val.offered, 0);
    const totalLot = active.reduce((s, o) => s + o.val.lot, 0);

    view.innerHTML = `
      <div class="np-pnl-cards">
        <div class="np-pnl-card"><div class="np-pnl-card-label">Offers</div><div class="np-pnl-card-val">${active.length}</div></div>
        <div class="np-pnl-card"><div class="np-pnl-card-label">NP tied up</div><div class="np-pnl-card-val">${formatNP(npTied)}</div></div>
        <div class="np-pnl-card"><div class="np-pnl-card-label">Items offered</div><div class="np-pnl-card-val">${itemsTied}</div></div>
        ${anyValued ? `
        <div class="np-pnl-card"><div class="np-pnl-card-label">You give ≈</div><div class="np-pnl-card-val">${formatNP(totalOffered)}</div></div>
        <div class="np-pnl-card"><div class="np-pnl-card-label">Lots ≈</div><div class="np-pnl-card-val">${formatNP(totalLot)}</div></div>
        <div class="np-pnl-card"><div class="np-pnl-card-label">Gap</div><div class="np-pnl-card-val ${totalLot - totalOffered >= 0 ? 'np-green' : 'np-red'}">${totalLot - totalOffered >= 0 ? '+' : ''}${formatNP(totalLot - totalOffered)}</div></div>` : ''}
      </div>
      <div class="np-offer-sync np-muted">
        ${scanned ? `Synced ${timeAgo(scanned)}` : 'Not synced yet'} ·
        <a class="np-offer-link-inline" href="https://www.neopets.com/island/tradingpost.phtml#/?type=offer-made">open Offers you have made</a> to refresh
      </div>
      <div class="np-panel-toolbar">
        <select id="np-offers-sort" class="np-offers-sort">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="np">NP high → low</option>
          <option value="seller">Seller A → Z</option>
          <option value="gap"${anyValued ? '' : ' disabled'}>Best value gap</option>
        </select>
        <button id="np-offers-value"${offerValuing ? ' disabled' : ''}>${offerValuing ? '⏳ Valuing…' : '💰 Value offers'}</button>
      </div>
      <div id="np-offers-list">
        ${active.length ? active.map(o => card(o, false)).join('')
          : `<div style="text-align:center;padding:30px;color:#999999;font-style:italic;">🏝️ No pending offers cached.<br>Open "Offers you have made" once to load them.</div>`}
      </div>
      ${gone.length ? `
        <details class="np-offers-gone">
          <summary>No longer listed (${gone.length})</summary>
          <div class="np-muted np-offer-gone-note">Accepted, rejected, withdrawn or expired. Kept so an accepted offer can still be costed; cleared after ${OFFER_CACHE_DAYS} days.</div>
          ${gone.map(o => card(o, true)).join('')}
        </details>` : ''}
    `;

    const sel = document.getElementById('np-offers-sort');
    sel.value = (sort === 'gap' && !anyValued) ? 'newest' : sort;
    sel.addEventListener('change', () => { GM_setValue(OFFER_SORT_KEY, sel.value); renderOffersView(); });
    document.getElementById('np-offers-value').addEventListener('click', valueAllOffers);
  }

  // itemdb lookup that tells failures apart from "no price":
  //   ok      → { status:'ok', v }      priced
  //   none    → { status:'none' }       item unknown or unpriced (safe to cache)
  //   auth    → { status:'auth' }       401, itemdb session expired
  //   error   → { status:'error' }      network, timeout, 429, 5xx (retry, never cache)
  function itemdbLookup(name) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://itemdb.com.br/api/v1/items/${encodeURIComponent(name)}`,
        headers: { 'Accept': 'application/json' },
        timeout: 10000,
        onload: r => {
          if (r.status === 401) return resolve({ status: 'auth' });
          if (r.status === 404) return resolve({ status: 'none' });
          if (r.status < 200 || r.status >= 300) return resolve({ status: 'error' });
          try {
            const d = JSON.parse(r.responseText);
            const v = d && d.price && d.price.value;
            resolve(v ? { status: 'ok', v } : { status: 'none' });
          } catch { resolve({ status: 'error' }); }
        },
        onerror: () => resolve({ status: 'error' }),
        ontimeout: () => resolve({ status: 'error' })
      });
    });
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const POLITE_MS = 1000;   // fixed gap between itemdb requests, to go easy on their API

  // Fetch itemdb prices for every item in active offers that isn't already
  // cached. Offered items fully covered by Tracker lots are skipped.
  function valueAllOffers() {
    if (offerValuing) return;
    const cache = getOfferCache();
    const purchases = getPurchases();
    const prices = getOfferPrices();
    const names = new Map();
    for (const o of Object.values(cache)) {
      if (o.gone) continue;
      for (const it of (o.lotItems || [])) names.set(it.name.trim().toLowerCase(), it.name);
      for (const it of (o.offerItems || [])) {
        if (trackerCostOf(it.name, it.count || 1, purchases).got < (it.count || 1))
          names.set(it.name.trim().toLowerCase(), it.name);
      }
    }
    const todo = [...names.entries()].filter(([k]) => offerPriceFor(k, prices) === undefined);
    if (!todo.length) {
      showToast('💰 Prices already up to date'); renderOffersView(); return;
    }

    offerValuing = true;
    const selBusy = () => document.activeElement && document.activeElement.id === 'np-offers-sort';
    const setBtn = (txt) => { const b = document.getElementById('np-offers-value'); if (b) { b.disabled = true; b.textContent = txt; } };
    (async () => {
      let priced = 0, none = 0, failed = 0, done = 0, authLost = false;
      for (const [key, name] of todo) {
        setBtn(`⏳ ${done}/${todo.length} items…`);
        let res;
        for (let attempt = 0; attempt < 3; attempt++) {
          res = await itemdbLookup(name);
          if (res.status !== 'error') break;
          await sleep(3000 * (attempt + 1));          // back off, then retry
        }
        if (res.status === 'auth') { authLost = true; break; }
        if (res.status === 'ok' || res.status === 'none') {
          const p = getOfferPrices();
          p[key] = { v: res.status === 'ok' ? res.v : null, t: Date.now() };
          GM_setValue(OFFER_PRICE_KEY, JSON.stringify(p));
          res.status === 'ok' ? priced++ : none++;
        } else failed++;                                // not cached → retried next press
        done++;
        if (done % 10 === 0 && !selBusy()) renderOffersView();
        await sleep(POLITE_MS);
      }
      // Public build: no batch Trading Post fallback. Items itemdb can't price stay unpriced.
      const tpPriced = 0, tpNone = 0, tpFailed = 0;
      offerValuing = false;
      // Drop old price entries so the store doesn't grow forever
      const q = getOfferPrices();
      for (const [k, e] of Object.entries(q)) if (Date.now() - e.t > OFFER_PRICE_TTL * 4) delete q[k];
      GM_setValue(OFFER_PRICE_KEY, JSON.stringify(q));
      renderOffersView();
      if (authLost) showToast('⚠️ itemdb session expired — open itemdb.com.br, then press Value again');
      else {
        const bits = [`${priced} itemdb`];
        if (tpPriced) bits.push(`${tpPriced} TP min`);
        if (tpNone) bits.push(`${tpNone} no price`);
        if (failed + tpFailed) bits.push(`${failed + tpFailed} failed (press again to retry)`);
        showToast(`💰 ${bits.join(' · ')}`);
      }
    })();
  }

  // ─── WATCH TAB (lots you didn't buy · items you're eyeing) ─────────────────
  // Data lives in localStorage.np_tp_watchlist so Quick Lookup (another
  // script, another GM sandbox) can add to it. Mirrored to GM storage as a
  // backup: if localStorage is ever wiped, the Tracker restores it on load.
  //
  // Lots:  is it still on the TP? (paged item_exact search, looking for the
  //        lot id — no lot-number endpoint needed). Once gone, ask itemdb's
  //        trade history what the lot was priced at: exact lot-id match if
  //        itemdb's record carries one, else same seller + item, closest date.
  //        itemdb's figure is a community estimate, not a confirmed sale.
  // Items: current itemdb price + our own snapshots + itemdb price history
  //        (once a day) → mini trend; 🔔 when price ≤ your target.
  //
  // Checks only run when you open the tab (stale entries only, capped) or
  // press Check all / ↻. Public build: only a lot's own ↻ searches the Trading
  // Post; Check all and tab-open refresh use itemdb only. No background polling.
  const WATCH_KEY = 'np_tp_watchlist';
  const WATCH_BACKUP_KEY = 'np_watchlist_backup';
  const WATCH_SNAP_MAX = 90;
  const WATCH_SNAP_GAP = 6 * 3600000;
  const WATCH_HIST_MAX = 60;
  const WATCH_HIST_TTL = 24 * 3600000;
  const WATCH_ITEM_STALE = 2 * 3600000;
  const WATCH_LOT_STALE = 6 * 3600000;
  const WATCH_TRADE_RETRY = 12 * 3600000;
  const WATCH_AUTO_MAX = 8;          // per kind, per tab open
  const TP_FIND_MAX_PAGES = 3;   // pages read for one lot, only when you press its ↻
  let watchBusy = false;

  function wKey(n) { return String(n || '').trim().toLowerCase(); }

  function getWatch() {
    try {
      const w = JSON.parse(localStorage.getItem(WATCH_KEY) || 'null');
      if (w && typeof w === 'object') return { ...w, v: 1, lots: w.lots || {}, items: w.items || {} };
    } catch {}
    return { v: 1, lots: {}, items: {} };
  }
  function saveWatch(w) {
    w.updated = new Date().toISOString();
    const json = JSON.stringify(w);
    try { localStorage.setItem(WATCH_KEY, json); } catch (e) { console.warn('[NP Tracker] Watchlist save failed:', e); }
    GM_setValue(WATCH_BACKUP_KEY, json);
    updateWatchBadges();
  }
  // On load: localStorage missing entirely → restore from GM. Otherwise the
  // localStorage copy is the truth (Quick Lookup may have changed it), so
  // refresh the backup from it.
  function syncWatchBackup() {
    let raw = null;
    try { raw = localStorage.getItem(WATCH_KEY); } catch { return; }
    if (raw === null) {
      const backup = GM_getValue(WATCH_BACKUP_KEY, '');
      if (backup) { try { localStorage.setItem(WATCH_KEY, backup); } catch {} }
    } else {
      GM_setValue(WATCH_BACKUP_KEY, raw);
    }
  }

  // Merge (import): never drops anything already here.
  function mergeWatch(a, b) {
    const out = { ...a, v: 1, lots: { ...a.lots }, items: { ...a.items } };
    for (const [id, lot] of Object.entries((b && b.lots) || {})) {
      const cur = out.lots[id];
      if (!cur) out.lots[id] = lot;
      else if (String(lot.checked || '') > String(cur.checked || '')) out.lots[id] = { ...cur, ...lot, seen: cur.seen || lot.seen };
    }
    const byT = (xs) => {
      const m = new Map();
      for (const p of xs) if (p && Number.isFinite(p.t)) m.set(p.t, p);
      return [...m.values()].sort((x, y) => x.t - y.t);
    };
    for (const [k, it] of Object.entries((b && b.items) || {})) {
      const cur = out.items[k];
      if (!cur) { out.items[k] = it; continue; }
      const newer = String(it.checked || '') > String(cur.checked || '') ? it : cur;
      const older = newer === it ? cur : it;
      const firstAdded = [cur, it].filter(x => x.added).sort((x, y) => String(x.added).localeCompare(String(y.added)))[0] || cur;
      out.items[k] = {
        ...older, ...newer,
        target: cur.target != null ? cur.target : it.target,
        added: firstAdded.added || null,
        addedPrice: firstAdded.addedPrice != null ? firstAdded.addedPrice : (cur.addedPrice != null ? cur.addedPrice : it.addedPrice),
        snaps: byT([...(cur.snaps || []), ...(it.snaps || [])]).slice(-WATCH_SNAP_MAX),
        hist: byT([...(cur.hist || []), ...(it.hist || [])]).slice(-WATCH_HIST_MAX)
      };
    }
    return out;
  }

  function belowTarget(it) { return !!(it && it.target && it.price && it.price <= it.target); }

  function updateWatchBadges() {
    const hits = Object.values(getWatch().items).filter(belowTarget).length;
    const badge = document.getElementById('np-watch-badge');
    if (badge) badge.textContent = hits ? ` 🔔${hits}` : '';
    const btn = document.getElementById('np-tracker-btn');
    if (btn) btn.textContent = '🍕 PBP Tracker' + (hits ? ` · 🔔${hits}` : '');
  }

  // itemdb JSON with the same status split as itemdbLookup
  function idbJson(path) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://itemdb.com.br/api/v1/items/${path}`,
        headers: { 'Accept': 'application/json' },
        timeout: 12000,
        onload: r => {
          if (r.status === 401) return resolve({ status: 'auth' });
          if (r.status === 404) return resolve({ status: 'none' });
          if (r.status < 200 || r.status >= 300) return resolve({ status: 'error' });
          try { resolve({ status: 'ok', d: JSON.parse(r.responseText) }); } catch { resolve({ status: 'error' }); }
        },
        onerror: () => resolve({ status: 'error' }),
        ontimeout: () => resolve({ status: 'error' })
      });
    });
  }

  function tpPageHasMore(data, page) {
    const total = Number(pickKey(data, ['total_pages', 'totalPages', 'pages', 'page_count', 'pageCount', 'last_page', 'lastPage']));
    if (Number.isFinite(total) && total > 0) return page < total;
    const more = pickKey(data, ['has_more', 'hasMore', 'has_next', 'hasNext', 'more']);
    if (typeof more === 'boolean') return more;
    return null;
  }

  // Is lot `lotId` still listed? Pages through the item's TP search.
  //   listed  → { status, ib }   still there (ib = current instant-buy, 0 if none)
  //   gone    → read every page, not there
  //   unknown → too many pages, or lot ids unreadable (schema not pinned)
  //   error   → request failed
  async function tpFindLot(itemName, lotId) {
    const seen = new Set();
    for (let page = 1; page <= TP_FIND_MAX_PAGES; page++) {
      let data;
      try {
        const res = await fetch(TP_LIST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
          body: JSON.stringify({ type: 'browse', criteria: 'item_exact', search_string: itemName, sort: 'newest', page })
        });
        if (!res.ok) return { status: 'error' };
        data = await res.json();
      } catch { return { status: 'error' }; }
      if (!data || data.success !== true) return { status: 'error' };
      const lots = Array.isArray(data.lots) ? data.lots : [];
      let ids = 0, fresh = 0;
      for (const l of lots) {
        const id = String(pickKey(l, ['lot_id', 'lotId', 'lot_number', 'id']) || '');
        if (!id) continue;
        ids++;
        if (id === String(lotId)) return { status: 'listed', ib: Number(l.instant_buy_amount) || 0 };
        if (!seen.has(id)) { seen.add(id); fresh++; }
      }
      if (lots.length && !ids) return { status: 'unknown' };   // can't read lot ids
      if (!lots.length || !fresh) return { status: 'gone' };   // ran out / page param ignored
      if (tpPageHasMore(data, page) === false) return { status: 'gone' };
      await sleep(POLITE_MS);
    }
    return { status: 'unknown' };
  }

  // Find the watched lot in itemdb's trade history for the item.
  function matchTrade(lot, d) {
    const recent = Array.isArray(d && d.recent) ? d.recent : [];
    const target = wKey(lot.item);
    const itemsOf = t => Array.isArray(t.items) ? t.items : [];
    const priceOf = t => {
      const mine = itemsOf(t).find(i => wKey(i.name) === target);
      return mine && t.priced ? Number(mine.price) || 0 : 0;
    };
    const exact = recent.find(t => String(pickKey(t, ['trade_id', 'tradeId', 'lot_id', 'lotId', 'id']) || '') === String(lot.lotId));
    if (exact) return { match: 'exact', price: priceOf(exact), at: exact.addedAt || null };
    const owner = wKey(lot.owner);
    if (!owner) return null;
    const seenT = Date.parse(lot.seen) || Date.now();
    const cands = recent.filter(t => wKey(t.owner) === owner && itemsOf(t).some(i => wKey(i.name) === target));
    if (!cands.length) return null;
    cands.sort((a, b) => Math.abs((Date.parse(a.addedAt) || 0) - seenT) - Math.abs((Date.parse(b.addedAt) || 0) - seenT));
    const t = cands[0];
    return { match: 'seller', price: priceOf(t), at: t.addedAt || null };
  }

  async function checkWatchLot(lotId, allowTp) {
    const lot = getWatch().lots[lotId];
    if (!lot) return 'skip';
    const now = new Date().toISOString();
    const upd = {};
    if (lot.status !== 'gone' && allowTp) {
      if (!lot.item) return 'skip';
      const r = await tpFindLot(lot.item, lot.lotId);
      if (r.status === 'error') return 'error';
      upd.checked = now;
      if (r.status === 'listed') { upd.status = 'listed'; upd.lastListed = now; upd.ibNow = r.ib || null; }
      else if (r.status === 'gone') { upd.status = 'gone'; upd.goneBy = now; }
      else upd.status = 'unknown';
    }
    let auth = false;
    if ((upd.status || lot.status) === 'gone' && !lot.closedPrice) {
      if (upd.status) await sleep(POLITE_MS);
      const t = await idbJson(`${encodeURIComponent(lot.item)}/trades`);
      if (t.status === 'auth') auth = true;
      else if (t.status === 'ok' || t.status === 'none') {
        upd.priceChecked = now;
        const m = t.status === 'ok' ? matchTrade(lot, Array.isArray(t.d) ? t.d[0] : t.d) : null;
        if (m) { upd.closedMatch = m.match; upd.closedPrice = m.price || null; upd.tradeAt = m.at; }
      }
    }
    const w = getWatch();
    if (!w.lots[lotId]) return 'skip';
    w.lots[lotId] = { ...w.lots[lotId], ...upd };
    saveWatch(w);
    return auth ? 'auth' : 'ok';
  }

  async function checkWatchItem(key) {
    const it = getWatch().items[key];
    if (!it) return 'skip';
    const res = await itemdbLookup(it.name);
    if (res.status === 'auth') return 'auth';
    if (res.status === 'error') return 'error';
    const nowMs = Date.now();
    const upd = { checked: new Date(nowMs).toISOString() };
    let snaps = Array.isArray(it.snaps) ? it.snaps : [];
    if (res.status === 'ok') {
      upd.price = res.v;
      const last = snaps[snaps.length - 1];
      if (!last || last.v !== res.v || nowMs - last.t >= WATCH_SNAP_GAP) snaps = [...snaps, { t: nowMs, v: res.v }].slice(-WATCH_SNAP_MAX);
      if (it.addedPrice == null) upd.addedPrice = res.v;
    }
    upd.snaps = snaps;
    if (!it.histT || nowMs - Date.parse(it.histT) > WATCH_HIST_TTL) {
      await sleep(POLITE_MS);
      const h = await idbJson(`${encodeURIComponent(it.name)}/prices`);
      if (h.status === 'ok') {
        upd.hist = (Array.isArray(h.d) ? h.d : [])
          .map(p => ({ t: Date.parse(p.addedAt), v: Number(p.value) || 0 }))
          .filter(p => p.v > 0 && Number.isFinite(p.t))
          .sort((a, b) => a.t - b.t)
          .slice(-WATCH_HIST_MAX);
        upd.histT = upd.checked;
      } else if (h.status === 'none') upd.histT = upd.checked;
    }
    const w = getWatch();
    if (!w.items[key]) return 'skip';
    const was = belowTarget(w.items[key]);
    w.items[key] = { ...w.items[key], ...upd };
    saveWatch(w);
    if (!was && belowTarget(w.items[key])) {
      showToast(`🔔 ${it.name} is ${formatNP(w.items[key].price)} NP — at/below your ${formatNP(it.target)} target`);
    }
    return 'ok';
  }

  function setWatchBtn(txt, busy) {
    const b = document.getElementById('np-watch-check');
    if (b) { b.textContent = txt; b.disabled = !!busy; }
  }

  // mode: 'auto' (tab open: stale only, capped) | 'all' (button) | {kind,id} (one row)
  async function runWatchChecks(mode) {
    if (watchBusy) return;
    const w = getWatch();
    const now = Date.now();
    const age = iso => iso ? now - Date.parse(iso) : Infinity;
    let jobs = [];
    if (mode && typeof mode === 'object') {
      jobs = [mode];
    } else {
      let items = Object.keys(w.items);
      let lots = Object.values(w.lots).filter(l => l.item);
      if (mode === 'auto') {
        items = items.filter(k => age(w.items[k].checked) > WATCH_ITEM_STALE).slice(0, WATCH_AUTO_MAX);
        lots = lots.filter(l => l.status === 'gone'
          && !l.closedPrice && age(l.priceChecked) > WATCH_TRADE_RETRY).slice(0, WATCH_AUTO_MAX);
      } else {
        lots = lots.filter(l => l.status === 'gone' && !l.closedPrice);
      }
      jobs = [...items.map(k => ({ kind: 'item', id: k })), ...lots.map(l => ({ kind: 'lot', id: l.lotId }))];
    }
    if (!jobs.length) { if (mode === 'all') showToast('👁 Nothing needs checking'); return; }

    watchBusy = true;
    renderWatchView();
    let done = 0, failed = 0, auth = false;
    for (const j of jobs) {
      setWatchBtn(`⏳ ${done}/${jobs.length}…`, true);
      // Only a single-row ↻ (mode is an object) may search the Trading Post
      const r = j.kind === 'item' ? await checkWatchItem(j.id) : await checkWatchLot(j.id, typeof mode === 'object');
      if (r === 'auth') { auth = true; break; }
      if (r === 'error') failed++;
      done++;
      if (done % 3 === 0) renderWatchView();
      if (done < jobs.length) await sleep(POLITE_MS);
    }
    watchBusy = false;
    renderWatchView();
    if (auth) showToast('⚠️ itemdb session expired — open itemdb.com.br, then check again');
    else if (failed) showToast(`👁 Checked ${done - failed}/${jobs.length} · ${failed} failed (try again later)`);
    else if (mode !== 'auto') showToast(`👁 Checked ${done}`);
  }

  function watchSpark(it) {
    const cutoff = Date.now() - 90 * 86400000;
    const m = new Map();
    for (const p of [...(it.hist || []), ...(it.snaps || [])]) if (p && p.v > 0 && p.t >= cutoff) m.set(p.t, p);
    const pts = [...m.values()].sort((a, b) => a.t - b.t);
    if (pts.length < 2) return '';
    const W = 300, H = 34, pad = 3;
    const vals = pts.map(p => p.v);
    if (it.target) vals.push(it.target);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const x = t => pad + (W - 2 * pad) * ((t - t0) / Math.max(1, t1 - t0));
    const y = v => H - pad - (H - 2 * pad) * ((v - lo) / Math.max(1, hi - lo));
    const line = pts.map(p => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    const tgt = it.target ? `<line x1="0" x2="${W}" y1="${y(it.target).toFixed(1)}" y2="${y(it.target).toFixed(1)}" stroke="#999999" stroke-width="1" stroke-dasharray="3,3"/>` : '';
    return `<svg class="np-watch-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${tgt}<polyline points="${line}" fill="none" stroke="#e8a800" stroke-width="1.5"/></svg>
      <div class="np-muted np-watch-line">low ${formatNP(Math.min(...pts.map(p => p.v)))} · high ${formatNP(Math.max(...pts.map(p => p.v)))} · since ${formatDate(new Date(t0).toISOString())}${it.target ? ' · dashed = target' : ''}</div>`;
  }

  function watchItemCard(it) {
    const hit = belowTarget(it);
    const chg = it.addedPrice && it.price ? Math.round((it.price - it.addedPrice) / it.addedPrice * 100) : null;
    const link = `https://itemdb.com.br/search?s=${encodeURIComponent(it.name)}`;
    return `
      <div class="np-offer-card np-watch-card${hit ? ' np-watch-hit' : ''}">
        <div class="np-offer-head">
          <span class="np-offer-lot">${escHtml(it.name)}</span>
          <span class="np-offer-seller"></span>
          <span class="np-muted np-offer-age" title="Watching since ${formatDateTime(it.added)}">${it.checked ? 'checked ' + timeAgo(it.checked) : 'not checked yet'}</span>
        </div>
        <div class="np-watch-row">
          <span class="np-watch-price">${it.price ? formatNP(it.price) + ' NP' : '—'}</span>
          ${chg !== null ? `<span class="${chg <= 0 ? 'np-green' : 'np-red'}" title="vs ${formatNP(it.addedPrice)} NP when added">${chg > 0 ? '+' : ''}${chg}% since added</span>` : ''}
          ${it.target ? `<span class="np-watch-target${hit ? ' on' : ''}">${hit ? '🔔 ' : ''}target ${formatNP(it.target)}</span>` : ''}
        </div>
        ${watchSpark(it)}
        <div class="np-watch-actions">
          <button class="np-watch-act" data-act="check-item" data-id="${escHtml(it.key)}"${watchBusy ? ' disabled' : ''}>↻ Check</button>
          <button class="np-watch-act" data-act="target" data-id="${escHtml(it.key)}">🎯 Target</button>
          <a class="np-watch-act" href="${link}" target="_blank" rel="noopener">itemdb ↗</a>
          <button class="np-watch-act" data-act="remove-item" data-id="${escHtml(it.key)}">✕</button>
        </div>
      </div>`;
  }

  // How long the lot had been up: real TP listing date if Quick Lookup got one,
  // else when you first saw it. Once gone, measured to when it disappeared.
  function listedLine(l) {
    const from = Date.parse(l.listedAt || l.firstSeen || '');
    if (!Number.isFinite(from)) return '';
    const to = l.status === 'gone' && l.goneBy ? Date.parse(l.goneBy) : Date.now();
    const days = Math.max(0, Math.floor((to - from) / 86400000));
    const span = days < 1 ? '<1 day' : `${days} day${days === 1 ? '' : 's'}`;
    const label = (l.status === 'gone' ? 'was up' : 'up') + (l.listedAt ? '' : ' ≥');
    const title = l.listedAt ? `Listed ${formatDateTime(l.listedAt)}` : `Listing date unknown — first seen ${formatDateTime(l.firstSeen)}`;
    return ` <span class="np-muted" title="${escHtml(title)}">· ${label} ${span}</span>`;
  }

  function watchLotCard(l) {
    let pill, detail = '';
    if (!l.checked && l.status !== 'gone') {
      pill = '<span class="np-watch-pill new">Not checked yet</span>';
    } else if (l.status === 'listed') {
      pill = '<span class="np-watch-pill listed">Still listed</span>';
      if (l.ibNow && l.ibNow !== l.ibPrice) {
        const d = l.ibNow - l.ibPrice;
        detail = `IB now <b>${formatNP(l.ibNow)}</b> <span class="${d < 0 ? 'np-green' : 'np-red'}">(${d > 0 ? '+' : ''}${formatNP(d)})</span>`;
      } else if (l.ibNow === null && l.ibPrice) detail = 'Instant-buy removed';
    } else if (l.status === 'gone') {
      pill = `<span class="np-watch-pill gone" title="Not found on the TP at ${formatDateTime(l.goneBy)}">Gone by ${formatDate(l.goneBy)}</span>`;
      if (l.closedPrice) {
        const d = l.ibPrice ? Math.round((l.closedPrice - l.ibPrice) / l.ibPrice * 100) : null;
        detail = `itemdb priced it <b>${formatNP(l.closedPrice)} NP</b>${d !== null ? ` <span class="np-muted">(${d > 0 ? '+' : ''}${d}% vs IB you saw)</span>` : ''}
          <span class="np-muted" title="${l.closedMatch === 'exact' ? 'itemdb record for this exact lot' : 'itemdb record from the same seller for this item, closest in time — may be a different lot'}">· ${l.closedMatch === 'exact' ? 'this lot' : 'matched by seller'}</span>`;
      } else if (l.closedMatch) {
        detail = '<span class="np-muted">itemdb has the lot, not priced yet — will retry</span>';
      } else if (l.priceChecked) {
        detail = '<span class="np-muted">No itemdb record yet — will retry</span>';
      }
    } else {
      pill = '<span class="np-watch-pill unknown" title="Too many lots to page through, or lot ids unreadable">Unknown</span>';
    }
    const open = l.link || `https://www.neopets.com/island/tradingpost.phtml#/?type=makeoffer&lot_id=${encodeURIComponent(l.lotId)}`;
    const vsIdb = l.ibPrice && l.idbAtSeen ? Math.round((l.ibPrice - l.idbAtSeen) / l.idbAtSeen * 100) : null;
    return `
      <div class="np-offer-card np-watch-card">
        <div class="np-offer-head">
          <span class="np-offer-lot">Lot ${escHtml(l.lotId)}</span>
          <span class="np-offer-seller">${escHtml(l.item || '?')} · ${escHtml(l.owner || '?')}</span>
          <span class="np-muted np-offer-age" title="Added ${formatDateTime(l.seen)}">${timeAgo(l.seen)}</span>
        </div>
        <div class="np-watch-line">Seen at IB <b>${l.ibPrice ? formatNP(l.ibPrice) : '—'}</b>${vsIdb !== null ? ` <span class="np-muted">(${vsIdb > 0 ? '+' : ''}${vsIdb}% vs itemdb ${formatNP(l.idbAtSeen)})</span>` : ''}${listedLine(l)}</div>
        <div class="np-watch-line">${pill} ${detail}</div>
        ${l.wishlist ? `<div class="np-muted np-watch-wish" title="${escHtml(l.wishlist)}">Wishlist: ${escHtml(l.wishlist)}</div>` : ''}
        <div class="np-watch-actions">
          <button class="np-watch-act" data-act="check-lot" data-id="${escHtml(l.lotId)}"${watchBusy ? ' disabled' : ''}>↻ Check</button>
          <a class="np-watch-act" href="${escHtml(open)}" target="_blank" rel="noopener">Open ↗</a>
          <button class="np-watch-act" data-act="remove-lot" data-id="${escHtml(l.lotId)}">✕</button>
        </div>
      </div>`;
  }

  function renderWatchView() {
    const view = document.getElementById('np-view-watch');
    if (!view) return;
    const w = getWatch();
    const items = Object.entries(w.items).map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => (belowTarget(b) - belowTarget(a)) || String(a.name).localeCompare(String(b.name)));
    const lots = Object.values(w.lots).sort((a, b) => String(b.seen).localeCompare(String(a.seen)));
    const hits = items.filter(belowTarget).length;
    const gone = lots.filter(l => l.status === 'gone').length;

    view.innerHTML = `
      <div class="np-pnl-cards">
        <div class="np-pnl-card"><div class="np-pnl-card-label">Items</div><div class="np-pnl-card-val">${items.length}</div></div>
        <div class="np-pnl-card"><div class="np-pnl-card-label">Below target</div><div class="np-pnl-card-val${hits ? ' np-green' : ''}">${hits ? '🔔 ' + hits : 0}</div></div>
        <div class="np-pnl-card"><div class="np-pnl-card-label">Lots</div><div class="np-pnl-card-val">${lots.length}</div></div>
        <div class="np-pnl-card"><div class="np-pnl-card-label">Gone</div><div class="np-pnl-card-val">${gone}</div></div>
      </div>
      <div class="np-panel-toolbar">
        <button id="np-watch-check"${watchBusy ? ' disabled' : ''}>${watchBusy ? '⏳ Checking…' : '🔄 Check all'}</button>
        <button id="np-watch-export">📤 Export</button>
        <button id="np-watch-import">📥 Import</button>
      </div>
      <div class="np-pnl-section-title">🔔 Items (${items.length})</div>
      ${items.length ? items.map(watchItemCard).join('')
        : '<div class="np-watch-empty">Highlight an item and press 👁 Watch in Quick Lookup to follow its price.</div>'}
      <div class="np-pnl-section-title" style="margin-top:14px">🏝️ Lots (${lots.length})</div>
      ${lots.length ? lots.map(watchLotCard).join('')
        : '<div class="np-watch-empty">Press 👁 on a Trading Post lot in Quick Lookup to follow it.</div>'}
      <div class="np-muted np-watch-foot">Opening this tab refreshes stale item prices from itemdb. To see if a lot is still on the Trading Post, press its ↻. Closed-lot prices come from itemdb's trade pricing — a community estimate, not a confirmed sale price.</div>
    `;

    document.getElementById('np-watch-check').onclick = () => runWatchChecks('all');
    document.getElementById('np-watch-export').onclick = exportWatch;
    document.getElementById('np-watch-import').onclick = importWatch;
    view.onclick = (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const id = b.dataset.id;
      const act = b.dataset.act;
      if (act === 'check-item') runWatchChecks({ kind: 'item', id });
      else if (act === 'check-lot') runWatchChecks({ kind: 'lot', id });
      else if (act === 'target') {
        const cur = getWatch().items[id];
        if (!cur) return;
        const v = prompt(`Target price for ${cur.name} (NP). Leave blank to clear.`, cur.target || '');
        if (v === null) return;
        const ww = getWatch();
        if (!ww.items[id]) return;
        ww.items[id].target = parseInt(String(v).replace(/[^\d]/g, ''), 10) || null;
        saveWatch(ww); renderWatchView();
      } else if (act === 'remove-item' || act === 'remove-lot') {
        const ww = getWatch();
        const bucket = act === 'remove-item' ? ww.items : ww.lots;
        const label = act === 'remove-item' ? (bucket[id] && bucket[id].name) : `lot ${id}`;
        if (!bucket[id] || !confirm(`Stop watching ${label}?`)) return;
        delete bucket[id];
        saveWatch(ww); renderWatchView();
      }
    };
    updateWatchBadges();
  }

  function exportWatch() {
    const blob = new Blob([JSON.stringify(getWatch(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pbp-watchlist-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }

  function importWatch() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const inc = JSON.parse(ev.target.result);
          if (!inc || typeof inc !== 'object' || (!inc.lots && !inc.items)) { alert('That file isn\'t a PBP watchlist.'); return; }
          const cur = getWatch();
          const newLots = Object.keys(inc.lots || {}).filter(k => !cur.lots[k]).length;
          const newItems = Object.keys(inc.items || {}).filter(k => !cur.items[k]).length;
          saveWatch(mergeWatch(cur, inc));
          renderWatchView();
          showToast(`📥 Watchlist merged · ${newItems} new item${newItems === 1 ? '' : 's'}, ${newLots} new lot${newLots === 1 ? '' : 's'}`);
        } catch (err) {
          alert('Error reading watchlist: ' + err.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  // ─── MAKE AN OFFER → NEW TAB ───────────────────────────────────────────────
  // "Make an Offer" normally swaps the page to the offer form, losing your
  // search. We open #/?type=makeoffer&lot_id=N in a new tab instead. If the
  // lot number can't be found for certain, the click is left alone.
  const LOT_RE = /\bLot\s*#?\s*(\d{6,})/gi;

  function findLotIdFor(el) {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const ids = new Set([...(node.textContent || '').matchAll(LOT_RE)].map(m => m[1]));
      if (ids.size === 1) return [...ids][0];
      if (ids.size > 1) return null; // climbed past the card into the grid — ambiguous
    }
    return null;
  }

  document.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    const btn = e.target.closest && e.target.closest('button');
    if (!btn || btn.textContent.trim() !== 'Make an Offer') return;
    if (/type=makeoffer/.test(location.hash)) return;           // the offer form's own button
    const popup = btn.closest('.tp-popup-confirm');
    if (popup && popup.querySelector('input, textarea, select')) return; // a form popup, not a lot card
    const lotId = findLotIdFor(btn);
    if (!lotId) return; // unsure → normal behaviour
    e.preventDefault();
    e.stopImmediatePropagation();
    window.open(`https://www.neopets.com/island/tradingpost.phtml#/?type=makeoffer&lot_id=${lotId}`, '_blank');
  }, true);

  // ─── USER SHOPS: LOG PURCHASES ─────────────────────────────────────────────
  // Buying in a user shop is all AJAX: item button → confirm "Buy" → the
  // #bsp-buy-success-popup ("You bought X! … You spent N NP."). The popup
  // doesn't name the seller, so we stash it from the item button's buy URL
  // when it's clicked. Nothing opens here — the purchase waits in the inbox
  // and pre-fills the Add form next time the panel opens on the TP.
  // We never touch the buy request itself — only read the page after it.
  let shopPending = null;       // last item button clicked
  let shopPopupLogged = false;  // one log per showing of the success popup
  let shopRetryTimer = null;

  function shopOwnerFromPage() {
    try { return new URLSearchParams(location.search).get('owner') || ''; } catch { return ''; }
  }

  function stashShopItem(e) {
    if (e.button !== 0) return;
    const btn = e.target.closest && e.target.closest('.bsp-item__buy');
    if (!btn) return;
    let owner = '';
    try { owner = new URL(btn.dataset.buyUrl || '', location.origin).searchParams.get('owner') || ''; } catch {}
    shopPending = {
      name:  btn.dataset.name || '',
      price: parseInt((btn.dataset.price || '').replace(/\D/g, ''), 10) || 0,
      owner: owner || shopOwnerFromPage(),
    };
  }

  function isShopPopupVisible(popup) {
    return !!popup && getComputedStyle(popup).display !== 'none';
  }

  function parseShopSuccess(popup) {
    const title = (popup.querySelector('#bsp-buy-success-title')?.textContent || '').replace(/\s+/g, ' ').trim();
    const msg   = (popup.querySelector('#bsp-buy-success-msg')?.textContent   || '').replace(/\s+/g, ' ').trim();
    const nm = title.match(/You bought\s+(.+?)!?$/i);
    const pm = msg.match(/spent\s+([\d,]+)\s*NP/i);
    if (!nm || !pm) return null;
    return { name: nm[1].trim(), spent: parseInt(pm[1].replace(/,/g, ''), 10) };
  }

  function queueShopBuy(parsed) {
    const stamp = new Date().toLocaleDateString();
    const owner = (shopPending && shopPending.owner) || shopOwnerFromPage();
    const shopTxt = owner ? `User shop · ${owner}` : 'User shop';
    let entry;
    if (parsed) {
      const listed = shopPending && shopPending.name === parsed.name ? shopPending.price : 0;
      const diff = listed && listed !== parsed.spent ? ` · listed ${formatNP(listed)} NP` : '';
      entry = { item: parsed.name, price: parsed.spent, qty: 1, notes: `${shopTxt}${diff} · ${stamp}` };
    } else {
      // Couldn't read the popup — fall back to what was clicked so the buy isn't lost
      entry = { item: shopPending ? shopPending.name : '', price: shopPending ? shopPending.price || '' : '',
                qty: 1, notes: `${shopTxt} (couldn't read popup — check price) · ${stamp}` };
    }
    entry.date = new Date().toISOString();
    const inbox = getInbox(); inbox.push(entry); saveInbox(inbox);
    shopPopupLogged = true;
    shopPending = null;
    showToast(parsed ? `📥 ${parsed.name} queued for logging` : '⚠️ Shop purchase queued — check the details');
  }

  function detectShopPurchase(force = false) {
    const popup = document.getElementById('bsp-buy-success-popup');
    if (!isShopPopupVisible(popup)) {
      shopPopupLogged = false;           // hidden again → ready for the next buy
      clearTimeout(shopRetryTimer);
      return;
    }
    if (shopPopupLogged) return;
    const parsed = parseShopSuccess(popup);
    if (!parsed && !force) {
      // Text may fill in a moment after the popup shows — give it a beat
      clearTimeout(shopRetryTimer);
      shopRetryTimer = setTimeout(() => detectShopPurchase(true), 800);
      return;
    }
    clearTimeout(shopRetryTimer);
    queueShopBuy(parsed);
  }

  // ─── MENU COMMAND ──────────────────────────────────────────────────────────
  GM_registerMenuCommand('📦 Toggle NP Tracker Panel', () => {
    const existing = document.getElementById('np-tracker-panel');
    if (existing) { existing.remove(); } else { showTrackerPanel(); }
  });
  GM_registerMenuCommand('↺ Reset NP Tracker button position', () => {
    GM_setValue(BTN_POS_KEY, '');
    const btn = document.getElementById('np-tracker-btn');
    if (btn) placeTrackerBtn(btn);
  });

  // ─── ROUTER ────────────────────────────────────────────────────────────────
  publishHoldings();   // keep Quick Lookup's snapshot fresh on every Tracker page
  syncWatchBackup();   // restore the watchlist if localStorage lost it, else back it up
  if (window.location.href.includes('tradingpost.phtml')) {
    detectTrade();
    injectTrackerButton();
    processTrackerInbox();
    // Quick Lookup's ＋ Log Buy on this same page → open the Add form now
    document.addEventListener('pbp-tracker-inbox', () => processTrackerInbox());
    // Quick Lookup changed the watchlist (this tab: custom event; other tabs: storage event)
    const watchChanged = () => {
      updateWatchBadges();
      const v = document.getElementById('np-view-watch');
      if (v && !v.classList.contains('np-hidden') && !watchBusy) renderWatchView();
    };
    document.addEventListener('pbp-watchlist-changed', watchChanged);
    window.addEventListener('storage', (e) => { if (e.key === WATCH_KEY) watchChanged(); });
    // Ignore changes inside our own panel/toast: redrawing the Offers tab
    // would otherwise trigger a rescan → redraw loop on the offer-made page.
    const ownNode = (r) => {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      return !!(el && el.closest && el.closest('#np-tracker-panel, .np-toast, #np-tracker-btn'));
    };
    const observer = new MutationObserver((recs) => {
      if (recs.length && recs.every(ownNode)) return;
      detectTrade(); detectLotPurchased(); detectOfferAccepted(); scanOffersMade();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(runBackgroundAlertCheck, 3000);
  } else if (window.location.pathname.includes('browseshop.phtml')) {
    document.addEventListener('click', stashShopItem, true);
    const shopObserver = new MutationObserver(() => detectShopPurchase());
    shopObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }

})();
