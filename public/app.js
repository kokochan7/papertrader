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
  updateEstimate();
}

function renderQuote(q) {
  const box = $('quote');
  const change = q.previousClose ? q.price - q.previousClose : null;
  const owned = portfolio?.positions.find((p) => p.symbol === q.symbol);
  box.replaceChildren(
    el('div', { class: 'meta' },
      el('span', {}, tickerLink(q.symbol, q.exchange, q.googleUrl), ` · ${q.exchange}`),
      el('a', { href: q.googleUrl, target: '_blank', rel: 'noopener' }, 'View on Google Finance ↗')),
    el('div', { class: 'name' }, q.name || ''),
    el('div', { class: 'price' }, usd.format(q.price)),
    el('div', { class: 'meta' },
      change === null
        ? el('span', { class: 'muted' }, '')
        : el('span', { class: signClass(change) }, `${signed(change)} (${pctFmt.format(change / q.previousClose)}) today`),
      el('span', { class: 'muted' }, owned ? `You own ${shareFmt.format(owned.shares)}` : 'You own 0')),
  );
  box.hidden = false;
  $('trade-form').hidden = false;
  updateEstimate();
}

function updateEstimate() {
  const shares = Number($('shares').value);
  if (!currentQuote || !(shares > 0)) {
    $('estimate').textContent = portfolio && currentQuote
      ? `You can afford about ${shareFmt.format(Math.floor((portfolio.cash / currentQuote.price) * 100) / 100)} shares.`
      : '';
    return;
  }
  $('estimate').textContent = `Estimated ${usd.format(shares * currentQuote.price)} · cash available ${usd.format(portfolio.cash)}`;
}

// ---------- actions ----------

async function loadPortfolio() {
  try {
    portfolio = await api(`/portfolios/${portfolioId}`);
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
  $('setup').hidden = false;
  $('updated').textContent = '';
  $('starting-cash').focus();
}

async function showApp() {
  $('setup').hidden = true;
  $('app').hidden = false;
  await loadPortfolio();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadPortfolio();
  }, REFRESH_MS);
}

async function lookUp() {
  const symbol = $('symbol').value.trim();
  if (!symbol) return;
  $('trade-error').textContent = '';
  $('trade-message').textContent = '';
  await withBusy($('quote-form'), async () => {
    try {
      currentQuote = await api(`/quote?symbol=${encodeURIComponent(symbol)}`);
      renderQuote(currentQuote);
      $('shares').focus();
    } catch (err) {
      currentQuote = null;
      $('quote').hidden = true;
      $('trade-form').hidden = true;
      $('trade-error').textContent = err.message;
    }
  });
}

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('setup-error').textContent = '';
  await withBusy(e.target, async () => {
    try {
      const { id } = await api('/portfolios', { method: 'POST', body: { startingCash: $('starting-cash').value } });
      portfolioId = id;
      storage('set', id);
      $('starting-cash').value = '';
      await showApp();
    } catch (err) {
      $('setup-error').textContent = err.message;
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

$('shares').addEventListener('input', updateEstimate);

$('trade-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const side = e.submitter?.dataset.side || 'buy';
  $('trade-error').textContent = '';
  $('trade-message').textContent = '';
  await withBusy(e.target, async () => {
    try {
      const result = await api(`/portfolios/${portfolioId}/trade`, {
        method: 'POST',
        body: { symbol: `${currentQuote.symbol}:${currentQuote.exchange}`, side, shares: $('shares').value },
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

$('reset').addEventListener('click', async () => {
  if (!confirm('Delete this portfolio and start over? This cannot be undone.')) return;
  try {
    await api(`/portfolios/${portfolioId}`, { method: 'DELETE' });
  } catch {
    // If the delete fails we still forget it locally so the user can start fresh.
  }
  storage('clear');
  currentQuote = null;
  $('quote').hidden = true;
  $('trade-form').hidden = true;
  $('symbol').value = '';
  showSetup();
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
