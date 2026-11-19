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

stop_running_bridge
echo
echo "Starte die Bridge …"
echo "Adresse am iPhone im Safari oeffnen. Zum Beenden Fenster schliessen oder Strg+C."
echo
cd bridge || exit 1
# Bevorzugt ein aktuelles Python (python.org oder Homebrew): es bringt eine
# aktuelle SSL-Bibliothek mit (TLS 1.3). Ohne eines laeuft es wie bisher mit python3.
PY=python3
for c in /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if [ -x "$c" ] && "$c" -c 'import ssl,sys; sys.exit(0 if sys.version_info >= (3, 9) and ssl.HAS_TLSv1_3 and ssl.create_default_context().cert_store_stats()["x509_ca"] > 0 else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
echo "Python: $PY ($("$PY" -c 'import sys,ssl; print(sys.version.split()[0], "·", ssl.OPENSSL_VERSION)' 2>/dev/null))"
exec "$PY" shc_bridge.py serve
