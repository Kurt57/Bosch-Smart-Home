#!/usr/bin/env python3
"""YouTube Music playlists for the living-room dashboard – links only.

YouTube Music has no official API for third-party apps to play or control
music, and fetching its audio streams would break YouTube's terms (and, in
Germany, circumvent a technical protection measure). So this module does
nothing of that: it only

* recognises a playlist link (music.youtube.com / youtube.com, ``?list=…`` or
  ``/browse/VL…``) and builds the canonical link that opens the playlist in the
  YouTube Music app (iOS universal link), and
* asks YouTube's public oEmbed endpoint for the playlist's title and a
  thumbnail – which works for public and unlisted playlists; for private ones
  YouTube answers 401/404 and the user names the playlist themselves.

Playback, the HomePod (AirPlay) and the login all stay in the YouTube Music
app / on the HomePod. Standard library only.
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "BoschHomeEnergyBridge/1.0 (Playlist-Link)"
_CACHE: dict = {}                  # id -> (ts, result): described ones a day, failures 2 min
_CACHE_LOCK = threading.Lock()
_LIST_RX = re.compile(r"(?:[?&]list=|/browse/VL)([A-Za-z0-9_-]{2,80})")


def playlist_id(url: str) -> str | None:
    """The playlist id from a shared link, or None (also accepts a bare id)."""
    s = (url or "").strip()
    m = _LIST_RX.search(s)
    if m:
        return m.group(1)
    return s if re.fullmatch(r"(?:PL|OLAK5uy_|RD)[A-Za-z0-9_-]{8,80}|LM", s) else None


def app_link(pid: str) -> str:
    """Opens the playlist in the YouTube Music app (or the web player)."""
    return "https://music.youtube.com/playlist?list=" + urllib.parse.quote(pid, safe="-_")


def playlist_meta(url: str, timeout: float = 8.0) -> dict:
    """{"ok", "id", "url", "title", "thumb", "meta_error"} – title/thumb are None
    when YouTube does not describe the playlist (private, or offline)."""
    pid = playlist_id(url)
    if pid:
        with _CACHE_LOCK:
            hit = _CACHE.get(pid)
        if hit and time.time() - hit[0] < (86400 if hit[1].get("title") else 120):
            return dict(hit[1])
    out = _playlist_meta(url, pid, timeout)
    if out.get("ok"):
        with _CACHE_LOCK:
            if len(_CACHE) > 300:
                _CACHE.clear()
            _CACHE[pid] = (time.time(), dict(out))
    return out


def _playlist_meta(url: str, pid: str | None, timeout: float) -> dict:
    if not pid:
        return {"ok": False, "error": "Das ist kein Playlist-Link (er enthält „list=“). "
                                      "In YouTube Music: Playlist öffnen → Teilen → Link kopieren."}
    out = {"ok": True, "id": pid, "url": app_link(pid), "title": None, "thumb": None}
    if pid == "LM":
        out["title"] = "Mag ich"                 # the "liked music" list exists only inside the app
        return out
    q = urllib.parse.quote("https://www.youtube.com/playlist?list=" + pid, safe="")
    req = urllib.request.Request("https://www.youtube.com/oembed?format=json&url=" + q,
                                 headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.loads(r.read(256 * 1024).decode("utf-8", "replace"))
        out["title"] = (j.get("title") or "").strip() or None
        thumb = j.get("thumbnail_url") or ""
        out["thumb"] = thumb if thumb.startswith("https://") else None
    except urllib.error.HTTPError as exc:
        out["meta_error"] = ("privat – Name bitte selbst eintragen" if exc.code in (401, 403, 404)
                             else f"YouTube antwortet mit {exc.code}")
    except Exception as exc:  # offline, DNS, timeout
        out["meta_error"] = f"YouTube nicht erreichbar ({exc.__class__.__name__})"
    return out
