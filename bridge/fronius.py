#!/usr/bin/env python3
"""Fronius inverter client (local Solar API v1, read-only) – standard library only.

Fronius inverters (Symo/Primo GEN24 Plus, Tauro, and older Symo/Primo with a
Datamanager) answer plain HTTP JSON requests on port 80 of the inverter –
no login, no cloud, nothing is ever written:

    GET /solar_api/GetAPIVersion.cgi                  -> {"APIVersion": 1, "BaseURL": "/solar_api/v1/"}
    GET /solar_api/v1/GetPowerFlowRealtimeData.fcgi   -> PV, grid, house, battery (W) + SOC
    GET /solar_api/v1/GetInverterInfo.cgi             -> device type, installed PV power, name
    GET /solar_api/v1/GetInverterRealtimeData.cgi?Scope=Device&DeviceId=1&DataCollection=CommonInverterData
                                                      -> AC power/voltage/frequency, DC per MPP tracker
    GET /solar_api/v1/GetMeterRealtimeData.cgi?Scope=System    -> smart meter(s): counters, phases
    GET /solar_api/v1/GetStorageRealtimeData.cgi?Scope=System  -> battery: SOC, capacity, temperature
    GET /solar_api/v1/GetOhmPilotRealtimeData.cgi?Scope=System -> Ohmpilot (heating rod), if any
    GET /solar_api/v1/GetActiveDeviceInfo.cgi?DeviceClass=System -> which devices exist

GEN24: the Solar API is switched OFF by default. Enable it once in the inverter's
web interface: Kommunikation → Solar API → „Kommunikation über Solar API aktivieren".

Signs in GetPowerFlowRealtimeData → Body.Data.Site (the inverter does the math):
    P_PV    ≥ 0   PV production (DC side); null at night on some devices
    P_Grid  > 0   drawn from the grid,  < 0 fed into the grid; null = no meter
    P_Load  < 0   house consumption (NEGATIVE in the API); null = no meter
    P_Akku  > 0   battery discharging, < 0 charging; null = no battery
Everything here is normalised to: pv_w ≥ 0, grid_w (+import/−export),
load_w ≥ 0 (consumption), batt_w (+discharge/−charge).

GEN24 specifics handled here: E_Day/E_Year are null (only E_Total), smart-meter
values may come as ``SMARTMETER_*_F64`` keys, the inverter name is plain UTF-8
(Datamanager: HTML entities), ``ErrorCode`` may be missing.
"""

from __future__ import annotations

import html
import http.client
import json
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

API_VERSION_PATH = "/solar_api/GetAPIVersion.cgi"
DEFAULT_BASE = "/solar_api/v1/"

EP_POWER_FLOW = "GetPowerFlowRealtimeData.fcgi"
EP_INVERTER_INFO = "GetInverterInfo.cgi"
EP_INVERTER_COMMON = "GetInverterRealtimeData.cgi?Scope=Device&DeviceId={}&DataCollection=CommonInverterData"
EP_INVERTER_3P = "GetInverterRealtimeData.cgi?Scope=Device&DeviceId={}&DataCollection=3PInverterData"
EP_METER = "GetMeterRealtimeData.cgi?Scope=System"
EP_STORAGE = "GetStorageRealtimeData.cgi?Scope=System"
EP_OHMPILOT = "GetOhmPilotRealtimeData.cgi?Scope=System"
EP_ACTIVE = "GetActiveDeviceInfo.cgi?DeviceClass=System"

