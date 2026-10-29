import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

// Runs the real Worker against a local D1 database. Outbound requests to Google
// Finance are answered by a fake that serves quote pages at prices set by the test.
const prices = { 'AAPL:NASDAQ': 200, 'KO:NYSE': 60, 'MSFT:NYSE': 400 };

function googlePage(symbol, price) {
  return `<html><head><title>${symbol} Corp (${symbol}) Stock Price &amp; News - Google Finance</title></head>
<body><div data-last-price="${price}" data-currency-code="USD"></div></body></html>`;
}

let mf;
let base;

before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: 'src/index.js',
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2025-09-01',
    d1Databases: ['DB'],
    outboundService(request) {
      const m = /finance\/quote\/([^:]+):(.+)$/.exec(request.url);
      const key = m && `${decodeURIComponent(m[1])}:${m[2]}`;
      if (key && prices[key]) return new Response(googlePage(m[1], prices[key]));
      return new Response('<html></html>', { status: m ? 200 : 404 });
    },
  });
  const db = await mf.getD1Database('DB');
  for (const file of readdirSync('migrations').sort()) {
    const sql = readFileSync(`migrations/${file}`, 'utf8').replace(/--.*$/gm, '');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  base = (await mf.ready).toString().replace(/\/$/, '');
});

after(() => mf?.dispose());

