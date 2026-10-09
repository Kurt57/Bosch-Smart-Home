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
try:
    import electrolux  # optional AEG / Electrolux (washer/dryer) client
except Exception:  # pragma: no cover - keeps the bridge running without it
    electrolux = None
try:
    import spot  # optional day-ahead exchange prices (aWATTar / EPEX)
except Exception:  # pragma: no cover - keeps the bridge running without it
    spot = None
try:
    import pvgis  # optional PV yield lookup by location (EU JRC PVGIS)
except Exception:  # pragma: no cover - keeps the bridge running without it
    pvgis = None
try:
    import weather  # optional weather forecast for PV/heat prognosis (Open-Meteo)
except Exception:  # pragma: no cover - keeps the bridge running without it
    weather = None
try:
    import carbon  # optional grid CO2-intensity model (footprint / greenest hours)
except Exception:  # pragma: no cover - keeps the bridge running without it
    carbon = None
try:
    import tibber  # optional Tibber dynamic-tariff client (real all-in prices)
except Exception:  # pragma: no cover - keeps the bridge running without it
    tibber = None
try:
    import ha_client as ha  # optional Home Assistant REST client (power/energy sensors)
except Exception:  # pragma: no cover - keeps the bridge running without it
    ha = None

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
        # Optional AEG / Electrolux appliances (washer, dryer) via the official
        # developer API – filled in via the web UI.
        "electrolux_api_key": "",
        "electrolux_refresh_token": "",
        "electrolux_interval": 300,    # seconds between appliance polls
        # For models that report no kWh, energy is estimated as wash cycles ×
        # this per-cycle figure (mixed-usage average; tune to your machine).
        "electrolux_kwh_per_cycle": 0.8,
        # Dynamic exchange tariff (day-ahead spot prices). The market price is
        # turned into a consumer price: market × (1+VAT) + surcharge (grid fees,
        # levies, provider margin – all the ct/kWh on top of the raw market).
        "spot_enabled": False,
        "spot_market": "de",           # "de" or "at"
        "spot_surcharge_ct": 15.0,     # ct/kWh added on top of the market price
        "spot_vat": 19.0,              # % VAT applied to the market price
        # Optional Tibber account: a personal read token yields the user's REAL
        # all-in tariff price per hour (overrides the market+surcharge estimate).
        "tibber_token": "",
        # Optional Home Assistant: read power/energy sensors (e.g. a Koogeek plug
        # paired via HA's HomeKit Controller) over HA's REST API.
        "ha_url": "",
        "ha_token": "",
        "ha_entities": "",             # comma-separated entity_ids ("" = auto power/energy)
        # Auto-update: when > 0, the bridge periodically checks the git remote
        # and, if new commits are available, pulls and restarts itself. 0 = off.
        "auto_update_interval": 0,     # minutes between update checks (0 = off)
    }
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                cfg.update({k: v for k, v in json.load(fh).items() if v is not None})
        except (OSError, ValueError) as exc:
            print(f"[config] could not read {path}: {exc}", file=sys.stderr)
    return cfg


# --------------------------------------------------------------------------- #
# Self-update helpers (shared by the manual /api/update tap and the optional
# automatic update loop). Kept dependency-free: plain `git` via subprocess.
# --------------------------------------------------------------------------- #
def _repo_root() -> str:
    return os.path.dirname(HERE)


def _is_git_repo() -> bool:
    return os.path.isdir(os.path.join(_repo_root(), ".git"))


