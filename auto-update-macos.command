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

start_bridge() {
  ( cd bridge && python3 shc_bridge.py serve ) &
  BRIDGE_PID=$!
  echo "Bridge gestartet (PID $BRIDGE_PID)."
}

stop_bridge() {
  if [ -n "$BRIDGE_PID" ] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill "$BRIDGE_PID" 2>/dev/null
    wait "$BRIDGE_PID" 2>/dev/null
  fi
}

# sauber beenden, wenn das Fenster geschlossen wird
trap 'echo; echo "Beende …"; stop_bridge; exit 0' INT TERM

echo "Adresse am iPhone im Safari oeffnen. Zum Beenden Fenster schliessen oder Strg+C."
echo "Auto-Update: alle ${INTERVAL_MIN} Minuten."
echo
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