# Head.Status.Code of a Solar API answer
STATUS_CODES = {
    0: "OK", 1: "nicht implementiert", 2: "nicht initialisiert", 3: "initialisiert",
    4: "läuft", 5: "Zeitüberschreitung", 6: "Argumentfehler", 7: "Anfragefehler",
    8: "Anfrage-Zeitüberschreitung", 9: "Antwort nicht lesbar", 10: "Konfigurationsfehler",
    11: "nicht unterstützt", 12: "Gerät nicht verfügbar", 255: "unbekannter Fehler",
}
# DeviceStatus.StatusCode of an inverter (Datamanager devices; GEN24 also sends
# a plain-text InverterState)
INVERTER_STATUS = {
    0: "Start", 1: "Start", 2: "Start", 3: "Start", 4: "Start", 5: "Start", 6: "Start",
    7: "in Betrieb", 8: "Bereitschaft", 9: "Bootloader", 10: "Fehler", 11: "Leerlauf",
    12: "bereit", 13: "Schlafmodus", 255: "unbekannt",
}
INVERTER_STATE_DE = {
    "running": "in Betrieb", "sleeping": "Schlafmodus", "standby": "Bereitschaft",
    "startup": "Start", "starting": "Start", "error": "Fehler", "idle": "Leerlauf",
    "ready": "bereit", "bootloading": "Bootloader", "unknown": "unbekannt",
}
SITE_MODE_DE = {
    "produce-only": "nur Erzeugung (kein Zähler)", "meter": "mit Smart Meter",
    "vague-meter": "Smart Meter (unvollständig)", "bidirectional": "mit Batterie",
    "ac-coupled": "AC-gekoppelt",
}
BATTERY_MODE_DE = {
    "normal": "normal", "disabled": "deaktiviert", "service": "Service",
    "charge boost": "Zwangsladung", "nearly depleted": "fast leer", "suspended": "pausiert",
    "calibrate": "kalibriert", "grid support": "Netzstützung", "deplete recovery": "Schutzladung",
    "non operable (voltage)": "außer Betrieb (Spannung)",
    "non operable (temperature)": "außer Betrieb (Temperatur)",
    "preheating": "heizt vor", "startup": "startet", "stopped (temperature)": "gestoppt (Temperatur)",
    "battery full": "voll",
}
# DT (device type) – only the families that matter here; everything else is
# shown by its CustomName / type number.
DEVICE_TYPE = {1: "Fronius GEN24"}
# Meter_Location_Current
METER_LOCATION = {0: "grid", 1: "load", 3: "generator"}
METER_LOCATION_DE = {"grid": "Einspeisepunkt (Netz)", "load": "Verbrauchszweig",
                     "generator": "externer Erzeuger", "sub": "Unterzähler", "unknown": "unbekannt"}


class FroniusError(RuntimeError):
    """Connection/answer problem – the message is shown to the user (German)."""


class FroniusStatusError(FroniusError):
    """The inverter answered, but with a non-zero Head.Status.Code."""

    def __init__(self, code, reason=""):
        self.code = code
        super().__init__(f"Wechselrichter meldet Status {code} ({STATUS_CODES.get(code, 'unbekannt')})"
                         + (f": {reason}" if reason else ""))


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def normalize_host(host: str) -> str:
    """'http://192.168.2.50/' → '192.168.2.50' (an explicit port is kept)."""
    h = (host or "").strip()
    for pre in ("http://", "https://"):
        if h.lower().startswith(pre):
            h = h[len(pre):]
    h = h.split("/", 1)[0].strip()
    return h


def _split_host(host: str) -> tuple[str, int]:
    h = normalize_host(host)
    if h.count(":") == 1:                          # host:port (IPv4 / name)
        name, port = h.split(":")
        try:
            return name, int(port)
        except ValueError:
            return name, 80
    return h, 80


def _num(x):
    """float or None (also for numeric strings); bools are not numbers."""
    if isinstance(x, bool) or x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    try:
        return float(str(x).strip())
    except (TypeError, ValueError):
        return None


def _val(d: dict, key: str):
    """Value of a {"Unit": …, "Value": …} entry (inverter realtime data)."""
    v = d.get(key) if isinstance(d, dict) else None
    if isinstance(v, dict):
        return _num(v.get("Value"))
    return _num(v)


def _first(d: dict, *keys):
    """First present, numeric value among ``keys``."""
    for k in keys:
        if isinstance(d, dict) and k in d:
            v = _num(d.get(k))
            if v is not None:
                return v
    return None


def _text(x) -> str:
    return html.unescape(str(x)).strip() if x is not None else ""


def meter_location(code) -> str:
    c = _num(code)
    if c is None:
        return "unknown"
    c = int(c)
    if 256 <= c <= 511:
        return "sub"
    return METER_LOCATION.get(c, "unknown")


