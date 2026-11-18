#!/usr/bin/env python3
"""Read-only calendar feeds (iCloud "public calendar", Google "secret address in
iCal format", any .ics / webcal:// link) – standard library only.

    fetch(url)                       -> ICS text (webcal:// is fetched as https://)
    parse(text)                      -> {"name", "color", "events": [...]}
    expand(cal, start, end)          -> event instances overlapping [start, end)

Times are returned as naive *local* datetimes of the machine running the bridge
(the dashboard hangs in the same house). Supported: TZID (via zoneinfo when
available, else treated as local), UTC (…Z), floating times, all-day events
(VALUE=DATE), DURATION, RRULE (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT,
UNTIL, BYDAY incl. ordinals like 2MO / -1FR, BYMONTHDAY, BYMONTH, BYSETPOS),
EXDATE, RECURRENCE-ID (moved/changed single instances) and STATUS:CANCELLED.
Nothing is ever written to the calendar.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

try:                                   # Python ≥ 3.9; may lack tz data (Windows)
    from zoneinfo import ZoneInfo
except Exception:                      # pragma: no cover
    ZoneInfo = None

MAX_BYTES = 8 * 1024 * 1024
WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}


class CalendarError(RuntimeError):
    """Problem fetching/reading a calendar – the message is shown to the user (German)."""


# --------------------------------------------------------------------------- #
# fetching
# --------------------------------------------------------------------------- #
def normalize_url(url: str) -> str:
    u = (url or "").strip()
    if u.lower().startswith("webcal://"):
        u = "https://" + u[len("webcal://"):]
    elif u.lower().startswith("webcals://"):
        u = "https://" + u[len("webcals://"):]
    return u


def mask_url(url: str) -> str:
    """Show enough to recognise a link, not enough to read the calendar."""
    u = (url or "").strip()
    m = re.match(r"^([a-z]+://[^/]+/)(.*)$", u, re.I)
    if not m:
        return u[:12] + "…" if len(u) > 12 else u
    rest = m.group(2)
    return m.group(1) + (rest[:6] + "…" + rest[-4:] if len(rest) > 14 else rest)


def fetch(url: str, timeout: float = 20.0) -> str:
    u = normalize_url(url)
    if not u.lower().startswith(("https://", "http://")):
        raise CalendarError("Bitte eine Kalender-Adresse eintragen, die mit webcal://, https:// oder http:// beginnt.")
    req = urllib.request.Request(u, headers={"User-Agent": "BoschHomeEnergyBridge/1.0 (calendar)",
                                             "Accept": "text/calendar, text/plain, */*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:      # follows redirects
            raw = resp.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404):
            raise CalendarError(f"Kalender nicht abrufbar (HTTP {exc.code}) – ist er öffentlich freigegeben und "
                                "die Adresse vollständig kopiert? (iPhone: Kalender-App → Kalender → ⓘ → "
                                "„Öffentlicher Kalender“)") from None
        raise CalendarError(f"Kalender-Server antwortet mit HTTP {exc.code}.") from None
    except urllib.error.URLError as exc:
        raise CalendarError(f"Kalender nicht erreichbar ({getattr(exc, 'reason', exc)}).") from None
    except OSError as exc:
        raise CalendarError(f"Kalender nicht erreichbar ({exc}).") from None
    if len(raw) > MAX_BYTES:
        raise CalendarError("Der Kalender ist zu groß (über 8 MB).")
    text = raw.decode("utf-8", "replace")
    if "BEGIN:VCALENDAR" not in text[:2000].upper():
        raise CalendarError("Unter der Adresse liegt kein Kalender (kein iCalendar-Format).")
    return text


# --------------------------------------------------------------------------- #
# parsing
# --------------------------------------------------------------------------- #
def _unfold(text: str) -> list[str]:
    out: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line[:1] in (" ", "\t") and out:
            out[-1] += line[1:]
        elif line:
            out.append(line)
    return out


def _split_prop(line: str):
    """'DTSTART;TZID=Europe/Berlin:20261118T090000' -> ('DTSTART', {'TZID': ...}, value)."""
    inq, cut = False, -1
    for i, ch in enumerate(line):
        if ch == '"':
            inq = not inq
        elif ch == ":" and not inq:
            cut = i
            break
    if cut < 0:
        return None
    head, value = line[:cut], line[cut + 1:]
    parts = head.split(";")
    name = parts[0].upper()
    params = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.strip('"')
    return name, params, value


def _text(v: str) -> str:
    return (v.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",")
             .replace("\\;", ";").replace("\\\\", "\\")).strip()


def _tz(tzid: str | None):
    if not tzid or ZoneInfo is None:
        return None
    try:
        return ZoneInfo(tzid.strip())
    except Exception:
        return None                      # unknown name -> treat as local wall time


def _parse_dt(value: str, params: dict):
    """-> (wall datetime (naive), tz marker, all_day). tz marker: 'UTC', a
    tzinfo, or None (local/floating)."""
    v = value.strip()
    if params.get("VALUE", "").upper() == "DATE" or re.fullmatch(r"\d{8}", v):
        d = datetime.strptime(v[:8], "%Y%m%d")
        return d, None, True
    utc = v.endswith("Z")
    v = v.rstrip("Z")
    fmt = "%Y%m%dT%H%M%S" if len(v) >= 15 else "%Y%m%dT%H%M"
    d = datetime.strptime(v[:15] if len(v) >= 15 else v, fmt)
    if utc:
        return d, "UTC", False
    return d, _tz(params.get("TZID")), False


def _to_local(wall: datetime, tzm) -> datetime:
    """Naive wall time in zone tzm -> naive local time of this machine."""
    if tzm == "UTC":
        return wall.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
    if tzm is not None:
        try:
            return wall.replace(tzinfo=tzm).astimezone().replace(tzinfo=None)
        except Exception:
            return wall
    return wall


def _from_local(local: datetime, tzm) -> datetime:
    """Inverse of _to_local (for comparing UNTIL/EXDATE in the event's own zone)."""
    if tzm == "UTC":
        return local.astimezone(timezone.utc).replace(tzinfo=None)
    if tzm is not None:
        try:
            return local.astimezone(tzm).replace(tzinfo=None)
        except Exception:
            return local
    return local


_DUR = re.compile(r"^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$")


def _duration(v: str) -> timedelta | None:
    m = _DUR.match(v.strip().upper())
    if not m:
        return None
    sign = -1 if m.group(1) == "-" else 1
    w, d, h, mi, s = (int(x) if x else 0 for x in m.groups()[1:])
    return sign * timedelta(weeks=w, days=d, hours=h, minutes=mi, seconds=s)


def parse(text: str) -> dict:
    """ICS text -> {"name", "color", "events"}; each event keeps its wall times
    and zone so recurrences expand correctly across DST."""
    cal = {"name": None, "color": None, "events": []}
    stack: list[str] = []
    ev: dict | None = None
    for line in _unfold(text):
        up = line.upper()
        if up.startswith("BEGIN:"):
            comp = up[6:].strip()
            stack.append(comp)
            if comp == "VEVENT" and len(stack) >= 1 and stack[-2:-1] in (["VCALENDAR"], []):
                ev = {"exdates": [], "rdates": []}
            continue
        if up.startswith("END:"):
            comp = up[4:].strip()
            if stack and stack[-1] == comp:
                stack.pop()
            if comp == "VEVENT" and ev is not None:
                if ev.get("start") is not None:
                    cal["events"].append(ev)
                ev = None
            continue
        p = _split_prop(line)
        if not p:
            continue
        name, params, value = p
        if not stack or stack[-1] == "VCALENDAR":
            if name == "X-WR-CALNAME":
                cal["name"] = _text(value)
            elif name == "X-APPLE-CALENDAR-COLOR" and re.match(r"^#[0-9A-Fa-f]{6}", value):
                cal["color"] = value[:7]
            continue
        if ev is None or stack[-1] != "VEVENT":
            continue                       # inside VALARM etc.
        try:
            if name == "DTSTART":
                ev["start"], ev["tz"], ev["all_day"] = _parse_dt(value, params)
            elif name == "DTEND":
                ev["end"], ev["end_tz"], _ad = _parse_dt(value, params)
            elif name == "DURATION":
                ev["duration"] = _duration(value)
            elif name == "SUMMARY":
                ev["title"] = _text(value)
            elif name == "LOCATION":
                ev["location"] = _text(value)
            elif name == "UID":
                ev["uid"] = value.strip()
            elif name == "STATUS":
                ev["status"] = value.strip().upper()
            elif name == "RRULE":
                ev["rrule"] = {k.upper(): v for k, v in (x.split("=", 1) for x in value.split(";") if "=" in x)}
            elif name in ("EXDATE", "RDATE"):
                for item in value.split(","):
                    if item.strip():
                        ev["exdates" if name == "EXDATE" else "rdates"].append(_parse_dt(item, params))
            elif name == "RECURRENCE-ID":
                ev["rid"] = _parse_dt(value, params)
            elif name == "TRANSP":
                ev["transp"] = value.strip().upper()
        except (ValueError, TypeError):
            continue                       # one broken property must not lose the calendar
    return cal


# --------------------------------------------------------------------------- #
# recurrence
# --------------------------------------------------------------------------- #
def _byday(tokens: str) -> list[tuple[int | None, int]]:
    out = []
    for t in (tokens or "").split(","):
        m = re.fullmatch(r"([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)", t.strip().upper())
        if m:
            out.append((int(m.group(1)) if m.group(1) else None, WEEKDAYS[m.group(2)]))
    return out


def _ints(tokens: str) -> list[int]:
    out = []
    for t in (tokens or "").split(","):
        try:
            out.append(int(t))
        except ValueError:
            pass
    return out


def _month_days(y: int, m: int) -> int:
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return (nxt - date(y, m, 1)).days


def _nth_weekday(y: int, m: int, n: int, wd: int) -> int | None:
    days = [d for d in range(1, _month_days(y, m) + 1) if date(y, m, d).weekday() == wd]
    if not days or n == 0 or abs(n) > len(days):
        return None
    return days[n - 1] if n > 0 else days[n]


def _days_in_month(y: int, m: int, rule: dict, start: datetime) -> list[int]:
    """Day numbers of month m matching BYMONTHDAY / BYDAY (default: start's day)."""
    nd = _month_days(y, m)
    md = _ints(rule.get("BYMONTHDAY", ""))
    bd = _byday(rule.get("BYDAY", ""))
    days: set[int] = set()
    if md:
        for d in md:
            dd = d if d > 0 else nd + d + 1
            if 1 <= dd <= nd:
                days.add(dd)
    if bd:
        cand = set()
        for n, wd in bd:
            if n is None:
                cand |= {d for d in range(1, nd + 1) if date(y, m, d).weekday() == wd}
            else:
                x = _nth_weekday(y, m, n, wd)
                if x:
                    cand.add(x)
        days = (days & cand) if md else cand
    if not md and not bd:
        if start.day <= nd:
            days.add(start.day)
    out = sorted(days)
    sp = _ints(rule.get("BYSETPOS", ""))
    if sp and out:
        out = sorted({out[p - 1] if p > 0 else out[p] for p in sp if -len(out) <= p <= len(out) and p != 0})
    return out


def _occurrences(start: datetime, rule: dict, until_wall: datetime | None, horizon: datetime,
                 limit: int = 20000):
    """Recurrence start times (wall time of the event's zone), in order,
    including `start` itself, up to `horizon` (or UNTIL/COUNT)."""
    freq = (rule.get("FREQ") or "").upper()
    try:
        interval = max(1, int(rule.get("INTERVAL", "1")))
    except ValueError:
        interval = 1
    count = None
    if rule.get("COUNT"):
        try:
            count = int(rule["COUNT"])
        except ValueError:
            count = None
    bymonth = set(_ints(rule.get("BYMONTH", "")))
    tod = (start.hour, start.minute, start.second)
    n = 0

    def ok(t):
        return t >= start and (until_wall is None or t <= until_wall)

    def emit(cands):
        nonlocal n
        for t in sorted(cands):
            if t < start:
                continue
            if until_wall is not None and t > until_wall:
                return False
            if t > horizon:
                return False
            n += 1
            yield_list.append(t)
            if count is not None and n >= count:
                return False
        return True

    yield_list: list[datetime] = []
    if freq == "DAILY":
        bd = {wd for _n, wd in _byday(rule.get("BYDAY", ""))}
        md = set(_ints(rule.get("BYMONTHDAY", "")))
        t, i = start, 0
        while i < limit:
            i += 1
            if (not bd or t.weekday() in bd) and (not bymonth or t.month in bymonth) and (not md or t.day in md):
                if not emit([t]):
                    break
            t += timedelta(days=interval)
            if t > horizon or (until_wall is not None and t > until_wall):
                break
    elif freq == "WEEKLY":
        wds = sorted({wd for _n, wd in _byday(rule.get("BYDAY", ""))}) or [start.weekday()]
        wk = start - timedelta(days=start.weekday())                 # Monday of the first week
        wk = wk.replace(hour=tod[0], minute=tod[1], second=tod[2])
        i = 0
        while i < limit:
            i += 1
            cands = [wk + timedelta(days=wd) for wd in wds]
            cands = [c for c in cands if not bymonth or c.month in bymonth]
            if not emit(cands):
                break
            wk += timedelta(weeks=interval)
            if wk > horizon or (until_wall is not None and wk > until_wall):
                break
    elif freq in ("MONTHLY", "YEARLY"):
        y, m, i = start.year, start.month, 0
        while i < limit:
            i += 1
            months = [m] if freq == "MONTHLY" else (sorted(bymonth) if bymonth else [start.month])
            cands = []
            for mm in months:
                if freq == "MONTHLY" and bymonth and mm not in bymonth:
                    continue
                for d in _days_in_month(y, mm, rule, start):
                    cands.append(datetime(y, mm, d, *tod))
            if not emit(cands):
                break
            if freq == "MONTHLY":
                m += interval
                y += (m - 1) // 12
                m = (m - 1) % 12 + 1
            else:
                y += interval
            if datetime(y, m if freq == "MONTHLY" else 1, 1) > horizon:
                break
    else:
        if ok(start) and start <= horizon:
            yield_list.append(start)
    return yield_list


def expand(cal: dict, start: datetime, end: datetime) -> list[dict]:
    """Instances (local naive datetimes) overlapping [start, end), sorted."""
    events = cal.get("events") or []
    # changed/moved single instances, keyed by (UID, original start in local time)
    overrides: dict = {}
    for ev in events:
        if ev.get("rid") and ev.get("uid"):
            w, tzm, _ad = ev["rid"]
            overrides[(ev["uid"], _to_local(w, tzm).replace(second=0))] = ev
    out = []

    def add(ev, s_local, e_local, recurring):
        if ev.get("status") == "CANCELLED":
            return
        if s_local < end and e_local > start:
            out.append({"start": s_local, "end": e_local, "all_day": bool(ev.get("all_day")),
                        "title": ev.get("title") or "(ohne Titel)", "location": ev.get("location") or "",
                        "uid": ev.get("uid") or "", "recurring": recurring})

    for ev in events:
        s_wall, tzm, all_day = ev["start"], ev.get("tz"), ev.get("all_day")
        if ev.get("end") is not None:
            e_wall = ev["end"] if ev.get("end_tz", tzm) == tzm else _from_local(_to_local(ev["end"], ev.get("end_tz")), tzm)
            length = e_wall - s_wall
        elif ev.get("duration") is not None:
            length = ev["duration"]
        else:
            length = timedelta(days=1) if all_day else timedelta(0)
        if length < timedelta(0):
            length = timedelta(0)
        if ev.get("rid"):                                   # a single changed instance
            s_loc = _to_local(s_wall, tzm)
            add(ev, s_loc, s_loc + length if all_day else _to_local(s_wall + length, tzm), True)
            continue
        rule = ev.get("rrule")
        if not rule:
            s_loc = _to_local(s_wall, tzm)
            add(ev, s_loc, s_loc + length if all_day else _to_local(s_wall + length, tzm), False)
            continue
        until_wall = None
        if rule.get("UNTIL"):
            try:
                uw, utz, uad = _parse_dt(rule["UNTIL"], {})
                if uad:
                    until_wall = uw + timedelta(days=1) - timedelta(seconds=1)
                else:
                    until_wall = _from_local(_to_local(uw, utz), tzm) if utz != tzm else uw
            except ValueError:
                until_wall = None
        horizon = _from_local(end, tzm) + timedelta(days=1)
        ex = set()
        for w, etz, ead in ev.get("exdates") or []:
            ex.add(_to_local(w, etz).replace(second=0) if not ead else w.date())
        starts = _occurrences(s_wall, rule, until_wall, horizon)
        for w, rtz, _rad in ev.get("rdates") or []:
            starts.append(_from_local(_to_local(w, rtz), tzm))
        for occ in starts:
            s_loc = _to_local(occ, tzm)
            key = s_loc.replace(second=0)
            if key in ex or (all_day and occ.date() in ex):
                continue
            if ev.get("uid") and (ev["uid"], key) in overrides:
                continue                                        # replaced by its changed version
            e_loc = s_loc + length if all_day else _to_local(occ + length, tzm)
            add(ev, s_loc, e_loc, True)
    out.sort(key=lambda x: (x["start"], not x["all_day"], x["title"]))
    return out
