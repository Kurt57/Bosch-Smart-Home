#!/usr/bin/env python3
"""Bosch HomeCom Easy client (heat pump) – standard library only.

The Bosch Compress 6800i AW heat pump is NOT part of the local Smart Home
Controller. It is reached through Bosch' HomeCom Easy cloud:

* Login: SingleKey ID OAuth 2.0 (Authorization Code + PKCE). The public client
  constants below are the same ones the official app / the community
  ``homecom_alt`` library use – they are not secrets.
* Data:  https://pointt-api.bosch-thermotechnology.com/pointt-api/api/v1/
         gateways/{id}/resource/...

Because the redirect target is a custom app scheme, the one-time login code is
copied out of the browser by hand (see docs/HEATPUMP.md). After that the bridge
keeps a refresh token and renews the access token on its own.

Confirmed resource paths (values usually as {"value": <num>, "unitOfMeasure": ...}):
  /resource/heatSources/hs1/actualPower                 -> thermal output (kW)
  /resource/heatSources/hs1/powerPercentage             -> modulation (%)
  /resource/heatSources/electricityTotalConsumption     -> electricity (kWh, cumulative)
  /resource/dhwCircuits/waterTotalConsumption           -> hot water (m³ / kWh)
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import socket
import ssl
import threading
import time
from urllib.parse import urlencode

OAUTH_HOST = "singlekey-id.com"
API_HOST = "pointt-api.bosch-thermotechnology.com"
CLIENT_ID = "762162C0-FA2D-4540-AE66-6489F189FADC"
REDIRECT_URI = "com.bosch.tt.dashtt.pointt://app/login"
# fixed PKCE verifier (public, same as the community library / app)
CODE_VERIFIER = (
    "AZbpLzMvXigq_jz7_riwNDV8BQYT30prXGDyRHdQMo0GYre3si9YJfG4b1U-QWERtOiX_9mCJE2SAPvJMeM2yA"
)
SCOPE = (
    "openid email profile offline_access pointt.gateway.claiming "
    "pointt.gateway.removal pointt.gateway.list pointt.gateway.users "
    "pointt.gateway.resource.dashapp pointt.castt.flow.token-exchange "
    "bacon hcc.tariff.read"
)
API_BASE = "/pointt-api/api/v1/gateways/"

# candidate resource paths per metric (first that returns a number wins –
# different heat pumps expose slightly different trees)
RES = {
    "energy_kwh": ["/resource/heatSources/electricityTotalConsumption",
                   "/resource/heatSources/emon/totalConsumption"],
    "thermal_kw": ["/resource/heatSources/hs1/actualPower"],
    "modulation": ["/resource/heatSources/actualModulation",
                   "/resource/heatSources/hs1/powerPercentage"],
    "outdoor_c": ["/resource/system/sensors/temperatures/outdoor_t1"],
    "supply_c": ["/resource/heatSources/actualSupplyTemperature"],
    "return_c": ["/resource/heatSources/returnTemperature"],
}

# paths tried by the diagnostic probe (to discover what THIS gateway exposes)
PROBE_PATHS = [
    "/resource/heatSources/electricityTotalConsumption",
    "/resource/heatSources/emon/totalConsumption",
    "/resource/heatSources/hs1/actualPower",
    "/resource/heatSources/hs1/powerPercentage",
    "/resource/heatSources/actualModulation",
    "/resource/heatSources/actualSupplyTemperature",
    "/resource/heatSources/returnTemperature",
    "/resource/heatSources/actualHeatDemand",
    "/resource/heatSources/numberOfStarts",
    "/resource/heatSources/workingTime/totalSystem",
    "/resource/heatSources/hs1/numberOfStarts",
    "/resource/heatSources/hs1/operationHours",
    "/resource/heatSources/info",
    "/resource/system/sensors/temperatures/outdoor_t1",
    "/resource/system/info",
    "/resource/system/healthStatus",
    "/resource/dhwCircuits/waterTotalConsumption",
    "/resource/energy/history",
    "/resource/energy/historyHourly",
    "/resource/energy/historyEntries",
]


def _challenge() -> str:
    digest = hashlib.sha256(CODE_VERIFIER.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def authorize_url() -> str:
    """The URL the user opens in a browser to log in and obtain a code."""
    params = {
        "redirect_uri": REDIRECT_URI,
        "client_id": CLIENT_ID,
        "response_type": "code",
        "prompt": "login",
        "scope": SCOPE,
        "code_challenge_method": "S256",
        "code_challenge": _challenge(),
        "style_id": "tt_bsch",
    }
    return f"https://{OAUTH_HOST}/auth/connect/authorize?" + urlencode(params)


class HomeComError(RuntimeError):
    pass


class AuthExpiredError(HomeComError):
    """The refresh token is no longer valid – a fresh login is required."""


class HomeComNetworkError(HomeComError):
    """The Bosch cloud is not reachable or not answering properly (DNS, TCP,
    TLS, timeout, HTTP 429/5xx). Aborts the whole read – it must never turn
    into a sample full of empty values."""


class HomeComAuthError(HomeComError):
    """The access token was rejected (HTTP 401)."""


_ABORT = (HomeComNetworkError, HomeComAuthError, AuthExpiredError)
_HOST_ROLE = {OAUTH_HOST: "Anmeldung bei SingleKey ID", API_HOST: "Datenabruf HomeCom"}


def _net_error(host: str, exc: BaseException) -> HomeComNetworkError:
    """A low-level connection error as a readable German message, naming the
    host and what the bridge was doing (login vs. reading data)."""
    role = _HOST_ROLE.get(host, host)
    msg = str(exc) or exc.__class__.__name__
    if isinstance(exc, socket.gaierror):
        txt = f"Name {host} nicht auflösbar (DNS) – Internetverbindung des Rechners prüfen"
    elif isinstance(exc, ssl.SSLCertVerificationError):
        txt = (f"Zertifikat von {host} nicht prüfbar ({getattr(exc, 'verify_message', '') or msg}) – "
               "stimmen Datum und Uhrzeit des Rechners?")
    elif isinstance(exc, (socket.timeout, TimeoutError)):
        txt = (f"Zeitüberschreitung beim Verschlüsseln (TLS-Handshake) mit {host}" if "handshake" in msg.lower()
               else f"Zeitüberschreitung – {host} antwortet nicht")
    elif isinstance(exc, ConnectionRefusedError):
        txt = f"{host} lehnt die Verbindung ab"
    elif isinstance(exc, ssl.SSLError):
        txt = f"TLS-Fehler mit {host} ({getattr(exc, 'reason', None) or msg})"
    else:
        txt = f"Netzwerkfehler mit {host} ({getattr(exc, 'strerror', None) or msg})"
    return HomeComNetworkError(f"{role}: {txt}")


def _http_error(host: str, status: int) -> HomeComNetworkError:
    role = _HOST_ROLE.get(host, host)
    if status == 429:
        return HomeComNetworkError(f"{role}: HTTP 429 – Bosch drosselt gerade (zu viele Anfragen)")
    return HomeComNetworkError(f"{role}: HTTP {status} – Störung bei Bosch")


class HomeComClient:
    """Talks to SingleKey ID (OAuth) and the HomeCom gateway API.

    SingleKey ID rotates the refresh token on every refresh (single use), so a
    new token MUST be persisted. Pass ``on_token`` to be called with each new
    refresh token; the caller stores it (e.g. in config.json).
    """

    def __init__(self, refresh_token: str | None = None, on_token=None,
                 timeout: float = 20.0):
        self.refresh_token = refresh_token
        self.on_token = on_token
        self.timeout = timeout
        self._access = None
        self._access_exp = 0
        self._lock = threading.Lock()   # serialise token refreshes
        self._ctx = ssl.create_default_context()  # public hosts -> verify on

    # -- low level -------------------------------------------------------- #
    def _post_form(self, host: str, path: str, form: dict) -> dict:
        body = urlencode(form).encode("ascii")
        conn = http.client.HTTPSConnection(host, 443, timeout=self.timeout, context=self._ctx)
        try:
            try:
                conn.request("POST", path, body=body, headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                })
                resp = conn.getresponse()
                data = resp.read()
            except (OSError, http.client.HTTPException) as exc:
                raise _net_error(host, exc) from exc
            if resp.status != 200:
                if b"invalid_grant" in data:
                    raise AuthExpiredError(
                        "HomeCom-Anmeldung abgelaufen – bitte im Setup neu verbinden.")
                if resp.status == 429 or resp.status >= 500:
                    raise _http_error(host, resp.status)
                raise HomeComError(f"token endpoint HTTP {resp.status}: {data[:200]!r}")
            return json.loads(data)
        finally:
            conn.close()

    def _api_get(self, path: str):
        token = self._valid_token()
        conn = http.client.HTTPSConnection(API_HOST, 443, timeout=self.timeout, context=self._ctx)
        try:
            try:
                conn.request("GET", path, headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                })
                resp = conn.getresponse()
                data = resp.read()
            except (OSError, http.client.HTTPException) as exc:
                raise _net_error(API_HOST, exc) from exc
            if resp.status in (403, 404):
                return None  # resource not available on this device
            if resp.status == 401:
                raise HomeComAuthError("Datenabruf HomeCom: Bosch lehnt das Token ab (HTTP 401)")
            if resp.status == 429 or resp.status >= 500:
                raise _http_error(API_HOST, resp.status)
            if resp.status != 200:
                raise HomeComError(f"GET {path} -> HTTP {resp.status}: {data[:160]!r}")
            return json.loads(data) if data else None
        finally:
            conn.close()

    # -- auth ------------------------------------------------------------- #
    def exchange_code(self, code: str) -> str:
        """Exchange the one-time login code for tokens; return refresh token."""
        raw = (code or "").strip()
        val = raw
        # tolerate the user pasting the whole redirect URL
        if "code=" in raw:
            val = raw.split("code=", 1)[1].split("&", 1)[0]
        val = val.strip()
        # reject obviously-wrong pastes (e.g. the SingleKey interstitial URL,
        # which has no real ?code=… yet)
        if not val or "://" in val or "authorize" in val or "code_challenge" in val:
            raise HomeComError(
                "Kein gültiger Login-Code gefunden. Bitte die FINALE Weiterleitungs-Adresse "
                "einfügen, die 'com.bosch...://app/login?code=…' enthält (nicht die "
                "Zwischenseite 'Weiterleitung…').")
        code = val
        tok = self._post_form(OAUTH_HOST, "/auth/connect/token", {
            "grant_type": "authorization_code",
            "redirect_uri": REDIRECT_URI,
            "client_id": CLIENT_ID,
            "code": code,
            "code_verifier": CODE_VERIFIER,
        })
        self.refresh_token = tok.get("refresh_token") or self.refresh_token
        self._access = tok.get("access_token")
        self._access_exp = time.time() + int(tok.get("expires_in", 3600)) - 60
        if not self.refresh_token:
            raise HomeComError("no refresh_token in response")
        self._persist()
        return self.refresh_token

    def _persist(self):
        if self.on_token and self.refresh_token:
            try:
                self.on_token(self.refresh_token)
            except Exception:
                pass

    def _refresh(self):
        if not self.refresh_token:
            raise AuthExpiredError("nicht angemeldet (kein Refresh-Token)")
        tok = self._post_form(OAUTH_HOST, "/auth/connect/token", {
            "grant_type": "refresh_token",
            "client_id": CLIENT_ID,
            "refresh_token": self.refresh_token,
        })
        self._access = tok.get("access_token")
        self._access_exp = time.time() + int(tok.get("expires_in", 3600)) - 60
        if tok.get("refresh_token"):
            self.refresh_token = tok["refresh_token"]  # rotate -> persist!
            self._persist()
        if not self._access:
            raise HomeComError("no access_token after refresh")

    def _valid_token(self) -> str:
        with self._lock:
            if not self._access or time.time() >= self._access_exp:
                self._refresh()
            return self._access

    # -- data ------------------------------------------------------------- #
    def list_gateways(self) -> list[str]:
        data = self._api_get(API_BASE) or []
        ids = []
        for g in data if isinstance(data, list) else data.get("gateways", []):
            gid = g.get("deviceId") or g.get("id") if isinstance(g, dict) else None
            if gid:
                ids.append(gid)
        return ids

    @staticmethod
    def _num(payload):
        """Pull a number out of a Bosch resource response."""
        if payload is None:
            return None
        if isinstance(payload, (int, float)):
            return float(payload)
        if isinstance(payload, dict):
            v = payload.get("value")
            if isinstance(v, (int, float)):
                return float(v)
            # some counters return a list of {name,value}
            if isinstance(v, list) and v and isinstance(v[-1], dict) and "value" in v[-1]:
                try:
                    return float(v[-1]["value"])
                except (TypeError, ValueError):
                    return None
        return None

    def read_heatpump(self, gateway_id: str) -> dict:
        """Return the available heat-pump metrics for one gateway.

        Tailored to the Compress CS6800i AW: cumulative energy comes from the
        ``emon/totalConsumption`` resource, split into compressor / e-heater
        (electrical) and outputProduced (thermal). No native history resource,
        so day/hour history is built by the bridge from these counters.
        """
        errors = []

        def get(p):
            try:
                return self._api_get(f"{API_BASE}{gateway_id}{p}")
            except _ABORT:
                raise                      # no connection / no login: abort, never store empties
            except HomeComError as exc:
                errors.append(str(exc))
                return None

        out = {"gateway": gateway_id}

        # cumulative energy counters (kWh)
        emon = get("/resource/heatSources/emon/totalConsumption")
        vals = {}
        if isinstance(emon, dict):
            for item in emon.get("values", []) or []:
                if isinstance(item, dict):
                    for k, v in item.items():
                        if isinstance(v, (int, float)):
                            vals[k] = float(v)
        comp, eh, produced = vals.get("compressor"), vals.get("eheater"), vals.get("outputProduced")
        electrical = None
        if comp is not None or eh is not None:
            electrical = (comp or 0.0) + (eh or 0.0)
        out["energy_kwh"] = electrical        # electrical total (compressor+eheater)
        out["heat_kwh"] = produced            # thermal produced total
        out["compressor_kwh"] = comp
        out["eheater_kwh"] = eh

        # instantaneous-ish values
        out["modulation"] = self._num(get("/resource/heatSources/actualModulation"))
        out["supply_c"] = self._num(get("/resource/heatSources/actualSupplyTemperature"))
        out["return_c"] = self._num(get("/resource/heatSources/returnTemperature"))
        out["outdoor_c"] = self._num(get("/resource/system/sensors/temperatures/outdoor_t1"))
        out["starts"] = self._num(get("/resource/heatSources/numberOfStarts"))
        wt = self._num(get("/resource/heatSources/workingTime/totalSystem"))
        out["working_h"] = round(wt / 3600.0) if wt is not None else None

        # current operating mode (arrayData -> e.g. ["dhw"], ["ch"], [] )
        hd = get("/resource/heatSources/actualHeatDemand")
        mode = None
        if isinstance(hd, dict):
            vv = hd.get("values") if hd.get("values") is not None else hd.get("value")
            if isinstance(vv, list):
                mode = str(vv[0]) if vv else "off"
            elif isinstance(vv, str):
                mode = vv or "off"
        out["mode"] = mode or "off"

        # hot-water tank: actual temperature + the setpoint it is charging to.
        # Logged over time by the bridge, so a hot-water phase can be judged on
        # what the tank really did (reached its target or not) instead of a guess.
        out["dhw_c"] = self._num(get("/resource/dhwCircuits/dhw1/actualTemp"))
        out["dhw_set_c"] = self._num(get("/resource/dhwCircuits/dhw1/currentSetpoint"))
        keys = ("energy_kwh", "heat_kwh", "modulation", "supply_c", "return_c", "outdoor_c", "starts", "dhw_c")
        if all(out.get(k) is None for k in keys):
            raise HomeComError("HomeCom antwortet, liefert aber keine Werte"
                               + (f" ({errors[0]})" if errors else
                                  " – ist die Wärmepumpe online? (in der HomeCom-App prüfen)"))
        return out

    # -- operating state (read-only ground truth) ------------------------- #
    @staticmethod
    def _summarise_switch_program(res) -> dict | None:
        """Best-effort summary of a Bosch switch programme resource
        ({"switchPoints": [{"dayOfWeek","setpoint","time"}, …]}). Returns None
        when the device answers in a shape we do not recognise – the caller then
        says "not readable" rather than guessing."""
        pts = res.get("switchPoints") if isinstance(res, dict) else None
        if not isinstance(pts, list) or not pts:
            return None
        levels, reduced, comfort = set(), [], []
        for p in pts:
            if not isinstance(p, dict):
                continue
            sp = str(p.get("setpoint") or "").lower()
            t = p.get("time")
            if not sp or not isinstance(t, (int, float)):
                continue
            levels.add(sp)
            is_reduced = any(k in sp for k in ("eco", "low", "night", "reduc", "off"))
            (reduced if is_reduced else comfort).append(int(t))
        if not levels:
            return None

        def med(a):
            a = sorted(a)
            return a[len(a) // 2] if a else None

        return {"levels": sorted(levels), "n_points": len(pts),
                "has_reduced": bool(reduced),
                "reduced_start_min": med(reduced), "comfort_start_min": med(comfort)}

    def read_opstate(self, gateway_id: str) -> dict:
        """How the heating is ACTUALLY set, read from the device: the heating
        circuit's operation mode (manual = one fixed room setpoint, auto = time
        programme switching between temperature levels), those levels, and the
        hot-water mode / setpoints. A handful of targeted GETs – no tree crawl.
        Any value the device does not expose comes back as None."""
        prefix = f"{API_BASE}{gateway_id}"
        failed = 0

        def raw(path):
            nonlocal failed
            try:
                return self._api_get(prefix + path)
            except _ABORT:
                raise
            except HomeComError:
                failed += 1
                return None

        def val(path):
            res = raw(path)
            if isinstance(res, dict):
                v = res.get("value")
                return None if isinstance(v, (list, dict)) else v
            return None

        def first_child(root, default):
            res = raw(root)
            refs = res.get("references") if isinstance(res, dict) else None
            for r in refs or []:
                rid = r.get("id") if isinstance(r, dict) else None
                if isinstance(rid, str):
                    name = rid.rstrip("/").split("/")[-1]
                    if name and name not in ("heatingCircuits", "dhwCircuits"):
                        return name
            return default

        hc = first_child("/resource/heatingCircuits", "hc1")
        dhw = first_child("/resource/dhwCircuits", "dhw1")
        H = f"/resource/heatingCircuits/{hc}"
        W = f"/resource/dhwCircuits/{dhw}"
        out = {
            "gateway": gateway_id, "hc": hc, "dhw": dhw,
            "hc_mode": val(H + "/operationMode"),
            "hc_status": val(H + "/overallStatus"),
            "hc_setpoint": val(H + "/currentRoomSetpoint"),
            "hc_manual": val(H + "/temperatureRoomManual"),
            "hc_comfort": val(H + "/temperatureLevels/comfort2"),
            "hc_eco": val(H + "/temperatureLevels/eco"),
            "hc_control": val(H + "/controlType"),
            "hc_max_flow": val(H + "/maxFlowTemp"),
            "dhw_mode": val(W + "/operationMode"),
            "dhw_setpoint": val(W + "/currentSetpoint"),
            "dhw_actual": val(W + "/actualTemp"),
            "dhw_high": val(W + "/temperatureLevels/high"),
            "dhw_eco": val(W + "/temperatureLevels/eco"),
            "dhw_low": val(W + "/temperatureLevels/low"),
            "dhw_charge": val(W + "/charge"),
            "dhw_charge_dur": val(W + "/chargeDuration"),
            "program": None,
        }
        # the time programme only matters (and is only read) in auto mode
        if str(out["hc_mode"] or "").lower() == "auto":
            name = val(H + "/activeSwitchProgram") or val(H + "/currentSwitchProgram")
            res = raw(f"{H}/switchPrograms/{name}") if isinstance(name, str) and name else None
            if not isinstance(res, dict):
                first = first_child(H + "/switchPrograms", None)
                res = raw(f"{H}/switchPrograms/{first}") if first else None
            out["program"] = self._summarise_switch_program(res)
        out["failed"] = failed
        out["readable"] = out["hc_mode"] is not None or out["dhw_mode"] is not None
        return out

    def raw(self, gateway_id: str, resource_path: str):
        """Diagnostic: raw GET of one resource path -> (status, text)."""
        token = self._valid_token()
        full = f"{API_BASE}{gateway_id}{resource_path}"
        conn = http.client.HTTPSConnection(API_HOST, 443, timeout=self.timeout, context=self._ctx)
        try:
            try:
                conn.request("GET", full, headers={
                    "Authorization": f"Bearer {token}", "Accept": "application/json"})
                r = conn.getresponse()
                data = r.read()
            except (OSError, http.client.HTTPException) as exc:
                raise _net_error(API_HOST, exc) from exc
            return r.status, data.decode("utf-8", "replace")
        finally:
            conn.close()

    def probe(self, gateway_id: str) -> dict:
        out = {}
        for p in PROBE_PATHS:
            try:
                st, body = self.raw(gateway_id, p)
                out[p] = {"status": st, "body": body[:700]}
            except Exception as exc:
                out[p] = {"error": str(exc)}
        return out

    # -- controls (read settings + write them back) ----------------------- #
    @staticmethod
    def _control_desc(res: dict) -> dict | None:
        """Normalise a Bosch resource JSON into a control descriptor, or None if
        it is not a settable/scalar leaf."""
        if not isinstance(res, dict):
            return None
        rid = res.get("id")
        val = res.get("value")
        if rid is None or isinstance(val, (list, dict)):
            return None
        allowed = res.get("allowedValues")
        return {
            "path": rid,
            "value": val,
            "type": res.get("type"),
            "writeable": bool(res.get("writeable")),
            "allowed": allowed if isinstance(allowed, list) else None,
            "min": res.get("minValue"),
            "max": res.get("maxValue"),
            "unit": res.get("unitOfMeasure"),
        }

    def read_controls(self, gateway_id: str, max_nodes: int = 90) -> list[dict]:
        """Discover settable heating/hot-water resources by crawling the
        heatingCircuits and dhwCircuits trees (bounded). Read-only; returns each
        leaf's current value plus whether the device reports it writeable and its
        allowed range – so writes can be validated against the device's own rules."""
        prefix = f"{API_BASE}{gateway_id}"

        def norm(pid):
            if not isinstance(pid, str) or not pid.startswith("/"):
                return None
            return pid if pid.startswith("/resource/") else "/resource" + pid

        seen, out, budget = set(), {}, max_nodes
        queue = ["/resource/heatingCircuits", "/resource/dhwCircuits"]
        while queue and budget > 0:
            p = queue.pop(0)
            if p in seen:
                continue
            seen.add(p)
            budget -= 1
            try:
                res = self._api_get(prefix + p)
            except _ABORT:
                raise                      # cloud unreachable / login gone: stop the crawl
            except HomeComError:
                res = None
            if not isinstance(res, dict):
                continue
            refs = res.get("references")
            if isinstance(refs, list):
                for r in refs:
                    rid = norm(r.get("id") if isinstance(r, dict) else None)
                    if rid and rid not in seen:
                        queue.append(rid)
                continue                       # a container, not a value leaf
            d = self._control_desc(res)
            if d and d.get("value") is not None:  # skip empty/placeholder leaves
                d["path"] = norm(d["path"]) or p
                out[d["path"]] = d
        return list(out.values())

    # -- volume flow (discovery: the API documents no fixed path) ---------- #
    # unit → factor to l/min. Matched case-insensitively, without blanks.
    FLOW_UNITS = {"l/min": 1.0, "lpm": 1.0, "l/h": 1.0 / 60.0, "lph": 1.0 / 60.0,
                  "m3/h": 1000.0 / 60.0, "m³/h": 1000.0 / 60.0, "l/s": 60.0}
    _FLOW_NAME = ("flowrate", "flow_rate", "volumeflow", "volumetricflow", "volumenstrom",
                  "durchfluss", "waterflow")
    _FLOW_LIMIT = ("max", "min", "setpoint", "nominal", "limit", "target")

    @classmethod
    def _flow_unit(cls, unit) -> float | None:
        if not isinstance(unit, str):
            return None
        return cls.FLOW_UNITS.get(unit.strip().lower().replace(" ", ""))

    @classmethod
    def _flow_leaf(cls, res: dict, path: str) -> dict | None:
        """A resource that holds a volume flow: by its unit, or – when the unit
        is missing – by a flow-like name that is clearly no temperature."""
        val = res.get("value")
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            return None
        unit = res.get("unitOfMeasure")
        fac = cls._flow_unit(unit)
        low = path.lower()
        if fac is None:
            if not any(k in low.replace("/", "") for k in cls._FLOW_NAME):
                return None
            if isinstance(unit, str) and unit.strip().upper() in ("C", "°C", "K", "%", "BAR", "KW", "W"):
                return None
            fac = 1.0                      # flow-like name without unit: assume l/min
            unit = unit or "?"
        last = low.rsplit("/", 1)[-1]
        return {"path": path, "value": float(val), "unit": unit,
                "l_min": round(float(val) * fac, 2),
                "setting": bool(res.get("writeable")) or any(k in last for k in cls._FLOW_LIMIT)}

    def discover_flow(self, gateway_id: str, max_nodes: int = 120, spacing: float = 0.5) -> dict:
        """Look through what the heat pump offers (heatSources, system, heating
        circuits; bounded) for a volume-flow value. Bosch does not document one
        for the CS6800i, so this only reports what the device really exposes.
        Read-only. Also counts the units seen, so 'nothing found' is checkable."""
        prefix = f"{API_BASE}{gateway_id}"

        def norm(pid):
            if not isinstance(pid, str) or not pid.startswith("/"):
                return None
            return pid if pid.startswith("/resource/") else "/resource" + pid

        seen, found, units, leaves, budget = set(), [], {}, 0, max_nodes
        queue = ["/resource/heatSources", "/resource/system", "/resource/heatingCircuits"]
        while queue and budget > 0:
            p = queue.pop(0)
            if p in seen:
                continue
            if seen and spacing > 0:
                time.sleep(spacing)            # one request at a time, spaced out
            seen.add(p)
            budget -= 1
            try:
                res = self._api_get(prefix + p)
            except _ABORT:
                raise                      # cloud unreachable / login gone: stop the crawl
            except HomeComError:
                res = None
            if not isinstance(res, dict):
                continue
            refs = res.get("references")
            if isinstance(refs, list):
                for r in refs:
                    rid = norm(r.get("id") if isinstance(r, dict) else None)
                    if rid and rid not in seen:
                        queue.append(rid)
                continue
            leaves += 1
            u = res.get("unitOfMeasure")
            if isinstance(u, str) and u:
                units[u] = units.get(u, 0) + 1
            f = self._flow_leaf(res, norm(res.get("id")) or p)
            if f:
                found.append(f)
        # the value to log: an actual reading (not a limit/setting), heat source first
        def rank(f):
            pth = f["path"]
            return (f["setting"], 0 if "/heatSources" in pth else 1 if "/system" in pth else 2, pth)
        found.sort(key=rank)
        primary = next((f["path"] for f in found if not f["setting"]), None)
        return {"ts": int(time.time()), "checked": len(seen), "leaves": leaves,
                "complete": not queue, "found": found, "primary": primary, "units": units}

    def read_flow(self, gateway_id: str, path: str) -> dict | None:
        """Read the discovered flow resource once (→ {l_min, value, unit})."""
        try:
            res = self._api_get(f"{API_BASE}{gateway_id}{path}")
        except HomeComError:
            return None
        return self._flow_leaf(res, path) if isinstance(res, dict) else None

    def read_resource(self, gateway_id: str, resource_path: str) -> dict | None:
        """GET one resource as a control descriptor (for write validation)."""
        res = self._api_get(f"{API_BASE}{gateway_id}{resource_path}")
        return self._control_desc(res) if isinstance(res, dict) else None

    @staticmethod
    def _num_by_keys(item: dict, keys) -> float | None:
        if not isinstance(item, dict):
            return None
        low = {str(k).lower(): v for k, v in item.items()}
        for k in keys:
            v = low.get(k)
            if isinstance(v, (int, float)):
                return float(v)
            if isinstance(v, dict) and isinstance(v.get("value"), (int, float)):
                return float(v["value"])
        return None

    @classmethod
    def _extract_curve_points(cls, res):
        """Best-effort: pull (outdoor, flow) point pairs out of a resource whose
        value is a heating curve (shapes vary by firmware)."""
        OUT = ("outdoor", "outdoortemp", "outdoortemperature", "outside", "ambient",
               "temperature", "x", "tout", "t_out", "taussen", "out", "at")
        FLOW = ("flow", "flowtemp", "flowtemperature", "supply", "setpoint", "vorlauf",
                "y", "value", "temp", "ft")
        if not isinstance(res, dict):
            return None
        val = res.get("value")
        lists = []
        if isinstance(val, list):
            lists.append(val)
        if isinstance(val, dict):
            for k in ("points", "coordinates", "curve", "values", "nodes", "entries"):
                if isinstance(val.get(k), list):
                    lists.append(val[k])
        for lst in lists:
            pts = []
            for item in lst:
                o = cls._num_by_keys(item, OUT)
                f = cls._num_by_keys(item, FLOW)
                if o is not None and f is not None and 10 <= f <= 80 and -40 <= o <= 40:
                    pts.append((o, f))
            if len(pts) >= 2:
                pts.sort(key=lambda x: x[0])
                return pts
        return None

    def read_curve(self, gateway_id: str, max_nodes: int = 120) -> dict:
        """Find the configured heating curve on the device and return its two
        reference points (+20 °C and −10 °C). Crawls heatingCircuits collecting
        ALL resources (scalar + structured); on failure returns the structured
        candidates (raw) so the parser can be refined. Read-only."""
        prefix = f"{API_BASE}{gateway_id}"

        def norm(pid):
            if not isinstance(pid, str) or not pid.startswith("/"):
                return None
            return pid if pid.startswith("/resource/") else "/resource" + pid

        seen, collected, budget = set(), [], max_nodes
        queue = ["/resource/heatingCircuits"]
        # curated hints, in case the crawl misses the curve leaf
        queue += [f"/resource/heatingCircuits/hc1/{s}" for s in
                  ("heatingCurve", "heatcurve", "heatCurve", "curve", "heatingCurveParameters",
                   "temperatureCurve", "characteristicCurve")]
        while queue and budget > 0:
            p = queue.pop(0)
            if p in seen:
                continue
            seen.add(p)
            budget -= 1
            try:
                res = self._api_get(prefix + p)
            except _ABORT:
                raise                      # cloud unreachable / login gone: stop the crawl
            except HomeComError:
                res = None
            if not isinstance(res, dict):
                continue
            refs = res.get("references")
            if isinstance(refs, list):
                for r in refs:
                    rid = norm(r.get("id") if isinstance(r, dict) else None)
                    if rid and rid not in seen:
                        queue.append(rid)
                continue
            collected.append((norm(res.get("id")) or p, res))

        # 1) prefer a resource whose path mentions "curve"
        ordered = sorted(collected, key=lambda c: 0 if "curve" in c[0].lower() else 1)
        for path, res in ordered:
            pts = self._extract_curve_points(res)
            if pts:
                cold, warm = pts[0], pts[-1]
                a = ((warm[1] - cold[1]) / (warm[0] - cold[0])) if warm[0] != cold[0] else 0.0
                b = cold[1] - a * cold[0]
                return {"found": True, "path": path,
                        "points": [{"outdoor": o, "flow": f} for o, f in pts],
                        "p20": round(a * 20 + b, 1), "pm10": round(a * (-10) + b, 1)}

        # 2) not found → return structured/curve-ish candidates for diagnosis
        cand = []
        for path, res in collected:
            v = res.get("value")
            if isinstance(v, (list, dict)) or "curve" in path.lower():
                cand.append({"path": path, "raw": json.dumps(res)[:500]})
        return {"found": False, "candidates": cand[:20], "scanned": len(collected)}

    def put(self, gateway_id: str, resource_path: str, value) -> tuple[int, str]:
        """Write a value to a resource (PUT {"value": …}). Returns (status, body).
        Caller is responsible for validating the resource is writeable first."""
        token = self._valid_token()
        full = f"{API_BASE}{gateway_id}{resource_path}"
        body = json.dumps({"value": value}).encode("utf-8")
        conn = http.client.HTTPSConnection(API_HOST, 443, timeout=self.timeout, context=self._ctx)
        try:
            conn.request("PUT", full, body=body, headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            })
            r = conn.getresponse()
            data = r.read()
            return r.status, data.decode("utf-8", "replace")
        finally:
            conn.close()
