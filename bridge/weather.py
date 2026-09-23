#!/usr/bin/env python3
"""Weather forecast for PV- and heat-demand prognosis – standard library only.

Source: the free Open-Meteo forecast API (no account, no API key,
``api.open-meteo.com``). We fetch the hourly global horizontal irradiance
(``shortwave_radiation`` in W/m²), the outside air temperature and cloud cover
for the next couple of days. The bridge/front-end turn that into an expected PV
yield (kWh) and – together with the building data – an expected heating demand.
"""

from __future__ import annotations

import http.client
import json
import math
import ssl
import time

API_HOST = "api.open-meteo.com"
API_PATH = "/v1/forecast"
_CTX = ssl.create_default_context()


def fetch(lat: float, lon: float, days: int = 2, timeout: float = 20.0) -> dict:
    """Return {'hourly': [{'ts', 'ghi', 'temp', 'cloud'}, …], 'tz': str}.

    ``ghi`` is global horizontal irradiance in W/m², ``temp`` the 2 m air
    temperature in °C, ``cloud`` the cloud cover in %. Raises on network/parse
    errors; the caller decides how to surface that."""
    q = (f"?latitude={round(float(lat), 4)}&longitude={round(float(lon), 4)}"
         f"&hourly=shortwave_radiation,temperature_2m,cloudcover"
         f"&forecast_days={int(days)}&timezone=auto")
    conn = http.client.HTTPSConnection(API_HOST, 443, timeout=timeout, context=_CTX)
    try:
        conn.request("GET", API_PATH + q, headers={"Accept": "application/json"})
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            raise RuntimeError(f"Open-Meteo HTTP {resp.status}: {raw[:160]!r}")
        data = json.loads(raw)
    finally:
        conn.close()
    h = data.get("hourly", {}) or {}
    times = h.get("time", []) or []
    ghi = h.get("shortwave_radiation", []) or []
    temp = h.get("temperature_2m", []) or []
    cloud = h.get("cloudcover", []) or []
    off = int(data.get("utc_offset_seconds", 0) or 0)
    out = []
    for i, t in enumerate(times):
        try:
            # Open-Meteo local ISO time (no zone suffix) → epoch seconds
            ts = int(time.mktime(time.strptime(t, "%Y-%m-%dT%H:%M"))) if "T" in t else None
        except (ValueError, OverflowError):
            ts = None
        if ts is None:
            continue
        out.append({
            "ts": ts,
            "ghi": _f(ghi, i, 0.0),
            "temp": _f(temp, i, None),
            "cloud": _f(cloud, i, None),
        })
    return {"hourly": out, "tz": data.get("timezone", "auto"), "utc_offset": off}


def _f(seq, i, default):
    try:
        v = seq[i]
        return float(v) if v is not None else default
    except (IndexError, TypeError, ValueError):
        return default


# ---- demo -------------------------------------------------------------- #
def demo(days: int = 2) -> dict:
    """A plausible synthetic forecast: a clear-ish day then a cloudier one, with
    a diurnal irradiance bell and a temperature swing. Used in --demo and as a
    fallback so the front-end always has something to draw."""
    now = int(time.time())
    day0 = now - (now % 86400)
    out = []
    for d in range(days):
        cloudiness = 0.15 if d == 0 else 0.6          # day 2 is cloudier
        for h in range(24):
            ts = day0 + d * 86400 + h * 3600
            # clear-sky-ish GHI bell centred on solar noon (~13 h local)
            clear = 780.0 * math.exp(-((h - 13) ** 2) / (2 * 3.1 ** 2))
            ghi = max(0.0, clear * (1 - 0.75 * cloudiness))
            # temperature: daily mean ~8 °C, ±5 °C swing peaking mid-afternoon
            temp = 8.0 - 3.0 * d + 5.0 * math.sin((h - 9) / 24.0 * 2 * math.pi)
            out.append({"ts": ts, "ghi": round(ghi, 1),
                        "temp": round(temp, 1), "cloud": round(cloudiness * 100)})
    return {"hourly": out, "tz": "demo", "utc_offset": 0}
