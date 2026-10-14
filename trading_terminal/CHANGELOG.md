# Changelog

## 0.3.0 - 2026-10-14
- **Opens straight away.** The page no longer waits for the broker connection and the AI check (which could take a minute after a restart). Screens that need the broker say "Connecting to your broker…" and fill in by themselves.
- **Live prices.** Prices on screen are pushed from the server once a second from the Alpaca stream (every 5 seconds for indexes, futures and anything the stream doesn't cover), instead of the page asking every 5 seconds.
- **Size by risk** on the order ticket: enter the dollars you're willing to lose and a stop price, and it sets the share count, capped by the max position size in My trading plan, and fills in the stop loss. The risk amount starts from your plan's risk per trade.
- **Portfolio vs the S&P 500**: the equity chart shows what the same money would have done in SPY over the same range, with how far ahead or behind you are. New panels for open P/L by position and closed P/L by journal tag.
- **Alerts explain themselves**: when a price alert hits, the AI adds a two-sentence "why" from the latest headlines, earnings dates and the market's move. It shows as a second notification and on the Alerts screen.
- **Keyboard shortcuts**: `/` command bar, `[` `]` step through recent tickers, `D` `G` `N` `F` `A` `E` `O` for the stock screens, `B`/`S` buy or sell ticket, `P` portfolio, `W` watchlists, `M` markets, `I` Ask AI, `?` for the list. The command bar lists your recent tickers when empty, and the side column shows them too.
- Each screen remembers its settings (ranges, statement, screen, idea list, prediction topic, backtest) and the app reopens on the last screen you used.
- Notifications can be closed by clicking them; old ones no longer replay when the page reloads.
- New smoke test (`python -m tests.smoke`) that checks every API route, the order safety checks and the page scripts before a release.

## 0.2.0 - 2026-10-07
- **New terminal interface.** The slow Streamlit screens are replaced by a fast Bloomberg-style web app: function rail, command bar (type `NVDA GP`, `AAPL N`, `PORT`), dense panels and a live watchlist column. Every previous screen carries over, and prices update every few seconds.
- **Phone friendly.** On a phone or the Home Assistant app it shows one panel at a time with bottom tabs (Home, Stock, Market, Trade, AI).
- Faster: slow data is cached and refreshed in the background, the main screens are pre-loaded at start-up, and watchlist quotes come in one batch from Alpaca. Price alerts and earnings reminders are checked on the server even when no page is open.
- Charts are drawn in the page itself (line, candles, SMA, Bollinger, RSI, MACD, volume, compare with SPY).
- Option `ui`: `new` (default) or `classic` to go back to the previous screens if anything is missing.

## 0.1.16 - 2026-10-03
- Fixed: Ask AI could sit forever without replying when using your Claude subscription. It now sends a small summary of the screen (Claude looks up the rest with its tools) instead of first gathering every data set, which could take a minute or more. Prediction-market odds no longer hold up screens while they load.
- While Claude works, Ask AI shows what it's looking up ("Looking up: get_quote ..."). If something goes wrong you get the reason within seconds, and a stuck answer is stopped after 10 minutes instead of hanging.
- If your Claude sign-in has expired, Ask AI says so and Assistant > Connect Claude asks you to sign in again.
- Each question writes `[claude] ...` lines to the Log tab (started, tools used, answered or the error) to help track down problems.

## 0.1.15 - 2026-10-02
- **Claude now has 30 read-only research tools** when it answers through your subscription (Ask AI and the morning brief). It looks up what each question needs, for any asset class: quotes and history for stocks, ETFs, indexes, futures, forex and crypto; technicals; company profiles; 15 years of SEC financial statements; earnings; analyst views; valuation scores; news; insider trades; full SEC filing text; options chains with implied volatility, expected move and put/call ratios; ETF holdings and sector weights; a market overview (indexes, futures, yields, dollar, commodities, sectors); an S&P 500 screener; any FRED economic series (searchable); prediction-market odds; backtests; and your own portfolio, orders, journal, gains and trading plan. None of the tools can trade.
- The tools run as an always-on service inside the add-on, so they're ready instantly.
- Effort: Ask AI and the morning brief run at **high**; headline sentiment at **low** (a quick rating that runs often in the background).
- Gemini and an Anthropic API key still get the on-screen data bundle rather than the tools.

## 0.1.14 - 2026-10-02
- Faster switch to the Assistant tab: the morning brief is now written in the background (about a minute) instead of holding up the page; it appears when ready, and the rest of the app stays usable meanwhile.
- The "are you signed in to Claude" check (which starts a small program, slow on the Green) is reused for 10 minutes instead of 1.

## 0.1.13 - 2026-10-02
- Data collection now writes to the Log tab when it starts (`[collector] storage: ...`, saying whether collection is on and, if not, which setting is missing) and whenever it can't reach your storage. Before, a refused connection was silent.
- The Data collection screen says exactly why collection is off.
- Note: the collector starts the first time the app is opened after the add-on starts.

## 0.1.12 - 2026-10-02
- Fixed: uploads to Backblaze B2 (and other S3-compatible storage) could be refused because the storage library added checksum headers those services don't accept.
- New **Test connection** button on Assistant > Data collection: saves and reads back a tiny file and shows the exact error if the storage refuses.

## 0.1.11 - 2026-10-02
- **Data collection** (Assistant > Data collection): after each market close, saves daily price history for the S&P 500 and your stocks (back to 1980 where available), minute prices, daily statistics snapshots, SEC financial statements (weekly) and news with sentiment to **your own storage**: an S3-compatible bucket (Cloudflare R2, Backblaze B2, or a NAS) or a network folder. Nothing is stored on the Green. Off until you set `store_type` and its settings on the Configuration tab.
- Charts and backtests read daily prices from your collection first (instant, and long history no longer depends on Yahoo). A split or dividend that re-adjusts past prices is detected and that stock's history is rebuilt.
- New settings: `store_type`, `store_path`, `s3_endpoint`, `s3_bucket`, `s3_access_key`, `s3_secret_key`, `s3_prefix`, `s3_region`, `minute_backfill_days`.
- This update installs two new libraries, so it takes longer to build than the last few.

## 0.1.10 - 2026-10-02
- **Financials** now come from companies' own SEC filings: about 15 years of annual results (Yahoo had 4) and 12 quarters, with a chart of the headline lines (revenue and net income, assets and liabilities, operating and free cash flow). Yahoo is still used for companies that don't file with the SEC.
- **Backtest** has a new "Max" period that tests a rule on a stock's entire price history (back to 1980 for Apple), so it's tested through the 2000 and 2008 crashes too.

## 0.1.9 - 2026-10-02
Data from official free APIs instead of Yahoo, with Yahoo kept as a backup:
- Price charts, mini charts and the S&P 500 scan now come from Alpaca's market data (your existing keys). The S&P 500 scan takes about 10 seconds instead of about a minute. Today's chart adds the last 15 minutes from the live feed, since the free full-market data runs 15 minutes behind. The "MAX" chart range still uses Yahoo (Alpaca goes back about 10 years).
- News comes from Alpaca's feed (Benzinga) first.
- Company profile, key statistics and analyst ratings come from Finnhub first, so a stock you haven't opened before shows its numbers in about a second; Yahoo's fuller profile (the description, employees, price targets) fills in from the background.
- New "Research elsewhere" links on every stock page: Stock Analysis, Seeking Alpha, Google Finance, Finviz, TradingView, plus Koyfin and TIKR.

## 0.1.8 - 2026-10-02
Faster clicks:
- Live sections redraw less often, so clicks don't queue behind them: price header every 3 s (was 1 s), watchlist every 5 s (was 2 s), market panel every 15 s (was 5 s), alerts every 30 s.
- Watchlist quotes, mini charts and the earnings-reminder dates show the last saved copy instantly and refresh in the background, instead of making a page wait while they reload.
- Speed log: anything taking over a second is written to this add-on's Log tab as `[speed] ... took N s`, to pin down what's slow.

## 0.1.7 - 2026-10-02
- Fixed: the section bar (Home, Stock, Market, Assistant) and screen buttons at the top were invisible in 0.1.6, so you couldn't move between screens.

## 0.1.6 - 2026-10-02
Faster screens:
- Clicking a stock in a watchlist, the market panel, your positions or the S&P 500 movers opens it in place instead of reloading the whole app.
- A new stock's quote, company info, news, chart and analyst data now load at the same time instead of one after another.
- Headline sentiment is worked out in the background: the news shows straight away and the tags appear a few seconds later.
- Account balances and positions are reused for 10 seconds instead of being fetched again on every click (refreshed right after you place an order).
- If IB Gateway is down, screens no longer wait up to 8 seconds per click for it; the app retries every 30 seconds.

## 0.1.5 - 2026-10-02
- **Connect Claude** (Assistant): sign in with your Claude subscription the same way the Claude Code CLI does. Ask AI, the morning brief and headline sentiment then run on your subscription. New `ai_choice` setting (auto = subscription, then Anthropic API key, then Gemini).
- **My trading plan** (Assistant): goals, risk limits and rules, sent with every AI question along with your track record and recent journal notes.
- **Journal** (Home): every order you send is logged with your note and tags; add a review afterwards; win rate and profit/loss by setup tag.
- **Gains & dividends** (Home): realized gains (oldest shares first, short- vs long-term), dividends received and upcoming, CSV downloads.
- **Saved watchlists**: several named lists; add, remove and reorder them, or use "+ Watchlist" on any stock.
- **Size by risk** on the order card: shares worked out from how much you'll risk and your stop.
- **Headline sentiment**: each headline tagged Positive / Negative / Neutral, with an overall mood.
- **ForecastEx odds** on Predictions, read through IB Gateway (product codes set on that screen; FF to start).
- IBKR orders: the app waits a few seconds for IBKR to accept an order and shows IBKR's reason when it holds or rejects one.
- Claude Code is now installed in the add-on (first update takes longer).

## 0.1.4 - 2026-10-02
- Portfolio is the home screen; new **Home** section (Portfolio, Trade, Alerts). Clicking the logo goes home.
- Burnt-orange accent colour; gains stay green and losses are a true red.
- Order statuses in plain English ("Sending to IBKR", "Working", "Filled"...); the order list refreshes every 3 seconds; orders still being sent can be canceled.

## 0.1.3 - 2026-10-02
- The Interactive Brokers port now follows `trading_mode` when `ibkr_port` is left empty (4004 paper, 4003 live).

## 0.1.2 - 2026-10-02
- Default IB Gateway host corrected to `e8950327-ib-gateway` (add-ons installed from GitHub aren't named `local-...`).

## 0.1.1 - 2026-10-02
- Fixed the build failing with "pip: not found" (Home Assistant was swapping in its own base image).

## 0.1.0 - 2026-10-02
- First release as a Home Assistant add-on.
