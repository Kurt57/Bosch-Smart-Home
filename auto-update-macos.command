#!/bin/bash
# Doppelklick: startet die Bridge UND haelt sie automatisch aktuell.
#
# Dieses Fenster laeuft dauerhaft. Es startet die Bridge und prueft im
# Hintergrund alle paar Minuten, ob es eine neue Version gibt. Wenn ja, holt
# es sie (git pull) und startet die Bridge automatisch neu – du musst nichts
# tun. So kommen neue Funktionen von allein an, auch wenn du Aufgaben nur per
# iPhone schickst.
#
# (Alternativ kannst du die Auto-Aktualisierung auch direkt in der Bridge
#  einschalten: Setup -> "Automatisch aktualisieren". Dann reicht der normale
#  start-macos.command.)
#
# Intervall in Minuten (Standard 30) – bei Bedarf hier anpassen:
INTERVAL_MIN="${INTERVAL_MIN:-30}"

cd "$(dirname "$0")" || exit 1

if ! command -v git >/dev/null 2>&1; then
  echo "git wurde nicht gefunden – bitte manuell aktualisieren."
  read -n1 -r -p "Zum Schliessen eine Taste druecken …"
  exit 1
fi

BRIDGE_PID=""
# Bevorzugt ein aktuelles Python (python.org oder Homebrew): es bringt eine
# aktuelle SSL-Bibliothek mit (TLS 1.3). Ohne eines laeuft es wie bisher mit python3.
PY=python3
for c in /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if [ -x "$c" ] && "$c" -c 'import ssl,sys; sys.exit(0 if sys.version_info >= (3, 9) and ssl.HAS_TLSv1_3 and ssl.create_default_context().cert_store_stats()["x509_ca"] > 0 else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
echo "Python: $PY ($("$PY" -c 'import sys,ssl; print(sys.version.split()[0], "·", ssl.OPENSSL_VERSION)' 2>/dev/null))"

start_bridge() {
  # exec: the background job IS the bridge – so stop_bridge reaches it (before,
  # only the wrapping shell was stopped and the old bridge kept running)
  ( cd bridge && exec "$PY" shc_bridge.py serve ) &
  BRIDGE_PID=$!
  echo "Bridge gestartet (PID $BRIDGE_PID)."
  # Mac wach halten, solange genau diese Bridge laeuft (am Netzteil) – im
  # Ruhezustand ist sie am iPhone nicht erreichbar. Abschalten: BRIDGE_ALLOW_SLEEP=1
  if [ -z "$BRIDGE_ALLOW_SLEEP" ] && command -v caffeinate >/dev/null 2>&1; then
    caffeinate -s -w "$BRIDGE_PID" &
  fi
}

# Eine schon laufende Bridge zuerst sauber beenden: zwei gleichzeitig wuerden
# dieselbe Bosch-/AEG-Anmeldung benutzen – Bosch sperrt sie dann.
stop_running_bridge() {
  PIDS=$(pgrep -f "[s]hc_bridge\.py.* serve" 2>/dev/null | tr '\n' ' ')
  [ -z "${PIDS// /}" ] && return 0
  echo "Beende die laufende Bridge (PID $PIDS) …"
  kill -TERM $PIDS 2>/dev/null
  for _ in $(seq 1 50); do
    sleep 0.5
    pgrep -f "[s]hc_bridge\.py.* serve" >/dev/null 2>&1 || { echo "  beendet."; return 0; }
  done
  echo "  Sie reagiert nicht – erzwinge das Beenden."
  kill -KILL $PIDS 2>/dev/null
  sleep 1
}

stop_bridge() {
  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill -TERM "$BRIDGE_PID" 2>/dev/null
    wait "$BRIDGE_PID" 2>/dev/null
  fi
  stop_running_bridge          # also one started elsewhere (other window)
}

# sauber beenden, wenn das Fenster geschlossen wird
trap 'echo; echo "Beende …"; stop_bridge; exit 0' INT TERM

echo "Adresse am iPhone im Safari oeffnen. Zum Beenden Fenster schliessen oder Strg+C."
echo "Auto-Update: alle ${INTERVAL_MIN} Minuten."
echo
stop_running_bridge
start_bridge

while true; do
  sleep $(( INTERVAL_MIN * 60 ))
  echo "[$(date '+%H:%M')] Pruefe auf neue Version …"
  git fetch --quiet 2>/dev/null || { echo "  (offline – ueberspringe)"; continue; }
  BEHIND=$(git rev-list --count HEAD..@{u} 2>/dev/null || echo 0)
  if [ "$BEHIND" -gt 0 ] 2>/dev/null; then
    echo "  Neue Version gefunden – hole sie und starte neu."
    if git pull --ff-only; then
      stop_bridge
      start_bridge
    else
      echo "  git pull fehlgeschlagen (lokale Aenderungen?) – lasse alte Version weiterlaufen."
    fi
  else
    echo "  Bereits aktuell."
  fi
done
