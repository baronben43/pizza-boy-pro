// ==UserScript==
// @name         PBP Festival of Fears Dailies
// @namespace    pizzaboypro
// @version      1.0.1
// @description  Pizza Boy Pro — runs the Haunted Woods / Festival of Fears dailies from one button and logs prizes, NP and Fright Track points
// @match        https://www.neopets.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      itemdb.com.br
// @run-at       document-idle
// ==/UserScript==

// ════════════════════════════════════════════════════════════════════════════
// Activities, in run order:
//   1 Apple Bobbing        once/day                              10 pts
//   2 Test Your Strength   one swing per run (game allows 1 per 6h; direct GET, as the hammer does)  10 pts
//   3 Wheel of Misfortune  up to 2 spins/day (free + premium)     5 pts
//   4 Haunted Woods Hunt   one play/day                          15 pts
//   5 Grave Danger         send chosen petpet / claim on return    5 pts
//   6 Scratchcards         1 kiosk + SSW top-up to 5, never scratch keepers  5 pts
//   7 Brain Tree           accept → 2 Esophagor reveals → submit  35 pts
//   8 Esophagor            up to daily count (Brain Tree's 2 exempt) 15 pts
//   9 Edna                 up to daily count                      10 pts
//
// Pinned from Ben's HTML pastes (24 Oct 2026): Brain Tree, Esophagor, Edna,
// Apple Bobbing, Grave Danger send + timer, scratchcard kiosk/scratch/loss,
// Strength (strtestH5.js), Wheel (wheelgame.js), Hunt.
// Still candidates: Grave Danger return/claim page, Apple Bobbing prize popup,
// scratchcard win page, Hunt win popup, Edna/Esophagor "done for today" text.
// Anything unrecognised is logged as raw text and the activity moves on.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const VERSION = '1.0.1';
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // ─── Storage keys ─────────────────────────────────────────────────────────
  const K_SETTINGS = 'pbp_fof_settings';
  const K_RUN      = 'pbp_fof_run';
  const K_DAYS     = 'pbp_fof_days';      // { [nstDay]: dayState }
  const K_LOG      = 'pbp_fof_log';       // [entry]
  const K_IDB      = 'pbp_fof_itemdb';    // { [name]: { ts, price } }
  const K_PETPETS  = 'pbp_fof_petpets';   // { owner: petpetName }
  const K_UI       = 'pbp_fof_ui';

  const POINTS = { apple: 10, strength: 10, wheel: 5, hunt: 15, gravedanger: 5, scratch: 5, brain: 35, esophagor: 15, edna: 10 };
  const LABEL  = { apple: 'Apple Bobbing', strength: 'Test Your Strength', wheel: 'Wheel of Misfortune', hunt: 'Haunted Woods Hunt',
                   gravedanger: 'Grave Danger', scratch: 'Scratchcards', brain: 'Brain Tree', esophagor: 'Esophagor', edna: 'Edna' };
  const ORDER  = ['apple', 'strength', 'wheel', 'hunt', 'gravedanger', 'scratch', 'brain', 'esophagor', 'edna'];

  const KIOSK_CARDS = ['Crypt of Chance Scratchcard', 'Undead Jackpot of Doom Scratchcard', 'Mutating Millions Scratchcard',
                       'Pustravanganza Scratchcard', 'Rotting Riches Scratchcard'];
  const KIOSK_PRICE = 1200;
  const SCRATCH_PER_DAY = 5;
  const WHEEL_PER_DAY = 2;
  const REROLLS_PER_SLOT = 3;
  const VISIT_GUARD = 30;               // page visits per activity per run before giving up

  const URL = {
    apple: '/halloween/applebobbing.phtml',
    strength: '/halloween/strtest/index.phtml',
    wheel: '/halloween/wheel/',
    hunt: '/halloween/haunted_woods_hunt.phtml',
    gravedanger: '/halloween/gravedanger/index.phtml',
    scratch: '/halloween/scratch.phtml',
    brain: '/halloween/braintree.phtml',
    esophagor: '/halloween/esophagor.phtml',
    edna: '/halloween/witchtower.phtml',
    quickstock: '/quickstock.phtml',
  };

  const DEFAULTS = {
    enabled: { apple: true, strength: true, wheel: true, hunt: true, gravedanger: true, scratch: true, brain: true, esophagor: true, edna: true },
    esoCount: 5, esoMaxNP: 10000,
    ednaCount: 10, ednaMaxNP: 10000,
    gdPetpetOwner: '',
    scratchMaxNP: 100000,
    scratchBuy: { 'Crypt of Chance Scratchcard': true, 'Undead Jackpot of Doom Scratchcard': true, 'Mutating Millions Scratchcard': true },
    scratchKeep: { 'Pustravanganza Scratchcard': true, 'Rotting Riches Scratchcard': true },
  };

  // ─── Small helpers ────────────────────────────────────────────────────────
  const qs  = (s, r) => (r || document).querySelector(s);
  const qsa = (s, r) => [...(r || document).querySelectorAll(s)];
  const txt = el => (el && el.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const fmtNP = n => (Number(n) || 0).toLocaleString('en-US');
  const rand = (a, b) => a + Math.random() * (b - a);
  const DELAY_REACT = () => rand(900, 2600);
  const clean = s => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const toInt = s => { const n = parseInt(String(s || '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
  const path = () => location.pathname.replace(/\/index\.phtml$/, '/');
  const onPath = p => path() === p.replace(/\/index\.phtml$/, '/');

  function nstDay(d) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
  }

  function load(k, def) { try { const v = GM_getValue(k); return v === undefined ? def : JSON.parse(v); } catch { return def; } }
  function save(k, v) { GM_setValue(k, JSON.stringify(v)); }

  function settings() {
    const s = load(K_SETTINGS, {});
    return Object.assign({}, DEFAULTS, s, {
      enabled: Object.assign({}, DEFAULTS.enabled, s.enabled || {}),
      scratchBuy: Object.assign({}, s.scratchBuy || DEFAULTS.scratchBuy),
      scratchKeep: Object.assign({}, s.scratchKeep || DEFAULTS.scratchKeep),
    });
  }
  function saveSettings(s) { save(K_SETTINGS, s); }

  // Day state: what's done today, counters, Brain Tree answers, Grave Danger return time.
  function dayState() {
    const all = load(K_DAYS, {});
    const key = nstDay();
    if (!all[key]) all[key] = { done: {}, counts: {}, brain: {}, gd: {}, scratch: {} };
    // keep a week of day states
    const keys = Object.keys(all).sort();
    while (keys.length > 7) delete all[keys.shift()];
    save(K_DAYS, all);
    return all[key];
  }
  function updateDay(fn) {
    const all = load(K_DAYS, {});
    const key = nstDay();
    const d = all[key] || { done: {}, counts: {}, brain: {}, gd: {}, scratch: {} };
    fn(d);
    all[key] = d;
    save(K_DAYS, all);
    return d;
  }
  function markDone(act, why) { updateDay(d => { d.done[act] = why || true; }); log(LABEL[act] + ' done for today' + (why && why !== true ? ' (' + why + ')' : ''), 'ok'); }
  function bump(act, n) { return updateDay(d => { d.counts[act] = (d.counts[act] || 0) + (n || 1); }).counts[act]; }
  // Grave Danger is never "done" — it loops send/claim — so it only skips while the petpet is out.
  function isDone(act) {
    const d = dayState();
    if (act === 'gravedanger') return !!(d.gd.returnAt && Date.now() < d.gd.returnAt);
    return !!d.done[act];
  }

  // ─── Prize log ────────────────────────────────────────────────────────────
  function record(act, o) {
    const entries = load(K_LOG, []);
    const e = Object.assign({ ts: Date.now(), day: nstDay(), act, items: [], np: 0, spent: 0, points: 0, note: '' }, o);
    e.note = clean(e.note); e.items = (e.items || []).map(clean).filter(Boolean);
    entries.push(e);
    save(K_LOG, entries);
    const bits = [];
    if (e.items.length) bits.push(e.items.join(', '));
    if (e.np) bits.push('+' + fmtNP(e.np) + ' NP');
    if (e.spent) bits.push('spent ' + fmtNP(e.spent) + ' NP');
    if (e.points) bits.push('+' + e.points + ' pts');
    log(LABEL[act] + ': ' + (bits.join(' · ') || e.note || 'logged'), 'prize');
    renderPanel();
  }

  // ─── Run state ────────────────────────────────────────────────────────────
  function run() { return load(K_RUN, { active: false }); }
  function saveRun(r) { save(K_RUN, r); }
  function updateRun(fn) { const r = run(); fn(r); saveRun(r); return r; }
  const aborted = () => !run().active;

  async function abortableSleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (aborted()) return false;
      await new Promise(r => setTimeout(r, Math.min(400, end - Date.now())));
    }
    return !aborted();
  }
  // Human pacing: a reaction delay, and now and then a longer "distraction" pause.
  async function humanPause() {
    if (Math.random() < 0.06) { const ms = rand(15000, 45000); setStatus('Short pause (' + Math.round(ms / 1000) + 's)…'); return abortableSleep(ms); }
    return abortableSleep(DELAY_REACT());
  }

  async function waitForEl(fn, ms) {
    const end = Date.now() + (ms || 10000);
    while (Date.now() < end) {
      if (aborted()) return null;
      let v = null;
      try { v = fn(); } catch { v = null; }
      if (v) return v;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }

  async function go(url) {
    if (!await humanPause()) return;
    location.href = url;
  }

  // Count visits so a page that never resolves can't loop forever.
  function visit(act) {
    const r = updateRun(x => { x.visits = x.visits || {}; x.visits[act] = (x.visits[act] || 0) + 1; });
    return r.visits[act];
  }

  function advance(note) {
    if (note) log(note);
    updateRun(r => { r.idx++; r.sub = {}; });
  }

  function insertNext(acts) { updateRun(r => { r.queue.splice(r.idx + 1, 0, ...acts); }); }

  function startRun(queue, label) {
    const s = settings();
    const q = (queue || ORDER).filter(a => s.enabled[a]);
    saveRun({ active: true, queue: q, idx: 0, sub: {}, visits: {}, started: Date.now(), label: label || 'Run dailies' });
    log((label || 'Run dailies') + ' started: ' + q.map(a => LABEL[a]).join(' → '), 'ok');
    renderPanel();
    tick();
  }
  function stopRun(why) {
    updateRun(r => { r.active = false; r.buy = null; });
    log('Stopped' + (why ? ': ' + why : ''), why ? 'warn' : '');
    renderPanel();
  }

  // ─── Firefox-safe input setter ────────────────────────────────────────────
  function setInput(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    desc.set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  }

  function mainContent() { return qs('#container__2020') || qs('td.content') || document.body; }

  // ─── SSW search + shop buy (lib/ssw-buy.js, lifted from Auto Trainer 1.4.5) ─
  const SSW_QUERY = '/np-templates/views/shops/ssw/ssw_query.php';

  async function sswSearch(name, maxPrice) {
    const p = new URLSearchParams({
      q: name, caller: 'h5', priceOnly: '0', context: '0', partial: '0',
      min_price: '0', max_price: String(maxPrice), lang: 'en', json: '1',
      cb: String(Math.floor(100000 + Math.random() * 900000)),
    });
    let data;
    try {
      const res = await fetch(SSW_QUERY + '?' + p.toString(), { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      data = await res.json();
    } catch (e) {
      return { error: 'SSW request failed (' + (e && e.message || 'not JSON') + ')', shops: [] };
    }
    const err = data && data.data && data.data.error;
    const html = (data && data.html) || '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lis = [...doc.querySelectorAll('.ssw-results-grid ul li')].slice(1);
    const shops = [];
    for (const li of lis) {
      const a = li.querySelector('.ssw-results-grid-user a');
      const pr = li.querySelector('.ssw-results-grid-price');
      if (!a || !pr) continue;
      const price = toInt(pr.textContent);
      if (!price || price > maxPrice) continue;
      shops.push({ owner: txt(a), shopUrl: new window.URL(a.getAttribute('href') || '', location.origin).href, price });
    }
    shops.sort((x, y) => x.price - y.price);
    if (!shops.length && err && String(err).trim()) return { error: String(err).replace(/<[^>]+>/g, '').trim(), shops };
    return { shops };
  }
  const sswLooksBanned = msg => /too many|too busy|try again|slow down|wait/i.test(msg || '');
  function shopOwnerParam(url) {
    try { return (new window.URL(url, location.origin).searchParams.get('owner') || '').toLowerCase(); } catch { return ''; }
  }

  async function buyOneFromShop(itemName, maxNP) {
    const btns = () => qsa('button.bsp-item__buy[data-name]');
    await waitForEl(() => btns().length || null, 10000);
    if (aborted()) return { bought: false, reason: 'aborted' };
    if (!await abortableSleep(DELAY_REACT())) return { bought: false, reason: 'aborted' };
    const want = itemName.toLowerCase();
    const btn = btns().find(b => (b.dataset.name || '').trim().toLowerCase() === want);
    if (!btn) return { bought: false, reason: 'not in stock any more' };
    const paid = parseInt(btn.dataset.price, 10);
    const url = btn.dataset.buyUrl;
    if (Number.isFinite(paid) && paid > maxNP) return { bought: false, reason: 'price now ' + fmtNP(paid) + ' NP' };
    if (!url) return { bought: false, reason: 'no buy link' };
    if (!await abortableSleep(300 + Math.random() * 600)) return { bought: false, reason: 'aborted' };
    try {
      const res = await fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'ajax=1', {
        method: 'GET', credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      const data = await res.json().catch(() => null);
      if (data && data.success) return { bought: true, paid };
      const reason = (data && data.message) ? String(data.message).replace(/<[^>]+>/g, '').trim() : 'purchase rejected';
      return { bought: false, reason, inventoryFull: /inventory|maximum of 50|too many items/i.test(reason) };
    } catch (e) {
      return { bought: false, reason: 'network error' };
    }
  }

  // Search one item, waiting out an SSW refusal once (~30 min) rather than giving up.
  async function priceOne(name, maxNP) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!await abortableSleep(rand(1200, 2600))) return { aborted: true };
      const r = await sswSearch(name, maxNP);
      if (r.error && sswLooksBanned(r.error)) {
        log('SSW says "' + r.error + '" — pausing ~30 min', 'warn');
        setStatus('SSW cooldown, waiting ~30 min…');
        if (!await abortableSleep(rand(29, 33) * 60000)) return { aborted: true };
        continue;
      }
      return { shops: r.shops.slice(0, 5), error: r.error };
    }
    return { shops: [], error: 'SSW still refusing' };
  }

  // Price every item first (Kitchen Quest rule). Returns { plan, missing:[name] }.
  async function priceAll(names, maxNP) {
    const plan = [], missing = [];
    for (const name of names) {
      setStatus('Pricing ' + name + '…');
      const r = await priceOne(name, maxNP);
      if (r.aborted) return { aborted: true };
      if (!r.shops.length) missing.push(name);
      else plan.push({ name, shops: r.shops, done: false, tries: 0, researched: false });
    }
    return { plan, missing };
  }

  // Hand off to the shop-page buyer; it comes back to returnUrl with run.buyResult set.
  function startBuy(plan, maxNP, tag, returnUrl) {
    updateRun(r => { r.buy = { plan, maxNP, tag, returnUrl, spent: 0, failed: null }; r.buyResult = null; });
    const first = plan[0];
    log('Buying ' + plan.length + ' item(s): ' + plan.map(p => p.name + ' @ ' + fmtNP(p.shops[0].price)).join(', '));
    go(first.shops[0].shopUrl);
  }

  function finishBuy(ok) {
    const r = run();
    const b = r.buy;
    updateRun(x => { x.buyResult = { tag: b.tag, ok, spent: b.spent, failed: b.failed, inventoryFull: !!b.inventoryFull }; x.buy = null; });
    go(b.returnUrl);
  }

  async function handleShopPage() {
    const r = run();
    const b = r.buy;
    const cur = b.plan.find(p => !p.done);
    if (!cur) return finishBuy(true);
    const shop = cur.shops[cur.tries];
    if (!shop) return finishBuy(false);
    // Only act on the shop this script navigated to.
    if (shopOwnerParam(location.href) !== shopOwnerParam(shop.shopUrl)) return;
    setStatus('Buying ' + cur.name + ' from ' + shop.owner + '…');
    const res = await buyOneFromShop(cur.name, b.maxNP);
    if (aborted()) return;
    const b2 = run().buy;
    const c2 = b2.plan.find(p => p.name === cur.name && !p.done);
    if (res.bought) {
      c2.done = true; c2.paid = res.paid; b2.spent += res.paid || 0;
      log('Bought ' + cur.name + ' for ' + fmtNP(res.paid) + ' NP', 'ok');
    } else {
      log(cur.name + ' at ' + shop.owner + ': ' + res.reason, 'warn');
      if (res.inventoryFull) { b2.failed = cur.name; b2.inventoryFull = true; updateRun(x => { x.buy = b2; }); return finishBuy(false); }
      c2.tries++;
      if (c2.tries >= c2.shops.length) {
        if (!c2.researched) {
          c2.researched = true;
          updateRun(x => { x.buy = b2; });
          const again = await priceOne(cur.name, b2.maxNP);
          if (again.aborted) return;
          const b3 = run().buy;
          const c3 = b3.plan.find(p => p.name === cur.name && !p.done);
          c3.shops = again.shops; c3.tries = 0;
          updateRun(x => { x.buy = b3; });
          if (!again.shops.length) { b3.failed = cur.name; updateRun(x => { x.buy = b3; }); return finishBuy(false); }
          return go(c3.shops[0].shopUrl);
        }
        b2.failed = cur.name;
        updateRun(x => { x.buy = b2; });
        return finishBuy(false);
      }
    }
    updateRun(x => { x.buy = b2; });
    const next = b2.plan.find(p => !p.done);
    if (!next) return finishBuy(true);
    go(next.shops[next.tries].shopUrl);
  }

  // ─── itemdb (anonymous API, as Quick Lookup) ──────────────────────────────
  function itemdbPrice(name) {
    const cache = load(K_IDB, {});
    const c = cache[name];
    if (c && Date.now() - c.ts < 24 * 3600e3) return Promise.resolve(c.price);
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: 'https://itemdb.com.br/api/v1/items/' + encodeURIComponent(name),
        headers: { Accept: 'application/json' },
        onload: res => {
          if (res.status === 401) return resolve('session');
          try {
            const d = JSON.parse(res.responseText);
            const price = d && d.price ? d.price.value : null;
            const all = load(K_IDB, {});
            all[name] = { ts: Date.now(), price };
            save(K_IDB, all);
            resolve(price);
          } catch { resolve(null); }
        },
        onerror: () => resolve(null),
      });
    });
  }

  // ─── Prize parsing ────────────────────────────────────────────────────────
  function npFrom(s) {
    const m = String(s || '').replace(/ /g, ' ').match(/([\d,]+)\s*(?:NP|Neopoints)\b/i);
    return m ? toInt(m[1]) : 0;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // ACTIVITY HANDLERS — each returns when it has navigated, advanced or stopped.
  // ═════════════════════════════════════════════════════════════════════════

  const H = {};

  // 1 ─ Apple Bobbing ────────────────────────────────────────────────────────
  H.apple = async () => {
    if (!onPath(URL.apple)) return go(URL.apple);
    const page = txt(mainContent());
    if (/already let you have a go at Apple Bobbing today/i.test(page)) { markDone('apple', 'already bobbed'); return advance(); }
    if (/bobbing=1/.test(location.search)) {
      const pop = await waitForEl(() => { const p = qs('#apple_bobbing_popup'); return p && txt(p) ? p : null; }, 6000);
      const ptxt = pop ? txt(pop) : '';
      const item = pop ? (txt(qs('b, strong', qs('.popup-body__2020', pop) || pop)) || '') : '';
      const win = !!qs('#bob_bg.win');
      record('apple', { items: item ? [item] : [], np: npFrom(ptxt), points: POINTS.apple, note: ptxt.slice(0, 200) || (win ? 'win (prize not read)' : 'no prize text') });
      markDone('apple');
      return advance();
    }
    const link = qs('a[href*="applebobbing.phtml?bobbing=1"]');
    if (!link) { log('Apple Bobbing: no Bob button and no "already" text', 'warn'); markDone('apple', 'unrecognised page'); return advance(); }
    return go(link.href);
  };

  // 2 ─ Test Your Strength ───────────────────────────────────────────────────
  H.strength = async () => {
    if (!onPath(URL.strength)) return go(URL.strength);
    if (/already played this game within the last/i.test(txt(mainContent()))) { markDone('strength', 'already swung (once per 6 hours)'); return advance(); }
    if (!await abortableSleep(rand(3500, 8000))) return;
    setStatus('Test Your Strength swing…');
    let data = null, raw = '';
    try {
      const res = await fetch('/np-templates/ajax/process_strtest.php', { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      raw = await res.text();
      data = JSON.parse(raw);
    } catch { data = null; }
    const msg = clean(data && data.message ? data.message : '');
    if (!data || !/scored\s+\d+/i.test(msg)) {
      const why = /already played/i.test(raw) ? 'already swung (once per 6 hours)' : 'unknown reply';
      if (why === 'unknown reply') log('Strength reply not a prize: ' + (msg || clean(raw)).slice(0, 160), 'warn');
      markDone('strength', why);
      return advance();
    }
    const score = (msg.match(/scored\s+(\d+)\s+out of/i) || [])[1];
    const item = (msg.match(/won an? (.+?)!/i) || [])[1];
    bump('strength');
    record('strength', { items: item && !/neopoints/i.test(item) ? [item] : [], np: npFrom(msg), points: POINTS.strength, note: clean(data.score) + (score ? ' — ' + score + '/100' : '') });
    markDone('strength', 'swung — next one in 6 hours');
    return advance();
  };

  // 3 ─ Wheel of Misfortune (free spin only) ─────────────────────────────────
  H.wheel = async () => {
    if (!onPath(URL.wheel)) return go(URL.wheel);
    await waitForEl(() => qs('#wheelCanvas canvas'), 10000);
    if (!await abortableSleep(2500)) return;
    const btn = qs('#wheelButtonSpin');
    if ((dayState().counts.wheel || 0) >= WHEEL_PER_DAY) { markDone('wheel', WHEEL_PER_DAY + ' spins'); return advance(); }
    if (isVisible(qs('#wheelDonePopup')) || !btn || !isVisible(btn)) { markDone('wheel', 'no spins left'); return advance(); }
    if (!await humanPause()) return;
    btn.click();
    const claim = await waitForEl(() => isVisible(qs('#clickToShowPrize')) || isVisible(qs('#wheelPrizePopup')) ? true : null, 30000);
    if (!claim) { record('wheel', { points: POINTS.wheel, note: 'spun, prize not read (no claim prompt)' }); return wheelNext(); }
    if (!isVisible(qs('#wheelPrizePopup'))) {
      if (!await abortableSleep(DELAY_REACT())) return;
      clickCanvasCentre(qs('#wheelCanvas canvas') || qs('canvas', mainContent()));
    }
    const shown = await waitForEl(() => isVisible(qs('#wheelPrizePopup')) ? true : null, 8000);
    if (!shown) { record('wheel', { points: POINTS.wheel, note: 'spun, prize not read' }); return wheelNext(); }
    const ok = isVisible(qs('#responseDisplaySuccess'));
    const item = ok ? txt(qs('#itemName')) : '';
    const msg = ok ? txt(qs('#spinMessage')) : txt(qs('#failMessage'));
    record('wheel', { items: item ? [item] : [], np: npFrom(msg + ' ' + item), points: POINTS.wheel, note: msg });
    return wheelNext();
  };

  // After a spin: reload for the premium second spin, or finish.
  function wheelNext() {
    const n = bump('wheel');
    if (n >= WHEEL_PER_DAY) { markDone('wheel', n + ' spins'); return advance(); }
    return go(URL.wheel);
  }

  function clickCanvasCentre(c) {
    if (!c) return;
    const r = c.getBoundingClientRect();
    const x = r.left + r.width / 2 + rand(-8, 8), y = r.top + r.height / 2 + rand(-8, 8);
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    for (const t of ['pointerover', 'pointerdown', 'mousedown']) c.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
    for (const t of ['pointerup', 'mouseup', 'click']) c.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o));
  }

  // 4 ─ Haunted Woods Hunt ───────────────────────────────────────────────────
  H.hunt = async () => {
    if (!onPath(URL.hunt)) return go(URL.hunt);
    if (/[?&]spot=/.test(location.search)) {
      await waitForEl(() => qsa('.popup-body__2020').some(e => txt(e).length > 30) ? true : null, 5000);
      const pops = qsa('.popup-body__2020').map(txt).filter(t => t.length > 30);
      const t = pops.find(p => /collect|smell|find|found|treasure|you/i.test(p)) || pops[0] || '';
      const nothing = /nothing to collect/i.test(t);
      const item = nothing ? '' : ((t.match(/(?:found|find|discover(?:ed)?|receive[ds]?|get|got)\s+(?:an?\s+|some\s+)?([A-Z][^.!]{2,60})[.!]/) || [])[1] || '');
      bump('hunt');
      record('hunt', { items: item ? [item] : [], np: npFrom(t), points: POINTS.hunt, note: nothing ? 'nothing to collect' : t.slice(0, 220) });
      markDone('hunt', 'played');
      return advance();
    }
    const page = txt(mainContent());
    if (/may need a special item/i.test(page)) { markDone('hunt', 'no free plays left'); return advance(); }
    const overlays = huntOverlays();
    if (!overlays.length) { log('Hunt: no clickable items found on the page', 'warn'); markDone('hunt', 'no items'); return advance(); }
    const pick = overlays[Math.floor(Math.random() * overlays.length)];
    log('Hunt: picking ' + pick.name);
    return go(pick.url);
  };

  function huntOverlays() {
    for (const s of qsa('script')) {
      const m = (s.textContent || '').match(/overlays\s*:\s*(\[[\s\S]*?\])\s*\}/);
      if (!m) continue;
      try { return JSON.parse(m[1]).filter(o => o && o.url && /spot=\d+&key=/.test(o.url)); } catch { /* next */ }
    }
    return [];
  }

  // 5 ─ Grave Danger ─────────────────────────────────────────────────────────
  H.gravedanger = async () => {
    if (!onPath(URL.gravedanger)) return go(URL.gravedanger);
    readPetpets();
    const s = settings();

    // Petpet out adventuring: store the exact return time and move on.
    const target = gdTarget();
    if (qs('#gdActive') && target) {
      updateDay(d => { d.gd.returnAt = target * 1000; });
      log('Grave Danger: petpet back at ' + new Date(target * 1000).toLocaleTimeString() + ' (' + txt(qs('#gdRemaining')) + ')');
      return advance();
    }

    // Choose screen: send the chosen petpet.
    if (qs('#gdSelection .petpet')) {
      if (run().sub.gdClaimTried && !run().sub.gdLogged) {
        const raw = txt(mainContent()).slice(0, 400);
        record('gravedanger', { np: npFrom(raw), points: POINTS.gravedanger, note: raw.slice(0, 220) });
        updateRun(x => { x.sub.gdLogged = true; });
        updateDay(x => { x.gd.returnAt = 0; });
      }
      if (!s.gdPetpetOwner) { log('Grave Danger: pick a petpet in the panel first', 'warn'); return advance(); }
      const card = qs('#gdSelection .petpet[data-neopet="' + CSS.escape(s.gdPetpetOwner) + '"]');
      if (!card) { log('Grave Danger: ' + s.gdPetpetOwner + "'s petpet isn't on the list", 'warn'); return advance(); }
      const ppName = txt(qs('.petpetName', card));
      if (!await humanPause()) return;
      card.click();
      const sel = await waitForEl(() => { const b = qs('#gdSelection button.select'); return b && !b.disabled ? b : null; }, 6000);
      if (!sel) { log('Grave Danger: "Choose a Petpet!" never enabled', 'warn'); return advance(); }
      if (!await abortableSleep(DELAY_REACT())) return;
      sel.click();
      const pop = await waitForEl(() => { const p = qs('#gd-selectppPopup2021'); return p && isVisible(p) ? p : null; }, 6000);
      const confirm = pop && qs('button.select', pop);
      if (!confirm) { log('Grave Danger: confirm popup not found', 'warn'); return advance(); }
      const line = txt(qs('.petpet-confirm', pop));
      if (ppName && line.indexOf(ppName) === -1) { log('Grave Danger: confirm names "' + line + '", expected ' + ppName + ' — not sending', 'warn'); return advance(); }
      if (!await abortableSleep(DELAY_REACT())) return;
      updateRun(r => { r.sub.gdSent = true; });
      log('Grave Danger: sending ' + ppName);
      confirm.click();          // posts #gdForm → page reloads onto the timer page
      return;
    }

    // Anything else is the (unseen) return page: try a claim button, log what's there.
    const raw = txt(mainContent()).slice(0, 400);
    if (!run().sub.gdClaimTried) {
      const claim = qsa('button, input[type=submit]', mainContent()).find(b => {
        const t = (b.value || txt(b) || '');
        return /claim|collect|retrieve|welcome back|open/i.test(t) && !/cookie|mall|nc\b|neocash/i.test(t);
      });
      if (claim) {
        updateRun(r => { r.sub.gdClaimTried = true; });
        log('Grave Danger: pressing "' + (claim.value || txt(claim)) + '"');
        if (!await humanPause()) return;
        claim.click();
        await abortableSleep(3000);
        if (aborted()) return;
        if (onPath(URL.gravedanger) && !qs('#gdSelection .petpet')) return H.gravedanger();
        return;
      }
    }
    const items = qsa('img.item, .item-name, .prize b', mainContent()).map(e => e.alt || txt(e)).filter(Boolean).slice(0, 6);
    record('gravedanger', { items, np: npFrom(raw), points: POINTS.gravedanger, note: raw.slice(0, 220) });
    updateDay(d => { d.gd.returnAt = 0; });
    if (visit('gravedanger_odd') > 3) { log('Grave Danger: return page not recognised — paste it for pinning', 'warn'); return advance(); }
    return go(URL.gravedanger);    // back to the choose screen to resend
  };

  function gdTarget() {
    for (const s of qsa('script')) { const m = (s.textContent || '').match(/target\s*:\s*(\d{9,})/); if (m) return parseInt(m[1], 10); }
    return 0;
  }
  function readPetpets() {
    for (const s of qsa('script')) {
      const m = (s.textContent || '').match(/petpets\s*:\s*(\{[^}]*\})/);
      if (!m) continue;
      try { save(K_PETPETS, JSON.parse(m[1])); return; } catch { /* next */ }
    }
  }

  // 6 ─ Scratchcards ─────────────────────────────────────────────────────────
  const scratchable = name => {
    const s = settings();
    return KIOSK_CARDS.indexOf(name) !== -1 && !s.scratchKeep[name];
  };

  H.scratch = async () => {
    const d = dayState();
    if ((d.counts.scratch || 0) >= SCRATCH_PER_DAY) { markDone('scratch', SCRATCH_PER_DAY + ' scratched'); return advance(); }

    // Mid-card: scratch squares, or read the result.
    if (onPath('/halloween/scratch2.phtml') || onPath('/halloween/process_scratch.phtml')) return scratchCardPage();
    if (!onPath(URL.scratch)) return go(URL.scratch);
    if (/in the middle of scratching your card/i.test(txt(mainContent()))) {
      log('Scratchcards: a card was left half-scratched — continuing it');
      return go('/halloween/scratch2.phtml');
    }

    const r = run();
    // SSW top-up came back.
    if (r.buyResult && r.buyResult.tag === 'scratch') {
      const br = r.buyResult;
      updateRun(x => { x.buyResult = null; });
      if (br.spent) record('scratch', { spent: br.spent, note: 'SSW scratchcards' + (br.failed ? ' (could not buy ' + br.failed + ')' : '') });
      else if (br.failed) log('Scratchcards: could not buy ' + br.failed, 'warn');
    }

    // Kiosk buy first (just the one, no cooldown waiting).
    const bought = qs('center font[color="green"]') && /Thanksss for buying/i.test(txt(mainContent()));
    if (bought && !d.scratch.kioskLogged) {
      const card = txt(qsa('center b', mainContent()).find(b => /Scratchcard/i.test(txt(b))));
      updateDay(x => { x.scratch.kioskLogged = true; });
      if (card && settings().scratchKeep[card]) {
        const v = await itemdbPrice(card);
        record('scratch', { items: [card], spent: KIOSK_PRICE, note: 'kiosk card — kept, not scratched' + (typeof v === 'number' ? ' (itemdb ' + fmtNP(v) + ' NP)' : '') });
      } else record('scratch', { items: card ? [card] : [], spent: KIOSK_PRICE, note: 'kiosk card' });
    }
    if (!d.scratch.kioskTried) {
      const form = qsa('form[action*="process_scratch.phtml"]').find(f => qs('input[type=submit]', f) && /take one/i.test(qs('input[type=submit]', f).value));
      updateDay(x => { x.scratch.kioskTried = true; });
      if (form) {
        log('Scratchcards: buying one at the kiosk (' + fmtNP(KIOSK_PRICE) + ' NP)');
        if (!await humanPause()) return;
        qs('input[type=submit]', form).click();
        return;
      }
      log('Scratchcards: kiosk buy button not found', 'warn');
    }

    // Cards held for this kiosk.
    const select = qs('select[name="card_id"]');
    const held = select ? qsa('option', select).filter(o => o.value && scratchable(txt(o))) : [];
    const need = SCRATCH_PER_DAY - (dayState().counts.scratch || 0);

    // Top up from the SSW once per day.
    if (held.length < need && !dayState().scratch.toppedUp) {
      updateDay(x => { x.scratch.toppedUp = true; });
      const s = settings();
      const names = KIOSK_CARDS.filter(n => s.scratchBuy[n] && !s.scratchKeep[n]);
      if (names.length) {
        const offers = [];
        for (const n of names) {
          setStatus('Pricing ' + n + '…');
          const pr = await priceOne(n, s.scratchMaxNP);
          if (pr.aborted) return;
          pr.shops.forEach(sh => offers.push({ name: n, shop: sh }));
        }
        offers.sort((a, b) => a.shop.price - b.shop.price);
        const want = need - held.length;
        const plan = [];
        const used = new Set();
        for (const o of offers) {
          if (plan.length >= want) break;
          const key = o.name + '|' + o.shop.owner;
          if (used.has(key)) continue;
          used.add(key);
          // each purchase gets its own shop list: this shop first, then other shops for the same card
          const alts = offers.filter(x => x.name === o.name && !used.has(x.name + '|' + x.shop.owner)).map(x => x.shop);
          plan.push({ name: o.name, shops: [o.shop, ...alts.slice(0, 3)], done: false, tries: 0, researched: true });
        }
        if (plan.length) return startBuy(plan, s.scratchMaxNP, 'scratch', URL.scratch);
        log('Scratchcards: none of the ticked cards on the SSW under ' + fmtNP(s.scratchMaxNP) + ' NP', 'warn');
      }
    }

    if (!held.length) { markDone('scratch', 'no scratchable cards'); return advance(); }

    // Scratch the first scratchable card.
    const opt = held[0];
    const form = select.closest('form');
    updateRun(x => { x.sub.card = { id: opt.value, name: txt(opt), clicked: [] }; });
    log('Scratchcards: scratching ' + txt(opt));
    if (!await humanPause()) return;
    select.value = opt.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const sub = qs('input[type=submit]', form);
    if (sub) sub.click(); else form.submit();
  };

  async function scratchCardPage() {
    const page = txt(mainContent());
    const squares = qsa('a[href*="process_scratch.phtml?type=scratch&loc="]');
    const card = run().sub.card || { name: '', clicked: [] };
    const verdict = !squares.length && (/Sidney says/i.test(page) || /looserkeeper|winnerkeeper|winkeeper/.test(mainContent().innerHTML));
    if (verdict) {
      const lost = /wrong thingss/i.test(page);
      const prize = lost ? '' : (txt(qsa('b, strong', mainContent()).find(b => !/Sidney|Scratch/i.test(txt(b)))) || '');
      bump('scratch');
      record('scratch', { items: prize ? [prize] : [], np: lost ? 0 : npFrom(page), points: POINTS.scratch, note: (card.name || 'card') + (lost ? ' — no win' : ' — ' + page.slice(0, 160)) });
      updateRun(x => { x.sub.card = null; });
      return go(URL.scratch);
    }
    if (squares.length) {
      if ((card.clicked || []).length >= 6) { log('Scratchcards: 6 squares done but no result text', 'warn'); return go(URL.scratch); }
      const left = squares.filter(a => (card.clicked || []).indexOf(a.href) === -1);
      const pick = (left.length ? left : squares)[Math.floor(Math.random() * (left.length || squares.length))];
      updateRun(x => { x.sub.card = Object.assign({ name: '', clicked: [] }, x.sub.card); x.sub.card.clicked.push(pick.href); });
      return go(pick.href);
    }
    if (visit('scratch_odd') > 6) { log('Scratchcards: page not recognised — ' + page.slice(0, 160), 'warn'); markDone('scratch', 'scratch page not recognised'); return advance(); }
    return go(onPath('/halloween/scratch2.phtml') ? URL.scratch : '/halloween/scratch2.phtml');
  }

  // 7 ─ Brain Tree ───────────────────────────────────────────────────────────
  H.brain = async () => {
    if (!onPath(URL.brain)) return go(URL.brain);
    const box = () => qs('#braintree_container') || mainContent();
    const page = txt(mainContent());

    if (/already been on a Brain Tree quest today/i.test(page)) { markDone('brain', 'already done'); return advance(); }

    if (/Thank you, you are correct/i.test(page)) return brainReward();

    const accept = qs('#acceptquest');
    if (accept) {
      if (!await humanPause()) return;
      accept.click();
      const form = await waitForEl(() => qs('#person'), 10000);
      if (!form) { log('Brain Tree: quest form did not appear after accepting', 'warn'); markDone('brain', 'accept failed'); return advance(); }
    }

    const person = qs('#person');
    if (!person) {
      if (visit('brain_odd') > 3) { log('Brain Tree: page not recognised', 'warn'); markDone('brain', 'unrecognised'); return advance(); }
      return go(URL.brain);
    }
    const name = (person.value || '').replace(/ /g, ' ').trim();
    const d = updateDay(x => { if (x.brain.person !== name) x.brain = { person: name }; x.brain.status = 'accepted'; });

    if (!d.brain.year || !d.brain.place) {
      log('Brain Tree: need ' + name + "'s year and place — off to the Esophagor");
      insertNext(['esophagor', 'brain']);
      return advance();
    }

    // Both answers in hand: fill and submit.
    const a1 = qs('#answer_1'), a2 = qs('#answer_2');
    if (!await humanPause()) return;
    setInput(a1, d.brain.year);
    if (!await abortableSleep(rand(700, 1600))) return;
    setInput(a2, d.brain.place);
    if (a1.value !== d.brain.year || a2.value !== d.brain.place) { log('Brain Tree: answers did not stick in the boxes', 'warn'); markDone('brain', 'fill failed'); return advance(); }
    if (!await abortableSleep(DELAY_REACT())) return;
    log('Brain Tree: answering ' + d.brain.year + ' / ' + d.brain.place);
    qs('#submit_brain_answer').click();
    const res = await waitForEl(() => /Thank you, you are correct/i.test(txt(mainContent())) || !qs('#person') ? true : null, 12000);
    if (!res) return;
    if (/Thank you, you are correct/i.test(txt(mainContent()))) return brainReward();
    log('Brain Tree: answer not accepted — ' + txt(box()).slice(0, 200), 'warn');
    markDone('brain', 'answer rejected');
    return advance();
  };

  function brainReward() {
    const page = txt(mainContent());
    const npB = qsa('p', mainContent()).map(txt).find(t => /NP!?$/.test(t) && /reward/i.test(t)) || page;
    const img = qs('img.item-img', mainContent());
    let item = '';
    if (img) { let n = img.nextElementSibling; while (n && !item) { if (n.tagName === 'P') item = txt(n); n = n.nextElementSibling; } }
    record('brain', { items: item ? [item] : [], np: npFrom(npB), points: POINTS.brain, note: '' });
    updateDay(x => { x.brain.status = 'done'; });
    markDone('brain');
    return advance();
  }

  // 8 ─ Esophagor ────────────────────────────────────────────────────────────
  // Brain Tree mode: Brain Tree accepted and an answer still missing — exempt from the daily count.
  function esoBrainMode() { const b = dayState().brain; return b.status === 'accepted' && (!b.year || !b.place); }

  H.esophagor = async () => {
    if (onPath(URL.quickstock)) return quickstockDeposit();
    if (!onPath(URL.esophagor)) return go(URL.esophagor);
    const s = settings();
    const container = () => qs('#esophagor-container') || mainContent();
    const page = txt(container());
    const brainMode = esoBrainMode();
    const count = dayState().counts.esophagor || 0;

    // Inventory over 60: Quickstock-deposit everything once, cancel the run if it's still there.
    if (/SECURITY ALERT/i.test(page) && /more than\s*60\s*items/i.test(page)) {
      if (run().depositTried) return stopRun('inventory still over 60 after depositing — clear it and run again');
      updateRun(r => { r.depositTried = true; r.depositReturn = URL.esophagor; });
      log('Esophagor: inventory over 60 — depositing everything via Quickstock', 'warn');
      return go(URL.quickstock);
    }

    // Result of feeding.
    if (/Nowww essoophagorr happy|essoophagorr happy/i.test(page)) return esoResult();

    // Coming back from the SSW.
    const r = run();
    if (r.buyResult && r.buyResult.tag === 'esophagor') {
      const br = r.buyResult;
      updateRun(x => { x.buyResult = null; });
      if (!br.ok) {
        record('esophagor', { spent: br.spent, note: 'quest abandoned — could not buy ' + (br.failed || 'an item') });
        if (brainMode) markDone('brain', 'Esophagor quest abandoned');
        markDone('esophagor', 'quest abandoned (it stays open until it expires)');
        return advance();
      }
      updateRun(x => { x.sub.bought = true; x.sub.spent = br.spent; });
    }

    // Ingredients in hand.
    const got = qs('#gotingredients');
    if (got && run().sub.bought) {
      if (!await humanPause()) return;
      got.click();
      await waitForEl(() => /essoophagorr happy/i.test(txt(container())) ? true : null, 10000);
      if (aborted()) return;
      if (/essoophagorr happy/i.test(txt(container()))) return esoResult();
      log('Esophagor: no result after handing over the food — ' + txt(container()).slice(0, 160), 'warn');
      markDone('esophagor', 'feed failed');
      return advance();
    }

    // Start a new quest, if allowed.
    const start = qs('#startquest');
    if (start) {
      if (!brainMode && count >= s.esoCount) { markDone('esophagor', count + ' quests'); return advance(); }
      if (!await humanPause()) return;
      start.click();
      await waitForEl(() => esoItems().length || /SECURITY ALERT/i.test(txt(container())) ? true : null, 10000);
      if (aborted()) return;
      if (/SECURITY ALERT/i.test(txt(container()))) return H.esophagor();
    }

    // A quest is open: price everything (re-rolling missing/over-limit slots), then buy.
    const items = esoItems();
    if (items.length) {
      if (run().sub.bought) {
        // Bought already but no hand-over button yet — reload to get it.
        if (visit('esophagor_stuck') > 5) { markDone('esophagor', 'stuck'); return advance(); }
        return go(URL.esophagor);
      }
      const plan = [];
      for (const it of items) {
        let name = it.name, tries = 0, shops = [];
        for (;;) {
          setStatus('Pricing ' + name + '…');
          const pr = await priceOne(name, s.esoMaxNP);
          if (pr.aborted) return;
          shops = pr.shops;
          if (shops.length || !it.reroll || tries >= REROLLS_PER_SLOT) break;
          tries++;
          log('Esophagor: ' + name + ' missing or over ' + fmtNP(s.esoMaxNP) + ' NP — re-rolling slot ' + it.slot + ' (' + tries + '/' + REROLLS_PER_SLOT + ')');
          const nn = await rerollSlot(it.slot, name);
          if (!nn) { log('Esophagor: re-roll refused', 'warn'); break; }
          name = nn;
        }
        if (!shops.length) {
          record('esophagor', { note: 'quest abandoned — ' + name + ' missing or over ' + fmtNP(s.esoMaxNP) + ' NP' });
          if (brainMode) markDone('brain', 'Esophagor quest abandoned');
          markDone('esophagor', 'quest abandoned (it stays open until it expires)');
          return advance();
        }
        plan.push({ name, shops, done: false, tries: 0, researched: false });
      }
      return startBuy(plan, s.esoMaxNP, 'esophagor', URL.esophagor);
    }

    if (visit('esophagor_odd') > 3) { log('Esophagor: page not recognised — ' + page.slice(0, 160), 'warn'); markDone('esophagor', 'unrecognised page (limit?)'); return advance(); }
    return go(URL.esophagor);
  };

  // Quest items: first view has .esophagor-item (with re-roll buttons); later views have a plain grid.
  function esoItems() {
    const c = qs('#esophagor-container') || mainContent();
    const rich = qsa('.esophagor-item', c);
    if (rich.length) return rich.map((el, i) => {
      const rb = qs('.esophagor-item-reroll', el);
      return { name: txt(qs('.item-name b', el) || qs('.item-name', el)), slot: rb ? rb.getAttribute('data-slot') : String(i + 1), reroll: !!rb };
    }).filter(x => x.name);
    if (qs('.item-container', c)) return [];       // result grid ("Thanks!"), not a request
    return qsa('.ingredient-grid p b', c).map(b => ({ name: txt(b), slot: '', reroll: false })).filter(x => x.name && !/^Thanks!?$/i.test(x.name));
  }

  async function rerollSlot(slot, oldName) {
    const btn = qs('.esophagor-item-reroll[data-slot="' + slot + '"]');
    if (!btn) return null;
    if (!await humanPause()) return null;
    btn.click();
    const nn = await waitForEl(() => {
      const el = btn.closest('.esophagor-item');
      const n = el ? txt(qs('.item-name b', el)) : '';
      return n && n !== oldName ? n : null;
    }, 8000);
    if (isVisible(qs('#DefaultErrorPopup'))) log('Esophagor re-roll: ' + txt(qs('#DefaultErrorMsg')), 'warn');
    return nn;
  }

  function esoResult() {
    const c = qs('#esophagor-container') || mainContent();
    const dialogues = qsa('.quest_dialogue__2021', c);
    const reveal = dialogues.find(p => /dieeddd/i.test(txt(p)));
    const brainMode = esoBrainMode();
    const spent = run().sub.spent || 0;
    let note = '';
    if (reveal) {
      const t = txt(reveal);
      const person = t.split(/\s+dieeddd/i)[0].trim();
      const u = qs('u', reveal);
      let ans = txt(u);
      const isYear = /yee*ar/i.test(t);
      if (isYear) {
        const after = (t.split(ans)[1] || '').trim();
        const era = (after.match(/^([A-Z]{1,3})\b/) || [])[1] || '';
        ans = ans + era;                        // "33" + "BN" → "33BN" (accepted format)
      }
      const d = dayState();
      if (d.brain.person && person && person !== d.brain.person) log('Esophagor reveal is for ' + person + ', Brain Tree wants ' + d.brain.person, 'warn');
      else updateDay(x => { if (isYear) x.brain.year = ans; else x.brain.place = ans; });
      note = (isYear ? 'Brain Tree year: ' : 'Brain Tree place: ') + ans;
    }
    // Extra rewards (event items / NP), if any are shown beyond the reveal.
    const rest = dialogues.filter(p => p !== reveal).map(txt).join(' ');
    const gift = qsa('strong, b', c).map(txt).find(t => /gives you|you get|you receive/i.test(t)) || '';
    const item = (gift.match(/(?:gives you|you get|you receive)\s+(?:an?\s+)?(.+?)!*$/i) || [])[1] || '';
    const n = bump('esophagor');
    record('esophagor', { items: item ? [item] : [], np: npFrom(rest), spent, points: POINTS.esophagor, note: (note ? note + ' · ' : '') + 'quest ' + n + (brainMode ? ' (Brain Tree)' : '') });
    updateRun(x => { x.sub = {}; });
    const b = dayState().brain;
    if (b.status === 'accepted' && b.year && b.place) {
      log('Brain Tree answers ready: ' + b.year + ' / ' + b.place);
      return advance();                         // queue has 'brain' next
    }
    return go(URL.esophagor);
  }

  async function quickstockDeposit() {
    const radios = qsa('input[type=radio][value="deposit"]');
    if (!radios.length) { log('Quickstock: nothing to deposit', 'warn'); return go(run().depositReturn || URL.esophagor); }
    if (!await humanPause()) return;
    radios.forEach(r => { r.checked = true; });
    const form = radios[0].closest('form');
    const sub = form && qsa('input[type=submit], button[type=submit]', form).find(b => /submit/i.test(b.value || txt(b))) || (form && qs('input[type=submit]', form));
    updateRun(r => { r.depositPosted = true; });
    log('Quickstock: depositing ' + radios.length + ' item(s)');
    if (sub) sub.click(); else if (form) form.submit();
  }

  // 9 ─ Edna ─────────────────────────────────────────────────────────────────
  H.edna = async () => {
    if (!onPath(URL.edna)) return go(URL.edna);
    const s = settings();
    const container = () => qs('#edna-container') || mainContent();
    const page = txt(container());
    const count = dayState().counts.edna || 0;

    if (/I have successfully made/i.test(page)) return ednaResult();

    const r = run();
    if (r.buyResult && r.buyResult.tag === 'edna') {
      const br = r.buyResult;
      updateRun(x => { x.buyResult = null; });
      if (!br.ok) {
        record('edna', { spent: br.spent, note: 'quest abandoned — could not buy ' + (br.failed || 'an item') });
        markDone('edna', 'quest abandoned (it stays open until it expires)');
        return advance();
      }
      updateRun(x => { x.sub.bought = true; x.sub.spent = br.spent; });
    }

    const got = qs('#gotingredients');
    if (got && run().sub.bought) {
      if (!await humanPause()) return;
      got.click();
      await waitForEl(() => /I have successfully made/i.test(txt(container())) ? true : null, 10000);
      if (aborted()) return;
      if (/I have successfully made/i.test(txt(container()))) return ednaResult();
      log('Edna: no result after handing over — ' + txt(container()).slice(0, 160), 'warn');
      markDone('edna', 'hand-over failed');
      return advance();
    }

    const start = qs('#startquest');
    if (start) {
      if (count >= s.ednaCount) { markDone('edna', count + ' quests'); return advance(); }
      if (!await humanPause()) return;
      start.click();
      await waitForEl(() => ednaItems().length ? true : null, 10000);
      if (aborted()) return;
    }

    const items = ednaItems();
    if (items.length) {
      if (run().sub.bought) {
        if (visit('edna_stuck') > 5) { markDone('edna', 'stuck'); return advance(); }
        return go(URL.edna);
      }
      const pa = await priceAll(items, s.ednaMaxNP);
      if (pa.aborted) return;
      if (pa.missing.length) {
        record('edna', { note: 'quest abandoned — ' + pa.missing.join(', ') + ' missing or over ' + fmtNP(s.ednaMaxNP) + ' NP' });
        markDone('edna', 'quest abandoned (it stays open until it expires)');
        return advance();
      }
      return startBuy(pa.plan, s.ednaMaxNP, 'edna', URL.edna);
    }

    if (visit('edna_odd') > 3) { log('Edna: page not recognised — ' + page.slice(0, 160), 'warn'); markDone('edna', 'unrecognised page (limit?)'); return advance(); }
    return go(URL.edna);
  };

  function ednaItems() {
    const c = qs('#edna-container') || mainContent();
    if (qs('.item-container', c)) return [];
    return qsa('.ingredient-grid p b', c).map(txt).filter(n => n && !/^Thanks!?$/i.test(n));
  }

  function ednaResult() {
    const c = qs('#edna-container') || mainContent();
    const dialogues = qsa('.quest_dialogue__2021', c).map(txt);
    const npLine = dialogues.find(t => /NP/.test(t)) || '';
    const gift = qsa('p strong', c).find(el => /old witch gives you/i.test(txt(el)));
    const item = gift ? txt(qs('strong', gift)) : '';
    const spent = run().sub.spent || 0;
    const n = bump('edna');
    record('edna', { items: item ? [item] : [], np: npFrom(npLine), spent, points: n <= 10 ? POINTS.edna : 0, note: 'quest ' + n });
    updateRun(x => { x.sub = {}; });
    return go(URL.edna);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Dispatcher
  // ═════════════════════════════════════════════════════════════════════════
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (let guard = 0; guard < 25; guard++) {
        const r = run();
        if (!r.active) return;

        // Shop page during a buy.
        if (r.buy) {
          if (onPath('/browseshop.phtml')) { await handleShopPage(); return; }
          if (visit('buyhop') > 12) { updateRun(x => { x.buy.failed = 'shop pages kept redirecting'; }); finishBuy(false); return; }
          const cur = r.buy.plan.find(p => !p.done);
          if (cur && cur.shops[cur.tries]) go(cur.shops[cur.tries].shopUrl); else finishBuy(!cur);
          return;
        }
        // Quickstock detour.
        if (onPath(URL.quickstock) && r.depositTried) {
          if (r.depositPosted) { updateRun(x => { x.depositPosted = false; }); return go(r.depositReturn || URL.esophagor); }
          return quickstockDeposit();
        }

        const act = r.queue[r.idx];
        if (!act) return finishRun();
        if (isDone(act)) {
          updateRun(x => { x.idx++; x.sub = {}; });
          continue;
        }
        if (visit(act) > VISIT_GUARD * 4) { log(LABEL[act] + ': too many page visits — skipping', 'warn'); advance(); continue; }
        setStatus(LABEL[act] + '…');
        renderPanel();
        const before = run();
        await H[act]();
        const after = run();
        // A handler that advanced without navigating lets the next activity start on this page.
        if (!after.active || after.idx === before.idx || location.href !== pageAtLoad) return;
        if (!await abortableSleep(rand(800, 1800))) return;
      }
    } catch (e) {
      log('Error: ' + (e && e.message || e), 'warn');
      console.error('[PBP FoF]', e);
    } finally {
      ticking = false;
      renderPanel();
    }
  }
  const pageAtLoad = location.href;

  function finishRun() {
    const r = run();
    updateRun(x => { x.active = false; });
    log((r.label || 'Run') + ' finished', 'ok');
    setStatus('Finished');
    scheduleGdReturn();
    renderPanel();
  }

  // If the tab stays open, come back for Grave Danger when the petpet returns.
  let gdTimer = null;
  function scheduleGdReturn() {
    if (gdTimer) clearTimeout(gdTimer);
    const s = settings();
    const at = dayState().gd.returnAt;
    if (!s.enabled.gravedanger || !s.gdPetpetOwner || !at) return;
    const wait = at - Date.now() + rand(60, 180) * 1000;
    if (wait < 0 || wait > 8 * 3600e3) return;
    gdTimer = setTimeout(() => { if (!run().active) startRun(['gravedanger'], 'Grave Danger return'); }, wait);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Panel
  // ═════════════════════════════════════════════════════════════════════════
  let statusText = '';
  const liveLog = [];
  function log(msg, kind) {
    msg = clean(msg);
    liveLog.push({ t: new Date().toLocaleTimeString(), msg, kind: kind || '' });
    while (liveLog.length > 60) liveLog.shift();
    const ll = load('pbp_fof_livelog', []);
    ll.push({ t: new Date().toLocaleTimeString(), msg, kind: kind || '' });
    while (ll.length > 60) ll.shift();
    save('pbp_fof_livelog', ll);
    console.log('[PBP FoF] ' + msg);
    renderLog();
  }
  function setStatus(s) { statusText = s; const el = qs('#pbpfof-status'); if (el) el.textContent = s; }

  const showPanelHere = () => /^\/halloween\//.test(location.pathname) || run().active;

  function css() {
    const st = document.createElement('style');
    st.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Ubuntu:wght@400;700&display=swap');
#pbpfof-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#e8a800;color:#1a1a1a;border:0;border-radius:6px;
 font:700 13px Ubuntu,Arial,sans-serif;padding:8px 12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}
#pbpfof{position:fixed;right:18px;bottom:60px;z-index:2147483000;width:360px;max-height:80vh;display:flex;flex-direction:column;
 background:#2c2c2c;color:#eee;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);font:12px Ubuntu,Arial,sans-serif;overflow:hidden}
#pbpfof .hd{background:#e8a800;color:#1a1a1a;font-weight:700;padding:8px 10px;display:flex;justify-content:space-between;align-items:center}
#pbpfof .hd span{font-size:11px;font-weight:400}
#pbpfof .bd{overflow:auto;padding:8px 10px}
#pbpfof .row{display:flex;gap:6px;margin:6px 0;flex-wrap:wrap}
#pbpfof button.b{border:0;border-radius:4px;padding:6px 10px;font:700 12px Ubuntu,Arial,sans-serif;cursor:pointer;color:#fff}
#pbpfof .go{background:#3a9d4f}#pbpfof .stop{background:#c0392b}#pbpfof .grey{background:#555}#pbpfof .amb{background:#e8a800;color:#1a1a1a}
#pbpfof .stat{color:#ffcf4d;margin:4px 0}
#pbpfof .tally{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin:6px 0}
#pbpfof .tally div{background:#383838;border-radius:4px;padding:5px;text-align:center}
#pbpfof .tally b{display:block;font-size:14px;color:#ffcf4d}
#pbpfof details{background:#333;border-radius:4px;margin:6px 0;padding:4px 6px}
#pbpfof summary{cursor:pointer;font-weight:700;color:#e8a800}
#pbpfof label{display:flex;justify-content:space-between;align-items:center;gap:6px;margin:4px 0}
#pbpfof input[type=number],#pbpfof select{width:110px;background:#1e1e1e;color:#eee;border:1px solid #555;border-radius:3px;padding:2px 4px;font:12px Ubuntu,Arial}
#pbpfof .acts{display:grid;grid-template-columns:1fr 1fr;gap:2px 8px}
#pbpfof .acts label{justify-content:flex-start;margin:1px 0}
#pbpfof .done{color:#7fd18b}#pbpfof .warn{color:#ff9d7a}#pbpfof .prize{color:#ffcf4d}#pbpfof .ok{color:#7fd18b}
#pbpfof .log{font:11px monospace;max-height:150px;overflow:auto;background:#1e1e1e;border-radius:4px;padding:4px}
#pbpfof table{width:100%;border-collapse:collapse;font-size:11px}
#pbpfof td{padding:2px 3px;border-bottom:1px solid #3a3a3a;vertical-align:top}
#pbpfof .card{display:grid;grid-template-columns:auto 1fr auto auto;gap:4px;align-items:center;margin:2px 0}
#pbpfof .small{font-size:10px;color:#aaa}
#pbpfof td,#pbpfof th,#pbpfof div,#pbpfof span,#pbpfof label,#pbpfof b,#pbpfof p{color:#eee !important;font-family:Ubuntu,Arial,sans-serif !important;background:transparent}
#pbpfof table td{font-size:11px !important;line-height:1.35 !important}
#pbpfof .hd,#pbpfof .hd *{color:#1a1a1a !important}
#pbpfof .tally div{background:#383838 !important}#pbpfof .tally b,#pbpfof .stat{color:#ffcf4d !important}
#pbpfof .small,#pbpfof .small *{color:#aaa !important}
#pbpfof .done,#pbpfof .ok,#pbpfof td.done{color:#7fd18b !important}#pbpfof .warn,#pbpfof span.warn{color:#ff9d7a !important}#pbpfof .prize,#pbpfof span.prize{color:#ffcf4d !important}
#pbpfof .log,#pbpfof .log div{background:#1e1e1e;font-family:monospace !important}
#pbpfof a.rst{color:#e8a800 !important;text-decoration:none;font-weight:700}`;
    document.head.appendChild(st);
  }

  function totals(filterDay) {
    const t = { np: 0, spent: 0, points: 0, items: 0 };
    for (const e of load(K_LOG, [])) {
      if (filterDay && e.day !== filterDay) continue;
      t.np += e.np || 0; t.spent += e.spent || 0; t.points += e.points || 0; t.items += (e.items || []).length;
    }
    return t;
  }

  function renderPanel() {
    if (!document.body || !showPanelHere()) return;
    let btn = qs('#pbpfof-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'pbpfof-btn';
      btn.textContent = '🎃 PBP Dailies';
      btn.onclick = () => { const ui = load(K_UI, {}); ui.open = !ui.open; save(K_UI, ui); renderPanel(); };
      document.body.appendChild(btn);
    }
    let p = qs('#pbpfof');
    const ui = load(K_UI, {});
    if (!ui.open) { if (p) p.remove(); return; }
    const openDetails = p ? qsa('details', p).filter(d => d.open).map(d => d.dataset.k) : (ui.openDetails || []);
    if (!p) { p = document.createElement('div'); p.id = 'pbpfof'; document.body.appendChild(p); }
    const s = settings(), r = run(), d = dayState();
    const today = totals(nstDay()), all = totals();
    const pets = load(K_PETPETS, {});
    const doneLine = a => {
      if (a === 'gravedanger') return d.gd.returnAt && Date.now() < d.gd.returnAt ? 'out until ' + new Date(d.gd.returnAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const c = d.counts[a];
      return d.done[a] ? '✓' : (c ? c + '' : '');
    };
    p.innerHTML = `
<div class="hd">🎃 Festival of Fears Dailies <span>v${VERSION}</span></div>
<div class="bd">
  <div class="row">
    ${r.active ? '<button class="b stop" id="pbpfof-stop">■ Stop</button>' : '<button class="b go" id="pbpfof-run">▶ Run dailies</button>'}
    <button class="b grey" id="pbpfof-diag">Diagnose DOM</button>
    <button class="b grey" id="pbpfof-export">Export log</button>
  </div>
  <div class="stat" id="pbpfof-status">${r.active ? (statusText || 'Running…') : (statusText || 'Idle')}</div>
  <div class="small">Today (NST ${nstDay()})</div>
  <div class="tally">
    <div><b>${fmtNP(today.points)}</b>points</div>
    <div><b>${fmtNP(today.np)}</b>NP won</div>
    <div><b>${fmtNP(today.spent)}</b>NP spent</div>
  </div>
  <div class="small">Event total: ${fmtNP(all.points)} pts · ${fmtNP(all.np)} NP won · ${fmtNP(all.spent)} spent · <b style="color:${all.np - all.spent >= 0 ? '#7fd18b' : '#ff9d7a'}">net ${all.np - all.spent >= 0 ? '+' : ''}${fmtNP(all.np - all.spent)}</b> · ${all.items} items</div>

  <details data-k="acts"><summary>Activities</summary>
    <div class="acts">${ORDER.map(a => `<label><input type="checkbox" data-act="${a}" ${s.enabled[a] ? 'checked' : ''}> ${LABEL[a]} <span class="done">${doneLine(a)}</span>${doneLine(a) ? ` <a href="#" class="rst" data-reset="${a}" title="Reset today's state for ${LABEL[a]}">↺</a>` : ''}</label>`).join('')}</div>
  </details>

  <details data-k="quests"><summary>Esophagor / Edna</summary>
    <label>Esophagor quests per day <input type="number" min="0" id="s-esoCount" value="${s.esoCount}"></label>
    <label>Esophagor max NP per item <input type="number" min="0" step="500" id="s-esoMaxNP" value="${s.esoMaxNP}"></label>
    <label>Edna quests per day <input type="number" min="0" id="s-ednaCount" value="${s.ednaCount}"></label>
    <label>Edna max NP per item <input type="number" min="0" step="500" id="s-ednaMaxNP" value="${s.ednaMaxNP}"></label>
    <div class="small">Brain Tree's two Esophagor quests run even past the daily count. Brain Tree today: ${d.brain.person ? d.brain.person + ' — ' + (d.brain.year || '?') + ' / ' + (d.brain.place || '?') : 'not started'}</div>
  </details>

  <details data-k="gd"><summary>Grave Danger</summary>
    <label>Petpet to send <select id="s-gd"><option value="">— choose —</option>${Object.keys(pets).map(o => `<option value="${o}" ${s.gdPetpetOwner === o ? 'selected' : ''}>${pets[o]} (${o})</option>`).join('')}</select></label>
    ${Object.keys(pets).length ? '' : '<div class="small">Open Grave Danger once to load your petpets.</div>'}
  </details>

  <details data-k="scratch"><summary>Scratchcards</summary>
    <label>Max NP per SSW card <input type="number" min="0" step="1000" id="s-scratchMaxNP" value="${s.scratchMaxNP}"></label>
    <div class="small">Buy = SSW top-up candidates · Keep = never scratched</div>
    ${KIOSK_CARDS.map(n => `<div class="card"><span>${n.replace(' Scratchcard', '')}</span><span class="small" data-idb="${n}">…</span>
      <label class="small"><input type="checkbox" data-buy="${n}" ${s.scratchBuy[n] ? 'checked' : ''}>buy</label>
      <label class="small"><input type="checkbox" data-keep="${n}" ${s.scratchKeep[n] ? 'checked' : ''}>keep</label></div>`).join('')}
    <div class="small">Scratched today: ${d.counts.scratch || 0}/${SCRATCH_PER_DAY}</div>
  </details>

  <details data-k="prizes"><summary>Prize log (${load(K_LOG, []).length})</summary>
    <table>${load(K_LOG, []).slice(-60).reverse().map(e => `<tr><td class="small">${new Date(e.ts).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${LABEL[e.act] || e.act}</td><td>${esc((e.items || []).join(', ') || e.note || '')}${e.np ? ' <span class="prize">+' + fmtNP(e.np) + '</span>' : ''}${e.spent ? ' <span class="warn">−' + fmtNP(e.spent) + '</span>' : ''}</td><td class="done">${e.points ? e.points : ''}</td></tr>`).join('')}</table>
  </details>

  <details data-k="log" open><summary>Activity log</summary><div class="log" id="pbpfof-log"></div></details>
</div>`;
    qsa('details', p).forEach(dt => { if (openDetails.indexOf(dt.dataset.k) !== -1) dt.open = true; dt.addEventListener('toggle', () => { const u = load(K_UI, {}); u.openDetails = qsa('details', p).filter(x => x.open).map(x => x.dataset.k); save(K_UI, u); }); });
    wirePanel(p);
    renderLog();
    if (qs('details[data-k="scratch"]', p).open) fillItemdb(p);
    qs('details[data-k="scratch"]', p).addEventListener('toggle', e => { if (e.target.open) fillItemdb(p); });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function renderLog() {
    const el = qs('#pbpfof-log');
    if (!el) return;
    const ll = load('pbp_fof_livelog', []);
    el.innerHTML = ll.slice().reverse().map(l => `<div class="${l.kind}">${l.t} ${esc(l.msg)}</div>`).join('');
  }

  async function fillItemdb(p) {
    for (const n of KIOSK_CARDS) {
      const el = qs('[data-idb="' + n + '"]', p);
      if (!el) continue;
      const v = await itemdbPrice(n);
      el.textContent = v === 'session' ? 'itemdb login?' : (typeof v === 'number' ? fmtNP(v) + ' NP' : '—');
    }
  }

  function wirePanel(p) {
    const on = (id, fn) => { const el = qs('#' + id, p); if (el) el.onclick = fn; };
    on('pbpfof-run', () => startRun());
    on('pbpfof-stop', () => stopRun());
    on('pbpfof-diag', diagnose);
    on('pbpfof-export', exportLog);
    qsa('a[data-reset]', p).forEach(a => a.onclick = e => { e.preventDefault(); resetActivity(a.dataset.reset); });
    qsa('input[data-act]', p).forEach(cb => cb.onchange = () => { const s = settings(); s.enabled[cb.dataset.act] = cb.checked; saveSettings(s); });
    qsa('input[data-buy]', p).forEach(cb => cb.onchange = () => { const s = settings(); s.scratchBuy[cb.dataset.buy] = cb.checked; saveSettings(s); });
    qsa('input[data-keep]', p).forEach(cb => cb.onchange = () => { const s = settings(); s.scratchKeep[cb.dataset.keep] = cb.checked; saveSettings(s); });
    for (const k of ['esoCount', 'esoMaxNP', 'ednaCount', 'ednaMaxNP', 'scratchMaxNP']) {
      const el = qs('#s-' + k, p);
      if (el) el.onchange = () => { const s = settings(); s[k] = Math.max(0, toInt(el.value)); saveSettings(s); };
    }
    const gd = qs('#s-gd', p);
    if (gd) gd.onchange = () => { const s = settings(); s.gdPetpetOwner = gd.value; saveSettings(s); };
  }

  // Clear today's state for one activity so a run will do it again.
  function resetActivity(act) {
    updateDay(d => {
      delete d.done[act]; delete d.counts[act];
      if (act === 'scratch') { d.scratch.toppedUp = false; }
      if (act === 'gravedanger') { d.gd.returnAt = 0; }
      if (act === 'brain') { d.brain = {}; }
    });
    log(LABEL[act] + ' reset for today', 'ok');
    renderPanel();
  }

  function diagnose() {
    const c = mainContent().cloneNode(true);
    qsa('#pbpfof, #pbpfof-btn, script, style, link', c).forEach(e => e.remove());
    const popups = qsa('[id*="opup"]').filter(isVisible).map(e => e.outerHTML).join('\n');
    const out = `=== PBP FoF ${VERSION} Diagnose — ${location.href} — ${new Date().toISOString()} ===\n` +
      `run: ${JSON.stringify(run())}\nday: ${JSON.stringify(dayState())}\n\n=== VISIBLE POPUPS ===\n${popups}\n\n=== PAGE ===\n${c.outerHTML.slice(0, 60000)}`;
    GM_setClipboard(out);
    log('Diagnose DOM copied to clipboard (' + out.length + ' chars)', 'ok');
  }

  function exportLog() {
    const rows = [['time', 'nst_day', 'activity', 'items', 'np_won', 'np_spent', 'points', 'note']];
    for (const e of load(K_LOG, [])) rows.push([new Date(e.ts).toISOString(), e.day, LABEL[e.act] || e.act, (e.items || []).join('; '), e.np || 0, e.spent || 0, e.points || 0, e.note || '']);
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'pbp-fof-prizes-' + nstDay() + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  css();
  if (onPath(URL.gravedanger)) readPetpets();
  renderPanel();
  scheduleGdReturn();
  if (run().active) setTimeout(tick, rand(900, 1800));
})();
