# Kenny's Paper Trader

A multiplayer paper trading website. Anyone can play: pick a name and how much simulated cash to
start with, type a stock symbol, and buy or sell at the current market price. A public rankings
page shows who's doing best. Portfolios are saved in a database, so they're still there when you
come back.

It runs on Cloudflare: a [Worker](https://developers.cloudflare.com/workers/) serves the page and
the API, and a [D1](https://developers.cloudflare.com/d1/) database stores portfolios. Everything
fits in Cloudflare's free tier.

## Features

- Enter a name and any starting amount to play; no account needed
- One deposit per game: the Add cash box disappears after your starting cash (Restart to play again)
- Public **Rankings** page, ranked by percent return so different starting amounts compare fairly
- Click a name in the rankings to see that player's portfolio, view only
- Look up any US-listed stock or ETF by symbol (`AAPL`, `KO`, `BRK.B`, or `AAPL:NASDAQ`)
- Buy and sell, including fractional shares, at the live price
- Holdings with average cost, today's change, market value and gain/loss; prices refresh every 30 seconds
- Full trade and deposit history
- **Refresh** button for up-to-the-second prices, and **Restart** to wipe everything back to $0
- Every ticker links to its Google Finance page
- Each browser gets its own portfolio; a private link opens it on another device
- **Admin page** at `/admin.html` (key-protected): see every player, copy their private link, rename, reset or delete

## Where prices come from

Google Finance doesn't have an official API. The Worker reads the price straight from the public
Google Finance quote page (for example `https://www.google.com/finance/quote/AAPL:NASDAQ`), which
carries the live price in its markup. When you type a bare symbol it tries the US exchanges
(NASDAQ, NYSE, NYSE Arca, NYSE American, Cboe BZX) to find the listing.

Scraping can break if Google changes its page or rate-limits Cloudflare's servers, so if Google
returns no price the Worker falls back to Yahoo Finance's free chart endpoint. Either way the
ticker still links to Google Finance. Quotes are cached for 15 seconds for display; trades always
fetch a fresh price. Only US-dollar listings are supported so cash stays in one currency.

## Deploy to Cloudflare

The D1 database (`papertrader`) already exists and its id is in `wrangler.toml`.

**Automatic deploys from GitHub (recommended):** in the Cloudflare dashboard go to
**Workers & Pages → Create → Import a repository**, pick this repo, and set the deploy command to
`npm run deploy`. Every push to `main` then applies any new database migrations and deploys.
Your site will be at `https://papertrader.<your-subdomain>.workers.dev`; to use your own domain,
add it under the Worker's **Settings → Domains & Routes**.

**From your own computer:** with Node.js 18 or newer,

```sh
npm install
npx wrangler login
npm run deploy
```

If you ever point this at a fresh account, create a database first with
`npx wrangler d1 create papertrader` and put the printed id in `wrangler.toml`.

### Admin key

The admin page checks a key against its SHA-256 hash in the `settings` table, so the key itself
is never stored. To set or change it:

```sh
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" 'your-new-key'
npx wrangler d1 execute papertrader --remote --command \
  "INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_key_sha256', '<hash from above>')"
```

## Run it locally

```sh
npm install
npm run dev      # http://localhost:8787, using a local D1 database
```

## Tests

```sh
npm test
```

The tests run the real Worker against a local D1 database with a fake Google Finance, so they
don't need a network connection or a Cloudflare account.

## API

| Method | Path | Body | |
| --- | --- | --- | --- |
| `GET` | `/api/quote?symbol=AAPL` | | Live quote (add `&fresh=1` to skip the 15s cache) |
| `POST` | `/api/portfolios` | `{ "name": "Kenny", "startingCash": 10000 }` | Create a portfolio, returns `{ id }` |
| `GET` | `/api/portfolios/:id` | | Cash, positions with live prices, history (`?fresh=1` skips the cache) |
| `POST` | `/api/portfolios/:id/deposit` | `{ "amount": 500 }` | Add starting cash (only when nothing has been added since the last reset) |
| `POST` | `/api/portfolios/:id/name` | `{ "name": "Kenny" }` | Set or change the player name |
| `GET` | `/api/players/:name` | | Read-only view of a player's portfolio (no portfolio id) |
| `GET` | `/api/leaderboard?me=:id` | | Public rankings; `me` marks your own row (ids are never returned) |
| `POST` | `/api/portfolios/:id/trade` | `{ "symbol": "AAPL", "side": "buy", "shares": 10 }` or `"dollars": 500` | Buy or sell at the current price |
| `POST` | `/api/portfolios/:id/reset` | | Set cash to $0 and erase holdings and history |
| `DELETE` | `/api/portfolios/:id` | | Delete the portfolio |

## Project layout

```
public/          the web page (plain HTML, CSS and JavaScript)
src/index.js     the Worker: API routes and portfolio logic
src/quotes.js    Google Finance quotes, with the Yahoo Finance fallback
migrations/      D1 database schema
test/            tests (node --test)
```
