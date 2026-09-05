# Bosch Smart Home – Strom-App 🔌📱

Eine schlanke iPhone-Web-App (PWA), die den **Stromverbrauch deiner Bosch
„Licht-/Rollladensteuerung II"**-Module sichtbar macht – live, historisch und als
Prognose. Läuft komplett in deinem Heimnetz, ohne Cloud.

![Ansichten](https://img.shields.io/badge/Ansichten-Live·Verbrauch·Profil·Abwesenheit·Prognose-3ba9ff)

## Was du bekommst

| Ansicht | Inhalt |
|---|---|
| **Live** | Aktuelle Leistung (W) aller Module **kumuliert** und je Gerät, Grundlast/Standby, heute geschätzt + Kosten, Gesamt gemessen (kWh) |
| **Verbrauch** | kWh **pro Tag** (14/30/90 Tage), abwesende Tage rot markiert, Anteil je Gerät am Gesamtverbrauch |
| **Profil** | Ø-Leistung je **Stunde** (Tagesprofil), Ø-kWh je **Wochentag**, **Wärmekarte** Wochentag × Stunde |
| **Abwesenheit** | Heuristische Schätzung, **wie oft ihr nicht zuhause wart**, Anwesenheit pro Tag + Kalender |
| **Prognose** | **Jahres-Hochrechnung** (kWh + €), Monat/Tag, Standby-Anteil, Einordnung, konfigurierbarer Strompreis |

Alles basiert ausschließlich auf den `PowerMeter`-Daten (Wirkleistung in W,
Energiezähler in Wh) der Bosch-Module – genau wie gewünscht.

## Architektur

```
   Bosch SHC  ──mTLS──▶  bridge/shc_bridge.py  ──HTTP──▶  frontend/  (PWA auf dem iPhone)
 (lokales LAN)          (Python, ohne pip)               index.html + app.js
```

* **bridge/** – eine kleine Python-Bridge (nur Standardbibliothek). Sie meldet
  sich per Client-Zertifikat am Controller an, fragt regelmäßig die Leistungs-
  werte ab, speichert sie in SQLite und liefert eine JSON-API **plus** die Web-App.
* **frontend/** – die Single-File-PWA mit eigenen SVG-Diagrammen (keine externen
  Bibliotheken). Funktioniert auch **ohne Bridge im Demo-Modus**, damit du sofort
  siehst, wie alles aussieht.

## Schnellstart (Demo, ohne Controller)

```bash
cd bridge
python3 shc_bridge.py serve --demo
```

Dann am iPhone (gleiches WLAN) die angezeigte Adresse öffnen,
z. B. `http://192.168.x.x:8090/`.

## Mit deinem echten Controller

1. Einmalig anmelden (Client-Zertifikat wird erzeugt und gekoppelt):
   ```bash
   cd bridge
   cp config.example.json config.json      # IP + Systempasswort eintragen
   python3 shc_bridge.py pair               # dann Knopf am SHC drücken
   ```
2. Starten:
   ```bash
   python3 shc_bridge.py serve
   ```

Ausführliche Anleitung inkl. „Zum Home-Bildschirm hinzufügen":
siehe **[docs/SETUP.md](docs/SETUP.md)**.

## Voraussetzungen

* Python 3.9+ (für die Bridge) auf einem Gerät, das dauerhaft läuft
  (Raspberry Pi, NAS, Mac/PC).
* `openssl` (nur einmalig fürs Erzeugen des Client-Zertifikats).
* iPhone im gleichen WLAN.

## Datenschutz

Alle Daten bleiben lokal (SQLite in `bridge/energy.db`). Zertifikat, Passwort
und Datenbank sind per `.gitignore` von Commits ausgeschlossen.
