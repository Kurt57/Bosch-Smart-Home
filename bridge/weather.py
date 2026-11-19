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


# --------------------------------------------------------------------------- #
# Weather of the past days + the next ones, for the PV views: sunshine hours,
# cloud cover, irradiance, weather type per day (and per hour for today)
# --------------------------------------------------------------------------- #
DAILY_VARS = ("weather_code,temperature_2m_max,temperature_2m_min,sunshine_duration,daylight_duration,"
              "precipitation_sum,snowfall_sum,shortwave_radiation_sum")
HOURLY_VARS = "shortwave_radiation,cloud_cover,sunshine_duration,temperature_2m,weather_code"


def _get_json(host: str, path: str, timeout: float) -> dict:
    conn = http.client.HTTPSConnection(host, 443, timeout=timeout, context=_CTX)
    try:
        conn.request("GET", path, headers={"Accept": "application/json",
                                           "User-Agent": "BoschHomeEnergyBridge/1.0"})
        resp = conn.getresponse()
        raw = resp.read(8 * 1024 * 1024)
        if resp.status != 200:
            raise RuntimeError(f"Open-Meteo HTTP {resp.status}")
        return json.loads(raw)
    finally:
        conn.close()


def fetch_days(lat: float, lon: float, past_days: int = 92, forecast_days: int = 3,
               timeout: float = 25.0) -> dict:
    """Daily weather from `past_days` ago up to `forecast_days` ahead (Open-Meteo
    model data for the location – not a station): {"daily": [{"day", "code",
    "tmax", "tmin", "sun_h", "daylight_h", "rain_mm", "snow_cm", "rad_kwh",
    "cloud"}], "hourly": [{"ts", "ghi", "cloud", "sun_min", "temp", "code"}]}.
    Hourly values describe the PRECEDING hour (Open-Meteo convention): the row
    with ts = 12:00 is 11:00–12:00. "cloud" per day = mean cloud cover of the
    daylight hours; "rad_kwh" = global horizontal irradiation in kWh/m²."""
    q = (f"?latitude={round(float(lat), 4)}&longitude={round(float(lon), 4)}"
         f"&daily={DAILY_VARS}&hourly={HOURLY_VARS}"
         f"&past_days={max(0, min(92, int(past_days)))}&forecast_days={max(1, min(16, int(forecast_days)))}"
         f"&timezone=auto")
    data = _get_json(API_HOST, API_PATH + q, timeout)
    h = data.get("hourly") or {}
    hourly = []
    for i, t in enumerate(h.get("time") or []):
        try:
            ts = int(time.mktime(time.strptime(t, "%Y-%m-%dT%H:%M")))
        except (ValueError, OverflowError, TypeError):
            continue
        sun = _f(h.get("sunshine_duration") or [], i, None)
        hourly.append({"ts": ts, "ghi": _f(h.get("shortwave_radiation") or [], i, None),
                       "cloud": _f(h.get("cloud_cover") or [], i, None),
                       "sun_min": round(sun / 60.0, 1) if sun is not None else None,
                       "temp": _f(h.get("temperature_2m") or [], i, None),
                       "code": _i(h.get("weather_code") or [], i)})
    # mean cloud cover while the sun is up, per local day (of the hour's start)
    cl: dict = {}
    for r in hourly:
        if r["cloud"] is None or not (r["ghi"] or 0) > 5:
            continue
        day = time.strftime("%Y-%m-%d", time.localtime(r["ts"] - 3600))
        a = cl.setdefault(day, [0.0, 0])
        a[0] += r["cloud"]
        a[1] += 1
    d = data.get("daily") or {}
    daily = []
    for i, day in enumerate(d.get("time") or []):
        sun = _f(d.get("sunshine_duration") or [], i, None)
        dl = _f(d.get("daylight_duration") or [], i, None)
        rad = _f(d.get("shortwave_radiation_sum") or [], i, None)
        c = cl.get(day)
        daily.append({"day": day, "code": _i(d.get("weather_code") or [], i),
                      "tmax": _f(d.get("temperature_2m_max") or [], i, None),
                      "tmin": _f(d.get("temperature_2m_min") or [], i, None),
                      "sun_h": round(sun / 3600.0, 2) if sun is not None else None,
                      "daylight_h": round(dl / 3600.0, 2) if dl is not None else None,
                      "rain_mm": _f(d.get("precipitation_sum") or [], i, None),
                      "snow_cm": _f(d.get("snowfall_sum") or [], i, None),
                      "rad_kwh": round(rad / 3.6, 3) if rad is not None else None,       # MJ/m² → kWh/m²
                      "cloud": round(c[0] / c[1]) if c and c[1] else None})
    return {"daily": daily, "hourly": hourly, "tz": data.get("timezone", "auto"),
            "utc_offset": int(data.get("utc_offset_seconds", 0) or 0)}


def geocode(name: str, timeout: float = 15.0) -> list:
    """Places matching a name (Open-Meteo geocoding): [{"name", "region",
    "country", "lat", "lon"}] – to set the location without GPS."""
    import urllib.parse
    q = "?" + urllib.parse.urlencode({"name": (name or "").strip()[:80], "count": 6,
                                      "language": "de", "format": "json"})
    data = _get_json("geocoding-api.open-meteo.com", "/v1/search" + q, timeout)
    out = []
    for r in data.get("results") or []:
        try:
            out.append({"name": r.get("name") or "", "region": r.get("admin1") or "",
                        "country": r.get("country") or "", "lat": round(float(r["latitude"]), 4),
                        "lon": round(float(r["longitude"]), 4)})
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _i(seq, i):
    try:
        v = seq[i]
        return int(v) if v is not None else None
    except (IndexError, TypeError, ValueError):
        return None


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