def _git_updates_available() -> bool:
    """True if the upstream branch has commits we don't have yet.

    Fetches quietly, then counts commits in HEAD..@{u}. Never raises – any
    problem (offline, no upstream, git missing) is treated as "nothing to do".
    """
    repo = _repo_root()
    if not _is_git_repo():
        return False
    try:
        subprocess.run(["git", "-C", repo, "fetch", "--quiet"],
                       capture_output=True, text=True, timeout=60)
        out = subprocess.run(["git", "-C", repo, "rev-list", "--count", "HEAD..@{u}"],
                             capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return False
        return int((out.stdout or "0").strip() or "0") > 0
    except Exception:
        return False


_update_status_cache = {"ts": 0.0, "data": None}


def _git_update_status(force: bool = False) -> dict:
    """How many commits behind upstream we are, plus the newest commit subject –
    for the 'update available' banner. Cached ~5 min (a git fetch is a network
    call). Never raises."""
    now = time.time()
    c = _update_status_cache
    if not force and c["data"] is not None and (now - c["ts"]) < 300:
        return c["data"]
    repo = _repo_root()
    res = {"ok": True, "git": _is_git_repo(), "behind": 0, "latest": ""}
    if res["git"]:
        try:
            subprocess.run(["git", "-C", repo, "fetch", "--quiet"],
                           capture_output=True, text=True, timeout=60)
            out = subprocess.run(["git", "-C", repo, "rev-list", "--count", "HEAD..@{u}"],
                                 capture_output=True, text=True, timeout=30)
            if out.returncode == 0:
                res["behind"] = int((out.stdout or "0").strip() or "0")
            if res["behind"] > 0:
                msg = subprocess.run(["git", "-C", repo, "log", "-1", "--format=%s", "@{u}"],
                                     capture_output=True, text=True, timeout=30)
                if msg.returncode == 0:
                    res["latest"] = (msg.stdout or "").strip()[:160]
        except Exception as exc:
            res["ok"] = False
            res["error"] = str(exc)
    c["ts"] = now
    c["data"] = res
    return res


def _git_pull() -> tuple[bool, bool, str]:
    """Fast-forward pull. Returns (ok, changed, log)."""
    repo = _repo_root()
    try:
        out = subprocess.run(["git", "-C", repo, "pull", "--ff-only"],
                             capture_output=True, text=True, timeout=60)
    except Exception as exc:
        return False, False, f"git pull fehlgeschlagen: {exc}"
    log = (out.stdout or "") + (out.stderr or "")
    if out.returncode != 0:
        return False, False, log.strip()
    changed = "Already up to date" not in log and "Bereits aktuell" not in log
    return True, changed, log.strip()


def _schedule_restart(delay: float = 1.2) -> None:
    """Re-exec this process after a short delay so any in-flight HTTP response
    can flush first."""
    def _restart():
        time.sleep(delay)
        try:
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as exc:  # pragma: no cover
            print(f"[update] restart failed: {exc}", file=sys.stderr)
    threading.Thread(target=_restart, daemon=True).start()


_auto_update_thread = None  # module-level guard so only one loop ever runs


def _ensure_auto_update(cfg: dict) -> bool:
    """Start the auto-update loop if the config enables it and it isn't already
    running. Idempotent – safe to call from startup and from the settings save.
    Returns True if the loop is (now) active. Note: changing the interval takes
    full effect after the next restart; toggling on starts it immediately."""
    global _auto_update_thread
    try:
        au = float(cfg.get("auto_update_interval", 0) or 0)
    except (TypeError, ValueError):
        au = 0
    if au <= 0 or not _is_git_repo():
        return False
    if _auto_update_thread and _auto_update_thread.is_alive():
        return True
    _auto_update_thread = threading.Thread(
        target=auto_update_loop, args=(au,), daemon=True)
    _auto_update_thread.start()
    return True


def auto_update_loop(interval_min: float) -> None:
    """Background loop: every `interval_min` minutes, check the git remote and
    pull + restart if there are new commits. Runs only when the config enables
    it. Any error is logged and the loop simply tries again next round."""
    interval = max(60.0, float(interval_min) * 60.0)  # never faster than 1/min
    print(f"[auto-update] enabled, checking every {interval/60:.0f} min", file=sys.stderr)
    while True:
        time.sleep(interval)
        try:
            if not _git_updates_available():
                continue
            ok, changed, log = _git_pull()
            if ok and changed:
                print(f"[auto-update] pulled update, restarting:\n{log}", file=sys.stderr)
                _schedule_restart()
                return  # stop the loop; the new process starts its own
            elif not ok:
                print(f"[auto-update] pull failed: {log}", file=sys.stderr)
        except Exception as exc:  # pragma: no cover
            print(f"[auto-update] check failed: {exc}", file=sys.stderr)


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

    def read_switch(self, device_id: str) -> str | None:
        """Current PowerSwitch state ('ON'/'OFF') for a switchable device, or None."""
        try:
            state = self.get(f"/smarthome/devices/{device_id}/services/PowerSwitch")
        except Exception:
            return None
        if not state:
            return None
        st = state.get("state", state)
        return st.get("switchState")

    def set_switch(self, device_id: str, on: bool) -> str:
        """Switch a device's PowerSwitch ON/OFF. Returns the new state on success."""
        body = json.dumps({"@type": "powerSwitchState",
                           "switchState": "ON" if on else "OFF"}).encode("utf-8")
        status, data = self._request(
            "PUT", 8444,
            f"/smarthome/devices/{device_id}/services/PowerSwitch/state", body=body)
        if status not in (200, 204):
            raise RuntimeError(f"PUT PowerSwitch {device_id} -> HTTP {status}: {data[:200]!r}")
        return "ON" if on else "OFF"

    def list_switchables(self, name_filter: list[str] | None = None) -> list[dict]:
        """Switchable devices (PowerSwitch service) with their current state.
        Reuses list_power_devices' naming/room logic for a consistent label."""
        meter = {d["id"]: d for d in self.list_power_devices(name_filter)}
        devices = self.get("/smarthome/devices") or []
        out = []
        for dev in devices:
            if "PowerSwitch" not in (dev.get("deviceServiceIds") or []):
                continue
            dev_id = dev.get("id")
            info = meter.get(dev_id)              # nice name/room if it's also a meter
            name = (info or {}).get("name") or dev.get("name") or dev_id
            room = (info or {}).get("room") or ""
            out.append({"id": dev_id, "name": name, "room": room,
                        "model": dev.get("deviceModel") or "",
                        "state": self.read_switch(dev_id)})
        out.sort(key=lambda d: (d["room"], d["name"]))
        return out

    def list_climate(self) -> list[dict]:
        """Per-room climate/thermostat snapshot for the heating diagnostics.

        Combines the virtual per-room ``RoomClimateControl`` (setpoint, mode) with
        the physical radiator thermostats' ``ValveTappet`` (valve %), measured
        ``TemperatureLevel`` and ``TemperatureOffset`` – grouped by room. Reads all
        service states in one bulk call where supported, else per device.
        """
        devices = self.get("/smarthome/devices") or []
        rooms = {}
        try:
            raw = self.get("/smarthome/rooms") or []
            if isinstance(raw, dict):
                raw = raw.get("rooms") or raw.get("items") or []
            for r in raw:
                if isinstance(r, dict):
                    rooms[r.get("id")] = r.get("name")
        except Exception:
            pass

        # serviceId -> state, keyed by deviceId. Prefer the bulk endpoint.
        svc = {}
        bulk = None
        try:
            bulk = self.get("/smarthome/services")
        except Exception:
            bulk = None
        if isinstance(bulk, list):
            for s in bulk:
                if not isinstance(s, dict):
                    continue
                did, sid = s.get("deviceId"), s.get("id")
                if did and sid:
                    svc.setdefault(did, {})[sid] = s.get("state") or {}
        else:
            # fall back to one GET per climate service per device
            wanted = {"RoomClimateControl", "TemperatureLevel", "ValveTappet",
                      "TemperatureOffset", "Thermostat", "ChildLock"}
            for dev in devices:
                did = dev.get("id")
                for sid in (dev.get("deviceServiceIds") or []):
                    if sid not in wanted:
                        continue
                    try:
                        st = self.get(f"/smarthome/devices/{did}/services/{sid}")
                    except Exception:
                        continue
                    if isinstance(st, dict):
                        svc.setdefault(did, {})[sid] = st.get("state", st) or {}

        def num(d, *keys):
            for k in keys:
                v = (d or {}).get(k)
                if isinstance(v, (int, float)):
                    return float(v)
            return None

        by_room = {}

        def room_rec(room_id):
            name = rooms.get(room_id) or room_id or "—"
            return by_room.setdefault(room_id or name, {
                "room": name, "setpoint": None, "temp": None, "valve": None,
                "valves": [], "operationMode": None, "roomControlMode": None,
                "boost": False, "summerMode": False, "low": False, "offset": None,
                "childLock": False, "faults": [], "devices": 0})

        for dev in devices:
            did = dev.get("id")
            sids = dev.get("deviceServiceIds") or []
            climate_sids = {"RoomClimateControl", "ValveTappet", "Thermostat"}
            if not (climate_sids & set(sids)) and "TemperatureLevel" not in sids:
                continue
            # a device with only TemperatureLevel and nothing climate-y (e.g. a
            # twinguard) is skipped unless it also controls climate
            if not (climate_sids & set(sids)):
                continue
            rid = dev.get("roomId")
            rec = room_rec(rid)
            rec["devices"] += 1
            st = svc.get(did, {})
            rcc = st.get("RoomClimateControl") or {}
            if rcc:
                sp = num(rcc, "setpointTemperature")
                if sp is not None:
                    rec["setpoint"] = sp
                rec["operationMode"] = rcc.get("operationMode") or rec["operationMode"]
                rec["roomControlMode"] = rcc.get("roomControlMode") or rec["roomControlMode"]
                rec["boost"] = bool(rcc.get("boostMode")) or rec["boost"]
                rec["summerMode"] = bool(rcc.get("summerMode")) or rec["summerMode"]
                rec["low"] = bool(rcc.get("low")) or rec["low"]
            tl = num(st.get("TemperatureLevel") or {}, "temperature")
            if tl is not None:
                # prefer the room-control device's reading; else take any
                if rec["temp"] is None or "RoomClimateControl" in st:
                    rec["temp"] = tl
            vt = num(st.get("ValveTappet") or {}, "position", "value")
            if vt is not None:
                rec["valves"].append(int(round(vt)))
            off = num(st.get("TemperatureOffset") or {}, "offset")
            if off is not None and abs(off) > abs(rec["offset"] or 0):
                rec["offset"] = off
            cl = st.get("ChildLock") or {}
            if (cl.get("childLock") or cl.get("childLockState")) in ("ON", True, "on"):
                rec["childLock"] = True
            for f in (dev.get("faults") or []):
                fs = f.get("type") if isinstance(f, dict) else str(f)
                if fs and fs not in rec["faults"]:
                    rec["faults"].append(fs)

        out = []
        for rec in by_room.values():
            if rec["valves"]:
                rec["valve"] = max(rec["valves"])   # the most-open valve drives flow demand
            out.append(rec)
        out.sort(key=lambda r: r["room"])
        return out


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
            # supply_c/return_c let the heating-curve analysis build up over time
            for col in ("heat_kwh", "heat_w", "supply_c", "return_c"):
                if col not in hpcols:
                    self.conn.execute(f"ALTER TABLE hp_samples ADD COLUMN {col} REAL")
            if "mode" not in hpcols:
                self.conn.execute("ALTER TABLE hp_samples ADD COLUMN mode TEXT")
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_hp ON hp_samples(ts)"
            )
            # imported heat-pump history (from a HomeCom CSV export): real
            # per-day and per-month energy, split into heating / hot water.
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS hp_history("
                " period TEXT, date TEXT, elec_kwh REAL, heat_kwh REAL,"
                " heating_kwh REAL, water_kwh REAL, outdoor_c REAL,"
                " PRIMARY KEY(period,date))"
            )
            # heating-curve points from an imported CSV: flow temp vs. outdoor
            # during SPACE HEATING hours (the CSV exposes Vorlauftemperatur hourly).
            # Separate from hp_samples so energy/COP analytics stay untouched.
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS hp_curve("
                " ts INTEGER PRIMARY KEY, outdoor_c REAL, supply_c REAL)"
            )
            # AEG / Electrolux appliances (washer, dryer, …) and their readings
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS aeg_appliances("
                " id TEXT PRIMARY KEY, name TEXT, type TEXT, brand TEXT,"
                " model TEXT, last_seen INTEGER)"
            )
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS aeg_samples("
                " appliance_id TEXT, ts INTEGER, total_kwh REAL, cycle_kwh REAL,"
                " state TEXT, program TEXT, cycles INTEGER, estimated INTEGER)"
            )
            aegcols = [r[1] for r in self.conn.execute("PRAGMA table_info(aeg_samples)")]
            for col, typ in (("cycles", "INTEGER"), ("estimated", "INTEGER")):
                if col not in aegcols:
                    self.conn.execute(f"ALTER TABLE aeg_samples ADD COLUMN {col} {typ}")
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_aeg ON aeg_samples(appliance_id, ts)"
            )
            # manual whole-house meter readings (total kWh incl. heat pump) –
            # a ground-truth anchor for calibrating totals and forecasts.
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS meter_readings("
                " ts INTEGER PRIMARY KEY, kwh REAL, note TEXT)"
            )
            # cached day-ahead exchange market prices (ct/kWh) per hour
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS spot_prices("
                " ts INTEGER PRIMARY KEY, market_ct REAL)"
            )

    # -- heat pump ------------------------------------------------------- #
    def add_hp_sample(self, row: dict):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO hp_samples(gateway,ts,energy_kwh,power_w,thermal_kw,"
                "modulation,outdoor_c,heat_kwh,heat_w,mode,supply_c,return_c)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (row.get("gateway"), row["ts"], row.get("energy_kwh"), row.get("power_w"),
                 row.get("thermal_kw"), row.get("modulation"), row.get("outdoor_c"),
                 row.get("heat_kwh"), row.get("heat_w"), row.get("mode"),
                 row.get("supply_c"), row.get("return_c")),
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
        outdoor_c,heat_kwh,heat_w,mode,supply_c,return_c) tuples – demo seeder."""
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO hp_samples(gateway,ts,energy_kwh,power_w,thermal_kw,"
                "modulation,outdoor_c,heat_kwh,heat_w,mode,supply_c,return_c)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    def hp_samples_since(self, since_ts: int) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT * FROM hp_samples WHERE ts>=? ORDER BY ts ASC", (since_ts,))
            return [dict(r) for r in cur.fetchall()]

    def hp_count(self) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) AS c FROM hp_samples").fetchone()["c"]

    def hp_history(self, period: str) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT * FROM hp_history WHERE period=? ORDER BY date", (period,))
            return [dict(r) for r in cur.fetchall()]

    def hp_history_upsert(self, rows: list[tuple]) -> int:
        """rows: (period,date,elec,heat,heating,water,outdoor). Replace on conflict."""
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO hp_history(period,date,elec_kwh,heat_kwh,heating_kwh,water_kwh,outdoor_c)"
                " VALUES(?,?,?,?,?,?,?) ON CONFLICT(period,date) DO UPDATE SET"
                " elec_kwh=excluded.elec_kwh, heat_kwh=excluded.heat_kwh,"
                " heating_kwh=excluded.heating_kwh, water_kwh=excluded.water_kwh,"
                " outdoor_c=excluded.outdoor_c", rows)
        return len(rows)

    def hp_history_count(self) -> dict:
        with self.lock:
            d = self.conn.execute("SELECT COUNT(*) c FROM hp_history WHERE period='day'").fetchone()["c"]
            m = self.conn.execute("SELECT COUNT(*) c FROM hp_history WHERE period='month'").fetchone()["c"]
            hh = self.conn.execute("SELECT COUNT(*) c FROM hp_history WHERE period='hour'").fetchone()["c"]
            return {"days": d, "months": m, "hours": hh}

    def hp_history_clear(self) -> int:
        """Remove ALL imported heat-pump history (CSV). Returns rows deleted."""
        with self.lock, self.conn:
            cur = self.conn.execute("DELETE FROM hp_history")
            n = cur.rowcount or 0
            cur2 = self.conn.execute("DELETE FROM hp_curve")   # CSV curve points too
            return n + (cur2.rowcount or 0)

    # -- heating-curve points from CSV (flow temp vs. outdoor) ----------- #
    def hp_curve_upsert(self, rows: list[tuple]) -> int:
        """rows: (ts, outdoor_c, supply_c). Replace on timestamp conflict."""
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO hp_curve(ts,outdoor_c,supply_c) VALUES(?,?,?)"
                " ON CONFLICT(ts) DO UPDATE SET outdoor_c=excluded.outdoor_c,"
                " supply_c=excluded.supply_c", rows)
        return len(rows)

    def hp_curve_since(self, since_ts: int) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT ts,outdoor_c,supply_c FROM hp_curve WHERE ts>=? ORDER BY ts ASC",
                (since_ts,))
            return [dict(r) for r in cur.fetchall()]

    def hp_curve_count(self) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) c FROM hp_curve").fetchone()["c"]

    # -- AEG / Electrolux appliances ------------------------------------- #
    def aeg_upsert_appliance(self, a: dict):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO aeg_appliances(id,name,type,brand,model,last_seen)"
                " VALUES(?,?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type,"
                " brand=COALESCE(excluded.brand,aeg_appliances.brand),"
                " model=COALESCE(excluded.model,aeg_appliances.model),"
                " last_seen=excluded.last_seen",
                (a["id"], a.get("name"), a.get("type"), a.get("brand"),
                 a.get("model"), int(time.time())))

    def aeg_add_sample(self, appliance_id: str, ts: int, total_kwh, cycle_kwh,
                       state, program, cycles=None, estimated=False):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO aeg_samples(appliance_id,ts,total_kwh,cycle_kwh,state,"
                "program,cycles,estimated) VALUES(?,?,?,?,?,?,?,?)",
                (appliance_id, ts, total_kwh, cycle_kwh, state, program,
                 cycles, 1 if estimated else 0))

    def aeg_appliances(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT id,name,type,brand,model,last_seen FROM aeg_appliances"
                " ORDER BY name").fetchall()
        return [dict(r) for r in rows]

    def aeg_latest(self, appliance_id: str) -> dict | None:
        with self.lock:
            r = self.conn.execute(
                "SELECT ts,total_kwh,cycle_kwh,state,program,cycles,estimated"
                " FROM aeg_samples WHERE appliance_id=? ORDER BY ts DESC LIMIT 1",
                (appliance_id,)).fetchone()
        return dict(r) if r else None

    def aeg_total_since(self, appliance_id: str, since_ts: int):
        """kWh consumed since `since_ts` from the cumulative counter growth
        (robust to polling gaps): last value minus the first value at/after
        `since_ts`; falls back to the last value before it as the baseline."""
        with self.lock:
            base = self.conn.execute(
                "SELECT total_kwh FROM aeg_samples WHERE appliance_id=?"
                " AND total_kwh IS NOT NULL AND ts<=? ORDER BY ts DESC LIMIT 1",
                (appliance_id, since_ts)).fetchone()
            if not base:
                base = self.conn.execute(
                    "SELECT total_kwh FROM aeg_samples WHERE appliance_id=?"
                    " AND total_kwh IS NOT NULL AND ts>=? ORDER BY ts ASC LIMIT 1",
                    (appliance_id, since_ts)).fetchone()
            last = self.conn.execute(
                "SELECT total_kwh FROM aeg_samples WHERE appliance_id=?"
                " AND total_kwh IS NOT NULL ORDER BY ts DESC LIMIT 1",
                (appliance_id,)).fetchone()
        if not base or not last or last["total_kwh"] is None or base["total_kwh"] is None:
            return None
        d = last["total_kwh"] - base["total_kwh"]
        return round(d, 3) if d >= 0 else None

    # -- manual whole-house meter readings ------------------------------- #
    def meter_upsert(self, ts: int, kwh: float, note: str = ""):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO meter_readings(ts,kwh,note) VALUES(?,?,?)"
                " ON CONFLICT(ts) DO UPDATE SET kwh=excluded.kwh, note=excluded.note",
                (int(ts), float(kwh), note or ""))

    def meter_list(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT ts,kwh,note FROM meter_readings ORDER BY ts ASC").fetchall()
        return [dict(r) for r in rows]

    def meter_delete(self, ts: int):
        with self.lock, self.conn:
            self.conn.execute("DELETE FROM meter_readings WHERE ts=?", (int(ts),))

    # -- day-ahead exchange prices --------------------------------------- #
    def spot_upsert(self, rows: list[tuple]):
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO spot_prices(ts,market_ct) VALUES(?,?)"
                " ON CONFLICT(ts) DO UPDATE SET market_ct=excluded.market_ct",
                [(int(ts), float(ct)) for ts, ct in rows])

    def spot_range(self, ts_from: int, ts_to: int) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT ts,market_ct FROM spot_prices WHERE ts>=? AND ts<=? ORDER BY ts ASC",
                (int(ts_from), int(ts_to))).fetchall()
        return [dict(r) for r in rows]

    def spot_max_ts(self) -> int | None:
        with self.lock:
            r = self.conn.execute("SELECT MAX(ts) m FROM spot_prices").fetchone()
        return r["m"] if r and r["m"] is not None else None

    def spot_stats(self, days: int = 90) -> dict:
        """Average stored market price (ct/kWh) over the last `days`, plus how
        many hours of history that covers – the basis for a realistic annual mean."""
        since = int(time.time()) - days * 86400
        with self.lock:
            r = self.conn.execute(
                "SELECT AVG(market_ct) a, COUNT(*) c FROM spot_prices WHERE ts>=?",
                (since,)).fetchone()
        return {"avg_market_ct": r["a"], "hours": r["c"] or 0}

    def spot_month_hour(self, days: int = 400) -> dict:
        """Average market price (ct/kWh) bucketed by (month 0-11, hour 0-23) over
        the stored history – the basis for a load-weighted, seasonal cost."""
        since = int(time.time()) - days * 86400
        with self.lock:
            rows = self.conn.execute(
                "SELECT ts, market_ct FROM spot_prices WHERE ts>=?", (since,)).fetchall()
        acc = [[[0.0, 0] for _ in range(24)] for _ in range(12)]     # [sum, count]
        for r in rows:
            lt = time.localtime(r["ts"])
            cell = acc[lt.tm_mon - 1][lt.tm_hour]
            cell[0] += r["market_ct"]; cell[1] += 1
        grid = [[round(c[0] / c[1], 3) if c[1] else None for c in mrow] for mrow in acc]
        month_avg = []
        for mrow in acc:
            s = sum(c[0] for c in mrow); n = sum(c[1] for c in mrow)
            month_avg.append(round(s / n, 3) if n else None)
        return {"grid": grid, "month_avg": month_avg, "hours": len(rows)}

    def hp_counter_span(self) -> dict | None:
        """First and last cumulative counters over the whole observed history –
        gives a robust daily average even across polling gaps."""
        with self.lock:
            first = self.conn.execute(
                "SELECT ts,energy_kwh,heat_kwh FROM hp_samples WHERE energy_kwh IS NOT NULL"
                " ORDER BY ts ASC LIMIT 1").fetchone()
            last = self.conn.execute(
                "SELECT ts,energy_kwh,heat_kwh FROM hp_samples WHERE energy_kwh IS NOT NULL"
                " ORDER BY ts DESC LIMIT 1").fetchone()
        if not first or not last or last["ts"] <= first["ts"]:
            return None
        return {"first_ts": first["ts"], "last_ts": last["ts"],
                "first_e": first["energy_kwh"], "last_e": last["energy_kwh"],
                "first_h": first["heat_kwh"], "last_h": last["heat_kwh"]}

    def samples_span(self) -> dict | None:
        """Per-device first/last cumulative energy counters + observed span (s),
        for a meter-based average when no install date is reported."""
        with self.lock:
            rows = self.conn.execute(
                "SELECT device_id, MIN(ts) AS t0, MAX(ts) AS t1 FROM samples GROUP BY device_id"
            ).fetchall()
            if not rows:
                return None
            growth = 0.0
            t0 = min(r["t0"] for r in rows)
            t1 = max(r["t1"] for r in rows)
            for r in rows:
                a = self.conn.execute(
                    "SELECT energy_wh FROM samples WHERE device_id=? ORDER BY ts ASC LIMIT 1",
                    (r["device_id"],)).fetchone()
                b = self.conn.execute(
                    "SELECT energy_wh FROM samples WHERE device_id=? ORDER BY ts DESC LIMIT 1",
                    (r["device_id"],)).fetchone()
                if a and b and b["energy_wh"] >= a["energy_wh"]:
                    growth += b["energy_wh"] - a["energy_wh"]
        if t1 <= t0:
            return None
        return {"t0": t0, "t1": t1, "growth_wh": growth}

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
    dev_hour: dict[str, list[list[float]]] = {}   # id -> 24 lists of power

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
        # hourly / weekday average power profile (overall + per device)
        dh = dev_hour.setdefault(dev_id, [[] for _ in range(24)])
        for s in samples:
            dt = datetime.fromtimestamp(s["ts"])
            hour_power[dt.hour].append(s["power_w"])
            hw_power.setdefault((dt.weekday(), dt.hour), []).append(s["power_w"])
            dh[dt.hour].append(s["power_w"])

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
    per_device_hour = {dev_id: [round(sum(v) / len(v), 2) if v else 0.0 for v in dh]
                       for dev_id, dh in dev_hour.items()}
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
            "since": earliest, "since_days": round(since_days, 1),
            "total_kwh": round(total_energy_kwh, 3), "avg_daily_kwh": round(c_avg, 3),
            "year_estimate_kwh": round(c_avg * 365, 1),
            "year_estimate_cost": round(c_avg * 365 * price, 2),
            "month_estimate_kwh": round(c_avg * 30.4, 2), "basis": "install",
        }
    else:
        # no install date reported → use the meter growth over the observed span
        span = store.samples_span()
        if span and span["growth_wh"] > 0:
            span_days = max(0.5, (span["t1"] - span["t0"]) / 86400.0)
            c_avg = span["growth_wh"] / 1000.0 / span_days
            counter = {
                "since": span["t0"], "since_days": round(span_days, 1),
                "total_kwh": round(span["growth_wh"] / 1000.0, 3), "avg_daily_kwh": round(c_avg, 3),
                "year_estimate_kwh": round(c_avg * 365, 1),
                "year_estimate_cost": round(c_avg * 365 * price, 2),
                "month_estimate_kwh": round(c_avg * 30.4, 2), "basis": "observed",
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
        "per_device_hour": per_device_hour,
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

    Each consecutive counter delta is spread across the local days it spans
    (proportional to time), so energy split across midnight lands on the right
    day AND an offline gap is *backfilled* when the heat pump reconnects: the
    cumulative counter kept counting while we couldn't reach it, so the jump on
    reconnect is real consumption, not lost. Resets/implausible jumps are
    filtered by average power, not by a hard time cutoff.
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
            # plausible growth: positive, average power within a heat pump's
            # range (drops counter resets), gap up to ~31 days so a real offline
            # stretch is recovered rather than discarded.
            if delta > 0 and 0 < dt_h <= 24 * 31 and (delta / dt_h) <= 25:
                _spread_delta_over_days(out, pt, s["ts"], delta)
        prev = (s["ts"], v)
    return out


def _spread_delta_over_days(out: dict, pt: int, ts: int, delta: float):
    """Add `delta` kWh to `out`, split across the local calendar days spanned by
    [pt, ts] proportional to the time in each day (DST-aware via localtime)."""
    total = ts - pt
    if total <= 0:
        out[_local_day(pt)] = out.get(_local_day(pt), 0.0) + delta
        return
    seg_start = pt
    guard = 0
    while seg_start < ts and guard < 400:
        guard += 1
        lt = time.localtime(seg_start)
        day0 = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)))
        # next local midnight, recomputed from a point safely inside the next day
        nlt = time.localtime(day0 + 86400 + 7200)
        next_mid = int(time.mktime((nlt.tm_year, nlt.tm_mon, nlt.tm_mday, 0, 0, 0, 0, 0, -1)))
        seg_end = min(next_mid, ts)
        day = _local_day(seg_start)
        out[day] = out.get(day, 0.0) + delta * (seg_end - seg_start) / total
        seg_start = seg_end


def _hp_mode_buckets(rows: list[dict], only_day: str | None = None) -> dict:
    """Electrical kWh attributed to the operating mode (Heizung/Warmwasser/Sonstiges)
    by consecutive counter deltas – the heat pump's own 'wofür'."""
    b = {"heating": 0.0, "water": 0.0, "other": 0.0}
    prev = None
    for s in rows:
        v = s.get("energy_kwh")
        if v is None:
            continue
        if prev is not None:
            pv, pt, pm, pp = prev
            delta = v - pv
            dt_h = (s["ts"] - pt) / 3600.0
            # same plausibility as the day-splitter, so the mode split covers the
            # SAME energy as 'Strom heute' (no undercounting after an outage).
            if delta > 0 and 0 < dt_h <= 24 * 31 and (delta / dt_h) <= 25:
                # attribute the interval to the mode that was actually running
                # (higher power), so an off→on transition counts as the active mode
                m = pm if (pp or 0) >= (s.get("power_w") or 0) else s.get("mode")
                key = "heating" if m == "ch" else "water" if m == "dhw" else "other"
                if only_day is None:
                    b[key] += delta
                else:
                    # only the share of [pt, ts] that falls on `only_day`
                    frac = {}
                    _spread_delta_over_days(frac, pt, s["ts"], 1.0)
                    b[key] += delta * frac.get(only_day, 0.0)
        prev = (v, s["ts"], s.get("mode"), s.get("power_w"))
    return {k: round(x, 3) for k, x in b.items()}


