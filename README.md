# Bosch Smart Home – Energie-App 🔌🔥📱

Eine schlanke iPhone-Web-App (PWA), die deinen **Stromverbrauch** sichtbar macht –
die Bosch **„Licht-/Rollladensteuerung II"**-Module **und** deine Bosch-Wärmepumpe,
**kombiniert** in einem kleinen Energiemanagement-System: live, historisch, als
Prognose und aufgeschlüsselt nach **wann, wie viel, wofür**. Läuft komplett in
deinem Heimnetz; die Wärmepumpe kommt über Bosch HomeCom Easy dazu.

![Ansichten](https://img.shields.io/badge/Ansichten-Übersicht·Heute·Verlauf·Wärmepumpe·Profil·PV-3ba9ff)

## Was du bekommst

| Ansicht | Inhalt |
|---|---|
| **Übersicht** | **Heute bisher** (kWh + Kosten), aktuelle Gesamtleistung inkl. Wärmepumpen-Anteil, Monats-Hochrechnung, **Wofür-heute-Donut** (Wärmepumpe + Geräte), letzte 14 Tage **gestapelt** (Smart Home vs. Wärmepumpe), Wärmepumpen-Kurzstatus |
| **Heute** | Verbrauch **nach Stunde** (Smart Home + Wärmepumpe gestapelt), Aufteilung heute als Donut mit Kosten, Smart-Home-Geräte heute |
| **Verlauf** | kWh **pro Tag** (14/30/90 Tage) bzw. **pro Monat** (1 Jahr, fehlende Monate geschätzt), gestapelt nach Quelle; **Anteil je Quelle**; **Abwesenheit** (wie oft ihr nicht zuhause wart) + Kalender; **Jahres-Hochrechnung** & Einordnung |
| **Wärmepumpe** | Live-Karte (elektr./therm. Leistung, **COP jetzt**, Zähler-Splits Kompressor/Heizstab, Temperaturen, Starts/Stunden), **Strom & Wärme pro Tag**, **COP-Verlauf**, **COP pro Monat**, **Monatsbilanz**, **Wärmekarte** Wochentag × Stunde, **Theorie vs. Praxis** (erwarteter Stromverbrauch aus deinen Gebäudedaten – U·A + Heizgradtage – gegen den gemessenen Verbrauch, mit den größten Sanierungs-Hebeln) |
| **Profil** | Ø-Leistung je **Stunde** (Tagesprofil), Ø-kWh je **Wochentag**, **Wärmekarte** Wochentag × Stunde (Smart Home) |
| **PV** | **PV-Planer** für eine geplante Anlage: Anlagengröße/Ausrichtung/Batterie/**E-Auto** eingeben → **Jahresertrag**, **Eigenverbrauch & Autarkie** (aus deinem echten Tagesprofil simuliert), Ersparnis, **PV-Ertrag vs. Verbrauch pro Monat**, typischer Sommertag und **Amortisation**. Knopf **„kWp & Speicher vorschlagen"** dimensioniert aus deinem Verbrauch. |

Auf der **Übersicht** erscheinen zusätzlich verbundene **AEG/Electrolux-Haushaltsgeräte**
(Waschmaschine, Trockner) mit **Zustand, Strom pro Waschgang und Gesamtzähler** – siehe
**[docs/AEG.md](docs/AEG.md)**.
| **Setup** | Strompreis, **Controller automatisch finden**, Kopplung per Formular, Live-Status, **Geräte lokal umbenennen**, **Wärmepumpe (HomeCom) verbinden**, **Wärmepumpen-Historie als CSV importieren**, **AEG/Electrolux verbinden**, **Bridge aktualisieren** (Self-Update, manuell oder **automatisch** im Hintergrund) |

Der Smart-Home-Teil basiert auf den `PowerMeter`-Daten (Wirkleistung in W,
Energiezähler in Wh) der Bosch-Module; die Wärmepumpe liefert kumulative
Energiezähler (Strom = Kompressor + Heizstab, Wärme = erzeugte Energie), aus
denen die Bridge Leistung, COP und Historie ableitet.

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

### macOS – per Doppelklick

Nach dem Klonen (siehe unten) im Finder einfach doppelklicken:

* **`demo-macos.command`** – startet die Demo.
* **`start-macos.command`** – startet den Normalbetrieb (Kopplung dann am iPhone im Tab *Setup*).
* **`auto-update-macos.command`** – startet den Normalbetrieb **und hält die Bridge automatisch aktuell**: prüft alle paar Minuten auf neue Versionen, holt sie (git pull) und startet neu. Praktisch, wenn du Aufgaben nur per iPhone schickst. *Dasselbe geht auch ohne Extra-Skript direkt in der App:* Tab *Setup* → **„Automatisch aktualisieren"**.

Beim allerersten Start fragt macOS evtl. „Eingehende Verbindungen erlauben?" → **Erlauben**.
Falls Gatekeeper meckert: Rechtsklick auf die Datei → **Öffnen**.
Tipp: Statt der IP kannst du am iPhone auch `http://<Mac-Name>.local:8090/` als festen Link nutzen.

**Klonen auf dem Mac** (Terminal):
```bash
git clone https://github.com/Kurt57/Bosch-Smart-Home.git
cd Bosch-Smart-Home
git checkout claude/bosch-smart-home-energy-c6p99e
```

## Mit deinem echten Controller

**Am einfachsten – Kopplung direkt in der App:**
```bash
cd bridge
python3 shc_bridge.py serve      # ohne Argumente starten
```
Seite am iPhone öffnen → Tab **Setup** → **„Controller automatisch finden"** →
Systempasswort eingeben → kurz den Knopf am Controller II drücken → **„Jetzt
koppeln"**. Die App schaltet automatisch auf Live.

*Alternativ per Kommandozeile:*
```bash
cd bridge
cp config.example.json config.json      # IP + Systempasswort eintragen
python3 shc_bridge.py pair               # dann kurz Knopf am Controller II drücken
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
