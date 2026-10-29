import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

// Runs the real Worker against a local D1 database. Outbound requests to Google
// Finance are answered by a fake that serves quote pages at prices set by the test.
const prices = { 'AAPL:NASDAQ': 200, 'KO:NYSE': 60 };

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
  const sql = readFileSync('migrations/0001_init.sql', 'utf8').replace(/--.*$/gm, '');
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(statement).run();
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
  const created = await call('POST', '/portfolios', { startingCash: 10000 });
  assert.equal(created.status, 201);
  const id = created.data.id;

  let { data: p } = await call('GET', `/portfolios/${id}`);
  assert.equal(p.cash, 10000);
  assert.equal(p.total, 10000);

  ({ data: p } = await call('POST', `/portfolios/${id}/deposit`, { amount: 2500.5 }));
  assert.equal(p.cash, 12500.5);
  assert.equal(p.deposited, 12500.5);

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
  assert.deepEqual(p.transactions.map((t) => t.type), ['sell', 'sell', 'buy', 'buy', 'deposit', 'deposit']);

  assert.equal((await call('DELETE', `/portfolios/${id}`)).status, 200);
  assert.equal((await call('GET', `/portfolios/${id}`)).status, 404);
});

test('fractional shares and input validation', async () => {
  const { data: { id } } = await call('POST', '/portfolios', { startingCash: 100 });
  const res = await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'buy', shares: 0.5 });
  assert.equal(res.data.portfolio.cash, 70);
  assert.equal(res.data.portfolio.positions[0].shares, 0.5);

  assert.equal((await call('POST', '/portfolios', { startingCash: -5 })).status, 400);
  assert.equal((await call('POST', `/portfolios/${id}/deposit`, { amount: 'abc' })).status, 400);
  assert.equal((await call('POST', `/portfolios/${id}/trade`, { symbol: 'KO', side: 'short', shares: 1 })).status, 400);
  assert.equal((await call('POST', `/portfolios/${id}/trade`, { symbol: 'NOPE', side: 'buy', shares: 1 })).status, 400);
  assert.equal((await call('GET', '/portfolios/does-not-exist')).status, 404);
});

test('quote endpoint returns the Google Finance link', async () => {
  const { status, data } = await call('GET', '/quote?symbol=ko');
  assert.equal(status, 200);
  assert.equal(data.exchange, 'NYSE');
  assert.equal(data.price, 60);
  assert.equal(data.googleUrl, 'https://www.google.com/finance/quote/KO:NYSE');
});
