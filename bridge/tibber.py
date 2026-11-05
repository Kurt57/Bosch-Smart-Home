#!/usr/bin/env python3
"""Tibber API client – the user's *real* dynamic tariff prices.

Standard library only, same spirit as ``homecom.py`` / ``electrolux.py``.

Tibber is a dynamic-tariff provider. Unlike the raw EPEX/aWATTar feed (a market
price to which we add a surcharge + VAT), Tibber returns the customer's **actual
all-in price** per hour (``total`` = energy + tax + grid), so no surcharge has
to be guessed. Reached through the official GraphQL API:

    Endpoint:  https://api.tibber.com/v1-beta/gql
    Auth:      a personal access token (Bearer), created once at
               https://developer.tibber.com/ (or the Tibber app) using the
               user's own account.

We read the price info (current / today / tomorrow) for the first home. The
token is a read credential; it is stored only in ``config.json`` (git-ignored),
never in the repo.
"""

from __future__ import annotations

import http.client
import json
import re
import ssl
import time

API_HOST = "api.tibber.com"
API_PATH = "/v1-beta/gql"
_CTX = ssl.create_default_context()

# Tibber's public demo token (read-only sample home) – handy for a first test.
DEMO_TOKEN = "5K4MVS-OjfWhK_4yrjOlFe1F6kJXPVf7eQYggo8ebAE"

_PRICE_QUERY = (
    "{ viewer { homes { id appNickname address { address1 } "
    "currentSubscription { priceInfo { "
    "current { total energy tax startsAt level currency } "
    "today { total startsAt level } "
    "tomorrow { total startsAt level } } } } } }"
)


class TibberError(RuntimeError):
    pass


class TibberAuthError(TibberError):
    """The access token was rejected – a fresh token is required."""


def _request(token: str, query: str, timeout: float = 20.0) -> dict:
    body = json.dumps({"query": query}).encode("utf-8")
    conn = http.client.HTTPSConnection(API_HOST, 443, timeout=timeout, context=_CTX)
    try:
        conn.request("POST", API_PATH, body=body, headers={
            "Authorization": "Bearer " + (token or "").strip(),
            "Content-Type": "application/json",
            "Accept": "application/json",
        })
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status in (401, 403):
            raise TibberAuthError("Tibber-Token abgelehnt (401/403) – bitte neu erstellen.")
        if resp.status != 200:
            raise TibberError(f"Tibber HTTP {resp.status}: {raw[:160]!r}")
        data = json.loads(raw)
    finally:
        conn.close()
    if data.get("errors"):
        msg = "; ".join(str(e.get("message", e)) for e in data["errors"])
        if "unauthenticated" in msg.lower() or "token" in msg.lower():
            raise TibberAuthError("Tibber-Token ungültig: " + msg)
        raise TibberError("Tibber-Fehler: " + msg)
    return data.get("data") or {}


def _parse_iso(s: str):
    """Epoch seconds from a Tibber ISO timestamp like
    '2026-09-18T00:00:00.000+02:00' – tolerant of fractional seconds and offset."""
    if not s:
        return None
    m = re.match(
        r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?"
        r"(Z|[+-]\d{2}:?\d{2})?$", s.strip())
    if not m:
        return None
    y, mo, d, hh, mm, ss, off = m.groups()
    import calendar
    ts = calendar.timegm((int(y), int(mo), int(d), int(hh), int(mm), int(ss), 0, 0, 0))
    if off and off != "Z":
        sign = 1 if off[0] == "+" else -1
        off = off[1:].replace(":", "")
        ts -= sign * (int(off[:2]) * 3600 + int(off[2:4]) * 60)
    return ts


def _row(node: dict) -> dict:
    return {"ts": _parse_iso(node.get("startsAt")),
            "total_ct": round(float(node["total"]) * 100, 3) if node.get("total") is not None else None,
            "level": node.get("level")}


def fetch_prices(token: str, timeout: float = 20.0) -> dict:
    """Return {'home','currency','current':{...},'prices':[{ts,total_ct,level},…]}
    for the first home. Prices are the all-in consumer price in ct/kWh."""
    data = _request(token, _PRICE_QUERY, timeout)
    homes = ((data.get("viewer") or {}).get("homes") or [])
    if not homes:
        raise TibberError("Kein Zuhause im Tibber-Konto gefunden.")
    home = homes[0]
    sub = (home.get("currentSubscription") or {})
    pi = (sub.get("priceInfo") or {})
    cur = pi.get("current") or {}
    rows = []
    for node in (pi.get("today") or []) + (pi.get("tomorrow") or []):
        r = _row(node)
        if r["ts"] is not None and r["total_ct"] is not None:
            rows.append(r)
    rows.sort(key=lambda r: r["ts"])
    name = home.get("appNickname") or ((home.get("address") or {}).get("address1")) or "Zuhause"
    return {
        "home": name,
        "currency": cur.get("currency") or "EUR",
        "current": _row(cur) if cur.get("startsAt") else None,
        "prices": rows,
    }


