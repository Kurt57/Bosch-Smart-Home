# Wohn-Dashboard (`…/#dash`)

Vollbild-Ansicht für ein Wand-iPad oder ein altes Tablet: die App mit `#dash` am Ende der
Adresse öffnen (z. B. `http://<bridge>:8090/#dash`) und zum Homescreen hinzufügen.

* **Hell/Dunkel:** dunkel ist Standard; der Knopf 🌙/☀️ oben schaltet um, die Wahl bleibt auf
  diesem Gerät gespeichert.
* **Hinweis-Kacheln** oben – nur was gerade Aufmerksamkeit braucht, Dringendes pulsiert:
  * 🪟/🚪 Fenster oder Tür offen – ab 10 Minuten pulsierend, rot bei laufender Heizung, Kälte
    draußen oder „Abwesend“. Die Dauer zählt ab dem Moment, ab dem die Bridge das Öffnen bemerkt hat.
  * 🌬️ lüften (Feuchte/Luftqualität), 🥶 Raum deutlich unter Soll.
  * 📅 Termin in der nächsten Stunde, 🗑️ Mülltonnen am Vorabend (ab 16 Uhr) und am Morgen.
  * 🔋 Batterie lädt aus dem Netz, ☀️/♨️ PV-Anlage oder Wärmepumpe ohne aktuelle Werte,
    ⚡ sehr hoher Verbrauch.
* **Banner:** PV-Überschuss jetzt nutzen bzw. Börsenstrom günstig/teuer; sonst die Geldbilanz der
  PV-Anlage (heute, Monat, seit Anschluss). Ohne Aussage kein Banner.
* **Termine:** heute, morgen und die nächsten Tage aus deinen Kalendern und der Müllabfuhr.
* **Energiefluss:** Sonne, Batterie, Haus, Netz – gemessen vom Wechselrichter – und vom Haus aus
  Linien zu den größten Verbrauchern (Wärmepumpe, Geräte, nicht einzeln gemessener Rest).
* **Räume:** Temperatur, Soll, Fenster, Luft.

## Kalender

Setup → **📅 Kalender im Wohn-Dashboard** → Adresse einfügen → „Speichern & prüfen“.

* **iPhone (iCloud):** Kalender-App → *Kalender* → ⓘ neben dem Kalender → *Öffentlicher
  Kalender* einschalten → *Link teilen …* (beginnt mit `webcal://`).
* **Google:** Kalender-Einstellungen → *Privatadresse im iCal-Format*.

Mehrere Kalender: eine Adresse pro Zeile. Die Adressen stehen nur in `bridge/config.json`
(nicht im Repository); wer eine Adresse kennt, kann den Kalender lesen. Die Bridge holt die
Kalender alle 15 Minuten (`bridge/calendar_ics.py`, nur lesend; Wiederholungen, Ausnahmen,
ganztägige Termine und Zeitzonen werden berücksichtigt).

## Müllabfuhr (AWB Köln)

Setup → **🗑️ Müllabfuhr (AWB Köln)** → Straße und Hausnummer → „Adresse suchen“ → deine
Adresse antippen. Die Bridge holt die Abfuhrtermine (Rest-, Bio-, Papier-, Wertstofftonne …) für
ein Jahr und frischt sie alle 12 Stunden auf.

AWB Köln hat **keine offiziell dokumentierte Schnittstelle**. Die App nutzt dieselben
JSON-Abfragen wie der Abfuhrkalender auf awbkoeln.de (`/api/streets`, `/api/calendar`), die auch
die Home-Assistant-Integration „waste_collection_schedule“ verwendet. Ändert AWB sie, zeigt das
Setup eine Fehlermeldung. Die Adresse bleibt lokal und geht nur an awbkoeln.de
(`bridge/awb_koeln.py`).
