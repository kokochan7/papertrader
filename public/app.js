const STORAGE_KEY = 'papertrader.portfolioId';
const REFRESH_MS = 30_000;

const $ = (id) => document.getElementById(id);
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const shareFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const pctFmt = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const timeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

let portfolioId = null;
let portfolio = null;
let currentQuote = null;
let refreshTimer = null;
let tradeMode = 'shares'; // or 'dollars'
let lookupSeq = 0;
let lookupTimer = null;

function storage(action, value) {
  try {
    if (action === 'get') return localStorage.getItem(STORAGE_KEY);
    if (action === 'set') localStorage.setItem(STORAGE_KEY, value);
    if (action === 'clear') localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or blocked storage: the portfolio link still works.
  }
  return null;
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

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
  const cents = Math.round(n * 100) / 100 || 0; // avoid "-$0.00"
  return (cents > 0 ? '+' : '') + usd.format(cents);
};

function tickerLink(symbol, exchange, url) {
  return el('a', { href: url, target: '_blank', rel: 'noopener', class: 'ticker', title: `${symbol}:${exchange} on Google Finance` }, symbol);
}

async function withBusy(form, fn) {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------- rendering ----------

function render() {
  const p = portfolio;
  $('stat-total').textContent = usd.format(p.total);
  $('stat-cash').textContent = usd.format(p.cash);
  $('stat-invested').textContent = usd.format(p.invested);
  const gain = $('stat-gain');
  gain.textContent = signed(p.gain);
  gain.className = `value ${signClass(p.gain)}`;
  $('stat-deposited').textContent = `${pctFmt.format(p.deposited ? p.gain / p.deposited : 0)} on ${usd.format(p.deposited)} added`;
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;

  const holdings = $('holdings').querySelector('tbody');
  holdings.replaceChildren(
    ...p.positions.map((pos) => {
      const day = pos.price !== null && pos.previousClose ? (pos.price - pos.previousClose) / pos.previousClose : null;
      const gainPct = pos.gain !== null && pos.cost ? pos.gain / pos.cost : null;
      const row = el(
        'tr',
        { title: 'Click to trade' },
        el('td', {}, tickerLink(pos.symbol, pos.exchange, pos.googleUrl), el('span', { class: 'cell-name' }, pos.name || pos.exchange)),
        el('td', { class: 'num' }, shareFmt.format(pos.shares)),
        el('td', { class: 'num' }, usd.format(pos.avgCost)),
        el('td', { class: 'num' }, pos.price === null ? 'unavailable' : usd.format(pos.price)),
        el('td', { class: `num ${signClass(day ?? 0)}` }, day === null ? '–' : pctFmt.format(day)),
        el('td', { class: 'num' }, pos.value === null ? '–' : usd.format(pos.value)),
        el('td', { class: `num ${signClass(pos.gain ?? 0)}` }, pos.gain === null ? '–' : `${signed(pos.gain)} (${pctFmt.format(gainPct)})`),
      );
      row.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        $('symbol').value = `${pos.symbol}:${pos.exchange}`;
        lookUp();
        $('symbol').scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return row;
    }),
  );
  $('no-holdings').hidden = p.positions.length > 0;

  const history = $('history').querySelector('tbody');
  history.replaceChildren(
    ...p.transactions.map((t) => {
      const when = timeFmt.format(new Date(t.createdAt));
      if (t.type === 'deposit') {
        return el('tr', {}, el('td', {}, when), el('td', {}, 'Added cash'), el('td'), el('td'), el('td', { class: 'num up' }, `+${usd.format(t.amount)}`));
      }
      const url = `https://www.google.com/finance/quote/${t.symbol}:${t.exchange}`;
      return el(
        'tr',
        {},
        el('td', {}, when),
        el('td', {}, t.type === 'buy' ? 'Bought ' : 'Sold ', tickerLink(t.symbol, t.exchange, url)),
        el('td', { class: 'num' }, shareFmt.format(t.shares)),
        el('td', { class: 'num' }, usd.format(t.price)),
        el('td', { class: 'num' }, `${t.type === 'buy' ? '−' : '+'}${usd.format(t.amount)}`),
      );
    }),
  );

  $('share-link').value = `${location.origin}/?p=${portfolioId}`;
  $('name-card').hidden = Boolean(p.name);
  // One deposit per game: the Add cash box only shows while nothing has been added since the last Restart.
  $('deposit-card').hidden = p.deposited > 0;
  $('rank-card').hidden = !(p.deposited > 0);
  if (p.deposited > 0) loadRank();
  updateEstimate();
}

function renderQuote(q) {
  const box = $('quote');
  const change = q.previousClose ? q.price - q.previousClose : null;
  const owned = portfolio?.positions.find((p) => p.symbol === q.symbol);
  const pct = change === null ? null : change / q.previousClose;
  box.classList.remove('loading');
  // Laid out like a Google Finance search result: ticker and name on the left, price and day change on the right.
  box.replaceChildren(
    el('div', { class: 'head' },
      el('div', {},
        el('div', { class: 'sym' }, tickerLink(q.symbol, q.exchange, q.googleUrl)),
        el('div', { class: 'name' }, `${q.name ? `${q.name} · ` : ''}${q.exchange} (US)`)),
      el('div', { class: 'right' },
        el('div', { class: 'price' }, usd.format(q.price)),
        pct === null
          ? null
          : el('div', { class: `change ${signClass(change)}`, title: `${signed(change)} today` },
              pctFmt.format(pct), el('span', { class: 'arrow', 'aria-hidden': 'true' }, change > 0 ? '↑' : '↓')))),
    el('div', { class: 'meta' },
      el('a', { href: q.googleUrl, target: '_blank', rel: 'noopener' }, 'View on Google Finance ↗'),
      el('span', { class: 'muted' }, owned ? `You own ${shareFmt.format(owned.shares)} (${usd.format(owned.shares * q.price)})` : 'You own 0')),
  );
  box.hidden = false;
  $('trade-form').hidden = false;
  updateEstimate();
}

function updateEstimate() {
  const value = Number($('shares').value);
  if (!currentQuote || !portfolio) {
    $('estimate').textContent = '';
    return;
  }
  if (!(value > 0)) {
    $('estimate').textContent = `You have ${usd.format(portfolio.cash)} cash, enough for about ${shareFmt.format(Math.floor((portfolio.cash / currentQuote.price) * 100) / 100)} shares.`;
    return;
  }
  $('estimate').textContent = tradeMode === 'dollars'
    ? `≈ ${shareFmt.format(Math.floor((value / currentQuote.price) * 1e4) / 1e4)} shares · cash available ${usd.format(portfolio.cash)}`
    : `Estimated ${usd.format(value * currentQuote.price)} · cash available ${usd.format(portfolio.cash)}`;
}

function setTradeMode(mode) {
  tradeMode = mode;
  document.querySelectorAll('.segmented .seg').forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const dollars = mode === 'dollars';
  $('amount-label').textContent = dollars ? 'Amount in dollars' : 'Shares';
  $('amount-prefix').hidden = !dollars;
  $('shares').parentElement.classList.toggle('dollars', dollars);
  $('shares').placeholder = dollars ? '500' : '10';
  $('shares').min = dollars ? '0.01' : '0.0001';
  $('shares').value = '';
  updateEstimate();
}

async function loadRank() {
  if (!portfolio?.name) {
    $('rank-position').textContent = '–';
    $('rank-detail').textContent = 'Pick a name above to appear in the rankings.';
    return;
  }
  try {
    const { players } = await api(`/leaderboard?me=${encodeURIComponent(portfolioId)}`);
    const me = players.find((p) => p.you);
    if (!me) return;
    $('rank-position').textContent = `#${me.rank}`;
    $('rank-detail').textContent = `of ${players.length} player${players.length === 1 ? '' : 's'} · ${portfolio.name} · ${pctFmt.format(me.returnPct)} return`;
  } catch {
    // Rankings are a nice-to-have here; the main page keeps working without them.
  }
}

// ---------- actions ----------

async function loadPortfolio({ fresh = false } = {}) {
  try {
    portfolio = await api(`/portfolios/${portfolioId}${fresh ? '?fresh=1' : ''}`);
  } catch (err) {
    if (err.status === 404) {
      storage('clear');
      showSetup();
      return;
    }
    $('updated').textContent = `Couldn't refresh: ${err.message}`;
    return;
  }
  render();
}

function showSetup() {
  portfolioId = null;
  portfolio = null;
  clearInterval(refreshTimer);
  $('app').hidden = true;
  $('refresh').hidden = true;
  $('restart').hidden = true;
  $('setup').hidden = false;
  $('updated').textContent = '';
  $('starting-cash').focus();
}

async function showApp() {
  $('setup').hidden = true;
  $('app').hidden = false;
  $('refresh').hidden = false;
  $('restart').hidden = false;
  await loadPortfolio();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadPortfolio();
  }, REFRESH_MS);
}

