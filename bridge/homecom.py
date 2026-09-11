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

RES = {
    "thermal_kw": "/resource/heatSources/hs1/actualPower",
    "modulation": "/resource/heatSources/hs1/powerPercentage",
    "energy_kwh": "/resource/heatSources/electricityTotalConsumption",
    "water_total": "/resource/dhwCircuits/waterTotalConsumption",
    "outdoor_c": "/resource/systemStates/outdoorTemperature",
}


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


class HomeComClient:
    """Talks to SingleKey ID (OAuth) and the HomeCom gateway API."""

    def __init__(self, refresh_token: str | None = None, timeout: float = 20.0):
        self.refresh_token = refresh_token
        self.timeout = timeout
        self._access = None
        self._access_exp = 0
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
        return self.refresh_token

    def _refresh(self):
        if not self.refresh_token:
            raise HomeComError("not logged in (no refresh token)")
        tok = self._post_form(OAUTH_HOST, "/auth/connect/token", {
            "grant_type": "refresh_token",
            "client_id": CLIENT_ID,
            "refresh_token": self.refresh_token,
        })
        self._access = tok.get("access_token")
        self._access_exp = time.time() + int(tok.get("expires_in", 3600)) - 60
        if tok.get("refresh_token"):
            self.refresh_token = tok["refresh_token"]  # rotate
        if not self._access:
            raise HomeComError("no access_token after refresh")

    def _valid_token(self) -> str:
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
        """Return the available heat-pump metrics for one gateway."""
        out = {"gateway": gateway_id}
        for key, path in RES.items():
            try:
                payload = self._api_get(f"{API_BASE}{gateway_id}{path}")
            except HomeComError:
                payload = None
            out[key] = self._num(payload)
        return out
