"""The terminal's web server: a JSON API over the terminal package plus the single-page front end in static/.

Run locally:   .venv\\Scripts\\python -m web.server            (http://localhost:8501)
In the add-on, addon_entry.py starts it behind Home Assistant's ingress proxy. Every URL the page uses is
relative, so it works under ingress's /api/hassio_ingress/<token>/ prefix.

Speed: slow sources are memoised in memory with stale-while-revalidate (an expired value is returned at once
and refreshed in the background), heavy pages never wait on optional data, and the most used data is warmed
at start-up.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import HTMLResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from terminal import (alerts, backtest, cache, collector, config, data, gains, ideas, journal,  # noqa: E402
                      predictions, profile, sources, store, stream, tools, watchlists)
from terminal import indicators as ind  # noqa: E402
from terminal.brokers import OrderRequest, connect_all  # noqa: E402

VERSION = "0.3.0"
STATIC = Path(__file__).resolve().parent / "static"
NY, LOCAL_TZ = "America/New_York", "America/Denver"
SLOW = 1.0


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---------- memo: stale-while-revalidate ----------
_memo: dict[str, tuple[float, object]] = {}
_memo_locks: dict[str, threading.Lock] = {}
_memo_busy: set[str] = set()
_memo_guard = threading.Lock()


def memo(key: str, ttl: float, fn, stale: bool = True):
    """fn()'s value, reused for `ttl` seconds. Once expired the old value is returned straight away and
    refreshed in the background (stale=True), so only the very first call ever waits."""
    hit = _memo.get(key)
    now = time.time()
    if hit and now - hit[0] < ttl:
        return hit[1]
    if hit and stale:
        with _memo_guard:
            start = key not in _memo_busy
            _memo_busy.add(key)
        if start:
            def refresh():
                try:
                    _memo[key] = (time.time(), _timed(key, fn))
                except Exception as e:
                    log(f"[web] refresh {key} failed: {e}")
                finally:
                    _memo_busy.discard(key)
            threading.Thread(target=refresh, daemon=True, name=f"memo-{key[:40]}").start()
        return hit[1]
    with _memo_guard:
        lock = _memo_locks.setdefault(key, threading.Lock())
    with lock:  # one fetch per key; callers arriving meanwhile wait for it instead of fetching again
        hit = _memo.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        value = _timed(key, fn)
        _memo[key] = (time.time(), value)
        return value


def forget(prefix: str) -> None:
    for k in [k for k in _memo if k.startswith(prefix)]:
        _memo.pop(k, None)


def peek(key: str, ttl: float, fn, default=None):
    """Like memo() but never waits: before the first value exists it starts fetching in the background and
    returns `default`. For start-up data the page can fill in a moment later."""
    if key in _memo:
        return memo(key, ttl, fn)
    with _memo_guard:
        start = key not in _memo_busy
        _memo_busy.add(key)
    if start:
        def first():
            try:
                memo(key, ttl, fn, stale=False)
            except Exception as e:
                log(f"[web] {key} failed: {e}")
            finally:
                _memo_busy.discard(key)
        threading.Thread(target=first, daemon=True, name=f"peek-{key}").start()
    return default


def _timed(what: str, fn):
    started = time.perf_counter()
    try:
        return fn()
    finally:
        took = time.perf_counter() - started
        if took >= SLOW:
            log(f"[speed] {what} took {took:.1f}s")


def key_of(*parts) -> str:
    return hashlib.md5("|".join(map(str, parts)).encode()).hexdigest()[:12]


# ---------- JSON ----------
def clean(v):
    """JSON-safe: NaN/inf -> None, numpy -> python, timestamps -> ISO strings, DataFrames -> records."""
    if v is None or isinstance(v, (str, bool)):
        return v
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        return None if math.isnan(v) or math.isinf(v) else float(v)
    if isinstance(v, (pd.Timestamp, np.datetime64)):
        return None if pd.isna(v) else str(pd.Timestamp(v))
    if hasattr(v, "isoformat"):
        return v.isoformat()
    if isinstance(v, pd.DataFrame):
        return [clean(r) for r in v.to_dict("records")]
    if isinstance(v, pd.Series):
        return [clean(x) for x in v.tolist()]
    if isinstance(v, dict):
        return {str(k): clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [clean(x) for x in v]
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return str(v)


def ok(value, status: int = 200) -> Response:
    return Response(json.dumps(clean(value), separators=(",", ":")), status_code=status,
                    media_type="application/json", headers={"Cache-Control": "no-store"})


def fail(msg: str, status: int = 400) -> Response:
    return ok({"error": msg}, status)


def api(fn):
    """Route wrapper: runs the handler in a worker thread (data calls block) and turns errors into JSON."""
    async def endpoint(request: Request):
        if request.method == "POST" and request.headers.get("x-terminal") != "1":
            return fail("missing request header", 403)  # blocks cross-site form posts
        body = {}
        if request.method == "POST":
            try:
                body = await request.json()
            except Exception:
                body = {}
        try:
            result = await run_in_threadpool(fn, request.query_params, body, request.path_params)
        except Exception as e:
            log(f"[web] {request.url.path} failed: {type(e).__name__}: {e}")
            return fail(sources.clean_error(e) or type(e).__name__, 500)
        return result if isinstance(result, Response) else ok(result)
    return endpoint


def sym_of(p) -> str:
    return (p.get("s") or p.get("symbol") or "").strip().upper()


def syms_of(p) -> list[str]:
    return [s.strip().upper() for s in (p.get("s") or "").split(",") if s.strip()][:80]


# ---------- brokers ----------
_brokers: dict = {"at": 0.0, "brokers": {}, "errors": {}}
_broker_lock = threading.Lock()
RETRY_BROKERS = 60


def brokers() -> tuple[dict, dict]:
    with _broker_lock:
        missing = set(_brokers["errors"])
        if not _brokers["at"] or (missing and time.time() - _brokers["at"] > RETRY_BROKERS):
            b, e = connect_all()
            _brokers.update(at=time.time(), brokers={**_brokers["brokers"], **b}, errors=e)
        return _brokers["brokers"], _brokers["errors"]


def broker(name: str):
    b, _ = brokers()
    if not b:
        raise RuntimeError("No broker connected")
    return b.get(name) or next(iter(b.values()))


def account(name: str) -> dict:
    return memo(f"acct:{name}", 8, lambda: broker(name).account(), stale=False)


def positions(name: str) -> list[dict]:
    return memo(f"pos:{name}", 8, lambda: broker(name).positions(), stale=False)


def held_symbols() -> list[str]:
    out = []
    for name in brokers()[0]:
        try:
            out += [p["symbol"] for p in positions(name) if not OrderRequest(p["symbol"], "buy", 1).is_option]
        except Exception:
            pass
    return list(dict.fromkeys(out))


# ---------- quotes ----------
def quotes(symbols: list[str]) -> dict[str, dict]:
    """Fast quotes; daily references reused for 2 minutes, live prices every call (memoised 2 s)."""
    symbols = list(dict.fromkeys(symbols))
    us = sorted(s for s in symbols if data.alpaca_symbol(s))
    refs = memo(f"refs:{key_of(*us)}", 120, lambda: data.daily_refs(us)) if us else {}
    other = [s for s in symbols if s not in refs]
    out = data.fast_quotes([s for s in us if s in refs], refs)
    if other:  # Yahoo: memoised per symbol and fetched side by side
        from concurrent.futures import ThreadPoolExecutor

        def one(s):
            try:
                return memo(f"yq:{s}", 30, lambda: data.quote(s, {}))
            except Exception:
                return None
        with ThreadPoolExecutor(min(10, len(other))) as pool:
            for s, q in zip(other, pool.map(one, other)):
                if q and q.get("last") is not None:
                    out[s] = q
    return out


def live_api(p, b, pp):
    """Server-sent quotes for the symbols on screen: once a second from the Alpaca stream when it's live, with
    the regular quotes (every 5 s) for anything the stream doesn't cover. Only changed quotes are sent. The
    connection closes after a few minutes and the browser reconnects by itself."""
    syms = syms_of(p)
    us = [s for s in syms if data.alpaca_symbol(s)]
    stream.watch(us)
    keys = ("last", "prev_close", "change", "change_pct", "bid", "ask", "day_high", "day_low", "volume")

    def gen():
        sent: dict[str, tuple] = {}
        started = last_beat = time.time()
        while time.time() - started < 300:
            try:
                base = memo(f"q5:{key_of(*syms)}", 5, lambda: quotes(syms))
                out = {}
                for s in syms:
                    q = dict(base.get(s) or {})
                    live = stream.get(s) if s in us else None
                    if live and q.get("prev_close"):
                        q.update(last=live["last"], bid=live["bid"], ask=live["ask"], change=live["last"] - q["prev_close"],
                                 change_pct=(live["last"] / q["prev_close"] - 1) * 100,
                                 day_high=max(q.get("day_high") or live["last"], live["last"]),
                                 day_low=min(q.get("day_low") or live["last"], live["last"]))
                    if q.get("last") is None:
                        continue
                    row = {k: q.get(k) for k in keys}
                    sig = tuple(row.values())
                    if sent.get(s) != sig:
                        sent[s] = sig
                        out[s] = row
                if out:
                    yield sse({"quotes": clean(out), "stream": stream.status()[0]})
                    last_beat = time.time()
                    if p.get("once"):  # tests: one message, then close
                        return
                elif time.time() - last_beat > 15:
                    yield ": keep-alive\n\n"
                    last_beat = time.time()
            except Exception as e:
                log(f"[web] live quotes: {e}")
            time.sleep(1)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def q_api(p, b, pp):
    syms = syms_of(p)
    out = quotes(syms)
    keys = ("symbol", "last", "prev_close", "change", "change_pct", "bid", "ask", "day_high", "day_low", "open",
            "volume", "source")
    rows = {s: {k: out[s].get(k) for k in keys} for s in syms if s in out}
    if p.get("spark"):
        us = sorted(s for s in syms if data.alpaca_symbol(s))
        sparks = memo(f"spark:{key_of(*us)}", 120, lambda: data.sparklines(us)) if us else {}
        for s, r in rows.items():
            if sparks.get(s):
                r["spark"] = sparks[s][-80:]
    return {"quotes": rows, "stream": stream.status()[0], "t": time.time()}


# ---------- price history / charts ----------
RANGES = {"1D": ("1d", "5m"), "5D": ("5d", "15m"), "1M": ("1mo", "1h"), "3M": ("3mo", "1d"), "6M": ("6mo", "1d"),
          "YTD": ("ytd", "1d"), "1Y": ("1y", "1d"), "5Y": ("5y", "1wk"), "MAX": ("max", "1mo")}


def history(symbol: str, rng: str) -> pd.DataFrame:
    period, interval = RANGES.get(rng, RANGES["1Y"])
    return memo(f"hist:{symbol}:{rng}", 60 if interval.endswith(("m", "h")) else 900,
                lambda: data.history(symbol, period, interval))


def ms(index) -> np.ndarray:
    """Epoch milliseconds for any datetime index (pandas 3 may hold seconds, micro- or nanoseconds)."""
    idx = pd.DatetimeIndex(index)
    idx = idx.tz_convert("UTC") if idx.tz is not None else idx.tz_localize("UTC")
    return idx.as_unit("ms").asi8


def bars_json(df: pd.DataFrame) -> dict:
    idx = pd.DatetimeIndex(df.index)
    t = ms(idx)
    r = lambda c: [None if pd.isna(x) else round(float(x), 4) for x in df[c]]
    return {"t": t.tolist(), "o": r("Open"), "h": r("High"), "l": r("Low"), "c": r("Close"),
            "v": [None if pd.isna(x) else float(x) for x in df["Volume"]]}


def history_api(p, b, pp):
    s, rng = sym_of(p), p.get("range", "1D")
    df = history(s, rng)
    if df.empty:
        return {"symbol": s, "range": rng, "t": []}
    out = {"symbol": s, "range": rng, "intraday": RANGES.get(rng, RANGES["1Y"])[1].endswith(("m", "h")),
           **bars_json(df)}
    if rng == "1D":
        q = quotes([s]).get(s) or {}
        out["prev_close"] = q.get("prev_close")
    return out


def chart_api(p, b, pp):
    """Bars plus indicators for the GP screen. Daily indicators use 5 years so long averages start filled."""
    s, rng = sym_of(p), p.get("range", "1Y")
    want = set((p.get("ind") or "").split(","))
    df = history(s, rng)
    if df.empty:
        return {"symbol": s, "t": []}
    interval = RANGES.get(rng, RANGES["1Y"])[1]
    full = memo(f"hist5y:{s}", 900, lambda: data.history(s, "5y", "1d")) if interval == "1d" and rng != "MAX" else df
    close = full["Close"]
    fit = lambda x: [None if pd.isna(v) else round(float(v), 4) for v in x.reindex(df.index)]
    out = {"symbol": s, "range": rng, "intraday": interval.endswith(("m", "h")), **bars_json(df), "ind": {}}
    for n in (20, 50, 200):
        if f"sma{n}" in want:
            out["ind"][f"SMA {n}"] = fit(ind.sma(close, n))
    if "bb" in want:
        lo, mid, hi = ind.bollinger(close)
        out["ind"].update({"BB upper": fit(hi), "BB mid": fit(mid), "BB lower": fit(lo)})
    if "rsi" in want:
        out["rsi"] = fit(ind.rsi(close))
    if "macd" in want:
        m, sig, h = ind.macd(close)
        out["macd"] = {"macd": fit(m), "signal": fit(sig), "hist": fit(h)}
    if p.get("vs"):
        spy = history("SPY", rng)
        if not spy.empty:
            out["vs"] = {"symbol": "SPY", **bars_json(spy)}
    return out


# ---------- stock pages ----------
INFO_KEYS = ["longName", "shortName", "quoteType", "exchange", "sector", "industry", "country", "city", "state",
             "website", "fullTimeEmployees", "longBusinessSummary", "marketCap", "enterpriseValue", "trailingPE",
             "forwardPE", "pegRatio", "priceToSalesTrailing12Months", "priceToBook", "enterpriseToEbitda",
             "totalRevenue", "revenueGrowth", "earningsGrowth", "grossMargins", "operatingMargins", "profitMargins",
             "returnOnEquity", "returnOnAssets", "freeCashflow", "totalCash", "totalDebt", "debtToEquity",
             "currentRatio", "dividendYield", "dividendRate", "payoutRatio", "exDividendDate", "beta",
             "sharesOutstanding", "floatShares", "shortPercentOfFloat", "shortRatio", "heldPercentInsiders",
             "heldPercentInstitutions", "averageVolume", "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "targetMeanPrice",
             "targetLowPrice", "targetHighPrice", "recommendationKey", "numberOfAnalystOpinions", "trailingEps",
             "forwardEps", "open", "category", "fundFamily", "totalAssets", "netExpenseRatio", "yield"]


def info(s: str) -> dict:
    return memo(f"info:{s}", 1800, lambda: data.info(s))


def overview_api(p, b, pp):
    s = sym_of(p)
    i = info(s)
    return {"symbol": s, "info": {k: i.get(k) for k in INFO_KEYS if i.get(k) not in (None, "")},
            "quote": quotes([s]).get(s), "watching": s in watchlists.symbols(), "active_list": watchlists.active()}


def news_api(p, b, pp):
    s = sym_of(p)
    items = memo(f"news:{s}", 300, lambda: data.news(s))[: int(p.get("n", 20))]
    out = {"symbol": s, "items": [{k: n.get(k) for k in ("published", "publisher", "title", "url", "thumb", "summary")}
                                  for n in items]}
    if p.get("sent") and items:
        from terminal import ai, sentiment

        if ai.provider():
            titles = [n["title"] for n in items[:15]]
            k = "sent-" + key_of(s, *titles)
            scores, _, running, err = cache.get(k, lambda: sentiment.score(s, titles), 6 * 3600)
            if scores:
                out["sentiment"] = scores
                if k not in _sent_saved:
                    _sent_saved.add(k)
                    threading.Thread(target=collector.record_sentiment, args=(s, titles, scores), daemon=True).start()
            out["sentiment_pending"] = bool(running and not scores)
            out["sentiment_error"] = err if not scores and not running else None
            out["rated_by"] = ai.provider()
    return out


_sent_saved: set[str] = set()


def analysts_api(p, b, pp):
    s = sym_of(p)
    recs = memo(f"recs:{s}", 3600, lambda: data.recommendations(s))
    i = info(s)
    return {"symbol": s, "recs": recs, "target_mean": i.get("targetMeanPrice"), "target_low": i.get("targetLowPrice"),
            "target_high": i.get("targetHighPrice"), "consensus": i.get("recommendationKey"),
            "analysts": i.get("numberOfAnalystOpinions"), "last": (quotes([s]).get(s) or {}).get("last")}


def financials_api(p, b, pp):
    s, stmt, qtr = sym_of(p), p.get("stmt", "income"), p.get("q") == "1"
    df = memo(f"fin:{s}:{stmt}:{qtr}", 6 * 3600, lambda: data.financials(s, stmt, qtr))
    if df.empty:
        return {"symbol": s, "columns": [], "rows": []}
    cols = [str(getattr(c, "date", lambda: c)()) if hasattr(c, "date") else str(c) for c in df.columns]
    rows = [{"name": str(r), "values": [None if pd.isna(v) else float(v) if isinstance(v, (int, float, np.number)) else None
                                        for v in df.loc[r].tolist()]} for r in df.index]
    return {"symbol": s, "statement": stmt, "quarterly": qtr, "source": df.attrs.get("source", "Yahoo Finance"),
            "columns": cols, "rows": rows}


def valuation_api(p, b, pp):
    s = sym_of(p)
    if not config.FMP_API_KEY:
        return {"needs_key": "FMP_API_KEY", "where": "financialmodelingprep.com"}
    get = lambda ep: memo(f"fmp:{ep}:{s}", 6 * 3600, lambda: sources.fmp(ep, s))
    out = {"symbol": s, "last": (quotes([s]).get(s) or {}).get("last")}
    for name, ep in (("dcf", "discounted-cash-flow"), ("scores", "financial-scores"), ("rating", "ratings-snapshot"),
                     ("target", "price-target-consensus"), ("ratios", "ratios-ttm"), ("metrics", "key-metrics-ttm")):
        try:
            out[name] = get(ep)
        except Exception as e:
            out[name] = {"error": sources.clean_error(e)}
    return out


def earnings_api(p, b, pp):
    s = sym_of(p)
    if not config.FINNHUB_API_KEY:
        return {"needs_key": "FINNHUB_API_KEY", "where": "finnhub.io"}
    out = {"symbol": s}
    try:
        out["history"] = memo(f"surp:{s}", 6 * 3600, lambda: sources.earnings_surprises(s))
    except Exception as e:
        out["history_error"] = sources.clean_error(e)
    days = int(p.get("days", 14))
    try:
        cal = memo(f"ecal:{days}", 3600, lambda: sources.earnings_calendar(days))
        if p.get("est", "1") == "1" and not cal.empty:
            cal = cal[cal["epsEstimate"].notna()]
        out["calendar"] = cal.head(400)
    except Exception as e:
        out["calendar_error"] = sources.clean_error(e)
    return out


def filings_api(p, b, pp):
    s = sym_of(p)
    out = {"symbol": s}
    try:
        f = memo(f"filings:{s}", 1800, lambda: sources.sec_filings(s))
        out["filings"] = f.head(200)
    except Exception as e:
        out["filings_error"] = sources.clean_error(e)
    if config.FINNHUB_API_KEY:
        try:
            ins = memo(f"insiders:{s}", 6 * 3600, lambda: sources.insider_transactions(s))
            if not ins.empty:
                ins = ins.assign(value=ins["change"].abs() * ins["transactionPrice"])
            out["insiders"] = ins.head(200)
        except Exception as e:
            out["insiders_error"] = sources.clean_error(e)
    else:
        out["insiders_error"] = "Add FINNHUB_API_KEY to see insider trades"
    return out


def options_api(p, b, pp):
    s = sym_of(p)
    exps = memo(f"exps:{s}", 3600, lambda: data.option_expirations(s))
    if not exps:
        return {"symbol": s, "expiries": []}
    expiry = p.get("expiry") or exps[min(3, len(exps) - 1)]
    chain = memo(f"chain:{s}:{expiry}", 60, lambda: tools.get_options_chain(s, expiry, "both", 400))
    return {"symbol": s, "expiries": exps, "expiry": expiry, **chain}


def backtest_api(p, b, pp):
    s = sym_of(p)
    strat = p.get("strategy") or next(iter(backtest.STRATEGIES))
    desc, spec = backtest.STRATEGIES[strat]
    params = {k: v[1] for k, v in spec.items()}
    for k in spec:
        if p.get(k) not in (None, ""):
            params[k] = type(spec[k][1])(float(p[k]))
    period, capital = p.get("period", "5y"), float(p.get("capital", 10000))
    df = memo(f"bt:{s}:{period}", 1800, lambda: data.history(s, period, "1d"))
    out = {"strategies": {k: {"desc": d, "params": {n: list(x) for n, x in sp.items()}}
                          for k, (d, sp) in backtest.STRATEGIES.items()},
           "strategy": strat, "params": params, "period": period}
    if len(df) < 60:
        return {**out, "error": "Not enough price history for this symbol and period."}
    r = backtest.run(df, strat, params, capital)
    ts = lambda x: ms(x.index).tolist()
    trades = r.trades.assign(entry_date=r.trades["entry_date"].astype(str), exit_date=r.trades["exit_date"].astype(str)) \
        if not r.trades.empty else r.trades
    return {**out, "rule": desc.format(**params), "stats": r.stats, "equity": {"t": ts(r.equity), "v": r.equity.round(2)},
            "benchmark": {"t": ts(r.benchmark), "v": r.benchmark.round(2)}, "trades": trades,
            "price": {"t": ts(df["Close"]), "v": df["Close"].round(4)}}


def search_api(p, b, pp):
    qtext = (p.get("q") or "").strip().upper()
    if not qtext:
        return {"results": []}
    try:
        names = memo("tickers", 24 * 3600, sources.ticker_names)
    except Exception:
        names = []
    exact = [(t, n) for t, n in names if t == qtext]
    starts = [(t, n) for t, n in names if t.startswith(qtext) and t != qtext]
    words = [(t, n) for t, n in names if len(qtext) > 2 and qtext in n.upper() and not t.startswith(qtext)]
    return {"results": [{"symbol": t, "name": n.title()} for t, n in (exact + sorted(starts, key=lambda x: len(x[0]))
                                                                       + words)[:10]]}


# ---------- portfolio & trading ----------
PORT_RANGES = {"1D": "1D", "1W": "1W", "1M": "1M", "3M": "3M", "1Y": "1Y", "ALL": "ALL"}


def portfolio_api(p, b, pp):
    bs, errors = brokers()
    if not bs:
        return {"brokers": [], "errors": errors}
    name = p.get("broker") if p.get("broker") in bs else next(iter(bs))
    rng = p.get("range", "1D")
    out = {"brokers": list(bs), "broker": name, "errors": errors, "mode": config.MODE_LABEL, "range": rng}
    out["account"] = account(name)
    pos = positions(name)
    syms = [x["symbol"] for x in pos if not OrderRequest(x["symbol"], "buy", 1).is_option]
    qs = quotes(syms) if syms else {}
    for x in pos:
        q = qs.get(x["symbol"]) or {}
        x["change_pct"] = q.get("change_pct")
        x["day_pl"] = (q.get("change") or 0) * (x.get("qty") or 0) if q.get("change") is not None else None
    out["positions"] = pos
    try:
        hist = memo(f"phist:{name}:{rng}", 60, lambda: broker(name).portfolio_history(rng if rng != "ALL" else "1Y"))
        hist = hist[hist.diff().abs().fillna(0) < hist.median() * 0.5] if len(hist) > 3 else hist  # drop glitches
        idx = pd.DatetimeIndex(hist.index)
        out["history"] = {"t": ms(idx).tolist(), "v": [round(float(v), 2) for v in hist]}
        out["spy"] = spy_alongside(hist, rng)
    except Exception as e:
        out["history"] = {"t": [], "v": [], "error": str(e)}
    return out


SPY_RANGE = {"1D": "1D", "1W": "5D", "1M": "1M", "3M": "3M", "1Y": "1Y", "ALL": "5Y"}


def spy_alongside(hist: pd.Series, rng: str) -> list | None:
    """SPY closes lined up with the equity curve's timestamps (last close at or before each point), scaled so
    both start at the same value: the line shows what the same money would have done in the S&P 500."""
    if len(hist) < 2:
        return None
    spy = history("SPY", SPY_RANGE.get(rng, "1Y"))["Close"].dropna()
    if spy.empty:
        return None
    left = pd.DataFrame({"t": ms(hist.index)})
    right = pd.DataFrame({"t": ms(spy.index), "c": spy.to_numpy()})
    c = pd.merge_asof(left, right, on="t", direction="backward")["c"]
    first = c.first_valid_index()
    if first is None:
        return None
    scaled = c / c[first] * float(hist.iloc[first])
    return [None if pd.isna(v) else round(float(v), 2) for v in scaled]


def account_api(p, b, pp):
    """Equity and buying power plus the trading plan's limits, for sizing a trade on the order ticket."""
    name = p.get("broker")
    plan = profile.load()
    return {"account": account(name), "plan": {k: plan.get(k) for k in ("risk_per_trade", "max_position", "account_size")}}