// preview: true while typing (debounced, quieter errors, keeps focus in the symbol box).
async function lookUp({ preview = false } = {}) {
  clearTimeout(lookupTimer);
  const symbol = $('symbol').value.trim();
  if (!symbol) return;
  const seq = ++lookupSeq;
  $('trade-error').textContent = '';
  $('trade-message').textContent = '';
  $('quote').classList.add('loading');
  try {
    const quote = await api(`/quote?symbol=${encodeURIComponent(symbol)}`);
    if (seq !== lookupSeq) return; // a newer lookup started while this one was in flight
    currentQuote = quote;
    renderQuote(currentQuote);
    if (!preview) $('shares').focus();
  } catch (err) {
    if (seq !== lookupSeq) return;
    currentQuote = null;
    $('quote').hidden = true;
    $('trade-form').hidden = true;
    $('trade-error').textContent = preview ? `No match for "${symbol.toUpperCase()}" yet` : err.message;
  }
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('setup-error').textContent = '';
  await withBusy(e.target, async () => {
    try {
      const { id } = await api('/portfolios', {
        method: 'POST',
        body: { name: $('player-name').value, startingCash: $('starting-cash').value },
      });
      portfolioId = id;
      storage('set', id);
      $('starting-cash').value = '';
      await showApp();
    } catch (err) {
      $('setup-error').textContent = err.message;
    }
  });
});