# --------------------------------------------------------------------------- #
# parsers (pure – they take Body.Data and return plain dicts)
# --------------------------------------------------------------------------- #
def parse_power_flow(data: dict) -> dict:
    """GetPowerFlowRealtimeData → normalised live values (W, %, Wh)."""
    site = data.get("Site") or {}
    invs = data.get("Inverters") or {}
    if isinstance(invs, list):                     # tolerate a list instead of a dict
        invs = {str(i + 1): v for i, v in enumerate(invs)}
    p_pv, p_grid = _num(site.get("P_PV")), _num(site.get("P_Grid"))
    p_load, p_akku = _num(site.get("P_Load")), _num(site.get("P_Akku"))
    inverters, socs = [], []
    for iid, inv in sorted(invs.items(), key=lambda kv: str(kv[0])):
        if not isinstance(inv, dict):
            continue
        soc = _num(inv.get("SOC"))
        if soc is not None:
            socs.append(soc)
        inverters.append({
            "id": str(iid), "dt": inv.get("DT"), "p_w": _num(inv.get("P")), "soc": soc,
            "battery_mode": inv.get("Battery_Mode"),
            "e_day_wh": _num(inv.get("E_Day")), "e_total_wh": _num(inv.get("E_Total")),
        })
    has_meter = p_grid is not None or p_load is not None
    meter_loc = str(site.get("Meter_Location") or "unknown")
    mode = site.get("Mode")
    ohm = []
    smart = data.get("Smartloads") or {}
    for kind in ("Ohmpilots", "OhmpilotEcos"):
        for oid, o in (smart.get(kind) or {}).items():
            if isinstance(o, dict):
                ohm.append({"id": str(oid), "kind": kind, "p_w": _num(o.get("P_AC_Total")),
                            "state": o.get("State"), "temp_c": _num(o.get("Temperature"))})
    pv = p_pv if p_pv is not None else (0.0 if inverters else None)
    return {
        "pv_w": max(0.0, pv) if pv is not None else None,
        "grid_w": p_grid,
        "load_w": (-p_load) if p_load is not None else None,
        "batt_w": p_akku,
        "soc": socs[0] if socs else None,
        "has_meter": has_meter,
        "has_battery": p_akku is not None or bool(socs),
        "meter_location": meter_loc,
        "mode": mode, "mode_de": SITE_MODE_DE.get(str(mode), str(mode or "")),
        "battery_mode": next((i["battery_mode"] for i in inverters if i.get("battery_mode")), None),
        "battery_mode_de": next((BATTERY_MODE_DE.get(str(i["battery_mode"]).lower(), str(i["battery_mode"]))
                                 for i in inverters if i.get("battery_mode")), None),
        "backup_mode": bool(site.get("BackupMode")) if "BackupMode" in site else None,
        "battery_standby": bool(site.get("BatteryStandby")) if "BatteryStandby" in site else None,
        "e_day_wh": _num(site.get("E_Day")), "e_year_wh": _num(site.get("E_Year")),
        "e_total_wh": _num(site.get("E_Total")),
        "autonomy_pct": _num(site.get("rel_Autonomy")),
        "self_consumption_pct": _num(site.get("rel_SelfConsumption")),
        "inverters": inverters, "ohmpilots": ohm,
        "version": data.get("Version"),
    }


def parse_inverter_info(data: dict) -> list:
    """GetInverterInfo → one entry per inverter (model, name, PV power, state)."""
    out = []
    for iid, inv in sorted((data or {}).items(), key=lambda kv: str(kv[0])):
        if not isinstance(inv, dict):
            continue
        dt = inv.get("DT")
        sc = inv.get("StatusCode")
        state = inv.get("InverterState")
        out.append({
            "id": str(iid), "dt": dt,
            "type": DEVICE_TYPE.get(dt) or (f"Fronius (Typ {dt})" if dt is not None else "Fronius"),
            "name": _text(inv.get("CustomName")),
            "pv_power_w": _num(inv.get("PVPower")),
            "status_code": sc,
            "state": state,
            "state_de": (INVERTER_STATE_DE.get(str(state).lower()) if state else None)
                        or INVERTER_STATUS.get(sc if isinstance(sc, int) else -1) or (str(state or sc or "")),
            "error_code": inv.get("ErrorCode"),
            "unique_id": str(inv.get("UniqueID") or ""),
        })
    return out


