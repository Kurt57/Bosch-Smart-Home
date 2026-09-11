#!/usr/bin/env python3
"""Bosch Smart Home energy bridge.

A tiny, dependency-free bridge between the *local* Bosch Smart Home Controller
(SHC) REST API and the iPhone web app in ``frontend/``.

What it does
------------
* Pairs a client certificate with your SHC (``pair`` sub-command).
* Polls every device that exposes a ``PowerMeter`` service (this includes the
  "Licht-/Rollladensteuerung II") and stores power (W) and the cumulative
  energy counter (Wh) in a local SQLite database.
* Serves a small JSON REST API plus the static web app so you can open it on
  your iPhone at ``http://<this-machine-ip>:8090/``.
* ``--demo`` fabricates a realistic household so you can try the whole stack
  without touching your real controller.

It only uses the Python standard library (plus the ``openssl`` command line
tool for the one-off certificate generation during pairing), so it runs on a
Raspberry Pi, NAS, Mac or PC with nothing to ``pip install``.

Local SHC API summary (confirmed against the official docs / boschshcpy):
* Registration:  POST https://<IP>:8443/smarthome/clients
                 headers: Content-Type: application/json,
                          Systempassword: base64(<system password>)
                 mutual TLS with the freshly generated client cert/key.
* Data:          https://<IP>:8444/smarthome  (mutual TLS, header api-version: 3.2)
                 GET /devices
                 GET /devices/{id}/services/{serviceId}
* PowerMeter state fields: powerConsumption (W), energyConsumption (Wh).
"""

from __future__ import annotations

import argparse
import base64
import http.client
import json
import math
import os
import re
import socket
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
try:
    import homecom  # optional Bosch HomeCom Easy (heat pump) client
except Exception:  # pragma: no cover - keeps the bridge running without it
    homecom = None

DEFAULT_FRONTEND = os.path.normpath(os.path.join(HERE, "..", "frontend"))
DEFAULT_DB = os.path.join(HERE, "energy.db")
DEFAULT_CERT = os.path.join(HERE, "shc-client-cert.pem")
DEFAULT_KEY = os.path.join(HERE, "shc-client-key.pem")
DEFAULT_CONFIG = os.path.join(HERE, "config.json")

API_VERSION = "3.2"
CLIENT_NAME = "oss_BoschHomeEnergy_Binding"
CLIENT_ID = "oss_bosch_home_energy"


# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
def load_config(path: str) -> dict:
    cfg = {
        "shc_ip": os.environ.get("SHC_IP", ""),
        "system_password": os.environ.get("SHC_PASSWORD", ""),
        "cert": DEFAULT_CERT,
        "key": DEFAULT_KEY,
        "db": DEFAULT_DB,
        "poll_interval": 30,          # seconds between power samples
        "price_per_kwh": 0.35,        # €/kWh, used for cost estimates
        "currency": "€",
        # Optional filter: only keep devices whose name/model contains one of
        # these (case-insensitive) substrings. Empty = keep every power meter.
        "device_filter": [],
        # Optional Bosch HomeCom Easy (heat pump) – filled in via the web UI.
        "homecom_refresh_token": "",
        "homecom_gateway": "",
        "homecom_interval": 300,       # seconds between heat-pump polls
    }
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                cfg.update({k: v for k, v in json.load(fh).items() if v is not None})
        except (OSError, ValueError) as exc:
            print(f"[config] could not read {path}: {exc}", file=sys.stderr)
    return cfg


def _parse_start_date(raw) -> int | None:
    """Best-effort parse of energyConsumptionStartDate to epoch seconds.

    Controllers may report this as epoch milliseconds (int) OR as an ISO-8601
    string like '2025-11-28T18:02:46Z'. Never raises – returns None on anything
    unexpected, so it can never break the polling loop.
    """
    if raw is None:
        return None
    try:
        if isinstance(raw, (int, float)):
            v = float(raw)
            return int(v / 1000) if v > 1e12 else int(v)
        s = str(raw).strip()
        if not s:
            return None
        if s.isdigit():
            v = int(s)
            return int(v / 1000) if v > 1e12 else v
        # ISO-8601; normalise the trailing 'Z' and drop fractional seconds
        s = s.replace("Z", "+00:00")
        if "." in s:
            head, _, tail = s.partition(".")
            off = ""
            for sign in ("+", "-"):
                idx = tail.find(sign)
                if idx != -1:
                    off = tail[idx:]
                    break
            s = head + off
        return int(datetime.fromisoformat(s).timestamp())
    except (ValueError, TypeError, OverflowError):
        return None


