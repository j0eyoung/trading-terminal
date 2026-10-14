"""Smoke test for the web terminal: every API route answers, the page and scripts load, and the safety checks
on POSTs hold. Run before each release:

    .venv\\Scripts\\python -m tests.smoke            (add --fast to skip the slow S&P 500 scan routes)

It calls the real data sources (Alpaca, Yahoo, Finnhub...) with the keys in .env, so it needs the internet.
It never places, changes or cancels an order: order routes are only called in ways the server must refuse.
The start-up jobs (price stream, data collection, warm-up) are not started.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

os.environ.setdefault("STREAM", "off")  # the one Alpaca stream belongs to the running add-on

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from starlette.testclient import TestClient  # noqa: E402

from web import server  # noqa: E402

S = "AAPL"
# (route, query) for GETs. Every route in server.ROUTES must appear here or in POSTS/REFUSED below.
GETS = [
    ("boot", {}), ("quotes", {"s": f"{S},SPY,^GSPC", "spark": 1}), ("live", {"s": f"{S},SPY", "once": 1}),
    ("history", {"s": S, "range": "1D"}), ("history", {"s": S, "range": "5Y"}),
    ("chart", {"s": S, "range": "1Y", "ind": "sma20,sma50,sma200,bb,rsi,macd", "vs": 1}),
    ("overview", {"s": S}), ("news", {"s": S, "n": 5}), ("analysts", {"s": S}),
    ("financials", {"s": S, "stmt": "income"}), ("financials", {"s": S, "stmt": "balance", "q": 1}),
    ("valuation", {"s": S}), ("earnings", {"s": S}), ("filings", {"s": S}), ("options", {"s": S}),
    ("backtest", {"s": S}), ("search", {"q": "appl"}), ("portfolio", {"range": "1M"}), ("allocation", {}),
    ("account", {}), ("orders", {}), ("journal", {}), ("gains", {}), ("world", {}), ("futures", {}),
    ("sp500", {}), ("ideas", {}), ("calendar", {}), ("predictions", {}), ("screens", {}), ("economy", {}),
    ("events", {}), ("watchlists", {}), ("alerts", {}), ("plan", {}), ("brief", {}), ("claude", {}), ("data", {}),
]
SLOW = {"sp500", "ideas"}
# POSTs that only read (an empty body changes nothing).
POSTS = ["watchlists", "alerts", "plan", "claude", "data", "orders/preview"]
# Routes that must refuse what we send: (route, body, expected status).
REFUSED = [
    ("orders/submit", {"symbol": S, "qty": 1}, 400),            # not confirmed
    ("orders/preview", {"symbol": S, "qty": 0}, 500),           # quantity must be > 0
    ("orders/cancel", {}, 500),                                 # no order id
    ("journal/update", {}, 500),                                # no entry id
]
UNTESTED = {"brokers/reconnect": "drops live broker connections", "brief": "covered by GET (starting one costs an AI call)"}
# Keys that should be in each GET answer (a cheap check that the shape didn't change under the page).
SHAPE = {
    "boot": ["functions", "brokers", "pending"], "quotes": ["quotes"], "history": ["t"], "chart": ["t", "ind"],
    "overview": ["info"], "news": ["items"], "portfolio": ["brokers"], "orders": ["brokers"], "world": ["indexes"],
    "options": ["expiries"], "backtest": ["strategies"], "watchlists": ["names", "lists"], "plan": ["fields", "values"],
    "account": ["account", "plan"], "screens": ["names", "rows"],
}


def main() -> int:
    fast = "--fast" in sys.argv
    client = TestClient(server.app, raise_server_exceptions=False)  # no `with`: start-up jobs stay off
    fails, rows = [], []

    def check(name, ok_, took, note=""):
        rows.append((name, "ok " if ok_ else "FAIL", f"{took:5.1f}s", note))
        if not ok_:
            fails.append(name)

    covered = {r for r, _ in GETS} | set(POSTS) | {r for r, _, _ in REFUSED} | set(UNTESTED)
    missing = set(server.ROUTES) - covered
    check("every route has a test", not missing, 0, ", ".join(sorted(missing)))

    for route, q in GETS:
        if fast and route in SLOW:
            continue
        t = time.time()
        r = client.get(f"/api/{route}", params=q)
        took = time.time() - t
        name = f"GET {route} {json.dumps(q) if q else ''}".strip()
        if route == "live":
            ok_ = r.status_code == 200 and r.text.startswith("data: ") and "quotes" in r.text
            check(name, ok_, took, "" if ok_ else r.text[:120])
            continue
        try:
            body = r.json()
        except ValueError:
            check(name, False, took, f"not JSON ({r.status_code})")
            continue
        bad = r.status_code != 200 or (isinstance(body, dict) and body.get("error") and route not in ("sp500", "ideas"))
        lacking = [k for k in SHAPE.get(route, []) if k not in body] if not bad else []
        check(name, not bad and not lacking, took,
              (body.get("error") if isinstance(body, dict) else "") or (f"missing {lacking}" if lacking else ""))

    for route in POSTS:
        t = time.time()
        body = {"symbol": S, "qty": 1, "side": "buy", "type": "market"} if route == "orders/preview" else {}
        r = client.post(f"/api/{route}", json=body, headers={"X-Terminal": "1"})
        check(f"POST {route}", r.status_code == 200, time.time() - t, "" if r.status_code == 200 else r.text[:120])

    for route, body, want in REFUSED:
        t = time.time()
        r = client.post(f"/api/{route}", json=body, headers={"X-Terminal": "1"})
        check(f"POST {route} refused", r.status_code == want, time.time() - t,
              "" if r.status_code == want else f"got {r.status_code}: {r.text[:80]}")

    r = client.post("/api/orders/submit", json={"symbol": S, "qty": 1, "confirm": True})
    check("POST without X-Terminal header is blocked", r.status_code == 403, 0, f"got {r.status_code}")
    r = client.post("/api/ask", json={"messages": []})
    check("Ask AI without header is blocked", r.status_code == 403, 0, f"got {r.status_code}")

    page = client.get("/")
    check("page loads", page.status_code == 200 and "{{V}}" not in page.text and "app.js" in page.text, 0)
    for f in ("app.js", "chart.js", "app.css"):
        check(f"static/{f}", client.get(f"/static/{f}").status_code == 200, 0)
    node = shutil.which("node")
    for f in ("app.js", "chart.js"):
        if node:
            p = subprocess.run([node, "--check", str(ROOT / "web" / "static" / f)], capture_output=True, text=True)
            check(f"{f} syntax", p.returncode == 0, 0, p.stderr.strip()[:160])
        else:
            rows.append((f"{f} syntax", "skip", "", "node not installed"))

    width = max(len(r[0]) for r in rows)
    for name, status, took, note in rows:
        print(f"{status}  {name:<{width}}  {took:>6}  {note}")
    print(f"\n{len(rows) - len(fails)} passed, {len(fails)} failed" + (f": {', '.join(fails)}" if fails else ""))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