def parse_inverter_realtime(data: dict) -> dict:
    """GetInverterRealtimeData (CommonInverterData) → AC values + MPP strings."""
    strings = []
    for i in range(1, 10):
        sfx = "" if i == 1 else f"_{i}"
        u, a = _val(data, "UDC" + sfx), _val(data, "IDC" + sfx)
        if u is None and a is None:                # slot not present / not wired (GEN24: null)
            continue
        p = round(u * a, 1) if (u is not None and a is not None) else None
        strings.append({"n": i, "u_v": u, "i_a": a, "p_w": p})
    st = data.get("DeviceStatus") or {}
    sc = st.get("StatusCode")
    state = st.get("InverterState")
    return {
        "pac_w": _val(data, "PAC"), "sac_va": _val(data, "SAC"),
        "iac_a": _val(data, "IAC"), "uac_v": _val(data, "UAC"), "fac_hz": _val(data, "FAC"),
        "day_wh": _val(data, "DAY_ENERGY"), "year_wh": _val(data, "YEAR_ENERGY"),
        "total_wh": _val(data, "TOTAL_ENERGY"),
        "status_code": sc, "state": state,
        "state_de": (INVERTER_STATE_DE.get(str(state).lower()) if state else None)
                    or INVERTER_STATUS.get(sc if isinstance(sc, int) else -1),
        "error_code": st.get("ErrorCode"),
        "strings": strings,
    }


def parse_meters(data: dict) -> list:
    """GetMeterRealtimeData (Scope=System) → one entry per smart meter.
    Counters in Wh. At the grid point: import = 'Consumed', export = 'Produced'."""
    out = []
    for mid, m in sorted((data or {}).items(), key=lambda kv: str(kv[0])):
        if not isinstance(m, dict):
            continue
        det = m.get("Details") or {}
        loc_code = _first(m, "Meter_Location_Current", "SMARTMETER_VALUE_LOCATION_U16")
        phases = []
        for ph in (1, 2, 3):
            p = _first(m, f"PowerReal_P_Phase_{ph}", f"SMARTMETER_POWERACTIVE_0{ph}_F64")
            u = _first(m, f"Voltage_AC_Phase_{ph}", f"SMARTMETER_VOLTAGE_0{ph}_F64")
            a = _first(m, f"Current_AC_Phase_{ph}", f"ACBRIDGE_CURRENT_ACTIVE_MEAN_0{ph}_F32")
            pf = _first(m, f"PowerFactor_Phase_{ph}", f"SMARTMETER_FACTOR_POWER_0{ph}_F64")
            if p is not None or u is not None or a is not None:
                phases.append({"n": ph, "p_w": p, "u_v": u, "i_a": a, "pf": pf})
        p_sum = _first(m, "PowerReal_P_Sum", "SMARTMETER_POWERACTIVE_MEAN_SUM_F64")
        if p_sum is None and phases and all(x["p_w"] is not None for x in phases):
            p_sum = sum(x["p_w"] for x in phases)
        loc = meter_location(loc_code)
        out.append({
            "id": str(mid), "location": loc, "location_code": loc_code,
            "location_de": METER_LOCATION_DE.get(loc, "unbekannt"),
            "manufacturer": _text(det.get("Manufacturer")), "model": _text(det.get("Model")),
            "serial": _text(det.get("Serial")),
            "p_w": p_sum,
            "import_wh": _first(m, "EnergyReal_WAC_Sum_Consumed", "SMARTMETER_ENERGYACTIVE_CONSUMED_SUM_F64",
                                "EnergyReal_WAC_Plus_Absolute", "SMARTMETER_ENERGYACTIVE_ABSOLUT_PLUS_F64"),
            "export_wh": _first(m, "EnergyReal_WAC_Sum_Produced", "SMARTMETER_ENERGYACTIVE_PRODUCED_SUM_F64",
                                "EnergyReal_WAC_Minus_Absolute", "SMARTMETER_ENERGYACTIVE_ABSOLUT_MINUS_F64"),
            "freq_hz": _first(m, "Frequency_Phase_Average", "SMARTMETER_FREQUENCY_MEAN_F64"),
            "pf": _first(m, "PowerFactor_Sum", "SMARTMETER_FACTOR_POWER_SUM_F64"),
            "phases": phases,
            "enabled": m.get("Enable", m.get("COMPONENTS_MODE_ENABLE_U16")),
        })
    return out


