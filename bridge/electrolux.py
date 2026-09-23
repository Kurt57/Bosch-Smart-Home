#!/usr/bin/env python3
"""Electrolux Group API client (AEG / Electrolux connected appliances).

Standard library only – same spirit as ``homecom.py``.

AEG washing machines / dryers (and other Electrolux-owned brands) are NOT part
of the local Bosch controller. They are reached through the **official
Electrolux Group developer API**:

    Base:  https://api.developer.electrolux.one/api/v1
    Auth:  an API key (``x-api-key`` header) PLUS an OAuth access/refresh token
           pair – all three are created once in the developer dashboard
           (https://developer.electrolux.one/dashboard) using the same account
           as the AEG/Electrolux app.

The access token is short-lived; refreshing it rotates the refresh token, so a
new refresh token MUST be persisted (identical to HomeCom). Pass ``on_token``
to be notified of each new refresh token.

Endpoints used (confirmed against the community ``pyelectroluxgroup`` client):
    POST /token/refresh              {"refreshToken": ...} -> {accessToken, refreshToken}
    GET  /appliances                 -> [{applianceId, applianceName, applianceType}]
    GET  /appliances/{id}/info       -> {applianceInfo:{...}, capabilities:{...}}
    GET  /appliances/{id}/state      -> {status, connectionState, properties:{reported:{...}}}

What we read: the cumulative energy counter and the running state that washers
expose in ``properties.reported``. Field names differ per model, so the energy
extractor searches the reported tree for any "energy"-like numeric value; the
``probe`` helper dumps the whole tree so the exact fields can be inspected.
"""

from __future__ import annotations

import http.client
import json
import ssl
import threading
import time

API_HOST = "api.developer.electrolux.one"
API_BASE = "/api/v1"


class ElectroluxError(RuntimeError):
    pass


class ElectroluxAuthError(ElectroluxError):
    """API key or refresh token rejected – a fresh setup is required."""