# --------------------------------------------------------------------------- #
# SHC client (mutual TLS, standard library only)
# --------------------------------------------------------------------------- #
class SHCClient:
    """Minimal mutual-TLS client for the local Bosch SHC REST API."""

    def __init__(self, ip: str, cert: str, key: str, timeout: float = 15.0):
        self.ip = ip
        self.cert = cert
        self.key = key
        self.timeout = timeout

    def _context(self) -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        # The SHC uses a self-signed server certificate; we authenticate it by
        # our own client certificate instead of a public CA chain.
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ctx.load_cert_chain(certfile=self.cert, keyfile=self.key)
        return ctx

    def _request(self, method: str, port: int, path: str,
                 body: bytes | None = None, extra_headers: dict | None = None) -> tuple[int, bytes]:
        conn = http.client.HTTPSConnection(
            self.ip, port, timeout=self.timeout, context=self._context()
        )
        headers = {"api-version": API_VERSION, "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if extra_headers:
            headers.update(extra_headers)
        try:
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            return resp.status, data
        finally:
            conn.close()

    def get(self, path: str) -> object:
        status, data = self._request("GET", 8444, path)
        if status != 200:
            raise RuntimeError(f"GET {path} -> HTTP {status}: {data[:200]!r}")
        return json.loads(data) if data else None

    # -- registration ------------------------------------------------------ #
    def register(self, system_password: str) -> tuple[int, bytes]:
        with open(self.cert, "r", encoding="utf-8") as fh:
            pem = fh.read().strip()
        one_line = (
            pem.replace("\n", "")
            .replace("-----BEGIN CERTIFICATE-----", "-----BEGIN CERTIFICATE-----\r")
            .replace("-----END CERTIFICATE-----", "\r-----END CERTIFICATE-----")
        )
        payload = json.dumps({
            "@type": "client",
            "id": CLIENT_ID,
            "name": CLIENT_NAME,
            "primaryRole": "ROLE_RESTRICTED_CLIENT",
            "certificate": one_line,
        }).encode("utf-8")
        pw_b64 = base64.b64encode(system_password.encode("utf-8")).decode("utf-8")
        return self._request(
            "POST", 8443, "/smarthome/clients",
            body=payload, extra_headers={"Systempassword": pw_b64},
        )

    # -- device discovery -------------------------------------------------- #
    def list_power_devices(self, name_filter: list[str] | None = None) -> list[dict]:
        """Return devices that expose a PowerMeter service.

        Each entry: {id, name, room, model}.
        """
        devices = self.get("/smarthome/devices") or []
        rooms = {}
        try:
            raw_rooms = self.get("/smarthome/rooms") or []
            if isinstance(raw_rooms, dict):  # some firmwares wrap the list
                raw_rooms = raw_rooms.get("rooms") or raw_rooms.get("items") or []
            for room in raw_rooms:
                if isinstance(room, dict):
                    rooms[room.get("id")] = room.get("name")
        except Exception:
            pass

        by_id = {d.get("id"): d for d in devices if isinstance(d, dict)}

        def is_generic(nm: str) -> bool:
            # matches only Bosch's default product label, not user names that
            # merely contain "…steuerung" (e.g. "Lichtsteuerung Elif")
            return (not nm) or bool(re.search(
                r"rollladensteuerung|micromodule|light[\s_-]?control|shutter[\s_-]?control",
                nm, re.I))

        result = []
        for dev in devices:
            dev_id = dev.get("id")
            services = dev.get("deviceServiceIds") or []
            if "PowerMeter" not in services:
                continue
            name = dev.get("name") or ""
            model = dev.get("deviceModel") or ""
            room_id = dev.get("roomId")
            # Bosch puts the PowerMeter on the LIGHT_CONTROL module, but the
            # user-given names/rooms live on its attached child lights
            # (MICROMODULE_LIGHT_ATTACHED) or, less often, a parent device.
            # Inherit from those when this device itself is generic/roomless.
            if is_generic(name) or not room_id:
                linked = [by_id.get(dev.get("parentDeviceId"))]
                linked += [by_id.get(cid) for cid in (dev.get("childDeviceIds") or [])]
                linked = [d for d in linked if d]
                names = [d.get("name") for d in linked
                         if d.get("name") and not is_generic(d.get("name"))]
                rooms_c = [d.get("roomId") for d in linked if d.get("roomId")]
                if is_generic(name) and names:
                    uniq = list(dict.fromkeys(names))
                    name = " + ".join(uniq[:2]) + (" …" if len(uniq) > 2 else "")
                if not room_id and rooms_c:
                    room_id = max(set(rooms_c), key=rooms_c.count)
            name = name or dev_id
            if name_filter:
                hay = f"{name} {model}".lower()
                if not any(f.lower() in hay for f in name_filter):
                    continue
            result.append({
                "id": dev_id,
                "name": name,
                "room": rooms.get(room_id, ""),
                "model": model,
            })
        return result

    def read_power(self, device_id: str) -> dict | None:
        """Return {power_w, energy_wh, energy_start} for a device's PowerMeter."""
        state = self.get(f"/smarthome/devices/{device_id}/services/PowerMeter")
        if not state:
            return None
        st = state.get("state", state)
        return {
            "power_w": float(st.get("powerConsumption", 0.0) or 0.0),
            "energy_wh": float(st.get("energyConsumption", 0.0) or 0.0),
            "energy_start": _parse_start_date(st.get("energyConsumptionStartDate")),
        }


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #
class Store:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init()

    def _init(self):
        with self.lock, self.conn:
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS devices("
                " id TEXT PRIMARY KEY, name TEXT, room TEXT, model TEXT,"
                " last_seen INTEGER, energy_start INTEGER)"
            )
            # add columns for databases created before these existed
            cols = [r[1] for r in self.conn.execute("PRAGMA table_info(devices)")]
            if "energy_start" not in cols:
                self.conn.execute("ALTER TABLE devices ADD COLUMN energy_start INTEGER")
            if "custom_name" not in cols:
                self.conn.execute("ALTER TABLE devices ADD COLUMN custom_name TEXT")
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS samples("
                " device_id TEXT, ts INTEGER, power_w REAL, energy_wh REAL)"
            )
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_samples ON samples(device_id, ts)"
            )
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS hp_samples("
                " gateway TEXT, ts INTEGER, energy_kwh REAL, power_w REAL,"
                " thermal_kw REAL, modulation REAL, outdoor_c REAL)"
            )
            hpcols = [r[1] for r in self.conn.execute("PRAGMA table_info(hp_samples)")]
            for col in ("heat_kwh", "heat_w"):
                if col not in hpcols:
                    self.conn.execute(f"ALTER TABLE hp_samples ADD COLUMN {col} REAL")
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_hp ON hp_samples(ts)"
            )

    # -- heat pump ------------------------------------------------------- #
    def add_hp_sample(self, row: dict):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO hp_samples(gateway,ts,energy_kwh,power_w,thermal_kw,"
                "modulation,outdoor_c,heat_kwh,heat_w) VALUES(?,?,?,?,?,?,?,?,?)",
                (row.get("gateway"), row["ts"], row.get("energy_kwh"), row.get("power_w"),
                 row.get("thermal_kw"), row.get("modulation"), row.get("outdoor_c"),
                 row.get("heat_kwh"), row.get("heat_w")),
            )

    def hp_prev(self, field: str):
        """Most recent (ts, <field>) with a non-null value, for power calc."""
        if field not in ("energy_kwh", "heat_kwh"):
            return None
        with self.lock:
            cur = self.conn.execute(
                f"SELECT ts,{field} AS v FROM hp_samples WHERE {field} IS NOT NULL"
                " ORDER BY ts DESC LIMIT 1")
            row = cur.fetchone()
            return (row["ts"], row["v"]) if row else None

    def hp_latest(self) -> dict | None:
        with self.lock:
            cur = self.conn.execute("SELECT * FROM hp_samples ORDER BY ts DESC LIMIT 1")
            row = cur.fetchone()
            return dict(row) if row else None

    def add_hp_samples_bulk(self, rows: list[tuple]):
        """Bulk insert (gateway,ts,energy_kwh,power_w,thermal_kw,modulation,
        outdoor_c,heat_kwh,heat_w) tuples – used by the demo seeder."""
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO hp_samples(gateway,ts,energy_kwh,power_w,thermal_kw,"
                "modulation,outdoor_c,heat_kwh,heat_w) VALUES(?,?,?,?,?,?,?,?,?)", rows)

    def hp_samples_since(self, since_ts: int) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT * FROM hp_samples WHERE ts>=? ORDER BY ts ASC", (since_ts,))
            return [dict(r) for r in cur.fetchall()]

    def hp_count(self) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) AS c FROM hp_samples").fetchone()["c"]

    def upsert_device(self, dev: dict, ts: int, energy_start: int | None = None):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO devices(id,name,room,model,last_seen,energy_start)"
                " VALUES(?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET name=excluded.name, room=excluded.room,"
                " model=excluded.model, last_seen=excluded.last_seen,"
                " energy_start=COALESCE(excluded.energy_start, devices.energy_start)",
                (dev["id"], dev["name"], dev.get("room", ""), dev.get("model", ""),
                 ts, energy_start),
            )

    def set_custom_name(self, device_id: str, name: str | None):
        """Store a user-assigned name for a device (local only, never pushed)."""
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE devices SET custom_name=? WHERE id=?",
                ((name or "").strip() or None, device_id),
            )

    def add_sample(self, device_id: str, ts: int, power_w: float, energy_wh: float):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO samples(device_id,ts,power_w,energy_wh) VALUES(?,?,?,?)",
                (device_id, ts, power_w, energy_wh),
            )

    def add_samples_bulk(self, rows: list[tuple]):
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO samples(device_id,ts,power_w,energy_wh) VALUES(?,?,?,?)", rows
            )

    def devices(self) -> list[dict]:
        with self.lock:
            cur = self.conn.execute("SELECT * FROM devices ORDER BY name")
            return [dict(r) for r in cur.fetchall()]

    def latest(self, device_id: str) -> dict | None:
        with self.lock:
            cur = self.conn.execute(
                "SELECT ts,power_w,energy_wh FROM samples WHERE device_id=?"
                " ORDER BY ts DESC LIMIT 1", (device_id,)
            )
            row = cur.fetchone()
            return dict(row) if row else None

    def samples_since(self, since_ts: int, device_id: str | None = None) -> list[dict]:
        q = "SELECT device_id,ts,power_w,energy_wh FROM samples WHERE ts>=?"
        args = [since_ts]
        if device_id and device_id != "all":
            q += " AND device_id=?"
            args.append(device_id)
        q += " ORDER BY ts ASC"
        with self.lock:
            cur = self.conn.execute(q, args)
            return [dict(r) for r in cur.fetchall()]

    def min_ts(self) -> int | None:
        with self.lock:
            cur = self.conn.execute("SELECT MIN(ts) AS m FROM samples")
            row = cur.fetchone()
            return row["m"] if row and row["m"] is not None else None

    def count(self) -> int:
        with self.lock:
            cur = self.conn.execute("SELECT COUNT(*) AS c FROM samples")
            return cur.fetchone()["c"]


