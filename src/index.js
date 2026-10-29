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

async function createPortfolio(db, body) {
  const cents = toCents(body.startingCash);
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare('INSERT INTO portfolios (id, cash_cents, deposited_cents) VALUES (?, ?, ?)').bind(id, cents, cents),
    db.prepare("INSERT INTO transactions (portfolio_id, type, amount_cents) VALUES (?, 'deposit', ?)").bind(id, cents),
  ]);
  return { id };
}

async function deposit(db, id, body) {
  const cents = toCents(body.amount);
  await loadPortfolio(db, id);
  await db.batch([
    db.prepare('UPDATE portfolios SET cash_cents = cash_cents + ?1, deposited_cents = deposited_cents + ?1 WHERE id = ?2').bind(cents, id),
    db.prepare("INSERT INTO transactions (portfolio_id, type, amount_cents) VALUES (?, 'deposit', ?)").bind(id, cents),
  ]);
}

async function trade(db, id, body) {
  const side = body.side;
  if (side !== 'buy' && side !== 'sell') throw new HttpError(400, 'side must be "buy" or "sell"');
  const shares = toShares(body.shares);
  const portfolio = await loadPortfolio(db, id);
  const quote = await quoteOrError(body.symbol, { fresh: true });
  const amount = Math.round(shares * quote.price * 100);
  const holding = await db
    .prepare('SELECT * FROM holdings WHERE portfolio_id = ? AND symbol = ?')
    .bind(id, quote.symbol)
    .first();

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

async function getPortfolio(db, id) {
  const portfolio = await loadPortfolio(db, id);
  const [{ results: holdings }, { results: transactions }] = await Promise.all([
    db.prepare('SELECT * FROM holdings WHERE portfolio_id = ? ORDER BY symbol').bind(id).all(),
    db.prepare('SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY id DESC LIMIT 100').bind(id).all(),
  ]);

  const positions = await Promise.all(
    holdings.map(async (h) => {
      const quote = await getQuote(`${h.symbol}:${h.exchange}`).catch(() => null);
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

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ["api", ...]
  const method = request.method;
  const db = env.DB;
  if (parts[0] !== 'api') throw new HttpError(404, 'Not found');

  if (parts[1] === 'quote' && parts.length === 2 && method === 'GET') {
    return json(await quoteOrError(url.searchParams.get('symbol')));
  }
  if (parts[1] === 'portfolios') {
    if (parts.length === 2 && method === 'POST') return json(await createPortfolio(db, await readBody(request)), 201);
    const id = parts[2];
    if (parts.length === 3 && method === 'GET') return json(await getPortfolio(db, id));
    if (parts.length === 3 && method === 'DELETE') {
      await db.batch(
        ['transactions', 'holdings'].map((table) => db.prepare(`DELETE FROM ${table} WHERE portfolio_id = ?`).bind(id))
          .concat(db.prepare('DELETE FROM portfolios WHERE id = ?').bind(id)),
      );
      return json({ ok: true });
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
