// Real-time quotes.
//
// Google Finance has no public API, so the primary source is the Google Finance
// quote page itself (https://www.google.com/finance/quote/AAPL:NASDAQ), which
// carries the live price in a `data-last-price` attribute. If Google blocks the
// request or changes its markup, we fall back to Yahoo Finance's free chart
// endpoint so trading keeps working. Either way the ticker links to Google Finance.

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

// US exchanges, in the order we try them when the user types a bare symbol.
export const US_EXCHANGES = ['NASDAQ', 'NYSE', 'NYSEARCA', 'NYSEAMERICAN', 'BATS'];

// Yahoo exchange codes -> Google Finance exchange names.
const YAHOO_EXCHANGES = {
  NMS: 'NASDAQ', NGM: 'NASDAQ', NCM: 'NASDAQ', NAS: 'NASDAQ',
  NYQ: 'NYSE', PCX: 'NYSEARCA', ASE: 'NYSEAMERICAN', BTS: 'BATS',
};

const CACHE_TTL_MS = 15_000;
const cache = new Map();

export class QuoteError extends Error {}

// Accepts "aapl", "AAPL:NASDAQ" or "BRK.B". Returns { symbol, exchange|null }.
export function parseSymbol(input) {
  const text = String(input ?? '').trim().toUpperCase();
  const match = /^([A-Z0-9][A-Z0-9.\-]{0,9})(?::([A-Z]{2,15}))?$/.exec(text);
  if (!match) throw new QuoteError(`"${input}" doesn't look like a stock symbol`);
  // Only US listings. A US ticker names the same security on every US exchange, so a typed
  // exchange can't swap in a different company that happens to share the ticker abroad.
  if (match[2] && !US_EXCHANGES.includes(match[2])) {
    throw new QuoteError(`${match[2]} isn't supported. Use a US exchange: ${US_EXCHANGES.join(', ')}`);
  }
  return { symbol: match[1], exchange: match[2] ?? null };
}

