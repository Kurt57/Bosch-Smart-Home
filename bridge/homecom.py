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
            conn.request("POST", path, body=body, headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            })
            resp = conn.getresponse()
            data = resp.read()
            if resp.status != 200:
                if b"invalid_grant" in data:
                    raise AuthExpiredError(
                        "HomeCom-Anmeldung abgelaufen – bitte im Setup neu verbinden.")
                raise HomeComError(f"token endpoint HTTP {resp.status}: {data[:200]!r}")
            return json.loads(data)
        finally:
            conn.close()

    def _api_get(self, path: str):
        token = self._valid_token()
        conn = http.client.HTTPSConnection(API_HOST, 443, timeout=self.timeout, context=self._ctx)
        try:
            conn.request("GET", path, headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
            })
            resp = conn.getresponse()
            data = resp.read()
            if resp.status in (403, 404):
                return None  # resource not available on this device
            if resp.status == 401:
                raise HomeComError("unauthorized (token rejected)")
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
        def get(p):
            try:
                return self._api_get(f"{API_BASE}{gateway_id}{p}")
            except HomeComError:
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
        return out

    def raw(self, gateway_id: str, resource_path: str):
        """Diagnostic: raw GET of one resource path -> (status, text)."""
        token = self._valid_token()
        full = f"{API_BASE}{gateway_id}{resource_path}"
        conn = http.client.HTTPSConnection(API_HOST, 443, timeout=self.timeout, context=self._ctx)
        try:
            conn.request("GET", full, headers={
                "Authorization": f"Bearer {token}", "Accept": "application/json"})
            r = conn.getresponse()
            data = r.read()
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