def allocation_api(p, b, pp):
    name = p.get("broker")
    pos = positions(name) if name else []
    alloc: dict[str, float] = {}
    for x in pos:
        if OrderRequest(x["symbol"], "buy", 1).is_option:
            sector = "Options"
        else:
            try:
                i = info(x["symbol"])
                sector = i.get("sector") or ("Funds" if i.get("quoteType") == "ETF" else "Other")
            except Exception:
                sector = "Other"
        alloc[sector] = alloc.get(sector, 0) + abs(x.get("market_value") or 0)
    return {"allocation": sorted(alloc.items(), key=lambda kv: -kv[1])}


ORDER_STATUS = {
    "pendingsubmit": ("Sending to IBKR", "open"), "apipending": ("Sending to IBKR", "open"),
    "presubmitted": ("Waiting for market open", "open"), "submitted": ("Working", "open"),
    "pendingcancel": ("Canceling", "open"), "pendingnew": ("Sending to Alpaca", "open"),
    "new": ("Working", "open"), "accepted": ("Accepted", "open"), "held": ("Waiting to trigger", "open"),
    "acceptedforbidding": ("Accepted", "open"), "partiallyfilled": ("Partly filled", "open"),
    "pendingreplace": ("Updating", "open"), "calculated": ("Working", "open"),
    "filled": ("Filled", "done"), "doneforday": ("Done for the day", "done"),
    "cancelled": ("Canceled", "closed"), "canceled": ("Canceled", "closed"), "apicancelled": ("Canceled", "closed"),
    "expired": ("Expired", "closed"), "rejected": ("Rejected", "closed"), "inactive": ("Not active", "closed"),
    "replaced": ("Replaced", "closed"), "stopped": ("Stopped", "closed"), "suspended": ("Suspended", "closed"),
}