export function googleFinanceUrl(symbol, exchange) {
  // Google writes class B shares as BRK.B -> "BRK.B:NYSE"
  return `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:${encodeURIComponent(exchange)}`;
}

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function parseMoney(text) {
  const n = Number(String(text).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Pulls a quote out of a Google Finance quote page. Returns null if the page has no price.
export function parseGoogleFinancePage(html) {
  const price = /data-last-price="([0-9.]+)"/.exec(html);
  if (!price) return null;
  const currency = /data-currency-code="([A-Z]{3})"/.exec(html);
  const title = /<title>([^<]*?)\s*\([^()]*\)\s*Stock Price/i.exec(html);
  const prevClose = /Previous close<\/div>[\s\S]{0,400}?class="P6K39c"[^>]*>([^<]+)</.exec(html);
  return {
    price: Number(price[1]),
    currency: currency ? currency[1] : 'USD',
    name: title ? decodeEntities(title[1].trim()) : null,
    previousClose: prevClose ? parseMoney(prevClose[1]) : null,
  };
}

async function fetchGoogle(symbol, exchange, fetchImpl) {
  const url = googleFinanceUrl(symbol, exchange);
  const res = await fetchImpl(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!res.ok) return null;
  const parsed = parseGoogleFinancePage(await res.text());
  return parsed && { ...parsed, symbol, exchange, source: 'google' };
}

async function fromGoogle(symbol, exchange, fetchImpl) {
  const exchanges = exchange ? [exchange] : US_EXCHANGES;
  const results = await Promise.all(
    exchanges.map((ex) => fetchGoogle(symbol, ex, fetchImpl).catch(() => null)),
  );
  return results.find(Boolean) ?? null;
}

// Which part of the US trading day `date` falls in, by New York wall-clock time:
// 'pre' (4:00-9:30), 'regular' (9:30-16:00), 'post' (16:00-20:00) or 'closed' (overnight, weekends).
// Exchange holidays read as a normal day; no shares trade then, so the last price stays correct.
export function marketSession(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'closed';
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return 'pre';
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return 'regular';
  if (minutes >= 16 * 60 && minutes < 20 * 60) return 'post';
  return 'closed';
}

// The most recent trade in a Yahoo chart response's 1-minute bars, or null if there are none.
function lastBar(result) {
  const times = result?.timestamp ?? [];
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  let best = null;
  for (let i = 0; i < times.length; i++) {
    if (closes[i] > 0 && (!best || times[i] > best.time)) best = { time: times[i], price: closes[i] };
  }
  return best;
}

// Yahoo's free chart endpoint. With 1-minute bars including pre/post market, it carries both
// the regular-session price and the latest extended-hours trade.
async function fromYahoo(symbol, fetchImpl) {
  const yahooSymbol = symbol.replace('.', '-'); // BRK.B -> BRK-B
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1m&includePrePost=true`;
  const res = await fetchImpl(url, { headers: BROWSER_HEADERS });
  if (!res.ok) return null;
  const result = (await res.json())?.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta || !(meta.regularMarketPrice > 0)) return null;
  const latest = lastBar(result);
  const regularTime = meta.regularMarketTime ?? 0;
  return {
    symbol,
    exchange: YAHOO_EXCHANGES[meta.exchangeName] ?? meta.exchangeName ?? 'NASDAQ',
    price: meta.regularMarketPrice,
    // A bar newer than the last regular-session trade is a pre-market or after-hours trade.
    extendedPrice: latest && latest.time > regularTime ? latest.price : null,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    currency: meta.currency ?? 'USD',
    name: meta.longName ?? meta.shortName ?? null,
    source: 'yahoo',
  };
}

// Returns { symbol, exchange, name, price, previousClose, currency, source, session, live, googleUrl }.
//
// During regular market hours the price is Google Finance's last price (Yahoo if Google fails).
// Outside them, Google and Yahoo's headline price is frozen at the 4 PM close while pre-market and
// after-hours trading moves on, so the price comes from Yahoo's latest extended-hours trade instead.
// `live` is false when that extended-hours price couldn't be fetched and the frozen price was used:
// fine for showing a portfolio, but trades must refuse it.
//
// Pass { fresh: true } to skip the short-lived cache (used when placing trades).
export async function getQuote(input, { fetchImpl = fetch, fresh = false, now = new Date() } = {}) {
  const { symbol, exchange } = parseSymbol(input);
  const key = `${symbol}:${exchange ?? ''}`;
  const hit = cache.get(key);
  if (!fresh && hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.quote;

  const session = marketSession(now);
  let quote = null;
  if (session !== 'regular') {
    const yahoo = await fromYahoo(symbol, fetchImpl).catch(() => null);
    if (yahoo) {
      quote = { ...yahoo, price: yahoo.extendedPrice ?? yahoo.price, live: true };
      if (exchange) quote.exchange = exchange;
    }
  }
  if (!quote) {
    quote = await fromGoogle(symbol, exchange, fetchImpl);
    if (!quote) {
      quote = await fromYahoo(symbol, fetchImpl).catch(() => null);
      if (quote && exchange) quote.exchange = exchange; // keep the listing the user asked for
    }
    if (quote) quote.live = session === 'regular';
  }
  if (!quote) throw new QuoteError(`No quote found for ${exchange ? `${symbol}:${exchange}` : symbol}`);
  if (quote.currency !== 'USD') {
    throw new QuoteError(`${symbol} trades in ${quote.currency}; only US-dollar listings are supported`);
  }

  delete quote.extendedPrice;
  quote.session = session;
  quote.googleUrl = googleFinanceUrl(quote.symbol, quote.exchange);
  quote.at = now.toISOString();
  cache.set(key, { at: now.getTime(), quote });
  return quote;
}

export function clearQuoteCache() {
  cache.clear();
}
