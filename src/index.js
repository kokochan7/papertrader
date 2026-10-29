import { getQuote, QuoteError } from './quotes.js';

// Each visitor gets their own portfolio, identified by a random id that the browser
// keeps. Anyone with the id can open the portfolio, so it works like a private link.

const MAX_CENTS = 1_000_000_000_00; // $1B cap per deposit keeps numbers sane
const SHARE_DECIMALS = 4;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'Enter an amount greater than $0');
  const cents = Math.round(n * 100);
  if (cents < 1 || cents > MAX_CENTS) throw new HttpError(400, 'Amount must be between $0.01 and $1,000,000,000');
  return cents;
}

function toShares(value) {
  const n = Number(value);
  const factor = 10 ** SHARE_DECIMALS;
  const shares = Math.round(n * factor) / factor;
  if (!Number.isFinite(n) || shares <= 0) throw new HttpError(400, 'Enter a number of shares greater than 0');
  return shares;
}

// Whole number of 0.0001-share units the dollar amount buys, rounded down so it never costs more.
function dollarsToShares(cents, price) {
  const factor = 10 ** SHARE_DECIMALS;
  return Math.floor((cents / 100 / price) * factor + 1e-9) / factor;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be JSON');
  }
}

async function loadPortfolio(db, id) {
  const row = await db.prepare('SELECT * FROM portfolios WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Portfolio not found');
  return row;
}

async function quoteOrError(input, options) {
  try {
    return await getQuote(input, options);
  } catch (err) {
    if (err instanceof QuoteError) throw new HttpError(400, err.message);
    throw err;
  }
}

// Player names show on the public rankings: 1-24 characters, unique ignoring case.
function toName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Enter a name to play');
  if (name.length > 24) throw new HttpError(400, 'Names can be at most 24 characters');
  if (!/^[\p{L}\p{N} ._'-]+$/u.test(name)) throw new HttpError(400, 'Names can use letters, numbers, spaces and . _ \' -');
  return name;
}

async function withUniqueName(name, write) {
  try {
    return await write();
  } catch (err) {
    if (/UNIQUE constraint failed/i.test(String(err?.message))) throw new HttpError(409, `"${name}" is taken. Try another name.`);
    throw err;
  }
}

async function createPortfolio(db, body) {
  const name = toName(body.name);
  const cents = toCents(body.startingCash);
  const id = crypto.randomUUID();
  await withUniqueName(name, () =>
    db.batch([
      db.prepare('INSERT INTO portfolios (id, name, cash_cents, deposited_cents) VALUES (?, ?, ?, ?)').bind(id, name, cents, cents),
      db.prepare("INSERT INTO transactions (portfolio_id, type, amount_cents) VALUES (?, 'deposit', ?)").bind(id, cents),
    ]),
  );
  return { id };
}

async function rename(db, id, body) {
  const name = toName(body.name);
  await loadPortfolio(db, id);
  await withUniqueName(name, () => db.prepare('UPDATE portfolios SET name = ? WHERE id = ?').bind(name, id).run());
}

// Cash can be added once per game: at the start, or again after a Restart.
async function deposit(db, id, body) {
  const cents = toCents(body.amount);
  const portfolio = await loadPortfolio(db, id);
  if (portfolio.deposited_cents > 0) throw new HttpError(400, 'You already added your starting cash. Restart to begin a new game.');
  await db.batch([
    db.prepare('UPDATE portfolios SET cash_cents = cash_cents + ?1, deposited_cents = deposited_cents + ?1 WHERE id = ?2').bind(cents, id),
    db.prepare("INSERT INTO transactions (portfolio_id, type, amount_cents) VALUES (?, 'deposit', ?)").bind(id, cents),
  ]);
}