def _hp_cop_by_temp(rows: list[dict]) -> list[dict]:
    """Seasonal-performance curve: COP grouped into 5 °C outdoor-temperature bins."""
    bins: dict[int, list] = {}
    prev = None
    for s in rows:
        e, h, o = s.get("energy_kwh"), s.get("heat_kwh"), s.get("outdoor_c")
        if e is None or h is None or o is None:
            prev = None
            continue
        if prev is not None:
            de, dh, dt = e - prev[0], h - prev[1], s["ts"] - prev[2]
            if 0 < de < 100 and 0 <= dh < 300 and 0 < dt < 86400:
                key = int(math.floor(prev[3] / 5.0) * 5)
                bins.setdefault(key, [0.0, 0.0])
                bins[key][0] += de
                bins[key][1] += dh
        prev = (e, h, s["ts"], o)
    return [{"temp": k, "cop": round(v[1] / v[0], 2), "kwh": round(v[0], 1)}
            for k, v in sorted(bins.items()) if v[0] > 0.5 and v[1] > 0]


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

    # hourly electrical-power profile + 7x24 heatmap (W), plus per-month heatmaps
    hour_power = {h: [] for h in range(24)}
    hw_power: dict[tuple[int, int], list[float]] = {}
    hw_month: dict[str, dict[tuple[int, int], list[float]]] = {}
    outdoor_hour = {h: [] for h in range(24)}
    for s in rows:
        if s.get("power_w") is None:
            continue
        dt = datetime.fromtimestamp(s["ts"])
        hour_power[dt.hour].append(s["power_w"])
        hw_power.setdefault((dt.weekday(), dt.hour), []).append(s["power_w"])
        hw_month.setdefault(dt.strftime("%Y-%m"), {}).setdefault(
            (dt.weekday(), dt.hour), []).append(s["power_w"])
        if s.get("outdoor_c") is not None:
            outdoor_hour[dt.hour].append(s["outdoor_c"])
    hourly_profile = [{"hour": h,
                       "avg_w": round(sum(v) / len(v), 1) if v else 0.0,
                       "avg_outdoor": round(sum(outdoor_hour[h]) / len(outdoor_hour[h]), 1)
                       if outdoor_hour[h] else None}
                      for h, v in hour_power.items()]

    # fold in imported hourly history (from a HomeCom CSV) – kWh in one hour
    # equals the average power in kW, so × 1000 gives the hour's average watts.
    hour_he = {h: [0.0, 0.0] for h in range(24)}   # per hour-of-day: [elec, heat]
    hour_water = {h: 0.0 for h in range(24)}
    imp_hour_rows = store.hp_history("hour")
    for r in imp_hour_rows:
        e = r.get("elec_kwh")
        if e is None:
            continue
        try:
            dt = datetime.fromisoformat(r["date"])
        except (ValueError, TypeError):
            continue
        pw = e * 1000.0
        hw_power.setdefault((dt.weekday(), dt.hour), []).append(pw)
        hw_month.setdefault(dt.strftime("%Y-%m"), {}).setdefault(
            (dt.weekday(), dt.hour), []).append(pw)
        hour_he[dt.hour][0] += e
        if r.get("heat_kwh") is not None:
            hour_he[dt.hour][1] += r["heat_kwh"]
        if r.get("water_kwh") is not None:
            hour_water[dt.hour] += r["water_kwh"]

    def _grid(hw):
        return [[round(sum(hw.get((wd, h), [])) / len(hw[(wd, h)]), 1)
                 if hw.get((wd, h)) else 0.0 for h in range(24)] for wd in range(7)]
    heatmap = _grid(hw_power)
    heatmap_monthly = {m: _grid(hw_month[m]) for m in sorted(hw_month)}

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

    # robust daily average: trim first/last partial day only when we have enough
    complete = daily[1:-1] if len(daily) > 3 else daily
    e_vals = [d["elec_kwh"] for d in complete if d["elec_kwh"] > 0] or \
        [d["elec_kwh"] for d in daily if d["elec_kwh"] > 0] or [0.0]
    avg_e = sum(e_vals) / len(e_vals)
    tot_e = sum(elec_day.values())
    tot_h = sum(heat_day.values())

    mode_today = _hp_mode_buckets(rows, only_day=today)
    mode_window = _hp_mode_buckets(rows)
    cop_by_temp = _hp_cop_by_temp(rows)

    # meter-based average over the whole observed history (robust to polling
    # gaps – the cumulative counter captures energy used while we weren't looking)
    span = store.hp_counter_span()
    counter = None
    if span:
        span_days = max(0.5, (span["last_ts"] - span["first_ts"]) / 86400.0)
        e_growth = span["last_e"] - span["first_e"]
        h_growth = (span["last_h"] - span["first_h"]) \
            if span["first_h"] is not None and span["last_h"] is not None else None
        if e_growth >= 0:
            counter = {
                "span_days": round(span_days, 1),
                "elec_growth_kwh": round(e_growth, 1),
                "heat_growth_kwh": round(h_growth, 1) if h_growth is not None and h_growth >= 0 else None,
                "avg_daily_elec_kwh": round(e_growth / span_days, 3),
                "avg_daily_heat_kwh": round(h_growth / span_days, 3)
                if h_growth is not None and h_growth >= 0 else None,
                "observed_months": sorted({datetime.fromtimestamp(t).strftime("%Y-%m")
                                           for t in (span["first_ts"], span["last_ts"])}),
            }

    # --- imported HomeCom-CSV history (real day/month data) ----------------- #
    since_day = _local_day(since)
    imp_days = [r for r in store.hp_history("day") if r.get("elec_kwh") is not None]
    imp_months = [r for r in store.hp_history("month") if r.get("elec_kwh") is not None]
    imported = None
    if imp_days:
        # overlay real days onto the polled daily series (within the window)
        dd = {d["day"]: d for d in daily}
        for r in imp_days:
            if r["date"] >= since_day:
                e = round(r["elec_kwh"] or 0.0, 3)
                h = round(r["heat_kwh"] or 0.0, 3)
                dd[r["date"]] = {"day": r["date"], "elec_kwh": e, "heat_kwh": h,
                                 "cop": round(h / e, 2) if e > 0 else None,
                                 "cost": round(e * price, 2)}
        daily = [dd[k] for k in sorted(dd)]
        # real 'wofür' from the heating/water split, over the window
        win = [r for r in imp_days if r["date"] >= since_day]
        if win and any(r.get("heating_kwh") is not None for r in win):
            heating = sum(r.get("heating_kwh") or 0.0 for r in win)
            water = sum(r.get("water_kwh") or 0.0 for r in win)
            elec_sum = sum(r.get("elec_kwh") or 0.0 for r in win)
            mode_window = {"heating": round(heating, 3), "water": round(water, 3),
                           "other": round(max(0.0, elec_sum - heating - water), 3)}
        trow = next((r for r in imp_days if r["date"] == today), None)
        if trow and trow.get("heating_kwh") is not None:
            mode_today = {"heating": round(trow.get("heating_kwh") or 0.0, 3),
                          "water": round(trow.get("water_kwh") or 0.0, 3),
                          "other": round(max(0.0, (trow.get("elec_kwh") or 0.0)
                                             - (trow.get("heating_kwh") or 0.0)
                                             - (trow.get("water_kwh") or 0.0)), 3)}
    if imp_months:
        # prefer the real monthly figures for the monthly chart
        monthly = [{"month": r["date"], "elec_kwh": round(r["elec_kwh"] or 0.0, 1),
                    "heat_kwh": round(r["heat_kwh"] or 0.0, 1),
                    "cop": round((r["heat_kwh"] or 0.0) / (r["elec_kwh"] or 1.0), 2)
                    if (r["elec_kwh"] or 0.0) > 0 else None} for r in imp_months]
        last12 = imp_months[-12:]
        year_e = sum(r["elec_kwh"] or 0.0 for r in last12)
        year_h = sum(r["heat_kwh"] or 0.0 for r in last12)
        imported = {
            "months": len(imp_months), "months_used": len(last12),
            "days": len(imp_days),
            "year_elec_kwh": round(year_e, 0), "year_heat_kwh": round(year_h, 0),
            "seasonal_cop": round(year_h / year_e, 2) if year_e > 0 else None,
            "latest": imp_months[-1]["date"],
            "monthly": [{"month": r["date"], "elec_kwh": round(r["elec_kwh"] or 0.0, 1),
                         "heat_kwh": round(r["heat_kwh"] or 0.0, 1)} for r in imp_months],
            "daily": [{"date": r["date"], "elec_kwh": round(r["elec_kwh"] or 0.0, 2),
                       "cop": round((r["heat_kwh"] or 0.0) / r["elec_kwh"], 2)
                       if (r["elec_kwh"] or 0.0) > 0 else None} for r in imp_days],
            "hours": len(imp_hour_rows),
            "cop_by_hour": [{"hour": h,
                             "cop": round(hour_he[h][1] / hour_he[h][0], 2)
                             if hour_he[h][0] > 0.05 and hour_he[h][1] > 0.05 else None,
                             "water_kwh": round(hour_water[h], 2)} for h in range(24)]
            if any(hour_he[h][0] > 0 for h in range(24)) else [],
        }
    elif imp_days:
        imported = {"months": 0, "months_used": 0, "days": len(imp_days),
                    "year_elec_kwh": None, "year_heat_kwh": None, "seasonal_cop": None,
                    "latest": imp_days[-1]["date"], "monthly": []}

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
        "mode_today": mode_today,
        "mode_window": mode_window,
        "cop_by_temp": cop_by_temp,
        "counter": counter,
        "imported": imported,
        "daily": daily,
        "monthly": monthly,
        "hourly_profile": hourly_profile,
        "heatmap": heatmap,
        "heatmap_monthly": heatmap_monthly,
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


