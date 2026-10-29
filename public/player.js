// Read-only view of another player's portfolio, opened from the rankings page.
const $ = (id) => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const shareFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const timeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const name = new URLSearchParams(location.search).get('name') || '';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

const signClass = (n) => (n > 0.004 ? 'up' : n < -0.004 ? 'down' : '');
const signed = (n) => {
  const cents = Math.round(n * 100) / 100 || 0;
  return (cents > 0 ? '+' : '') + usd.format(cents);
};
const tickerLink = (symbol, exchange) =>
  el('a', { href: `https://www.google.com/finance/quote/${symbol}:${exchange}`, target: '_blank', rel: 'noopener', class: 'ticker' }, symbol);

function render(p) {
  document.title = `${p.name} · Kenny's Paper Trader`;
  $('player-name').textContent = p.name;
  $('stat-total').textContent = usd.format(p.total);
  $('stat-cash').textContent = usd.format(p.cash);
  $('stat-invested').textContent = usd.format(p.invested);
  $('stat-gain').textContent = pctFmt.format(p.returnPct);
  $('stat-gain').className = `value ${signClass(p.gain)}`;
  $('stat-deposited').textContent = `${signed(p.gain)} on ${usd.format(p.deposited)} starting cash`;

  $('holdings').querySelector('tbody').replaceChildren(
    ...p.positions.map((pos) => {
      const day = pos.price !== null && pos.previousClose ? (pos.price - pos.previousClose) / pos.previousClose : null;
      const gainPct = pos.gain !== null && pos.cost ? pos.gain / pos.cost : null;
      return el('tr', {},
        el('td', {}, tickerLink(pos.symbol, pos.exchange), el('span', { class: 'cell-name' }, pos.name || pos.exchange)),
        el('td', { class: 'num' }, shareFmt.format(pos.shares)),
        el('td', { class: 'num' }, usd.format(pos.avgCost)),
        el('td', { class: 'num' }, pos.price === null ? 'unavailable' : usd.format(pos.price)),
        el('td', { class: `num ${signClass(day ?? 0)}` }, day === null ? '–' : pctFmt.format(day)),
        el('td', { class: 'num' }, pos.value === null ? '–' : usd.format(pos.value)),
        el('td', { class: `num ${signClass(pos.gain ?? 0)}` }, pos.gain === null ? '–' : `${signed(pos.gain)} (${pctFmt.format(gainPct)})`));
    }),
  );
  $('no-holdings').hidden = p.positions.length > 0;

  $('history').querySelector('tbody').replaceChildren(
    ...p.transactions.map((t) => {
      const when = timeFmt.format(new Date(t.createdAt));
      if (t.type === 'deposit') {
        return el('tr', {}, el('td', {}, when), el('td', {}, 'Added cash'), el('td'), el('td'), el('td', { class: 'num up' }, `+${usd.format(t.amount)}`));
      }
      return el('tr', {},
        el('td', {}, when),
        el('td', {}, t.type === 'buy' ? 'Bought ' : 'Sold ', tickerLink(t.symbol, t.exchange)),
        el('td', { class: 'num' }, shareFmt.format(t.shares)),
        el('td', { class: 'num' }, usd.format(t.price)),
        el('td', { class: 'num' }, `${t.type === 'buy' ? '−' : '+'}${usd.format(t.amount)}`));
    }),
  );
  $('player').hidden = false;
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
}

async function load() {
  $('error').textContent = '';
  $('refresh').disabled = true;
  try {
    const res = await fetch(`/api/players/${encodeURIComponent(name)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    render(data);
  } catch (err) {
    $('player-name').textContent = name || 'Player';
    $('error').textContent = `Couldn't load this player: ${err.message}`;
  } finally {
    $('refresh').disabled = false;
  }
}

$('refresh').addEventListener('click', load);
setInterval(() => document.visibilityState === 'visible' && load(), 30_000);
load();