async function trade(db, id, body) {
  const side = body.side;
  if (side !== 'buy' && side !== 'sell') throw new HttpError(400, 'side must be "buy" or "sell"');
  const byDollars = body.dollars !== undefined && body.dollars !== null && body.dollars !== '';
  const dollarCents = byDollars ? toCents(body.dollars) : null;
  let shares = byDollars ? null : toShares(body.shares);
  const portfolio = await loadPortfolio(db, id);
  const quote = await quoteOrError(body.symbol, { fresh: true });
  const holding = await db
    .prepare('SELECT * FROM holdings WHERE portfolio_id = ? AND symbol = ?')
    .bind(id, quote.symbol)
    .first();
  if (byDollars) {
    shares = dollarsToShares(dollarCents, quote.price);
    // Selling "all of it" in dollars: a cent of rounding shouldn't leave a sliver behind or fail.
    const owned = holding?.shares ?? 0;
    if (side === 'sell' && shares > owned && dollarCents <= Math.round(owned * quote.price * 100) + 1) shares = owned;
    if (shares <= 0) throw new HttpError(400, `$${(dollarCents / 100).toFixed(2)} is less than 0.0001 shares of ${quote.symbol}`);
  }
  const amount = Math.round(shares * quote.price * 100);

  const statements = [];
  if (side === 'buy') {
    if (amount > portfolio.cash_cents) {
      throw new HttpError(400, `Not enough cash: ${shares} ${quote.symbol} costs $${(amount / 100).toFixed(2)}`);
    }
    statements.push(
      db.prepare('UPDATE portfolios SET cash_cents = cash_cents - ? WHERE id = ?').bind(amount, id),
      db.prepare(
        `INSERT INTO holdings (portfolio_id, symbol, exchange, name, shares, cost_cents) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (portfolio_id, symbol) DO UPDATE SET
           shares = round(shares + ?5, ${SHARE_DECIMALS}), cost_cents = cost_cents + ?6, exchange = ?3, name = coalesce(?4, name)`,
      ).bind(id, quote.symbol, quote.exchange, quote.name, shares, amount),
    );
  } else {
    const owned = holding?.shares ?? 0;
    if (shares > owned) throw new HttpError(400, `You only own ${owned} shares of ${quote.symbol}`);
    statements.push(db.prepare('UPDATE portfolios SET cash_cents = cash_cents + ? WHERE id = ?').bind(amount, id));
    if (shares === owned) {
      statements.push(db.prepare('DELETE FROM holdings WHERE portfolio_id = ? AND symbol = ?').bind(id, quote.symbol));
    } else {
      // Average-cost basis: selling part of a position removes that fraction of its cost.
      const costRemoved = Math.round((holding.cost_cents * shares) / owned);
      statements.push(
        db.prepare(
          `UPDATE holdings SET shares = round(shares - ?, ${SHARE_DECIMALS}), cost_cents = cost_cents - ? WHERE portfolio_id = ? AND symbol = ?`,
        ).bind(shares, costRemoved, id, quote.symbol),
      );
    }
  }
  statements.push(
    db.prepare(
      'INSERT INTO transactions (portfolio_id, type, symbol, exchange, shares, price, amount_cents) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, side, quote.symbol, quote.exchange, shares, quote.price, amount),
  );
  await db.batch(statements);
  return { side, symbol: quote.symbol, shares, price: quote.price, amount: amount / 100 };
}

async function resetPortfolio(db, id) {
  await loadPortfolio(db, id);
  await db.batch([
    db.prepare('DELETE FROM transactions WHERE portfolio_id = ?').bind(id),
    db.prepare('DELETE FROM holdings WHERE portfolio_id = ?').bind(id),
    db.prepare('UPDATE portfolios SET cash_cents = 0, deposited_cents = 0 WHERE id = ?').bind(id),
  ]);
}

// Pass fresh to skip the quote cache (the Refresh button).
async function getPortfolio(db, id, { fresh = false } = {}) {
  const portfolio = await loadPortfolio(db, id);
  const [{ results: holdings }, { results: transactions }] = await Promise.all([
    db.prepare('SELECT * FROM holdings WHERE portfolio_id = ? ORDER BY symbol').bind(id).all(),
    db.prepare('SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY id DESC LIMIT 100').bind(id).all(),
  ]);

  const positions = await Promise.all(
    holdings.map(async (h) => {
      const quote = await getQuote(`${h.symbol}:${h.exchange}`, { fresh }).catch(() => null);
      const cost = h.cost_cents / 100;
      const value = quote ? h.shares * quote.price : null;
      return {
        symbol: h.symbol,
        exchange: h.exchange,
        name: quote?.name ?? h.name,
        shares: h.shares,
        cost,
        avgCost: cost / h.shares,
        price: quote?.price ?? null,
        previousClose: quote?.previousClose ?? null,
        value,
        gain: value === null ? null : value - cost,
        googleUrl: `https://www.google.com/finance/quote/${h.symbol}:${h.exchange}`,
      };
    }),
  );

  const cash = portfolio.cash_cents / 100;
  const invested = positions.reduce((sum, p) => sum + (p.value ?? p.cost), 0);
  const deposited = portfolio.deposited_cents / 100;
  return {
    id,
    name: portfolio.name,
    createdAt: portfolio.created_at,
    cash,
    deposited,
    invested,
    total: cash + invested,
    gain: cash + invested - deposited,
    positions,
    transactions: transactions.map((t) => ({
      id: t.id,
      type: t.type,
      symbol: t.symbol,
      exchange: t.exchange,
      shares: t.shares,
      price: t.price,
      amount: t.amount_cents / 100,
      createdAt: t.created_at,
    })),
  };
}

// Public rankings by percent return, so players who started with different amounts compare fairly.
// Never includes portfolio ids: an id is the key to a portfolio. `me` only marks the caller's own row.
async function leaderboard(db, me) {
  const [{ results: players }, { results: holdings }] = await Promise.all([
    db.prepare('SELECT id, name, cash_cents, deposited_cents FROM portfolios WHERE name IS NOT NULL AND deposited_cents > 0').all(),
    db.prepare(
      'SELECT h.portfolio_id, h.symbol, h.exchange, h.shares, h.cost_cents FROM holdings h JOIN portfolios p ON p.id = h.portfolio_id WHERE p.name IS NOT NULL',
    ).all(),
  ]);
  const listings = [...new Set(holdings.map((h) => `${h.symbol}:${h.exchange}`))];
  const prices = new Map(
    await Promise.all(listings.map(async (l) => [l, (await getQuote(l).catch(() => null))?.price ?? null])),
  );
  const byPlayer = new Map();
  for (const h of holdings) {
    const price = prices.get(`${h.symbol}:${h.exchange}`);
    // If a price is unavailable, value the position at cost rather than dropping it.
    const value = price === null ? h.cost_cents / 100 : h.shares * price;
    const entry = byPlayer.get(h.portfolio_id) ?? { value: 0, count: 0 };
    entry.value += value;
    entry.count += 1;
    byPlayer.set(h.portfolio_id, entry);
  }
  const rows = players.map((p) => {
    const stocks = byPlayer.get(p.id) ?? { value: 0, count: 0 };
    const deposited = p.deposited_cents / 100;
    const total = p.cash_cents / 100 + stocks.value;
    return {
      name: p.name,
      started: deposited,
      total,
      gain: total - deposited,
      returnPct: (total - deposited) / deposited,
      holdings: stocks.count,
      you: p.id === me,
    };
  });
  rows.sort((a, b) => b.returnPct - a.returnPct || b.total - a.total || a.name.localeCompare(b.name));
  rows.forEach((r, i) => (r.rank = i + 1));
  return { updatedAt: new Date().toISOString(), players: rows };
}

// Read-only view of a player's portfolio for the rankings page, looked up by name.
// The portfolio id is the key that allows trading, so it is stripped before returning.
async function publicPlayer(db, name) {
  const row = await db
    .prepare('SELECT id FROM portfolios WHERE name IS NOT NULL AND lower(name) = lower(?)')
    .bind(String(name ?? '').trim())
    .first();
  if (!row) throw new HttpError(404, 'Player not found');
  const { id, ...portfolio } = await getPortfolio(db, row.id);
  return { ...portfolio, returnPct: portfolio.deposited ? portfolio.gain / portfolio.deposited : 0 };
}

// ---------- admin ----------
// The admin key is checked against a SHA-256 hash stored in the settings table, so the key itself
// is never in the database or the repo.

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function requireAdmin(request, db) {
  const key = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'admin_key_sha256'").first();
  if (!row) throw new HttpError(403, 'Admin access is not set up');
  if (!key) throw new HttpError(401, 'Enter the admin key');
  const hash = await sha256Hex(key);
  let diff = hash.length ^ row.value.length;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ row.value.charCodeAt(i);
  if (diff !== 0) throw new HttpError(401, 'Wrong admin key');
}

async function adminPlayers(db) {
  const { results } = await db.prepare('SELECT id FROM portfolios ORDER BY created_at DESC').all();
  const players = await Promise.all(results.map((r) => getPortfolio(db, r.id)));
  return {
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      cash: p.cash,
      deposited: p.deposited,
      total: p.total,
      returnPct: p.deposited ? p.gain / p.deposited : 0,
      holdings: p.positions.length,
      trades: p.transactions.filter((t) => t.type !== 'deposit').length,
    })),
  };
}