# --------------------------------------------------------------------------- #
# Analytics – turn raw samples into the numbers the UI shows
# --------------------------------------------------------------------------- #
def _local_day(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def _energy_for_bucket(samples: list[dict]) -> float:
    """Energy (Wh) for a list of samples of ONE device, time-ordered.

    Prefer the cumulative energy counter delta; fall back to integrating power
    over time if the counter is flat/unavailable or resets.
    """
    if len(samples) < 2:
        return 0.0
    counter_delta = samples[-1]["energy_wh"] - samples[0]["energy_wh"]
    if counter_delta > 0:
        return counter_delta
    # Fallback: trapezoidal integration of power (W) over time (h).
    wh = 0.0
    for a, b in zip(samples, samples[1:]):
        dt_h = (b["ts"] - a["ts"]) / 3600.0
        if 0 < dt_h < 6:  # ignore huge gaps (bridge was offline)
            wh += (a["power_w"] + b["power_w"]) / 2.0 * dt_h
    return wh


def compute_analytics(store: Store, days: int, price: float) -> dict:
    now = int(time.time())
    since = now - days * 86400
    all_samples = store.samples_since(since)
    devices = {d["id"]: d for d in store.devices()}

    # group per device
    by_dev: dict[str, list[dict]] = {}
    for s in all_samples:
        by_dev.setdefault(s["device_id"], []).append(s)

    # --- live snapshot ---------------------------------------------------- #
    per_device = []
    total_now = 0.0
    total_energy_kwh = 0.0
    for dev_id, dev in devices.items():
        latest = store.latest(dev_id)
        p = latest["power_w"] if latest else 0.0
        e = latest["energy_wh"] if latest else 0.0
        total_now += p
        total_energy_kwh += e / 1000.0
        per_device.append({
            "id": dev_id,
            "name": dev["name"],
            "custom_name": dev.get("custom_name") or "",
            "room": dev.get("room", ""),
            "model": dev.get("model", ""),
            "power_w": round(p, 2),
            "energy_kwh_total": round(e / 1000.0, 3),
            "last_seen": latest["ts"] if latest else None,
        })
    per_device.sort(key=lambda d: d["power_w"], reverse=True)

    # --- day / hour / weekday buckets ------------------------------------- #
    day_kwh: dict[str, float] = {}
    day_active_kwh: dict[str, float] = {}
    hour_power: dict[int, list[float]] = {h: [] for h in range(24)}
    hw_power: dict[tuple[int, int], list[float]] = {}
    weekday_kwh: dict[int, list[float]] = {i: [] for i in range(7)}
    per_device_day: dict[str, dict[str, float]] = {}

    # baseline (standby) power = low percentile of all power readings
    all_powers = sorted(s["power_w"] for s in all_samples) or [0.0]
    baseline_w = all_powers[max(0, int(len(all_powers) * 0.10) - 1)]

    for dev_id, samples in by_dev.items():
        # split per local day, compute energy per day for this device
        day_groups: dict[str, list[dict]] = {}
        for s in samples:
            day_groups.setdefault(_local_day(s["ts"]), []).append(s)
        for day, rows in day_groups.items():
            wh = _energy_for_bucket(rows)
            day_kwh[day] = day_kwh.get(day, 0.0) + wh / 1000.0
            per_device_day.setdefault(dev_id, {})[day] = round(wh / 1000.0, 4)
            # active energy = above standby baseline
            active_wh = max(0.0, wh - baseline_w * (
                (rows[-1]["ts"] - rows[0]["ts"]) / 3600.0))
            day_active_kwh[day] = day_active_kwh.get(day, 0.0) + active_wh / 1000.0
        # hourly / weekday average power profile
        for s in samples:
            dt = datetime.fromtimestamp(s["ts"])
            hour_power[dt.hour].append(s["power_w"])
            hw_power.setdefault((dt.weekday(), dt.hour), []).append(s["power_w"])

    for day, kwh in day_kwh.items():
        wd = datetime.strptime(day, "%Y-%m-%d").weekday()
        weekday_kwh[wd].append(kwh)

    days_sorted = sorted(day_kwh.keys())
    daily_series = [{"day": d, "kwh": round(day_kwh[d], 3),
                     "active_kwh": round(day_active_kwh.get(d, 0.0), 3)}
                    for d in days_sorted]

    hourly_profile = [
        {"hour": h,
         "avg_w": round(sum(v) / len(v), 2) if v else 0.0}
        for h, v in hour_power.items()
    ]
    weekday_profile = [
        {"weekday": i,
         "avg_kwh": round(sum(v) / len(v), 3) if v else 0.0}
        for i, v in weekday_kwh.items()
    ]
    # 7 x 24 grid of average power (W) for the profile heatmap
    heatmap = []
    for wd in range(7):
        row = []
        for h in range(24):
            v = hw_power.get((wd, h), [])
            row.append(round(sum(v) / len(v), 1) if v else 0.0)
        heatmap.append(row)

    # --- statistics & forecast ------------------------------------------- #
    complete_days = [d for d in daily_series][1:-1] if len(daily_series) > 2 else daily_series
    kwh_values = [d["kwh"] for d in complete_days] or [0.0]
    avg_daily = sum(kwh_values) / len(kwh_values)
    median_daily = sorted(kwh_values)[len(kwh_values) // 2]
    year_estimate = avg_daily * 365.0

    # --- away detection --------------------------------------------------- #
    active_values = sorted(d["active_kwh"] for d in complete_days) or [0.0]
    median_active = active_values[len(active_values) // 2]
    away_threshold = max(0.02, median_active * 0.25)
    away_days = []
    for d in daily_series:
        presence = 0.0 if median_active <= 0 else min(1.0, d["active_kwh"] / (median_active or 1))
        is_away = d["active_kwh"] < away_threshold
        if is_away:
            away_days.append(d["day"])
        d["presence"] = round(presence, 2)
        d["likely_away"] = is_away

    # --- counter-based "day 1" estimate ---------------------------------- #
    # The PowerMeter counter is cumulative since energyConsumptionStartDate,
    # so total / age gives an average even before we have our own history.
    starts = [d.get("energy_start") for d in devices.values() if d.get("energy_start")]
    counter = None
    if starts and total_energy_kwh > 0:
        earliest = min(starts)
        since_days = max(0.5, (now - earliest) / 86400.0)
        c_avg = total_energy_kwh / since_days
        counter = {
            "since": earliest,
            "since_days": round(since_days, 1),
            "total_kwh": round(total_energy_kwh, 3),
            "avg_daily_kwh": round(c_avg, 3),
            "year_estimate_kwh": round(c_avg * 365, 1),
            "year_estimate_cost": round(c_avg * 365 * price, 2),
            "month_estimate_kwh": round(c_avg * 30.4, 2),
        }

    return {
        "generated_at": now,
        "window_days": days,
        "price_per_kwh": price,
        "baseline_w": round(baseline_w, 2),
        "counter_estimate": counter,
        "live": {
            "total_power_w": round(total_now, 2),
            "total_energy_kwh": round(total_energy_kwh, 3),
            "devices": per_device,
        },
        "daily": daily_series,
        "hourly_profile": hourly_profile,
        "weekday_profile": weekday_profile,
        "heatmap": heatmap,
        "per_device_day": per_device_day,
        "stats": {
            "avg_daily_kwh": round(avg_daily, 3),
            "median_daily_kwh": round(median_daily, 3),
            "min_daily_kwh": round(min(kwh_values), 3),
            "max_daily_kwh": round(max(kwh_values), 3),
            "year_estimate_kwh": round(year_estimate, 1),
            "year_estimate_cost": round(year_estimate * price, 2),
            "month_estimate_kwh": round(avg_daily * 30.4, 2),
            "month_estimate_cost": round(avg_daily * 30.4 * price, 2),
            "day_avg_cost": round(avg_daily * price, 2),
            "standby_share": round(
                (baseline_w * 24 / 1000.0) / avg_daily, 3) if avg_daily > 0 else 0.0,
        },
        "away": {
            "count": len(away_days),
            "days": away_days,
            "threshold_kwh": round(away_threshold, 3),
            "analysed_days": len(daily_series),
        },
    }


def _counter_day_kwh(samples: list[dict], field: str) -> dict:
    """Energy (kWh) per local day from a cumulative kWh counter.

    Attribute each consecutive counter delta to the day of the earlier sample,
    so energy split across midnight lands on the right day. Guards against
    counter resets and long offline gaps.
    """
    out: dict[str, float] = {}
    prev = None
    for s in samples:
        v = s.get(field)
        if v is None:
            continue
        if prev is not None:
            pt, pv = prev
            delta = v - pv
            dt_h = (s["ts"] - pt) / 3600.0
            if 0 < delta < 100 and 0 < dt_h < 24:   # sane step, no reset/gap
                out[_local_day(pt)] = out.get(_local_day(pt), 0.0) + delta
        prev = (s["ts"], v)
    return out


def compute_hp_analytics(store: Store, days: int, price: float,
                         live: dict | None = None) -> dict:
    """Heat-pump history & profile, derived from the polled cumulative counters
    (electrical = compressor+eheater, thermal = produced heat)."""
    now = int(time.time())
    since = now - days * 86400
    rows = store.hp_samples_since(since)
    live = live or {}

    elec_day = _counter_day_kwh(rows, "energy_kwh")
    heat_day = _counter_day_kwh(rows, "heat_kwh")
    all_days = sorted(set(elec_day) | set(heat_day))
    daily = []
    for d in all_days:
        e = round(elec_day.get(d, 0.0), 3)
        h = round(heat_day.get(d, 0.0), 3)
        daily.append({"day": d, "elec_kwh": e, "heat_kwh": h,
                      "cop": round(h / e, 2) if e > 0 else None,
                      "cost": round(e * price, 2)})

    # hourly electrical-power profile + 7x24 heatmap (W)
    hour_power = {h: [] for h in range(24)}
    hw_power: dict[tuple[int, int], list[float]] = {}
    outdoor_hour = {h: [] for h in range(24)}
    for s in rows:
        if s.get("power_w") is None:
            continue
        dt = datetime.fromtimestamp(s["ts"])
        hour_power[dt.hour].append(s["power_w"])
        hw_power.setdefault((dt.weekday(), dt.hour), []).append(s["power_w"])
        if s.get("outdoor_c") is not None:
            outdoor_hour[dt.hour].append(s["outdoor_c"])
    hourly_profile = [{"hour": h,
                       "avg_w": round(sum(v) / len(v), 1) if v else 0.0,
                       "avg_outdoor": round(sum(outdoor_hour[h]) / len(outdoor_hour[h]), 1)
                       if outdoor_hour[h] else None}
                      for h, v in hour_power.items()]
    heatmap = [[round(sum(hw_power.get((wd, h), [])) / len(hw_power[(wd, h)]), 1)
                if hw_power.get((wd, h)) else 0.0 for h in range(24)] for wd in range(7)]

    # monthly totals (electrical + thermal kWh) – the "monatliche Wärmekarte"
    month_e: dict[str, float] = {}
    month_h: dict[str, float] = {}
    for d in all_days:
        m = d[:7]
        month_e[m] = month_e.get(m, 0.0) + elec_day.get(d, 0.0)
        month_h[m] = month_h.get(m, 0.0) + heat_day.get(d, 0.0)
    monthly = [{"month": m, "elec_kwh": round(month_e[m], 1),
                "heat_kwh": round(month_h.get(m, 0.0), 1),
                "cop": round(month_h.get(m, 0.0) / month_e[m], 2) if month_e[m] > 0 else None}
               for m in sorted(month_e)]

    # today so far
    today = _local_day(now)
    today_e = round(elec_day.get(today, 0.0), 3)
    today_h = round(heat_day.get(today, 0.0), 3)

    complete = daily[1:-1] if len(daily) > 2 else daily
    e_vals = [d["elec_kwh"] for d in complete] or [0.0]
    avg_e = sum(e_vals) / len(e_vals)
    tot_e = sum(elec_day.values())
    tot_h = sum(heat_day.values())

    return {
        "generated_at": now,
        "window_days": days,
        "connected": bool(live.get("connected") or rows),
        "live": {
            "power_w": live.get("power_w"),
            "heat_w": live.get("heat_w"),
            "cop_live": live.get("cop_live"),
            "cop_lifetime": live.get("cop_lifetime"),
            "modulation": live.get("modulation"),
            "mode": live.get("mode"),
            "outdoor_c": live.get("outdoor_c"),
            "supply_c": live.get("supply_c"),
            "return_c": live.get("return_c"),
            "energy_kwh": live.get("energy_kwh"),
            "heat_kwh": live.get("heat_kwh"),
            "compressor_kwh": live.get("compressor_kwh"),
            "eheater_kwh": live.get("eheater_kwh"),
            "starts": live.get("starts"),
            "working_h": live.get("working_h"),
            "last_poll": live.get("last_poll"),
        },
        "today": {"elec_kwh": today_e, "heat_kwh": today_h,
                  "cost": round(today_e * price, 2),
                  "cop": round(today_h / today_e, 2) if today_e > 0 else None},
        "daily": daily,
        "monthly": monthly,
        "hourly_profile": hourly_profile,
        "heatmap": heatmap,
        "stats": {
            "avg_daily_elec_kwh": round(avg_e, 3),
            "window_elec_kwh": round(tot_e, 1),
            "window_heat_kwh": round(tot_h, 1),
            "window_cost": round(tot_e * price, 2),
            "seasonal_cop": round(tot_h / tot_e, 2) if tot_e > 0 else None,
            "year_estimate_kwh": round(avg_e * 365, 1),
            "year_estimate_cost": round(avg_e * 365 * price, 2),
        },
    }


def compute_overview(store: Store, days: int, price: float,
                     hp_live: dict | None = None) -> dict:
    """One combined snapshot for the dashboard: Smart Home + heat pump together,
    'heute bisher', current draw, cost and a 'wofür' breakdown."""
    now = int(time.time())
    today = _local_day(now)
    sh = compute_analytics(store, days, price)
    hp = compute_hp_analytics(store, days, price, hp_live)

    # today so far (kWh) per source
    sh_daily = {d["day"]: d for d in sh["daily"]}
    sh_today = round(sh_daily.get(today, {}).get("kwh", 0.0), 3)
    hp_today = hp["today"]["elec_kwh"]
    total_today = round(sh_today + hp_today, 3)

    # current draw (W)
    sh_now = sh["live"]["total_power_w"]
    hp_now = hp_live.get("power_w") if hp_live else None
    total_now = round(sh_now + (hp_now or 0.0), 1)

    # combined daily series (last `days`), stacked SmartHome vs heat pump
    hp_daily = {d["day"]: d for d in hp["daily"]}
    all_days = sorted(set(sh_daily) | set(hp_daily))
    combined_daily = [{
        "day": d,
        "smarthome_kwh": round(sh_daily.get(d, {}).get("kwh", 0.0), 3),
        "heatpump_kwh": round(hp_daily.get(d, {}).get("elec_kwh", 0.0), 3),
        "total_kwh": round(sh_daily.get(d, {}).get("kwh", 0.0)
                           + hp_daily.get(d, {}).get("elec_kwh", 0.0), 3),
    } for d in all_days]

    # today so far, by hour (kWh) for the "Heute"-timeline, from counter deltas
    mid = int(datetime.fromtimestamp(now).replace(
        hour=0, minute=0, second=0, microsecond=0).timestamp())
    sh_hour = [0.0] * 24
    by_dev_today: dict[str, list[dict]] = {}
    for s in store.samples_since(mid):
        by_dev_today.setdefault(s["device_id"], []).append(s)
    for rows in by_dev_today.values():
        prev = None
        for s in rows:
            if prev is not None:
                delta = s["energy_wh"] - prev["energy_wh"]
                if 0 < delta < 1e6 and (s["ts"] - prev["ts"]) < 21600:
                    sh_hour[datetime.fromtimestamp(prev["ts"]).hour] += delta / 1000.0
            prev = s
    hp_hour = [0.0] * 24
    prev = None
    for s in store.hp_samples_since(mid):
        v = s.get("energy_kwh")
        if v is None:
            continue
        if prev is not None and 0 < (v - prev[1]) < 100 and (s["ts"] - prev[0]) < 21600:
            hp_hour[datetime.fromtimestamp(prev[0]).hour] += v - prev[1]
        prev = (s["ts"], v)
    today_hourly = [{"hour": h, "smarthome_kwh": round(sh_hour[h], 3),
                     "heatpump_kwh": round(hp_hour[h], 3)} for h in range(24)]

    # "wofür" breakdown for today (kWh); heat pump split by heating vs hot water
    # is not per-day available, so it is shown as one heat-pump slice.
    def _label(d: dict) -> str:
        custom = (d.get("custom_name") or "").strip()
        if custom:
            return custom
        name = d.get("name") or ""
        generic = bool(re.search(r"rollladensteuerung|micromodule|light[\s_-]?control"
                                 r"|shutter[\s_-]?control", name, re.I)) \
            or name.lower() == (d.get("model") or "").lower()
        if generic and d.get("room"):
            return d["room"]
        return name or d.get("room") or dev_id

    breakdown = []
    if hp_today > 0 or (hp_live and hp_live.get("connected")):
        breakdown.append({"key": "heatpump", "label": "Wärmepumpe",
                          "kwh": hp_today, "color": "#ef6c4d"})
    # per Smart-Home device today
    pdd = sh.get("per_device_day", {})
    dev_by_id = {d["id"]: d for d in sh["live"]["devices"]}
    for dev_id, days_map in pdd.items():
        v = round(days_map.get(today, 0.0), 3)
        if v > 0:
            breakdown.append({"key": dev_id,
                              "label": _label(dev_by_id.get(dev_id, {"name": dev_id})),
                              "kwh": v, "color": "#4da3ff"})
    breakdown.sort(key=lambda x: x["kwh"], reverse=True)

    # combined month estimate
    sh_avg = sh["stats"]["avg_daily_kwh"]
    hp_avg = hp["stats"]["avg_daily_elec_kwh"]
    month_kwh = round((sh_avg + hp_avg) * 30.4, 1)
    year_kwh = round((sh_avg + hp_avg) * 365, 1)

    return {
        "generated_at": now,
        "window_days": days,
        "price_per_kwh": price,
        "heatpump_connected": bool(hp_live.get("connected")) if hp_live else False,
        "now": {"total_w": total_now, "smarthome_w": round(sh_now, 1),
                "heatpump_w": round(hp_now, 1) if hp_now is not None else None},
        "today": {"total_kwh": total_today, "smarthome_kwh": sh_today,
                  "heatpump_kwh": hp_today, "cost": round(total_today * price, 2)},
        "estimate": {"month_kwh": month_kwh, "month_cost": round(month_kwh * price, 2),
                     "year_kwh": year_kwh, "year_cost": round(year_kwh * price, 2)},
        "combined_daily": combined_daily,
        "today_hourly": today_hourly,
        "breakdown": breakdown,
        "heatpump": {"today": hp["today"], "live": hp["live"],
                     "seasonal_cop": hp["stats"]["seasonal_cop"]},
    }


# --------------------------------------------------------------------------- #
# Poller
# --------------------------------------------------------------------------- #
class Poller(threading.Thread):
    def __init__(self, client: SHCClient, store: Store, cfg: dict):
        super().__init__(daemon=True)
        self.client = client
        self.store = store
        self.cfg = cfg
        self._stop = threading.Event()
        self.last_error: str | None = None
        self.last_poll: int | None = None

    def run(self):
        interval = max(5, int(self.cfg.get("poll_interval", 30)))
        while not self._stop.is_set():
            try:
                self._poll_once()
                self.last_error = None
            except Exception as exc:  # keep the bridge alive on transient errors
                self.last_error = str(exc)
                print(f"[poll] error: {exc}", file=sys.stderr)
            self._stop.wait(interval)

    def _poll_once(self):
        ts = int(time.time())
        devices = self.client.list_power_devices(self.cfg.get("device_filter") or None)
        for dev in devices:
            try:
                reading = self.client.read_power(dev["id"])
                self.store.upsert_device(dev, ts, reading.get("energy_start") if reading else None)
                if reading:
                    self.store.add_sample(dev["id"], ts, reading["power_w"], reading["energy_wh"])
            except Exception as exc:  # one bad device must not stop the others
                print(f"[poll] device {dev.get('id')}: {exc}", file=sys.stderr)
        self.last_poll = ts

    def stop(self):
        self._stop.set()


# --------------------------------------------------------------------------- #
# Demo data
# --------------------------------------------------------------------------- #
DEMO_DEVICES = [
    {"id": "demo-wohnzimmer", "name": "Wohnzimmer Rollladen", "room": "Wohnzimmer",
     "model": "BSM"},
    {"id": "demo-kueche", "name": "Küche Licht", "room": "Küche", "model": "BSM"},
    {"id": "demo-schlafzimmer", "name": "Schlafzimmer Rollladen", "room": "Schlafzimmer",
     "model": "BSM"},
    {"id": "demo-flur", "name": "Flur Licht", "room": "Flur", "model": "BSM"},
]


def _demo_power(dev_id: str, dt: datetime, away: bool) -> float:
    """Plausible instantaneous power (W) for a light/shutter micromodule."""
    h = dt.hour + dt.minute / 60.0
    weekend = dt.weekday() >= 5
    base = 0.4  # standby of the module itself
    if away:
        # only the standby draw and the occasional timer-driven shutter move
        if "rollladen" in dev_id and (abs(h - 8) < 0.2 or abs(h - 20) < 0.2):
            return base + 55.0
        return base + 0.1

    def bell(center, width, peak):
        return peak * math.exp(-((h - center) ** 2) / (2 * width ** 2))

    val = base
    if "kueche" in dev_id:
        val += bell(7.5, 1.0, 22) + bell(18.5, 2.0, 30) + (bell(12.5, 0.8, 15) if weekend else 0)
    elif "flur" in dev_id:
        val += bell(7, 1.2, 10) + bell(19, 2.5, 14) + bell(1, 0.3, 6)
    elif "wohnzimmer" in dev_id:
        val += bell(20, 2.8, 45) + bell(9, 1.5, 8)
        if abs(h - 7.5) < 0.15 or abs(h - 21.5) < 0.15:  # shutter movement spikes
            val += 60
    elif "schlafzimmer" in dev_id:
        val += bell(6.7, 0.8, 12) + bell(22, 1.2, 14)
        if abs(h - (7 if not weekend else 9)) < 0.15 or abs(h - 22) < 0.15:
            val += 58
    # small random-ish flicker without importing random (deterministic)
    val *= 1.0 + 0.06 * math.sin(dt.timestamp() / 137.0)
    return round(max(0.0, val), 2)


DEMO_HP_GW = "demo-hp"


def _demo_hp(dt: datetime) -> dict:
    """Plausible heat-pump operating point for the demo (Compress-style).

    Returns instantaneous electrical/thermal power (W), outdoor temp, modulation
    and mode. Space heating scales with cold; hot water spikes morning/evening.
    """
    doy = dt.timetuple().tm_yday
    h = dt.hour + dt.minute / 60.0
    # seasonal outdoor temperature (coldest ~ mid-Jan, warmest ~ mid-Jul)
    seasonal = 9.0 - 12.0 * math.cos((doy - 20) / 365.0 * 2 * math.pi)
    daily = 4.0 * math.sin((h - 14) / 24.0 * 2 * math.pi)
    outdoor = round(seasonal + daily, 1)

    dhw = (6.0 <= h <= 7.0) or (18.5 <= h <= 19.5)     # hot-water charge windows
    if dhw:
        elec, mode, cop = 1500.0, "dhw", 2.6
    elif outdoor < 16.0:                                # space heating
        elec = 300.0 + (16.0 - outdoor) * 95.0
        cop = max(1.6, min(4.8, 1.9 + 0.11 * outdoor))
        mode = "ch"
    else:
        elec, mode, cop = 14.0, "off", 0.0             # standby only
    elec *= 1.0 + 0.05 * math.sin(dt.timestamp() / 211.0)
    heat = elec * cop
    modulation = round(max(0.0, min(100.0, elec / 2600.0 * 100.0)), 0) if mode != "off" else 0
    supply = round(28.0 + (heat / 6000.0) * 12.0, 1) if mode != "off" else round(24.0, 1)
    return {"elec_w": round(max(0.0, elec), 1), "heat_w": round(max(0.0, heat), 1),
            "outdoor_c": outdoor, "modulation": modulation, "mode": mode,
            "supply_c": supply, "return_c": round(supply - (heat / 6000.0) * 5.0, 1)}


def seed_demo(store: Store, days: int = 90):
    if store.count() > 0:
        return
    print(f"[demo] seeding {days} days of synthetic history …")
    now = datetime.now()
    start = now - timedelta(days=days)
    # a couple of away periods (holidays / weekend trips)
    away_ranges = [
        (now - timedelta(days=40), now - timedelta(days=34)),   # ~1 week holiday
        (now - timedelta(days=17), now - timedelta(days=15)),   # weekend trip
        (now - timedelta(days=6), now - timedelta(days=5)),     # day away
    ]

    def is_away(dt):
        return any(a <= dt <= b for a, b in away_ranges)

    step = timedelta(minutes=15)
    counters = {d["id"]: 0.0 for d in DEMO_DEVICES}
    rows = []
    # counter start date = start of the seeded history (keeps the counter-based
    # estimate consistent with the measured daily average in demo mode)
    install = int(start.timestamp())
    for dev in DEMO_DEVICES:
        store.upsert_device(dev, int(now.timestamp()), energy_start=install)
    t = start
    while t <= now:
        away = is_away(t)
        for dev in DEMO_DEVICES:
            p = _demo_power(dev["id"], t, away)
            counters[dev["id"]] += p * (step.total_seconds() / 3600.0)  # Wh
            rows.append((dev["id"], int(t.timestamp()), p, round(counters[dev["id"]], 3)))
        t += step
    store.add_samples_bulk(rows)
    print(f"[demo] inserted {len(rows)} samples for {len(DEMO_DEVICES)} devices.")

    # heat-pump history (cumulative kWh counters, like the real emon values)
    hp_rows = []
    e_kwh = h_kwh = 0.0
    t = start
    while t <= now:
        op = _demo_hp(t)
        dt_h = step.total_seconds() / 3600.0
        e_kwh += op["elec_w"] / 1000.0 * dt_h
        h_kwh += op["heat_w"] / 1000.0 * dt_h
        hp_rows.append((DEMO_HP_GW, int(t.timestamp()), round(e_kwh, 4), op["elec_w"],
                        round(op["heat_w"] / 1000.0, 3), op["modulation"], op["outdoor_c"],
                        round(h_kwh, 4), op["heat_w"]))
        t += step
    store.add_hp_samples_bulk(hp_rows)
    print(f"[demo] inserted {len(hp_rows)} heat-pump samples.")


class DemoPoller(threading.Thread):
    """Keeps demo data 'live' by appending a fresh sample every interval."""

    def __init__(self, store: Store, interval: int = 30, hp_state: dict | None = None):
        super().__init__(daemon=True)
        self.store = store
        self.interval = interval
        self.hp_state = hp_state
        self.last_poll = int(time.time())
        self.last_error = None
        self._stop = threading.Event()

    def run(self):
        counters = {}
        for d in DEMO_DEVICES:
            latest = self.store.latest(d["id"])
            counters[d["id"]] = latest["energy_wh"] if latest else 0.0
        hp_latest = self.store.hp_latest() or {}
        e_kwh = hp_latest.get("energy_kwh") or 0.0
        h_kwh = hp_latest.get("heat_kwh") or 0.0
        while not self._stop.is_set():
            now = datetime.now()
            ts = int(now.timestamp())
            for dev in DEMO_DEVICES:
                p = _demo_power(dev["id"], now, away=False)
                counters[dev["id"]] += p * (self.interval / 3600.0)
                self.store.add_sample(dev["id"], ts, p, round(counters[dev["id"]], 3))
            # heat pump
            op = _demo_hp(now)
            dt_h = self.interval / 3600.0
            e_kwh += op["elec_w"] / 1000.0 * dt_h
            h_kwh += op["heat_w"] / 1000.0 * dt_h
            self.store.add_hp_sample({
                "gateway": DEMO_HP_GW, "ts": ts, "energy_kwh": round(e_kwh, 4),
                "power_w": op["elec_w"], "heat_kwh": round(h_kwh, 4), "heat_w": op["heat_w"],
                "thermal_kw": op["heat_w"] / 1000.0, "modulation": op["modulation"],
                "outdoor_c": op["outdoor_c"]})
            if self.hp_state is not None:
                cop = round(op["heat_w"] / op["elec_w"], 2) if op["elec_w"] > 0 else None
                self.hp_state.clear()
                self.hp_state.update({
                    "gateway": DEMO_HP_GW, "ts": ts, "power_w": op["elec_w"],
                    "heat_w": op["heat_w"], "cop_live": cop,
                    "cop_lifetime": round(h_kwh / e_kwh, 2) if e_kwh > 0 else None,
                    "energy_kwh": round(e_kwh, 1), "heat_kwh": round(h_kwh, 1),
                    "compressor_kwh": round(e_kwh * 0.87, 1), "eheater_kwh": round(e_kwh * 0.13, 1),
                    "modulation": op["modulation"], "mode": op["mode"],
                    "outdoor_c": op["outdoor_c"], "supply_c": op["supply_c"],
                    "return_c": op["return_c"], "starts": 655, "working_h": 4333,
                    "ok": True, "last_poll": ts})
            self.last_poll = ts
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


# --------------------------------------------------------------------------- #
# Heat pump (Bosch HomeCom Easy) poller
# --------------------------------------------------------------------------- #
class HeatPumpPoller(threading.Thread):
    def __init__(self, client, gateway, store: Store, state: dict, interval: int = 300):
        super().__init__(daemon=True)
        self.client = client
        self.gateway = gateway
        self.store = store
        self.state = state
        self.interval = max(60, int(interval))
        self._stop = threading.Event()
        self.last_error = None
        self.last_poll = None

    def run(self):
        while not self._stop.is_set():
            try:
                self._poll()
                self.last_error = None
                self.state["last_error"] = None
            except Exception as exc:
                self.last_error = str(exc)
                self.state["last_error"] = str(exc)
                print(f"[heatpump] error: {exc}", file=sys.stderr)
            self._stop.wait(self.interval)

    def _derive_power(self, field, current, ts):
        """Average power (W) from a cumulative kWh counter delta."""
        if current is None:
            return None
        prev = self.store.hp_prev(field)
        if prev and prev[1] is not None and current >= prev[1] and ts > prev[0]:
            dt_h = (ts - prev[0]) / 3600.0
            if 0 < dt_h < 24:
                return round((current - prev[1]) / dt_h * 1000.0, 1)
        return None

    def _poll(self):
        ts = int(time.time())
        data = self.client.read_heatpump(self.gateway)
        elec = data.get("energy_kwh")           # electrical total (kWh)
        heat = data.get("heat_kwh")             # thermal produced total (kWh)
        power_w = self._derive_power("energy_kwh", elec, ts)
        heat_w = self._derive_power("heat_kwh", heat, ts)
        self.store.add_hp_sample({
            "gateway": self.gateway, "ts": ts, "energy_kwh": elec, "power_w": power_w,
            "heat_kwh": heat, "heat_w": heat_w,
            "thermal_kw": (heat_w / 1000.0) if heat_w is not None else None,
            "modulation": data.get("modulation"), "outdoor_c": data.get("outdoor_c"),
        })
        # live + lifetime COP
        cop_live = round(heat_w / power_w, 2) if (heat_w and power_w and power_w > 0) else None
        cop_life = round(heat / elec, 2) if (heat and elec and elec > 0) else None
        snap = dict(data)
        snap.update({"gateway": self.gateway, "ts": ts, "power_w": power_w,
                     "heat_w": heat_w, "cop_live": cop_live, "cop_lifetime": cop_life,
                     "ok": True, "last_poll": ts})
        self.state.clear()
        self.state.update(snap)
        self.last_poll = ts

    def stop(self):
        self._stop.set()


# --------------------------------------------------------------------------- #
# Runtime – holds the store/config and the currently running poller so the
# poller can be (re)started from the web UI (pair / switch demo↔live).
# --------------------------------------------------------------------------- #
class Runtime:
    def __init__(self, store: Store, cfg: dict):
        self.store = store
        self.cfg = cfg
        self.poller = None
        self.mode = "idle"
        self.hp = None          # HeatPumpPoller
        self.hp_state = {}      # latest heat-pump snapshot

    def stop(self):
        if self.poller:
            self.poller.stop()
            self.poller = None
        self.stop_heatpump()

    def start_demo(self, days: int = 90):
        self.stop()
        seed_demo(self.store, days)
        self.cfg["_demo"] = True
        self.mode = "demo"
        self.poller = DemoPoller(self.store, int(self.cfg.get("poll_interval", 30)),
                                 hp_state=self.hp_state)
        self.poller.start()

    def start_live(self):
        self.stop()
        self.cfg["_demo"] = False
        self.mode = "live"
        client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
        self.poller = Poller(client, self.store, self.cfg)
        self.poller.start()

    # -- heat pump ------------------------------------------------------- #
    def save_homecom_token(self, refresh_token: str):
        """Persist a rotated HomeCom refresh token (single-use rotation)."""
        self.cfg["homecom_refresh_token"] = refresh_token
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))

    def homecom_client(self):
        """The shared HomeCom client (poller's), so refresh tokens aren't
        consumed twice. Creates one on demand if the poller isn't running."""
        if self.hp and getattr(self.hp, "client", None):
            return self.hp.client
        if not homecom or not self.cfg.get("homecom_refresh_token"):
            return None
        return homecom.HomeComClient(self.cfg["homecom_refresh_token"],
                                     on_token=self.save_homecom_token)

    def start_heatpump(self) -> bool:
        self.stop_heatpump()
        if not homecom or not self.cfg.get("homecom_refresh_token") \
                or not self.cfg.get("homecom_gateway"):
            return False
        client = homecom.HomeComClient(self.cfg["homecom_refresh_token"],
                                       on_token=self.save_homecom_token)
        self.hp = HeatPumpPoller(client, self.cfg["homecom_gateway"], self.store,
                                 self.hp_state, int(self.cfg.get("homecom_interval", 300)))
        self.hp.start()
        return True

    def stop_heatpump(self):
        if self.hp:
            self.hp.stop()
            self.hp = None


def save_config(cfg: dict, path: str):
    keep = ("shc_ip", "system_password", "cert", "key", "db", "poll_interval",
            "price_per_kwh", "currency", "device_filter",
            "homecom_refresh_token", "homecom_gateway", "homecom_interval")
    data = {k: cfg[k] for k in keep if k in cfg and not str(k).startswith("_")}
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
    except OSError as exc:
        print(f"[config] could not write {path}: {exc}", file=sys.stderr)


# --------------------------------------------------------------------------- #
# HTTP server
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "BoschHomeEnergyBridge/1.0"

    ctx: Runtime = None          # injected by the server factory
    frontend_dir: str = DEFAULT_FRONTEND

    # convenience accessors onto the shared runtime
    @property
    def store(self):
        return self.ctx.store

    @property
    def cfg(self):
        return self.ctx.cfg

    @property
    def poller(self):
        return self.ctx.poller

    def log_message(self, fmt, *args):  # quieter logging
        pass

    def _hp_live(self) -> dict:
        """Live heat-pump snapshot + a 'connected' flag (real token or demo)."""
        hp = dict(self.ctx.hp_state)
        hp["connected"] = bool(self.cfg.get("homecom_refresh_token")) or self.ctx.mode == "demo"
        return hp

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        if path.startswith("/api/"):
            return self._api(path, qs)
        return self._static(path)

    # -- write actions (pairing / config / mode from the web UI) ----------- #
    def _read_json(self) -> dict:
        n = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(n) if n else b""
        return json.loads(raw) if raw else {}

    def do_POST(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return self.send_error(404)
        try:
            body = self._read_json()
        except ValueError:
            return self._send_json({"error": "invalid json"}, 400)
        try:
            if parsed.path == "/api/config":
                return self._post_config(body)
            if parsed.path == "/api/pair":
                return self._post_pair(body)
            if parsed.path == "/api/mode":
                return self._post_mode(body)
            if parsed.path == "/api/device-name":
                return self._post_device_name(body)
            if parsed.path == "/api/homecom/connect":
                return self._post_homecom_connect(body)
            return self._send_json({"error": "unknown endpoint"}, 404)
        except Exception as exc:
            return self._send_json({"error": str(exc)}, 500)

    def _post_config(self, body):
        cfg = self.cfg
        for k in ("shc_ip", "system_password", "currency"):
            if body.get(k) is not None:
                cfg[k] = str(body[k])
        if body.get("price_per_kwh") is not None:
            cfg["price_per_kwh"] = float(body["price_per_kwh"])
        if body.get("poll_interval") is not None:
            cfg["poll_interval"] = max(5, int(body["poll_interval"]))
        if isinstance(body.get("device_filter"), list):
            cfg["device_filter"] = body["device_filter"]
        save_config(cfg, cfg.get("_config_path", DEFAULT_CONFIG))
        return self._send_json({"ok": True})

    def _post_pair(self, body):
        cfg = self.cfg
        ip = str(body.get("ip") or cfg.get("shc_ip") or "").strip()
        pw = str(body.get("password") or cfg.get("system_password") or "")
        if not ip or not pw:
            return self._send_json(
                {"ok": False, "error": "IP-Adresse und Systempasswort sind erforderlich."}, 400)
        cfg["shc_ip"], cfg["system_password"] = ip, pw
        if body.get("price_per_kwh") is not None:
            cfg["price_per_kwh"] = float(body["price_per_kwh"])
        if body.get("poll_interval") is not None:
            cfg["poll_interval"] = max(5, int(body["poll_interval"]))

        cert, key = cfg["cert"], cfg["key"]
        if not (os.path.exists(cert) and os.path.exists(key)):
            try:
                subprocess.run([
                    "openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048",
                    "-keyout", key, "-out", cert, "-days", "3650",
                    "-subj", f"/CN={CLIENT_ID}",
                ], check=True, capture_output=True)
            except (subprocess.CalledProcessError, FileNotFoundError) as exc:
                return self._send_json(
                    {"ok": False, "error": f"Zertifikat konnte nicht erzeugt werden "
                     f"(ist openssl installiert?): {exc}"}, 500)

        client = SHCClient(ip, cert, key)
        try:
            status, data = client.register(pw)
        except ssl.SSLError as exc:
            # TLS handshake reached the controller but our client cert was
            # rejected – almost always because it is NOT in registration mode.
            msg = str(exc)
            if "CERTIFICATE_UNKNOWN" in msg or "certificate unknown" in msg or "alert" in msg:
                hint = ("Controller erreichbar, aber das Zertifikat wurde abgewiesen. "
                        "Das heißt fast immer: der Kopplungsmodus war nicht aktiv. "
                        "Bitte KURZ den Knopf am Controller II drücken (LED beachten) und "
                        "innerhalb weniger Sekunden erneut koppeln.")
            else:
                hint = f"TLS-Fehler beim Koppeln: {exc}"
            return self._send_json({"ok": False, "error": hint}, 200)
        except Exception as exc:
            return self._send_json(
                {"ok": False, "error": f"Controller nicht erreichbar: {exc}. "
                 "Stimmt die IP-Adresse? Gleiches WLAN?"}, 502)

        if status in (200, 201):
            save_config(cfg, cfg.get("_config_path", DEFAULT_CONFIG))
            try:
                self.ctx.start_live()
            except Exception as exc:
                return self._send_json(
                    {"ok": True, "live": False,
                     "message": f"Gekoppelt, aber Live-Start schlug fehl: {exc}"})
            return self._send_json(
                {"ok": True, "live": True,
                 "message": "Erfolgreich gekoppelt und live geschaltet."})
        if status == 401:
            return self._send_json(
                {"ok": False, "error": "Falsches Systempasswort (HTTP 401)."}, 200)
        return self._send_json(
            {"ok": False, "error": f"Registrierung fehlgeschlagen (HTTP {status}). "
             "Am Controller II kurz den Knopf drücken und sofort erneut koppeln.",
             "detail": data[:200].decode("utf-8", "replace")}, 200)

    def _post_mode(self, body):
        mode = body.get("mode")
        if mode == "demo":
            self.ctx.start_demo()
            return self._send_json({"ok": True, "mode": "demo"})
        if mode == "live":
            cfg = self.cfg
            if not (os.path.exists(cfg["cert"]) and os.path.exists(cfg["key"])):
                return self._send_json(
                    {"ok": False, "error": "Noch nicht gekoppelt – zuerst koppeln."}, 200)
            if not cfg.get("shc_ip"):
                return self._send_json({"ok": False, "error": "Keine Controller-IP gesetzt."}, 200)
            self.ctx.start_live()
            return self._send_json({"ok": True, "mode": "live"})
        return self._send_json({"error": "mode muss 'live' oder 'demo' sein"}, 400)

    def _post_device_name(self, body):
        dev_id = str(body.get("id") or "").strip()
        if not dev_id:
            return self._send_json({"ok": False, "error": "device id fehlt"}, 400)
        self.store.set_custom_name(dev_id, body.get("name"))
        return self._send_json({"ok": True})

    def _post_homecom_connect(self, body):
        if not homecom:
            return self._send_json({"ok": False, "error": "HomeCom-Modul fehlt (homecom.py)."}, 500)
        code = str(body.get("code") or "").strip()
        if not code:
            return self._send_json({"ok": False, "error": "Login-Code fehlt."}, 400)
        cfg = self.cfg
        client = homecom.HomeComClient(on_token=self.ctx.save_homecom_token)
        try:
            refresh = client.exchange_code(code)
        except Exception as exc:
            return self._send_json(
                {"ok": False, "error": f"Login fehlgeschlagen: {exc}. "
                 "Code korrekt/kopiert? Er ist nur wenige Minuten gültig."}, 200)
        cfg["homecom_refresh_token"] = refresh
        # auto-detect the heat-pump gateway
        gateway = str(body.get("gateway") or "").strip()
        if not gateway:
            try:
                gws = client.list_gateways()
                gateway = gws[0] if gws else ""
            except Exception as exc:
                return self._send_json(
                    {"ok": True, "connected": True, "gateway": "",
                     "message": f"Angemeldet, aber Gateway-Liste fehlgeschlagen: {exc}"})
        cfg["homecom_gateway"] = gateway
        save_config(cfg, cfg.get("_config_path", DEFAULT_CONFIG))
        started = self.ctx.start_heatpump()
        return self._send_json({"ok": True, "connected": True, "gateway": gateway,
                                "started": started,
                                "message": "HomeCom verbunden." + (
                                    f" Wärmepumpe: {gateway}" if gateway else
                                    " Keine Wärmepumpe gefunden.")})

    # -- REST API ---------------------------------------------------------- #
    def _api(self, path, qs):
        try:
            if path == "/api/health":
                cfg = self.cfg
                have_cert = os.path.exists(cfg.get("cert", "")) and os.path.exists(cfg.get("key", ""))
                return self._send_json({
                    "ok": True,
                    "mode": self.ctx.mode,
                    "sample_count": self.store.count(),
                    "device_count": len(self.store.devices()),
                    "last_poll": getattr(self.poller, "last_poll", None),
                    "last_error": getattr(self.poller, "last_error", None),
                    "since": self.store.min_ts(),
                    "server_time": int(time.time()),
                    "price_per_kwh": self.cfg.get("price_per_kwh"),
                    "poll_interval": self.cfg.get("poll_interval", 30),
                    "currency": self.cfg.get("currency", "€"),
                    "shc_ip": self.cfg.get("shc_ip", ""),
                    "has_password": bool(self.cfg.get("system_password")),
                    "has_cert": have_cert,
                    "homecom_available": homecom is not None,
                    "homecom_connected": bool(self.cfg.get("homecom_refresh_token")),
                    "homecom_gateway": self.cfg.get("homecom_gateway", ""),
                    "homecom_last_error": self.ctx.hp_state.get("last_error"),
                    "homecom_last_poll": self.ctx.hp_state.get("last_poll"),
                })
            if path == "/api/devices":
                return self._send_json({"devices": self.store.devices()})
            if path == "/api/heatpump":
                st = dict(self.ctx.hp_state)
                st["available"] = bool(st) and st.get("energy_kwh") is not None or bool(st.get("last_poll"))
                st["connected"] = bool(self.cfg.get("homecom_refresh_token"))
                return self._send_json(st)
            if path == "/api/homecom/authurl":
                if not homecom:
                    return self._send_json({"error": "homecom modul fehlt"}, 500)
                return self._send_json({"url": homecom.authorize_url()})
            if path == "/api/homecom/probe":
                client = self.ctx.homecom_client()
                if not client:
                    return self._send_json({"error": "nicht mit HomeCom verbunden"}, 400)
                gid = qs.get("gateway", [self.cfg.get("homecom_gateway", "")])[0]
                return self._send_json({"gateway": gid, "results": client.probe(gid)})
            days = int(qs.get("days", ["60"])[0])
            price = float(qs.get("price", [self.cfg.get("price_per_kwh", 0.35)])[0])
            if path == "/api/analytics" or path == "/api/summary":
                return self._send_json(compute_analytics(self.store, days, price))
            if path == "/api/overview":
                return self._send_json(
                    compute_overview(self.store, days, price, self._hp_live()))
            if path == "/api/heatpump/analytics":
                return self._send_json(
                    compute_hp_analytics(self.store, days, price, self._hp_live()))
            if path == "/api/series":
                device = qs.get("device", ["all"])[0]
                since = int(time.time()) - days * 86400
                rows = self.store.samples_since(since, device)
                return self._send_json({"device": device, "samples": rows})
            if path == "/api/discover":
                found = discover_shc()
                return self._send_json({
                    "candidates": found,
                    "suggested": found[0] if found else "",
                    "scanned": local_subnet() + ".0/24",
                })
            if path == "/api/raw-devices":
                # diagnostic: raw controller device + room JSON (live only)
                if self.ctx.mode != "live":
                    return self._send_json({"error": "nur im Live-Modus verfügbar"}, 400)
                client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
                devs = client.get("/smarthome/devices") or []
                try:
                    rooms = client.get("/smarthome/rooms")
                except Exception:
                    rooms = None
                keys = ("id", "name", "deviceModel", "roomId", "parentDeviceId",
                        "childDeviceIds", "deviceServiceIds")
                power = [{k: d.get(k) for k in keys}
                         for d in devs if "PowerMeter" in (d.get("deviceServiceIds") or [])]
                # all devices (trimmed) so named/roomed "light" entities linked to
                # the power-meter modules can be found and mapped
                all_devs = [{k: d.get(k) for k in
                             ("id", "name", "deviceModel", "roomId", "parentDeviceId")}
                            for d in devs]
                return self._send_json({"power_devices": power, "all_devices": all_devs,
                                        "rooms": rooms})
            return self._send_json({"error": "unknown endpoint"}, 404)
        except Exception as exc:
            return self._send_json({"error": str(exc)}, 500)

    # -- static frontend --------------------------------------------------- #
    def _static(self, path):
        if path == "/" or path == "":
            path = "/index.html"
        # prevent path traversal
        safe = os.path.normpath(path).lstrip("/\\")
        full = os.path.join(self.frontend_dir, safe)
        if not full.startswith(self.frontend_dir) or not os.path.isfile(full):
            self.send_error(404, "Not found")
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".webmanifest": "application/manifest+json",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
        }.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)


