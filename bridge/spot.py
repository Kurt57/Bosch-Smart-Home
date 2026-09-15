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
