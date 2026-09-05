#!/bin/bash
# Doppelklick auf diese Datei startet die Bridge im Normalbetrieb.
# Beim ersten Mal ist noch nichts gekoppelt: die angezeigte Adresse am iPhone
# oeffnen und im Tab "Setup" den Controller finden und koppeln.
cd "$(dirname "$0")/bridge" || exit 1

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 wurde nicht gefunden."
  echo "Bitte im Terminal 'xcode-select --install' ausfuehren und danach erneut versuchen."
  read -n1 -r -p "Zum Schliessen eine Taste druecken …"
  exit 1
fi

echo "Starte Bosch Home Strom Bridge …"
echo "Adresse am iPhone im Safari oeffnen, dann Setup -> Controller finden -> koppeln."
echo "Zum Beenden dieses Fenster schliessen oder Strg+C druecken."
echo
exec python3 shc_bridge.py serve
