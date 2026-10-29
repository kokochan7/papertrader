-- Money is stored in integer cents; share counts may be fractional.
CREATE TABLE portfolios (
  id TEXT PRIMARY KEY,
  cash_cents INTEGER NOT NULL,
  deposited_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE holdings (
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  name TEXT,
  shares REAL NOT NULL,
  cost_cents INTEGER NOT NULL,
  PRIMARY KEY (portfolio_id, symbol)
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('deposit', 'buy', 'sell')),
  symbol TEXT,
  exchange TEXT,
  shares REAL,
  price REAL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX transactions_by_portfolio ON transactions (portfolio_id, id DESC);
