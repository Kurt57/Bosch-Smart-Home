#!/usr/bin/env python3
"""Day-ahead exchange electricity prices (EPEX spot) – standard library only.

Source: the free aWATTar market-data API (no account needed), which serves the
EPEX SPOT day-ahead auction for Germany (``api.awattar.de``) and Austria
(``api.awattar.at``). Tomorrow's prices appear each afternoon after the auction.

We store the raw **market** price in ct/kWh; the bridge turns that into a
**consumer** price with the user's surcharge + VAT (see shc_bridge.py).
"""

from __future__ import annotations

import http.client
import json
import math
import ssl
import time

HOSTS = {"de": "api.awattar.de", "at": "api.awattar.at"}
_CTX = ssl.create_default_context()

# A realistic long-run German day-ahead average (ct/kWh, market/net) used until
# the bridge has accumulated enough of its own price history. EPEX DE yearly
# averages were ~9.5 ct (2023), ~7.8 ct (2024), ~8–9 ct (2025) → ~8.5 ct.
TYPICAL_MARKET_CT = 8.5


def fetch_market_prices(market: str = "de", timeout: float = 15.0) -> list[tuple[int, float]]:
    """Return [(ts_epoch_sec, market_ct_per_kwh), …] for the available window
    (usually the next 24–48 h). Raises on network/parse errors."""
    host = HOSTS.get((market or "de").lower(), HOSTS["de"])
    conn = http.client.HTTPSConnection(host, 443, timeout=timeout, context=_CTX)
    try:
        conn.request("GET", "/v1/marketdata", headers={"Accept": "application/json"})
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            raise RuntimeError(f"aWATTar HTTP {resp.status}")
        data = json.loads(raw)
    finally:
        conn.close()
    out = []
    for item in data.get("data", []) or []:
        try:
            ts = int(item["start_timestamp"]) // 1000          # ms → s
            ct = float(item["marketprice"]) / 10.0             # €/MWh → ct/kWh
        except (KeyError, TypeError, ValueError):
            continue
        out.append((ts, round(ct, 3)))
    out.sort()
    return out


def fetch_range(market: str = "de", start_ts: int = 0, end_ts: int = 0,
                timeout: float = 30.0) -> list[tuple[int, float]]:
    """Historical hourly market prices for [start_ts, end_ts] (epoch seconds).
    aWATTar serves the past via ?start=&end= in milliseconds. Raises on error."""
    host = HOSTS.get((market or "de").lower(), HOSTS["de"])
    path = f"/v1/marketdata?start={int(start_ts) * 1000}&end={int(end_ts) * 1000}"
    conn = http.client.HTTPSConnection(host, 443, timeout=timeout, context=_CTX)
    try:
        conn.request("GET", path, headers={"Accept": "application/json"})
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            raise RuntimeError(f"aWATTar HTTP {resp.status}")
        data = json.loads(raw)
    finally:
        conn.close()
    out = []
    for item in data.get("data", []) or []:
        try:
            ts = int(item["start_timestamp"]) // 1000
            ct = float(item["marketprice"]) / 10.0
        except (KeyError, TypeError, ValueError):
            continue
        out.append((ts, round(ct, 3)))
    out.sort()
    return out


# Typical German day-ahead SHAPE, mean 1.0 – used to synthesize a plausible
# history for the demo and as a fallback when real history is thin.
DEMO_MONTH_FACTOR = [1.28, 1.22, 1.10, 0.95, 0.82, 0.74, 0.72, 0.78, 0.90, 1.02, 1.18, 1.29]
DEMO_HOUR_FACTOR = [0.80, 0.74, 0.70, 0.70, 0.74, 0.86, 1.05, 1.28, 1.30, 1.12, 0.98, 0.88,
                    0.80, 0.78, 0.80, 0.90, 1.05, 1.25, 1.34, 1.28, 1.14, 1.02, 0.94, 0.86]


def demo_history(days: int = 260) -> list[tuple[int, float]]:
    """Synthetic hourly market history (ct/kWh) for the past `days`, following the
    typical monthly + hour-of-day shape around TYPICAL_MARKET_CT."""
    now = int(time.time())
    h0 = now - (now % 3600)
    out = []
    for i in range(days * 24, 0, -1):
        ts = h0 - i * 3600
        lt = time.localtime(ts)
        v = TYPICAL_MARKET_CT * DEMO_MONTH_FACTOR[lt.tm_mon - 1] * DEMO_HOUR_FACTOR[lt.tm_hour]
        v += 1.5 * math.sin(i / 5.0)                     # a little day-to-day noise
        out.append((ts, round(max(-3.0, v), 3)))
    return out


def demo_prices(hours: int = 48) -> list[tuple[int, float]]:
    """A realistic synthetic day-ahead curve (ct/kWh, market): cheap at night and
    around midday (solar), with morning and evening peaks."""
    now = int(time.time())
    h0 = now - (now % 3600)
    out = []
    for i in range(hours):
        ts = h0 + i * 3600
        h = time.localtime(ts).tm_hour
        base = 8.0
        base += 6.0 * math.exp(-((h - 8) ** 2) / (2 * 1.6 ** 2))    # morning peak
        base += 8.0 * math.exp(-((h - 19) ** 2) / (2 * 2.0 ** 2))   # evening peak
        base -= 4.0 * math.exp(-((h - 13) ** 2) / (2 * 2.2 ** 2))   # midday solar dip
        base -= 3.0 * math.exp(-((h - 3) ** 2) / (2 * 2.5 ** 2))    # night low
        base += 1.2 * math.sin(i / 2.0)                             # a little noise
        out.append((ts, round(max(-2.0, base), 3)))
    return out
