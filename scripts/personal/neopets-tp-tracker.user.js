// ==UserScript==
// @name         Neopets Trading Post Tracker
// @namespace    http://tampermonkey.net/
// @version      2.34.0
// @description  Track items you buy at the Trading Post and user shops for reselling, sales of your own lots, plus a watchlist for lots and items you didn't buy. Personal build: the Lister (Listings tab) lists items on the TP, relists lots, puts items up for auction, relists unsold ones and logs auction sales.
// @author       You
// @match        https://www.neopets.com/island/tradingpost.phtml*
// @match        https://www.neopets.com/browseshop.phtml*
// @match        https://www.neopets.com/auctions.phtml*
// @match        https://www.neopets.com/safetydeposit.phtml*
// @match        https://www.neopets.com/gallery/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      itemdb.com.br
// ==/UserScript==

(function () {
  'use strict';

  function getPurchases() {
    const raw = GM_getValue('np_purchases', '[]');
    try { return JSON.parse(raw); } catch { return []; }
  }
  function savePurchases(arr) {
    GM_setValue('np_purchases', JSON.stringify(arr));
    publishHoldings(arr);
    renderValueStats();
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
    updateWatchBadges();   // the PBP button shows the queue count
  }

  // Queue entries: purchases (from Instant Buy, offers, user shops, Quick
  // Lookup, the Auto-Buyer) and, since 2.18.0, sales of your own lots that
  // had no matching Tracker row ({ kind: 'sale' }).
  const isSaleEntry = (e) => !!e && e.kind === 'sale';
  const buyIndex = (inbox) => inbox.findIndex(e => !isSaleEntry(e));
  const isCompleteBuy = (e) => !isSaleEntry(e) && !!String(e.item || '').trim() && (parseInt(e.price, 10) || 0) > 0;

  // Fill the Add form with the first queued purchase (if any) and redraw the
  // queue banner and sale reviews. Caller must ensure the panel is rendered.
  function fillFormFromInbox() {
    renderInboxUi();
    const inbox = getInbox();
    const i = buyIndex(inbox);
    if (i < 0) return false;
    const next = inbox[i];
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
    formEl.dataset.fromQueue = '1';   // Save pops this entry
    formEl.classList.remove('np-hidden');
    return true;
  }

  // Banner (queued purchases) and sale review cards, above the Add form
  function renderInboxUi() {
    const formEl = document.getElementById('np-panel-manual-form');
    if (!formEl) return;
    const inbox = getInbox();
    const buys = inbox.filter(e => !isSaleEntry(e));
    const sales = inbox.filter(isSaleEntry);

    let banner = document.getElementById('np-inbox-banner');
    if (!buys.length) {
      if (banner) banner.remove();
    } else {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'np-inbox-banner';
        banner.className = 'np-inbox-banner';
        formEl.parentNode.insertBefore(banner, formEl);
      }
      const review = buys.filter(e => !isCompleteBuy(e)).length;
      banner.innerHTML = `<div>📥 <strong>${buys.length}</strong> purchase${buys.length === 1 ? '' : 's'} queued${review ? ` · ${review} need${review === 1 ? 's' : ''} review` : ''}. Save each one, or:</div>
        <div class="np-q-actions">
          <button type="button" class="np-q-btn" data-q="review" title="Show the next queued purchase in the form">✎ Review</button>
          <button type="button" class="np-q-btn np-q-main" data-q="accept" title="Log every queued purchase that has an item name and a price">✅ Accept all</button>
          <button type="button" class="np-q-btn" data-q="skip" title="Drop the purchase in the form and show the next one">Skip</button>
          <button type="button" class="np-q-btn np-q-danger" data-q="discard" title="Empty the purchase queue">🗑 Discard all</button>
        </div>`;
    }

    let box = document.getElementById('np-sale-review');
    if (!sales.length) {
      if (box) box.remove();
    } else {
      if (!box) {
        box = document.createElement('div');
        box.id = 'np-sale-review';
      }
      // Always just above the banner (or the form when there's no banner)
      const anchor = document.getElementById('np-inbox-banner') || formEl;
      if (box.nextSibling !== anchor) anchor.parentNode.insertBefore(box, anchor);
      box.innerHTML = `<div class="np-sale-head">🏷 ${sales.length} sale${sales.length === 1 ? '' : 's'} with no matching Tracker row</div>`
        + sales.map(s => `
          <div class="np-sale-card" data-qid="${escHtml(s.qid)}">
            <div><b>${escHtml(s.item)}</b>${(s.qty || 1) > 1 ? ` ×${s.qty}` : ''} sold for <b>${formatNP(s.np || 0)} NP</b></div>
            <div class="np-muted np-sale-note">${escHtml(s.notes || '')}${s.date ? ` · ${formatDate(s.date)}` : ''}</div>
            <div class="np-sale-row">
              <input type="number" class="np-sale-cost" min="0" placeholder="What you paid per item (NP)" />
              <button type="button" data-sale="log" title="Log it as bought for that price and sold">Log sale</button>
              <button type="button" data-sale="dismiss">Dismiss</button>
            </div>
          </div>`).join('');
    }
  }

  function hideAddForm() {
    const f = document.getElementById('np-panel-manual-form');
    if (f) { f.classList.add('np-hidden'); delete f.dataset.fromQueue; }
  }
  function afterQueueChange(msg) {
    if (buyIndex(getInbox()) >= 0) fillFormFromInbox();
    else { hideAddForm(); renderInboxUi(); }
    if (msg) showToast(msg);
  }

  function handleQueueClick(e) {
    const q = e.target.closest('[data-q]');
    if (q) { e.preventDefault(); queueAction(q.dataset.q); return; }
    const s = e.target.closest('[data-sale]');
    if (s) { e.preventDefault(); const card = s.closest('[data-qid]'); if (card) saleReviewAction(s.dataset.sale, card); }
  }

  function queueAction(act) {
    const inbox = getInbox();
    if (act === 'review') { fillFormFromInbox(); return; }
    if (act === 'skip') {
      const i = buyIndex(inbox);
      if (i < 0) return;
      inbox.splice(i, 1);
      saveInbox(inbox);
      afterQueueChange('Skipped');
      return;
    }
    if (act === 'discard') {
      const n = inbox.filter(e => !isSaleEntry(e)).length;
      if (!n || !confirm(`Discard all ${n} queued purchase${n === 1 ? '' : 's'}? They won't be logged.`)) return;
      saveInbox(inbox.filter(isSaleEntry));
      afterQueueChange('🗑 Queue cleared');
      return;
    }
    if (act === 'accept') {
      const ok = inbox.filter(isCompleteBuy);
      const rest = inbox.filter(e => !isCompleteBuy(e));
      if (!ok.length) { showToast('Nothing ready to log yet: each needs an item name and a price'); fillFormFromInbox(); return; }
      const purchases = getPurchases();
      const base = Date.now();
      ok.forEach((e, i) => purchases.push({
        id: base + i, item: String(e.item).trim(), price: parseInt(e.price, 10) || 0, qty: parseInt(e.qty, 10) || 1,
        notes: e.notes || '', date: e.date || new Date().toISOString(), soldPrice: null, soldDate: null
      }));
      savePurchases(purchases);
      saveInbox(rest);
      renderPanelTable(getPurchases());
      updatePanelStats();
      const review = rest.filter(e => !isSaleEntry(e)).length;
      afterQueueChange(`✅ Logged ${ok.length}${review ? ` · ${review} need review` : ''}`);
    }
  }

  function saleReviewAction(act, card) {
    const inbox = getInbox();
    const idx = inbox.findIndex(e => isSaleEntry(e) && String(e.qid) === card.dataset.qid);
    if (idx < 0) { renderInboxUi(); return; }
    const s = inbox[idx];
    if (act === 'dismiss') {
      inbox.splice(idx, 1);
      saveInbox(inbox);
      renderInboxUi();
      showToast('Sale dismissed');
      return;
    }
    if (act === 'log') {
      const costEl = card.querySelector('.np-sale-cost');
      const cost = parseInt(costEl ? costEl.value : '', 10);
      if (!Number.isFinite(cost) || cost < 0) { alert('Enter what you paid per item (0 if it cost nothing).'); return; }
      const qty = s.qty || 1;
      const when = s.date || new Date().toISOString();
      const purchases = getPurchases();
      purchases.push({ id: Date.now(), item: s.item, price: cost, qty, notes: s.notes || '', date: when,
                       soldPrice: Math.round((s.np || 0) / qty), soldQty: qty, soldDate: when });
      savePurchases(purchases);
      inbox.splice(idx, 1);
      saveInbox(inbox);
      renderInboxUi();
      renderPanelTable(getPurchases());
      updatePanelStats();
      showToast(`🏷 ${s.item} logged as bought and sold`);
    }
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

  // The queue changed (something was logged on this page, Quick Lookup's
  // ＋ Log Buy, another tab). The panel never opens by itself any more: the
  // PBP button shows the count, and an open panel refreshes its banner.
  function processTrackerInbox() {
    updateWatchBadges();
    const panel = document.getElementById('np-tracker-panel');
    if (!panel || panel.dataset.closing) return;
    const form = document.getElementById('np-panel-manual-form');
    if (form && form.classList.contains('np-hidden') && buyIndex(getInbox()) >= 0) fillFormFromInbox();
    else renderInboxUi();
  }

  // 📌 Pin: pinned = the panel opens on every Trading Post page load;
  // unpinned = it stays closed until you click the PBP button.
  const PANEL_PIN_KEY = 'np_panel_pinned';
  function isPanelPinned() { return !!GM_getValue(PANEL_PIN_KEY, false); }
  function updatePinBtn(panel) {
    const b = panel.querySelector('#np-panel-pin');
    if (!b) return;
    const on = isPanelPinned();
    b.classList.toggle('np-pin-on', on);
    b.textContent = on ? '📌 Pinned' : '📌 Pin';
    b.title = on ? 'Pinned: opens by itself on every Trading Post page. Click to unpin.'
                 : 'Not pinned: stays closed until you click the PBP button. Click to keep it open on every page.';
  }

  // ─── 🏷 LIST VIA THE AUTO-LISTER (personal build only) ─────────────────────
  // 🏷 List on an unsold row / List all on a Grouped row adds it to a draft
  // (GM np_list_draft). The drawer sets qty, price per item, lot shape and
  // size; Send writes localStorage.pbp_tpl_queue, which the PBP TP Auto-Lister
  // (a separate script) works through with ▶ Run queue. The lister writes
  // done / missing back to the same key, shown here. Public builds set
  // PERSONAL_BUILD = false and strip this block.
  const PERSONAL_BUILD = true;
  const LIST_DRAFT_KEY = 'np_list_draft';
  const LISTER_QUEUE_KEY = 'pbp_tpl_queue';

  function getListDraft() {
    try {
      const d = JSON.parse(GM_getValue(LIST_DRAFT_KEY, '') || 'null') || {};
      return { items: Array.isArray(d.items) ? d.items : [], mode: d.mode === 'packed' ? 'packed' : 'single',
               lotSize: Math.max(1, Math.min(30, parseInt(d.lotSize, 10) || 30)) };
    } catch { return { items: [], mode: 'single', lotSize: 30 }; }
  }
  function saveListDraft(d) { GM_setValue(LIST_DRAFT_KEY, JSON.stringify(d)); }
  function getListerQueue() {
    try { const q = JSON.parse(localStorage.getItem(LISTER_QUEUE_KEY) || 'null'); return q && Array.isArray(q.items) ? q : null; }
    catch { return null; }
  }

  // "5000", "5k", "2.5m", "1,000,000" → NP; blank or unreadable → 0
  function parseNPInput(s) {
    const m = String(s || '').trim().toLowerCase().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
    return m ? Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)) : 0;
  }

  // rows = unsold Tracker rows of one item. A row already in the draft isn't added twice.
  function addToListDraft(rows) {
    const d = getListDraft();
    let added = 0;
    for (const p of rows) {
      if (isSoldRow(p)) continue;
      const k = groupKey(p.item);
      let e = d.items.find(x => groupKey(x.name) === k);
      if (!e) { e = { name: String(p.item).trim(), qty: 0, price: '', ids: [] }; d.items.push(e); }
      e.ids = e.ids || [];
      if (e.ids.includes(p.id)) continue;
      e.ids.push(p.id);
      e.qty += Number(p.qty) || 1;
      added += Number(p.qty) || 1;
    }
    saveListDraft(d);
    renderListDrawer();
    const name = rows[0] ? rows[0].item : '';
    showToast(added ? `🏷 ${added}× ${name} added to the list` : `🏷 ${name} is already in the list`);
  }

  function renderListDrawer() {
    const box = document.getElementById('np-list-drawer');
    if (!box) return;
    const d = getListDraft();
    const q = getListerQueue();
    const qLeft = q ? q.items.reduce((s, i) => s + (i.qty > 0 ? i.qty : 0), 0) : 0;
    const qDone = q && Array.isArray(q.done) ? q.done : [];
    const qMiss = q && Array.isArray(q.missing) ? q.missing : [];
    if (!d.items.length && !qLeft && !qDone.length && !qMiss.length) { box.classList.add('np-hidden'); box.innerHTML = ''; return; }
    box.classList.remove('np-hidden');

    const lots = new Set(qDone.map(x => x.lot)).size;
    const queueHtml = q && (qLeft || qDone.length || qMiss.length) ? `
      <div class="np-ld-queue">
        <div>🤖 Auto-Lister: ${qLeft ? `<b>${qLeft}</b> item${qLeft === 1 ? '' : 's'} waiting` : 'queue finished'}${qDone.length ? ` · ${qDone.reduce((s, x) => s + (x.qty || 0), 0)} listed in ${lots} lot${lots === 1 ? '' : 's'}` : ''}</div>
        ${qMiss.length ? `<div class="np-red np-ld-miss" title="Not found in inventory, gallery or SDB">Short: ${qMiss.map(m => `${escHtml(m.name)} (${m.short})`).join(', ')}</div>` : ''}
        ${qLeft ? '<div class="np-muted np-ld-note">Press ▶ Run queue in Listings → 🏝️ Trades.</div>' : ''}
        <div class="np-q-actions"><button type="button" class="np-q-btn np-q-danger" data-ld="clearq">${qLeft ? 'Cancel queue' : 'Clear'}</button></div>
      </div>` : '';

    const total = d.items.reduce((s, e) => s + (e.qty || 0), 0);
    const draftHtml = d.items.length ? `
      <div class="np-ld-head">🏷 To list · ${total} item${total === 1 ? '' : 's'}</div>
      ${d.items.map((e, i) => {
        const m = marketPrices[e.name];
        const hint = m && m.value ? `IB ea · itemdb ${shortNP(m.value)}` : 'IB each (blank = none)';
        return `<div class="np-ld-row" data-i="${i}">
          <span class="np-ld-name" title="${escHtml(e.name)}">${escHtml(e.name)}</span>
          <input class="np-ld-qty" type="number" min="1" value="${e.qty}" title="How many to list" />
          <input class="np-ld-price" type="text" value="${escHtml(e.price || '')}" placeholder="${escHtml(hint)}" title="Instant-buy per item: 5000, 5k, 2.5m" />
          <button type="button" class="np-ld-rm" data-ld="rm" title="Remove">✕</button>
        </div>`;
      }).join('')}
      <div class="np-ld-opts">
        <div class="np-view-toggle" title="One item type per lot, or mixed items packed together">
          <button type="button" data-ld="single" class="${d.mode === 'single' ? 'np-view-on' : ''}">One type</button>
          <button type="button" data-ld="packed" class="${d.mode === 'packed' ? 'np-view-on' : ''}">Packed</button>
        </div>
        <label>Lot size <input class="np-ld-size" type="number" min="1" max="30" value="${d.lotSize}" /></label>
      </div>
      <div class="np-muted np-ld-note">Lot IB = item prices added up. Any blank price → no IB for that lot. Over 20m → IB off, asking price goes in the wishlist.</div>
      <div class="np-q-actions">
        <button type="button" class="np-q-btn np-q-main" data-ld="send">🚀 Send to Auto-Lister</button>
        <button type="button" class="np-q-btn np-q-danger" data-ld="clear">Clear</button>
      </div>` : '';

    box.innerHTML = draftHtml + queueHtml;
  }

  // Bound once per panel: clicks for buttons, change for the inputs (no redraw while typing)
  function bindListDrawer() {
    const box = document.getElementById('np-list-drawer');
    if (!box) return;
    box.addEventListener('change', (e) => {
      const d = getListDraft();
      if (e.target.classList.contains('np-ld-size')) {
        const n = parseInt(e.target.value, 10);
        d.lotSize = n >= 1 && n <= 30 ? n : d.lotSize;
        e.target.value = d.lotSize;
        saveListDraft(d);
        return;
      }
      const row = e.target.closest('.np-ld-row');
      const it = row && d.items[parseInt(row.dataset.i, 10)];
      if (!it) return;
      if (e.target.classList.contains('np-ld-qty')) {
        const n = parseInt(e.target.value, 10);
        it.qty = n >= 1 ? n : it.qty;
        e.target.value = it.qty;
      } else if (e.target.classList.contains('np-ld-price')) {
        const raw = e.target.value.trim();
        const n = parseNPInput(raw);
        it.price = raw && n ? String(n) : '';
        e.target.value = it.price;
        if (raw && !n) showToast('Price not understood — use 5000, 5k or 2.5m');
      }
      saveListDraft(d);
      // No redraw here: a blur-triggered redraw would swallow a click on Send
      const head = box.querySelector('.np-ld-head');
      const total = d.items.reduce((s, x) => s + (x.qty || 0), 0);
      if (head) head.textContent = `🏷 To list · ${total} item${total === 1 ? '' : 's'}`;
    });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ld]');
      if (!b) return;
      e.preventDefault();
      const act = b.dataset.ld;
      const d = getListDraft();
      if (act === 'rm') {
        const row = b.closest('.np-ld-row');
        d.items.splice(parseInt(row.dataset.i, 10), 1);
        saveListDraft(d); renderListDrawer();
      } else if (act === 'single' || act === 'packed') {
        d.mode = act; saveListDraft(d); renderListDrawer();
      } else if (act === 'clear') {
        if (!confirm('Clear the list? Nothing has been sent yet.')) return;
        d.items = []; saveListDraft(d); renderListDrawer();
      } else if (act === 'clearq') {
        const q = getListerQueue();
        const left = q ? q.items.reduce((s, i) => s + (i.qty > 0 ? i.qty : 0), 0) : 0;
        if (left && !confirm(`Cancel the Auto-Lister queue? ${left} item${left === 1 ? '' : 's'} won't be listed. (Stop the Auto-Lister first if it's running.)`)) return;
        localStorage.removeItem(LISTER_QUEUE_KEY);
        renderListDrawer();
        listerRefresh();
      } else if (act === 'send') {
        sendToLister(d);
      }
    });
  }

  function sendToLister(d) {
    d = getListDraft();   // the field being typed in saved on blur, before this click
    const items = d.items.filter(e => e.qty > 0 && String(e.name).trim());
    if (!items.length) return;
    const q = getListerQueue();
    // Queued relists (↻ on Listings) are kept; only plain items get replaced
    const relists = q ? q.items.filter(i => i.group && i.qty > 0) : [];
    const left = q ? q.items.reduce((s, i) => s + (i.qty > 0 && !i.group ? i.qty : 0), 0) : 0;
    if (left && !confirm(`The Auto-Lister still has ${left} item${left === 1 ? '' : 's'} queued. Replace that queue with this one?`)) return;
    const unpriced = items.filter(e => !parseNPInput(e.price)).length;
    if (unpriced && !confirm(`${unpriced} item${unpriced === 1 ? ' has' : 's have'} no price, so ${unpriced === 1 ? 'its lots get' : 'their lots get'} no instant-buy. Send anyway?`)) return;
    localStorage.setItem(LISTER_QUEUE_KEY, JSON.stringify({
      v: 1, created: new Date().toISOString(), mode: d.mode, lotSize: d.lotSize,
      items: [...relists, ...items.map(e => ({ name: String(e.name).trim(), qty: e.qty, price: parseNPInput(e.price) || null }))],
      groups: relists.length ? (q.groups || {}) : {},
      done: [], missing: []
    }));
    d.items = [];
    saveListDraft(d);
    renderListDrawer();
    const n = items.reduce((s, e) => s + e.qty, 0);
    listerRefresh();
    showToast(`🚀 ${n} item${n === 1 ? '' : 's'} sent — press ▶ Run queue in Listings → 🏝️ Trades`);
  }

  // ─── 🔨 AUCTION VIA THE AUTO-LISTER (personal build only) ─────────────────
  // 🔨 on an unsold row / 🔨 All on a Grouped row adds it to an auction draft
  // (GM np_auc_draft). The drawer sets how many and the start price per item;
  // Send writes localStorage.pbp_auc_queue, which the Auto-Lister works
  // through with ▶ Run auctions, one auction per item. Min. increment, length
  // and Neofriends-only are Lister panel settings. The Lister records every
  // auction it starts in localStorage.pbp_auc_live and marks it sold or
  // unsold from My Auctioned Items; sold ones are logged here, oldest
  // matching rows first (processAuctionSales).
  const AUC_DRAFT_KEY = 'np_auc_draft';
  const AUC_QUEUE_KEY = 'pbp_auc_queue';
  const AUC_REG_KEY = 'pbp_auc_live';
  const AUC_LOGGED_KEY = 'np_auc_logged';

  function getAucDraft() {
    try {
      const d = JSON.parse(GM_getValue(AUC_DRAFT_KEY, '') || 'null') || {};
      return { items: Array.isArray(d.items) ? d.items : [] };
    } catch { return { items: [] }; }
  }
  function saveAucDraft(d) { GM_setValue(AUC_DRAFT_KEY, JSON.stringify(d)); }
  function getAucQueue() {
    try { const q = JSON.parse(localStorage.getItem(AUC_QUEUE_KEY) || 'null'); return q && Array.isArray(q.items) ? q : null; }
    catch { return null; }
  }
  // Auction ids you removed (✕ / Delete all). The Lister skips them on My
  // Auctioned Items, so a row still on that page isn't picked up again.
  const AUC_IGNORE_KEY = 'pbp_auc_ignore';
  function aucIgnored() {
    try { return new Set((JSON.parse(localStorage.getItem(AUC_IGNORE_KEY) || '[]') || []).map(String)); } catch { return new Set(); }
  }
  function aucIgnoreAdd(ids) {
    const set = aucIgnored();
    ids.filter(Boolean).forEach(id => set.add(String(id)));
    try { localStorage.setItem(AUC_IGNORE_KEY, JSON.stringify([...set].slice(-3000))); } catch { /* full: nothing to do */ }
  }
  function getAucReg() {
    try { const r = JSON.parse(localStorage.getItem(AUC_REG_KEY) || 'null'); return r && Array.isArray(r.entries) ? r : { entries: [] }; }
    catch { return { entries: [] }; }
  }

  function addToAucDraft(rows) {
    const d = getAucDraft();
    let added = 0;
    for (const p of rows) {
      if (isSoldRow(p)) continue;
      const k = groupKey(p.item);
      let e = d.items.find(x => groupKey(x.name) === k);
      if (!e) { e = { name: String(p.item).trim(), qty: 0, start: '', ids: [] }; d.items.push(e); }
      e.ids = e.ids || [];
      if (e.ids.includes(p.id)) continue;
      e.ids.push(p.id);
      e.qty += Number(p.qty) || 1;
      added += Number(p.qty) || 1;
    }
    saveAucDraft(d);
    renderAucDrawer();
    const name = rows[0] ? rows[0].item : '';
    showToast(added ? `🔨 ${added}× ${name} added to the auction list` : `🔨 ${name} is already in the auction list`);
  }

  function renderAucDrawer() {
    const box = document.getElementById('np-auc-drawer');
    if (!box) return;
    const d = getAucDraft();
    const q = getAucQueue();
    const qLeft = q ? q.items.reduce((s, i) => s + (i.qty > 0 ? i.qty : 0), 0) : 0;
    const qDone = q && Array.isArray(q.done) ? q.done : [];
    const qMiss = q && Array.isArray(q.missing) ? q.missing : [];
    const reg = getAucReg().entries;
    const live = reg.filter(e => e.status === 'pending' || e.status === 'live').length;
    const unsold = reg.filter(e => e.status === 'unsold').length;
    const showQ = !!q && (qLeft || qDone.length || qMiss.length);
    if (!d.items.length && !showQ && !live && !unsold) { box.classList.add('np-hidden'); box.innerHTML = ''; box.dataset.html = ''; return; }
    box.classList.remove('np-hidden');

    const queueHtml = showQ ? `
      <div class="np-ld-queue">
        <div>🤖 Auctions: ${qLeft ? `<b>${qLeft}</b> item${qLeft === 1 ? '' : 's'} waiting` : 'queue finished'}${qDone.length ? ` · ${qDone.length} put up` : ''}</div>
        ${qMiss.length ? `<div class="np-red np-ld-miss" title="Not found in the SDB, gallery or inventory">Short: ${qMiss.map(m => `${escHtml(m.name)} (${m.short})`).join(', ')}</div>` : ''}
        ${qLeft ? '<div class="np-muted np-ld-note">Press ▶ Run auctions in Listings → 🔨 Auctions.</div>' : ''}
        <div class="np-q-actions"><button type="button" class="np-q-btn np-q-danger" data-ad="clearq">${qLeft ? 'Cancel queue' : 'Clear'}</button></div>
      </div>` : '';
    const waiting = reg.filter(e => e.status === 'unsold');
    const unsoldHtml = waiting.length ? `
      <div class="np-ld-queue">
        <div>Unsold · ↻ relist now at:</div>
        ${waiting.length > 1 ? `<div class="np-watch-actions np-au-pcts"><b style="font-size:11px">All ${waiting.length}:</b>${[0, 5, 10, 15, 20].map(pc =>
          `<button type="button" class="np-watch-act" data-ad="relistall" data-p="${pc}" title="Relist all ${waiting.length} in one run">${pc ? '−' + pc : '0'}%</button>`).join('')}</div>` : ''}
        ${waiting.map(e => `
          <div class="np-ld-row np-au-row" data-key="${escHtml(e.key)}">
            <span class="np-ld-name" title="${escHtml(e.name)} · auction ${escHtml(e.id || '')}">${escHtml(e.name)}</span>
            <input class="np-au-price" type="text" value="${formatNP(e.start)}" title="Relist start price: 5000, 5k, 2.5m" />
            <button type="button" class="np-ld-rm" data-ad="norelist" title="Don't relist this one">✕</button>
          </div>
          <div class="np-watch-actions np-au-pcts">${[0, 5, 10, 15, 20].map(pc => {
            const v = relistPrice(e.base || e.start, pc);
            return `<button type="button" class="np-watch-act" data-ad="relist" data-key="${escHtml(e.key)}" data-p="${pc}" title="Put it back up now at ${formatNP(v)} NP">${pc ? '−' + pc : '0'}%</button>`;
          }).join('')}</div>`).join('')}
      </div>` : '';
    const regHtml = live || unsold ? `<div class="np-muted np-ld-note np-ad-live">🔨 ${live} auction${live === 1 ? '' : 's'} running${unsold ? ` · ${unsold} unsold` : ''}. Sales are logged here once the Auto-Lister reads My Auctioned Items.</div>` : '';

    const total = d.items.reduce((s, e) => s + (e.qty || 0), 0);
    const draftHtml = d.items.length ? `
      <div class="np-ld-head">🔨 To auction · ${total} item${total === 1 ? '' : 's'}</div>
      ${d.items.map((e, i) => {
        const m = marketPrices[e.name];
        const hint = m && m.value ? `start ea · itemdb ${shortNP(m.value)}` : 'Start price each';
        return `<div class="np-ld-row" data-i="${i}">
          <span class="np-ld-name" title="${escHtml(e.name)}">${escHtml(e.name)}</span>
          <input class="np-ld-qty" type="number" min="1" value="${e.qty}" title="How many to auction (one auction each)" />
          <input class="np-ld-price" type="text" value="${escHtml(e.start || '')}" placeholder="${escHtml(hint)}" title="Start price per item: 5000, 5k, 2.5m" />
          <button type="button" class="np-ld-rm" data-ad="rm" title="Remove">✕</button>
        </div>`;
      }).join('')}
      <div class="np-muted np-ld-note">One auction per item. Min. increment, length and Neofriends-only are set in the Auto-Lister panel.</div>
      <div class="np-q-actions">
        <button type="button" class="np-q-btn np-q-main" data-ad="send">🚀 Send to Auto-Lister</button>
        <button type="button" class="np-q-btn np-q-danger" data-ad="clear">Clear</button>
      </div>` : '';

    // Not while typing a relist price — a redraw would eat the edit
    if (box.contains(document.activeElement) && document.activeElement.classList.contains('np-au-price')) return;
    const html = draftHtml + queueHtml + unsoldHtml + regHtml;
    if (box.innerHTML !== html && box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }

  function saveAucReg(r) {
    try { localStorage.setItem(AUC_REG_KEY, JSON.stringify(r)); } catch (e) { showToast('Could not save: ' + e.message); }
    processAuctionSales();   // a ✅ Log sale gets logged right away
    renderAucDrawer();
    if (listingsOpen()) renderListingsView();
    listerRefresh();
  }

  function bindAucDrawer() {
    const box = document.getElementById('np-auc-drawer');
    if (!box) return;
    box.addEventListener('change', (e) => {
      if (e.target.classList.contains('np-au-price')) {
        const r = getAucReg();
        const en = r.entries.find(x => x.key === e.target.closest('.np-au-row').dataset.key);
        const n = parseNPInput(e.target.value);
        if (en && n > 0) { en.base = en.base || en.start; en.start = n; saveAucReg(r); }
        else if (e.target.value.trim()) showToast('Price not understood — use 5000, 5k or 2.5m');
        e.target.blur();
        renderAucDrawer();
        return;
      }
      const d = getAucDraft();
      const row = e.target.closest('.np-ld-row');
      const it = row && d.items[parseInt(row.dataset.i, 10)];
      if (!it) return;
      if (e.target.classList.contains('np-ld-qty')) {
        const n = parseInt(e.target.value, 10);
        it.qty = n >= 1 ? n : it.qty;
        e.target.value = it.qty;
      } else if (e.target.classList.contains('np-ld-price')) {
        const raw = e.target.value.trim();
        const n = parseNPInput(raw);
        it.start = raw && n ? String(n) : '';
        e.target.value = it.start;
        if (raw && !n) showToast('Price not understood — use 5000, 5k or 2.5m');
      }
      saveAucDraft(d);
      const head = box.querySelector('.np-ld-head');
      const total = d.items.reduce((s, x) => s + (x.qty || 0), 0);
      if (head) head.textContent = `🔨 To auction · ${total} item${total === 1 ? '' : 's'}`;
    });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ad]');
      if (!b) return;
      e.preventDefault();
      const act = b.dataset.ad;
      const d = getAucDraft();
      if (act === 'relistall') {
        relistAuctions(getAucReg().entries.filter(x => x.status === 'unsold').map(x => x.key), parseInt(b.dataset.p, 10) || 0);
        return;
      }
      if (act === 'pct' || act === 'norelist' || act === 'relist') {
        auctionAction(act, b.dataset.key || b.closest('.np-au-row').dataset.key, parseInt(b.dataset.p, 10) || 0);
        return;
      }
      if (act === 'rm') {
        d.items.splice(parseInt(b.closest('.np-ld-row').dataset.i, 10), 1);
        saveAucDraft(d); renderAucDrawer();
      } else if (act === 'clear') {
        if (!confirm('Clear the auction list? Nothing has been sent yet.')) return;
        d.items = []; saveAucDraft(d); renderAucDrawer();
      } else if (act === 'clearq') {
        const q = getAucQueue();
        const left = q ? q.items.reduce((s, i) => s + (i.qty > 0 ? i.qty : 0), 0) : 0;
        if (left && !confirm(`Cancel the auction queue? ${left} item${left === 1 ? '' : 's'} won't be auctioned. (Stop the Auto-Lister first if it's running.)`)) return;
        localStorage.removeItem(AUC_QUEUE_KEY);
        renderAucDrawer();
        listerRefresh();
      } else if (act === 'send') {
        sendAucQueue();
      }
    });
  }

  function sendAucQueue() {
    const d = getAucDraft();   // the field being typed in saved on blur, before this click
    const items = d.items.filter(e => e.qty > 0 && String(e.name).trim());
    if (!items.length) return;
    const noStart = items.filter(e => !parseNPInput(e.start));
    if (noStart.length) { showToast(`🔨 Every item needs a start price (${noStart.map(e => e.name).join(', ')})`); return; }
    const q = getAucQueue();
    const left = q ? q.items.reduce((s, i) => s + (i.qty > 0 ? i.qty : 0), 0) : 0;
    if (left && !confirm(`The Auto-Lister still has ${left} item${left === 1 ? '' : 's'} queued for auction. Replace that queue with this one?`)) return;
    localStorage.setItem(AUC_QUEUE_KEY, JSON.stringify({
      v: 1, created: new Date().toISOString(),
      items: items.map(e => ({ name: String(e.name).trim(), qty: e.qty, start: parseNPInput(e.start) })),
      done: [], missing: []
    }));
    d.items = [];
    saveAucDraft(d);
    renderAucDrawer();
    const n = items.reduce((s, e) => s + e.qty, 0);
    listerRefresh();
    showToast(`🚀 ${n} item${n === 1 ? '' : 's'} sent — press ▶ Run auctions in Listings → 🔨 Auctions`);
  }

  // Sold auctions → oldest matching unsold rows marked sold (FIFO) at the
  // winning bid. No Tracker row → queued as a sale to review. Each auction
  // id is logged once (GM np_auc_logged).
  function processAuctionSales() {
    if (!PERSONAL_BUILD) return;
    const sold = getAucReg().entries.filter(e => e.status === 'sold' && e.id && Number(e.price) > 0);
    if (!sold.length) return;
    let logged;
    try { logged = new Set(JSON.parse(GM_getValue(AUC_LOGGED_KEY, '[]')) || []); } catch { logged = new Set(); }
    const todo = sold.filter(e => !logged.has(String(e.id)));
    if (!todo.length) return;
    // Mark first, so a second tab running this at the same moment skips them
    todo.forEach(e => logged.add(String(e.id)));
    GM_setValue(AUC_LOGGED_KEY, JSON.stringify([...logged].slice(-1000)));
    const purchases = getPurchases();
    let marked = 0, review = 0, np = 0;
    for (const e of todo) {
      const price = Number(e.price);
      const when = e.soldAt || new Date().toISOString();
      const note = `sold at auction #${e.id}${e.buyer ? ` to ${e.buyer}` : ''}`;
      const r = sellFifo(purchases, e.name, 1, price, when, note);
      if (r.sold) marked++;
      else { queueSale({ item: e.name, qty: 1, np: price, date: when, notes: note }); review++; }
      np += price;
    }
    if (marked) savePurchases(purchases);
    refreshOpenPanel();
    renderAucDrawer();
    showToast(`🔨 ${todo.length} auction sale${todo.length === 1 ? '' : 's'} · ${formatNP(np)} NP · ${marked} marked sold${review ? ` · ${review} to review` : ''}`);
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

  // Saved prices (np_listing_prices) load into the Market column, so they're
  // still there after a reload. They change only with 🔄 Refresh Prices, a
  // row's ↻, or a refresh on the Listings tab.
  function hydrateMarketPrices(purchases) {
    const saved = getListingPrices();
    for (const p of purchases) {
      const e = saved[wKey(p.item)];
      if (e) marketPrices[p.item] = { value: e.v || null, inflated: !!e.inflated, slug: e.slug || null, t: e.t };
    }
  }
  function savedAgo(m) { return m && m.t ? `saved ${timeAgo(new Date(m.t).toISOString())}` : 'fetched this visit'; }
  function rfBtn(id, item) {
    return `<button class="np-btn-check-price np-btn-rf" data-id="${id}" data-item="${escHtml(item)}" title="Refresh this itemdb price">↻</button>`;
  }

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
    if (!m.value) return `<span class="np-muted" title="itemdb has no price · ${savedAgo(m)}">No data</span>${rfBtn(p.id, p.item)}`;
    const link = `https://itemdb.com.br/item/${m.slug || encodeURIComponent(p.item)}`;
    const priceHtml = `<a class="np-market-price" href="${link}" target="_blank" title="itemdb · ${savedAgo(m)}">${formatNP(m.value)} NP${m.inflated ? ' ⚠️' : ''}</a>${rfBtn(p.id, p.item)}`;
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
              if (response.status >= 200 && response.status < 300) saveFetchedPrice(itemName, data);
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
      // While the 🤖 Lister is working, open straight on Listings → its sub-tab
      if (existing) { existing.remove(); return; }
      if (lister && lister.running()) {
        GM_setValue(LISTINGS_SUB_KEY, lister.mode() === 'auction' ? 'auctions' : 'trades');
        showTrackerPanel('listings');
      } else showTrackerPanel();
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
  // 📜 History open under a Purchases row ('r:<id>' list row, 'g:<item>' group)
  // or a 💡 suggestion ('s:<item>'). Uses the Watch tab's loader and cache.
  const purchHistOpen = new Set();
  function histBtn(id, name) {
    return `<button type="button" class="np-btn-hist${purchHistOpen.has(id) ? ' on' : ''}" data-ph="${escHtml(id)}" data-name="${escHtml(name)}" title="Trading Post now, auction, trade and price history for ${escHtml(name)}">📜</button>`;
  }
  function histRow(id, name, cols) {
    if (!purchHistOpen.has(id)) return '';
    const m = marketPrices[name];
    return `<tr class="np-ph-tr"><td colspan="${cols}"><div class="np-wh">${watchHistHtml(name, m && m.value)}</div></td></tr>`;
  }
  // Open/close one panel; redraw now (spinner) and again when itemdb answers
  function togglePurchHist(id, name, redraw) {
    if (purchHistOpen.has(id)) { purchHistOpen.delete(id); redraw(); return; }
    purchHistOpen.add(id);
    redraw();
    loadWatchHist(name).then(redraw);
  }

  // ─── TRACKER PANEL ─────────────────────────────────────────────────────────
  function showTrackerPanel(openTab) {
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
          <button id="np-panel-pin" type="button"></button>
          <button id="np-panel-dock" type="button"></button>
          <button id="np-panel-close">✕</button>
        </div>
        <div class="np-tab-bar">
          <button class="np-tab np-tab-active" data-tab="purchases">📦 Purchases</button>
          <button class="np-tab" data-tab="pnl">📊 P&amp;L</button>
          <button class="np-tab" data-tab="offers">📨 Offers</button>
          <button class="np-tab" data-tab="listings">🏷 Listings</button>
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
            <div class="np-stat np-stat-goto" id="np-stat-listed-card" data-goto="listings">
              <div class="np-stat-label">Listed</div>
              <div class="np-stat-val" id="np-stat-listed">—</div>
              <div class="np-stat-sub" id="np-stat-listed-sub"></div>
            </div>
            <div class="np-stat" id="np-stat-tosell-card">
              <div class="np-stat-label">To sell ≈</div>
              <div class="np-stat-val" id="np-stat-tosell">—</div>
              <div class="np-stat-sub" id="np-stat-tosell-sub"></div>
            </div>
          </div>
          <div id="np-stat-drawer" class="np-hidden"></div>
          <div id="np-portfolio-summary" class="np-hidden"></div>
          <details id="np-suggest" class="np-suggest"></details>
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
          ${PERSONAL_BUILD ? '<div id="np-list-drawer" class="np-hidden"></div><div id="np-auc-drawer" class="np-hidden"></div>' : ''}
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

        <!-- LISTINGS TAB -->
        <div id="np-view-listings" class="np-hidden"></div>

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
    updatePinBtn(panel);
    panel.querySelector('#np-panel-pin').addEventListener('click', () => {
      GM_setValue(PANEL_PIN_KEY, !isPanelPinned());
      updatePinBtn(panel);
      showToast(isPanelPinned() ? '📌 Pinned: the Tracker opens on every Trading Post page'
                                : '📌 Unpinned: the Tracker stays closed until you click it');
    });
    // Queue banner and sale review buttons
    document.getElementById('np-view-purchases').addEventListener('click', handleQueueClick);

    // ─── EVENTS ──────────────────────────────────────────────────────────────
    listingsLastHtml = '';   // fresh panel → Listings draws for real
    watchPanelWidth(panel);
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
      delete form.dataset.fromQueue;
      if (!form.classList.contains('np-hidden')) {
        ['np-pf-item', 'np-pf-price', 'np-pf-notes'].forEach(id => { document.getElementById(id).value = ''; });
        document.getElementById('np-pf-qty').value = '1';
        setAddFormDate(null);
      }
    });

    // ─── STAT CARD DRAWER ────────────────────────────────────────────────────
    let activeFilter = null;
    document.querySelector('.np-panel-stats').addEventListener('click', (e) => {
      const go = e.target.closest('[data-goto]');
      if (go) { const t = document.querySelector(`.np-tab[data-tab="${go.dataset.goto}"]`); if (t) t.click(); return; }
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
      const fromQueue = !!document.getElementById('np-panel-manual-form').dataset.fromQueue;
      const purchases = getPurchases();
      purchases.push({ id: Date.now(), item, price, qty, notes, date, soldPrice: null, soldDate: null });
      savePurchases(purchases);
      hideAddForm();
      document.getElementById('np-pf-item').value = '';
      document.getElementById('np-pf-price').value = '';
      document.getElementById('np-pf-qty').value = '1';
      document.getElementById('np-pf-notes').value = '';
      setAddFormDate(null);
      renderPanelTable(getPurchases());
      updatePanelStats();
      showToast(toDateInput(date) === toDateInput() ? 'Purchase logged!' : `Purchase logged for ${formatDate(date)}`);

      // Saved from the queue → drop that entry and show the next one
      if (fromQueue) {
        const inbox = getInbox();
        const i = buyIndex(inbox);
        if (i >= 0) { inbox.splice(i, 1); saveInbox(inbox); }
        if (buyIndex(getInbox()) >= 0) {
          setTimeout(fillFormFromInbox, 150);
        } else {
          renderInboxUi();
          showToast('✅ All queued purchases logged!');
        }
      }
    });
    document.getElementById('np-pf-cancel').addEventListener('click', () => {
      // Only closes the form. Anything queued stays queued (the button still counts it).
      hideAddForm();
    });
    document.getElementById('np-panel-tbody').addEventListener('click', (e) => {
      const hb = e.target.closest('.np-btn-hist');
      if (hb) { togglePurchHist(hb.dataset.ph, hb.dataset.name, () => renderPanelTable(getPurchases())); return; }
      const ab = e.target.closest('.np-btn-auc');
      if (ab) {
        const all = getPurchases();
        const rows = ab.dataset.grp !== undefined
          ? all.filter(p => !isSoldRow(p) && groupKey(p.item) === ab.dataset.grp)
          : all.filter(p => p.id === parseInt(ab.dataset.id, 10));
        if (rows.length) addToAucDraft(rows);
        return;
      }
      const lb = e.target.closest('.np-btn-list');
      if (lb) {
        const all = getPurchases();
        const rows = lb.dataset.grp !== undefined
          ? all.filter(p => !isSoldRow(p) && groupKey(p.item) === lb.dataset.grp)
          : all.filter(p => p.id === parseInt(lb.dataset.id, 10));
        if (rows.length) addToListDraft(rows);
        return;
      }
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
        document.getElementById('np-view-listings').classList.toggle('np-hidden', tab !== 'listings');
        document.getElementById('np-view-watch').classList.toggle('np-hidden', tab !== 'watch');
        if (tab === 'pnl') renderPnlView('24h');
        if (tab === 'offers') renderOffersView();
        if (tab === 'listings') { renderListingsView(); valueListings(false); }
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
    renderValueStats();
    fillFormFromInbox();   // anything queued → Add form pre-filled, banner + sale reviews shown
    if (PERSONAL_BUILD) { bindListDrawer(); renderListDrawer(); bindAucDrawer(); renderAucDrawer(); }
    if (openTab) { const t = panel.querySelector(`.np-tab[data-tab="${openTab}"]`); if (t) t.click(); }
  }

  function renderPanelTable(purchases, filter) {
    const tbody = document.getElementById('np-panel-tbody');
    const empty = document.getElementById('np-panel-empty');
    const table = document.getElementById('np-panel-table');
    if (!tbody) return;
    hydrateMarketPrices(purchases);
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
          ${grp ? '' : histBtn('r:' + p.id, p.item)}
          ${PERSONAL_BUILD && !isSoldRow(p) ? `<button class="np-btn-list" data-id="${p.id}" title="Add to the list for the Auto-Lister">🏷</button><button class="np-btn-auc" data-id="${p.id}" title="Add to the auction list for the Auto-Lister">🔨</button>` : ''}
        </td>
      </tr>` + (grp ? '' : histRow('r:' + p.id, p.item, 7));
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
        marketCell = `<span class="np-muted" title="itemdb has no price · ${savedAgo(m)}">No data</span>${rfBtn(rows[0].id, name)}`;
      } else {
        const link = `https://itemdb.com.br/item/${m.slug || encodeURIComponent(name)}`;
        const unreal = rows.reduce((s, p) => s + (marketPL(p) || 0), 0);
        marketCell = `<a class="np-market-price" href="${link}" target="_blank" title="itemdb · ${savedAgo(m)}">${formatNP(m.value)} NP${m.inflated ? ' ⚠️' : ''}</a>${rfBtn(rows[0].id, name)}`
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
        <td>${histBtn('g:' + k, name)}${PERSONAL_BUILD && held ? `<button class="np-btn-list np-btn-list-all" data-grp="${escHtml(k)}" title="Add all ${held} held to the list for the Auto-Lister">🏷 All</button><button class="np-btn-auc np-btn-list-all" data-grp="${escHtml(k)}" title="Add all ${held} held to the auction list for the Auto-Lister">🔨 All</button>` : ''}</td>
      </tr>`;
      return head + histRow('g:' + k, name, 7) + (open ? rows.map(p => rowHtml(p, 'np-grp-child', k)).join('') : '');
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
    document.getElementById('np-view-listings').classList.add('np-hidden');
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
          if (response.status >= 200 && response.status < 300) saveFetchedPrice(itemName, data);
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
    if (isLotSoldPopup(popup)) return;       // someone bought YOUR lot — handled by the sale logger
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
      /* ── 2.33.3: 📜 History on purchases and suggestions ── */
      .np-btn-hist {
        background: transparent !important; border: 1px solid #444444 !important; border-radius: 4px !important;
        cursor: pointer !important; font-size: 11px !important; padding: 1px 4px !important; margin-left: 3px; opacity: 0.75;
      }
      .np-btn-hist:hover, .np-btn-hist.on { opacity: 1; border-color: #e8a800 !important; }
      #np-panel-table tr.np-ph-tr td { background: #262626 !important; padding: 2px 8px 8px; }
      #np-panel-table tr.np-ph-tr .np-wh { margin-top: 0; }
      .np-sg-hist { margin: 2px 0 6px; padding-left: 4px; }

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
      .np-watch-act.on { border-color: #e8a800 !important; color: #e8a800 !important; }
      /* TP lots + 📜 History — same look as Quick Lookup */
      .np-wh { margin-top: 8px; padding-top: 2px; border-top: 1px solid #444444; max-height: 340px; overflow-y: auto;
               overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #e8a800 #2c2c2c; }
      .np-wh-h { font-size: 10px; font-weight: 700; color: #e8a800; text-transform: uppercase; letter-spacing: 0.5px; margin: 9px 0 2px; }
      .np-wh-list { display: flex; flex-direction: column; gap: 2px; margin: 3px 0; }
      .np-wh-row { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: #bbbbbb; }
      .np-wh-price { font-weight: 700; color: #dddddd; min-width: 74px; text-align: right; white-space: nowrap; }
      .np-wh-who { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #888888; }
      .np-wh-when { font-size: 10px; color: #777777; white-space: nowrap; }
      .np-wh-note { font-size: 10px; color: #999999; margin-top: 2px; line-height: 1.4; }
      .np-wh-none { font-size: 11px; color: #999999; font-style: italic; }
      .np-wh-err { font-size: 11px; color: #e98b80; }
      .np-wh-err a { color: #e8a800; }
      a.np-wh-seller { color: #cfcfcf; text-decoration: none; }
      .np-wh-masked { color: #777777; cursor: help; }
      a.np-wh-seller:hover { color: #ffd88a; text-decoration: underline; }
      a.np-wh-ico { font-size: 10px; margin-left: 3px; opacity: 0.7; text-decoration: none; }
      a.np-wh-ico:hover { opacity: 1; }
      a.np-wh-open { color: #ffaa00; font-weight: 700; text-decoration: none; }
      a.np-wh-open:hover { color: #ffd88a; }
      .np-wh-tag { font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px; white-space: nowrap; }
      .np-wh-tag.sold   { background: #2e4a5a; color: #9fd0ea; }
      .np-wh-tag.nobid  { background: #444444; color: #999999; }
      .np-wh-tag.nf     { background: #4a3a1a; color: #e8c070; }
      .np-wh-tag.bundle { background: #3f3552; color: #c8b4ec; cursor: help; }
      .np-wh-tag.ask    { background: #4a3a1a; color: #ffd88a; border: 1px dashed #b07800; cursor: help; }
      .np-wh-pct { font-size: 10px; font-weight: 700; padding: 1px 4px; border-radius: 3px; white-space: nowrap; }
      .np-wh-pct.under { background: #1f4d2e; color: #7ee2a0; }
      .np-wh-pct.over  { background: #5a2323; color: #f0a0a0; }
      .np-wh-pct.even  { background: #444444; color: #cccccc; }
      .np-wh-spark { display: block; width: 100%; height: 46px; margin-top: 4px; background: #262626; border-radius: 3px; }

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

      /* ── 2.18: 📌 pin, queue banner, sale reviews, Listings ── */
      .np-panel-header #np-panel-pin {
        background: transparent !important; border: 1px solid #b07800 !important; border-radius: 6px !important;
        color: #7a5600 !important; padding: 2px 7px !important; margin-right: 6px; cursor: pointer !important;
        font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important; white-space: nowrap;
        transition: color 0.2s, border-color 0.2s, background 0.2s;
      }
      .np-panel-header #np-panel-pin:hover { color: #fff8dd !important; border-color: #fff8dd !important; }
      .np-panel-header #np-panel-pin.np-pin-on { background: #7a5600 !important; border-color: #7a5600 !important; color: #fff8dd !important; }
      .np-inbox-banner {
        background: rgba(232,168,0,0.1); border: 1px solid #e8a800; color: #ffd88a;
        padding: 7px 10px; margin: 6px 0; border-radius: 6px; font-size: 11px;
      }
      .np-q-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
      .np-q-btn, .np-sale-row button, #np-listings-value {
        background: transparent !important; border: 1px solid #b07800 !important; border-radius: 5px !important;
        color: #ffd88a !important; font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important;
        padding: 3px 8px !important; cursor: pointer !important; transition: border-color 0.2s, color 0.2s;
      }
      .np-q-btn:hover, .np-sale-row button:hover, #np-listings-value:hover { border-color: #e8a800 !important; color: #fff8dd !important; }
      .np-q-btn.np-q-main { background: #e8a800 !important; border-color: #e8a800 !important; color: #2c2c2c !important; font-weight: bold !important; }
      .np-q-btn.np-q-danger { border-color: #e06060 !important; color: #e06060 !important; }
      #np-listings-value { flex: 1; padding: 7px 4px !important; }
      #np-listings-value:disabled { opacity: 0.5 !important; cursor: not-allowed !important; }
      #np-sale-review { margin: 6px 0; }
      .np-sale-head { font-size: 10px; color: #e8a800; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px; }
      .np-sale-card { background: #232323; border: 1px solid #5fc48a; border-radius: 6px; padding: 7px 9px; margin-bottom: 6px; font-size: 12px; }
      .np-sale-note { font-size: 10px; margin: 2px 0 5px; }
      .np-sale-row { display: flex; gap: 5px; align-items: center; }
      .np-sale-row input {
        flex: 1; min-width: 0; background: #2c2c2c !important; border: 1px solid #444444 !important;
        border-radius: 5px !important; color: #dddddd !important; font-size: 12px !important; padding: 4px 6px !important;
      }
      #np-view-listings { width: 100%; overflow-x: hidden; }
      #np-view-listings .np-pnl-cards { margin-bottom: 8px; }
      .np-panel-stats { flex-wrap: wrap; }
      .np-panel-stats .np-stat { min-width: calc(33.333% - 6px); }
      .np-btn-check-price.np-btn-rf {
        border: none !important; color: #999999 !important; background: transparent !important;
        padding: 0 0 0 4px !important; font-size: 11px !important;
      }
      .np-btn-check-price.np-btn-rf:hover { color: #e8a800 !important; background: transparent !important; }
      .np-stat-sub { font-size: 10px; color: #999999; margin-top: 2px; }
      .np-stat-goto { cursor: pointer; transition: border-color 0.2s, background 0.2s; }
      .np-stat-goto:hover { border-color: #e8a800 !important; background: #333333 !important; }
      #np-stat-tosell-card { cursor: help; }
      .np-chip-px { color: #ffd88a; margin-left: 5px; font-weight: bold; cursor: help; }
      .np-chip-px.none { color: #999999; font-weight: normal; }
      .np-chip-rf {
        background: transparent !important; border: none !important; color: #999999 !important;
        cursor: pointer !important; font-size: 10px !important; padding: 0 0 0 3px !important;
      }
      .np-chip-rf:hover { color: #e8a800 !important; }
      .np-chip-rf:disabled { opacity: 0.35; cursor: default !important; }

      @keyframes np-highlight-flash {
        0%   { background: rgba(232,168,0,0.35); }
        100% { background: transparent; }
      }
      .np-row-highlight td { animation: np-highlight-flash 2s ease-out forwards; }

      /* ── 2.20: 🏷 list for the Auto-Lister ── */
      .np-btn-list, .np-btn-auc {
        background: transparent !important; border: 1px solid #b07800 !important; color: #e8a800 !important;
        cursor: pointer !important; font-family: 'Ubuntu', Arial, sans-serif !important; font-size: 11px !important;
        padding: 1px 4px !important; border-radius: 4px !important; white-space: nowrap;
      }
      .np-btn-list:hover, .np-btn-auc:hover { background: #e8a800 !important; color: #2c2c2c !important; }
      .np-btn-auc { margin-left: 3px; }
      #np-list-drawer, #np-auc-drawer {
        background: #232323; border: 1px solid #e8a800; border-radius: 8px; padding: 9px 10px; margin-bottom: 10px; font-size: 12px;
      }
      .np-ld-head { font-size: 10px; color: #e8a800; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
      .np-ld-row { display: flex; gap: 5px; align-items: center; margin-bottom: 5px; }
      .np-ld-name { flex: 1; min-width: 0; color: #ffd88a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .np-ld-row input, .np-ld-opts input {
        background: #2c2c2c !important; border: 1px solid #444444 !important; border-radius: 5px !important;
        color: #dddddd !important; font-size: 12px !important; padding: 4px 6px !important; outline: none !important;
      }
      .np-ld-row input:focus, .np-ld-opts input:focus { border-color: #e8a800 !important; }
      .np-ld-qty { width: 52px; }
      .np-ld-price { width: 120px; }
      .np-ld-size { width: 52px; }
      .np-ld-rm { background: transparent !important; border: none !important; color: #999999 !important; cursor: pointer !important; }
      .np-ld-rm:hover { color: #e06060 !important; }
      .np-ld-opts { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0 4px; }
      .np-ld-opts label { color: #999999; font-size: 11px; display: flex; align-items: center; gap: 5px; }
      .np-ld-note { font-size: 10px; line-height: 1.4; margin: 3px 0 2px; }
      .np-ld-queue { border-top: 1px solid #444444; margin-top: 8px; padding-top: 7px; color: #dddddd; }
      #np-list-drawer > .np-ld-queue:first-child, #np-auc-drawer > .np-ld-queue:first-child { border-top: none; margin-top: 0; padding-top: 0; }
      #np-auc-drawer .np-ad-live { margin-top: 6px; }
      .np-lst-sub { display: flex; margin-bottom: 10px; }
      .np-au-bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; background: #232323; border: 1px solid #444444;
        border-radius: 8px; padding: 6px 8px; margin-bottom: 8px; font-size: 12px; }
      .np-au-bulk label { display: flex; align-items: center; gap: 4px; cursor: pointer; margin-right: 4px; }
      .np-au-bulk .np-watch-act[disabled] { opacity: .4; cursor: default; }
      .np-au-pick { margin: 0 6px 0 0; cursor: pointer; vertical-align: middle; }
      .np-lst-sub button { flex: 1; }
      #np-view-listings .np-offer-card, #np-view-listings .np-offer-card * { user-select: text; }
      a.np-lot-link { text-decoration: none; }
      a.np-lot-link:hover { text-decoration: underline; }
      .np-lst-items { width: 100%; border-collapse: collapse; margin: 2px 0 6px; font-size: 12px; }
      .np-lst-items th { text-align: left; font-weight: normal; color: #999999; font-size: 11px; padding: 2px 6px; border-bottom: 1px solid #444444; }
      .np-lst-items td { padding: 3px 6px; border-bottom: 1px solid #333333; vertical-align: top; color: #dddddd !important; }
      .np-lst-items th { color: #999999 !important; }
      .np-offer-card, .np-offer-card td, .np-offer-card .np-watch-line { color: #dddddd; }
      .np-lst-items td.np-lst-name { color: #ffd88a; }
      .np-lst-items td.np-lst-tr { white-space: nowrap; }
      .np-lst-items sup { color: #999999; font-size: 9px; }
      .np-lst-items .np-lst-hist { padding: 0 6px !important; }
      .np-lst-items .np-lst-hist.on { border-color: #e8a800 !important; }
      .np-lst-histrow td { background: #232323; }
      .np-au-sold {
        width: 110px; background: #2c2c2c !important; border: 1px solid #444444 !important; border-radius: 5px !important;
        color: #dddddd !important; font-size: 12px !important; padding: 3px 6px !important;
      }
      #np-auc-drawer .np-au-price { width: 110px; }
      #np-auc-drawer .np-au-pcts { margin: -1px 0 7px; }
      #np-auc-drawer .np-au-pcts .np-watch-act.on { border-color: #e8a800 !important; color: #e8a800 !important; }
      .np-ld-miss { font-size: 11px; margin-top: 3px; }
      /* ── 2.33: 💡 sell suggestions ── */
      .np-suggest { background: #232323; border: 1px solid #444444; border-radius: 8px; padding: 7px 10px; margin-bottom: 10px; font-size: 12px; color: #dddddd; }
      .np-suggest summary { cursor: pointer; color: #e8a800; font-size: 12px; font-weight: 500; }
      .np-suggest[open] summary { margin-bottom: 6px; }
      .np-sg-head { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; margin: 8px 0 4px; }
      .np-sg-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; border-bottom: 1px solid #333333; }
      .np-sg-name { flex: 1; min-width: 0; color: #ffd88a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .np-sg-num { white-space: nowrap; font-size: 11px; min-width: 48px; text-align: right; color: #dddddd; }
      .np-sg-btns { display: flex; gap: 3px; white-space: nowrap; }
      .np-sg-none { font-size: 11px; padding: 2px 0; }
      .np-sg-set { margin: 4px 0 2px; }
      .np-sg-set .np-view-toggle button { padding: 3px 7px !important; }
      .np-sg-sub { display: block; font-size: 10px; color: #999999; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; }
      .np-sg-ctl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 2px; font-size: 11px; }
    `;
    document.head.appendChild(s);
  }


  // ─── INSTANT BUY: LOG + STAY PUT ───────────────────────────────────────────
  // After an Instant Buy the TP shows a "Lot Purchased!" popup. Its Thanks!
  // button sends the Vue app to Your Lots (#/?type=view). We:
  //   1. read the popup (lot #, price, items) and queue it in np_tracker_inbox
  //   2. on Thanks!, remember the search hash and put it back after the jump
  //   3. the PBP button shows the queued count; the panel waits for your click
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
    processTrackerInbox();   // badge + open panel refresh only — never opens the panel
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
  // buy in the inbox (same format as Instant Buy); it waits there for your click.
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

  // Thanks! on the offer popup: make sure it's queued, then refresh the badge
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
  // Needs a TP lookup: itemdb had no price and TP hasn't been checked recently
  function needsTp(name, prices) {
    const e = prices[name.trim().toLowerCase()];
    return !!(e && (Date.now() - e.t) < OFFER_PRICE_TTL && !e.v && (!e.tpT || (Date.now() - e.tpT) >= TP_PRICE_TTL));
  }

  // ─── WISHLIST ASKING PRICE ("100m", "ab 1.5b", "90-100m") ─────────────────
  // Instant-buy tops out at 20m, so anything dearer is priced in the wishlist.
  // Returns { v, raw, ab } or null. Picks a number tagged ab/autobuy/insta/bin
  // first, then ignores ones tagged c/o (current offer), then takes the highest.
  // Bare numbers only count with commas or "np" and ≥ 100,000.
  const ASK_MULT = { k: 1e3, m: 1e6, mil: 1e6, mill: 1e6, million: 1e6, b: 1e9, bil: 1e9, bill: 1e9, billion: 1e9 };
  const ASK_RE = /(\d+(?:[.,]\d+)?)\s*(?:(?:-|–|to)\s*(\d+(?:[.,]\d+)?)\s*)?(million|billion|mill|bill|mil|bil|k|m|b)(?![a-z])|(\d{1,3}(?:,\d{3}){2,}|\d{6,})\s*(np)?/gi;
  const ASK_AB = /\b(?:ab|a\/b|auto\s*-?buy|autobuy|insta(?:nt)?(?:\s*buy)?|bin|buy\s*now|ib)\s*[:=@-]?\s*$/i;
  const ASK_CO = /\b(?:c\/o|co|current(?:ly)?\s*(?:offer|at)?|offer(?:ed)?|sb|starting\s*bid)\s*[:=@-]?\s*$/i;
  function parseAskPrice(text) {
    const s = String(text || '');
    if (!s) return null;
    const found = [];
    let m;
    ASK_RE.lastIndex = 0;
    while ((m = ASK_RE.exec(s))) {
      let v, raw = m[0].trim();
      if (m[3]) {
        const num = parseFloat(String(m[2] || m[1]).replace(',', '.'));
        v = num * ASK_MULT[m[3].toLowerCase()];
      } else {
        if (!/,/.test(m[4]) && !m[5]) continue;   // a bare long number with no comma or NP
        v = parseInt(m[4].replace(/,/g, ''), 10);
      }
      if (!Number.isFinite(v) || v < 100000) continue;
      const before = s.slice(Math.max(0, m.index - 20), m.index);
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 12);
      const coAfter = /^\s*(?:c\/o|co\b|current)/i.test(after);
      found.push({ v: Math.round(v), raw, ab: ASK_AB.test(before), co: ASK_CO.test(before) || coAfter });
    }
    if (!found.length) return null;
    const pool = found.filter(f => f.ab).length ? found.filter(f => f.ab)
      : found.filter(f => !f.co).length ? found.filter(f => !f.co) : found;
    const best = pool.reduce((a, b) => b.v > a.v ? b : a);
    return { v: best.v, raw: best.raw, ab: best.ab };
  }
  function shortNP(n) {
    if (n >= 1e9) return +(n / 1e9).toFixed(2) + 'b';
    if (n >= 1e6) return +(n / 1e6).toFixed(2) + 'm';
    if (n >= 1e3) return +(n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  // ─── TP FALLBACK (borrowed from Quick Lookup) ──────────────────────────────
  // Same-origin POST to Neopets' TP browse endpoint, one page per item.
  // Returns the cheapest instant-buy of a lot that is exactly one unit of the
  // item. The lot schema isn't pinned yet, so field names are candidate lists;
  // a lot whose contents can't be read is skipped rather than guessed (a
  // bundle's instant-buy must never pass as one item's price).
  const TP_LIST_URL = 'https://www.neopets.com/np-templates/ajax/island/tradingpost/tradingpost-list.php';
  let tpRawLogged = false;
  function pickKey(obj, keys) {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    return undefined;
  }
  function tpLotIsSingle(lot, itemName) {
    const items = pickKey(lot, ['items', 'lot_items', 'lotItems', 'item_list', 'itemList', 'objects']);
    if (Array.isArray(items) && items.length) {
      const target = itemName.trim().toLowerCase();
      let count = 0;
      for (const it of items) {
        count += Number(pickKey(it, ['quantity', 'qty', 'amount', 'count'])) || 1;
        const nm = String(pickKey(it, ['name', 'item_name', 'itemName', 'obj_name']) || '').trim().toLowerCase();
        if (!nm || nm !== target) return false;
      }
      return count === 1;
    }
    const n = Number(pickKey(lot, ['item_count', 'itemCount', 'num_items', 'numItems', 'total_items']));
    return n === 1;   // unknown contents → not single
  }
  async function tpMinPrice(name) {
    try {
      const res = await fetch(TP_LIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ type: 'browse', criteria: 'item_exact', search_string: name, sort: 'newest', page: 1 })
      });
      if (!res.ok) return { status: 'error' };
      const data = await res.json();
      if (!data || data.success !== true) return { status: 'error' };
      if (!tpRawLogged) { tpRawLogged = true; console.debug('[NP Tracker] TP fallback raw response (for pinning lot fields):', data); }
      const prices = (Array.isArray(data.lots) ? data.lots : [])
        .filter(l => Number(l.instant_buy_amount) > 0 && tpLotIsSingle(l, name))
        .map(l => Number(l.instant_buy_amount));
      return prices.length ? { status: 'ok', v: Math.min(...prices) } : { status: 'none' };
    } catch { return { status: 'error' }; }
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
            resolve(v ? { status: 'ok', v, inflated: !!d.price.inflated } : { status: 'none' });
          } catch { resolve({ status: 'error' }); }
        },
        onerror: () => resolve({ status: 'error' }),
        ontimeout: () => resolve({ status: 'error' })
      });
    });
  }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

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
    if (!todo.length && ![...names.keys()].some(k => needsTp(k, prices))) {
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
        await sleep(jitter(700, 1300));
      }
      // TP fallback for everything itemdb had no price for
      let tpPriced = 0, tpNone = 0, tpFailed = 0;
      if (!authLost) {
        const p0 = getOfferPrices();
        const tpTodo = [...names.entries()].filter(([k]) => needsTp(k, p0));
        let tpDone = 0;
        for (const [key, name] of tpTodo) {
          setBtn(`⏳ TP ${tpDone}/${tpTodo.length}…`);
          const res = await tpMinPrice(name);
          if (res.status === 'error') tpFailed++;     // not recorded → retried next press
          else {
            const p = getOfferPrices();
            if (p[key]) {
              p[key].tp = res.status === 'ok' ? res.v : null;
              p[key].tpT = Date.now();
              GM_setValue(OFFER_PRICE_KEY, JSON.stringify(p));
            }
            res.status === 'ok' ? tpPriced++ : tpNone++;
          }
          tpDone++;
          if (tpDone % 5 === 0 && !selBusy()) renderOffersView();
          await sleep(jitter(1200, 2200));
        }
      }
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
  //        ↻ and Check all also search the Trading Post (one page, same rules
  //        as Quick Lookup's 🏝️ Check TP): cheapest single-item instant-buy
  //        lots, % vs itemdb. A fresh TP low at/below target rings 🔔 too.
  //        Opening the tab never searches the TP — itemdb only.
  // 📜 History (items and lots): itemdb auctions, trades and price chart, the
  //        same panel as Quick Lookup. Loaded only when pressed, cached for the page.
  //
  // Checks only run when you open the tab (stale entries only, capped) or
  // press Check all / ↻. Spaced out with jitter. No background polling.
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
  const TP_FIND_MAX_PAGES = 5;
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

  // 🔔 when itemdb's price, or a TP low from the last few hours, is at/below target
  function belowTarget(it) {
    if (!it || !it.target) return false;
    if (it.price && it.price <= it.target) return true;
    const low = tpLow(it);
    return !!(low && low <= it.target && tpFresh(it));
  }

  function updateWatchBadges() {
    const hits = Object.values(getWatch().items).filter(belowTarget).length;
    const badge = document.getElementById('np-watch-badge');
    if (badge) badge.textContent = hits ? ` 🔔${hits}` : '';
    const btn = document.getElementById('np-tracker-btn');
    const queued = getInbox().length;
    if (btn) btn.textContent = '🍕 PBP Tracker' + (queued ? ` · 📥${queued}` : '') + (hits ? ` · 🔔${hits}` : '')
      + (listerChip ? ` · 🤖 ${listerChip}` : '');
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
        if (id === String(lotId)) {
          const a = parseAskPrice(pickKey(l, ['wishlist', 'wish_list', 'wishList']));
          return { status: 'listed', ib: Number(l.instant_buy_amount) || 0, ask: a ? a.v : null };
        }
        if (!seen.has(id)) { seen.add(id); fresh++; }
      }
      if (lots.length && !ids) return { status: 'unknown' };   // can't read lot ids
      if (!lots.length || !fresh) return { status: 'gone' };   // ran out / page param ignored
      if (tpPageHasMore(data, page) === false) return { status: 'gone' };
      await sleep(jitter(500, 1100));
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
    const askOf = t => { const a = itemsOf(t).length === 1 ? parseAskPrice(t.wishlist) : null; return a ? a.v : null; };
    if (exact) return { match: 'exact', price: priceOf(exact), ask: askOf(exact), at: exact.addedAt || null };
    const owner = wKey(lot.owner);
    if (!owner) return null;
    const seenT = Date.parse(lot.seen) || Date.now();
    const cands = recent.filter(t => wKey(t.owner) === owner && itemsOf(t).some(i => wKey(i.name) === target));
    if (!cands.length) return null;
    cands.sort((a, b) => Math.abs((Date.parse(a.addedAt) || 0) - seenT) - Math.abs((Date.parse(b.addedAt) || 0) - seenT));
    const t = cands[0];
    return { match: 'seller', price: priceOf(t), ask: askOf(t), at: t.addedAt || null };
  }

  // ─── WATCH: TRADING POST PRICES FOR AN ITEM ───────────────────────────────
  // Same rules as Quick Lookup's 🏝️ Check TP: one page, instant-buy lots only,
  // bundles left out (a bundle's price is never one item's price). Lots whose
  // contents can't be read count as single, flagged "bundle check unverified".
  const WATCH_TP_SHOW = 5;                 // cheapest lots kept per item
  const WATCH_TP_FRESH = 6 * 3600000;      // a TP low older than this doesn't ring 🔔
  function watchLotContents(lot, itemName) {
    const items = pickKey(lot, ['items', 'lot_items', 'lotItems', 'item_list', 'itemList', 'objects']);
    if (Array.isArray(items) && items.length) {
      const target = wKey(itemName);
      let count = 0, allMatch = true;
      for (const it of items) {
        count += Number(pickKey(it, ['quantity', 'qty', 'amount', 'count'])) || 1;
        const nm = wKey(pickKey(it, ['name', 'item_name', 'itemName', 'obj_name']));
        if (nm && nm !== target) allMatch = false;
      }
      return { known: true, single: count === 1 && allMatch };
    }
    const n = Number(pickKey(lot, ['item_count', 'itemCount', 'num_items', 'numItems', 'total_items']));
    if (Number.isFinite(n) && n > 0) return { known: true, single: n === 1 };
    return { known: false, single: true };
  }
  function tpLotLink(link, lotId) {
    const l = String(link || '');
    if (l.startsWith('//')) return 'https:' + l;
    if (l.startsWith('http')) return l;
    if (l) return 'https://www.neopets.com' + l.replace(/^\/+/, '/');
    return lotId ? `https://www.neopets.com/island/tradingpost.phtml#/?type=makeoffer&lot_id=${encodeURIComponent(lotId)}` : '';
  }
  async function tpItemLots(itemName) {
    let data;
    try {
      const res = await fetch(TP_LIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ type: 'browse', criteria: 'item_exact', search_string: itemName, sort: 'newest', page: 1 })
      });
      if (!res.ok) return { status: 'error' };
      data = await res.json();
    } catch { return { status: 'error' }; }
    if (!data || data.success !== true) return { status: 'error' };
    const lots = Array.isArray(data.lots) ? data.lots : [];
    const ib = lots.map(l => {
      const c = watchLotContents(l, itemName);
      const lotId = String(pickKey(l, ['lot_id', 'lotId', 'lot_number', 'id']) || '');
      const ibAmt = Number(l.instant_buy_amount) || 0;
      const a = ibAmt ? null : parseAskPrice(pickKey(l, ['wishlist', 'wish_list', 'wishList']));
      return {
        ib: ibAmt || (a ? a.v : 0), ask: !ibAmt && !!a, lotId,
        owner: String(pickKey(l, ['owner', 'username', 'user', 'seller', 'owner_name']) || ''),
        link: tpLotLink(l.link, lotId), single: c.single, known: c.known
      };
    }).filter(l => l.ib > 0).sort((a, b) => a.ib - b.ib);
    const singles = ib.filter(l => l.single);
    return {
      status: 'ok',
      total: lots.length,
      singleCount: singles.length,
      bundles: ib.length - singles.length,
      known: ib.every(l => l.known),
      more: tpPageHasMore(data, 1) === true,
      askCount: singles.filter(l => l.ask).length,
      lots: singles.slice(0, WATCH_TP_SHOW).map(({ ib, ask, lotId, owner, link }) => ({ ib, ask, lotId, owner, link }))
    };
  }
  function tpLow(it) {
    const l = it && it.tp && it.tp.lots && it.tp.lots.find(x => !x.ask);
    return l ? l.ib : null;
  }
  function tpFresh(it) { return !!(it && it.tp && Date.now() - Date.parse(it.tp.t) < WATCH_TP_FRESH); }

  // ─── WATCH: SHARED BITS (same look as Quick Lookup) ───────────────────────
  function wSellerLinks(owner) {
    if (!owner) return '';
    // itemdb hides some sellers as "*****": no real name, so nothing to link
    if (/^[*•]+$/.test(String(owner).trim())) return `<span class="np-wh-masked" title="itemdb hides this seller's name">${escHtml(owner)}</span>`;
    const u = encodeURIComponent(owner);
    const profile  = `https://www.neopets.com/userlookup.phtml?user=${u}`;
    const trades   = `https://www.neopets.com/island/tradingpost.phtml#/?type=browse&criteria=owner&search_string=${u}`;
    const auctions = `https://www.neopets.com/genie.phtml?type=find_user&auction_username=${u}`;
    return `<a class="np-wh-seller" href="${profile}" target="_blank" rel="noopener" title="${escHtml(owner)}'s profile">${escHtml(owner)}</a>`
         + `<a class="np-wh-ico" href="${trades}" target="_blank" rel="noopener" title="${escHtml(owner)}'s Trading Post lots">🏝️</a>`
         + `<a class="np-wh-ico" href="${auctions}" target="_blank" rel="noopener" title="${escHtml(owner)}'s auctions">🔨</a>`;
  }
  // "-18%" vs itemdb. Green = cheaper than itemdb.
  function wPct(price, idbPrice) {
    if (!idbPrice || !price) return '';
    const pct = Math.round((price - idbPrice) / idbPrice * 100);
    const cls = pct < 0 ? 'under' : pct > 0 ? 'over' : 'even';
    return `<span class="np-wh-pct ${cls}" title="vs itemdb ${formatNP(idbPrice)} NP">${pct > 0 ? '+' : ''}${pct}%</span>`;
  }

  // ─── WATCH: 📜 HISTORY PANEL (auctions · trades · price) ─────────────────
  // Ported from Quick Lookup. The auction and trade endpoints are metered per
  // record, so nothing loads until 📜 is pressed; results are kept for the page.
  const WATCH_HIST_ROWS = 10;
  const watchHistCache = new Map();   // item key → { done, auctions, trades, prices }
  const watchHistOpen = new Set();    // card ids ('i:key' / 'l:lotId') with History open

  function unwrapIdb(d) { return Array.isArray(d) ? (d[0] || null) : d; }

  async function loadWatchHist(name) {
    const key = wKey(name);
    const hit = watchHistCache.get(key);
    if (hit && !hit.retry) return hit.promise || hit;
    const enc = encodeURIComponent(name);
    const entry = { done: false };
    // Live TP lots: one same-origin TP search (same rules as Quick Lookup's tooltip)
    const tpLive = tpItemLots(name).catch(() => ({ status: 'error' }));
    entry.promise = Promise.all([
      idbJson(`${enc}/auction`), idbJson(`${enc}/trades`), idbJson(`${enc}/prices`), tpLive
    ]).then(([a, t, p, tp]) => {
      Object.assign(entry, { done: true, auctions: a, trades: t, prices: p, tp, tpT: new Date().toISOString() });
      delete entry.promise;
      // Failures are shown, then refetched next time 📜 is opened (e.g. after refreshing the itemdb session)
      if ([a, t, p, tp].some(r => r.status === 'auth' || r.status === 'error')) entry.retry = true;
      return entry;
    });
    watchHistCache.set(key, entry);
    return entry.promise;
  }

  function whErr(r) {
    if (r.status === 'auth') return `<div class="np-wh-err">itemdb session expired — <a href="https://itemdb.com.br" target="_blank" rel="noopener">open itemdb</a>, then try again.</div>`;
    return `<div class="np-wh-err">Couldn't load this from itemdb.</div>`;
  }
  function whSummary(bits) { return bits.length ? `<div class="np-wh-note">${escHtml(bits.join(' · '))}</div>` : ''; }

  function whAuctions(r, idbPrice) {
    let html = `<div class="np-wh-h">🔨 Auctions</div>`;
    if (r.status === 'auth' || r.status === 'error') return html + whErr(r);
    const d = (r.status === 'ok' && unwrapIdb(r.d)) || {};
    const recent = Array.isArray(d.recent) ? d.recent : [];
    const sum = [];
    if (d.total != null) sum.push(`${formatNP(d.total)} auctions`);
    if (d.sold != null) sum.push(`${formatNP(d.sold)} sold`);
    if (d.uniqueOwners != null) sum.push(`${formatNP(d.uniqueOwners)} sellers`);
    if (d.period) sum.push(String(d.period));
    html += whSummary(sum);
    if (!recent.length) return html + `<div class="np-wh-none">No recorded auctions</div>`;
    return html + `<div class="np-wh-list">` + recent.slice(0, WATCH_HIST_ROWS).map(a => {
      const price = Number(a.price) || 0;
      return `<div class="np-wh-row">
          <span class="np-wh-price">${price ? formatNP(price) + ' NP' : '—'}</span>
          ${a.hasBuyer ? wPct(price, idbPrice) : ''}
          ${a.hasBuyer ? '<span class="np-wh-tag sold">sold</span>' : '<span class="np-wh-tag nobid">no bid</span>'}${a.isNF ? '<span class="np-wh-tag nf">NF</span>' : ''}
          <span class="np-wh-who">${wSellerLinks(a.owner || '')}</span>
          <span class="np-wh-when">${escHtml(timeAgo(a.addedAt))}</span>
        </div>`;
    }).join('') + `</div>`;
  }

  function whTrades(r, itemName, idbPrice) {
    let html = `<div class="np-wh-h">🏝️ Trades</div>`;
    if (r.status === 'auth' || r.status === 'error') return html + whErr(r);
    const d = (r.status === 'ok' && unwrapIdb(r.d)) || {};
    const recent = Array.isArray(d.recent) ? d.recent : [];
    const sum = [];
    if (d.total != null) sum.push(`${formatNP(d.total)} trades`);
    if (d.priced != null) sum.push(`${formatNP(d.priced)} priced`);
    if (d.uniqueOwners != null) sum.push(`${formatNP(d.uniqueOwners)} sellers`);
    if (d.period) sum.push(String(d.period));
    html += whSummary(sum);
    if (!recent.length) return html + `<div class="np-wh-none">No recorded trades</div>`;
    const target = wKey(itemName);
    return html + `<div class="np-wh-list">` + recent.slice(0, WATCH_HIST_ROWS).map(t => {
      const items = Array.isArray(t.items) ? t.items : [];
      const mine = items.find(i => wKey(i.name) === target);
      const price = mine && t.priced ? Number(mine.price) || 0 : 0;
      const others = Math.max(0, items.length - 1);
      const ask = price ? null : parseAskPrice(t.wishlist);
      const extra = others ? `<span class="np-wh-tag bundle" title="${escHtml(items.filter(i => i !== mine).map(i => i.name).join(', '))}">+${others}</span>` : '';
      return `<div class="np-wh-row"${t.wishlist ? ` title="Wishlist: ${escHtml(t.wishlist)}"` : ''}>
          <span class="np-wh-price">${price ? formatNP(price) + ' NP' : ask ? formatNP(ask.v) + ' NP' : 'unpriced'}</span>
          ${ask ? `<span class="np-wh-tag ask" title="${others ? 'Whole lot' : 'Asking price'} from the wishlist: ${escHtml(t.wishlist)}">${others ? 'lot ask' : 'ask'}</span>` : ''}
          ${price ? wPct(price, idbPrice) : ask && !others ? wPct(ask.v, idbPrice) : ''}${extra}
          <span class="np-wh-who">${wSellerLinks(t.owner || '')}</span>
          <span class="np-wh-when">${escHtml(timeAgo(t.addedAt))}</span>
        </div>`;
    }).join('') + `</div>`;
  }

  function whPrices(r) {
    let html = `<div class="np-wh-h">📈 Price history</div>`;
    if (r.status === 'auth' || r.status === 'error') return html + whErr(r);
    const pts = (r.status === 'ok' && Array.isArray(r.d) ? r.d : [])
      .map(p => ({ v: Number(p.value) || 0, t: Date.parse(p.addedAt), inf: !!p.inflated }))
      .filter(p => p.v > 0 && Number.isFinite(p.t))
      .sort((a, b) => a.t - b.t);
    if (pts.length < 2) return html + `<div class="np-wh-none">Not enough price history</div>`;
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
    const old = [...pts].reverse().find(p => p.t <= latest.t - 30 * 86400000);
    let change = '';
    if (old) {
      const pct = Math.round((latest.v - old.v) / old.v * 100);
      change = ` <span class="np-wh-pct ${pct < 0 ? 'under' : pct > 0 ? 'over' : 'even'}">${pct > 0 ? '+' : ''}${pct}% / 30d</span>`;
    }
    return html + `
      <svg class="np-wh-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <polyline points="${line}" fill="none" stroke="#e8a800" stroke-width="1.5"/>${dots}
      </svg>
      <div class="np-wh-note">low ${formatNP(lo)} · high ${formatNP(hi)} · ${pts.length} points since ${escHtml(new Date(t0).toLocaleDateString())}${change}${pts.some(p => p.inf) ? ' · <span style="color:#e06060">●</span> inflated' : ''}</div>`;
  }

  // Panel body for one card: from cache if loaded, else a spinner line
  function watchHistHtml(name, idbPrice) {
    const h = watchHistCache.get(wKey(name));
    if (!h || !h.done) return `<div class="np-wh-none">⏳ Loading itemdb history…</div>`;
    return whTpLive(h.tp, h.tpT, idbPrice) + whAuctions(h.auctions, idbPrice) + whTrades(h.trades, name, idbPrice) + whPrices(h.prices);
  }
  // 🏝️ On the TP now: cheapest single-item instant-buy lots (bundles hidden), % vs itemdb
  function whTpLive(tp, at, idbPrice) {
    let html = `<div class="np-wh-h">🏝️ On the Trading Post now</div>`;
    if (!tp || tp.status === 'error') return html + `<div class="np-wh-err">Couldn't search the Trading Post.</div>`;
    const when = at ? ` · searched ${escHtml(timeAgo(at))}` : '';
    if (!tp.lots || !tp.lots.length) {
      const why = tp.bundles ? `only bundle lots (${tp.bundles})` : tp.total ? `${tp.total} lot${tp.total === 1 ? '' : 's'}, none priced` : 'no lots listed';
      return html + `<div class="np-wh-none">${why}${when}</div>`;
    }
    const notes = [];
    if (tp.bundles) notes.push(`${tp.bundles} bundle${tp.bundles === 1 ? '' : 's'} hidden`);
    if (tp.more) notes.push('first page only');
    if (!tp.known) notes.push('bundle check unverified');
    return html + `<div class="np-wh-list">` + tp.lots.map(l => `
        <div class="np-wh-row">
          <span class="np-wh-price">${formatNP(l.ib)} NP</span>
          ${l.ask ? '<span class="np-wh-tag ask" title="Asking price from the wishlist, not instant-buy">ask</span>' : ''}
          ${wPct(l.ib, idbPrice)}
          <span class="np-wh-who">${wSellerLinks(l.owner)}${l.lotId ? ` <span class="np-muted">#${escHtml(l.lotId)}</span>` : ''}</span>
          ${l.link ? `<a class="np-wh-open" href="${escHtml(l.link)}" target="_blank" rel="noopener" title="Open lot">↗</a>` : ''}
        </div>`).join('') + `</div>` + `<div class="np-wh-note">${escHtml([...notes, at ? 'searched ' + timeAgo(at) : ''].filter(Boolean).join(' · '))}</div>`;
  }
  function watchHistSlot(cardId, name, idbPrice) {
    if (!watchHistOpen.has(cardId)) return '';
    return `<div class="np-wh" data-hist="${escHtml(cardId)}">${watchHistHtml(name, idbPrice)}</div>`;
  }
  function toggleWatchHist(cardId, name) {
    if (watchHistOpen.has(cardId)) { watchHistOpen.delete(cardId); renderWatchView(); return; }
    watchHistOpen.add(cardId);
    renderWatchView();
    loadWatchHist(name).then(() => renderWatchView());
  }

  // TP block on an item card
  function watchTpBlock(it) {
    const tp = it.tp;
    if (!tp) return `<div class="np-muted np-watch-line">🏝️ TP not checked yet — press ↻</div>`;
    const when = `<span class="np-muted" title="Searched ${formatDateTime(tp.t)}">· ${timeAgo(tp.t)}</span>`;
    if (!tp.lots || !tp.lots.length) {
      const why = tp.bundles ? `only bundle lots with a price (${tp.bundles})`
        : tp.total ? `${tp.total} lot${tp.total === 1 ? '' : 's'} listed, none with instant-buy or a wishlist price`
        : 'no lots on the Trading Post';
      return `<div class="np-watch-line">🏝️ <span class="np-muted">${why}</span> ${when}</div>`;
    }
    const low = tpLow(it);
    const askLow = tp.lots[0].ask ? tp.lots[0].ib : null;
    const hit = it.target && low && low <= it.target && tpFresh(it);
    const rows = tp.lots.map(l => `
        <div class="np-wh-row">
          <span class="np-wh-price">${formatNP(l.ib)} NP</span>
          ${l.ask ? '<span class="np-wh-tag ask" title="Asking price from the wishlist, not instant-buy">ask</span>' : ''}
          ${wPct(l.ib, it.price)}
          <span class="np-wh-who">${wSellerLinks(l.owner)}${l.lotId ? ` <span class="np-muted">#${escHtml(l.lotId)}</span>` : ''}</span>
          ${l.link ? `<a class="np-wh-open" href="${escHtml(l.link)}" target="_blank" rel="noopener" title="Open lot">↗</a>` : ''}
        </div>`).join('');
    const ibN = tp.singleCount - (tp.askCount || 0);
    const notes = [`${ibN} single-item IB lot${ibN === 1 ? '' : 's'}`];
    if (tp.askCount) notes.push(`${tp.askCount} priced in wishlist`);
    if (tp.bundles) notes.push(`${tp.bundles} bundle${tp.bundles === 1 ? '' : 's'} hidden`);
    if (tp.more) notes.push('first page only');
    if (!tp.known) notes.push('bundle check unverified');
    return `
      <div class="np-watch-line">${low
        ? `🏝️ TP low <b class="${hit ? 'np-green' : ''}">${formatNP(low)} NP</b> ${wPct(low, it.price)}${hit ? ' 🔔' : ''}`
        : '🏝️ <span class="np-muted">no instant-buy</span>'}${askLow ? ` · asking from <b>${formatNP(askLow)}</b> ${wPct(askLow, it.price)}` : ''} ${when}</div>
      <div class="np-wh-list">${rows}</div>
      <div class="np-wh-note">${escHtml(notes.join(' · '))}</div>`;
  }

  async function checkWatchLot(lotId) {
    const lot = getWatch().lots[lotId];
    if (!lot) return 'skip';
    const now = new Date().toISOString();
    const upd = {};
    if (lot.status !== 'gone') {
      if (!lot.item) return 'skip';
      const r = await tpFindLot(lot.item, lot.lotId);
      if (r.status === 'error') return 'error';
      upd.checked = now;
      if (r.status === 'listed') { upd.status = 'listed'; upd.lastListed = now; upd.ibNow = r.ib || null; upd.askNow = r.ask || null; }
      else if (r.status === 'gone') { upd.status = 'gone'; upd.goneBy = now; }
      else upd.status = 'unknown';
    }
    let auth = false;
    if ((upd.status || lot.status) === 'gone' && !lot.closedPrice) {
      if (upd.status) await sleep(jitter(600, 1200));
      const t = await idbJson(`${encodeURIComponent(lot.item)}/trades`);
      if (t.status === 'auth') auth = true;
      else if (t.status === 'ok' || t.status === 'none') {
        upd.priceChecked = now;
        const m = t.status === 'ok' ? matchTrade(lot, Array.isArray(t.d) ? t.d[0] : t.d) : null;
        if (m) { upd.closedMatch = m.match; upd.closedPrice = m.price || null; upd.closedAsk = m.ask || null; upd.tradeAt = m.at; }
      }
    }
    const w = getWatch();
    if (!w.lots[lotId]) return 'skip';
    w.lots[lotId] = { ...w.lots[lotId], ...upd };
    saveWatch(w);
    return auth ? 'auth' : 'ok';
  }

  async function checkWatchItem(key, allowTp) {
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
      await sleep(jitter(500, 1000));
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
    let tpFailed = false;
    if (allowTp) {
      await sleep(jitter(900, 1600));
      const t = await tpItemLots(it.name);
      if (t.status === 'ok') { delete t.status; upd.tp = { ...t, t: upd.checked }; }
      else tpFailed = true;   // keep the last TP result
    }
    const w = getWatch();
    if (!w.items[key]) return 'skip';
    const was = belowTarget(w.items[key]);
    w.items[key] = { ...w.items[key], ...upd };
    saveWatch(w);
    const now = w.items[key];
    if (!was && belowTarget(now)) {
      const viaTp = !(now.price && now.price <= it.target);
      showToast(viaTp
        ? `🔔 ${it.name} is on the TP for ${formatNP(tpLow(now))} NP — at/below your ${formatNP(it.target)} target`
        : `🔔 ${it.name} is ${formatNP(now.price)} NP — at/below your ${formatNP(it.target)} target`);
    }
    return tpFailed ? 'tpfail' : 'ok';
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
          ? (!l.closedPrice && age(l.priceChecked) > WATCH_TRADE_RETRY)
          : age(l.checked) > WATCH_LOT_STALE).slice(0, WATCH_AUTO_MAX);
      } else {
        lots = lots.filter(l => l.status !== 'gone' || !l.closedPrice);
      }
      jobs = [...items.map(k => ({ kind: 'item', id: k })), ...lots.map(l => ({ kind: 'lot', id: l.lotId }))];
    }
    if (!jobs.length) { if (mode === 'all') showToast('👁 Nothing needs checking'); return; }

    watchBusy = true;
    renderWatchView();
    let done = 0, failed = 0, tpFailed = 0, auth = false;
    for (const j of jobs) {
      setWatchBtn(`⏳ ${done}/${jobs.length}…`, true);
      const r = j.kind === 'item' ? await checkWatchItem(j.id, mode !== 'auto') : await checkWatchLot(j.id);
      if (r === 'auth') { auth = true; break; }
      if (r === 'error') failed++;
      if (r === 'tpfail') tpFailed++;
      done++;
      if (done % 3 === 0) renderWatchView();
      if (done < jobs.length) await sleep(jitter(900, 1800));
    }
    watchBusy = false;
    renderWatchView();
    if (auth) showToast('⚠️ itemdb session expired — open itemdb.com.br, then check again');
    else if (failed || tpFailed) showToast(`👁 Checked ${done - failed}/${jobs.length}${failed ? ` · ${failed} failed` : ''}${tpFailed ? ` · ${tpFailed} TP search${tpFailed === 1 ? '' : 'es'} failed` : ''} (try again later)`);
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
        ${watchTpBlock(it)}
        <div class="np-watch-actions">
          <button class="np-watch-act" data-act="check-item" data-id="${escHtml(it.key)}"${watchBusy ? ' disabled' : ''} title="itemdb price + Trading Post search">↻ Check</button>
          <button class="np-watch-act" data-act="target" data-id="${escHtml(it.key)}">🎯 Target</button>
          <button class="np-watch-act${watchHistOpen.has('i:' + it.key) ? ' on' : ''}" data-act="hist" data-id="${escHtml('i:' + it.key)}" data-name="${escHtml(it.name)}" title="Auction, trade and price history from itemdb">📜 History</button>
          <a class="np-watch-act" href="${link}" target="_blank" rel="noopener">itemdb ↗</a>
          <button class="np-watch-act" data-act="remove-item" data-id="${escHtml(it.key)}">✕</button>
        </div>
        ${watchHistSlot('i:' + it.key, it.name, it.price)}
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
      if (!l.ibNow && l.askNow && l.askNow !== l.askPrice) {
        const d = l.askPrice ? l.askNow - l.askPrice : null;
        detail += `${detail ? ' · ' : ''}asking now <b>${formatNP(l.askNow)}</b>${d ? ` <span class="${d < 0 ? 'np-green' : 'np-red'}">(${d > 0 ? '+' : ''}${formatNP(d)})</span>` : ''}`;
      }
    } else if (l.status === 'gone') {
      pill = `<span class="np-watch-pill gone" title="Not found on the TP at ${formatDateTime(l.goneBy)}">Gone by ${formatDate(l.goneBy)}</span>`;
      if (l.closedPrice) {
        const d = l.ibPrice ? Math.round((l.closedPrice - l.ibPrice) / l.ibPrice * 100) : null;
        detail = `itemdb priced it <b>${formatNP(l.closedPrice)} NP</b>${d !== null ? ` <span class="np-muted">(${d > 0 ? '+' : ''}${d}% vs IB you saw)</span>` : ''}
          <span class="np-muted" title="${l.closedMatch === 'exact' ? 'itemdb record for this exact lot' : 'itemdb record from the same seller for this item, closest in time — may be a different lot'}">· ${l.closedMatch === 'exact' ? 'this lot' : 'matched by seller'}</span>`;
      } else if (l.closedMatch && l.closedAsk) {
        detail = `listed at <b>${formatNP(l.closedAsk)} NP</b> <span class="np-muted" title="From the lot's wishlist. itemdb hasn't priced it yet — will retry">(wishlist ask)</span>`;
      } else if (l.closedMatch) {
        detail = '<span class="np-muted">itemdb has the lot, not priced yet — will retry</span>';
      } else if (l.priceChecked) {
        detail = '<span class="np-muted">No itemdb record yet — will retry</span>';
      }
    } else {
      pill = '<span class="np-watch-pill unknown" title="Too many lots to page through, or lot ids unreadable">Unknown</span>';
    }
    const open = l.link || `https://www.neopets.com/island/tradingpost.phtml#/?type=makeoffer&lot_id=${encodeURIComponent(l.lotId)}`;
    const seenPx = l.ibPrice || l.askPrice || null;
    const vsIdb = seenPx && l.idbAtSeen ? Math.round((seenPx - l.idbAtSeen) / l.idbAtSeen * 100) : null;
    return `
      <div class="np-offer-card np-watch-card">
        <div class="np-offer-head">
          <span class="np-offer-lot">Lot ${escHtml(l.lotId)}</span>
          <span class="np-offer-seller">${escHtml(l.item || '?')} · ${escHtml(l.owner || '?')}</span>
          <span class="np-muted np-offer-age" title="Added ${formatDateTime(l.seen)}">${timeAgo(l.seen)}</span>
        </div>
        <div class="np-watch-line">${!l.ibPrice && l.askPrice ? 'Seen asking' : 'Seen at IB'} <b>${seenPx ? formatNP(seenPx) : '—'}</b>${!l.ibPrice && l.askPrice ? ' <span class="np-muted">(wishlist)</span>' : ''}${vsIdb !== null ? ` <span class="np-muted">(${vsIdb > 0 ? '+' : ''}${vsIdb}% vs itemdb ${formatNP(l.idbAtSeen)})</span>` : ''}${listedLine(l)}</div>
        <div class="np-watch-line">${pill} ${detail}</div>
        ${l.wishlist ? `<div class="np-muted np-watch-wish" title="${escHtml(l.wishlist)}">Wishlist: ${escHtml(l.wishlist)}</div>` : ''}
        <div class="np-watch-actions">
          <button class="np-watch-act" data-act="check-lot" data-id="${escHtml(l.lotId)}"${watchBusy ? ' disabled' : ''}>↻ Check</button>
          ${l.item ? `<button class="np-watch-act${watchHistOpen.has('l:' + l.lotId) ? ' on' : ''}" data-act="hist" data-id="${escHtml('l:' + l.lotId)}" data-name="${escHtml(l.item)}" title="Auction, trade and price history for ${escHtml(l.item)} from itemdb">📜 History</button>` : ''}
          <a class="np-watch-act" href="${escHtml(open)}" target="_blank" rel="noopener">Open ↗</a>
          <button class="np-watch-act" data-act="remove-lot" data-id="${escHtml(l.lotId)}">✕</button>
        </div>
        ${l.item ? watchHistSlot('l:' + l.lotId, l.item, l.idbAtSeen) : ''}
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
      <div class="np-muted np-watch-foot">Opening this tab refreshes stale item prices from itemdb (items 2h, lots 6h). ↻ and Check all also search the Trading Post for items. Closed-lot prices come from itemdb's trade pricing — a community estimate, not a confirmed sale price.</div>
    `;

    document.getElementById('np-watch-check').onclick = () => runWatchChecks('all');
    document.getElementById('np-watch-export').onclick = exportWatch;
    document.getElementById('np-watch-import').onclick = importWatch;
    view.onclick = (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const id = b.dataset.id;
      const act = b.dataset.act;
      if (act === 'hist') toggleWatchHist(id, b.dataset.name);
      else if (act === 'check-item') runWatchChecks({ kind: 'item', id });
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

  // ─── YOUR LOTS SOLD: "Instant Purchase" POPUP ──────────────────────────────
  // When someone instant-buys one of your lots, the TP shows an "Instant
  // Purchase" popup: "Lot N <buyer> purchased this lot! You have received X NP."
  // We mark the oldest matching unsold Tracker rows as sold (FIFO, item name
  // ignoring case). A lot with several items splits the NP by itemdb value,
  // then by Tracker cost, then evenly. Items with no Tracker row wait in the
  // queue for review. Read only: the Thanks! button is left alone.
  const LISTING_CACHE_KEY = 'np_listing_cache';
  const LISTING_SCAN_KEY = 'np_listing_scanned';   // last complete read of Your Trades
  const LISTING_KEEP_DAYS = 60;                     // sold / cancelled lots kept this long
  const LISTING_GAP_MS = 1000;                      // fixed gap between itemdb requests
  let listingValuing = false;

  // Saved itemdb prices for your listed items. Unlike the Offers price cache
  // these never expire: opening the Listings tab fetches only items with no
  // saved price yet; after that a price changes only with 🔄 Refresh all
  // prices or the item's own ↻.
  const LISTING_PRICE_KEY = 'np_listing_prices';
  let listingPriceBusy = null;   // item key being refreshed on its own
  function getListingPrices() {
    try { return JSON.parse(GM_getValue(LISTING_PRICE_KEY, '{}')) || {}; } catch { return {}; }
  }
  function setListingPrice(key, name, res) {
    const p = getListingPrices();
    p[key] = { name, v: res.status === 'ok' ? res.v : null, inflated: !!res.inflated,
               slug: res.slug || (p[key] && p[key].slug) || null, t: Date.now() };
    GM_setValue(LISTING_PRICE_KEY, JSON.stringify(p));
    renderValueStats();
  }
  function saveFetchedPrice(name, data) {
    const v = data && data.price && data.price.value;
    setListingPrice(wKey(name), String(name).trim(), v ? { status: 'ok', v, inflated: !!data.price.inflated, slug: data.slug || null } : { status: 'none' });
  }

  // ─── TOP STATS: LISTED + TO SELL ───────────────────────────────────────────
  // Listed   = what your active lots would bring in at their instant-buy (or
  //            wishlist asking price, for lots without one).
  // To sell  = every unsold Tracker item × its saved itemdb price. Prices come
  //            from the saved store (Listings tab, 🔄 Refresh Prices, ↗).
  // ─── 💡 SELL SUGGESTIONS (Purchases tab) ──────────────────────────────────
  // From unsold rows, grouped by item: avg paid vs the saved itemdb price.
  // Winners = biggest total gain if sold at itemdb now; losers = the lowest
  // (under water first). 🏷 / 🔨 put every held unit into that drawer.
  const SUGGEST_OPEN_KEY = 'np_suggest_open';
  const SUGGEST_MODE_KEY = 'np_suggest_mode';   // 'top' | 'random'
  const SUGGEST_PICK_KEY = 'np_suggest_pick';   // random mode's current picks
  // ⚙ settings: how many rows per side, and how deep 🎲 Shuffle reaches (0 = all)
  const SUGGEST_N_KEY = 'np_suggest_n';
  const SUGGEST_POOL_KEY = 'np_suggest_pool';
  const SUGGEST_N_OPTS = [5, 10, 15, 20];
  const SUGGEST_POOL_OPTS = [20, 50, 0];
  function sgN() { const n = parseInt(GM_getValue(SUGGEST_N_KEY, 10), 10); return SUGGEST_N_OPTS.includes(n) ? n : 10; }
  function sgPool() { const n = parseInt(GM_getValue(SUGGEST_POOL_KEY, 0), 10); return SUGGEST_POOL_OPTS.includes(n) ? n : 0; }
  let sgSettingsOpen = false;
  function suggestionData() {
    const saved = getListingPrices();
    const groups = new Map();
    for (const p of getPurchases()) {
      if (isSoldRow(p)) continue;
      const k = groupKey(p.item);
      const g = groups.get(k) || { name: String(p.item).trim(), qty: 0, cost: 0, rows: [] };
      g.qty += Number(p.qty) || 1; g.cost += (Number(p.price) || 0) * (Number(p.qty) || 1); g.rows.push(p);
      groups.set(k, g);
    }
    const priced = [], unpriced = [];
    for (const [k, g] of groups) {
      const e = saved[wKey(g.name)];
      const v = (e && e.v) || (marketPrices[g.name] && marketPrices[g.name].value) || 0;
      if (!v) { unpriced.push(g); continue; }
      const avg = g.qty ? g.cost / g.qty : 0;
      priced.push({ ...g, key: k, v, avg, each: v - avg, total: (v - avg) * g.qty, pct: avg ? Math.round((v - avg) / avg * 100) : null });
    }
    priced.sort((a, b) => b.total - a.total);
    if (GM_getValue(SUGGEST_MODE_KEY, 'top') !== 'random') {
      const N = sgN();
      const top = priced.filter(x => x.total > 0).slice(0, N);
      const low = priced.filter(x => !top.includes(x)).slice(-N).reverse();
      return { top, low, unpriced: unpriced.length, held: groups.size };
    }
    // 🎲 Random: 5 from the top 50 winners, 5 from the bottom 50 of the rest.
    // Under 100 priced items the list is split in the middle instead, so the
    // two pools never share an item. Picks are kept until 🎲 is pressed
    // again; sold-out ones are topped up.
    // Pool All = top half vs bottom half; 20 / 50 = that many from each end
    const N = sgN(), pool = sgPool();
    const half = pool ? Math.min(pool, Math.ceil(priced.length / 2)) : Math.ceil(priced.length / 2);
    const topPool = priced.slice(0, half).filter(x => x.total > 0);
    const rest = priced.filter(x => !topPool.includes(x));
    const lowPool = pool ? rest.slice(-pool) : rest;
    let picks;
    try { picks = JSON.parse(GM_getValue(SUGGEST_PICK_KEY, '') || 'null') || {}; } catch { picks = {}; }
    const choose = (pool, kept) => {
      const out = pool.filter(x => (kept || []).includes(x.key));
      const rest = pool.filter(x => !out.includes(x));
      while (out.length < N && rest.length) out.push(rest.splice(Math.floor(Math.random() * rest.length), 1)[0]);
      return out.slice(0, N);
    };
    const top = choose(topPool, picks.top).sort((a, b) => b.total - a.total);
    const low = choose(lowPool, picks.low).sort((a, b) => a.total - b.total);
    const next = JSON.stringify({ top: top.map(x => x.key), low: low.map(x => x.key) });
    if (next !== JSON.stringify({ top: picks.top || [], low: picks.low || [] })) GM_setValue(SUGGEST_PICK_KEY, next);
    return { top, low, unpriced: unpriced.length, held: groups.size };
  }
  function renderSuggestions() {
    const box = document.getElementById('np-suggest');
    if (!box) return;
    const { top, low, unpriced, held } = suggestionData();
    if (!held) { box.classList.add('np-hidden'); return; }
    box.classList.remove('np-hidden');
    const listIds = new Set(PERSONAL_BUILD ? getListDraft().items.flatMap(e => e.ids || []) : []);
    const aucIds = new Set(PERSONAL_BUILD ? getAucDraft().items.flatMap(e => e.ids || []) : []);
    const row = x => {
      const inList = x.rows.every(p => listIds.has(p.id)), inAuc = x.rows.every(p => aucIds.has(p.id));
      const cls = x.total >= 0 ? 'np-green' : 'np-red';
      // Several held: total worth at itemdb, total paid, total gain / loss
      const worth = Math.round(x.v * x.qty), tot = Math.round(x.total);
      const multi = x.qty > 1 ? `<span class="np-sg-sub" title="${x.qty} × itemdb ${formatNP(x.v)} = ${formatNP(worth)} NP · paid ${formatNP(Math.round(x.cost))} NP in total">worth ${shortNP(worth)} · paid ${shortNP(Math.round(x.cost))} · <b class="${cls}">${tot >= 0 ? '+' : '−'}${shortNP(Math.abs(tot))} total</b></span>` : '';
      return `<div class="np-sg-row">
          <span class="np-sg-name" title="${escHtml(x.name)} · ${x.qty} held · avg paid ${formatNP(Math.round(x.avg))} · itemdb ${formatNP(x.v)}">${escHtml(x.name)}${x.qty > 1 ? ` <span class="np-muted">×${x.qty}</span>` : ''}${multi}</span>
          <span class="np-sg-num" title="Per item: itemdb ${formatNP(x.v)} − paid ${formatNP(Math.round(x.avg))}">${x.each >= 0 ? '+' : '−'}${shortNP(Math.abs(Math.round(x.each)))} ea</span>
          <span class="np-sg-num ${cls}">${x.pct !== null ? `${x.pct >= 0 ? '+' : ''}${x.pct}%` : '—'}</span>
          ${PERSONAL_BUILD ? `<span class="np-sg-btns">${inList ? '<span class="np-muted" title="Already in the 🏷 list">🏷✓</span>' : `<button class="np-btn-list" data-sg="list" data-grp="${escHtml(x.key)}" title="Add all ${x.qty} to the 🏷 list at the itemdb price">🏷</button>`}${inAuc ? '<span class="np-muted" title="Already in the 🔨 auction list">🔨✓</span>' : `<button class="np-btn-auc" data-sg="auc" data-grp="${escHtml(x.key)}" title="Add all ${x.qty} to the 🔨 auction list">🔨</button>`}</span>` : ''}
          ${histBtn('s:' + x.key, x.name)}
        </div>${purchHistOpen.has('s:' + x.key) ? `<div class="np-wh np-sg-hist">${watchHistHtml(x.name, x.v)}</div>` : ''}`;
    };
    const open = !!GM_getValue(SUGGEST_OPEN_KEY, true);
    const rnd = GM_getValue(SUGGEST_MODE_KEY, 'top') === 'random';
    const N = sgN(), pool = sgPool();
    const html = `<summary>💡 Sell suggestions <span class="np-muted">· vs saved itemdb price</span></summary>
      <div class="np-sg-ctl">
        <div class="np-view-toggle">
          <button type="button" data-sgm="top" class="${rnd ? '' : 'np-view-on'}" title="Strict list: the ${N} biggest gains and the ${N} lowest">Top ${N}</button>
          <button type="button" data-sgm="random" class="${rnd ? 'np-view-on' : ''}" title="${N} at random from ${pool ? `the top ${pool} and the bottom ${pool}` : 'the top half and the bottom half'}, still sorted">🎲 Shuffle</button>
        </div>
        <button type="button" class="np-btn-hist${sgSettingsOpen ? ' on' : ''}" data-sgset="1" title="How many to show, and how far 🎲 Shuffle reaches">⚙</button>
        ${rnd ? `<span class="np-muted">${N} each, random from ${pool ? `top / bottom ${pool}` : 'all items'} · 🎲 again for new picks</span>` : ''}
      </div>
      ${sgSettingsOpen ? `<div class="np-sg-ctl np-sg-set">
        <span class="np-muted">Show</span><div class="np-view-toggle">${SUGGEST_N_OPTS.map(v =>
          `<button type="button" data-sgn="${v}" class="${v === N ? 'np-view-on' : ''}">${v}</button>`).join('')}</div>
        <span class="np-muted">Shuffle pool</span><div class="np-view-toggle">${SUGGEST_POOL_OPTS.map(v =>
          `<button type="button" data-sgp="${v}" class="${v === pool ? 'np-view-on' : ''}" title="${v ? `Top ${v} and bottom ${v}` : 'Every priced item, split in the middle'}">${v || 'All'}</button>`).join('')}</div>
      </div>` : ''}
      <div class="np-sg-head np-green">📈 ${rnd ? 'Gains' : 'Biggest gains now'}</div>
      ${top.length ? top.map(row).join('') : '<div class="np-muted np-sg-none">Nothing in profit at itemdb prices.</div>'}
      <div class="np-sg-head np-red">📉 ${rnd ? 'Low end' : 'Lowest'} — hold or cut loose</div>
      ${low.length ? low.map(row).join('') : '<div class="np-muted np-sg-none">—</div>'}
      ${unpriced ? `<div class="np-muted np-sg-none">${unpriced} item${unpriced === 1 ? ' has' : 's have'} no saved price — 🔄 Refresh Prices to include ${unpriced === 1 ? 'it' : 'them'}.</div>` : ''}`;
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
    box.open = open;
    if (!box.dataset.bound) {
      box.dataset.bound = '1';
      box.addEventListener('toggle', () => GM_setValue(SUGGEST_OPEN_KEY, box.open));
      box.addEventListener('click', (e) => {
        const st = e.target.closest('button[data-sgset], button[data-sgn], button[data-sgp]');
        if (st) {
          e.preventDefault();
          if (st.dataset.sgset) sgSettingsOpen = !sgSettingsOpen;
          else {
            if (st.dataset.sgn) GM_setValue(SUGGEST_N_KEY, parseInt(st.dataset.sgn, 10));
            else GM_setValue(SUGGEST_POOL_KEY, parseInt(st.dataset.sgp, 10));
            GM_setValue(SUGGEST_PICK_KEY, '');   // new size or pool → fresh picks
          }
          renderSuggestions();
          return;
        }
        const m = e.target.closest('button[data-sgm]');
        if (m) {
          e.preventDefault();
          // 🎲 while already random = new picks
          if (m.dataset.sgm === 'random') GM_setValue(SUGGEST_PICK_KEY, '');
          GM_setValue(SUGGEST_MODE_KEY, m.dataset.sgm);
          renderSuggestions();
          return;
        }
        const hb = e.target.closest('.np-btn-hist');
        if (hb) { e.preventDefault(); togglePurchHist(hb.dataset.ph, hb.dataset.name, renderSuggestions); return; }
        const b = e.target.closest('button[data-sg]');
        if (!b) return;
        e.preventDefault();
        const rows = getPurchases().filter(p => !isSoldRow(p) && groupKey(p.item) === b.dataset.grp);
        if (!rows.length) return;
        if (b.dataset.sg === 'auc') { addToAucDraft(rows); renderSuggestions(); return; }
        addToListDraft(rows);
        // Pre-fill the instant-buy at the itemdb price when it's still blank
        const sd = suggestionData();
        const v = (sd.top.concat(sd.low).find(x => x.key === b.dataset.grp) || {}).v;
        const d = getListDraft();
        const it = d.items.find(x => groupKey(x.name) === b.dataset.grp);
        if (it && !it.price && v) { it.price = String(v); saveListDraft(d); renderListDrawer(); }
        renderSuggestions();
      });
    }
  }

  function renderValueStats() {
    renderSuggestions();
    const listedEl = document.getElementById('np-stat-listed');
    if (!listedEl) return;
    const put = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const tip = (id, t) => { const el = document.getElementById(id); if (el) el.title = t; };

    let listed = 0, lots = 0, noPx = 0;
    for (const l of Object.values(getListingCache())) {
      if (l.gone || l.sold || l.cancelled) continue;
      lots++;
      const a = l.ib ? null : parseAskPrice(l.wishlist);
      const px = l.ib || (a ? a.v : 0);
      if (px) listed += px; else noPx++;
    }
    put('np-stat-listed', lots ? shortNP(listed) + ' NP' : '—');
    put('np-stat-listed-sub', lots ? `${lots} lot${lots === 1 ? '' : 's'}${noPx ? ` · ${noPx} no price` : ''}` : 'no lots synced');
    tip('np-stat-listed-card', lots
      ? `${formatNP(listed)} NP if every active lot sells at its instant-buy (or wishlist asking price).${noPx ? ` ${noPx} lot${noPx === 1 ? ' has' : 's have'} no price and ${noPx === 1 ? 'isn\'t' : 'aren\'t'} counted.` : ''} Click to open Listings.`
      : 'Open Your Trades on the Trading Post once to load your lots. Click to open Listings.');

    const saved = getListingPrices();
    let value = 0, units = 0;
    const unpriced = new Set();
    for (const p of getPurchases()) {
      if (isSoldRow(p)) continue;
      const q = Number(p.qty) || 1;
      units += q;
      const e = saved[wKey(p.item)];
      const v = (e && e.v) || (marketPrices[p.item] && marketPrices[p.item].value) || 0;
      if (v) value += v * q; else unpriced.add(wKey(p.item));
    }
    put('np-stat-tosell', units ? shortNP(value) + ' NP' : '—');
    put('np-stat-tosell-sub', units ? `${units} item${units === 1 ? '' : 's'}${unpriced.size ? ` · ${unpriced.size} unpriced` : ''}` : 'nothing unsold');
    tip('np-stat-tosell-card', units
      ? `${formatNP(value)} NP: all ${units} unsold Tracker items at their saved itemdb price.${unpriced.size ? ` ${unpriced.size} item type${unpriced.size === 1 ? ' has' : 's have'} no saved price — press 🔄 Refresh Prices to fill them in.` : ''}`
      : 'No unsold items in your Tracker.');
  }

  // Items in lots that are still up or gone-but-unresolved
  function listingItemNames() {
    const names = new Map();
    for (const l of Object.values(getListingCache())) {
      if (l.sold || l.cancelled) continue;
      for (const it of (l.items || [])) names.set(wKey(it.name), it.name);
    }
    return names;
  }

  function getListingCache() {
    try { return JSON.parse(GM_getValue(LISTING_CACHE_KEY, '{}')) || {}; } catch { return {}; }
  }
  function saveListingCache(obj) { GM_setValue(LISTING_CACHE_KEY, JSON.stringify(obj)); renderValueStats(); }

  function isLotSoldPopup(popup) {
    const text = (popup.textContent || '').replace(/\s+/g, ' ');
    return /purchased this lot!/i.test(text) && /You have received/i.test(text);
  }

  function parseLotSold(popup) {
    const text = (popup.textContent || '').replace(/\s+/g, ' ');
    const m = text.match(/Lot\s*#?\s*(\d+)\s*(\S+?)\s+purchased this lot!\s*You have received\s+([\d,]+)\s*NP/i);
    if (!m) return null;
    const items = [];
    const cards = new Set();
    for (const img of popup.querySelectorAll('img')) {
      if (!/\/items\//i.test(img.getAttribute('src') || '')) continue;
      const card = img.closest('div.flex.flex-col');
      if (!card || cards.has(card)) continue;
      cards.add(card);
      const nameEl = [...card.querySelectorAll('p')].pop();
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (!name) continue;
      const countEl = card.querySelector('.item-count-big');
      const qty = countEl ? (parseInt(countEl.textContent.replace(/\D/g, ''), 10) || 1) : 1;
      items.push({ name, qty });
    }
    return { lot: m[1], buyer: m[2], total: parseInt(m[3].replace(/,/g, ''), 10) || 0, items };
  }

  let soldRetryTimer = null;
  const soldInflight = {};
  function detectLotSold(force = false) {
    const popup = document.querySelector('.tp-popup-confirm');
    if (!popup || !isLotSoldPopup(popup)) return;
    const p = parseLotSold(popup);
    if (!p) return;
    const key = 'sold:' + p.lot;
    if (soldInflight[key] || loggedLots().includes(key)) return;
    const cached = getListingCache()[p.lot];
    if (cached && cached.sold) { markLotLogged(key); return; }   // already recorded (e.g. by the Sold button)
    if (!p.items.length && !force) {
      // Item tiles may render a moment after the text — give them a beat
      clearTimeout(soldRetryTimer);
      soldRetryTimer = setTimeout(() => detectLotSold(true), 800);
      return;
    }
    clearTimeout(soldRetryTimer);
    markLotLogged(key);
    soldInflight[key] = recordLotSale({ lot: p.lot, buyer: p.buyer, total: p.total, items: p.items })
      .catch(e => console.warn('[NP Tracker] Could not record lot sale:', e))
      .finally(() => { delete soldInflight[key]; });
  }

  // Same item listed twice → one entry with the quantities added up
  function mergeItems(list) {
    const m = new Map();
    for (const it of (list || [])) {
      const k = wKey(it.name);
      if (!k) continue;
      const cur = m.get(k);
      if (cur) cur.qty += it.qty || 1;
      else m.set(k, { name: String(it.name).trim(), qty: it.qty || 1 });
    }
    return [...m.values()];
  }

  // Weight per item for splitting a bundle's NP: itemdb value × qty, else the
  // Tracker cost, else the average of the others (all unknown → even split).
  async function weighItems(items) {
    const purchases = getPurchases();
    const out = [];
    for (const it of items) {
      const savedPx = getListingPrices()[wKey(it.name)];
      let px = savedPx ? savedPx.v : offerPriceFor(it.name, getOfferPrices());
      if (px === undefined) {
        const res = await itemdbLookup(it.name);
        if (res.status === 'ok' || res.status === 'none') {
          const p = getOfferPrices();
          p[wKey(it.name)] = { v: res.status === 'ok' ? res.v : null, t: Date.now() };
          GM_setValue(OFFER_PRICE_KEY, JSON.stringify(p));
          px = res.status === 'ok' ? res.v : null;
        } else px = null;
        await sleep(LISTING_GAP_MS);
      }
      if (px) { out.push({ unit: px, how: 'itemdb' }); continue; }
      const tc = trackerCostOf(it.name, it.qty, purchases);
      if (tc.got && tc.cost) { out.push({ unit: tc.cost / tc.got, how: 'Tracker cost' }); continue; }
      out.push(null);
    }
    const known = out.filter(Boolean);
    const avg = known.length ? known.reduce((s, x) => s + x.unit, 0) / known.length : 1;
    return items.map((it, i) => out[i]
      ? { v: out[i].unit * it.qty, how: out[i].how }
      : { v: avg * it.qty, how: 'even' });
  }

  function splitTotal(total, weights) {
    const W = weights.reduce((s, x) => s + x.v, 0) || 1;
    let left = total;
    return weights.map((x, i) => {
      if (i === weights.length - 1) return left;
      const share = Math.round(total * x.v / W);
      left -= share;
      return share;
    });
  }

  // Mark `qty` units of `name` sold, oldest unsold rows first. Partial rows
  // split like the Sell modal. Mutates `purchases`; returns { sold, left }.
  function sellFifo(purchases, name, qty, unitPrice, when, note) {
    const key = wKey(name);
    const held = purchases
      .filter(p => !isSoldRow(p) && wKey(p.item) === key)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let need = qty, sold = 0;
    for (const row of held) {
      if (!need) break;
      const take = Math.min(need, row.qty || 1);
      const idx = purchases.findIndex(p => p.id === row.id);
      const notes = [row.notes, note].filter(Boolean).join(' · ');
      if (take >= (row.qty || 1)) {
        purchases[idx] = { ...row, soldPrice: unitPrice, soldQty: take, soldDate: when, notes };
      } else {
        purchases[idx] = { ...row, qty: row.qty - take };
        purchases.push({ id: Date.now() + Math.floor(Math.random() * 100000), item: row.item, price: row.price, qty: take,
                         soldQty: take, soldPrice: unitPrice, soldDate: when, date: row.date, notes });
      }
      sold += take; need -= take;
    }
    return { sold, left: need };
  }

  function queueSale(s) {
    const inbox = getInbox();
    inbox.push({ kind: 'sale', qid: String(Date.now()) + Math.floor(Math.random() * 1000), ...s });
    saveInbox(inbox);
    processTrackerInbox();
  }

  function markListingSold(lot, buyer, np, when) {
    const c = getListingCache();
    c[lot] = { items: [], seen: when, ...(c[lot] || {}), sold: when, soldTo: buyer || '', soldNp: np };
    saveListingCache(c);
  }

  function refreshOpenPanel() {
    if (!document.getElementById('np-panel-tbody')) return;
    renderPanelTable(getPurchases());
    updatePanelStats();
    const v = document.getElementById('np-view-listings');
    if (v && !v.classList.contains('np-hidden')) renderListingsView();
  }

  // Record one sold lot. Items: the cached listing when it's complete (stack
  // sizes from the popup), else the popup's tiles, else whatever the cache has.
  async function recordLotSale({ lot, buyer, total, items: popupItems }) {
    const listing = getListingCache()[lot];
    const fromPopup = mergeItems(popupItems);
    let items;
    if (listing && listing.items && listing.items.length && !listing.truncated) {
      items = mergeItems(listing.items);
      for (const it of items) {
        const p = fromPopup.find(x => wKey(x.name) === wKey(it.name));
        if (p) it.qty = Math.max(it.qty, p.qty);
      }
    } else if (fromPopup.length) {
      items = fromPopup;
    } else {
      items = mergeItems(listing && listing.items);
    }
    const when = new Date().toISOString();
    const note = `sold TP lot #${lot}${buyer ? ` to ${buyer}` : ''}`;

    if (!items.length) {
      queueSale({ item: `TP lot #${lot} (items not read)`, qty: 1, np: total, lot, buyer, date: when, notes: note });
      markListingSold(lot, buyer, total, when);
      refreshOpenPanel();
      showToast(`🏷 Lot #${lot} sold for ${formatNP(total)} NP — items not read, queued for review`);
      return;
    }

    const weights = items.length > 1 ? await weighItems(items) : [{ v: 1, how: 'only' }];
    const shares = splitTotal(total, weights);
    const purchases = getPurchases();   // read after any itemdb lookups
    const bundleNote = items.length > 1 ? ` (bundle, ${formatNP(total)} NP total, split by value)` : '';
    let marked = 0;
    const review = [];
    items.forEach((it, i) => {
      const unit = Math.round(shares[i] / it.qty);
      const r = sellFifo(purchases, it.name, it.qty, unit, when, note + bundleNote);
      marked += r.sold;
      if (r.left) review.push({ item: it.name, qty: r.left, np: unit * r.left });
    });
    if (marked) savePurchases(purchases);
    for (const r of review) queueSale({ ...r, lot, buyer, date: when, notes: note + bundleNote });
    markListingSold(lot, buyer, total, when);
    refreshOpenPanel();
    showToast(`🏷 Lot #${lot} sold${buyer ? ` to ${buyer}` : ''} · ${formatNP(total)} NP · ${marked} marked sold${review.length ? ` · ${review.length} to review` : ''}`);
  }

  // ─── YOUR TRADES PAGE → LISTINGS CACHE ─────────────────────────────────────
  // The default TP view ("Your Trades", also #/?type=view) lists your active
  // lots. We read them into np_listing_cache. A lot only counts as gone when
  // the number of cards read matches "Your Active Lots: N", so a half-loaded
  // page never looks like everything sold. DOM only, no extra requests.
  function postedToIso(txt) {
    const s = String(txt || '');
    if (/just now/i.test(s)) return new Date().toISOString();
    const m = s.match(/(\d+|an?)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
    if (!m) return null;
    const n = /^an?$/i.test(m[1]) ? 1 : parseInt(m[1], 10);
    const unit = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6, year: 31536e6 }[m[2].toLowerCase()];
    return new Date(Date.now() - n * unit).toISOString();
  }
  function onYourTrades() {
    return [...document.querySelectorAll('button.selected-tab-btn')].some(b => b.textContent.trim() === 'Your Trades');
  }
  function activeLotCounter() {
    for (const p of document.querySelectorAll('p')) {
      const m = (p.textContent || '').match(/Your Active Lots:\s*(\d+)\s*\/\s*\d+/i);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  function readListingCard(card) {
    const ps = [...card.querySelectorAll('p')];
    const lotP = ps.find(p => p.classList.contains('text-cafeteria') && /^Lot\s+\d+$/.test(p.textContent.trim()));
    if (!lotP) return null;
    const items = [...card.querySelectorAll('p.item-name-text')].map(n => {
      const r = n.nextElementSibling;
      return { name: n.textContent.trim(), rarity: r && r.tagName === 'P' ? r.textContent.trim() : '' };
    }).filter(i => i.name);
    const postedP = ps.find(p => /^Posted\b/i.test(p.textContent.trim()));
    const wishEl = card.querySelector('p.wishlist-text');
    let ib = 0;
    const ibLabel = ps.find(p => p.textContent.trim() === 'Instant Buy');
    if (ibLabel && ibLabel.parentElement) {
      const amt = ibLabel.parentElement.querySelector('p.text-museo-bold');
      ib = amt ? (parseInt(amt.textContent.replace(/\D/g, ''), 10) || 0) : 0;
    }
    const link = card.querySelector('a[href*="search_string="]');
    return {
      lot: lotP.textContent.replace(/\D/g, ''),
      items,
      truncated: ps.some(p => /^and more\.*$/i.test(p.textContent.trim())),
      ib,
      wishlist: wishEl ? wishEl.textContent.trim() : '',
      postedTxt: postedP ? postedP.textContent.trim() : '',
      link: link ? link.href : ''
    };
  }

  let listingScanTimer = null;
  function scanYourTrades(confirmZero = false) {
    const h = location.hash;
    if (!onYourTrades() && !(!h || h === '#' || h === '#/' || /type=view/.test(h))) return;
    clearTimeout(listingScanTimer);
    listingScanTimer = setTimeout(() => {
      const count = activeLotCounter();
      if (count === null) return;   // not the Your Trades view, or not rendered yet
      const cards = [...document.querySelectorAll('div.tp-border-frame')].map(readListingCard).filter(Boolean);
      const cache = getListingCache();
      const before = JSON.stringify(cache);
      const now = new Date().toISOString();
      const onPage = new Set();
      for (const c of cards) {
        onPage.add(c.lot);
        const prev = cache[c.lot] || {};
        const { gone, cancelled, ...rest } = prev;   // back on the page → live again
        const keepOld = c.truncated && prev.items && prev.items.length > c.items.length;
        cache[c.lot] = {
          ...rest,
          items: keepOld ? prev.items : c.items.map(i => ({ name: i.name, qty: 1, rarity: i.rarity })),
          truncated: keepOld ? !!prev.truncated : c.truncated,
          ib: c.ib,
          wishlist: c.wishlist,
          posted: prev.posted || postedToIso(c.postedTxt) || now,
          link: c.link || prev.link || '',
          seen: prev.seen || now
        };
      }
      let complete = onPage.size === count;
      if (complete && count === 0 && !confirmZero) {
        // "0 active" can show for a moment before the lots load — look again
        setTimeout(() => scanYourTrades(true), 2000);
        complete = false;
      }
      if (complete) {
        for (const [k, v] of Object.entries(cache)) {
          if (!onPage.has(k) && !v.gone && !v.sold && !v.cancelled) {
            if (relistDeleted().has(k)) { v.cancelled = now; v.relisted = true; }   // the Lister deleted it to relist
            else v.gone = now;
          }
        }
        GM_setValue(LISTING_SCAN_KEY, now);
      }
      const cutoff = Date.now() - LISTING_KEEP_DAYS * 864e5;
      for (const [k, v] of Object.entries(cache)) {
        const end = v.sold || v.cancelled;
        if (end && Date.parse(end) < cutoff) delete cache[k];
      }
      const changed = JSON.stringify(cache) !== before;
      if (changed) saveListingCache(cache);
      const view = document.getElementById('np-view-listings');
      if ((changed || complete) && view && !view.classList.contains('np-hidden')) renderListingsView();
    }, 400);
  }

  // ─── 🏷 LISTINGS TAB ───────────────────────────────────────────────────────
  // Reads np_listing_cache. Item prices come from np_listing_prices (saved,
  // no expiry): shown on every item, refreshed all at once or one by one.
  const LISTINGS_SUB_KEY = 'np_listings_sub';
  let listingsDefer = null;
  let listingsLastHtml = '';
  // Mouse held down anywhere in the panel → background redraws wait (see above)
  let panelPointerDown = false;
  document.addEventListener('mousedown', (e) => { if (e.target.closest && e.target.closest('#np-tracker-panel')) panelPointerDown = true; }, true);
  document.addEventListener('mouseup', () => { setTimeout(() => { panelPointerDown = false; }, 50); }, true);
  function renderListingsView() {
    const view = document.getElementById('np-view-listings');
    if (!view) return;
    // Typing in a price box (Lister or a card), or a mouse button held down
    // (a redraw between press and release eats the click): redraw just after
    const ae = document.activeElement;
    if (panelPointerDown || (ae && view.contains(ae) && /^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName))) {
      clearTimeout(listingsDefer);
      listingsDefer = setTimeout(renderListingsView, 1500);
      return;
    }
    const cache = getListingCache();
    const purchases = getPurchases();
    const prices = getListingPrices();
    const all = Object.entries(cache).map(([lot, l]) => ({ lot, ...l }));
    const byNewest = (k) => (a, b) => String(b[k] || b.seen).localeCompare(String(a[k] || a.seen));
    const active = all.filter(l => !l.gone && !l.sold && !l.cancelled).sort(byNewest('posted'));
    const gone = all.filter(l => l.gone && !l.sold && !l.cancelled).sort(byNewest('gone'));
    const closed = all.filter(l => l.sold || l.cancelled)
      .sort((a, b) => String(b.sold || b.cancelled).localeCompare(String(a.sold || a.cancelled)));
    const scanned = GM_getValue(LISTING_SCAN_KEY, '');

    // Tracker cost per lot, oldest held rows first, carried across lots so a
    // unit you hold once is never counted in two lots
    const used = {};
    const costLot = (l) => {
      let cost = 0, got = 0, n = 0;
      for (const it of (l.items || [])) {
        const k = wKey(it.name), q = it.qty || 1, u = used[k] || 0;
        const a = trackerCostOf(it.name, u + q, purchases), b = trackerCostOf(it.name, u, purchases);
        used[k] = u + q;
        it._paid = { cost: a.cost - b.cost, got: a.got - b.got };
        cost += a.cost - b.cost; got += a.got - b.got; n += q;
      }
      return { cost, got, n };
    };
    const valueLot = (l) => {
      let v = 0, known = 0, missing = 0;
      for (const it of (l.items || [])) {
        const e = prices[wKey(it.name)];
        const px = e && e.v;
        if (px) { v += px * (it.qty || 1); known++; } else missing++;
      }
      return { v, known, missing };
    };
    for (const l of [...active, ...gone]) { l.c = costLot(l); l.m = valueLot(l); }
    // Your price: instant-buy, else the asking price in your wishlist ("100m")
    for (const l of all) {
      const a = l.ib ? null : parseAskPrice(l.wishlist);
      l.px = l.ib || (a ? a.v : 0);
      l.isAsk = !l.ib && !!a;
    }

    const npListed = active.reduce((s, l) => s + (l.px || 0), 0);
    const askLots = active.filter(l => l.isAsk).length;
    const costListed = active.reduce((s, l) => s + l.c.cost, 0);
    const withIb = active.filter(l => l.px);
    const profit = withIb.reduce((s, l) => s + (l.px - l.c.cost), 0);
    const untrackedLots = withIb.filter(l => l.c.got < l.c.n).length;
    const valued = active.filter(l => l.m.known);
    const mkt = valued.reduce((s, l) => s + l.m.v, 0);
    const ibVsMkt = valued.filter(l => l.px).reduce((s, l) => s + (l.px - l.m.v), 0);

    const lockPx = listingValuing || !!listingPriceBusy;
    const chipPx = (it) => {
      const k = wKey(it.name), e = prices[k];
      if (listingPriceBusy === k) return '<span class="np-chip-px none">⏳</span>';
      const when = e ? timeAgo(new Date(e.t).toISOString()) : '';
      const label = !e ? '?' : e.v ? shortNP(e.v) + (e.inflated ? ' ⚠️' : '') : '—';
      const tip = !e ? 'No itemdb price saved yet'
        : e.v ? `itemdb ${formatNP(e.v)} NP each${e.inflated ? ' (flagged inflated)' : ''} · saved ${when}`
        : `itemdb has no price · checked ${when}`;
      return `<span class="np-chip-px${e && e.v ? '' : ' none'}" title="${escHtml(tip)}">${label}</span>`
        + `<button type="button" class="np-chip-rf" data-lact="price" data-name="${escHtml(it.name)}" title="Refresh this item's itemdb price"${lockPx ? ' disabled' : ''}>↻</button>`;
    };
    const chips = (l) => (l.items || []).map(it =>
      `<span class="np-offer-item"${it.rarity ? ` title="${escHtml(it.rarity)}"` : ''}>${(it.qty || 1) > 1 ? it.qty + '× ' : ''}${escHtml(it.name)}${chipPx(it)}</span>`).join('')
      + (l.truncated ? '<span class="np-offer-item np-muted" title="Your Trades shows 4 items per lot">+more</span>' : '');
    const lotLink = (l) => l.link || `https://www.neopets.com/island/tradingpost.phtml#/?type=makeoffer&lot_id=${encodeURIComponent(l.lot)}`;
    const sign = (n) => (n >= 0 ? '+' : '') + formatNP(n);
    const pxNames = listingItemNames();
    const savedTs = [...pxNames.keys()].map(k => prices[k] && prices[k].t).filter(Boolean);
    const oldestPx = savedTs.length ? Math.min(...savedTs) : null;
    const priceLine = pxNames.size
      ? `itemdb prices saved for ${savedTs.length}/${pxNames.size} items${oldestPx ? ` · oldest ${timeAgo(new Date(oldestPx).toISOString())}` : ''} · ↻ on an item refreshes just that one`
      : '';

    const wide = isWide();
    // Closed lots: their cost wasn't worked out above
    for (const l of all) if (!l.c) { l.c = { cost: 0, got: 0, n: 0 }; }
    const card = (l, mode) => {
      const when = mode === 'gone' ? 'gone ' + timeAgo(l.gone)
        : mode === 'closed' ? (l.sold ? 'sold ' + timeAgo(l.sold) : 'cancelled ' + timeAgo(l.cancelled))
        : 'posted ' + timeAgo(l.posted || l.seen);
      let money;
      if (mode === 'closed') {
        money = l.sold
          ? `<div class="np-offer-value">Sold${l.soldTo ? ` to ${escHtml(l.soldTo)}` : ''} for <b>${formatNP(l.soldNp || 0)} NP</b></div>`
          : '<div class="np-offer-value np-muted">Cancelled</div>';
      } else {
        const c = l.c, m = l.m;
        const pl = l.px && c.got ? l.px - c.cost : null;
        money = `<div class="np-offer-value">Cost ${c.got ? formatNP(c.cost) : '?'}`
          + (c.got < c.n ? ` <span class="np-muted" title="Not in your Tracker, or more units than you hold">(${c.n - c.got} untracked)</span>` : '')
          + (pl !== null ? ` · at ${l.isAsk ? 'ask' : 'IB'} <span class="${pl >= 0 ? 'np-green' : 'np-red'}">${sign(pl)}</span>` : '')
          + (m.known ? ` · itemdb ≈ ${formatNP(m.v)}${m.missing ? ` <span class="np-muted">(${m.missing} unpriced)</span>` : ''}` : '')
          + '</div>';
      }
      const actions = mode === 'gone'
        ? `<div class="np-watch-actions">
             <button class="np-watch-act" data-lact="sold" data-lot="${escHtml(l.lot)}" title="Record the sale: oldest matching Tracker rows are marked sold">✅ Sold</button>
             <button class="np-watch-act" data-lact="cancelled" data-lot="${escHtml(l.lot)}" title="You took it down — just archive it">↩ Cancelled</button>
             ${PERSONAL_BUILD && unsoldLot(l) ? `<button class="np-watch-act" data-lact="draft" data-lot="${escHtml(l.lot)}" title="Add these items to the 🏷 list at the old price">🏷 Relist</button>` : ''}
           </div>` + (PERSONAL_BUILD ? relistControls(l, true) : '')
        : mode === 'closed'
        ? `<div class="np-watch-actions">${PERSONAL_BUILD && unsoldLot(l) ? `<button class="np-watch-act" data-lact="draft" data-lot="${escHtml(l.lot)}" title="Add these items to the 🏷 list at the old price">🏷 Relist</button>` : ''}${PERSONAL_BUILD && !l.sold && l.drafted ? '<span class="np-muted" style="font-size:11px">🏷 in the list</span>' : ''}<button class="np-watch-act" data-lact="forget" data-lot="${escHtml(l.lot)}" title="Remove from this list (Tracker rows stay as they are)">✕ Forget</button></div>`
          + (PERSONAL_BUILD && !l.sold ? relistControls(l, true) : '')
        : `<a class="np-offer-link" href="${escHtml(lotLink(l))}" target="_blank" rel="noopener">📍 Open on TP ↗</a>`
          + (PERSONAL_BUILD ? relistControls(l) : '');
      return `
        <div class="np-offer-card${mode === 'closed' ? ' np-offer-gone' : ''}">
          <div class="np-offer-head">
            <a class="np-offer-lot np-lot-link" href="${escHtml(lotLink(l))}" target="_blank" rel="noopener" title="Open lot ${escHtml(l.lot)} on the Trading Post">Lot ${escHtml(l.lot)} ↗</a>
            <span class="np-offer-seller">${l.ib ? `IB ${formatNP(l.ib)} NP`
              : l.isAsk ? `Asking ${formatNP(l.px)} NP <span class="np-muted" title="Read from your wishlist text">(wishlist)</span>`
              : '<span class="np-muted">no instant-buy or wishlist price</span>'}</span>
            <span class="np-muted np-offer-age" title="Posted ≈ ${formatDateTime(l.posted || l.seen)}">${when}</span>
          </div>
          ${wide && (l.items || []).length
            ? itemTableHtml(mergeItems(l.items).map(it => {
                const parts = (l.items || []).filter(x => wKey(x.name) === wKey(it.name));
                return { name: it.name, qty: it.qty, rarity: parts[0] && parts[0].rarity,
                  paid: parts.reduce((t, x) => ({ cost: t.cost + ((x._paid || {}).cost || 0), got: t.got + ((x._paid || {}).got || 0) }), { cost: 0, got: 0 }) };
              }), prices) + (l.truncated ? '<div class="np-muted np-watch-line">+ more items (Your Trades shows 4 per lot)</div>' : '')
            : `<div class="np-offer-row">${chips(l) || '<span class="np-muted">—</span>'}</div>`}
          ${money}
          ${l.wishlist ? `<div class="np-muted np-watch-wish" title="${escHtml(l.wishlist)}">${escHtml(l.wishlist)}</div>` : ''}
          ${actions}
        </div>`;
    };

    const tradesHtml = `
      <div class="np-pnl-cards">
        <div class="np-pnl-card"><div class="np-pnl-card-label">Active trades</div><div class="np-pnl-card-val">${active.length}</div></div>
        <div class="np-pnl-card" title="Instant-buy, or the asking price in your wishlist when there's no instant-buy${askLots ? ` (${askLots} lot${askLots === 1 ? '' : 's'} priced by wishlist)` : ''}"><div class="np-pnl-card-label">NP listed</div><div class="np-pnl-card-val">${formatNP(npListed)}</div></div>
        <div class="np-pnl-card"><div class="np-pnl-card-label">Tracker cost</div><div class="np-pnl-card-val">${formatNP(costListed)}</div></div>
        ${withIb.length ? `<div class="np-pnl-card" title="Your price (IB, else wishlist ask) minus Tracker cost, priced lots only${untrackedLots ? ` · ${untrackedLots} lot(s) have untracked items, so this runs high` : ''}"><div class="np-pnl-card-label">Profit at price${untrackedLots ? ' *' : ''}</div><div class="np-pnl-card-val ${profit >= 0 ? 'np-green' : 'np-red'}">${sign(profit)}</div></div>` : ''}
        ${valued.length ? `
        <div class="np-pnl-card"><div class="np-pnl-card-label">itemdb ≈</div><div class="np-pnl-card-val">${formatNP(mkt)}</div></div>
        <div class="np-pnl-card" title="Your price (IB, else wishlist ask) minus itemdb value, valued lots with a price"><div class="np-pnl-card-label">Price vs itemdb</div><div class="np-pnl-card-val">${sign(ibVsMkt)}</div></div>` : ''}
      </div>
      <div class="np-offer-sync np-muted">
        ${scanned ? `Synced ${timeAgo(scanned)}` : 'Not synced yet'} ·
        <a class="np-offer-link-inline" href="https://www.neopets.com/island/tradingpost.phtml">open Your Trades</a> to refresh
      </div>
      <div class="np-panel-toolbar">
        <button id="np-listings-value"${lockPx ? ' disabled' : ''} title="Fetch a fresh itemdb price for every item in your listings">${listingValuing ? '⏳ Refreshing…' : '🔄 Refresh all prices'}</button>
      </div>
      ${priceLine ? `<div class="np-offer-sync np-muted">${priceLine}</div>` : ''}
      ${PERSONAL_BUILD && all.some(unsoldLot) ? `<div class="np-panel-toolbar"><button type="button" class="np-q-btn np-q-main" data-lact="draftall" title="Every cancelled lot, and every lot gone without a sale popup, into the 🏷 list at its old price">🏷 List all unsold (${all.filter(unsoldLot).length})</button></div>` : ''}
      <div class="np-pnl-section-title">🏝️ Active trades (${active.length})</div>
      ${active.length ? active.map(l => card(l, 'active')).join('')
        : `<div style="text-align:center;padding:30px;color:#999999;font-style:italic;">🏝️ No active lots cached.<br>Open Your Trades once to load them.</div>`}
      ${gone.length ? `
        <div class="np-pnl-section-title" style="margin-top:14px">No longer listed (${gone.length})</div>
        <div class="np-muted np-offer-gone-note">Gone from Your Trades without a sale popup. ✅ Sold records it (instant-buy or wishlist price, or the price you enter); ↩ Cancelled just archives it.</div>
        ${gone.map(l => card(l, 'gone')).join('')}` : ''}
      ${closed.length ? `
        <details class="np-offers-gone">
          <summary>Sold &amp; cancelled (${closed.length})</summary>
          <div class="np-muted np-offer-gone-note">Kept for ${LISTING_KEEP_DAYS} days.</div>
          ${closed.map(l => card(l, 'closed')).join('')}
        </details>` : ''}
    `;

    // Personal build: 🏝️ Trades | 🔨 Auctions sub-tabs, the Lister's status strip
    // on both, and its controls for that side under it
    const sub = PERSONAL_BUILD && GM_getValue(LISTINGS_SUB_KEY, 'trades') === 'auctions' ? 'auctions' : 'trades';
    if (PERSONAL_BUILD) {
      const reg = getAucReg().entries;
      const nRun = reg.filter(e => e.status === 'pending' || e.status === 'live').length;
      const nAttn = reg.filter(e => e.status === 'gone' || e.status === 'unsold').length;
      const html = `
        <div class="np-view-toggle np-lst-sub">
          <button type="button" data-sub="trades" class="${sub === 'trades' ? 'np-view-on' : ''}">🏝️ Trades (${active.length})${gone.length ? ` · ${gone.length} gone` : ''}</button>
          <button type="button" data-sub="auctions" class="${sub === 'auctions' ? 'np-view-on' : ''}">🔨 Auctions (${nRun})${nAttn ? ` · ${nAttn} to act on` : ''}</button>
        </div>
        <div id="np-lst-status"></div>
        <div id="np-lst-ctl"></div>
        ${sub === 'auctions' ? auctionsListingsHtml() : tradesHtml}`;
      // Same content as on screen → leave the DOM alone (buttons stay clickable)
      if (html === listingsLastHtml && view.querySelector('#np-lst-ctl')) { if (lister) lister.render(); }
      else {
        view.innerHTML = html;
        listingsLastHtml = html;
      }
      if (lister) lister.mount(sub === 'auctions'
        ? { status: document.getElementById('np-lst-status'), auc: document.getElementById('np-lst-ctl') }
        : { status: document.getElementById('np-lst-status'), trades: document.getElementById('np-lst-ctl') });
    } else if (tradesHtml !== listingsLastHtml) {
      view.innerHTML = tradesHtml;
      listingsLastHtml = tradesHtml;
    }

    view.onclick = (e) => {
      const hb = e.target.closest('.np-lst-hist');
      if (hb) { toggleListingHist(hb.dataset.hist); return; }
      const pick = e.target.closest('.np-au-pick, .np-au-pickall');
      if (pick) {
        const unsoldKeys = getAucReg().entries.filter(x => x.status === 'unsold').map(x => x.key);
        if (pick.classList.contains('np-au-pickall')) { if (pick.checked) aucUnpicked.clear(); else unsoldKeys.forEach(k => aucUnpicked.add(k)); }
        else if (pick.checked) aucUnpicked.delete(pick.dataset.key); else aucUnpicked.add(pick.dataset.key);
        renderListingsView();
        return;
      }
      const rs = e.target.closest('button[data-aact="relistsel"]');
      if (rs) {
        const keys = getAucReg().entries.filter(x => x.status === 'unsold' && !aucUnpicked.has(x.key)).map(x => x.key);
        if (keys.length) relistAuctions(keys, parseInt(rs.dataset.p, 10) || 0);
        return;
      }
      const sb = e.target.closest('[data-sub]');
      if (sb) { GM_setValue(LISTINGS_SUB_KEY, sb.dataset.sub); renderListingsView(); return; }
      const sl = e.target.closest('button[data-aact="logsale"]');
      if (sl) {
        const box = sl.closest('.np-offer-card') && sl.closest('.np-offer-card').querySelector('.np-au-sold');
        const n = parseNPInput(box ? box.value : '');
        if (!n) { showToast('Enter what it sold for: 5000, 5k or 2.5m'); return; }
        auctionAction('logsale', sl.dataset.key, n);
        return;
      }
      const ab = e.target.closest('button[data-aact]');
      if (ab) { auctionAction(ab.dataset.aact, ab.dataset.key, parseInt(ab.dataset.p, 10) || 0); return; }
      const b = e.target.closest('button[data-lact]');
      if (b && b.dataset.lact === 'price') { refreshListingPrice(b.dataset.name); return; }
      if (b && b.dataset.lact === 'relist') { relistLot(b.dataset.lot, parseInt(b.dataset.p, 10) || 0); return; }
      if (b && b.dataset.lact === 'draft') { lotsToDraft([b.dataset.lot]); return; }
      if (b && b.dataset.lact === 'draftall') {
        const c = getListingCache();
        const lots = Object.keys(c).filter(k => unsoldLot(c[k]));
        const gone = lots.filter(k => !c[k].cancelled).length;
        if (!lots.length) return;
        if (!confirm(`Add the items from ${lots.length} unsold lot${lots.length === 1 ? '' : 's'} to the 🏷 list, at their old prices?${gone ? `\n\n${gone} of them disappeared without a sale popup — if any of those actually sold, remove them from the list before sending.` : ''}`)) return;
        lotsToDraft(lots);
        return;
      }
      if (b) { listingAction(b.dataset.lact, b.dataset.lot); return; }
      if (e.target.closest('#np-listings-value')) { valueListings(true); return; }
    };
  }

  // ─── ↻ RELIST A LOT (personal build) ─────────────────────────────────────
  // Adds the lot to the Auto-Lister's TP queue as a relist group: the Lister
  // deletes the lot on Your Trades (bin → Delete Lot), then lists the same
  // items as one lot at the new price. A lot no longer on Your Trades (sold)
  // is skipped by the Lister and never relisted.
  const RELIST_DELETED_KEY = 'pbp_tpl_deleted';
  function relistDeleted() {
    try { return new Set((JSON.parse(localStorage.getItem(RELIST_DELETED_KEY) || '[]') || []).map(String)); } catch { return new Set(); }
  }
  // Round down: to 1,000 NP from 10,000 up, else to whole NP
  const relistPrice = (px, pct) => { const n = px * (1 - pct / 100); return n >= 10000 ? Math.floor(n / 1000) * 1000 : Math.floor(n); };
  function relistQueued(lot) {
    const q = getListerQueue();
    return !!(q && q.groups && q.groups['r' + lot] && q.items.some(i => i.group === 'r' + lot));
  }
  // past = the lot is already off the TP (cancelled, or gone): no delete step,
  // the items are taken from inventory / SDB / gallery like a normal queue
  function relistControls(l, past) {
    if (!l.px) return '';
    if (relistQueued(l.lot)) return '<div class="np-muted np-watch-line">↻ Relist queued — running from ▶ Run queue above</div>';
    if (l.truncated) return '<div class="np-muted np-watch-line" title="Your Trades only shows the first items of this lot">↻ Relist unavailable: not all items are known</div>';
    return `${l.relistedAt ? `<div class="np-muted np-watch-line">↻ Relisted ${timeAgo(l.relistedAt)}</div>` : ''}
      <div class="np-watch-actions np-rl"><span class="np-muted" style="font-size:11px">↻ Relist${past ? ' again' : ''}</span>
        ${[0, 5, 10, 15, 20].map(p => `<button class="np-watch-act" data-lact="relist" data-lot="${escHtml(l.lot)}" data-p="${p}" title="${past ? 'List the same items again' : 'Delete this lot and list the same items'} at ${formatNP(relistPrice(l.px, p))} NP">${p ? '−' + p : '0'}%</button>`).join('')}
      </div>`;
  }
  function relistLot(lot, pct) {
    const l = getListingCache()[lot];
    if (!l) return;
    const ask = l.ib ? null : parseAskPrice(l.wishlist);
    const px = l.ib || (ask ? ask.v : 0);
    if (!px) { showToast('This lot has no price to relist at'); return; }
    if (relistQueued(lot)) { showToast(`↻ Lot #${lot} is already queued`); return; }
    const items = mergeItems(l.items);
    if (!items.length || l.truncated) { showToast('↻ Not all of this lot\'s items are known — relist it by hand'); return; }
    if (l.sold) { showToast(`Lot #${lot} sold — nothing to relist`); return; }
    const past = !!(l.cancelled || l.gone);
    const price = relistPrice(px, pct);
    const how = price > 20000000 ? 'wishlist asking price (over 20m)' : 'instant-buy';
    const note = past
      ? `This lot is already off the Trading Post, so the items are taken from your inventory, SDB or gallery and listed as a new lot. ${l.gone && !l.cancelled ? 'It disappeared without a sale popup — only relist if it didn\'t sell. ' : ''}Anything not found is left out and the price scaled down.`
      : 'The Lister deletes the lot on the Trading Post, then lists the same items again. If it has sold by then, it\'s skipped.';
    if (!confirm(`Relist lot #${lot} at ${formatNP(price)} NP${pct ? ` (−${pct}%)` : ''} as ${how}?\n\n${items.map(i => `${i.qty > 1 ? i.qty + '× ' : ''}${i.name}`).join(', ')}\n\n${note}`)) return;
    const gid = 'r' + lot;
    const q = getListerQueue() || { v: 1, created: new Date().toISOString(), mode: 'single', lotSize: 30, items: [], done: [], missing: [] };
    q.groups = q.groups || {};
    q.groups[gid] = { lot: String(lot), price, from: px, pct, past };
    q.items.push(...items.map(i => ({ name: i.name, qty: i.qty, price: null, group: gid })));
    q.updated = new Date().toISOString();
    localStorage.setItem(LISTER_QUEUE_KEY, JSON.stringify(q));
    const cache = getListingCache();
    if (cache[lot]) { cache[lot].relistedAt = new Date().toISOString(); saveListingCache(cache); }
    renderListingsView();
    renderListDrawer();
    listerRefresh();
    if (lister && lister.startQueue()) showToast(`↻ Relisting lot #${lot} at ${formatNP(price)} NP…`);
    else showToast(`↻ Lot #${lot} queued at ${formatNP(price)} NP — the Lister is busy; it runs with ▶ Run queue after`);
  }

  // ─── 🏷 UNSOLD LOTS → LIST DRAWER (personal build) ────────────────────────
  // Cancelled lots (and ones gone without a sale popup) go back into the 🏷
  // drawer on Purchases, each item priced from the old lot: one item type →
  // lot price ÷ qty; a bundle → split by saved itemdb value, else evenly.
  // Unsold = cancelled, or gone without a sale popup, and not sent yet
  const unsoldLot = l => !!l && !l.sold && !l.drafted && !l.relistedAt && !l.truncated && (l.cancelled || l.gone) && (l.items || []).length;
  function lotItemPrices(l) {
    const items = mergeItems(l.items);
    const a = l.ib ? null : parseAskPrice(l.wishlist);
    const px = l.ib || (a ? a.v : 0);
    if (!px) return items.map(it => ({ ...it, price: '' }));
    if (items.length === 1) return [{ ...items[0], price: String(Math.max(1, Math.floor(px / items[0].qty))) }];
    const saved = getListingPrices();
    const known = items.map(it => { const e = saved[wKey(it.name)]; return e && e.v ? e.v : 0; });
    const avg = known.filter(Boolean).length ? known.filter(Boolean).reduce((x, y) => x + y, 0) / known.filter(Boolean).length : 1;
    const shares = splitTotal(px, items.map((it, i) => ({ v: (known[i] || avg) * it.qty })));
    return items.map((it, i) => ({ ...it, price: String(Math.max(1, Math.floor(shares[i] / it.qty))) }));
  }
  function lotsToDraft(lots) {
    const cache = getListingCache();
    const d = getListDraft();
    let units = 0, sent = 0;
    const now = new Date().toISOString();
    for (const lot of lots) {
      const l = cache[lot];
      if (!l || l.sold || l.truncated || !(l.items || []).length) continue;
      for (const it of lotItemPrices(l)) {
        let e = d.items.find(x => groupKey(x.name) === groupKey(it.name));
        if (!e) { e = { name: it.name, qty: 0, price: it.price, ids: [] }; d.items.push(e); }
        else if (!e.price) e.price = it.price;
        e.qty += it.qty;
        units += it.qty;
      }
      l.drafted = now;
      sent++;
    }
    if (!sent) { showToast('Nothing to add — no unsold lots with known items'); return; }
    saveListDraft(d);
    saveListingCache(cache);
    renderListDrawer();
    renderListingsView();
    showToast(`🏷 ${units} item${units === 1 ? '' : 's'} from ${sent} lot${sent === 1 ? '' : 's'} added to the list on 📦 Purchases — check prices, then 🚀 Send`);
  }

  function listingAction(act, lot) {
    const c = getListingCache();
    const l = c[lot];
    if (!l) return;
    const now = new Date().toISOString();
    if (act === 'cancelled') {
      l.cancelled = now;
      saveListingCache(c); renderListingsView();
      showToast(`↩ Lot #${lot} archived`);
    } else if (act === 'forget') {
      if (!confirm(`Remove lot #${lot} from this list? Your Tracker rows aren't changed.`)) return;
      delete c[lot];
      saveListingCache(c); renderListingsView();
    } else if (act === 'sold') {
      const warn = l.truncated ? '\n\nOnly the first items of this lot are known; the rest will not be matched.' : '';
      const wl = l.ib ? null : parseAskPrice(l.wishlist);
      const ask = prompt(`Lot #${lot} sold for how many NP?${wl ? `\n\nPre-filled from your wishlist (${wl.raw}). Change it if the accepted offer was different.` : ''}${warn}`,
        l.ib ? String(l.ib) : wl ? String(wl.v) : '');
      if (ask === null) return;
      const total = parseInt(String(ask).replace(/[^\d]/g, ''), 10) || 0;
      if (!total) { alert('Enter the NP you received.'); return; }
      markLotLogged('sold:' + lot);   // a late sale popup for this lot is then ignored
      recordLotSale({ lot, buyer: '', total, items: [] })
        .catch(e => console.warn('[NP Tracker] Could not record lot sale:', e))
        .finally(() => renderListingsView());
    }
  }

  // all = true: fresh price for every listed item (🔄 Refresh all prices).
  // all = false: only items with no saved price (runs when the tab opens).
  function valueListings(all) {
    if (listingValuing || listingPriceBusy) return;
    const saved = getListingPrices();
    const todo = [...listingItemNames().entries()].filter(([k]) => all || !saved[k]);
    if (!todo.length) { if (all) showToast('💰 No listed items to price'); return; }
    listingValuing = true;
    renderListingsView();
    (async () => {
      let priced = 0, none = 0, failed = 0, done = 0, auth = false;
      for (const [key, name] of todo) {
        const b = document.getElementById('np-listings-value');
        if (b) b.textContent = `⏳ ${done}/${todo.length} items…`;
        const res = await itemdbLookup(name);
        if (res.status === 'auth') { auth = true; break; }
        if (res.status === 'ok' || res.status === 'none') {
          setListingPrice(key, name, res);
          res.status === 'ok' ? priced++ : none++;
        } else failed++;                     // saved price (if any) kept → retried next time
        done++;
        if (done % 10 === 0) renderListingsView();
        if (done < todo.length) await sleep(LISTING_GAP_MS);
      }
      listingValuing = false;
      renderListingsView();
      if (auth) { showToast('⚠️ itemdb session expired — open itemdb.com.br, then refresh again'); return; }
      const bits = [`${priced} priced`];
      if (none) bits.push(`${none} no itemdb price`);
      if (failed) bits.push(`${failed} failed (refresh again to retry)`);
      showToast(`💰 ${all ? 'Prices refreshed' : 'New item prices saved'} · ${bits.join(' · ')}`);
    })();
  }

  // ↻ on one item chip: refresh just that item's saved price
  async function refreshListingPrice(name) {
    const key = wKey(name);
    if (!key || listingValuing || listingPriceBusy) return;
    listingPriceBusy = key;
    renderListingsView();
    let res = { status: 'error' };
    try { res = await itemdbLookup(name); } finally { listingPriceBusy = null; }
    if (res.status === 'ok' || res.status === 'none') setListingPrice(key, name, res);
    renderListingsView();
    showToast(res.status === 'ok' ? `💰 ${name}: ${formatNP(res.v)} NP`
      : res.status === 'none' ? `💰 ${name}: itemdb has no price`
      : res.status === 'auth' ? '⚠️ itemdb session expired — open itemdb.com.br, then try again'
      : `⚠️ Couldn't reach itemdb for ${name} — saved price kept`);
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

  // ─── LISTINGS: WIDE VIEW (panel stretched to ≥ 650px) ─────────────────────
  // Each lot / auction shows its items as rows: qty · what you paid (Tracker,
  // oldest held rows first) · itemdb · the last 3 trade prices from itemdb ·
  // 📜 for the full history (auctions, trades, price chart) under the row.
  // Trade prices load only in the wide view, 2 at a time, only the /trades
  // endpoint, and are kept 6 hours (GM np_trade_recent).
  const WIDE_AT = 650;
  const TRADE_RECENT_KEY = 'np_trade_recent';
  const TRADE_RECENT_TTL = 6 * 3600000;
  const lstHistOpen = new Set();     // item keys with 📜 open in Listings
  let tradeRecent = null;
  const tradeQueue = [];
  let tradeActive = 0;
  let wideRerender = null;

  function getTradeRecent() {
    if (!tradeRecent) { try { tradeRecent = JSON.parse(GM_getValue(TRADE_RECENT_KEY, '{}')) || {}; } catch { tradeRecent = {}; } }
    return tradeRecent;
  }
  function saveTradeRecent() {
    const c = getTradeRecent();
    const cut = Date.now() - 3 * 864e5;   // tidy: drop entries older than 3 days
    for (const k of Object.keys(c)) if (!(c[k].t > cut)) delete c[k];
    GM_setValue(TRADE_RECENT_KEY, JSON.stringify(c));
  }
  // Last 3 prices this item traded at (its own price in a priced lot, else a
  // single-item lot's wishlist ask)
  function tradePricesFrom(r, name) {
    if (r.status !== 'ok') return null;
    const d = unwrapIdb(r.d) || {};
    const target = wKey(name), out = [];
    for (const t of (Array.isArray(d.recent) ? d.recent : [])) {
      const items = Array.isArray(t.items) ? t.items : [];
      const mine = items.find(i => wKey(i.name) === target);
      let v = mine && t.priced ? Number(mine.price) || 0 : 0, ask = false;
      if (!v && items.length <= 1) { const a = parseAskPrice(t.wishlist); if (a) { v = a.v; ask = true; } }
      if (v) out.push({ v, ask, at: t.addedAt });
      if (out.length >= 3) break;
    }
    return { p: out, n: d.total != null ? Number(d.total) : null };
  }
  function wantTrades(name) {
    const k = wKey(name), c = getTradeRecent()[k];
    if (c && Date.now() - c.t < TRADE_RECENT_TTL) return c;
    if (!tradeQueue.includes(name) && !(c && c.busy)) tradeQueue.push(name);
    pumpTrades();
    return c || null;
  }
  function pumpTrades() {
    while (tradeActive < 2 && tradeQueue.length) {
      const name = tradeQueue.shift();
      const k = wKey(name);
      const c = getTradeRecent();
      c[k] = Object.assign(c[k] || {}, { busy: true });
      tradeActive++;
      idbJson(`${encodeURIComponent(name)}/trades`).then(r => {
        tradeActive--;
        const got = tradePricesFrom(r, name);
        const cc = getTradeRecent();
        if (got) cc[k] = { t: Date.now(), p: got.p, n: got.n };
        else cc[k] = { t: Date.now() - TRADE_RECENT_TTL + 10 * 60000, p: (cc[k] && cc[k].p) || [], err: r.status };   // retry in 10 min
        saveTradeRecent();
        clearTimeout(wideRerender);
        wideRerender = setTimeout(() => { if (listingsOpen()) renderListingsView(); }, 400);
        pumpTrades();
      });
    }
  }
  function tradeCell(name) {
    const c = wantTrades(name);
    if (!c || (c.busy && !c.p)) return '<span class="np-muted">⏳</span>';
    if (c.err === 'auth') return '<a class="np-muted" href="https://itemdb.com.br" target="_blank" rel="noopener" title="itemdb session expired — open itemdb, then reopen this tab">sign in ↗</a>';
    if (!c.p || !c.p.length) return '<span class="np-muted">none</span>';
    return c.p.map(x => `<span title="${x.ask ? 'Wishlist ask' : 'Priced trade'} · ${escHtml(timeAgo(x.at))}">${shortNP(x.v)}${x.ask ? '<sup>a</sup>' : ''}</span>`).join(' · ');
  }
  // rows: [{ name, qty, rarity, paid: { cost, got } }]
  function itemTableHtml(rows, prices) {
    return `<table class="np-lst-items"><thead><tr>
        <th>Item</th><th>Qty</th><th title="What you paid each (Tracker, oldest held rows first)">Paid ea</th><th>itemdb</th><th title="Last 3 trade prices on itemdb (a = wishlist ask)">Recent trades</th><th></th>
      </tr></thead><tbody>${rows.map(r => {
        const k = wKey(r.name), e = prices[k], q = r.qty || 1;
        const paid = r.paid && r.paid.got ? Math.round(r.paid.cost / r.paid.got) : 0;
        const open = lstHistOpen.has(k);
        return `<tr>
          <td class="np-lst-name"${r.rarity ? ` title="${escHtml(r.rarity)}"` : ''}>${escHtml(r.name)}</td>
          <td>${q}</td>
          <td>${paid ? formatNP(paid) + (r.paid.got < q ? ` <span class="np-muted" title="${q - r.paid.got} not in your Tracker">*</span>` : '') : '<span class="np-muted">—</span>'}</td>
          <td>${e && e.v ? shortNP(e.v) : '<span class="np-muted">?</span>'}</td>
          <td class="np-lst-tr">${tradeCell(r.name)}</td>
          <td><button type="button" class="np-watch-act np-lst-hist${open ? ' on' : ''}" data-hist="${escHtml(r.name)}" title="Full itemdb history: auctions, trades, price chart">📜</button></td>
        </tr>${open ? `<tr class="np-lst-histrow"><td colspan="6"><div class="np-wh">${watchHistHtml(r.name, e && e.v)}</div></td></tr>` : ''}`;
      }).join('')}</tbody></table>`;
  }
  function toggleListingHist(name) {
    const k = wKey(name);
    if (lstHistOpen.has(k)) lstHistOpen.delete(k);
    else { lstHistOpen.add(k); loadWatchHist(name).then(() => { if (listingsOpen()) renderListingsView(); }); }
    renderListingsView();
  }
  // Panel width → .np-wide; wide view turning on loads what it needs
  function watchPanelWidth(panel) {
    if (!window.ResizeObserver) return;
    new ResizeObserver(() => {
      const wide = panel.offsetWidth >= WIDE_AT;
      if (wide === panel.classList.contains('np-wide')) return;
      panel.classList.toggle('np-wide', wide);
      if (wide && listingsOpen()) renderListingsView();
    }).observe(panel);
  }
  const isWide = () => { const p = document.getElementById('np-tracker-panel'); return !!(p && p.classList.contains('np-wide')); };

  // ─── 🔨 AUCTIONS ON THE LISTINGS TAB ──────────────────────────────────────
  // From the auction log (localStorage.pbp_auc_live) the 🤖 Lister keeps
  // while it reads My Auctioned Items: running ones with time left, current
  // price and last bidder; unsold ones waiting to relist (price + %); past
  // ones (sold, relisted, given up) for 14 days.
  const aucLink = id => `https://www.neopets.com/auctions.phtml?type=bids&auction_id=${encodeURIComponent(id)}`;

  // 🗑 Delete all past auctions (sold / relisted / given up)
  function clearPastAuctions() {
    processAuctionSales();   // anything sold but not yet logged is logged first
    const r2 = getAucReg();
    const pastE = r2.entries.filter(x => ['sold', 'relisted', 'lost'].includes(x.status));
    if (!pastE.length) return;
    const lost = pastE.filter(x => x.status === 'lost' && (x.base || x.start)).length;
    if (!confirm(`Delete all ${pastE.length} past auctions from this list?${lost ? `\n\n${lost} of them ${lost === 1 ? 'is an unsold one' : 'are unsold ones'} you could still relist from here — ${lost === 1 ? 'it goes' : 'they go'} too.` : ''}\n\nLogged sales stay in your Tracker.`)) return;
    aucIgnoreAdd(pastE.map(x => x.id));
    r2.entries = r2.entries.filter(x => !pastE.includes(x));
    saveAucReg(r2);
    showToast(`🗑 ${pastE.length} past auction${pastE.length === 1 ? '' : 's'} deleted`);
    return;
  }

  // Unsold auction: set the relist price (% of the original start), or don't relist
  function auctionAction(act, key, pct) {
    if (act === 'clearpast') { clearPastAuctions(); return; }
    if (act === 'notsoldall') {
      const r0 = getAucReg();
      const chk = r0.entries.filter(x => x.status === 'gone');
      if (!chk.length || !confirm(`Mark all ${chk.length} as unsold? They move to Past auctions, where 🔨 Relist puts them back up.`)) return;
      const now = new Date().toISOString();
      chk.forEach(x => { x.status = 'lost'; x.ended = x.ended || now; });
      saveAucReg(r0);
      showToast(`↩ ${chk.length} marked unsold`);
      return;
    }
    if (act === 'todraft') {
      const r0 = getAucReg();
      const en0 = r0.entries.find(x => x.key === key);
      if (!en0) return;
      const d = getAucDraft();
      const px = en0.base || en0.start || 0;
      let e = d.items.find(x => groupKey(x.name) === groupKey(en0.name));
      if (!e) { e = { name: en0.name, qty: 0, start: px ? String(px) : '', ids: [] }; d.items.push(e); }
      else if (!e.start && px) e.start = String(px);
      e.qty += 1;
      saveAucDraft(d);
      en0.drafted = new Date().toISOString();
      saveAucReg(r0);
      showToast(`🔨 ${en0.name} added to the auction list on 📦 Purchases${px ? '' : ' — set a start price there'}`);
      return;
    }
    const r = getAucReg();
    const en = r.entries.find(x => x.key === key);
    if (!en) return;
    if (act === 'logsale' && en.status === 'gone') {
      const now = new Date().toISOString();
      Object.assign(en, { status: 'sold', price: pct, soldAt: en.ended || now, ended: en.ended || now,
        buyer: en.bidder && !/^nobody$/i.test(en.bidder) ? en.bidder : '' });
    } else if (act === 'notsold' && en.status === 'gone') {
      en.status = 'lost'; en.ended = en.ended || new Date().toISOString();
    } else if (act === 'relist') {
      relistAuctions([key], pct || 0);
      return;
    } else if (act === 'pct' && en.status === 'unsold') {
      en.base = en.base || en.start;
      en.start = relistPrice(en.base, pct || 0);
      showToast(`🔨 ${en.name} relists at ${formatNP(en.start)} NP`);
    } else if (act === 'norelist' && en.status === 'unsold') {
      if (!confirm(`Don't relist ${en.name}? It stays in your inventory.`)) return;
      en.status = 'lost'; en.ended = new Date().toISOString();
    } else if (act === 'forget') {
      if (!confirm(`Remove ${en.name} (auction ${en.id || 'new'}) from this list? Your Tracker rows aren't changed${en.status === 'pending' || en.status === 'live' ? ', and a still-running auction stays up on Neopets — it just isn\'t tracked any more' : ''}.`)) return;
      aucIgnoreAdd([en.id]);
      r.entries = r.entries.filter(x => x.key !== key);

    } else return;
    saveAucReg(r);
  }

  // ↻ Relist one or many unsold auctions at a % of their original start: all
  // go into the auction queue, then one run puts them up (straight to New
  // Listing). An auction run already going picks them up as it goes.
  const aucUnpicked = new Set();   // unsold auctions unticked for "Relist selected"
  function relistAuctions(keys, pct) {
    const r = getAucReg();
    const list = keys.map(k => r.entries.find(x => x.key === k))
      .filter(en => en && (en.status === 'unsold' || (en.status === 'lost' && en.start)) && relistPrice(en.base || en.start || 0, pct) > 0);
    if (!list.length) { showToast('Nothing to relist — no start price known'); return; }
    const young = list.filter(en => en.status === 'unsold' && en.closedAt && Date.now() - Date.parse(en.closedAt) < 15 * 60000);
    if (young.length && !confirm(`${young.length === 1 ? `${young[0].name} closed` : `${young.length} of these closed`} less than 15 min ago — items usually take about 15 min to come back to your inventory. Any that aren't back yet get marked short.\n\nRelist ${list.length === 1 ? 'it' : `all ${list.length}`} now anyway?`)) return;
    const q = getAucQueue() || { v: 1, created: new Date().toISOString(), items: [], done: [], missing: [] };
    const now = new Date().toISOString();
    let np = 0;
    for (const en of list) {
      const price = relistPrice(en.base || en.start, pct);
      // An old one may have been moved to the SDB or gallery since: let the run look there too
      const old = en.status === 'lost';
      q.items.push({ name: en.name, qty: 1, start: price, relists: old ? 0 : (en.relists || 0) + 1, again: (en.relists || 0) + 1, base: en.base || en.start,
        qid: 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
      Object.assign(en, { status: 'relisted', start: price, ended: now });
      aucUnpicked.delete(en.key);
      np += price;
    }
    q.updated = now;
    localStorage.setItem(AUC_QUEUE_KEY, JSON.stringify(q));
    saveAucReg(r);
    const what = list.length === 1 ? `${list[0].name} at ${formatNP(np)} NP` : `${list.length} auctions${pct ? ` at −${pct}%` : ''} (${shortNP(np)} total)`;
    if (lister && lister.auctionRunning()) showToast(`↻ ${what} added to the running auction run`);
    else if (lister && lister.startAuctions()) showToast(`↻ Relisting ${what}…`);
    else showToast(`↻ ${what} queued — the Lister is busy; press ▶ Run auctions after`);
  }

  function auctionsListingsHtml() {
    const reg = getAucReg().entries;
    const purchases = getPurchases();
    const relistOn = !!(lister && lister.relistOn());
    const byAt = (a, b) => String(b.at).localeCompare(String(a.at));
    const running = reg.filter(e => e.status === 'pending' || e.status === 'live').sort(byAt);
    const unsold = reg.filter(e => e.status === 'unsold').sort(byAt);
    const check = reg.filter(e => e.status === 'gone').sort(byAt);
    const past = reg.filter(e => ['sold', 'relisted', 'lost'].includes(e.status))
      .sort((a, b) => String(b.ended || b.at).localeCompare(String(a.ended || a.at)));

    const wide = isWide();
    const head = (e, when) => `
        <div class="np-offer-head">
          ${e.id ? `<a class="np-offer-lot np-lot-link" href="${aucLink(e.id)}" target="_blank" rel="noopener" title="Open auction ${escHtml(e.id)}">Auction ${escHtml(e.id)} ↗</a>` : '<span class="np-offer-lot">New auction</span>'}
          <span class="np-offer-seller" title="${escHtml(e.name)}">${escHtml(e.name)}</span>
          <span class="np-muted np-offer-age">${when}</span>
        </div>`;
    const costLine = (e) => {
      const c = trackerCostOf(e.name, 1, purchases);
      if (!c.got) return '<span class="np-muted" title="No unsold Tracker row for this item">cost ?</span>';
      const ref = e.cur || e.start;
      const pl = ref ? ref - c.cost : null;
      return `cost ${formatNP(c.cost)}${pl !== null ? ` · <span class="${pl >= 0 ? 'np-green' : 'np-red'}" title="${e.cur ? 'Current price' : 'Start price'} minus Tracker cost">${pl >= 0 ? '+' : ''}${formatNP(pl)}</span>` : ''}`;
    };
    const viewLink = e => e.id ? `<a class="np-offer-link" href="${aucLink(e.id)}" target="_blank" rel="noopener">🔨 View auction ↗</a>` : '';
    // Wide: the item as a row (paid · itemdb · recent trades · 📜) right under the header
    const lp = getListingPrices();
    const wideRow = e => wide ? itemTableHtml([{ name: e.name, qty: 1, paid: trackerCostOf(e.name, 1, purchases) }], lp) : '';
    const open = (e, extra = '') => `<div class="np-offer-card${extra}">`;
    const relists = e => e.relists ? ` · relist ${e.relists}` : '';

    const runCard = e => {
      const bid = e.bidder && !/^nobody$/i.test(e.bidder);
      const now = e.seen
        ? `${escHtml(e.timeLeft || '?')} left · now ${formatNP(e.cur || 0)}${bid ? ` · <b>${escHtml(e.bidder)}</b> leads` : ' · no bids'}`
        : '<span class="np-muted">waiting for My Auctioned Items</span>';
      return `${open(e)}${head(e, 'started ' + timeAgo(e.at))}${wideRow(e)}
          <div class="np-watch-line">Start ${e.start ? formatNP(e.start) : '?'}${relists(e)} · ${costLine(e)}</div>
          <div class="np-watch-line">${now}${e.seen ? ` <span class="np-muted">· checked ${timeAgo(e.seen)}</span>` : ''}</div>
          <div class="np-watch-actions">${viewLink(e)}<button class="np-watch-act" data-aact="forget" data-key="${escHtml(e.key)}" title="Remove from this list only — nothing changes on Neopets">✕</button></div>
        </div>`;
    };
    const unsoldCard = e => `${open(e)}${head(e, 'closed ' + timeAgo(e.closedAt || e.at)).replace('<div class="np-offer-head">',
        `<div class="np-offer-head"><input type="checkbox" class="np-au-pick" data-key="${escHtml(e.key)}"${aucUnpicked.has(e.key) ? '' : ' checked'} title="Include in Relist selected">`)}${wideRow(e)}
          <div class="np-watch-line">Unsold · start was <b>${e.start ? formatNP(e.start) : '?'}</b>${relists(e)} · ${costLine(e)}
            ${relistOn ? ' <span class="np-muted">· auto-relists at this price</span>' : ''}</div>
          <div class="np-watch-actions"><span class="np-muted" style="font-size:11px">↻ Relist now</span>${[0, 5, 10, 15, 20].map(pc => {
            const v = relistPrice(e.base || e.start || 0, pc);
            return `<button class="np-watch-act" data-aact="relist" data-key="${escHtml(e.key)}" data-p="${pc}" title="Put it back up now at ${formatNP(v)} NP">${pc ? '−' + pc : '0'}%</button>`;
          }).join('')}
            <button class="np-watch-act" data-aact="norelist" data-key="${escHtml(e.key)}" title="Don't relist">✕</button></div>
          ${viewLink(e)}
        </div>`;
    const pastCard = e => {
      const what = e.status === 'sold'
        ? `Sold for <b>${formatNP(e.price || 0)} NP</b>${e.buyer ? ` to ${escHtml(e.buyer)}` : ''}`
        : e.status === 'relisted' ? `Unsold · relisted at ${formatNP(e.start || 0)}` : 'Unsold · not relisted';
      const canRelist = e.status === 'lost' && (e.base || e.start) > 0;
      return `${open(e, ' np-offer-gone')}${head(e, (e.status === 'sold' ? 'sold ' : 'ended ') + timeAgo(e.ended || e.at))}${wideRow(e)}
          <div class="np-watch-line">${what} <span class="np-muted">· start ${formatNP(e.start || 0)}${relists(e)}</span></div>
          ${canRelist ? `<div class="np-watch-actions"><span class="np-muted" style="font-size:11px">↻ Relist now at</span>${[0, 5, 10, 15, 20].map(pc => {
            const v = relistPrice(e.base || e.start, pc);
            return `<button class="np-watch-act" data-aact="relist" data-key="${escHtml(e.key)}" data-p="${pc}" title="Put it back up at ${formatNP(v)} NP (it must be in your inventory, SDB or gallery)">${pc ? '−' + pc : '0'}%</button>`;
          }).join('')}</div>` : ''}
          <div class="np-watch-actions">${e.status === 'lost' ? (e.drafted
              ? '<span class="np-muted" style="font-size:11px">🔨 in the auction list</span>'
              : `<button class="np-watch-act" data-aact="todraft" data-key="${escHtml(e.key)}" title="Add to the 🔨 auction list on Purchases${(e.base || e.start) ? ' at its old start price' : ' — set a start price there'}">🔨 Relist</button>`) : ''}<button class="np-watch-act" data-aact="forget" data-key="${escHtml(e.key)}">✕ Forget</button></div>
        </div>`;
    };

    const checkCard = e => {
      const bid = e.bidder && !/^nobody$/i.test(e.bidder);
      return `${open(e)}${head(e, 'ended ' + timeAgo(e.ended || e.at))}${wideRow(e)}
          <div class="np-watch-line">${e.never ? 'Never showed up on My Auctioned Items (failed, or sold before it was read)' : e.early ? 'Finished before tracking started' : 'Finished, but the result wasn\'t seen'} · last seen ${bid ? `<b>${formatNP(e.lastBid || e.cur || 0)}</b> from ${escHtml(e.bidder)}` : 'no bids'}</div>
          <div class="np-watch-actions">
            <input class="np-au-sold" type="text" value="${bid && (e.lastBid || e.cur) ? formatNP(e.lastBid || e.cur) : ''}" placeholder="Sold for (NP)" title="What it sold for: 5000, 5k, 2.5m" />
            <button class="np-watch-act" data-aact="logsale" data-key="${escHtml(e.key)}" title="Log it: oldest matching Tracker rows are marked sold">✅ Log sale</button>
            <button class="np-watch-act" data-aact="notsold" data-key="${escHtml(e.key)}" title="It didn't sell — just archive it">↩ Not sold</button>
          </div>
        </div>`;
    };
    const soldRecent = past.filter(e => e.status === 'sold');
    const soldNp = soldRecent.reduce((t, e) => t + (Number(e.price) || 0), 0);

    return `
      <div class="np-pnl-cards">
        <div class="np-pnl-card"><div class="np-pnl-card-label">Running</div><div class="np-pnl-card-val">${running.length}</div></div>
        <div class="np-pnl-card"><div class="np-pnl-card-label">Unsold</div><div class="np-pnl-card-val">${unsold.length}</div></div>
        <div class="np-pnl-card" title="Sold auctions kept in the last 14 days"><div class="np-pnl-card-label">Sold · 14d</div><div class="np-pnl-card-val">${soldRecent.length} · ${shortNP(soldNp)}</div></div>
      </div>
      ${check.length ? `
        <div class="np-pnl-section-title">⚠️ Check sale (${check.length})</div>
        <div class="np-muted np-offer-gone-note">These finished without the Lister seeing the result. ✅ Log sale marks the oldest matching Tracker rows sold; ↩ Not sold archives it.</div>
        ${check.length > 1 ? `<div class="np-watch-actions" style="margin-bottom:8px"><button class="np-watch-act" data-aact="notsoldall" data-key="" title="Every card here didn't sell — move them all to Past auctions">↩ Mark all ${check.length} unsold</button></div>` : ''}
        ${check.map(checkCard).join('')}` : ''}
      <div class="np-pnl-section-title" style="margin-top:14px">🔨 Active auctions (${running.length})</div>
      <div class="np-offer-sync np-muted">${relistOn ? '↻ Relist unsold is on · ' : ''}<a class="np-offer-link-inline" href="https://www.neopets.com/auctions.phtml?show=mine">open My Auctioned Items</a> to refresh</div>
      ${running.length ? running.map(runCard).join('')
        : '<div class="np-watch-empty">No auctions running. Put items up with 🔨 on the Purchases tab.</div>'}
      ${unsold.length ? `
        <div class="np-pnl-section-title" style="margin-top:14px">Unsold · waiting to relist (${unsold.length})</div>
        ${(() => {
          const picked = unsold.filter(e => !aucUnpicked.has(e.key));
          return `<div class="np-au-bulk">
            <label><input type="checkbox" class="np-au-pickall"${picked.length === unsold.length ? ' checked' : ''}> All</label>
            <span>↻ Relist <b>${picked.length}</b> selected at</span>
            ${[0, 5, 10, 15, 20].map(pc => `<button class="np-watch-act" data-aact="relistsel" data-p="${pc}"${picked.length ? '' : ' disabled'} title="Put all ticked ones back up in one run at ${pc ? '−' + pc + '% of their original start' : 'their original start'}">${pc ? '−' + pc : '0'}%</button>`).join('')}
          </div>`;
        })()}
        ${unsold.map(unsoldCard).join('')}` : ''}
      ${past.length ? `
        <details class="np-offers-gone">
          <summary>Past auctions (${past.length})</summary>
          <div class="np-muted np-offer-gone-note">Sold, relisted and given-up auctions. Kept for 14 days.</div>
          <div class="np-watch-actions" style="margin-bottom:8px"><button class="np-watch-act" data-aact="clearpast" data-key="" title="Remove every past auction from this list (logged sales stay in your Tracker)">🗑 Delete all ${past.length}</button></div>
          ${past.map(pastCard).join('')}
        </details>` : ''}`;
  }

  // ─── 🤖 LISTER ↔ TRACKER ───────────────────────────────────────────────────
  let lister = null;        // the 🤖 Lister (personal build), set up by the router
  let listerChip = '';      // short Lister status on the 🍕 button
  function listingsOpen() { const v = document.getElementById('np-view-listings'); return !!(v && !v.classList.contains('np-hidden')); }
  function listerRefresh() { if (lister) lister.render(); }
  function listerHost() {
    return {
      setChip(s) { listerChip = s || ''; updateWatchBadges(); },
      onQueues() { renderListDrawer(); renderAucDrawer(); if (listingsOpen()) renderListingsView(); },
      onAuctions() { processAuctionSales(); renderAucDrawer(); if (listingsOpen()) renderListingsView(); },
      toast: showToast
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 🤖 AUTO-LISTER (personal build) — was the separate "PBP — Trading Post
  // Auto-Lister" script (1.4.1), now the 🤖 Lister tab. Own scope, so its
  // names don't clash with the Tracker's. Talks to the Tracker through host:
  // setChip (🍕 button note), onQueues / onAuctions (redraw, log sales), toast.
  // Queues and the auction log stay in localStorage (same keys as before).
  // ═══════════════════════════════════════════════════════════════════════════
  function autoLister(host) {
  /* ───────────────────────── config ───────────────────────── */
  const VERSION = '2.29';
  const CREATE_URL = 'https://www.neopets.com/island/tradingpost.phtml#/?type=create';
  const SDB_URL = 'https://www.neopets.com/safetydeposit.phtml';
  const GALLERY_URL = 'https://www.neopets.com/gallery/quickremove.phtml';
  const SDB_SEARCH = '/np-templates/ajax/safetydeposit/get-items.php';
  const SDB_MOVE = '/np-templates/ajax/safetydeposit/move-items.php';
  const QUEUE_KEY = 'pbp_tpl_queue';                // localStorage, written by the PBP Tracker
  const DELETED_KEY = 'pbp_tpl_deleted';            // localStorage, lots the Lister deleted to relist (the Tracker reads it)
  const VIEW_URL = 'https://www.neopets.com/island/tradingpost.phtml#/?type=view';
  // 1.3.0 — auctions
  const AUC_QUEUE_KEY = 'pbp_auc_queue';            // localStorage, written by the Tracker's 🔨 drawer
  const AUC_REG_KEY = 'pbp_auc_live';               // localStorage, every auction we start (the Tracker logs sales from it)
  const AUC_SDB = '/np-templates/ajax/safetydeposit/auction.php';
  const AUC_CREATE = '/np-templates/ajax/auctions/create.php';
  const AUC_INV_LIST = '/np-templates/ajax/auctions/inventory-list.php';
  const AUC_NEW_URL = 'https://www.neopets.com/auctions.phtml?type=newlisting';
  const AUC_MINE_URL = 'https://www.neopets.com/auctions.phtml?show=mine';
  const AUC_DURATIONS = [1, 2, 3, 4, 6, 9, 12, 18, 24, 48];
  const AUC_GAP_MIN = 1500, AUC_GAP_MAX = 3500;     // between auctions
  const RELIST_AFTER = 15 * 60000;                  // an unsold item takes ~15 min to come back
  const RELIST_GIVE_UP = 2 * 3600000;               // still not back after this → it sold (Check sale in Listings)
  const WATCH_MIN = 4 * 60000, WATCH_MAX = 7 * 60000; // My Auctioned Items refresh while watching
  const AUC_FAIL_MAX = 3;                           // this many failures in a row stops a run
  const STALL_AFTER = 4 * 60000;                    // a run with no progress this long is stopped
  const STALE_RUN = 15 * 60000;                     // on page load: "running" but silent this long → reset
  const IB_CAP = 20000000;                          // instant-buy tops out at 20m
  const STEP_PAUSE_MIN = 1200, STEP_PAUSE_MAX = 2800; // between pages in Queue mode
  const ORDERS = {
    'gallery,sdb,inventory': 'Gallery → SDB → Inventory',
    'sdb,gallery,inventory': 'SDB → Gallery → Inventory',
    'inventory,gallery,sdb': 'Inventory → Gallery → SDB',
    'inventory,sdb,gallery': 'Inventory → SDB → Gallery'
  };
  const KEY = 'pbp_tpl_state';
  const SNAP_KEY = 'pbp_tpl_snapshot';
  const CLICK_MIN = 500, CLICK_MAX = 1500;          // per click, like a human
  const LOT_PAUSE_MIN = 1500, LOT_PAUSE_MAX = 3500; // breather between lots
  const SUBMIT_TIMEOUT = 15000;
  const LOAD_TIMEOUT = 20000;
  const FALLBACK_LOT_MAX = 30;
  const WISH_MAX = 750;

  // Outcome text after "Start Trading!" — candidates until the real popup is pinned
  const SUCCESS_RX = /(success|created|has been (posted|created|listed)|lot\s*#?\s*\d+|trade (lot )?(created|posted))/i;
  const ERROR_RX = /(error|cannot|can't|unable|not allowed|too many|maximum|limit reached|failed|invalid|please (select|add))/i;
  const CONFIRM_RX = /(are you sure|confirm)/i;
  const POPUP_SELECTORS = [
    '[role="dialog"]', '[role="alertdialog"]',
    '[class*="modal"]', '[class*="Modal"]',
    '[class*="popup"]', '[class*="Popup"]',
    '[class*="dialog"]', '[class*="overlay"]',
    '[class*="toast"]', '[class*="alert"]'
  ];

  /* ───────────────────────── state ───────────────────────── */
  const defaults = { running: false, phase: 'idle', pending: 0, pendingNum: 0, lots: 0, items: 0, log: [],
    wishOn: false, wishTpl: 'Lot #{n}', nextNum: 1,
    // 1.2.0 — Queue mode
    mode: 'all',                        // 'all' = list everything, 'queue' = Tracker queue
    cap: 12, runLots: 0,                // lots-per-session cap, lots listed this run
    order: 'gallery,sdb,inventory',     // where to take items from first
    qCur: null,                         // the lot being built: { items:[{name,qty,price}], left:{}, pulled:{}, steps:[], step:0 }
    qSrc: null,                         // this run's source counts: { gallery:{name:held}|null, sdb:{name:amount} }
    qGot: null,                         // tiles ticked per item, kept across a submit reload
    // 1.3.0 — auctions
    aucIncr: 1, aucDur: 24, aucNf: false, relistOn: false,
    aStep: null,                        // 'sdb' | 'gallery' | 'inv' while an auction run is going
    aFails: 0,
    // 2.29 — List all instant-buy per lot (0 = none) and run speed (1 = normal, 3 = very slow)
    allIb: 0, tpSpeed: 1, aucSpeed: 1 };
  let state = Object.assign({}, defaults, GM_getValue(KEY, {}));
  const save = () => GM_setValue(KEY, state);
  let busy = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  // Speed setting: every human-style pause is stretched by it. Auction runs and
  // the auctions pages use the auction speed, everything else the TP speed.
  const SPEEDS = { 1: 'Normal', 1.5: 'Relaxed', 2: 'Slow', 3: 'Very slow' };
  const okSpeed = v => SPEEDS[+v] ? +v : 1;
  const spd = () => okSpeed(state.mode === 'auction' || /\/auctions\.phtml/i.test(location.pathname) ? state.aucSpeed : state.tpSpeed);
  const jitter = (a, b) => sleep(rand(a, b) * spd());
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  function log(msg) {
    if (state.running) state.beat = Date.now();
    const t = new Date().toTimeString().slice(0, 8);
    state.log.unshift(`${t}  ${msg}`);
    state.log = state.log.slice(0, 40);
    save();
    render();
  }

  async function waitFor(fn, timeout, every = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }

  /* ───────────────────────── DOM helpers ───────────────────────── */
  const isCreateRoute = () => /type=create/.test(location.hash);
  const visible = el => !!el && el.isConnected && el.offsetParent !== null &&
    getComputedStyle(el).visibility !== 'hidden';
  const form = () => document.querySelector('#tp-create-form');

  // The page renders every item once per category tab; only the visible panel counts.
  function activePanel() {
    const panels = [...document.querySelectorAll('#tp-create-form .tp-tab-panel')];
    return panels.find(p => p.style.display !== 'none' && visible(p)) || panels[0] || null;
  }
  function tiles() {
    const p = activePanel();
    return p ? [...p.querySelectorAll('.tp-grid-item')] : [];
  }
  const isSelected = t => t.classList.contains('bg-item-selection');
  const selectedCount = () => tiles().filter(isSelected).length;

  function lotLimit() {
    const p = [...document.querySelectorAll('#tp-create-form p')]
      .find(x => /Limit:\s*\d+\s*\/\s*\d+/i.test(x.textContent));
    const m = p && p.textContent.match(/Limit:\s*(\d+)\s*\/\s*(\d+)/i);
    return m ? { used: +m[1], max: +m[2] } : null;
  }

  function startButton() {
    const f = form();
    if (!f) return null;
    return [...f.querySelectorAll('button')].find(b => /start trading/i.test(b.textContent)) || null;
  }

  function wishlistBox() {
    const f = form();
    return f ? f.querySelector('textarea') : null;
  }

  // Vue v-model needs the native setter + an input event, not a bare .value =
  function setTextarea(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const wishText = n => (state.wishTpl || 'Lot #{n}').replace(/\{n\}/g, n).slice(0, WISH_MAX);

  // Lot finished: bump counters and, if numbering, the next number
  function recordLot(sel) {
    state.lots++; state.items += sel;
    if (state.pendingNum) state.nextNum = state.pendingNum + 1;
    const tag = state.pendingNum ? ` [#${state.pendingNum}]` : '';
    state.pending = 0; state.pendingNum = 0; state.phase = 'idle'; save();
    return tag;
  }

  async function ensureFullInventoryTab() {
    const tab = [...document.querySelectorAll('#tp-create-form .tp-tab-item')]
      .find(b => /full inventory/i.test(b.textContent));
    if (tab && !tab.classList.contains('tp-tab-active')) {
      await jitter(CLICK_MIN, CLICK_MAX);
      tab.click();
      await sleep(600);
    }
  }

  // Our own UI (this panel, the Tracker, its toasts and modals, other PBP
  // scripts) must never count as the site's answer: the Tracker shows text
  // like "Lot 12345", which matches SUCCESS_RX.
  const OWN_UI = '#pbp-tpl, #np-lister, #np-tracker-panel, #np-tracker-btn, .np-toast, .np-modal-overlay, .np-alert-popup, '
    + '[id^="np-"], [class^="np-"], [class*=" np-"], [id^="idb-"]';
  const isOwnUi = el => !!(el && el.closest && el.closest(OWN_UI));

  function popupCandidates() {
    const out = new Set();
    for (const sel of POPUP_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => {
        if (isOwnUi(el) || !visible(el)) return;
        if (clean(el.textContent).length < 4) return;
        out.add(el);
      });
    }
    // Fallback: fixed-position top-level children of body / #app
    const roots = [...document.body.children, ...(document.querySelector('#app')?.children || [])];
    roots.forEach(el => {
      if (isOwnUi(el) || !visible(el)) return;
      if (getComputedStyle(el).position === 'fixed' && clean(el.textContent).length >= 4) out.add(el);
    });
    // Keep only outermost matches
    return [...out].filter(el => ![...out].some(o => o !== el && o.contains(el)));
  }

  function findButton(root, rx) {
    return [...root.querySelectorAll('button, a, [role="button"], .tp-border-frame-btn, img[class*="close"]')]
      .find(b => visible(b) && (rx.test(clean(b.textContent)) || rx.test(b.getAttribute('alt') || '') ||
        rx.test(b.getAttribute('aria-label') || '') || rx.test(b.className || '')));
  }

  /* ───────────────────────── core loop ───────────────────────── */
  // Popups showing (with this text) just before Start Trading — not the answer
  function popupSnapshot() {
    const m = new Map();
    for (const p of popupCandidates()) m.set(p, clean(p.textContent));
    return m;
  }

  async function awaitOutcome(before) {
    const startHash = location.hash;
    const clicked = new WeakSet();
    const t0 = Date.now();
    await sleep(400);
    while (Date.now() - t0 < SUBMIT_TIMEOUT) {
      if (!state.running) return { ok: false, msg: 'stopped by user' };
      for (const pop of popupCandidates()) {
        const txt = clean(pop.textContent);
        if (before && before.get(pop) === txt) continue;   // was already there before the click
        if (SUCCESS_RX.test(txt)) return { ok: true, msg: txt.slice(0, 140), pop };
        if (ERROR_RX.test(txt)) return { ok: false, msg: txt.slice(0, 160), pop };
        if (CONFIRM_RX.test(txt) && !clicked.has(pop)) {
          const b = findButton(pop, /^(yes|confirm|ok|continue|start trading)/i);
          if (b) {
            clicked.add(pop);
            await jitter(CLICK_MIN, CLICK_MAX);
            b.click();
            log('Confirm dialog → clicked "' + clean(b.textContent).slice(0, 30) + '"');
          }
        }
      }
      if (location.hash !== startHash) return { ok: true, msg: 'route changed to ' + location.hash };
      if (!startButton() && !form()) return { ok: true, msg: 'create form closed' };
      const lim = lotLimit();
      if (isCreateRoute() && lim && lim.used === 0 && state.pending > 0) return { ok: true, msg: 'form reset' };
      await sleep(300);
    }
    return { ok: false, timeout: true };
  }

  async function runPass() {
    if (busy || !state.running || state.mode === 'queue' || !isCreateRoute()) return;
    busy = true;
    try {
      // A submit that made the site navigate/reload before we saw the result
      if (state.phase === 'submitted') {
        const tag = recordLot(state.pending);
        state.runLots++; save();
        log(`Lot ${state.lots}${tag} listed (page changed after submit)`);
        if (capReached()) return;
      }

      setStatus('Waiting for inventory…');
      if (!await waitFor(form, LOAD_TIMEOUT)) return stop('Create form never loaded');
      await ensureFullInventoryTab();
      await sleep(1500); // let Vue finish rendering the grid
      let all = tiles();
      if (!all.length) { await sleep(2500); all = tiles(); }
      if (!all.length) return stop(`Done — inventory empty. ${state.lots} lots / ${state.items} items listed.`, true);

      const lim = lotLimit();
      const max = lim ? lim.max : FALLBACK_LOT_MAX;
      const target = Math.min(max, all.length);
      setStatus(`Selecting ${target} item${target === 1 ? '' : 's'}…`);

      for (const t of all) {
        if (!state.running) return;
        if (selectedCount() >= target) break;
        if (isSelected(t)) continue;
        await jitter(CLICK_MIN, CLICK_MAX);
        t.click();
        if (!await waitFor(() => isSelected(t), 1500, 100)) {
          log('Tile click did not register: ' + clean(t.querySelector('.tp-grid-item-name')?.textContent));
        }
      }
      if (!state.running) return;

      const sel = selectedCount();
      if (sel < target) return stop(`Only ${sel}/${target} selected — clicks not registering. Run Diagnose DOM.`);

      // Autobuy price: one flat instant-buy per lot; over 20m it goes in the wishlist as an asking price
      const flat = Math.max(0, parseInt(state.allIb, 10) || 0);
      const ib = flat && flat <= IB_CAP ? flat : 0;
      const ask = flat > IB_CAP ? flat : 0;
      if (!await setInstantBuy(ib)) return stop(`Instant-buy ${ib ? 'amount' : 'switch'} did not stick. Run Diagnose DOM.`);

      let num = 0;
      const parts = [];
      if (state.wishOn) { num = state.nextNum; parts.push(wishText(num)); }
      if (ask) parts.push(askText(ask));
      if (parts.length) {
        const box = wishlistBox();
        if (!box) return stop('Wishlist box not found. Run Diagnose DOM.');
        const text = parts.join(' · ').slice(0, WISH_MAX);
        await jitter(CLICK_MIN, CLICK_MAX);
        box.focus();
        setTextarea(box, text);
        box.blur();
        await sleep(200);
        if (box.value !== text) return stop('Wishlist text did not stick. Run Diagnose DOM.');
      }

      const btn = startButton();
      if (!btn) return stop('"Start Trading!" button not found. Run Diagnose DOM.');
      await jitter(CLICK_MIN, CLICK_MAX);
      state.phase = 'submitted'; state.pending = sel; state.pendingNum = num; save();
      setStatus(`Submitting lot of ${sel}${ib ? ` · IB ${fmtNP(ib)}` : ask ? ' · wishlist ask' : ''}…`);
      const before = popupSnapshot();
      btn.click();

      const res = await awaitOutcome(before);
      if (res.timeout) {
        snapshot('timeout after submit');
        state.phase = 'idle'; state.pending = 0; state.pendingNum = 0; save();
        return stop('No recognisable result after Start Trading. Check Your Trades, then send Diagnose DOM.');
      }
      if (!res.ok) {
        snapshot('error after submit');
        state.phase = 'idle'; state.pending = 0; state.pendingNum = 0; save();
        return stop('Site said: ' + res.msg);
      }

      const tag = recordLot(sel);
      state.runLots++; save();
      log(`Lot ${state.lots}${tag} listed (${sel} items) — ${res.msg}`);
      if (res.pop) {
        const close = findButton(res.pop, /^(ok|okay|close|continue|done|back|×|x)$|close/i);
        if (close) { await jitter(CLICK_MIN, CLICK_MAX); close.click(); }
      }
      if (capReached()) return;

      setStatus('Next lot shortly…');
      await jitter(LOT_PAUSE_MIN, LOT_PAUSE_MAX);
      if (!state.running) return;
      // Fresh load = fresh inventory list
      busy = false;
      location.replace(CREATE_URL);
      setTimeout(() => location.reload(), 400);
    } catch (e) {
      state.phase = 'idle'; save();
      stop('Script error: ' + e.message);
    } finally {
      busy = false;
    }
  }

  /* ───────────────────────── queue mode (1.2.0) ─────────────────────────
     The PBP Tracker writes localStorage.pbp_tpl_queue. One lot at a time:
     plan it from the queue, pull what's needed from the gallery / SDB (in the
     chosen order, one lot's worth only), tick tiles by name on the create
     form, set instant-buy (sum of item prices) or a wishlist asking price
     when the sum is over 20m, list it, then update the queue's done / missing.
     Every step survives a page load: the lot being built lives in state.qCur. */
  const lc = s => clean(s).toLowerCase();
  const priceOf = p => { const n = parseInt(p, 10); return n > 0 ? n : 0; };
  const later = () => setTimeout(runQueue, rand(STEP_PAUSE_MIN, STEP_PAUSE_MAX) * spd());

  function getQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(QUEUE_KEY) || 'null');
      if (!q || !Array.isArray(q.items)) return null;
      q.done = Array.isArray(q.done) ? q.done : [];
      q.missing = Array.isArray(q.missing) ? q.missing : [];
      return q;
    } catch { return null; }
  }
  function saveQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
    catch (e) { log('Could not save the queue: ' + e.message); }
    host.onQueues();
  }
  const queueLeft = q => q ? q.items.reduce((s, i) => s + (i.qty > 0 ? i.qty : 0), 0) : 0;

  // Next lot from what's left in the queue. Same name twice → one entry.
  function planLot(q) {
    const size = Math.max(1, Math.min(30, parseInt(q.lotSize, 10) || 30));
    let live = q.items.filter(i => i.qty > 0 && clean(i.name));
    if (!live.length) return null;
    const out = [];
    const add = (i, n) => {
      const cur = out.find(o => lc(o.name) === lc(i.name));
      if (cur) cur.qty += n; else out.push({ name: clean(i.name), qty: n, price: priceOf(i.price) });
    };
    // A relist (Tracker's ↻ on Listings): exactly the old lot's items, as one lot
    if (live[0].group) {
      const gid = live[0].group;
      live.filter(i => i.group === gid).forEach(i => add(i, i.qty));
      out.group = gid;
      return out;
    }
    live = live.filter(i => !i.group);
    if (q.mode === 'packed') {
      let room = size;
      for (const i of live) { if (!room) break; const n = Math.min(room, i.qty); add(i, n); room -= n; }
    } else {
      const first = live[0];
      let room = size;
      for (const i of live.filter(x => lc(x.name) === lc(first.name))) {
        if (!room) break; const n = Math.min(room, i.qty); add(i, n); room -= n;
      }
    }
    return out;
  }

  // Source order → steps. 'scan' (count inventory first) only when a pull comes after it.
  function buildSteps(group) {
    // Relist: delete the old lot (items go back to inventory), then list — no pulls
    if (group) {
      const g = (getQueue().groups || {})[group] || {};
      if (!g.past) return g.deleted ? ['list'] : ['cancel', 'list'];
      // Already off the TP: no delete, fetch the items like any queued lot
    }
    const order = (state.order || 'gallery,sdb,inventory').split(',');
    const steps = [];
    order.forEach((s, i) => {
      if (s === 'inventory') { if (order.slice(i + 1).some(x => x !== 'inventory')) steps.push('scan'); }
      else steps.push(s);
    });
    steps.push('list');
    return steps;
  }

  function planNext() {
    const q = getQueue();
    const items = q && planLot(q);
    if (!items) {
      const miss = q && q.missing.length;
      stop(`Queue done — ${state.runLots} lot${state.runLots === 1 ? '' : 's'} this run.${miss ? ` ${miss} item${miss === 1 ? '' : 's'} came up short, see the Tracker.` : ''}`, true);
      return false;
    }
    const group = items.group || null;
    state.qCur = { items: [...items], group, left: Object.fromEntries(items.map(i => [lc(i.name), i.qty])), pulled: {}, steps: buildSteps(group), step: 0 };
    state.qGot = null;
    save();
    log((group ? `Relist lot #${((q.groups || {})[group] || {}).lot}: ` : 'Next lot: ') + items.map(i => `${i.qty}× ${i.name}`).join(', '));
    return true;
  }

  const stepName = () => state.qCur && state.qCur.steps[state.qCur.step];
  const needLeft = () => Object.entries(state.qCur.left).filter(([, n]) => n > 0);
  const nameOf = k => (state.qCur.items.find(i => lc(i.name) === k) || { name: k }).name;

  function addPulled(k, n, src) {
    const c = state.qCur;
    c.left[k] = Math.max(0, (c.left[k] || 0) - n);
    c.pulled[k] = (c.pulled[k] || 0) + n;
    if (src && state.qSrc && state.qSrc[src] && state.qSrc[src][k] > 0) state.qSrc[src][k] -= n;
  }

  // Skip a pull when nothing is left to find, or this run already saw the source hasn't got it
  function skipStep(step) {
    if (!step || step === 'list' || step === 'cancel') return false;
    const left = needLeft();
    if (!left.length) return true;
    const src = state.qSrc || {};
    if (step === 'gallery' && src.gallery) return left.every(([k]) => !(src.gallery[k] > 0));
    if (step === 'sdb' && src.sdb) return left.every(([k]) => src.sdb[k] === 0);
    return false;
  }
  function onPageFor(step) {
    if (step === 'cancel') return /tradingpost\.phtml/i.test(location.pathname) && !/type=(?!view)/.test(location.hash);
    if (step === 'gallery') return /\/gallery\/quickremove\.phtml/i.test(location.pathname);
    if (step === 'sdb') return /\/safetydeposit\.phtml/i.test(location.pathname);
    return /tradingpost\.phtml/i.test(location.pathname) && isCreateRoute();
  }
  const urlFor = step => step === 'gallery' ? GALLERY_URL : step === 'sdb' ? SDB_URL : step === 'cancel' ? VIEW_URL : CREATE_URL;

  async function runQueue() {
    if (busy || !state.running || state.mode !== 'queue') return;
    busy = true;
    try {
      if (state.phase === 'submitted') finishQueueLot(true, 'page changed after submit');
      if (!state.qCur && !planNext()) return;
      while (skipStep(stepName())) { state.qCur.step++; save(); }
      const step = stepName();
      if (!onPageFor(step)) {
        setStatus(`Going to ${step === 'gallery' ? 'the gallery' : step === 'sdb' ? 'the SDB' : step === 'cancel' ? 'Your Trades' : 'the create form'}…`);
        await jitter(STEP_PAUSE_MIN, STEP_PAUSE_MAX);
        if (!state.running) return;
        location.href = urlFor(step);
        return;
      }
      if (step === 'cancel') await doDeleteLot();
      else if (step === 'gallery') await doGallery();
      else if (step === 'sdb') await doSdb();
      else if (step === 'scan') await doScan();
      else await doList();
    } catch (e) {
      stop('Script error: ' + e.message);
    } finally {
      busy = false;
    }
  }

  // Native setter + events so the page's own scripts see the change
  function setInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ── relist: delete the old lot on Your Trades (bin → Delete Lot) ── */
  function lotCard(lot) {
    return [...document.querySelectorAll('div.tp-border-frame')].find(c =>
      !isOwnUi(c) && [...c.querySelectorAll('p')].some(p => clean(p.textContent) === `Lot ${lot}`)) || null;
  }
  function yourTradesCount() {
    for (const p of document.querySelectorAll('p')) {
      if (isOwnUi(p)) continue;
      const m = (p.textContent || '').match(/Your Active Lots:\s*(\d+)/i);
      if (m) return +m[1];
    }
    return null;
  }
  function noteDeleted(lot) {
    try {
      const a = JSON.parse(localStorage.getItem(DELETED_KEY) || '[]');
      a.push(String(lot));
      localStorage.setItem(DELETED_KEY, JSON.stringify(a.slice(-200)));
    } catch { /* ignore */ }
  }
  // The relist is over without listing (lot gone already): drop its items from the queue
  function dropGroup(gid) {
    const q = getQueue();
    if (q) {
      q.items = q.items.filter(i => i.group !== gid);
      if (q.groups) delete q.groups[gid];
      saveQueue(q);
    }
    state.qCur = null; state.qGot = null; save(); render();
  }

  async function doDeleteLot() {
    const gid = state.qCur.group;
    const g = ((getQueue() || {}).groups || {})[gid];
    if (!g) { dropGroup(gid); return later(); }
    setStatus(`Your Trades: finding lot #${g.lot}…`);
    // Wait for the lots to render (the counter shows first)
    await waitFor(() => yourTradesCount() !== null && (yourTradesCount() === 0 || document.querySelector('div.tp-border-frame')), LOAD_TIMEOUT);
    await sleep(1200);
    const card = lotCard(g.lot);
    if (!card) {
      log(`Relist: lot #${g.lot} isn't on Your Trades (sold or already removed) — not relisted`);
      dropGroup(gid);
      return later();
    }
    const bin = card.querySelector('img[src*="bin-icon"]');
    if (!bin) return stop(`Relist: no delete (bin) button on lot #${g.lot}. Run Diagnose DOM.`);
    await jitter(CLICK_MIN, CLICK_MAX);
    (bin.closest('button, [role="button"]') || bin).click();
    const del = await waitFor(() => [...document.querySelectorAll('button')]
      .find(b => !isOwnUi(b) && visible(b) && /^delete lot$/i.test(clean(b.textContent))), 6000, 200);
    if (!del) return stop(`Relist: the Delete Lot confirm didn't appear for lot #${g.lot}. Run Diagnose DOM.`);
    await jitter(CLICK_MIN, CLICK_MAX);
    setStatus(`Deleting lot #${g.lot}…`);
    del.click();
    const gone = await waitFor(() => !lotCard(g.lot), SUBMIT_TIMEOUT, 300);
    if (!gone) { snapshot('lot delete not confirmed'); return stop(`Relist: lot #${g.lot} still shows after Delete Lot. Check Your Trades, then Diagnose DOM.`); }
    noteDeleted(g.lot);
    const q = getQueue();
    if (q && q.groups && q.groups[gid]) { q.groups[gid].deleted = true; saveQueue(q); }
    log(`Relist: lot #${g.lot} deleted — items back in inventory`);
    // Close a leftover popup if the site shows one
    for (const pop of popupCandidates()) {
      const close = findButton(pop, /^(ok|okay|close|continue|done|thanks!?)$|close/i);
      if (close) { await jitter(CLICK_MIN, CLICK_MAX); close.click(); break; }
    }
    state.qCur.step++; save();
    later();
  }

  /* ── gallery: tick, set qty, Remove Checked ── */
  function galleryRows(f) {
    return [...f.querySelectorAll('input.check_box_remove')].map(cb => {
      const id = cb.value, tr = cb.closest('tr');
      const name = tr && tr.cells[2] ? clean(tr.cells[2].textContent) : '';
      const h = f.querySelector(`input[name="remove_h_qty_arr[${id}]"]`);
      const qtyBox = f.querySelector(`input[name="remove_qty_arr[${id}]"]`);
      return { cb, id, name, held: h ? (parseInt(h.value, 10) || 0) : (qtyBox ? parseInt(qtyBox.value, 10) || 0 : 0), qtyBox };
    }).filter(r => r.name && r.held > 0);
  }

  async function doGallery() {
    setStatus('Gallery: finding items…');
    const f = await waitFor(() => document.querySelector('#quickremove_form'), LOAD_TIMEOUT);
    const rows = f ? galleryRows(f) : [];
    const snap = {};
    rows.forEach(r => { const k = lc(r.name); snap[k] = (snap[k] || 0) + r.held; });
    state.qSrc = state.qSrc || {};
    state.qSrc.gallery = snap;       // later lots skip the visit when none of theirs is here
    if (!f) log('Gallery: quick-remove form not found — skipping the gallery');

    const took = [];
    for (const [k, n] of needLeft()) {
      let need = n;
      for (const r of rows.filter(x => lc(x.name) === k)) {
        if (!need || !state.running) break;
        const take = Math.min(need, r.held);
        await jitter(CLICK_MIN, CLICK_MAX);
        if (!r.cb.checked) r.cb.click();
        if (!r.cb.checked) { r.cb.checked = true; r.cb.dispatchEvent(new Event('change', { bubbles: true })); }
        if (r.qtyBox) setInput(r.qtyBox, String(take));
        need -= take;
        addPulled(k, take, 'gallery');
        took.push(`${take}× ${r.name}`);
      }
    }
    if (!state.running) return;
    state.qCur.step++; save();
    if (!took.length) { log('Gallery: none of this lot there'); return later(); }

    const btn = f.querySelector('input.remove_checked_submit, input[value="Remove Checked"]');
    if (!btn) return stop('Gallery: "Remove Checked" button not found. Run Diagnose DOM.');
    log('Gallery: removing ' + took.join(', '));
    setStatus('Gallery: removing…');
    await jitter(CLICK_MIN, CLICK_MAX);
    btn.click();
    // The page normally reloads after removing; if it stays put, move on ourselves
    setTimeout(() => { if (state.running) runQueue(); }, 12000);
  }

  /* ── SDB: the page's own AJAX endpoints, while on the SDB page ── */
  function sdbRefCk() {
    try {
      const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      if (w.__sdbData && w.__sdbData.refCk) return String(w.__sdbData.refCk);
    } catch { /* fall through */ }
    for (const s of document.scripts) {
      const m = (s.textContent || '').match(/refCk["']?\s*[:=]\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
    return '';
  }
  async function sdbPost(url, body) {
    const res = await fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, text };
  }
  function sdbResult(r) {
    const d = r.data || {};
    const s = d.status || d.result || (d.data && d.data.status) ||
      (d.success === true ? 'success' : d.success === false ? (d.error || 'error') : '');
    return String(s).toLowerCase();
  }

  async function doSdb() {
    setStatus('SDB: looking up items…');
    const ck = await waitFor(sdbRefCk, LOAD_TIMEOUT);
    if (!ck) return stop('SDB: could not read the page key. Run Diagnose DOM on the SDB page.');
    state.qSrc = state.qSrc || {};
    state.qSrc.sdb = state.qSrc.sdb || {};
    const moves = [], plan = [];
    for (const [k, n] of needLeft()) {
      if (!state.running) return;
      if (state.qSrc.sdb[k] === 0) continue;
      const name = nameOf(k);
      await jitter(600, 1400);
      const r = await sdbPost(SDB_SEARCH, { page: 1, per_page: 30, search: name, category: '', sort: '', view_filter: 'np', _ref_ck: ck });
      const items = r.data && r.data.data && Array.isArray(r.data.data.items) ? r.data.data.items : null;
      if (!items) { log(`SDB: search for ${name} failed (HTTP ${r.status})`); continue; }
      const hit = items.find(i => lc(i.obj_name) === k);
      if (hit && Number(hit.is_notrade)) { log(`SDB: ${name} is no-trade — skipped`); state.qSrc.sdb[k] = 0; continue; }
      const amount = hit ? (parseInt(hit.amount, 10) || 0) : 0;
      state.qSrc.sdb[k] = amount;
      const take = Math.min(n, amount);
      if (take) { moves.push({ obj_info_id: Number(hit.obj_info_id), quantity: take, action: 'inventory' }); plan.push([k, take, name]); }
    }
    if (!state.running) return;
    state.qCur.step++; save();
    if (!moves.length) { log('SDB: none of this lot there'); return later(); }

    await jitter(CLICK_MIN, CLICK_MAX);
    setStatus('SDB: moving to inventory…');
    const r = await sdbPost(SDB_MOVE, { moves, pin: '', _ref_ck: ck });
    const res = sdbResult(r);
    if (res === 'pin_required' || res === 'pin_wrong') return stop('The SDB asked for a PIN — this run assumes none is set.');
    if (res === 'success' || res === 'partial_error') {
      plan.forEach(([k, take]) => addPulled(k, take, 'sdb'));
      log('SDB: moved ' + plan.map(([, t, n]) => `${t}× ${n}`).join(', ') +
        (res === 'partial_error' ? ' (only partly — any shortfall shows on the create form)' : ''));
    } else {
      log('SDB move not confirmed: ' + (r.text || '').replace(/\s+/g, ' ').slice(0, 160));
    }
    save();
    later();   // anything that didn't arrive is caught when tiles are counted
  }

  /* ── create form ── */
  const tileName = t => lc(t.querySelector('.tp-grid-item-name')?.textContent);
  async function loadCreateGrid() {
    if (!await waitFor(form, LOAD_TIMEOUT)) return null;
    await ensureFullInventoryTab();
    await sleep(1500);
    let all = tiles();
    if (!all.length) { await sleep(2500); all = tiles(); }
    return all;
  }

  // Inventory comes before a pull in the order: count what's already here
  async function doScan() {
    setStatus('Counting inventory…');
    const all = await loadCreateGrid();
    if (!all) return stop('Create form never loaded');
    const counts = {};
    all.forEach(t => { const k = tileName(t); counts[k] = (counts[k] || 0) + 1; });
    const c = state.qCur;
    for (const [k, n] of needLeft()) {
      const avail = Math.max(0, (counts[k] || 0) - (c.pulled[k] || 0));
      c.left[k] = n - Math.min(avail, n);
    }
    c.step++; save();
    later();
  }

  const ibSwitch = () => form() && form().querySelector('label.tp-switch input[type="checkbox"]');
  const ibAmount = () => form() && form().querySelector('input[placeholder="Amount"]');

  async function setInstantBuy(amount) {
    const want = amount > 0;
    const sw = ibSwitch();
    if (!sw) return !want;
    if (sw.checked !== want) {
      await jitter(CLICK_MIN, CLICK_MAX);
      (sw.closest('label') || sw).click();
      await waitFor(() => sw.checked === want, 1500, 100);
      if (sw.checked !== want) { sw.click(); await waitFor(() => sw.checked === want, 1500, 100); }
      if (sw.checked !== want) return false;
    }
    if (!want) return true;
    const box = await waitFor(ibAmount, 3000, 150);
    if (!box) return false;
    await jitter(CLICK_MIN, CLICK_MAX);
    box.focus();
    setInput(box, String(amount));
    box.blur();
    await sleep(250);
    return String(box.value || '').replace(/\D/g, '') === String(amount);
  }

  // Wishlist asking price the Tracker's parseAskPrice reads: "ab 25m", or exact with commas
  function askText(n) {
    const short = n >= 1e9 ? +(n / 1e9).toFixed(2) + 'b' : +(n / 1e6).toFixed(2) + 'm';
    const back = parseFloat(short) * (short.endsWith('b') ? 1e9 : 1e6);
    return Math.round(back) === n ? `ab ${short}` : `ab ${n.toLocaleString('en-US')} NP`;
  }

  async function doList() {
    setStatus('Building the lot…');
    const all = await loadCreateGrid();
    if (!all) return stop('Create form never loaded');
    const cur = state.qCur;
    const lim = lotLimit();
    const max = lim ? lim.max : FALLBACK_LOT_MAX;
    const got = {};
    let total = 0;
    for (const it of cur.items) {
      const k = lc(it.name);
      got[k] = 0;
      for (const t of tiles().filter(x => tileName(x) === k && !isSelected(x))) {
        if (!state.running) return;
        if (got[k] >= it.qty || total >= max) break;
        await jitter(CLICK_MIN, CLICK_MAX);
        t.click();
        if (await waitFor(() => isSelected(t), 1500, 100)) { got[k]++; total++; }
        else log('Tile click did not register: ' + it.name);
      }
    }
    if (!state.running) return;
    state.qGot = got; save();
    if (!total) {
      log('None of this lot is in inventory — marked short');
      finishQueueLot(false);
      return later();
    }

    // Price: every item priced → IB = sum; over 20m → asking price in the wishlist.
    // Relist: the Tracker's new lot price (scaled down if some items came up short).
    let ib = 0, ask = 0;
    const inLot = cur.items.filter(it => got[lc(it.name)] > 0);
    const grp = cur.group && ((getQueue() || {}).groups || {})[cur.group];
    if (grp && grp.price > 0) {
      const want = cur.items.reduce((s, it) => s + it.qty, 0);
      const sum = total < want ? Math.floor(grp.price * total / want) : grp.price;
      if (total < want) log(`Relist: only ${total}/${want} items found — price scaled to ${sum.toLocaleString('en-US')}`);
      if (sum <= IB_CAP) ib = sum; else ask = sum;
    } else if (inLot.every(it => it.price > 0)) {
      const sum = inLot.reduce((s, it) => s + it.price * got[lc(it.name)], 0);
      if (sum <= IB_CAP) ib = sum; else ask = sum;
    }
    if (!await setInstantBuy(ib)) return stop(`Instant-buy ${ib ? 'amount' : 'switch'} did not stick. Run Diagnose DOM.`);

    let num = 0;
    const parts = [];
    if (state.wishOn) { num = state.nextNum; parts.push(wishText(num)); }
    if (ask) parts.push(askText(ask));
    if (parts.length) {
      const box = wishlistBox();
      if (!box) return stop('Wishlist box not found. Run Diagnose DOM.');
      const text = parts.join(' · ').slice(0, WISH_MAX);
      await jitter(CLICK_MIN, CLICK_MAX);
      box.focus(); setTextarea(box, text); box.blur();
      await sleep(200);
      if (box.value !== text) return stop('Wishlist text did not stick. Run Diagnose DOM.');
    }

    const btn = startButton();
    if (!btn) return stop('"Start Trading!" button not found. Run Diagnose DOM.');
    await jitter(CLICK_MIN, CLICK_MAX);
    state.phase = 'submitted'; state.pending = total; state.pendingNum = num; save();
    setStatus(`Submitting lot of ${total}${ib ? ` · IB ${ib.toLocaleString('en-US')}` : ask ? ' · wishlist ask' : ''}…`);
    const before = popupSnapshot();
    btn.click();

    const res = await awaitOutcome(before);
    if (res.timeout || !res.ok) {
      snapshot(res.timeout ? 'timeout after submit' : 'error after submit');
      state.phase = 'idle'; state.pending = 0; state.pendingNum = 0; save();
      return stop(res.timeout ? 'No recognisable result after Start Trading. Check Your Trades, then send Diagnose DOM.'
        : 'Site said: ' + res.msg);
    }
    finishQueueLot(true, res.msg);
    if (res.pop) {
      const close = findButton(res.pop, /^(ok|okay|close|continue|done|back|×|x)$|close/i);
      if (close) { await jitter(CLICK_MIN, CLICK_MAX); close.click(); }
    }
    if (capReached()) return;
    setStatus('Next lot shortly…');
    await jitter(LOT_PAUSE_MIN, LOT_PAUSE_MAX);
    if (!state.running) return;
    busy = false;
    location.replace(CREATE_URL);
    setTimeout(() => location.reload(), 400);
  }

  // Lot over (listed, or nothing found): take it off the queue, note done / short
  function finishQueueLot(listed, msg) {
    const cur = state.qCur;
    const got = state.qGot || {};
    const num = state.pendingNum;
    let tag = '';
    if (listed) { tag = recordLot(state.pending); state.runLots++; }
    const q = getQueue();
    if (cur && q) {
      const lotLabel = num ? `Lot #${num}` : `run lot ${state.runLots}`;
      for (const it of cur.items) {
        const k = lc(it.name);
        const g = listed ? (got[k] || 0) : 0;
        const short = it.qty - g;
        let take = it.qty;
        for (const qi of q.items) {
          if (!take) break;
          if (lc(qi.name) !== k || !(qi.qty > 0) || (qi.group || null) !== (cur.group || null)) continue;
          const n = Math.min(take, qi.qty);
          qi.qty -= n; take -= n;
        }
        if (g) q.done.push({ name: it.name, qty: g, lot: lotLabel });
        if (short > 0) {
          const m = q.missing.find(x => lc(x.name) === k);
          if (m) m.short += short; else q.missing.push({ name: it.name, short });
        }
      }
      q.items = q.items.filter(i => i.qty > 0);
      if (cur.group && q.groups) delete q.groups[cur.group];
      q.updated = new Date().toISOString();
      saveQueue(q);
    }
    if (listed) {
      const n = Object.values(got).reduce((s, x) => s + x, 0);
      log(`Lot ${state.lots}${tag} listed (${n} item${n === 1 ? '' : 's'})${msg ? ' — ' + msg : ''}`);
    }
    state.qCur = null; state.qGot = null; state.phase = 'idle'; state.pending = 0; state.pendingNum = 0;
    save();
    render();
  }

  /* ───────────────────────── auction queue (1.3.0) ─────────────────────────
     The Tracker's 🔨 drawer writes localStorage.pbp_auc_queue: items with a
     qty and a start price. One auction per item. A run goes:
       sdb     → the SDB page: auction.php straight from the box
       gallery → the gallery: remove what's still needed to inventory
       inv     → New Listing page: inventory-list.php + create.php
     Whatever is still left after that is marked short. Every auction started
     goes into localStorage.pbp_auc_live; reading My Auctioned Items fills in
     the auction id, then sold (Last Bidder ≠ nobody) or unsold. The Tracker
     logs sold ones; unsold ones are relisted at the same price when Relist
     unsold is on. The queue is updated after every auction, so a reload
     mid-run never lists anything twice. */
  function getAucQueue() {
    try {
      const q = JSON.parse(localStorage.getItem(AUC_QUEUE_KEY) || 'null');
      if (!q || !Array.isArray(q.items)) return null;
      q.done = Array.isArray(q.done) ? q.done : [];
      q.missing = Array.isArray(q.missing) ? q.missing : [];
      return q;
    } catch { return null; }
  }
  function saveAucQueue(q) {
    q.updated = new Date().toISOString();
    try { localStorage.setItem(AUC_QUEUE_KEY, JSON.stringify(q)); }
    catch (e) { log('Could not save the auction queue: ' + e.message); }
    host.onQueues();
  }
  const aucLeft = q => q ? q.items.reduce((s, i) => s + (i.qty > 0 ? i.qty : 0), 0) : 0;

  function getReg() {
    try {
      const r = JSON.parse(localStorage.getItem(AUC_REG_KEY) || 'null');
      return r && Array.isArray(r.entries) ? r : { entries: [] };
    } catch { return { entries: [] }; }
  }
  function saveReg(r) {
    // Finished entries are kept 14 days (the Tracker needs a sold one until it has logged it)
    const cutoff = Date.now() - 14 * 864e5;
    r.entries = r.entries.filter(e => !['sold', 'relisted', 'lost'].includes(e.status) || Date.parse(e.ended || e.at) > cutoff);
    r.updated = new Date().toISOString();
    try { localStorage.setItem(AUC_REG_KEY, JSON.stringify(r)); }
    catch (e) { log('Could not save the auction log: ' + e.message); }
    host.onAuctions();
  }
  function regAdd(e) {
    const r = getReg();
    r.entries.push({ key: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), id: null, status: 'pending',
      at: new Date().toISOString(), relists: 0, ...e });
    saveReg(r);
  }

  const aucSettings = () => ({
    incr: Math.max(1, parseInt(state.aucIncr, 10) || 1),
    dur: AUC_DURATIONS.includes(+state.aucDur) ? +state.aucDur : 24,
    nf: !!state.aucNf
  });
  const npNum = s => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0;
  // "5000", "5k", "2.5m", "1,000,000" → NP; unreadable → 0
  function parseNP(s) {
    const m = String(s || '').trim().toLowerCase().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/);
    return m ? Math.round(parseFloat(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1)) : 0;
  }
  const fmtNP = n => (Number(n) || 0).toLocaleString('en-US');
  // Price drop for a relist: % of the original start, rounded down (to 1,000 NP from 10,000 up)
  const RELIST_PCTS = [0, 5, 10, 15, 20];
  const dropPrice = (px, pct) => { const n = px * (1 - pct / 100); return n >= 10000 ? Math.floor(n / 1000) * 1000 : Math.max(1, Math.floor(n)); };

  // Page key on any auctions page (New Listing sets ahNlCk; the nav uses _ref_ck)
  function pageRefCk() {
    for (const s of document.scripts) {
      const t = s.textContent || '';
      const m = t.match(/ahNlCk\s*=\s*["']([^"']+)["']/) || t.match(/["']?_ref_ck["']?\s*:\s*["']([0-9a-f]{16,})["']/i);
      if (m) return m[1];
    }
    return '';
  }

  // One auction. src 'sdb' → { obj_info_id }, src 'inv' → { obj_id }. Returns { ok, msg }.
  async function postAuction(src, ref, start, ck) {
    const { incr, dur, nf } = aucSettings();
    const inc = Math.min(incr, start);   // the site refuses an increment above the start price
    const body = src === 'sdb'
      ? { obj_info_id: ref, quantity: 1, start_price: start, min_increment: inc, duration: dur, neofriends_only: nf, pin: '', _ref_ck: ck }
      : { obj_id: ref, start_price: start, min_increment: inc, duration: dur, neofriends_only: nf, guild_members_only: false, _ref_ck: ck };
    const r = await sdbPost(src === 'sdb' ? AUC_SDB : AUC_CREATE, body);
    const d = r.data || {};
    const msg = clean(d.message || d.error || (r.data ? '' : r.text)).slice(0, 160);
    // Success in any shape the site answers with (success: true, status: 'success', …)
    const ok = d.success === true || (r.status >= 200 && r.status < 300 && sdbResult(r) === 'success');
    return { ok, msg: msg || `HTTP ${r.status}`, inc };
  }

  // One item taken off the queue after a successful auction
  function aucDone(name, start, src, inc, qid) {
    const q = getAucQueue();
    let extra = {};
    if (q) {
      const it = (qid && q.items.find(i => i.qid === qid && i.qty > 0))
        || q.items.find(i => lc(i.name) === lc(name) && i.qty > 0 && priceOf(i.start) === start)
        || q.items.find(i => lc(i.name) === lc(name) && i.qty > 0);
      if (it && (it.relists || it.again)) extra = { relists: it.relists || it.again, base: it.base, src: 'relist' };
      if (it) it.qty--;
      q.done.push({ name, start, src, at: new Date().toISOString() });
      q.items = q.items.filter(i => i.qty > 0);
      saveAucQueue(q);
    }
    const { dur, nf } = aucSettings();
    regAdd({ name, start, incr: inc, dur, nf, src, ...extra });
    state.aFails = 0; save();
    render();
  }
  // A failure: stop the run after AUC_FAIL_MAX in a row (a limit, a key problem, …)
  function aucFail(what, msg) {
    state.aFails = (state.aFails || 0) + 1; save();
    log(`${what} failed: ${msg}`);
    if (state.aFails >= AUC_FAIL_MAX) { stop(`${AUC_FAIL_MAX} auctions failed in a row — stopped. Last: ${msg}`); return true; }
    return false;
  }

  const aucUrlFor = step => step === 'sdb' ? SDB_URL : step === 'gallery' ? GALLERY_URL : AUC_NEW_URL;
  function onAucPage(step) {
    if (step === 'sdb') return /\/safetydeposit\.phtml/i.test(location.pathname);
    if (step === 'gallery') return /\/gallery\/quickremove\.phtml/i.test(location.pathname);
    return /\/auctions\.phtml/i.test(location.pathname) && /type=newlisting/i.test(location.search);
  }
  const laterAuc = () => setTimeout(runAuction, rand(STEP_PAUSE_MIN, STEP_PAUSE_MAX) * spd());
  function nextAucStep() {
    state.aStep = state.aStep === 'sdb' ? 'gallery' : 'inv';
    save();
  }

  async function runAuction() {
    if (busy || !state.running || state.mode !== 'auction') return;
    busy = true;
    try {
      const q = getAucQueue();
      if (!aucLeft(q)) return finishAuctionRun();
      // Relists come back to inventory, so they skip the SDB and gallery: with
      // only relists left, go straight to New Listing
      const fresh = q.items.some(i => i.qty > 0 && !i.relists);
      if (!state.aStep || (!fresh && state.aStep !== 'inv')) { state.aStep = fresh ? (state.aStep || 'sdb') : 'inv'; save(); }
      const step = state.aStep;
      if (!onAucPage(step)) {
        setStatus(`Going to ${step === 'sdb' ? 'the SDB' : step === 'gallery' ? 'the gallery' : 'New Listing'}…`);
        await jitter(STEP_PAUSE_MIN, STEP_PAUSE_MAX);
        if (!state.running) return;
        location.href = aucUrlFor(step);
        return;
      }
      if (step === 'sdb') await aucFromSdb();
      else if (step === 'gallery') await aucFromGallery();
      else await aucFromInventory();
    } catch (e) {
      stop('Script error: ' + e.message);
    } finally {
      busy = false;
    }
  }

  async function aucFromSdb() {
    setStatus('SDB: looking up items…');
    const ck = await waitFor(sdbRefCk, LOAD_TIMEOUT);
    if (!ck) return stop('SDB: could not read the page key. Run Diagnose DOM on the SDB page.');
    for (const it of getAucQueue().items.filter(i => i.qty > 0 && !i.relists)) {
      if (!state.running) return;
      await jitter(600, 1400);
      const r = await sdbPost(SDB_SEARCH, { page: 1, per_page: 30, search: it.name, category: '', sort: '', view_filter: 'np', _ref_ck: ck });
      const items = r.data && r.data.data && Array.isArray(r.data.data.items) ? r.data.data.items : null;
      if (!items) { log(`SDB: search for ${it.name} failed (HTTP ${r.status})`); continue; }
      const hit = items.find(i => lc(i.obj_name) === lc(it.name));
      if (!hit) continue;
      if (Number(hit.is_notrade)) { log(`SDB: ${it.name} is no-trade — skipped`); continue; }
      const n = Math.min(it.qty, parseInt(hit.amount, 10) || 0);
      const start = priceOf(it.start);
      if (!start) { log(`${it.name}: no start price — skipped`); continue; }
      for (let i = 0; i < n; i++) {
        if (!state.running) return;
        await jitter(AUC_GAP_MIN, AUC_GAP_MAX);
        setStatus(`SDB: auctioning ${it.name} (${i + 1}/${n})…`);
        const res = await postAuction('sdb', Number(hit.obj_info_id), start, ck);
        if (res.ok) { aucDone(it.name, start, 'sdb', res.inc); log(`Auction: ${it.name} from the SDB · start ${start.toLocaleString('en-US')}`); }
        else { if (aucFail(`SDB auction of ${it.name}`, res.msg)) return; break; }
      }
    }
    if (!state.running) return;
    nextAucStep();
    laterAuc();
  }

  async function aucFromGallery() {
    setStatus('Gallery: finding items…');
    const f = await waitFor(() => document.querySelector('#quickremove_form'), LOAD_TIMEOUT);
    const rows = f ? galleryRows(f) : [];
    if (!f) log('Gallery: quick-remove form not found — skipping the gallery');
    const took = [];
    for (const it of getAucQueue().items.filter(i => i.qty > 0 && !i.relists)) {
      let need = it.qty;
      for (const r of rows.filter(x => lc(x.name) === lc(it.name))) {
        if (!need || !state.running) break;
        const take = Math.min(need, r.held);
        await jitter(CLICK_MIN, CLICK_MAX);
        if (!r.cb.checked) r.cb.click();
        if (!r.cb.checked) { r.cb.checked = true; r.cb.dispatchEvent(new Event('change', { bubbles: true })); }
        if (r.qtyBox) setInput(r.qtyBox, String(take));
        need -= take;
        took.push(`${take}× ${r.name}`);
      }
    }
    if (!state.running) return;
    nextAucStep();
    if (!took.length) { log('Gallery: none of the auction queue there'); return laterAuc(); }
    const btn = f.querySelector('input.remove_checked_submit, input[value="Remove Checked"]');
    if (!btn) return stop('Gallery: "Remove Checked" button not found. Run Diagnose DOM.');
    log('Gallery: removing ' + took.join(', '));
    setStatus('Gallery: removing…');
    await jitter(CLICK_MIN, CLICK_MAX);
    btn.click();
    setTimeout(() => { if (state.running) runAuction(); }, 12000);
  }

  async function aucInventory() {
    const res = await fetch(AUC_INV_LIST, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const data = await res.json().catch(() => null);
    return data && Array.isArray(data.items) ? data.items : null;
  }

  async function aucFromInventory() {
    setStatus('New Listing: reading inventory…');
    const ck = await waitFor(pageRefCk, LOAD_TIMEOUT);
    if (!ck) return stop('New Listing: could not read the page key. Run Diagnose DOM on this page.');
    let inv = await aucInventory();
    if (!inv) return stop('New Listing: could not load your auctionable inventory.');
    const used = new Set();
    // Items can be added while this runs (↻ Relist now on more cards): keep
    // going in passes until nothing new turns up, re-reading inventory each pass
    const tried = new Set();
    const idOf = it => it.qid || `${lc(it.name)}|${priceOf(it.start)}`;
    for (let pass = 0; pass < 20; pass++) {
      const todo = getAucQueue().items.filter(i => i.qty > 0 && !tried.has(idOf(i)));
      if (!todo.length) break;
      if (pass) { inv = await aucInventory() || inv; log(`${todo.length} more added to the run`); }
      for (const it of todo) {
        tried.add(idOf(it));
        const start = priceOf(it.start);
        const objs = inv.filter(o => lc(o.name) === lc(it.name) && !used.has(o.obj_id));
        const n = Math.min(it.qty, objs.length);
        if (!start) { log(`${it.name}: no start price — skipped`); continue; }
        for (let i = 0; i < n; i++) {
          if (!state.running) return;
          used.add(objs[i].obj_id);
          await jitter(AUC_GAP_MIN, AUC_GAP_MAX);
          setStatus(`Auctioning ${it.name} (${i + 1}/${n})…`);
          const res = await postAuction('inv', objs[i].obj_id, start, ck);
          if (res.ok) { aucDone(it.name, start, 'inv', res.inc, it.qid); log(`Auction: ${it.name} · start ${start.toLocaleString('en-US')}`); }
          else { if (aucFail(`Auction of ${it.name}`, res.msg)) return; break; }
        }
      }
    }
    if (!state.running) return;
    // Anything still in the queue wasn't in the SDB, gallery or inventory
    const q = getAucQueue();
    for (const it of q.items.filter(i => i.qty > 0 && tried.has(idOf(i)))) {
      const m = q.missing.find(x => lc(x.name) === lc(it.name));
      if (m) m.short += it.qty; else q.missing.push({ name: it.name, short: it.qty });
      log(`Short: ${it.qty}× ${it.name} — not found`);
      it.qty = 0;
    }
    q.items = q.items.filter(i => i.qty > 0);   // anything added in the last second stays for next time
    saveAucQueue(q);
    if (aucLeft(q)) { log(`${aucLeft(q)} added at the very end — running again`); return laterAuc(); }
    finishAuctionRun();
  }

  function finishAuctionRun() {
    const q = getAucQueue();
    const n = q ? q.done.length : 0;
    const miss = q ? q.missing.reduce((s, m) => s + m.short, 0) : 0;
    state.aStep = null; save();
    stop(`Auction queue done — ${n} put up${miss ? `, ${miss} short (see the Tracker)` : ''}.`, true);
    // Straight to My Auctioned Items: that's where ids, sales and relists are picked up
    setTimeout(() => {
      if (state.running) return;
      if (onMinePage()) watchMine(); else location.href = AUC_MINE_URL;
    }, 2500);
  }

  /* ── My Auctioned Items: claim ids, read sold / unsold, relist ── */
  const onMinePage = () => /\/auctions\.phtml/i.test(location.pathname) && /show=mine/i.test(location.search);
  // "Closed" wording isn't pinned yet: anything closed-sounding, or a cell with no time left in it
  // Closed only on closed-sounding wording. Text with no time in it used to
  // count as closed too, which could end a running auction early; an auction
  // that really ended is still caught when its row leaves the page.
  const isClosedText = t => !!t && /clos|ended|finish|over\b|expired/i.test(t);

  function mineRows() {
    return [...document.querySelectorAll('tr.ah2_row')].map(tr => {
      const a = tr.querySelector('a[href*="auction_id="]');
      const id = a && (a.getAttribute('href').match(/auction_id=(\d+)/) || [])[1];
      const cell = l => clean((tr.querySelector(`td[data-label="${l}"]`) || {}).textContent);
      const nameA = tr.cells[2] && tr.cells[2].querySelector('a');
      return {
        id, name: clean(nameA ? nameA.textContent : (tr.cells[2] || {}).textContent),
        time: cell('Time Remaining'), lastBid: npNum(cell('Last Bid')), price: npNum(cell('Current Price')),
        bidder: cell('Last Bidder')
      };
    }).filter(r => r.id && r.name);
  }

  let watchTimer = null;
  let mineReading = false;
  async function watchMine() {
    if (!onMinePage() || state.running || mineReading) return;
    mineReading = true;
    try { await readMine(); }
    catch (e) { log('My Auctioned Items: read failed — ' + e.message); setStatus('Read failed — see the log'); }
    finally { mineReading = false; }
  }
  // Overdue: past its start + length + 20 min. Ids and adopted auctions with no length are skipped.
  const AUC_OVERDUE_GRACE = 20 * 60000;
  const aucOverdue = e => e.dur > 0 && Date.now() > Date.parse(e.at) + e.dur * 3600000 + AUC_OVERDUE_GRACE;
  async function readMine() {
    setStatus('Reading My Auctioned Items…');
    // The table can render well after load: wait for rows (or an empty table) before reading
    await waitFor(() => document.querySelector('tr.ah2_row'), 10000, 300);
    if (!document.querySelector('tr.ah2_row')) await waitFor(() => document.querySelector('table.ah2_list'), 2000, 300);
    await sleep(400);
    const rows = mineRows();
    const reg = getReg();
    const now = new Date().toISOString();
    const claimed = new Set([...reg.entries.filter(e => e.id).map(e => String(e.id)), ...aucIgnored()]);
    const nobody = b => !b || /^nobody$/i.test(b);
    const tableShown = !!document.querySelector('table.ah2_list') || rows.length > 0;

    // 0. A Lister auction this page adopted before the run tab had recorded it
    // (two tabs, a few seconds apart): give the id back to the Lister's entry
    // and drop the duplicate, so start price, relists and the queue line up.
    for (const e of reg.entries.filter(x => x.status === 'pending' && !x.id)) {
      const t0 = Date.parse(e.at);
      const dup = reg.entries.find(x => x.src === 'page' && x.id && x.status === 'live' && lc(x.name) === lc(e.name)
        && Math.abs(Date.parse(x.at) - t0) < 15 * 60000 && (!x.start || x.start === e.start));
      if (!dup) continue;
      Object.assign(e, { id: dup.id, status: 'live', timeLeft: dup.timeLeft, cur: dup.cur, lastBid: dup.lastBid, bidder: dup.bidder, seen: dup.seen });
      reg.entries = reg.entries.filter(x => x !== dup);
      log(`${e.name}: matched to auction ${e.id}`);
    }

    // 1. New auctions get their id: same name, still at the start price, no bids — oldest first
    const pend = reg.entries.filter(e => e.status === 'pending' && !e.id).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const asc = [...rows].sort((a, b) => Number(a.id) - Number(b.id));
    for (const e of pend) {
      let r = asc.find(x => !claimed.has(x.id) && lc(x.name) === lc(e.name) && nobody(x.bidder) && (x.price === e.start || x.lastBid === e.start));
      // Not seen for an hour (it may have a bid by now): same name is enough
      if (!r && Date.now() - Date.parse(e.at) > 3600000) r = asc.find(x => !claimed.has(x.id) && lc(x.name) === lc(e.name));
      if (r) { e.id = r.id; e.status = 'live'; claimed.add(r.id); }
      else if (tableShown && Date.now() - Date.parse(e.at) > 6 * 3600000) {
        // Never showed up on My Auctioned Items: it may have failed, or sold and gone before
        // the page was read. Check sale in Listings decides (✅ Log sale / ↩ Not sold).
        Object.assign(e, { status: 'gone', ended: now, early: false, never: true });
        log(`${e.name}: never seen on My Auctioned Items — check it in Listings`);
      }
    }

    // 1b. Running auctions the Lister didn't start (put up by hand, or before
    // 1.4.1) are tracked too. Only ones still running when first seen, so a
    // sale from before can never be logged twice. Rows whose item still has
    // a Lister auction waiting for its id are left for that auction.
    const waitingNames = new Set(reg.entries.filter(e => e.status === 'pending' && !e.id).map(e => lc(e.name)));
    let adopted = 0;
    for (const r of asc) {
      if (claimed.has(r.id) || isClosedText(r.time) || waitingNames.has(lc(r.name))) continue;
      reg.entries.push({ key: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), id: r.id, name: r.name,
        start: nobody(r.bidder) ? (r.price || null) : null, status: 'live', src: 'page', at: now, relists: 0 });
      claimed.add(r.id);
      adopted++;
    }
    if (adopted) log(`Now tracking ${adopted} auction${adopted === 1 ? '' : 's'} already running on My Auctioned Items`);

    // 1c. Auctions that had already finished before we ever saw them: shown in
    // Listings, never logged on their own. Sold → Check sale (you confirm, so
    // nothing you logged by hand is logged twice). Unsold → past, not relisted.
    let old = 0;
    for (const r of asc) {
      if (claimed.has(r.id) || !isClosedText(r.time) || waitingNames.has(lc(r.name))) continue;
      const hadBid = !nobody(r.bidder);
      reg.entries.push({ key: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), id: r.id, name: r.name,
        start: hadBid ? null : (r.price || null), status: hadBid ? 'gone' : 'lost', src: 'page', at: now, relists: 0,
        timeLeft: r.time, cur: r.price, lastBid: r.lastBid, bidder: r.bidder, seen: now, ended: now, early: true });
      claimed.add(r.id);
      old++;
    }
    if (old) log(`Found ${old} auction${old === 1 ? '' : 's'} that finished before tracking — see Listings → Auctions`);

    // 2. Live ones: Closed + bidder → sold. Closed + nobody → unsold.
    // Gone from the page: no bids last seen → unsold (the item is on its way
    // back); a bidder last seen → Check sale, with that bid filled in.
    let sold = 0, unsold = 0;
    for (const e of reg.entries.filter(x => x.id && x.status === 'live')) {
      const r = rows.find(x => x.id === String(e.id));
      if (r) Object.assign(e, { timeLeft: r.time, cur: r.price, lastBid: r.lastBid, bidder: r.bidder, seen: now });
      if (!r) {
        if (!tableShown) continue;   // page not rendered — don't guess
        if (!nobody(e.bidder)) {
          Object.assign(e, { status: 'gone', ended: now });
          log(`${e.name}: gone from My Auctioned Items with a bid from ${e.bidder} — check the sale in Listings`);
        } else {
          Object.assign(e, { status: 'unsold', closedAt: now });
          unsold++;
          log(`Unsold: ${e.name} (auction ${e.id}, no longer listed)`);
        }
        continue;
      }
      if (!isClosedText(r.time)) continue;
      if (!nobody(r.bidder)) {
        Object.assign(e, { status: 'sold', price: r.lastBid || r.price, buyer: r.bidder, soldAt: now, ended: now });
        sold++;
        log(`Sold: ${e.name} for ${(e.price || 0).toLocaleString('en-US')} to ${r.bidder}`);
      } else {
        Object.assign(e, { status: 'unsold', closedAt: now });
        unsold++;
        log(`Unsold: ${e.name} (auction ${e.id})`);
      }
    }

    // 2b. Overdue sweep: should have ended by now but couldn't be read off the page.
    // Last seen a bidder → Check sale. No bids → unsold (a relist only fires
    // once the item is really back in inventory, so a sale is never relisted).
    let overdue = 0;
    for (const e of reg.entries.filter(x => (x.status === 'live' || x.status === 'pending') && aucOverdue(x))) {
      if (e.id && rows.some(x => x.id === String(e.id))) continue;
      overdue++;
      if (!e.id) Object.assign(e, { status: 'gone', ended: now, never: true });
      else if (!nobody(e.bidder)) Object.assign(e, { status: 'gone', ended: now });
      else { Object.assign(e, { status: 'unsold', closedAt: now }); unsold++; }
      log(`${e.name}: past its end time and not readable — ${e.status === 'gone' ? 'check the sale in Listings' : 'marked unsold'}`);
    }
    log(`Read ${rows.length} auction${rows.length === 1 ? '' : 's'} from My Auctioned Items${tableShown ? '' : ' (table not found)'}`
      + (sold || unsold || overdue ? ` · ${sold} sold · ${unsold} unsold` : ''));
    saveReg(reg);

    // 3. Relist unsold ones once they're back in inventory (about 15 min)
    if (state.relistOn) await relistDue();
    renderWatch();

    // 4. Keep watching while anything is running or waiting to be relisted
    const r2 = getReg().entries;
    const open = r2.filter(e => e.status === 'pending' || e.status === 'live' || (e.status === 'unsold' && state.relistOn)).length;
    clearTimeout(watchTimer);
    const at = new Date().toTimeString().slice(0, 5);
    if (open) {
      const wait = rand(WATCH_MIN, WATCH_MAX);
      const next = new Date(Date.now() + wait).toTimeString().slice(0, 5);
      setStatus(`Watching ${open} auction${open === 1 ? '' : 's'} · checked ${at} · next ${next}`);
      setBarNote(`👁 ${open} · next ${next}`);
      watchTimer = setTimeout(() => { if (!state.running) location.reload(); }, wait);
    } else {
      setStatus(`Checked ${at} · nothing running, not refreshing`);
      setBarNote('');
    }
  }

  async function relistDue() {
    const due = getReg().entries.filter(e => e.status === 'unsold' && e.start > 0 && Date.now() - Date.parse(e.closedAt) >= RELIST_AFTER);
    if (!due.length) return;
    const ck = pageRefCk();
    if (!ck) { log('Relist: could not read the page key'); return; }
    const inv = await aucInventory();
    if (!inv) { log('Relist: could not load your inventory'); return; }
    const used = new Set();
    for (const e of due) {
      const o = inv.find(x => lc(x.name) === lc(e.name) && !used.has(x.obj_id));
      const reg = getReg();
      const cur = reg.entries.find(x => x.key === e.key);
      if (!cur || cur.status !== 'unsold') continue;
      if (!o) {
        if (Date.now() - Date.parse(e.closedAt) > RELIST_GIVE_UP) {
          cur.status = 'gone'; cur.ended = new Date().toISOString(); saveReg(reg);
          log(`Relist: ${e.name} never came back to inventory — it probably sold. Check the sale in Listings`);
        }
        continue;
      }
      used.add(o.obj_id);
      await jitter(AUC_GAP_MIN, AUC_GAP_MAX);
      setStatus(`Relisting ${e.name}…`);
      const res = await postAuction('inv', o.obj_id, e.start, ck);
      if (!res.ok) { log(`Relist of ${e.name} failed: ${res.msg}`); continue; }
      const r = getReg();
      const c = r.entries.find(x => x.key === e.key);
      if (c) { c.status = 'relisted'; c.ended = new Date().toISOString(); }
      saveReg(r);
      const { dur, nf } = aucSettings();
      regAdd({ name: e.name, start: e.start, base: e.base || e.start, incr: res.inc, dur, nf, src: 'relist', relists: (e.relists || 0) + 1 });
      log(`Relisted: ${e.name} · start ${e.start.toLocaleString('en-US')} (relist ${(e.relists || 0) + 1})`);
    }
  }

  // Not while typing in one of its boxes — a redraw would eat the edit
  function renderAucItems(aq) {
    const box = ui.querySelector('.a-items');
    if (box.contains(document.activeElement)) return;
    const items = aq ? aq.items.map((it, i) => ({ it, i })).filter(x => x.it.qty > 0) : [];
    const waiting = [];   // unsold auctions: ↻ Relist now on their cards in Listings → 🔨 Auctions
    const html = items.map(({ it, i }) => `
        <div class="a-row"><span class="a-name" title="${esc(it.name)}">${it.qty > 1 ? it.qty + '× ' : ''}${esc(it.name)}</span>
          <input class="a-start" data-i="${i}" value="${fmtNP(it.start)}" title="Start price each: 5000, 5k, 2.5m">
          <button class="a-x" data-i="${i}" title="Remove from the queue">✕</button></div>`).join('')
      + (waiting.length ? `<div class="a-sub">Unsold · ${state.relistOn ? 'relists' : 'would relist'} at:</div>` + waiting.map(e => `
        <div class="a-row"><span class="a-name" title="${esc(e.name)} · auction ${esc(e.id)}">${esc(e.name)}</span>
          <input class="a-rprice" data-key="${esc(e.key)}" value="${fmtNP(e.start)}" title="Start price for the relist">
          <button class="a-x" data-key="${esc(e.key)}" title="Don't relist this one">✕</button></div>
        <div class="a-pcts">${RELIST_PCTS.map(pc => {
          const v = dropPrice(e.base || e.start, pc);
          return `<button class="a-pct${v === e.start ? ' on' : ''}" data-key="${esc(e.key)}" data-p="${pc}" title="${fmtNP(v)} NP">${pc ? '−' + pc : '0'}%</button>`;
        }).join('')}</div>`).join('') : '');
    if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  }

  function renderWatch() {
    if (!ui) return;
    const reg = getReg().entries;
    const live = reg.filter(e => e.status === 'pending' || e.status === 'live').length;
    const wait = reg.filter(e => e.status === 'unsold').length;
    const sold = reg.filter(e => e.status === 'sold').length;
    const check = reg.filter(e => e.status === 'gone').length;
    renderAucItems(getAucQueue());
    ui.querySelector('.a-watch').textContent = live || wait || sold || check
      ? `${live} running · ${wait} unsold${wait && state.relistOn ? ' (relisting)' : ''} · ${sold} sold${check ? ` · ${check} to check` : ''}`
      : 'No auctions tracked yet — ↻ Check auctions now';
  }

  function capReached() {
    if (state.runLots < (state.cap || 12)) return false;
    stop(`Session cap reached — ${state.runLots} lots this run. Press Start again later to carry on.`, true);
    return true;
  }

  function start(mode) {
    state.mode = mode === 'queue' || mode === 'auction' ? mode : 'all';
    if (state.mode === 'queue') {
      const q = getQueue();
      if (!queueLeft(q)) { log('No queue to run — send one from the Tracker'); render(); return; }
      state.qSrc = {};   // a new run re-checks the gallery and SDB
    }
    if (state.mode === 'auction') {
      if (!aucLeft(getAucQueue())) {
        log('No auction queue');
        host.toast('Nothing queued for auction — use 🔨 on Purchases, or ↻ Relist now on an unsold auction');
        render(); return;
      }
      state.aStep = null; state.aFails = 0;
      clearTimeout(watchTimer);
    }
    state.running = true; state.runLots = 0; state.phase = 'idle'; state.pending = 0; state.pendingNum = 0; state.beat = Date.now(); save();
    log(state.mode === 'queue' ? `Queue started (${queueLeft(getQueue())} items)`
      : state.mode === 'auction' ? `Auction queue started (${aucLeft(getAucQueue())} items)`
      : `List all started · ${state.allIb ? fmtNP(state.allIb) + ' NP per lot' : 'no instant-buy'}`);
    if (spd() > 1) log(`Speed: ${SPEEDS[spd()]} (${spd()}×)`);
    resume();
  }

  function resume() {
    if (state.mode === 'queue') return runQueue();
    if (state.mode === 'auction') return runAuction();
    if (!/tradingpost\.phtml/i.test(location.pathname) || !isCreateRoute()) { location.href = CREATE_URL; return; }
    runPass();
  }

  function stop(msg, done) {
    state.running = false; save();
    host.setChip('');
    if (msg) log(msg);
    setStatus(done ? 'Finished' : (msg ? 'Stopped' : 'Idle'));
  }

  /* ───────────────────────── diagnostics ───────────────────────── */
  function snapshot(reason) {
    const pops = popupCandidates().map(p => p.outerHTML.slice(0, 4000));
    GM_setValue(SNAP_KEY, { reason, at: new Date().toISOString(), hash: location.hash, pops });
  }

  function diagnose() {
    const panels = [...document.querySelectorAll('#tp-create-form .tp-tab-panel')];
    const snap = GM_getValue(SNAP_KEY, null);
    const lines = [
      `PBP TP Auto-Lister v${VERSION} — Diagnose DOM`,
      `url: ${location.href}`,
      `state: ${JSON.stringify({ running: state.running, phase: state.phase, lots: state.lots, items: state.items, wishOn: state.wishOn, nextNum: state.nextNum })}`,
      `wishlist box: ${wishlistBox() ? wishlistBox().outerHTML.slice(0, 200) : 'NOT FOUND'}`,
      `form found: ${!!form()} | panels: ${panels.length} | active panel tiles: ${tiles().length} | selected: ${selectedCount()}`,
      `limit: ${JSON.stringify(lotLimit())} | start button: ${startButton() ? startButton().outerHTML.slice(0, 200) : 'NOT FOUND'}`,
      `IB switch: ${ibSwitch() ? 'found, ' + (ibSwitch().checked ? 'on' : 'off') : 'NOT FOUND'} | IB amount: ${ibAmount() ? ibAmount().outerHTML.slice(0, 160) : 'NOT FOUND'}`,
      `mode: ${state.mode} | runLots: ${state.runLots}/${state.cap} | order: ${state.order}`,
      `qCur: ${JSON.stringify(state.qCur)}`,
      `qSrc: ${JSON.stringify(state.qSrc)}`,
      `queue: ${(localStorage.getItem(QUEUE_KEY) || '(none)').slice(0, 1500)}`,
      `auction: step ${state.aStep} | fails ${state.aFails} | incr ${state.aucIncr} | dur ${state.aucDur} | nf ${state.aucNf} | relist ${state.relistOn}`,
      `auction queue: ${(localStorage.getItem(AUC_QUEUE_KEY) || '(none)').slice(0, 1000)}`,
      `auction log: ${(localStorage.getItem(AUC_REG_KEY) || '(none)').slice(0, 1500)}`,
      `auctions page: ${/auctions\.phtml/i.test(location.pathname) ? `key ${pageRefCk() ? 'found' : 'NOT FOUND'} | rows ${mineRows().length}${mineRows()[0] ? ' | first: ' + JSON.stringify(mineRows()[0]) : ''}` : '(not on an auctions page)'}`,
      `SDB key: ${/safetydeposit/i.test(location.pathname) ? (sdbRefCk() ? 'found' : 'NOT FOUND') : '(not on SDB page)'}`,
      `gallery form: ${/\/gallery\//i.test(location.pathname)
        ? (document.querySelector('#quickremove_form') ? `found, ${galleryRows(document.querySelector('#quickremove_form')).length} rows` : 'NOT FOUND')
        : '(not on gallery page)'}`,
      '',
      '── popup candidates now ──',
      ...popupCandidates().map((p, i) => `[${i}] ${p.outerHTML.slice(0, 4000)}`),
      '',
      '── last auto-snapshot ──',
      snap ? `${snap.reason} @ ${snap.at} (${snap.hash})\n${snap.pops.join('\n\n') || '(no popup candidates found)'}` : '(none)'
    ];
    const text = lines.join('\n');
    try { GM_setClipboard(text); } catch (_) { /* ignore */ }
    const box = document.querySelector('#np-lister-diag');
    box.value = text;
    box.style.display = 'block';
    log('Diagnose DOM copied to clipboard');
  }

  /* ───────────────────────── UI ───────────────────────── */
  let ui, parts;
  function buildUI() {
    if (!document.querySelector('link[href*="family=Ubuntu"]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;700&display=swap';
      document.head.appendChild(l);
    }
    const css = document.createElement('style');
    css.textContent = `
      .np-lister{font:13px Ubuntu,sans-serif;color:#eee}
      .np-lister.pt-status{background:#232323;border:1px solid #444;border-radius:8px;padding:6px 8px;margin-bottom:10px}
      .np-lister .st-row{display:flex;align-items:center;gap:8px}
      .np-lister .st-row .status{flex:1;margin:0;font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .np-lister .st-row .halt{flex:0 0 auto;padding:4px 10px}
      .np-lister .st-dot{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#999}
      .np-lister details summary{cursor:pointer;font-size:11px;color:#999;margin-top:4px}
      .np-lister details[open] summary{margin-bottom:6px}
      .np-lister .cfg{margin-top:2px}
      .np-lister .cfg summary{font-size:13px !important;color:#dddddd !important}
      .np-lister .cfg label{font-size:14px !important;color:#eeeeee !important;margin-bottom:7px !important}
      .np-lister .cfg input,.np-lister .cfg select{font-size:14px !important;padding:4px 6px !important}
      .np-lister .cfg .wish{background:#1b1b1b;margin-top:6px}
      .np-lister .bar{display:none !important}
      .np-lister .body{padding:0 !important}
      .np-lister .bar{background:#e8a800;color:#2c2c2c;font-weight:700;padding:7px 10px;display:flex;
        justify-content:space-between;align-items:center;cursor:pointer;user-select:none}
      .np-lister .body{padding:10px}
      .np-lister.collapsed .body{display:none}
      .np-lister .row{display:flex;gap:6px;margin-bottom:8px}
      .np-lister button{flex:1;border:0;border-radius:4px;padding:7px 6px;font:700 12px Ubuntu,sans-serif;
        color:#fff;cursor:pointer}
      .np-lister .go{background:#3a9d4a}.np-lister .halt{background:#c0392b}
      .np-lister .diag{background:#555}.np-lister .reset{background:#444}
      .np-lister .stats{display:flex;justify-content:space-between;background:#222;border-radius:4px;
        padding:6px 8px;margin-bottom:8px}
      .np-lister .stats b{color:#e8a800}
      .np-lister .wish{background:#222;border-radius:4px;padding:6px 8px;margin-bottom:8px}
      .np-lister .wish label{display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:6px}
      .np-lister .wish input[type=text],.np-lister .wish input[type=number]{background:#111;color:#eee;border:1px solid #444;
        border-radius:3px;padding:4px 6px;font:12px Ubuntu,sans-serif;box-sizing:border-box}
      .np-lister .wish .w-tpl{width:100%;margin-bottom:6px}
      .np-lister .wish .w-num{width:70px}
      .np-lister .wish .hint{font-size:11px;color:#999}
      .np-lister .wish.off .w-fields{opacity:.45}
      .np-lister .queue{background:#222;border-radius:4px;padding:6px 8px;margin-bottom:8px}
      .np-lister .queue .q-info{margin-bottom:6px;color:#ddd}
      .np-lister .queue .q-info b{color:#e8a800}
      .np-lister .queue .row{margin-bottom:6px}
      .np-lister .queue label{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px;font-size:12px}
      .np-lister .queue select,.np-lister .queue input{background:#111;color:#eee;border:1px solid #444;border-radius:3px;
        padding:3px 5px;font:12px Ubuntu,sans-serif}
      .np-lister .queue .q-cap{width:60px}
      .np-lister .qgo{background:#b07800}
      .np-lister .ago{background:#8a4fbf}
      .np-lister .auc .q-incr{width:90px}
      .np-lister .auc .a-watch{font-size:11px;color:#999;margin-top:2px}
      .np-lister .auc label input[type=checkbox]{margin:0}
      .np-lister .a-items{margin:2px 0 6px}
      .np-lister .a-row{display:flex;align-items:center;gap:5px;margin-bottom:4px;font-size:12px}
      .np-lister .a-row .a-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ffd88a}
      .np-lister .a-row input{width:86px;background:#111;color:#eee;border:1px solid #444;border-radius:3px;padding:3px 5px;font:12px Ubuntu,sans-serif}
      .np-lister .a-row .a-x{flex:0 0 auto;background:none;color:#999;padding:0 4px;font-size:13px}
      .np-lister .a-row .a-x:hover{color:#e06060}
      .np-lister .a-sub{font-size:11px;color:#999;margin:4px 0 3px}
      .np-lister .acancel{background:#c0392b}
      .np-lister .acheck{background:#555}
      .np-lister .bar-note{flex:1;text-align:right;margin-right:8px;font-weight:400;font-size:11px}
      .np-lister .a-pcts{display:flex;gap:3px;margin:-1px 0 6px}
      .np-lister .a-pcts button{flex:1;background:#333;color:#ccc;padding:3px 0;font-size:11px}
      .np-lister .a-pcts button.on{background:#e8a800;color:#2c2c2c}
      .np-lister .status{margin-bottom:6px;color:#e8a800}
      .np-lister .log{max-height:140px;overflow:auto;font:11px monospace;color:#bbb;background:#222;
        border-radius:4px;padding:6px;white-space:pre-wrap}
      #np-lister-diag{display:none;width:100%;height:120px;margin-top:8px;font:10px monospace;
        background:#111;color:#9f9;border:0;border-radius:4px;box-sizing:border-box}
    `;
    document.head.appendChild(css);

    // Three pieces, mounted at the top of Listings → Trades / Auctions (the
    // status strip on both). ui answers querySelector across all of them.
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="np-lister pt-status">
        <div class="bar"><span>PBP · Lister v${VERSION}</span><span class="bar-note"></span><span class="tog">+</span></div>
        <div class="st-row"><span class="st-dot s-run">idle</span><span class="status">Idle</span><button class="halt" title="Stop whatever the Lister is doing">■ Stop</button></div>
        <details class="st-more"><summary>🤖 Log · lots <b class="s-lots">0</b> · items <b class="s-items">0</b></summary>
          <div class="log"></div>
          <div class="row" style="margin-top:6px;margin-bottom:0">
            <button class="diag">Diagnose DOM</button><button class="reset">Reset counts</button></div>
          <textarea id="np-lister-diag" readonly></textarea>
        </details>
      </div>
      <div class="np-lister pt-trades">
        <div class="queue">
          <div class="q-info">No queue</div>
          <div class="row"><button class="qgo" title="List the items sent with 🏷, and ↻ relists">▶ Run queue</button><button class="go" title="List everything in your inventory, 30 per lot, at the IB per lot set in ⚙ Lister settings">▶ List all</button></div>
          <details class="cfg"><summary>⚙ Lister settings</summary>
            <label>Take from <select class="q-order">${Object.entries(ORDERS).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
            <label>Lots per run <input type="number" class="q-cap" min="1" max="50" step="1"></label>
            <label title="▶ List all: the same instant-buy on every lot. Blank = no instant-buy. Over 20m it goes in the wishlist as an asking price.">List all IB per lot <input type="text" class="q-allib" inputmode="numeric" placeholder="none (e.g. 500k)"></label>
            <label title="Stretches every pause between clicks, pages and lots">Speed <select class="q-speed">${Object.entries(SPEEDS).sort((a, b) => a[0] - b[0]).map(([v, t]) => `<option value="${v}">${t} (${v}×)</option>`).join('')}</select></label>
            <div class="wish">
              <label><input type="checkbox" class="w-on"> Numbered wishlist</label>
              <div class="w-fields">
                <input type="text" class="w-tpl" maxlength="${WISH_MAX}" placeholder="Lot #{n}">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <span>Next # <input type="number" class="w-num" min="1" step="1"></span>
                  <span class="hint">{n} = lot number</span>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
      <div class="np-lister pt-auc">
        <div class="queue auc">
          <div class="q-info a-info">No auction queue</div>
          <div class="a-items"></div>
          <div class="row"><button class="ago" title="Put the items sent with 🔨 up for auction, one per item">▶ Run auctions</button><button class="acancel" title="Stop and clear the auction queue (auctions already up stay up)">✕ Cancel queue</button></div>
          <div class="a-watch"></div>
          <div class="row" style="margin:6px 0"><button class="acheck" title="Read My Auctioned Items now (opens it if you're elsewhere)">↻ Check auctions now</button></div>
          <details class="cfg"><summary>⚙ Auction settings</summary>
            <label>Min. increment <input type="text" class="q-incr" inputmode="numeric"></label>
            <label>Auction length <select class="a-dur">${AUC_DURATIONS.map(h => `<option value="${h}">${h < 24 ? h + ' hour' + (h === 1 ? '' : 's') : h / 24 + ' day' + (h === 24 ? '' : 's')}</option>`).join('')}</select></label>
            <label>Neofriends only <input type="checkbox" class="a-nf"></label>
            <label title="Unsold auctions are put back up once the item is back (about 15 min). Needs a tab open on My Auctioned Items.">Relist unsold <input type="checkbox" class="a-relist"></label>
            <label title="Stretches the gap between auctions and the pauses between pages">Speed <select class="a-speed">${Object.entries(SPEEDS).sort((a, b) => a[0] - b[0]).map(([v, t]) => `<option value="${v}">${t} (${v}×)</option>`).join('')}</select></label>
          </details>
        </div>
      </div>`;
    parts = { status: root.children[0], trades: root.children[1], auc: root.children[2] };
    ui = {
      classList: root.classList,
      querySelector(sel) {
        for (const p of Object.values(parts)) {
          if (p.matches(sel)) return p;
          const f = p.querySelector(sel);
          if (f) return f;
        }
        return null;
      }
    };

    ui.querySelector('.bar').onclick = () => {
      ui.classList.toggle('collapsed');
      ui.querySelector('.tog').textContent = ui.classList.contains('collapsed') ? '+' : '–';
    };
    // A run still marked as going (or stuck) never blocks a new one: ask, stop it, start
    const startFresh = (mode) => {
      if (state.running) {
        const what = state.mode === 'queue' ? 'the TP queue' : state.mode === 'auction' ? 'the auction queue' : 'List all';
        if (!confirm(`The Lister is still running ${what}${oldScript ? '' : ` (${clean(ui.querySelector('.status').textContent).slice(0, 80)})`}.\n\nStop it and start this instead?`)) return;
        stop('Stopped to start something else');
      }
      start(mode);
    };
    ui.querySelector('.go').onclick = () => startFresh('all');
    ui.querySelector('.qgo').onclick = () => startFresh('queue');
    ui.querySelector('.ago').onclick = () => startFresh('auction');
    ui.querySelector('.acheck').onclick = checkNow;
    ui.querySelector('.acancel').onclick = () => {
      const left = aucLeft(getAucQueue());
      if (!left && !getAucQueue()) return;
      if (left && !confirm(`Cancel the auction queue? ${left} item${left === 1 ? '' : 's'} won't be auctioned. Auctions already up stay up.`)) return;
      if (state.running && state.mode === 'auction') stop('Auction queue cancelled');
      state.aStep = null; save();
      localStorage.removeItem(AUC_QUEUE_KEY);
      host.onQueues();
      log('Auction queue cleared');
    };
    // Queued items: edit start price, remove. Unsold auctions: edit the relist price.
    const aItems = ui.querySelector('.a-items');
    aItems.addEventListener('change', (e) => {
      const el = e.target;
      const n = parseNP(el.value);
      if (el.classList.contains('a-start')) {
        const q = getAucQueue();
        const it = q && q.items[+el.dataset.i];
        if (!it) return render();
        if (n > 0) { it.start = n; saveAucQueue(q); log(`${it.name}: start price ${fmtNP(n)}`); }
        el.value = fmtNP(it.start);
      } else if (el.classList.contains('a-rprice')) {
        const r = getReg();
        const en = r.entries.find(x => x.key === el.dataset.key);
        if (!en) return render();
        if (n > 0) { en.base = en.base || en.start; en.start = n; saveReg(r); log(`${en.name}: relist price ${fmtNP(n)}`); }
        el.value = fmtNP(en.start);
      }
    });
    aItems.addEventListener('click', (e) => {
      const pb = e.target.closest('.a-pct');
      if (pb) {
        const r = getReg();
        const en = r.entries.find(x => x.key === pb.dataset.key);
        if (!en) return;
        en.base = en.base || en.start;
        en.start = dropPrice(en.base, +pb.dataset.p);
        saveReg(r);
        log(`${en.name}: relist at ${fmtNP(en.start)}${+pb.dataset.p ? ` (−${pb.dataset.p}%)` : ''}`);
        return;
      }
      const b = e.target.closest('.a-x');
      if (!b) return;
      if (b.dataset.i !== undefined) {
        const q = getAucQueue();
        if (!q || !q.items[+b.dataset.i]) return;
        const [it] = q.items.splice(+b.dataset.i, 1);
        saveAucQueue(q); log(`Removed ${it.name} from the auction queue`);
      } else if (b.dataset.key) {
        const r = getReg();
        const en = r.entries.find(x => x.key === b.dataset.key);
        if (!en || !confirm(`Don't relist ${en.name}? It stays in your inventory.`)) return;
        en.status = 'lost'; en.ended = new Date().toISOString(); saveReg(r);
        log(`${en.name}: won't be relisted`);
      }
    });
    const aIncr = ui.querySelector('.q-incr'), aDur = ui.querySelector('.a-dur'),
      aNf = ui.querySelector('.a-nf'), aRel = ui.querySelector('.a-relist');
    aIncr.value = (parseInt(state.aucIncr, 10) || 1).toLocaleString('en-US');
    aDur.value = String(AUC_DURATIONS.includes(+state.aucDur) ? +state.aucDur : 24);
    aNf.checked = !!state.aucNf;
    aRel.checked = !!state.relistOn;
    aIncr.onchange = () => {
      const n = npNum(aIncr.value);
      if (n >= 1) state.aucIncr = n;
      aIncr.value = (parseInt(state.aucIncr, 10) || 1).toLocaleString('en-US');
      save();
    };
    aDur.onchange = () => { state.aucDur = +aDur.value; save(); };
    aNf.onchange = () => { state.aucNf = aNf.checked; save(); };
    aRel.onchange = () => {
      state.relistOn = aRel.checked; save(); renderWatch();
      if (state.relistOn && onMinePage()) watchMine();
    };
    const qSpeed = ui.querySelector('.q-speed'), aSpeed = ui.querySelector('.a-speed'), qAllIb = ui.querySelector('.q-allib');
    qSpeed.value = String(okSpeed(state.tpSpeed));
    aSpeed.value = String(okSpeed(state.aucSpeed));
    qSpeed.onchange = () => { state.tpSpeed = okSpeed(qSpeed.value); save(); log(`TP speed: ${SPEEDS[state.tpSpeed]}`); };
    aSpeed.onchange = () => { state.aucSpeed = okSpeed(aSpeed.value); save(); log(`Auction speed: ${SPEEDS[state.aucSpeed]}`); };
    const showAllIb = () => { qAllIb.value = state.allIb > 0 ? fmtNP(state.allIb) : ''; };
    showAllIb();
    qAllIb.onchange = () => {
      const raw = qAllIb.value.trim();
      const n = parseNP(raw);
      if (!raw) state.allIb = 0;
      else if (n > 0) state.allIb = n;
      else host.toast('Price not understood — use 5000, 5k or 2.5m');
      save(); showAllIb();
      log(state.allIb ? `List all: ${fmtNP(state.allIb)} NP per lot${state.allIb > IB_CAP ? ' (wishlist ask, over 20m)' : ''}` : 'List all: no instant-buy');
    };
    const qOrder = ui.querySelector('.q-order'), qCap = ui.querySelector('.q-cap');
    qOrder.value = ORDERS[state.order] ? state.order : 'gallery,sdb,inventory';
    qCap.value = state.cap;
    qOrder.onchange = () => { state.order = qOrder.value; save(); };
    qCap.onchange = () => {
      const n = parseInt(qCap.value, 10);
      if (n >= 1 && n <= 50) { state.cap = n; save(); } else qCap.value = state.cap;
    };
    ui.querySelector('.halt').onclick = () => stop('Stopped by you');
    ui.querySelector('.diag').onclick = diagnose;
    const wOn = ui.querySelector('.w-on'), wTpl = ui.querySelector('.w-tpl'), wNum = ui.querySelector('.w-num');
    wOn.checked = !!state.wishOn;
    wTpl.value = state.wishTpl;
    wNum.value = state.nextNum;
    wOn.onchange = () => { state.wishOn = wOn.checked; save(); render(); };
    wTpl.oninput = () => { state.wishTpl = wTpl.value || 'Lot #{n}'; save(); };
    wNum.onchange = () => {
      const n = parseInt(wNum.value, 10);
      if (n >= 1) { state.nextNum = n; save(); } else wNum.value = state.nextNum;
    };
    ui.querySelector('.reset').onclick = () => {
      if (state.running) return;
      // Also drops a half-built queue lot; anything already pulled stays in inventory
      state.lots = 0; state.items = 0; state.log = []; state.qCur = null; state.qGot = null; state.qSrc = null;
      save(); render();
    };
    render();
  }

  // ↻ Check auctions now: always reads the page. A run still marked as going is offered a stop first.
  function checkNow() {
    if (state.running) {
      const what = state.mode === 'queue' ? 'the TP queue' : state.mode === 'auction' ? 'the auction queue' : 'List all';
      if (!confirm(`The Lister is still marked as running ${what}, which blocks reading My Auctioned Items.\n\nStop it and check auctions now?`)) return;
      stop('Stopped to check auctions');
    }
    if (onMinePage()) watchMine(); else location.href = AUC_MINE_URL;
  }

  function setBarNote(s) {
    if (ui) ui.querySelector('.bar-note').textContent = s;
    if (!state.running) host.setChip(s);
  }

  function setStatus(s) {
    if (state.running) { state.beat = Date.now(); save(); }
    if (ui) ui.querySelector('.status').textContent = s;
    if (state.running) host.setChip(s.length > 42 ? s.slice(0, 40) + '…' : s);
  }

  function render() {
    if (!ui) return;
    ui.querySelector('.s-lots').textContent = state.lots;
    ui.querySelector('.s-items').textContent = state.items;
    ui.querySelector('.s-run').textContent = state.running ? (state.mode === 'queue' ? 'queue' : state.mode === 'auction' ? 'auctions' : 'running') : 'idle';
    const q = getQueue();
    const left = queueLeft(q);
    ui.querySelector('.q-info').innerHTML = left
      ? `Queue: <b>${left}</b> item${left === 1 ? '' : 's'} · ${q.mode === 'packed' ? 'packed' : 'one type'} · lots of ${esc(q.lotSize)}`
        + (q.missing.length ? ` · <span style="color:#e06060">${q.missing.length} short</span>` : '')
      : (q && q.done.length ? `Queue finished · ${q.done.length} listed` : 'No queue — send one from the Tracker');
    ui.querySelector('.qgo').style.opacity = !left ? '.5' : '1';
    const aq = getAucQueue();
    const aLeft = aucLeft(aq);
    ui.querySelector('.a-info').innerHTML = aLeft
      ? `Auctions: <b>${aLeft}</b> item${aLeft === 1 ? '' : 's'} queued`
        + (aq.missing.length ? ` · <span style="color:#e06060">${aq.missing.length} short</span>` : '')
      : (aq && aq.done.length ? `Auction queue finished · ${aq.done.length} put up` : 'No auction queue — send one with 🔨 in the Tracker');
    renderAucItems(aq);
    ui.querySelector('.ago').style.opacity = !aLeft ? '.5' : '1';
    renderWatch();
    ui.querySelector('.wish').classList.toggle('off', !state.wishOn);
    const wNum = ui.querySelector('.w-num');
    if (wNum && document.activeElement !== wNum) wNum.value = state.nextNum;
    ui.querySelector('.log').innerHTML = state.log.map(esc).join('\n') || '—';
  }

  /* ───────────────────────── boot ───────────────────────── */
  function boot() {
    buildUI();
    window.addEventListener('hashchange', () => {
      if (!state.running || oldScript) return;
      if (state.mode === 'queue' && /tradingpost\.phtml/i.test(location.pathname)) setTimeout(runQueue, 800);   // Your Trades ↔ create
      else if (state.mode === 'all' && isCreateRoute()) setTimeout(runPass, 800);
    });
    // Another tab sent or changed a queue
    window.addEventListener('storage', e => { if (e.key === QUEUE_KEY || e.key === AUC_QUEUE_KEY || e.key === AUC_REG_KEY) render(); });
    // The old standalone Auto-Lister draws #pbp-tpl. Two engines would click everything twice.
    setTimeout(() => {
      if (document.getElementById('pbp-tpl')) {
        oldScript = true;
        setStatus('The old "PBP — Trading Post Auto-Lister" script is still on — turn it off in Tampermonkey, then reload');
        host.toast('⚠️ Turn off the old Auto-Lister script in Tampermonkey — the Lister is part of the Tracker now');
        return;
      }
      if (state.running && Date.now() - (state.beat || 0) > STALE_RUN) {
        // Marked running, but nothing has happened for ages (closed tab, crash, old version)
        stop(`The last ${state.mode === 'auction' ? 'auction' : state.mode === 'queue' ? 'queue' : ''} run had stopped responding — reset. Press ▶ to start again.`);
        if (onMinePage()) watchMine();
      } else if (state.running) {
        setStatus('Resuming…');
        resume();
      } else if (onMinePage()) {
        watchMine();
      }
      // Watchdog: a run with no progress for a while is stopped, so the buttons never stay dead
      setInterval(() => {
        if (state.running && !busy && Date.now() - (state.beat || 0) > STALL_AFTER * spd()) {
          snapshot('watchdog: no progress');
          stop(`Stalled — no progress for ${Math.round(STALL_AFTER * spd() / 60000)} min (${state.mode}${state.aStep ? ', ' + state.aStep : ''}${state.qCur ? ', step ' + (state.qCur.steps || [])[state.qCur.step] : ''}). Send Diagnose DOM if this repeats.`);
        }
      }, 30000);
    }, 1500);   // also lets the page (and an old script, if any) render
  }
  let oldScript = false;

  boot();
  return {
    // Listings → Trades / Auctions: { status, trades, auc } → containers (any may be missing)
    mount(where) {
      for (const [k, el] of Object.entries(where || {})) if (el && parts[k] && parts[k].parentNode !== el) el.appendChild(parts[k]);
      render();
    },
    mode: () => state.mode,
    render() { render(); },
    running: () => !!state.running && !oldScript,
    relistOn: () => !!state.relistOn,
    checkAuctions() { checkNow(); },
    // ↻ Relist now: start an auction run unless something is already running
    startAuctions() { if (state.running || oldScript) return false; start('auction'); return true; },
    startQueue() { if (state.running || oldScript) return false; start('queue'); return true; },
    // An auction run is going → items added to the queue now are picked up by it
    auctionRunning: () => !!state.running && state.mode === 'auction' && !oldScript
  };
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
  if (PERSONAL_BUILD) lister = autoLister(listerHost());   // 🤖 Lister: resumes a run on any of its pages
  if (window.location.href.includes('tradingpost.phtml')) {
    detectTrade();
    injectTrackerButton();
    if (isPanelPinned()) showTrackerPanel();   // 📌 pinned → open; otherwise closed until clicked
    // Quick Lookup's ＋ Log Buy on this same page → refresh the count (and an open panel)
    document.addEventListener('pbp-tracker-inbox', () => processTrackerInbox());
    // Quick Lookup changed the watchlist (this tab: custom event; other tabs: storage event)
    const watchChanged = () => {
      updateWatchBadges();
      const v = document.getElementById('np-view-watch');
      if (v && !v.classList.contains('np-hidden') && !watchBusy) renderWatchView();
    };
    document.addEventListener('pbp-watchlist-changed', watchChanged);
    window.addEventListener('storage', (e) => {
      if (e.key === WATCH_KEY) watchChanged();
      if (e.key === TRACKER_INBOX_KEY) processTrackerInbox();   // queued from another tab
      if (PERSONAL_BUILD && e.key === LISTER_QUEUE_KEY) renderListDrawer();   // Auto-Lister progress
      if (PERSONAL_BUILD && e.key === AUC_QUEUE_KEY) renderAucDrawer();
      if (PERSONAL_BUILD && e.key === AUC_REG_KEY) { processAuctionSales(); renderAucDrawer(); }
    });
    // Ignore changes inside our own panel/toast: redrawing the Offers tab
    // would otherwise trigger a rescan → redraw loop on the offer-made page.
    const ownNode = (r) => {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      return !!(el && el.closest && el.closest('#np-tracker-panel, .np-toast, #np-tracker-btn'));
    };
    const observer = new MutationObserver((recs) => {
      if (recs.length && recs.every(ownNode)) return;
      detectTrade(); detectLotPurchased(); detectOfferAccepted(); detectLotSold();
      scanOffersMade(); scanYourTrades();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(runBackgroundAlertCheck, 3000);
    setTimeout(processAuctionSales, 2000);   // auction sales the Lister found since the last visit
  } else if (window.location.pathname.includes('auctions.phtml')) {
    // The 🤖 Lister reads My Auctioned Items here and records sold auctions → log them
    injectTrackerButton();
    setTimeout(processAuctionSales, 2500);
    window.addEventListener('storage', (e) => { if (e.key === AUC_REG_KEY) processAuctionSales(); });
    // Same tab: the Lister writes localStorage, which fires no storage event here
    setInterval(processAuctionSales, 60000);
  } else if (/\/safetydeposit\.phtml|\/gallery\//i.test(window.location.pathname)) {
    // The 🤖 Lister's SDB / gallery steps: just the button (its note shows progress)
    if (PERSONAL_BUILD) injectTrackerButton();
  } else if (window.location.pathname.includes('browseshop.phtml')) {
    document.addEventListener('click', stashShopItem, true);
    const shopObserver = new MutationObserver(() => detectShopPurchase());
    shopObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  }

})();