def parse_storage(data: dict) -> dict | None:
    """GetStorageRealtimeData (Scope=System) → the first battery, or None."""
    for sid, s in sorted((data or {}).items(), key=lambda kv: str(kv[0])):
        if not isinstance(s, dict):
            continue
        c = s.get("Controller") if isinstance(s.get("Controller"), dict) else s
        det = c.get("Details") or {}
        designed = _num(c.get("DesignedCapacity"))
        maximum = _num(c.get("Capacity_Maximum"))
        return {
            "id": str(sid),
            "soc": _num(c.get("StateOfCharge_Relative")),
            "capacity_wh": designed if designed else maximum,
            "max_capacity_wh": maximum,
            "temp_c": _num(c.get("Temperature_Cell")),
            "u_v": _num(c.get("Voltage_DC")), "i_a": _num(c.get("Current_DC")),
            "manufacturer": _text(det.get("Manufacturer")), "model": _text(det.get("Model")),
            "serial": _text(det.get("Serial")),
            "enabled": c.get("Enable"),
            "status": c.get("Status_BatteryCell"),
            "modules": len(s.get("Modules") or []) if isinstance(s.get("Modules"), list) else None,
        }
    return None


def parse_ohmpilots(data: dict) -> list:
    out = []
    for oid, o in sorted((data or {}).items(), key=lambda kv: str(kv[0])):
        if not isinstance(o, dict):
            continue
        det = o.get("Details") or {}
        out.append({"id": str(oid), "p_w": _num(o.get("PowerReal_PAC_Sum")),
                    "energy_wh": _num(o.get("EnergyReal_WAC_Sum_Consumed")),
                    "temp_c": _num(o.get("Temperature_Channel_1")),
                    "state_code": o.get("CodeOfState"), "error_code": o.get("CodeOfError"),
                    "model": _text(det.get("Model"))})
    return out


def parse_active_devices(data: dict) -> dict:
    """GetActiveDeviceInfo → which device classes exist (inverter/meter/storage/…)."""
    out = {}
    for cls in ("Inverter", "Meter", "Storage", "Ohmpilot", "SensorCard", "StringControl"):
        d = (data or {}).get(cls) or {}
        out[cls.lower()] = [{"id": str(k), "dt": (v or {}).get("DT"), "serial": _text((v or {}).get("Serial"))}
                            for k, v in d.items() if isinstance(v, dict)] if isinstance(d, dict) else []
    return out