def _ideal_flow(outdoor: float) -> float:
    """WP-friendly target flow temperature for an outdoor temp (underfloor-ish).
    Low and flat – every +1 K flow costs ~2–3 % efficiency."""
    return max(28.0, min(45.0, 30.0 + (18.0 - outdoor) * 0.45))


def hp_cycle_stats(samples: list[dict]) -> dict | None:
    """Real cycling from the stored mode/modulation sequence: compressor starts
    per day and average run length. 'running' = heating/hot-water or load > 0."""
    seq = [s for s in samples if s.get("ts")]
    if len(seq) < 10:
        return None
    seq.sort(key=lambda s: s["ts"])
    def running(s):
        m = (s.get("mode") or "").lower()
        return m in ("ch", "heating", "heat", "dhw") or (s.get("modulation") or 0) > 0
    starts = 0
    run_s = 0.0
    prev = None
    prev_run = False
    for s in seq:
        r = running(s)
        if prev is not None:
            dt = s["ts"] - prev["ts"]
            if 0 < dt <= 1800 and prev_run:       # accumulate run time (cap gaps)
                run_s += dt
            if r and not prev_run:
                starts += 1
        elif r:
            starts += 1
        prev, prev_run = s, r
    span_days = max(0.5, (seq[-1]["ts"] - seq[0]["ts"]) / 86400.0)
    per_day = starts / span_days
    run_min = (run_s / 60.0 / starts) if starts else None
    return {"days": round(span_days, 1), "starts": starts,
            "per_day": round(per_day, 1),
            "avg_run_min": round(run_min) if run_min else None}


IDEAL_SLOPE = -0.45   # °C flow per °C outdoor (= 4,5 K Vorlauf je 10 K kälter)