def orders_api(p, b, pp):
    bs, errors = brokers()
    out = {"brokers": {}, "errors": dict(errors)}
    for name, br in bs.items():
        try:
            rows = []
            for o in br.orders()[:40]:
                raw = (o.get("status") or "").lower().replace("_", "")
                label, state = ORDER_STATUS.get(raw, ((o.get("status") or "Unknown").replace("_", " ").capitalize(), "open"))
                rows.append({**o, "status_label": label, "state": state})
            out["brokers"][name] = rows
        except Exception as e:
            out["errors"][name] = str(e)
    return out


def _order_req(b: dict) -> OrderRequest:
    f = lambda k: float(b[k]) if b.get(k) not in (None, "", 0, "0") else None
    otype = b.get("type", "market")
    px = f("price")
    req = OrderRequest(str(b["symbol"]).strip().upper(), b.get("side", "buy"), float(b.get("qty") or 0), otype,
                       px if otype == "limit" else None, px if otype == "stop" else None, b.get("tif", "day"),
                       f("take_profit"), f("stop_loss"))
    if req.qty <= 0:
        raise ValueError("Quantity must be more than 0")
    if otype != "market" and not px:
        raise ValueError(f"Enter a {otype} price")
    return req


def order_preview_api(p, b, pp):
    req = _order_req(b)
    name = b.get("broker")
    ref = b.get("ref") or (quotes([req.symbol]).get(req.symbol) or {}).get("last") if not req.is_option else b.get("ref")
    unit = req.limit_price or req.stop_price or ref
    value = req.qty * unit * (100 if req.is_option else 1) if unit else None
    warnings = []
    plan = profile.load()
    try:
        eq = account(name)["equity"]
        if value and eq and plan.get("max_position") and value > eq * plan["max_position"] / 100:
            warnings.append(f"More than your {plan['max_position']:g}% max position size (My trading plan).")
    except Exception:
        pass
    if config.LIVE:
        warnings.append("LIVE account: this uses real money.")
    return {"describe": req.describe(), "value": value, "warnings": warnings, "mode": config.MODE_LABEL,
            "broker": broker(name).name}