# --------------------------------------------------------------------------- #
# client
# --------------------------------------------------------------------------- #
class FroniusClient:
    def __init__(self, host: str, timeout: float = 6.0):
        self.host = normalize_host(host)
        if not self.host:
            raise FroniusError("Keine Adresse für den Wechselrichter angegeben.")
        self.timeout = timeout
        self.base = DEFAULT_BASE

    # -- transport -------------------------------------------------------- #
    def _raw(self, path: str, timeout: float | None = None) -> tuple[int, str, bytes]:
        name, port = _split_host(self.host)
        conn = http.client.HTTPConnection(name, port, timeout=timeout or self.timeout)
        try:
            conn.request("GET", path, headers={"Accept": "application/json",
                                               "User-Agent": "BoschHomeEnergy/1 (Solar API reader)"})
            r = conn.getresponse()
            body = r.read(4 * 1024 * 1024)
            return r.status, r.getheader("Content-Type") or "", body
        except socket.timeout:
            raise FroniusError(f"Keine Antwort von {self.host} (Zeitüberschreitung).")
        except OSError as exc:
            raise FroniusError(f"{self.host} nicht erreichbar ({exc.strerror or exc}).")
        finally:
            conn.close()

    def _json(self, path: str, timeout: float | None = None) -> dict:
        status, _ctype, body = self._raw(path, timeout)
        if status == 404:
            raise FroniusError(f"{path} gibt es auf {self.host} nicht (HTTP 404) – ist die Solar API "
                               "eingeschaltet? (GEN24: Kommunikation → Solar API)")
        if status in (401, 403):
            raise FroniusError(f"{self.host} verweigert den Zugriff (HTTP {status}) – die Solar API ist "
                               "vermutlich ausgeschaltet (GEN24: Kommunikation → Solar API → aktivieren).")
        if status != 200:
            raise FroniusError(f"{self.host} antwortet mit HTTP {status} auf {path}.")
        try:
            return json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            raise FroniusError(f"{self.host} liefert auf {path} kein JSON – ist das ein Fronius-Wechselrichter?")

    def _data(self, endpoint: str, *, empty_ok: bool = False) -> dict:
        """GET one v1 endpoint, check Head.Status.Code, return Body.Data."""
        res = self._json(self.base + endpoint)
        head = res.get("Head") if isinstance(res, dict) else None
        status = (head or {}).get("Status") or {}
        code = status.get("Code")
        if head is None or code is None:
            raise FroniusError(f"Unerwartete Antwort auf {endpoint} (kein Solar-API-Kopf).")
        if code != 0:
            if empty_ok:
                return {}
            raise FroniusStatusError(code, status.get("Reason") or status.get("UserMessage") or "")
        body = res.get("Body") or {}
        data = body.get("Data")
        if data is None:
            data = {k: v for k, v in body.items() if k != "Data"}
        return data if isinstance(data, dict) else {}

    # -- endpoints -------------------------------------------------------- #
    def api_version(self) -> dict:
        res = self._json(API_VERSION_PATH)
        if not isinstance(res, dict) or "APIVersion" not in res:
            raise FroniusError(f"{self.host} antwortet, aber nicht wie die Fronius Solar API.")
        base = res.get("BaseURL") or DEFAULT_BASE
        if isinstance(base, str) and base.startswith("/"):
            self.base = base if base.endswith("/") else base + "/"
        return {"api": res.get("APIVersion"), "base": self.base,
                "compat": res.get("CompatibilityRange")}

    def power_flow(self) -> dict:
        out = parse_power_flow(self._data(EP_POWER_FLOW))
        out["ts"] = int(time.time())
        return out

    def inverter_info(self) -> list:
        return parse_inverter_info(self._data(EP_INVERTER_INFO))

    def inverter_realtime(self, device_id: str = "1") -> dict:
        return parse_inverter_realtime(self._data(EP_INVERTER_COMMON.format(device_id)))

    def meters(self) -> list:
        return parse_meters(self._data(EP_METER, empty_ok=True))

    def storage(self) -> dict | None:
        return parse_storage(self._data(EP_STORAGE, empty_ok=True))

    def ohmpilots(self) -> list:
        return parse_ohmpilots(self._data(EP_OHMPILOT, empty_ok=True))

    def active_devices(self) -> dict:
        return parse_active_devices(self._data(EP_ACTIVE, empty_ok=True))

    # -- bundles ----------------------------------------------------------- #
    def details(self, device_ids=("1",)) -> dict:
        """Everything besides the power flow; every part may fail on its own
        (a device without battery/meter must not break the rest)."""
        out, errors = {"inverters": {}, "meters": [], "storage": None, "ohmpilots": []}, {}
        for did in device_ids:
            try:
                out["inverters"][str(did)] = self.inverter_realtime(did)
            except FroniusError as exc:
                errors[f"inverter_{did}"] = str(exc)
        for key, fn in (("meters", self.meters), ("storage", self.storage), ("ohmpilots", self.ohmpilots)):
            try:
                out[key] = fn()
            except FroniusError as exc:
                errors[key] = str(exc)
        out["errors"] = errors
        out["ts"] = int(time.time())
        return out

    def identify(self) -> dict:
        """Who is there? (for connecting / the setup card)."""
        ver = self.api_version()
        info, act = [], {}
        try:
            info = self.inverter_info()
        except FroniusError:
            pass
        try:
            act = self.active_devices()
        except FroniusError:
            pass
        flow = self.power_flow()                   # the one call the poller needs
        main = info[0] if info else {}
        return {"host": self.host, "api": ver, "inverters": info, "devices": act,
                "name": main.get("name") or main.get("type") or "Fronius",
                "type": main.get("type"), "pv_power_w": main.get("pv_power_w"),
                "has_meter": flow.get("has_meter"), "has_battery": flow.get("has_battery"),
                "meter_location": flow.get("meter_location"), "mode": flow.get("mode"),
                "mode_de": flow.get("mode_de"), "flow": flow, "ts": int(time.time())}

    def probe(self) -> dict:
        """Raw answers of every endpoint (for diagnosis – shown to the user so
        an unexpected format can be fixed quickly)."""
        paths = [API_VERSION_PATH] + [self.base + e for e in (
            EP_POWER_FLOW, EP_INVERTER_INFO, EP_INVERTER_COMMON.format("1"), EP_INVERTER_3P.format("1"),
            EP_METER, EP_STORAGE, EP_OHMPILOT, EP_ACTIVE)]
        out = {"host": self.host, "ts": int(time.time()), "endpoints": []}
        for p in paths:
            t0 = time.time()
            try:
                st, ctype, body = self._raw(p)
                txt = body.decode("utf-8", "replace")
                out["endpoints"].append({"path": p, "status": st, "type": ctype,
                                         "ms": round((time.time() - t0) * 1000),
                                         "body": txt[:12000], "truncated": len(txt) > 12000})
            except FroniusError as exc:
                out["endpoints"].append({"path": p, "error": str(exc),
                                         "ms": round((time.time() - t0) * 1000)})
        return out


