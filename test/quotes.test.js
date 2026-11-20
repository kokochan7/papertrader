import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getQuote, parseSymbol, parseGoogleFinancePage, clearQuoteCache, QuoteError, marketSession } from '../src/quotes.js';

const googlePage = ({ price = '227.48', currency = 'USD', name = 'Apple Inc', symbol = 'AAPL', prev = '$225.00' } = {}) => `
<html><head><title>${name} (${symbol}) Stock Price &amp; News - Google Finance</title></head>
<body><div class="YMlKec fxKbKc">$${price}</div>
<div jsname="ip75Cb" data-last-price="${price}" data-last-normal-market-timestamp="1730236800" data-currency-code="${currency}"></div>
<div class="gyFHrc"><span class="mfs7Fc">Previous close</div><div class="P6K39c">${prev}</div></div>
</body></html>`;

// Fake fetch: serves Google pages for the listings in `google`, Yahoo JSON for `yahoo`.
function fakeFetch({ google = {}, yahoo = {} } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const g = /finance\/quote\/([^:]+):(.+)$/.exec(url);
    if (g) {
      const page = google[`${decodeURIComponent(g[1])}:${g[2]}`];
      return new Response(page ?? '<html><title>Google Finance</title></html>', { status: 200 });
    }
    const y = /chart\/([^?]+)/.exec(url);
    if (y && yahoo[y[1]]) return Response.json({ chart: { result: [{ meta: yahoo[y[1]] }] } });
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => clearQuoteCache());

// A weekday mid-session, so these tests don't depend on when they run.
const MARKET_HOURS = new Date('2026-11-18T16:00:00Z');

test('parseSymbol accepts bare and exchange-qualified symbols', () => {
  assert.deepEqual(parseSymbol(' aapl '), { symbol: 'AAPL', exchange: null });
  assert.deepEqual(parseSymbol('brk.b:nyse'), { symbol: 'BRK.B', exchange: 'NYSE' });
  assert.throws(() => parseSymbol('not a symbol!'), QuoteError);
  assert.throws(() => parseSymbol(''), QuoteError);
  assert.throws(() => parseSymbol('AAPL:LON'), /US exchange/);
});

test('parseGoogleFinancePage reads price, name, currency and previous close', () => {
  assert.deepEqual(parseGoogleFinancePage(googlePage()), {
    price: 227.48, currency: 'USD', name: 'Apple Inc', previousClose: 225,
  });
  assert.equal(parseGoogleFinancePage('<html>no quote here</html>'), null);
});

test('finds the exchange for a bare symbol on Google Finance', async () => {
  const fetchImpl = fakeFetch({ google: { 'KO:NYSE': googlePage({ price: '62.10', name: 'Coca-Cola Co', symbol: 'KO' }) } });
  const q = await getQuote('ko', { fetchImpl , now: MARKET_HOURS });
  assert.equal(q.symbol, 'KO');
  assert.equal(q.exchange, 'NYSE');
  assert.equal(q.price, 62.1);
  assert.equal(q.source, 'google');
  assert.equal(q.googleUrl, 'https://www.google.com/finance/quote/KO:NYSE');
});

test('falls back to Yahoo when Google has no price', async () => {
  const fetchImpl = fakeFetch({
    yahoo: { 'BRK-B': { regularMarketPrice: 450.5, chartPreviousClose: 448, currency: 'USD', exchangeName: 'NYQ', longName: 'Berkshire Hathaway Inc.' } },
  });
  const q = await getQuote('BRK.B', { fetchImpl , now: MARKET_HOURS });
  assert.equal(q.source, 'yahoo');
  assert.equal(q.exchange, 'NYSE');
  assert.equal(q.price, 450.5);
  assert.equal(q.googleUrl, 'https://www.google.com/finance/quote/BRK.B:NYSE');
});

test('rejects unknown symbols and non-USD listings', async () => {
  await assert.rejects(getQuote('ZZZZ', { fetchImpl: fakeFetch() , now: MARKET_HOURS }), /No quote found/);
  await assert.rejects(getQuote('SHOP:TSE', { fetchImpl: fakeFetch(), now: MARKET_HOURS }), /US exchange/);
  const fetchImpl = fakeFetch({ google: { 'SHOP:NYSE': googlePage({ currency: 'CAD', symbol: 'SHOP' }) } });
  await assert.rejects(getQuote('SHOP:NYSE', { fetchImpl, now: MARKET_HOURS }), /only US-dollar/);
});