async function call(method, path, body) {
  const res = await mf.dispatchFetch(`${base}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

test('full trading flow persists cash, holdings and history', async () => {
  const created = await call('POST', '/portfolios', { name: 'Alice', startingCash: 12500.5 });
  assert.equal(created.status, 201);
  const id = created.data.id;

  let { data: p } = await call('GET', `/portfolios/${id}`);
  assert.equal(p.name, 'Alice');
  assert.equal(p.cash, 12500.5);
  assert.equal(p.total, 12500.5);
  assert.equal(p.deposited, 12500.5);

  // Starting cash is the only deposit allowed until a Restart.
  const again = await call('POST', `/portfolios/${id}/deposit`, { amount: 100 });
  assert.equal(again.status, 400);
  assert.match(again.data.error, /already added/);

  let res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'aapl', side: 'buy', shares: 10 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.trade, { side: 'buy', symbol: 'AAPL', shares: 10, price: 200, amount: 2000 });
  p = res.data.portfolio;
  assert.equal(p.cash, 10500.5);
  assert.equal(p.positions[0].googleUrl, 'https://www.google.com/finance/quote/AAPL:NASDAQ');

  // Price rises; buy more at the new price and check average cost.
  prices['AAPL:NASDAQ'] = 250;
  res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'AAPL:NASDAQ', side: 'buy', shares: 10 });
  p = res.data.portfolio;
  assert.equal(p.positions[0].shares, 20);
  assert.equal(p.positions[0].avgCost, 225);
  assert.equal(p.positions[0].value, 5000);
  assert.equal(p.gain, 500);

  // Sell half: cost basis drops proportionally.
  res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'AAPL', side: 'sell', shares: 10 });
  p = res.data.portfolio;
  assert.equal(p.positions[0].shares, 10);
  assert.equal(p.positions[0].cost, 2250);
  assert.equal(p.cash, 8000.5 + 2500);

  // Selling more than owned or buying more than cash allows is refused.
  res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'AAPL', side: 'sell', shares: 11 });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /only own 10/);
  res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'buy', shares: 1000 });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Not enough cash/);

  // Sell the rest: the position disappears.
  res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'AAPL', side: 'sell', shares: 10 });
  p = res.data.portfolio;
  assert.equal(p.positions.length, 0);
  assert.equal(p.cash, 13000.5);
  assert.equal(p.gain, 500);
  assert.deepEqual(p.transactions.map((t) => t.type), ['sell', 'sell', 'buy', 'buy', 'deposit']);

  assert.equal((await call('DELETE', `/portfolios/${id}`)).status, 200);
  assert.equal((await call('GET', `/portfolios/${id}`)).status, 404);
});

test('fractional shares and input validation', async () => {
  const { data: { id } } = await call('POST', '/portfolios', { name: 'Bob', startingCash: 100 });
  const res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'buy', shares: 0.5 });
  assert.equal(res.data.portfolio.cash, 70);
  assert.equal(res.data.portfolio.positions[0].shares, 0.5);

  assert.equal((await call('POST', '/portfolios', { name: 'Neg', startingCash: -5 })).status, 400);
  assert.equal((await call('POST', `/portfolios/${id}/deposit`, { amount: 'abc' })).status, 400);
  assert.equal((await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'short', shares: 1 })).status, 400);
  assert.equal((await call('POST', `/portfolios/${id}/trade`, { symbol: 'NOPE', side: 'buy', shares: 1 })).status, 400);
  assert.equal((await call('GET', '/portfolios/does-not-exist')).status, 404);
});

test('buying and selling by dollar amount converts to fractional shares', async () => {
  const { data: { id } } = await call('POST', '/portfolios', { name: 'Dana', startingCash: 1000 });
  // KO is $60: $100 buys 1.6666 shares (rounded down), costing $100.00 after rounding to cents.
  let res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'buy', dollars: 100 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.trade.shares, 1.6666);
  assert.equal(res.data.trade.amount, 100);
  assert.equal(res.data.portfolio.cash, 900);

  res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'buy', dollars: 5000 });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Not enough cash/);

  // Selling the whole position's value in dollars sells every share.
  res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'sell', dollars: 100 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.trade.shares, 1.6666);
  assert.deepEqual(res.data.portfolio.positions, []);

  assert.equal((await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'buy', dollars: 0.001 })).status, 400);
});

test('reset sets cash to $0 and clears holdings and history', async () => {
  const { data: { id } } = await call('POST', '/portfolios', { name: 'Eve', startingCash: 1000 });
  await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'buy', shares: 2 });
  const { status, data: p } = await call('POST', `/portfolios/${id}/reset`);
  assert.equal(status, 200);
  assert.equal(p.cash, 0);
  assert.equal(p.deposited, 0);
  assert.equal(p.total, 0);
  assert.equal(p.gain, 0);
  assert.deepEqual(p.positions, []);
  assert.deepEqual(p.transactions, []);

  // The same portfolio keeps working after a reset.
  const after = await call('POST', `/portfolios/${id}/deposit`, { amount: 50 });
  assert.equal(after.data.cash, 50);
  assert.equal(after.data.transactions.length, 1);
  assert.equal((await call('POST', '/portfolios/missing/reset')).status, 404);
});

test('names are required, validated and unique ignoring case', async () => {
  assert.equal((await call('POST', '/portfolios', { startingCash: 100 })).status, 400);
  assert.equal((await call('POST', '/portfolios', { name: 'x'.repeat(25), startingCash: 100 })).status, 400);
  assert.equal((await call('POST', '/portfolios', { name: '<script>', startingCash: 100 })).status, 400);
  const first = await call('POST', '/portfolios', { name: '  Frank   Lee ', startingCash: 100 });
  assert.equal(first.status, 201);
  assert.equal((await call('GET', `/portfolios/${first.data.id}`)).data.name, 'Frank Lee');
  const dupe = await call('POST', '/portfolios', { name: 'frank lee', startingCash: 100 });
  assert.equal(dupe.status, 409);
  assert.match(dupe.data.error, /taken/);

  // A portfolio from before names existed can pick one later.
  const db = await mf.getD1Database('DB');
  await db.prepare("INSERT INTO portfolios (id, cash_cents, deposited_cents) VALUES ('legacy', 100, 100)").run();
  assert.equal((await call('POST', '/portfolios/legacy/name', { name: 'FRANK LEE' })).status, 409);
  const named = await call('POST', '/portfolios/legacy/name', { name: 'Grace' });
  assert.equal(named.status, 200);
  assert.equal(named.data.name, 'Grace');
});

test('leaderboard ranks by percent return and never exposes portfolio ids', async () => {
  const big = (await call('POST', '/portfolios', { name: 'Big', startingCash: 100000 })).data.id;
  const small = (await call('POST', '/portfolios', { name: 'Small', startingCash: 1000 })).data.id;
  await call('POST', `/portfolios/${big}/trade`, { symbol: 'KO', side: 'buy', shares: 100 });
  await call('POST', `/portfolios/${small}/trade`, { symbol: 'KO', side: 'buy', shares: 10 });
  prices['KO:NYSE'] = 66; // +10% on the stock
  // A fresh trade at the new price also refreshes the Worker's short quote cache.
  const late = (await call('POST', '/portfolios', { name: 'Late', startingCash: 66 })).data.id;
  await call('POST', `/portfolios/${late}/trade`, { symbol: 'KO:NYSE', side: 'buy', shares: 1 });
  const { status, data } = await call('GET', `/leaderboard?me=${small}`);
  prices['KO:NYSE'] = 60;
  assert.equal(status, 200);
  const rows = Object.fromEntries(data.players.map((p) => [p.name, p]));
  // Small put 60% of their cash in KO (+6% overall); Big put 6% in (+0.6%), so Small ranks higher.
  assert.ok(Math.abs(rows.Small.returnPct - 0.06) < 1e-9);
  assert.ok(Math.abs(rows.Big.returnPct - 0.006) < 1e-9);
  assert.ok(rows.Small.rank < rows.Big.rank);
  assert.equal(rows.Small.you, true);
  assert.equal(rows.Big.you, false);
  assert.equal(rows.Small.holdings, 1);
  assert.ok(!JSON.stringify(data).includes(big) && !JSON.stringify(data).includes(small));
});

test('public player view is read-only and hides the portfolio id', async () => {
  const id = (await call('POST', '/portfolios', { name: 'Viewer Test', startingCash: 600 })).data.id;
  await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO:NYSE', side: 'buy', shares: 5 });
  const { status, data } = await call('GET', `/players/${encodeURIComponent('viewer test')}`);
  assert.equal(status, 200);
  assert.equal(data.name, 'Viewer Test');
  assert.equal(data.positions[0].symbol, 'KO');
  assert.equal(data.deposited, 600);
  assert.equal(data.id, undefined);
  assert.ok(!JSON.stringify(data).includes(id));
  assert.equal((await call('GET', '/players/nobody')).status, 404);
  // There is no write route under /players.
  assert.equal((await call('POST', '/players/Viewer%20Test', { side: 'buy' })).status, 404);
});

test('admin routes need the admin key and can rename, reset and delete players', async () => {
  const db = await mf.getD1Database('DB');
  const adminCall = async (method, path, key, body) => {
    const res = await mf.dispatchFetch(`${base}/api/admin${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await adminCall('GET', '/players', 'anything')).status, 403); // not set up yet

  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('s3cret-key')))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.prepare("INSERT INTO settings (key, value) VALUES ('admin_key_sha256', ?)").bind(hash).run();

  assert.equal((await adminCall('GET', '/players')).status, 401);
  assert.equal((await adminCall('GET', '/players', 'wrong')).status, 401);
  const id = (await call('POST', '/portfolios', { name: 'Admin Target', startingCash: 300 })).data.id;
  const list = await adminCall('GET', '/players', 's3cret-key');
  assert.equal(list.status, 200);
  const target = list.data.players.find((p) => p.name === 'Admin Target');
  assert.equal(target.id, id);
  assert.equal(target.deposited, 300);

  assert.equal((await adminCall('POST', `/players/${id}/name`, 's3cret-key', { name: 'Renamed' })).status, 200);
  assert.equal((await call('GET', `/portfolios/${id}`)).data.name, 'Renamed');
  assert.equal((await adminCall('POST', `/players/${id}/reset`, 's3cret-key')).status, 200);
  assert.equal((await call('GET', `/portfolios/${id}`)).data.deposited, 0);
  assert.equal((await adminCall('DELETE', `/players/${id}`, 'wrong')).status, 401);
  assert.equal((await adminCall('DELETE', `/players/${id}`, 's3cret-key')).status, 200);
  assert.equal((await call('GET', `/portfolios/${id}`)).status, 404);
});

test('quote endpoint returns the Google Finance link', async () => {
  const { status, data } = await call('GET', '/quote?symbol=msft');
  assert.equal(status, 200);
  assert.equal(data.exchange, 'NYSE');
  assert.equal(data.price, 400);
  assert.equal(data.googleUrl, 'https://www.google.com/finance/quote/MSFT:NYSE');
});