# --------------------------------------------------------------------------- #
# discovery in the local network
# --------------------------------------------------------------------------- #
def subnet_hosts(own_ip: str) -> list:
    """All other addresses of the /24 network of ``own_ip`` (IPv4)."""
    parts = (own_ip or "").split(".")
    if len(parts) != 4 or not all(p.isdigit() for p in parts) or own_ip.startswith("127."):
        return []
    pre = ".".join(parts[:3])
    return [f"{pre}.{i}" for i in range(1, 255) if f"{pre}.{i}" != own_ip]


def _port_open(host: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def check_host(host: str, timeout: float = 2.5) -> dict | None:
    """Is a Fronius device at ``host``? → description, or None.
    Also recognises a Fronius whose Solar API is still switched off."""
    cl = FroniusClient(host, timeout=timeout)
    try:
        ver = cl.api_version()
    except FroniusError:
        ver = None
    if ver:
        found = {"host": cl.host, "solar_api": True, "api": ver.get("api")}
        try:
            info = cl.inverter_info()
            if info:
                found.update({"name": info[0].get("name"), "type": info[0].get("type"),
                              "pv_power_w": info[0].get("pv_power_w"),
                              "state_de": info[0].get("state_de")})
        except FroniusError as exc:
            found["note"] = str(exc)
        return found
    # no Solar API answer: is it still a Fronius web interface?
    try:
        st, _ct, body = cl._raw("/", timeout=timeout)
        if b"fronius" in body[:200000].lower():
            return {"host": cl.host, "solar_api": False,
                    "note": "Fronius-Weboberfläche gefunden, aber die Solar API antwortet nicht – "
                            "beim GEN24 unter Kommunikation → Solar API einschalten."}
    except FroniusError:
        pass
    return None


def discover(hosts: list, port: int = 80, connect_timeout: float = 0.6,
             workers: int = 48, deadline: float = 30.0) -> list:
    """Scan ``hosts`` for Fronius inverters (TCP probe on port 80 first, then
    the Solar API). Returns the devices found, Solar-API-capable ones first."""
    t_end = time.time() + deadline
    open_hosts = []
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        futs = {ex.submit(_port_open, h, port, connect_timeout): h for h in hosts}
        for f in as_completed(futs):
            try:
                if f.result():
                    open_hosts.append(futs[f])
            except Exception:
                pass
    found = []
    if not open_hosts:
        return found
    ex = ThreadPoolExecutor(max_workers=min(16, len(open_hosts)))
    futs = {ex.submit(check_host, h if port == 80 else f"{h}:{port}"): h for h in open_hosts}
    try:
        for f in as_completed(futs, timeout=max(1.0, t_end - time.time())):
            try:
                r = f.result()
            except Exception:
                r = None
            if r:
                found.append(r)
    except Exception:                              # deadline reached – keep what we have
        pass
    finally:
        ex.shutdown(wait=False)
    found.sort(key=lambda r: (not r.get("solar_api"), [int(x) if x.isdigit() else 0
                                                       for x in r["host"].split(":")[0].split(".")]))
    return found
