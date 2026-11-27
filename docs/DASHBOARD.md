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
  **aus dem Netz** (und eingespeist), **gespart** (€, davon Einspeisung; dazu „+ ≈ … € im Akku“, solange heute
  Geladenes noch nicht verbraucht ist – siehe [FRONIUS.md](FRONIUS.md#so-rechnet-gespart)), **Batterie** (jetzt und
  heute min–max) und **CO₂ vermieden** (Sonnenstrom × CO₂-Gehalt des Netzstroms in derselben
  Stunde, dasselbe Modell wie im Tab Börse – eine Schätzung). Darunter 7 Tage, Monat, seit
  Anschluss und der beste Sonnentag. Auf breiten Bildschirmen (iPad quer) neben dem Energiefluss.
* **Räume:** Temperatur, Soll, Fenster, Luft.

**Einstellungen:** Setup → **🖥️ Wohn-Dashboard** – ab wie vielen **Sekunden** der Fenster-Hinweis
blinkt (Standard 600 s; zum Testen z. B. 1 s) und wie viele **Abende vorher** der Tonnen-Hinweis
erscheint (Standard 1). Gilt für alle Geräte; ein laufendes Dashboard übernimmt die Werte innerhalb
einer Minute. Ist ein Fenster offen, schaut das Dashboard alle 20 Sekunden nach. Dort auch fürs Apple TV:
ab welcher Leistung ein Gerät mit Messung (Standard 100 W) und der „Rest im Haus“ (Standard 150 W) als
**weitere Verbraucher** unter dem Energiefluss erscheinen – mit Vorschau, was gerade gemessen wird
([APPLETV.md](APPLETV.md)).

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

## Feier-Modus (Geburtstag, Jahrestag)

Setup → **🖥️ Wohn-Dashboard** → *🎉 Feier-Modus*: Glückwunsch eintippen (optional) → **„Heute feiern“**.
Dann zeigen Wohn-Dashboard, Haus-Dashboard und Apple TV den Glückwunsch mit **Konfetti** (beim Öffnen,
alle 10 Minuten und beim Antippen des Banners); im Wohn-Dashboard leuchtet der Hintergrund in Partyfarben, die
App selbst grüßt am Feiertag einmal pro Gerät. Von selbst feiert das Dashboard an einem **ganztägigen
Kalendertermin** mit „Geburtstag“, „Birthday“, „Doğum Günü“, „Jahrestag“, „Hochzeitstag“ oder 🎂 im Namen
(abschaltbar: „Geburtstage aus dem Kalender automatisch feiern“). **„Beenden“** schaltet ihn für den Tag ab,
um Mitternacht endet er ohnehin. Der Text wird wie die übrigen Einstellungen in der Bridge gespeichert
(`bhe_party_text`, `bhe_party_date`, `bhe_party_off`, `bhe_party_auto`) – nichts davon steht im Repository.
Mit „Bewegung reduzieren“ in den Bedienungshilfen gibt es den Glückwunsch ohne Konfetti.

## Fußball im Kalender

Setup → **⚽ Fußball im Kalender**: Mannschaft suchen (Vereine und Nationalmannschaften; Nationalmannschaften
auch auf Deutsch, z. B. „Türkei“ oder „turkei“, und so angezeigt; türkische Buchstaben gehen) → mit ＋ übernehmen, bis zu 8. Die Bridge holt die
nächsten und die letzten Spiele alle 3 Stunden aus dem freien Verzeichnis **TheSportsDB** (gesendet werden nur der
Name bei der Suche bzw. die Nummer der Mannschaft) und trägt sie als Termine ein: im Wohn-Dashboard und auf dem
Apple TV, eine Stunde vorher als Hinweis; auf dem Apple TV laufen Ergebnisse und nächste Spiele durchs Laufband.
Anstoßzeiten kommen aus dem Verzeichnis in UTC und werden in Ortszeit gezeigt. Live-Spielstände bietet der freie
Zugang nicht – das Ergebnis steht da, sobald das Verzeichnis es hat. Ob der freie Zugang alle Spiele einer
Mannschaft liefert, legt der Anbieter fest; im Setup siehst du sofort, ob die Suche klappt.

## Nachrichten

Setup → **📰 Nachrichten**: einen Vorschlag antippen (tagesschau, Deutschlandfunk, SPIEGEL, ZEIT, kicker, NTV,
Hürriyet, BBC) oder eine RSS-/Atom-Adresse eintragen – jeder Feed wird vor dem Übernehmen geprüft (die Vorschläge
sind Adressen, die die Sender veröffentlichen; ändert einer seine Adresse, meldet die Prüfung das). Bis zu 6 Feeds;
die Bridge holt sie alle 15 Minuten im Hintergrund (`GET /api/news`) und behält nur Titel, Link und Zeit. Im
Wohn-Dashboard steht eine Liste der neuesten Schlagzeilen, auf dem Apple TV laufen sie durchs Laufband und stehen
weiter unten als Liste. Feeds mit DOCTYPE-Angabe werden aus Sicherheitsgründen nicht gelesen.

## Kinder-Routine

Setup → **🧒 Kinder-Routine**: einschalten, zwei Namen (mit Tier-Symbol), Uhrzeit (Abendroutine, Standard
18:30–20:30) und die Aufgaben – eine pro Zeile, ein Emoji vorne ist erlaubt. Eine Zeile `Name: Aufgabe` gilt nur
für dieses Kind (z. B. den Schulranzen nur für das Schulkind). Während der Uhrzeit steht im Wohn-Dashboard je Kind
eine **Abhakliste** mit großen Tippflächen und Fortschrittsbalken, auf dem Apple TV dieselbe Liste zum Abhaken mit
der Fernbedienung. Die Bridge führt die Häkchen (`GET /api/routine`, `POST /api/routine/toggle`), deshalb sehen
iPad, Handy und Fernseher immer denselben Stand; um Mitternacht beginnt ein neuer Tag (eine Routine über
Mitternacht gehört zum Abend, an dem sie begann). Wer fertig ist, bekommt Konfetti, ein Lob und einen **⭐** –
gezählt werden die geschafften Abende der letzten 7 Tage.

Zum Ausprobieren: **„Heute zum Testen den ganzen Tag zeigen“** (endet um Mitternacht oder per Knopf),
**„Häkchen von heute löschen“** setzt zurück; die Vorschau im Setup lässt sich wie die echte Liste abhaken.
Namen und Aufgaben stehen nur in den Einstellungen der Bridge (`bhe_routine`), nicht im Repository.

## Apple TV

Das Wohn-Dashboard gibt es auch als eigene **Apple-TV-App** (Ordner `appletv/`, Daten über `GET /api/tv`) –
Installation mit Xcode und alles Weitere in **[APPLETV.md](APPLETV.md)**. Ohne App: iPad oder Mac per
AirPlay-Bildschirmsynchronisierung aufs Apple TV spiegeln.

## Musik (YouTube Music)

Setup → **„🎵 Musik im Wohn-Dashboard“**: Playlists per Link hinzufügen (YouTube Music → Playlist →
Teilen → Link kopieren). Das Dashboard zeigt sie als Kacheln mit Titel und – bei öffentlichen oder nicht
gelisteten Playlists – Bild (über YouTubes öffentliche oEmbed-Schnittstelle; private Playlists bekommen
den Namen, den du einträgst). Gilt auf allen Geräten.

* **Antippen** öffnet die Playlist in der **YouTube-Music-App**. Den HomePod wählst du dort über das
  Cast-/AirPlay-Symbol. Ist YouTube Music mit dem HomePod verbunden (YouTube Music → Einstellungen →
  Verknüpfte Apps), geht auch „Hey Siri, spiel … auf YouTube Music im Wohnzimmer“.
* **Ein-Tipp per Kurzbefehl (optional):** HomePod-/Raumnamen eintragen und „Ein-Tipp über iOS-Kurzbefehle“
  einschalten. Das Dashboard zeigt dann Knöpfe für die HomePods (Auswahl je Gerät gespeichert) und startet
  beim Antippen den Kurzbefehl „Musik &lt;Raum&gt;“ mit dem Playlist-Link als Eingabe. Der Kurzbefehl
  (einmal je HomePod anlegen): „URLs öffnen“ (Kurzbefehleingabe) → „Warten“ 3 s → „Wiedergabe/Pause“
  auf „Wiedergabe“ → „Wiedergabeziel festlegen“ (HomePod). Auf einem echten iPhone ungetestet – startet
  die Musik nicht, die letzten beiden Schritte tauschen.

**Grenzen:** YouTube Music hat keine offizielle Schnittstelle, über die eine fremde App Musik startet,
steuert oder HomePods auswählt. Die Musik über die Bridge abzugreifen und selbst an die HomePods zu
schicken, wäre ein Verstoß gegen YouTubes Bedingungen und in Deutschland das Umgehen einer technischen
Schutzmaßnahme – das macht die App bewusst nicht. Im „Geführten Zugriff“ (Wand-iPad) darf das Dashboard
keine anderen Apps öffnen. Technisch: `GET /api/music/meta?url=…` (`bridge/ytmusic.py`).

## Müllabfuhr (AWB Köln)

Setup → **🗑️ Müllabfuhr (AWB Köln)** → Straße und Hausnummer → „Adresse suchen“ → deine
Adresse antippen. Die Bridge holt die Abfuhrtermine (Rest-, Bio-, Papier-, Wertstofftonne …) für
ein Jahr und frischt sie alle 12 Stunden auf.

AWB Köln hat **keine offiziell dokumentierte Schnittstelle**. Die App nutzt dieselben
JSON-Abfragen wie der Abfuhrkalender auf awbkoeln.de (`/api/streets`, `/api/calendar`), die auch
die Home-Assistant-Integration „waste_collection_schedule“ verwendet. Ändert AWB sie, zeigt das
Setup eine Fehlermeldung. Die Adresse bleibt lokal und geht nur an awbkoeln.de
(`bridge/awb_koeln.py`).
