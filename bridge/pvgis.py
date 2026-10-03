#!/usr/bin/env python3
"""PVGIS client – real PV yield for a location (EU JRC, free, no API key).

https://re.jrc.ec.europa.eu/api/v5_2/PVcalc – returns the annual and monthly
PV energy for a 1 kWp system, i.e. the location's specific yield (kWh/kWp) and
the monthly production shape. Standard library only.

Azimuth convention (PVGIS ``aspect``): 0 = south, -90 = east, +90 = west,
180 = north.
"""

from __future__ import annotations

import http.client
import json
import ssl
from urllib.parse import urlencode

API_HOST = "re.jrc.ec.europa.eu"
API_PATH = "/api/v5_2/PVcalc"
_CTX = ssl.create_default_context()


def fetch(lat: float, lon: float, tilt: float = 35.0, azimuth: float = 0.0,
          loss: float = 14.0, mounting: str = "building", timeout: float = 25.0) -> dict:
    """Return {'yield': kWh/kWp/a, 'monthly': [12 fractions], 'monthly_kwh': [12]}.

    Raises on network/parse errors; the caller decides how to surface that."""
    params = {
        "lat": round(float(lat), 5), "lon": round(float(lon), 5),
        "peakpower": 1, "loss": float(loss), "angle": float(tilt),
        "aspect": float(azimuth), "mountingplace": mounting,
        "pvtechchoice": "crystSi", "outputformat": "json",
    }
    conn = http.client.HTTPSConnection(API_HOST, 443, timeout=timeout, context=_CTX)
    try:
        conn.request("GET", f"{API_PATH}?{urlencode(params)}", headers={"Accept": "application/json"})
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status != 200:
            raise RuntimeError(f"PVGIS HTTP {resp.status}: {raw[:160]!r}")
        data = json.loads(raw)
    finally:
        conn.close()
    out = data.get("outputs", {})
    e_y = (out.get("totals", {}).get("fixed", {}) or {}).get("E_y")
    monthly_rows = out.get("monthly", {}).get("fixed", []) or []
    monthly_kwh = [None] * 12
    for r in monthly_rows:
        try:
            monthly_kwh[int(r["month"]) - 1] = float(r["E_m"])
        except (KeyError, TypeError, ValueError, IndexError):
            continue
    have = [v for v in monthly_kwh if v is not None]
    if e_y is None and have:
        e_y = sum(have)
    total = sum(v for v in monthly_kwh if v is not None) or 1.0
    monthly = [round((v / total), 4) if v is not None else None for v in monthly_kwh]
    return {"yield": round(float(e_y), 1) if e_y is not None else None,
            "monthly": monthly, "monthly_kwh": monthly_kwh}
