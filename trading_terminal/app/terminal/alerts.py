"""Price alerts, kept in alerts.json next to the app. Checked while the app is open."""
from __future__ import annotations

import json

from . import config, data

PATH = config.DATA_DIR / "alerts.json"


def load() -> list[dict]:
    try:
        return json.loads(PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def save(alerts: list[dict]) -> None:
    PATH.write_text(json.dumps(alerts, indent=1))


def add(symbol: str, direction: str, price: float) -> None:
    save(load() + [{"symbol": symbol.upper(), "direction": direction, "price": price, "triggered": None}])


def check() -> list[dict]:
    """Marks alerts whose price condition is now met; returns the newly triggered ones."""
    alerts = load()
    pending = [a for a in alerts if not a["triggered"]]
    if not pending:
        return []
    symbols = sorted({a["symbol"] for a in pending})
    prices = {s: p["last"] for s, p in data.live_prices(symbols).items()}
    for s in symbols:
        if s not in prices:
            try:
                prices[s] = data.quote(s)["last"]
            except Exception:
                pass
    fired = []
    for a in pending:
        last = prices.get(a["symbol"])
        if last is None:
            continue
        if (a["direction"] == "above" and last >= a["price"]) or (a["direction"] == "below" and last <= a["price"]):
            a["triggered"] = last
            fired.append(a)
    if fired:
        save(alerts)
    return fired


def explain(fired: dict, why: str) -> None:
    """Keeps the AI's short explanation on a triggered alert."""
    alerts = load()
    for a in alerts:
        if a["symbol"] == fired["symbol"] and a["direction"] == fired["direction"] and a["price"] == fired["price"] \
                and a.get("triggered") is not None:
            a["why"] = why
    save(alerts)