def compute_heating_curve(store: "Store", days: int = 30, hp_live: dict | None = None) -> dict:
    """The REAL heating curve: flow temperature vs. outdoor temperature from the
    stored samples + the current operating point, a fitted (or provisional) line,
    the WP-friendly target band, and a CONCRETE recommendation (Niveau/Steilheit).

    Historic CSV/energy data has no flow temperature, so the curve builds from the
    flow/return we log from now on – plus the live snapshot, so a first
    recommendation is possible immediately instead of waiting days."""
    since = int(time.time()) - days * 86400
    rows = store.hp_samples_since(since)
    pts = []
    for s in rows:
        o, sup = s.get("outdoor_c"), s.get("supply_c")
        m = (s.get("mode") or "").lower()
        heating = m in ("ch", "heating", "heat")
        if o is None or sup is None or sup < 20 or not heating:
            continue
        if (s.get("modulation") or 0) <= 0:
            continue
        pts.append((round(float(o), 1), round(float(sup), 1)))
    # historical heating-curve points imported from a HomeCom CSV (flow temp vs.
    # outdoor during space-heating hours) – make the curve usable immediately.
    csv_rows = store.hp_curve_since(since)
    for s in csv_rows:
        o, sup = s.get("outdoor_c"), s.get("supply_c")
        if o is not None and sup is not None and sup >= 20:
            pts.append((round(float(o), 1), round(float(sup), 1)))
    n_csv = len(csv_rows)
    # add the live operating point (counts immediately, before history fills up)
    live_pt = None
    if hp_live:
        lo, ls = hp_live.get("outdoor_c"), hp_live.get("supply_c")
        lm = (hp_live.get("mode") or "").lower()
        if lo is not None and ls is not None and ls >= 20 and lm in ("ch", "heating", "heat") \
                and (hp_live.get("modulation") or 0) > 0:
            live_pt = (round(float(lo), 1), round(float(ls), 1))
            pts.append(live_pt)
    n = len(pts)
    cyc = hp_cycle_stats(rows)
    if n == 0:
        return {"ok": True, "enough": False, "n": 0, "points": [], "cycles": cyc,
                "csv_points": 0,
                "note": "Noch keine Heizpunkte. Entweder heizt die Wärmepumpe gerade nicht, oder "
                        "importiere im Setup deinen HomeCom-CSV-Export – er enthält stündlich "
                        "Vorlauf- und Außentemperatur, daraus baue ich die Kurve sofort."}

    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    span = max(xs) - min(xs)
    full_fit = n >= 10 and span >= 5
    if full_fit:
        mx = sum(xs) / n; my = sum(ys) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
        a = (sxy / sxx) if sxx > 1e-6 else IDEAL_SLOPE
        b = my - a * mx
        basis = "fit"
    else:
        # too few points / too little outdoor spread to trust a slope → assume the
        # standard steepness and only estimate the LEVEL (parallel offset).
        a = IDEAL_SLOPE
        offs = [ys[i] - _ideal_flow(xs[i]) for i in range(n)]
        b = (sum(offs) / n) + _ideal_flow(0.0)      # ideal(0)=b_ideal; shift by mean offset
        basis = "provisional"

    xmin = max(-15.0, min(min(xs), -7.0)); xmax = min(18.0, max(max(xs), 12.0))
    if xmax - xmin < 6:
        xmin, xmax = xmin - 3, xmax + 3
    sample_x = [xmin + (xmax - xmin) * k / 6 for k in range(7)]
    over_k = round(sum((a * x + b) - _ideal_flow(x) for x in sample_x) / len(sample_x), 1)

    # slope expressed as "K Vorlauf je 10 K kälter" (positive number)
    slope_act10 = round(abs(a) * 10, 1)
    slope_ideal10 = round(abs(IDEAL_SLOPE) * 10, 1)
    steil = None
    if full_fit:
        if slope_act10 >= slope_ideal10 + 1.5:
            steil = "flacher"      # too steep (rises too much towards cold)
        elif slope_act10 <= slope_ideal10 - 1.5:
            steil = "steiler"
        else:
            steil = "ok"

    if over_k >= 6:
        verdict = "Heizkurve deutlich zu hoch – klares Sparpotenzial."
    elif over_k >= 3:
        verdict = "Heizkurve etwas zu hoch – Spielraum nach unten."
    elif over_k <= -3:
        verdict = "Heizkurve sehr niedrig – prüfen, ob alle Räume warm werden."
    else:
        verdict = "Heizkurve WP-freundlich eingestellt."
    saving_pct = round(min(0.18, max(0.0, over_k) * 0.025), 3)

    # concrete recommendation
    niveau = round(over_k)                    # lower the whole curve by this many K
    rec = {"basis": basis, "niveau_k": niveau,
           "slope_act10": slope_act10, "slope_ideal10": slope_ideal10, "steil": steil}
    parts = []
    if niveau >= 2:
        parts.append(f"<b>Niveau / Parallelverschiebung um ca. −{niveau} K</b> senken "
                     f"(die ganze Kurve bzw. den Vorlauf-Soll um {niveau} K runter)")
    elif niveau <= -2:
        parts.append(f"<b>Niveau um ca. +{abs(niveau)} K</b> anheben – die Räume könnten sonst "
                     f"zu kühl werden")
    else:
        parts.append("das <b>Niveau</b> passt bereits gut")
    if steil == "flacher":
        parts.append(f"die <b>Steilheit/Gradient etwas flacher</b> stellen "
                     f"(aktuell ~{slope_act10} K je 10 K kälter, Ziel ~{slope_ideal10})")
    elif steil == "steiler":
        parts.append(f"die <b>Steilheit etwas steiler</b> stellen "
                     f"(aktuell ~{slope_act10}, Ziel ~{slope_ideal10} K je 10 K kälter)")
    rec["text"] = " und ".join(parts) + "."
    rec["howto"] = ("In kleinen Schritten (2–3 K bzw. eine Stufe), dann 1–2 Tage beobachten, ob "
                    "alle Räume noch warm werden – besonders der kälteste Raum (Leitraum). "
                    "Wiederholen, bis es gerade noch reicht.")

    ref = [{"outdoor": rx, "actual": round(a * rx + b, 1), "ideal": round(_ideal_flow(rx), 1)}
           for rx in (-7, 0, 7)]
    step = max(1, n // 300)
    return {"ok": True, "enough": True, "provisional": not full_fit, "basis": basis,
            "n": n, "csv_points": n_csv, "days_window": days,
            "points": pts[::step], "live_point": live_pt,
            "fit": {"a": round(a, 3), "b": round(b, 2)},
            "ideal": [{"x": round(x, 1), "y": round(_ideal_flow(x), 1)} for x in
                      [xmin + (xmax - xmin) * k / 20 for k in range(21)]],
            "xmin": round(xmin, 1), "xmax": round(xmax, 1),
            "over_k": over_k, "verdict": verdict, "saving_pct": saving_pct,
            "recommendation": rec, "ref": ref, "cycles": cyc}


def compute_heating_diag(climate: list[dict], hp: dict | None, cycles: dict | None = None) -> dict:
    """Turn room thermostats + the heat-pump flow/return snapshot into concrete
    'Einstellungsfehler / Effizienz' findings.

    Two kinds of finding: SETTINGS (time-independent configuration issues –
    throttled valves, setpoint spread, wrong modes, offsets) and OPERATING (the
    momentary flow temperature, spread and cycling). Each finding carries a
    severity, the measured value, a target and a concrete fix. Pure heuristics –
    labelled as guidance, not gospel.
    """
    hp = hp or {}
    rooms = [r for r in (climate or []) if isinstance(r, dict)]
    F = []   # findings

    def add(sev, cat, title, detail, value=None, target=None, fix=None, rooms_hit=None, saving_pct=0.0):
        F.append({"severity": sev, "cat": cat, "title": title, "detail": detail,
                  "value": value, "target": target, "fix": fix,
                  "rooms": rooms_hit or [], "saving_pct": round(saving_pct, 3)})

    supply = hp.get("supply_c")
    ret = hp.get("return_c")
    outdoor = hp.get("outdoor_c")
    mode = (hp.get("mode") or "").lower()
    modulation = hp.get("modulation")
    starts = hp.get("starts")
    working_h = hp.get("working_h")
    heating_now = mode in ("ch", "heating", "heat") and (modulation or 0) > 0
    compressor_on = (modulation or 0) > 0

    # ---- OPERATING: flow temperature vs. outside (heat-curve too steep) ----- #
    # A heat pump wants the LOWEST flow temp that still heats the house; each +1 K
    # costs ~2.5 % efficiency. Target band derived from outdoor temp (underfloor
    # friendly). Only meaningful while the compressor heats the house.
    ideal_flow = round(_ideal_flow(outdoor), 1) if outdoor is not None else None
    if heating_now and supply is not None and ideal_flow is not None:
        over = round(supply - ideal_flow, 1)
        if over >= 8:
            add("high", "flow", "Vorlauftemperatur deutlich zu hoch",
                f"Vorlauf {supply:.0f} °C bei {outdoor:.0f} °C außen – für eine Wärmepumpe "
                f"rund {over:.0f} K über dem sinnvollen Zielband (~{ideal_flow:.0f} °C). "
                f"Jedes +1 K Vorlauf kostet ~2–3 % Effizienz (JAZ).",
                value=f"{supply:.0f} °C", target=f"≈ {ideal_flow:.0f} °C",
                fix="Heizkurve (Steilheit/Niveau) absenken: schrittweise je 2–3 K, bis Räume "
                    "gerade noch warm werden. Ziel: niedrigster Vorlauf, der die Wohnung hält.",
                saving_pct=min(0.18, over * 0.025))
        elif over >= 4:
            add("warn", "flow", "Vorlauftemperatur etwas hoch",
                f"Vorlauf {supply:.0f} °C bei {outdoor:.0f} °C außen, ~{over:.0f} K über dem "
                f"Zielband (~{ideal_flow:.0f} °C). Spielraum, die Heizkurve flacher zu stellen.",
                value=f"{supply:.0f} °C", target=f"≈ {ideal_flow:.0f} °C",
                fix="Heizkurve leicht absenken und beobachten, ob alle Räume noch warm werden.",
                saving_pct=min(0.10, over * 0.025))
        else:
            add("ok", "flow", "Vorlauftemperatur im sinnvollen Bereich",
                f"Vorlauf {supply:.0f} °C bei {outdoor:.0f} °C außen passt zum WP-freundlichen "
                f"Zielband (~{ideal_flow:.0f} °C).",
                value=f"{supply:.0f} °C", target=f"≈ {ideal_flow:.0f} °C")

    # ---- OPERATING: spread Vorlauf − Rücklauf ------------------------------- #
    if compressor_on and supply is not None and ret is not None:
        dt = round(supply - ret, 1)
        if dt < 3:
            add("warn", "spread", "Spreizung zu klein (Vorlauf−Rücklauf)",
                f"ΔT nur {dt:.1f} K. Zu kleine Spreizung heißt: die Umwälzpumpe fördert zu "
                f"viel – oder ein Überströmventil / zu viele offene Kreise mischen zurück. "
                f"Das senkt die Effizienz und begünstigt Takten.",
                value=f"{dt:.1f} K", target="5–8 K",
                fix="Pumpendrehzahl/Volumenstrom reduzieren bis ΔT ≈ 5–7 K; Überströmventil prüfen.",
                saving_pct=0.03)
        elif dt > 10:
            add("warn", "spread", "Spreizung zu groß (Vorlauf−Rücklauf)",
                f"ΔT {dt:.1f} K. Zu große Spreizung deutet auf zu wenig Durchfluss – gedrosselte "
                f"Thermostate, verschmutzter Filter/Sieb oder zu langsame Pumpe.",
                value=f"{dt:.1f} K", target="5–8 K",
                fix="Mehr Heizkreise öffnen, Schmutzfilter reinigen, Pumpenleistung erhöhen.",
                saving_pct=0.03)
        else:
            add("ok", "spread", "Spreizung im Zielbereich",
                f"Vorlauf−Rücklauf ΔT {dt:.1f} K – passt (Zielband 5–8 K).",
                value=f"{dt:.1f} K", target="5–8 K")

    # ---- OPERATING: cycling (short cycles) ---------------------------------- #
    # Prefer REAL per-day cycling from the logged history; fall back to the
    # lifetime average (counter) when there isn't enough history yet.
    cyc_min = None
    cyc_src = None
    per_day = None
    if cycles and cycles.get("avg_run_min") and (cycles.get("days") or 0) >= 1:
        cyc_min = cycles["avg_run_min"]; per_day = cycles.get("per_day")
        cyc_src = f"{per_day:.0f} Takte/Tag" if per_day is not None else "Verlauf"
    elif starts and working_h and starts > 0:
        cyc_min = round(working_h * 60.0 / starts, 0); cyc_src = "Lebensdauer-Mittel"
    if cyc_min is not None:
        extra = f" (~{per_day:.0f} Takte/Tag)" if per_day is not None else ""
        if cyc_min < 10:
            add("high", "cycle", "Wärmepumpe taktet zu häufig",
                f"Ø Laufzeit nur ~{cyc_min:.0f} min pro Takt{extra}. Kurze Takte verschleißen den "
                f"Verdichter und senken die Jahresarbeitszahl – meist durch zu hohen Vorlauf oder zu "
                f"wenig offene Heizfläche.",
                value=f"~{cyc_min:.0f} min/Takt", target="> 15 min",
                fix="Vorlauf/Heizkurve senken, mehr Heizkreise offen lassen, ggf. Hysterese erhöhen.",
                saving_pct=0.05)
        elif cyc_min < 15:
            add("warn", "cycle", "Taktung grenzwertig",
                f"Ø ~{cyc_min:.0f} min pro Takt{extra}. Etwas kurz – mehr offene Heizfläche / "
                f"niedrigerer Vorlauf verlängert die Takte.",
                value=f"~{cyc_min:.0f} min/Takt", target="> 15 min",
                fix="Thermostate weiter öffnen, Heizkurve flacher stellen.",
                saving_pct=0.03)
        else:
            add("ok", "cycle", "Taktung unauffällig",
                f"Ø ~{cyc_min:.0f} min pro Takt ({cyc_src}) – ruhiger Lauf.",
                value=f"~{cyc_min:.0f} min/Takt", target="> 15 min")

    # ---- SETTINGS: thermostats throttling the heat pump --------------------- #
    heat_rooms = [r for r in rooms
                  if (r.get("roomControlMode") or "HEATING").upper() != "OFF"
                  and not r.get("summerMode")]
    valved = [r for r in heat_rooms if isinstance(r.get("valve"), (int, float))]
    throttled = [r for r in valved if r["valve"] < 80]
    hard = [r for r in valved if r["valve"] < 50]
    if valved and len(throttled) / len(valved) >= 0.4:
        names = [r["room"] for r in sorted(throttled, key=lambda x: x["valve"])]
        sev = "high" if (len(hard) >= 2 or len(throttled) / len(valved) >= 0.6) else "warn"
        add(sev, "valves", "Einzelraumregelung arbeitet gegen die Wärmepumpe",
            f"{len(throttled)} von {len(valved)} Räumen sind angedrosselt (Ventil < 80 %"
            f"{', davon ' + str(len(hard)) + ' unter 50 %' if hard else ''}). Gedrosselte Ventile "
            f"verkleinern die aktive Heizfläche – die WP muss den Vorlauf anheben und taktet. "
            f"Bei Flächenheizung ist die Heizkurve der bessere Regler als die Raumthermostate.",
            value=f"{len(throttled)}/{len(valved)} gedrosselt", target="Ventile möglichst offen",
            fix="Thermostate in den Haupträumen voll öffnen und die Temperatur über die Heizkurve "
                "regeln; Feinverteilung über hydraulischen Abgleich statt Zudrosseln.",
            rooms_hit=names, saving_pct=0.10 if sev == "high" else 0.06)
    elif valved:
        add("ok", "valves", "Heizflächen weit offen",
            f"{len(valved) - len(throttled)} von {len(valved)} Räumen haben die Ventile weit offen "
            f"– gut für einen niedrigen Vorlauf.",
            value=f"{len(throttled)}/{len(valved)} gedrosselt", target="Ventile möglichst offen")

    # ---- SETTINGS: setpoint spread between rooms ---------------------------- #
    sps = [(r["room"], r["setpoint"]) for r in heat_rooms
           if isinstance(r.get("setpoint"), (int, float))]
    if len(sps) >= 2:
        lo = min(sps, key=lambda x: x[1]); hi = max(sps, key=lambda x: x[1])
        spread = round(hi[1] - lo[1], 1)
        if spread >= 4:
            add("warn", "spread_room", "Große Soll-Unterschiede zwischen Räumen",
                f"Von {lo[0]} ({lo[1]:.0f} °C) bis {hi[0]} ({hi[1]:.0f} °C) – {spread:.0f} K "
                f"Unterschied. Der wärmste Raum zwingt den Vorlauf hoch, die kühleren drosseln dann "
                f"ab: genau das, was die WP ineffizient macht.",
                value=f"{spread:.0f} K Spreizung", target="≤ 3 K",
                fix="Solltemperaturen angleichen (z. B. alle 20–22 °C) und selten genutzte Räume "
                    "eher über Lüftung/Türen temperieren als mit stark abweichendem Sollwert.",
                saving_pct=0.03)

    # ---- SETTINGS: absolute setpoint high ----------------------------------- #
    hot = [r for r in heat_rooms if isinstance(r.get("setpoint"), (int, float)) and r["setpoint"] >= 23]
    if hot:
        hot_lst = ", ".join(f"{r['room']} ({r['setpoint']:.0f} °C)" for r in hot)
        add("info", "high_set", "Hohe Solltemperaturen",
            f"{hot_lst}. Jedes +1 °C Raumtemperatur kostet grob ~6 % Heizenergie.",
            value=f"{len(hot)} Raum/Räume ≥ 23 °C", target="20–22 °C üblich",
            fix="Prüfen, ob 23 °C+ wirklich nötig sind – 1 °C weniger spart spürbar.")

    # ---- SETTINGS: control-off / summer-mode in heating season -------------- #
    cold_outside = outdoor is not None and outdoor < 15
    off_rooms = [r for r in rooms if (r.get("roomControlMode") or "").upper() == "OFF"
                 and isinstance(r.get("temp"), (int, float)) and r["temp"] < 18]
    if cold_outside and off_rooms:
        add("warn", "mode_off", "Raumregelung aus, obwohl es kühl ist",
            f"{', '.join(r['room'] for r in off_rooms)} steht auf AUS und ist unter 18 °C. "
            f"Gewollt (ungenutzter Raum) oder vergessen?",
            value=f"{len(off_rooms)} Raum/Räume AUS", target=None,
            fix="Wenn der Raum genutzt wird: Regelung wieder auf Heizen stellen.")
    summer_rooms = [r for r in rooms if r.get("summerMode")]
    if cold_outside and summer_rooms:
        add("warn", "summer", "Sommerbetrieb trotz Kälte aktiv",
            f"{', '.join(r['room'] for r in summer_rooms)} im Sommerbetrieb, draußen {outdoor:.0f} °C. "
            f"Dann heizt der Raum nicht.",
            value=f"{len(summer_rooms)} Raum/Räume", target=None,
            fix="Sommerbetrieb beenden, wenn geheizt werden soll.")

    # ---- SETTINGS: control deviation per room (Soll vs. Ist) ---------------- #
    cold = [r for r in heat_rooms
            if isinstance(r.get("setpoint"), (int, float)) and isinstance(r.get("temp"), (int, float))
            and r["temp"] <= r["setpoint"] - 1.5 and (r.get("valve") is None or r["valve"] >= 90)]
    if cold:
        names = [f"{r['room']} ({r['temp']:.0f}/{r['setpoint']:.0f} °C)" for r in cold]
        add("warn", "undersupply", "Räume werden trotz offenem Ventil nicht warm",
            f"{', '.join(names)}: Ist liegt ≥ 1,5 K unter Soll, Ventil (fast) offen. Heizfläche zu "
            f"klein, Vorlauf zu niedrig für diesen Raum, hydraulischer Abgleich – oder Fenster offen.",
            value=f"{len(cold)} Raum/Räume unterversorgt", target="Ist ≈ Soll",
            fix="Diesen Raum beim hydraulischen Abgleich bevorzugen; prüfen, ob er den Vorlauf limitiert.")

    # ---- SETTINGS: measured-temperature offset ------------------------------ #
    offs = [r for r in rooms if isinstance(r.get("offset"), (int, float)) and abs(r["offset"]) >= 2]
    if offs:
        off_lst = ", ".join(f"{r['room']} ({r['offset']:+.0f} K)" for r in offs)
        add("info", "offset", "Großer Temperatur-Offset gesetzt",
            f"{off_lst}. Ein großer Offset verstellt die gemessene Raumtemperatur – leicht Quelle "
            f"für dauerhaftes Über-/Unterheizen.",
            value=f"{len(offs)} Raum/Räume", target="≈ 0 K",
            fix="Offset nur zum Kalibrieren gegen ein geprüftes Thermometer nutzen, nicht zum 'Mogeln'.")

    # ---- SETTINGS: device faults (battery etc.) ----------------------------- #
    faulty = [(r["room"], r["faults"]) for r in rooms if r.get("faults")]
    if faulty:
        txt = "; ".join(f"{rm}: {', '.join(fs)}" for rm, fs in faulty)
        add("warn", "fault", "Thermostat meldet einen Fehler",
            f"{txt}. Z. B. schwache Batterie verfälscht die Regelung.",
            value=f"{len(faulty)} Gerät(e)", target=None,
            fix="Gemeldete Fehler beheben (meist Batterie wechseln).")

    # ---- KPIs / headline ---------------------------------------------------- #
    order = {"high": 0, "warn": 1, "info": 2, "ok": 3}
    F.sort(key=lambda f: order.get(f["severity"], 9))
    n_high = sum(1 for f in F if f["severity"] == "high")
    n_warn = sum(1 for f in F if f["severity"] == "warn")
    if n_high:
        verdict = "Deutliches Sparpotenzial – Einstellungen anpassen."
    elif n_warn:
        verdict = "Kleinere Stellhebel vorhanden."
    else:
        verdict = "Heizung läuft sauber eingestellt."
    dt = (round(supply - ret, 1) if (supply is not None and ret is not None) else None)
    cyc = cyc_min if cyc_min is not None else None
    # rough combined saving potential: diminishing sum of the single effects,
    # capped – the measures overlap (lower flow also reduces cycling).
    eff = 0.0
    for f in sorted(F, key=lambda x: -x.get("saving_pct", 0)):
        sp = f.get("saving_pct", 0) or 0
        if sp > 0:
            eff = eff + sp * (1 - eff)          # combine as independent fractions
    saving_pct_total = round(min(0.30, eff), 3)
    kpis = {
        "supply_c": supply, "return_c": ret, "outdoor_c": outdoor,
        "spread_k": dt, "modulation": modulation, "mode": hp.get("mode"),
        "ideal_flow_c": ideal_flow, "cycle_min": cyc,
        "cycles_per_day": (cycles or {}).get("per_day"),
        "rooms": len(rooms), "heating_now": heating_now,
        "saving_pct_total": saving_pct_total,
        "n_high": n_high, "n_warn": n_warn,
        "n_info": sum(1 for f in F if f["severity"] == "info"),
        "n_ok": sum(1 for f in F if f["severity"] == "ok"),
    }
    return {"ok": True, "verdict": verdict, "kpis": kpis,
            "findings": F, "rooms": rooms}


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
    mt = hp.get("mode_today", {})
    heat_ = round(mt.get("heating", 0.0), 3)
    water_ = round(mt.get("water", 0.0), 3)
    # reconcile with the authoritative day total ('Strom heute'): energy the mode
    # split couldn't classify (mode unknown, or recovered after an outage) is
    # shown as "Sonstiges" so the WP slices SUM to hp_today instead of undercounting.
    other_ = round(max(mt.get("other", 0.0), (hp_today or 0.0) - heat_ - water_), 3)
    if heat_ > 0.01 or water_ > 0.01 or other_ > 0.01:
        if heat_ > 0.01:
            breakdown.append({"key": "hp_heating", "label": "WP · Heizung",
                              "kwh": heat_, "color": "#ef6c4d"})
        if water_ > 0.01:
            breakdown.append({"key": "hp_water", "label": "WP · Warmwasser",
                              "kwh": water_, "color": "#f6b93b"})
        if other_ > 0.01:
            breakdown.append({"key": "hp_other", "label": "WP · Sonstiges",
                              "kwh": other_, "color": "#b07a4d"})
    elif hp_today > 0 or (hp_live and hp_live.get("connected")):
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
        elec, mode = 1500.0, "dhw"
        cop = max(1.8, min(3.6, 2.0 + 0.07 * outdoor))  # warmer air = better COP
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


def _demo_climate() -> list[dict]:
    """Synthetic per-room thermostat snapshot for the heating diagnostics demo –
    deliberately seeded with a few typical misconfigurations so the check has
    something to flag (throttled valves, setpoint spread, a cold room, an offset)."""
    def rec(room, setpoint, temp, valve, **kw):
        d = {"room": room, "setpoint": setpoint, "temp": temp, "valve": valve,
             "valves": [valve], "operationMode": "AUTOMATIC", "roomControlMode": "HEATING",
             "boost": False, "summerMode": False, "low": False, "offset": None,
             "childLock": False, "faults": [], "devices": 1}
        d.update(kw)
        return d
    return [
        rec("Wohnzimmer", 22.0, 21.7, 95),
        rec("Küche", 21.0, 21.2, 85),
        rec("Bad", 24.0, 23.1, 100, offset=0.0),            # setpoint spread driver
        rec("Schlafzimmer", 18.0, 19.0, 25),                # throttled valve
        rec("Arbeitszimmer", 20.0, 18.2, 100),              # cold despite open valve
        rec("Gäste-WC", 19.0, 20.5, 20, offset=2.0),        # throttled + offset
        rec("Flur", 19.0, 19.5, 40),                        # throttled
    ]


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
                        round(h_kwh, 4), op["heat_w"], op["mode"], op["supply_c"], op["return_c"]))
        t += step
    store.add_hp_samples_bulk(hp_rows)
    print(f"[demo] inserted {len(hp_rows)} heat-pump samples.")

    # a demo AEG washing machine: a growing lifetime kWh counter plus a few
    # wash cycles, so the appliance card has something to show in demo mode.
    store.aeg_upsert_appliance({"id": "demo-washer", "name": "Waschmaschine",
                                "type": "WM", "brand": "AEG", "model": "LR8E75495"})
    kpc, cycles = 0.8, 380       # like real AEG: no kWh field, energy from cycles
    t = start
    while t <= now:
        # a wash on alternate days at 10:00 and 18:00
        running = (t.hour in (10, 18)) and (int(t.timestamp()) // 86400) % 2 == 0
        if running:
            cycles += 1
        store.aeg_add_sample("demo-washer", int(t.timestamp()), round(cycles * kpc, 2),
                             kpc, "RUNNING" if running else "READY_TO_START",
                             "COTTON_PR_ECO40-60" if running else None,
                             cycles, True)
        t += timedelta(hours=1)
    print("[demo] inserted demo AEG appliance history.")

    # two demo whole-house meter readings (~17 kWh/day total)
    store.meter_upsert(int((now - timedelta(days=8)).timestamp()), 2202.0, "")
    store.meter_upsert(int(now.timestamp()), 2202.0 + 8 * 17.0, "")


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
                "outdoor_c": op["outdoor_c"], "mode": op["mode"],
                "supply_c": op["supply_c"], "return_c": op["return_c"]})
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
            "mode": data.get("mode"),
            "supply_c": data.get("supply_c"), "return_c": data.get("return_c"),
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
# AEG / Electrolux appliance poller (washer, dryer, … via the developer API)
# --------------------------------------------------------------------------- #
class ElectroluxPoller(threading.Thread):
    def __init__(self, client, store: Store, state: dict, interval: int = 300):
        super().__init__(daemon=True)
        self.client = client
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
                self.state["last_error"] = None
            except Exception as exc:
                self.last_error = str(exc)
                self.state["last_error"] = str(exc)
                print(f"[electrolux] error: {exc}", file=sys.stderr)
            self._stop.wait(self.interval)

    def _poll(self):
        ts = int(time.time())
        appliances = self.client.list_appliances()
        out = []
        for a in appliances:
            self.store.aeg_upsert_appliance(a)
            try:
                snap = self.client.read_appliance(a["id"], a.get("name"))
            except Exception as exc:
                out.append({**a, "error": str(exc)})
                continue
            self.store.aeg_add_sample(a["id"], ts, snap.get("total_kwh"),
                                      snap.get("cycle_kwh"), snap.get("state"),
                                      snap.get("program"), snap.get("cycles"),
                                      snap.get("energy_estimated"))
            today0 = int(time.mktime(time.localtime(ts)[:3] + (0, 0, 0, 0, 0, -1)))
            out.append({
                **a,
                "state": snap.get("state"),
                "connection": snap.get("connection"),
                "program": snap.get("program"),
                "time_to_end_min": snap.get("time_to_end_min"),
                "cycles": snap.get("cycles"),
                "working_time_h": snap.get("working_time_h"),
                "total_kwh": snap.get("total_kwh"),
                "cycle_kwh": snap.get("cycle_kwh"),
                "energy_estimated": snap.get("energy_estimated"),
                "today_kwh": self.store.aeg_total_since(a["id"], today0),
                "energy_fields": snap.get("energy_fields"),
            })
        self.state.clear()
        self.state.update({"ok": True, "last_poll": ts, "appliances": out,
                           "last_error": None})
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
        self.ael = None         # ElectroluxPoller
        self.ael_state = {}     # latest AEG/Electrolux snapshot
        self.spot_last_fetch = 0
        self.spot_last_error = None
        self.spot_backfilling = False
        self.tibber_cache = None        # {"data":..., "ts":...}
        self.tibber_last_error = None
        self.ha_cache = None            # {"data":..., "ts":...}
        self.ha_last_error = None

    def ha_values(self):
        """Lazily read Home Assistant power/energy sensors (cached ~20 s)."""
        if self.mode == "demo":
            return ha.demo() if ha else None
        url = (self.cfg.get("ha_url") or "").strip()
        token = (self.cfg.get("ha_token") or "").strip()
        if not ha or not url or not token:
            return None
        c = self.ha_cache
        now = int(time.time())
        if c and now - c["ts"] < 20:
            return c["data"]
        ents = [e.strip() for e in (self.cfg.get("ha_entities") or "").split(",") if e.strip()]
        try:
            # refresh=True: some HomeKit sensors (e.g. Koogeek) never push updates,
            # so ask HA to re-read them before we take the values.
            data = ha.fetch(url, token, ents or None, refresh=True)
            self.ha_cache = {"data": data, "ts": now}
            self.ha_last_error = None
            return data
        except Exception as exc:
            self.ha_last_error = str(exc)
            return c["data"] if c else None

    def tibber_prices(self):
        """Lazily fetch the user's real Tibber prices (cached ~15 min). Returns
        the tibber.fetch_prices dict, or None when not connected/unavailable."""
        if self.mode == "demo":
            return tibber.demo() if tibber else None
        token = (self.cfg.get("tibber_token") or "").strip()
        if not tibber or not token:
            return None
        c = self.tibber_cache
        now = int(time.time())
        if c and now - c["ts"] < 900:
            return c["data"]
        try:
            data = tibber.fetch_prices(token)
            self.tibber_cache = {"data": data, "ts": now}
            self.tibber_last_error = None
            return data
        except Exception as exc:
            self.tibber_last_error = str(exc)
            return c["data"] if c else None

    def start_spot_backfill(self):
        """One-off: pull ~10 months of historical prices so the seasonal/hourly
        grid and the annual average are based on real data. Runs in a thread."""
        if self.spot_backfilling or not spot or not self.cfg.get("spot_enabled"):
            return
        self.spot_backfilling = True
        market = self.cfg.get("spot_market", "de")

        def _run():
            now = int(time.time())
            cur = now - 300 * 86400
            while cur < now:
                end = min(cur + 30 * 86400, now)
                try:
                    rows = spot.fetch_range(market, cur, end)
                    if rows:
                        self.store.spot_upsert(rows)
                    self.spot_last_error = None
                except Exception as exc:
                    self.spot_last_error = str(exc)
                    print(f"[spot] backfill chunk failed: {exc}", file=sys.stderr)
                cur = end
                time.sleep(0.4)
            print("[spot] historical backfill done", file=sys.stderr)
            self.spot_backfilling = False
        threading.Thread(target=_run, daemon=True).start()

    def stop(self):
        if self.poller:
            self.poller.stop()
            self.poller = None
        self.stop_heatpump()
        self.stop_electrolux()

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

    # -- AEG / Electrolux ------------------------------------------------ #
    def save_electrolux_token(self, refresh_token: str):
        """Persist a rotated Electrolux refresh token (rotation on refresh)."""
        self.cfg["electrolux_refresh_token"] = refresh_token
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))

    def electrolux_client(self):
        """Shared Electrolux client (the poller's, if running) so refresh
        tokens aren't rotated twice; created on demand otherwise."""
        if self.ael and getattr(self.ael, "client", None):
            return self.ael.client
        if not electrolux or not self.cfg.get("electrolux_api_key") \
                or not self.cfg.get("electrolux_refresh_token"):
            return None
        return electrolux.ElectroluxClient(
            self.cfg["electrolux_api_key"], self.cfg["electrolux_refresh_token"],
            on_token=self.save_electrolux_token,
            kwh_per_cycle=float(self.cfg.get("electrolux_kwh_per_cycle", 0.8) or 0.8))

    def start_electrolux(self) -> bool:
        self.stop_electrolux()
        if not electrolux or not self.cfg.get("electrolux_api_key") \
                or not self.cfg.get("electrolux_refresh_token"):
            return False
        client = electrolux.ElectroluxClient(
            self.cfg["electrolux_api_key"], self.cfg["electrolux_refresh_token"],
            on_token=self.save_electrolux_token,
            kwh_per_cycle=float(self.cfg.get("electrolux_kwh_per_cycle", 0.8) or 0.8))
        self.ael = ElectroluxPoller(client, self.store, self.ael_state,
                                    int(self.cfg.get("electrolux_interval", 300)))
        self.ael.start()
        return True

    def stop_electrolux(self):
        if self.ael:
            self.ael.stop()
            self.ael = None


