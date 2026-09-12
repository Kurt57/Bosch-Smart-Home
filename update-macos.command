#!/bin/bash
# Doppelklick: holt den neuesten Code (git pull) und startet die Bridge neu.
# (Alternativ geht das auch direkt in der App: Setup -> "Bridge aktualisieren".)
cd "$(dirname "$0")" || exit 1

if ! command -v git >/dev/null 2>&1; then
  echo "git wurde nicht gefunden – bitte manuell aktualisieren."
  read -n1 -r -p "Zum Schliessen eine Taste druecken …"
  exit 1
fi

echo "Hole neuesten Code …"
git pull --ff-only || {
  echo "git pull fehlgeschlagen (lokale Aenderungen?)."
  read -n1 -r -p "Zum Schliessen eine Taste druecken …"
  exit 1
}

echo
echo "Starte die Bridge …"
echo "Adresse am iPhone im Safari oeffnen. Zum Beenden Fenster schliessen oder Strg+C."
echo
cd bridge || exit 1
exec python3 shc_bridge.py serve