$('name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('name-error').textContent = '';
  await withBusy(e.target, async () => {
    try {
      portfolio = await api(`/portfolios/${portfolioId}/name`, { method: 'POST', body: { name: $('name-input').value } });
      render();
    } catch (err) {
      $('name-error').textContent = err.message;
    }
  });
});

$('deposit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('deposit-error').textContent = '';
  await withBusy(e.target, async () => {
    try {
      portfolio = await api(`/portfolios/${portfolioId}/deposit`, { method: 'POST', body: { amount: $('deposit-amount').value } });
      $('deposit-amount').value = '';
      render();
    } catch (err) {
      $('deposit-error').textContent = err.message;
    }
  });
});

$('quote-form').addEventListener('submit', (e) => {
  e.preventDefault();
  lookUp();
});

$('symbol').addEventListener('input', () => {
  clearTimeout(lookupTimer);
  if (!$('symbol').value.trim()) {
    lookupSeq++;
    currentQuote = null;
    $('quote').hidden = true;
    $('trade-form').hidden = true;
    $('trade-error').textContent = '';
    return;
  }
  lookupTimer = setTimeout(() => lookUp({ preview: true }), 450);
});

$('shares').addEventListener('input', updateEstimate);

document.querySelectorAll('.segmented .seg').forEach((b) => b.addEventListener('click', () => setTradeMode(b.dataset.mode)));

$('trade-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const side = e.submitter?.dataset.side || 'buy';
  $('trade-error').textContent = '';
  $('trade-message').textContent = '';
  await withBusy(e.target, async () => {
    try {
      const result = await api(`/portfolios/${portfolioId}/trade`, {
        method: 'POST',
        body: {
          symbol: `${currentQuote.symbol}:${currentQuote.exchange}`,
          side,
          [tradeMode === 'dollars' ? 'dollars' : 'shares']: $('shares').value,
        },
      });
      portfolio = result.portfolio;
      const t = result.trade;
      $('trade-message').textContent = `${side === 'buy' ? 'Bought' : 'Sold'} ${shareFmt.format(t.shares)} ${t.symbol} at ${usd.format(t.price)} for ${usd.format(t.amount)}.`;
      $('shares').value = '';
      currentQuote = { ...currentQuote, price: t.price };
      render();
      renderQuote(currentQuote);
    } catch (err) {
      $('trade-error').textContent = err.message;
    }
  });
});

$('copy-link').addEventListener('click', async () => {
  const input = $('share-link');
  try {
    await navigator.clipboard.writeText(input.value);
    $('copy-link').textContent = 'Copied';
  } catch {
    input.select();
    $('copy-link').textContent = 'Press Ctrl+C';
  }
  setTimeout(() => ($('copy-link').textContent = 'Copy'), 2000);
});

$('refresh').addEventListener('click', async () => {
  const button = $('refresh');
  button.disabled = true;
  button.textContent = 'Refreshing…';
  try {
    await loadPortfolio({ fresh: true });
    if (currentQuote) {
      currentQuote = await api(`/quote?symbol=${encodeURIComponent(`${currentQuote.symbol}:${currentQuote.exchange}`)}&fresh=1`);
      renderQuote(currentQuote);
    }
  } catch (err) {
    $('updated').textContent = `Couldn't refresh: ${err.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Refresh';
  }
});

$('restart').addEventListener('click', async () => {
  if (!confirm('Restart? This sets your cash to $0 and erases all holdings and history, then lets you add new starting cash. It cannot be undone.')) return;
  try {
    portfolio = await api(`/portfolios/${portfolioId}/reset`, { method: 'POST' });
  } catch (err) {
    alert(`Couldn't restart: ${err.message}`);
    return;
  }
  currentQuote = null;
  $('quote').hidden = true;
  $('trade-form').hidden = true;
  $('symbol').value = '';
  $('trade-error').textContent = '';
  $('trade-message').textContent = '';
  render();
  $('deposit-amount').focus();
});

// ---------- startup ----------

const fromLink = new URLSearchParams(location.search).get('p');
if (fromLink) {
  storage('set', fromLink);
  history.replaceState(null, '', '/');
}
portfolioId = fromLink || storage('get');
if (portfolioId) showApp();
else showSetup();