test('caches quotes briefly unless fresh is requested', async () => {
  const fetchImpl = fakeFetch({ google: { 'AAPL:NASDAQ': googlePage() } });
  await getQuote('AAPL:NASDAQ', { fetchImpl, now: MARKET_HOURS });
  await getQuote('AAPL:NASDAQ', { fetchImpl, now: MARKET_HOURS });
  assert.equal(fetchImpl.calls.length, 1);
  await getQuote('AAPL:NASDAQ', { fetchImpl, fresh: true, now: MARKET_HOURS });
  assert.equal(fetchImpl.calls.length, 2);
});

// Fake Yahoo chart with 1-minute bars: `bars` is [[unixSeconds, close], ...].
function yahooChartFetch({ regular, regularTime, bars = [], google = {} }) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const g = /finance\/quote\/([^:]+):(.+)$/.exec(url);
    if (g) {
      const page = google[`${decodeURIComponent(g[1])}:${g[2]}`];
      return new Response(page ?? '<html></html>', { status: 200 });
    }
    if (/chart\//.test(url)) {
      return Response.json({ chart: { result: [{
        meta: { regularMarketPrice: regular, regularMarketTime: regularTime, chartPreviousClose: 48, currency: 'USD', exchangeName: 'NMS', longName: 'ProShares UltraPro Short QQQ' },
        timestamp: bars.map((b) => b[0]),
        indicators: { quote: [{ close: bars.map((b) => b[1]) }] },
      }] } });
    }
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

const at = (iso) => new Date(iso);
const secs = (iso) => Date.parse(iso) / 1000;

test('marketSession follows New York time', () => {
  assert.equal(marketSession(at('2026-11-20T11:00:00Z')), 'pre'); // Fri 6:00 AM EST
  assert.equal(marketSession(at('2026-11-20T14:30:00Z')), 'regular'); // 9:30 AM
  assert.equal(marketSession(at('2026-11-20T20:59:00Z')), 'regular'); // 3:59 PM
  assert.equal(marketSession(at('2026-11-20T21:00:00Z')), 'post'); // 4:00 PM
  assert.equal(marketSession(at('2026-11-21T02:00:00Z')), 'closed'); // Fri 9:00 PM
  assert.equal(marketSession(at('2026-11-21T16:00:00Z')), 'closed'); // Saturday
  assert.equal(marketSession(at('2026-07-01T13:30:00Z')), 'regular'); // 9:30 AM EDT
});

test('pre-market quotes use the latest extended-hours trade, not the frozen close', async () => {
  const fetchImpl = yahooChartFetch({
    regular: 49.42,
    regularTime: secs('2026-11-19T21:00:00Z'),
    bars: [[secs('2026-11-20T12:00:00Z'), 50.8], [secs('2026-11-20T13:10:00Z'), 51.2]],
    google: { 'SQQQ:NASDAQ': googlePage({ price: '49.42', symbol: 'SQQQ' }) },
  });
  const q = await getQuote('SQQQ', { fetchImpl, now: at('2026-11-20T13:12:00Z') });
  assert.equal(q.price, 51.2);
  assert.equal(q.session, 'pre');
  assert.equal(q.live, true);
  assert.equal(q.exchange, 'NASDAQ');
  assert.ok(fetchImpl.calls.every((u) => !u.includes('google.com')), 'Google is skipped outside market hours');
  assert.match(fetchImpl.calls[0], /includePrePost=true/);
});

test('with no extended-hours trades the regular close is the latest price', async () => {
  const fetchImpl = yahooChartFetch({
    regular: 49.42,
    regularTime: secs('2026-11-20T21:00:00Z'),
    bars: [[secs('2026-11-20T20:59:00Z'), 49.4]],
  });
  const q = await getQuote('SQQQ', { fetchImpl, now: at('2026-11-21T03:00:00Z') });
  assert.equal(q.price, 49.42);
  assert.equal(q.live, true);
});

test('outside market hours a frozen Google price is marked not live', async () => {
  const fetchImpl = fakeFetch({ google: { 'AAPL:NASDAQ': googlePage() } }); // Yahoo unavailable
  const q = await getQuote('AAPL:NASDAQ', { fetchImpl, now: at('2026-11-20T23:00:00Z') });
  assert.equal(q.price, 227.48);
  assert.equal(q.live, false);
});

test('during market hours Google stays the primary source', async () => {
  const fetchImpl = fakeFetch({ google: { 'AAPL:NASDAQ': googlePage() } });
  const q = await getQuote('AAPL', { fetchImpl, now: at('2026-11-20T15:00:00Z') });
  assert.equal(q.source, 'google');
  assert.equal(q.live, true);
  assert.equal(q.session, 'regular');
});
