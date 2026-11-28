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
# Bevorzugt ein aktuelles Python (python.org oder Homebrew): es bringt eine
# aktuelle SSL-Bibliothek mit (TLS 1.3). Ohne eines laeuft es wie bisher mit python3.
PY=python3
for c in /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if [ -x "$c" ] && "$c" -c 'import ssl,sys; sys.exit(0 if sys.version_info >= (3, 9) and ssl.HAS_TLSv1_3 and ssl.create_default_context().cert_store_stats()["x509_ca"] > 0 else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
echo "Python: $PY ($("$PY" -c 'import sys,ssl; print(sys.version.split()[0], "·", ssl.OPENSSL_VERSION)' 2>/dev/null))"
exec "$PY" shc_bridge.py serve --demo