def verify(token: str) -> dict:
    """Validate a token by fetching prices; raises on failure. Returns the same
    dict as fetch_prices (so the caller can show the home name)."""
    return fetch_prices(token)


_CONS_QUERY = (
    "{{ viewer {{ homes {{ consumption(resolution: {res}, last: {last}) {{ "
    "nodes {{ from to cost unitPrice consumption }} }} }} }} }}")


def fetch_consumption(token: str, resolution: str = "DAILY", last: int = 30,
                      timeout: float = 20.0) -> dict:
    """Return {'nodes':[{ts, kwh, cost, unit_ct},…], 'currency','total_kwh',
    'total_cost'} – the user's REAL metered consumption from Tibber."""
    res = (resolution or "DAILY").upper()
    if res not in ("HOURLY", "DAILY", "WEEKLY", "MONTHLY"):
        res = "DAILY"
    last = max(1, min(int(last), 744))
    data = _request(token, _CONS_QUERY.format(res=res, last=last), timeout)
    homes = ((data.get("viewer") or {}).get("homes") or [])
    if not homes:
        raise TibberError("Kein Zuhause im Tibber-Konto gefunden.")
    nodes_raw = (((homes[0].get("consumption") or {}).get("nodes")) or [])
    nodes, tk, tc = [], 0.0, 0.0
    for n in nodes_raw:
        kwh = n.get("consumption")
        if kwh is None:
            continue
        cost = n.get("cost")
        up = n.get("unitPrice")
        row = {"ts": _parse_iso(n.get("from")), "kwh": round(float(kwh), 3),
               "cost": round(float(cost), 3) if cost is not None else None,
               "unit_ct": round(float(up) * 100, 2) if up is not None else None}
        nodes.append(row)
        tk += row["kwh"]
        if row["cost"]:
            tc += row["cost"]
    nodes.sort(key=lambda r: (r["ts"] is None, r["ts"]))
    return {"resolution": res, "nodes": nodes, "currency": "EUR",
            "total_kwh": round(tk, 2), "total_cost": round(tc, 2)}


# ---- demo -------------------------------------------------------------- #
def demo() -> dict:
    """A synthetic Tibber-shaped result (all-in ct/kWh) for --demo / offline:
    today + tomorrow (48 h) from local midnight, with a plausible day shape."""
    import math
    now = int(time.time())
    lt = time.localtime(now)
    midnight = now - (lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec)
    rows = []
    for i in range(48):
        ts = midnight + i * 3600
        h = time.localtime(ts).tm_hour
        base = 30.0 + 8 * math.exp(-((h - 8) ** 2) / 5) + 10 * math.exp(-((h - 19) ** 2) / 8) \
            - 5 * math.exp(-((h - 13) ** 2) / 9) - 4 * math.exp(-((h - 3) ** 2) / 12)
        base = round(max(5.0, base), 2)
        lvl = "CHEAP" if base < 28 else "EXPENSIVE" if base > 40 else "NORMAL"
        rows.append({"ts": ts, "total_ct": base, "level": lvl})
    cur = next((r for r in rows if r["ts"] <= now < r["ts"] + 3600), rows[0])
    return {"home": "Demo-Zuhause", "currency": "EUR",
            "current": dict(cur), "prices": rows}


def demo_consumption(resolution: str = "DAILY", last: int = 30) -> dict:
    """Synthetic metered consumption (whole-house) for --demo / offline."""
    import math
    res = (resolution or "DAILY").upper()
    now = int(time.time())
    step = 3600 if res == "HOURLY" else 86400
    lt = time.localtime(now)
    if res == "HOURLY":
        anchor = now - (now % 3600) - (last - 1) * step
    else:
        anchor = now - (lt.tm_hour * 3600 + lt.tm_min * 60 + lt.tm_sec) - (last - 1) * step
    nodes, tk, tc = [], 0.0, 0.0
    for i in range(last):
        ts = anchor + i * step
        if res == "HOURLY":
            h = time.localtime(ts).tm_hour
            kwh = 0.3 + 0.5 * math.exp(-((h - 8) ** 2) / 6) + 0.7 * math.exp(-((h - 19) ** 2) / 8)
        else:
            kwh = 16.0 + 3.0 * math.sin(i / 3.0)          # ~16 kWh/day whole house
        kwh = round(max(0.05, kwh), 3)
        unit = 0.30
        cost = round(kwh * unit, 3)
        nodes.append({"ts": ts, "kwh": kwh, "cost": cost, "unit_ct": round(unit * 100, 2)})
        tk += kwh; tc += cost
    return {"resolution": res, "nodes": nodes, "currency": "EUR",
            "total_kwh": round(tk, 2), "total_cost": round(tc, 2)}
