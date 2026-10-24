// ════════════════════════════════════════════════════════════════════════════
// PBP shared — SSW search + single-item user-shop buy
// ════════════════════════════════════════════════════════════════════════════
//
// Lifted from Auto Trainer 1.4.5 (Kitchen Quest), which is proven live.
// Copy into a userscript and supply: log(msg, kind), aborted(), abortableSleep(ms),
// qsa(sel, root), waitForEl(fn, ms), fmtNP(n), DELAY_REACT().
//
// Ben's buying rules (Kitchen Quest, carried over to the Festival of Fears auto):
//   - price EVERY item on the SSW before buying anything, so an abandoned
//     quest costs nothing;
//   - buy only at or under the max NP per item;
//   - if any item is missing or over the limit, give up on the quest (let it
//     expire) and log it;
//   - SSW refusal ("too many"/"try again"/"wait") → pause ~30m, don't abandon;
//   - try up to 5 cheapest shops per item, one re-search if all fail;
//   - full-inventory message → abandon.
// ════════════════════════════════════════════════════════════════════════════

const SSW_QUERY = '/np-templates/views/shops/ssw/ssw_query.php';

// The same JSON endpoint the SSW widget uses.
// Returns { shops: [{ owner, shopUrl, price }] } cheapest first, or { error, shops }.
async function sswSearch(name, maxPrice) {
  const qs = new URLSearchParams({
    q: name, caller: 'h5', priceOnly: '0', context: '0', partial: '0',
    min_price: '0', max_price: String(maxPrice), lang: 'en', json: '1',
    cb: String(Math.floor(100000 + Math.random() * 900000)),
  });
  let data;
  try {
    const res = await fetch(SSW_QUERY + '?' + qs.toString(), {
      credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    data = await res.json();
  } catch (e) {
    return { error: 'SSW request failed (' + (e && e.message || 'not JSON') + ')', shops: [] };
  }
  const err = data && data.data && data.data.error;
  const html = (data && data.html) || '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lis = [...doc.querySelectorAll('.ssw-results-grid ul li')].slice(1);   // first li is the header
  const shops = [];
  for (const li of lis) {
    const a = li.querySelector('.ssw-results-grid-user a');
    const p = li.querySelector('.ssw-results-grid-price');
    if (!a || !p) continue;
    const price = parseInt((p.textContent || '').replace(/[^0-9]/g, ''), 10);
    if (!Number.isFinite(price) || price > maxPrice) continue;
    shops.push({
      owner: (a.textContent || '').trim(),
      shopUrl: new URL(a.getAttribute('href') || '', location.origin).href,
      price,
    });
  }
  shops.sort((x, y) => x.price - y.price);
  if (!shops.length && err && String(err).trim()) return { error: String(err).replace(/<[^>]+>/g, '').trim(), shops };
  return { shops };
}

function sswLooksBanned(msg) {
  return /too many|too busy|try again|slow down|wait/i.test(msg || '');
}

function shopOwnerParam(url) {
  try { return (new URL(url, location.origin).searchParams.get('owner') || '').toLowerCase(); }
  catch { return ''; }
}

// On browseshop.phtml: buy exactly ONE of `itemName` at ≤ maxNP.
// Only call when this is the shop the script navigated to (compare
// shopOwnerParam(location.href) with the target shop's) — never a shop
// Ben opened by hand.
// Same mechanism as SW Auto-Buyer 16.1.5+: the grid button carries a
// single-use data-buy-url; GET it with &ajax=1 and read { success, message }.
// Returns { bought, paid, reason, inventoryFull }.
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