def order_submit_api(p, b, pp):
    if not b.get("confirm"):
        return fail("Order not confirmed")
    req = _order_req(b)
    br = broker(b.get("broker"))
    oid = br.submit_order(req)
    forget("acct:"); forget("pos:")
    note = ""
    try:
        unit = req.limit_price or req.stop_price or b.get("ref")
        journal.add(br.name, oid, req, unit, b.get("note", ""), b.get("tags") or [])
    except Exception as e:
        note = f"Order sent, but the journal entry wasn't saved: {e}"
    return {"id": oid, "describe": req.describe(), "note": note}


def order_cancel_api(p, b, pp):
    broker(b["broker"]).cancel_order(b["id"])
    return {"ok": True}


def reconnect_api(p, b, pp):
    with _broker_lock:
        _brokers.update(at=0.0, brokers={}, errors={})
    bs, errors = brokers()
    return {"brokers": list(bs), "errors": errors}


def activity() -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    fills, divs, errors = [], [], {}
    for name in brokers()[0]:
        try:
            f, d = memo(f"activity:{name}", 300, lambda n=name: broker(n).activity())
            fills.append(f.assign(broker=name))
            divs.append(d.assign(broker=name))
        except Exception as e:
            errors[name] = str(e)
    cat = lambda xs, cols: pd.concat(xs, ignore_index=True) if xs else pd.DataFrame(columns=cols)
    return cat(fills, ["symbol", "side", "qty", "price", "time", "broker"]), \
        cat(divs, ["symbol", "amount", "date", "broker"]), errors