class ElectroluxClient:
    """Talks to the Electrolux Group developer API.

    Credentials: ``api_key`` + ``refresh_token`` (an ``access_token`` may be
    supplied but is treated as optional – a valid one is minted from the
    refresh token on demand).
    """

    def __init__(self, api_key: str, refresh_token: str | None = None,
                 access_token: str | None = None, on_token=None,
                 timeout: float = 20.0, kwh_per_cycle: float = 0.8):
        self.api_key = (api_key or "").strip()
        self.refresh_token = (refresh_token or "").strip() or None
        self.on_token = on_token
        self.timeout = timeout
        # Many AEG/Electrolux models expose NO energy field via the API – only a
        # cumulative wash-cycle counter. For those we estimate energy as
        # cycles × this per-cycle figure (a mixed-usage average; tune per model).
        self.kwh_per_cycle = float(kwh_per_cycle)
        self._access = (access_token or "").strip() or None
        self._access_exp = time.time() + 300 if self._access else 0
        self._lock = threading.Lock()
        self._ctx = ssl.create_default_context()   # public host -> verify on

    # -- low level -------------------------------------------------------- #
    def _request(self, method: str, path: str, body: dict | None = None,
                 auth: bool = True) -> tuple[int, bytes]:
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["x-api-key"] = self.api_key
        if auth:
            headers["Authorization"] = f"Bearer {self._valid_token()}"
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPSConnection(API_HOST, 443, timeout=self.timeout,
                                           context=self._ctx)
        try:
            conn.request(method, f"{API_BASE}/{path}", body=data, headers=headers)
            resp = conn.getresponse()
            return resp.status, resp.read()
        finally:
            conn.close()

    def _get_json(self, path: str):
        st, data = self._request("GET", path)
        if st in (403, 404):
            return None
        if st == 401:
            raise ElectroluxError("unauthorized (token rejected)")
        if st == 429:
            raise ElectroluxError("Tageslimit der API erreicht (HTTP 429) – später erneut.")
        if st != 200:
            raise ElectroluxError(f"GET {path} -> HTTP {st}: {data[:160]!r}")
        return json.loads(data) if data else None

    # -- auth ------------------------------------------------------------- #
    def _refresh(self):
        if not self.refresh_token:
            raise ElectroluxAuthError("nicht angemeldet (kein Refresh-Token)")
        st, data = self._request("POST", "token/refresh",
                                 body={"refreshToken": self.refresh_token}, auth=False)
        if st in (400, 401, 403):
            raise ElectroluxAuthError(
                "AEG-Anmeldung abgelaufen/ungültig – bitte im Setup neu verbinden "
                "(API-Key & Refresh-Token prüfen).")
        if st != 200:
            raise ElectroluxError(f"token/refresh -> HTTP {st}: {data[:160]!r}")
        tok = json.loads(data)
        self._access = tok.get("accessToken")
        self._access_exp = time.time() + int(tok.get("expiresIn", 43200)) - 120
        if tok.get("refreshToken"):
            self.refresh_token = tok["refreshToken"]   # rotates -> persist!
            if self.on_token:
                try:
                    self.on_token(self.refresh_token)
                except Exception:
                    pass
        if not self._access:
            raise ElectroluxError("no accessToken after refresh")

    def _valid_token(self) -> str:
        with self._lock:
            if not self._access or time.time() >= self._access_exp:
                self._refresh()
            return self._access

    # -- data ------------------------------------------------------------- #
    def list_appliances(self) -> list[dict]:
        """Return [{'id','name','type'}, ...] for every appliance on the account."""
        data = self._get_json("appliances") or []
        out = []
        for a in data if isinstance(data, list) else data.get("appliances", []):
            if not isinstance(a, dict):
                continue
            aid = a.get("applianceId") or a.get("id")
            if not aid:
                continue
            out.append({
                "id": aid,
                "name": a.get("applianceName") or a.get("name") or aid,
                "type": a.get("applianceType") or a.get("type") or "",
            })
        return out

    def get_info(self, appliance_id: str) -> dict:
        return self._get_json(f"appliances/{appliance_id}/info") or {}

    def get_state(self, appliance_id: str) -> dict:
        return self._get_json(f"appliances/{appliance_id}/state") or {}

    @staticmethod
    def _reported(state: dict) -> dict:
        props = (state or {}).get("properties") or {}
        rep = props.get("reported")
        if isinstance(rep, dict):
            return rep
        # some payloads nest reported directly
        return rep if isinstance(rep, dict) else (props if isinstance(props, dict) else {})

    @staticmethod
    def _walk_numbers(node, prefix=""):
        """Yield (flat_key, value) for every numeric leaf in a nested dict/list."""
        if isinstance(node, dict):
            for k, v in node.items():
                key = f"{prefix}.{k}" if prefix else str(k)
                yield from ElectroluxClient._walk_numbers(v, key)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                yield from ElectroluxClient._walk_numbers(v, f"{prefix}[{i}]")
        elif isinstance(node, bool):
            return
        elif isinstance(node, (int, float)):
            yield prefix, float(node)

    @classmethod
    def _energy_fields_raw(cls, reported: dict) -> dict:
        """All numeric fields whose key mentions energy, as {flat_key: raw}."""
        return {key: val for key, val in cls._walk_numbers(reported)
                if "energy" in key.lower()}

    @staticmethod
    def _energy_scale(raw: dict) -> float:
        """kWh-per-unit for the reported energy values. Electrolux reports Wh on
        some models and kWh on others; a lifetime *washer* total is realistically
        < 3000 kWh but > 50000 Wh, so a large magnitude means the unit is Wh.
        The whole appliance shares one unit, so we decide once from the maximum."""
        mx = max(raw.values()) if raw else 0
        return 0.001 if mx >= 10000 else 1.0

    @classmethod
    def _energy_fields(cls, reported: dict) -> dict:
        """Energy fields normalised to kWh (unit inferred once for the appliance)."""
        raw = cls._energy_fields_raw(reported)
        scale = cls._energy_scale(raw)
        return {k: round(v * scale, 3) for k, v in raw.items()}

    @staticmethod
    def _pick(reported: dict, *names):
        """First present value among the given (case-insensitive) key names."""
        low = {str(k).lower(): v for k, v in reported.items()}
        for n in names:
            if n.lower() in low and low[n.lower()] not in (None, ""):
                return low[n.lower()]
        return None

    @staticmethod
    def _nested(rep: dict, *path):
        """Fetch a nested value, e.g. _nested(rep, 'userSelections', 'programUID')."""
        node = rep
        for p in path:
            if not isinstance(node, dict):
                return None
            node = node.get(p)
        return node

    def read_appliance(self, appliance_id: str, name: str | None = None) -> dict:
        """Normalised snapshot: running state + energy.

        If the model exposes an energy field we use it; otherwise (very common
        for AEG washers) we estimate from the cumulative wash-cycle counter and
        flag it as estimated."""
        state = self.get_state(appliance_id)
        rep = self._reported(state)
        efields = self._energy_fields(rep)
        cycles = self._pick(rep, "totalWashCyclesCount", "totalCycleCounter",
                            "totalCyclesCount", "cycleCounter")
        cycles = int(cycles) if isinstance(cycles, (int, float)) else None
        total_kwh = cycle_kwh = None
        estimated = False
        if efields:
            totals = {k: v for k, v in efields.items()
                      if any(w in k.lower() for w in ("total", "life", "cumul"))}
            total_kwh = max(totals.values()) if totals else max(efields.values())
            cyc = {k: v for k, v in efields.items()
                   if any(w in k.lower() for w in ("cycle", "current", "last", "program"))}
            if cyc:
                cycle_kwh = max(cyc.values())
        elif cycles is not None:
            total_kwh = round(cycles * self.kwh_per_cycle, 2)
            cycle_kwh = round(self.kwh_per_cycle, 2)
            estimated = True
        app_state = self._pick(rep, "applianceState", "State", "status") or state.get("status")
        wt = self._pick(rep, "applianceTotalWorkingTime", "totalWashingTime")
        prog = self._nested(rep, "userSelections", "programUID") \
            or self._pick(rep, "programUID", "cyclePhase", "applianceMode")
        tte = self._pick(rep, "timeToEnd", "remainingTime", "timeToEndSeconds")
        return {
            "id": appliance_id,
            "name": name,
            "connection": state.get("connectionState"),
            "state": str(app_state) if app_state is not None else None,
            "program": str(prog) if prog else None,
            "time_to_end_min": round(tte / 60) if isinstance(tte, (int, float)) and tte > 0 else None,
            "cycles": cycles,
            "working_time_h": round(wt / 3600) if isinstance(wt, (int, float)) and wt > 0 else None,
            "total_kwh": total_kwh,
            "cycle_kwh": cycle_kwh,
            "energy_estimated": estimated,
            "energy_fields": efields,
        }

    def verify(self) -> list[dict]:
        """Validate credentials by listing appliances (raises on bad auth)."""
        return self.list_appliances()

    def probe(self, appliance_id: str) -> dict:
        """Diagnostic: full reported state + discovered energy fields, so the
        exact per-model field names can be inspected."""
        info = self.get_info(appliance_id)
        state = self.get_state(appliance_id)
        rep = self._reported(state)
        return {
            "info": (info.get("applianceInfo") if isinstance(info, dict) else None) or info,
            "connectionState": state.get("connectionState"),
            "status": state.get("status"),
            "reported": rep,
            "energy_fields": self._energy_fields(rep),
        }
