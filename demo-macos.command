#!/bin/bash
# Doppelklick auf diese Datei startet die Bridge mit DEMO-Daten.
# (Zum Ausprobieren ohne Controller.)
cd "$(dirname "$0")/bridge" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 wurde nicht gefunden."
  echo "Bitte im Terminal 'xcode-select --install' ausfuehren und danach erneut versuchen."
  read -n1 -r -p "Zum Schliessen eine Taste druecken …"
  exit 1
fi

echo "Starte Bosch Home Strom (DEMO) …"
echo "Danach die unten angezeigte Adresse am iPhone im Safari oeffnen."
echo "Zum Beenden dieses Fenster schliessen oder Strg+C druecken."
echo
exec python3 shc_bridge.py serve --demo
