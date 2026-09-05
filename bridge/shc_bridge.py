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
    }
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                cfg.update({k: v for k, v in json.load(fh).items() if v is not None})
        except (OSError, ValueError) as exc:
            print(f"[config] could not read {path}: {exc}", file=sys.stderr)
    return cfg


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
            for room in (self.get("/smarthome/rooms") or []):
                rooms[room.get("id")] = room.get("name")
        except RuntimeError:
            pass

        result = []
        for dev in devices:
            dev_id = dev.get("id")
            services = dev.get("deviceServiceIds") or []
            if "PowerMeter" not in services:
                continue
            name = dev.get("name") or dev_id
            model = dev.get("deviceModel") or ""
            if name_filter:
                hay = f"{name} {model}".lower()
                if not any(f.lower() in hay for f in name_filter):
                    continue
            result.append({
                "id": dev_id,
                "name": name,
                "room": rooms.get(dev.get("roomId"), ""),
                "model": model,
            })
        return result

    def read_power(self, device_id: str) -> dict | None:
        """Return {power_w, energy_wh} for a device's PowerMeter service."""
        state = self.get(f"/smarthome/devices/{device_id}/services/PowerMeter")
        if not state:
            return None
        st = state.get("state", state)
        return {
            "power_w": float(st.get("powerConsumption", 0.0) or 0.0),
            "energy_wh": float(st.get("energyConsumption", 0.0) or 0.0),
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
                " last_seen INTEGER)"
            )
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS samples("
                " device_id TEXT, ts INTEGER, power_w REAL, energy_wh REAL)"
            )
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_samples ON samples(device_id, ts)"
            )

    def upsert_device(self, dev: dict, ts: int):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO devices(id,name,room,model,last_seen) VALUES(?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET name=excluded.name, room=excluded.room,"
                " model=excluded.model, last_seen=excluded.last_seen",
                (dev["id"], dev["name"], dev.get("room", ""), dev.get("model", ""), ts),
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

    return {
        "generated_at": now,
        "window_days": days,
        "price_per_kwh": price,
        "baseline_w": round(baseline_w, 2),
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
            self.store.upsert_device(dev, ts)
            reading = self.client.read_power(dev["id"])
            if reading:
                self.store.add_sample(dev["id"], ts, reading["power_w"], reading["energy_wh"])
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
    for dev in DEMO_DEVICES:
        store.upsert_device(dev, int(now.timestamp()))
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


class DemoPoller(threading.Thread):
    """Keeps demo data 'live' by appending a fresh sample every interval."""

    def __init__(self, store: Store, interval: int = 30):
        super().__init__(daemon=True)
        self.store = store
        self.interval = interval
        self.last_poll = int(time.time())
        self.last_error = None
        self._stop = threading.Event()

    def run(self):
        counters = {}
        for d in DEMO_DEVICES:
            latest = self.store.latest(d["id"])
            counters[d["id"]] = latest["energy_wh"] if latest else 0.0
        while not self._stop.is_set():
            now = datetime.now()
            for dev in DEMO_DEVICES:
                p = _demo_power(dev["id"], now, away=False)
                counters[dev["id"]] += p * (self.interval / 3600.0)
                self.store.add_sample(dev["id"], int(now.timestamp()), p,
                                      round(counters[dev["id"]], 3))
            self.last_poll = int(now.timestamp())
            self._stop.wait(self.interval)

    def stop(self):
        self._stop.set()


# --------------------------------------------------------------------------- #
# HTTP server
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "BoschHomeEnergyBridge/1.0"

    # injected by the server factory
    store: Store = None
    cfg: dict = None
    poller = None
    frontend_dir: str = DEFAULT_FRONTEND

    def log_message(self, fmt, *args):  # quieter logging
        pass

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

    # -- REST API ---------------------------------------------------------- #
    def _api(self, path, qs):
        try:
            if path == "/api/health":
                return self._send_json({
                    "ok": True,
                    "mode": "demo" if self.cfg.get("_demo") else "live",
                    "sample_count": self.store.count(),
                    "last_poll": getattr(self.poller, "last_poll", None),
                    "last_error": getattr(self.poller, "last_error", None),
                    "since": self.store.min_ts(),
                    "server_time": int(time.time()),
                    "price_per_kwh": self.cfg.get("price_per_kwh"),
                    "currency": self.cfg.get("currency", "€"),
                })
            if path == "/api/devices":
                return self._send_json({"devices": self.store.devices()})
            days = int(qs.get("days", ["60"])[0])
            price = float(qs.get("price", [self.cfg.get("price_per_kwh", 0.35)])[0])
            if path == "/api/analytics" or path == "/api/summary":
                return self._send_json(compute_analytics(self.store, days, price))
            if path == "/api/series":
                device = qs.get("device", ["all"])[0]
                since = int(time.time()) - days * 86400
                rows = self.store.samples_since(since, device)
                return self._send_json({"device": device, "samples": rows})
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


def make_server(host, port, store, cfg, poller, frontend_dir):
    handler = type("BoundHandler", (Handler,), {
        "store": store, "cfg": cfg, "poller": poller, "frontend_dir": frontend_dir,
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
    status, data = client.register(password)
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
    demo = args.demo
    cfg["_demo"] = demo
    if args.price is not None:
        cfg["price_per_kwh"] = args.price

    if demo:
        seed_demo(store, days=args.demo_days)
        poller = DemoPoller(store, interval=int(cfg.get("poll_interval", 30)))
    else:
        ip = args.ip or cfg.get("shc_ip")
        if not ip:
            sys.exit("Missing SHC IP. Use --ip, set shc_ip in config.json, or run with --demo.")
        if not (os.path.exists(cfg["cert"]) and os.path.exists(cfg["key"])):
            sys.exit("No client certificate found. Run `pair` first (or use --demo).")
        client = SHCClient(ip, cfg["cert"], cfg["key"])
        poller = Poller(client, store, cfg)
    poller.start()

    frontend = args.frontend or DEFAULT_FRONTEND
    httpd = make_server(args.host, args.port, store, cfg, poller, frontend)
    ip_hint = local_ip()
    print("\n  Bosch Home Energy bridge running")
    print(f"  Mode:        {'DEMO' if demo else 'LIVE (' + (args.ip or cfg.get('shc_ip','')) + ')'}")
    print(f"  Open on this machine:  http://localhost:{args.port}/")
    print(f"  Open on your iPhone:   http://{ip_hint}:{args.port}/")
    print("  (iPhone must be on the same Wi-Fi. Press Ctrl+C to stop.)\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping …")
    finally:
        poller.stop()
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
