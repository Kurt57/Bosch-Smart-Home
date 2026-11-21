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
import bisect
import gzip
import hashlib
import http.client
import json
import math
import os
import re
import signal
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
try:
    import fronius  # optional Fronius inverter (local Solar API: PV, battery, smart meter)
except Exception:  # pragma: no cover - keeps the bridge running without it
    fronius = None
try:
    import calendar_ics  # optional calendar feeds (iCloud/Google/.ics) for the dashboard
except Exception:  # pragma: no cover - keeps the bridge running without it
    calendar_ics = None
try:
    import awb_koeln  # optional waste collection dates of the AWB Köln
except Exception:  # pragma: no cover - keeps the bridge running without it
    awb_koeln = None

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
        # Optional Fronius inverter (PV / battery / smart meter) via its local
        # Solar API – address filled in via the web UI ("" = not connected).
        "fronius_host": "",
        "fronius_interval": 15,        # seconds between live readings (stored as 1-min means)
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
            if _RUNTIME is not None:          # never re-exec in the middle of a token refresh
                _RUNTIME.quiesce_tokens()
        except Exception as exc:  # pragma: no cover
            print(f"[update] quiesce: {exc}", file=sys.stderr)
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

    def put(self, path: str, obj: dict) -> int:
        """PUT a service state. Returns the HTTP status (200/204 = ok)."""
        status, data = self._request(
            "PUT", 8444, path, body=json.dumps(obj).encode("utf-8"))
        if status not in (200, 204):
            raise RuntimeError(f"PUT {path} -> HTTP {status}: {data[:200]!r}")
        return status

    def set_room_setpoint(self, rcc_device_id: str, temp: float) -> float:
        """Write a room's target temperature via RoomClimateControl.

        Hard safety clamp to 5–30 °C regardless of caller – this is the only
        place that ever changes a thermostat, so the clamp lives here."""
        if not rcc_device_id:
            raise ValueError("kein RoomClimateControl-Gerät für diesen Raum")
        t = round(max(5.0, min(30.0, float(temp))), 1)
        self.put(f"/smarthome/devices/{rcc_device_id}/services/RoomClimateControl/state",
                 {"@type": "climateControlState", "setpointTemperature": t})
        return t

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

    def read_power_bulk(self) -> dict:
        """{device_id: {power_w, energy_wh, energy_start}} for ALL PowerMeter
        devices in ONE `/smarthome/services` call – avoids one mTLS request per
        device (which, with many devices, made each poll take tens of seconds
        and kept the controller busy for the UI's own requests)."""
        out: dict[str, dict] = {}
        try:
            bulk = self.get("/smarthome/services")
        except Exception:
            return out
        if not isinstance(bulk, list):
            return out
        for s in bulk:
            if not (isinstance(s, dict) and s.get("id") == "PowerMeter" and s.get("deviceId")):
                continue
            st = s.get("state") or {}
            out[s["deviceId"]] = {
                "power_w": float(st.get("powerConsumption", 0.0) or 0.0),
                "energy_wh": float(st.get("energyConsumption", 0.0) or 0.0),
                "energy_start": _parse_start_date(st.get("energyConsumptionStartDate")),
            }
        return out

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
        Reuses list_power_devices' naming/room logic for a consistent label.

        PERF: read ALL PowerSwitch states in ONE bulk `/smarthome/services`
        call instead of one mTLS request per device (which, with many lights,
        meant dozens of sequential TLS handshakes = tens of seconds)."""
        meter = {d["id"]: d for d in self.list_power_devices(name_filter)}
        devices = self.get("/smarthome/devices") or []
        sw_state, have_bulk = {}, False
        try:
            bulk = self.get("/smarthome/services")
            if isinstance(bulk, list):
                have_bulk = True
                for s in bulk:
                    if isinstance(s, dict) and s.get("id") == "PowerSwitch" and s.get("deviceId"):
                        sw_state[s["deviceId"]] = (s.get("state") or {}).get("switchState")
        except Exception:
            pass
        out = []
        for dev in devices:
            if "PowerSwitch" not in (dev.get("deviceServiceIds") or []):
                continue
            dev_id = dev.get("id")
            info = meter.get(dev_id)              # nice name/room if it's also a meter
            name = (info or {}).get("name") or dev.get("name") or dev_id
            room = (info or {}).get("room") or ""
            state = sw_state.get(dev_id)
            if state is None and not have_bulk:   # bulk unavailable → single read (rare)
                state = self.read_switch(dev_id)
            out.append({"id": dev_id, "name": name, "room": room,
                        "model": dev.get("deviceModel") or "",
                        "state": state})
        out.sort(key=lambda d: (d["room"], d["name"]))
        return out

    def list_window_contacts(self, room_map: dict | None = None) -> list[dict]:
        """Door/window contacts (ShutterContact service) with OPEN/CLOSED state.

        ``room_map`` optionally overrides a contact's room (keyed by device id or
        by lower-cased device name) – e.g. to let a front-door contact that sits
        in a hallway/vestibule count for the adjacent living room."""
        room_map = room_map or {}
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
        svc = {}
        try:
            bulk = self.get("/smarthome/services")
        except Exception:
            bulk = None
        if isinstance(bulk, list):
            for s in bulk:
                if isinstance(s, dict) and s.get("id") == "ShutterContact" and s.get("deviceId"):
                    svc[s["deviceId"]] = (s.get("state") or {})
        out = []
        for dev in devices:
            did = dev.get("id")
            if "ShutterContact" not in (dev.get("deviceServiceIds") or []):
                continue
            st = svc.get(did)
            if st is None:
                try:
                    r = self.get(f"/smarthome/devices/{did}/services/ShutterContact")
                    st = (r or {}).get("state", r) or {}
                except Exception:
                    st = {}
            val = str(st.get("value") or "").upper()
            nm = dev.get("name") or did
            shc_room = rooms.get(dev.get("roomId"), "")
            ov = room_map.get(did) or room_map.get(str(nm).lower())
            out.append({"id": did, "name": nm,
                        "room": ov or shc_room, "shc_room": shc_room,
                        "moved": bool(ov),
                        "open": val == "OPEN", "state": val or "UNKNOWN"})
        out.sort(key=lambda d: (d["room"], d["name"]))
        return out

    def climate_raw(self) -> list[dict]:
        """Diagnostic: raw service states of all climate-related devices, so we
        can see exactly which fields a thermostat reports (e.g. a heating-demand
        flag) without guessing. Read-only; used by /api/climate/raw."""
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
        svc = {}
        try:
            bulk = self.get("/smarthome/services")
            if isinstance(bulk, list):
                for s in bulk:
                    if isinstance(s, dict) and s.get("deviceId") and s.get("id"):
                        svc.setdefault(s["deviceId"], {})[s["id"]] = s.get("state") or {}
        except Exception:
            pass
        climate_sids = {"RoomClimateControl", "ValveTappet", "Thermostat",
                        "TemperatureLevel", "TemperatureOffset", "ChildLock"}
        out = []
        for dev in devices:
            sids = set(dev.get("deviceServiceIds") or [])
            if not (climate_sids & sids):
                continue
            out.append({
                "device": dev.get("id"), "model": dev.get("deviceModel") or dev.get("@type"),
                "name": dev.get("name"), "room": rooms.get(dev.get("roomId")) or dev.get("roomId"),
                "serviceIds": sorted(sids),
                "states": svc.get(dev.get("id"), {}),
            })
        return out

    def list_climate(self, room_map: dict | None = None) -> list[dict]:
        """Per-room climate/thermostat snapshot for the heating diagnostics.

        Combines the virtual per-room ``RoomClimateControl`` (setpoint, mode) with
        the physical radiator thermostats' ``ValveTappet`` (valve %), measured
        ``TemperatureLevel`` and ``TemperatureOffset`` – grouped by room. Reads all
        service states in one bulk call where supported, else per device.
        ``room_map`` optionally re-homes a window/door contact to another room
        (keyed by device id or lower-cased name).
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
        # Remember the last good id→name map per controller. If the rooms lookup
        # fails for one poll we reuse it instead of falling back to the raw room
        # id ("hz_3") – that fallback used to log each room a second time under
        # its id, which then showed up as phantom rooms in the analyses.
        cached = _ROOM_NAMES.setdefault(self.ip, {})
        if rooms:
            cached.update({k: v for k, v in rooms.items() if k and v})
        else:
            rooms = dict(cached)

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
                # unnamed = the name could not be resolved and is just the raw id
                "room": name, "unnamed": not rooms.get(room_id),
                "setpoint": None, "temp": None, "valve": None,
                "valves": [], "operationMode": None, "roomControlMode": None,
                "boost": False, "summerMode": False, "low": False, "offset": None,
                "childLock": False, "faults": [], "devices": 0, "rcc_device": None,
                "heating": None, "heating_src": None, "away": False, "humidity": None,
                "windows": [], "windows_open": 0, "air": None, "air_purity": None})

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
                rec["rcc_device"] = did        # device that carries the setpoint (for writes)
                sp = num(rcc, "setpointTemperature")
                if sp is not None:
                    rec["setpoint"] = sp
                rec["operationMode"] = rcc.get("operationMode") or rec["operationMode"]
                rec["roomControlMode"] = rcc.get("roomControlMode") or rec["roomControlMode"]
                rec["boost"] = bool(rcc.get("boostMode")) or rec["boost"]
                rec["summerMode"] = bool(rcc.get("summerMode")) or rec["summerMode"]
                rec["low"] = bool(rcc.get("low")) or rec["low"]
                # Bosch RoomClimateControl reports the real call-for-heat here:
                # hasDemand = the controller's command toward the actuator (true =
                # heizt). This is the authoritative value, better than any guess.
                if isinstance(rcc.get("hasDemand"), bool):
                    rec["heating"] = rcc["hasDemand"]
                    rec["heating_src"] = "gemeldet"
                if isinstance(rcc.get("away"), bool):
                    rec["away"] = rcc["away"]
                # Other controllers may name it differently – try a few as fallback.
                if rec["heating"] is None:
                    for hk in ("heatingDemand", "operationState", "callForHeat", "heating", "valveState"):
                        hv = rcc.get(hk)
                        if isinstance(hv, bool):
                            rec["heating"] = hv; rec["heating_src"] = "gemeldet"
                        elif isinstance(hv, (int, float)):
                            rec["heating"] = hv > 5; rec["heating_src"] = "gemeldet"
                        elif isinstance(hv, str):
                            up = hv.upper()
                            if up in ("HEATING", "ON", "ACTIVE", "OPEN"):
                                rec["heating"] = True; rec["heating_src"] = "gemeldet"
                            elif up in ("IDLE", "OFF", "INACTIVE", "CLOSED"):
                                rec["heating"] = False; rec["heating_src"] = "gemeldet"
            tl = num(st.get("TemperatureLevel") or {}, "temperature")
            if tl is not None:
                # prefer the room-control device's reading; else take any
                if rec["temp"] is None or "RoomClimateControl" in st:
                    rec["temp"] = tl
            vt = num(st.get("ValveTappet") or {}, "position", "value")
            if vt is not None:
                rec["valves"].append(int(round(vt)))
            hum = num(st.get("HumidityLevel") or {}, "humidity")
            if hum is not None:
                rec["humidity"] = round(hum, 1)
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

        # second pass: window/door contacts + air-quality (Twinguard) per room,
        # from the same bulk service snapshot (no extra round-trips). Rooms are
        # matched by roomId to the thermostat records built above – the SHC
        # already carries each contact's/sensor's room, so no manual assignment.
        room_map = room_map or {}
        by_name = {rec["room"]: rec for rec in by_room.values()}
        door_kw = ("haustür", "haustuer", "tür", "tuer", "eingang", "door", "entrance")
        for dev in devices:
            sids = set(dev.get("deviceServiceIds") or [])
            rid = dev.get("roomId")
            rec = by_room.get(rid if rid in by_room else (rooms.get(rid) or rid))
            st = svc.get(dev.get("id"), {})
            if "ShutterContact" in sids:
                did = dev.get("id"); nm = dev.get("name") or ""
                # optional override: re-home this contact to another room
                ov = room_map.get(did) or room_map.get(nm.lower())
                target = by_name.get(ov) if ov else rec
                if target is not None:
                    val = str((st.get("ShutterContact") or {}).get("value") or "").upper()
                    is_door = bool(ov) or any(k in nm.lower() for k in door_kw)
                    target["windows"].append({"name": nm, "open": val == "OPEN",
                                              "door": is_door, "moved": bool(ov)})
            if "AirQualityLevel" in sids and rec is not None:
                aq = st.get("AirQualityLevel") or {}
                rating = str(aq.get("combinedRating") or "").upper() or None
                if rating:
                    rec["air"] = rating                       # GOOD / MEDIUM / BAD
                pur = num(aq, "purity")
                if pur is not None:
                    rec["air_purity"] = int(round(pur))       # VOC-equivalent (ppm)
                # the Twinguard also reports humidity/temperature – fill gaps
                if rec.get("humidity") is None:
                    h2 = num(aq, "humidity") or num(st.get("HumidityLevel") or {}, "humidity")
                    if h2 is not None:
                        rec["humidity"] = round(h2, 1)

        out = []
        for rec in by_room.values():
            rec["windows_open"] = sum(1 for w in rec["windows"] if w.get("open"))
            if rec["valves"]:
                rec["valve"] = max(rec["valves"])   # the most-open valve drives flow demand
            # "heizt gerade?" – from a reported flag if present, else the valve,
            # else inferred like the thermostat itself (Soll > Ist, Heizmodus).
            if rec["heating"] is None:
                if rec["valve"] is not None:
                    rec["heating"] = rec["valve"] > 5
                    rec["heating_src"] = "ventil"
                elif (not rec["summerMode"]
                      and str(rec["roomControlMode"] or "HEATING").upper() != "OFF"
                      and rec["setpoint"] is not None and rec["temp"] is not None):
                    rec["heating"] = rec["temp"] < rec["setpoint"] - 0.1
                    rec["heating_src"] = "abgeleitet"
            out.append(rec)
        out.sort(key=lambda r: r["room"])
        return out


_RAW_ROOM_ID = re.compile(r"^hz_\d+$")      # the SHC's internal room ids
_ROOM_NAMES: dict = {}                      # SHC ip -> {room id: name}, last good lookup


def _loggable_climate(climate: list[dict]) -> list[dict]:
    """The rooms of a thermostat snapshot that should go into the room log:
    heating rooms with a temperature. Rooms whose NAME could not be resolved
    (raw id only) are skipped whenever other rooms in the same snapshot did
    resolve – logging them would create a duplicate room under its id."""
    rows = [r for r in climate
            if str(r.get("roomControlMode") or "HEATING").upper() != "OFF"
            and not r.get("summerMode")
            and isinstance(r.get("temp"), (int, float))]
    if any(not r.get("unnamed") for r in rows):
        rows = [r for r in rows if not r.get("unnamed")]
    return rows


def _drop_stray_rooms(rows: list[dict]) -> list[dict]:
    """Remove "rooms" that are logging artefacts rather than real rooms.

    When the SHC's room-name lookup fails for a single poll, the thermostat
    records fall back to their raw room id (``hz_1`` …) and are logged under
    that name – one stray sample per room, which then surfaces as an extra
    empty room in every per-room analysis. A room is dropped when it holds only
    a sliver of the busiest room's samples AND (its name is a raw SHC id, or it
    has fewer than 3 samples). Real rooms – including ones named by id on
    installations whose names never resolve – carry a full share and stay."""
    if not rows:
        return rows
    counts: dict = {}
    for r in rows:
        counts[r.get("room")] = counts.get(r.get("room"), 0) + 1
    stray = _stray_room_names(counts)
    return [r for r in rows if r.get("room") not in stray] if stray else rows


def _stray_room_names(counts: dict) -> set:
    """The rule behind :func:`_drop_stray_rooms`, on a room -> sample-count map."""
    if not counts:
        return set()
    top = max(counts.values())
    if top < 20:                       # too little data overall to judge
        return set()
    return {rm for rm, n in counts.items()
            if n < max(3, top * 0.02)
            and (n < 3 or (isinstance(rm, str) and _RAW_ROOM_ID.match(rm)))}


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
            for col in ("heat_kwh", "heat_w", "supply_c", "return_c", "flow_lmin", "eheater_kwh", "starts"):
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
            # supply/water temperature per hourly row (for the time-series view)
            hhcols = [r[1] for r in self.conn.execute("PRAGMA table_info(hp_history)")]
            for col in ("supply_c", "water_c"):
                if col not in hhcols:
                    self.conn.execute(f"ALTER TABLE hp_history ADD COLUMN {col} REAL")
            # heating-curve points from an imported CSV: flow temp vs. outdoor
            # during SPACE HEATING hours (the CSV exposes Vorlauftemperatur hourly).
            # Separate from hp_samples so energy/COP analytics stay untouched.
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS hp_curve("
                " ts INTEGER PRIMARY KEY, outdoor_c REAL, supply_c REAL)"
            )
            # indoor room temperature over time, logged from the SHC thermostats
            # (the HomeCom CSV has no room temp) – for the time-series overlay.
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS room_temp("
                " ts INTEGER PRIMARY KEY, temp REAL, setpoint REAL)"
            )
            # window/door contact state changes (open-set), logged on change
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS window_log("
                " ts INTEGER PRIMARY KEY, open_count INTEGER, rooms TEXT)"
            )
            # `doors` records which of the open contacts are DOORS (Haustür etc.),
            # so the chart can mark a door opening differently from a window.
            wlcols = [r[1] for r in self.conn.execute("PRAGMA table_info(window_log)")]
            if "doors" not in wlcols:
                self.conn.execute("ALTER TABLE window_log ADD COLUMN doors TEXT")
            # per-room temperature / setpoint / valve over time (thermostats)
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS room_log("
                " ts INTEGER, room TEXT, temp REAL, setpoint REAL, valve REAL,"
                " PRIMARY KEY(ts,room))"
            )
            self.conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_roomlog ON room_log(ts)"
            )
            # Pre-aggregated statistics per device and LOCAL day (see
            # rollup_ensure). The analytics used to re-read every raw sample of
            # the last 90 days on each request – millions of rows; a finished
            # day never changes, so it is aggregated once and read from here.
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS dev_day("
                " device_id TEXT, day TEXT, ver INTEGER, n INTEGER, wh REAL,"
                " t0 INTEGER, t1 INTEGER, data TEXT, PRIMARY KEY(device_id, day))"
            )
            # hot-water tank temperature + the setpoint it charges to, per
            # heat-pump poll – lets a DHW phase be judged on what the tank did
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS dhw_log("
                " ts INTEGER PRIMARY KEY, temp REAL, setpoint REAL)"
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
            # small key/value store for server-side app state (e.g. the guided
            # observation run anchor for the thermal/hydraulic analysis)
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)"
            )
            # weather per local day (Open-Meteo) for the PV views – kept, so the
            # history grows beyond the 92 days the service returns
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS weather_day(day TEXT PRIMARY KEY, lat REAL, lon REAL,"
                " data TEXT, ts INTEGER)"
            )
            # PV system (Fronius): one row per minute – the mean of the live
            # readings in that minute, plus the counters at its end
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS pv_samples("
                " ts INTEGER PRIMARY KEY, n INTEGER,"
                " pv_w REAL, grid_w REAL, load_w REAL, batt_w REAL, soc REAL, inv_w REAL,"
                " e_total_wh REAL, imp_wh REAL, exp_wh REAL, mpp1_w REAL, mpp2_w REAL,"
                " mpp1_v REAL, mpp2_v REAL, load_max_w REAL, grid_max_w REAL)"
            )
            pvcols = [r[1] for r in self.conn.execute("PRAGMA table_info(pv_samples)")]
            # string voltages (v203): compare the strings and spot a lost module;
            # the highest 15-s reading of the minute (v205): real load peaks
            for col in ("mpp1_v", "mpp2_v", "load_max_w", "grid_max_w"):
                if col not in pvcols:
                    self.conn.execute(f"ALTER TABLE pv_samples ADD COLUMN {col} REAL")
            # hardware product catalog (PV inverters / batteries / all-in-one),
            # seeded from curated datasheets, extensible by the user. `data` holds
            # the full spec document as JSON so the schema stays flexible.
            self.conn.execute(
                "CREATE TABLE IF NOT EXISTS products("
                " id TEXT PRIMARY KEY, brand TEXT, category TEXT, name TEXT,"
                " data TEXT, updated INTEGER)"
            )

    # -- PV system (Fronius) --------------------------------------------- #
    PV_COLS = ("ts", "n", "pv_w", "grid_w", "load_w", "batt_w", "soc", "inv_w",
               "e_total_wh", "imp_wh", "exp_wh", "mpp1_w", "mpp2_w", "mpp1_v", "mpp2_v",
               "load_max_w", "grid_max_w")
    # extra columns of pv_rows_bucketed (after the PV_COLS ones)
    PV_BUCKET_EXTRA = ("imp_w", "exp_w", "ch_w", "dis_w", "gch_w", "vw1", "wv1", "vw2", "wv2",
                       "inv_pos_w", "mpp1_max", "mpp2_max", "pv_max")

    def pv_add(self, row: dict):
        with self.lock, self.conn:
            self.conn.execute(
                f"INSERT OR REPLACE INTO pv_samples({','.join(self.PV_COLS)})"
                f" VALUES({','.join('?' * len(self.PV_COLS))})",
                tuple(row.get(c) for c in self.PV_COLS))

    def pv_add_bulk(self, rows: list[tuple]):
        """rows in PV_COLS order – demo seeding. Shorter rows (written before a
        column was added) get None for the missing columns."""
        n = len(self.PV_COLS)
        rows = [tuple(r) + (None,) * (n - len(r)) if len(r) < n else tuple(r) for r in rows]
        with self.lock, self.conn:
            self.conn.executemany(
                f"INSERT OR REPLACE INTO pv_samples({','.join(self.PV_COLS)})"
                f" VALUES({','.join('?' * n)})", rows)

    def pv_rows(self, since_ts: int, until_ts: int | None = None) -> list[tuple]:
        """Rows (PV_COLS order) with since ≤ ts < until, oldest first."""
        with self.lock:
            if until_ts is None:
                cur = self.conn.execute(
                    f"SELECT {','.join(self.PV_COLS)} FROM pv_samples WHERE ts>=? ORDER BY ts", (since_ts,))
            else:
                cur = self.conn.execute(
                    f"SELECT {','.join(self.PV_COLS)} FROM pv_samples WHERE ts>=? AND ts<? ORDER BY ts",
                    (since_ts, until_ts))
            return [tuple(r) for r in cur.fetchall()]

    def pv_rows_bucketed(self, since_ts: int, until_ts: int, bucket: int = 900) -> list[tuple]:
        """Like pv_rows, but averaged over ``bucket`` seconds by SQLite (for long
        ranges). Columns: PV_COLS order (ts = last row of the bucket, n = rows in
        it) + PV_BUCKET_EXTRA: the separate means of import, export, charge and
        discharge – so the energies stay exact even when the grid flips direction
        inside a bucket –, of the battery's charging from the grid (see
        compute_pv), the string voltages weighted by the string power (only while
        the string produces), the inverter's AC output and the bucket peaks."""
        with self.lock:
            cur = self.conn.execute(
                "SELECT MAX(ts), COUNT(*), AVG(pv_w), AVG(grid_w), AVG(load_w), AVG(batt_w), AVG(soc),"
                " AVG(inv_w), MAX(e_total_wh), MAX(imp_wh), MAX(exp_wh), AVG(mpp1_w), AVG(mpp2_w),"
                " AVG(mpp1_v), AVG(mpp2_v), MAX(load_max_w), MAX(grid_max_w),"
                " AVG(MAX(grid_w, 0)), AVG(MAX(-grid_w, 0)), AVG(MAX(-batt_w, 0)), AVG(MAX(batt_w, 0)),"
                " AVG(CASE WHEN batt_w < 0 AND grid_w > load_w THEN MIN(grid_w - load_w, -batt_w * 1.25)"
                " ELSE 0 END),"
                f" AVG(CASE WHEN mpp1_v IS NOT NULL AND mpp1_w > {PV_STR_MIN_W} THEN mpp1_v * mpp1_w ELSE 0 END),"
                f" AVG(CASE WHEN mpp1_v IS NOT NULL AND mpp1_w > {PV_STR_MIN_W} THEN mpp1_w ELSE 0 END),"
                f" AVG(CASE WHEN mpp2_v IS NOT NULL AND mpp2_w > {PV_STR_MIN_W} THEN mpp2_v * mpp2_w ELSE 0 END),"
                f" AVG(CASE WHEN mpp2_v IS NOT NULL AND mpp2_w > {PV_STR_MIN_W} THEN mpp2_w ELSE 0 END),"
                " AVG(MAX(inv_w, 0)), MAX(mpp1_w), MAX(mpp2_w), MAX(pv_w)"
                " FROM pv_samples WHERE ts>=? AND ts<? GROUP BY (ts - 1) / ? ORDER BY 1",
                (since_ts, until_ts, bucket))
            return [tuple(r) for r in cur.fetchall()]

    def pv_before(self, ts: int) -> tuple | None:
        """The last row before ts (baseline for counters across a window start)."""
        with self.lock:
            r = self.conn.execute(
                f"SELECT {','.join(self.PV_COLS)} FROM pv_samples WHERE ts<? ORDER BY ts DESC LIMIT 1",
                (ts,)).fetchone()
            return tuple(r) if r else None

    def pv_last(self) -> dict | None:
        with self.lock:
            r = self.conn.execute(
                f"SELECT {','.join(self.PV_COLS)} FROM pv_samples ORDER BY ts DESC LIMIT 1").fetchone()
            return dict(zip(self.PV_COLS, tuple(r))) if r else None

    def pv_span(self) -> tuple[int, int, int]:
        """(first ts, last ts, rows) – 0s when empty."""
        with self.lock:
            r = self.conn.execute("SELECT MIN(ts) a, MAX(ts) b, COUNT(*) c FROM pv_samples").fetchone()
            return (int(r["a"] or 0), int(r["b"] or 0), int(r["c"] or 0))

    # -- heat pump ------------------------------------------------------- #
    def add_hp_sample(self, row: dict):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO hp_samples(gateway,ts,energy_kwh,power_w,thermal_kw,"
                "modulation,outdoor_c,heat_kwh,heat_w,mode,supply_c,return_c,flow_lmin,eheater_kwh,starts)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (row.get("gateway"), row["ts"], row.get("energy_kwh"), row.get("power_w"),
                 row.get("thermal_kw"), row.get("modulation"), row.get("outdoor_c"),
                 row.get("heat_kwh"), row.get("heat_w"), row.get("mode"),
                 row.get("supply_c"), row.get("return_c"), row.get("flow_lmin"),
                 row.get("eheater_kwh"), row.get("starts")),
            )

    def hp_last_good_ts(self) -> int | None:
        """Time of the last heat-pump sample that carried real values."""
        with self.lock:
            r = self.conn.execute(
                "SELECT MAX(ts) m FROM hp_samples WHERE energy_kwh IS NOT NULL OR heat_kwh IS NOT NULL"
                " OR supply_c IS NOT NULL OR outdoor_c IS NOT NULL").fetchone()
            return int(r["m"]) if r and r["m"] else None

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
        outdoor_c,heat_kwh,heat_w,mode,supply_c,return_c[,eheater_kwh]) tuples –
        demo seeder / imports."""
        rows = [tuple(r) + (None,) * (13 - len(r)) for r in rows]
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO hp_samples(gateway,ts,energy_kwh,power_w,thermal_kw,"
                "modulation,outdoor_c,heat_kwh,heat_w,mode,supply_c,return_c,eheater_kwh)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    def hp_samples_since(self, since_ts: int) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT * FROM hp_samples WHERE ts>=? ORDER BY ts ASC", (since_ts,))
            return [dict(r) for r in cur.fetchall()]

    def hp_samples_between(self, start_ts: int, end_ts: int) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT * FROM hp_samples WHERE ts>=? AND ts<? ORDER BY ts ASC",
                (start_ts, end_ts))
            return [dict(r) for r in cur.fetchall()]

    def hp_first_ts(self) -> int:
        with self.lock:
            r = self.conn.execute("SELECT MIN(ts) m FROM hp_samples").fetchone()
            return int(r["m"]) if r and r["m"] else 0

    def hp_count(self) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) AS c FROM hp_samples").fetchone()["c"]

    def hp_history(self, period: str) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT * FROM hp_history WHERE period=? ORDER BY date", (period,))
            return [dict(r) for r in cur.fetchall()]

    def hp_history_upsert(self, rows: list[tuple]) -> int:
        """rows: (period,date,elec,heat,heating,water,outdoor,supply,water_temp).
        Replace on conflict."""
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO hp_history(period,date,elec_kwh,heat_kwh,heating_kwh,water_kwh,"
                "outdoor_c,supply_c,water_c)"
                " VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(period,date) DO UPDATE SET"
                " elec_kwh=excluded.elec_kwh, heat_kwh=excluded.heat_kwh,"
                " heating_kwh=excluded.heating_kwh, water_kwh=excluded.water_kwh,"
                " outdoor_c=excluded.outdoor_c, supply_c=excluded.supply_c,"
                " water_c=excluded.water_c", rows)
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

    # -- room temperature (logged from the thermostats) ------------------ #
    def room_temp_add(self, ts: int, temp: float, setpoint=None):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO room_temp(ts,temp,setpoint) VALUES(?,?,?)"
                " ON CONFLICT(ts) DO UPDATE SET temp=excluded.temp,"
                " setpoint=excluded.setpoint", (ts, temp, setpoint))

    def room_temp_add_bulk(self, rows: list[tuple]):
        """rows: (ts, temp, setpoint) – bulk insert of the house-average temp."""
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO room_temp(ts,temp,setpoint) VALUES(?,?,?)"
                " ON CONFLICT(ts) DO UPDATE SET temp=excluded.temp,"
                " setpoint=excluded.setpoint", rows)

    def room_temp_hourly(self, since_ts: int) -> dict:
        """Average logged indoor temp per hour (hour-start ts -> temp)."""
        with self.lock:
            cur = self.conn.execute(
                "SELECT ts,temp FROM room_temp WHERE ts>=? AND temp IS NOT NULL", (since_ts,))
            rows = cur.fetchall()
        buckets = {}
        for r in rows:
            hts = (r["ts"] // 3600) * 3600
            buckets.setdefault(hts, []).append(r["temp"])
        return {h: round(sum(v) / len(v), 1) for h, v in buckets.items()}

    def room_temp_count(self) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) c FROM room_temp").fetchone()["c"]

    def room_temp_series(self, since_ts: int) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT ts,temp FROM room_temp WHERE ts>=? AND temp IS NOT NULL ORDER BY ts ASC",
                (since_ts,))
            return [dict(r) for r in cur.fetchall()]

    def room_log_add_bulk(self, rows: list[tuple]):
        """rows: (ts, room, temp, setpoint, valve)."""
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO room_log(ts,room,temp,setpoint,valve) VALUES(?,?,?,?,?)"
                " ON CONFLICT(ts,room) DO UPDATE SET temp=excluded.temp,"
                " setpoint=excluded.setpoint, valve=excluded.valve", rows)

    def room_log_since(self, since_ts: int, clean: bool = True) -> list[dict]:
        """Per-room thermostat log. With ``clean`` (default) stray rooms are
        dropped – see :func:`_drop_stray_rooms` – so a one-off glitch poll does
        not surface as an extra "room" in every analysis."""
        with self.lock:
            cur = self.conn.execute(
                "SELECT ts,room,temp,setpoint,valve FROM room_log WHERE ts>=? ORDER BY ts ASC",
                (since_ts,))
            rows = [dict(r) for r in cur.fetchall()]
        return _drop_stray_rooms(rows) if clean else rows

    def room_log_counts(self, since_ts: int) -> dict:
        """room -> number of logged samples since ``since_ts`` (unfiltered)."""
        with self.lock:
            cur = self.conn.execute(
                "SELECT room, COUNT(*) AS n FROM room_log WHERE ts>=? GROUP BY room", (since_ts,))
            return {r["room"]: int(r["n"]) for r in cur.fetchall()}

    def room_setpoint_modes(self, since_ts: int, max_sp: float = 24.5) -> dict:
        """room -> the setpoint that was in effect most often by day (8–22 h)
        since ``since_ts``, ignoring cranked-up values above ``max_sp``. Used to
        recover a room's normal comfort setpoint while the thermostats are
        deliberately opened up for balancing."""
        with self.lock:
            cur = self.conn.execute(
                "SELECT room, ROUND(setpoint*2)/2.0 AS sp, COUNT(*) AS n FROM room_log"
                " WHERE ts>=? AND setpoint IS NOT NULL AND setpoint<=?"
                " AND CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) BETWEEN 8 AND 21"
                " GROUP BY room, sp", (since_ts, max_sp))
            best: dict = {}
            for r in cur.fetchall():
                rm, sp, n = r["room"], r["sp"], r["n"]
                if sp is None:
                    continue
                if rm not in best or n > best[rm][1]:
                    best[rm] = (float(sp), int(n))
        return {rm: v[0] for rm, v in best.items() if v[1] >= 6}

    # -- hot-water tank log ---------------------------------------------- #
    def dhw_log_add(self, ts: int, temp, setpoint=None):
        if temp is None:
            return
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT OR REPLACE INTO dhw_log(ts,temp,setpoint) VALUES(?,?,?)",
                (int(ts), float(temp), float(setpoint) if setpoint is not None else None))

    def dhw_log_add_bulk(self, rows: list[tuple]):
        """rows: (ts, temp, setpoint) – demo/test seeding."""
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT OR REPLACE INTO dhw_log(ts,temp,setpoint) VALUES(?,?,?)", rows)

    def dhw_log_since(self, since_ts: int) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT ts,temp,setpoint FROM dhw_log WHERE ts>=? AND temp IS NOT NULL"
                " ORDER BY ts ASC", (since_ts,))
            return [dict(r) for r in cur.fetchall()]

    def room_log_count(self) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) c FROM room_log").fetchone()["c"]

    def room_log_last_ts(self) -> int:
        with self.lock:
            r = self.conn.execute("SELECT MAX(ts) m FROM room_log").fetchone()
            return int(r["m"]) if r and r["m"] else 0

    def room_temp_at(self, ts: int, tol: int = 1800):
        """Logged indoor temp nearest to ts (within tol seconds), or None."""
        with self.lock:
            r = self.conn.execute(
                "SELECT temp FROM room_temp WHERE temp IS NOT NULL AND ABS(ts-?)<=?"
                " ORDER BY ABS(ts-?) LIMIT 1", (ts, tol, ts)).fetchone()
            return r["temp"] if r else None

    # -- window/door contacts -------------------------------------------- #
    def window_log_add(self, ts: int, open_count: int, rooms: str, doors: str = ""):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO window_log(ts,open_count,rooms,doors) VALUES(?,?,?,?)"
                " ON CONFLICT(ts) DO UPDATE SET open_count=excluded.open_count,"
                " rooms=excluded.rooms, doors=excluded.doors", (ts, open_count, rooms, doors))

    def window_log_since(self, since_ts: int) -> list[dict]:
        with self.lock:
            cur = self.conn.execute(
                "SELECT ts,open_count,rooms,doors FROM window_log WHERE ts>=? ORDER BY ts ASC",
                (since_ts,))
            return [dict(r) for r in cur.fetchall()]

    def window_log_last(self):
        with self.lock:
            r = self.conn.execute(
                "SELECT ts,open_count,rooms FROM window_log ORDER BY ts DESC LIMIT 1").fetchone()
            return dict(r) if r else None

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

    # -- hardware product catalog ---------------------------------------- #
    def product_upsert(self, p: dict):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO products(id,brand,category,name,data,updated)"
                " VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET"
                " brand=excluded.brand, category=excluded.category,"
                " name=excluded.name, data=excluded.data, updated=excluded.updated",
                (p["id"], p.get("brand", ""), p.get("category", ""), p.get("name", ""),
                 json.dumps(p, ensure_ascii=False), int(time.time())))

    def products_list(self) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(
                "SELECT data FROM products ORDER BY category, brand, name").fetchall()
        out = []
        for r in rows:
            try:
                out.append(json.loads(r["data"]))
            except Exception:
                pass
        return out

    def product_delete(self, pid: str):
        with self.lock, self.conn:
            self.conn.execute("DELETE FROM products WHERE id=?", (str(pid),))

    # -- weather per day (PV views) -------------------------------------- #
    def wx_put(self, rows: list[dict], lat: float, lon: float):
        now = int(time.time())
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT INTO weather_day(day,lat,lon,data,ts) VALUES(?,?,?,?,?)"
                " ON CONFLICT(day) DO UPDATE SET lat=excluded.lat, lon=excluded.lon,"
                " data=excluded.data, ts=excluded.ts",
                [(r["day"], lat, lon, json.dumps(r, separators=(",", ":")), now) for r in rows if r.get("day")])

    def wx_days(self, first_day: str, last_day: str, lat: float, lon: float) -> list[dict]:
        """Stored days in [first, last] for (about) this location – another
        location (moved, typo fixed) does not mix in."""
        with self.lock:
            cur = self.conn.execute(
                "SELECT data FROM weather_day WHERE day>=? AND day<=? AND ABS(lat-?)<0.05 AND ABS(lon-?)<0.05"
                " ORDER BY day", (first_day, last_day, lat, lon))
            out = []
            for r in cur.fetchall():
                try:
                    out.append(json.loads(r["data"]))
                except ValueError:
                    pass
            return out

    # -- generic key/value app state ------------------------------------- #
    def kv_get(self, key: str):
        with self.lock:
            r = self.conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
            return r["value"] if r else None

    def kv_set(self, key: str, value: str):
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO kv(key,value) VALUES(?,?)"
                " ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def kv_del(self, key: str):
        with self.lock, self.conn:
            self.conn.execute("DELETE FROM kv WHERE key=?", (key,))

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
        for a meter-based average when no install date is reported. Reads the
        first and last row per device through the index (a GROUP BY over the
        whole table took a quarter of a second on a grown database)."""
        ids = self.sample_device_ids()
        if not ids:
            return None
        growth, t0s, t1s = 0.0, [], []
        with self.lock:
            for d in ids:
                a = self.conn.execute(
                    "SELECT ts, energy_wh FROM samples WHERE device_id=? ORDER BY ts ASC LIMIT 1",
                    (d,)).fetchone()
                b = self.conn.execute(
                    "SELECT ts, energy_wh FROM samples WHERE device_id=? ORDER BY ts DESC LIMIT 1",
                    (d,)).fetchone()
                if not a or not b:
                    continue
                t0s.append(a["ts"]); t1s.append(b["ts"])
                if b["energy_wh"] >= a["energy_wh"]:
                    growth += b["energy_wh"] - a["energy_wh"]
        if not t0s or max(t1s) <= min(t0s):
            return None
        return {"t0": min(t0s), "t1": max(t1s), "growth_wh": growth}

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

    def samples_range(self, device_id: str, t0: int, t1: int) -> list[tuple]:
        """(ts, power_w, energy_wh) of ONE device with t0 <= ts < t1, time-ordered.
        Always filtered by device, so it runs on the (device_id, ts) index – a
        plain "ts >= ?" over all devices would scan the whole table."""
        with self.lock:
            cur = self.conn.execute(
                "SELECT ts,power_w,energy_wh FROM samples"
                " WHERE device_id=? AND ts>=? AND ts<? ORDER BY ts ASC",
                (device_id, int(t0), int(t1)))
            return [(r[0], r[1], r[2]) for r in cur.fetchall()]

    def sample_device_ids(self) -> list[str]:
        """Every device id that has samples – via an index skip-scan (a plain
        SELECT DISTINCT walks the whole index)."""
        with self.lock:
            cur = self.conn.execute(
                "WITH RECURSIVE t(d) AS ("
                " SELECT MIN(device_id) FROM samples"
                " UNION ALL"
                " SELECT (SELECT MIN(device_id) FROM samples WHERE device_id > t.d)"
                " FROM t WHERE t.d IS NOT NULL)"
                " SELECT d FROM t WHERE d IS NOT NULL")
            return [r[0] for r in cur.fetchall()]

    def dev_first_ts(self, device_id: str) -> int | None:
        with self.lock:
            r = self.conn.execute(
                "SELECT MIN(ts) AS m FROM samples WHERE device_id=?", (device_id,)).fetchone()
            return int(r["m"]) if r and r["m"] is not None else None

    def dev_day_keys(self, first_day: str, ver: int) -> set:
        """(device_id, day) pairs that already have a current-version row."""
        with self.lock:
            cur = self.conn.execute(
                "SELECT device_id, day FROM dev_day WHERE day>=? AND ver=?", (first_day, ver))
            return {(r[0], r[1]) for r in cur.fetchall()}

    def dev_day_rows(self, first_day: str, ver: int) -> list[tuple]:
        """(device_id, day, n, wh, t0, t1, data-json) for day >= first_day."""
        with self.lock:
            cur = self.conn.execute(
                "SELECT device_id, day, n, wh, t0, t1, data FROM dev_day"
                " WHERE day>=? AND ver=? AND n>0 ORDER BY day ASC", (first_day, ver))
            return [tuple(r) for r in cur.fetchall()]

    def dev_day_put(self, rows: list[tuple]):
        """rows: (device_id, day, ver, n, wh, t0, t1, data-json)."""
        with self.lock, self.conn:
            self.conn.executemany(
                "INSERT OR REPLACE INTO dev_day(device_id,day,ver,n,wh,t0,t1,data)"
                " VALUES(?,?,?,?,?,?,?,?)", rows)

    def dev_day_count(self) -> int:
        with self.lock:
            return self.conn.execute("SELECT COUNT(*) c FROM dev_day").fetchone()["c"]

    def min_ts(self) -> int | None:
        """Time of the very first sample – per device through the index (a
        plain MIN(ts) scans every row, ~0.1 s on a grown database)."""
        vals = [self.dev_first_ts(d) for d in self.sample_device_ids()]
        vals = [v for v in vals if v is not None]
        return min(vals) if vals else None

    def count_fast(self) -> int:
        """Number of samples, read off the highest row id (rows are never
        deleted, so this equals COUNT(*) without walking the table)."""
        with self.lock:
            r = self.conn.execute("SELECT MAX(rowid) AS m FROM samples").fetchone()
            return int(r["m"]) if r and r["m"] is not None else 0

    def count(self) -> int:
        with self.lock:
            cur = self.conn.execute("SELECT COUNT(*) AS c FROM samples")
            return cur.fetchone()["c"]


# --------------------------------------------------------------------------- #
# Analytics – turn raw samples into the numbers the UI shows
# --------------------------------------------------------------------------- #
def _local_day(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def _local_midnight(ts: int) -> int:
    """Epoch of local midnight (00:00) of the day containing ts."""
    d = datetime.fromtimestamp(ts).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(d.timestamp())


# A 16 A Schuko plug tops out near 3680 W; a measured interval implying a much
# higher average power is a counter artefact (a device that was offline and then
# reports a counter that jumped by many days' worth of energy at once), not real
# consumption. Deltas above this per-hour rate are not trusted.
MAX_PLUG_W = 3800.0
# Beyond this gap between two consecutive samples the device (or the bridge) was
# offline; a counter jump across it belongs to the offline period, not to the
# bucket where the device reappears, so we never attribute it here.
MAX_SAMPLE_GAP_H = 2.0


def _counter_delta_ok(d: float, dt_h: float) -> bool:
    """A cumulative-counter delta is trusted only when the interval is short and
    the implied average power is physically plausible for a plug."""
    return 0.0 <= d <= MAX_PLUG_W * dt_h * 1.1 and 0.0 < dt_h <= MAX_SAMPLE_GAP_H


def _energy_for_bucket(samples: list[dict]) -> float:
    """Energy (Wh) for a list of samples of ONE device, time-ordered.

    Sums the cumulative energy-counter deltas over CONSECUTIVE samples, but
    trusts each delta only when the interval is short and the implied power is
    plausible (see _counter_delta_ok). A counter that jumps after the device was
    unreachable — or resets on a power-cycle — would otherwise dump many days of
    energy onto the single day the device reappears (and then be counted again),
    which is exactly the "whole total shows up as today" artefact. When the
    counter is flat/unavailable (a module that reports only power), we integrate
    the measured power instead. Implausible jumps and long offline gaps
    contribute nothing rather than a false spike.
    """
    if len(samples) < 2:
        return 0.0
    live_counter = (samples[-1]["energy_wh"] - samples[0]["energy_wh"]) > 0.5
    wh = 0.0
    for a, b in zip(samples, samples[1:]):
        dt_h = (b["ts"] - a["ts"]) / 3600.0
        if dt_h <= 0 or dt_h > MAX_SAMPLE_GAP_H:   # offline gap → unknown, skip
            continue
        if live_counter:
            d = b["energy_wh"] - a["energy_wh"]
            if _counter_delta_ok(d, dt_h):
                wh += d                            # trusted counter delta
            # else: reset / implausible jump → skip (don't dump it onto this day)
        else:                                      # counter dead → integrate power
            pa = min(max(a["power_w"] or 0.0, 0.0), MAX_PLUG_W)
            pb = min(max(b["power_w"] or 0.0, 0.0), MAX_PLUG_W)
            wh += (pa + pb) / 2.0 * dt_h
    return wh


# --------------------------------------------------------------------------- #
# Hardware product catalog – curated from the manufacturer datasheets the user
# supplied (Fronius Symo GEN24 Plus, Fronius Reserva, GoodWe ESA). Seeded into
# the `products` table so the app "has it in the database" and can be extended.
# All figures are from the datasheets; prices are left out (not on the sheets).
# --------------------------------------------------------------------------- #
PRODUCT_CATALOG = [
    {
        "id": "fronius_gen24_plus",
        "brand": "Fronius",
        "category": "hybrid_inverter",       # Wechselrichter mit Batterie-Anschluss
        "name": "Fronius Symo GEN24 Plus",
        "origin": "Österreich (Europa)",
        "phases": 3,
        "coupling": "DC",
        "needs_separate_battery": True,
        "controllable": 5,                   # 1..5 – how well THIS app can read/steer it
        "local_api": ["Fronius Solar API (JSON, lokal)", "Modbus TCP SunSpec", "Modbus RTU SunSpec"],
        "ohmpilot": True,                     # steuert Heizstab/Warmwasser mit Überschuss
        "smart_meter": "Fronius Smart Meter (separat)",
        "built_in_ems": False,
        "backup": "full_optional",            # Full Backup (ganzes Haus) ab 6 kW + Zusatzkomponenten
        "backup_switch_s": 10.0,
        "efficiency_max_pct": 98.3,
        "warranty_years": 10,                 # nach Produktregistrierung
        "night_w": 10,
        "compatible_batteries": ["Fronius Reserva", "BYD Battery-Box HVS/HVM", "LG FLEX"],
        "variants": [
            {"model": "GEN24 6.0 Plus", "ac_kw": 6.0, "pv_max_wp": 9000, "batt_kw": 6.0, "mppt": 2, "full_backup": True, "weight_kg": 22.8},
            {"model": "GEN24 8.0 Plus", "ac_kw": 8.0, "pv_max_wp": 12000, "batt_kw": 8.0, "mppt": 2, "full_backup": True, "weight_kg": 22.8},
            {"model": "GEN24 10.0 Plus", "ac_kw": 10.0, "pv_max_wp": 15000, "batt_kw": 10.0, "mppt": 2, "full_backup": True, "weight_kg": 22.8},
            {"model": "GEN24 12.0 Plus", "ac_kw": 12.0, "pv_max_wp": 18000, "batt_kw": 11.7, "mppt": 2, "full_backup": True, "weight_kg": 22.8},
        ],
        "summary": "Hybrid-Wechselrichter: das „Herz\" der Anlage, das zusätzlich eine Batterie laden/entladen kann. Offene lokale Schnittstellen (Solar-API + Modbus) – ideal, wenn diese App der Energiemanager sein soll. Braucht eine separate Batterie.",
    },
    {
        "id": "fronius_reserva",
        "brand": "Fronius",
        "category": "battery",
        "name": "Fronius Reserva",
        "origin": "Europa (Fronius)",
        "chemistry": "LFP (Lithium-Eisenphosphat)",
        "coupling": "DC (Hochvolt)",
        "controllable": 5,                    # über den GEN24-Wechselrichter
        "max_current_a": 32,
        "warranty_years": 10,
        "parallel_max": 4,
        "compatible_inverters": ["Fronius Symo GEN24 Plus"],
        "variants": [
            {"model": "Reserva 6.3", "usable_kwh": 6.31, "modules": 2, "weight_kg": 86.5, "height_mm": 860},
            {"model": "Reserva 9.5", "usable_kwh": 9.47, "modules": 3, "weight_kg": 120.0, "height_mm": 1100},
            {"model": "Reserva 12.6", "usable_kwh": 12.63, "modules": 4, "weight_kg": 153.5, "height_mm": 1360},
            {"model": "Reserva 15.8", "usable_kwh": 15.79, "modules": 5, "weight_kg": 187.0, "height_mm": 1610},
        ],
        "summary": "DC-gekoppelter Hochvolt-Speicher, der nur an den Fronius GEN24 Plus passt. 2–5 Module (≈3,15 kWh je Modul), 10 Jahre Garantie, europäischer Service.",
    },
    {
        "id": "goodwe_esa",
        "brand": "GoodWe",
        "category": "all_in_one",             # Wechselrichter + Batterie + Energiemanager in einem
        "name": "GoodWe ESA-Serie (All-in-One)",
        "origin": "China (GoodWe)",
        "chemistry": "LFP (Lithium-Eisenphosphat)",
        "coupling": "DC + AC (Hybrid)",
        "phases": 3,
        "needs_separate_battery": False,
        "controllable": 3,                    # Modbus-TCP lokal, aber eigener EMS dazwischen
        "local_api": ["Modbus-TCP", "Modbus-RTU"],
        "built_in_ems": True,                 # KI-Energiemanagement
        "dynamic_tariff_builtin": True,       # dynamische Tarifoptimierung ab Werk
        "backup": "whole_home",               # Whole-Home Backup (Dual-Port)
        "backup_switch_s": 0.004,             # <4 ms
        "efficiency_max_pct": 98.2,
        "heating_to_c": -20,
        "battery_module_kwh": [5.0, 8.0],     # nutzbar je Modul (GW5.1 / GW8.3)
        "battery_modules_max": 12,
        "battery_max_kwh": 108,
        "inverter_kw_range": [5, 30],
        "warranty_years": 10,
        "variants": [
            {"model": "ESA GW6K + 10 kWh", "ac_kw": 6.0, "batt_kwh": 10.0, "modules": "2× 5 kWh"},
            {"model": "ESA GW8K + 16 kWh", "ac_kw": 8.0, "batt_kwh": 16.0, "modules": "2× 8 kWh"},
            {"model": "ESA GW10K + 20 kWh", "ac_kw": 10.0, "batt_kwh": 20.0, "modules": "4× 5 kWh"},
            {"model": "ESA GW15K + 24 kWh", "ac_kw": 15.0, "batt_kwh": 24.0, "modules": "3× 8 kWh"},
        ],
        "summary": "Alles in einem Gerät (Wechselrichter + Batterie + Energiemanager), sehr groß ausbaubar (bis 108 kWh / 30 kW), eingebaute KI-Optimierung für dynamische Tarife und blitzschnelles Notstrom-Umschalten (<4 ms). Weniger offen für eine eigene App-Steuerung als Fronius.",
    },
]

PRODUCT_GLOSSARY = [
    ("Wechselrichter", "Wandelt den Gleichstrom (DC) der Solarmodule in normalen Haushaltsstrom (AC, 230 V) um – das Herzstück jeder PV-Anlage."),
    ("Hybrid-Wechselrichter", "Ein Wechselrichter, der zusätzlich eine Batterie laden und entladen kann. Ohne „Hybrid\" bräuchtest du später ein zweites Gerät für den Speicher."),
    ("All-in-One", "Wechselrichter + Batterie + Energiemanager stecken in einem Gerät. Vorteil: weniger Einzelteile, schneller installiert, oft günstiger."),
    ("kWp (Kilowatt-Peak)", "Die Spitzenleistung der Solarmodule bei vollem Sonnenschein. Faustregel Deutschland: 1 kWp bringt ~900–1000 kWh Strom pro Jahr."),
    ("kWh Speicher", "Wie viel Strom die Batterie speichert. Grob: 1 kWh ≈ eine Waschmaschinen-Ladung oder ein halber Tag Kühlschrank + Router + Licht."),
    ("DC-/AC-gekoppelt", "DC-gekoppelt = Batterie hängt direkt am Solarstrom, minimal effizienter. AC-gekoppelt = Batterie hängt am Hausnetz, dafür flexibler nachrüstbar."),
    ("LFP", "Lithium-Eisenphosphat – die sicherste und langlebigste Akku-Art fürs Haus (kein Kobalt, sehr schwer entflammbar)."),
    ("MPP-Tracker", "Ein Eingang für eine Modulgruppe. Mehr Tracker = du kannst Dachflächen mit unterschiedlicher Ausrichtung (z. B. Ost + West) getrennt optimal nutzen."),
    ("Notstrom / Backup", "Versorgt dich bei Stromausfall weiter. „Whole-Home / Full Backup\" = ganzes Haus, „PV Point\" = nur eine Notsteckdose bei Sonne."),
    ("Umschaltzeit", "Wie schnell bei Stromausfall auf Batterie umgeschaltet wird. Unter 10 ms merkst du gar nichts; Sekunden = kurzes Flackern/PC aus."),
    ("Smart Meter", "Misst den Strom am Hausanschluss. Nötig, damit die Anlage genau weiß, wie viel Überschuss da ist – sonst verschenkt sie Strom oder zieht unnötig aus dem Netz."),
    ("Dynamischer Tarif", "Strompreis ändert sich stündlich mit der Börse. Ein guter Energiemanager lädt/entlädt die Batterie so, dass du günstig kaufst und teuer vermeidest (oder verkaufst)."),
    ("Modbus / Solar-API", "Offene „Sprachen\", über die ein Gerät lokal Messwerte herausgibt und Befehle annimmt. Je offener, desto besser kann DIESE App der Energiemanager sein."),
]


def seed_products(store: "Store"):
    """Upsert the curated hardware catalog into the DB (idempotent)."""
    for p in PRODUCT_CATALOG:
        store.product_upsert(p)


def _meter_daily_kwh(store: "Store") -> dict | None:
    """Whole-house TOTAL daily kWh (incl. heat pump) from the manual meter
    readings – cumulative counter values in kWh at timestamps. Uses the growth
    from the first to the last reading / the span, matching the frontend's
    meterStats(). Returns {daily_kwh, span_days, first_ts, last_ts} or None."""
    rows = [r for r in store.meter_list()
            if r.get("kwh") is not None and r.get("ts")]
    if len(rows) < 2:
        return None
    rows.sort(key=lambda r: r["ts"])
    first, last = rows[0], rows[-1]
    span = (last["ts"] - first["ts"]) / 86400.0
    if span <= 0 or last["kwh"] < first["kwh"]:
        return None
    return {"daily_kwh": (last["kwh"] - first["kwh"]) / span, "span_days": span,
            "first_ts": first["ts"], "last_ts": last["ts"]}


def compute_dhw_impact(store: "Store", days: float = 14, hp_live: dict | None = None) -> dict:
    """Comfort cost of hot-water (DHW) priority: while the heat pump makes warm
    water, space heating pauses and the house cools. This correlates the HP's
    DHW phases (HomeCom `mode`) with the measured average indoor temperature
    (Bosch thermostats) and, per DHW phase, measures:
      • how far the indoor temperature fell (T at DHW-start − lowest point), and
      • how long after heating resumed it took to climb back to the T at
        DHW-start ("warm again").
    Aggregated over the window, plus one representative phase for a chart."""
    now = int(time.time())
    days = max(1.0, min(60.0, float(days)))
    since = int(now - days * 86400)
    temp = [(int(r["ts"]), float(r["temp"])) for r in store.room_temp_series(since)
            if r.get("temp") is not None]
    if len(temp) < 6:
        return {"ok": True, "n": 0, "reason": "no_temp", "days": days}
    temp.sort()
    tts = [t for t, _ in temp]
    tvs = [v for _, v in temp]

    def temp_at(ts, maxgap=2 * 3600):
        """Linear interpolation on the indoor-temp series (None if no reading
        within maxgap on both sides)."""
        i = bisect.bisect_left(tts, ts)
        if i <= 0:
            return tvs[0] if abs(tts[0] - ts) <= maxgap else None
        if i >= len(tts):
            return tvs[-1] if abs(tts[-1] - ts) <= maxgap else None
        t0, t1, v0, v1 = tts[i - 1], tts[i], tvs[i - 1], tvs[i]
        if (ts - t0) > maxgap and (t1 - ts) > maxgap:
            return None
        return v0 if t1 == t0 else v0 + (v1 - v0) * (ts - t0) / (t1 - t0)

    hp = sorted((s for s in store.hp_samples_since(since) if s.get("ts")),
                key=lambda s: s["ts"])

    def is_dhw(s):
        m = (s.get("mode") or "").lower()
        return "dhw" in m or "water" in m or "ww" in m or "warm" in m

    # contiguous DHW runs, then merge runs split by a short non-DHW gap (<20 min)
    runs, i, n = [], 0, len(hp)
    while i < n:
        if is_dhw(hp[i]):
            j, outs = i, []
            while j < n and is_dhw(hp[j]):
                if hp[j].get("outdoor_c") is not None:
                    outs.append(float(hp[j]["outdoor_c"]))
                j += 1
            runs.append([hp[i]["ts"], hp[j - 1]["ts"], outs])
            i = j
        else:
            i += 1
    MERGE = 20 * 60
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] <= MERGE:
            merged[-1][1] = r[1]
            merged[-1][2] += r[2]
        else:
            merged.append(r[:])

    # A DHW dip only "costs comfort" if the house measurably cooled AND there
    # was a fair chance for the heating to catch back up. Each phase gets a
    # `status`: minimal / recovered / tight / open.
    #   • minimal  (< MIN_DROP): nothing to recover — don't alarm.
    #   • recovered: dipped, then climbed back to the start temp.
    #   • tight    : didn't climb back, but the HEATING WINDOW before the next
    #                DHW phase was too short to expect it (WW phases back-to-back
    #                with little heating in between). Not alarming — expected.
    #   • open     : real dip, had enough heating time afterwards, still didn't
    #                climb back → the genuinely interesting case.
    # No assumption about night-setback etc.: the discriminator is the measured
    # heating gap (`heat_min`), i.e. how long the heating actually ran before
    # the next warm-water phase interrupted it.
    MIN_DROP = 0.15          # °C — below this the dip is practically nothing
    REC_TOL = 0.1            # °C — "warm again" tolerance back to the start temp
    SHORT_HEAT = 45          # min — below this the heating window is "too short"
    events = []
    for k, (st, en, outs) in enumerate(merged):
        if en - st < 600:                         # ignore <10-min blips
            continue
        t_start = temp_at(st)
        if t_start is None:
            continue
        nxt = merged[k + 1][0] if k + 1 < len(merged) else now
        # heating window after this DHW phase, before the next DHW phase starts
        heat_min = round((min(nxt, now) - en) / 60.0)
        # the low point is during DHW + up to 1 h lag; the climb-back gets up to
        # 2 h, but never past the next DHW phase (that's the whole point).
        dip_end = min(en + 3600, nxt, now)
        rec_end = min(en + 7200, nxt, now)
        dip_pts = [(t, v) for t, v in temp if st <= t <= dip_end]
        if len(dip_pts) < 2:
            continue
        t_min_v = min(v for _, v in dip_pts)
        t_min_ts = min(t for t, v in dip_pts if v == t_min_v)
        drop = max(0.0, t_start - t_min_v)
        rec_ts = None                             # first return to the start temp
        for t, v in temp:
            if t < max(en, t_min_ts):
                continue
            if t > rec_end:
                break
            if v >= t_start - REC_TOL:
                rec_ts = t
                break
        if drop < MIN_DROP:
            status = "minimal"                    # WW barely cost any comfort
        elif rec_ts is not None:
            status = "recovered"                  # dipped, then heating caught up
        elif heat_min < SHORT_HEAT:
            status = "tight"                      # next WW too soon — no heat time
        else:
            status = "open"                       # had the time, still not back
        out_avg = round(sum(outs) / len(outs), 1) if outs else None
        events.append({
            "start": st, "end": en, "rec_ts": rec_ts,
            "dur_min": round((en - st) / 60.0), "heat_min": heat_min,
            "t_start": round(t_start, 1), "t_min": round(t_min_v, 1),
            "drop": round(drop, 2),
            # a negligible dip has nothing to "recover", so it contributes no
            # recovery time to the stats (it would otherwise log a bogus 0 min)
            "recov_min": (round((rec_ts - en) / 60.0) if (rec_ts and status != "minimal") else None),
            "outdoor": out_avg, "recovered": rec_ts is not None and status != "minimal",
            "status": status,
        })

    if not events:
        return {"ok": True, "n": 0, "reason": "no_dhw", "days": days,
                "n_dhw_total": len(merged), "temp_points": len(temp)}

    drops = [e["drop"] for e in events]
    recs = [e["recov_min"] for e in events if e["recov_min"] is not None]
    meaningful = [e for e in events if e["status"] != "minimal"]
    expectable = [e for e in events if e["status"] in ("recovered", "open")]
    n_minimal = sum(1 for e in events if e["status"] == "minimal")
    n_tight = sum(1 for e in events if e["status"] == "tight")
    n_open = sum(1 for e in events if e["status"] == "open")
    n_recovered = sum(1 for e in events if e["status"] == "recovered")
    # how packed are the WW phases? heating window between consecutive phases
    heat_gaps = sorted(e["heat_min"] for e in events if e["heat_min"] is not None)
    med_heat_min = heat_gaps[len(heat_gaps) // 2] if heat_gaps else None

    def med(a):
        a = sorted(a)
        return a[len(a) // 2] if a else None

    # drop vs. outdoor temperature (colder outside → bigger dip / slower recovery)
    buckets = [("kalt (< 3 °C)", -99, 3), ("3–8 °C", 3, 8),
               ("8–13 °C", 8, 13), ("mild (≥ 13 °C)", 13, 99)]
    by_out = []
    for lbl, lo, hi in buckets:
        es = [e for e in events if e["outdoor"] is not None and lo <= e["outdoor"] < hi]
        if es:
            rs = [e["recov_min"] for e in es if e["recov_min"] is not None]
            by_out.append({"label": lbl, "n": len(es),
                           "avg_drop": round(sum(d["drop"] for d in es) / len(es), 2),
                           "avg_recov_min": (round(sum(rs) / len(rs)) if rs else None)})

    # --- day-part breakdown + concrete "Hebel" (levers) --------------------- #
    def hod(ts):
        return datetime.fromtimestamp(ts).hour

    dayparts = []
    for lbl, lo, hi in [("früh/Nacht (0–8 Uhr)", 0, 9), ("Mittag (9–16 Uhr)", 9, 17),
                        ("Abend (17–23 Uhr)", 17, 24)]:
        es = [e for e in events if lo <= hod(e["start"]) < hi]
        if es:
            rs = [e["recov_min"] for e in es if e["recov_min"] is not None]
            dayparts.append({"label": lbl, "n": len(es),
                             "avg_drop": round(sum(e["drop"] for e in es) / len(es), 2),
                             "avg_recov_min": (round(sum(rs) / len(rs)) if rs else None)})

    levers = []
    overall_drop = sum(drops) / len(drops)
    timing_added = False
    # Lever 1 — timing: colder outside = bigger dip; move DHW to the warm midday
    if len(by_out) >= 2:
        warm = min(by_out, key=lambda b: b["avg_drop"])
        cold = max(by_out, key=lambda b: b["avg_drop"])
        gain = round(cold["avg_drop"] - warm["avg_drop"], 1)
        if gain >= 0.2:
            timing_added = True
            levers.append({
                "icon": "🕑", "title": "Warmwasser in die Mittagszeit legen", "benefit_c": gain,
                "detail": f"Wenn es draußen wärmer ist ({warm['label']}), kühlt dein Haus beim WW nur um "
                          f"−{warm['avg_drop']:.1f} °C aus – bei {cold['label']} dagegen um −{cold['avg_drop']:.1f} °C. "
                          f"Lege die WW-Bereitung in die wärmsten Stunden (Mittag, oft mit PV-Überschuss): "
                          f"die Heizung pausiert dann bei kleinerem Komfortverlust."})
    # Lever 2 — duration: longer charges cool the house more → cap the charge time
    durs = sorted(e["dur_min"] for e in events)
    med_dur = durs[len(durs) // 2]
    longs = [e for e in events if e["dur_min"] > med_dur]
    shorts = [e for e in events if e["dur_min"] <= med_dur]
    if longs and shorts:
        dl = sum(e["drop"] for e in longs) / len(longs)
        ds = sum(e["drop"] for e in shorts) / len(shorts)
        if dl - ds >= 0.15:
            levers.append({
                "icon": "⏱️", "title": f"WW-Ladedauer begrenzen (~{med_dur:.0f} min)",
                "benefit_c": round(dl - ds, 1),
                "detail": f"Lange WW-Ladungen (> {med_dur:.0f} min) kühlen dein Haus um −{dl:.1f} °C aus, kurze nur "
                          f"um −{ds:.1f} °C. Über WW-Soll/Hysterese oder eine Zeitbegrenzung die Ladung kürzer halten – "
                          f"so pausiert die Heizung weniger lang."})
    # Lever 3 — early-morning cluster: the setback hours are the worst to pause
    # in (only when the timing lever didn't already say "move DHW to midday")
    morn = [e for e in events if 4 <= hod(e["start"]) < 9]
    if not timing_added and len(morn) >= 3:
        dm = sum(e["drop"] for e in morn) / len(morn)
        if dm >= overall_drop + 0.12:
            levers.append({
                "icon": "🌅", "title": "Früh-WW (4–9 Uhr) entzerren", "benefit_c": round(dm - overall_drop, 1),
                "detail": f"Morgens (4–9 Uhr) ist der Dip mit −{dm:.1f} °C überdurchschnittlich – da ist es "
                          f"draußen am kältesten und der Warmwasser-Bedarf am höchsten. Die WW-Ladung ein bis zwei "
                          f"Stunden später (wenn es draußen wärmer wird) legen glättet den Tiefpunkt."})
    # Lever 4 — lower the hot-water target (directional, always sensible)
    levers.append({
        "icon": "🌡️", "title": "WW-Soll etwas senken (z. B. 55 → 50 °C)", "benefit_c": None,
        "detail": "Jedes Grad weniger Warmwasser-Soll verkürzt die Ladezeit und damit die Heizpause. 50 °C genügen "
                  "meist für Komfort; für den Legionellenschutz reicht 1×/Woche eine Aufheizung auf 60 °C. Die "
                  "Heizung ist danach schneller wieder dran."})
    # quantified levers first (by benefit), directional ones last
    levers.sort(key=lambda l: (l["benefit_c"] is None, -(l["benefit_c"] or 0)))

    # ---- what the TANK did per charge (read, when the device reports it) ---- #
    tank_rows = store.dhw_log_since(since - 1800)
    tank_ts = [r["ts"] for r in tank_rows]

    def tank_at(ts, tol=900):
        if not tank_rows:
            return None
        i = bisect.bisect_left(tank_ts, ts)
        best = None
        for j in (i - 1, i):
            if 0 <= j < len(tank_rows) and abs(tank_ts[j] - ts) <= tol:
                if best is None or abs(tank_ts[j] - ts) < abs(tank_ts[best] - ts):
                    best = j
        return tank_rows[best] if best is not None else None

    for e in events:
        a, b = tank_at(e["start"]), tank_at(e["end"])
        e["tank_start"] = round(a["temp"], 1) if a else None
        e["tank_end"] = round(b["temp"], 1) if b else None
        sp = (b or a or {}).get("setpoint") if (a or b) else None
        e["tank_set"] = round(sp, 1) if sp is not None else None
        # reached = the charge ended at (about) its setpoint, i.e. it finished
        # by itself; clearly below = it was cut off before the tank was full
        e["tank_reached"] = (e["tank_end"] >= e["tank_set"] - 1.5
                             if (e["tank_end"] is not None and e["tank_set"] is not None) else None)

    # ---- charging pattern: why does it switch so often? (measured) ---------- #
    long_e = [e for e in events if e["dur_min"] >= 45]
    cap_min, capped = None, []
    for e in long_e:                            # densest ±6-min cluster of durations
        grp = [x for x in long_e if abs(x["dur_min"] - e["dur_min"]) <= 6]
        if len(grp) > len(capped):
            capped = grp
    if len(capped) >= 3 and len(capped) >= 0.3 * len(long_e):
        cap_min = med([x["dur_min"] for x in capped])
        if cap_min < 60:
            cap_min, capped = None, []
    else:
        capped = []
    # chains: the next charge started after less than an hour of heating
    chains, cur_chain = [], []
    for e in events:
        cur_chain.append(e)
        if not (e["heat_min"] is not None and e["heat_min"] < 60):
            if len(cur_chain) >= 2:
                chains.append(cur_chain)
            cur_chain = []
    if len(cur_chain) >= 2:
        chains.append(cur_chain)
    chain_gaps = [e["heat_min"] for ch in chains for e in ch[:-1] if e["heat_min"] is not None]
    span_d = max(1.0, (now - max(since, events[0]["start"])) / 86400.0)
    dhw_h_day = sum(e["dur_min"] for e in events) / 60.0 / span_d
    tank_e = [e for e in events if e["tank_reached"] is not None]
    n_short = sum(1 for e in tank_e if not e["tank_reached"])
    cap_tank = [e for e in capped if e["tank_reached"] is not None]
    cap_short = sum(1 for e in cap_tank if not e["tank_reached"])
    pattern = {
        "cap_min": cap_min, "n_capped": len(capped), "n_long": len(long_e),
        "n_chains": len(chains), "longest_chain": max((len(c) for c in chains), default=0),
        "chain_gap_min": (med(chain_gaps) if chain_gaps else None),
        "hours_per_day": round(dhw_h_day, 1), "time_share": round(dhw_h_day / 24.0 * 100),
        "tank": ({"n": len(tank_e), "n_short": n_short,
                  "avg_end": round(sum(e["tank_end"] for e in tank_e) / len(tank_e), 1),
                  "setpoint": med([e["tank_set"] for e in tank_e])} if tank_e else None),
        "level": "info", "html": "",
    }
    parts = []
    if cap_min:
        txt = (f"<b>{len(capped)} von {len(long_e)}</b> längeren Ladungen dauerten fast exakt gleich lang "
               f"(<b>~{cap_min:.0f} min</b>)")
        if chain_gaps:
            txt += (f", und in <b>{len(chains)} Ketten</b> startete die nächste schon nach "
                    f"~{med(chain_gaps):.0f} min Heizen")
        txt += ". "
        if cap_tank and cap_short >= 0.6 * len(cap_tank):
            avg_end = sum(e["tank_end"] for e in cap_tank) / len(cap_tank)
            sp_ = med([e["tank_set"] for e in cap_tank])
            txt += (f"Dabei endeten {cap_short} von {len(cap_tank)} davon <b>unter dem Soll</b> "
                    f"(Speicher Ø {_de(avg_end)} °C bei Soll {_de(sp_)} °C). Die Ladung wird also nach "
                    f"einer festen Zeit <b>abgebrochen, bevor der Speicher voll ist</b>, die Heizung darf "
                    f"kurz ran, dann geht es von vorn los. Typische Ursachen: das <b>WW-Soll ist für die "
                    f"Wärmepumpe bei dieser Außentemperatur zu hoch</b>, oder der Speicher verliert "
                    f"ständig Wärme (z. B. eine dauernd laufende <b>Zirkulationspumpe</b>).")
            pattern["level"] = "warn"
        elif cap_tank:
            txt += ("Der Speicher erreichte dabei meist sein Soll – die gleiche Dauer kommt also eher "
                    "von einem festen Zeitprogramm als von einem Abbruch.")
        else:
            txt += ("Gleich lange Ladungen, die kurz darauf neu starten, sehen nach einer "
                    "<b>Zeitbegrenzung der WW-Ladung</b> aus (maximale Ladedauer erreicht, danach eine "
                    "Mindest-Heizzeit, dann die nächste Ladung). Ob der Speicher dabei sein Soll "
                    "erreicht, protokolliert die App <b>ab jetzt</b> mit – dann steht hier, ob es ein "
                    "Abbruch ist.")
            pattern["level"] = "warn"
        parts.append(txt)
    elif chains:
        parts.append(f"<b>{len(chains)}×</b> folgte die nächste WW-Ladung nach weniger als einer Stunde "
                     f"Heizen (längste Kette: {pattern['longest_chain']} Ladungen).")
    if dhw_h_day >= 4.0:
        parts.append(f"Insgesamt macht die Wärmepumpe im Schnitt <b>{_de(dhw_h_day)} h pro Tag</b> "
                     f"Warmwasser ({pattern['time_share']} % der Zeit) – üblich sind 1–3 h. In der Zeit "
                     f"pausiert die Heizung.")
        pattern["level"] = "warn"
    if tank_e and not cap_min and n_short >= 0.5 * len(tank_e) and len(tank_e) >= 3:
        parts.append(f"{n_short} von {len(tank_e)} Ladungen endeten unter dem Soll "
                     f"(Speicher Ø {_de(pattern['tank']['avg_end'])} °C).")
    pattern["html"] = " ".join(parts)

    # representative phase for the chart: most recent clear dip that recovered
    cand = [e for e in events if e["drop"] >= 0.2 and e["recovered"]] or events
    rep_e = max(cand, key=lambda x: x["start"])
    a = rep_e["start"] - 30 * 60
    b = (rep_e["rec_ts"] or rep_e["end"]) + 30 * 60
    rep = dict(rep_e)
    rep["series"] = [{"ts": t, "temp": round(v, 2)} for t, v in temp if a <= t <= b]

    return {
        "ok": True, "days": days, "n": len(events),
        "avg_drop": round(sum(drops) / len(drops), 2),
        "median_drop": round(med(drops), 2),
        "max_drop": round(max(drops), 2),
        "avg_drop_meaningful": (round(sum(e["drop"] for e in meaningful) / len(meaningful), 2) if meaningful else None),
        "avg_recov_min": (round(sum(recs) / len(recs)) if recs else None),
        "median_recov_min": (round(med(recs)) if recs else None),
        "share_recovered": (round(n_recovered / len(expectable) * 100) if expectable else None),
        "n_recovered": n_recovered, "n_open": n_open,
        "n_minimal": n_minimal, "n_tight": n_tight,
        "n_meaningful": len(meaningful),
        "median_heat_min": med_heat_min,
        "pattern": pattern,
        "avg_dur_min": round(sum(e["dur_min"] for e in events) / len(events)),
        "by_outdoor": by_out,
        "dayparts": dayparts,
        "levers": levers,
        "events": events[-24:],
        "representative": rep,
        "n_dhw_total": len(merged),
    }


# --------------------------------------------------------------------------- #
# Hot-water tank: how fast it empties and refills (the tank sensor, read with
# every heat-pump poll), what another target would change, and the legionella
# view. All temperatures are the tank SENSOR's – the top of the tank is a bit
# warmer, the bottom (cold-water inlet) colder.
# --------------------------------------------------------------------------- #
DHW_GROW_HI = 45.0        # legionella multiply mainly between 25 and 45 °C
DHW_MIN_OP = 50.0         # DVGW W 551: don't run a tank permanently below 50 °C
DHW_KILL = 55.0           # from here they die off – slowly (hours)
DHW_DISINFECT = 59.0      # a reading this high = a thermal-disinfection run (60 °C+)
DHW_DRAW_KH = 3.0         # the sensor falling faster than this = hot water drawn
DHW_RESUME_S = 90 * 60    # a charge cut off and resumed within this = one charge
DHW_SETTLE_S = 20 * 60    # after a charge the sensor still moves (mixing)
DHW_SCENARIOS = (("stop52", None, 52.0), ("stop50", None, 50.0),
                 ("s46_50", 46.0, 50.0), ("s47_52", 47.0, 52.0))


def _is_dhw_mode(m) -> bool:
    m = (m or "").lower()
    return "dhw" in m or "water" in m or "ww" in m or "warm" in m


def compute_dhw_tank(store: "Store", days: float = 14, now: int | None = None) -> dict:
    """The hot-water tank, measured: every charge (the heat pump in DHW mode)
    with the tank temperature at its start and end, how long it took and why
    long ones were long (cut off and resumed, water drawn meanwhile, cold air,
    the slow last degrees); the minutes each degree takes; how fast the tank
    cools between charges (standby loss vs. draws, by hour); the setpoints the
    heat pump used; the legionella view (time below 45/50 °C, highest
    temperature, a 60 °C run seen or not); and what a different start/stop
    temperature would change – estimated from these measurements."""
    now = int(now or time.time())
    days = max(2.0, min(60.0, float(days)))
    since = int(now - days * 86400)
    pre = since - 6 * 3600                      # a charge already running at `since`
    trows = [(int(r["ts"]), float(r["temp"]), r.get("setpoint")) for r in store.dhw_log_since(pre)]
    trows = [r for r in trows if -5.0 < r[1] < 95.0]
    n_win = sum(1 for r in trows if r[0] >= since)
    if n_win < 36:                              # < ~3 h of readings
        return {"ok": True, "n": 0, "reason": "no_tank", "days": days, "n_tank": n_win}
    tts = [r[0] for r in trows]
    tv = [r[1] for r in trows]
    diffs = sorted(b - a for a, b in zip(tts, tts[1:]) if b > a)
    step = diffs[len(diffs) // 2] if diffs else 300
    gap = max(900.0, 2.5 * step)
    first_ts = max(since, next(t for t in tts if t >= since))
    span_d = max(0.5, (now - first_ts) / 86400.0)

    hp = sorted((s for s in store.hp_samples_since(pre) if s.get("ts")), key=lambda s: s["ts"])
    n = len(hp)

    def tslice(a, b):
        return bisect.bisect_left(tts, a), bisect.bisect_right(tts, b)

    # ---- DHW runs: contiguous DHW samples (one odd sample does not split) ---- #
    runs, i = [], 0
    while i < n:
        if _is_dhw_mode(hp[i].get("mode")):
            j = i
            while j + 1 < n and _is_dhw_mode(hp[j + 1].get("mode")) and hp[j + 1]["ts"] - hp[j]["ts"] <= gap:
                j += 1
            if runs and hp[i]["ts"] - hp[runs[-1][1]]["ts"] <= max(2 * step, 600) + 1:
                runs[-1][1] = j
            else:
                runs.append([i, j])
            i = j + 1
        else:
            i += 1

    def edge(k, side):
        t = hp[k]["ts"]
        nb = k - 1 if side < 0 else k + 1
        if 0 <= nb < n and abs(hp[nb]["ts"] - t) <= gap:
            return (t + hp[nb]["ts"]) / 2.0
        return t + side * step / 2.0

    bands_t, bands_k, bands_n = {}, {}, {}      # per 1-K band: minutes, K covered, runs
    R = []
    for i0, i1 in runs:
        st, en = edge(i0, -1), edge(i1, +1)
        running = i1 == n - 1 and now - hp[i1]["ts"] <= gap
        if running:
            en = float(hp[i1]["ts"])
        lo, hi = tslice(st - step, hp[i0]["ts"] + step)
        t_start = min(tv[lo:hi]) if hi > lo else None
        lo, hi = tslice(hp[i1]["ts"] - step, en + 2 * step)
        t_end = max(tv[lo:hi]) if hi > lo else None
        lo, hi = tslice(st, en + step)
        sps = [float(trows[k][2]) for k in range(lo, hi) if trows[k][2] is not None]
        set_ = _median(sps) if sps else None
        outs = [float(hp[k]["outdoor_c"]) for k in range(i0, i1 + 1) if hp[k].get("outdoor_c") is not None]
        # inside the run: where the time went (rising per band / standing / drawn)
        a = max(0, bisect.bisect_right(tts, st) - 1)
        b = bisect.bisect_right(tts, en + step)
        draw_k = stall = 0.0
        lag = None
        rising = False          # the first rising step still holds part of the start-up
        mybands = {}
        for k in range(a, min(b, len(tts)) - 1):
            ta, tb = tts[k], tts[k + 1]
            if tb - ta > gap or tb <= st:
                continue
            dt = (min(tb, en) - max(ta, st)) / 60.0
            if dt <= 0:
                continue
            dT = tv[k + 1] - tv[k]
            if dT > 0.05 and not rising:
                rising = True
                stall += dt
            elif dT > 0.05:
                Ta, Tb = tv[k], tv[k + 1]
                for band in range(math.floor(Ta), math.floor(Tb - 1e-9) + 1):
                    ov = min(Tb, band + 1) - max(Ta, band)
                    if ov > 0:
                        mybands[band] = mybands.get(band, [0.0, 0.0])
                        mybands[band][0] += dt * ov / dT
                        mybands[band][1] += ov
            else:
                stall += dt
                if dT < -0.15:
                    draw_k += -dT
            if lag is None and t_start is not None and tv[k + 1] >= t_start + 0.3:
                lag = max(0.0, (tb - st) / 60.0)
        el = th = 0.0
        has_e = has_h = False
        for k in range(max(1, i0), i1 + 1):
            p, c = hp[k - 1], hp[k]
            if c["ts"] - p["ts"] > gap:
                continue
            if p.get("energy_kwh") is not None and c.get("energy_kwh") is not None and 0 <= c["energy_kwh"] - p["energy_kwh"] < 5:
                el += c["energy_kwh"] - p["energy_kwh"]
                has_e = True
            if p.get("heat_kwh") is not None and c.get("heat_kwh") is not None and 0 <= c["heat_kwh"] - p["heat_kwh"] < 15:
                th += c["heat_kwh"] - p["heat_kwh"]
                has_h = True
        if not running and st >= since:
            for band, (m, kk) in mybands.items():
                bands_t[band] = bands_t.get(band, 0.0) + m
                bands_k[band] = bands_k.get(band, 0.0) + kk
                if kk >= 0.3:
                    bands_n[band] = bands_n.get(band, 0) + 1
        R.append({"st": st, "en": en, "running": running, "t_start": t_start, "t_end": t_end, "set": set_,
                  "out": (sum(outs) / len(outs)) if outs else None, "draw_k": draw_k, "stall": stall,
                  "lag": lag, "bands": mybands, "el": el if has_e else None, "th": th if has_h else None,
                  "reached": (t_end >= set_ - 1.0) if (t_end is not None and set_ is not None) else None})

    # ---- episodes: a charge cut off and resumed soon after counts as one ---- #
    E = []
    for r in R:
        p = E[-1] if E else None
        if (p and not p["running"] and r["st"] - p["en"] <= DHW_RESUME_S
                and (p["reached"] is False or (p["reached"] is None and r["st"] - p["en"] <= 1800))):
            p["runs"].append(r)
            p["break_s"] += r["st"] - p["en"]
            p.update(en=r["en"], running=r["running"], t_end=r["t_end"], reached=r["reached"],
                     set=r["set"] if r["set"] is not None else p["set"])
        else:
            E.append({"st": r["st"], "en": r["en"], "running": r["running"], "runs": [r], "break_s": 0.0,
                      "t_start": r["t_start"], "t_end": r["t_end"], "set": r["set"], "reached": r["reached"]})
    outs_all = [r["out"] for r in R if r["out"] is not None]
    out_med = _median(outs_all) if outs_all else None
    eps = []
    for e in E:
        rs = e["runs"]
        dhw_min = sum(r["en"] - r["st"] for r in rs) / 60.0
        ob = [r["out"] for r in rs if r["out"] is not None]
        out = sum(ob) / len(ob) if ob else None
        top = None
        if e["set"] is not None:
            top = sum(m for r in rs for band, (m, _k) in r["bands"].items() if band >= e["set"] - 2.0)
        ep = {"start": int(e["st"]), "end": int(e["en"]), "running": e["running"],
              "dur_min": round((e["en"] - e["st"]) / 60.0), "dhw_min": round(dhw_min),
              "break_min": round(e["break_s"] / 60.0), "n_runs": len(rs),
              "longest_min": round(max(r["en"] - r["st"] for r in rs) / 60.0),
              "t_start": round(e["t_start"], 1) if e["t_start"] is not None else None,
              "t_end": round(e["t_end"], 1) if e["t_end"] is not None else None,
              "set": round(e["set"], 1) if e["set"] is not None else None,
              "reached": e["reached"], "outdoor": round(out, 1) if out is not None else None,
              "draw_k": round(sum(r["draw_k"] for r in rs), 1),
              "stall_min": round(sum(r["stall"] for r in rs)),
              "lag_min": round(rs[0]["lag"]) if rs[0]["lag"] is not None else None,
              "top_min": round(top) if top is not None else None,
              "el_kwh": round(sum(r["el"] for r in rs), 2) if all(r["el"] is not None for r in rs) else None,
              "th_kwh": round(sum(r["th"] for r in rs), 2) if all(r["th"] is not None for r in rs) else None}
        why = []
        if not e["running"]:
            if len(rs) >= 2:
                why.append("cut")
            if ep["draw_k"] >= 1.0:
                why.append("draw")
            if out is not None and (out <= 2.0 or (out_med is not None and out <= out_med - 4.0)):
                why.append("cold")
            if top is not None and top >= 25:            # the last 2 K alone took ≥ 25 min
                why.append("top")
            if e["reached"] is False:
                why.append("short")
            if ep["lag_min"] is not None and ep["lag_min"] >= 15:
                why.append("lag")
        ep["why"] = why
        eps.append(ep)
    done = [e for e in eps if not e["running"] and e["start"] >= since]

    # ---- minutes per degree while charging ---------------------------------- #
    mpk = {b: bands_t[b] / bands_k[b] for b in bands_k
           if bands_k[b] >= 1.0 and bands_n.get(b, 0) >= 2}

    def mpk_at(k):
        known = sorted(mpk)
        if not known:
            return None, True
        if k in mpk:
            return mpk[k], False
        if k > known[-1]:                       # hotter than ever measured: slower still
            return mpk[known[-1]] * 1.12 ** (k - known[-1]), True
        if k < known[0]:
            return mpk[known[0]], True
        lo_ = max(x for x in known if x < k)
        hi_ = min(x for x in known if x > k)
        return mpk[lo_] + (mpk[hi_] - mpk[lo_]) * (k - lo_) / (hi_ - lo_), False

    def charge_minutes(S, T):
        tot, ex = 0.0, False
        for band in range(math.floor(S), math.ceil(T)):
            ov = min(T, band + 1) - max(S, band)
            if ov <= 0:
                continue
            m, x = mpk_at(band)
            if m is None:
                return None, True
            tot += m * ov
            ex = ex or x
        return tot, ex

    starts = [e["t_start"] for e in done if e["t_start"] is not None]
    sets = [e["set"] for e in done if e["set"] is not None]
    ends = [e["t_end"] for e in done if e["t_end"] is not None and e["reached"] is not False]
    S0 = _median(starts) if starts else None
    set0 = _median(sets) if sets else (_median(ends) if ends else None)
    over = []                                   # start-up + standing time per charge
    for e in done:
        if e["t_start"] is not None and e["t_end"] is not None and e["t_end"] > e["t_start"]:
            cm, _x = charge_minutes(e["t_start"], e["t_end"])
            if cm is not None:
                over.append(max(0.0, e["dhw_min"] - cm))
    overhead = _median(over) if over else 0.0
    # the per-degree model is scaled so that today's setting reproduces the
    # measured median charge (draws, defrosts … are in the measurement)
    meas = _median([e["dhw_min"] for e in done]) if done else None
    calib = 1.0
    if meas and S0 is not None and set0 is not None and set0 > S0 and mpk:
        bm, _x = charge_minutes(S0, set0)
        if bm:
            calib = max(0.7, min(1.4, meas / (overhead + bm)))

    curve = []
    if S0 is not None and set0 is not None and set0 > S0 and mpk:
        acc, t = overhead, S0
        curve.append({"t": round(S0, 1), "min": round(acc * calib)})
        for band in range(math.floor(S0) + 1, math.ceil(set0) + 1):
            tt = min(float(band), set0)
            m, _x = charge_minutes(t, tt)
            if m is None:
                break
            acc += m
            t = tt
            curve.append({"t": round(tt, 1), "min": round(acc * calib)})

    # ---- between charges: standby loss vs. draws ---------------------------- #
    in_ch = [False] * len(tts)
    for r in R:
        lo, hi = tslice(r["st"], r["en"] + DHW_SETTLE_S)
        for k in range(lo, hi):
            in_ch[k] = True
    sb_dt = sb_dT = nt_dt = nt_dT = 0.0
    draw_tot = 0.0
    draws = []                                  # [start, end, K]
    hr_drop = [0.0] * 24
    hr_dt = [0.0] * 24
    dis_h = 0.0
    for k in range(len(tts) - 1):
        ta, tb = tts[k], tts[k + 1]
        if ta < since or in_ch[k] or in_ch[k + 1] or tb - ta > gap or tb <= ta:
            continue
        dt_h = (tb - ta) / 3600.0
        dT = tv[k + 1] - tv[k]
        hr = time.localtime(ta).tm_hour
        hr_dt[hr] += dt_h
        hr_drop[hr] += max(0.0, -dT)
        dis_h += dt_h
        if dT / dt_h <= -DHW_DRAW_KH:
            draw_tot += -dT
            if draws and ta - draws[-1][1] <= 1200:
                draws[-1][1] = tb
                draws[-1][2] += -dT
            else:
                draws.append([ta, tb, -dT])
        else:
            sb_dt += dt_h
            sb_dT += dT
            if hr < 5:
                nt_dt += dt_h
                nt_dT += dT
    draws = [d for d in draws if d[2] >= 0.5]
    draw_hours = [0.0] * 24
    for d in draws:
        draw_hours[time.localtime(d[0]).tm_hour] += d[2]
    peak = sorted(range(24), key=lambda h: -draw_hours[h])[:3]
    peak = sorted(h for h in peak if draw_hours[h] > 0)
    loss_kh = (-sb_dT / sb_dt) if sb_dt >= 3 else None
    # K the tank loses per day: from what the charges put back (incl. what was
    # drawn while charging) – robust to gaps; else from the cooling itself
    k_charges = sum((e["t_end"] - e["t_start"]) + e["draw_k"] for e in done
                    if e["t_end"] is not None and e["t_start"] is not None)
    k_day = (k_charges / span_d) if len(done) >= 3 else (
        ((draw_tot + max(0.0, -sb_dT)) / dis_h * 24.0) if dis_h >= 6 else None)
    holds = [(b["start"] - a["end"]) / 3600.0 for a, b in zip(eps, eps[1:])
             if not a["running"] and a["start"] >= since]

    # ---- setpoints the heat pump used --------------------------------------- #
    sp_by_h = [[] for _ in range(24)]
    sp_vals = {}
    for ts_, _t, sp in trows:
        if ts_ < since or sp is None:
            continue
        sp_by_h[time.localtime(ts_).tm_hour].append(float(sp))
        key = round(float(sp) * 2) / 2.0
        sp_vals[key] = sp_vals.get(key, 0) + 1
    n_sp = sum(sp_vals.values())
    setpoints = {"by_hour": [(_median(v) if v else None) for v in sp_by_h],
                 "values": [{"t": t, "share": round(c / n_sp, 3)} for t, c in
                            sorted(sp_vals.items(), key=lambda x: -x[1])] if n_sp else [],
                 "now": (float(trows[-1][2]) if trows[-1][2] is not None else None)}

    # ---- legionella view: time at temperature (sensor) ---------------------- #
    w_tot = w45 = w50 = w55 = 0.0
    per_day = {}
    t_max = t_max_ts = t_min = None
    last60 = last55 = None
    for k in range(len(tts)):
        if tts[k] < since:
            continue
        nxt = tts[k + 1] if k + 1 < len(tts) else now
        w = min(max(0.0, nxt - tts[k]), gap)
        T = tv[k]
        w_tot += w
        w45 += w if T < DHW_GROW_HI else 0.0
        w50 += w if T < DHW_MIN_OP else 0.0
        w55 += w if T >= DHW_KILL else 0.0
        if t_max is None or T > t_max:
            t_max, t_max_ts = T, tts[k]
        t_min = T if t_min is None else min(t_min, T)
        if T >= DHW_DISINFECT:
            last60 = tts[k]
        if T >= DHW_KILL:
            last55 = tts[k]
        d = time.strftime("%Y-%m-%d", time.localtime(tts[k]))
        pd = per_day.setdefault(d, {"day": d, "t_max": T, "t_min": T, "h": 0.0, "h_lt45": 0.0,
                                    "h_lt50": 0.0, "h_ge55": 0.0, "n": 0, "dhw_min": 0, "longest": 0})
        pd["t_max"] = max(pd["t_max"], T)
        pd["t_min"] = min(pd["t_min"], T)
        pd["h"] += w / 3600.0
        pd["h_lt45"] += w / 3600.0 if T < DHW_GROW_HI else 0.0
        pd["h_lt50"] += w / 3600.0 if T < DHW_MIN_OP else 0.0
        pd["h_ge55"] += w / 3600.0 if T >= DHW_KILL else 0.0
    for e in eps:
        d = time.strftime("%Y-%m-%d", time.localtime(e["start"]))
        if d in per_day:
            per_day[d]["n"] += 1
            per_day[d]["dhw_min"] += e["dhw_min"]
            per_day[d]["longest"] = max(per_day[d]["longest"], e["longest_min"])
    days_l = []
    for d in sorted(per_day):
        pd = per_day[d]
        days_l.append({k: (round(v, 1) if isinstance(v, float) else v) for k, v in pd.items()})
    full = [x for x in days_l if x["h"] >= 20]
    sp_hi = max((v["t"] for v in setpoints["values"]), default=None)
    legio = {"t_max": round(t_max, 1), "t_max_ts": t_max_ts, "t_min": round(t_min, 1),
             "share_lt45": round(w45 / w_tot, 3) if w_tot else None,
             "share_lt50": round(w50 / w_tot, 3) if w_tot else None,
             "share_ge55": round(w55 / w_tot, 3) if w_tot else None,
             "h_lt45_day": round(w45 / w_tot * 24, 1) if w_tot else None,
             "h_lt50_day": round(w50 / w_tot * 24, 1) if w_tot else None,
             "n_days": len(full), "days_ge55": sum(1 for x in full if x["t_max"] >= DHW_KILL),
             "days_ge60": sum(1 for x in full if x["t_max"] >= DHW_DISINFECT),
             "last_ge60": last60, "last_ge55": last55,
             "disinfection_seen": last60 is not None or (sp_hi is not None and sp_hi >= 60)}

    # ---- what another start/stop temperature would change (estimate) -------- #
    scen = []
    if S0 is not None and set0 is not None and set0 - S0 >= 2 and k_day and mpk:
        def one(key, S, T):
            cm, ex = charge_minutes(S, T)
            if cm is None:
                return None
            dur = (overhead + cm) * calib
            per = k_day / (T - S)
            lt = lambda x: max(0.0, min(1.0, (x - S) / (T - S)))
            return {"key": key, "start": round(S, 1), "stop": round(T, 1), "dur_min": round(dur),
                    "per_day": round(per, 1), "h_day": round(per * dur / 60.0, 1),
                    "share_lt45": round(lt(DHW_GROW_HI), 2), "share_lt50": round(lt(DHW_MIN_OP), 2),
                    "extrap": ex}
        s = one("now", S0, set0)
        if s:
            s["measured_min"] = round(meas) if meas else None
            scen.append(s)
        for key, S, T in DHW_SCENARIOS:
            S = S0 if S is None else S
            if T - S < 2 or (abs(T - set0) < 0.6 and abs(S - S0) < 0.6) or (key.startswith("stop") and set0 <= T + 0.5):
                continue
            s = one(key, S, T)
            if s:
                scen.append(s)

    # ---- the last two days as a curve (for the chart) ----------------------- #
    c0 = now - 2 * 86400
    series = [[tts[k], round(tv[k], 1)] for k in range(len(tts)) if tts[k] >= c0]
    runs48 = [[int(r["st"]), int(r["en"])] for r in R if r["en"] >= c0]

    by_out = []
    for label, lo_, hi_ in (("unter 3 °C", -99, 3), ("3–8 °C", 3, 8), ("über 8 °C", 8, 99)):
        es = [e for e in done if e["outdoor"] is not None and lo_ <= e["outdoor"] < hi_]
        if es:
            rates = [(e["t_end"] - e["t_start"]) / (e["dhw_min"] / 60.0) for e in es
                     if e["t_end"] is not None and e["t_start"] is not None and e["dhw_min"] >= 15]
            by_out.append({"label": label, "n": len(es), "dur_med": round(_median([e["dhw_min"] for e in es])),
                           "rate_kh": round(_median(rates), 1) if rates else None})

    durs = [e["dur_min"] for e in done]
    els = [e["el_kwh"] for e in done if e["el_kwh"] is not None]
    pairs = [(e["el_kwh"], e["th_kwh"]) for e in done if e["el_kwh"] is not None and e["th_kwh"] is not None]
    p_el, p_th = sum(a for a, _ in pairs), sum(b for _, b in pairs)
    rates = [(e["t_end"] - e["t_start"]) / (e["dhw_min"] / 60.0) for e in done
             if e["t_end"] is not None and e["t_start"] is not None and e["dhw_min"] >= 15]
    pdur = sorted(durs)
    summary = {
        "n": len(done), "per_day": round(len(done) / span_d, 1),
        "dur_med": round(_median(durs)) if durs else None,
        "dur_avg": round(sum(durs) / len(durs)) if durs else None,
        "dur_max": max(durs) if durs else None,
        "dur_p90": pdur[min(len(pdur) - 1, int(0.9 * len(pdur)))] if pdur else None,
        "pause_max": max((e["longest_min"] for e in done), default=None),
        "pause_med": round(_median([e["longest_min"] for e in done])) if done else None,
        "t_start": round(S0, 1) if S0 is not None else None,
        "t_end": round(_median(ends), 1) if ends else None,
        "set": round(set0, 1) if set0 is not None else None,
        "hyst": round(set0 - S0, 1) if (S0 is not None and set0 is not None) else None,
        "rate_kh": round(_median(rates), 1) if rates else None,
        "h_day": round(sum(e["dhw_min"] for e in done) / 60.0 / span_d, 1),
        "el_day": round(sum(els) / len(els) * len(done) / span_d, 1) if len(els) >= max(1, len(done) // 2) else None,
        "cop": round(p_th / p_el, 2) if p_el > 0.3 else None,
        "n_cut": sum(1 for e in done if e["n_runs"] >= 2),
        "n_short": sum(1 for e in done if e["reached"] is False),
        "n_draw": sum(1 for e in done if e["draw_k"] >= 1.0),
        "lag_med": round(_median([e["lag_min"] for e in done if e["lag_min"] is not None]))
        if any(e["lag_min"] is not None for e in done) else None,
        "overhead_min": round(overhead), "calib": round(calib, 2),
        "out_med": round(out_med, 1) if out_med is not None else None,
    }
    discharge = {"k_day": round(k_day, 1) if k_day else None,
                 "loss_kh": round(loss_kh, 2) if loss_kh is not None else None,
                 "loss_night_kh": round(-nt_dT / nt_dt, 2) if nt_dt >= 3 else None,
                 "draws_day": round(len(draws) / span_d, 1), "draw_k_day": round(draw_tot / span_d, 1),
                 "by_hour": [round(hr_drop[h] / hr_dt[h], 2) if hr_dt[h] >= 0.5 else None for h in range(24)],
                 "draw_by_hour": [round(x / span_d, 2) for x in draw_hours], "peak_hours": peak,
                 "hold_h_med": round(_median(holds), 1) if holds else None,
                 "hold_h_max": round(max(holds), 1) if holds else None}
    midnight = int(time.mktime(time.localtime(now)[:3] + (0, 0, 0, 0, 0, -1)))
    return {"ok": True, "days": days, "span_d": round(span_d, 1), "step_s": int(step), "n": len(done),
            "n_runs": len(R), "summary": summary,
            "bands": [{"t": b, "min_k": round(mpk[b], 1), "k": round(bands_k[b], 1), "n": bands_n.get(b, 0)}
                      for b in sorted(mpk)],
            "curve": curve, "by_outdoor": by_out, "discharge": discharge, "setpoints": setpoints,
            "legio": legio, "days_list": days_l[-21:], "scenarios": scen,
            "episodes": eps[-14:], "today": [e for e in eps if e["end"] >= midnight or e["running"]],
            "series": series, "runs48": runs48, "now": now,
            "tank_now": {"ts": tts[-1], "t": round(tv[-1], 1)}}


# --------------------------------------------------------------------------- #
# Arbeitszahl: datasheet vs. practice. The datasheet COP points (EN 14511) are
# turned into a model COP(outdoor, flow): each point says which share of the
# ideal (Carnot) COP the machine reaches at that outdoor temperature; between
# points linear, outside flat. The flow temperature then scales the COP the
# way physics does (higher flow = bigger temperature lift = lower COP). Every
# measured interval is compared with what the model expects for exactly its
# outdoor and flow temperature.
# --------------------------------------------------------------------------- #
# Bosch Compress 6800i AW, outdoor unit AW 7 OR-S (R290), EN 14511 heating
# points as published for this size (retail/portal listings of the datasheet):
# A-7/W35 6.71 kW COP 2.36 · A2/W35 2.87 kW COP 4.06 · A7/W35 2.85 kW COP 4.8;
# SCOP (average climate) 4.58 at 35 °C, 3.51 at 55 °C.
HP_SPEC_DEFAULT = {"name": "Bosch Compress 6800i AW 7 OR-S",
                   "pts": [(-7.0, 35.0, 2.36), (2.0, 35.0, 4.06), (7.0, 35.0, 4.8)]}
COP_DC, COP_DE = 4.0, 8.0     # K: condensing above the flow, evaporating below the air
DHW_FLOW_ABOVE_TANK = 6.0     # K: flow into the tank coil above the tank sensor while charging
DHW_RETURN_DT = 5.0           # K: flow above the return from the tank coil while charging
DHW_FLOW_FALLBACK = 50.0      # °C: hot-water flow when neither the sensor nor the tank helps


def _carnot_cop(tout: float, tflow: float) -> float:
    tc = tflow + COP_DC
    return (tc + 273.15) / max(8.0, tc - (tout - COP_DE))


def hp_cop_model(pts):
    """COP(outdoor °C, flow °C) from datasheet points [(outdoor, flow, COP), …]
    → (function, [(outdoor, share of Carnot)])."""
    eta: dict = {}
    for to, tf, c in pts:
        eta.setdefault(float(to), []).append(float(c) / _carnot_cop(float(to), float(tf)))
    xs = sorted(eta)
    ys = [sum(eta[x]) / len(eta[x]) for x in xs]

    def eta_at(t):
        if t <= xs[0]:
            return ys[0]
        if t >= xs[-1]:
            return ys[-1]
        i = bisect.bisect_right(xs, t)
        return ys[i - 1] + (ys[i] - ys[i - 1]) * (t - xs[i - 1]) / (xs[i] - xs[i - 1])

    def cop(tout, tflow):
        return max(1.0, min(8.0, eta_at(tout) * _carnot_cop(tout, tflow)))
    return cop, [(x, round(y, 3)) for x, y in zip(xs, ys)]


def parse_hp_spec(raw: str | None) -> dict:
    """`pts` query value "-7:35:2.36,2:35:4.06,…" → spec; the default when
    missing or implausible."""
    pts = []
    for part in (raw or "").split(","):
        try:
            to, tf, c = (float(x) for x in part.split(":"))
        except ValueError:
            continue
        if -30 <= to <= 35 and 20 <= tf <= 75 and 1.0 <= c <= 9.0:
            pts.append((to, tf, c))
    if not pts:
        return dict(HP_SPEC_DEFAULT)
    return {"name": None, "pts": pts[:12]}


def compute_hp_cop_theory(store: "Store", days: float = 30, spec: dict | None = None,
                          live: dict | None = None, now: int | None = None) -> dict:
    """Measured COP (heat ÷ electricity from the heat pump's own counters) vs.
    the datasheet COP at the same outdoor and flow temperature: overall, for
    heating and hot water, per outdoor-temperature bin and per day – and where
    the extra electricity went (standby while off, the electric heater when it
    is logged, the rest: defrost, cycling, part load, measurement). Plus the
    levers: what a lower flow / hot-water temperature, hot water at midday,
    no electric heater … would change, estimated with the same model.

    Hot water: HomeCom's supply sensor often sits in the heating circuit and
    reads the cooling heating pipe (~30 °C) while the tank charges. Where it is
    below the tank temperature, the flow is taken as tank + DHW_FLOW_ABOVE_TANK."""
    now = int(now or time.time())
    days = max(3.0, min(400.0, float(days)))
    since = int(now - days * 86400)
    spec = spec or dict(HP_SPEC_DEFAULT)
    cop_th, etas = hp_cop_model(spec["pts"])
    rows = sorted((s for s in store.hp_samples_since(since - 3600) if s.get("ts")), key=lambda s: s["ts"])
    rows = [s for s in rows if s.get("energy_kwh") is not None and s.get("heat_kwh") is not None]
    if len(rows) < 12:
        return {"ok": True, "n": 0, "reason": "no_data", "days": days,
                "spec": {"name": spec.get("name"), "pts": spec["pts"]}, "etas": etas}
    gap = _hp_gap_s(rows)
    tank = [(int(r["ts"]), float(r["temp"])) for r in store.dhw_log_since(since - 3600)]
    tank_ts = [t for t, _ in tank]

    def tank_at(ts):
        i = bisect.bisect_left(tank_ts, ts)
        best = None
        for j in (i - 1, i):
            if 0 <= j < len(tank) and abs(tank[j][0] - ts) <= 900:
                if best is None or abs(tank[j][0] - ts) < abs(tank[best][0] - ts):
                    best = j
        return tank[best][1] if best is not None else None

    active = lambda m: (m or "off").lower() not in ("off", "", "standby", "idle")

    def kind(m):
        m = (m or "").lower()
        return "dhw" if _is_dhw_mode(m) else "heating" if m in ("ch", "heating", "heat") else "other"

    def blank():
        return {"e": 0.0, "h": 0.0, "h_ok": 0.0, "e_th": 0.0, "tf": 0.0, "to": 0.0,
                "e_m2": 0.0, "e_m4": 0.0, "h_est": 0.0, "h_ret": 0.0, "h_tank": 0.0, "tr": 0.0, "h_tr": 0.0}
    acc = {k: blank() for k in ("heating", "dhw", "other")}
    bins: dict = {}
    per_day: dict = {}
    sb_e = sb_h = 0.0              # while the heat pump was off (standby, frost protection …)
    he_e = 0.0                     # electric heater, when the samples carry its counter
    he_by = {"heating": 0.0, "dhw": 0.0, "other": 0.0, "off": 0.0}
    he_logged = False
    warm_e = warm_h = 0.0          # heating while it is ≥ 15 °C outside
    mid_out = []                   # outdoor 11–15 h (when hot water could run instead)
    st_n = st_h = st_run = 0.0     # compressor starts (device counter), hours covered, of which running
    st_warm = 0.0                  # … starts while it is ≥ 12 °C outside
    n = 0
    t_first = None
    for p, c in zip(rows, rows[1:]):
        if c["ts"] < since:
            continue
        dt = c["ts"] - p["ts"]
        if dt <= 0 or dt > gap:
            continue
        de, dh = c["energy_kwh"] - p["energy_kwh"], c["heat_kwh"] - p["heat_kwh"]
        if de < 0 or dh < 0 or de / (dt / 3600.0) > 25 or dh / (dt / 3600.0) > 80:
            continue
        n += 1
        t_first = t_first or c["ts"]
        outs = [x for x in (p.get("outdoor_c"), c.get("outdoor_c")) if x is not None]
        to = sum(outs) / len(outs) if outs else None
        if to is not None and 11 <= time.localtime(c["ts"]).tm_hour < 15:
            mid_out.append(to)
        if p.get("starts") is not None and c.get("starts") is not None and 0 <= c["starts"] - p["starts"] < 50:
            st_n += c["starts"] - p["starts"]
            st_h += dt / 3600.0
            if active(p.get("mode")) or active(c.get("mode")):
                st_run += dt / 3600.0
            if to is not None and to >= 12.0:
                st_warm += c["starts"] - p["starts"]
        dhe = 0.0
        if p.get("eheater_kwh") is not None and c.get("eheater_kwh") is not None:
            he_logged = True
            dhe = max(0.0, c["eheater_kwh"] - p["eheater_kwh"])     # ticks independently of the total
            he_e += dhe
        day = time.strftime("%Y-%m-%d", time.localtime(c["ts"]))
        d = per_day.setdefault(day, {"day": day, "e": 0.0, "h": 0.0, "h_ok": 0.0, "e_th": 0.0, "sb": 0.0, "to": []})
        d["e"] += de
        d["h"] += dh
        if to is not None:
            d["to"].append(to)
        if not (active(p.get("mode")) or active(c.get("mode"))):
            sb_e += de
            sb_h += dh
            d["sb"] += de
            he_by["off"] += dhe
            continue
        m = kind(p.get("mode") if active(p.get("mode")) else c.get("mode"))
        he_by[m] += dhe
        a = acc[m]
        a["e"] += de
        a["h"] += dh
        flows = [x for x in (p.get("supply_c"), c.get("supply_c")) if x is not None]
        tf = sum(flows) / len(flows) if flows else None
        est = False
        src = None
        if m == "dhw":
            rets = [x for x in (p.get("return_c"), c.get("return_c")) if x is not None]
            rt = sum(rets) / len(rets) if rets else None
            tk = tank_at(c["ts"])
            if rt is not None and dh > 0:
                a["tr"] += rt * dh
                a["h_tr"] += dh
            if rt is not None and rt >= 40.0 and (tf is None or rt > tf + 3.0):
                tf, est, src = rt + DHW_RETURN_DT, True, "ret"
            elif tk is not None and (tf is None or tf < tk + 2.0):
                tf, est, src = tk + DHW_FLOW_ABOVE_TANK, True, "tank"
            elif tk is None and (tf is None or tf < 40.0):
                tf, est, src = DHW_FLOW_FALLBACK, True, "fixed"
        if m == "heating" and to is not None and to >= 15.0:
            warm_e += de
            warm_h += dh
        if dh > 0 and to is not None and tf is not None:
            eth = dh / cop_th(to, tf)
            a["h_ok"] += dh
            a["e_th"] += eth
            a["tf"] += tf * dh
            a["to"] += to * dh
            a["e_m2"] += dh / cop_th(to, tf - 2.0)
            a["e_m4"] += dh / cop_th(to, tf - 4.0)
            if est:
                a["h_est"] += dh
                if src == "ret":
                    a["h_ret"] += dh
                elif src == "tank":
                    a["h_tank"] += dh
            d["h_ok"] += dh
            d["e_th"] += eth
            if m == "heating":
                k = int(math.floor(to / 3.0) * 3)
                b = bins.setdefault(k, {"t": k, "e": 0.0, "h": 0.0, "h_ok": 0.0, "e_th": 0.0, "tf": 0.0})
                b["h_ok"] += dh
                b["e_th"] += eth
                b["tf"] += tf * dh
        if m == "heating" and to is not None:
            k = int(math.floor(to / 3.0) * 3)
            b = bins.setdefault(k, {"t": k, "e": 0.0, "h": 0.0, "h_ok": 0.0, "e_th": 0.0, "tf": 0.0})
            b["e"] += de
            b["h"] += dh
    if n < 12:
        return {"ok": True, "n": 0, "reason": "no_data", "days": days,
                "spec": {"name": spec.get("name"), "pts": spec["pts"]}, "etas": etas}

    def cops(a):
        """measured COP, datasheet COP for the same heat and conditions,
        heat-weighted flow and outdoor temperature"""
        cm = a["h"] / a["e"] if a["e"] > 0.3 and a["h"] > 0 else None
        ct = a["h_ok"] / a["e_th"] if a["e_th"] > 0.05 else None
        return {"e": round(a["e"], 1), "h": round(a["h"], 1), "cop": round(cm, 2) if cm else None,
                "cop_th": round(ct, 2) if ct else None,
                "flow": round(a["tf"] / a["h_ok"], 1) if a["h_ok"] > 0 else None,
                "out": round(a["to"] / a["h_ok"], 1) if a["h_ok"] > 0 else None,
                "flow_est": round(a["h_est"] / a["h_ok"], 2) if a["h_ok"] > 0 else None,
                "flow_src": (("ret" if a["h_ret"] >= a["h_tank"] else "tank") if a["h_est"] > 0.5 * a["h_ok"] else "sensor")
                if a["h_ok"] > 0 else None,
                "ret": round(a["tr"] / a["h_tr"], 1) if a["h_tr"] > 0 else None,
                "cover": round(a["h_ok"] / a["h"], 2) if a["h"] > 0 else None}
    run = {k: sum(acc[m][k] for m in acc) for k in blank()}
    R = cops(run)
    tot_e, tot_h = run["e"] + sb_e, run["h"] + sb_h
    cop_meas = tot_h / tot_e if tot_e > 0.3 else None
    # electricity the datasheet machine would have needed for ALL the heat
    # (heat whose conditions were not logged at the same rate as the rest)
    e_th_all = (run["e_th"] * tot_h / run["h_ok"]) if run["h_ok"] > 0 else None
    cop_theory = (tot_h / e_th_all) if e_th_all else None
    gapd = None
    if e_th_all is not None and tot_e > 0:
        extra = tot_e - e_th_all
        he_extra = he_e * (1.0 - 1.0 / cop_theory) if (he_logged and cop_theory) else None
        rest = extra - sb_e - (he_extra or 0.0)
        gapd = {"e_meas": round(tot_e, 1), "e_th": round(e_th_all, 1), "extra": round(extra, 1),
                "standby": round(sb_e, 1), "heater": round(he_e, 1) if he_logged else None,
                "heater_extra": round(he_extra, 1) if he_extra is not None else None,
                "rest": round(rest, 1)}
    span_d = max(1.0, (now - (t_first or since)) / 86400.0)
    daily = []
    for dd in sorted(per_day):
        x = per_day[dd]
        daily.append({"day": dd, "e": round(x["e"], 2), "h": round(x["h"], 2),
                      "cop": round(x["h"] / x["e"], 2) if x["e"] > 0.5 and x["h"] > 0 else None,
                      "cop_th": round(x["h_ok"] / x["e_th"], 2) if x["e_th"] > 0.1 else None,
                      "e_th": round(x["e_th"] * x["h"] / x["h_ok"], 2) if x["h_ok"] > 0 else None,
                      "sb": round(x["sb"], 2),
                      "out": round(sum(x["to"]) / len(x["to"]), 1) if x["to"] else None})
    blist = []
    for k in sorted(bins):
        b = bins[k]
        if b["e"] < 3.0 or b["h_ok"] <= 0:          # coarse (1-kWh) counters: a few kWh per bin at least
            continue
        blist.append({"t": k, "e": round(b["e"], 1), "h": round(b["h"], 1),
                      "cop": round(b["h"] / b["e"], 2) if b["e"] > 0 else None,
                      "cop_th": round(b["h_ok"] / b["e_th"], 2) if b["e_th"] > 0 else None,
                      "flow": round(b["tf"] / b["h_ok"], 1)})
    lv = live or {}
    life = None
    if lv.get("energy_kwh") and lv.get("eheater_kwh") is not None and lv["energy_kwh"] > 0:
        life = {"heater_kwh": round(lv["eheater_kwh"], 0), "heater_share": round(lv["eheater_kwh"] / lv["energy_kwh"], 3),
                "cop": lv.get("cop_lifetime")}

    # ---- levers: what would change it (same model, on the measured heat) ---- #
    def gain(a, key):
        """share of the electricity a lower temperature saves (model)"""
        return round(1.0 - a[key] / a["e_th"], 3) if a["e_th"] > 0.05 else None
    H, W = acc["heating"], acc["dhw"]
    levers = {"heat_flow": None, "dhw_temp": None, "dhw_midday": None}
    if H["e_th"] > 0.05:
        levers["heat_flow"] = {"flow": round(H["tf"] / H["h_ok"], 1), "e": round(H["e"], 1),
                               "gain2": gain(H, "e_m2"), "gain4": gain(H, "e_m4")}
    if W["e_th"] > 0.05:
        wf, wo = W["tf"] / W["h_ok"], W["to"] / W["h_ok"]
        levers["dhw_temp"] = {"flow": round(wf, 1), "e": round(W["e"], 1),
                              "gain2": gain(W, "e_m2"), "gain4": gain(W, "e_m4"),
                              "est": round(W["h_est"] / W["h_ok"], 2),
                              "src": "ret" if W["h_ret"] >= W["h_tank"] else "tank",
                              "ret": round(W["tr"] / W["h_tr"], 1) if W["h_tr"] > 0 else None}
        if len(mid_out) >= 12:
            mo = sum(mid_out) / len(mid_out)
            levers["dhw_midday"] = {"out_dhw": round(wo, 1), "out_mid": round(mo, 1), "e": round(W["e"], 1),
                                    "gain": round(max(0.0, 1.0 - cop_th(wo, wf) / cop_th(mo, wf)), 3)}
    rooms = [float(r["temp"]) for r in store.room_temp_series(since)]
    levers["heater"] = {"e": round(he_e, 1), "logged": he_logged,
                        "by_mode": {k: round(v, 1) for k, v in he_by.items()},
                        "cop_hp": R["cop"]}
    levers["warm"] = {"e": round(warm_e, 1), "h": round(warm_h, 1),
                      "cop": round(warm_h / warm_e, 2) if warm_e > 0.5 else None,
                      "share": round(warm_e / H["e"], 3) if H["e"] > 0.5 else None}
    levers["indoor"] = {"t": round(sum(rooms) / len(rooms), 1)} if len(rooms) >= 24 else None
    levers["starts"] = ({"per_day": round(st_n / st_h * 24.0, 1), "days": round(st_h / 24.0, 1),
                         "warm_share": round(st_warm / st_n, 2) if st_n else None,
                         "min_per_start": round(st_run * 60.0 / st_n) if st_n else None}
                        if st_h >= 24 else None)
    e_vals = [r["energy_kwh"] for r in rows]
    return {"ok": True, "n": n, "days": days, "span_d": round(span_d, 1),
            "spec": {"name": spec.get("name"), "pts": spec["pts"]}, "etas": etas,
            "cop": round(cop_meas, 2) if cop_meas else None,
            "cop_run": R["cop"], "cop_th": round(cop_theory, 2) if cop_theory else None,
            "ratio": round(cop_meas / cop_theory, 3) if (cop_meas and cop_theory) else None,
            "heat_kwh": round(tot_h, 1), "elec_kwh": round(tot_e, 1),
            "modes": {k: cops(acc[k]) for k in ("heating", "dhw") if acc[k]["e"] > 0.3},
            "bins": blist, "daily": daily, "gap": gapd, "levers": levers,
            "standby_w": round(sb_e / span_d / 24.0 * 1000.0) if span_d >= 1 else None,
            "heater_logged": he_logged, "lifetime": life,
            "counter_step": _counter_step(e_vals[-2000:]),
            "cover": R["cover"]}

LP_LEVELS = (600, 800, 1200, 2000, 3600, 5000, 8000, 10000, 15000)
LP_SM_MIN_S = 6 * 3600          # smart-meter data needed in the window to use it


def _load_peaks_smartmeter(store: "Store", days: float, since: int, now: int, sources: dict) -> dict | None:
    """Load peaks from the whole-house consumption the Fronius smart meter
    measures (minute means of the 15-s readings, plus the highest reading of
    each minute for the peaks). The measured plugs + heat pump are matched to
    the same minutes, so the per-device breakdown and the hourly split show
    the real rest instead of an estimate. Also: where the peaks came from
    (grid / battery / sun) and the highest grid import and battery output."""
    I = _PV_I
    raw = [r for r in store.pv_rows(since, now + 1) if r[I["load_w"]] is not None]
    if len(raw) < 2:
        return None
    ts = [r[0] for r in raw]
    diffs = sorted(b - a for a, b in zip(ts, ts[1:]) if b > a)
    step = diffs[len(diffs) // 2] if diffs else PV_STORE_EVERY
    cap = max(90.0, 2.5 * step)
    rows, prev = [], None
    for r in raw:
        dt = r[0] - prev if prev is not None else step
        prev = r[0]
        dur = dt if 0 < dt <= cap else step          # after a gap: the row stands for one step
        load = max(0.0, r[I["load_w"]])
        lmax = r[I["load_max_w"]]
        rows.append({"ts": r[0], "dur": float(dur), "gap": not (0 < dt <= cap), "load": load,
                     "peak": max(load, lmax if lmax is not None else load),
                     "grid": r[I["grid_w"]], "gmax": r[I["grid_max_w"]], "batt": r[I["batt_w"]],
                     "pv": r[I["pv_w"]]})
    total_s = sum(x["dur"] for x in rows)
    if total_s < LP_SM_MIN_S:
        return None
    # time-weighted percentiles of the minute means
    srt = sorted(rows, key=lambda x: -x["load"])
    vals = [x["load"] for x in srt]
    cum, acc = [], 0.0
    for x in srt:
        acc += x["dur"]
        cum.append(acc)

    def pct(fr):                                   # power exceeded fr of the time
        k = bisect.bisect_left(cum, fr * total_s)
        return round(vals[min(k, len(vals) - 1)], 0)
    pk_row = max(rows, key=lambda x: x["peak"])
    peak_w = round(pk_row["peak"], 0)
    ldc = [{"frac": round(i / 100.0, 2), "w": pct(i / 100.0)} for i in range(101)]
    levels = []
    for lv in LP_LEVELS:
        if lv > peak_w + 1:
            continue
        above = sum(x["dur"] for x in rows if x["load"] > lv)
        levels.append({"w": lv, "pct_above": round(above / total_s * 100.0, 1),
                       "hours_above": round(above / 3600.0, 2)})
    # peaks: contiguous minutes above a threshold, with where the power came from
    thr = max(pct(0.08), 300.0)
    events, i, n = [], 0, len(rows)
    while i < n:
        if rows[i]["load"] > thr:
            j = i
            while j + 1 < n and rows[j + 1]["load"] > thr and not rows[j + 1]["gap"]:
                j += 1
            seg = rows[i:j + 1]
            e_load = sum(x["load"] * x["dur"] for x in seg)
            e_grid = sum(max(0.0, x["grid"] or 0.0) * x["dur"] for x in seg if x["grid"] is not None)
            e_batt = sum(max(0.0, x["batt"] or 0.0) * x["dur"] for x in seg if x["batt"] is not None)
            pk = max(seg, key=lambda x: x["peak"])
            events.append({"peak_w": round(pk["peak"], 0), "start": int(seg[0]["ts"] - seg[0]["dur"]),
                           "dur_s": int(sum(x["dur"] for x in seg)),
                           "grid_share": round(min(1.0, e_grid / e_load), 2) if e_load > 0 else None,
                           "batt_share": round(min(1.0, e_batt / e_load), 2) if e_load > 0 else None})
            i = j + 1
        else:
            i += 1
    events.sort(key=lambda e: -e["peak_w"])
    # the plugs + heat pump on the same minutes → real breakdown and hourly split
    maxstale = 15 * 60
    ptrs = {k: 0 for k in sources}
    src_e = {k: 0.0 for k in sources}
    hs_tot, hs_meas, hs_dur = [0.0] * 24, [0.0] * 24, [0.0] * 24
    for x in rows:
        t, d = x["ts"], x["dur"]
        tm = t - d / 2.0                           # middle of the minute
        meas = 0.0
        for k, arr in sources.items():
            p = ptrs[k]
            while p + 1 < len(arr) and arr[p + 1][0] <= tm:
                p += 1
            ptrs[k] = p
            ts_k, pw_k = arr[p]
            if ts_k <= tm and tm - ts_k <= maxstale:
                meas += pw_k
                src_e[k] += pw_k * d / 3600.0
        h = min(23, max(0, int((tm - _day_of(int(tm))[0]) // 3600)))     # local hour (cached day bounds)
        hs_tot[h] += x["load"] * d
        hs_meas[h] += min(meas, x["load"]) * d
        hs_dur[h] += d
    total_kwh = sum(x["load"] * x["dur"] for x in rows) / 3.6e6
    measured_kwh = sum(src_e.values()) / 1000.0
    rest_kwh = max(0.0, total_kwh - measured_kwh)
    hour_dist = ([{"hour": h, "w": round(hs_tot[h] / hs_dur[h], 0) if hs_dur[h] else 0,
                   "measured_w": round(hs_meas[h] / hs_dur[h], 0) if hs_dur[h] else 0} for h in range(24)]
                 if sum(1 for v in hs_dur if v > 0) >= 12 else None)
    breakdown = None
    if sources:
        names = {dev["id"]: dev.get("custom_name") or dev.get("name") or dev["id"] for dev in store.devices()}
        bd = [{"name": "Wärmepumpe" if k == "__hp" else names.get(k, k), "kwh": round(e / 1000.0, 3), "measured": True}
              for k, e in src_e.items() if e > 0.5]
        bd.sort(key=lambda x: -x["kwh"])
        if rest_kwh > 0.01:
            bd.append({"name": "Rest (nicht einzeln gemessen)", "kwh": round(rest_kwh, 3), "measured": False})
        tot = sum(x["kwh"] for x in bd) or 1.0
        for x in bd:
            x["share"] = round(x["kwh"] / tot * 100.0, 1)
        breakdown = bd
    gp = [(max(x["gmax"] if x["gmax"] is not None else -1e9, x["grid"] if x["grid"] is not None else -1e9), x["ts"])
          for x in rows if x["grid"] is not None or x["gmax"] is not None]
    gpk = max(gp) if gp else None
    bt = [(x["batt"], x["ts"]) for x in rows if x["batt"] is not None]
    bmax = max(bt) if bt else None
    first = rows[0]["ts"] - rows[0]["dur"]
    return {"ok": True, "days": days, "bin_s": step, "n": n, "hours": round(total_s / 3600.0, 1),
            "sources": len(sources), "peak_w": peak_w, "peak_ts": int(pk_row["ts"]),
            "peak_mean_w": round(max(vals), 0), "p99_w": pct(0.01), "p95_w": pct(0.05), "p50_w": pct(0.5),
            "ldc": ldc, "levels": levels, "events": events[:10], "basis": "smartmeter",
            "sm": {"since": int(first), "span_days": round((rows[-1]["ts"] - first) / 86400.0, 1),
                   "covered_days": round(total_s / 86400.0, 1),
                   "window_days": days, "kwh": round(total_kwh, 2), "daily_kwh": round(total_kwh / (total_s / 86400.0), 2),
                   "measured_kwh": round(measured_kwh, 2), "rest_kwh": round(rest_kwh, 2),
                   "coverage": round(measured_kwh / total_kwh * 100.0, 1) if total_kwh > 0 else None,
                   "grid_peak_w": round(gpk[0], 0) if gpk and gpk[0] > 0 else None,
                   "grid_peak_ts": int(gpk[1]) if gpk and gpk[0] > 0 else None,
                   "batt_max_w": round(bmax[0], 0) if bmax and bmax[0] > 25 else None,
                   "batt_max_ts": int(bmax[1]) if bmax and bmax[0] > 25 else None,
                   "has_peaks": any(x["peak"] > x["load"] + 1 for x in rows)},
            "meter": None, "breakdown": breakdown, "hour_dist": hour_dist,
            "measured_kwh": round(measured_kwh, 3)}


def compute_load_peaks(store: "Store", days: float = 7, hp_live: dict | None = None) -> dict:
    """Load over time on a common grid, for load-management awareness: the
    biggest power peaks with their duration, a load-duration curve, and how much
    of the time a given output rating (e.g. 800 W) would cover.

    Base signal = sum of all MEASURED plugs + the heat pump. When manual
    whole-house meter readings exist we ANCHOR on them: the gap between the
    meter total and the measured sum ("ungemessener Rest") is distributed over
    the day following the rhythm of the measured devices, so the curve, peaks
    and levels reflect the real whole house. We also return a per-device
    breakdown (measured devices real + the unmeasured rest as one bucket) and a
    meter-anchored hourly distribution. Without a meter it stays measured-only
    and the note says so."""
    now = int(time.time())
    days = max(0.5, min(31.0, float(days)))
    since = int(now - days * 86400)
    bin_s = 60 if days <= 10 else 120
    maxstale = 15 * 60                       # forward-fill a reading up to 15 min

    sources: dict[str, list] = {}
    for r in store.samples_since(since):
        p = r.get("power_w")
        if p is not None:
            sources.setdefault(r["device_id"], []).append((int(r["ts"]), float(p)))
    hp = [(int(r["ts"]), float(r.get("power_w") or 0.0))
          for r in store.hp_samples_since(since) if r.get("power_w") is not None]
    if hp:
        sources["__hp"] = hp
    for k in sources:
        sources[k].sort()
    # a smart meter (Fronius) measures the whole house – far better than
    # summing the plugs and estimating the rest
    try:
        sm = _load_peaks_smartmeter(store, days, since, now, sources)
    except Exception as exc:               # never lose the card over it
        print(f"[loadpeaks] smart meter: {exc}", file=sys.stderr)
        sm = None
    if sm:
        return sm
    if not sources:
        return {"ok": True, "n": 0, "sources": 0}

    start = (since // bin_s) * bin_s
    ngrid = int((now - start) // bin_s) + 1
    if ngrid <= 2:
        return {"ok": True, "n": 0, "sources": len(sources)}
    ptrs = {k: 0 for k in sources}
    src_e = {k: 0.0 for k in sources}         # Wh integrated per source on the grid
    total = [0.0] * ngrid
    hour_of = [0] * ngrid
    for gi in range(ngrid):
        t = start + gi * bin_s
        hour_of[gi] = datetime.fromtimestamp(t).hour
        s = 0.0
        for k, arr in sources.items():
            p = ptrs[k]
            while p + 1 < len(arr) and arr[p + 1][0] <= t:
                p += 1
            ptrs[k] = p
            ts_k, pw_k = arr[p]
            if ts_k <= t and (t - ts_k) <= maxstale:
                s += pw_k
                src_e[k] += pw_k * bin_s / 3600.0      # Wh
        total[gi] = s
    n = ngrid
    win_hours = n * bin_s / 3600.0
    win_days = max(1e-6, win_hours / 24.0)
    measured_kwh = sum(src_e.values()) / 1000.0

    # ---- meter anchoring: augment the measured load up to the real whole-house
    # total from the manual meter readings, distributing the "unmeasured rest"
    # over the day by the rhythm of the measured devices --------------------- #
    meter = _meter_daily_kwh(store)
    basis = "measured"
    meter_block = breakdown = hour_dist = None
    if meter and meter["daily_kwh"] > 0 and measured_kwh > 0:
        meter_win_kwh = meter["daily_kwh"] * win_days
        rest_kwh = max(0.0, meter_win_kwh - measured_kwh)
        # measured avg-W-per-hour-of-day shape → spreads the rest over the day
        # (NOT onto instantaneous measured spikes, which would overstate peaks)
        hsum = [0.0] * 24
        hcnt = [0] * 24
        for gi in range(n):
            hsum[hour_of[gi]] += total[gi]
            hcnt[hour_of[gi]] += 1
        havg = [hsum[h] / hcnt[h] if hcnt[h] else 0.0 for h in range(24)]
        shape = sum(havg)
        rest_daily_kwh = rest_kwh / win_days
        if shape > 0:
            rest_w_hour = [rest_daily_kwh * 1000.0 * (havg[h] / shape) for h in range(24)]
        else:                                    # no shape → flat base
            rest_w_hour = [rest_daily_kwh * 1000.0 / 24.0] * 24
        for gi in range(n):                      # augment every bin → whole house
            total[gi] += rest_w_hour[hour_of[gi]]
        basis = "meter"
        hour_dist = [{"hour": h, "w": round(havg[h] + rest_w_hour[h], 0),
                      "measured_w": round(havg[h], 0)} for h in range(24)]
        names = {}
        for dev in store.devices():
            names[dev["id"]] = dev.get("custom_name") or dev.get("name") or dev["id"]
        bd = []
        for k, e in src_e.items():
            nm = "Wärmepumpe" if k == "__hp" else names.get(k, k)
            bd.append({"name": nm, "kwh": round(e / 1000.0, 3), "measured": True})
        bd.sort(key=lambda x: -x["kwh"])
        if rest_kwh > 0.01:
            bd.append({"name": "Nicht gemessen (Rest)",
                       "kwh": round(rest_kwh, 3), "measured": False})
        tot_kwh = sum(x["kwh"] for x in bd) or 1.0
        for x in bd:
            x["share"] = round(x["kwh"] / tot_kwh * 100.0, 1)
        breakdown = bd
        meter_block = {
            "daily_kwh": round(meter["daily_kwh"], 3),
            "win_kwh": round(meter_win_kwh, 3),
            "measured_kwh": round(measured_kwh, 3),
            "rest_kwh": round(rest_kwh, 3),
            "coverage": (round(measured_kwh / meter_win_kwh * 100.0, 1)
                         if meter_win_kwh > 0 else None),
            "span_days": round(meter["span_days"], 1),
        }

    srt = sorted(total, reverse=True)

    def pct(fr):                             # power exceeded fr of the time
        return round(srt[min(n - 1, int(fr * (n - 1)))], 0)
    peak_w = round(max(total), 0)
    ldc = [{"frac": round(i / 100.0, 2), "w": round(srt[min(n - 1, int(i / 100.0 * (n - 1)))], 0)}
           for i in range(101)]
    levels = []
    for lv in LP_LEVELS:
        if lv > peak_w + 1:
            continue
        cnt = sum(1 for v in total if v > lv)
        levels.append({"w": lv, "pct_above": round(cnt / n * 100.0, 1),
                       "hours_above": round(cnt * bin_s / 3600.0, 2)})
    # top excursion events: contiguous runs above a threshold, ranked by peak
    thr = max(pct(0.08), 300.0)
    events, i = [], 0
    while i < n:
        if total[i] > thr:
            j, pk = i, total[i]
            while j + 1 < n and total[j + 1] > thr:
                j += 1
                if total[j] > pk:
                    pk = total[j]
            events.append({"peak_w": round(pk, 0), "start": start + i * bin_s,
                           "dur_s": (j - i + 1) * bin_s})
            i = j + 1
        else:
            i += 1
    events.sort(key=lambda e: -e["peak_w"])
    return {"ok": True, "days": days, "bin_s": bin_s, "n": n,
            "hours": round(n * bin_s / 3600.0, 1), "sources": len(sources),
            "peak_w": peak_w, "p99_w": pct(0.01), "p95_w": pct(0.05),
            "p50_w": pct(0.5), "ldc": ldc, "levels": levels, "events": events[:10],
            "basis": basis, "meter": meter_block, "breakdown": breakdown,
            "hour_dist": hour_dist, "measured_kwh": round(measured_kwh, 3)}


# ===================================================================== #
#  Pre-aggregated day statistics ("rollup")                              #
# ===================================================================== #
# compute_analytics used to load EVERY raw sample of the window (90 days of
# 30-second readings per device = millions of rows) and reduce them in Python
# on each request – 15+ seconds once the history has grown, and it ran again
# every time the result cache went cold. A finished local day never changes,
# so each (device, day) is reduced ONCE to the handful of numbers the
# analytics need and stored in `dev_day`; requests then read ~one row per
# device and day plus the raw samples of the running day only.
#
# What a row holds is exactly what the old per-sample loops accumulated:
#   n, wh        sample count and the day's energy (same rules as
#                _energy_for_bucket: trusted counter deltas, else power integral)
#   t0, t1       first/last sample time (for the "active above standby" energy)
#   hs, hn       per hour of day: sum and count of the power readings
#   hist         histogram of the power readings (for the standby/peak
#                percentiles, which cannot be summed from per-day results)
ROLLUP_VER = 1                      # bump when the per-day math changes → rows are redone
_ROLLUP_LOCK = threading.Lock()


def _pbin(p: float) -> int:
    """Histogram bin of a power reading: 0.1 W steps below 50 W (where the
    standby floor lives), 1 W steps below 500 W, 10 W above. Keys rise with
    the power, so percentiles can be read off the sorted keys."""
    if p < 0.0:
        p = 0.0
    if p < 50.0:
        return int(p * 10.0 + 0.5)
    if p < 500.0:
        return 1000 + int(p + 0.5)
    return 2000 + int(p / 10.0 + 0.5)


def _pbin_value(k: int) -> float:
    if k < 1000:
        return k / 10.0
    if k < 2000:
        return float(k - 1000)
    return (k - 2000) * 10.0


def _hist_pick(hist: dict, idx: int) -> float:
    """The idx-th smallest reading (0-based) of a histogram."""
    c = 0
    for k in sorted(hist):
        c += hist[k]
        if c > idx:
            return _pbin_value(k)
    return _pbin_value(max(hist)) if hist else 0.0


def _day_bounds(day: str) -> tuple[int, int]:
    """[local midnight, next local midnight) of a 'YYYY-MM-DD' day – 23 or 25
    hours long on the days the clocks change."""
    d = datetime.strptime(day, "%Y-%m-%d")
    return int(d.timestamp()), int((d + timedelta(days=1)).timestamp())


def _day_range(d0: str, d1: str) -> list[str]:
    a, b = datetime.strptime(d0, "%Y-%m-%d"), datetime.strptime(d1, "%Y-%m-%d")
    out = []
    while a <= b:
        out.append(a.strftime("%Y-%m-%d"))
        a += timedelta(days=1)
    return out


def _last_final_day(now: float) -> str:
    """The newest local day that is over. In the first two minutes after
    midnight yesterday still counts as running, so a poll that was in flight
    at the day change is never missed."""
    cur = datetime.fromtimestamp(now - 120).replace(hour=0, minute=0, second=0, microsecond=0)
    return (cur - timedelta(days=1)).strftime("%Y-%m-%d")


def _day_stats(rows: list[tuple], midnight: int, next_midnight: int) -> dict | None:
    """Reduce the time-ordered (ts, power_w, energy_wh) samples of ONE device
    within ONE local day. None when there are no samples."""
    n = len(rows)
    if not n:
        return None
    hs, hn, hist = [0.0] * 24, [0] * 24, {}
    plain = (next_midnight - midnight) == 86400          # not a clock-change day
    for ts, p, _e in rows:
        if p is None:
            continue
        h = (ts - midnight) // 3600 if plain else datetime.fromtimestamp(ts).hour
        hs[h] += p
        hn[h] += 1
        k = _pbin(p)
        hist[k] = hist.get(k, 0) + 1
    # energy: identical rules to _energy_for_bucket
    wh = 0.0
    if n >= 2:
        live_counter = ((rows[-1][2] or 0.0) - (rows[0][2] or 0.0)) > 0.5
        prev = rows[0]
        for cur in rows[1:]:
            dt_h = (cur[0] - prev[0]) / 3600.0
            if 0.0 < dt_h <= MAX_SAMPLE_GAP_H:
                if live_counter:
                    d = (cur[2] or 0.0) - (prev[2] or 0.0)
                    if 0.0 <= d <= MAX_PLUG_W * dt_h * 1.1:
                        wh += d
                else:
                    pa = min(max(prev[1] or 0.0, 0.0), MAX_PLUG_W)
                    pb = min(max(cur[1] or 0.0, 0.0), MAX_PLUG_W)
                    wh += (pa + pb) / 2.0 * dt_h
            prev = cur
    return {"n": n, "wh": wh, "t0": rows[0][0], "t1": rows[-1][0],
            "hs": hs, "hn": hn, "hist": hist}


def _split_days(rows: list[tuple], days: list[str]):
    """Yield (day, midnight, next_midnight, rows-of-that-day) for each day."""
    ts_list = [r[0] for r in rows]
    for day in days:
        a, b = _day_bounds(day)
        i0, i1 = bisect.bisect_left(ts_list, a), bisect.bisect_left(ts_list, b)
        yield day, a, b, rows[i0:i1]


def rollup_ensure(store: "Store", first_day: str, now: float | None = None,
                  pause: float = 0.0, state: dict | None = None) -> int:
    """Make sure every device has its `dev_day` row for each FINISHED local day
    from ``first_day`` on. Missing days are computed from the raw samples, a
    month per device at a time; days already present cost one key lookup.
    Safe to call from several threads – whoever gets a chunk first computes it.
    Returns the number of rows written."""
    now = time.time() if now is None else now
    last = _last_final_day(now)
    if first_day > last:
        return 0
    have = store.dev_day_keys(first_day, ROLLUP_VER)
    made = 0
    for dev in store.sample_device_ids():
        first_ts = store.dev_first_ts(dev)
        if first_ts is None:
            continue
        d0 = max(first_day, _local_day(first_ts))
        if d0 > last:
            continue
        missing = [d for d in _day_range(d0, last) if (dev, d) not in have]
        for i in range(0, len(missing), 31):
            chunk = missing[i:i + 31]
            with _ROLLUP_LOCK:
                done = store.dev_day_keys(chunk[0], ROLLUP_VER)
                todo = [d for d in chunk if (dev, d) not in done]
                if not todo:
                    continue
                rows = store.samples_range(dev, _day_bounds(todo[0])[0], _day_bounds(todo[-1])[1])
                out = []
                for day, a, b, sl in _split_days(rows, todo):
                    st = _day_stats(sl, a, b)
                    if st is None:          # no data that day – remember it, so it is not re-read
                        out.append((dev, day, ROLLUP_VER, 0, 0.0, None, None, None))
                    else:
                        data = json.dumps({"hs": [round(x, 2) for x in st["hs"]], "hn": st["hn"],
                                           "hist": {str(k): c for k, c in st["hist"].items()}},
                                          separators=(",", ":"))
                        out.append((dev, day, ROLLUP_VER, st["n"], st["wh"], st["t0"], st["t1"], data))
                store.dev_day_put(out)
                made += len(out)
                if state is not None:
                    state["rows"] = state.get("rows", 0) + len(out)
            if pause:
                time.sleep(pause)            # background run: leave room for requests
    return made


def _window_stats(store: "Store", first_day: str, now: int) -> dict:
    """device -> {day -> stats} for [first_day … now]: finished days from the
    rollup, the running day(s) straight from the raw samples."""
    rollup_ensure(store, first_day, now)
    last = _last_final_day(now)
    per: dict[str, dict[str, dict]] = {}
    for dev, day, n, wh, t0, t1, data in store.dev_day_rows(first_day, ROLLUP_VER):
        if day > last or not data:
            continue
        d = json.loads(data)
        per.setdefault(dev, {})[day] = {
            "n": n, "wh": wh, "t0": t0, "t1": t1, "hs": d["hs"], "hn": d["hn"],
            "hist": {int(k): c for k, c in d["hist"].items()}}
    live_first = (datetime.strptime(last, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    live_days = _day_range(max(live_first, first_day), _local_day(now))
    if live_days:
        a = _day_bounds(live_days[0])[0]
        for dev in store.sample_device_ids():
            rows = store.samples_range(dev, a, now + 1)
            if not rows:
                continue
            for day, da, db, sl in _split_days(rows, live_days):
                st = _day_stats(sl, da, db)
                if st is not None:
                    per.setdefault(dev, {})[day] = st
    return per


def compute_analytics(store: Store, days: int, price: float) -> dict:
    """Smart-home analytics over the last ``days`` days. Built from one
    pre-aggregated row per device and finished day plus today's raw samples –
    see the rollup notes above. The window starts at local midnight ``days``
    days ago (the oldest day is whole instead of being cut at the time of day)."""
    now = int(time.time())
    first_day = _local_day(now - days * 86400)
    per = _window_stats(store, first_day, now)
    devices = {d["id"]: d for d in store.devices()}
    # devices in the order their first sample of the window appears
    dev_order = sorted(per, key=lambda dv: (min(st["t0"] for st in per[dv].values()), dv))

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

    # --- percentiles from the merged power histograms ---------------------- #
    # baseline (standby) power = low percentile of all power readings
    all_hist: dict[int, int] = {}
    dev_hist: dict[str, dict[int, int]] = {}
    dev_n: dict[str, int] = {}
    for dev_id in dev_order:
        dh_ = dev_hist.setdefault(dev_id, {})
        n_dev = 0
        for st in per[dev_id].values():
            n_dev += st["n"]
            for k, c in st["hist"].items():
                dh_[k] = dh_.get(k, 0) + c
                all_hist[k] = all_hist.get(k, 0) + c
        dev_n[dev_id] = n_dev
    n_all = sum(all_hist.values())
    baseline_w = _hist_pick(all_hist, max(0, int(n_all * 0.10) - 1)) if n_all else 0.0

    # per-device standby floor: the power a device draws nearly all the time
    # (low percentile of ITS OWN readings). A light that is often off → ~0 (no
    # standby); a router/TV that always sips a few W → that floor = its standby.
    dev_standby: dict[str, float] = {}
    dev_peak: dict[str, float] = {}
    for dev_id, h in dev_hist.items():
        m = sum(h.values())
        if m:
            dev_standby[dev_id] = round(_hist_pick(h, max(0, int(m * 0.10) - 1)), 2)
            dev_peak[dev_id] = round(_hist_pick(h, min(m - 1, int(m * 0.97))), 2)
    for d in per_device:
        d["standby_w"] = dev_standby.get(d["id"], 0.0)
        d["peak_w"] = dev_peak.get(d["id"], 0.0)
        # does this device report power at all in the window? (vs. a pure
        # switch/contact/thermostat that never contributes a standby reading)
        d["measures_power"] = d["id"] in dev_standby
        d["win_samples"] = dev_n.get(d["id"], 0)

    # --- day / hour / weekday buckets ------------------------------------- #
    day_kwh: dict[str, float] = {}
    day_active_kwh: dict[str, float] = {}
    hour_sum, hour_n = [0.0] * 24, [0] * 24
    hw_sum: dict[tuple[int, int], float] = {}
    hw_n: dict[tuple[int, int], int] = {}
    weekday_kwh: dict[int, list[float]] = {i: [] for i in range(7)}
    per_device_day: dict[str, dict[str, float]] = {}
    per_device_hour: dict[str, list[float]] = {}

    for dev_id in dev_order:
        dsum, dn = [0.0] * 24, [0] * 24
        for day in sorted(per[dev_id]):
            st = per[dev_id][day]
            wh = st["wh"]
            day_kwh[day] = day_kwh.get(day, 0.0) + wh / 1000.0
            per_device_day.setdefault(dev_id, {})[day] = round(wh / 1000.0, 4)
            # active energy = above standby baseline
            active_wh = max(0.0, wh - baseline_w * ((st["t1"] - st["t0"]) / 3600.0))
            day_active_kwh[day] = day_active_kwh.get(day, 0.0) + active_wh / 1000.0
            # hourly / weekday average power profile (overall + per device)
            wd = datetime.strptime(day, "%Y-%m-%d").weekday()
            hs, hn = st["hs"], st["hn"]
            for h in range(24):
                c = hn[h]
                if c:
                    v = hs[h]
                    hour_sum[h] += v; hour_n[h] += c
                    dsum[h] += v; dn[h] += c
                    hw_sum[(wd, h)] = hw_sum.get((wd, h), 0.0) + v
                    hw_n[(wd, h)] = hw_n.get((wd, h), 0) + c
        per_device_hour[dev_id] = [round(dsum[h] / dn[h], 2) if dn[h] else 0.0 for h in range(24)]

    for day, kwh in day_kwh.items():
        wd = datetime.strptime(day, "%Y-%m-%d").weekday()
        weekday_kwh[wd].append(kwh)

    days_sorted = sorted(day_kwh.keys())
    daily_series = [{"day": d, "kwh": round(day_kwh[d], 3),
                     "active_kwh": round(day_active_kwh.get(d, 0.0), 3)}
                    for d in days_sorted]

    hourly_profile = [
        {"hour": h, "avg_w": round(hour_sum[h] / hour_n[h], 2) if hour_n[h] else 0.0}
        for h in range(24)
    ]
    weekday_profile = [
        {"weekday": i,
         "avg_kwh": round(sum(v) / len(v), 3) if v else 0.0}
        for i, v in weekday_kwh.items()
    ]
    # 7 x 24 grid of average power (W) for the profile heatmap
    heatmap = []
    for wd in range(7):
        heatmap.append([round(hw_sum[(wd, h)] / hw_n[(wd, h)], 1) if hw_n.get((wd, h)) else 0.0
                        for h in range(24)])

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


_DAY_CACHE = (0, 0, "")     # (midnight, next midnight, 'YYYY-MM-DD') of the last local day looked up


def _day_of(ts: int) -> tuple:
    """(local midnight, next local midnight, day) of the day containing ts.
    Samples are walked in time order, so the previous answer is almost always
    still the right one – this turns two mktime/localtime calls per sample
    into one comparison. The tuple is replaced as a whole (thread-safe)."""
    global _DAY_CACHE
    c = _DAY_CACHE
    if c[0] <= ts < c[1]:
        return c
    lt = time.localtime(ts)
    day0 = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1)))
    # next local midnight, recomputed from a point safely inside the next day
    nlt = time.localtime(day0 + 86400 + 7200)
    next_mid = int(time.mktime((nlt.tm_year, nlt.tm_mon, nlt.tm_mday, 0, 0, 0, 0, 0, -1)))
    c = (day0, next_mid, time.strftime("%Y-%m-%d", lt))
    _DAY_CACHE = c
    return c


def _spread_delta_over_days(out: dict, pt: int, ts: int, delta: float):
    """Add `delta` kWh to `out`, split across the local calendar days spanned by
    [pt, ts] proportional to the time in each day (DST-aware via localtime)."""
    total = ts - pt
    _d0, next_mid, day = _day_of(pt)
    if total <= 0 or ts <= next_mid:          # within one local day – the usual case
        out[day] = out.get(day, 0.0) + delta
        return
    seg_start = pt
    guard = 0
    while seg_start < ts and guard < 400:
        guard += 1
        _d0, next_mid, day = _day_of(seg_start)
        seg_end = min(next_mid, ts)
        out[day] = out.get(day, 0.0) + delta * (seg_end - seg_start) / total
        seg_start = seg_end


HP_GAP_MIN_S = 1800      # counter readings further apart than this: a data gap


_HP_DATA_KEYS = ("energy_kwh", "power_w", "heat_kwh", "modulation", "supply_c", "outdoor_c")


def _hp_has_data(s: dict) -> bool:
    """False for an empty sample: older bridges stored one per poll while the
    cloud login was expired (all values None, mode 'off'). It is a data gap,
    not a pause of the heat pump."""
    return any(s.get(k) is not None for k in _HP_DATA_KEYS)


def _hp_gap_s(rows: list[dict]) -> float:
    """Longest interval between two counter readings that still counts as normal
    polling. Across a longer one the bridge did not see the heat pump (bridge
    stopped, Mac asleep, cloud login expired): the counter still says how much
    energy was used, but not when, nor for which operating mode. 30 min, or three
    typical poll intervals for a bridge set to poll less often (typical = lower
    quartile, so a few long gaps among few samples cannot stretch it)."""
    ts = [s["ts"] for s in rows if s.get("energy_kwh") is not None] \
        or [s["ts"] for s in rows if _hp_has_data(s)]
    d = sorted(b - a for a, b in zip(ts, ts[1:]) if b > a)
    return float(max(HP_GAP_MIN_S, 3 * d[len(d) // 4])) if d else float(HP_GAP_MIN_S)


def _hp_mode_buckets(rows: list[dict], only_day: str | None = None,
                     gap_s: float | None = None) -> dict:
    """Electrical kWh attributed to the operating mode (Heizung/Warmwasser/Sonstiges)
    by consecutive counter deltas – the heat pump's own 'wofür'. Energy counted
    across a data gap stays in the total but goes to 'gap' (mode unknown) instead
    of being credited to whatever mode ran at the edge of the gap."""
    if gap_s is None:
        gap_s = _hp_gap_s(rows)
    b = {"heating": 0.0, "water": 0.0, "other": 0.0, "gap": 0.0}
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
                if s["ts"] - pt > gap_s:
                    key = "gap"          # hours unseen: the mode at either edge says nothing
                else:
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

    gap_s = _hp_gap_s(rows)
    mode_today = _hp_mode_buckets(rows, only_day=today, gap_s=gap_s)
    mode_window = _hp_mode_buckets(rows, gap_s=gap_s)
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
                           "other": round(max(0.0, elec_sum - heating - water), 3), "gap": 0.0}
        trow = next((r for r in imp_days if r["date"] == today), None)
        if trow and trow.get("heating_kwh") is not None:
            mode_today = {"heating": round(trow.get("heating_kwh") or 0.0, 3),
                          "water": round(trow.get("water_kwh") or 0.0, 3),
                          "other": round(max(0.0, (trow.get("elec_kwh") or 0.0)
                                             - (trow.get("heating_kwh") or 0.0)
                                             - (trow.get("water_kwh") or 0.0)), 3), "gap": 0.0}
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

    try:
        fl = compute_flow(store, days=14, rows=rows)
        flow = {"now": fl["now"], "system": fl["system"],
                "measured": {"available": fl["measured"]["available"], "path": fl["measured"]["path"]},
                "derived": {k: fl["derived"][k] for k in ("typical", "n", "spread_k", "sure", "behaviour", "why")}}
    except Exception as exc:
        print(f"[hp] flow: {exc}", file=sys.stderr)
        flow = None
    return {
        "generated_at": now,
        "window_days": days,
        "connected": bool(live.get("connected") or rows),
        "flow": flow,
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
            "flow_lmin": live.get("flow_lmin"),
            "energy_kwh": live.get("energy_kwh"),
            "heat_kwh": live.get("heat_kwh"),
            "compressor_kwh": live.get("compressor_kwh"),
            "eheater_kwh": live.get("eheater_kwh"),
            "starts": live.get("starts"),
            "working_h": live.get("working_h"),
            "last_poll": live.get("last_poll"),
            "last_error": live.get("last_error"),
            "last_error_ts": live.get("last_error_ts"),
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


def compute_heating_curve(store: "Store", days: int = 30, hp_live: dict | None = None,
                          since: int | None = None, until: int | None = None,
                          range_label: str | None = None) -> dict:
    """The REAL heating curve: flow temperature vs. outdoor temperature from the
    stored samples + the current operating point, a fitted (or provisional) line,
    the WP-friendly target band, and a CONCRETE recommendation (Niveau/Steilheit).

    The time window is either the last ``days`` days (default) or an explicit
    [``since``, ``until``) range (for "heute"/"gestern"/"gesamt"). The live
    operating point is only folded in when the window reaches up to now.

    Historic CSV/energy data has no flow temperature, so the curve builds from the
    flow/return we log from now on – plus the live snapshot, so a first
    recommendation is possible immediately instead of waiting days."""
    now = int(time.time())
    if until is None:
        until = now
    if since is None:
        since = now - days * 86400
    includes_now = until >= now - 300          # window reaches "now"? → live point valid
    rows = [s for s in store.hp_samples_since(since) if s.get("ts", 0) < until]
    pts = []
    for s in rows:
        o, sup = s.get("outdoor_c"), s.get("supply_c")
        m = (s.get("mode") or "").lower()
        heating = m in ("ch", "heating", "heat")
        if o is None or sup is None or sup < 20 or not heating:
            continue
        if (s.get("modulation") or 0) <= 0:
            continue
        # [outdoor, supply, ts] – the ts lets the UI shade points by recency.
        pts.append((round(float(o), 1), round(float(sup), 1), s.get("ts")))
    # historical heating-curve points imported from a HomeCom CSV (flow temp vs.
    # outdoor during space-heating hours) – make the curve usable immediately.
    csv_rows = [s for s in store.hp_curve_since(since) if s.get("ts", 0) < until]
    for s in csv_rows:
        o, sup = s.get("outdoor_c"), s.get("supply_c")
        if o is not None and sup is not None and sup >= 20:
            pts.append((round(float(o), 1), round(float(sup), 1), s.get("ts")))
    n_csv = len(csv_rows)
    # add the live operating point (counts immediately, before history fills up) –
    # only when the window actually includes the present moment.
    live_pt = None
    if hp_live and includes_now:
        lo, ls = hp_live.get("outdoor_c"), hp_live.get("supply_c")
        lm = (hp_live.get("mode") or "").lower()
        if lo is not None and ls is not None and ls >= 20 and lm in ("ch", "heating", "heat") \
                and (hp_live.get("modulation") or 0) > 0:
            live_pt = (round(float(lo), 1), round(float(ls), 1))
            pts.append((live_pt[0], live_pt[1], now))     # newest point
    n = len(pts)
    cyc = hp_cycle_stats(rows)
    win = {"range": range_label, "since": since, "until": until, "days_window": days}
    if n == 0:
        ranged = range_label in ("today", "yesterday") or (range_label or "").endswith("d")
        note = ("In diesem Zeitraum hat die Wärmepumpe keine Heizpunkte aufgezeichnet "
                "(z. B. zu mild, oder sie lief nicht). Wähle einen längeren Zeitraum "
                "oder „Gesamt“.") if ranged else \
               ("Noch keine Heizpunkte. Entweder heizt die Wärmepumpe gerade nicht, oder "
                "importiere im Setup deinen HomeCom-CSV-Export – er enthält stündlich "
                "Vorlauf- und Außentemperatur, daraus baue ich die Kurve sofort.")
        return {"ok": True, "enough": False, "n": 0, "points": [], "cycles": cyc,
                "csv_points": 0, "note": note, **win}

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
        verdict = "Heizkurve niedrig eingestellt – effizient (Komfort im Blick behalten)."
    else:
        verdict = "Heizkurve WP-freundlich eingestellt."
    saving_pct = round(min(0.18, max(0.0, over_k) * 0.025), 3)

    # concrete recommendation. KEY: a LOW curve is good for a heat pump – raising
    # it is never an efficiency recommendation, only a comfort note.
    niveau = round(over_k)                    # >0 = lower the curve; <0 = already low
    rec = {"basis": basis, "niveau_k": niveau, "efficient": niveau <= -2,
           "slope_act10": slope_act10, "slope_ideal10": slope_ideal10, "steil": steil}
    parts = []
    comfort_ok = True
    if niveau >= 2:
        parts.append(f"<b>Niveau / Parallelverschiebung um ca. −{niveau} K</b> senken "
                     f"(die ganze Kurve bzw. den Vorlauf-Soll um {niveau} K runter)")
        comfort_ok = False
    elif niveau <= -2:
        parts.append("deine Kurve liegt <b>bereits unter dem WP-Zielband</b> – das ist "
                     "<b>effizient</b>. <b>Niveau so lassen</b>; nur anheben, falls einzelne Räume "
                     "nicht richtig warm werden")
    else:
        parts.append("das <b>Niveau</b> passt bereits gut")
    # steeper = more flow in the cold = less efficient → only suggest when the
    # curve isn't already low; flatter always saves, so always allowed.
    if steil == "flacher":
        parts.append(f"die <b>Steilheit/Gradient etwas flacher</b> stellen "
                     f"(aktuell ~{slope_act10} K je 10 K kälter, Ziel ~{slope_ideal10})")
    elif steil == "steiler" and not comfort_ok:
        parts.append(f"die <b>Steilheit etwas steiler</b> stellen "
                     f"(aktuell ~{slope_act10}, Ziel ~{slope_ideal10} K je 10 K kälter)")
    rec["text"] = " und ".join(parts) + "."
    rec["howto"] = ("Immer in kleinen Schritten (2–3 K bzw. eine Stufe), dann 1–2 Tage beobachten. "
                    "Ziel: der <b>niedrigste</b> Vorlauf, bei dem alle Räume – besonders der kälteste "
                    "(Leitraum) – gerade noch warm werden.") if not comfort_ok else \
        ("Niedriger Vorlauf = effizient. Falls ein Raum zu kühl bleibt, lieber erst den "
         "<b>hydraulischen Abgleich</b> prüfen, bevor du die ganze Kurve anhebst.")

    # reference points at the Bosch heating-curve anchors (+20 °C and −10 °C),
    # plus a midpoint, so the table lines up with the device's two curve points.
    ref = [{"outdoor": rx, "actual": round(a * rx + b, 1), "ideal": round(_ideal_flow(rx), 1)}
           for rx in (20, 0, -10)]
    step = max(1, n // 300)
    return {"ok": True, "enough": True, "provisional": not full_fit, "basis": basis,
            "n": n, "csv_points": n_csv,
            "points": pts[::step], "live_point": live_pt,
            "fit": {"a": round(a, 3), "b": round(b, 2)},
            "ideal": [{"x": round(x, 1), "y": round(_ideal_flow(x), 1)} for x in
                      [xmin + (xmax - xmin) * k / 20 for k in range(21)]],
            "xmin": round(xmin, 1), "xmax": round(xmax, 1),
            "over_k": over_k, "verdict": verdict, "saving_pct": saving_pct,
            "recommendation": rec, "ref": ref, "cycles": cyc, **win}


def _linfit(xy):
    """Least-squares slope+intercept for [(x,y)], or None."""
    n = len(xy)
    if n < 3:
        return None
    mx = sum(p[0] for p in xy) / n
    my = sum(p[1] for p in xy) / n
    sxx = sum((p[0] - mx) ** 2 for p in xy)
    if sxx < 1e-6:
        return None
    a = sum((p[0] - mx) * (p[1] - my) for p in xy) / sxx
    return a, my - a * mx


def _live_hourly(rows: list[dict], cutoff: int) -> dict:
    """Hourly outdoor/flow/consumption/COP derived from the LIVE hp_samples –
    so the time-series works without a CSV import. Consumption comes from the
    cumulative electric/heat counters (per-sample deltas, split by mode)."""
    rows = sorted(rows, key=lambda s: s.get("ts", 0))
    # across a data gap the counters say how much, but not in which hour or
    # mode – such deltas are left out rather than piled onto the hour after it
    gap_s = _hp_gap_s(rows)
    buckets: dict[int, dict] = {}
    prev_e = prev_h = None
    for s in rows:
        ts = int(s.get("ts", 0))
        hts = (ts // 3600) * 3600
        b = buckets.setdefault(hts, {"outs": [], "sups": [], "elec": 0.0,
                                     "heat": 0.0, "heating": 0.0, "water": 0.0})
        if s.get("outdoor_c") is not None:
            b["outs"].append(s["outdoor_c"])
        if s.get("supply_c") is not None:
            b["sups"].append(s["supply_c"])
        mode = (s.get("mode") or "").lower()
        # recognise hot-water modes broadly; everything else (incl. unknown)
        # counts as heating so the consumption bars always show
        is_water = ("dhw" in mode or "water" in mode or "ww" in mode or "warm" in mode)
        e = s.get("energy_kwh")
        if e is not None and prev_e is not None:
            de, dt_h = e - prev_e[1], (ts - prev_e[0]) / 3600.0
            if de > 0 and 0 < ts - prev_e[0] <= gap_s and (de / dt_h) <= 25:
                b["elec"] += de
                if is_water:
                    b["water"] += de
                else:
                    b["heating"] += de
        if e is not None:
            prev_e = (ts, e)
        h = s.get("heat_kwh")
        if h is not None and prev_h is not None:
            dh, dt_h = h - prev_h[1], (ts - prev_h[0]) / 3600.0
            if dh >= 0 and 0 < ts - prev_h[0] <= gap_s and (dh / dt_h) <= 60:
                b["heat"] += dh
        if h is not None:
            prev_h = (ts, h)
    out = {}
    for hts, b in buckets.items():
        if hts < cutoff:
            continue
        elec, heat = b["elec"], b["heat"]
        out[hts] = {
            "ts": hts, "hour": datetime.fromtimestamp(hts).hour,
            "outdoor": round(sum(b["outs"]) / len(b["outs"]), 1) if b["outs"] else None,
            "supply": round(sum(b["sups"]) / len(b["sups"]), 1) if b["sups"] else None,
            "indoor": None, "water_t": None,
            "elec": round(elec, 2) if elec > 0 else None,
            "heat": round(heat, 2) if heat > 0 else None,
            "heating": round(b["heating"], 2), "water": round(b["water"], 2),
            "cop": round(heat / elec, 2) if (elec > 0.05 and heat > 0) else None}
    return out


HP_IDLE_W = 40.0                 # below this the heat pump is in standby / pause
HP_MAX_KW = 12.0                 # plausible electrical ceiling (compressor + heater)


def _hp_day_metrics(rows: list[dict]) -> tuple:
    """Operating KPIs + state segments for ONE day's heat-pump samples.
    Returns (kpis, segments, heater_segments, comp_max_w). Shared by the day
    timeline and the multi-day trend. Defrost / backup-heater are derived from
    the physical signatures (heat collapses while the compressor draws;
    electrical power above the compressor envelope). Across a data gap the
    state is unknown: no segment and no minutes for it (the ribbon shows a
    hole), only its energy still counts (up to 2 h, as before)."""
    rows = [s for s in rows if _hp_has_data(s)] or rows      # empty samples = gap
    gap_s = _hp_gap_s(rows)

    def cop_of(s):
        p, h = s.get("power_w") or 0.0, s.get("heat_w") or 0.0
        return (h / p) if p > 50 else 0.0

    comp_pw = [s["power_w"] for s in rows if (s.get("power_w") or 0) > 150
               and cop_of(s) >= 2.0]
    comp_max = max(comp_pw) if comp_pw else 3000.0

    def state_of(s):
        p = s.get("power_w") or 0.0
        m = (s.get("mode") or "").lower()
        o = s.get("outdoor_c")
        if p <= HP_IDLE_W or m in ("", "off", "standby"):
            return "idle"
        if m == "dhw" or "water" in m or "ww" in m:
            return "water"
        if "cool" in m:
            return "cooling"
        if m in ("ch", "heat", "heating") and cop_of(s) < 0.6 and p > 250 \
                and (o is None or o < 9.0):
            return "defrost"
        return "heating"

    def heater_on(s):
        return (s.get("power_w") or 0.0) > comp_max * 1.15 and cop_of(s) < 1.6

    segs, heat_segs = [], []
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        if b["ts"] - a["ts"] > gap_s:
            continue
        st = state_of(a)
        if segs and segs[-1][0] == st and a["ts"] - segs[-1][2] <= gap_s:
            segs[-1][2] = b["ts"]
        else:
            segs.append([st, a["ts"], b["ts"]])
        if heater_on(a):
            if heat_segs and a["ts"] - heat_segs[-1][1] <= gap_s:
                heat_segs[-1][1] = b["ts"]
            else:
                heat_segs.append([a["ts"], b["ts"]])
    segs = [s for s in segs if s[2] - s[1] >= 60] or segs

    elec_wh = heat_wh = 0.0
    runtime_s = pause_s = 0.0
    mode_s = {"heating": 0.0, "water": 0.0, "cooling": 0.0, "defrost": 0.0, "idle": 0.0}
    heater_s = 0.0
    starts = 0
    mod_sum = mod_n = 0
    out_sum = out_n = 0.0
    maxp = 0.0
    prev_run = None
    for i in range(len(rows) - 1):
        a, b = rows[i], rows[i + 1]
        dt_s = b["ts"] - a["ts"]
        st = state_of(a)
        run = st != "idle"
        if 0 < dt_s <= 2 * 3600:
            dt_h = dt_s / 3600.0
            pa = min(max(a.get("power_w") or 0.0, 0.0), HP_MAX_KW * 1000)
            pb = min(max(b.get("power_w") or 0.0, 0.0), HP_MAX_KW * 1000)
            elec_wh += (pa + pb) / 2.0 * dt_h
            ha = max(a.get("heat_w") or 0.0, 0.0)
            hb = max(b.get("heat_w") or 0.0, 0.0)
            heat_wh += (ha + hb) / 2.0 * dt_h
        if 0 < dt_s <= gap_s:
            mode_s[st] += dt_s
            (runtime_s, pause_s) = (runtime_s + dt_s, pause_s) if run else (runtime_s, pause_s + dt_s)
            if heater_on(a):
                heater_s += dt_s
        if prev_run is not None and (not prev_run) and run:
            starts += 1
        prev_run = run
        if run and a.get("modulation") is not None:
            mod_sum += a["modulation"]
            mod_n += 1
        if a.get("outdoor_c") is not None:
            out_sum += a["outdoor_c"]
            out_n += 1
        maxp = max(maxp, a.get("power_w") or 0.0)
    maxp = max(maxp, rows[-1].get("power_w") or 0.0)

    kpis = {
        "elec_kwh": round(elec_wh / 1000.0, 2), "heat_kwh": round(heat_wh / 1000.0, 2),
        "cop": round(heat_wh / elec_wh, 2) if elec_wh > 1 else None,
        "runtime_min": round(runtime_s / 60.0), "pause_min": round(pause_s / 60.0),
        "starts": starts, "defrost_count": sum(1 for s in segs if s[0] == "defrost"),
        "defrost_min": round(mode_s["defrost"] / 60.0),
        "heater_min": round(heater_s / 60.0),
        "max_power_kw": round(maxp / 1000.0, 2),
        "avg_mod": round(mod_sum / mod_n) if mod_n else None,
        "min_per_start": round(runtime_s / 60.0 / starts) if starts else None,
        "heating_min": round(mode_s["heating"] / 60.0),
        "water_min": round(mode_s["water"] / 60.0),
        "cooling_min": round(mode_s["cooling"] / 60.0),
        "avg_outdoor": round(out_sum / out_n, 1) if out_n else None,
    }
    return kpis, segs, heat_segs, comp_max


def compute_hp_day(store: "Store", date_str: str | None = None,
                   hp_live: dict | None = None) -> dict:
    """Chronological one-day timeline of the heat pump: a state ribbon
    (Heizung / Warmwasser / Abtauen / Kühlen / Pause) with the electric heater
    highlighted, the electrical & thermal power, modulation, COP and
    flow/return/outdoor temperatures over the day, day KPIs and an event log.
    Defrost and backup-heater are DERIVED from the physical signatures (heat
    collapses while the compressor draws; electrical power above the compressor
    envelope), since the HomeCom poll does not expose explicit flags."""
    now = int(time.time())
    base = datetime.fromtimestamp(now)
    if date_str:
        try:
            d0 = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            d0 = base
    else:
        d0 = base
    start = int(d0.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    end = start + 86400
    date = _local_day(start)
    today0 = int(base.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    first = store.hp_first_ts()
    has_prev = bool(first) and first < start
    has_next = start < today0
    rows = [s for s in store.hp_samples_between(start, end) if s.get("ts")]
    meta = {"ok": True, "date": date, "weekday": d0.weekday(),
            "is_today": start == today0, "has_prev": has_prev, "has_next": has_next,
            "start": start}
    if len(rows) < 2:
        return {**meta, "n": len(rows)}

    kpis, segs, heat_segs, comp_max = _hp_day_metrics(rows)

    # ---- raw per-sample series (capped), so the client can zoom the time
    # axis to any span and re-bucket at full resolution -------------------- #
    cap = 720
    stride = max(1, len(rows) // cap)
    raw = []
    for i in range(0, len(rows), stride):
        s = rows[i]
        pw, hw = s.get("power_w"), s.get("heat_w")
        raw.append({
            "t": s["ts"],
            "p": round(pw / 1000.0, 3) if pw is not None else None,
            "h": round(hw / 1000.0, 3) if hw is not None else None,
            "mod": s.get("modulation"),
            "cop": round(hw / pw, 2) if (pw and pw > 50 and hw) else None,
            "sup": s.get("supply_c"), "ret": s.get("return_c"), "out": s.get("outdoor_c"),
        })

    # ---- per-room indoor temperatures for the SAME day as RAW points (the
    # thermostats report sparse point measurements; the client connects them) - #
    ROOM_PAL = ["#3ba9ff", "#ff6b8a", "#4be0b0", "#ffb64d", "#b794f6", "#f78fb3",
                "#7ed6df", "#e77f67"]
    rlog: dict[str, list] = {}
    rsp: dict[str, list] = {}
    for r in store.room_log_since(start):
        if r.get("ts", 0) >= end:
            continue
        rm, tv = r.get("room"), r.get("temp")
        if not rm or tv is None:
            continue
        rlog.setdefault(rm, []).append((r["ts"], tv))
        if r.get("setpoint") is not None:
            rsp.setdefault(rm, []).append(r["setpoint"])
    rooms_out = []
    for i, rm in enumerate(sorted(rlog.keys())):
        pts = sorted(rlog[rm])
        rstride = max(1, len(pts) // 360)
        prs = [{"t": p[0], "temp": round(p[1], 2)} for p in pts[::rstride]]
        sps = sorted(rsp.get(rm) or [])
        sp = round(sps[len(sps) // 2], 1) if sps else None
        rooms_out.append({"room": rm, "color": ROOM_PAL[i % len(ROOM_PAL)],
                          "setpoint": sp, "points": prs})

    # ---- chronological event log ------------------------------------------ #
    events = []
    for st, a, b in segs:
        events.append({"ts": a, "kind": st, "dur_s": b - a})
    for a, b in heat_segs:
        if b - a >= 60:
            events.append({"ts": a, "kind": "heater", "dur_s": b - a})
    events.sort(key=lambda e: e["ts"])

    return {**meta, "n": len(rows), "kpis": kpis, "raw": raw, "rooms": rooms_out,
            "data_start": rows[0]["ts"], "data_end": rows[-1]["ts"],
            "segments": [{"state": s[0], "start": s[1], "end": s[2]} for s in segs],
            "heater": [{"start": a, "end": b} for a, b in heat_segs],
            "events": events, "comp_max_w": round(comp_max)}


def compute_hp_trend(store: "Store", days: int = 21, hp_live: dict | None = None) -> dict:
    """Per-day operating KPIs over the last `days` days, to see a trend: how
    many compressor starts (Takte) per day, how long each cycle lasts
    (min/Takt), runtime, Ø modulation, COP and defrost count – so the effect of
    a hydraulic-balancing change shows up as the unit running longer and calmer.
    Ø outdoor is included as weather context (cold days cycle less on their
    own)."""
    now = int(time.time())
    days = max(7, min(90, int(days)))
    base = datetime.fromtimestamp(now)
    start0 = int((base - timedelta(days=days - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0).timestamp())
    by_day: dict[str, list] = {}
    for s in store.hp_samples_since(start0):
        if s.get("ts"):
            by_day.setdefault(_local_day(s["ts"]), []).append(s)
    daily = []
    for day in sorted(by_day):
        drows = by_day[day]
        if len(drows) < 2:
            continue
        k, _segs, _h, _c = _hp_day_metrics(drows)
        daily.append({
            "date": day, "starts": k["starts"], "runtime_min": k["runtime_min"],
            "min_per_start": k["min_per_start"], "avg_mod": k["avg_mod"],
            "cop": k["cop"], "defrost_count": k["defrost_count"],
            "elec_kwh": k["elec_kwh"], "heat_kwh": k["heat_kwh"],
            "heater_min": k["heater_min"], "avg_outdoor": k["avg_outdoor"],
        })
    return {"ok": True, "days": days, "n": len(daily), "daily": daily}


def compute_heat_timeseries(store: "Store", days: int = 4) -> dict:
    """Hourly time-series: outdoor + flow temperature, consumption (heating/
    hot-water) and the derived COP, plus efficiency/logic insights. Uses the
    imported CSV where available and fills the remaining hours from the LIVE
    heat-pump samples, so it also works without a CSV import."""
    rows = store.hp_history("hour")
    cutoff = int(time.time() - days * 86400)
    by_hour = {}
    for r in rows:
        try:
            ts = int(datetime.fromisoformat(str(r.get("date"))).timestamp())
        except (ValueError, TypeError):
            continue
        if ts < cutoff:
            continue
        elec = r.get("elec_kwh")
        heat = r.get("heat_kwh")
        heating = r.get("heating_kwh") or 0
        water = r.get("water_kwh") or 0
        cop = round(heat / elec, 2) if (elec and elec > 0.05 and heat) else None
        by_hour[(ts // 3600) * 3600] = {
            "ts": ts, "hour": datetime.fromtimestamp(ts).hour,
            "outdoor": r.get("outdoor_c"), "supply": r.get("supply_c"),
            "indoor": None, "water_t": r.get("water_c"),
            "elec": round(elec, 2) if elec is not None else None,
            "heat": round(heat, 2) if heat is not None else None,
            "heating": round(heating, 2), "water": round(water, 2), "cop": cop}
    # fill hours the CSV doesn't cover from the live heat-pump samples (CSV wins
    # per hour where present, as its per-hour energy is clean)
    live_rows = store.hp_samples_since(cutoff - 7200)
    for hts, rec in _live_hourly(live_rows, cutoff).items():
        by_hour.setdefault(hts, rec)
    # overlay logged indoor temperature (from the thermostats) by hour; add
    # indoor-only hours so recently logged temps show even without CSV coverage.
    for hts, temp in store.room_temp_hourly(cutoff).items():
        if hts in by_hour:
            by_hour[hts]["indoor"] = temp
        else:
            by_hour[hts] = {"ts": hts, "hour": datetime.fromtimestamp(hts).hour,
                            "outdoor": None, "supply": None, "indoor": temp, "water_t": None,
                            "elec": None, "heat": None, "heating": 0, "water": 0, "cop": None}
    series = sorted(by_hour.values(), key=lambda s: s["ts"])
    if not series:
        return {"ok": True, "n": 0,
                "note": "Noch keine Stundendaten. Bei verbundener Wärmepumpe füllt sich das über die "
                        "nächsten Stunden von selbst; für Historie zusätzlich den HomeCom-CSV-Export importieren."}
    return _ts_derive(series, days)


def _ts_derive(series: list[dict], days: int) -> dict:
    """Derive efficiency/logic insights from an hourly series (shared by the CSV
    time-series and the demo)."""
    tot_elec = sum(s["elec"] or 0 for s in series)
    tot_heat = sum(s["heat"] or 0 for s in series)
    tot_heating = sum(s["heating"] for s in series)
    tot_water = sum(s["water"] for s in series)
    avg_cop = round(tot_heat / tot_elec, 2) if tot_elec > 0.1 else None
    # heating-hour relationships (space heating only – clean signal)
    heat_hrs = [s for s in series if s["heating"] > 0.05 and s["outdoor"] is not None]
    supply_fit = _linfit([(s["outdoor"], s["supply"]) for s in heat_hrs if s["supply"] is not None])
    elec_fit = _linfit([(s["outdoor"], s["heating"]) for s in heat_hrs])
    cop_pts = [(s["outdoor"], s["cop"]) for s in series if s["cop"] is not None and s["outdoor"] is not None]
    cop_fit = _linfit(cop_pts)
    best = max((s for s in series if s["cop"] is not None), key=lambda s: s["cop"], default=None)
    worst = min((s for s in series if s["cop"] is not None), key=lambda s: s["cop"], default=None)

    logic = []
    if avg_cop is not None:
        logic.append(f"Ø Arbeitszahl (COP) <b>{avg_cop}</b> im Zeitraum – aus "
                     f"<b>{tot_elec:.1f} kWh</b> Strom wurden <b>{tot_heat:.1f} kWh</b> Wärme.")
    if supply_fit:
        msg = (f"<b>Logik:</b> je <b>1 °C kälter</b> steigt der Vorlauf um "
               f"~<b>{abs(supply_fit[0]):.1f} K</b>")
        # heating power per °C in watts (kWh/h → W); only show if meaningful
        if elec_fit:
            w_per_k = round(abs(elec_fit[0]) * 1000)
            if w_per_k >= 5:
                msg += f" und der Heizstrombedarf um ~<b>{w_per_k} W</b>"
        msg += " – die Regelung folgt der Außentemperatur."
        logic.append(msg)
    if cop_fit and abs(cop_fit[0]) > 0.01:
        trend = "steigt" if cop_fit[0] > 0 else "sinkt"
        logic.append(f"Die Effizienz <b>{trend}</b> mit wärmerer Luft (~{abs(cop_fit[0]):.2f} COP je °C) – "
                     f"typisch für Wärmepumpen.")
    if tot_water > 0 and (tot_heating + tot_water) > 0:
        share = round(tot_water / (tot_heating + tot_water) * 100)
        logic.append(f"<b>Warmwasser</b> macht ~<b>{share}%</b> des WP-Stroms aus "
                     f"(Heizung {100 - share}%).")
    if best and worst and best["cop"] and worst["cop"]:
        logic.append(f"Bester Punkt: COP <b>{best['cop']}</b> bei {fmt_c(best['outdoor'])}, "
                     f"schlechtester: COP <b>{worst['cop']}</b> bei {fmt_c(worst['outdoor'])}.")
    # indoor temperature (logged from the thermostats), when available
    ind = [s["indoor"] for s in series if s.get("indoor") is not None]
    if len(ind) >= 2:
        lo, hi = min(ind), max(ind)
        logic.append(f"<b>Innentemperatur</b> (aus den Thermostaten): Ø <b>{sum(ind) / len(ind):.1f} °C</b> "
                     f"(Schwankung {lo:.1f}–{hi:.1f} °C). "
                     + ("Sehr konstant – gute Regelung." if hi - lo <= 1.0 else
                        "Spürbare Schwankung – ggf. Takten, Nachtabsenkung oder Zuglufteintrag."))

    return {"ok": True, "n": len(series), "days_window": days, "rows": series,
            "stats": {"avg_cop": avg_cop, "tot_elec": round(tot_elec, 1),
                      "tot_heat": round(tot_heat, 1), "tot_heating": round(tot_heating, 1),
                      "tot_water": round(tot_water, 1),
                      "supply_slope": round(supply_fit[0], 2) if supply_fit else None,
                      "elec_slope": round(elec_fit[0], 3) if elec_fit else None},
            "logic": logic}


def fmt_c(v):
    return f"{v:.0f} °C" if isinstance(v, (int, float)) else "–"


def _demo_timeseries(days: int = 4) -> dict:
    """Synthetic hourly series for the demo (outdoor diurnal + flow tracking +
    heating/hot-water consumption + COP), run through the same derivation."""
    now = datetime.now().replace(minute=0, second=0, microsecond=0)
    series = []
    hours = max(24, min(days, 7) * 24)
    for i in range(hours, 0, -1):
        t = now - timedelta(hours=i)
        doy = t.timetuple().tm_yday
        h = t.hour
        seasonal = 9.0 - 12.0 * math.cos((doy - 20) / 365.0 * 2 * math.pi)
        outdoor = round(seasonal + 4.0 * math.sin((h - 14) / 24.0 * 2 * math.pi), 1)
        dhw = h in (6, 18)
        heating = water = elec = heat = 0.0
        supply = round(24 + max(0, 16 - outdoor) * 0.4, 1)
        if dhw:
            water = round(0.8 + 0.2 * math.sin(i), 2)
            elec = water
            cop = max(1.8, 2.0 + 0.07 * outdoor)
            heat = round(water * cop, 2)
            supply = round(48 + 4 * math.sin(i), 1)
        elif outdoor < 16:
            heating = round(0.2 + (16 - outdoor) * 0.06, 2)
            elec = heating
            cop = max(2.2, min(5.0, 2.6 + 0.12 * outdoor))
            heat = round(heating * cop, 2)
        series.append({
            "ts": int(t.timestamp()), "hour": h, "outdoor": outdoor,
            "supply": supply if (heating > 0 or dhw) else None,
            "indoor": round(21.8 + 0.7 * math.sin((h - 15) / 24.0 * 2 * math.pi), 1),
            "water_t": round(46 + 3 * math.sin(i / 3), 1),
            "elec": round(elec, 2) or None, "heat": round(heat, 2) or None,
            "heating": round(heating, 2), "water": round(water, 2),
            "cop": round(heat / elec, 2) if elec > 0.05 else None})
    return _ts_derive(series, days)


def _heat_intervals(hp_rows: list[dict], now: int) -> list[list]:
    """Intervals [start,end] where the heat pump was space-heating (from mode)."""
    ivs, cur = [], None
    for s in sorted(hp_rows, key=lambda x: x.get("ts", 0)):
        heating = (s.get("mode") or "").lower() in ("ch", "heating", "heat")
        ts = s.get("ts", 0)
        if heating:
            if cur is None:
                cur = [ts, ts]
            else:
                cur[1] = ts
        elif cur is not None:
            ivs.append(cur); cur = None
    if cur is not None:
        ivs.append(cur)
    return ivs


def compute_room_timeseries(store: "Store", days: int = 2) -> dict:
    """Per-room temperature/setpoint/valve over time + the heat-pump heating
    state – to see which room reaches its setpoint (valve closes), which never
    does, how fast a room cools, and why heating switched off."""
    now = int(time.time())
    since = now - days * 86400
    rows = store.room_log_since(since)
    heat_iv = _heat_intervals(store.hp_samples_since(since), now)
    # per-room window-open intervals – an open window is ventilation, not the
    # room's natural heat loss, so it must not count as "fast cool-down".
    win_events = _window_events(store.window_log_since(since), now)
    win_by_room: dict[str, list] = {}
    for e in win_events:
        for rm in e.get("rooms") or []:
            win_by_room.setdefault(rm, []).append((e["start"], e["end"]))

    def _in_any(ts, ivs):
        return any(a <= ts <= b for a, b in ivs)

    rooms = {}
    for r in rows:
        rm = r.get("room") or "—"
        rooms.setdefault(rm, []).append(r)

    def med(xs):
        s = sorted(xs); k = len(s)
        return None if not k else (s[k // 2] if k % 2 else (s[k // 2 - 1] + s[k // 2]) / 2)

    out_rooms, insights = [], []
    never, reached_valve, cooldowns = [], [], []
    palette = ["#3ba9ff", "#ff6b8a", "#4be0b0", "#ffb64d", "#b794f6", "#f78fb3", "#7ed6df", "#e77f67"]
    for i, (rm, pts) in enumerate(sorted(rooms.items())):
        pts.sort(key=lambda p: p["ts"])
        temps = [p["temp"] for p in pts if p["temp"] is not None]
        sps = [p["setpoint"] for p in pts if p["setpoint"] is not None]
        if not temps:
            continue
        sp = round(med(sps), 1) if sps else None
        tmax = max(temps)
        reached = sp is not None and tmax >= sp - 0.1
        below_always = sp is not None and tmax < sp - 0.5
        # valve closes once warm? (temp near/over setpoint AND valve low)
        valve_closes = any(p.get("valve") is not None and p["valve"] <= 30 and sp is not None
                           and p["temp"] is not None and p["temp"] >= sp - 0.3 for p in pts)
        # fastest cool-down (K/h) over a ~1 h sliding window, EXCLUDING any
        # period where a window in this room was open (that's airing out, not
        # the wall losing heat – otherwise an open bathroom window looks like a
        # draughty/leaky room).
        rm_wins = win_by_room.get(rm, [])
        win_open_now = bool(rm_wins) and _in_any(pts[-1]["ts"], rm_wins)
        cd = 0.0
        for a in range(len(pts)):
            for b in range(a + 1, len(pts)):
                dt = pts[b]["ts"] - pts[a]["ts"]
                if dt < 2400 or dt > 5400:
                    continue
                if pts[a]["temp"] is None or pts[b]["temp"] is None:
                    continue
                if rm_wins and (_in_any(pts[a]["ts"], rm_wins) or _in_any(pts[b]["ts"], rm_wins)):
                    break          # ventilation window → skip this pair
                rate = (pts[a]["temp"] - pts[b]["temp"]) / (dt / 3600.0)
                if rate > cd:
                    cd = rate
                break
        if cd > 0.05:
            cooldowns.append((rm, round(cd, 1)))
        if below_always:
            never.append((rm, sp, round(tmax, 1)))
        elif reached and valve_closes:
            reached_valve.append(rm)
        # downsample to ~160 points
        step = max(1, len(pts) // 160)
        out_rooms.append({
            "room": rm, "color": palette[i % len(palette)], "setpoint": sp,
            "reached": reached, "below_always": below_always, "valve_closes": valve_closes,
            "cooldown": round(cd, 1) if cd > 0.05 else None,
            "window_open": win_open_now,
            "points": [{"ts": p["ts"], "temp": p["temp"], "setpoint": p["setpoint"],
                        "valve": p["valve"]} for p in pts[::step]]})

    if never:
        insights.append("<b>Erreicht Soll nie:</b> " + ", ".join(
            f"{rm} (max {mx} / Soll {sp:.0f} °C)" for rm, sp, mx in never) +
            " – zu wenig Heizleistung/Durchfluss: beim hydraulischen Abgleich bevorzugen oder Vorlauf prüfen.")
    if reached_valve:
        insights.append("<b>Erreicht Soll & Ventil schließt:</b> " + ", ".join(reached_valve) +
                        " – gut geregelt; sobald alle Räume so weit sind, hat die WP keine Abnahme mehr und schaltet ab.")
    if cooldowns:
        cooldowns.sort(key=lambda x: -x[1])
        slow = cooldowns[-1]; fast = cooldowns[0]
        excluded_any = any(win_by_room.get(rm) for rm, _ in cooldowns)
        insights.append(f"<b>Auskühlen:</b> am schnellsten {fast[0]} (~{fast[1]} K/h), "
                        f"am trägsten {slow[0]} (~{slow[1]} K/h) – schnelles Auskühlen (bei "
                        f"geschlossenem Fenster) deutet auf Zugluft/undichte Stellen oder große "
                        f"Fensterfläche." +
                        (" Offene-Fenster-Phasen sind dabei ausgeklammert (Lüften ≠ Wärmeverlust der Wand)."
                         if excluded_any else ""))
    if heat_iv:
        tot = sum(e[1] - e[0] for e in heat_iv) / 3600.0
        insights.append(f"Wärmepumpe heizte im Zeitraum <b>{tot:.1f} h</b> in {len(heat_iv)} Phasen. "
                        f"Heizpausen = alle Räume haben ihr Soll erreicht (Ventile zu) oder Warmwasser-Vorrang.")

    # window-open events for the chart markers (which room, when open→close).
    # `doors` flags openings that are a door (Haustür etc.) – shown separately.
    window_events = [{"rooms": sorted(e.get("rooms") or []),
                      "doors": sorted(e.get("doors") or []), "start": e["start"],
                      "end": e["end"], "ongoing": bool(e.get("ongoing"))}
                     for e in win_events if e.get("end", 0) >= since]
    return {"ok": True, "days_window": days, "rooms": out_rooms,
            "heating": [[a, b] for a, b in heat_iv], "window_events": window_events,
            "insights": insights}


def _demo_room_timeseries(days: int = 2) -> dict:
    """Synthetic per-room series: Bad reaches setpoint & valve closes, Büro never
    reaches, plus a WP heating strip – for the demo."""
    now = int(time.time())
    base = now - days * 86400
    rooms_def = [("Wohnzimmer", 22, 0.3, True), ("Bad", 24, 0.2, True),
                 ("Büro", 21, 1.2, False), ("Schlafzimmer", 19, 0.5, True)]
    out, heat = [], []
    palette = ["#3ba9ff", "#ff6b8a", "#4be0b0", "#ffb64d"]
    total = days * 86400
    step = max(60, int(total / 90))         # ~90 points across the chosen range
    n = max(2, int(total / step))
    for idx, (rm, sp, deficit, reaches) in enumerate(rooms_def):
        pts = []
        for i in range(n):
            t = base + i * step
            h = datetime.fromtimestamp(t).hour + datetime.fromtimestamp(t).minute / 60.0
            swing = 0.8 * math.sin((h - 15) / 24.0 * 2 * math.pi)
            temp = sp - deficit + swing + (0.3 if reaches else -0.4)
            valve = 10 if (reaches and temp >= sp - 0.2) else 80
            pts.append({"ts": t, "temp": round(temp, 1), "setpoint": sp, "valve": valve})
        out.append({"room": rm, "color": palette[idx], "setpoint": sp,
                    "reached": reaches, "below_always": not reaches,
                    "valve_closes": reaches, "cooldown": round(0.6 + 0.3 * idx, 1),
                    "points": pts[::2]})
    for dayi in range(int(base // 86400), int(now // 86400) + 1):
        day0 = dayi * 86400
        heat.append([day0 + 5 * 3600, day0 + 9 * 3600])
        heat.append([day0 + 16 * 3600, day0 + 22 * 3600])
    insights = [
        "<b>Erreicht Soll nie:</b> Büro (max 19.9 / Soll 21 °C) – beim hydraulischen Abgleich bevorzugen.",
        "<b>Erreicht Soll & Ventil schließt:</b> Wohnzimmer, Bad, Schlafzimmer – gut geregelt.",
        "<b>Auskühlen:</b> am schnellsten Bad (~1.5 K/h), am trägsten Wohnzimmer (~0.6 K/h).",
        "Wärmepumpe heizte im Zeitraum mehrere Phasen; Pausen = alle Räume am Soll (Ventile zu).",
    ]
    # a couple of demo window-open events so the chart markers are visible,
    # plus a short Haustür (door) opening so the door marker shows too
    win = [{"rooms": ["Bad"], "doors": [], "start": int(now - 5 * 3600), "end": int(now - 4.4 * 3600), "ongoing": False},
           {"rooms": ["Flur"], "doors": ["Haustür"], "start": int(now - 3.2 * 3600), "end": int(now - 3.17 * 3600), "ongoing": False},
           {"rooms": ["Wohnzimmer"], "doors": [], "start": int(now - 2 * 3600), "end": int(now - 1.6 * 3600), "ongoing": False}]
    return {"ok": True, "demo": True, "days_window": days, "rooms": out,
            "heating": heat, "window_events": win, "insights": insights}


# ===================================================================== #
#  Intelligent heat-load analysis — module 1: learning thermal model     #
# ===================================================================== #
# Honest scope: from the SHC thermostats we measure, per room, the indoor
# temperature, the setpoint and the valve position over time; from the heat
# pump we get the OUTDOOR temperature and whether it is space-heating. We do
# NOT have per-circuit flow rate or per-circuit supply/return temperature, so
# the heat actually delivered to a single room cannot be measured directly.
# Everything below is therefore split into:
#   • MESSBAR   (measured)  – read straight from a sensor
#   • ABGELEITET(derived)   – computed from measured data by a physical model
#   • GESCHÄTZT (estimated) – a model assumption where a sensor is missing
# and it is a DATA-BASED optimisation aid, not a norm-compliant hydraulic
# balance (DIN EN 12831 / VdZ) which needs the heat-load calculation.

def _outdoor_hourly_map(hp_rows: list[dict]) -> dict:
    """hour-start ts -> mean outdoor °C, from the heat-pump samples."""
    m: dict[int, list] = {}
    for s in hp_rows:
        o = s.get("outdoor_c")
        if o is None:
            continue
        h = (int(s.get("ts", 0)) // 3600) * 3600
        m.setdefault(h, []).append(o)
    return {h: sum(v) / len(v) for h, v in m.items()}


def _outdoor_at(omap: dict, ts: int):
    """Nearest hourly outdoor temp to ts (within ±2 h), or None."""
    h = (int(ts) // 3600) * 3600
    for d in (0, -3600, 3600, -7200, 7200):
        if (h + d) in omap:
            return omap[h + d]
    return None


def _temp_runs(pts: list[dict], kind: str) -> list[list]:
    """Maximal runs of consecutive samples that are cooling ('cool': valve low /
    unknown and temperature flat-or-falling) or warming ('warm': valve open and
    temperature flat-or-rising). A gap > 3 h breaks a run."""
    runs, cur = [], None
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        dt = b["ts"] - a["ts"]
        ta, tb = a.get("temp"), b.get("temp")
        if dt <= 0 or dt > 3 * 3600 or ta is None or tb is None:
            if cur and len(cur) >= 3:
                runs.append(cur)
            cur = None
            continue
        va = a.get("valve")
        dtemp = tb - ta
        if kind == "cool":
            # cooling: valve low AND no open window in this room (an open window
            # is ventilation, not the room's natural heat loss → excluded).
            # Without a valve reading (floor heating) the room must demonstrably
            # NOT be heated: either the heat pump was not heating, or the
            # thermostat was satisfied (setpoint below the room temperature).
            # A room that is being heated while its temperature drifts down is
            # not a free cool-down and used to yield wildly scattered τ values.
            if va is not None:
                unheated = va <= 35
            else:
                spa = a.get("setpoint")
                unheated = (not (a.get("_heat") and b.get("_heat"))
                            or (spa is not None and spa <= ta - 0.3))
            ok = (dtemp <= 0.05 and unheated
                  and not a.get("_win") and not b.get("_win"))
        else:
            # warming: valve open, OR – for floor heating without a valve reading –
            # the heat pump was heating while the room temperature rose.
            gate = (va >= 45) if va is not None else bool(a.get("_heat") and b.get("_heat"))
            ok = dtemp >= -0.03 and gate
        if ok:
            cur = [a, b] if cur is None else cur + [b]
        else:
            if cur and len(cur) >= 3:
                runs.append(cur)
            cur = None
    if cur and len(cur) >= 3:
        runs.append(cur)
    return runs


def _guess_target(room: str) -> float:
    """A sensible comfort temperature from the room name – last resort when
    neither the user nor the setpoint history says what the room should have."""
    n = (room or "").lower()
    if re.search(r"bad|wc|dusch", n):
        return 23.0
    if re.search(r"schlaf", n):
        return 18.0
    if re.search(r"flur|diele|keller|g[äa]ste|abstell|hwr|technik|wasch", n):
        return 19.0
    if re.search(r"küche|kueche", n):
        return 20.0
    return 21.0


def _room_targets(store: "Store", rooms: list, explicit: dict | None, now: int) -> dict:
    """room -> (comfort target °C, source). The target is what the room SHOULD
    have – deliberately not the raw thermostat setpoint, which is cranked up
    (25–30 °C) while the valves are held open for balancing and would make
    every room look like it "misses its setpoint by 4 K".

    Order: the value the user entered → the setpoint in effect by day over the
    last 3 days (if it is a normal value) → the normal setpoint from before the
    thermostats were opened up (last 60 days) → a guess from the room name."""
    explicit = explicit or {}
    recent = store.room_setpoint_modes(now - 3 * 86400)
    older = store.room_setpoint_modes(now - 60 * 86400)
    out = {}
    for rm in rooms:
        v = explicit.get(rm)
        try:
            v = float(v) if v is not None else None
        except (TypeError, ValueError):
            v = None
        if v is not None and 10.0 <= v <= 30.0:
            out[rm] = (v, "eingestellt")
        elif rm in recent:
            out[rm] = (recent[rm], "Sollwert")
        elif rm in older:
            out[rm] = (older[rm], "früherer Sollwert")
        else:
            out[rm] = (_guess_target(rm), "geschätzt")
    return out


def _interval_lookup(ivs):
    """Fast "is ts inside any interval?" test (merge + bisect) – the per-sample
    membership checks below would otherwise be O(samples × intervals)."""
    merged = []
    for a, b in sorted((a, b) for a, b in ivs):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    starts = [a for a, _ in merged]

    def inside(ts):
        i = bisect.bisect_right(starts, ts) - 1
        return i >= 0 and merged[i][1] >= ts
    return inside


SUPPLY_BAND_K = 0.7        # a room this far off the house average needs adjusting


def compute_thermal_model(store: "Store", days: int = 14, targets: dict | None = None,
                          exclude: set | None = None) -> dict:
    """Per-room learning thermal model (RC: C·dT/dt = Q − UA·(T_in − T_out)).

    Two separate things, deliberately not mixed:

    • PHYSICS (derived, slow-changing): the thermal time constant τ = C/UA from
      free cool-down phases and the heat-up rate. τ is a property of the
      building, so it is learned from a longer history (≥ 45 days).
    • SUPPLY (measured, last 24 h only): how each room sits against its comfort
      target (``targets``: room -> °C as entered by the user; otherwise
      recovered from the setpoint history). While the thermostats are opened up
      the yardstick is a room's deviation relative to the other rooms – which is
      exactly what hydraulic balancing equalises. A 14-day worst case would say
      nothing about today."""
    now = int(time.time())
    win_days = max(int(days), 45)
    since = now - win_days * 86400
    rows = store.room_log_since(since)
    hp_rows = store.hp_samples_since(since)
    omap = _outdoor_hourly_map(hp_rows)
    heat_iv = _heat_intervals(hp_rows, now)
    in_heat = _interval_lookup(heat_iv)
    has_outdoor = len(omap) > 0
    hist = store.hp_history_count()

    # per-room window-open intervals (so ventilation is excluded from the
    # cool-down / τ measurement) – reconstructed from the window change-log.
    win_events = _window_events(store.window_log_since(since), now)
    win_by_room: dict[str, list] = {}
    for e in win_events:
        for rm in e.get("rooms") or []:
            win_by_room.setdefault(rm, []).append((e["start"], e["end"]))

    if targets is None:                 # the user's own comfort targets (synced app settings)
        targets = _settings_targets(_app_settings(store))
    exclude = exclude or set()
    byroom: dict[str, list] = {}
    for r in rows:
        rm = r.get("room") or "—"
        if rm in exclude:               # rooms the user removed from the manifold layout
            continue
        byroom.setdefault(rm, []).append(r)

    span_s = (max(p["ts"] for p in rows) - min(p["ts"] for p in rows)) if rows else 0
    span_days = span_s / 86400.0
    tmap = _room_targets(store, list(byroom.keys()), targets, now)

    def _median(xs):
        s = sorted(xs)
        k = len(s)
        if not k:
            return None
        return s[k // 2] if k % 2 else (s[k // 2 - 1] + s[k // 2]) / 2.0

    def _conf_word(score):
        return "hoch" if score >= 0.66 else ("mittel" if score >= 0.33 else "niedrig")

    day_ago, two_ago = now - 86400, now - 2 * 86400
    out_rooms = []
    for rm, pts in sorted(byroom.items()):
        pts.sort(key=lambda p: p["ts"])
        # annotate each sample: was a window open in this room, and was the heat
        # pump heating? (used to exclude ventilation from τ and to detect heat-up
        # phases on floor heating, where there is no valve % to key off.)
        in_win = _interval_lookup(win_by_room[rm]) if win_by_room.get(rm) else None
        n_win_excluded = 0
        for p in pts:
            wopen = in_win(p["ts"]) if in_win else False
            p["_win"] = wopen
            p["_heat"] = in_heat(p["ts"])
            if wopen:
                n_win_excluded += 1
        temps = [p["temp"] for p in pts if p.get("temp") is not None]
        if not temps:
            continue
        # the setpoint that is in effect NOW (not a 14-day median, which lags
        # behind for days after a change and then contradicts the live value)
        sp = next((round(p["setpoint"], 1) for p in reversed(pts)
                   if p.get("setpoint") is not None), None)
        temp_now = pts[-1].get("temp")

        # --- cool-down phases -> τ (derived) + cool-down rate (measured) ---
        taus, cool_rates = [], []
        for run in _temp_runs(pts, "cool"):
            dur_h = (run[-1]["ts"] - run[0]["ts"]) / 3600.0
            drop = run[0]["temp"] - run[-1]["temp"]
            if dur_h < 1.5 or drop < 0.4:
                continue
            cool_rates.append(drop / dur_h)
            if has_outdoor:
                # dT/dt = −(T − T_out)/τ  →  τ = mean driving difference ÷ cooling
                # rate. Unlike a log-fit of (T − T_out) this stays stable when the
                # outdoor temperature itself moves during the night (it usually
                # falls faster than a screed floor cools, which made the log-fit
                # return no value or a wildly wrong one).
                drive = [p["temp"] - o for p in run
                         for o in [_outdoor_at(omap, p["ts"])] if o is not None]
                if len(drive) >= max(3, len(run) // 2):
                    dmean = sum(drive) / len(drive)
                    rate = drop / dur_h
                    if dmean >= 2.0 and rate > 0.01:
                        tau = dmean / rate
                        if 1.0 <= tau <= 400.0:
                            taus.append(tau)

        # --- heat-up phases -> responsiveness (derived) ---
        warm_rates = []
        for run in _temp_runs(pts, "warm"):
            dur_h = (run[-1]["ts"] - run[0]["ts"]) / 3600.0
            rise = run[-1]["temp"] - run[0]["temp"]
            if dur_h < 0.5 or rise < 0.3:
                continue
            warm_rates.append(rise / dur_h)

        tau_h = round(_median(taus), 1) if taus else None
        # spread of the τ estimates (coefficient of variation) – feeds the
        # heat-load uncertainty band in module 3
        tau_cv = None
        if len(taus) >= 2:
            mean_t = sum(taus) / len(taus)
            if mean_t > 0:
                var_t = sum((x - mean_t) ** 2 for x in taus) / (len(taus) - 1)
                tau_cv = round(var_t ** 0.5 / mean_t, 2)
        cool_kph = round(_median(cool_rates), 2) if cool_rates else None
        warm_kph = round(_median(warm_rates), 2) if warm_rates else None

        # --- supply: where the room sits against its target (measured, 24 h) ---
        target, target_src = tmap.get(rm, (None, None))
        # opened up = the thermostat asks for clearly more than the room should
        # have, so it calls for heat permanently and the manifold decides
        open_mode = bool(sp is not None and target is not None and sp - target >= 1.5)
        fresh = (now - pts[-1]["ts"]) <= 3 * 3600
        # temperatures while the room was asked to hold its comfort level and
        # no window was open. "Comfort level" = the target, but never more than
        # the thermostat actually asked for that day: this leaves out set-back
        # hours without dropping every sample when the user's target is above
        # the thermostat setpoint (the room then simply shows as too cold).
        sp24 = [p["setpoint"] for p in pts if p["ts"] >= day_ago and p.get("setpoint") is not None]
        hold = min(target, max(sp24)) if (target is not None and sp24) else target
        t24 = [p["temp"] for p in pts
               if p["ts"] >= day_ago and p.get("temp") is not None and not p["_win"]
               and (hold is None or p.get("setpoint") is None or p["setpoint"] >= hold - 0.3)]
        temp_24h = round(_median(t24), 1) if (len(t24) >= 4 and fresh) else None
        dev = round(temp_24h - target, 1) if (temp_24h is not None and target is not None) else None
        # share of the last 48 h in which the thermostat was calling for heat
        d48 = [p for p in pts if p["ts"] >= two_ago and p.get("temp") is not None
               and p.get("setpoint") is not None]
        demand_share = (round(sum(1 for p in d48 if p["temp"] < p["setpoint"] - 0.15) / len(d48), 2)
                        if len(d48) >= 8 else None)

        # --- confidence of the physics model (derived) ---
        n_tau, n_warm = len(taus), len(warm_rates)
        score = (min(1.0, span_days / 7.0) * 0.4
                 + min(1.0, n_tau / 3.0) * 0.35
                 + min(1.0, n_warm / 3.0) * 0.25)
        conf = _conf_word(score)
        missing = []
        if n_tau < 2:
            missing.append("1–2 heizfreie Auskühlphasen (Raum einige Stunden unbeheizt, Fenster zu)")
        if n_warm < 2:
            missing.append("1–2 klare Aufheizphasen")
        if span_days < 5:
            missing.append(f"längerer Zeitraum (bisher {span_days:.1f} von ≥5 Tagen)")
        status = "bereit" if (conf != "niedrig" and not missing) else "beobachtung"

        out_rooms.append({
            "room": rm, "n": len(pts), "setpoint": sp,
            "temp_now": round(temp_now, 1) if temp_now is not None else None,
            "target": target, "target_src": target_src, "open_mode": open_mode,
            "temp_24h": temp_24h, "dev": dev, "demand_share": demand_share,
            "tau_h": tau_h, "tau_cv": tau_cv,
            "cooldown_kph": cool_kph, "heatup_kph": warm_kph,
            "n_cool": len(cool_rates), "n_warm": n_warm, "n_tau": n_tau,
            "confidence": conf, "conf_score": round(score, 2),
            "status": status, "missing": missing, "win_excluded": n_win_excluded,
        })

    # ---- house reference + per-room verdict ------------------------------- #
    # Among the opened-up rooms the typical deviation from target is the common
    # mode (that is the heating curve's job); what differs from it is imbalance.
    open_devs = [r["dev"] for r in out_rooms if r["open_mode"] and r["dev"] is not None]
    house_dev = round(_median(open_devs), 1) if open_devs else None
    n_open = sum(1 for r in out_rooms if r["open_mode"])
    house_open = bool(out_rooms) and n_open >= max(2, math.ceil(0.6 * len(out_rooms)))
    for r in out_rooms:
        dev, tgt, t24 = r["dev"], r["target"], r["temp_24h"]
        ds = r["demand_share"]
        rel = None
        if dev is None:
            cat = "observing"
            finding = "Keine aktuellen Messwerte der letzten 24 Stunden."
            reco = "Sobald der Thermostat wieder Werte liefert, erscheint hier die Einordnung."
        elif r["open_mode"]:
            rel = round(dev - house_dev, 1) if house_dev is not None else 0.0
            if len(open_devs) < 2:
                cat = "balanced"
                finding = (f"Thermostat ist hochgedreht; Ø 24 h {_de(t24)} °C bei Wunsch {_de(tgt)} °C. "
                           "Für einen Vergleich muss mindestens ein zweiter Raum offen sein.")
                reco = "Für die Einstell-Phase alle Thermostate öffnen, dann vergleiche ich die Räume."
            elif rel <= -SUPPLY_BAND_K:
                cat = "under"
                finding = (f"Liegt <b>{_de(abs(rel))} K unter dem Hausschnitt</b> "
                           f"(Ø 24 h {_de(t24)} °C, Wunsch {_de(tgt)} °C) – bekommt im Vergleich zu wenig Wärme.")
                reco = ("Durchfluss am Verteiler einen kleinen Schritt <b>erhöhen</b> "
                        "(+0,2–0,3 l/min je Kreis), dann 1–2 Tage beobachten.")
            elif rel >= SUPPLY_BAND_K:
                cat = "reserve"
                finding = (f"Liegt <b>{_de(rel)} K über dem Hausschnitt</b> "
                           f"(Ø 24 h {_de(t24)} °C, Wunsch {_de(tgt)} °C) – bekommt mehr Wärme als nötig.")
                reco = ("Kreis leicht <b>androsseln</b> (−0,2–0,3 l/min je Kreis); das gibt Durchfluss "
                        "für die kühleren Räume frei.")
            else:
                cat = "balanced"
                finding = (f"Im Gleichlauf mit dem Haus (Abweichung {'+' if rel >= 0 else '−'}{_de(abs(rel))} K; "
                           f"Ø 24 h {_de(t24)} °C, Wunsch {_de(tgt)} °C).")
                reco = "Nichts verstellen."
        else:
            call = f"{round(ds * 100)} % der Zeit" if ds is not None else None
            if dev <= -0.5:
                cat = "under"
                finding = (f"Bleibt typisch <b>{_de(abs(dev))} K unter dem Sollwert</b> "
                           f"(Ø 24 h {_de(t24)} °C bei {_de(tgt)} °C)"
                           + (f", obwohl der Thermostat {call} Wärme anfordert" if call else "") + ".")
                reco = ("Kandidat für <b>mehr Durchfluss</b>: am Verteiler einen kleinen Schritt öffnen "
                        "(+0,2–0,3 l/min je Kreis), dann 1–2 Tage beobachten.")
            elif ds is not None and ds <= 0.35:
                cat = "reserve"
                finding = (f"Hält den Sollwert (Ø 24 h {_de(t24)} °C bei {_de(tgt)} °C) und fordert nur "
                           f"{call} Wärme an – hier ist <b>Reserve</b>.")
                reco = ("Kann leicht gedrosselt werden, falls andere Räume zu wenig bekommen. "
                        "Sonst so lassen.")
            else:
                cat = "balanced"
                finding = (f"Hält den Sollwert (Ø 24 h {_de(t24)} °C bei {_de(tgt)} °C"
                           + (f", fordert {call} Wärme an" if call else "") + ").")
                reco = "Nichts verstellen."
        # how much more heat the room needs, in K (positive = too cold)
        need = None if dev is None else round(-(rel if r["open_mode"] and rel is not None else dev), 1)
        r.update({
            "rel": rel, "category": cat, "finding": finding, "recommendation": reco,
            "need_k": need,
            # kept for older step baselines / callers: typical shortfall in K
            "reaches": bool(dev is not None and dev >= -0.3),
            "max_deficit": (round(max(0.0, -dev), 1) if dev is not None else None),
            "demand_index": max(0.0, need) if need is not None else 0.0,
        })

    # rooms that need attention first (largest shortfall first)
    ranked = sorted([r for r in out_rooms if (r.get("need_k") or 0) >= 0.3],
                    key=lambda r: -r["need_k"])
    priority = [{"room": r["room"], "index": r["need_k"],
                 "deficit": r["max_deficit"], "confidence": r["confidence"]}
                for r in ranked[:8]]

    # overall insights (derived from the same per-room category, so the summary
    # and the room rows never contradict each other)
    insights = []
    under = [r["room"] for r in out_rooms if r["category"] == "under"]
    over = [r["room"] for r in out_rooms if r["category"] == "reserve"]
    if house_open and house_dev is not None:
        insights.append(
            f"<b>Einstell-Modus:</b> {n_open} von {len(out_rooms)} Thermostaten sind hochgedreht, "
            f"die Räume werden deshalb <b>untereinander</b> verglichen. Im Schnitt liegt das Haus "
            f"{_de(abs(house_dev))} K {'über' if house_dev >= 0 else 'unter'} den Wunschtemperaturen.")
    if under:
        insights.append("<b>Zu wenig Wärme (aufdrehen):</b> " + ", ".join(under) + ".")
    if over:
        insights.append("<b>Zu viel Wärme (androsseln):</b> " + ", ".join(over) + ".")
    ready = sum(1 for r in out_rooms if r["status"] == "bereit")
    insights.append(f"{ready}/{len(out_rooms)} Räume mit gemessener Trägheit τ. "
                    f"Zeitraum {span_days:.1f} Tage, {len(rows)} Messpunkte"
                    + ("" if has_outdoor else ", Außentemperatur fehlt → τ nicht bestimmbar") + ".")

    # what to collect next to raise confidence
    next_obs = []
    if span_days < 5:
        next_obs.append("Mindestens 5–7 Tage durchlaufen lassen (automatische Protokollierung läuft).")
    if not has_outdoor:
        next_obs.append("Wärmepumpe/HomeCom verbinden – ohne Außentemperatur lässt sich τ nicht ableiten.")
    if any(r["n_tau"] < 2 for r in out_rooms):
        next_obs.append("Für τ fehlen heizfreie Auskühlphasen: sie entstehen, wenn ein Raum einige "
                        "Stunden nicht beheizt wird – z. B. über die Auto-Messung.")
    if any(r["n_warm"] < 2 for r in out_rooms):
        next_obs.append("Normale Aufheizphasen genügen – je mehr, desto genauer die Aufheizrate.")

    return {
        "ok": True, "days_window": win_days,
        "assessment": {
            "span_days": round(span_days, 1),
            "n_room_samples": len(rows), "n_rooms": len(byroom),
            "has_outdoor": has_outdoor, "heating_phases": len(heat_iv),
            "csv_hours": hist.get("hours", 0),
            "measured": ["Raumtemperatur", "Soll-Temperatur", "Ventilstellung",
                         "Außentemperatur" if has_outdoor else None, "WP Heiz-Phasen"],
            "derived": ["Zeitkonstante τ (Trägheit)", "Auskühlrate", "Aufheizrate",
                        "Abweichung vom Wunsch / vom Hausschnitt"],
            "estimated": ["Heizlast je Raum", "Ziel-Durchfluss je Kreis"],
            "gap": ("Kein Messwert pro Heizkreis: weder Durchfluss noch Vor-/Rücklauf "
                    "je Raum werden erfasst. Die tatsächlich an EINEN Raum gelieferte "
                    "Wärme ist daher nicht messbar – dies ist eine datenbasierte "
                    "Optimierungshilfe, kein normgerechter hydraulischer Abgleich."),
        },
        "house": {"open": house_open, "n_open": n_open, "dev": house_dev,
                  "n_live": sum(1 for r in out_rooms if r["dev"] is not None)},
        "rooms": out_rooms, "priority": priority,
        "insights": insights, "next_observations": next_obs,
    }


def _demo_thermal(days: int = 14) -> dict:
    """Synthetic learning-model output for the demo."""
    rooms = [
        {"room": "Wohnzimmer", "n": 320, "setpoint": 22.0, "temp_now": 21.9,
         "reaches": True, "max_deficit": 0.1, "tau_h": 48.0, "cooldown_kph": 0.35,
         "heatup_kph": 0.55, "n_cool": 5, "n_warm": 6, "n_tau": 5,
         "confidence": "hoch", "conf_score": 0.86, "status": "bereit", "missing": [],
         "finding": "Erreicht Soll zügig, kühlt träge aus (~0.35 K/h, τ≈48 h) – gut versorgt.",
         "recommendation": "Reserve vorhanden: Durchfluss ggf. leicht drosseln.",
         "category": "reserve", "demand_index": 0.18},
        {"room": "Büro", "n": 300, "setpoint": 21.0, "temp_now": 19.8,
         "reaches": False, "max_deficit": 1.2, "tau_h": 22.0, "cooldown_kph": 0.9,
         "heatup_kph": 0.2, "n_cool": 4, "n_warm": 3, "n_tau": 4,
         "confidence": "hoch", "conf_score": 0.8, "status": "bereit", "missing": [],
         "finding": "Erreicht Soll nicht (Defizit bis 1.2 K), heizt langsam auf (~0.20 K/h).",
         "recommendation": "Kandidat für MEHR Durchfluss beim Abgleich – datenbasierter Hinweis.",
         "category": "under", "demand_index": 0.78},
        {"room": "Bad", "n": 280, "setpoint": 24.0, "temp_now": 23.8,
         "reaches": True, "max_deficit": 0.2, "tau_h": 18.0, "cooldown_kph": 1.2,
         "heatup_kph": 0.7, "n_cool": 4, "n_warm": 5, "n_tau": 4,
         "confidence": "mittel", "conf_score": 0.6, "status": "bereit", "missing": [],
         "finding": "Erreicht Soll, τ≈18 h, Auskühlen ~1.20 K/h.",
         "recommendation": "Ausgewogen – weiter beobachten.",
         "category": "balanced", "demand_index": 0.42},
        {"room": "Schlafzimmer", "n": 120, "setpoint": 19.0, "temp_now": 19.1,
         "reaches": True, "max_deficit": 0.0, "tau_h": None, "cooldown_kph": 0.5,
         "heatup_kph": None, "n_cool": 2, "n_warm": 1, "n_tau": 1,
         "confidence": "niedrig", "conf_score": 0.28, "status": "beobachtung",
         "missing": ["1–2 klare Aufheizphasen (Ventil offen)"],
         "finding": "Erreicht Soll, Auskühlen ~0.50 K/h.",
         "recommendation": "Beobachtungsphase – mehr Aufheizphasen sammeln.",
         "category": "balanced", "demand_index": 0.13},
    ]
    priority = [{"room": "Büro", "index": 0.78, "deficit": 1.2, "confidence": "hoch"},
                {"room": "Bad", "index": 0.42, "deficit": 0.2, "confidence": "mittel"},
                {"room": "Wohnzimmer", "index": 0.18, "deficit": 0.1, "confidence": "hoch"}]
    return {
        "ok": True, "demo": True, "days_window": days,
        "assessment": {
            "span_days": 12.0, "n_room_samples": 1020, "n_rooms": 4,
            "has_outdoor": True, "heating_phases": 23, "csv_hours": 336,
            "measured": ["Raumtemperatur", "Soll-Temperatur", "Ventilstellung",
                         "Außentemperatur", "WP Heiz-Phasen"],
            "derived": ["Zeitkonstante τ (Trägheit)", "Auskühlrate", "Aufheizrate",
                        "Soll-Erreichung/Defizit"],
            "estimated": ["relativer Wärmebedarf je Raum", "Priorität für den Abgleich"],
            "gap": ("Kein Messwert pro Heizkreis: weder Durchfluss noch Vor-/Rücklauf "
                    "je Raum werden erfasst. Datenbasierte Optimierungshilfe, kein "
                    "normgerechter hydraulischer Abgleich."),
        },
        "rooms": rooms, "priority": priority,
        "insights": [
            "<b>Unterversorgt (mehr Durchfluss):</b> Büro – beim Abgleich zuerst diesen Kreis öffnen.",
            "<b>Reserve (ggf. drosseln):</b> Wohnzimmer – frei werdende Leistung geht ans Büro.",
            "3/4 Räume mit belastbarem Modell (Rest in Beobachtung). Zeitraum 12.0 Tage, 1020 Messpunkte.",
        ],
        "next_observations": [
            "Nachts die Soll-Temperatur absenken: die Auskühlphasen liefern τ je Raum.",
            "Normale Aufheizphasen genügen – je mehr, desto genauer die Aufheizrate.",
        ],
    }


# ===================================================================== #
#  Intelligent heat-load analysis — module 2: guided observation phase   #
# ===================================================================== #
# A controlled, multi-day protocol that makes module 1 trustworthy: it
# anchors a start time, tracks per-room how many clean cool-down / heat-up
# phases have been collected, flags disturbances (open windows, missing
# night set-back, too little outdoor-temperature spread) and tells the user
# the single next action. Nothing here changes the heating – it only guides
# data collection and reports progress honestly.

OBS_KEY = "observation"


def _obs_cfg(store: "Store"):
    raw = store.kv_get(OBS_KEY)
    if not raw:
        return None
    try:
        c = json.loads(raw)
        return c if isinstance(c, dict) else None
    except (ValueError, TypeError):
        return None


def _de(x, nd: int = 1) -> str:
    """German number formatting for user-facing text (21.5 -> '21,5',
    -0.8 -> '−0,8' with a real minus sign)."""
    if x is None:
        return "–"
    return f"{x:.{nd}f}".replace(".", ",").replace("-", "−")


def _measure_setback(room_rows: list[dict], nights: int = 5, now: int | None = None) -> dict:
    """MEASURED night set-back over the last ``nights`` completed nights, from
    the logged room setpoints – nothing is assumed. Per night (0–5 h) and room
    the median setpoint is compared with the median of the day before
    (11–20 h); a night counts as lowered when the house-average drop is
    ≥ 0.8 K. Older data is ignored on purpose: a set-back that ran weeks ago
    (e.g. the app's own Auto-Messung) says nothing about tonight."""
    now = int(now or time.time())

    def med(a):
        a = sorted(a)
        return a[len(a) // 2] if a else None

    m0 = _local_midnight(now)
    checked, lowered = [], []
    for k in range(nights + 1):
        m = m0 - k * 86400
        if m + 5 * 3600 > now:                  # tonight is not over yet
            continue
        if len(checked) >= nights:
            break
        n_by, d_by = {}, {}
        for r in room_rows:
            sp, ts = r.get("setpoint"), r["ts"]
            if sp is None:
                continue
            if m <= ts < m + 5 * 3600:
                n_by.setdefault(r.get("room"), []).append(sp)
            elif m - 13 * 3600 <= ts < m - 4 * 3600:
                d_by.setdefault(r.get("room"), []).append(sp)
        drops, d_all, n_all = [], [], []
        for rm, ns in n_by.items():
            ds = d_by.get(rm) or []
            if len(ns) < 3 or len(ds) < 3:
                continue
            drops.append(med(ds) - med(ns))
            d_all.append(med(ds)); n_all.append(med(ns))
        if not drops:
            continue
        drop = sum(drops) / len(drops)
        night = {"ts": m, "drop": round(drop, 1), "rooms": len(drops),
                 "day_sp": round(sum(d_all) / len(d_all), 1),
                 "night_sp": round(sum(n_all) / len(n_all), 1),
                 "lowered": drop >= 0.8}
        checked.append(night)
        if night["lowered"]:
            lowered.append(night)
    last = checked[0] if checked else None
    return {
        "nights_checked": len(checked), "nights_lowered": len(lowered),
        "active": bool(last and last["lowered"]),      # the most recent night
        "avg_drop": (round(sum(n["drop"] for n in lowered) / len(lowered), 1) if lowered else 0.0),
        "day_sp": last["day_sp"] if last else None,
        "night_sp": last["night_sp"] if last else None,
        "nights": checked,
    }


def _demo_opstate_hc() -> dict:
    """The demo heat pump's operating state, taken from the same synthetic
    control tree the „Wärmepumpe steuern" card shows."""
    c = {x["path"].split("/resource/", 1)[1]: x["value"] for x in _demo_controls()}
    H, W = "heatingCircuits/hc1/", "dhwCircuits/dhw1/"
    return {"gateway": DEMO_HP_GW, "hc": "hc1", "dhw": "dhw1",
            "hc_mode": c.get(H + "operationMode"), "hc_status": c.get(H + "overallStatus"),
            "hc_setpoint": c.get(H + "currentRoomSetpoint"),
            "hc_manual": c.get(H + "temperatureRoomManual"),
            "hc_comfort": c.get(H + "temperatureLevels/comfort2"),
            "hc_eco": c.get(H + "temperatureLevels/eco"),
            "hc_control": c.get(H + "controlType"), "hc_max_flow": c.get(H + "maxFlowTemp"),
            "dhw_mode": c.get(W + "operationMode"), "dhw_setpoint": c.get(W + "currentSetpoint"),
            "dhw_actual": c.get(W + "actualTemp"), "dhw_high": c.get(W + "temperatureLevels/high"),
            "dhw_eco": c.get(W + "temperatureLevels/eco"), "dhw_low": c.get(W + "temperatureLevels/low"),
            "dhw_charge": c.get(W + "charge"), "dhw_charge_dur": c.get(W + "chargeDuration"),
            "program": None, "failed": 0, "readable": True, "read_ts": int(time.time())}


def compute_opstate(store: "Store", hc: dict | None = None, climate: list | None = None,
                    hc_error: str | None = None) -> dict:
    """How the heating is ACTUALLY operated – read, not assumed.

    Three independent sources, each labelled with where it comes from:
      • the heat pump's heating-circuit mode and levels (HomeCom, read),
      • the room thermostats' mode (Bosch SHC, read),
      • the logged room setpoints of the last nights (measured).
    From these it states whether a night set-back is in effect. Where a source
    is not available the answer says so instead of filling the gap."""
    now = int(time.time())

    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    sb = _measure_setback(store.room_log_since(now - 7 * 86400), nights=5, now=now)
    am = _am_cfg(store) or {}
    am_on = bool(am.get("enabled") or am.get("run"))
    am_recent = any(e.get("action") == "absenken" and now - int(e.get("ts") or 0) < 6 * 86400
                    for e in (am.get("log") or []))

    lines, hints = [], []

    # ---- heat pump (HomeCom) -------------------------------------------- #
    hp = None
    if hc and hc.get("readable"):
        mode = str(hc.get("hc_mode") or "").lower() or None
        manual, cur = num(hc.get("hc_manual")), num(hc.get("hc_setpoint"))
        comfort, eco = num(hc.get("hc_comfort")), num(hc.get("hc_eco"))
        prog = hc.get("program") if isinstance(hc.get("program"), dict) else None
        room_sp = manual if (mode == "manual" and manual is not None) else cur
        hp = {"mode": mode, "status": hc.get("hc_status"), "room_setpoint": room_sp,
              "comfort": comfort, "eco": eco, "program": prog,
              "max_flow": num(hc.get("hc_max_flow")), "control": hc.get("hc_control"),
              "read_ts": hc.get("read_ts")}
        if mode == "manual":
            hp["schedule"] = "none"
            txt = ("Betriebsart <b>manuell</b> – ein fester Raum-Soll"
                   + (f" von <b>{_de(room_sp)} °C</b>" if room_sp is not None else "")
                   + ", <b>kein Zeitprogramm</b>.")
        elif mode == "auto":
            hp["schedule"] = "program"
            step = (comfort - eco) if (comfort is not None and eco is not None) else None
            hp["program_step_k"] = round(step, 1) if step is not None else None
            txt = "Betriebsart <b>Automatik</b> – ein Zeitprogramm schaltet zwischen den Stufen"
            if comfort is not None and eco is not None:
                txt += f" Komfort <b>{_de(comfort)} °C</b> und Eco <b>{_de(eco)} °C</b>"
            if prog and prog.get("has_reduced") and prog.get("reduced_start_min") is not None:
                t0, t1 = prog["reduced_start_min"], prog.get("comfort_start_min")
                txt += (f"; abgesenkt ab ~{t0 // 60:02d}:{t0 % 60:02d} Uhr"
                        + (f", Komfort ab ~{t1 // 60:02d}:{t1 % 60:02d} Uhr" if t1 is not None else ""))
            elif prog and not prog.get("has_reduced"):
                txt += "; im Programm steht aber <b>keine</b> abgesenkte Phase"
            else:
                txt += "; die Schaltzeiten liefert das Gerät nicht in lesbarer Form"
            txt += "."
        elif mode == "off":
            hp["schedule"] = "off"
            txt = "Heizkreis ist <b>aus</b>."
        else:
            hp["schedule"] = "unknown"
            txt = (f"Betriebsart „{_esc(hc.get('hc_mode'))}\"." if hc.get("hc_mode") is not None
                   else "Betriebsart des Heizkreises liefert das Gerät nicht.")
        lines.append({"icon": "🔥", "label": "Wärmepumpe", "src": "aus HomeCom gelesen", "html": txt})
        if room_sp is not None and room_sp >= 24.0 and mode in ("manual", "auto"):
            hints.append(f"Der <b>Raum-Soll an der Wärmepumpe</b> steht auf <b>{_de(room_sp)} °C</b>. "
                         "Bei der witterungsgeführten Regelung verschiebt das die ganze Heizkurve nach oben "
                         "(höherer Vorlauf). Für die Einstell-Phase ist das in Ordnung – danach wieder auf "
                         "deinen Wohlfühlwert stellen, das senkt den Vorlauf und spart Strom.")
    else:
        lines.append({"icon": "🔥", "label": "Wärmepumpe", "src": "HomeCom",
                      "html": ("Betriebsart <b>nicht lesbar</b>"
                               + (f" ({_esc(hc_error)})" if hc_error else " – HomeCom ist nicht verbunden") + "."),
                      "missing": True})

    # ---- room thermostats (SHC) ----------------------------------------- #
    th = None
    if climate is not None:
        heat = [r for r in climate
                if str(r.get("roomControlMode") or "HEATING").upper() != "OFF"
                and not r.get("summerMode") and not r.get("unnamed")]
        auto = sorted(r["room"] for r in heat if str(r.get("operationMode") or "").upper() == "AUTOMATIC")
        manual_rooms = sorted(r["room"] for r in heat if str(r.get("operationMode") or "").upper() == "MANUAL")
        sps = sorted(r["setpoint"] for r in heat if isinstance(r.get("setpoint"), (int, float)))
        th = {"n": len(heat), "automatic": auto, "manual": manual_rooms,
              "sp_min": sps[0] if sps else None, "sp_max": sps[-1] if sps else None}
        if heat:
            if not auto:
                txt = (f"<b>{len(manual_rooms) or len(heat)} von {len(heat)}</b> im Modus <b>manuell</b> "
                       "(feste Sollwerte, kein Zeitprogramm)")
            else:
                txt = (f"<b>{len(auto)} von {len(heat)}</b> im <b>Zeitprogramm</b> (Automatik): "
                       + ", ".join(_esc(x) for x in auto[:6]) + ("…" if len(auto) > 6 else ""))
            if sps:
                txt += (f" · Sollwerte aktuell {_de(sps[0])} °C" if sps[0] == sps[-1]
                        else f" · Sollwerte aktuell {_de(sps[0])}–{_de(sps[-1])} °C")
            lines.append({"icon": "🌡️", "label": "Raumthermostate", "src": "aus Bosch Smart Home gelesen",
                          "html": txt + "."})

    # ---- measured from the setpoint log ---------------------------------- #
    nc, nl = sb["nights_checked"], sb["nights_lowered"]
    if nc:
        if nl == 0:
            txt = (f"In den letzten <b>{nc} Nächten</b> blieben die Raum-Sollwerte nachts <b>unverändert</b>"
                   + (f" (Tag {_de(sb['day_sp'])} °C · Nacht {_de(sb['night_sp'])} °C)"
                      if sb["day_sp"] is not None else "") + ".")
        else:
            txt = (f"In <b>{nl} von {nc}</b> Nächten lagen die Raum-Sollwerte nachts im Schnitt "
                   f"<b>{_de(sb['avg_drop'])} K tiefer</b>"
                   + (" – zuletzt aber nicht mehr" if not sb["active"] else "") + ".")
        lines.append({"icon": "📏", "label": "Gemessen", "src": "aus dem Sollwert-Protokoll", "html": txt})
    if am_on:
        lines.append({"icon": "🤖", "label": "Auto-Messung", "src": "diese App",
                      "html": (f"ist <b>eingeschaltet</b> und senkt von {am.get('start_h', 23)} bis "
                               f"{am.get('end_h', 5)} Uhr die Raum-Sollwerte um {_de(float(am.get('setback_k', 4.0)), 0)} K "
                               "(stellt sie morgens zurück).")})

    # ---- hot water (HomeCom) --------------------------------------------- #
    dhw = None
    if hc and hc.get("readable") and (hc.get("dhw_mode") is not None or hc.get("dhw_setpoint") is not None):
        dset, dact = num(hc.get("dhw_setpoint")), num(hc.get("dhw_actual"))
        dhw = {"mode": hc.get("dhw_mode"), "setpoint": dset, "actual": dact,
               "high": num(hc.get("dhw_high")), "eco": num(hc.get("dhw_eco")), "low": num(hc.get("dhw_low")),
               "charge": hc.get("dhw_charge")}
        parts = []
        if hc.get("dhw_mode") is not None:
            parts.append(f"Betriebsart <b>{_esc(hc.get('dhw_mode'))}</b>")
        if dset is not None:
            parts.append(f"Soll <b>{_de(dset)} °C</b>")
        if dact is not None:
            parts.append(f"Speicher aktuell <b>{_de(dact)} °C</b>")
        lines.append({"icon": "🚿", "label": "Warmwasser", "src": "aus HomeCom gelesen",
                      "html": " · ".join(parts) + "."})

    # ---- verdict: is a night set-back in effect? -------------------------- #
    hp_sched = hp["schedule"] if hp else None
    th_auto = bool(th and th["automatic"])
    hp_prog_reduces = bool(hp and hp_sched == "program"
                           and (hp.get("program") or {}).get("has_reduced") is not False
                           and (hp.get("program_step_k") or 0) >= 0.5)
    if am_on or (sb["active"] and am_recent):
        state = "automeasure"
        verdict = ("Nachtabsenkung <b>durch die Auto-Messung dieser App</b> – nicht durch ein "
                   "Zeitprogramm deiner Heizung.")
    elif sb["active"]:
        state = "measured"
        verdict = (f"Nachtabsenkung <b>gemessen</b>: letzte Nacht lagen die Raum-Sollwerte "
                   f"{_de(sb['nights'][0]['drop'])} K unter dem Tageswert.")
    elif hp_prog_reduces:
        state = "hp_program"
        verdict = ("An den Raum-Sollwerten ist <b>keine</b> Absenkung messbar – die Wärmepumpe läuft aber "
                   "im <b>Zeitprogramm</b> mit einer abgesenkten Stufe, sie kann nachts also selbst "
                   "den Vorlauf senken.")
    elif nc and nl == 0 and hp_sched == "none" and not th_auto:
        state = "none"
        verdict = ("<b>Keine Nachtabsenkung aktiv.</b> Wärmepumpe und Thermostate laufen mit festen "
                   "Sollwerten, und in den letzten Nächten wurde auch keine gemessen.")
    elif nc and nl == 0:
        state = "none_measured"
        verdict = ("<b>Keine Nachtabsenkung gemessen</b> – die Raum-Sollwerte blieben nachts unverändert"
                   + (" (die Betriebsart der Wärmepumpe konnte ich nicht lesen)." if not hp else "."))
    elif hp_sched == "none" and not th_auto and climate is not None:
        state = "none"
        verdict = "<b>Keine Nachtabsenkung eingestellt</b> – Wärmepumpe und Thermostate haben feste Sollwerte."
    else:
        state = "unknown"
        verdict = ("Ob eine Nachtabsenkung läuft, lässt sich noch <b>nicht sagen</b> – es fehlen "
                   "Sollwert-Messungen der letzten Nächte und die Betriebsart der Wärmepumpe.")

    return {"ok": True, "ts": now, "state": state, "verdict": verdict,
            "lines": lines, "hints": hints, "heatpump": hp, "thermostats": th,
            "dhw": dhw, "measured": sb, "automeasure_on": am_on}


def compute_observation(store: "Store", lookback_days: int = 21, tm: dict | None = None,
                        targets: dict | None = None) -> dict:
    """Data situation for the thermal model: how long has been logged, how many
    rooms already have clean cool-down / heat-up phases, what is still missing.

    This is about COLLECTING DATA only. Opening the thermostats belongs to the
    separate adjusting phase and is not a step here (it used to be step 1, and
    because floor-heating thermostats report no valve position it could never
    complete – the card then asked forever to "open all thermostats")."""
    now = int(time.time())
    cfg = _obs_cfg(store)
    active = bool(cfg and cfg.get("active"))
    started = int(cfg["started_ts"]) if (cfg and cfg.get("started_ts")) else None
    target_days = int(cfg.get("target_days")) if (cfg and cfg.get("target_days")) else 7

    since = started if (active and started) else now - lookback_days * 86400
    elapsed_days = max(0.0, (now - since) / 86400.0)

    if tm is None:
        tm = compute_thermal_model(store, days=lookback_days, targets=targets)
    rooms = tm["rooms"]
    n_rooms = len(rooms)
    has_outdoor = tm["assessment"]["has_outdoor"]
    span_days = tm["assessment"]["span_days"]

    hp = store.hp_samples_since(int(now - 45 * 86400))
    win_events = _window_events(store.window_log_since(int(now - 14 * 86400)), now)

    outs = [s["outdoor_c"] for s in hp if s.get("outdoor_c") is not None]
    out_span = round(max(outs) - min(outs), 1) if outs else 0.0
    out_min = round(min(outs), 1) if outs else None
    out_max = round(max(outs), 1) if outs else None
    # measured, last 5 nights only (not "at some point in the last weeks")
    sb = _measure_setback(store.room_log_since(now - 7 * 86400), nights=5, now=now)
    night_setback = sb["active"]

    tau_ok = sum(1 for r in rooms if r["n_tau"] >= 2)
    warm_ok = sum(1 for r in rooms if r["n_warm"] >= 2)
    ready = sum(1 for r in rooms if r["status"] == "bereit")

    def pct(x):
        return max(0, min(100, round(x * 100)))

    # ---- what the model needs (derived state, each 0–100 %) ----
    steps = []
    s_days = min(1.0, span_days / target_days) if target_days else 0.0
    steps.append({
        "key": "days", "title": f"Zeitraum (Ziel {target_days} Tage)",
        "progress": pct(s_days), "state": "done" if span_days >= target_days else "active",
        "detail": f"{_de(span_days)} Tage protokolliert",
        "hint": "Läuft automatisch mit, solange die Bridge läuft."})

    s_warm = (warm_ok / n_rooms) if n_rooms else 0.0
    steps.append({
        "key": "heatup", "title": "Aufheizphasen",
        "progress": pct(s_warm), "state": "done" if s_warm >= 0.8 else "active",
        "detail": f"{warm_ok}/{n_rooms} Räume mit ≥2 klaren Aufheizphasen",
        "hint": "Kommen im normalen Betrieb von selbst."})

    s_tau = (tau_ok / n_rooms) if n_rooms else 0.0
    steps.append({
        "key": "cooldown", "title": "Heizfreie Auskühlphasen (für τ)",
        "progress": pct(s_tau), "state": "done" if s_tau >= 0.8 else "active",
        "detail": f"{tau_ok}/{n_rooms} Räume mit ≥2 freien Auskühlphasen",
        "hint": ("In den letzten Nächten wurden die Sollwerte abgesenkt – das liefert sie."
                 if night_setback else
                 "Entstehen nur, wenn ein Raum einige Stunden nicht beheizt wird. Im Dauerbetrieb "
                 "gibt es sie kaum – die Auto-Messung kann sie für ein paar Nächte erzeugen.")})

    s_span = min(1.0, out_span / 8.0) if has_outdoor else 0.0
    steps.append({
        "key": "span", "title": "Temperaturspanne außen",
        "progress": pct(s_span), "state": "done" if (has_outdoor and out_span >= 8.0) else "active",
        "detail": (f"Außen {_de(out_min)} … {_de(out_max)} °C (Spanne {_de(out_span)} K, Ziel ≥ 8 K)"
                   if has_outdoor else "keine Außentemperatur (WP/HomeCom verbinden)"),
        "hint": "Mehr Wetterwechsel macht Heizkurve und Heizlast-Schätzung sicherer."})

    overall = round(sum(s["progress"] for s in steps) / len(steps))
    # the supply comparison needs no τ – so "enough data" means time + heat-up
    done = span_days >= target_days and s_warm >= 0.75
    tau_complete = s_tau >= 0.8

    # ---- notes on the window ----
    disturbances = []
    nwin = len(win_events)
    if nwin:
        disturbances.append(f"{nwin}× Fenster geöffnet in den letzten 14 Tagen – solche Zeiten werden "
                            f"bei der Auswertung automatisch ausgeklammert (kein Fehler).")
    if has_outdoor and out_span < 4 and span_days >= 2:
        disturbances.append(f"Außentemperatur bisher nur {_de(out_span)} K Spanne – Kennlinie/Heizlast "
                            f"werden erst mit wechselhafterem Wetter belastbar.")

    need_tau = [r["room"] for r in rooms if r["n_tau"] < 2]
    if not n_rooms:
        next_action = "Noch keine Raumdaten – Thermostate koppeln, dann protokolliert die Bridge automatisch."
    elif not has_outdoor:
        next_action = "Wärmepumpe/HomeCom verbinden – ohne Außentemperatur lässt sich τ nicht ableiten."
    elif not done:
        next_action = (f"Weiterlaufen lassen ({_de(span_days)} von {target_days} Tagen) – "
                       "die Daten kommen von selbst zusammen.")
    elif not tau_complete:
        next_action = ("Für den Abgleich reichen die Daten. Nur die Trägheit τ fehlt noch für "
                       + (", ".join(need_tau[:4]) + ("…" if len(need_tau) > 4 else "")
                          if need_tau else "einige Räume")
                       + " – optional über die Auto-Messung nachholen.")
    else:
        next_action = "Genug Daten gesammelt. ✅"

    room_ready = [{"room": r["room"], "status": r["status"], "confidence": r["confidence"],
                   "n_tau": r["n_tau"], "n_warm": r["n_warm"], "n": r["n"], "missing": r["missing"]}
                  for r in rooms]

    return {
        "ok": True, "active": active, "started_ts": started,
        "target_days": target_days,
        "elapsed_days": round(elapsed_days, 1), "span_days": span_days,
        "overall": overall, "done": done, "tau_complete": tau_complete,
        "n_rooms": n_rooms, "rooms_ready": ready,
        "has_outdoor": has_outdoor, "night_setback": night_setback, "setback": sb,
        "out_span": out_span, "out_min": out_min, "out_max": out_max,
        "n_windows": nwin, "n_samples": tm["assessment"]["n_room_samples"],
        "heating_phases": tm["assessment"]["heating_phases"],
        "steps": steps, "disturbances": disturbances, "next_action": next_action,
        "room_ready": room_ready, "gap": tm["assessment"].get("gap"),
    }


def _demo_observation() -> dict:
    now = int(time.time())
    steps = [
        {"key": "days", "title": "Zeitraum (Ziel 7 Tage)", "progress": 100, "state": "done",
         "detail": "12,0 Tage protokolliert", "hint": "Läuft automatisch mit, solange die Bridge läuft."},
        {"key": "heatup", "title": "Aufheizphasen", "progress": 100, "state": "done",
         "detail": "5/5 Räume mit ≥2 klaren Aufheizphasen", "hint": "Kommen im normalen Betrieb von selbst."},
        {"key": "cooldown", "title": "Heizfreie Auskühlphasen (für τ)", "progress": 60, "state": "active",
         "detail": "3/5 Räume mit ≥2 freien Auskühlphasen",
         "hint": "Entstehen nur, wenn ein Raum einige Stunden nicht beheizt wird. Im Dauerbetrieb "
                 "gibt es sie kaum – die Auto-Messung kann sie für ein paar Nächte erzeugen."},
        {"key": "span", "title": "Temperaturspanne außen", "progress": 100, "state": "done",
         "detail": "Außen −2,0 … 8,0 °C (Spanne 10,0 K, Ziel ≥ 8 K)",
         "hint": "Mehr Wetterwechsel macht Heizkurve und Heizlast-Schätzung sicherer."},
    ]
    return {
        "ok": True, "demo": True, "active": True, "started_ts": now - 12 * 86400,
        "target_days": 7, "elapsed_days": 12.0, "span_days": 12.0,
        "overall": round(sum(s["progress"] for s in steps) / len(steps)), "done": True,
        "tau_complete": False, "n_rooms": 5, "rooms_ready": 3, "has_outdoor": True,
        "night_setback": False,
        "setback": {"nights_checked": 5, "nights_lowered": 0, "active": False, "avg_drop": 0.0,
                    "day_sp": 25.0, "night_sp": 25.0, "nights": []},
        "out_span": 10.0, "out_min": -2.0, "out_max": 8.0, "n_windows": 6,
        "n_samples": 8640, "heating_phases": 41,
        "steps": steps,
        "disturbances": ["6× Fenster geöffnet in den letzten 14 Tagen – solche Zeiten werden bei der "
                         "Auswertung automatisch ausgeklammert (kein Fehler)."],
        "next_action": "Für den Abgleich reichen die Daten. Nur die Trägheit τ fehlt noch für "
                       "Schlafzimmer, Bad – optional über die Auto-Messung nachholen.",
        "room_ready": [
            {"room": "Wohnzimmer", "status": "bereit", "confidence": "hoch", "n_tau": 5, "n_warm": 6, "n": 1728, "missing": []},
            {"room": "Küche", "status": "bereit", "confidence": "hoch", "n_tau": 4, "n_warm": 5, "n": 1728, "missing": []},
            {"room": "Kinderzimmer", "status": "bereit", "confidence": "hoch", "n_tau": 3, "n_warm": 4, "n": 1728, "missing": []},
            {"room": "Schlafzimmer", "status": "beobachtung", "confidence": "mittel", "n_tau": 0, "n_warm": 3, "n": 1728,
             "missing": ["1–2 heizfreie Auskühlphasen (Raum einige Stunden unbeheizt, Fenster zu)"]},
            {"room": "Bad", "status": "beobachtung", "confidence": "mittel", "n_tau": 1, "n_warm": 4, "n": 1728,
             "missing": ["1–2 heizfreie Auskühlphasen (Raum einige Stunden unbeheizt, Fenster zu)"]},
        ],
        "gap": ("Kein Messwert pro Heizkreis: weder Durchfluss noch Vor-/Rücklauf je Raum werden erfasst. "
                "Datenbasierte Optimierungshilfe, kein normgerechter hydraulischer Abgleich."),
    }


# ===================================================================== #
#  Intelligent heat-load analysis — module 3: per-room heat load (W)     #
# ===================================================================== #
# Idea (physically grounded, calibrated, no fake precision):
#   • The building heat-demand line comes from a MEASURED "energy signature":
#     space-heating power vs. outdoor temperature (linear regression). At the
#     design outdoor temperature that line gives the whole-house load Q_total.
#   • Per room, the conductance UA_i is proportional to area_i / τ_i:
#     τ = C/UA and, assuming the same screed capacity per m² across rooms,
#     C_i ∝ area_i, so UA_i ∝ area_i/τ_i. The unknown screed constant CANCELS
#     once we calibrate the sum of room losses to the measured Q_total.
#   • Q_design,i = UA_i · (T_set,i − T_design); the Σ equals Q_total by
#     construction. A confidence band is propagated from the τ spread, an
#     area tolerance and the signature scatter.
# Honest limits: areas are user-entered; the equal-screed assumption is just
# that; and without per-circuit flow the split is derived, not measured. This
# is a DATA-BASED estimate, not a norm heat-load calculation (DIN EN 12831).

DESIGN_OUTDOOR_C = -12.0   # typical German norm design outdoor temp (region −10…−16)


def _energy_signature(store: "Store") -> dict | None:
    """Building heat-demand line: average space-heating power (W) vs. outdoor
    temperature, by least-squares regression. Prefers the clean hourly CSV
    energy; falls back to live thermal-power samples."""
    pts = []
    for r in store.hp_history("hour"):
        heating = r.get("heating_kwh")
        o = r.get("outdoor_c")
        if heating is None or o is None or heating <= 0.01:
            continue
        pts.append((o, heating * 1000.0))     # kWh in that hour -> average W
    src = "csv"
    if len(pts) < 6:
        pts = []
        for s in store.hp_samples_since(int(time.time()) - 60 * 86400):
            if (s.get("mode") or "").lower() not in ("ch", "heating", "heat"):
                continue
            w = s.get("heat_w")
            o = s.get("outdoor_c")
            if w is None or o is None or w <= 50:
                continue
            pts.append((o, w))
        src = "live"
    if len(pts) < 6:
        return None
    fit = _linfit(pts)
    if not fit or fit[0] >= 0:
        return None                            # no sensible negative slope
    a, b = fit
    n = len(pts)
    mean_y = sum(y for _, y in pts) / n
    rss = sum((y - (a * x + b)) ** 2 for x, y in pts)
    sigma = (rss / max(1, n - 2)) ** 0.5
    rel = (sigma / mean_y) if mean_y > 0 else None
    xs = [x for x, _ in pts]
    span = max(xs) - min(xs)                        # outdoor-temp range covered
    balance_c = (-b / a) if a else None
    # A fit is only trustworthy if the data spans a decent outdoor range AND the
    # implied balance point is physically sane. Mild/narrow data gives a nearly
    # flat slope → absurd extrapolation (e.g. UA 11 W/K, balance 31 °C, whole-
    # house load 489 W). Flag those so the heat-load falls back to area-based.
    reliable = (span >= 6.0
                and balance_c is not None and 5.0 <= balance_c <= 22.0
                and (rel is None or rel <= 0.7))
    return {"a": a, "b": b, "n": n, "src": src, "sigma": sigma, "rel": rel,
            "span": round(span, 1), "reliable": bool(reliable),
            "balance_c": balance_c, "mean_w": mean_y}


def _central_spread(store: "Store") -> dict | None:
    """Measured central spread (supply − return, K) during space heating – the
    SYSTEM spread at the heat pump, NOT a per-circuit ΔT. For context only."""
    rows = store.hp_samples_since(int(time.time()) - 21 * 86400)
    diffs = []
    for s in rows:
        if (s.get("mode") or "").lower() not in ("ch", "heating", "heat"):
            continue
        su, re = s.get("supply_c"), s.get("return_c")
        if su is None or re is None:
            continue
        d = su - re
        if 0.3 <= d <= 20:
            diffs.append(d)
    if len(diffs) < 3:
        return None
    diffs.sort()
    return {"spread_k": round(diffs[len(diffs) // 2], 1), "n": len(diffs)}


# --------------------------------------------------------------------------- #
# Volume flow through the heat pump – read where the device offers it,
# otherwise derived from heat output ÷ spread. Always says which of the two.
# --------------------------------------------------------------------------- #
FLOW_DISC_KEY = "hc_flow_disc"
FLOW_REDISCOVER_S = 7 * 86400
WATER_WH_PER_LK = 1.163                  # Wh to heat one litre of water by 1 K
_HEAT_MODES = ("ch", "heating", "heat")


def _is_heat_mode(m) -> bool:
    m = (m or "").lower()
    return m in _HEAT_MODES or m.startswith(("heat", "ch"))


def _flow_disc_load(store: "Store") -> dict | None:
    try:
        raw = store.kv_get(FLOW_DISC_KEY)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _median(vals):
    v = sorted(vals)
    if not v:
        return None
    n = len(v)
    return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0


def _counter_step(vals) -> float | None:
    """Resolution of a cumulative counter (1 kWh on some devices, 0.1 or finer
    on others): the smallest step, if every step is a whole multiple of it.
    A finely resolved counter moves by arbitrary amounts → None (negligible)."""
    steps = sorted({round(b - a, 4) for a, b in zip(vals, vals[1:]) if b - a > 1e-6})
    if not steps:
        return None
    m = steps[0]
    if all(abs(x / m - round(x / m)) <= 0.03 for x in steps):
        return m
    return None


def _flow_segments(rows: list[dict], min_min: float = 15.0, max_min: float = 90.0) -> list[list[dict]]:
    """Continuous space-heating stretches with the compressor running, cut into
    pieces of 15–90 minutes – long enough for the heat counter to move, short
    enough to follow the load."""
    gaps = sorted(b["ts"] - a["ts"] for a, b in zip(rows, rows[1:]) if b["ts"] > a["ts"])
    step = gaps[len(gaps) // 2] if gaps else 300
    max_gap = max(2.5 * step, 600)
    runs, cur = [], []
    for r in rows:
        heating = (_is_heat_mode(r.get("mode")) and r.get("heat_kwh") is not None
                   and (r.get("modulation") is None or r["modulation"] > 0))
        if heating and cur and r["ts"] - cur[-1]["ts"] <= max_gap:
            cur.append(r)
            continue
        if len(cur) >= 3:
            runs.append(cur)
        cur = [r] if heating else []
    if len(cur) >= 3:
        runs.append(cur)
    segs = []
    for run in runs:
        piece = [run[0]]
        for r in run[1:]:
            piece.append(r)
            if (piece[-1]["ts"] - piece[0]["ts"]) / 60.0 >= max_min:
                segs.append(piece)
                piece = [r]                  # next piece starts where this one ended
        if len(piece) >= 3 and (piece[-1]["ts"] - piece[0]["ts"]) / 60.0 >= min_min:
            segs.append(piece)
        elif segs and segs[-1][-1] is piece[0] and len(piece) > 1:
            segs[-1] = segs[-1] + piece[1:]  # short tail: add to the piece before
    return [g for g in segs if (g[-1]["ts"] - g[0]["ts"]) / 60.0 >= min_min]


def _flow_from_segment(seg: list[dict], res_kwh: float | None) -> dict | None:
    """Flow for one piece of heating, interval by interval: heat from the
    counter and the spread at that time. Intervals without a usable spread
    (defrost, the compressor pausing) are left out of BOTH heat and time –
    otherwise a defrost would count its missing heat but not its spread."""
    num = den = hours = 0.0
    dts = []
    for a, b in zip(seg, seg[1:]):
        qa, qb = a.get("heat_kwh"), b.get("heat_kwh")
        if qa is None or qb is None or qb < qa:
            continue
        ds = []
        for r in (a, b):
            su, re_ = r.get("supply_c"), r.get("return_c")
            if su is not None and re_ is not None and 0.3 <= su - re_ <= 20:
                ds.append(su - re_)
        if not ds or not (b.get("supply_c") is not None and b.get("return_c") is not None
                          and 0.3 <= b["supply_c"] - b["return_c"] <= 20):
            continue                          # interval ends in defrost / pause
        d = sum(ds) / len(ds)
        h = (b["ts"] - a["ts"]) / 3600.0
        num += qb - qa
        den += WATER_WH_PER_LK * d * h
        hours += h
        dts.append(d)
    if len(dts) < 2 or hours <= 0:
        return None
    dt = sum(dts) / len(dts)
    if dt < 1.0:
        return None
    p_w = num * 1000.0 / hours
    # a coarse counter may not move at all in a short run: such a piece has no
    # value of its own, but it still counts when the pieces are pooled
    flow = num * 1000.0 / den / 60.0 if (p_w >= 300 and den > 0) else None
    # uncertainty: counter resolution against the heat in this piece, plus
    # ±0.2 K on the difference of two temperature sensors
    unc = (res_kwh / num if (res_kwh and num > 0) else (1.0 if res_kwh else 0.0)) + 0.2 / dt
    out_c = [r["outdoor_c"] for r in seg if r.get("outdoor_c") is not None]
    sup = [r["supply_c"] for r in seg if r.get("supply_c") is not None]
    meas = [r["flow_lmin"] for r in seg if r.get("flow_lmin") is not None]
    return {"start": seg[0]["ts"], "end": seg[-1]["ts"],
            "dur_min": round((seg[-1]["ts"] - seg[0]["ts"]) / 60.0),
            "heat_kwh": round(num, 3), "p_w": round(p_w), "dt_k": round(dt, 2),
            "den": round(den, 3),
            "l_min": round(flow, 1) if flow is not None else None, "unc": round(unc, 2),
            "sure": flow is not None and unc <= 0.3,
            "plausible": flow is not None and 2.0 <= flow <= 80.0,
            "outdoor_c": round(sum(out_c) / len(out_c), 1) if out_c else None,
            "supply_c": round(sum(sup) / len(sup), 1) if sup else None,
            "measured": round(sum(meas) / len(meas), 1) if meas else None}


def compute_flow(store: "Store", days: int = 14, rows: list[dict] | None = None,
                 demo: bool = False) -> dict:
    """Volume flow through the heat pump during space heating.

    gelesen    – the device reports a flow value (found by the discovery crawl)
    abgeleitet – heat from the energy counter ÷ (1.163 × spread × time),
                 per 30–90-min piece of continuous heating
    """
    now = int(time.time())
    if rows is None:
        rows = store.hp_samples_since(now - days * 86400)
    else:
        rows = [r for r in rows if r["ts"] >= now - days * 86400]
    disc = None if demo else _flow_disc_load(store)

    # --- read from the device ---------------------------------------------- #
    meas_rows = [r for r in rows if r.get("flow_lmin") is not None]
    heat_meas = [r["flow_lmin"] for r in meas_rows
                 if _is_heat_mode(r.get("mode")) and r["flow_lmin"] > 0]
    dhw_meas = [r["flow_lmin"] for r in meas_rows if (r.get("mode") or "").lower() == "dhw" and r["flow_lmin"] > 0]
    last_m = meas_rows[-1] if meas_rows else None
    m_beh, m_p90 = None, None
    if len(heat_meas) >= 10:
        mm = sum(heat_meas) / len(heat_meas)
        msd = (sum((x - mm) ** 2 for x in heat_meas) / (len(heat_meas) - 1)) ** 0.5
        m_beh = "konstant" if mm and msd / mm < 0.15 else "lastabhängig"
        hs = sorted(heat_meas)
        m_p90 = round(hs[min(len(hs) - 1, int(round(0.9 * (len(hs) - 1))))], 1)
    measured = {
        "available": bool(meas_rows) or bool(disc and disc.get("primary")),
        "path": (disc or {}).get("primary"),
        "latest": round(last_m["flow_lmin"], 1) if last_m else None,
        "latest_ts": last_m["ts"] if last_m else None,
        "latest_mode": (last_m.get("mode") if last_m else None),
        "heat_median": round(_median(heat_meas), 1) if heat_meas else None,
        "dhw_median": round(_median(dhw_meas), 1) if dhw_meas else None,
        "n": len(heat_meas), "behaviour": m_beh, "p90": m_p90,
    }

    # --- derived: heat ÷ spread -------------------------------------------- #
    res = _counter_step([r["heat_kwh"] for r in rows if r.get("heat_kwh") is not None])
    segs = []
    raw_segs = _flow_segments(rows)
    for g in raw_segs:
        f = _flow_from_segment(g, res)
        if f:
            segs.append(f)
    ok = [f for f in segs if f["plausible"]]
    sure = [f for f in ok if f["sure"]]
    good = sure or ok
    flows = [f["l_min"] for f in good]
    # pieces too coarse on their own (short runs, a 1-kWh counter): pool them –
    # the counter's rounding errors largely cancel over many runs
    pooled = None
    if not sure and len(segs) >= 3:
        q = sum(f["heat_kwh"] for f in segs)
        den = sum(f["den"] for f in segs)
        if q > 0 and den > 0:
            dts = sorted(f["dt_k"] for f in segs)
            unc = (res * (2 * len(segs)) ** 0.5 / q if res else 0.0) + 0.2 / dts[len(dts) // 2]
            pl = q * 1000.0 / den / 60.0
            if 2.0 <= pl <= 80.0:
                pooled = {"l_min": round(pl, 1), "n": len(segs),
                          "heat_kwh": round(q, 1), "unc": round(unc, 2), "sure": unc <= 0.3}
    behaviour, cv, corr = None, None, None
    if len(good) >= 4:
        m = sum(flows) / len(flows)
        sd = (sum((x - m) ** 2 for x in flows) / (len(flows) - 1)) ** 0.5
        cv = sd / m if m else None
        ps = [f["p_w"] for f in good]
        mp = sum(ps) / len(ps)
        cov = sum((a - mp) * (b - m) for a, b in zip(ps, flows))
        va = sum((a - mp) ** 2 for a in ps) ** 0.5
        vb = sum((b - m) ** 2 for b in flows) ** 0.5
        corr = cov / (va * vb) if va and vb else None
        if cv is not None and cv < 0.15:
            behaviour = "konstant"
        elif corr is not None and corr >= 0.5:
            behaviour = "lastabhängig"
        else:
            behaviour = "schwankend"
    p90 = sorted(flows)[min(len(flows) - 1, int(round(0.9 * (len(flows) - 1))))] if flows else None
    modes = {}
    for r in rows:
        k = r.get("mode") or "–"
        modes[k] = modes.get(k, 0) + 1
    why = None
    if not (pooled or flows):
        heat_rows = [r for r in rows if _is_heat_mode(r.get("mode"))]
        if not rows:
            why = f"noch keine Messwerte der Wärmepumpe in den letzten {days} Tagen"
        elif not any(r.get("heat_kwh") is not None for r in rows):
            why = "die Wärmepumpe liefert keinen Wärmemengenzähler – ohne Wärmemenge keine Rechnung"
        elif not any(r.get("return_c") is not None and r.get("supply_c") is not None for r in rows):
            why = "die Wärmepumpe meldet keinen Vor- und Rücklauf – ohne Spreizung keine Rechnung"
        elif not heat_rows:
            seen = ", ".join(f"„{k}“ {n}×" for k, n in sorted(modes.items(), key=lambda kv: -kv[1])[:5])
            why = f"in den letzten {days} Tagen kein Heizbetrieb erkannt (gemeldete Betriebsarten: {seen})"
        elif not any(r.get("modulation") is None or r["modulation"] > 0 for r in heat_rows):
            why = "im Heizbetrieb meldet die Wärmepumpe 0 % Modulation – ein laufender Verdichter ist nicht erkennbar"
        elif not raw_segs:
            why = "noch kein Heizlauf von mindestens 15 min mit Vor- und Rücklauf"
        elif not segs:
            why = ("im Heizbetrieb liegt die Spreizung unter 1 K – zu klein für eine verlässliche Rechnung "
                   "(die Fühler haben selbst etwa ±0,2 K Toleranz)")
        else:
            why = "die Heizläufe sind bisher zu kurz oder die Spreizung liegt unter 1 K – noch kein belastbarer Wert"
    derived = {
        "typical": (pooled["l_min"] if pooled else round(_median(flows), 1) if flows else None),
        "p90": round(p90, 1) if p90 is not None else None,
        "n": pooled["n"] if pooled else len(good), "n_all": len(segs),
        "sure": pooled["sure"] if pooled else bool(sure),
        "pooled": pooled,
        "spread_k": round(_median([f["dt_k"] for f in (good or segs)]), 1) if (good or segs) else None,
        "resolution_kwh": res,
        "behaviour": behaviour, "cv": round(cv, 2) if cv is not None else None,
        "corr": round(corr, 2) if corr is not None else None,
        "last": ok[-1] if ok else None,
        "runs": ok[-8:],
        "why": why,
        "modes": [{"mode": k, "n": n} for k, n in sorted(modes.items(), key=lambda kv: -kv[1])[:6]],
    }

    # --- the one value used elsewhere -------------------------------------- #
    if measured["heat_median"] is not None and measured["n"] >= 3:
        system = {"l_min": measured["heat_median"], "src": "gelesen",
                  "basis": f"Median von {measured['n']} gelesenen Werten im Heizbetrieb"}
    elif derived["typical"] is not None and derived["n"] >= 2:
        system = {"l_min": derived["typical"], "src": "abgeleitet",
                  "basis": (f"aus {derived['n']} Heizläufen zusammen: Wärmemenge ÷ (1,163 × Spreizung)" if pooled else
                            f"Median aus {derived['n']} Heizläufen: Wärmemenge ÷ (1,163 × Spreizung)"),
                  "sure": derived["sure"]}
    else:
        system = {"l_min": None, "src": None, "basis": None}

    # live value for the heat-pump card
    nowv = None
    if last_m and now - last_m["ts"] <= 1800:
        nowv = {"l_min": round(last_m["flow_lmin"], 1), "src": "gelesen", "ts": last_m["ts"],
                "mode": last_m.get("mode")}
    elif segs and now - segs[-1]["end"] <= 1800:     # heating right now / just now
        last = segs[-1]
        if last["sure"] and last["plausible"]:
            nowv = {"l_min": last["l_min"], "src": "abgeleitet", "ts": last["end"],
                    "start": last["start"], "dt_k": last["dt_k"], "sure": True}
        elif derived["typical"] is not None:          # this run alone is too coarse
            nowv = {"l_min": derived["typical"], "src": "abgeleitet", "ts": last["end"],
                    "dt_k": last["dt_k"], "sure": derived["sure"], "typical": True}

    check = None
    if measured["heat_median"] and derived["typical"]:
        ratio = derived["typical"] / measured["heat_median"]
        check = {"ratio": round(ratio, 2),
                 "text": ("Gelesener und abgeleiteter Wert passen zusammen." if abs(ratio - 1) <= 0.2 else
                          f"Abgeleitet {_de(derived['typical'])} l/min, gelesen {_de(measured['heat_median'])} l/min – "
                          "Wärmemengenzähler oder Temperaturfühler weichen voneinander ab; der gelesene Wert zählt.")}

    discovery = None
    if disc:
        units = sorted((disc.get("units") or {}).items(), key=lambda kv: -kv[1])
        discovery = {"ts": disc.get("ts"), "checked": disc.get("checked"), "leaves": disc.get("leaves"),
                     "complete": disc.get("complete"), "error": disc.get("error"),
                     "found": disc.get("found") or [], "primary": disc.get("primary"),
                     "units": [{"unit": u, "n": n} for u, n in units[:10]]}
    return {"ok": True, "ts": now, "days": days, "demo": demo, "measured": measured,
            "derived": derived, "system": system, "now": nowv, "check": check,
            "discovery": discovery}


def _flow_compare(fl: dict, rooms: list[dict], flow_total: float | None) -> dict | None:
    """System flow vs. what all circuits together should get (Σ target flows),
    and – when the pump cannot deliver that – what each circuit can really get."""
    sysf = (fl.get("system") or {}).get("l_min")
    if not sysf or not flow_total:
        return None
    src = fl["system"]["src"]
    part = (fl.get("measured") if src == "gelesen" else fl.get("derived")) or {}
    behaviour = part.get("behaviour")
    ratio = sysf / flow_total
    best = part.get("p90") if behaviour == "lastabhängig" else None
    out = {"l_min": sysf, "src": src, "target_sum": round(flow_total, 1), "ratio": round(ratio, 2),
           "scale": None, "tone": "good", "text": ""}
    if best and best / flow_total >= 0.85 > ratio:
        out["text"] = (f"Der Durchfluss steigt mit der Heizleistung: im Mittel {_de(sysf)} l/min, bei den bisher stärksten Heizläufen "
                       f"{_de(best)} l/min – das reicht für Σ {_de(flow_total)} l/min aller Kreise.")
    elif ratio < 0.85:
        if behaviour == "lastabhängig":
            out["tone"] = "ok"
            out["text"] = (f"Der Durchfluss steigt mit der Heizleistung (die Pumpe regelt offenbar nach Last), bisher "
                           f"höchstens {_de(best or sysf)} l/min – "
                           f"alle Kreise zusammen sollen bei Auslegung Σ {_de(flow_total)} l/min bekommen. "
                           "Ob das bei Frost reicht, zeigen erst kalte Tage.")
        else:
            out["tone"] = "warn"
            out["scale"] = round(ratio, 3)
            out["text"] = (f"Durch die Wärmepumpe fließen ~{_de(sysf)} l/min, alle Kreise zusammen sollen "
                           f"Σ {_de(flow_total)} l/min bekommen. Mehr als ankommt kann der Verteiler nicht verteilen – "
                           f"stell die Kreise <b>anteilig</b> ein (je Kreis „erreichbar“ = Ziel × {_de(ratio * 100, 0)} %). "
                           "Die Verhältnisse zwischen den Räumen bleiben so richtig.")
    elif ratio > 1.3:
        out["text"] = (f"Durch die Wärmepumpe fließen ~{_de(sysf)} l/min, mehr als alle Kreise zusammen brauchen "
                       f"(Σ {_de(flow_total)} l/min) – für die Verteilung unkritisch.")
    else:
        out["text"] = (f"Durch die Wärmepumpe fließen ~{_de(sysf)} l/min – passt zu Σ {_de(flow_total)} l/min "
                       "aller Kreise. Die Ziel-Werte sind erreichbar.")
    # cross-check with the user's own flow-meter readings
    tg = [r for r in rooms if r.get("flow_loop") is not None]
    ist = [r for r in tg if r.get("ist") is not None]
    if tg and len(ist) >= max(2, 0.7 * len(tg)):
        s_ist = sum(r["ist"] * (r.get("loops") or 1) for r in ist)
        out["ist_sum"] = round(s_ist, 1)
        out["ist_n"], out["ist_of"] = len(ist), len(tg)
        if abs(s_ist / sysf - 1) > 0.2:
            out["ist_text"] = (f"Σ deiner Tacosetter-Ablesungen {_de(s_ist)} l/min ({len(ist)} von {len(tg)} Räumen), "
                               f"durch die Wärmepumpe {_de(sysf)} l/min ({src}). Abweichung über 20 %: Ablesungen zu "
                               "verschiedenen Zeiten, ein Tacosetter mit Luft/Schmutz – oder ein Puffer bzw. eine "
                               "Weiche trennt Wärmepumpe und Verteiler.")
    return out


def compute_heatload(store: "Store", areas: dict | None = None,
                     design_c: float = DESIGN_OUTDOOR_C,
                     spread_k: float = 5.0, spec_wm2: float = 40.0,
                     tm: dict | None = None, targets: dict | None = None) -> dict:
    """Per-room heat load in watts (at the design outdoor temp) with a
    confidence band, calibrated to the measured whole-house energy signature –
    plus the physically correct per-circuit target flow l/min = Q/(1.163·60·ΔT).

    ΔT here is the chosen DESIGN spread PER CIRCUIT, not the measured central
    system spread. When every loop is set to its target flow, all loops share
    that ΔT and the central spread equals it; mixing it up would mis-size the
    flows, so the two are reported separately."""
    try:
        design_c = float(design_c)
    except (TypeError, ValueError):
        design_c = DESIGN_OUTDOOR_C
    design_c = max(-25.0, min(-5.0, design_c))
    try:
        spread_k = float(spread_k)
    except (TypeError, ValueError):
        spread_k = 5.0
    spread_k = max(3.0, min(10.0, spread_k))
    try:
        spec_wm2 = float(spec_wm2)
    except (TypeError, ValueError):
        spec_wm2 = 40.0
    spec_wm2 = max(10.0, min(120.0, spec_wm2))
    areas = areas or {}

    if tm is None:
        tm = compute_thermal_model(store, days=21, targets=targets)
    sig = _energy_signature(store)
    q_total_design = None
    ua_total = None
    # Only calibrate to the measured signature when the fit is trustworthy.
    # An unreliable fit (narrow/noisy data) would otherwise yield absurd loads.
    if sig and sig.get("reliable"):
        q = sig["a"] * design_c + sig["b"]
        if q > 0:
            q_total_design = q
            ua_total = -sig["a"]               # W per K (slope magnitude)

    def _area_of(rm):
        v = areas.get(rm)
        try:
            v = float(v)
            return v if v > 0 else None
        except (TypeError, ValueError):
            return None

    rooms = []
    known = {r["room"] for r in tm["rooms"]}
    # rooms that only exist in the manifold layout (no thermostat) still get an
    # area-based load, so their circuits are not missing from the flow table
    extra = [{"room": rm, "tau_h": None, "tau_cv": None, "n_tau": 0, "setpoint": None,
              "target": _guess_target(rm), "confidence": "niedrig", "category": None,
              "recommendation": None}
             for rm in sorted(areas) if rm not in known and _area_of(rm)]
    for r in list(tm["rooms"]) + extra:
        rm = r["room"]; tau = r["tau_h"]
        # design indoor temperature = the room's comfort TARGET, never the
        # thermostat setpoint: that is cranked up to 25–30 °C while the valves
        # are held open for balancing and would inflate the load by 10–20 %
        sp = r.get("target") if r.get("target") is not None else r["setpoint"]
        area = _area_of(rm)
        dt = (sp - design_c) if sp is not None else None
        usable = bool(tau and area and dt and dt > 0 and r["n_tau"] >= 1)
        rooms.append({"room": rm, "tau_h": tau, "tau_cv": r.get("tau_cv"),
                      "n_tau": r["n_tau"], "setpoint": sp, "area": area,
                      "dt": dt, "confidence": r["confidence"], "usable": usable,
                      # the thermal model's verdict on the CURRENT state, so the
                      # flow card can reconcile ("Reserve → nicht hochdrehen")
                      # with its design-load recommendation instead of contradicting it.
                      "category": r.get("category"), "reco": r.get("recommendation")})

    covered = [w for w in rooms if w["usable"]]
    sumL = sum((w["area"] / w["tau_h"]) * w["dt"] for w in covered)
    can_abs = bool(q_total_design and sumL > 0 and covered)
    k = (q_total_design / sumL) if can_abs else None

    total_area = sum(w["area"] for w in rooms if w["area"]) or 0.0
    covered_area = sum(w["area"] for w in covered) or 0.0
    coverage = round(covered_area / total_area, 2) if total_area else 0.0

    # Without a trustworthy calibration we estimate the load straight from area ×
    # a typical specific load (same method as the Verteiler card) so the flows
    # stay sensible and the two cards agree, instead of near-zero τ artefacts.
    area_mode = not can_abs
    method = "calibrated" if can_abs else ("area" if any(w["area"] and w["dt"] for w in rooms) else "none")

    def _flow_row(base, q, band, spec, confidence_extra=None):
        base.update({"status": "ok", "q_design": round(q),
                     "q_lo": round(max(0.0, q - band)), "q_hi": round(q + band),
                     "spec": round(spec, 1),
                     "plausible": 10 <= spec <= 120,
                     "flow_lmin": round(q / (1.163 * spread_k) / 60.0, 2),
                     "flow_lo": round(max(0.0, q - band) / (1.163 * spread_k) / 60.0, 2),
                     "flow_hi": round((q + band) / (1.163 * spread_k) / 60.0, 2)})
        if confidence_extra:
            base["confidence"] = confidence_extra

    out, sum_q = [], 0.0
    for w in rooms:
        rm = w["room"]
        base = {"room": rm, "area": w["area"], "tau_h": w["tau_h"],
                "setpoint": w["setpoint"], "confidence": w["confidence"],
                "n_tau": w["n_tau"], "category": w.get("category"), "reco": w.get("reco")}
        if w["usable"] and can_abs:
            ua = k * (w["area"] / w["tau_h"])          # W/K
            q = ua * w["dt"]                            # W at design
            spec = q / w["area"]                        # W/m²
            rel_tau = w["tau_cv"] if w["tau_cv"] is not None else 0.30
            rel = (rel_tau ** 2 + 0.10 ** 2 + ((sig["rel"] or 0.15) ** 2)) ** 0.5
            rel = max(0.15, min(0.6, rel))
            band = q * rel
            sum_q += q
            base["ua"] = round(ua, 1); base["rel"] = round(rel, 2)
            _flow_row(base, q, band, spec)
        elif area_mode and w["area"] and w["dt"] and w["dt"] > 0:
            # area-based estimate: Q = area × spec_wm2 (independent of τ)
            q = w["area"] * spec_wm2
            band = q * 0.30
            sum_q += q
            base["ua"] = round(q / w["dt"], 1); base["rel"] = 0.3; base["estimated"] = True
            _flow_row(base, q, band, spec_wm2, confidence_extra="geschätzt (Fläche)")
        else:
            miss = []
            if not w["area"]:
                miss.append("Fläche in der Verteiler-Karte eintragen")
            if w["setpoint"] is None:
                miss.append("Sollwert fehlt")
            base.update({"status": "missing", "missing": miss})
        out.append(base)

    # order: computed rooms by load desc, then the rest
    out.sort(key=lambda x: (x["status"] != "ok", -(x.get("q_design") or 0)))

    insights = []
    sig_unreliable = bool(sig and not sig.get("reliable"))
    if method == "calibrated":
        insights.append(f"Gesamt-Heizlast bei {design_c:.0f} °C ≈ <b>{round(q_total_design):d} W</b> "
                        f"(aus der gemessenen Kennlinie, Quelle: {'CSV' if sig['src']=='csv' else 'Live'}). "
                        f"Gebäude-UA ≈ {ua_total:.0f} W/K, Bilanzpunkt ≈ {sig['balance_c']:.1f} °C.")
        if coverage < 0.8:
            insights.append(f"⚠︎ Nur <b>{round(coverage*100)} %</b> der erfassten Fläche hat Raum-Daten – "
                            f"die Absolutwerte der abgedeckten Räume sind dadurch eher zu hoch. Trage für alle "
                            f"beheizten Räume Fläche ein und sammle τ.")
        odd = [r["room"] for r in out if r.get("status") == "ok" and not r.get("plausible")]
        if odd:
            insights.append("Unplausible spezifische Last (W/m²) bei: <b>" + ", ".join(odd) +
                            "</b> – Fläche prüfen oder τ noch unsicher.")
    elif method == "area":
        if sig_unreliable:
            insights.append(f"⚠︎ Die gemessene <b>Wärmekennlinie ist noch nicht belastbar</b> "
                            f"(zu wenig Kaltwetter / zu große Streuung: Bilanzpunkt käme auf "
                            f"{sig['balance_c']:.0f} °C, unrealistisch). Daher <b>Schätzung aus der Fläche</b>.")
        else:
            insights.append("Noch keine belastbare <b>Gesamt-Wärmekennlinie</b> – daher <b>Schätzung aus der "
                            "Fläche</b> (Heizleistung über Außentemperatur sammeln: WP länger mitlaufen "
                            "lassen oder HomeCom-CSV importieren).")
        insights.append(f"Annahme: <b>{spec_wm2:.0f} W/m²</b> spezifische Heizlast (anpassbar in der "
                        f"Verteiler-Karte). Die Werte verfeinern sich automatisch, sobald eine saubere "
                        f"Kennlinie + Auskühlphasen (τ) vorliegen.")
    else:
        insights.append("Noch keine Daten: trage je Raum eine <b>Fläche</b> (Verteiler-Karte) ein.")

    total_flow = sum(r.get("flow_lmin") or 0 for r in out if r.get("status") == "ok")
    central = _central_spread(store)
    if method in ("calibrated", "area"):
        flow_msg = (f"Ziel-Durchfluss gesamt ≈ <b>{total_flow:.1f} l/min</b> bei Auslege-Spreizung "
                    f"<b>{spread_k:.0f} K</b> je Kreis"
                    + (" (flächenbasiert geschätzt)." if method == "area" else "."))
        if central:
            flow_msg += (f" Aktuell <b>zentral gemessene</b> Spreizung ≈ {central['spread_k']} K "
                         f"(System, nicht je Kreis) – die beiden sind erst bei vollständig "
                         f"ausgeglichener Anlage gleich.")
        insights.append(flow_msg)

    return {
        "ok": True, "design_c": design_c, "spread_k": spread_k, "spec_wm2": spec_wm2,
        "method": method,
        "q_total_design": round(q_total_design) if q_total_design else (round(sum_q) if method == "area" and sum_q else None),
        "ua_total": round(ua_total, 1) if ua_total else None,
        "balance_c": round(sig["balance_c"], 1) if sig and sig.get("balance_c") is not None else None,
        "signature": ({"src": sig["src"], "n": sig["n"], "reliable": sig.get("reliable"),
                       "rel": round(sig["rel"], 2) if sig["rel"] else None}
                      if sig else None),
        "coverage": coverage, "sum_q_design": round(sum_q) if sum_q else None,
        "total_flow_lmin": round(total_flow, 1) if total_flow else None,
        "central_spread": central,
        "rooms": out, "insights": insights,
        "note": ("Datenbasierte Schätzung, kein normgerechter Heizlast-Nachweis (DIN EN 12831). "
                 + ("Gesamtlast = gemessen, τ = abgeleitet; " if method == "calibrated"
                    else "Hier aus Fläche × spez. Last geschätzt; ") +
                 "ersetzt keine Fachplanung."),
    }


def _demo_heatload(design_c: float = DESIGN_OUTDOOR_C, spread_k: float = 5.0) -> dict:
    try:
        design_c = max(-25.0, min(-5.0, float(design_c)))
    except (TypeError, ValueError):
        design_c = DESIGN_OUTDOOR_C
    try:
        spread_k = max(3.0, min(10.0, float(spread_k)))
    except (TypeError, ValueError):
        spread_k = 5.0
    rooms = [
        {"room": "Wohnzimmer", "area": 32.0, "tau_h": 48.0, "setpoint": 22.0,
         "confidence": "hoch", "n_tau": 5, "status": "ok", "ua": 62.0, "q_design": 2108,
         "q_lo": 1750, "q_hi": 2466, "spec": 65.9, "rel": 0.17, "plausible": True,
         "manifold": "EG", "category": "reserve",
         "reco": "Reserve vorhanden: Durchfluss ggf. leicht drosseln."},
        {"room": "Büro", "area": 14.0, "tau_h": 22.0, "setpoint": 21.0,
         "confidence": "hoch", "n_tau": 4, "status": "ok", "ua": 59.0, "q_design": 1947,
         "q_lo": 1460, "q_hi": 2434, "spec": 139.1, "rel": 0.25, "plausible": False,
         "manifold": "EG", "category": "under",
         "reco": "Kandidat für mehr Durchfluss beim Abgleich."},
        {"room": "Bad", "area": 8.0, "tau_h": 18.0, "setpoint": 24.0,
         "confidence": "mittel", "n_tau": 4, "status": "ok", "ua": 41.0, "q_design": 1476,
         "q_lo": 1040, "q_hi": 1912, "spec": 184.5, "rel": 0.30, "plausible": False,
         "manifold": "OG", "category": "balanced"},
        {"room": "Schlafzimmer", "area": 16.0, "tau_h": None, "setpoint": 19.0,
         "confidence": "niedrig", "n_tau": 1, "status": "missing",
         "missing": ["mehr Auskühlphasen (τ fehlt)"], "manifold": "OG"},
    ]
    for r in rooms:
        if r["status"] == "ok":
            r["flow_lmin"] = round(r["q_design"] / (1.163 * spread_k) / 60.0, 2)
            r["flow_lo"] = round(r["q_lo"] / (1.163 * spread_k) / 60.0, 2)
            r["flow_hi"] = round(r["q_hi"] / (1.163 * spread_k) / 60.0, 2)
    sum_q = sum(r.get("q_design", 0) for r in rooms if r.get("status") == "ok")
    total_flow = round(sum(r.get("flow_lmin", 0) for r in rooms if r.get("status") == "ok"), 1)
    return {
        "ok": True, "demo": True, "design_c": design_c, "spread_k": spread_k,
        "q_total_design": 5531, "ua_total": 167.0, "balance_c": 15.3,
        "signature": {"src": "csv", "n": 412, "rel": 0.12},
        "coverage": 0.81, "sum_q_design": sum_q,
        "total_flow_lmin": total_flow, "central_spread": {"spread_k": 4.2, "n": 180},
        "rooms": rooms,
        "insights": [
            f"Gesamt-Heizlast bei {design_c:.0f} °C ≈ <b>5531 W</b> (aus der gemessenen Kennlinie, Quelle: CSV). "
            "Gebäude-UA ≈ 167 W/K, Bilanzpunkt ≈ 15.3 °C.",
            "Unplausible spezifische Last (W/m²) bei: <b>Büro, Bad</b> – Fläche prüfen oder τ noch unsicher.",
            f"Ziel-Durchfluss gesamt ≈ <b>{total_flow:.1f} l/min</b> bei Auslege-Spreizung <b>{spread_k:.0f} K</b> je Kreis. "
            "Aktuell <b>zentral gemessene</b> Spreizung ≈ 4.2 K (System, nicht je Kreis).",
        ],
        "note": ("Datenbasierte Schätzung, kein normgerechter Heizlast-Nachweis (DIN EN 12831). "
                 "Fläche = eingegeben, τ = abgeleitet, Gesamtlast = gemessen; Annahme gleicher "
                 "Estrich-Speichermasse je m². Ersetzt keine Fachplanung."),
    }


# ===================================================================== #
#  Intelligent heat-load analysis — module 5: step-wise balancing loop   #
# ===================================================================== #
# The closed loop that ties it together: one concrete adjustment at a time,
# then OBSERVE its effect (does the room now reach its setpoint? did the
# deficit shrink?), then the next step – until the system is balanced, at
# which point the heating curve can be lowered for the real efficiency gain.
# State (the log of steps + a per-step baseline snapshot) lives in kv so the
# loop survives restarts. It never writes to the heat pump; it records what
# the user did at the manifold and measures the result from the thermostats.

OPT_KEY = "optimize"


def _esc(s) -> str:
    """Minimal HTML escape for user-supplied text embedded in recommendation HTML."""
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _opt_steps(store: "Store") -> list:
    raw = store.kv_get(OPT_KEY)
    if not raw:
        return []
    try:
        d = json.loads(raw)
        return d.get("steps", []) if isinstance(d, dict) else []
    except (ValueError, TypeError):
        return []


def _opt_save(store: "Store", steps: list):
    store.kv_set(OPT_KEY, json.dumps({"steps": steps}))


def _room_snapshot(room: dict) -> dict:
    """The metrics we freeze when a step is logged, to measure its effect later."""
    return {"deficit": room.get("max_deficit"), "reaches": room.get("reaches"),
            "need": room.get("need_k"), "dev": room.get("dev"), "rel": room.get("rel"),
            "temp_24h": room.get("temp_24h"), "open": room.get("open_mode"),
            "cooldown": room.get("cooldown_kph"), "tau": room.get("tau_h"),
            "temp": room.get("temp_now"), "setpoint": room.get("setpoint")}


def _step_effect(step: dict, cur: dict | None, now: int) -> dict:
    """Compare a logged step's baseline against the current room state. The
    yardstick is the room's shortfall in K (`need`: against the house average
    while the thermostats are open, else against its setpoint); steps logged
    before that metric existed fall back to the plain deficit."""
    days = round((now - step["ts"]) / 86400.0, 1)
    b = step.get("baseline") or {}
    if not cur:
        return {"days": days, "verdict": "unbekannt",
                "line": "Raum nicht mehr in den Daten gefunden."}
    if cur.get("need_k") is not None and b.get("need") is not None:
        cur_need, base_need = cur["need_k"], b["need"]
    else:
        cur_need, base_need = (cur.get("max_deficit") or 0.0), (b.get("deficit") or 0.0)
    d = round(cur_need - base_need, 1)             # negative = room got warmer = less shortfall
    settling = days < 1.5
    action = step.get("action")
    if settling:
        verdict = "läuft"
        line = f"Seit {_de(days)} Tagen in Beobachtung – Wirkung braucht meist 1–2 Tage (Fußboden ist träge)."
    elif action == "open":
        if d <= -0.3:
            verdict = "wirksam"
            line = (f"Der Raum hat {_de(abs(d))} K aufgeholt"
                    + (" und liegt jetzt im Gleichlauf. 👍" if cur_need < SUPPLY_BAND_K else
                       f" – es fehlen noch {_de(cur_need)} K, ein weiterer kleiner Schritt lohnt sich."))
        elif d >= 0.3:
            verdict = "verschlechtert"
            line = f"Der Rückstand ist um {_de(d)} K größer geworden – anderer Einfluss? (Wetter, Fenster, anderer Kreis)"
        else:
            verdict = "kaum effekt"
            line = f"Kaum Änderung ({'+' if d >= 0 else '−'}{_de(abs(d))} K) – evtl. etwas größerer Schritt oder Vorlauf prüfen."
    else:  # throttle
        if cur.get("category") == "under" or cur_need >= SUPPLY_BAND_K:
            verdict = "zu weit gedrosselt"
            line = f"Der Raum liegt jetzt {_de(cur_need)} K zurück – etwas zurücknehmen."
        elif d >= 0.2:
            verdict = "wirksam"
            line = f"Der Raum ist {_de(d)} K näher an den Schnitt gerückt, ohne zu kühl zu werden. 👍"
        else:
            verdict = "ok"
            line = f"Stabil ({'+' if d >= 0 else '−'}{_de(abs(d))} K) – der Raum hat die Drosselung gut vertragen."
    return {"days": days, "d_deficit": d, "need_now": cur_need,
            "reaches_now": bool(cur.get("reaches")), "verdict": verdict, "line": line}


def _opt_recommend(tm: dict, curve: dict | None, steps: list, now: int) -> dict:
    """The single next action for the balancing loop."""
    rooms = [r for r in tm.get("rooms", []) if r.get("dev") is not None]
    house = tm.get("house") or {}

    # 1) don't stack changes: if the last step is still settling, wait
    if steps:
        last = steps[-1]
        days = (now - last["ts"]) / 86400.0
        if days < 1.5:
            return {"kind": "wait", "title": "Letzten Schritt wirken lassen",
                    "text": f"Der letzte Schritt an <b>{_esc(last['room'])}</b> läuft seit {_de(days)} Tagen. "
                            f"Mindestens 1–2 Tage beobachten, bevor der nächste Kreis verstellt wird – "
                            f"Fußbodenheizung reagiert träge.", "room": last["room"]}

    # 2) nothing to compare yet
    if not rooms:
        return {"kind": "observe", "title": "Noch keine aktuellen Raumdaten",
                "text": "Sobald die Thermostate Werte der letzten 24 Stunden liefern, vergleiche ich "
                        "die Räume und schlage den ersten Schritt vor.", "room": None}

    under = sorted([r for r in rooms if r.get("category") == "under"],
                   key=lambda r: -(r.get("need_k") or 0))
    over = sorted([r for r in rooms if r.get("category") == "reserve"],
                  key=lambda r: (r.get("need_k") or 0))

    # 3) the room that is furthest behind → open one small step
    if under:
        w = under[0]
        counter = over[0] if over else None
        return {"kind": "open", "title": f"{w['room']}: Durchfluss erhöhen",
                "room": w["room"], "action": "open",
                "text": f"<b>{_esc(w['room'])}</b>: {w['finding']} Am Verteiler den Durchfluss dieses "
                        f"Kreises <b>einen kleinen Schritt öffnen</b> (+0,2–0,3 l/min je Kreis)"
                        + (f"; im Gegenzug <b>{_esc(counter['room'])}</b> etwas androsseln, der Raum hat "
                           f"Reserve" if counter else "")
                        + ". Dann 1–2 Tage beobachten und den Schritt unten protokollieren.",
                "counter_room": counter["room"] if counter else None}

    # 4) nobody too cold, but someone clearly too warm → throttle that one
    if over and house.get("open"):
        w = over[0]
        return {"kind": "throttle", "title": f"{w['room']}: leicht androsseln",
                "room": w["room"], "action": "throttle",
                "text": f"Kein Raum ist zu kalt. <b>{_esc(w['room'])}</b>: {w['finding']} Einen kleinen "
                        f"Schritt <b>androsseln</b> (−0,2–0,3 l/min je Kreis) – das macht den Rücklauf "
                        f"kühler und die Wärmepumpe effizienter. Danach 1–2 Tage beobachten."}

    # 5) balanced while the thermostats are open → hand control back + curve
    if house.get("open"):
        hd = house.get("dev")
        txt = ("Die Räume laufen jetzt im <b>Gleichlauf</b> – der Verteiler ist eingestellt. "
               "Stelle die Thermostate wieder auf deine <b>Wunschtemperaturen</b>.")
        if hd is not None and hd >= 0.5:
            txt += (f" Das Haus liegt im Schnitt <b>{_de(hd)} K über</b> den Wunschwerten: Jetzt die "
                    f"<b>Heizkurve</b> (bzw. den Raum-Soll an der Wärmepumpe) schrittweise senken – "
                    f"das ist der eigentliche Effizienzgewinn.")
        elif hd is not None and hd <= -0.5:
            txt += (f" Das Haus liegt im Schnitt <b>{_de(abs(hd))} K unter</b> den Wunschwerten: die "
                    f"Heizkurve ist eher zu niedrig – in kleinen Schritten anheben.")
        return {"kind": "restore", "title": "Ausgeglichen – Thermostate zurückstellen",
                "room": None, "text": txt}

    # 6) normal operation, everyone supplied → efficiency: lower the curve
    if curve and curve.get("enough"):
        over_k = curve.get("over_k") or 0
        rec = curve.get("recommendation") or {}
        if over_k >= 2 and not rec.get("efficient", False):
            sv = curve.get("saving_pct") or 0
            return {"kind": "curve", "title": "Heizkurve absenken (Effizienz)",
                    "room": None,
                    "text": "Alle Räume halten ihren Sollwert – jetzt der eigentliche Effizienzgewinn: "
                            f"die <b>Heizkurve ~{round(over_k)} K absenken</b> (siehe Heizkurven-Karte unter "
                            f"„Einstellung“), in 2–3-K-Schritten, bis der kälteste Raum gerade noch warm wird."
                            + (f" Geschätzte Ersparnis ~{round(sv*100)} %." if sv else ""),
                    "saving_pct": sv}
    return {"kind": "done", "title": "Alle Räume sind versorgt ✅",
            "room": None,
            "text": "Im Regelbetrieb hält jeder Raum seinen Sollwert. Die Thermostate gleichen dabei "
                    "kleine Schieflagen selbst aus – willst du den Verteiler gezielt prüfen, dreh alle "
                    "Thermostate für 2–3 Tage hoch (Einstell-Modus): dann vergleiche ich die Räume direkt."}


def compute_optimize(store: "Store", tm: dict | None = None, curve: dict | None = None) -> dict:
    """Step-wise hydraulic-balancing loop: current recommendation, the logged
    steps with their measured effect, and the efficiency coupling."""
    now = int(time.time())
    if tm is None:
        tm = compute_thermal_model(store, days=21)
    rmap = {r["room"]: r for r in tm.get("rooms", [])}
    if curve is None:
        try:
            curve = compute_heating_curve(store, 30, None)
        except Exception:
            curve = None
    steps = _opt_steps(store)

    # attach live effect to every logged step
    hist = []
    for s in steps:
        eff = _step_effect(s, rmap.get(s["room"]), now)
        hist.append({**s, "effect": eff})
    hist.sort(key=lambda x: -x["ts"])

    rec = _opt_recommend(tm, curve, steps, now)

    # efficiency panel (30-day window – named, so it is not mistaken for the
    # "today" figure of the heating-curve card)
    eff_panel = None
    if curve and curve.get("enough"):
        r = curve.get("recommendation") or {}
        eff_panel = {"over_k": curve.get("over_k"), "verdict": curve.get("verdict"),
                     "saving_pct": curve.get("saving_pct"), "efficient": r.get("efficient", False),
                     "days": 30}

    # room list for the step form
    room_opts = [{"room": r["room"], "category": r.get("category"),
                  "deficit": r.get("max_deficit"), "need": r.get("need_k"),
                  "reaches": r.get("reaches"), "confidence": r.get("confidence")}
                 for r in tm.get("rooms", [])]

    live = [r for r in tm.get("rooms", []) if r.get("dev") is not None]
    balanced = bool(live) and not any(r.get("category") in ("under", "reserve") for r in live)
    return {"ok": True, "recommendation": rec, "steps": hist, "n_steps": len(steps),
            "efficiency": eff_panel, "rooms": room_opts, "balanced": balanced,
            "note": ("Die App schreibt NICHT an die Wärmepumpe – sie protokolliert deine Handgriffe am "
                     "Verteiler und misst die Wirkung aus den Raumthermostaten. Immer nur EIN Kreis pro "
                     "Schritt, dann 1–2 Tage beobachten. Datenbasierte Selbstoptimierung, kein Norm-Abgleich.")}


def _opt_add_step(store: "Store", body: dict) -> dict:
    """Log one adjustment with a baseline snapshot of the target room."""
    room = str(body.get("room") or "").strip()
    action = body.get("action") if body.get("action") in ("open", "throttle") else "open"
    if not room:
        return {"ok": False, "error": "Raum fehlt."}
    tm = compute_thermal_model(store, days=21)
    rmap = {r["room"]: r for r in tm.get("rooms", [])}

    def _f(key):
        try:
            return round(float(body.get(key)), 2)
        except (TypeError, ValueError):
            return None

    steps = _opt_steps(store)
    nid = (max((s.get("id", 0) for s in steps), default=0) + 1)
    step = {"id": nid, "ts": int(time.time()), "room": room, "action": action,
            "delta_lmin": _f("delta_lmin"), "from_lmin": _f("from_lmin"),
            "to_lmin": _f("to_lmin"), "note": str(body.get("note") or "")[:200],
            "baseline": _room_snapshot(rmap.get(room, {}))}
    steps.append(step)
    _opt_save(store, steps)
    return {"ok": True, **compute_optimize(store)}


def _opt_undo(store: "Store") -> dict:
    steps = _opt_steps(store)
    if steps:
        steps.pop()
        _opt_save(store, steps)
    return {"ok": True, **compute_optimize(store)}


def _opt_reset(store: "Store") -> dict:
    store.kv_del(OPT_KEY)
    return {"ok": True, **compute_optimize(store)}


def _demo_optimize() -> dict:
    now = int(time.time())
    steps = [
        {"id": 1, "ts": now - 4 * 86400, "room": "Büro", "action": "open",
         "delta_lmin": 0.3, "from_lmin": 1.4, "to_lmin": 1.7, "note": "Verteiler Kreis 3 aufgedreht",
         "baseline": {"deficit": 1.2, "reaches": False, "cooldown": 0.9, "tau": 22.0, "temp": 19.8, "setpoint": 21.0},
         "effect": {"days": 4.0, "d_deficit": -0.9, "reaches_now": True, "verdict": "wirksam",
                    "line": "Raum erreicht jetzt sein Soll (vorher nicht). Defizit -0.9 K."}},
        {"id": 2, "ts": now - 12 * 3600, "room": "Wohnzimmer", "action": "throttle",
         "delta_lmin": -0.3, "from_lmin": 3.0, "to_lmin": 2.7, "note": "etwas zurückgenommen",
         "baseline": {"deficit": 0.1, "reaches": True, "cooldown": 0.35, "tau": 48.0, "temp": 21.9, "setpoint": 22.0},
         "effect": {"days": 0.5, "d_deficit": 0.0, "reaches_now": True, "verdict": "läuft",
                    "line": "Seit 0.5 Tagen in Beobachtung – Wirkung braucht meist 1–2 Tage."}},
    ]
    return {
        "ok": True, "demo": True,
        "recommendation": {"kind": "wait", "title": "Letzten Schritt wirken lassen",
                           "room": "Wohnzimmer",
                           "text": "Der letzte Schritt an <b>Wohnzimmer</b> läuft seit 0.5 Tagen. "
                                   "Mindestens 1–2 Tage beobachten, bevor der nächste Kreis verstellt wird."},
        "steps": sorted(steps, key=lambda x: -x["ts"]), "n_steps": 2,
        "efficiency": {"over_k": 4, "verdict": "Heizkurve etwas zu hoch – Spielraum nach unten.",
                       "saving_pct": 0.1, "efficient": False},
        "rooms": [
            {"room": "Wohnzimmer", "category": "reserve", "deficit": 0.1, "reaches": True, "confidence": "hoch"},
            {"room": "Büro", "category": "balanced", "deficit": 0.2, "reaches": True, "confidence": "hoch"},
            {"room": "Bad", "category": "balanced", "deficit": 0.2, "reaches": True, "confidence": "mittel"},
            {"room": "Schlafzimmer", "category": "observing", "deficit": None, "reaches": True, "confidence": "niedrig"},
        ],
        "balanced": True,
        "note": ("Die App schreibt NICHT an die Wärmepumpe – sie protokolliert deine Handgriffe am Verteiler "
                 "und misst die Wirkung. Immer nur EIN Kreis pro Schritt, dann 1–2 Tage beobachten."),
    }


# ===================================================================== #
#  Active control — "Auto-Messung": orchestrated night setback for τ      #
# ===================================================================== #
# The ONLY part of the system that writes to the heating. Opt-in, bounded,
# time-boxed and self-restoring. While armed, it lowers the room setpoints
# during a night window to force clean, undisturbed cool-down (so module 1
# can derive τ per room), then writes the EXACT previous setpoints back in
# the morning. Originals are persisted BEFORE any write, so a restart still
# restores. Hard guards: only ever LOWERS (never raises), never below the
# floor temperature, the SHC client clamps 5–30 °C, and disabling restores
# immediately. It auto-stops after enough nights or once every room has τ.

AM_KEY = "automeasure"
AM_SETBACK_MIN, AM_SETBACK_MAX = 1.0, 5.0
AM_FLOOR_MIN, AM_FLOOR_MAX = 12.0, 20.0


def _am_defaults() -> dict:
    return {"enabled": False, "setback_k": 4.0, "floor_c": 15.0,
            "start_h": 23, "end_h": 5, "max_nights": 5, "nights_done": 0,
            "last_night": None, "run": None, "log": []}


def _am_cfg(store: "Store"):
    raw = store.kv_get(AM_KEY)
    if not raw:
        return None
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else None
    except (ValueError, TypeError):
        return None


def _am_save(store: "Store", cfg: dict):
    cfg["log"] = (cfg.get("log") or [])[-40:]
    store.kv_set(AM_KEY, json.dumps(cfg))


def _am_log(cfg: dict, ts: int, action: str, room, frm, to, note):
    cfg.setdefault("log", []).append({"ts": ts, "action": action, "room": room,
                                      "from": frm, "to": to, "note": note})


def _am_in_window(now: int, start_h: int, end_h: int) -> bool:
    h = datetime.fromtimestamp(now).hour
    if start_h == end_h:
        return False
    if start_h < end_h:
        return start_h <= h < end_h
    return h >= start_h or h < end_h          # wraps across midnight


def _am_window_ends(now: int, end_h: int) -> int:
    dt = datetime.fromtimestamp(now)
    end = dt.replace(hour=end_h, minute=0, second=0, microsecond=0)
    if end <= dt:
        end = end + timedelta(days=1)
    return int(end.timestamp())


def _am_night_label(now: int, start_h: int, end_h: int) -> str:
    dt = datetime.fromtimestamp(now)
    if start_h > end_h and dt.hour < end_h:   # early-morning part belongs to last night
        dt = dt - timedelta(days=1)
    return dt.strftime("%Y-%m-%d")


def _am_start(client, store, cfg, now, night):
    try:
        climate = client.list_climate()
    except Exception as exc:
        _am_log(cfg, now, "fehler", None, None, None, f"Lesen fehlgeschlagen: {exc}")
        _am_save(store, cfg)
        return
    setback = max(AM_SETBACK_MIN, min(AM_SETBACK_MAX, float(cfg.get("setback_k", 4.0))))
    floor = max(AM_FLOOR_MIN, min(AM_FLOOR_MAX, float(cfg.get("floor_c", 15.0))))
    originals, applied = {}, {}
    for r in climate:
        if str(r.get("roomControlMode") or "HEATING").upper() == "OFF" or r.get("summerMode"):
            continue
        sp, rcc = r.get("setpoint"), r.get("rcc_device")
        if not isinstance(sp, (int, float)) or not rcc:
            continue
        target = max(floor, round(sp - setback, 1))
        if target >= sp - 0.1:                 # already at/below floor → nothing to lower
            continue
        try:
            t = client.set_room_setpoint(rcc, target)
            originals[r["room"]] = {"rcc": rcc, "setpoint": sp}
            applied[r["room"]] = t
            _am_log(cfg, now, "absenken", r["room"], sp, t, None)
        except Exception as exc:
            _am_log(cfg, now, "fehler", r["room"], sp, target, str(exc))
    if originals:
        cfg["run"] = {"night": night, "started": now,
                      "ends_ts": _am_window_ends(now, cfg["end_h"]),
                      "originals": originals, "applied": applied}
    cfg["last_night"] = night
    _am_save(store, cfg)


def _am_restore(client, store, cfg, now, reason=""):
    run = cfg.get("run") or {}
    originals = run.get("originals") or {}
    remaining = {}
    for room, o in originals.items():
        if client is None:
            remaining[room] = o
            continue
        try:
            client.set_room_setpoint(o["rcc"], o["setpoint"])
            _am_log(cfg, now, "zurückgestellt", room, None, o["setpoint"], reason or None)
        except Exception as exc:
            _am_log(cfg, now, "fehler", room, None, o.get("setpoint"), f"Restore: {exc}")
            remaining[room] = o
    if remaining:
        run["originals"] = remaining
        cfg["run"] = run                        # keep for retry on the next tick
    else:
        cfg["run"] = None
        cfg["nights_done"] = cfg.get("nights_done", 0) + 1
        try:
            tm = compute_thermal_model(store, days=21)
            heat = tm.get("rooms") or []
            if heat and all(r.get("n_tau", 0) >= 2 for r in heat):
                cfg["enabled"] = False
                _am_log(cfg, now, "auto-stop", None, None, None, "genug τ-Daten gesammelt")
        except Exception:
            pass
        if cfg.get("nights_done", 0) >= cfg.get("max_nights", 5):
            cfg["enabled"] = False
            _am_log(cfg, now, "auto-stop", None, None, None, "max. Nächte erreicht")
    _am_save(store, cfg)


def automeasure_tick(client, store, now=None):
    """Reconciliation tick (called from the poller). Idempotent and restart-safe:
    it brings the real state in line with 'should we be lowered right now?'."""
    cfg = _am_cfg(store)
    if not cfg:
        return
    now = now or int(time.time())
    run = cfg.get("run")
    if not cfg.get("enabled"):
        if run:                                 # disabled mid-run → restore
            _am_restore(client, store, cfg, now, reason="deaktiviert")
        return
    in_win = _am_in_window(now, cfg.get("start_h", 23), cfg.get("end_h", 5))
    if run:
        if now >= run.get("ends_ts", 0) or not in_win:
            _am_restore(client, store, cfg, now, reason="Fenster beendet")
        return                                  # else hold (already lowered)
    if not in_win:
        return
    night = _am_night_label(now, cfg.get("start_h", 23), cfg.get("end_h", 5))
    if cfg.get("last_night") == night:
        return
    if cfg.get("nights_done", 0) >= cfg.get("max_nights", 5):
        cfg["enabled"] = False
        _am_save(store, cfg)
        return
    if client is None:
        return
    _am_start(client, store, cfg, now, night)


def compute_automeasure(store: "Store") -> dict:
    cfg = _am_cfg(store) or _am_defaults()
    now = int(time.time())
    run = cfg.get("run")
    state = "aktiv – abgesenkt" if run else ("scharf (wartet auf Nachtfenster)"
                                             if cfg.get("enabled") else "aus")
    return {"ok": True, "enabled": bool(cfg.get("enabled")),
            "setback_k": cfg.get("setback_k", 4.0), "floor_c": cfg.get("floor_c", 15.0),
            "start_h": cfg.get("start_h", 23), "end_h": cfg.get("end_h", 5),
            "max_nights": cfg.get("max_nights", 5), "nights_done": cfg.get("nights_done", 0),
            "running": bool(run), "state": state,
            "lowered_rooms": list((run.get("applied") or {}).keys()) if run else [],
            "in_window": _am_in_window(now, cfg.get("start_h", 23), cfg.get("end_h", 5)),
            "log": list(reversed(cfg.get("log") or []))[:20]}


def _am_arm(store: "Store", body: dict) -> dict:
    cfg = _am_cfg(store) or _am_defaults()

    def cf(key, lo, hi, dflt):
        try:
            return max(lo, min(hi, float(body.get(key))))
        except (TypeError, ValueError):
            return dflt

    def ci(key, lo, hi, dflt):
        try:
            return int(max(lo, min(hi, int(body.get(key)))))
        except (TypeError, ValueError):
            return dflt

    cfg["setback_k"] = cf("setback_k", AM_SETBACK_MIN, AM_SETBACK_MAX, cfg.get("setback_k", 4.0))
    cfg["floor_c"] = cf("floor_c", AM_FLOOR_MIN, AM_FLOOR_MAX, cfg.get("floor_c", 15.0))
    cfg["start_h"] = ci("start_h", 0, 23, cfg.get("start_h", 23))
    cfg["end_h"] = ci("end_h", 0, 23, cfg.get("end_h", 5))
    cfg["max_nights"] = ci("max_nights", 1, 14, cfg.get("max_nights", 5))
    cfg["enabled"] = True
    cfg["nights_done"] = 0
    cfg["last_night"] = None
    _am_save(store, cfg)
    return compute_automeasure(store)


def _am_disarm(store: "Store", client, now=None) -> dict:
    cfg = _am_cfg(store) or _am_defaults()
    cfg["enabled"] = False
    _am_save(store, cfg)
    if cfg.get("run"):
        _am_restore(client, store, cfg, now or int(time.time()), reason="manuell gestoppt")
    return compute_automeasure(store)


def _demo_automeasure() -> dict:
    now = int(time.time())
    return {
        "ok": True, "demo": True, "enabled": True,
        "setback_k": 4.0, "floor_c": 15.0, "start_h": 23, "end_h": 5,
        "max_nights": 5, "nights_done": 2, "running": True, "state": "aktiv – abgesenkt",
        "lowered_rooms": ["Wohnzimmer", "Büro", "Schlafzimmer"],
        "in_window": True,
        "log": [
            {"ts": now - 3600, "action": "absenken", "room": "Wohnzimmer", "from": 22.0, "to": 18.0, "note": None},
            {"ts": now - 3600, "action": "absenken", "room": "Büro", "from": 21.0, "to": 17.0, "note": None},
            {"ts": now - 90000, "action": "zurückgestellt", "room": "Wohnzimmer", "from": None, "to": 22.0, "note": "Fenster beendet"},
        ],
    }


# ===================================================================== #
#  Hydraulic balancing — ONE consolidated view                           #
# ===================================================================== #
# The balancing tab used to be ten cards, each computing its own thermal
# model and its own per-room list (model / heat load / target flow / manifold
# table / priority / readiness / step form) – with numbers that disagreed
# between cards (two different ΔT settings → two different l/min for the same
# circuit). compute_balance() runs every module ONCE on the same inputs and
# merges the result into a single per-room table plus one next step.

SETTINGS_KV = "settings"          # the synced app settings (frontend localStorage mirror)

DEMO_LAYOUT = {
    "q": 40, "dt": 6, "manifolds": ["EG", "OG"],     # q/dt = the app's own defaults
    "rooms": {
        "Wohnzimmer": {"manifold": "EG", "area": 32, "loops": 3},
        "Küche": {"manifold": "EG", "area": 16, "loops": 2},
        "Arbeitszimmer": {"manifold": "EG", "area": 12, "loops": 1},
        "Schlafzimmer": {"manifold": "OG", "area": 16, "loops": 2},
        "Bad": {"manifold": "OG", "area": 8, "loops": 1},
    },
}


def _app_settings(store: "Store") -> dict:
    raw = store.kv_get(SETTINGS_KV)
    if not raw:
        return {}
    try:
        d = json.loads(raw)
        return d if isinstance(d, dict) else {}
    except (ValueError, TypeError):
        return {}


def _settings_floats(st: dict | None, prefix: str, lo: float, hi: float) -> dict:
    out = {}
    for k, v in (st or {}).items():
        if isinstance(k, str) and k.startswith(prefix):
            try:
                f = float(str(v).replace(",", "."))
            except (TypeError, ValueError):
                continue
            if lo <= f <= hi:
                out[k[len(prefix):]] = f
    return out


def _settings_targets(st: dict | None) -> dict:
    """room -> comfort target °C the user entered (key ``bhe_target_<room>``)."""
    return _settings_floats(st, "bhe_target_", 10.0, 30.0)


def _settings_taco(st: dict | None) -> dict:
    """room -> current flow-meter reading per circuit, l/min (``bhe_taco_<room>``)."""
    return _settings_floats(st, "bhe_taco_", 0.0, 30.0)


def _settings_layout(st: dict | None) -> dict:
    """The manifold layout the user maintains in the app (rooms → manifold,
    area, number of circuits) plus the three assumptions every flow figure
    depends on: specific load q [W/m²], circuit spread dt [K], design outdoor
    temperature [°C]. One place, so no two cards can use different values."""
    try:
        l = json.loads((st or {}).get("heatLayout") or "{}")
    except (ValueError, TypeError):
        l = {}
    if not isinstance(l, dict):
        l = {}

    def f(v, dflt, lo, hi):
        try:
            return max(lo, min(hi, float(v)))
        except (TypeError, ValueError):
            return dflt

    def pos(v):
        try:
            x = float(v)
            return x if x > 0 else None
        except (TypeError, ValueError):
            return None

    rooms = {}
    for rm, c in (l.get("rooms") or {}).items():
        if not isinstance(c, dict) or not isinstance(rm, str):
            continue
        loops = pos(c.get("loops"))
        rooms[rm] = {"manifold": str(c.get("manifold") or ""), "area": pos(c.get("area")),
                     "loops": max(1, int(round(loops))) if loops else 1,
                     "length": pos(c.get("length"))}
    return {"q": f(l.get("q"), 40.0, 10.0, 120.0), "dt": f(l.get("dt"), 6.0, 3.0, 10.0),
            "design_c": f(l.get("design"), DESIGN_OUTDOOR_C, -25.0, -5.0),
            "manifolds": [str(m) for m in (l.get("manifolds") or []) if m],
            "rooms": rooms,
            "hidden": [str(x) for x in (l.get("hidden") or []) if x]}


def compute_balance(store: "Store", settings: dict | None = None, demo: bool = False) -> dict:
    """Everything the balancing tab shows, computed once: phase, the single
    next step, one merged row per room (supply · model · heat load · target
    flow · the user's flow-meter reading), manifold sums, the data situation
    and the step log."""
    now = int(time.time())
    st = dict(settings if settings is not None else _app_settings(store))
    layout = _settings_layout(st)
    layout_demo = False
    if demo and not any(c.get("area") for c in layout["rooms"].values()):
        # demo without a layout of its own: show example rooms so the table is
        # not empty – but keep the assumptions the user may already have changed
        base = dict(DEMO_LAYOUT)
        if st.get("heatLayout"):
            base.update({"q": layout["q"], "dt": layout["dt"], "design": layout["design_c"]})
        layout = _settings_layout({"heatLayout": json.dumps(base)})
        layout_demo = True
    targets = _settings_targets(st)
    taco = _settings_taco(st)
    hidden = set(layout["hidden"])

    tm = compute_thermal_model(store, days=21, targets=targets, exclude=hidden)
    areas = {rm: c["area"] for rm, c in layout["rooms"].items()
             if c.get("area") and rm not in hidden}
    hl = compute_heatload(store, areas, layout["design_c"], layout["dt"], layout["q"], tm=tm)
    try:
        curve = compute_heating_curve(store, 30, None)
    except Exception:
        curve = None
    opt = compute_optimize(store, tm=tm, curve=curve)
    obs = compute_observation(store, tm=tm)
    am = compute_automeasure(store)
    try:
        fl = compute_flow(store, days=14, demo=demo)
    except Exception as exc:
        print(f"[abgleich] flow: {exc}", file=sys.stderr)
        fl = None

    tm_by = {r["room"]: r for r in tm["rooms"]}
    hl_by = {r["room"]: r for r in hl["rooms"]}
    names = sorted(set(tm_by) | {rm for rm in layout["rooms"] if rm not in hidden})
    rooms = []
    for rm in names:
        t = tm_by.get(rm) or {}
        h = hl_by.get(rm) or {}
        c = layout["rooms"].get(rm) or {}
        loops = int(c.get("loops") or 1)
        ok = h.get("status") == "ok" and h.get("flow_lmin") is not None
        fr = h.get("flow_lmin") if ok else None

        def per(v):
            return round(v / loops, 2) if v is not None else None

        rooms.append({
            "room": rm, "manifold": c.get("manifold") or "", "area": c.get("area"),
            "loops": loops, "length": c.get("length"), "has_thermostat": bool(t),
            # --- supply (measured, last 24 h) ---
            "temp_now": t.get("temp_now"), "setpoint": t.get("setpoint"),
            "target": t.get("target"), "target_src": t.get("target_src"),
            "open_mode": bool(t.get("open_mode")), "temp_24h": t.get("temp_24h"),
            "dev": t.get("dev"), "rel": t.get("rel"), "need_k": t.get("need_k"),
            "demand_share": t.get("demand_share"),
            "category": t.get("category") or "none",
            "finding": t.get("finding") or ("Kein Thermostat in diesem Raum – nur Fläche und Kreise bekannt."),
            "recommendation": t.get("recommendation") or "",
            # --- physics model (derived) ---
            "tau_h": t.get("tau_h"), "cooldown_kph": t.get("cooldown_kph"),
            "heatup_kph": t.get("heatup_kph"), "n_tau": t.get("n_tau", 0),
            "n_warm": t.get("n_warm", 0), "n": t.get("n", 0),
            "confidence": t.get("confidence"), "model_ready": t.get("status") == "bereit",
            "missing": t.get("missing") or [],
            # --- heat load + target flow (estimated / calibrated) ---
            "q_design": h.get("q_design") if ok else None,
            "q_lo": h.get("q_lo") if ok else None, "q_hi": h.get("q_hi") if ok else None,
            "spec": h.get("spec") if ok else None, "ua": h.get("ua") if ok else None,
            "estimated": bool(h.get("estimated")), "plausible": h.get("plausible", True),
            "flow_room": fr, "flow_loop": per(fr),
            "flow_lo": per(h.get("flow_lo")) if ok else None,
            "flow_hi": per(h.get("flow_hi")) if ok else None,
            "flow_missing": (h.get("missing") or ["Fläche fehlt"]) if not ok else None,
            # --- the user's own flow-meter reading, per circuit ---
            "ist": taco.get(rm),
        })

    # what the heat pump really pushes through vs. what all circuits should get
    fcmp = _flow_compare(fl, rooms, hl.get("total_flow_lmin")) if fl else None
    for r in rooms:
        r["flow_reach"] = (round(r["flow_loop"] * fcmp["scale"], 2)
                           if fcmp and fcmp.get("scale") and r["flow_loop"] is not None else None)

    # manifold sums, in the user's manifold order; unassigned rooms last
    order = list(layout["manifolds"])
    for r in rooms:
        if r["manifold"] and r["manifold"] not in order:
            order.append(r["manifold"])
    manifolds = []
    for m in order + [""]:
        rs = [r for r in rooms if r["manifold"] == m]
        if not rs:
            continue
        manifolds.append({"name": m, "rooms": len(rs),
                          "loops": sum(r["loops"] for r in rs if r["flow_room"] is not None),
                          "flow": round(sum(r["flow_room"] or 0 for r in rs), 1)})

    # ---- phase + headline numbers ---------------------------------------- #
    live = [r for r in rooms if r["dev"] is not None]
    under = sorted([r for r in live if r["category"] == "under"], key=lambda r: -(r["need_k"] or 0))
    over = sorted([r for r in live if r["category"] == "reserve"], key=lambda r: (r["need_k"] or 0))
    even = [r for r in live if r["category"] == "balanced"]
    house = tm.get("house") or {}
    have_layout = bool(areas)
    n_th = len(tm["rooms"])
    if not n_th:
        phase = {"key": "nodata", "label": "Noch keine Raumdaten",
                 "text": "Sobald Raumthermostate gekoppelt sind, protokolliert die Bridge automatisch "
                         "Temperatur und Sollwert je Raum – daraus entsteht hier der Abgleich."}
    elif house.get("open"):
        if under or over:
            phase = {"key": "adjust", "label": "Einstell-Phase",
                     "text": f"{house.get('n_open')} von {n_th} Thermostaten sind hochgedreht – der "
                             "Verteiler bestimmt jetzt die Wärmeverteilung, und ich vergleiche die Räume "
                             "<b>untereinander</b> (Abweichung von ihrer Wunschtemperatur)."}
        else:
            phase = {"key": "finish", "label": "Ausgeglichen",
                     "text": "Alle Räume liegen im Gleichlauf – der Verteiler passt. Jetzt die Thermostate "
                             "zurückstellen und die Heizkurve senken."}
    else:
        phase = {"key": "normal", "label": "Regelbetrieb",
                 "text": "Die Thermostate regeln selbst. Ich prüfe je Raum, ob er seinen Sollwert hält "
                         "und wie viel der Zeit er Wärme anfordert – wer dauernd anfordert und trotzdem "
                         "darunter bleibt, bekommt zu wenig."}

    rels = [r["rel"] for r in live if r["rel"] is not None]
    spread = round(max(rels) - min(rels), 1) if len(rels) >= 2 else None
    eff = opt.get("efficiency")
    kpis = []
    if house.get("open") and spread is not None:
        kpis.append({"v": f"{_de(spread)} K", "l": "Spanne zwischen den Räumen",
                     "tone": "good" if spread < 1.5 else ("ok" if spread < 3.0 else "warn"),
                     "hint": "Ziel: unter 1,5 K"})
        if house.get("dev") is not None:
            hd = house["dev"]
            kpis.append({"v": f"{'+' if hd >= 0 else '−'}{_de(abs(hd))} K", "l": "Haus gegenüber Wunsch",
                         "tone": "ok" if abs(hd) >= 0.5 else "good",
                         "hint": "gleicht später die Heizkurve aus"})
    elif live:
        hold = sum(1 for r in live if r["category"] != "under")
        kpis.append({"v": f"{hold}/{len(live)}", "l": "Räume halten ihren Sollwert",
                     "tone": "good" if hold == len(live) else "warn"})
    if live:
        kpis.append({"v": f"{len(under)} · {len(over)}", "l": "zu kalt · zu warm",
                     "tone": "good" if not (under or over) else "warn"})
    if hl.get("total_flow_lmin"):
        kpis.append({"v": f"{_de(hl['total_flow_lmin'])}", "l": f"Σ Ziel l/min bei ΔT {_de(layout['dt'], 0)} K",
                     "tone": "na"})
    fsys = (fl or {}).get("system") or {}
    if fsys.get("l_min"):
        kpis.append({"v": ("≈ " if fsys["src"] == "abgeleitet" else "") + _de(fsys["l_min"]),
                     "l": "l/min durch die Wärmepumpe",
                     "tone": {"warn": "warn", "ok": "ok", "good": "good"}.get((fcmp or {}).get("tone"), "na"),
                     "hint": "gelesen" if fsys["src"] == "gelesen" else "abgeleitet: Wärme ÷ Spreizung"})
    if eff and eff.get("over_k") is not None:
        ok_ = eff["over_k"]
        kpis.append({"v": f"{'+' if ok_ >= 0 else '−'}{_de(abs(ok_))} K", "l": "Heizkurve über Ziel (30 Tage)",
                     "tone": "good" if ok_ < 2 else ("ok" if ok_ < 4 else "warn")})

    setup_hint = None
    if n_th and not have_layout:
        setup_hint = ("Für die <b>l/min-Werte</b> fehlen noch Flächen und Kreise je Raum – unten unter "
                      "„Verteiler einrichten“ eintragen. Der Raumvergleich funktioniert auch ohne.")
    elif have_layout and not any(r["ist"] is not None for r in rooms):
        setup_hint = ("Tipp: Trage in der Raumliste deine aktuellen <b>Tacosetter-Werte</b> (Ist) ein – "
                      "dann siehst du je Kreis die Abweichung zur Empfehlung.")

    stray = sorted(str(x) for x in _stray_room_names(store.room_log_counts(now - 45 * 86400)))

    return {
        "ok": True, "ts": now, "phase": phase, "next": opt["recommendation"],
        "setup_hint": setup_hint, "kpis": kpis,
        "summary": {"open": [r["room"] for r in under], "throttle": [r["room"] for r in over],
                    "even": [r["room"] for r in even]},
        "house": house, "rooms": rooms, "manifolds": manifolds,
        "totals": {"q_total": hl.get("q_total_design"), "flow_total": hl.get("total_flow_lmin"),
                   "method": hl.get("method"), "spec_wm2": layout["q"], "spread_k": layout["dt"],
                   "design_c": layout["design_c"], "central_spread": hl.get("central_spread"),
                   "signature": hl.get("signature"), "coverage": hl.get("coverage"),
                   "ua_total": hl.get("ua_total"), "balance_c": hl.get("balance_c")},
        "flow": fl, "flow_cmp": fcmp,
        "curve": eff, "steps": opt["steps"], "n_steps": opt["n_steps"], "opt_note": opt["note"],
        "data": obs, "automeasure": am, "stray_rooms": stray,
        "layout_demo": layout_demo,
        "insights": tm.get("insights") or [], "hl_insights": hl.get("insights") or [],
        "note": hl.get("note"),
    }


def _window_events(log_rows: list[dict], now: int) -> list[dict]:
    """Reconstruct open intervals from the window-log change rows."""
    events, cur = [], None
    for r in log_rows:
        oc = r.get("open_count") or 0
        if oc > 0:
            if cur is None:
                cur = {"start": r["ts"], "rooms": set(), "doors": set(), "end": None}
            for x in (r.get("rooms") or "").split(","):
                if x.strip():
                    cur["rooms"].add(x.strip())
            for x in (r.get("doors") or "").split(","):
                if x.strip():
                    cur["doors"].add(x.strip())
        elif cur is not None:
            cur["end"] = r["ts"]
            events.append(cur)
            cur = None
    if cur is not None:
        cur["end"] = now
        cur["ongoing"] = True
        events.append(cur)
    return events


def window_open_since(store: "Store", now: int | None = None, days: float = 3) -> dict:
    """Room → time it has been open since without a break, from the window
    change log (the poller writes a row whenever the set of open rooms changes).
    Only rooms that are open in the latest row."""
    now = int(now or time.time())
    since: dict = {}
    for r in store.window_log_since(int(now - days * 86400)):
        cur = ({x.strip() for x in (r.get("rooms") or "").split(",") if x.strip()}
               if (r.get("open_count") or 0) > 0 else set())
        for room in list(since):
            if room not in cur:
                del since[room]
        for room in cur:
            since.setdefault(room, int(r["ts"]))
    return since


def compute_window_awareness(store: "Store", days: int = 3, current: list | None = None) -> dict:
    """Window-open events over time + their effect on the indoor temperature –
    so you SEE whether ventilation drops the temperature (and heat is lost)."""
    now = int(time.time())
    since = now - days * 86400
    events_raw = _window_events(store.window_log_since(since), now)
    temp_series = store.room_temp_series(since)
    hp_rows = store.hp_samples_since(since)

    events, drops, total_open = [], [], 0
    heating_open = 0
    for e in events_raw:
        dur = max(0, e["end"] - e["start"])
        total_open += dur
        t0 = store.room_temp_at(e["start"]); t1 = store.room_temp_at(e["end"])
        delta = round(t1 - t0, 1) if (t0 is not None and t1 is not None) else None
        if delta is not None:
            drops.append(delta)
        heating = any((s.get("mode") or "").lower() in ("ch", "heating", "heat")
                      and e["start"] <= s.get("ts", 0) <= e["end"] for s in hp_rows)
        if heating:
            heating_open += 1
        events.append({"start": e["start"], "end": e["end"],
                       "dur_min": round(dur / 60), "rooms": sorted(e["rooms"]),
                       "temp_start": t0, "temp_end": t1, "delta": delta,
                       "heating": heating, "ongoing": e.get("ongoing", False)})

    n = len(events)
    insights = []
    if n == 0:
        insights.append("Im Zeitraum wurde <b>kein Fenster geöffnet</b> (oder es werden noch keine "
                        "Kontakte geloggt). Die App zeichnet Öffnungen ab jetzt auf.")
    else:
        hrs = total_open / 3600.0
        insights.append(f"<b>{n}× gelüftet</b> in {days} Tagen, zusammen <b>{hrs:.1f} h</b> offen "
                        f"(Ø {round(total_open / 60 / n)} min/Lüftung).")
        avg_drop = sum(drops) / len(drops) if drops else None
        if avg_drop is not None:
            if avg_drop <= -0.4:
                insights.append(f"Beim Lüften fällt die Innentemperatur im Schnitt um "
                                f"<b>{abs(avg_drop):.1f} K</b> – diese Wärme muss die WP nachheizen. "
                                f"<b>Kurz & kräftig stoßlüften</b> (5–10 min) statt Dauerkippen.")
            else:
                insights.append("Beim Lüften fällt die Innentemperatur <b>kaum</b> – kurzes "
                                "Stoßlüften, gut gemacht. 👍")
        long_ev = [e for e in events if e["dur_min"] >= 30]
        if long_ev:
            insights.append(f"<b>{len(long_ev)}× länger als 30 min</b> offen"
                            + (" – bei Kälte kostet das spürbar Wärme." if any(e["delta"] and e["delta"] <= -0.5 for e in long_ev) else "."))
        if heating_open:
            insights.append(f"<b>{heating_open}×</b> war dabei die <b>Wärmepumpe am Heizen</b> – "
                            f"Heizen gegen offenes Fenster ist reiner Verlust. Thermostat/WP beim "
                            f"Lüften kurz runter (oder Fenster-auf-Erkennung nutzen).")

    cur_open = [c for c in (current or []) if c.get("open")]
    return {"ok": True, "days_window": days, "n_events": n,
            "total_open_min": round(total_open / 60), "events": events[-40:],
            "temp_series": temp_series, "current_open": cur_open,
            "has_contacts": current is not None and len(current) > 0,
            "insights": insights}


def _demo_window_awareness(days: int = 3) -> dict:
    """Synthetic window events + indoor temp dips for the demo."""
    now = int(time.time())
    events, temp = [], []
    base = now - days * 86400
    # a cold-day morning airing (big drop) and a short evening one (small drop)
    for d in range(days):
        day0 = base + d * 86400
        morn = day0 + 8 * 3600
        events.append({"start": morn, "end": morn + 25 * 60, "dur_min": 25,
                       "rooms": ["Schlafzimmer"], "temp_start": 21.8, "temp_end": 20.9,
                       "delta": -0.9, "heating": d % 2 == 0, "ongoing": False})
        eve = day0 + 19 * 3600
        events.append({"start": eve, "end": eve + 8 * 60, "dur_min": 8,
                       "rooms": ["Küche"], "temp_start": 22.0, "temp_end": 21.9,
                       "delta": -0.1, "heating": False, "ongoing": False})
    for i in range(days * 24):
        t = base + i * 3600
        temp.append({"ts": t, "temp": round(21.8 + 0.6 * math.sin(i / 5), 1)})
    insights = [
        f"<b>{len(events)}× gelüftet</b> in {days} Tagen (Demo).",
        "Beim Lüften fällt die Innentemperatur im Schnitt um <b>0.5 K</b> – kurz & kräftig stoßlüften.",
        "<b>1×</b> war dabei die <b>Wärmepumpe am Heizen</b> – Heizen gegen offenes Fenster ist Verlust.",
    ]
    return {"ok": True, "demo": True, "days_window": days, "n_events": len(events),
            "total_open_min": sum(e["dur_min"] for e in events), "events": events,
            "temp_series": temp, "current_open": [{"name": "Küche", "room": "Küche", "open": True}],
            "has_contacts": True, "insights": insights}


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
                     hp_live: dict | None = None,
                     sh: dict | None = None, hp: dict | None = None) -> dict:
    """One combined snapshot for the dashboard: Smart Home + heat pump together,
    'heute bisher', current draw, cost and a 'wofür' breakdown. ``sh``/``hp``
    take already computed analytics (the caller usually has them cached) –
    this used to recompute both from scratch on every call."""
    now = int(time.time())
    today = _local_day(now)
    if sh is None:
        sh = compute_analytics(store, days, price)
    if hp is None:
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
    for dev_id in store.sample_device_ids():
        prev = None
        for s in store.samples_range(dev_id, mid, now + 1):     # (ts, power_w, energy_wh)
            if prev is not None:
                delta = (s[2] or 0.0) - (prev[2] or 0.0)
                dt_h = (s[0] - prev[0]) / 3600.0
                # same guard as _energy_for_bucket: reject offline-jump artefacts
                if _counter_delta_ok(delta, dt_h):
                    sh_hour[datetime.fromtimestamp(prev[0]).hour] += delta / 1000.0
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
    # energy counted across a data gap (bridge/cloud not reachable): known
    # amount, unknown operating mode – its own slice instead of a wrong one
    gap_ = round(mt.get("gap", 0.0), 3)
    # reconcile with the authoritative day total ('Strom heute'): energy the mode
    # split couldn't classify (mode unknown) is shown as "Sonstiges" so the WP
    # slices SUM to hp_today instead of undercounting.
    other_ = round(max(mt.get("other", 0.0), (hp_today or 0.0) - heat_ - water_ - gap_), 3)
    if heat_ > 0.01 or water_ > 0.01 or other_ > 0.01 or gap_ > 0.01:
        if heat_ > 0.01:
            breakdown.append({"key": "hp_heating", "label": "WP · Heizung",
                              "kwh": heat_, "color": "#ef6c4d"})
        if water_ > 0.01:
            breakdown.append({"key": "hp_water", "label": "WP · Warmwasser",
                              "kwh": water_, "color": "#f6b93b"})
        if other_ > 0.01:
            breakdown.append({"key": "hp_other", "label": "WP · Sonstiges",
                              "kwh": other_, "color": "#b07a4d"})
        if gap_ > 0.01:
            breakdown.append({"key": "hp_gap", "label": "WP · Betriebsart unbekannt (Datenlücke)",
                              "kwh": gap_, "color": "#8b93a1"})
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
        self._last_room = 0           # throttle for room-temp logging
        self._win_sig = None          # last window open-set (log only on change)

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
        bulk = self.client.read_power_bulk()     # all PowerMeter states in ONE request
        for dev in devices:
            try:
                reading = bulk.get(dev["id"])
                if reading is None and not bulk:  # bulk unavailable → single read (rare)
                    reading = self.client.read_power(dev["id"])
                self.store.upsert_device(dev, ts, reading.get("energy_start") if reading else None)
                if reading:
                    self.store.add_sample(dev["id"], ts, reading["power_w"], reading["energy_wh"])
            except Exception as exc:  # one bad device must not stop the others
                print(f"[poll] device {dev.get('id')}: {exc}", file=sys.stderr)
        # log the average indoor temperature from the thermostats (every ~10 min)
        if ts - self._last_room >= 600:
            self._last_room = ts
            try:
                self._log_room_temp(ts)
            except Exception as exc:
                print(f"[poll] room temp: {exc}", file=sys.stderr)
        # log window/door open-set every poll, but only when it changes
        try:
            self._log_windows(ts)
        except Exception as exc:
            print(f"[poll] windows: {exc}", file=sys.stderr)
        # Auto-Messung: orchestrated night setback (opt-in; writes thermostats)
        try:
            automeasure_tick(self.client, self.store, ts)
        except Exception as exc:
            print(f"[poll] automeasure: {exc}", file=sys.stderr)
        self.last_poll = ts

    def _log_windows(self, ts: int):
        """Record a row whenever the set of open windows changes."""
        contacts = self.client.list_window_contacts(self.cfg.get("contact_room_map"))
        open_rooms = sorted({(c.get("room") or c.get("name") or "?") for c in contacts if c.get("open")})
        open_doors = sorted({(c.get("room") or c.get("name") or "?")
                             for c in contacts if c.get("open") and c.get("door")})
        sig = tuple(open_rooms)
        if sig == self._win_sig:
            return                        # no change → nothing to log
        self._win_sig = sig
        self.store.window_log_add(ts, len(open_rooms), ", ".join(open_rooms),
                                  ", ".join(open_doors))

    def _log_room_temp(self, ts: int):
        """Measured temperature per room (+ setpoint, valve) → store. Also keeps
        the average for the heat time-series overlay."""
        climate = self.client.list_climate(self.cfg.get("contact_room_map"))
        temps, sets, per_room = [], [], []
        for r in _loggable_climate(climate):
            t = r.get("temp")
            sp = r.get("setpoint") if isinstance(r.get("setpoint"), (int, float)) else None
            vv = r.get("valve") if isinstance(r.get("valve"), (int, float)) else None
            temps.append(t)
            if sp is not None:
                sets.append(sp)
            per_room.append((ts, r.get("room") or "—", round(t, 1),
                             round(sp, 1) if sp is not None else None, vv))
        if per_room:
            self.store.room_log_add_bulk(per_room)
        if temps:
            self.store.room_temp_add(ts, round(sum(temps) / len(temps), 1),
                                     round(sum(sets) / len(sets), 1) if sets else None)

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
    {"id": "demo-router", "name": "WLAN-Router", "room": "Arbeitszimmer", "model": "PSM"},
    {"id": "demo-tv", "name": "TV Wohnzimmer", "room": "Wohnzimmer", "model": "PSM"},
]


def _demo_power(dev_id: str, dt: datetime, away: bool) -> float:
    """Plausible instantaneous power (W) for a light/shutter micromodule."""
    h = dt.hour + dt.minute / 60.0
    weekend = dt.weekday() >= 5
    # always-on devices: a router sips a near-constant few watts (pure standby);
    # a TV sits at ~1 W standby and jumps to ~90 W while watched in the evening.
    if "router" in dev_id:
        return round(6.8 + 0.6 * math.sin(dt.timestamp() / 211.0), 2)
    if "-tv" in dev_id:
        watching = (not away) and (18 <= h <= 23 or (weekend and 13 <= h <= 16))
        return round((95.0 if watching else 1.2) + 0.3 * math.sin(dt.timestamp() / 97.0), 2)
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
DEMO_DHW_START = 44.0      # demo: the tank is recharged when the sensor reads this …
DEMO_DHW_STOP = 53.0       # … up to this (matches temperatureLevels/high in _demo_controls)
DEMO_DHW_CAP_MIN = 120     # demo: a charge is cut after 2 h, the heating gets 30 min, then it resumes
DEMO_TANK_WH_K = 190 * 1.163   # demo 190-l tank: Wh per K
_DEMO_TANK: dict = {}      # day → (slots, end state); deterministic, built on demand


def _demo_outdoor(dt: datetime) -> float:
    """Demo outdoor temperature: season (coldest mid-Jan) + day/night swing."""
    doy = dt.timetuple().tm_yday
    h = dt.hour + dt.minute / 60.0
    seasonal = 9.0 - 12.0 * math.cos((doy - 20) / 365.0 * 2 * math.pi)
    return round(seasonal + 4.0 * math.cos((h - 15) / 24.0 * 2 * math.pi), 1)   # warmest ~15 h


def _demo_draws(day) -> list[tuple]:
    """Hot water drawn on a demo day: (hour, minutes, K at the tank sensor) –
    showers in the morning, the kitchen at noon, a bath some evenings."""
    doy = day.timetuple().tm_yday
    f = lambda k: 0.85 + 0.3 * ((math.sin(doy * 12.9898 + k * 78.233) * 43758.5453) % 1.0)
    if day.weekday() >= 5:
        plan = [(8.6, 9, 2.6 * f(1)), (9.1, 8, 2.3 * f(2)), (13.0, 3, 0.6 * f(3)), (19.4, 12, 3.4 * f(4))]
    else:
        plan = [(6.55, 8, 2.6 * f(1)), (6.95, 8, 2.2 * f(2)), (12.3, 3, 0.5 * f(3)),
                (18.1, 4, 0.7 * f(4)), (20.6, 9, 2.8 * f(5))]
    if doy % 4 == 0:
        plan.append((19.6, 14, 4.2 * f(6)))                       # a bath
    return plan


def _demo_tank_sim(day, st: dict) -> tuple[list, dict]:
    """One demo day of the hot-water tank in 1-min steps → 5-min slots of
    (tank °C, charging?, K/h). Charges by hysteresis (start/stop), slower the
    hotter the tank and the colder the air, cut after DEMO_DHW_CAP_MIN."""
    t0 = datetime.combine(day, datetime.min.time())
    m0 = int(t0.timestamp())
    m1 = int((t0 + timedelta(days=1)).timestamp())
    plan = [(h * 60.0, h * 60.0 + mins, k / mins) for h, mins, k in _demo_draws(day)]
    T, on, run, brk, lag = st["T"], st["on"], st["run"], st["brk"], st["lag"]
    slots = []
    rate = 0.0
    for i in range((m1 - m0) // 60):
        if i % 5 == 0:
            slots.append((round(T, 2), on, round(rate, 2)))
        if brk > 0:
            brk -= 1
            if brk == 0 and T < DEMO_DHW_STOP:
                on, run, lag = True, 0, 6
        elif not on and T <= DEMO_DHW_START:
            on, run, lag = True, 0, 6
        elif on and T >= DEMO_DHW_STOP:
            on = False
        elif on and run >= DEMO_DHW_CAP_MIN:
            on, brk = False, 30
        mm = i % 1440
        T -= sum(k for a, b, k in plan if a <= mm < b)
        T -= 0.40 * (T - 20.0) / 30.0 / 60.0                       # standby loss ~0.4 K/h
        rate = 0.0
        if on:
            run += 1
            if lag > 0:
                lag -= 1
            else:
                out = _demo_outdoor(datetime.fromtimestamp(m0 + i * 60))
                rate = max(1.0, 0.62 * (61.5 - T) * (0.78 + 0.018 * out))
                T += rate / 60.0
    return slots, {"T": T, "on": on, "run": run, "brk": brk, "lag": lag}


def _demo_tank_at(ts: float) -> tuple[float, bool, float]:
    """(tank °C, charging?, K/h) of the demo tank at ts. Each day continues
    from the previous one; without it, the tank is warmed up from 3 days
    earlier (it forgets where it started within a day)."""
    dt = datetime.fromtimestamp(ts)
    day = dt.date()
    hit = _DEMO_TANK.get(day)
    if hit is None:
        d = day
        while (d - timedelta(days=1)) not in _DEMO_TANK and (day - d).days < 3:
            d -= timedelta(days=1)
        prev = _DEMO_TANK.get(d - timedelta(days=1))
        st = dict(prev[1]) if prev else {"T": 50.0, "on": False, "run": 0, "brk": 0, "lag": 0}
        while d <= day:
            _DEMO_TANK[d] = _demo_tank_sim(d, st)
            st = dict(_DEMO_TANK[d][1])
            d += timedelta(days=1)
        hit = _DEMO_TANK[day]
    slots = hit[0]
    k = int((ts - datetime.combine(day, datetime.min.time()).timestamp()) // 300)
    return slots[max(0, min(len(slots) - 1, k))]


def _demo_hp(dt: datetime) -> dict:
    """Plausible heat-pump operating point for the demo (Compress-style).

    Returns instantaneous electrical/thermal power (W), outdoor temp, modulation
    and mode. Space heating scales with cold; hot water runs whenever the demo
    tank (_demo_tank_at) has cooled to its start temperature.
    """
    h = dt.hour + dt.minute / 60.0
    outdoor = _demo_outdoor(dt)

    # hot water: when the demo tank (hysteresis, showers, standby loss) asks for it
    tank_t, dhw, dhw_kh = _demo_tank_at(dt.timestamp())
    defrost = heater = False
    if dhw:
        mode = "dhw"
        # warmer air and a cooler tank = better COP; the heat matches the tank's rise
        cop = max(1.6, min(3.6, (2.3 + 0.06 * outdoor) * (1.0 - 0.012 * (tank_t - 44.0))))
        comp_elec = max(250.0, dhw_kh * DEMO_TANK_WH_K / cop) if dhw_kh > 0 else 250.0
    elif outdoor < 16.0:                                # space heating
        mode = "ch"
        minute_of_day = dt.hour * 60 + dt.minute
        if outdoor >= 9.0 and (minute_of_day % 30) >= 22:
            # mild → low heat demand: the compressor can't modulate low enough,
            # so it short-cycles (runs, then pauses) instead of running through
            comp_elec, mode, cop = 14.0, "off", 0.0
        else:
            comp_elec = 300.0 + (16.0 - outdoor) * 95.0
            # a modern inverter unit in a real house: ~70–75 % of its datasheet
            cop = max(1.8, min(5.2, 2.7 + 0.12 * outdoor))
            # periodic defrost when cold & damp (≤ ~7 °C): ~10 min at the top of
            # the hour, compressor reverses so the heat output collapses
            if outdoor < 7.0 and minute_of_day % 60 < 10:
                cop, defrost = 0.25, True
            # electric backup heater assists on the cold early-morning ramp
            if outdoor < 5.0 and 5.0 <= h < 7.0:
                heater = True
    else:
        comp_elec, mode, cop = 14.0, "off", 0.0        # standby only
    comp_elec *= 1.0 + 0.05 * math.sin(dt.timestamp() / 211.0)
    modulation = round(max(0.0, min(100.0, comp_elec / 2600.0 * 100.0)), 0) if mode != "off" else 0
    elec = comp_elec
    heat = comp_elec * cop
    if heater:                                          # +2.5 kW heater (COP ≈ 1)
        elec += 2500.0
        heat += 2450.0
    supply = round(28.0 + (heat / 6000.0) * 12.0, 1) if mode != "off" else round(24.0, 1)
    ret_dhw = None
    if mode == "dhw":
        # like the real CS6800i: the supply sensor sits in the heating circuit and
        # only sees the heating pipe cooling down while the tank charges
        supply = round(29.0 + 0.5 * math.sin(dt.timestamp() / 900.0), 1)
        ret_dhw = round(tank_t + 3.0, 1)                # … and the return carries the water from the tank coil
    if defrost:
        supply = round(supply - 6.0, 1)                 # flow dips during defrost
    return {"elec_w": round(max(0.0, elec), 1), "heat_w": round(max(0.0, heat), 1),
            "outdoor_c": outdoor, "modulation": modulation, "mode": mode,
            "supply_c": supply,
            "return_c": ret_dhw if ret_dhw is not None else round(supply - (heat / 6000.0) * 5.0, 1),
            "heater_w": 2500.0 if heater else 0.0}


def _demo_controls() -> list[dict]:
    """Synthetic heat-pump controls for the demo – mirrors a real CS6800i tree
    (weather-compensated: no Niveau/Steilheit knob; the curve follows the room
    setpoint + max flow temp). Some writeable, some read-only, with ranges."""
    def c(path, value, writeable=True, allowed=None, lo=None, hi=None, unit=None):
        return {"path": path, "value": value, "type": "value", "writeable": writeable,
                "allowed": allowed, "min": lo, "max": hi, "unit": unit}
    H = "/resource/heatingCircuits/hc1"
    W = "/resource/dhwCircuits/dhw1"
    return [
        c(f"{H}/controlType", "wdcoptimized", True, ["wdcoptimized", "wdcsimplified", "ISRC", "vbh"]),
        c(f"{H}/maxFlowTemp", 50, True, None, 30, 50, "C"),
        c(f"{H}/temperatureLevels/comfort2", 25, True, None, 23.5, 30, "C"),
        c(f"{H}/temperatureLevels/eco", 23, True, None, 5, 23, "C"),
        c(f"{H}/temperatureRoomManual", 23.5, True, None, 5, 30, "C"),
        c(f"{H}/currentRoomSetpoint", 23.5, False, None, None, None, "C"),
        c(f"{H}/heatingType", "floor", False, ["radiator", "floor", "airHeating"]),
        c(f"{H}/operationMode", "manual", True, ["off", "manual", "auto"]),
        c(f"{H}/boostMode", "off", True, ["on", "off"]),
        c(f"{H}/boostDuration", 1, True, None, 1, 8, "hours"),
        c(f"{H}/overallStatus", "heating_manual_on", False,
          ["boost", "away", "holiday", "heating_manual_on", "heating_auto"]),
        c(f"{H}/name", "AFoAZQBpAHQ=", True),      # binary → should be hidden
        c(f"{W}/operationMode", "eco", True, ["Off", "low", "high", "ownprogram", "eco"]),
        c(f"{W}/temperatureLevels/high", 53, True, None, 40, 55, "C"),
        c(f"{W}/temperatureLevels/eco", 44, True, None, 30, 46, "C"),
        c(f"{W}/temperatureLevels/low", 51, True, None, 35, 51, "C"),
        c(f"{W}/singleChargeSetpoint", 60, True, None, 50, 70, "C"),
        c(f"{W}/charge", "stop", True, ["start", "stop"]),
        c(f"{W}/chargeDuration", 60, True, None, 60, 2880, "mins"),
        c(f"{W}/actualTemp", 45.3, False, None, None, None, "C"),
        c(f"{W}/currentSetpoint", 53, False, None, None, None, "C"),
    ]


# human labels for the common heat-pump control resources
_CONTROL_LABELS = [
    ("operationmode", "Betriebsart"),
    ("heatingcurvelevel", "Heizkurve · Niveau (Parallelverschiebung)"),
    ("heatingcurve", "Heizkurve"),
    ("heatcurve", "Heizkurve"),
    ("roomtemperature", "Raum-Solltemperatur"),
    ("roommanual", "Raum-Soll (manuell)"),
    ("manualroomsetpoint", "Raum-Soll (manuell)"),
    ("suwithreshold", "Sommer/Winter-Schwelle"),
    ("supplytemperature", "Vorlauftemperatur"),
    ("temperaturelevels/high", "Warmwasser-Solltemperatur"),
    ("singlechargesetpoint", "Warmwasser Einmalladung"),
    ("temperatureroommanual", "Raum-Soll (manuell)"),
]


def _control_label(path: str) -> str:
    p = (path or "").lower()
    area = "Warmwasser" if "dhwcircuits" in p else ("Heizung" if "heatingcircuits" in p else "")
    for key, lbl in _CONTROL_LABELS:
        if key in p:
            return (lbl if "·" in lbl or not area else f"{area}: {lbl}")
    # fall back to the last path segment
    seg = path.rstrip("/").rsplit("/", 1)[-1]
    return f"{area}: {seg}" if area else seg


def _classify_room_inputs(controls: list[dict]) -> dict:
    """From the heat-pump control tree, pick the room-related resources and say
    whether the device exposes a WRITEABLE *measured* room-temperature input (the
    thing you'd push the thermostat reading into). On a Bosch/Buderus CS6800i this
    is normally absent – only the room SETPOINT is writeable; the actual room
    temperature comes from the heat pump's own room station, not an API write."""
    room, actual, setpoints = [], [], []
    for c in controls or []:
        p = (c.get("path") or "").lower()
        if "heatingcircuits" not in p:
            continue
        seg = p.rstrip("/").rsplit("/", 1)[-1]
        is_setpoint = any(k in p for k in ("manual", "setpoint", "comfort", "eco", "levels"))
        if "roomtemperature" in seg and not is_setpoint:
            kind = "actual_room_temp"          # the measured value (push target)
        elif any(k in p for k in ("roommanual", "temperatureroommanual", "manualroomsetpoint",
                                   "roomsetpoint", "currentroomsetpoint")):
            kind = "room_setpoint"
        elif "humidity" in p:
            kind = "humidity"
        else:
            continue
        entry = {"path": c.get("path"), "label": _control_label(c.get("path") or ""),
                 "value": c.get("value"), "writeable": bool(c.get("writeable")),
                 "unit": c.get("unit"), "kind": kind}
        room.append(entry)
        if kind == "actual_room_temp":
            actual.append(entry)
        elif kind == "room_setpoint":
            setpoints.append(entry)
    supports_actual = any(e["writeable"] for e in actual)
    return {"room_inputs": room, "supports_actual": supports_actual,
            "writeable_setpoints": [e for e in setpoints if e["writeable"]]}


def _demo_climate() -> list[dict]:
    """Synthetic per-room thermostat snapshot for the heating diagnostics demo –
    deliberately seeded with a few typical misconfigurations so the check has
    something to flag (throttled valves, setpoint spread, a cold room, an offset)."""
    def rec(room, setpoint, temp, valve, **kw):
        d = {"room": room, "setpoint": setpoint, "temp": temp, "valve": valve,
             "valves": [valve], "operationMode": "AUTOMATIC", "roomControlMode": "HEATING",
             "boost": False, "summerMode": False, "low": False, "offset": None,
             "childLock": False, "faults": [], "devices": 1,
             "humidity": round(42 + (hash(room) % 20), 1),
             "windows": [], "windows_open": 0, "air": None, "air_purity": None,
             "heating": temp < setpoint - 0.1, "heating_src": "gemeldet"}
        d.update(kw)
        d["windows_open"] = sum(1 for w in d.get("windows") or [] if w.get("open"))
        return d
    return [
        # Wohnzimmer: Haustür-Kontakt (Türkontakt, mittelbar) + Twinguard-Luftqualität
        rec("Wohnzimmer", 22.0, 21.7, 95, air="MEDIUM", air_purity=1150,
            windows=[{"name": "Haustür", "open": False, "door": True},
                     {"name": "Fenster Süd", "open": False, "door": False}]),
        rec("Küche", 21.0, 21.2, 85, humidity=58.0,
            windows=[{"name": "Küchenfenster", "open": False, "door": False}]),
        # Bad: Fenster offen -> schnelles „Auskühlen" ist in Wahrheit Lüften
        rec("Bad", 24.0, 23.1, 100, offset=0.0, humidity=71.0, air="BAD", air_purity=1850,
            windows=[{"name": "Badfenster", "open": True, "door": False}]),
        rec("Schlafzimmer", 18.0, 19.0, 25, air="GOOD", air_purity=780,
            windows=[{"name": "Schlafzimmerfenster", "open": False, "door": False}]),
        rec("Arbeitszimmer", 20.0, 18.2, 100),              # cold despite open valve
        rec("Gäste-WC", 19.0, 20.5, 20, offset=2.0),        # throttled + offset
        rec("Flur", 19.0, 19.5, 40),                        # throttled
    ]


# demo rooms: (name, base °C, setpoint, responsiveness to the house swing)
DEMO_ROOMS = [("Wohnzimmer", 21.8, 22.0, 1.0), ("Schlafzimmer", 19.2, 19.0, 0.6),
              ("Bad", 23.0, 24.0, 1.2), ("Küche", 21.2, 21.0, 1.0),
              ("Arbeitszimmer", 20.0, 21.0, 0.8)]
DEMO_DHW_SET = DEMO_DHW_STOP       # demo hot-water setpoint (matches _demo_controls)


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
    # + a correlated house-average indoor temperature: it drifts DOWN whenever
    # DHW priority pauses space heating, and recovers toward the setpoint once
    # heating resumes – so the "Warmwasser kostet Komfort" analysis has data.
    # finer than the device grid so short defrost cycles (~10 min) are captured
    hp_step = timedelta(minutes=5)
    hp_rows, rt_rows, rl_rows, dhw_rows = [], [], [], []
    # a few demo rooms at different levels/responsiveness, so the per-room
    # temperature overlay in the day-timeline has distinct, chronologically
    # varying curves: (name, base °C, setpoint, responsiveness to the house swing)
    demo_rooms = DEMO_ROOMS
    e_kwh = h_kwh = eh_kwh = 0.0
    indoor = 21.5
    t = start
    while t <= now:
        op = _demo_hp(t)
        dt_h = hp_step.total_seconds() / 3600.0
        e_kwh += op["elec_w"] / 1000.0 * dt_h
        h_kwh += op["heat_w"] / 1000.0 * dt_h
        eh_kwh += op["heater_w"] / 1000.0 * dt_h
        hp_rows.append((DEMO_HP_GW, int(t.timestamp()), round(e_kwh, 4), op["elec_w"],
                        round(op["heat_w"] / 1000.0, 3), op["modulation"], op["outdoor_c"],
                        round(h_kwh, 4), op["heat_w"], op["mode"], op["supply_c"], op["return_c"],
                        round(eh_kwh, 4)))
        hr = t.hour + t.minute / 60.0
        setp = 20.5 if (hr < 6 or hr >= 22) else 21.5      # mild night setback
        if is_away(t):
            setp = 18.0
        if op["mode"] == "dhw":                            # heating paused → cool
            indoor += (op["outdoor_c"] - indoor) * (dt_h / 30.0)
        else:                                              # heating on → recover
            indoor += (setp - indoor) * (dt_h / 0.8)
        indoor += 0.04 * math.sin(t.timestamp() / 611.0)   # small sensor wiggle
        ts = int(t.timestamp())
        rt_rows.append((ts, round(indoor, 1), setp))
        dhw_rows.append((ts, round(_demo_tank_at(ts)[0], 1), DEMO_DHW_SET))
        swing = indoor - 21.5                              # the house's live deviation
        for k, (nm, rbase, rsp, resp) in enumerate(demo_rooms):
            rt = rbase + swing * resp + 0.05 * math.sin(t.timestamp() / (480.0 + 37 * k))
            if is_away(t):
                rt -= 2.0
            valve = 90.0 if rt < rsp - 0.2 else 20.0
            rl_rows.append((ts, nm, round(rt, 1), rsp, valve))
        t += hp_step
    store.add_hp_samples_bulk(hp_rows)
    store.room_temp_add_bulk(rt_rows)
    store.room_log_add_bulk(rl_rows)
    store.dhw_log_add_bulk(dhw_rows)
    print(f"[demo] inserted {len(hp_rows)} heat-pump samples + {len(rt_rows)} indoor-temp"
          f" + {len(rl_rows)} per-room rows.")

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

    # two demo whole-house meter readings (~34 kWh/day total incl. heat pump) –
    # chosen above the measured plugs+WP sum so the "ungemessener Rest" bucket and
    # the meter-anchored load analysis have something to show in demo mode.
    store.meter_upsert(int((now - timedelta(days=8)).timestamp()), 2202.0, "")
    store.meter_upsert(int(now.timestamp()), 2202.0 + 8 * 34.0, "")


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
        eh_kwh = hp_latest.get("eheater_kwh") or 0.0
        last_room = 0
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
            eh_kwh += op["heater_w"] / 1000.0 * dt_h
            self.store.add_hp_sample({
                "gateway": DEMO_HP_GW, "ts": ts, "energy_kwh": round(e_kwh, 4),
                "power_w": op["elec_w"], "heat_kwh": round(h_kwh, 4), "heat_w": op["heat_w"],
                "thermal_kw": op["heat_w"] / 1000.0, "modulation": op["modulation"],
                "outdoor_c": op["outdoor_c"], "mode": op["mode"],
                "supply_c": op["supply_c"], "return_c": op["return_c"],
                "eheater_kwh": round(eh_kwh, 4)})
            # per-room thermostat log + hot-water tank, every 5 min – otherwise the
            # seeded history ends at start-up and the room analyses go stale
            if ts - last_room >= 300:
                last_room = ts
                dip = -0.3 if op["mode"] == "dhw" else 0.0
                rl = []
                for k, (nm, rbase, rsp, resp) in enumerate(DEMO_ROOMS):
                    rt = rbase + dip * resp + 0.05 * math.sin(ts / (480.0 + 37 * k))
                    rl.append((ts, nm, round(rt, 1), rsp, 90.0 if rt < rsp - 0.2 else 20.0))
                self.store.room_log_add_bulk(rl)
                self.store.dhw_log_add(ts, round(_demo_tank_at(ts)[0], 1), DEMO_DHW_SET)
            if self.hp_state is not None:
                cop = round(op["heat_w"] / op["elec_w"], 2) if op["elec_w"] > 0 else None
                self.hp_state.clear()
                self.hp_state.update({
                    "gateway": DEMO_HP_GW, "ts": ts, "power_w": op["elec_w"],
                    "heat_w": op["heat_w"], "cop_live": cop,
                    "cop_lifetime": round(h_kwh / e_kwh, 2) if e_kwh > 0 else None,
                    "energy_kwh": round(e_kwh, 1), "heat_kwh": round(h_kwh, 1),
                    "compressor_kwh": round(e_kwh - eh_kwh, 1), "eheater_kwh": round(eh_kwh, 1),
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
        self._disc_lock = threading.Lock()
        self.discovering = False
        self.fails = 0          # failed polls in a row
        self.ok_streak = 0      # successful polls in a row

    def run(self):
        while not self._stop.is_set():
            try:
                self._poll()
                self.last_error = None
                self.state["last_error"] = None
                self.fails = 0
                self.ok_streak += 1
            except Exception as exc:
                self.last_error = str(exc)
                self.fails += 1
                self.ok_streak = 0
                self.state.update({"last_error": str(exc), "last_error_ts": int(time.time()),
                                   "fails": self.fails})
                print(f"[heatpump] error: {exc}", file=sys.stderr)
            # look for a volume-flow value once the cloud answers reliably (two
            # good polls in a row), then weekly; after a failed search next day.
            # It is ~100 spaced-out requests, so never on every poll.
            if self.ok_streak >= 2 and not self._stop.is_set():
                d = _flow_disc_load(self.store)
                age = time.time() - ((d or {}).get("ts") or 0)
                if not d or age >= (86400 if d.get("error") else FLOW_REDISCOVER_S):
                    self.discover_flow()
            # after a failure try again sooner: 1, 2, 4 min, then the normal interval
            wait = self.interval if not self.fails else min(self.interval, 60 * 2 ** (self.fails - 1))
            self._stop.wait(wait)

    def discover_flow(self) -> dict | None:
        """Search the device's resources for a volume flow; result kept in kv."""
        if not hasattr(self.client, "discover_flow"):
            return None
        if not self._disc_lock.acquire(blocking=False):
            return None                      # already running
        self.discovering = True
        try:
            try:
                d = self.client.discover_flow(self.gateway)
            except Exception as exc:
                d = {"ts": int(time.time()), "error": str(exc), "found": [], "primary": None}
            self.store.kv_set(FLOW_DISC_KEY, json.dumps(d))
            print(f"[heatpump] flow discovery: {d.get('checked')} resources checked, "
                  f"found {[f.get('path') for f in d.get('found') or []]}", file=sys.stderr)
            return d
        finally:
            self.discovering = False
            self._disc_lock.release()

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
        # volume flow, if the device exposes one (found by discover_flow)
        flow = None
        disc = _flow_disc_load(self.store)
        if disc and disc.get("primary") and hasattr(self.client, "read_flow"):
            try:
                f = self.client.read_flow(self.gateway, disc["primary"])
                flow = f.get("l_min") if f else None
            except Exception:
                flow = None
        data["flow_lmin"] = flow
        self.store.add_hp_sample({
            "gateway": self.gateway, "ts": ts, "energy_kwh": elec, "power_w": power_w,
            "heat_kwh": heat, "heat_w": heat_w,
            "thermal_kw": (heat_w / 1000.0) if heat_w is not None else None,
            "modulation": data.get("modulation"), "outdoor_c": data.get("outdoor_c"),
            "mode": data.get("mode"),
            "supply_c": data.get("supply_c"), "return_c": data.get("return_c"),
            "flow_lmin": flow, "eheater_kwh": data.get("eheater_kwh"), "starts": data.get("starts"),
        })
        # hot-water tank temperature + setpoint, so a DHW phase can be judged on
        # what the tank really did (None when the device does not expose it)
        try:
            self.store.dhw_log_add(ts, data.get("dhw_c"), data.get("dhw_set_c"))
        except Exception as exc:
            print(f"[heatpump] dhw log: {exc}", file=sys.stderr)
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
# PV system (Fronius inverter): poller, demo installation, evaluation
# --------------------------------------------------------------------------- #
PV_STORE_EVERY = 60            # s – one stored row = mean of the live readings
PV_STR_MIN_W = 50              # W – a string below this is not producing (night, dawn)
PV_DETAILS_EVERY = 60          # s – inverter strings, meter counters, battery
PV_IDENT_EVERY = 6 * 3600      # s – model / installed power (rarely changes)
PV_FEEDIN_DEFAULT_CT = 8.0     # same default as the PV planner's input


class FroniusPoller(threading.Thread):
    """Reads the inverter's power flow every few seconds (live view) and keeps
    one averaged row per minute; once a minute also the inverter strings, the
    smart-meter counters and the battery. Read-only – nothing is ever written
    to the inverter."""

    def __init__(self, client, store: "Store", state: dict, interval: int = 15, demo: bool = False):
        super().__init__(daemon=True)
        self.client, self.store, self.state = client, store, state
        self.interval = max(5, int(interval or 15))
        self.demo = demo
        self._stop = threading.Event()
        self._acc: dict = {}
        self._n = 0
        self._last_store = time.time()
        self._last_details = 0.0
        self._last_ident = 0.0
        self.fails = 0

    def _accumulate(self, flow: dict):
        self._n += 1
        for k in ("pv_w", "grid_w", "load_w", "batt_w"):
            v = flow.get(k)
            if v is not None:
                a = self._acc.setdefault(k, [0.0, 0])
                a[0] += v
                a[1] += 1
        ps = [i["p_w"] for i in (flow.get("inverters") or []) if i.get("p_w") is not None]
        if ps:
            a = self._acc.setdefault("inv_w", [0.0, 0])
            a[0] += sum(ps)
            a[1] += 1
        for k in ("soc", "e_total_wh"):              # last value wins
            if flow.get(k) is not None:
                self._acc[k] = [flow[k], 1]
        for k, mk in (("load_w", "load_max_w"), ("grid_w", "grid_max_w")):   # highest reading of the minute
            v = flow.get(k)
            if v is not None and (mk not in self._acc or v > self._acc[mk][0]):
                self._acc[mk] = [v, 1]

    def _store_row(self, now: float):
        if not self._n:
            return
        row = {"ts": int(now), "n": self._n}
        for k in ("pv_w", "grid_w", "load_w", "batt_w", "inv_w"):
            a = self._acc.get(k)
            row[k] = round(a[0] / a[1], 1) if a and a[1] else None
        for k in ("soc", "e_total_wh"):
            a = self._acc.get(k)
            row[k] = a[0] if a else None
        for k in ("load_max_w", "grid_max_w"):
            a = self._acc.get(k)
            row[k] = round(a[0], 1) if a else None
        det = self.state.get("details") or {}
        if det and now - (det.get("ts") or 0) <= 2 * PV_DETAILS_EVERY:
            gm = next((m for m in det.get("meters") or [] if m.get("location") == "grid"), None)
            if gm:
                row["imp_wh"], row["exp_wh"] = gm.get("import_wh"), gm.get("export_wh")
            invs = det.get("inverters") or {}
            inv = invs.get("1") or next((v for _k, v in sorted(invs.items()) if (v or {}).get("strings")), None) or {}
            # by tracker number – an empty slot (GEN24: null) must not shift
            # MPP 2 into the place of MPP 1
            st = {s_.get("n"): s_ for s_ in inv.get("strings") or [] if isinstance(s_, dict)}
            for n in (1, 2):
                row[f"mpp{n}_w"] = (st.get(n) or {}).get("p_w")
                row[f"mpp{n}_v"] = (st.get(n) or {}).get("u_v")
        self.store.pv_add(row)
        self._acc, self._n = {}, 0
        self._last_store = now
        self.state["last_store"] = int(now)

    def run(self):
        while not self._stop.is_set():
            t0 = time.time()
            try:
                flow = self.client.power_flow()
                self._accumulate(flow)
                self.state.update({"ok": True, "error": None, "live": flow, "last_poll": int(t0)})
                self.fails = 0
            except Exception as exc:
                self.fails += 1
                self.state.update({"ok": False, "error": str(exc), "last_error_ts": int(t0)})
                if self.fails in (1, 10) or self.fails % 100 == 0:
                    print(f"[fronius] {exc}", file=sys.stderr)
            now = time.time()
            if not self.fails and now - self._last_details >= PV_DETAILS_EVERY:
                try:
                    self.state["details"] = self.client.details()
                    self.state["details_error"] = None
                except Exception as exc:
                    self.state["details_error"] = str(exc)
                self._last_details = now
            if not self.fails and now - self._last_ident >= PV_IDENT_EVERY:
                try:
                    ident = self.client.identify()
                    ident.pop("flow", None)
                    self.state["identity"] = ident
                except Exception as exc:
                    self.state["identity_error"] = str(exc)
                self._last_ident = now
            if now - self._last_store >= PV_STORE_EVERY:
                try:
                    self._store_row(now)
                except Exception as exc:
                    print(f"[fronius] store: {exc}", file=sys.stderr)
            wait = self.interval if not self.fails else min(120, self.interval * 2 ** min(3, self.fails))
            self._stop.wait(max(1.0, wait - (time.time() - t0)))

    def stop(self):
        self._stop.set()


# --- demo installation: 9.9 kWp south roof, 9.45 kWh battery, smart meter ----- #
DEMO_PV_KWP = 9.9
DEMO_BATT_WH = 9450.0
DEMO_STR_MODULES = (14, 8)     # 22 × 450 W modules on two MPP trackers, same roof


def _demo_strings(pv_w: float) -> list:
    """(power W, voltage V) per MPP tracker of the demo array: the power in
    proportion to the modules, the MPP voltage ~32–34 V per module (a bit
    lower when bright and hot), a small residual voltage at night."""
    tot = float(sum(DEMO_STR_MODULES))
    g = min(1.2, max(0.0, pv_w) / (DEMO_PV_KWP * 1000.0))      # relative irradiance
    out = []
    for nm in DEMO_STR_MODULES:
        u = nm * (34.0 * (1.0 + 0.02 * math.log(max(0.05, g))) - 2.2 * g) if pv_w > 20 else nm * 4.6
        out.append((round(max(0.0, pv_w) * nm / tot, 1), round(u, 1)))
    return out


def _demo_cloud(ts: float, lt) -> float:
    """Deterministic 'weather' per day: overcast / mixed / sunny, more grey in winter."""
    key = lt.tm_year * 1000 + lt.tm_yday
    r = (math.sin(key * 12.9898) * 43758.5453) % 1.0
    winter, shoulder = lt.tm_mon in (11, 12, 1, 2), lt.tm_mon in (3, 10)
    p_over = 0.5 if winter else (0.3 if shoulder else 0.2)
    p_sun = 0.2 if winter else (0.3 if shoulder else 0.4)
    if r < p_over:
        return 0.12 + 0.08 * ((r * 17.0) % 1.0)
    if r > 1.0 - p_sun:
        return 0.92 + 0.04 * math.sin(ts / 900.0)
    return 0.25 + 0.6 * (0.5 + 0.5 * math.sin(ts / 1300.0 + r * 20.0)) * (0.55 + 0.45 * math.sin(ts / 410.0 + r * 7.0))


def _demo_pv_w(ts: float) -> float:
    """DC power of the demo array: clear-sky sun position model (51° N, 10° E,
    35° south roof) × the day's weather."""
    lat, tilt = math.radians(51.0), math.radians(35.0)
    lt = time.localtime(ts)
    decl = math.radians(23.44) * math.sin(2 * math.pi * (284 + lt.tm_yday) / 365.0)
    solar_h = (ts % 86400) / 3600.0 + 10.0 / 15.0
    ha = math.radians(15.0 * (solar_h - 12.0))
    sin_el = math.sin(lat) * math.sin(decl) + math.cos(lat) * math.cos(decl) * math.cos(ha)
    if sin_el <= 0.02:
        return 0.0
    am = min(38.0, 1.0 / sin_el)
    dni = 1353.0 * 0.7 ** (am ** 0.678)
    cos_inc = math.sin(decl) * math.sin(lat - tilt) + math.cos(decl) * math.cos(lat - tilt) * math.cos(ha)
    poa = dni * max(0.0, cos_inc) + 110.0 * sin_el
    return round(DEMO_PV_KWP * poa * 0.86 * _demo_cloud(ts, lt), 1)


def _demo_house_w(dt: datetime) -> float:
    """Whole-house demand of the demo home: Bosch devices + heat pump + the
    rest of the house (cooking, washing, standby …) that no plug measures."""
    devs = sum(_demo_power(d["id"], dt, False) for d in DEMO_DEVICES)
    h = dt.hour + dt.minute / 60.0
    rest = (210.0 + 420.0 * math.exp(-((h - 12.4) ** 2) / 0.9) + 780.0 * math.exp(-((h - 18.6) ** 2) / 1.6)
            + 160.0 * math.exp(-((h - 7.1) ** 2) / 0.5))
    return round(devs + _demo_hp(dt)["elec_w"] + rest, 1)


def _demo_pv_step(st: dict, ts: float, dt_s: float) -> dict:
    """Advance the demo system by dt_s seconds to ts: the battery takes PV
    surplus and covers the deficit (5 kW max, 7 % reserve), the grid the rest."""
    pv, load = _demo_pv_w(ts), _demo_house_w(datetime.fromtimestamp(ts))
    eff, cap, h = 0.97, DEMO_BATT_WH, max(0.0, dt_s) / 3600.0
    need = load / eff
    soc = st["soc"]
    if pv >= need:
        room = (100.0 - soc) / 100.0 * cap / 0.96 / h if h > 0 else 0.0
        batt = -min(pv - need, 5000.0, max(0.0, room))
    else:
        avail = (soc - 7.0) / 100.0 * cap * 0.96 / h if h > 0 else 0.0
        batt = min(need - pv, 5000.0, max(0.0, avail))
    inv_ac = (pv + batt) * eff
    grid = load - inv_ac
    if h > 0:
        soc += ((-batt) * 0.96 if batt < 0 else -batt / 0.96) * h / cap * 100.0
        st["soc"] = max(5.0, min(100.0, soc))
        st["imp"] += max(0.0, grid) * h
        st["exp"] += max(0.0, -grid) * h
        st["etot"] += max(0.0, inv_ac) * h
    st["t"] = ts
    return {"pv_w": pv, "load_w": load, "batt_w": round(batt, 1), "grid_w": round(grid, 1),
            "inv_w": round(inv_ac, 1), "soc": round(st["soc"], 1)}


def seed_demo_pv(store: "Store", days: int = 90):
    """Demo history for the PV views (5-min rows), once."""
    if store.pv_span()[2] > 0:
        return
    now = int(time.time())
    t = now - days * 86400
    t -= t % 300
    st = {"soc": 35.0, "imp": 0.0, "exp": 0.0, "etot": 0.0, "t": t}
    rows = []
    while t <= now:
        v = _demo_pv_step(st, t, 300)
        (p1, u1), (p2, u2) = _demo_strings(v["pv_w"])
        rows.append((t, 1, v["pv_w"], v["grid_w"], v["load_w"], v["batt_w"], v["soc"], v["inv_w"],
                     round(st["etot"], 1), round(st["imp"], 1), round(st["exp"], 1), p1, p2, u1, u2))
        t += 300
    store.pv_add_bulk(rows)
    print(f"[demo] inserted {len(rows)} PV rows (Fronius demo installation).")


class DemoFronius:
    """Stands in for FroniusClient in demo mode – same method names and
    result shapes, values from the demo model, continuing the seeded history."""
    host = "demo"

    def __init__(self, store: "Store"):
        last = store.pv_last() or {}
        self.st = {"soc": last.get("soc") or 40.0, "imp": last.get("imp_wh") or 0.0,
                   "exp": last.get("exp_wh") or 0.0, "etot": last.get("e_total_wh") or 0.0,
                   "t": last.get("ts") or time.time()}
        self.v = None
        self._lock = threading.Lock()

    def _advance(self) -> dict:
        with self._lock:
            now = time.time()
            t = self.st["t"]
            if now - t > 600:                       # bridge was off: catch up in 5-min steps
                while now - t > 300:
                    t += 300
                    _demo_pv_step(self.st, t, 300)
            self.v = _demo_pv_step(self.st, now, now - self.st["t"])
            return self.v

    def power_flow(self) -> dict:
        v = self._advance()
        load, grid = v["load_w"], v["grid_w"]
        return {"pv_w": v["pv_w"], "grid_w": grid, "load_w": load, "batt_w": v["batt_w"], "soc": v["soc"],
                "has_meter": True, "has_battery": True, "meter_location": "grid",
                "mode": "bidirectional", "mode_de": "mit Batterie", "battery_mode": "normal",
                "battery_mode_de": "normal", "backup_mode": False, "battery_standby": False,
                "e_day_wh": None, "e_year_wh": None, "e_total_wh": round(self.st["etot"], 1),
                "autonomy_pct": round(100.0 * max(0.0, 1.0 - max(0.0, grid) / load), 1) if load > 0 else None,
                "self_consumption_pct": None,
                "inverters": [{"id": "1", "dt": 1, "p_w": v["inv_w"], "soc": v["soc"], "battery_mode": "normal",
                               "e_day_wh": None, "e_total_wh": round(self.st["etot"], 1)}],
                "ohmpilots": [], "version": "demo", "ts": int(time.time())}

    def inverter_info(self) -> list:
        return [{"id": "1", "dt": 1, "type": "Fronius GEN24", "name": "Symo GEN24 10.0 Plus (Demo)",
                 "pv_power_w": DEMO_PV_KWP * 1000, "status_code": 7, "state": "Running",
                 "state_de": "in Betrieb", "error_code": 0, "unique_id": "demo"}]

    def details(self) -> dict:
        v = self.v or self._advance()
        pv, grid = v["pv_w"], v["grid_w"]
        (s1, u1), (s2, u2) = _demo_strings(pv)
        ph = [{"n": i + 1, "p_w": round(grid * f, 1), "u_v": u, "i_a": round(abs(grid * f) / 230.0, 2)}
              for i, (f, u) in enumerate(((0.34, 230.4), (0.38, 231.2), (0.28, 229.8)))]
        return {"inverters": {"1": {"pac_w": v["inv_w"], "sac_va": round(v["inv_w"] + 35, 1),
                                    "iac_a": round(v["inv_w"] / 690.0, 2), "uac_v": 230.8, "fac_hz": 50.0,
                                    "day_wh": None, "year_wh": None, "total_wh": round(self.st["etot"], 1),
                                    "status_code": 7, "state": "Running", "state_de": "in Betrieb",
                                    "error_code": 0,
                                    "strings": [{"n": 1, "u_v": u1, "i_a": round(s1 / u1, 2), "p_w": s1},
                                                {"n": 2, "u_v": u2, "i_a": round(s2 / u2, 2), "p_w": s2}]}},
                "meters": [{"id": "0", "location": "grid", "location_code": 0, "location_de": "Einspeisepunkt (Netz)",
                            "manufacturer": "Fronius", "model": "Smart Meter TS 65A-3 (Demo)", "serial": "demo",
                            "p_w": grid, "import_wh": round(self.st["imp"], 1), "export_wh": round(self.st["exp"], 1),
                            "freq_hz": 50.0, "phases": ph, "enabled": 1}],
                "storage": {"id": "0", "soc": v["soc"], "capacity_wh": DEMO_BATT_WH, "max_capacity_wh": DEMO_BATT_WH,
                            "temp_c": 19.5, "u_v": 405.0, "i_a": round(-v["batt_w"] / 405.0, 2),
                            "manufacturer": "Fronius", "model": "Reserva 9.5 (Demo)", "serial": "demo",
                            "enabled": 1, "status": 3, "modules": 3},
                "ohmpilots": [], "errors": {}, "ts": int(time.time())}

    def identify(self) -> dict:
        info = self.inverter_info()
        return {"host": "demo", "api": {"api": 1, "base": "/solar_api/v1/", "compat": "demo"},
                "inverters": info, "devices": {}, "name": info[0]["name"], "type": info[0]["type"],
                "pv_power_w": info[0]["pv_power_w"], "has_meter": True, "has_battery": True,
                "meter_location": "grid", "mode": "bidirectional", "mode_de": "mit Batterie",
                "ts": int(time.time())}

    def probe(self) -> dict:
        return {"host": "demo", "ts": int(time.time()), "endpoints": [],
                "note": "Demo-Modus – es gibt keinen echten Wechselrichter, also keine Rohdaten."}


# --- evaluation ------------------------------------------------------------- #
_PV_I = {c: i for i, c in enumerate(Store.PV_COLS)}
_PV_XI = {c: len(Store.PV_COLS) + i for i, c in enumerate(Store.PV_BUCKET_EXTRA)}


def _pv_day_acc(day: str) -> dict:
    return {"day": day, "pv": 0.0, "load": 0.0, "imp_i": 0.0, "exp_i": 0.0, "ch": 0.0, "dis": 0.0, "gch": 0.0,
            "mpp1": 0.0, "mpp2": 0.0, "cov": 0.0, "gap": 0.0, "has_load": False, "has_batt": False,
            "imp_c": 0.0, "exp_c": 0.0, "cnt_rows": 0, "rows": 0, "cnt_bad": False,
            "soc_min": None, "soc_max": None, "peak": 0.0, "hp": 0.0, "hp_sun": 0.0, "hp_cov": 0.0,
            # strings: PV vs Σ strings on the same rows, voltage × power while
            # producing, peaks, energy × time of day (→ when a string produces)
            "pv_s": 0.0, "mpp_s": 0.0, "vw1": 0.0, "wv1": 0.0, "vw2": 0.0, "wv2": 0.0,
            "pk1": 0.0, "pk2": 0.0, "tc1": 0.0, "tc2": 0.0,
            # the inverter's own energy counter vs its integrated AC output
            "et": 0.0, "et_n": 0, "et_bad": False, "ac_et": 0.0, "pv_et": 0.0,
            "soc0": None, "soc1": None, "hc": [0.0] * 24, "pv_cov": 0.0}


def _pv_cnt_ok(a: dict) -> bool:
    """The smart meter's counters are used for the day: no data gap, they came
    with (nearly) every row and never jumped (meter swapped, inverter reset …)."""
    return a["gap"] < 1800 and not a["cnt_bad"] and a["rows"] > 0 and a["cnt_rows"] >= 0.9 * a["rows"]


def _pv_day_result(a: dict, price: float, feedin: float) -> dict:
    """Energies of one day (kWh) + rates and money. Import/export come from the
    smart meter's counters when the day has no data gap (exact), otherwise from
    the integrated readings (consistent with the PV/consumption sums)."""
    imp, exp, src = a["imp_i"], a["exp_i"], "gemessen"
    if _pv_cnt_ok(a):                    # the meter's counters are exact
        imp, exp, src = a["imp_c"], a["exp_c"], "Zähler"
    k = lambda wh: round(wh / 1000.0, 3)
    out = {"day": a["day"], "pv_kwh": k(a["pv"]), "peak_pv_w": round(a["peak"]),
           "cov_h": round(a["cov"] / 3600.0, 2), "gap_h": round(a["gap"] / 3600.0, 2),
           "soc_min": a["soc_min"], "soc_max": a["soc_max"],
           "ch_kwh": k(a["ch"]) if a["has_batt"] else None, "dis_kwh": k(a["dis"]) if a["has_batt"] else None,
           # battery charged from the grid (AC, incl. conversion losses) vs from the sun
           "ch_grid_kwh": k(a["gch"]) if a["has_batt"] else None,
           "ch_pv_kwh": k(max(0.0, a["ch"] - a["gch"])) if a["has_batt"] else None,
           "mpp1_kwh": k(a["mpp1"]), "mpp2_kwh": k(a["mpp2"]),
           # power-weighted mean MPP voltage while the string produces
           "mpp1_u": round(a["vw1"] / a["wv1"], 1) if a["wv1"] > 20 else None,
           "mpp2_u": round(a["vw2"] / a["wv2"], 1) if a["wv2"] > 20 else None,
           # share of a typical day's PV hours with data (1 = complete day)
           "pv_cov": round(a["pv_cov"], 3)}
    if a["has_load"]:
        load = a["load"]
        self_wh = max(0.0, a["pv"] - exp)
        avoided = max(0.0, load - imp)
        out.update({"load_kwh": k(load), "imp_kwh": k(imp), "exp_kwh": k(exp), "grid_src": src,
                    "self_kwh": k(self_wh),
                    "direct_kwh": k(max(0.0, a["pv"] - exp - max(0.0, a["ch"] - a["gch"]))),
                    "self_rate": round(self_wh / a["pv"], 3) if a["pv"] > 50 else None,
                    "autarky": round(avoided / load, 3) if load > 50 else None,
                    # money: own consumption covered by sun/battery (not bought) + feed-in paid
                    "self_eur": round(avoided / 1000.0 * price, 2), "feed_eur": round(exp / 1000.0 * feedin, 2),
                    "saved_eur": round(avoided / 1000.0 * price + exp / 1000.0 * feedin, 2)})
    else:
        out.update({"load_kwh": None, "imp_kwh": None, "exp_kwh": None, "grid_src": None, "self_kwh": None,
                    "direct_kwh": None, "self_rate": None, "autarky": None, "saved_eur": None,
                    "self_eur": None, "feed_eur": None})
    out["hp_kwh"] = k(a["hp"]) if a["hp_cov"] > 0 else None
    out["hp_sun_kwh"] = k(a["hp_sun"]) if a["hp_cov"] > 0 else None
    out["hp_sun_share"] = round(a["hp_sun"] / a["hp"], 3) if a["hp"] > 50 else None
    return out


def compute_pv(store: "Store", days: int = 30, price: float = 0.35, feedin: float = 0.08,
               now: int | None = None) -> dict:
    """Everything the PV views show, from the stored minute rows:
    per day / month energies (PV, consumption, import, export, battery),
    self-consumption and autarky, money saved, the heat pump's solar share,
    today's 15-min curve, the typical day (hourly means) and the MPP strings."""
    now = int(now or time.time())
    days = max(1, min(400, int(days)))
    today0, _t1, today = _day_of(now)
    start = int((datetime.fromtimestamp(today0) - timedelta(days=days - 1)).timestamp())
    first_ts, last_ts, n_rows = store.pv_span()
    base = {"ok": True, "ts": now, "days": days, "price": price, "feedin": feedin,
            "since": first_ts or None, "last": last_ts or None, "rows": n_rows}
    # the stored step (1 min live, 5 min in the demo history)
    probe = store.pv_rows(max(start, first_ts), max(start, first_ts) + 6 * 3600)
    diffs = sorted(b[0] - a[0] for a, b in zip(probe, probe[1:]) if b[0] > a[0])
    step = diffs[len(diffs) // 2] if diffs else PV_STORE_EVERY
    # long ranges: let SQLite average 15-min buckets (≈ 15× fewer rows here)
    bucketed = days > 31 and step < 600
    rows = store.pv_rows_bucketed(start, now + 1, 900) if bucketed else store.pv_rows(start, now + 1)
    if not rows:
        return {**base, "empty": True}
    I = _PV_I
    XI = _PV_XI
    i_m1, i_m2 = I["mpp1_w"], I["mpp2_w"]
    # per string: accumulator keys + row indices (minute rows / SQLite buckets)
    SK1 = ("mpp1", "tc1", "pk1", "vw1", "wv1", I["mpp1_v"], XI["mpp1_max"], XI["vw1"], XI["wv1"])
    SK2 = ("mpp2", "tc2", "pk2", "vw2", "wv2", I["mpp2_v"], XI["mpp2_max"], XI["vw2"], XI["wv2"])
    prev = store.pv_before(start)
    cap = max(90.0, 2.5 * (900 if bucketed else step))
    D: dict = {}
    hours = [[0.0, 0.0, 0.0, 0.0, 0.0] for _ in range(24)]       # pv, load, imp, exp (Wh) + seconds
    ser: dict = {}                                               # today: 15-min buckets
    T, LC, MC, CV = [], [0.0], [0.0], [0.0]                      # for the heat-pump matching
    last = prev
    imp_seen = prev[I["imp_wh"]] if prev else None
    exp_seen = prev[I["exp_wh"]] if prev else None
    et_seen = prev[I["e_total_wh"]] if prev else None
    soc_first = soc_last = None
    has_load = has_batt = has_mpp2 = False
    for r in rows:
        ts = r[0]
        # the very first row has no predecessor: it stands for one stored step –
        # or, bucketed, for all the rows SQLite averaged into it
        dt = ts - last[0] if last else (r[1] * step if bucketed else step)
        if dt <= 0:
            continue
        if bucketed:                               # n rows of `step` seconds each
            eff = min(dt, r[1] * step)
        else:
            eff = dt if dt <= cap else min(step, PV_STORE_EVERY)
        d0, _d1, day = _day_of(ts)
        a = D.get(day)
        if a is None:
            a = D[day] = _pv_day_acc(day)
        a["rows"] += 1
        h = eff / 3600.0
        pv, load, grid, batt, soc = r[I["pv_w"]], r[I["load_w"]], r[I["grid_w"]], r[I["batt_w"]], r[I["soc"]]
        pv = max(0.0, pv or 0.0)
        a["pv"] += pv * h
        a["cov"] += eff
        hour = min(23, max(0, int((ts - d0 - 1) // 3600)))
        a["hc"][hour] += eff
        is_gap = dt > cap or (bucketed and dt - eff > 120)
        if is_gap:
            a["gap"] += dt - eff
        pk = (r[XI["pv_max"]] or 0.0) if bucketed else pv
        if pk > a["peak"]:
            a["peak"] = pk
        imp_w = exp_w = 0.0
        if load is not None:
            has_load = a["has_load"] = True
            a["load"] += load * h
        if grid is not None:
            if bucketed:
                imp_w, exp_w = r[XI["imp_w"]] or 0.0, r[XI["exp_w"]] or 0.0
            else:
                imp_w, exp_w = max(0.0, grid), max(0.0, -grid)
            a["imp_i"] += imp_w * h
            a["exp_i"] += exp_w * h
        if batt is not None:
            has_batt = a["has_batt"] = True
            if bucketed:
                a["ch"] += (r[XI["ch_w"]] or 0.0) * h
                a["dis"] += (r[XI["dis_w"]] or 0.0) * h
                a["gch"] += (r[XI["gch_w"]] or 0.0) * h
            else:
                ch_w = max(0.0, -batt)
                a["ch"] += ch_w * h
                a["dis"] += max(0.0, batt) * h
                # import beyond the house's own consumption can only go into the
                # battery (plus conversion losses): it is being charged from the
                # grid – e.g. a GEN24 'charge boost' at a very low charge level
                if ch_w > 0 and grid is not None and load is not None and grid > load:
                    a["gch"] += min(grid - load, ch_w * 1.25) * h
        if soc is not None:
            a["soc_min"] = soc if a["soc_min"] is None else min(a["soc_min"], soc)
            a["soc_max"] = soc if a["soc_max"] is None else max(a["soc_max"], soc)
            if a["soc0"] is None:
                a["soc0"] = soc
            a["soc1"] = soc
            if soc_first is None:
                soc_first = soc
            soc_last = soc
        m1, m2 = r[i_m1], r[i_m2]
        if m1 is not None or m2 is not None:
            # Σ strings vs PV on exactly these rows (strings come once a minute)
            a["pv_s"] += pv * h
            a["mpp_s"] += (max(0.0, m1 or 0.0) + max(0.0, m2 or 0.0)) * h
            tod = (ts - eff / 2.0 - d0) / 3600.0            # hour of the day (middle of the step)
            for m_, sk in ((m1, SK1), (m2, SK2)):
                if m_ is None:
                    continue
                k_e, k_tc, k_pk, k_vw, k_wv, i_u, x_max, x_vw, x_wv = sk
                m_ = max(0.0, m_)
                e_ = m_ * h
                a[k_e] += e_
                a[k_tc] += e_ * tod
                pk = (r[x_max] or 0.0) if bucketed else m_
                if pk > a[k_pk]:
                    a[k_pk] = pk
                if bucketed:
                    a[k_vw] += (r[x_vw] or 0.0) * h
                    a[k_wv] += (r[x_wv] or 0.0) * h
                else:
                    u_ = r[i_u]
                    if u_ is not None and m_ > PV_STR_MIN_W:
                        a[k_vw] += u_ * e_
                        a[k_wv] += e_
            if m2 is not None and m2 > 0:
                has_mpp2 = True
        # the inverter's energy counter (E_Total) vs its integrated AC output –
        # only over steps without a gap, so both cover the same time
        et, inv = r[I["e_total_wh"]], r[I["inv_w"]]
        if et is not None:
            if et_seen is not None and not is_gap and inv is not None:
                de = et - et_seen
                if 0.0 <= de <= max(dt, 60.0) * 30000.0 / 3600.0:    # 30 kW: more is a jump
                    a["et"] += de
                    a["et_n"] += 1
                    a["ac_et"] += ((r[XI["inv_pos_w"]] or 0.0) if bucketed else max(0.0, inv)) * h
                    a["pv_et"] += pv * h
                else:
                    a["et_bad"] = True
            et_seen = et
        ci, ce = r[I["imp_wh"]], r[I["exp_wh"]]
        if ci is not None and ce is not None:
            if imp_seen is not None and exp_seen is not None:
                lim = max(dt, 60.0) * 60000.0 / 3600.0          # 60 kW: more is a jump
                di, de = ci - imp_seen, ce - exp_seen
                if 0.0 <= di <= lim and 0.0 <= de <= lim:
                    a["imp_c"] += di
                    a["exp_c"] += de
                    a["cnt_rows"] += 1
                else:
                    a["cnt_bad"] = True
            elif grid is not None:
                # the very first counter reading has no predecessor: its step
                # (up to 15 min when bucketed) comes from the power readings
                a["imp_c"] += imp_w * h
                a["exp_c"] += exp_w * h
                a["cnt_rows"] += 1
            imp_seen, exp_seen = ci, ce
        hb = hours[hour]
        hb[0] += pv * h
        hb[1] += (load or 0.0) * h
        hb[2] += imp_w * h
        hb[3] += exp_w * h
        hb[4] += eff
        if ts > today0:
            b = int((ts - today0 - 1) // 900)
            s_ = ser.setdefault(b, [0.0, 0.0, 0.0, 0.0, 0.0, None, 0, 0.0, 0.0, 0.0, 0.0])
            s_[0] += pv * eff
            s_[1] += (load or 0.0) * eff
            s_[2] += (grid or 0.0) * eff
            s_[3] += (batt or 0.0) * eff
            s_[4] += eff
            if soc is not None:
                s_[5] = soc
            s_[6] += 1
            if m1 is not None:
                s_[7] += max(0.0, m1) * eff
                s_[8] += eff
            if m2 is not None:
                s_[9] += max(0.0, m2) * eff
                s_[10] += eff
        T.append(ts)
        LC.append(LC[-1] + (load or 0.0) * h)
        MC.append(MC[-1] + imp_w * h)
        CV.append(CV[-1] + (eff if load is not None else 0.0))
        last = r

    # --- the heat pump's solar share: its energy per interval × the share of
    # the house consumption that was NOT drawn from the grid in that interval
    hp_ok = False
    if has_load:
        try:
            hrows = store.hp_samples_since(start)
        except Exception:
            hrows = []
        hp_prev = None
        for hr in hrows:
            if hp_prev is None:
                hp_prev = hr
                continue
            a_ts, b_ts = hp_prev["ts"], hr["ts"]
            span = b_ts - a_ts
            e_wh = None
            ea, eb = hp_prev.get("energy_kwh"), hr.get("energy_kwh")
            if ea is not None and eb is not None and 0 <= eb - ea and span <= 1800:
                e_wh = (eb - ea) * 1000.0
            elif hr.get("power_w") is not None and span <= 1800:
                e_wh = hr["power_w"] * span / 3600.0
            hp_prev = hr
            if e_wh is None or span <= 0:
                continue
            i0, i1 = bisect.bisect_right(T, a_ts), bisect.bisect_right(T, b_ts)
            cov = CV[i1] - CV[i0]
            ld = LC[i1] - LC[i0]
            if cov < 0.6 * span or ld <= 0:
                continue                           # no PV data for this interval
            share = min(1.0, max(0.0, 1.0 - (MC[i1] - MC[i0]) / ld))
            day = _day_of(b_ts)[2]
            a = D.get(day)
            if a is None:
                continue
            a["hp"] += e_wh
            a["hp_sun"] += e_wh * share
            a["hp_cov"] += span
            hp_ok = True

    # how complete each day is, weighted by when the sun produces: the mean
    # PV power per hour of the day over the range is the typical profile – a
    # day that starts at 22:00 has 2 h of data but ~0 % of the day's sun hours
    prof = [hb[0] / hb[4] if hb[4] > 0 else 0.0 for hb in hours]
    psum = sum(prof)
    for a in D.values():
        a["pv_cov"] = (sum(min(1.0, a["hc"][hh] / 3600.0) * prof[hh] for hh in range(24)) / psum
                       if psum > 0 else min(1.0, a["cov"] / 86400.0))

    daily = [_pv_day_result(D[d], price, feedin) for d in sorted(D)]

    def total(items):
        t = {"pv_kwh": 0.0, "load_kwh": 0.0, "imp_kwh": 0.0, "exp_kwh": 0.0, "self_kwh": 0.0,
             "direct_kwh": 0.0, "ch_kwh": 0.0, "dis_kwh": 0.0, "ch_grid_kwh": 0.0, "ch_pv_kwh": 0.0,
             "saved_eur": 0.0, "self_eur": 0.0, "feed_eur": 0.0, "hp_kwh": 0.0,
             "hp_sun_kwh": 0.0, "mpp1_kwh": 0.0, "mpp2_kwh": 0.0, "gap_h": 0.0, "days": len(items)}
        for x in items:
            for kk in t:
                if kk != "days" and x.get(kk) is not None:
                    t[kk] += x[kk]
        for kk in list(t):
            if kk != "days":
                t[kk] = round(t[kk], 2)
        t["pv_days"] = round(sum(x.get("pv_cov") or 0.0 for x in items), 2)    # complete PV days
        t["self_rate"] = round(t["self_kwh"] / t["pv_kwh"], 3) if (has_load and t["pv_kwh"] > 0.05) else None
        t["autarky"] = (round(max(0.0, t["load_kwh"] - t["imp_kwh"]) / t["load_kwh"], 3)
                        if (has_load and t["load_kwh"] > 0.05) else None)
        t["hp_sun_share"] = round(t["hp_sun_kwh"] / t["hp_kwh"], 3) if t["hp_kwh"] > 0.05 else None
        if not has_load:
            for kk in ("load_kwh", "imp_kwh", "exp_kwh", "self_kwh", "direct_kwh", "saved_eur", "self_eur", "feed_eur"):
                t[kk] = None
        if not has_batt:
            t["ch_kwh"] = t["dis_kwh"] = t["ch_grid_kwh"] = t["ch_pv_kwh"] = None
        return t

    monthly = []
    for mon in sorted({d["day"][:7] for d in daily}):
        items = [d for d in daily if d["day"].startswith(mon)]
        monthly.append({"month": mon, **total(items)})
    tot = total(daily)
    td = next((d for d in daily if d["day"] == today), None)
    hourly = []
    for hh, (pvw, ldw, imw, exw, secs) in enumerate(hours):
        f = 3600.0 / secs if secs > 0 else 0.0     # Wh per covered hour → mean W
        hourly.append({"h": hh, "pv_w": round(pvw * f), "load_w": round(ldw * f) if has_load else None,
                       "imp_w": round(imw * f) if has_load else None, "exp_w": round(exw * f) if has_load else None})
    series = []
    for b in sorted(ser):
        s_ = ser[b]
        if s_[4] <= 0:
            continue
        series.append({"t": today0 + b * 900, "pv_w": round(s_[0] / s_[4]),
                       "load_w": round(s_[1] / s_[4]) if has_load else None,
                       "grid_w": round(s_[2] / s_[4]) if has_load else None,
                       "batt_w": round(s_[3] / s_[4]) if has_batt else None, "soc": s_[5],
                       "mpp1_w": round(s_[7] / s_[8]) if s_[8] > 0 else None,
                       "mpp2_w": round(s_[9] / s_[10]) if (s_[10] > 0 and has_mpp2) else None})
    acc = [D[d] for d in sorted(D)]

    def S(key):
        return sum(x[key] for x in acc)
    strings = None
    if has_mpp2 or tot["mpp1_kwh"]:
        e1, e2 = S("mpp1"), S("mpp2")
        strings = {"mpp1_kwh": tot["mpp1_kwh"], "mpp2_kwh": tot["mpp2_kwh"] if has_mpp2 else None,
                   "today_mpp1_kwh": td["mpp1_kwh"] if td else None,
                   "today_mpp2_kwh": td["mpp2_kwh"] if (td and has_mpp2) else None,
                   "ratio": round(tot["mpp2_kwh"] / tot["mpp1_kwh"], 3) if (has_mpp2 and tot["mpp1_kwh"] > 0.5) else None,
                   # power-weighted MPP voltage, peak, and the energy-weighted
                   # hour of the day (when the string produces: east early, west late)
                   "mpp1_u": round(S("vw1") / S("wv1"), 1) if S("wv1") > 20 else None,
                   "mpp2_u": round(S("vw2") / S("wv2"), 1) if (has_mpp2 and S("wv2") > 20) else None,
                   "mpp1_peak_w": round(max(x["pk1"] for x in acc)),
                   "mpp2_peak_w": round(max(x["pk2"] for x in acc)) if has_mpp2 else None,
                   "mpp1_tc": round(S("tc1") / e1, 2) if e1 > 50 else None,
                   "mpp2_tc": round(S("tc2") / e2, 2) if (has_mpp2 and e2 > 50) else None}
    # --- plausibility: do the stored numbers agree with each other? ----------
    span = max(1, (last_ts or now) - max(start, first_ts or start))
    pv_s = S("pv_s")
    cnt_days = [x for x in acc if _pv_cnt_ok(x)]
    checks = {
        "coverage": {"covered_h": round(S("cov") / 3600.0, 1), "span_h": round(span / 3600.0, 1),
                     "gap_h": round(S("gap") / 3600.0, 1), "gap_days": [x["day"] for x in acc if x["gap"] > 1800]},
        "strings": ({"pv_kwh": round(pv_s / 1000.0, 2), "sum_kwh": round(S("mpp_s") / 1000.0, 2),
                     "dev": round(S("mpp_s") / pv_s - 1.0, 4)} if pv_s > 200 else None),
        "balance": ({"pv_kwh": tot["pv_kwh"], "dis_kwh": tot["dis_kwh"] or 0.0, "imp_kwh": tot["imp_kwh"],
                     "load_kwh": tot["load_kwh"], "ch_kwh": tot["ch_kwh"] or 0.0, "exp_kwh": tot["exp_kwh"]}
                    if has_load else None),
        "meter": ({"days": len(cnt_days),
                   "imp_cnt_kwh": round(sum(x["imp_c"] for x in cnt_days) / 1000.0, 2),
                   "imp_int_kwh": round(sum(x["imp_i"] for x in cnt_days) / 1000.0, 2),
                   "exp_cnt_kwh": round(sum(x["exp_c"] for x in cnt_days) / 1000.0, 2),
                   "exp_int_kwh": round(sum(x["exp_i"] for x in cnt_days) / 1000.0, 2)}
                  if (has_load and cnt_days) else None),
        "meter_jumps": [x["day"] for x in acc if x["cnt_bad"]],
        "battery": ({"ch_kwh": tot["ch_kwh"], "dis_kwh": tot["dis_kwh"], "soc_first": soc_first,
                     "soc_last": soc_last} if has_batt and soc_first is not None else None),
        "etotal": ({"et_kwh": round(S("et") / 1000.0, 2), "ac_kwh": round(S("ac_et") / 1000.0, 2),
                    "pv_kwh": round(S("pv_et") / 1000.0, 2), "jumps": [x["day"] for x in acc if x["et_bad"]]}
                   if sum(x["et_n"] for x in acc) >= 10 else None),
        "peak": (lambda x: {"pv_w": round(x["peak"]), "day": x["day"]})(max(acc, key=lambda x: x["peak"])),
    }
    return {**base, "empty": False, "step_s": step, "bucketed": bucketed,
            "has_meter": has_load, "has_battery": has_batt,
            "has_hp": hp_ok, "today": td, "daily": daily, "monthly": monthly, "totals": tot,
            "hourly": hourly, "series": series, "strings": strings, "checks": checks}


def compute_pv_money(store: "Store", price: float, feedin: float, now: int | None = None) -> dict | None:
    """What the PV system brought in money: today, this calendar month and since
    the first stored reading (up to 400 days) – own consumption not bought from
    the grid × electricity price, plus feed-in × feed-in tariff."""
    now = int(now or time.time())
    first, _last, n = store.pv_span()
    if not n:
        return None
    days = max(1, min(400, int((now - first) / 86400) + 2))
    r = compute_pv(store, days, price, feedin, now=now)
    if r.get("empty") or not r.get("has_meter"):
        return None
    today = _day_of(now)[2]
    month = today[:7]
    keys = ("self_eur", "feed_eur", "saved_eur", "pv_kwh", "self_kwh", "exp_kwh", "load_kwh", "imp_kwh")

    def agg(items):
        out = {k: round(sum((x.get(k) or 0.0) for x in items), 2) for k in keys}
        out["days"] = len(items)
        out["autarky"] = (round(max(0.0, out["load_kwh"] - out["imp_kwh"]) / out["load_kwh"], 3)
                          if out["load_kwh"] > 0.05 else None)
        return out
    daily = r.get("daily") or []
    d0 = datetime.fromtimestamp(now)
    yday = (d0 - timedelta(days=1)).strftime("%Y-%m-%d")
    week = {(d0 - timedelta(days=k)).strftime("%Y-%m-%d") for k in range(7)}
    yd = [d for d in daily if d["day"] == yday]
    # records only from (nearly) complete days – not the afternoon of connecting
    full = [d for d in daily if d["day"] != today and (d.get("pv_cov") or 0.0) >= 0.9]
    best = max(full, key=lambda d: d.get("pv_kwh") or 0.0) if full else None
    besta = max((d for d in full if d.get("autarky") is not None), key=lambda d: d["autarky"], default=None)
    return {"today": agg([d for d in daily if d["day"] == today]),
            "yesterday": agg(yd) if yd else None,
            "week": agg([d for d in daily if d["day"] in week]),
            "month": agg([d for d in daily if d["day"].startswith(month)]),
            "total": agg(daily), "since": first, "price": price, "feedin": feedin,
            "best_pv": {"day": best["day"], "pv_kwh": best["pv_kwh"]} if best and best.get("pv_kwh") else None,
            "best_autarky": {"day": besta["day"], "autarky": besta["autarky"]} if besta else None,
            "capped": days >= 400}


# --------------------------------------------------------------------------- #
# Calendar (dashboard): public iCloud / Google / .ics feeds, read-only
# --------------------------------------------------------------------------- #
CAL_MAX_AGE = 900               # s – a feed is fetched again after 15 min


def calendar_load(ctx, url: str, max_age: float = CAL_MAX_AGE, force: bool = False) -> dict:
    """Parsed calendar for url, from the cache unless older than max_age. On a
    failed refresh the last good copy is kept and the error reported."""
    now = time.time()
    with ctx._cal_lock:
        ent = ctx.cal_cache.get(url)
        if ent and not force and now - ent["ts"] < max_age:
            return ent
    try:
        cal = calendar_ics.parse(calendar_ics.fetch(url))
        ent = {"ts": now, "cal": cal, "error": None, "ok_ts": now}
    except Exception as exc:                      # CalendarError or anything unexpected
        old = ctx.cal_cache.get(url) or {}
        ent = {"ts": now, "cal": old.get("cal"), "error": str(exc), "ok_ts": old.get("ok_ts")}
    with ctx._cal_lock:
        ctx.cal_cache[url] = ent
    return ent


def _cal_event_out(e: dict, cal_name: str, color: str | None) -> dict:
    out = {"start": int(time.mktime(e["start"].timetuple())), "end": int(time.mktime(e["end"].timetuple())),
           "all_day": e["all_day"], "title": e["title"], "location": e["location"],
           "calendar": cal_name, "color": color, "recurring": e["recurring"]}
    if e["all_day"]:
        last = e["end"] - timedelta(days=1) if e["end"] > e["start"] else e["start"]
        out["start_day"], out["end_day"] = e["start"].strftime("%Y-%m-%d"), last.strftime("%Y-%m-%d")
    return out


def demo_calendar(now: int, days: int = 7) -> dict:
    """Example family calendar for the demo dashboard (relative to today)."""
    d0 = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0)

    def at(day, h, m=0, dur_min=60):
        s = d0 + timedelta(days=day, hours=h, minutes=m)
        return s, s + timedelta(minutes=dur_min)

    items = [("Kita bringen", *at(0, 7, 45, 30), False, ""), ("Zahnarzt", *at(0, 15, 30, 45), False, "Praxis Dr. Weber"),
             ("Elternabend", *at(0, 19, 30, 90), False, "Grundschule"), ("Bio-Tonne", d0 + timedelta(days=1),
             d0 + timedelta(days=2), True, ""), ("Schwimmen", *at(1, 17, 0, 60), False, "Hallenbad"),
             ("Geburtstag Oma", d0 + timedelta(days=2), d0 + timedelta(days=3), True, ""),
             ("Wartung Wärmepumpe", *at(3, 10, 0, 120), False, "")]
    nh = datetime.fromtimestamp(now)
    hour = nh.replace(minute=0, second=0, microsecond=0)
    items.append(("Paket abholen", hour + timedelta(minutes=80), hour + timedelta(minutes=95), False, "Packstation"))
    ev = [_cal_event_out({"start": s, "end": e, "all_day": ad, "title": t, "location": loc, "recurring": False},
                         "Familie (Demo)", "#ff2d55") for t, s, e, ad, loc in items]
    end = d0 + timedelta(days=days)
    ev = [x for x in ev if x["end"] > int(d0.timestamp()) and x["start"] < int(end.timestamp())]
    ev.sort(key=lambda x: (x["start"], not x["all_day"]))
    return {"ok": True, "demo": True, "ts": now, "days": days, "events": ev,
            "calendars": [{"name": "Familie (Demo)", "color": "#ff2d55", "error": None, "url": "Demo"}]}


AWB_MAX_AGE = 12 * 3600        # s – collection dates rarely change


def awb_load(ctx, force: bool = False) -> dict | None:
    """AWB Köln collection dates for the configured address (cached 12 h; on a
    failed refresh the last dates are kept and the error reported)."""
    sc, bn = ctx.cfg.get("awb_street_code"), ctx.cfg.get("awb_building_number")
    if not awb_koeln or not sc or not bn:
        return None
    key, now = (str(sc), str(bn)), time.time()
    with ctx._cal_lock:
        ent = ctx.awb_cache
        if ent and ent.get("key") == key and not force and now - ent["ts"] < AWB_MAX_AGE:
            return ent
    try:
        ent = {"key": key, "ts": now, "dates": awb_koeln.fetch_dates(*key), "error": None, "ok_ts": now}
    except Exception as exc:
        old = ctx.awb_cache if ctx.awb_cache.get("key") == key else {}
        ent = {"key": key, "ts": now, "dates": old.get("dates") or [], "error": str(exc), "ok_ts": old.get("ok_ts")}
    with ctx._cal_lock:
        ctx.awb_cache = ent
    return ent


WX_MAX_AGE = 3600              # s – weather for the PV views is fetched at most hourly
WX_RETRY = 600                 # s – after a failed fetch


def pv_weather_load(ctx, lat: float, lon: float, force: bool = False) -> dict:
    """Fetch the daily weather (92 days back, 3 ahead) for the location at most
    once an hour, store the days, keep today's hours in memory."""
    key, now = (round(lat, 2), round(lon, 2)), time.time()
    with ctx._cal_lock:
        ent = ctx.wx_cache
        if ent and ent.get("key") == key and not force and \
                now - ent["ts"] < (WX_MAX_AGE if not ent.get("error") else WX_RETRY):
            return ent
    try:
        r = weather.fetch_days(lat, lon, past_days=92, forecast_days=3)
        ctx.store.wx_put(r["daily"], lat, lon)
        ent = {"key": key, "ts": now, "hourly": r["hourly"], "error": None, "ok_ts": now}
    except Exception as exc:
        old = ctx.wx_cache if ctx.wx_cache.get("key") == key else {}
        ent = {"key": key, "ts": now, "hourly": old.get("hourly") or [], "error": str(exc), "ok_ts": old.get("ok_ts")}
    with ctx._cal_lock:
        ctx.wx_cache = ent
    return ent


def _wx_hours_today(hourly: list, now: int) -> list:
    """Today's weather per clock hour h (h:00–h+1:00): Open-Meteo stamps a value
    at the END of its hour."""
    d0, d1, _day = _day_of(now)
    out = {}
    for r in hourly:
        start = r["ts"] - 3600
        if d0 <= start < d1:
            out[int((start - d0) // 3600)] = {k: r.get(k) for k in ("ghi", "cloud", "sun_min", "temp", "code")}
    return [dict(h=h, **out[h]) for h in sorted(out) if 0 <= h < 24]


def demo_pv_weather(now: int, days: int) -> dict:
    """Weather that fits the demo installation (same cloud model as its PV)."""
    lat = math.radians(51.0)
    d0 = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0)
    daily, hours = [], []
    for k in range(-days + 1, 3):
        day = d0 + timedelta(days=k)
        lt = day.timetuple()
        decl = math.radians(23.44) * math.sin(2 * math.pi * (284 + lt.tm_yday) / 365.0)
        dl = 24.0 / math.pi * math.acos(max(-1.0, min(1.0, -math.tan(lat) * math.tan(decl))))
        cs, sun, rad, n = 0.0, 0.0, 0.0, 0
        for hh in range(24):
            ts = int((day + timedelta(hours=hh, minutes=30)).timestamp())
            p = _demo_pv_w(ts)                       # DC power of the 9.9 kWp demo array
            c = _demo_cloud(ts, time.localtime(ts))
            if p > 0:
                cs += c
                n += 1
                sun += max(0.0, min(1.0, (c - 0.3) / 0.6))
            g = p / (DEMO_PV_KWP * 0.86)              # ≈ irradiance on the modules, W/m²
            rad += g / 1000.0
            if k == 0:
                hours.append({"h": hh, "ghi": round(g), "cloud": round(100 * (1 - c)) if p > 0 else None,
                              "sun_min": round(60 * max(0.0, min(1.0, (c - 0.3) / 0.6))) if p > 0 else 0,
                              "temp": round(6 + 4 * math.sin((hh - 9) / 24 * 2 * math.pi), 1),
                              "code": 0 if c > 0.9 else 2 if c > 0.55 else 3})
        cm = cs / n if n else 0.5
        daily.append({"day": day.strftime("%Y-%m-%d"), "code": 0 if cm > 0.88 else 1 if cm > 0.75 else 2 if cm > 0.5 else 3,
                      "tmax": round(9 + 3 * math.cos(k / 3.0), 1), "tmin": round(2 + 2 * math.sin(k / 4.0), 1),
                      "sun_h": round(dl * (sun / n if n else 0), 2), "daylight_h": round(dl, 2),
                      "rain_mm": 0.0 if cm > 0.4 else 2.4, "snow_cm": 0.0, "rad_kwh": round(rad, 3),
                      "cloud": round(100 * (1 - cm))})
    return {"daily": daily, "hours": hours}


def compute_pv_weather(ctx, lat: float | None, lon: float | None, days: int = 30, force: bool = False) -> dict:
    """Weather of the last `days` days, today (also per hour) and the next two
    days for the PV views."""
    now = int(time.time())
    days = max(1, min(400, int(days)))
    base = {"ok": True, "ts": now, "source": "Open-Meteo", "days": days}
    if ctx.mode == "demo":
        dm = demo_pv_weather(now, max(days, 30))
        out = {**base, "demo": True, "hours": dm["hours"], "calib": _pv_weather_calib(ctx, dm["daily"], now)}
        first = (datetime.fromtimestamp(now) - timedelta(days=days - 1)).strftime("%Y-%m-%d")
        out["daily"] = [d for d in dm["daily"] if d["day"] >= first]
        return out
    if not weather:
        return {**base, "ok": False, "error": "Wetter-Modul fehlt (bridge/weather.py)."}
    if lat is None or lon is None:
        return {**base, "ok": False, "need_location": True,
                "error": "Für das Wetter fehlt der Standort."}
    ent = pv_weather_load(ctx, lat, lon, force=force)
    d0 = datetime.fromtimestamp(now)
    first = (d0 - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    last = (d0 + timedelta(days=2)).strftime("%Y-%m-%d")
    daily = ctx.store.wx_days(first, last, lat, lon)
    cal_first = (d0 - timedelta(days=29)).strftime("%Y-%m-%d")
    cal_days = daily if days >= 30 else ctx.store.wx_days(cal_first, last, lat, lon)
    return {**base, "demo": False, "daily": daily,
            "hours": _wx_hours_today(ent.get("hourly") or [], now),
            "calib": _pv_weather_calib(ctx, cal_days, now),
            "error": ent.get("error"), "fetched": int(ent.get("ok_ts") or 0) or None}


def _pv_weather_calib(ctx, wx_days: list, now: int) -> dict | None:
    """How much the installation made of the sun so far: PV kWh per kWh/m² of
    horizontal irradiation, over the complete days of the last 30 – multiplied
    with a forecast day's irradiation it gives that day's expected yield."""
    try:
        pv = ctx.calc_get(("pvcal", 30), 600, lambda: compute_pv(ctx.store, 30))
    except Exception:
        return None
    if not pv or pv.get("empty"):
        return None
    today = _day_of(now)[2]
    wx = {d["day"]: d for d in wx_days if d.get("rad_kwh")}
    pairs = [(d["pv_kwh"], wx[d["day"]]["rad_kwh"]) for d in pv.get("daily") or []
             if d["day"] != today and (d.get("pv_cov") or 0) >= 0.9 and d["day"] in wx
             and wx[d["day"]]["rad_kwh"] >= 0.1]
    if len(pairs) < 3:
        return {"f": None, "days": len(pairs)}
    rad = sum(r for _p, r in pairs)
    return {"f": round(sum(p for p, _r in pairs) / rad, 2) if rad > 0 else None, "days": len(pairs)}


def compute_calendar(ctx, days: int = 7, force: bool = False) -> dict:
    """Events of all configured calendars from today 00:00 for `days` days."""
    now = int(time.time())
    days = max(1, min(31, int(days)))
    if ctx.mode == "demo":
        return demo_calendar(now, days)
    urls = [u for u in (ctx.cfg.get("calendar_urls") or []) if isinstance(u, str) and u.strip()]
    base = {"ok": True, "demo": False, "ts": now, "days": days, "events": [], "calendars": []}
    d0 = datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0)
    w0, w1 = d0, d0 + timedelta(days=days)
    awb = awb_load(ctx, force=force)
    if awb is not None:                      # waste collection (AWB Köln) as all-day entries
        n = 0
        for d in awb.get("dates") or []:
            s_ = datetime(d["date"].year, d["date"].month, d["date"].day)
            if w0 <= s_ < w1:
                base["events"].append(_cal_event_out({"start": s_, "end": s_ + timedelta(days=1), "all_day": True,
                                                      "title": d["label"], "location": "", "recurring": False},
                                                     "Müllabfuhr AWB", d["color"]))
                n += 1
        base["calendars"].append({"name": "Müllabfuhr AWB Köln", "color": "#8e8e93", "error": awb.get("error"),
                                  "events": n, "url": ctx.cfg.get("awb_label") or "AWB Köln",
                                  "updated": int(awb.get("ok_ts") or 0) or None})
    if not urls:
        base["events"].sort(key=lambda x: (x["start"], not x["all_day"], x["title"]))
        return {**base, "configured": awb is not None}
    if calendar_ics is None:
        return {**base, "ok": False, "error": "Kalender-Modul fehlt (bridge/calendar_ics.py)."}
    for url in urls:
        ent = calendar_load(ctx, url, force=force)
        cal = ent.get("cal")
        name = (cal or {}).get("name") or "Kalender"
        color = (cal or {}).get("color")
        n = 0
        if cal:
            try:
                for e in calendar_ics.expand(cal, w0, w1):
                    base["events"].append(_cal_event_out(e, name, color))
                    n += 1
            except Exception as exc:
                ent = {**ent, "error": f"Kalender nicht lesbar: {exc}"}
        base["calendars"].append({"name": name, "color": color, "error": ent.get("error"), "events": n,
                                  "url": calendar_ics.mask_url(url), "updated": int(ent.get("ok_ts") or 0) or None})
    base["events"].sort(key=lambda x: (x["start"], not x["all_day"], x["title"]))
    return {**base, "configured": True}


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
        auth_err = getattr(electrolux, "ElectroluxAuthError", ()) if electrolux else ()
        while not self._stop.is_set():
            try:
                self._poll()
                self.state["last_error"] = None
            except auth_err as exc:
                # expired/invalid token won't fix itself by retrying – log ONCE
                # and stop the poller (no 5-min error spam). Reconnect or
                # disable in Setup to use it again.
                self.last_error = str(exc)
                self.state["last_error"] = str(exc)
                self.state["stopped_auth"] = True
                print(f"[electrolux] Anmeldung ungültig – Poller gestoppt. Im Setup neu "
                      f"verbinden oder AEG/Electrolux deaktivieren. ({exc})", file=sys.stderr)
                return
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
        self.fr = None                  # FroniusPoller
        self.fr_state = {}              # latest PV snapshot (live flow, details, identity)
        self.cal_cache = {}             # calendar url -> {"ts", "cal", "error"}
        self.awb_cache = {}             # AWB Köln: {"key", "ts", "dates", "error"}
        self.wx_cache = {}              # weather for the PV views: {"key", "ts", "hourly", "error"}
        self._cal_lock = threading.Lock()
        # heavy-analytics result cache: these process every raw sample in
        # Python, so recomputing them on every request/refresh is slow. Cache
        # results with a TTL + per-key dedup, and a background thread keeps the
        # recently-requested ones warm so the UI gets instant responses.
        self._calc_cache: dict = {}     # key -> (ts, result)
        self._calc_locks: dict = {}     # key -> threading.Lock (in-flight dedup)
        self._calc_meta = threading.Lock()
        self._calc_wanted: dict = {}    # key -> last_requested_ts
        self._warm_stop = threading.Event()
        self._warm_thread = None
        self._opstate_hit = None        # (ts, state, error) – HomeCom operating state
        self._opstate_lock = threading.Lock()
        self.calc_ms: dict = {}         # core key -> (compute ms, when) – for the start-time view
        self.rollup = {"running": False, "rows": 0, "started": None, "finished": None, "error": None}

    def hc_opstate(self, force: bool = False):
        """(state, error): the heat pump's operating mode / setpoints as READ
        from HomeCom. Cached for 10 min – it is ~15 sequential cloud requests –
        and failures for 1 min so a hiccup does not block the UI for long."""
        with self._opstate_lock:
            now = time.time()
            hit = self._opstate_hit
            if hit and not force and now - hit[0] < (600 if hit[1] else 60):
                return hit[1], hit[2]
            client = self.homecom_client()
            gid = self.cfg.get("homecom_gateway", "")
            if not client or not gid:
                return None, None
            try:
                st = client.read_opstate(gid)
                st["read_ts"] = int(now)
                err = None if st.get("readable") else "das Gerät liefert keine Betriebsart"
            except Exception as exc:
                st, err = None, str(exc)
            self._opstate_hit = (time.time(), st, err)
            return st, err

    CORE_TTL = 90                    # seconds a core result is served from cache

    def hp_snapshot(self) -> dict:
        """Live heat-pump snapshot + a 'connected' flag (real token or demo)."""
        hp = dict(self.hp_state)
        hp["connected"] = bool(self.cfg.get("homecom_refresh_token")) or self.mode == "demo"
        return hp

    def core(self, kind: str, days: int, price: float, fresh: bool = False,
             touch: bool = True):
        """One of the three results the app needs for its first screen:
        'analytics' (smart-home devices), 'hpanalytics' (heat pump) and
        'overview' (built FROM the other two – it used to recompute both).
        Cached per (kind, days, price); ``fresh`` recomputes now. ``touch``
        marks the result as recently requested (keeps it warm for 10 min) –
        the warm loop itself passes False so it does not keep itself alive."""
        key = (kind, days, price)

        def run():
            t0 = time.time()
            if kind == "analytics":
                res = compute_analytics(self.store, days, price)
            elif kind == "hpanalytics":
                res = compute_hp_analytics(self.store, days, price, self.hp_snapshot())
            else:
                res = compute_overview(self.store, days, price, self.hp_snapshot(),
                                       sh=self.core("analytics", days, price, fresh, touch),
                                       hp=self.core("hpanalytics", days, price, fresh, touch))
            self.calc_ms[key] = (round((time.time() - t0) * 1000), int(time.time()))
            return res
        if fresh:
            res = run()
            with self._calc_meta:
                self._calc_cache[key] = (time.time(), res)
                if touch:
                    self._calc_wanted[key] = time.time()
            return res
        return self.calc_get(key, self.CORE_TTL, run)

    BOOT_SNAP_KEY = "boot_snap"      # last core results, kept on disk
    BOOT_BUDGET_S = 1.5              # answer with the last state if fresh takes longer

    def _snap_save(self, days, price, parts: dict):
        """Persist the last core results (at most every 5 min) so the very next
        start – even right after a bridge restart – has something to show."""
        now = time.time()
        if now - getattr(self, "_snap_saved", 0) < 300:
            return
        self._snap_saved = now
        try:
            self.store.kv_set(self.BOOT_SNAP_KEY, json.dumps(
                {"days": days, "price": price, "ts": int(now), **parts}, separators=(",", ":")))
        except Exception as exc:
            print(f"[boot] snapshot: {exc}", file=sys.stderr)

    def _snap_load(self, days, price):
        try:
            d = json.loads(self.store.kv_get(self.BOOT_SNAP_KEY) or "null")
        except (ValueError, TypeError):
            return None
        if not isinstance(d, dict) or d.get("days") != days or d.get("price") != price:
            return None
        return d if all(d.get(k) for k in ("ov", "hpA", "data")) else None

    def boot_core(self, days: int, price: float, fresh: bool = False) -> dict:
        """Everything the first screen needs, in one answer: overview, heat-pump
        and device analytics. Normally fresh (cached ≤ 90 s). If computing takes
        longer than BOOT_BUDGET_S – e.g. while the history is still being
        aggregated after an update – the last persisted state is returned,
        marked ``stale``, and the computation simply continues for the next call."""
        box: dict = {}

        def work():
            try:
                box["ov"] = self.core("overview", days, price, fresh)
                box["hpA"] = self.core("hpanalytics", days, price)
                box["data"] = self.core("analytics", days, price)
            except Exception as exc:
                box["error"] = str(exc)
        th = threading.Thread(target=work, daemon=True)
        th.start()
        th.join(None if fresh else self.BOOT_BUDGET_S)
        if th.is_alive():
            snap = self._snap_load(days, price)
            if snap:
                return {"stale": True, "generated_at": snap.get("ts"),
                        "ov": snap["ov"], "hpA": snap["hpA"], "data": snap["data"]}
            th.join()                # nothing to fall back on → wait for the real thing
        if box.get("error") or not all(k in box for k in ("ov", "hpA", "data")):
            raise RuntimeError(box.get("error") or "Kern-Auswertung fehlgeschlagen")
        parts = {"ov": box["ov"], "hpA": box["hpA"], "data": box["data"]}
        self._snap_save(days, price, parts)
        return {"stale": False, "generated_at": int(time.time()), **parts}

    def calc_peek(self, key, ttl):
        """A cached result if it is still fresh, else None (never computes)."""
        with self._calc_meta:
            hit = self._calc_cache.get(key)
            return hit[1] if hit and time.time() - hit[0] < ttl else None

    def calc_get(self, key, ttl, fn):
        """Return a cached heavy-analytics result, computing it at most once per
        TTL and deduping concurrent identical requests."""
        now = time.time()
        with self._calc_meta:
            self._calc_wanted[key] = now
            hit = self._calc_cache.get(key)
            if hit and now - hit[0] < ttl:
                return hit[1]
            lock = self._calc_locks.setdefault(key, threading.Lock())
        with lock:                       # only one thread computes this key
            with self._calc_meta:
                hit = self._calc_cache.get(key)
                if hit and time.time() - hit[0] < ttl:
                    return hit[1]
            result = fn()
            with self._calc_meta:
                self._calc_cache[key] = (time.time(), result)
            return result

    def calc_clear(self, kind: str):
        """Forget cached results of one kind (e.g. 'pv' after connecting an inverter)."""
        with self._calc_meta:
            for k in [k for k in self._calc_cache if isinstance(k, tuple) and k and k[0] == kind]:
                self._calc_cache.pop(k, None)

    def _warm_once(self):
        cutoff = time.time() - 600       # forget ranges not requested in 10 min
        with self._calc_meta:
            self._calc_wanted = {k: t for k, t in self._calc_wanted.items() if t >= cutoff}
            wanted = list(self._calc_wanted.keys())
        for key in wanted:
            if not isinstance(key, tuple) or len(key) != 3:
                continue                 # not one of the warmable (kind, days, price) keys
            try:
                kind, days, price = key
                if kind not in ("overview", "analytics", "hpanalytics"):
                    continue
                if kind == "overview":          # renews its two parts as well
                    self.core("overview", days, price, fresh=True, touch=False)
                elif ("overview", days, price) not in wanted:
                    self.core(kind, days, price, fresh=True, touch=False)
            except Exception as exc:
                print(f"[warm] {key}: {exc}", file=sys.stderr)

    def _warm_hp(self):
        return self.hp_snapshot()

    def start_rollup(self):
        """Background: aggregate every finished day that has no `dev_day` row
        yet (first start after the update: the whole history, once; later: just
        yesterday). Requests do not wait for this – they compute what they need
        themselves – it only makes sure the work is usually done beforehand."""
        if self.rollup.get("running"):
            return

        def run():
            st = self.rollup
            st.update({"running": True, "started": int(time.time()), "finished": None, "error": None})
            try:
                first = self.store.min_ts()
                if first is not None:
                    rollup_ensure(self.store, _local_day(first), pause=0.02, state=st)
            except Exception as exc:
                st["error"] = str(exc)
                print(f"[rollup] {exc}", file=sys.stderr)
            finally:
                st.update({"running": False, "finished": int(time.time())})
        threading.Thread(target=run, daemon=True).start()

    def start_warmer(self):
        if self._warm_thread and self._warm_thread.is_alive():
            return
        # seed the ranges the UI actually requests (days=90) so even the first
        # page load after start hits a warm cache
        price = round(float(self.cfg.get("price_per_kwh", 0.35) or 0.35), 4)
        now = time.time()
        with self._calc_meta:
            for kind in ("overview", "analytics", "hpanalytics"):
                self._calc_wanted.setdefault((kind, 90, price), now)

        def loop():
            try:
                self._warm_once()        # warm immediately at startup
            except Exception as exc:
                print(f"[warm] initial: {exc}", file=sys.stderr)
            while not self._warm_stop.wait(25):
                try:
                    self._warm_once()
                except Exception as exc:
                    print(f"[warm] loop: {exc}", file=sys.stderr)
        self._warm_thread = threading.Thread(target=loop, daemon=True)
        self._warm_thread.start()

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
        seed_demo_pv(self.store, days)
        self.cfg["_demo"] = True
        self.mode = "demo"
        self.poller = DemoPoller(self.store, int(self.cfg.get("poll_interval", 30)),
                                 hp_state=self.hp_state)
        self.poller.start()
        self.start_fronius()

    def start_live(self):
        self.stop()
        self.cfg["_demo"] = False
        self.mode = "live"
        client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
        self.poller = Poller(client, self.store, self.cfg)
        self.poller.start()
        self.start_fronius()

    # -- PV system (Fronius) --------------------------------------------- #
    def fronius_connected(self) -> bool:
        return self.mode == "demo" or bool((self.cfg.get("fronius_host") or "").strip())

    def start_fronius(self) -> bool:
        """(Re)start the PV poller: the demo installation in demo mode, else the
        configured inverter. Independent of the Smart Home controller."""
        self.stop_fronius()
        if self.mode == "demo":
            client, demo = DemoFronius(self.store), True
        else:
            host = (self.cfg.get("fronius_host") or "").strip()
            if not fronius or not host:
                return False
            client, demo = fronius.FroniusClient(host), False
        self.fr_state.clear()
        self.fr_state.update({"host": client.host, "demo": demo, "started": int(time.time())})
        self.fr = FroniusPoller(client, self.store, self.fr_state,
                                int(self.cfg.get("fronius_interval", 15) or 15), demo)
        self.fr.start()
        return True

    def stop_fronius(self):
        if self.fr:
            self.fr.stop()
            self.fr = None

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
            # the replaced client must never refresh again – its refresh token is
            # single-use and a newer client takes over (else Bosch revokes the login)
            cl = getattr(self.hp, "client", None)
            if cl is not None and hasattr(cl, "retire"):
                cl.retire()
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
        if not self.cfg.get("electrolux_enabled", True):     # user disabled it
            return False
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
            cl = getattr(self.ael, "client", None)
            if cl is not None and hasattr(cl, "retire"):
                cl.retire()
            self.ael = None

    def quiesce_tokens(self, timeout: float = 20.0):
        """Before the process ends or re-executes itself: stop the cloud pollers
        and wait until no refresh-token rotation is in flight (HomeCom/AEG issue a
        new single-use token on every refresh – a process killed in the middle
        would leave a used-up token in config.json and the login would be lost)."""
        for name in ("hp", "ael"):
            poller = getattr(self, name, None)
            if poller:
                poller.stop()
                cl = getattr(poller, "client", None)
                if cl is not None and hasattr(cl, "retire"):
                    cl.retire(timeout)


_CONFIG_WRITE_LOCK = threading.Lock()
_RUNTIME = None          # the serving Runtime (for a clean re-exec after an update)


def save_config(cfg: dict, path: str):
    keep = ("shc_ip", "system_password", "cert", "key", "db", "poll_interval",
            "price_per_kwh", "currency", "device_filter",
            "homecom_refresh_token", "homecom_gateway", "homecom_interval",
            "electrolux_api_key", "electrolux_refresh_token", "electrolux_interval",
            "electrolux_kwh_per_cycle", "electrolux_enabled", "auto_update_interval",
            "spot_enabled", "spot_market", "spot_surcharge_ct", "spot_vat",
            # set in the app as well – were missing here, so they were lost
            # whenever the bridge restarted
            "tibber_token", "ha_url", "ha_token", "ha_entities", "contact_room_map",
            "fronius_host", "fronius_interval", "calendar_urls",
            "awb_street_code", "awb_building_number", "awb_label")
    # one writer at a time, and atomically (temp file + rename): two saves at once
    # (e.g. a rotated HomeCom token while a setting is stored) could otherwise
    # leave an older token – or a half-written file – on disk
    with _CONFIG_WRITE_LOCK:
        data = {k: cfg[k] for k in keep if k in cfg and not str(k).startswith("_")}
        tmp = f"{path}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2, ensure_ascii=False)
                fh.flush()
                try:
                    os.fsync(fh.fileno())
                except OSError:
                    pass
            os.replace(tmp, path)
        except OSError as exc:
            print(f"[config] could not write {path}: {exc}", file=sys.stderr)


# --------------------------------------------------------------------------- #
# HTTP server
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "BoschHomeEnergyBridge/1.0"
    # HTTP/1.1 keeps the connection open between requests: the app start fires a
    # dozen requests, each of which used to pay for a new TCP connection. Every
    # response therefore carries a Content-Length (see _send_bytes). Idle
    # connections are dropped after `timeout` seconds so they do not pin threads.
    protocol_version = "HTTP/1.1"
    timeout = 30

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
        return self.ctx.hp_snapshot()

    def _health(self) -> dict:
        """Bridge status for the app (mode, connections, capabilities)."""
        cfg = self.cfg
        have_cert = os.path.exists(cfg.get("cert", "")) and os.path.exists(cfg.get("key", ""))
        return {
            "ok": True,
            "mode": self.ctx.mode,
            "sample_count": self.store.count_fast(),
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
            "fronius_available": fronius is not None,
            "fronius_connected": self.ctx.fronius_connected(),
            "fronius_host": self.cfg.get("fronius_host", ""),
            "fronius_ok": self.ctx.fr_state.get("ok"),
            "fronius_error": self.ctx.fr_state.get("error"),
        }

    def _boot(self, qs) -> dict:
        """ONE answer for the app start: shared settings, bridge status and the
        three core results. The app used to fetch these in three consecutive
        round trips (settings → health → analytics) before it could draw
        anything; the request is now sent while the script is still loading.
        The electricity price is resolved here the same way the app does it
        (synced setting, else the bridge's configured price)."""
        st = self._settings_load()
        try:
            days = max(1, min(400, int(qs.get("days", ["90"])[0])))
        except ValueError:
            days = 90
        price = None
        for cand in (st.get("bhe_price"), qs.get("price", [None])[0], self.cfg.get("price_per_kwh", 0.35)):
            try:
                price = round(float(cand), 4)
                break
            except (TypeError, ValueError):
                continue
        t0 = time.time()
        try:
            core = self.ctx.boot_core(days, price if price is not None else 0.35, "fresh" in qs)
        except Exception as exc:
            core = {"error": str(exc)}
        core.update({"days": days, "price": price, "ms": round((time.time() - t0) * 1000),
                     "meter": {"readings": self.store.meter_list()}})
        return {"ok": True, "ts": int(time.time()), "settings": st,
                "health": self._health(), "core": core}

    def _perf(self, qs) -> dict:
        """Numbers behind the start-time view in the Setup tab: how long the
        bridge needed for the core results, the state of the day aggregation
        and the size of the database. ``?bench=1`` recomputes the three core
        results from a cold cache and reports the timings."""
        st = self._settings_load()
        try:
            price = round(float(st.get("bhe_price") or self.cfg.get("price_per_kwh", 0.35)), 4)
        except (TypeError, ValueError):
            price = 0.35
        out = {"ok": True, "ts": int(time.time())}
        if "bench" in qs:
            t0 = time.time()
            self.ctx.core("overview", 90, price, fresh=True)      # recomputes all three
            out["bench_ms"] = round((time.time() - t0) * 1000)
        names = {"analytics": "Geräte", "hpanalytics": "Wärmepumpe", "overview": "Übersicht"}
        out["core"] = [{"key": k, "label": names[k],
                        "ms": (self.ctx.calc_ms.get((k, 90, price)) or (None, None))[0],
                        "at": (self.ctx.calc_ms.get((k, 90, price)) or (None, None))[1]}
                       for k in ("analytics", "hpanalytics", "overview")]
        try:
            size_mb = round(os.path.getsize(self.cfg.get("db", "")) / 1e6, 1)
        except OSError:
            size_mb = None
        out["db"] = {"samples": self.store.count_fast(), "size_mb": size_mb,
                     "since": self.store.min_ts(), "day_rows": self.store.dev_day_count()}
        out["rollup"] = dict(self.ctx.rollup)
        return out

    def _opstate(self, force: bool = False) -> dict:
        """How the heating is actually operated (read from heat pump +
        thermostats, measured from the setpoint log)."""
        if self.ctx.mode == "demo":
            return {"demo": True,
                    **compute_opstate(self.store, _demo_opstate_hc(), _demo_climate())}
        hc, err = self.ctx.hc_opstate(force)
        climate = None
        if self.ctx.mode == "live":
            try:
                client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
                climate = client.list_climate(self.cfg.get("contact_room_map"))
            except Exception:
                climate = None
        return {"demo": False, **compute_opstate(self.store, hc, climate, err)}

    def _balance(self, force: bool = False) -> dict:
        """The consolidated balancing view (one model run for the whole tab)."""
        demo = self.ctx.mode == "demo"
        if not demo:
            try:
                if int(time.time()) - self.store.room_log_last_ts() >= 120:
                    self._log_rooms_now()
            except Exception:
                pass
        st = self._settings_load()
        # recompute when the layout / targets / flow readings change
        fp = hash((st.get("heatLayout"),
                   tuple(sorted((k, v) for k, v in st.items()
                                if k.startswith(("bhe_target_", "bhe_taco_"))))))

        def run():
            return {"demo": demo, **compute_balance(self.store, st, demo)}
        res = run() if force else self.ctx.calc_get(("abgleich", fp, demo), 45, run)
        poller = self.ctx.hp
        if res.get("flow") and poller and getattr(poller, "discovering", False):
            res = dict(res)                       # never touch the cached copy
            res["flow"] = dict(res["flow"], discovering=True)
        return res

    def _log_rooms_now(self):
        """On-demand per-room temperature log (used by the rooms endpoint so the
        chart isn't empty until the 10-min poller runs)."""
        if self.ctx.mode != "live":
            return
        client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
        climate = client.list_climate(self.cfg.get("contact_room_map"))
        ts = int(time.time())
        per_room, temps, sets = [], [], []
        for r in _loggable_climate(climate):
            t = r.get("temp")
            sp = r.get("setpoint") if isinstance(r.get("setpoint"), (int, float)) else None
            vv = r.get("valve") if isinstance(r.get("valve"), (int, float)) else None
            per_room.append((ts, r.get("room") or "—", round(t, 1),
                             round(sp, 1) if sp is not None else None, vv))
            temps.append(t)
            if sp is not None:
                sets.append(sp)
        if per_room:
            self.store.room_log_add_bulk(per_room)
        if temps:
            self.store.room_temp_add(ts, round(sum(temps) / len(temps), 1),
                                     round(sum(sets) / len(sets), 1) if sets else None)

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

    def _gzip_ok(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _send_bytes(self, status: int, body: bytes, ctype: str,
                    headers: dict | None = None, gz: bytes | None = None,
                    compress: bool = True):
        """The one place a response body is written: always with Content-Length
        (required for keep-alive), gzip-compressed when the client accepts it.
        ``gz`` is an already compressed copy of ``body`` (static files cache
        theirs); otherwise text bodies above 1 kB are compressed here."""
        enc = None
        if compress and self._gzip_ok():
            if gz is None and len(body) >= 1024:
                gz = gzip.compress(body, 5)
            if gz is not None and len(gz) < len(body):
                body, enc = gz, "gzip"
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Access-Control-Allow-Origin", "*")
            if enc:
                self.send_header("Content-Encoding", enc)
            if compress:
                self.send_header("Vary", "Accept-Encoding")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # the phone navigated away / reloaded before we finished sending –
            # harmless, don't spam the terminal with a traceback
            self.close_connection = True

    def _send_json(self, obj, status=200):
        self._send_bytes(status, json.dumps(obj).encode("utf-8"),
                         "application/json; charset=utf-8")

    def _send_csv(self, text, filename="export.csv", status=200):
        self._send_bytes(status, text.encode("utf-8"), "text/csv; charset=utf-8",
                         {"Content-Disposition": f'attachment; filename="{filename}"'})

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
        return self._static(path, qs)

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
            if parsed.path == "/api/contacts/map":
                return self._post_contacts_map(body)
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
            if parsed.path == "/api/homecom/write":
                return self._post_hp_write(body)
            if parsed.path == "/api/electrolux/connect":
                return self._post_electrolux_connect(body)
            if parsed.path == "/api/electrolux/disconnect":
                return self._post_electrolux_disconnect(body)
            if parsed.path == "/api/electrolux/probe":
                return self._post_electrolux_probe(body)
            if parsed.path == "/api/tibber/connect":
                return self._post_tibber_connect(body)
            if parsed.path == "/api/ha/connect":
                return self._post_ha_connect(body)
            if parsed.path == "/api/fronius/connect":
                return self._post_fronius_connect(body)
            if parsed.path == "/api/fronius/disconnect":
                return self._post_fronius_disconnect(body)
            if parsed.path == "/api/calendar/config":
                return self._post_calendar_config(body)
            if parsed.path == "/api/awb/config":
                return self._post_awb_config(body)
            if parsed.path == "/api/meter":
                return self._post_meter(body)
            if parsed.path == "/api/meter/delete":
                return self._post_meter_delete(body)
            if parsed.path == "/api/observation/start":
                return self._post_observation_start(body)
            if parsed.path == "/api/observation/stop":
                return self._post_observation_stop(body)
            if parsed.path == "/api/heatload":
                return self._post_heatload(body)
            if parsed.path == "/api/settings":
                return self._post_settings(body)
            if parsed.path == "/api/automeasure/arm":
                return self._post_automeasure("arm", body)
            if parsed.path == "/api/automeasure/disarm":
                return self._post_automeasure("disarm", body)
            if parsed.path == "/api/optimize/step":
                return self._post_optimize("step", body)
            if parsed.path == "/api/optimize/undo":
                return self._post_optimize("undo", body)
            if parsed.path == "/api/heatpump/flow/discover":
                return self._flow_discover()
            if parsed.path == "/api/optimize/reset":
                return self._post_optimize("reset", body)
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

    def _post_contacts_map(self, body):
        """Set/clear a window/door-contact → room override. Body: {id|name, room}.
        An empty/false room removes the override. Keyed by device id (preferred)
        or lower-cased name, matching list_window_contacts/list_climate."""
        key = str(body.get("id") or body.get("name") or "").strip()
        if not key:
            return self._send_json({"ok": False, "error": "Kontakt-id/-name fehlt"}, 400)
        key = key.lower() if not body.get("id") else key
        room = str(body.get("room") or "").strip()
        cmap = dict(self.cfg.get("contact_room_map") or {})
        if room:
            cmap[key] = room
        else:
            cmap.pop(key, None)
        self.cfg["contact_room_map"] = cmap
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
        return self._send_json({"ok": True, "map": cmap})

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
            supply = f(r.get("supply_c"))
            water_t = f(r.get("water_c"))
            if elec is None and heat is None:
                continue
            clean.append((period, date, elec, heat, heating, water, outdoor, supply, water_t))
            # real heating-curve point: an HOUR with actual space-heating OUTPUT
            # (produced heating heat > 0 – excludes standby & hot-water hours where
            # the flow sensor still reads the hot tank), no hot water, flow+outdoor
            # present. Using produced heat, not the 0.1 kWh standby electricity.
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

    def _post_hp_write(self, body):
        """Write a single heat-pump setting via the HomeCom API – guarded:
        only writeable heating/hot-water resources, value validated against the
        device's own allowedValues / min-max, explicit confirmation required."""
        path = str(body.get("path") or "").strip()
        value = body.get("value")
        if not path or value is None:
            return self._send_json({"ok": False, "error": "path und value erforderlich."}, 200)
        if not body.get("confirm"):
            return self._send_json({"ok": False, "error": "Bestätigung erforderlich."}, 200)
        # safety allowlist: only heating / hot-water circuits, never sensors/system
        low = path.lower()
        if not (low.startswith("/resource/heatingcircuits/") or low.startswith("/resource/dhwcircuits/")):
            return self._send_json({"ok": False,
                                    "error": "Aus Sicherheitsgründen nur Heiz-/Warmwasserkreise änderbar."}, 200)
        if self.ctx.mode == "demo":
            return self._send_json({"ok": True, "demo": True, "path": path, "value": value,
                                    "message": f"Demo: '{_control_label(path)}' würde auf {value} gesetzt."})
        client = self.ctx.homecom_client()
        if not client:
            return self._send_json({"ok": False, "error": "nicht mit HomeCom verbunden"}, 200)
        gid = self.cfg.get("homecom_gateway", "")
        try:
            cur = client.read_resource(gid, path)
        except Exception as exc:
            return self._send_json({"ok": False, "error": f"Ressource nicht lesbar: {exc}"}, 200)
        if not cur:
            return self._send_json({"ok": False, "error": "Ressource nicht gefunden."}, 200)
        if not cur.get("writeable"):
            return self._send_json({"ok": False,
                                    "error": "Diese Ressource ist laut Anlage nicht änderbar (read-only)."}, 200)
        prev = cur.get("value")
        # validate against the device's own constraints
        if cur.get("allowed"):
            if value not in cur["allowed"]:
                return self._send_json({"ok": False,
                                        "error": f"Wert nicht erlaubt. Erlaubt: {', '.join(map(str, cur['allowed']))}."}, 200)
        else:
            try:
                value = float(value)
            except (TypeError, ValueError):
                return self._send_json({"ok": False, "error": "Zahlenwert erwartet."}, 200)
            lo, hi = cur.get("min"), cur.get("max")
            if lo is not None and value < lo:
                return self._send_json({"ok": False, "error": f"Wert unter Minimum ({lo})."}, 200)
            if hi is not None and value > hi:
                return self._send_json({"ok": False, "error": f"Wert über Maximum ({hi})."}, 200)
            if float(value).is_integer():
                value = int(value)
        try:
            status, resp = client.put(gid, path, value)
        except Exception as exc:
            return self._send_json({"ok": False, "error": f"Schreiben fehlgeschlagen: {exc}"}, 200)
        if status not in (200, 204):
            return self._send_json({"ok": False,
                                    "error": f"Anlage lehnte ab (HTTP {status}).",
                                    "detail": resp[:200]}, 200)
        return self._send_json({"ok": True, "path": path, "value": value, "previous": prev,
                                "label": _control_label(path),
                                "message": f"'{_control_label(path)}' auf {value} gesetzt (vorher {prev})."})

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
        self.cfg["electrolux_enabled"] = True
        started = self.ctx.start_electrolux()
        names = ", ".join(a.get("name", a["id"]) for a in appliances) or "keine"
        return self._send_json({"ok": True, "connected": True, "started": started,
                                "appliances": appliances,
                                "message": f"Verbunden. Geräte: {names}."})

    def _post_electrolux_disconnect(self, body):
        """Disable the AEG/Electrolux integration: stop the poller, clear the
        credentials and remember it's off so it never starts again."""
        self.ctx.stop_electrolux()
        for k in ("electrolux_refresh_token", "electrolux_api_key"):
            self.cfg[k] = ""
        self.cfg["electrolux_enabled"] = False
        try:
            self.ctx.ael_state.clear()
        except Exception:
            pass
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
        return self._send_json({"ok": True, "connected": False,
                                "message": "AEG/Electrolux deaktiviert."})

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

    # -- PV system (Fronius) --------------------------------------------- #
    def _pv_prices(self, qs=None) -> tuple[float, float]:
        """(electricity price €/kWh, feed-in tariff €/kWh) – the app's synced
        settings first (same rule as the start request), else the bridge config."""
        st = self._settings_load()
        price = None
        for cand in (st.get("bhe_price"), (qs or {}).get("price", [None])[0], self.cfg.get("price_per_kwh", 0.35)):
            try:
                price = round(float(cand), 4)
                break
            except (TypeError, ValueError):
                continue
        try:
            feed = round(float(st.get("bhe_pv_feedin")) / 100.0, 5)
        except (TypeError, ValueError):
            feed = PV_FEEDIN_DEFAULT_CT / 100.0
        return (price if price is not None else 0.35), max(0.0, feed)

    def _fronius_payload(self) -> dict:
        st = dict(self.ctx.fr_state)
        connected = self.ctx.fronius_connected()
        out = {"available": fronius is not None or self.ctx.mode == "demo", "connected": connected,
               "demo": self.ctx.mode == "demo", "host": st.get("host") or self.cfg.get("fronius_host", ""),
               "running": bool(self.ctx.fr), "ok": st.get("ok"), "error": st.get("error"),
               "last_poll": st.get("last_poll"), "last_store": st.get("last_store"),
               "live": st.get("live"), "details": st.get("details"), "identity": st.get("identity"),
               "details_error": st.get("details_error"), "interval": int(self.cfg.get("fronius_interval", 15) or 15),
               "server_time": int(time.time())}
        if connected:
            price, feedin = self._pv_prices()
            try:
                out["today"] = self.ctx.calc_get(("pv", 1, price, feedin), 30,
                                                 lambda: compute_pv(self.store, 1, price, feedin))
            except Exception as exc:
                out["today_error"] = str(exc)
            try:      # month / since connection: heavier, so refreshed every 10 min
                out["money"] = self.ctx.calc_get(("pvmoney", 0, price, feedin), 600,
                                                 lambda: compute_pv_money(self.store, price, feedin))
            except Exception as exc:
                out["money_error"] = str(exc)
        return out

    def _fronius_discover(self, qs) -> dict:
        if not fronius:
            return {"ok": False, "error": "Fronius-Modul fehlt (bridge/fronius.py)."}
        t0 = time.time()
        one = (qs.get("host", [""])[0] or "").strip()
        if one:
            r = fronius.check_host(one)
            return {"ok": True, "found": [r] if r else [], "scanned": 1, "ms": round((time.time() - t0) * 1000)}
        ip = local_ip()
        hosts = fronius.subnet_hosts(ip)
        if not hosts:
            return {"ok": False, "error": "Keine Netzwerkadresse der Bridge gefunden – bitte die IP des "
                                          "Wechselrichters von Hand eintragen.", "found": []}
        found = fronius.discover(hosts)
        return {"ok": True, "found": found, "scanned": len(hosts), "subnet": ip.rsplit(".", 1)[0] + ".1–254",
                "ms": round((time.time() - t0) * 1000)}

    def _fronius_probe(self, qs) -> dict:
        if self.ctx.mode == "demo" and not qs.get("host"):
            return DemoFronius(self.store).probe()
        if not fronius:
            return {"ok": False, "error": "Fronius-Modul fehlt (bridge/fronius.py)."}
        host = (qs.get("host", [""])[0] or self.cfg.get("fronius_host") or "").strip()
        if not host:
            return {"ok": False, "error": "Noch keine Wechselrichter-Adresse eingetragen."}
        try:
            return {"ok": True, **fronius.FroniusClient(host).probe()}
        except fronius.FroniusError as exc:
            return {"ok": False, "error": str(exc)}

    def _post_fronius_connect(self, body):
        """Check the address, then save it and start reading the inverter."""
        if not fronius:
            return self._send_json({"ok": False, "error": "Fronius-Modul fehlt (bridge/fronius.py)."}, 500)
        host = fronius.normalize_host(str(body.get("host") or ""))
        if not host:
            return self._send_json({"ok": False, "error": "Bitte die IP-Adresse des Wechselrichters eintragen."}, 400)
        try:
            ident = fronius.FroniusClient(host).identify()
        except fronius.FroniusError as exc:
            hint, api_off = None, False
            try:
                found = fronius.check_host(host)
                if found and not found.get("solar_api"):
                    hint, api_off = found.get("note"), True    # Fronius web UI, Solar API off
            except Exception:
                pass
            return self._send_json({"ok": False, "error": str(exc), "hint": hint,
                                    "api_off": api_off, "host": host})
        self.cfg["fronius_host"] = ident["host"]
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
        if self.ctx.mode != "demo":
            self.ctx.start_fronius()
            self.ctx.fr_state["identity"] = {k: v for k, v in ident.items() if k != "flow"}
            self.ctx.fr_state["live"] = ident.get("flow")
        self.ctx.calc_clear("pv")
        return self._send_json({"ok": True, "identity": ident, "demo": self.ctx.mode == "demo"})

    def _post_awb_config(self, body):
        """Save the address for the AWB Köln collection dates (local config only);
        it is checked by fetching the dates once."""
        if awb_koeln is None:
            return self._send_json({"ok": False, "error": "AWB-Modul fehlt (bridge/awb_koeln.py)."}, 500)
        if body.get("clear"):
            for k in ("awb_street_code", "awb_building_number", "awb_label"):
                self.cfg.pop(k, None)
            save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
            self.ctx.awb_cache = {}
            return self._send_json({"ok": True})
        sc, bn = str(body.get("street_code") or "").strip(), str(body.get("building_number") or "").strip()
        if not sc or not bn:
            return self._send_json({"ok": False, "error": "Bitte zuerst die Adresse suchen und auswählen."}, 400)
        try:
            dates = awb_koeln.fetch_dates(sc, bn)
        except Exception as exc:
            return self._send_json({"ok": False, "error": str(exc)})
        self.cfg.update({"awb_street_code": sc, "awb_building_number": bn,
                         "awb_label": str(body.get("label") or "")[:120]})
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
        self.ctx.awb_cache = {"key": (sc, bn), "ts": time.time(), "dates": dates, "error": None, "ok_ts": time.time()}
        today_ = datetime.now().date()
        nxt = [{"date": d["date"].isoformat(), "label": d["label"], "color": d["color"], "type": d["type"]}
               for d in dates if d["date"] >= today_][:8]
        return self._send_json({"ok": True, "count": len(dates), "next": nxt,
                                "types": sorted({d["type"] for d in dates})})

    def _post_calendar_config(self, body):
        """Save the calendar links (kept only in the local config.json). Each
        link is fetched once; only readable calendars are stored."""
        if calendar_ics is None:
            return self._send_json({"ok": False, "error": "Kalender-Modul fehlt (bridge/calendar_ics.py)."}, 500)
        if body.get("clear"):
            self.cfg["calendar_urls"] = []
            save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
            self.ctx.cal_cache.clear()
            return self._send_json({"ok": True, "count": 0, "results": []})
        raw = body.get("urls")
        if isinstance(raw, str):
            raw = raw.split()
        urls = []
        for u in raw or []:
            u = str(u).strip()
            if u and u not in urls:
                urls.append(u)
        if not urls:
            return self._send_json({"ok": False, "error": "Bitte mindestens eine Kalender-Adresse eintragen."}, 400)
        keep, results = [], []
        for u in urls[:8]:
            ent = calendar_load(self.ctx, u, force=True)
            cal = ent.get("cal")
            if cal is not None and not ent.get("error"):
                keep.append(u)
                now = datetime.now()
                n7 = len(calendar_ics.expand(cal, now.replace(hour=0, minute=0, second=0, microsecond=0),
                                             now + timedelta(days=7)))
                results.append({"url": calendar_ics.mask_url(u), "ok": True, "name": cal.get("name") or "Kalender",
                                "events_7d": n7, "events_total": len(cal.get("events") or [])})
            else:
                results.append({"url": calendar_ics.mask_url(u), "ok": False, "error": ent.get("error")})
        if not keep:
            return self._send_json({"ok": False, "error": results[0].get("error") if results else "Nicht lesbar.",
                                    "results": results})
        self.cfg["calendar_urls"] = keep
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
        return self._send_json({"ok": True, "count": len(keep), "results": results})

    def _post_fronius_disconnect(self, body):
        self.cfg["fronius_host"] = ""
        save_config(self.cfg, self.cfg.get("_config_path", DEFAULT_CONFIG))
        if self.ctx.mode != "demo":
            self.ctx.stop_fronius()
            self.ctx.fr_state.clear()
        return self._send_json({"ok": True})

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

    def _post_observation_start(self, body):
        """Anchor a guided observation run so progress is measured from now."""
        try:
            td = max(3, min(21, int(body.get("target_days") or 7)))
        except (TypeError, ValueError):
            td = 7
        cfg = {"active": True, "started_ts": int(time.time()), "target_days": td,
               "night_setback": bool(body.get("night_setback", True))}
        self.store.kv_set(OBS_KEY, json.dumps(cfg))
        if self.ctx.mode == "demo":
            return self._send_json(_demo_observation())
        try:
            self._log_rooms_now()
        except Exception:
            pass
        return self._send_json({"ok": True, **compute_observation(self.store)})

    def _post_observation_stop(self, body):
        """End the guided observation run (data stays; only the anchor clears)."""
        self.store.kv_del(OBS_KEY)
        if self.ctx.mode == "demo":
            return self._send_json({"ok": True, **_demo_observation(), "active": False})
        return self._send_json({"ok": True, **compute_observation(self.store)})

    def _post_heatload(self, body):
        """Per-room heat load (W) with the room areas supplied by the frontend
        (they live in the browser's layout storage)."""
        areas = body.get("areas") if isinstance(body.get("areas"), dict) else {}
        try:
            dc = float(body.get("design_c")) if body.get("design_c") is not None else DESIGN_OUTDOOR_C
        except (TypeError, ValueError):
            dc = DESIGN_OUTDOOR_C
        try:
            sk = float(body.get("spread_k")) if body.get("spread_k") is not None else 5.0
        except (TypeError, ValueError):
            sk = 5.0
        try:
            sw = float(body.get("spec_wm2")) if body.get("spec_wm2") is not None else 40.0
        except (TypeError, ValueError):
            sw = 40.0
        if self.ctx.mode == "demo":
            return self._send_json(_demo_heatload(dc, sk))
        try:
            if int(time.time()) - self.store.room_log_last_ts() >= 120:
                self._log_rooms_now()
        except Exception:
            pass
        return self._send_json({"ok": True, "demo": False,
            **compute_heatload(self.store, areas, dc, sk, sw)})

    def _post_optimize(self, kind, body):
        """Log/undo/reset a balancing step. Logging captures a baseline snapshot
        so the step's effect can be measured over the following days."""
        if kind == "step":
            try:
                self._log_rooms_now()
            except Exception:
                pass
            res = _opt_add_step(self.store, body or {})
            return self._send_json(res, 200 if res.get("ok") else 400)
        if kind == "undo":
            return self._send_json(_opt_undo(self.store))
        if kind == "reset":
            return self._send_json(_opt_reset(self.store))
        return self._send_json({"ok": False, "error": "unknown"}, 400)

    SETTINGS_KEY = "settings"
    _SETTINGS_LOCK = threading.Lock()     # read-modify-write of the settings blob

    def _settings_load(self) -> dict:
        raw = self.store.kv_get(self.SETTINGS_KEY)
        if not raw:
            return {}
        try:
            d = json.loads(raw)
            return d if isinstance(d, dict) else {}
        except (ValueError, TypeError):
            return {}

    def _flow_payload(self) -> dict:
        demo = self.ctx.mode == "demo"
        fl = compute_flow(self.store, days=14, demo=demo)
        poller = self.ctx.hp
        fl["discovering"] = bool(poller and getattr(poller, "discovering", False))
        fl["can_discover"] = bool(poller) and not demo
        return fl

    def _flow_discover(self):
        """Search the heat pump's resources for a volume flow now (background)."""
        if self.ctx.mode == "demo":
            return self._send_json({"ok": False, "error": "Im Demo-Modus gibt es keine echte Wärmepumpe zum Durchsuchen."})
        poller = self.ctx.hp
        if not poller:
            return self._send_json({"ok": False, "error": "Wärmepumpe (HomeCom) ist nicht verbunden."})
        if getattr(poller, "discovering", False):
            return self._send_json({"ok": True, "started": False, "running": True})
        threading.Thread(target=poller.discover_flow, daemon=True).start()
        return self._send_json({"ok": True, "started": True})

    def _post_settings(self, body):
        """Merge app settings into the shared store. Accepts {key, value} or a
        bulk {settings: {...}}; a null value deletes the key. Values are strings
        (the frontend mirrors its localStorage here), capped for safety."""
        with self._SETTINGS_LOCK:          # a reload can send two updates at once
            return self._post_settings_locked(body)

    def _post_settings_locked(self, body):
        cur = self._settings_load()
        updates = {}
        if isinstance(body.get("settings"), dict):
            updates = body["settings"]
        elif "key" in body:
            updates = {body.get("key"): body.get("value")}
        if not isinstance(updates, dict):
            return self._send_json({"ok": False, "error": "ungültige Daten"}, 400)
        changed = 0
        for k, v in updates.items():
            if not isinstance(k, str) or not k or len(k) > 128:
                continue
            if v is None:
                if k in cur:
                    del cur[k]; changed += 1
            else:
                sv = v if isinstance(v, str) else json.dumps(v)
                if len(sv) > 100000:          # guard against runaway values
                    continue
                if cur.get(k) != sv:
                    cur[k] = sv; changed += 1
        if len(cur) > 2000:                   # hard cap on number of keys
            return self._send_json({"ok": False, "error": "zu viele Einstellungen"}, 400)
        if changed:
            self.store.kv_set(self.SETTINGS_KEY, json.dumps(cur))
        return self._send_json({"ok": True, "changed": changed, "settings": cur})

    def _post_automeasure(self, kind, body):
        """Arm/disarm the active night-setback. Only writes thermostats in live
        mode; demo returns a simulated view and changes nothing real."""
        if self.ctx.mode == "demo":
            return self._send_json(_demo_automeasure())
        if self.ctx.mode != "live":
            return self._send_json({"ok": False, "error": "nur im Live-Modus verfügbar"}, 400)
        try:
            client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
        except Exception as exc:
            return self._send_json({"ok": False, "error": str(exc)}, 200)
        if kind == "arm":
            res = _am_arm(self.store, body or {})
            # if we are already inside the night window, start right away
            try:
                automeasure_tick(client, self.store)
            except Exception as exc:
                print(f"[automeasure] arm tick: {exc}", file=sys.stderr)
            return self._send_json({"ok": True, **compute_automeasure(self.store)})
        if kind == "disarm":
            return self._send_json({"ok": True, **_am_disarm(self.store, client)})
        return self._send_json({"ok": False, "error": "unknown"}, 400)

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
                return self._send_json(self._health())
            if path == "/api/boot":
                return self._send_json(self._boot(qs))
            if path == "/api/perf":
                return self._send_json(self._perf(qs))
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
                    climate = _demo_climate()
                    # demo: the open bathroom window has been open for 14 minutes
                    wsince = {r["room"]: int(time.time()) - 14 * 60 for r in climate if r.get("windows_open")}
                    return self._send_json({"demo": True, "window_since": wsince,
                        **compute_heating_diag(climate, hp, cyc)})
                if self.ctx.mode != "live":
                    return self._send_json({"ok": False, "error": "nur im Live-Modus verfügbar"}, 400)
                try:
                    client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
                    climate = client.list_climate(self.cfg.get("contact_room_map"))
                except Exception as exc:
                    return self._send_json({"ok": False, "error": str(exc)}, 200)
                try:
                    wsince = window_open_since(self.store)
                except Exception:
                    wsince = {}
                return self._send_json({"demo": False, "window_since": wsince,
                    **compute_heating_diag(climate, hp, cyc)})
            if path == "/api/climate/raw":
                # diagnostic: raw thermostat service states, to find the exact
                # heating-demand field for this user's devices.
                if self.ctx.mode == "demo":
                    return self._send_json({"demo": True, "devices": [
                        {"device": "demo-rcc-wz", "model": "ROOM_CLIMATE_CONTROL", "name": "Wohnzimmer",
                         "room": "Wohnzimmer", "serviceIds": ["RoomClimateControl", "TemperatureLevel"],
                         "states": {"RoomClimateControl": {"@type": "climateControlState", "setpointTemperature": 23.0,
                                     "operationMode": "MANUAL", "roomControlMode": "HEATING", "summerMode": False,
                                     "hasDemand": True, "away": False},
                                    "TemperatureLevel": {"@type": "temperatureLevelState", "temperature": 21.1}}}]})
                if self.ctx.mode != "live":
                    return self._send_json({"ok": False, "error": "nur im Live-Modus verfügbar"}, 400)
                try:
                    client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
                    return self._send_json({"ok": True, "demo": False, "devices": client.climate_raw()})
                except Exception as exc:
                    return self._send_json({"ok": False, "error": str(exc)}, 200)
            if path == "/api/heating/curve":
                # the real heating curve (flow vs. outdoor) from logged samples
                # plus the live operating point, with a concrete recommendation.
                # `range` picks the window: today / yesterday / all, else `days`=N.
                rng = (qs.get("range", [""])[0] or "").lower()
                now = int(time.time())
                cd, since, until, label = 30, None, None, rng
                if rng == "today":
                    since, until, cd = _local_midnight(now), now, 1
                elif rng == "yesterday":
                    t0 = _local_midnight(now); since, until, cd = t0 - 86400, t0, 1
                elif rng in ("all", "gesamt", "total"):
                    since, until, label = 0, now, "all"
                else:
                    try:
                        cd = max(1, min(3650, int(qs.get("days", ["30"])[0])))
                    except ValueError:
                        cd = 30
                    since, until, label = now - cd * 86400, now, f"{cd}d"
                return self._send_json({"demo": self.ctx.mode == "demo",
                    **compute_heating_curve(self.store, cd, self._hp_live(),
                                            since=since, until=until, range_label=label)})
            if path == "/api/heating/timeseries":
                td = int(qs.get("days", ["4"])[0])
                if self.ctx.mode == "demo":
                    return self._send_json({"demo": True, **_demo_timeseries(td)})
                return self._send_json({"demo": False,
                    **compute_heat_timeseries(self.store, td)})
            if path == "/api/rooms/timeseries":
                try:
                    rd = max(0.007, min(14.0, float(qs.get("days", ["2"])[0])))
                except ValueError:
                    rd = 2.0
                if self.ctx.mode == "demo":
                    return self._send_json(_demo_room_timeseries(rd))
                # log a fresh per-room sample on demand (if the last one is stale),
                # so the chart shows something immediately instead of waiting 10 min
                try:
                    if int(time.time()) - self.store.room_log_last_ts() >= 120:
                        self._log_rooms_now()
                except Exception:
                    pass
                return self._send_json({"demo": False,
                    **compute_room_timeseries(self.store, rd)})
            if path == "/api/thermal":
                # learning per-room thermal model (RC) + heat-demand ranking
                try:
                    tdy = max(1, min(60, int(qs.get("days", ["14"])[0])))
                except ValueError:
                    tdy = 14
                if self.ctx.mode == "demo":
                    return self._send_json(_demo_thermal(tdy))
                try:
                    if int(time.time()) - self.store.room_log_last_ts() >= 120:
                        self._log_rooms_now()
                except Exception:
                    pass
                return self._send_json({"demo": False,
                    **compute_thermal_model(self.store, tdy)})
            if path == "/api/observation":
                if self.ctx.mode == "demo":
                    return self._send_json(_demo_observation())
                try:
                    if int(time.time()) - self.store.room_log_last_ts() >= 120:
                        self._log_rooms_now()
                except Exception:
                    pass
                return self._send_json({"demo": False, **compute_observation(self.store)})
            if path == "/api/heatload":
                try:
                    dc = float(qs.get("design", [str(DESIGN_OUTDOOR_C)])[0])
                except ValueError:
                    dc = DESIGN_OUTDOOR_C
                try:
                    sk = float(qs.get("spread", ["5"])[0])
                except ValueError:
                    sk = 5.0
                if self.ctx.mode == "demo":
                    return self._send_json(_demo_heatload(dc, sk))
                return self._send_json({"demo": False, **compute_heatload(self.store, None, dc, sk)})
            if path == "/api/settings":
                # device/browser-independent app settings (single source of truth
                # on the bridge; every device loads from here and writes back)
                return self._send_json({"ok": True, "settings": self._settings_load()})
            if path == "/api/automeasure":
                if self.ctx.mode == "demo":
                    return self._send_json(_demo_automeasure())
                return self._send_json({"demo": False, **compute_automeasure(self.store)})
            if path == "/api/optimize":
                if self.ctx.mode == "demo":
                    return self._send_json(_demo_optimize())
                try:
                    if int(time.time()) - self.store.room_log_last_ts() >= 120:
                        self._log_rooms_now()
                except Exception:
                    pass
                return self._send_json({"demo": False, **compute_optimize(self.store)})
            if path == "/api/windows":
                wd = int(qs.get("days", ["3"])[0])
                if self.ctx.mode == "demo":
                    return self._send_json(_demo_window_awareness(wd))
                current = None
                try:
                    client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
                    current = client.list_window_contacts(self.cfg.get("contact_room_map"))
                except Exception:
                    current = None
                return self._send_json({"demo": False,
                    **compute_window_awareness(self.store, wd, current)})
            if path == "/api/contacts":
                # window/door contacts + their (effective) room, for the
                # "re-home a contact" mapping UI. Rooms list = thermostat rooms.
                cmap = self.cfg.get("contact_room_map") or {}
                if self.ctx.mode == "demo":
                    dc = _demo_climate()
                    contacts = []
                    for r in dc:
                        for w in (r.get("windows") or []):
                            did = f"demo-{w['name']}"
                            ov = cmap.get(did) or cmap.get(w["name"].lower())
                            contacts.append({"id": did, "name": w["name"],
                                             "room": ov or r["room"], "shc_room": r["room"],
                                             "moved": bool(ov), "open": w.get("open", False),
                                             "door": w.get("door", False)})
                    rooms_list = [r["room"] for r in dc]
                    return self._send_json({"demo": True, "contacts": contacts,
                                            "rooms": rooms_list, "map": cmap})
                if self.ctx.mode != "live":
                    return self._send_json({"ok": False, "error": "nur im Live-Modus verfügbar"}, 400)
                try:
                    client = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
                    contacts = client.list_window_contacts(cmap)
                    rooms_list = sorted({r["room"] for r in client.list_climate(cmap)})
                except Exception as exc:
                    return self._send_json({"ok": False, "error": str(exc)}, 200)
                return self._send_json({"demo": False, "contacts": contacts,
                                        "rooms": rooms_list, "map": cmap})
            if path == "/api/heating/devicecurve":
                # read the device's configured 2-point heating curve from HomeCom
                if self.ctx.mode == "demo":
                    return self._send_json({"ok": True, "demo": True, "found": True,
                        "path": "/resource/heatingCircuits/hc1/heatingCurve",
                        "points": [{"outdoor": 20, "flow": 22}, {"outdoor": -10, "flow": 39}],
                        "p20": 22, "pm10": 39})
                client = self.ctx.homecom_client()
                if not client:
                    return self._send_json({"ok": False, "error": "nicht mit HomeCom verbunden"}, 200)
                gid = qs.get("gateway", [self.cfg.get("homecom_gateway", "")])[0]
                try:
                    return self._send_json({"ok": True, **client.read_curve(gid)})
                except Exception as exc:
                    return self._send_json({"ok": False, "error": str(exc)}, 200)
            if path == "/api/heatpump":
                st = dict(self.ctx.hp_state)
                st["available"] = bool(st) and st.get("energy_kwh") is not None or bool(st.get("last_poll"))
                st["connected"] = bool(self.cfg.get("homecom_refresh_token"))
                return self._send_json(st)
            if path == "/api/appliances":
                return self._send_json(self._appliances_payload())
            if path == "/api/meter":
                return self._send_json({"readings": self.store.meter_list()})
            if path == "/api/products":
                prods = self.store.products_list() or PRODUCT_CATALOG
                return self._send_json({"products": prods,
                                        "glossary": [{"term": t, "text": x} for t, x in PRODUCT_GLOSSARY]})
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
            if path == "/api/fronius":
                return self._send_json(self._fronius_payload())
            if path == "/api/calendar":
                try:
                    cdays = int(qs.get("days", ["7"])[0])
                except ValueError:
                    cdays = 7
                return self._send_json(compute_calendar(self.ctx, cdays, force=qs.get("refresh", ["0"])[0] == "1"))
            if path == "/api/awb/streets":
                if awb_koeln is None:
                    return self._send_json({"ok": False, "error": "AWB-Modul fehlt (bridge/awb_koeln.py)."})
                try:
                    res = awb_koeln.find_address(qs.get("street", [""])[0], qs.get("nr", [""])[0])
                    return self._send_json({"ok": True, "results": res})
                except Exception as exc:
                    return self._send_json({"ok": False, "error": str(exc)})
            if path == "/api/awb/config":
                ent = awb_load(self.ctx) if self.cfg.get("awb_street_code") else None
                today_ = datetime.now().date()
                nxt = [{"date": d["date"].isoformat(), "label": d["label"], "color": d["color"], "type": d["type"]}
                       for d in (ent or {}).get("dates") or [] if d["date"] >= today_][:8]
                return self._send_json({"ok": True, "available": awb_koeln is not None,
                                        "configured": bool(self.cfg.get("awb_street_code")),
                                        "label": self.cfg.get("awb_label") or "", "next": nxt,
                                        "error": (ent or {}).get("error"),
                                        "types": sorted({d["type"] for d in (ent or {}).get("dates") or []})})
            if path == "/api/calendar/config":
                urls = [u for u in (self.cfg.get("calendar_urls") or []) if isinstance(u, str)]
                return self._send_json({"ok": True, "available": calendar_ics is not None,
                                        "urls": [calendar_ics.mask_url(u) if calendar_ics else "…" for u in urls],
                                        "count": len(urls)})
            if path == "/api/pv":
                try:
                    pdays = max(1, min(400, int(qs.get("days", ["30"])[0])))
                except ValueError:
                    pdays = 30
                price, feedin = self._pv_prices(qs)
                return self._send_json(self.ctx.calc_get(
                    ("pv", pdays, price, feedin), 60,
                    lambda: compute_pv(self.store, pdays, price, feedin)))
            if path == "/api/pvweather":
                def fq(name):
                    try:
                        v = float(qs.get(name, [""])[0])
                        return v if math.isfinite(v) else None
                    except ValueError:
                        return None
                try:
                    wdays = max(1, min(400, int(qs.get("days", ["30"])[0])))
                except ValueError:
                    wdays = 30
                lat_, lon_ = fq("lat"), fq("lon")
                return self._send_json(compute_pv_weather(self.ctx, lat_, lon_, wdays, force="force" in qs))
            if path == "/api/geocode":
                name = (qs.get("name", [""])[0] or "").strip()
                if len(name) < 2:
                    return self._send_json({"ok": False, "error": "Bitte mindestens 2 Buchstaben eingeben."})
                if not weather:
                    return self._send_json({"ok": False, "error": "Wetter-Modul fehlt (bridge/weather.py)."})
                try:
                    return self._send_json({"ok": True, "places": weather.geocode(name)})
                except Exception as exc:
                    return self._send_json({"ok": False, "error": f"Ortssuche nicht erreichbar ({exc})."})
            if path == "/api/fronius/discover":
                return self._send_json(self._fronius_discover(qs))
            if path == "/api/fronius/probe":
                return self._send_json(self._fronius_probe(qs))
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
            if path == "/api/homecom/diag":
                return self._send_json(homecom_diag(self.ctx))
            if path == "/api/homecom/probe":
                client = self.ctx.homecom_client()
                if not client:
                    return self._send_json({"error": "nicht mit HomeCom verbunden"}, 400)
                gid = qs.get("gateway", [self.cfg.get("homecom_gateway", "")])[0]
                return self._send_json({"gateway": gid, "results": client.probe(gid)})
            if path == "/api/heatpump/roomsync":
                # Per-room Soll/Ist/Feuchte (SHC thermostats) + a probe of the heat
                # pump's API: does it accept a MEASURED room temperature, or only a
                # room setpoint? Honest, device-specific answer.
                try:
                    if self.ctx.mode == "demo":
                        climate, controls = _demo_climate(), _demo_controls()
                    else:
                        cl = SHCClient(self.cfg.get("shc_ip", ""), self.cfg["cert"], self.cfg["key"])
                        climate = cl.list_climate(self.cfg.get("contact_room_map"))
                        hc = self.ctx.homecom_client()
                        controls = hc.read_controls(self.cfg.get("homecom_gateway", "")) if hc else []
                except Exception as exc:
                    return self._send_json({"ok": False, "error": str(exc)}, 200)
                rooms = [{"room": r.get("room"), "ist": r.get("temp"), "soll": r.get("setpoint"),
                          "feuchte": r.get("humidity"), "valve": r.get("valve"),
                          "heating": r.get("heating")}
                         for r in climate
                         if str(r.get("roomControlMode") or "HEATING").upper() != "OFF"]
                cls = _classify_room_inputs(controls)
                return self._send_json({"ok": True, "demo": self.ctx.mode == "demo",
                                        "rooms": rooms, "connected_wp": bool(controls), **cls})
            if path == "/api/homecom/controls":
                # discover settable heat-pump resources (heating curve, modes,
                # setpoints) with their current value + writeable/range
                if self.ctx.mode == "demo":
                    ctrls = _demo_controls()
                    for c in ctrls:
                        c["label"] = _control_label(c["path"])
                    return self._send_json({"ok": True, "demo": True, "controls": ctrls})
                client = self.ctx.homecom_client()
                if not client:
                    return self._send_json({"ok": False, "error": "nicht mit HomeCom verbunden"}, 200)
                gid = qs.get("gateway", [self.cfg.get("homecom_gateway", "")])[0]
                try:
                    ctrls = client.read_controls(gid)
                    for c in ctrls:
                        c["label"] = _control_label(c["path"])
                    return self._send_json({"ok": True, "controls": ctrls, "gateway": gid})
                except Exception as exc:
                    return self._send_json({"ok": False, "error": str(exc)}, 200)
            days = int(qs.get("days", ["60"])[0])
            price = round(float(qs.get("price", [self.cfg.get("price_per_kwh", 0.35)])[0]), 4)
            if path == "/api/analytics" or path == "/api/summary":
                return self._send_json(self.ctx.core("analytics", days, price))
            if path == "/api/overview":
                return self._send_json(self.ctx.core("overview", days, price))
            if path == "/api/heatpump/analytics":
                return self._send_json(self.ctx.core("hpanalytics", days, price))
            if path == "/api/series":
                device = qs.get("device", ["all"])[0]
                since = int(time.time()) - days * 86400
                rows = self.store.samples_since(since, device)
                return self._send_json({"device": device, "samples": rows})
            if path == "/api/loadpeaks":
                try:
                    lpd = max(0.5, min(31.0, float(qs.get("days", ["7"])[0])))
                except ValueError:
                    lpd = 7.0
                return self._send_json(self.ctx.calc_get(
                    ("loadpeaks", round(lpd, 2)), 60,
                    lambda: compute_load_peaks(self.store, lpd, self._hp_live())))
            if path == "/api/abgleich":
                return self._send_json(self._balance("force" in qs))
            if path == "/api/heatpump/opstate":
                return self._send_json(self._opstate("force" in qs))
            if path == "/api/heatpump/flow":
                return self._send_json(self._flow_payload())
            if path == "/api/heatpump/dhwimpact":
                try:
                    dwd = max(1.0, min(60.0, float(qs.get("days", ["14"])[0])))
                except ValueError:
                    dwd = 14.0
                return self._send_json(self.ctx.calc_get(
                    ("dhwimpact", round(dwd, 2)), 120,
                    lambda: compute_dhw_impact(self.store, dwd, self._hp_live())))
            if path == "/api/heatpump/coptheory":
                try:
                    ctd = max(3.0, min(400.0, float(qs.get("days", ["30"])[0])))
                except ValueError:
                    ctd = 30.0
                raw_pts = qs.get("pts", [""])[0]
                return self._send_json(self.ctx.calc_get(
                    ("coptheory", round(ctd, 1), raw_pts), 120,
                    lambda: compute_hp_cop_theory(self.store, ctd, parse_hp_spec(raw_pts), self._hp_live())))
            if path == "/api/heatpump/dhwtank":
                try:
                    dtd = max(2.0, min(60.0, float(qs.get("days", ["14"])[0])))
                except ValueError:
                    dtd = 14.0
                return self._send_json(self.ctx.calc_get(
                    ("dhwtank", round(dtd, 2)), 120, lambda: compute_dhw_tank(self.store, dtd)))
            if path == "/api/heatpump/day":
                dts = (qs.get("date", [""])[0] or "").strip()[:10]
                return self._send_json(self.ctx.calc_get(
                    ("hpday", dts or "today"), 45,
                    lambda: compute_hp_day(self.store, dts or None, self._hp_live())))
            if path == "/api/heatpump/trend":
                try:
                    trd = max(7, min(90, int(qs.get("days", ["21"])[0])))
                except ValueError:
                    trd = 21
                return self._send_json(self.ctx.calc_get(
                    ("hptrend", trd), 300,
                    lambda: compute_hp_trend(self.store, trd, self._hp_live())))
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
    _STATIC_TYPES = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".webmanifest": "application/manifest+json",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".png": "image/png",
    }
    _static_cache: dict = {}        # path -> (signature, body, gzip or None, etag)
    _static_lock = threading.Lock()

    @staticmethod
    def _file_sig(full: str) -> str:
        st = os.stat(full)
        return f"{st.st_mtime_ns:x}-{st.st_size:x}"

    def _asset_version(self) -> str:
        """Short tag that changes whenever app.js changes – used in its URL."""
        try:
            return hashlib.md5(self._file_sig(os.path.join(self.frontend_dir, "app.js")).encode()).hexdigest()[:10]
        except OSError:
            return "0"

    def _static(self, path, qs=None):
        """Serve the frontend so that code is ALWAYS current and yet almost
        never re-downloaded:
          • index.html (and anything requested without a version) must be
            revalidated on every load – answered with a tiny 304 when unchanged;
          • index.html points to app.js under a URL that carries the file's
            version (app.js?v=…); that response may be cached forever, because
            a changed app.js gets a new URL.
        The old headers ("no-store") made the phone download all 850 kB again
        on every single open. Text is sent gzip-compressed."""
        if path == "/" or path == "":
            path = "/index.html"
        # prevent path traversal
        safe = os.path.normpath(path).lstrip("/\\")
        full = os.path.join(self.frontend_dir, safe)
        if not full.startswith(self.frontend_dir) or not os.path.isfile(full):
            self.send_error(404, "Not found")
            return
        ext = os.path.splitext(full)[1]
        ctype = self._STATIC_TYPES.get(ext, "application/octet-stream")
        is_html = ext == ".html"
        try:
            sig = self._file_sig(full) + ("|" + self._asset_version() if is_html else "")
        except OSError:
            self.send_error(404, "Not found")
            return
        with self._static_lock:
            hit = self._static_cache.get(full)
            if not hit or hit[0] != sig:
                with open(full, "rb") as fh:
                    data = fh.read()
                if is_html:          # point the page at the versioned script URL
                    data = data.replace(b'src="app.js"', b'src="app.js?v=' + self._asset_version().encode() + b'"')
                text = ext in (".html", ".js", ".css", ".json", ".svg", ".webmanifest")
                gz = gzip.compress(data, 6) if (text and len(data) >= 1024) else None
                etag = '"' + hashlib.md5(sig.encode()).hexdigest()[:16] + '"'
                hit = (sig, data, gz, etag)
                self._static_cache[full] = hit
        _sig, data, gz, etag = hit
        versioned = bool(qs and qs.get("v")) and not is_html and safe != "sw.js"
        cache = ("public, max-age=31536000, immutable" if versioned
                 else "no-cache")            # = keep a copy, but ask before using it
        headers = {"Cache-Control": cache, "ETag": etag}
        if (self.headers.get("If-None-Match") or "").strip() == etag:
            try:
                self.send_response(304)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()            # a 304 never has a body
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                self.close_connection = True
            return
        self._send_bytes(200, data, ctype, headers, gz=gz, compress=gz is not None)


class _QuietServer(ThreadingHTTPServer):
    """Browsers close kept-alive connections at will (HTTP/1.1) – that is
    normal and not worth a traceback in the console."""

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError,
                            socket.timeout, TimeoutError)):
            return
        super().handle_error(request, client_address)


def make_server(host, port, ctx, frontend_dir):
    handler = type("BoundHandler", (Handler,), {
        "ctx": ctx, "frontend_dir": frontend_dir,
    })
    httpd = _QuietServer((host, port), handler)
    return httpd


# --------------------------------------------------------------------------- #
# Heat pump: connection test (Setup → Wärmepumpe → "Verbindung testen", and
# `python3 shc_bridge.py diag` in a terminal)
# --------------------------------------------------------------------------- #
def _net_probe(host: str, port: int = 443, timeout: float = 8.0) -> dict:
    """DNS → TCP → TLS to one host, each step timed; stops at the first failure."""
    out = {"host": host}
    ms = lambda t: round((time.time() - t) * 1000)
    t0 = time.time()
    try:
        ips = []
        for info in socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM):
            if info[4][0] not in ips:
                ips.append(info[4][0])
        out["dns"] = {"ok": True, "ms": ms(t0), "ips": ips[:4]}
    except OSError as exc:
        out["dns"] = {"ok": False, "ms": ms(t0), "error": str(exc) or exc.__class__.__name__}
        return out
    t1 = time.time()
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError as exc:
        out["tcp"] = {"ok": False, "ms": ms(t1), "error": str(exc) or exc.__class__.__name__}
        return out
    out["tcp"] = {"ok": True, "ms": ms(t1), "ip": sock.getpeername()[0]}
    t2 = time.time()
    try:
        with ssl.create_default_context().wrap_socket(sock, server_hostname=host) as tls:
            out["tls"] = {"ok": True, "ms": ms(t2), "version": tls.version(),
                          "cipher": (tls.cipher() or [None])[0]}
    except (OSError, ssl.SSLError) as exc:
        out["tls"] = {"ok": False, "ms": ms(t2), "error": str(exc) or exc.__class__.__name__}
        try:
            sock.close()
        except OSError:
            pass
    return out


def _homecom_hosts() -> list:
    if homecom:
        return [(homecom.OAUTH_HOST, "Anmeldung (SingleKey ID)"), (homecom.API_HOST, "Daten (HomeCom)")]
    return [("singlekey-id.com", "Anmeldung (SingleKey ID)"),
            ("pointt-api.bosch-thermotechnology.com", "Daten (HomeCom)")]


def _homecom_verdict(d: dict) -> tuple:
    """(level ok/warn/error, one German sentence, tips) for the test result."""
    tls13 = d.get("tls13")
    for n in d.get("net") or []:
        h = n["host"]
        if not (n.get("dns") or {}).get("ok"):
            return ("error", f"Der Rechner kann {h} nicht auflösen (DNS).",
                    ["Internet am Rechner der Bridge prüfen (z. B. im Browser eine Seite öffnen).",
                     "Router/DNS neu starten; ein VPN oder Werbefilter kann Namen blockieren."])
        if not (n.get("tcp") or {}).get("ok"):
            return ("error", f"{h} ist über Port 443 nicht erreichbar.",
                    ["Internet des Rechners prüfen.",
                     "Firewall/Filter (Little Snitch, Router-Sicherheitsfunktion, VPN) prüfen.",
                     "Falls alles andere geht: Störung bei Bosch – später erneut testen."])
        if not (n.get("tls") or {}).get("ok"):
            tips = [f"Gegenprobe im Terminal: curl -sS -o /dev/null -w '%{{http_code}}\\n' https://{h}/"]
            if not tls13:
                tips.insert(0, f"Dein Python ({d.get('python')}, {d.get('ssl')}) kann kein TLS 1.3. Klappt die "
                               "curl-Gegenprobe, liegt es am Python: ein aktuelles Python von python.org "
                               "installieren, danach im Ordner Programme → Python 3.x einmal „Install "
                               "Certificates.command“ doppelklicken. Die Startskripte nehmen es dann automatisch.")
            else:
                tips.append("Meist eine Störung bei Bosch oder ein Filter im Netz (VPN, Jugendschutz, Router).")
            return ("error", f"Die Verbindung zu {h} scheitert beim Verschlüsseln (TLS).", tips)
    if not d.get("configured"):
        return ("warn", "Das Netz zur Bosch-Cloud ist in Ordnung – HomeCom ist aber noch nicht verbunden.",
                ["Im Setup unter „Wärmepumpe (HomeCom)“ verbinden."])
    tok = d.get("token") or {}
    if tok and not tok.get("ok"):
        if tok.get("expired"):
            return ("error", "Die HomeCom-Anmeldung ist abgelaufen.",
                    ["Im Setup unter „Wärmepumpe (HomeCom)“ neu verbinden (Login-Link → Code einfügen).",
                     "Passiert das öfter: Lief die Bridge zweimal (z. B. update-macos.command gestartet, während "
                     "die alte noch lief)? Dann verbraucht eine die Anmeldung der anderen. Ab v202 verhindert die "
                     "Bridge das und die Startskripte beenden die alte vorher."])
        return ("error", f"Die Anmeldung bei Bosch klappt gerade nicht: {tok.get('error')}",
                ["Später erneut testen; bleibt es, im Setup neu verbinden."])
    api = d.get("api") or {}
    st = api.get("status")
    if api and not api.get("ok"):
        if st == 429:
            return ("warn", "Bosch drosselt gerade die Abfragen (zu viele Anfragen).",
                    ["Das legt sich meist nach einiger Zeit – die Bridge fragt danach wieder alle 5 Minuten."])
        if st == 401:
            return ("error", "Bosch lehnt die Anmeldung ab (HTTP 401).", ["Im Setup neu verbinden."])
        if st in (403, 404):
            return ("warn", f"Die Bosch-Cloud kennt die Werte des Gateways gerade nicht (HTTP {st}).",
                    ["In der HomeCom-App prüfen, ob die Wärmepumpe online ist (Internet-Modul/WLAN der Wärmepumpe)."])
        if st and st >= 500:
            return ("warn", f"Störung bei Bosch (HTTP {st}).", ["Später erneut testen."])
        return ("error", f"Datenabruf fehlgeschlagen: {api.get('error') or ('HTTP ' + str(st))}", [])
    p = d.get("poller") or {}
    if api.get("ok"):
        if p.get("last_error"):
            return ("ok", "Verbindung und Anmeldung funktionieren jetzt. Der letzte Abruf war fehlgeschlagen – "
                          "die Bridge versucht es automatisch erneut.",
                    [f"Letzter Fehler: {p.get('last_error')}"])
        return ("ok", "Verbindung, Anmeldung und Datenabruf funktionieren.", [])
    return ("warn", "Kein vollständiger Test möglich.", [])


def homecom_diag(ctx: "Runtime", live: bool = True) -> dict:
    """Where does the heat-pump data get stuck? Network per host (DNS, TCP,
    TLS), then – with the bridge's own login – one token check and one data
    request. ``live=False`` (terminal) leaves the login alone, so a running
    bridge's single-use refresh token is never rotated from a second process."""
    cfg, store = ctx.cfg, ctx.store
    now = int(time.time())
    out = {"ok": True, "ts": now, "python": sys.version.split()[0], "executable": sys.executable,
           "ssl": ssl.OPENSSL_VERSION, "tls13": bool(getattr(ssl, "HAS_TLSv1_3", False)),
           "module": homecom is not None, "configured": bool(cfg.get("homecom_refresh_token")),
           "gateway": cfg.get("homecom_gateway") or None}
    hp = ctx.hp
    out["poller"] = {"running": bool(hp and hp.is_alive()), "interval": getattr(hp, "interval", None),
                     "last_poll": getattr(hp, "last_poll", None), "last_error": getattr(hp, "last_error", None),
                     "fails": getattr(hp, "fails", 0)}
    try:
        rows = store.hp_samples_since(now - 86400)
    except Exception:
        rows = []
    keys = ("energy_kwh", "heat_kwh", "supply_c", "outdoor_c")
    good = [r for r in rows if any(r.get(k) is not None for k in keys)]
    out["samples"] = {"n_24h": len(rows), "n_good_24h": len(good),
                      "last_ts": rows[-1]["ts"] if rows else None, "last_good_ts": store.hp_last_good_ts()}
    hosts = _homecom_hosts()
    res = [None] * len(hosts)

    def probe(i, h):
        res[i] = {**_net_probe(h[0]), "role": h[1]}
    ths = [threading.Thread(target=probe, args=(i, h), daemon=True) for i, h in enumerate(hosts)]
    for t in ths:
        t.start()
    for t in ths:
        t.join(30)
    out["net"] = [r for r in res if r]
    net_ok = all((n.get("tls") or {}).get("ok") for n in out["net"]) and len(out["net"]) == len(hosts)
    if live and net_ok and out["configured"] and homecom:
        client = ctx.homecom_client()
        if client:
            t0 = time.time()
            try:
                client._valid_token()
                out["token"] = {"ok": True, "ms": round((time.time() - t0) * 1000)}
            except Exception as exc:
                out["token"] = {"ok": False, "ms": round((time.time() - t0) * 1000), "error": str(exc),
                                "expired": isinstance(exc, getattr(homecom, "AuthExpiredError", ()))}
            if out["token"]["ok"] and out["gateway"]:
                t0 = time.time()
                try:
                    status, body = client.raw(out["gateway"], "/resource/heatSources/emon/totalConsumption")
                    out["api"] = {"ok": status == 200, "status": status, "ms": round((time.time() - t0) * 1000),
                                  "body": body[:240]}
                except Exception as exc:
                    out["api"] = {"ok": False, "ms": round((time.time() - t0) * 1000), "error": str(exc)}
    level, text, tips = _homecom_verdict(out)
    out.update({"level": level, "verdict": text, "tips": tips})
    return out


def cmd_diag(args, cfg):
    """Terminal version of the connection test (no login – see homecom_diag)."""
    store = Store(cfg["db"])
    ctx = Runtime(store, cfg)
    d = homecom_diag(ctx, live=False)
    fmt_ts = lambda t: datetime.fromtimestamp(t).strftime("%d.%m. %H:%M") if t else "–"
    print(f"\nPython {d['python']} ({d['executable']})")
    print(f"SSL    {d['ssl']} · TLS 1.3: {'ja' if d['tls13'] else 'NEIN'}")
    print(f"HomeCom verbunden: {'ja' if d['configured'] else 'nein'} · Gateway {d['gateway'] or '–'}")
    sm = d["samples"]
    print(f"Wärmepumpen-Werte: letzte echte Messung {fmt_ts(sm['last_good_ts'])} · "
          f"letzte 24 h: {sm['n_good_24h']} von {sm['n_24h']} Abfragen mit Werten\n")
    for n in d["net"]:
        parts = []
        for step in ("dns", "tcp", "tls"):
            x = n.get(step)
            if not x:
                continue
            extra = f" {x.get('version')}" if step == "tls" and x.get("ok") else ""
            parts.append(f"{step.upper()} {'ok' if x['ok'] else 'FEHLER'} {x['ms']} ms{extra}"
                         + ("" if x["ok"] else f" ({x.get('error')})"))
        print(f"{n['host']:40s} {' · '.join(parts)}")
    print(f"\n=> {d['verdict']}")
    for t in d.get("tips") or []:
        print(f"   - {t}")
    print()


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


def _instance_lock(cfg_path: str):
    """Exclusive lock next to config.json for the lifetime of this process. A
    second bridge on the same config would use the same single-use HomeCom/AEG
    refresh tokens – the first refresh of one process makes the other one's token
    invalid and Bosch then revokes the login. Returns the open file (keep it
    referenced), or None where file locks are unavailable."""
    try:
        import fcntl
    except ImportError:                      # Windows: rely on the port check
        return None
    lock_path = os.path.join(os.path.dirname(os.path.abspath(cfg_path)) or ".", ".bridge.lock")
    fh = open(lock_path, "a+")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.seek(0)
        other = (fh.read().strip() or "?")[:20]
        fh.close()
        print("\n  ⚠️  Die Bridge läuft bereits" + (f" (PID {other})" if other != "?" else "") + ".\n"
              "  Eine zweite würde die Anmeldung bei Bosch (HomeCom) und AEG verbrauchen –\n"
              "  deshalb startet diese hier nicht. Zum Neustart das andere Terminal-Fenster\n"
              "  schließen (oder dort Strg+C) oder update-macos.command / start-macos.command\n"
              "  benutzen: sie beenden die laufende Bridge vorher selbst.\n", file=sys.stderr)
        sys.exit(3)
    fh.seek(0)
    fh.truncate()
    fh.write(str(os.getpid()))
    fh.flush()
    return fh


def cmd_serve(args, cfg):
    global _RUNTIME
    # one bridge per config, and the web port taken BEFORE anything talks to a
    # cloud: a second start used to refresh the HomeCom token first and only then
    # fail on the busy port – leaving the running bridge with a used-up token
    _lock_fh = None if args.demo else _instance_lock(args.config)
    store = Store(cfg["db"])
    seed_products(store)                      # keep the hardware catalog in the DB
    cfg["_config_path"] = args.config
    if args.ip:
        cfg["shc_ip"] = args.ip
    if args.price is not None:
        cfg["price_per_kwh"] = args.price

    ctx = Runtime(store, cfg)
    _RUNTIME = ctx
    frontend = args.frontend or DEFAULT_FRONTEND
    try:
        httpd = make_server(args.host, args.port, ctx, frontend)
    except OSError as exc:
        print(f"\n  ⚠️  Port {args.port} ist belegt ({exc.strerror or exc}) – läuft die Bridge schon "
              f"(z. B. als Demo)?\n  Diese hier startet nicht; die Anmeldungen bleiben unberührt.\n", file=sys.stderr)
        sys.exit(3)
    have_cert = os.path.exists(cfg["cert"]) and os.path.exists(cfg["key"])
    if args.demo:
        ctx.start_demo(days=args.demo_days)
    elif cfg.get("shc_ip") and have_cert:
        ctx.start_live()
    else:
        # not configured yet – stay idle so the web UI can pair the controller
        ctx.mode = "idle"

    # aggregate finished days in the background, then keep the core results warm
    ctx.start_rollup()
    ctx.start_warmer()

    # optional: start the heat-pump (HomeCom) poller if already connected – not
    # in the demo, which must never touch the real accounts (single-use tokens)
    if not args.demo and ctx.start_heatpump():
        print(f"  Heat pump:   HomeCom gateway {cfg.get('homecom_gateway')}")

    # optional: start the AEG / Electrolux appliance poller if already connected
    if not args.demo and ctx.start_electrolux():
        print("  Appliances:  AEG/Electrolux connected")

    # optional: PV inverter (Fronius) – demo/live already started it
    if not ctx.fr and ctx.start_fronius():
        pass
    if ctx.fr:
        print(f"  PV:          Fronius {'(Demo)' if ctx.mode == 'demo' else cfg.get('fronius_host')}")

    # optional: automatic self-update (git pull + restart when new commits land)
    if _ensure_auto_update(cfg):
        print(f"  Auto-update: on (alle {int(cfg.get('auto_update_interval', 0))} min)")

    ip_hint = local_ip()
    mode_txt = {"demo": "DEMO", "live": "LIVE (" + cfg.get("shc_ip", "") + ")",
                "idle": "IDLE – noch nicht gekoppelt, bitte Setup im Browser öffnen"}[ctx.mode]
    print("\n  Bosch Home Energy bridge running")
    print(f"  Mode:        {mode_txt}")
    print(f"  Open on this machine:  http://localhost:{args.port}/")
    print(f"  Open on your iPhone:   http://{ip_hint}:{args.port}/")
    print("  (iPhone must be on the same Wi-Fi. Press Ctrl+C to stop.)\n")
    # Terminal closed (SIGHUP) or `kill` (SIGTERM): end like Ctrl+C, so the
    # cleanup below can wait for a token refresh in flight
    def _graceful(signum, frame):
        raise KeyboardInterrupt
    for sig in ("SIGTERM", "SIGHUP"):
        if hasattr(signal, sig):
            try:
                signal.signal(getattr(signal, sig), _graceful)
            except (ValueError, OSError):
                pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping …")
    finally:
        try:
            ctx.quiesce_tokens()
        except Exception as exc:  # pragma: no cover
            print(f"[stop] {exc}", file=sys.stderr)
        ctx.stop()
        ctx.stop_fronius()
        httpd.server_close()
        if _lock_fh is not None:
            _lock_fh.close()


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

    sub.add_parser("diag", help="test the connection to the Bosch cloud (heat pump)")

    args = parser.parse_args()
    cfg = load_config(args.config)

    if args.cmd == "pair":
        cmd_pair(args, cfg)
    elif args.cmd == "serve":
        cmd_serve(args, cfg)
    elif args.cmd == "diag":
        cmd_diag(args, cfg)


if __name__ == "__main__":
    main()
