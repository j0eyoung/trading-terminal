# Trading terminal

A local, Bloomberg-style terminal: market data and research for any ticker, plus
portfolio and order entry through Alpaca and Interactive Brokers.

## Run

```bash
.venv\Scripts\streamlit run app.py
```

Then open http://localhost:8501. Market data works immediately with no accounts.

## Connect your accounts

Copy `.env.example` to `.env` and fill in what you have. Restart the app after editing.

| What | Where to get it | Setting |
|---|---|---|
| Alpaca | app.alpaca.markets > API Keys (paper and live accounts each have their own pair) | `ALPACA_PAPER_API_KEY`, `ALPACA_PAPER_SECRET_KEY`, `ALPACA_LIVE_API_KEY`, `ALPACA_LIVE_SECRET_KEY` |
| Interactive Brokers | Run TWS or IB Gateway, log in to the paper account, enable Settings > API > "Enable ActiveX and Socket Clients" | `IBKR_ENABLED=true` |
| Claude panel (optional) | console.anthropic.com > API keys | `ANTHROPIC_API_KEY` |

`TRADING_MODE=paper` (default) uses simulated money. Set `TRADING_MODE=live` to use
the live Alpaca keys (and log TWS in to the live account) to trade real money.

With Alpaca connected, the ticker line and watchlist update every second from a background
price stream (IEX feed, up to 30 symbols at once). The dot next to the price says which you
are getting: green "Live" (streaming), amber "Delayed" (stream reconnecting; hover for why,
prices then refresh every 5 seconds). Run only one copy of the app at a time: the free Alpaca
plan allows a single stream connection, and a second copy is refused while the first keeps it.

The S&P 500 scan is saved in `.cache/` and refreshed in the background every 30 minutes, so
only the very first load waits (about a minute). Any screen can be opened by URL, e.g.
http://localhost:8501/?f=SPX, and any stock with http://localhost:8501/?t=NVDA.

## Commands

Type a ticker, a function code, or both in the command bar: `NVDA`, `GP`, `MSFT FA`.

| Code | Screen |
|---|---|
| DES | Company description and key ratios |
| GP | Price chart |
| FA | Financial statements |
| N | News |
| ANR | Analyst ratings and price targets |
| VAL | DCF fair value, rating, Piotroski and Altman scores, ratios (Financial Modeling Prep key) |
| ERN | Earnings vs estimates and upcoming earnings calendar (Finnhub key) |
| SEC | SEC filings with links, and insider buys and sells (Finnhub key for insiders) |
| ECO | Rates, inflation, unemployment, GDP, VIX, credit spreads (FRED key) |
| MON | Watchlist monitor |
| SCR | Stock screens |
| SPX | All S&P 500 stocks ranked by momentum, trend and RSI, with sector filter |
| OMON | Options chain with live bid/ask and greeks; tick a contract to send it to the order ticket |
| ALRT | Price alerts (checked every 15 seconds while the app is open) |
| PORT | Balances and positions at each broker |
| ORD | Order ticket (stocks and option contracts, optional take-profit / stop-loss bracket via Alpaca), open orders, cancel |
| AI | Research chat (Claude if `ANTHROPIC_API_KEY` is set, otherwise Gemini) |

## Also in the app

- **Home**: Portfolio (opens first), Trade, **Journal** (every order with your note, win rate by setup tag),
  **Gains & dividends** (first-in-first-out realized gains split short/long term, dividends received and
  upcoming, CSV downloads), Alerts.
- **Watchlists**: several named lists saved in the app; add/remove from the Watchlist screen or with
  "+ Watchlist" on any stock.
- **Order card**: "Size by risk" works out shares from how much you're willing to lose and your stop;
  "Journal note" saves why you made the trade.
- **News sentiment**: each headline tagged positive / negative / neutral by the AI, with an overall mood.
- **Predictions**: Kalshi and Polymarket, plus IBKR **ForecastEx** odds through IB Gateway (product codes set
  on that screen, e.g. FF for the Fed funds rate).
- **Assistant > My trading plan**: goals, risk limits and rules sent with every AI question.
- **Assistant > Connect Claude**: sign in with your Claude subscription the same way the Claude Code CLI does.
  The AI features then run on your subscription (its usage limits apply); Claude can only answer and search
  the web there. Choose the AI with `ai_choice` in the add-on (auto = subscription, then API key, then Gemini).
## Run it on Home Assistant (Green or any 64-bit Home Assistant OS)

This repository is a Home Assistant add-on repository with two add-ons:

- **Trading Terminal** (`trading_terminal/`): this app, in the Home Assistant sidebar behind
  Home Assistant's login. Its data lives in the add-on's own storage.
- **IB Gateway** (`ib_gateway/`): Interactive Brokers Gateway running headless, built on
  [gnzsnz/ib-gateway-docker](https://github.com/gnzsnz/ib-gateway-docker). Optional.

Keys and passwords are entered in each add-on's **Configuration** tab in Home Assistant. They are
never in this repository (`.env` is git-ignored).

1. Settings > Add-ons > Add-on Store > ⋮ > **Repositories**, add
   `https://github.com/j0eyoung/trading-terminal`, then close and refresh the store.
2. Install **Trading Terminal** (the first build takes a while on a Green). On its
   **Configuration** tab paste your keys, Save, **Start**, and turn on **Show in sidebar**.
3. Optional, for Interactive Brokers: install **IB Gateway**. On its Configuration tab pick`n   `trading_mode` (paper, live, or both) and fill in the matching login: IBKR gives the paper`n   account its own username and password (`paper_username` / `paper_password`), separate from`n   the live one (`live_username` / `live_password`). Start it and approve the login on your phone`n   if IBKR asks. Then in Trading Terminal's Configuration turn `ibkr_enabled` on and set`n   `ibkr_host` to the **Hostname** on the IB Gateway add-on's Info tab (`e8950327-ib-gateway``n   when installed from this repository). Leave `ibkr_port` empty: it follows Trading Terminal's`n   `trading_mode` (4004 paper, 4003 live). Restart Trading Terminal.
4. Stop any other copy of the app while the Home Assistant one runs: the free Alpaca plan
   allows only one live price stream.

To update after code changes: run `powershell -File make_addon.ps1` (refreshes the copy of the
code inside `trading_terminal/app`), raise `version` in that add-on's `config.yaml`, commit and
push, then press **Update** on the add-on page in Home Assistant.

IB Gateway logs out regularly and may ask for a phone approval to log back in: if Trading
Terminal says Interactive Brokers is not connected, check the IB Gateway add-on's Log tab.

If IBKR asks you to choose between multiple second-factor methods, set `twofa_device`
in the IB Gateway add-on's Configuration to the exact device name shown by IBKR.
See the [IB Gateway setup guide](ib_gateway/DOCS.md) for details; phone approval is still required.

If the sidebar page stays blank, set a port for 8501 in the add-on's Network section and open
`http://homeassistant.local:8501` on your home network instead (that route has no login, so
never forward it to the internet).

**Access from outside your home:** install the **Tailscale** add-on in Home Assistant and the
Tailscale app on your phone. Only your own devices can reach it, with no ports opened. Don't
expose this app to the internet any other way: it holds your broker keys and can place orders.

## Use it from Claude Code / Claude Desktop (no API key needed)

`mcp_server.py` exposes the terminal's data (quotes, fundamentals, news, screens,
your portfolio) to Claude as read-only tools. It cannot place orders.

```bash
claude mcp add trading-terminal -- C:\AntiGravity\TradingApp\.venv\Scripts\python.exe C:\AntiGravity\TradingApp\mcp_server.py
```