def save_config(cfg: dict, path: str):
    keep = ("shc_ip", "system_password", "cert", "key", "db", "poll_interval",
            "price_per_kwh", "currency", "device_filter",
            "homecom_refresh_token", "homecom_gateway", "homecom_interval",
            "electrolux_api_key", "electrolux_refresh_token", "electrolux_interval",
            "electrolux_kwh_per_cycle", "auto_update_interval",
            "spot_enabled", "spot_market", "spot_surcharge_ct", "spot_vat")
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

    def _spot_payload(self) -> dict:
        """Hourly consumer prices for the Börse tab. Uses the user's REAL Tibber
        tariff when connected, otherwise the EPEX/aWATTar market + surcharge."""
        cfg = self.cfg
        vat = float(cfg.get("spot_vat", 19.0) or 0)
        surch = float(cfg.get("spot_surcharge_ct", 15.0) or 0)
        def consumer(mkt):
            return round(mkt * (1 + vat / 100.0) + surch, 2)
        now = int(time.time())
        typical = spot.TYPICAL_MARKET_CT if spot else 8.5
        demo = self.ctx.mode == "demo"
        tib = self.ctx.tibber_prices()          # real (or, in demo, synthetic) Tibber prices

        def leveled_grid(base):
            """A seasonal month×hour grid at the given ct/kWh average level."""
            if not spot:
                return None, None
            g = [[round(base * spot.DEMO_MONTH_FACTOR[m] * spot.DEMO_HOUR_FACTOR[h], 3)
                  for h in range(24)] for m in range(12)]
            return g, [round(sum(g[m]) / 24, 3) for m in range(12)]

        def tibber_rows():
            return [{"ts": r["ts"], "market_ct": r["total_ct"],
                     "consumer_ct": r["total_ct"], "level": r.get("level")}
                    for r in (tib.get("prices") or []) if r.get("total_ct") is not None]

        def tibber_payload(is_demo):
            prices = tibber_rows()
            annual = round(sum(p["consumer_ct"] for p in prices) / len(prices), 2) if prices else consumer(typical)
            # grid at the all-in Tibber level (surcharge/VAT already included → 0)
            grid, month_avg = leveled_grid(annual)
            return {"enabled": True, "demo": is_demo, "source": "tibber", "home": tib.get("home"),
                    "market": "tibber", "surcharge_ct": 0, "vat": 0, "prices": prices,
                    "annual_consumer_ct": annual, "annual_basis": "tibber",
                    "month_hour_ct": grid, "month_avg_ct": month_avg, "backfilling": False,
                    "last_error": self.ctx.tibber_last_error}

        # ---- demo mode: always show something -----------------------------
        if demo:
            if tib:                              # prefer the (synthetic) Tibber curve
                return tibber_payload(True)
            grid, month_avg = leveled_grid(typical)
            rows = spot.demo_prices(48) if spot else []
            prices = [{"ts": ts, "market_ct": mc, "consumer_ct": consumer(mc)} for ts, mc in rows]
            return {"enabled": True, "demo": True, "source": "spot", "market": "demo",
                    "surcharge_ct": surch, "vat": vat, "prices": prices,
                    "hist_market_ct": typical, "hist_hours": 8760, "typical_market_ct": typical,
                    "annual_consumer_ct": consumer(typical), "annual_basis": "history",
                    "month_hour_ct": grid, "month_avg_ct": month_avg, "backfilling": False,
                    "last_error": None}

        # ---- live: Tibber takes precedence over the market estimate --------
        if tib and tib.get("prices"):
            return tibber_payload(False)

        if not spot or not cfg.get("spot_enabled"):
            return {"enabled": False, "available": spot is not None,
                    "tibber_available": tibber is not None, "prices": []}

        # lazy refresh: fetch at most every ~30 min, or when data runs short
        need = (self.store.spot_max_ts() or 0) < now + 6 * 3600
        if need and (now - getattr(self.ctx, "spot_last_fetch", 0)) > 1800:
            self.ctx.spot_last_fetch = now
            try:
                rows = spot.fetch_market_prices(cfg.get("spot_market", "de"))
                if rows:
                    self.store.spot_upsert(rows)
                self.ctx.spot_last_error = None
            except Exception as exc:
                self.ctx.spot_last_error = str(exc)
        rows = self.store.spot_range(now - 2 * 3600, now + 48 * 3600)
        prices = [{"ts": r["ts"], "market_ct": round(r["market_ct"], 2),
                   "consumer_ct": consumer(r["market_ct"])} for r in rows]
        # realistic annual average from accumulated history, plus a seasonal
        # month×hour grid for a load-weighted cost.
        st = self.store.spot_stats(400)
        mh = self.store.spot_month_hour(400)
        # kick off a one-off historical backfill if history is still thin
        if st["hours"] < 2000:
            self.ctx.start_spot_backfill()
        enough = st["hours"] >= 72 and st["avg_market_ct"] is not None
        annual_mkt = st["avg_market_ct"] if enough else typical
        return {"enabled": True, "demo": False, "source": "spot", "market": cfg.get("spot_market", "de"),
                "surcharge_ct": surch, "vat": vat, "prices": prices,
                "hist_market_ct": round(st["avg_market_ct"], 3) if st["avg_market_ct"] is not None else None,
                "hist_hours": st["hours"], "typical_market_ct": typical,
                "annual_consumer_ct": consumer(annual_mkt),
                "annual_basis": "history" if enough else "typisch",
                "month_hour_ct": mh["grid"], "month_avg_ct": mh["month_avg"],
                "backfilling": self.ctx.spot_backfilling,
                "last_error": getattr(self.ctx, "spot_last_error", None)}

    def _pvgis_payload(self, qs) -> dict:
        """PV yield for a location via PVGIS (or a plausible demo value)."""
        def q(name, default):
            try:
                return float(qs.get(name, [default])[0])
            except (TypeError, ValueError):
                return default
        lat, lon = q("lat", None), q("lon", None)
        tilt, az, loss = q("tilt", 35), q("az", 0), q("loss", 14)
        if self.ctx.mode == "demo" or not pvgis:
            # a plausible central-European south-facing result for the demo
            monthly = [0.030, 0.050, 0.085, 0.112, 0.128, 0.130, 0.132, 0.115, 0.088, 0.060, 0.036, 0.024]
            return {"ok": True, "demo": True, "yield": 1000, "monthly": monthly}
        if lat is None or lon is None:
            return {"ok": False, "error": "lat und lon erforderlich."}
        try:
            r = pvgis.fetch(lat, lon, tilt, az, loss)
            return {"ok": True, "demo": False, **r}
        except Exception as exc:
            return {"ok": False, "error": f"PVGIS-Abruf fehlgeschlagen: {exc}"}

    def _weather_payload(self, qs) -> dict:
        """Hourly weather forecast (irradiance + outside temp) for a PV- and
        heat-demand prognosis (or a plausible demo curve)."""
        def q(name, default):
            try:
                return float(qs.get(name, [default])[0])
            except (TypeError, ValueError):
                return default
        lat, lon = q("lat", None), q("lon", None)
        if self.ctx.mode == "demo" or not weather:
            r = weather.demo() if weather else {"hourly": [], "tz": "demo", "utc_offset": 0}
            return {"ok": True, "demo": True, **r}
        if lat is None or lon is None:
            return {"ok": False, "error": "lat und lon erforderlich."}
        try:
            r = weather.fetch(lat, lon)
            return {"ok": True, "demo": False, **r}
        except Exception as exc:
            return {"ok": False, "error": f"Wetter-Abruf fehlgeschlagen: {exc}"}

    def _appliances_payload(self) -> dict:
        """AEG/Electrolux appliances: live snapshot from the poller, enriched
        with today's kWh, or the last stored reading when the poller is idle."""
        live = {a["id"]: a for a in (self.ctx.ael_state.get("appliances") or [])}
        out = []
        for a in self.store.aeg_appliances():
            aid = a["id"]
            row = {"id": aid, "name": a.get("name"), "type": a.get("type"),
                   "brand": a.get("brand"), "model": a.get("model")}
            if aid in live:
                row.update({k: live[aid].get(k) for k in
                            ("state", "connection", "program", "time_to_end_min",
                             "cycles", "working_time_h", "total_kwh", "cycle_kwh",
                             "energy_estimated", "today_kwh", "energy_fields")})
            else:
                last = self.store.aeg_latest(aid)
                today0 = int(time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1)))
                if last:
                    row.update({"state": last.get("state"), "program": last.get("program"),
                                "total_kwh": last.get("total_kwh"),
                                "cycle_kwh": last.get("cycle_kwh"),
                                "cycles": last.get("cycles"),
                                "energy_estimated": bool(last.get("estimated")),
                                "today_kwh": self.store.aeg_total_since(aid, today0)})
            out.append(row)
        return {"connected": bool(self.cfg.get("electrolux_refresh_token")) or self.ctx.mode == "demo",
                "last_poll": self.ctx.ael_state.get("last_poll"),
                "last_error": self.ctx.ael_state.get("last_error"),
                "appliances": out}

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_csv(self, text, filename="export.csv", status=200):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _export_csv(self, days, price):
        """A daily CSV joining smart-home and heat-pump energy per day."""
        sh = compute_analytics(self.store, days, price)
        hp = compute_hp_analytics(self.store, days, price, self._hp_live())
        sh_daily = {d["day"]: d for d in sh.get("daily", [])}
        hp_daily = {d["day"]: d for d in hp.get("daily", [])}
        all_days = sorted(set(sh_daily) | set(hp_daily))
        rows = ["Datum;Smart-Home_kWh;Waermepumpe_Strom_kWh;Waermepumpe_Waerme_kWh;Gesamt_kWh;Kosten_EUR"]
        for d in all_days:
            shk = float((sh_daily.get(d) or {}).get("kwh", 0.0) or 0.0)
            he = float((hp_daily.get(d) or {}).get("elec_kwh", 0.0) or 0.0)
            hh = float((hp_daily.get(d) or {}).get("heat_kwh", 0.0) or 0.0)
            total = shk + he
            cost = total * price
            # German locale: decimal comma, semicolon separator
            def g(v, n=3):
                return f"{v:.{n}f}".replace(".", ",")
            rows.append(f"{d};{g(shk)};{g(he)};{g(hh)};{g(total)};{g(cost, 2)}")
        return "\n".join(rows) + "\n"

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
            if parsed.path == "/api/homecom/import":
                return self._post_hp_import(body)
            if parsed.path == "/api/homecom/import/clear":
                return self._post_hp_import_clear(body)
            if parsed.path == "/api/switch":
                return self._post_switch(body)
            if parsed.path == "/api/homecom/refresh":
                return self._post_hp_refresh(body)
            if parsed.path == "/api/electrolux/connect":
                return self._post_electrolux_connect(body)
            if parsed.path == "/api/electrolux/probe":
                return self._post_electrolux_probe(body)
            if parsed.path == "/api/tibber/connect":
                return self._post_tibber_connect(body)
            if parsed.path == "/api/ha/connect":
                return self._post_ha_connect(body)
            if parsed.path == "/api/meter":
                return self._post_meter(body)
            if parsed.path == "/api/meter/delete":
                return self._post_meter_delete(body)
            if parsed.path == "/api/update":
                return self._post_update(body)
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
        if body.get("auto_update_interval") is not None:
            try:
                cfg["auto_update_interval"] = max(0, int(float(body["auto_update_interval"])))
            except (TypeError, ValueError):
                pass
            _ensure_auto_update(cfg)
        if body.get("electrolux_kwh_per_cycle") is not None:
            try:
                cfg["electrolux_kwh_per_cycle"] = max(0.0, float(body["electrolux_kwh_per_cycle"]))
                self.ctx.start_electrolux()   # re-arm poller with the new factor
            except (TypeError, ValueError):
                pass
        if body.get("spot_enabled") is not None:
            cfg["spot_enabled"] = bool(body["spot_enabled"])
            self.ctx.spot_last_fetch = 0      # allow an immediate refresh
        if body.get("spot_market") in ("de", "at"):
            cfg["spot_market"] = body["spot_market"]; self.ctx.spot_last_fetch = 0
        for k in ("spot_surcharge_ct", "spot_vat"):
            if body.get(k) is not None:
                try:
                    cfg[k] = max(0.0, float(body[k]))
                except (TypeError, ValueError):
                    pass
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

    def _post_hp_import(self, body):
        """Store parsed HomeCom-CSV history (day/month rows with heating/water split)."""
        def f(v):
            try:
                return float(v) if v is not None and v != "" else None
            except (TypeError, ValueError):
                return None
        clean = []
        curve = []          # (ts, outdoor, supply) heating-curve points (hourly)
        for r in (body.get("rows") or []):
            period = r.get("period")
            date = str(r.get("date") or "").strip()
            if period not in ("day", "month", "hour") or not date:
                continue
            elec = f(r.get("elec_kwh"))
            heat = f(r.get("heat_kwh"))
            outdoor = f(r.get("outdoor_c"))
            heating = f(r.get("heating_kwh"))
            water = f(r.get("water_kwh"))
            if elec is None and heat is None:
                continue
            clean.append((period, date, elec, heat, heating, water, outdoor))
            # real heating-curve point: an HOUR with actual space-heating OUTPUT
            # (produced heating heat > 0 – excludes standby & hot-water hours where
            # the flow sensor still reads the hot tank), no hot water, flow+outdoor
            # present. Using produced heat, not the 0.1 kWh standby electricity.
            supply = f(r.get("supply_c"))
            prod_heat = f(r.get("heat_heating_kwh"))
            active = (prod_heat or 0) > 0.1 if prod_heat is not None else (heating or 0) > 0.15
            if (period == "hour" and supply is not None and outdoor is not None
                    and supply >= 20 and active and (water or 0) <= 0.05):
                try:
                    ts = int(datetime.fromisoformat(date).timestamp())
                    curve.append((ts, round(outdoor, 1), round(supply, 1)))
                except (ValueError, OverflowError):
                    pass
        if not clean:
            return self._send_json({"ok": False, "error": "Keine gültigen Zeilen erkannt."}, 200)
        self.store.hp_history_upsert(clean)
        if curve:
            self.store.hp_curve_upsert(curve)
        cnt = self.store.hp_history_count()
        days = sum(1 for c in clean if c[0] == "day")
        months = sum(1 for c in clean if c[0] == "month")
        hours = sum(1 for c in clean if c[0] == "hour")
        ctot = self.store.hp_curve_count()
        cmsg = f", {len(curve)} Heizkurven-Punkte" if curve else ""
        return self._send_json({"ok": True, "imported": len(clean),
                                "new_days": days, "new_months": months, "new_hours": hours,
                                "curve_points": len(curve), "total_curve": ctot,
                                "total_days": cnt["days"], "total_months": cnt["months"],
                                "total_hours": cnt.get("hours", 0),
                                "message": f"{len(clean)} Zeilen importiert "
                                           f"({days} Tage, {months} Monate, {hours} Stunden{cmsg})."})

    def _post_hp_import_clear(self, body):
        """Delete ALL imported heat-pump history (the CSV the user uploaded).
        Live polling data is kept; only the imported rows are removed."""
        n = self.store.hp_history_clear()
        return self._send_json({"ok": True, "cleared": n,
                                "message": f"{n} importierte Zeilen gelöscht."})

    def _post_switch(self, body):
        """Switch a Bosch device (Smart Plug+ etc.) ON/OFF. User-initiated only."""
        dev_id = str(body.get("device_id") or "").strip()
        on = bool(body.get("on"))
        if not dev_id:
            return self._send_json({"ok": False, "error": "device_id fehlt."}, 200)
        if self.ctx.mode == "demo":
            return self._send_json({"ok": True, "demo": True, "id": dev_id,
                                    "state": "ON" if on else "OFF"})
        if self.ctx.mode != "live":
            return self._send_json({"ok": False, "error": "nur im Live-Modus verfügbar"}, 200)
        try:
            client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
            state = client.set_switch(dev_id, on)
            return self._send_json({"ok": True, "id": dev_id, "state": state})
        except Exception as exc:
            return self._send_json({"ok": False, "error": str(exc)}, 200)

    def _post_hp_refresh(self, body):
        """Force an immediate heat-pump poll. Because the HomeCom energy counter
        is cumulative, one fresh read after an outage recovers all missed kWh:
        the day-splitter backfills the gap onto the right days."""
        hp = getattr(self.ctx, "hp", None)
        if hp is None:
            return self._send_json({"ok": False,
                                    "error": "Wärmepumpe nicht verbunden (im Setup koppeln)."}, 200)
        try:
            hp._poll()
        except Exception as exc:
            return self._send_json({"ok": False,
                                    "error": f"Wärmepumpe nicht erreichbar: {exc}"}, 200)
        st = dict(self.ctx.hp_state)
        return self._send_json({"ok": True, "ts": st.get("ts"),
                                "energy_kwh": st.get("energy_kwh"),
                                "message": "Aktueller Zählerstand gelesen – versäumte Verbräuche nachgeladen."})

    def _post_electrolux_connect(self, body):
        """Save the AEG/Electrolux API key + refresh token, verify them by
        listing appliances, and start the poller."""
        if not electrolux:
            return self._send_json({"ok": False, "error": "Electrolux-Modul fehlt (electrolux.py)."}, 500)
        api_key = str(body.get("api_key") or self.cfg.get("electrolux_api_key") or "").strip()
        refresh = str(body.get("refresh_token") or "").strip()
        access = str(body.get("access_token") or "").strip() or None
        if not api_key or not refresh:
            return self._send_json(
                {"ok": False, "error": "API-Key und Refresh-Token sind erforderlich."}, 400)
        client = electrolux.ElectroluxClient(api_key, refresh, access_token=access)
        try:
            appliances = client.verify()   # forces a token refresh + list
        except electrolux.ElectroluxAuthError as exc:
            return self._send_json({"ok": False, "error": str(exc)}, 200)
        except Exception as exc:
            return self._send_json(
                {"ok": False, "error": f"Verbindung fehlgeschlagen: {exc}"}, 200)
        # persist the possibly-rotated refresh token
        self.cfg["electrolux_api_key"] = api_key
        self.cfg["electrolux_refresh_token"] = client.refresh_token or refresh
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
        for a in appliances:
            self.store.aeg_upsert_appliance(a)
        started = self.ctx.start_electrolux()
        names = ", ".join(a.get("name", a["id"]) for a in appliances) or "keine"
        return self._send_json({"ok": True, "connected": True, "started": started,
                                "appliances": appliances,
                                "message": f"Verbunden. Geräte: {names}."})

    def _post_tibber_connect(self, body):
        """Save + verify a Tibber personal token (real all-in tariff prices)."""
        if not tibber:
            return self._send_json({"ok": False, "error": "Tibber-Modul fehlt (tibber.py)."}, 500)
        token = str(body.get("token") or "").strip()
        if not token:
            return self._send_json({"ok": False, "error": "Tibber-Token ist erforderlich."}, 400)
        try:
            info = tibber.verify(token)
        except tibber.TibberAuthError as exc:
            return self._send_json({"ok": False, "error": str(exc)}, 200)
        except Exception as exc:
            return self._send_json({"ok": False, "error": f"Verbindung fehlgeschlagen: {exc}"}, 200)
        self.cfg["tibber_token"] = token
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
        self.ctx.tibber_cache = None            # force a fresh pull on next read
        return self._send_json({"ok": True, "connected": True, "home": info.get("home"),
                                "message": f"Verbunden mit Tibber ({info.get('home')})."})

    def _post_ha_connect(self, body):
        """Save + verify Home Assistant URL and token, return discovered
        power/energy entities."""
        if not ha:
            return self._send_json({"ok": False, "error": "HA-Modul fehlt (ha_client.py)."}, 500)
        url = str(body.get("url") or "").strip()
        token = str(body.get("token") or "").strip()
        ents = str(body.get("entities") or "").strip()
        if not url or not token:
            return self._send_json({"ok": False, "error": "Adresse und Token sind erforderlich."}, 400)
        try:
            ha.verify(url, token)
            found = ha.fetch(url, token, [e.strip() for e in ents.split(",") if e.strip()] or None)
        except ha.HAAuthError as exc:
            return self._send_json({"ok": False, "error": str(exc)}, 200)
        except Exception as exc:
            return self._send_json({"ok": False, "error": f"Verbindung fehlgeschlagen: {exc}"}, 200)
        self.cfg["ha_url"] = url
        self.cfg["ha_token"] = token
        self.cfg["ha_entities"] = ents
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
        self.ctx.ha_cache = None
        names = ", ".join(e["name"] for e in found.get("entities", [])[:6]) or "keine"
        return self._send_json({"ok": True, "connected": True, "entities": found.get("entities", []),
                                "message": f"Verbunden. Sensoren: {names}."})

    def _post_electrolux_probe(self, body):
        """Diagnostic: dump one appliance's full reported state + energy fields,
        so the exact per-model field names can be inspected."""
        client = self.ctx.electrolux_client()
        if not client:
            return self._send_json({"ok": False, "error": "Nicht verbunden."}, 200)
        try:
            aid = str(body.get("id") or "").strip()
            if not aid:
                apps = client.list_appliances()
                if not apps:
                    return self._send_json({"ok": True, "appliances": [], "probe": None})
                aid = apps[0]["id"]
            return self._send_json({"ok": True, "id": aid, "probe": client.probe(aid)})
        except Exception as exc:
            return self._send_json({"ok": False, "error": str(exc)}, 200)

    def _post_meter(self, body):
        """Add/update a whole-house meter reading (date + total kWh)."""
        try:
            ts = int(body.get("ts"))
            kwh = float(body.get("kwh"))
        except (TypeError, ValueError):
            return self._send_json({"ok": False, "error": "Datum und Zählerstand (kWh) sind erforderlich."}, 400)
        if kwh < 0:
            return self._send_json({"ok": False, "error": "Zählerstand muss ≥ 0 sein."}, 400)
        self.store.meter_upsert(ts, kwh, str(body.get("note") or "")[:120])
        return self._send_json({"ok": True, "readings": self.store.meter_list()})

    def _post_meter_delete(self, body):
        try:
            ts = int(body.get("ts"))
        except (TypeError, ValueError):
            return self._send_json({"ok": False, "error": "ts fehlt."}, 400)
        self.store.meter_delete(ts)
        return self._send_json({"ok": True, "readings": self.store.meter_list()})

    def _post_update(self, body):
        """Pull the latest code (git) and restart the bridge in place.

        For the user's own local bridge on the home network: lets them update
        from the phone app with one tap. Runs `git pull` in the repo, then
        re-execs this process a moment later so the response can still flush.
        """
        if not _is_git_repo():
            return self._send_json(
                {"ok": False, "error": "Kein Git-Repository – Update nur bei einer "
                 "git-Installation möglich. Bitte manuell aktualisieren."}, 200)
        ok, changed, log = _git_pull()
        if not ok:
            return self._send_json({"ok": False, "error": "git pull fehlgeschlagen.",
                                    "output": log}, 200)
        if changed:
            _schedule_restart()
        return self._send_json({
            "ok": True, "changed": changed, "output": log,
            "message": ("Aktualisiert – die Bridge startet neu. Bitte in ein paar "
                        "Sekunden die Seite neu laden." if changed
                        else "Bereits auf dem neuesten Stand.")})

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
                    "hp_import": self.store.hp_history_count(),
                    "auto_update_interval": int(self.cfg.get("auto_update_interval", 0) or 0),
                    "is_git_repo": _is_git_repo(),
                    "electrolux_available": electrolux is not None,
                    "electrolux_connected": bool(self.cfg.get("electrolux_refresh_token")),
                    "electrolux_last_error": self.ctx.ael_state.get("last_error"),
                    "electrolux_last_poll": self.ctx.ael_state.get("last_poll"),
                    "electrolux_count": len(self.store.aeg_appliances()),
                    "electrolux_kwh_per_cycle": float(self.cfg.get("electrolux_kwh_per_cycle", 0.8) or 0.8),
                    "spot_available": spot is not None,
                    "spot_enabled": bool(self.cfg.get("spot_enabled")),
                    "spot_market": self.cfg.get("spot_market", "de"),
                    "spot_surcharge_ct": float(self.cfg.get("spot_surcharge_ct", 15.0) or 0),
                    "spot_vat": float(self.cfg.get("spot_vat", 19.0) or 0),
                    "pvgis_available": pvgis is not None,
                    "weather_available": weather is not None,
                    "carbon_available": carbon is not None,
                    "tibber_available": tibber is not None,
                    "tibber_connected": bool(self.cfg.get("tibber_token")),
                    "ha_available": ha is not None,
                    "ha_connected": bool(self.cfg.get("ha_url") and self.cfg.get("ha_token")),
                    "ha_url": self.cfg.get("ha_url", ""),
                })
            if path == "/api/devices":
                return self._send_json({"devices": self.store.devices()})
            if path == "/api/switches":
                # switchable devices (Bosch Smart Plug+ etc.) with current state
                if self.ctx.mode == "demo":
                    return self._send_json({"ok": True, "demo": True, "switches": [
                        {"id": "demo-plug-1", "name": "Waschmaschine", "room": "Hauswirtschaft", "state": "OFF"},
                        {"id": "demo-plug-2", "name": "Trockner", "room": "Hauswirtschaft", "state": "ON"},
                        {"id": "demo-plug-3", "name": "Kaffeemaschine", "room": "Küche", "state": "OFF"}]})
                if self.ctx.mode != "live":
                    return self._send_json({"ok": False, "error": "nur im Live-Modus verfügbar"}, 400)
                try:
                    client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
                    sw = client.list_switchables(self.cfg.get("device_filter") or None)
                    return self._send_json({"ok": True, "switches": sw})
                except Exception as exc:
                    return self._send_json({"ok": False, "error": str(exc)}, 200)
            if path == "/api/update/check":
                # is a newer version available? (cached git fetch) – drives the
                # "update available" banner so the user can update from the phone
                return self._send_json(_git_update_status("force" in qs))
            if path == "/api/heating/diag":
                # heating efficiency / thermostat-settings diagnostics:
                # room thermostats (SHC) + heat-pump flow/return snapshot (HomeCom)
                hp = self._hp_live()
                cyc = hp_cycle_stats(self.store.hp_samples_since(int(time.time()) - 30 * 86400))
                if self.ctx.mode == "demo":
                    return self._send_json({"demo": True,
                        **compute_heating_diag(_demo_climate(), hp, cyc)})
                if self.ctx.mode != "live":
                    return self._send_json({"ok": False, "error": "nur im Live-Modus verfügbar"}, 400)
                try:
                    client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
                    climate = client.list_climate()
                except Exception as exc:
                    return self._send_json({"ok": False, "error": str(exc)}, 200)
                return self._send_json({"demo": False,
                    **compute_heating_diag(climate, hp, cyc)})
            if path == "/api/heating/curve":
                # the real heating curve (flow vs. outdoor) from logged samples
                # plus the live operating point, with a concrete recommendation
                cd = int(qs.get("days", ["30"])[0])
                return self._send_json({"demo": self.ctx.mode == "demo",
                    **compute_heating_curve(self.store, cd, self._hp_live())})
            if path == "/api/heatpump":
                st = dict(self.ctx.hp_state)
                st["available"] = bool(st) and st.get("energy_kwh") is not None or bool(st.get("last_poll"))
                st["connected"] = bool(self.cfg.get("homecom_refresh_token"))
                return self._send_json(st)
            if path == "/api/appliances":
                return self._send_json(self._appliances_payload())
            if path == "/api/meter":
                return self._send_json({"readings": self.store.meter_list()})
            if path == "/api/spot":
                return self._send_json(self._spot_payload())
            if path == "/api/pvgis":
                return self._send_json(self._pvgis_payload(qs))
            if path == "/api/weather":
                return self._send_json(self._weather_payload(qs))
            if path == "/api/carbon":
                return self._send_json(carbon.payload() if carbon else {"ok": False, "error": "carbon modul fehlt"})
            if path == "/api/tibber":
                data = self.ctx.tibber_prices()
                connected = bool(self.cfg.get("tibber_token")) or self.ctx.mode == "demo"
                return self._send_json({
                    "available": tibber is not None, "connected": connected,
                    "home": (data or {}).get("home"),
                    "count": len((data or {}).get("prices") or []),
                    "last_error": self.ctx.tibber_last_error})
            if path == "/api/ha":
                data = self.ctx.ha_values()
                connected = bool(self.cfg.get("ha_token") and self.cfg.get("ha_url")) or self.ctx.mode == "demo"
                return self._send_json({
                    "available": ha is not None, "connected": connected,
                    "entities": (data or {}).get("entities") or [],
                    "demo": bool((data or {}).get("demo")),
                    "last_error": self.ctx.ha_last_error})
            if path == "/api/tibber/consumption":
                res = (qs.get("resolution", ["DAILY"])[0] or "DAILY")
                last = int(qs.get("last", ["30"])[0])
                if self.ctx.mode == "demo":
                    return self._send_json({"ok": True, "demo": True, **tibber.demo_consumption(res, last)}) if tibber \
                        else self._send_json({"ok": False, "error": "tibber modul fehlt"})
                token = (self.cfg.get("tibber_token") or "").strip()
                if not tibber or not token:
                    return self._send_json({"ok": False, "error": "Nicht mit Tibber verbunden."})
                try:
                    return self._send_json({"ok": True, "demo": False, **tibber.fetch_consumption(token, res, last)})
                except Exception as exc:
                    return self._send_json({"ok": False, "error": f"Tibber-Verbrauch fehlgeschlagen: {exc}"})
            if path == "/api/export.csv":
                ed = int(qs.get("days", ["365"])[0])
                ep = float(qs.get("price", [self.cfg.get("price_per_kwh", 0.35)])[0])
                return self._send_csv(self._export_csv(ed, ep),
                                      filename=f"energie_{time.strftime('%Y-%m-%d')}.csv")
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

    # optional: start the AEG / Electrolux appliance poller if already connected
    if ctx.start_electrolux():
        print("  Appliances:  AEG/Electrolux connected")

    # optional: automatic self-update (git pull + restart when new commits land)
    if _ensure_auto_update(cfg):
        print(f"  Auto-update: on (alle {int(cfg.get('auto_update_interval', 0))} min)")

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
