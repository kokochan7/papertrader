import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getQuote, parseSymbol, parseGoogleFinancePage, clearQuoteCache, QuoteError } from '../src/quotes.js';

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

test('parseSymbol accepts bare and exchange-qualified symbols', () => {
  assert.deepEqual(parseSymbol(' aapl '), { symbol: 'AAPL', exchange: null });
  assert.deepEqual(parseSymbol('brk.b:nyse'), { symbol: 'BRK.B', exchange: 'NYSE' });
  assert.throws(() => parseSymbol('not a symbol!'), QuoteError);
  assert.throws(() => parseSymbol(''), QuoteError);
});

test('parseGoogleFinancePage reads price, name, currency and previous close', () => {
  assert.deepEqual(parseGoogleFinancePage(googlePage()), {
    price: 227.48, currency: 'USD', name: 'Apple Inc', previousClose: 225,
  });
  assert.equal(parseGoogleFinancePage('<html>no quote here</html>'), null);
});

test('finds the exchange for a bare symbol on Google Finance', async () => {
  const fetchImpl = fakeFetch({ google: { 'KO:NYSE': googlePage({ price: '62.10', name: 'Coca-Cola Co', symbol: 'KO' }) } });
  const q = await getQuote('ko', { fetchImpl });
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
  const q = await getQuote('BRK.B', { fetchImpl });
  assert.equal(q.source, 'yahoo');
  assert.equal(q.exchange, 'NYSE');
  assert.equal(q.price, 450.5);
  assert.equal(q.googleUrl, 'https://www.google.com/finance/quote/BRK.B:NYSE');
});

test('rejects unknown symbols and non-USD listings', async () => {
  await assert.rejects(getQuote('ZZZZ', { fetchImpl: fakeFetch() }), /No quote found/);
  const fetchImpl = fakeFetch({ google: { 'SHOP:TSE': googlePage({ currency: 'CAD', symbol: 'SHOP' }) } });
  await assert.rejects(getQuote('SHOP:TSE', { fetchImpl }), /only US-dollar/);
});

test('caches quotes briefly unless fresh is requested', async () => {
  const fetchImpl = fakeFetch({ google: { 'AAPL:NASDAQ': googlePage() } });
  await getQuote('AAPL:NASDAQ', { fetchImpl });
  await getQuote('AAPL:NASDAQ', { fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  await getQuote('AAPL:NASDAQ', { fetchImpl, fresh: true });
  assert.equal(fetchImpl.calls.length, 2);
});