def make_server(host, port, ctx, frontend_dir):
    handler = type("BoundHandler", (Handler,), {
        "ctx": ctx, "frontend_dir": frontend_dir,
    })
    httpd = ThreadingHTTPServer((host, port), handler)
    return httpd


def local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def local_subnet() -> str:
    """Return the /24 prefix of the local address, e.g. '192.168.1'."""
    return local_ip().rsplit(".", 1)[0]


def _port_open(ip: str, port: int, timeout: float) -> bool:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except OSError:
        return False
    s.settimeout(timeout)
    try:
        s.connect((ip, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def discover_shc(timeout: float = 0.4) -> list[str]:
    """Scan the local /24 for the Bosch SHC.

    The controller listens on the registration port (8443) *and* the data port
    (8444); requiring both open makes false positives on a home network rare.
    A bounded worker pool keeps the number of concurrent sockets well under the
    OS file-descriptor limit (macOS defaults to 256).
    """
    from concurrent.futures import ThreadPoolExecutor

    prefix = local_subnet()
    mine = local_ip()

    def check(ip):
        if ip == mine:
            return None
        # probe the data port first; only try 8443 if 8444 answered
        if _port_open(ip, 8444, timeout) and _port_open(ip, 8443, timeout):
            return ip
        return None

    hosts = [f"{prefix}.{i}" for i in range(1, 255)]
    found = []
    with ThreadPoolExecutor(max_workers=40) as pool:
        for res in pool.map(check, hosts):
            if res:
                found.append(res)
    return sorted(found, key=lambda x: int(x.rsplit(".", 1)[1]))


# --------------------------------------------------------------------------- #
# Sub-commands
# --------------------------------------------------------------------------- #
def cmd_pair(args, cfg):
    ip = args.ip or cfg.get("shc_ip")
    password = args.password or cfg.get("system_password")
    if not ip:
        sys.exit("Missing SHC IP. Use --ip or set shc_ip in config.json.")
    if not password:
        sys.exit("Missing system password. Use --password or set system_password.")

    cert, key = cfg["cert"], cfg["key"]
    if not (os.path.exists(cert) and os.path.exists(key)):
        print("[pair] generating a self-signed 2048-bit client certificate …")
        try:
            subprocess.run([
                "openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048",
                "-keyout", key, "-out", cert, "-days", "3650",
                "-subj", f"/CN={CLIENT_ID}",
            ], check=True, capture_output=True)
        except (subprocess.CalledProcessError, FileNotFoundError) as exc:
            sys.exit(f"[pair] could not run openssl to create the certificate: {exc}\n"
                     "Install openssl or generate cert/key manually.")

    print("\n>>> Put the controller into client-registration mode, THEN press Enter here:")
    print(">>>   • Smart Home Controller II: SHORT press the button on the front.")
    print(">>>   • Original Smart Home Controller (gen 1): press and HOLD until the LED flashes.")
    try:
        input()
    except EOFError:
        pass

    client = SHCClient(ip, cert, key)
    try:
        status, data = client.register(password)
    except ssl.SSLError as exc:
        sys.exit(f"[pair] TLS handshake rejected ({exc}).\n"
                 "The controller was reached but refused the certificate – it was most "
                 "likely NOT in registration mode. Short-press the button on the SHC II "
                 "and run `pair` again immediately.")
    if status in (200, 201):
        print("[pair] success! Client registered. You can now run `serve`.")
    elif status == 401:
        sys.exit("[pair] HTTP 401 – wrong system password.")
    else:
        sys.exit(f"[pair] registration failed (HTTP {status}): {data[:300]!r}\n"
                 "Make sure the controller was in registration mode (SHC II: short button "
                 "press; gen 1: hold until LED flashes) when you pressed Enter, then retry.")


def cmd_serve(args, cfg):
    store = Store(cfg["db"])
    cfg["_config_path"] = args.config
    if args.ip:
        cfg["shc_ip"] = args.ip
    if args.price is not None:
        cfg["price_per_kwh"] = args.price

    ctx = Runtime(store, cfg)
    have_cert = os.path.exists(cfg["cert"]) and os.path.exists(cfg["key"])
    if args.demo:
        ctx.start_demo(days=args.demo_days)
    elif cfg.get("shc_ip") and have_cert:
        ctx.start_live()
    else:
        # not configured yet – stay idle so the web UI can pair the controller
        ctx.mode = "idle"

    # optional: start the heat-pump (HomeCom) poller if already connected
    if ctx.start_heatpump():
        print(f"  Heat pump:   HomeCom gateway {cfg.get('homecom_gateway')}")

    frontend = args.frontend or DEFAULT_FRONTEND
    httpd = make_server(args.host, args.port, ctx, frontend)
    ip_hint = local_ip()
    mode_txt = {"demo": "DEMO", "live": "LIVE (" + cfg.get("shc_ip", "") + ")",
                "idle": "IDLE – noch nicht gekoppelt, bitte Setup im Browser öffnen"}[ctx.mode]
    print("\n  Bosch Home Energy bridge running")
    print(f"  Mode:        {mode_txt}")
    print(f"  Open on this machine:  http://localhost:{args.port}/")
    print(f"  Open on your iPhone:   http://{ip_hint}:{args.port}/")
    print("  (iPhone must be on the same Wi-Fi. Press Ctrl+C to stop.)\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping …")
    finally:
        ctx.stop()
        httpd.server_close()


def main():
    parser = argparse.ArgumentParser(description="Bosch Smart Home energy bridge")
    parser.add_argument("--config", default=DEFAULT_CONFIG, help="path to config.json")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_pair = sub.add_parser("pair", help="register a client certificate with the SHC")
    p_pair.add_argument("--ip", help="SHC IP address")
    p_pair.add_argument("--password", help="SHC system password")

    p_serve = sub.add_parser("serve", help="poll the SHC and serve the web app")
    p_serve.add_argument("--ip", help="SHC IP address (overrides config)")
    p_serve.add_argument("--host", default="0.0.0.0", help="bind host (default 0.0.0.0)")
    p_serve.add_argument("--port", type=int, default=8090, help="bind port (default 8090)")
    p_serve.add_argument("--demo", action="store_true", help="run with synthetic demo data")
    p_serve.add_argument("--demo-days", type=int, default=90, help="days of demo history")
    p_serve.add_argument("--price", type=float, help="price per kWh (e.g. 0.35)")
    p_serve.add_argument("--frontend", help="path to the frontend directory")

    args = parser.parse_args()
    cfg = load_config(args.config)

    if args.cmd == "pair":
        cmd_pair(args, cfg)
    elif args.cmd == "serve":
        cmd_serve(args, cfg)


if __name__ == "__main__":
    main()
