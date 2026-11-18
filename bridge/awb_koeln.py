#!/usr/bin/env python3
"""Waste collection dates of the AWB Köln (Abfallwirtschaftsbetriebe Köln) –
standard library only, read-only.

AWB has no documented public API. Its own website (awbkoeln.de/abfuhrkalender)
uses two JSON endpoints, which the community integration "waste_collection_
schedule" (Home Assistant) has relied on for years:

    GET https://www.awbkoeln.de/api/streets?street_name=…&building_number=…&form=json
        -> {"data": [{"street_name", "building_number", "street_code", "district",
                      "zipcode", "user_street_name", "user_building_number", …}]}
    GET https://www.awbkoeln.de/api/calendar?street_code=…&building_number=…
        &start_year=…&start_month=…&end_year=…&end_month=…
        -> {"data": [{"year": 2026, "month": 11, "day": 19, "type": "brown"}, …]}

As they are undocumented they can change; errors are reported in plain German.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime

BASE = "https://www.awbkoeln.de/api/"
UA = "BoschHomeEnergyBridge/1.0 (Abfuhrkalender)"

# bin types as the AWB reports them -> German label + colour. Unknown types are
# shown as reported (so a new kind still appears and can be mapped later).
BINS = [
    (("grey", "gray", "grau", "rest"), "Restmülltonne (grau)", "#8e8e93"),
    (("brown", "braun", "bio"), "Biotonne (braun)", "#a2845e"),
    (("blue", "blau", "papier", "paper"), "Papiertonne (blau)", "#0a84ff"),
    (("yellow", "gelb", "wertstoff", "recycl"), "Wertstofftonne (gelb)", "#ffcc00"),
    (("christmas", "weihnacht", "tannen", "baum"), "Weihnachtsbaum-Abfuhr", "#30d158"),
    (("sperr", "bulky"), "Sperrmüll", "#bf5af2"),
]


class AWBError(RuntimeError):
    """Problem with the AWB service – the message is shown to the user (German)."""


def bin_info(kind: str) -> tuple[str, str]:
    k = (kind or "").strip().lower()
    for keys, label, color in BINS:
        if any(x in k for x in keys):
            return label, color
    return (f"{kind.strip().capitalize()} (Abfuhr)" if kind and kind.strip() else "Abfuhr"), "#8e8e93"


def _get(endpoint: str, params: dict, timeout: float = 15.0) -> dict:
    url = BASE + endpoint + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(4 * 1024 * 1024)
    except urllib.error.HTTPError as exc:
        raise AWBError(f"AWB-Server antwortet mit HTTP {exc.code}.") from None
    except urllib.error.URLError as exc:
        raise AWBError(f"awbkoeln.de nicht erreichbar ({getattr(exc, 'reason', exc)}).") from None
    except OSError as exc:
        raise AWBError(f"awbkoeln.de nicht erreichbar ({exc}).") from None
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise AWBError("AWB liefert kein lesbares Ergebnis – hat sich die Schnittstelle geändert?") from None
    if not isinstance(data, dict) or not isinstance(data.get("data"), list):
        raise AWBError("AWB liefert ein unbekanntes Format – hat sich die Schnittstelle geändert?")
    return data


def find_address(street: str, number: str) -> list[dict]:
    """Addresses matching a street search + house number (for the setup)."""
    street, number = (street or "").strip(), (number or "").strip()
    if len(street) < 3:
        raise AWBError("Bitte mindestens 3 Buchstaben des Straßennamens eingeben.")
    data = _get("streets", {"street_name": street, "building_number": number, "form": "json"})
    out, seen = [], set()
    for d in data["data"]:
        if not isinstance(d, dict) or not d.get("street_code"):
            continue
        key = (str(d.get("street_code")), str(d.get("building_number") or number))
        if key in seen:
            continue
        seen.add(key)
        name = d.get("user_street_name") or d.get("street_name") or street
        nr = d.get("user_building_number") or d.get("building_number") or number
        place = " – ".join(x for x in (f"{d.get('zipcode') or ''} Köln".strip(), d.get("district") or "") if x)
        out.append({"street_code": key[0], "building_number": key[1],
                    "label": f"{name} {nr}".strip() + (f", {place}" if place else "")})
    return out


def fetch_dates(street_code: str, building_number: str, months: int = 13, today: date | None = None) -> list[dict]:
    """Collection dates from this month for `months` months, sorted:
    [{"date": date, "type": raw, "label": …, "color": …}]."""
    if not street_code or not building_number:
        raise AWBError("Keine Adresse für den Abfuhrkalender eingetragen.")
    t = today or datetime.now().date()
    last = t.month - 1 + max(1, months) - 1          # 0-based index of the last month
    params = {"street_code": street_code, "building_number": building_number,
              "start_year": t.year, "start_month": t.month,
              "end_year": t.year + last // 12, "end_month": last % 12 + 1}
    data = _get("calendar", params)
    out = []
    for d in data["data"]:
        try:
            day = date(int(d["year"]), int(d["month"]), int(d["day"]))
        except (KeyError, TypeError, ValueError):
            continue
        label, color = bin_info(str(d.get("type") or ""))
        out.append({"date": day, "type": str(d.get("type") or ""), "label": label, "color": color})
    out.sort(key=lambda x: (x["date"], x["label"]))
    return out