async function deletePortfolio(db, id) {
  await db.batch(
    ['transactions', 'holdings'].map((table) => db.prepare(`DELETE FROM ${table} WHERE portfolio_id = ?`).bind(id))
      .concat(db.prepare('DELETE FROM portfolios WHERE id = ?').bind(id)),
  );
}

async function adminRoute(request, db, parts) {
  await requireAdmin(request, db);
  const method = request.method;
  if (parts.length === 3 && parts[2] === 'players' && method === 'GET') return json(await adminPlayers(db));
  if (parts[2] === 'players' && parts[3]) {
    const id = parts[3];
    if (parts.length === 4 && method === 'DELETE') {
      await loadPortfolio(db, id);
      await deletePortfolio(db, id);
      return json({ ok: true });
    }
    if (parts.length === 5 && method === 'POST' && parts[4] === 'name') {
      await rename(db, id, await readBody(request));
      return json({ ok: true });
    }
    if (parts.length === 5 && method === 'POST' && parts[4] === 'reset') {
      await resetPortfolio(db, id);
      return json({ ok: true });
    }
  }
  throw new HttpError(404, 'Not found');
}

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ["api", ...]
  const method = request.method;
  const db = env.DB;
  if (parts[0] !== 'api') throw new HttpError(404, 'Not found');

  if (parts[1] === 'quote' && parts.length === 2 && method === 'GET') {
    return json(await quoteOrError(url.searchParams.get('symbol'), { fresh: url.searchParams.has('fresh') }));
  }
  if (parts[1] === 'admin') return adminRoute(request, db, parts);
  if (parts[1] === 'leaderboard' && parts.length === 2 && method === 'GET') {
    return json(await leaderboard(db, url.searchParams.get('me')));
  }
  if (parts[1] === 'players' && parts.length === 3 && method === 'GET') {
    return json(await publicPlayer(db, decodeURIComponent(parts[2])));
  }
  if (parts[1] === 'portfolios') {
    if (parts.length === 2 && method === 'POST') return json(await createPortfolio(db, await readBody(request)), 201);
    const id = parts[2];
    if (parts.length === 3 && method === 'GET') {
      return json(await getPortfolio(db, id, { fresh: url.searchParams.has('fresh') }));
    }
    if (parts.length === 3 && method === 'DELETE') {
      await deletePortfolio(db, id);
      return json({ ok: true });
    }
    if (parts.length === 4 && method === 'POST' && parts[3] === 'name') {
      await rename(db, id, await readBody(request));
      return json(await getPortfolio(db, id));
    }
    if (parts.length === 4 && method === 'POST' && parts[3] === 'reset') {
      await resetPortfolio(db, id);
      return json(await getPortfolio(db, id));
    }
    if (parts.length === 4 && method === 'POST' && parts[3] === 'deposit') {
      await deposit(db, id, await readBody(request));
      return json(await getPortfolio(db, id));
    }
    if (parts.length === 4 && method === 'POST' && parts[3] === 'trade') {
      const result = await trade(db, id, await readBody(request));
      return json({ trade: result, portfolio: await getPortfolio(db, id) });
    }
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong' }, 500);
    }
  },
};
