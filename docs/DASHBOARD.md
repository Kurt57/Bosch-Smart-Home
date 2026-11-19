# Wohn-Dashboard (`…/#dash`) und Haus-Dashboard (`…/#dash2`)

Vollbild-Ansicht für ein Wand-iPad oder ein altes Tablet: die App mit `#dash` am Ende der
Adresse öffnen (z. B. `http://<bridge>:8090/#dash`) und zum Homescreen hinzufügen.

* **Hell/Dunkel:** dunkel ist Standard; der Knopf 🌙/☀️ oben schaltet um, die Wahl bleibt auf
  diesem Gerät gespeichert.
* **Hinweis-Kacheln** oben – nur was gerade Aufmerksamkeit braucht, Dringendes pulsiert:
  * 🪟/🚪 Fenster oder Tür offen – ab 10 Minuten pulsierend (einstellbar), rot bei laufender
    Heizung, Kälte draußen oder „Abwesend“. Die Dauer zählt ab dem Moment, ab dem die Bridge das
    Öffnen bemerkt hat.
  * 🌬️ lüften (Feuchte/Luftqualität), 🥶 Raum deutlich unter Soll.
  * 📅 Termin in der nächsten Stunde, 🗑️ Mülltonnen am Vorabend (ab 16 Uhr) und am Morgen.
  * 🔋 Batterie lädt aus dem Netz, ☀️/♨️ PV-Anlage oder Wärmepumpe ohne aktuelle Werte,
    ⚡ sehr hoher Verbrauch.
* **Banner:** nur wenn es etwas zu tun gibt – PV-Überschuss jetzt nutzen bzw. Börsenstrom
  günstig/teuer. Die Geldbilanz der PV-Anlage steht in „Heute“ (siehe unten).
* **Termine:** heute, morgen und die nächsten Tage aus deinen Kalendern und der Müllabfuhr. Auf
  breiten Bildschirmen (ab etwa 760 Pixel, z. B. iPad) stehen Termine und Stundenplan nebeneinander.
* **Energiefluss:** Sonne, Batterie, Haus, Netz – gemessen vom Wechselrichter – und vom Haus aus
  Linien zu den größten Verbrauchern (Wärmepumpe, Geräte, nicht einzeln gemessener Rest).
* **Heute** (mit PV-Anlage und Smart Meter): ein Ring mit der **Autarkie** – dem Anteil deines
  Verbrauchs, der nicht aus dem Netz kam – und daneben der Wert von gestern. Kacheln: **Sonne**
  (kWh, wie viel davon selbst genutzt), **verbraucht** (mit Wärmepumpe und ihrem Sonnenanteil),
  **aus dem Netz** (und eingespeist), **gespart** (€, davon Einspeisung), **Batterie** (jetzt und
  heute min–max) und **CO₂ vermieden** (Sonnenstrom × CO₂-Gehalt des Netzstroms in derselben
  Stunde, dasselbe Modell wie im Tab Börse – eine Schätzung). Darunter 7 Tage, Monat, seit
  Anschluss und der beste Sonnentag. Auf breiten Bildschirmen (iPad quer) neben dem Energiefluss.
* **Räume:** Temperatur, Soll, Fenster, Luft.

**Einstellungen:** Setup → **🖥️ Wohn-Dashboard** – ab wie vielen **Sekunden** der Fenster-Hinweis
blinkt (Standard 600 s; zum Testen z. B. 1 s) und wie viele **Abende vorher** der Tonnen-Hinweis
erscheint (Standard 1). Gilt für alle Geräte; ein laufendes Dashboard übernimmt die Werte innerhalb
einer Minute. Ist ein Fenster offen, schaut das Dashboard alle 20 Sekunden nach.

Auf Handy-Breite rutschen Außentemperatur und „aktualisiert“ in eine zweite Zeile, damit die
Knöpfe oben (Zuhause/Abwesend, Hell/Dunkel, ✕) im Bild bleiben.

## Haus-Dashboard (`…/#dash2`)

Die zweite Dashboard-Seite zeigt die PV-Anlage als **Haus-Grafik** (eigene Zeichnung): Dach mit
Modulen, Wechselrichter und Batterie an der Hauswand, Garage mit Auto und Wallbox, Wärmepumpe und
der Hausanschluss am Mast. Hell, im Stil einer Hersteller-App. Öffnen: `…/#dash2`, Setup →
**🏡 Haus-Dashboard**, oder im Wohn-Dashboard nach links wischen bzw. unten auf den zweiten Punkt
tippen (zurück: nach rechts wischen oder der erste Punkt).

* **Kopf:** „Zuhause“ mit Status – grün **Normal**, wenn der Wechselrichter aktuelle Werte liefert
  (höchstens 2 Minuten alt), sonst orange. Der Haus-Blitz-Knopf zeigt den **Notstrom-Status**
  (GEN24 `BackupMode`; wird er nicht gemeldet, steht das dabei), „…“ führt zum Wohn-Dashboard, zur
  PV-Auswertung oder zurück in die App.
* **Werte am Haus** (gemessen vom Wechselrichter und Smart Meter, alle 10 Sekunden):
  **Solar** (PV-Leistung), **Andere Lasten** (Hausverbrauch ohne Wallbox), **Batterie** (Lade- bzw.
  Entladeleistung und Ladestand; orange unter 15 %), **Stromnetz** (Bezug oder Einspeisung) und
  **Wallbox**. Die Leitungen zeigen mit laufenden Strichen, wohin der Strom gerade fließt.
* **Wallbox:** Der Wechselrichter misst keine Wallbox. Die Karte zeigt einen Wert nur, wenn ein
  gemessenes Gerät in der App „Wallbox“, „Ladestation“, „Ladepunkt“ oder „E-Auto“ heißt (Name in
  der Geräteliste); sonst steht dort „keine Messung“ statt erfundener 0 W.
* **Tägliche Energie:** drei Reiter – ⚡ **Solar** (heute erzeugt, Ring = Eigenverbrauchsquote,
  selbst genutzt/eingespeist), 🔋 **Batterie** (lädt/entlädt/Standby, verbleibende Energie =
  Ladestand × Kapazität laut Wechselrichter, Ring = Ladestand, heute auf- und entladen) und
  **Netz** (Bezug/Einspeisung jetzt, Ring = Autarkie heute, bezogen/eingespeist). Das
  Balken-Symbol öffnet die PV-Auswertung, ein Tipp auf „Solar ›“ ebenfalls.
* Ohne verbundene PV-Anlage stehen überall Striche und ein Hinweis aufs Setup.

## Stundenplan

Setup → **🎒 Stundenplan im Wohn-Dashboard**: eine Zeile je Stunde im Format
`08:10-08:55 | Mo | Di | Mi | Do | Fr` („-“ = frei), darunter eine Vorschau. Das Dashboard zeigt
den heutigen bzw. – nach Schulschluss, am Wochenende, an Feiertagen – den nächsten Schultag mit
der laufenden Stunde und dem Schulschluss. Hinweise: „Morgen Sport – Sportsachen einpacken“ ab
16 Uhr, „Heute Sport“ morgens vor Schulbeginn, „Schule aus um …“ in der letzten halben Stunde.
Feiertage in NRW werden selbst berechnet; **Ferien** und bewegliche Ferientage als ganztägigen
Termin mit „Ferien“ oder „schulfrei“ im Namen in den Kalender eintragen. Der Plan liegt wie die
übrigen App-Einstellungen in der Bridge, nicht im Repository.

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
