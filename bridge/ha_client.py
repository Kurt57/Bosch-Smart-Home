#!/usr/bin/env python3
"""Home Assistant REST client – read power/energy sensors from a local HA.

Standard library only. Home Assistant does the heavy lifting (e.g. pairing a
HomeKit accessory like a Koogeek plug via its *HomeKit Controller* integration
and exposing its live wattage as a sensor); we simply read HA's documented REST
API over the LAN:

    Base:   http://<ha-host>:8123/api/
    Auth:   a Long-Lived Access Token (Bearer), created in HA under the user
            profile → "Long-lived access tokens".

Endpoints used:
    GET /api/            -> {"message": "API running."}   (token check)
    GET /api/states      -> [{entity_id, state, attributes:{...}}, …]

We surface the entities whose ``device_class`` is ``power`` (live W) or
``energy`` (cumulative kWh); other numeric sensors can be added by entity id.
"""

from __future__ import annotations

import http.client
import json
import ssl
import time
from urllib.parse import urlparse

_CTX = ssl.create_default_context()


class HAError(RuntimeError):
    pass


class HAAuthError(HAError):
    """The token was rejected – a fresh long-lived token is required."""


def _conn(url: str, timeout: float):
    u = urlparse(url if "://" in url else "http://" + url)
    host = u.hostname or ""
    if not host:
        raise HAError("Ungültige Home-Assistant-Adresse.")
    port = u.port or (443 if u.scheme == "https" else 8123)
    if u.scheme == "https":
        return http.client.HTTPSConnection(host, port, timeout=timeout, context=_CTX), u
    return http.client.HTTPConnection(host, port, timeout=timeout), u


def _get(url: str, token: str, path: str, timeout: float = 15.0):
    conn, _ = _conn(url, timeout)
    try:
        conn.request("GET", path, headers={
            "Authorization": "Bearer " + (token or "").strip(),
            "Content-Type": "application/json"})
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status in (401, 403):
            raise HAAuthError("Home-Assistant-Token abgelehnt (401/403).")
        if resp.status != 200:
            raise HAError(f"Home Assistant HTTP {resp.status}: {raw[:160]!r}")
        return json.loads(raw)
    finally:
        conn.close()


def verify(url: str, token: str) -> bool:
    """True if the token is accepted; raises HAAuthError/HAError otherwise."""
    data = _get(url, token, "/api/")
    if isinstance(data, dict) and "message" in data:
        return True
    raise HAError("Unerwartete Antwort von Home Assistant.")


def _num(state):
    try:
        return float(state)
    except (TypeError, ValueError):
        return None


def _to_watt(val, unit):
    if val is None:
        return None
    u = (unit or "").lower()
    if u in ("kw",):
        return val * 1000.0
    return val                              # assume W


def _to_kwh(val, unit):
    if val is None:
        return None
    u = (unit or "").lower()
    if u in ("wh",):
        return val / 1000.0
    if u in ("mwh",):
        return val * 1000.0
    return val                              # assume kWh


def fetch(url: str, token: str, entity_ids: list[str] | None = None,
          timeout: float = 15.0) -> dict:
    """Return {'entities': [{entity_id,name,kind,watt|kwh,unit,raw}], 'count'}.

    ``kind`` is 'power' or 'energy'. When ``entity_ids`` is given, only those are
    returned (any numeric sensor); otherwise power/energy sensors are
    auto-discovered by device_class."""
    states = _get(url, token, "/api/states", timeout)
    wanted = set(e.strip() for e in (entity_ids or []) if e.strip())
    out = []
    for s in states if isinstance(states, list) else []:
        eid = s.get("entity_id", "")
        attrs = s.get("attributes", {}) or {}
        dc = (attrs.get("device_class") or "").lower()
        unit = attrs.get("unit_of_measurement")
        name = attrs.get("friendly_name") or eid
        val = _num(s.get("state"))
        if wanted:
            if eid not in wanted:
                continue
            kind = "power" if dc == "power" or (unit or "").lower() in ("w", "kw") else \
                   "energy" if dc == "energy" or (unit or "").lower() in ("wh", "kwh", "mwh") else "other"
        else:
            if dc == "power":
                kind = "power"
            elif dc == "energy":
                kind = "energy"
            else:
                continue
        row = {"entity_id": eid, "name": name, "kind": kind, "unit": unit, "raw": s.get("state")}
        if kind == "power":
            row["watt"] = _to_watt(val, unit)
        elif kind == "energy":
            row["kwh"] = _to_kwh(val, unit)
        else:
            row["value"] = val
        out.append(row)
    out.sort(key=lambda r: (r["kind"] != "power", r["name"].lower()))
    return {"entities": out, "count": len(out)}


# ---- demo -------------------------------------------------------------- #
def demo() -> dict:
    """Synthetic HA readout: a Koogeek P1EU plug (live W + total kWh) plus one
    more sensor, so the UI shows something in --demo / offline."""
    import math
    t = time.time()
    w = round(35 + 25 * math.sin(t / 300) + 15, 1)      # wobbling ~50 W
    return {"entities": [
        {"entity_id": "sensor.koogeek_p1eu_power", "name": "Koogeek P1EU – Leistung",
         "kind": "power", "unit": "W", "raw": str(w), "watt": w},
        {"entity_id": "sensor.koogeek_p1eu_energy", "name": "Koogeek P1EU – Energie",
         "kind": "energy", "unit": "kWh", "raw": "128.4", "kwh": 128.4},
        {"entity_id": "sensor.fridge_power", "name": "Kühlschrank – Leistung",
         "kind": "power", "unit": "W", "raw": "78.0", "watt": 78.0},
    ], "count": 3, "demo": True}
