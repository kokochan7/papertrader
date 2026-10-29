# Kenny's Paper Trader

A paper trading website. Pick how much simulated cash to start with, add more whenever you like,
type a stock symbol, and buy or sell at the current market price. Portfolios are saved in a
database, so they're still there when you come back.

It runs on Cloudflare: a [Worker](https://developers.cloudflare.com/workers/) serves the page and
the API, and a [D1](https://developers.cloudflare.com/d1/) database stores portfolios. Everything
fits in Cloudflare's free tier.

## Features

- Start with any amount of simulated cash and add more at any time
- Look up any US-listed stock or ETF by symbol (`AAPL`, `KO`, `BRK.B`, or `AAPL:NASDAQ`)
- Buy and sell, including fractional shares, at the live price
- Holdings with average cost, today's change, market value and gain/loss; prices refresh every 30 seconds
- Full trade and deposit history
- **Refresh** button for up-to-the-second prices, and **Restart** to wipe everything back to $0
- Every ticker links to its Google Finance page
- Each browser gets its own portfolio; a private link opens it on another device

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
| `POST` | `/api/portfolios` | `{ "startingCash": 10000 }` | Create a portfolio, returns `{ id }` |
| `GET` | `/api/portfolios/:id` | | Cash, positions with live prices, history (`?fresh=1` skips the cache) |
| `POST` | `/api/portfolios/:id/deposit` | `{ "amount": 500 }` | Add cash |
| `POST` | `/api/portfolios/:id/trade` | `{ "symbol": "AAPL", "side": "buy", "shares": 10 }` | Buy or sell at the current price |
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