def closed_trades(fills: pd.DataFrame) -> pd.DataFrame:
    parts = [gains.realized(g).assign(broker=k) for k, g in fills.groupby("broker")] if not fills.empty else []
    return pd.concat(parts, ignore_index=True) if parts else gains.realized(fills)


def journal_api(p, b, pp):
    entries = journal.load()
    fills, _, errors = activity()
    closed = closed_trades(fills)
    by_tag = []
    if not closed.empty and entries:
        utc = lambda ts: (lambda t: t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC"))(pd.Timestamp(ts))
        tagged = []
        for t in closed.itertuples():
            opener = "buy" if t.direction == "Long" else "sell"
            cutoff = utc(t.opened) + pd.Timedelta(minutes=1)
            match = [e for e in entries if e["symbol"] == t.symbol and e["side"] == opener
                     and pd.Timestamp(e["time"], unit="s", tz="UTC") <= cutoff]
            for tag in (match[-1]["tags"] if match else []) or ["(no tag)"]:
                tagged.append({"tag": tag, "pl": t.pl, "win": t.pl > 0})
        if tagged:
            g = pd.DataFrame(tagged).groupby("tag").agg(trades=("pl", "size"), win_rate=("win", "mean"), total=("pl", "sum"))
            g["win_rate"] *= 100
            by_tag = g.sort_values("total", ascending=False).reset_index()
    return {"entries": list(reversed(entries)), "summary": gains.summary(closed), "by_tag": by_tag, "errors": errors,
            "tags": journal.TAGS}


def journal_update_api(p, b, pp):
    if b.get("delete"):
        journal.delete(b["id"])
    else:
        journal.update(b["id"], review=b.get("review", ""))
    return {"ok": True}


def gains_api(p, b, pp):
    fills, divs, errors = activity()
    closed = closed_trades(fills)
    upcoming = []
    for name in brokers()[0]:
        try:
            held = positions(name)
        except Exception:
            continue
        for x in held:
            if OrderRequest(x["symbol"], "buy", 1).is_option or (x.get("qty") or 0) <= 0:
                continue
            i = info(x["symbol"])
            if not i.get("dividendRate"):
                continue
            ex = pd.Timestamp(i["exDividendDate"], unit="s").date() if i.get("exDividendDate") else None
            upcoming.append({"symbol": x["symbol"], "shares": x["qty"],
                             "ex_date": ex if ex and ex >= pd.Timestamp.now().date() else None,
                             "per_share": i.get("lastDividendValue"),
                             "next_payment": (i.get("lastDividendValue") or 0) * x["qty"],
                             "yearly": i["dividendRate"] * x["qty"]})
    return {"closed": closed.sort_values("closed", ascending=False) if not closed.empty else [],
            "dividends": divs.sort_values("date", ascending=False) if not divs.empty else [],
            "upcoming": upcoming, "errors": errors, "ibkr": "Interactive Brokers" in brokers()[0]}


# ---------- watchlists, alerts, plan ----------
def watchlists_api(p, b, pp):
    act = b.get("action")
    name = b.get("list") or None
    if act == "add":
        for s in str(b.get("symbol", "")).replace(",", " ").split():
            watchlists.add(s.upper(), name)
    elif act == "remove":
        watchlists.remove(b["symbol"], name)
    elif act == "move":
        watchlists.move(b["symbol"], int(b.get("step", 1)), name)
    elif act == "create":
        watchlists.create(b["name"])
    elif act == "rename":
        watchlists.rename(b["old"], b["name"])
    elif act == "delete":
        watchlists.delete(b["name"])
    elif act == "activate":
        watchlists.set_active(b["name"])
    if act:
        threading.Thread(target=lambda: collector.note_symbols(held_symbols()), daemon=True).start()
    return {"names": watchlists.names(), "active": watchlists.active(),
            "lists": {n: watchlists.symbols(n) for n in watchlists.names()}}


def alerts_api(p, b, pp):
    items = alerts.load()
    if b.get("action") == "add":
        alerts.add(b["symbol"], b.get("direction", "above"), float(b["price"]))
    elif b.get("action") == "remove":
        i = int(b["index"])
        alerts.save(items[:i] + items[i + 1:])
    return {"alerts": alerts.load()}


def plan_api(p, b, pp):
    if b.get("values"):
        profile.save({k: b["values"].get(k, v[3]) for k, v in profile.FIELDS.items()})
    return {"fields": {k: list(v) for k, v in profile.FIELDS.items()}, "values": profile.load()}


# ---------- market ----------
def world_api(p, b, pp):
    return memo("world", 45, tools.get_market_overview)


def futures_api(p, b, pp):
    return {"futures": memo("futures", 45, tools.get_futures_overview)}


SP500_AGE = 30 * 60


def sp500_api(p, b, pp):
    df, age, refreshing, err = cache.get("sp500", data.sp500_scan, SP500_AGE)
    if df is None:
        return {"pending": refreshing, "error": err}
    cols = [c for c in ("symbol", "name", "sector", "last", "chg_1d", "chg_1m", "chg_3m", "chg_1y", "from_high", "rsi",
                        "above_50d", "above_200d", "market_cap", "pe", "fwd_pe", "pb", "div_yield", "analyst_rating")
            if c in df.columns]
    return {"age": age, "refreshing": refreshing, "rows": df[cols]}


def ideas_api(p, b, pp):
    scan, _, refreshing, err = cache.get("sp500", data.sp500_scan, SP500_AGE)
    lists = {k: v[0] for k, v in ideas.IDEAS.items()}
    if scan is None:
        return {"pending": refreshing, "error": err, "lists": lists}
    idea = p.get("list") if p.get("list") in ideas.IDEAS else next(iter(ideas.IDEAS))
    desc, checks, deep = ideas.IDEAS[idea]
    s1 = ideas.stage1(scan, idea)
    top = list(s1["symbol"][: ideas.MAX_DEEP])
    k = "ideas-" + key_of(idea, *top)
    res, _, running, _ = cache.get(k, lambda: ideas.deep_checks(top, deep), 6 * 3600) if top else ({}, None, False, None)
    rows = []
    for r in s1.head(ideas.MAX_DEEP).itertuples():
        found = (res or {}).get(r.symbol, {})
        chk = [{"label": ideas.CHECKS[c][0], "state": True} for c in checks]
        chk += [{"label": ideas.DEEP[d][0], "state": found.get(d), "pending": res is None} for d in deep]
        rows.append({"symbol": r.symbol, "name": r.name, "sector": r.sector, "last": r.last, "chg_1d": r.chg_1d,
                     "checks": chk, "passed": len(checks) + sum(1 for d in deep if found.get(d)),
                     "total": len(checks) + len(deep)})
    rows.sort(key=lambda x: -x["passed"])
    return {"lists": lists, "list": idea, "desc": desc, "rows": rows, "deep_pending": res is None and running,
            "passed": len(s1), "universe": len(scan), "more": list(s1["symbol"][len(top):]),
            "explain": [(ideas.CHECKS[c][0], ideas.CHECKS[c][1]) for c in checks]
            + [(ideas.DEEP[d][0], ideas.DEEP[d][1]) for d in deep]}


def calendar_api(p, b, pp):
    if not config.FINNHUB_API_KEY:
        return {"needs_key": "FINNHUB_API_KEY", "where": "finnhub.io"}
    held = held_symbols()
    watch = [s for s in watchlists.everything() if s not in held]
    syms = held + watch
    up = memo(f"upcoming:{key_of(*syms)}", 6 * 3600, lambda: sources.upcoming_earnings(syms))
    rows = []
    for r in (up.itertuples() if not up.empty else []):
        try:
            s = memo(f"surp:{r.symbol}", 6 * 3600, lambda: sources.earnings_surprises(r.symbol)).head(4)
            record = f"Beat {int((s['surprisePercent'] > 0).sum())} of last {len(s)}" if not s.empty else "No history"
        except Exception:
            record = "-"
        rows.append({"symbol": r.symbol, "date": r.date, "hour": r.hour, "eps": r.epsEstimate,
                     "revenue": r.revenueEstimate, "record": record, "holding": r.symbol in held})
    return {"rows": rows, "held": len(held), "watch": len(watch)}


def predictions_all(wait: bool):
    def public():
        return predictions.all_events()

    def fx():
        bs = brokers()[0]
        ib = bs.get("Interactive Brokers")
        if not ib:
            return [], {}
        try:
            events, problems = ib.forecast_markets(predictions.forecast_products())
            return events, {f"ForecastEx {k}": v for k, v in problems.items()}
        except Exception as e:
            return [], {"ForecastEx": str(e)}

    if wait:
        pub, fxe = memo("pred-public", 600, public), memo("pred-fx", 600, fx)
    else:
        pub = cache.get("predictions-public", public, 600)[0] or ([], {})
        fxe = cache.get("predictions-fx", fx, 600)[0] or ([], {})
    return pub[0] + fxe[0], {**pub[1], **fxe[1]}


def predictions_api(p, b, pp):
    if b.get("codes") is not None:
        predictions.set_forecast_products(str(b["codes"]).replace(",", " ").split())
        forget("pred-fx")
    events, errors = predictions_all(wait=True)
    topic, qtext = p.get("topic", "Fed & rates"), p.get("q", "")
    if topic == "ForecastEx":
        found = predictions.matching([e for e in events if e["source"] == "IBKR ForecastEx"], None, qtext)
    else:
        found = predictions.matching(events, None if topic == "All" else topic, qtext)
    blocked = bool(errors) and all("handshake" in v for k, v in errors.items() if not k.startswith("ForecastEx"))
    return {"topics": [*predictions.TOPICS, "ForecastEx", "All"], "topic": topic, "events": found[:40],
            "errors": errors, "blocked": blocked, "codes": predictions.forecast_products(),
            "ibkr": "Interactive Brokers" in brokers()[0]}


def screens_api(p, b, pp):
    name = p.get("name") if p.get("name") in data.SCREENS else next(iter(data.SCREENS))
    return {"names": list(data.SCREENS), "name": name, "rows": memo(f"screen:{name}", 120, lambda: data.screen(name))}


def economy_api(p, b, pp):
    if not config.FRED_API_KEY:
        return {"needs_key": "FRED_API_KEY", "where": "fred.stlouisfed.org/docs/api/api_key.html"}
    out = []
    for name, sid in sources.FRED_SERIES.items():
        try:
            s = memo(f"fred:{sid}", 6 * 3600, lambda sid=sid: sources.fred_series(sid))
            step = max(1, len(s) // 150)
            th = s.iloc[::step]
            out.append({"name": name, "id": sid, "last": s.iloc[-1], "prev": s.iloc[-2] if len(s) > 1 else s.iloc[-1],
                        "as_of": str(s.index[-1].date()),
                        "t": ms(th.index).tolist(), "v": th.round(4)})
        except Exception as e:
            out.append({"name": name, "id": sid, "error": sources.clean_error(e)})
    events, _ = predictions_all(wait=False)
    return {"series": out, "fed": predictions.matching(events, "Fed & rates")[:3]}


# ---------- AI ----------
def ai_status() -> dict:
    from terminal import ai, claude_code

    return {"provider": ai.provider(), "claude_installed": claude_code.binary() is not None}


def light_context(screen: str, symbol: str) -> str:
    ctx: dict = {"screen": screen, "ticker_on_screen": symbol, "mode": config.MODE_LABEL,
                 "today": pd.Timestamp.now(tz=LOCAL_TZ).strftime("%A %B %d, %Y %I:%M %p Denver time")}
    q = quotes([symbol]).get(symbol) if symbol else None
    if q:
        ctx["quote"] = {k: q.get(k) for k in ("last", "change_pct", "day_low", "day_high", "volume")}
    ctx["holdings"] = {}
    for name in brokers()[0]:
        try:
            ctx["holdings"][name] = [{k: x.get(k) for k in ("symbol", "qty", "avg_cost", "market_value", "unrealized_pl")}
                                     for x in positions(name)]
        except Exception:
            pass
    if profile.is_set():
        ctx["my_trading_plan"] = profile.for_ai()
    return json.dumps(clean(ctx), default=str)


def full_context(screen: str, symbol: str) -> str:
    """For Gemini or an API key (no tools): the data bundle the old Ask AI screen sent."""
    ctx = json.loads(light_context(screen, symbol))
    if symbol:
        for name, fn in (("profile", lambda: tools.get_company_profile(symbol)),
                         ("technicals", lambda: tools.get_technicals(symbol)),
                         ("headlines", lambda: tools.get_news(symbol, 10)),
                         ("analysts", lambda: tools.get_analyst_views(symbol)),
                         ("earnings", lambda: tools.get_earnings(symbol))):
            try:
                ctx[name] = memo(f"ctx:{name}:{symbol}", 600, fn)
            except Exception:
                pass
    return json.dumps(clean(ctx), default=str)


def ask_stream(body: dict):
    """Server-sent events: {"type": "tool"|"text"|"error"|"done", ...} as Claude works."""
    from terminal import ai

    def gen():
        msgs = [{"role": m["role"], "content": m["content"]} for m in body.get("messages", []) if m.get("content")]
        if not msgs or msgs[-1]["role"] != "user":
            yield sse({"type": "error", "text": "No question"})
            return
        who = ai.provider()
        if not who:
            yield sse({"type": "error", "text": "No AI set up: sign in under AI > Connect Claude (CLD), or add a "
                                                "Gemini key on the add-on's Configuration tab."})
            return
        screen, symbol = body.get("screen", ""), (body.get("symbol") or "").upper()
        yield sse({"type": "status", "text": f"{who} is thinking…", "provider": who})
        ctx = light_context(screen, symbol) if who == "Claude Code" else full_context(screen, symbol)
        msgs[-1] = {"role": "user", "content": f"<context>{ctx}</context>\n\n{msgs[-1]['content']}"}
        q: queue.Queue = queue.Queue()

        def work():
            try:
                for chunk in ai.stream_answer(msgs, on_tool=lambda n: q.put({"type": "tool", "name": n})):
                    q.put({"type": "text", "text": chunk})
                q.put({"type": "done"})
            except Exception as e:
                q.put({"type": "error", "text": ai.error_text(e)})
        threading.Thread(target=work, daemon=True, name="ask-ai").start()
        while True:
            try:
                ev = q.get(timeout=15)
            except queue.Empty:
                yield ": keep-alive\n\n"  # keeps proxies from closing a quiet connection while tools run
                continue
            yield sse(ev)
            if ev["type"] in ("done", "error"):
                return

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def sse(ev: dict) -> str:
    return f"data: {json.dumps(ev)}\n\n"


async def ask_endpoint(request: Request):
    if request.headers.get("x-terminal") != "1":
        return fail("missing request header", 403)
    return ask_stream(await request.json())


# morning brief
_brief: dict = {}
BRIEF_PROMPT = """Write my morning brief for today from the data in <context>. Use these sections, skipping any \
that have nothing worth saying: **Market** (index ETFs, rates, VIX, Fed odds), **My holdings**, **Watchlist \
movers**, **Earnings this week**, **Insider activity**, **Headlines worth reading** (as markdown links), \
**What to watch today**. Under 400 words, bullet points, concrete numbers. Use only facts that appear in \
<context> (including its headlines); do not add figures from memory, and say when data is missing. \
Flag things to look into rather than telling me what to buy or sell."""


def brief_context() -> str:
    held = held_symbols()
    watch = [s for s in watchlists.everything() if s not in held]
    syms = held + watch
    ctx: dict = {"date": pd.Timestamp.now(tz=NY).strftime("%A %B %d, %Y %H:%M ET")}
    if profile.is_set():
        ctx["my_trading_plan"] = profile.for_ai()
    try:
        s = gains.summary(closed_trades(activity()[0]))
        if s.get("trades"):
            ctx["my_track_record"] = s
    except Exception:
        pass
    mk = quotes(["SPY", "QQQ", "DIA", "IWM"])
    ctx["market_etfs"] = [{k: v.get(k) for k in ("symbol", "last", "change_pct")} for v in mk.values()]
    if config.FRED_API_KEY:
        try:
            ctx["economy"] = {n: round(float(sources.fred_series(sources.FRED_SERIES[n]).iloc[-1]), 2)
                              for n in ("Fed funds rate", "10-year Treasury", "VIX", "CPI inflation (YoY %)")}
        except Exception:
            pass
    ctx["holdings"] = {}
    for name in brokers()[0]:
        try:
            ctx["holdings"][name] = positions(name)
        except Exception:
            pass
    qs = quotes(syms) if syms else {}
    ctx["moves_today"] = [{k: v.get(k) for k in ("symbol", "last", "change_pct", "volume")} for v in qs.values()]
    ctx["headlines"] = {}
    for s in syms:
        try:
            ctx["headlines"][s] = [{k: n[k] for k in ("title", "publisher", "published", "url")}
                                   for n in memo(f"news:{s}", 300, lambda s=s: data.news(s))[:3]]
        except Exception:
            pass
    if config.FINNHUB_API_KEY and syms:
        try:
            up = sources.upcoming_earnings(syms)
            if not up.empty:
                soon = up[pd.to_datetime(up["date"]) <= pd.Timestamp.now() + pd.Timedelta(days=7)]
                ctx["earnings_next_7_days"] = soon[["symbol", "date", "hour", "epsEstimate"]].astype(str).to_dict("records")
        except Exception:
            pass
        cutoff, trades = pd.Timestamp.now() - pd.Timedelta(days=30), []
        for s in syms:
            try:
                t = sources.insider_transactions(s)
                t = t[t["transactionCode"].isin(["P", "S"]) & (pd.to_datetime(t["transactionDate"]) > cutoff)]
                trades += t[["symbol", "name", "transactionCode", "change", "transactionPrice", "transactionDate"]] \
                    .head(5).to_dict("records")
            except Exception:
                pass
        ctx["insider_open_market_trades_30d"] = trades
    events, _ = predictions_all(wait=False)
    if events:
        ctx["prediction_market_odds"] = [{"title": e["title"], "outcomes": [(o, round(pr, 3)) for o, pr in e["outcomes"][:4]]}
                                         for e in predictions.matching(events, "Fed & rates")[:3]]
    return json.dumps(clean(ctx), default=str)


def brief_api(p, b, pp):
    from terminal import ai

    today = str(pd.Timestamp.now(tz=NY).date())
    path = cache.DIR / f"brief-{today}.md"
    if b.get("rewrite"):
        path.unlink(missing_ok=True)
        _brief.pop(today, None)
    job = _brief.get(today, {})
    if path.exists():
        written = pd.Timestamp(path.stat().st_mtime, unit="s", tz="UTC").tz_convert(LOCAL_TZ)
        return {"text": path.read_text(encoding="utf-8"), "written": written.strftime("%I:%M %p"), "date": today,
                "provider": ai.provider()}
    if job.get("error"):
        if b.get("retry"):
            _brief.pop(today, None)
        else:
            return {"error": job["error"], "date": today}
    if not ai.provider():
        return {"no_ai": True}
    if not _brief.get(today, {}).get("running"):
        _brief[today] = {"running": True, "started": time.time()}

        def work():
            try:
                messages = [{"role": "user", "content": f"<context>{brief_context()}</context>\n\n{BRIEF_PROMPT}"}]
                text = "".join(ai.stream_answer(messages))
                cache.DIR.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8")
                _brief[today] = {"running": False}
            except Exception as e:
                _brief[today] = {"running": False, "error": ai.error_text(e)}
        threading.Thread(target=work, daemon=True, name="brief").start()
    return {"running": True, "seconds": int(time.time() - _brief[today].get("started", time.time())), "date": today,
            "provider": ai.provider()}


# Claude sign-in
_login: dict = {"login": None}


def claude_api(p, b, pp):
    from terminal import ai, claude_code

    act = b.get("action")
    login = _login["login"]
    if not claude_code.binary():
        return {"installed": False}
    if act == "start":
        if login and not login.done:
            login.cancel()
        login = _login["login"] = claude_code.Login()
    elif act == "code" and login:
        login.send_code(b.get("code", ""))
    elif act == "cancel" and login:
        login.cancel()
        _login["login"] = login = None
    elif act == "logout":
        claude_code.logout()
        _login["login"] = login = None
    elif act == "test":
        return {"answer": claude_code.ask("In one short sentence, confirm you're connected and ready to help with "
                                          "stock research.", "Answer in one sentence.", tools=False)}
    if login and login.done:
        claude_code.forget_status()
    if login and not login.done and time.time() - login.started > 600:
        login.cancel()
    s = claude_code.status(max_age=5 if act else 30)
    return {"installed": True, "signed_in": bool(s.get("loggedIn")), "expired": bool(s.get("expired")),
            "email": s.get("email") or (s.get("account") or {}).get("email"),
            "plan": s.get("subscriptionType") or s.get("authMethod"), "provider": ai.provider(),
            "login": None if not login else {"url": login.url, "done": login.done, "result": login.result}}


# data collection
def data_api(p, b, pp):
    if b.get("action") == "run":
        collector.run_now()
    if b.get("action") == "test":
        stamp = pd.Timestamp.now(tz="UTC").isoformat()
        try:
            store.write_json("collector/connection-test.json", {"checked": stamp})
            back = store._backend().get("collector/connection-test.json")
            ok_ = bool(back and stamp in back.decode())
            return {"test": "Connection works: a test file was saved and read back." if ok_ else
                    "Saved a test file but couldn't read it back. Check the key has read access too.", "test_ok": ok_}
        except Exception as e:
            return {"test": f"Storage refused the test: {type(e).__name__}: {e}", "test_ok": False}
    if not store.enabled():
        return {"enabled": False, "why": store.why_off()}
    out = {"enabled": True, "where": store.describe(), "status": dict(collector.status), "jobs": collector.JOBS,
           "own": len(collector.own_symbols()), "minute_days": collector.minute_backfill_days()}
    try:
        out["runs"], out["usage"] = collector.last_runs(), store.usage()
    except Exception as e:
        out["error"] = str(e)
    return out


# ---------- events: alerts and earnings reminders, pushed to the page ----------
_events: list[dict] = []
_event_id = [0]


def push_event(kind: str, text: str) -> None:
    _event_id[0] += 1
    _events.append({"id": _event_id[0], "kind": kind, "text": text, "t": time.time()})
    del _events[:-50]


def events_api(p, b, pp):
    since = int(p.get("since", 0))
    return {"events": [e for e in _events if e["id"] > since], "last": _event_id[0]}


ALERT_PROMPT = """{symbol} just crossed my price alert: it is now {last} ({change}), and I asked to hear when it went \
{direction} {price}. In two short sentences, say what most likely explains the move, using only the facts in \
<context> (headlines, earnings date, market). If nothing there explains it, say so plainly. No advice."""


def explain_alert(a: dict) -> None:
    """Adds a two-sentence 'why' from the AI to a triggered alert, as a second notification."""
    from terminal import ai

    if not ai.provider():
        return
    s = a["symbol"]
    try:
        q = quotes([s, "SPY"])
        ctx: dict = {"quote": q.get(s), "spy_today_pct": (q.get("SPY") or {}).get("change_pct")}
        try:
            ctx["headlines"] = [{k: n.get(k) for k in ("title", "publisher", "published")}
                                for n in memo(f"news:{s}", 300, lambda: data.news(s))[:6]]
        except Exception:
            pass
        if config.FINNHUB_API_KEY:
            try:
                up = sources.upcoming_earnings([s])
                ctx["next_earnings"] = None if up.empty else str(up.iloc[0]["date"])
                ctx["recent_earnings"] = memo(f"surp:{s}", 6 * 3600, lambda: sources.earnings_surprises(s)).head(2)
            except Exception:
                pass
        last = (q.get(s) or {}).get("change_pct")
        prompt = f"<context>{json.dumps(clean(ctx), default=str)}</context>\n\n" + ALERT_PROMPT.format(
            symbol=s, last=f"{a['triggered']:,.2f}", change=f"{last:+.2f}% today" if last is not None else "change unknown",
            direction=a["direction"], price=f"{a['price']:,.2f}")
        why = ai.complete(prompt, "Answer in at most two sentences.", max_tokens=300, effort="low").strip()
        if why:
            alerts.explain(a, why)
            push_event("alert-why", f"{s}: {why}")
    except Exception as e:
        log(f"[web] alert explanation for {s} failed: {e}")


def background_loop():
    """Checks price alerts every 15 s (even with no browser open) and earnings dates hourly."""
    reminded: set = set()
    next_earn = 0.0
    while True:
        try:
            for a in alerts.check():
                push_event("alert", f"{a['symbol']} is {a['direction']} {a['price']:,.2f} (now {a['triggered']:,.2f})")
                threading.Thread(target=explain_alert, args=(a,), daemon=True, name="alert-why").start()
        except Exception as e:
            log(f"[web] alert check failed: {e}")
        if config.FINNHUB_API_KEY and time.time() > next_earn:
            next_earn = time.time() + 3600
            try:
                syms = held_symbols() + watchlists.everything()
                up = sources.upcoming_earnings(list(dict.fromkeys(syms)))
                today = pd.Timestamp.now(tz=NY).date()
                for r in (up.itertuples() if not up.empty else []):
                    days = (r.date - today).days
                    if days in (0, 1) and (r.symbol, r.date) not in reminded:
                        reminded.add((r.symbol, r.date))
                        when = {"bmo": " before the open", "amc": " after the close"}.get(r.hour, "")
                        push_event("earnings", f"{r.symbol} reports earnings {'today' if days == 0 else 'tomorrow'}{when}")
            except Exception:
                pass
        time.sleep(15)


def warm():
    """Fetch what the first screens need before anyone asks, so the first open is quick."""
    started = time.time()
    try:
        bs, _ = brokers()
        syms = list(dict.fromkeys(watchlists.symbols() + held_symbols() + ["SPY", "QQQ", "DIA", "IWM"]))
        q_api({"s": ",".join(syms), "spark": "1"}, {}, {})
        for name in bs:
            portfolio_api({"broker": name, "range": "1D"}, {}, {})
        history("SPY", "1D")
        world_api({}, {}, {})
        cache.get("sp500", data.sp500_scan, SP500_AGE)
    except Exception as e:
        log(f"[web] warm-up: {e}")
    log(f"[web] warm-up done in {time.time() - started:.0f}s")


# ---------- boot ----------
FUNCTIONS = {
    "Home": {"PORT": "Portfolio", "ORD": "Trade", "JRNL": "Journal", "GAIN": "Gains & dividends", "ALRT": "Alerts"},
    "Stock": {"DES": "Overview", "GP": "Chart", "N": "News", "FA": "Financials", "VAL": "Valuation",
              "ANR": "Analysts", "ERN": "Earnings", "SEC": "Filings & insiders", "OMON": "Options", "BT": "Backtest"},
    "Market": {"WEI": "World markets", "MON": "Watchlists", "SPX": "S&P 500", "IDEA": "Ideas", "CAL": "Earnings calendar",
               "PRED": "Predictions", "SCR": "Screens", "ECO": "Economy"},
    "AI": {"AI": "Ask AI", "BRF": "Morning brief", "PLAN": "My trading plan", "CLD": "Connect Claude",
           "DATA": "Data collection", "HELP": "Help"},
}


def boot_api(p, b, pp):
    """Answers at once: broker connections and the AI check (both can take many seconds) come from the
    background, and `pending` tells the page to ask again until they're in."""
    conn = peek("boot:brokers", 30, lambda: (lambda bs, errs: (list(bs), errs))(*brokers()))
    ai = peek("boot:ai", 60, ai_status)
    return {"version": VERSION, "mode": config.MODE_LABEL, "live": config.LIVE, "functions": FUNCTIONS,
            "brokers": conn[0] if conn else [], "broker_errors": conn[1] if conn else {},
            "ai": ai or {"provider": None, "claude_installed": False}, "pending": conn is None or ai is None,
            "watchlists": watchlists_api({}, {}, {}),
            "stream": stream.status(), "keys": {"finnhub": bool(config.FINNHUB_API_KEY), "fmp": bool(config.FMP_API_KEY),
                                                "fred": bool(config.FRED_API_KEY)}}


async def index(request: Request):
    html = (STATIC / "index.html").read_text(encoding="utf-8").replace("{{V}}", VERSION)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


def startup():
    stream.start()
    collector.start()
    threading.Thread(target=warm, daemon=True, name="warm").start()
    threading.Thread(target=background_loop, daemon=True, name="alerts").start()


ROUTES = {
    "boot": boot_api, "quotes": q_api, "live": live_api, "account": account_api, "history": history_api, "chart": chart_api, "overview": overview_api,
    "news": news_api, "analysts": analysts_api, "financials": financials_api, "valuation": valuation_api,
    "earnings": earnings_api, "filings": filings_api, "options": options_api, "backtest": backtest_api,
    "search": search_api, "portfolio": portfolio_api, "allocation": allocation_api, "orders": orders_api,
    "journal": journal_api, "gains": gains_api, "world": world_api, "futures": futures_api, "sp500": sp500_api,
    "ideas": ideas_api, "calendar": calendar_api, "predictions": predictions_api, "screens": screens_api,
    "economy": economy_api, "events": events_api, "watchlists": watchlists_api, "alerts": alerts_api,
    "plan": plan_api, "brief": brief_api, "claude": claude_api, "data": data_api,
    "orders/preview": order_preview_api, "orders/submit": order_submit_api, "orders/cancel": order_cancel_api,
    "brokers/reconnect": reconnect_api, "journal/update": journal_update_api,
}

@contextlib.asynccontextmanager
async def lifespan(_app):
    startup()
    yield


app = Starlette(
    routes=[Route("/", index), Route("/api/ask", ask_endpoint, methods=["POST"]),
            *[Route(f"/api/{path}", api(fn), methods=["GET", "POST"]) for path, fn in ROUTES.items()],
            Mount("/static", StaticFiles(directory=STATIC), name="static")],
    lifespan=lifespan,
)


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8501"))
    uvicorn.run(app, host=os.getenv("HOST", "127.0.0.1"), port=port, log_level="warning")
