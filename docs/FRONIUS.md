# PV-Anlage anbinden (Fronius-Wechselrichter)

Die App liest deinen **Fronius-Wechselrichter** (Symo/Primo **GEN24 Plus**, Tauro oder ältere
Symo/Primo mit Datamanager) **direkt im Heimnetz** über die **Fronius Solar API** – ohne Konto,
ohne Cloud und **nur lesend**: Die Bridge stellt am Wechselrichter nichts um.

Was du danach siehst:

* **Übersicht → Energiefluss jetzt:** Sonne, Haus, Batterie, Netz und Wärmepumpe mit
  laufenden Pfeilen, dazu die Zahlen von heute (PV, Autarkie, Eigenverbrauch, Einspeisung,
  Netzbezug, gespart, Anteil Sonnenstrom an der Wärmepumpe, Batterie).
* **Tab PV → Deine PV-Anlage:** dasselbe plus der **Tagesverlauf** (PV, Verbrauch,
  Batterie-Ladestand), **Verlauf** über 7/30/90 Tage oder ein Jahr („Wohin ging der
  Sonnenstrom?", „Woher kam dein Strom?", typischer Tag), **Monatswerte** mit Vergleich
  zur **Erwartung** aus dem PV-Planer/PVGIS sowie **Wechselrichter, Strings, Batterie und
  Smart Meter** im Detail (Strings, Batterie mit Spannung/Strom/Temperatur/Modus, Smart Meter je
  Phase mit Leistung, Strom, Spannung und cos φ). Der PV-Planer bleibt darunter für Erweiterungen.
* **Tab PV → Wetter:** unter den Zahlen von heute drei Kacheln – heute, morgen, übermorgen – mit
  Wetterart (sonnig, heiter, wechselhaft, trüb; Regen/Schnee), **Sonnenstunden** von den Stunden
  Tageslicht, **Bewölkung**, Temperatur und dem **erwarteten Ertrag** (siehe „Wie gerechnet
  wird“). Im Verlauf („Erzeugung & Verbrauch“) unter den PV-Balken die **Sonnenstunden je Tag**
  (bzw. je Stunde beim Zeitraum „Tag“, je Monat beim Jahr) genau darunter, das Wetter im Tooltip jedes
  Balkens und eine Zusammenfassung (Sonnenstunden, Bewölkung, sonnige/wechselhafte/trübe Tage,
  sonnigster und trübster Tag mit ihrem Ertrag).
* **Zeitraum „Tag“** im Verlauf: dieselben Kennzahlen für einen Tag, die Balken je Stunde. Mit
  **◀ ▶** blätterst du durch die Tage (bis zum ersten gespeicherten), „→ heute“ springt zurück.
  Für frühere Tage steht das Tageswetter da (Wetter je Stunde gibt es nur für heute); ein Tag ohne
  gespeicherte Werte wird benannt.
* **PV-Planer → 🔬 Theorie vs. Praxis** (unter „PV-Nutzung pro Monat“): je Monat, was der Planer für
  deine Anlage erwartet, neben dem, was sie gemessen gemacht hat – vier Balken pro Monat (PV
  Theorie/Praxis aufgeteilt in direkt genutzt, in die Batterie, eingespeist; Verbrauch
  Theorie/Praxis aufgeteilt in selbst gedeckt und Netzbezug) und eine Tabelle mit Abweichungen
  bei PV, Verbrauch, Netzbezug und Autarkie. Die Theorie rechnet mit der installierten Leistung
  und der Batterie laut Wechselrichter, der Ausrichtung der Strings (wenn eingetragen, sonst der
  des Planers) und dem Verbrauch laut Planer, für ein Durchschnittsjahr; angefangene Monate nur
  anteilig. Darunter eine Einordnung des letzten Monats: weniger PV bei trübem Wetter (Vergleich
  der Sonnenstunden mit dem Mittel für den Monat) ist normal, bei normaler Sonne lohnt ein Blick
  auf Verschattung und Ausrichtung; weicht der Verbrauch stark ab, sollte der Planer angepasst werden.
* **Tab PV → 🧵 String-Vergleich:** die beiden MPP-Tracker (Strings) nebeneinander – jetzt, heute
  als Kurven, je Tag, je kWp, wann sie erzeugen, mit Bewertung (siehe unten).
* **Tab PV → 🔎 Plausibilitätsprüfung:** passen die gespeicherten Zahlen zueinander? (siehe unten)
* **Profil → ⚡ Lastspitzen & Dimensionierung:** mit Smart Meter der **gemessene Verbrauch des
  ganzen Hauses** statt der Summe der einzeln gemessenen Steckdosen plus Schätzung: Lastdauerlinie
  und Kennwerte aus den Minutenmitteln, die Spitzen aus den einzelnen 15-s-Abfragen (die Bridge
  speichert je Minute auch den höchsten Wert), der höchste Netzbezug und die höchste
  Batterie-Abgabe, bei jeder Top-Spitze der Anteil aus Netz, Batterie und Sonne. Die
  Aufschlüsselung je Gerät und der Verbrauch je Stunde zeigen den Rest (Herd, Licht …) als
  gemessene Differenz zum Smart Meter. Gilt für die Zeit, für die Smart-Meter-Daten vorliegen
  (mindestens 6 Stunden im Zeitraum, sonst wie bisher). Anlaufströme unter einer Sekunde erfasst
  keine 15-s-Abfrage.
* **Wärmepumpe → Live:** wie viel des Stroms gerade von der Sonne kommt.
* **Wohn-Dashboard (`…/#dash`):** Energiefluss und Empfehlung mit den **gemessenen** Werten
  (alle 10 Sekunden), vom Haus aus Linien zu den größten Verbrauchern (Wärmepumpe, einzeln
  gemessene Geräte, nicht einzeln gemessener Rest). Antwortet der Wechselrichter länger als
  2 Minuten nicht, zeigt es wieder die Schätzung – mit Hinweis.

## Voraussetzungen

* Der Wechselrichter ist im **selben Heimnetz** wie die Bridge (LAN-Kabel oder WLAN –
  richtet meist der Installateur ein). Gast-WLAN oder ein eigenes VLAN trennen ihn ab.
* **GEN24/Tauro: Solar API einschalten** (ab Werk aus), siehe unten.
* Für Verbrauch, Einspeisung, Autarkie und „gespart" braucht es einen **Fronius Smart Meter**
  (gehört bei GEN24 mit Batterie praktisch immer dazu). Ohne ihn sieht der Wechselrichter nur
  die Erzeugung – die App zeigt dann nur die PV-Werte.

## So rechnet „gespart“

**gespart = (Hausverbrauch − Netzbezug) × Arbeitspreis + Einspeisung × Einspeisevergütung** (beides aus dem Setup).

* Strom, der in den **Akku** geht, zählt erst, wenn er wieder herauskommt und das Haus versorgt – dann steigt
  „gespart“ (meist am Abend). Was heute geladen und noch nicht verbraucht ist, steht daneben als
  **„+ ≈ … € im Akku“**: Zuwachs des Ladestands seit Mitternacht × Akkugröße (vom Wechselrichter, sonst aus dem
  PV-Setup) × 95 % (Wandlungsverluste) × Arbeitspreis.
* Was um Mitternacht noch im Akku ist, zählt am nächsten Tag – Monat und „seit Anschluss“ stimmen trotzdem.
* **Eingespeister** Strom bringt nur die Vergütung, nicht den Arbeitspreis; Lade-/Entladeverluste des Akkus
  (grob 5–10 %) sparen nichts. Deshalb ergeben z. B. 10 kWh Sonne selten volle 10 × Arbeitspreis.
* Lief die Bridge zeitweise nicht (Mac im Ruhezustand), fehlen diese Stunden – der PV-Tab zeigt sie als Lücke.

## Schritt für Schritt

1. **IP-Adresse des Wechselrichters herausfinden:** in der Geräteliste deines Routers
   (z. B. FRITZ!Box: Heimnetz → Netzwerk) oder in der Fronius-App. Tipp: dort gleich
   **„immer dieselbe IP vergeben"** einstellen, damit sich die Adresse nie ändert.
2. **Solar API einschalten (GEN24/Tauro):** die IP im Browser öffnen, als Benutzer
   **Customer** (Kunde) anmelden → **Kommunikation → Solar API** → „Kommunikation über
   Solar API aktivieren" einschalten und speichern. (Die genaue Bezeichnung kann je nach
   Firmware leicht abweichen.) Ältere Geräte mit Datamanager haben die Solar API immer an.
   Findet die App den Wechselrichter, aber die Solar API ist aus, zeigt sie diese Schritte
   mit einem Link zur Weboberfläche direkt an.

   **Welches Passwort?** Die Weboberfläche kennt die Benutzer **Customer** (Kunde) und
   **Technician** (Techniker). Beide Passwörter werden bei der Inbetriebnahme vergeben –
   frag deinen Installateur, oft steht das Customer-Passwort im Inbetriebnahme-Protokoll.
   **Customer-Passwort vergessen** (Ablauf laut Fronius-Hilfe): auf der Anmeldeseite
   „Passwort vergessen?" → Benutzer **Customer** → es erscheint ein **PIN**. In
   **Solar.web** (dort musst du als Besitzer der Anlage eingetragen sein) unter
   Einstellungen → Komponenten → beim Wechselrichter „Aktionen" → „Customer Passwort
   zurücksetzen" mit dem PIN einen Freischalt-Code erzeugen, ihn auf der Anmeldeseite
   eintragen und ein neues Passwort setzen. Der PIN gilt nur, solange er angezeigt wird.
   Das **Technician**-Passwort kann nur der
   Installateur bzw. Fronius zurücksetzen. Alternativ: den Installateur bitten, die
   Solar API einzuschalten.
3. In der App: **Setup → ☀️ PV-Anlage (Fronius) verbinden** → **„Im Netz suchen"** antippen
   (die Bridge durchsucht ihr eigenes Netz, bis zu 30 s) oder die IP eintragen →
   **Verbinden**. Die App zeigt danach Gerät, installierte kWp, ob ein Smart Meter und eine
   Batterie erkannt wurden.

Ab jetzt holt die Bridge **alle 15 Sekunden** den Energiefluss und **einmal pro Minute**
Strings (Leistung und Spannung je MPP-Tracker), Smart-Meter-Zählerstände und Batterie.
Gespeichert wird **je Minute ein Mittelwert** (Tabelle `pv_samples` in `bridge/energy.db`). Die Adresse steht in `bridge/config.json`;
nach einem Neustart verbindet sich die Bridge von selbst wieder.

> **Historie:** Der GEN24 bietet über die Solar API keine abrufbare Vergangenheit. Die
> Auswertungen beginnen deshalb mit dem Moment der Verbindung – je länger die Bridge läuft,
> desto aussagekräftiger werden Verlauf und Monatswerte.

## Wie gerechnet wird

* **Eigenverbrauch** = Anteil der PV-Erzeugung, der nicht eingespeist wurde (inkl. Batterieladung).
* **Autarkie** = Anteil deines Verbrauchs, der nicht aus dem Netz kam.
* **Gespart** = (Verbrauch − Netzbezug) × Strompreis (selbst genutzter Sonnen-/Batteriestrom,
  den du nicht kaufen musstest) + Einspeisung × Einspeisevergütung. Strompreis aus dem Setup,
  Vergütung aus dem PV-Planer (Feld „Einspeisung ct/kWh") – dort deinen Satz laut Netzbetreiber
  eintragen. Gezeigt für heute, den laufenden Monat und seit dem Anschluss (Übersicht, Tab PV und
  das Banner im Wohn-Dashboard).
* **Netzbezug und Einspeisung** kommen aus den **Zählerständen des Smart Meters** (exakt).
  An Tagen mit Datenlücke (Bridge oder Wechselrichter nicht erreichbar) oder wenn ein
  Zählerstand springt (z. B. Zähler getauscht), nimmt die App die gemessenen Leistungswerte
  und markiert den Tag.
* **Batterie aus dem Netz geladen:** Bezieht das Haus mehr aus dem Netz, als es selbst
  verbraucht, während die Batterie lädt, geht der Rest in die Batterie (samt Wandlungsverlusten).
  Das passiert z. B., wenn ein GEN24 bei sehr niedrigem Ladestand nachlädt (gemeldet als
  „charge boost“ – Fronius beschreibt den Begriff nicht genau; die App zeigt, was gemessen wird).
  Diese Menge steht als „Batterie aus dem Netz geladen“ da, zählt bei „Wohin ging der
  Sonnenstrom?“ **nicht** als Sonnenstrom und kostet den normalen Netzpreis.
* **Sonnenstrom der Wärmepumpe:** Die Wärmepumpe bekommt je 5 Minuten denselben Anteil
  Sonnen-/Batteriestrom zugeordnet wie das ganze Haus (anteilige Rechnung – ein eigener
  Zähler nur für die Wärmepumpe wäre genauer).
* **Erwartung** (Monatstabelle) = Jahresertrag je kWp × installierte kWp × Monatsanteil,
  gerechnet auf die **erfassten Sonnenstunden**: ein Tag, an dem die Bridge erst um 14 Uhr
  startete, zählt nur mit dem Teil, den die Sonne nach 14 Uhr typischerweise liefert (aus dem
  mittleren Tagesprofil im Zeitraum), nicht als ganzer Tag. Der Jahresertrag je kWp kommt aus
  der **Ausrichtung der Strings**, wenn du sie im String-Vergleich einträgst (Süd 1000,
  Südost/Südwest 950, Ost/West 840, Nordost/Nordwest 680, Nord 600, flach 870 kWh/kWp,
  gewichtet mit den kWp der Strings), sonst aus dem PV-Planer bzw. PVGIS. Das Wetter schwankt
  von Jahr zu Jahr um etwa ±15 %.

* **Wetter** kommt von **Open-Meteo** (kostenlos, ohne Konto): ein Wettermodell für deinen
  Standort, keine Messstation in deinem Garten. Den Standort nimmt die App aus dem PV-Planer;
  fehlt er, fragt sie nach dem Ort (Suche über Open-Meteo). Die Bridge holt höchstens stündlich
  die letzten 92 Tage und die nächsten Tage und speichert jeden Tag – so wächst die Wetter-Historie
  mit. **Sonnenstunden** = Zeit mit direkter Sonne (WMO-Definition), **Bewölkung** = Mittel der
  hellen Stunden. **Erwarteter Ertrag** = Einstrahlung des Tages × was deine Anlage an den letzten
  (bis zu 30) vollständig erfassten Tagen aus der Einstrahlung gemacht hat – so steckt deine
  Ausrichtung, Verschattung und Anlagengröße schon drin; eine Schätzung, ab 3 Tagen.

## Gesamtverbrauch des Hauses und Zählerablesungen

Seit der PV-Anlage zählt der Stromzähler des Netzbetreibers nur noch, was **aus dem Netz** kommt
(Bezug, Register 1.8.0) und was **hineingeht** (Einspeisung, 2.8.0). Was das Haus wirklich
verbraucht, misst der **Smart Meter** zusammen mit dem Wechselrichter („Verbrauch“ in Solar.web).
Die App nimmt diesen Wert deshalb **überall als Gesamtverbrauch** (seit v221):

* **Übersicht, Heute, Verlauf:** Ein Tag bzw. eine Stunde zeigt den ganzen Hausverbrauch,
  aufgeteilt in **Wärmepumpe** (HomeCom), **einzeln gemessene Smart-Home-Geräte** und grau den
  **Rest**, den keins davon erklärt (Herd, Kühlschrank, Steckdosen ohne Messung …). Ein Tag zählt,
  wenn der Smart Meter mindestens 22,5 Stunden aufgezeichnet hat (Lücken zusammen höchstens
  30 Minuten); Tage davor zeigen nur die einzeln gemessenen Teile.
* **Prognosen, Börse, Konzept:** Der Haushalt (alles außer der Wärmepumpe) ist das Mittel der
  letzten bis zu 28 vollständigen Tage (Haus minus Wärmepumpe), saisonal bereinigt.
* **Profil:** Tagesprofil, Wochentage und Wärmekarte zeigen das ganze Haus über dieselben Tage;
  das Tagesprofil ist aufgeteilt in Wärmepumpe, Smart Home und Rest.

**Zählerablesungen** (Setup → 🔢 Stromzähler & Smart Meter) prüfen jetzt den Smart Meter. Trag
Datum, **Uhrzeit**, den Bezug (1.8.0) und – wenn du magst – die Einspeisung (2.8.0) ein. Für jeden
Zeitraum zwischen zwei Ablesungen zeigt die App, was dein Zähler und was der Smart Meter gezählt
haben (der Smart-Meter-Stand wird auf die Minute der Ablesung interpoliert):

| Zeichen | Bedeutung |
|---|---|
| ✓ | höchstens 2 % Unterschied (mindestens 1 kWh Spielraum, weil viele Zähler nur ganze kWh zeigen) – zwei geeichte Zähler an derselben Leitung liegen meist innerhalb von 1–2 % |
| ≈ | mehr, aber durch eine **fehlende Uhrzeit** erklärbar: Ablesungen ohne Uhrzeit (alle vor v221) gelten als 12:00 Uhr; die App rechnet aus, wie viel ein halber Tag an diesem Tag ausmachte |
| ⚠︎ | mehr als 2 % – Ablesezeit und Zahlen prüfen. Bleibt es dabei: Sitzt der Smart Meter direkt am Hausanschluss, hängen alle Verbraucher dahinter (auch die Wärmepumpe)? |

Zeiträume, die gar nicht passen (über 20 % daneben oder ein Zählerstand rückwärts), sind meist
Tippfehler – sie zählen nicht zur Gesamtbilanz und werden eigens genannt. Ablesungen aus der Zeit
vor der Smart-Meter-Aufzeichnung bleiben gespeichert, lassen sich aber nicht vergleichen.

## Strings vergleichen (🧵 String-Vergleich)

Ein **String** ist eine Reihe von Modulen an einem MPP-Eingang des Wechselrichters (der GEN24
hat zwei). Die Karte zeigt:

* **Jetzt:** Leistung, Spannung und Strom je String, Anteil an der Summe und – sobald die kWp
  je String bekannt sind – Watt je kWp. Nachts bleibt an den Modulen eine kleine Spannung ohne
  Strom (z. B. 70 V und 49 V bei 0 A) – das ist normal.
* **Tagesverlauf:** beide Strings als Kurven (Viertelstunden), umschaltbar auf
  **je kWp**, damit unterschiedlich große Strings vergleichbar werden. Mit **◀ ▶** durch die Tage
  blättern – derselbe Tag wie in „Erzeugung & Verbrauch“; steht dort der Zeitraum „Tag“, gelten
  auch Tabelle und Hinweise für diesen Tag.
* **Tageswerte** (beim Jahr: Monatswerte) je String und eine Tabelle über den gewählten
  Zeitraum: Energie und Anteil, kWp, **kWh je kWp**, Spitzenleistung, **„erzeugt im Mittel
  um“** (Schwerpunkt der Tageserzeugung – Ostdächer liefern früher, Westdächer später) und die
  **Spannung im Betrieb** (nach Leistung gewichtet, nur solange der String Strom liefert).
* **✏️ Strings beschreiben** (optional): Name, Zahl der Module, kWp und Ausrichtung je String.
  Ohne Eintrag schätzt die App die kWp aus den Spannungen: Bei gleichen Modulen wächst die
  Spannung mit der Zahl der Module in Reihe, also teilt sich die installierte Leistung im
  Verhältnis der Spannungen auf (gekennzeichnet mit „≈“). Gilt für alle Geräte.

**Bewertung** (grün = unauffällig, blau = Hinweis, gelb = auffällig):

* Ein String liefert **jetzt** fast nichts, während der andere über 300 W bringt – oder er
  lieferte an einem ganzen Tag fast nichts → Schnee, Verschattung oder ein Defekt
  (Steckverbinder, Sicherung, DC-Trennschalter, Eingang des Wechselrichters).
* **Summe der Strings = PV-Erzeugung** (auf denselben Minuten; bis 3 % unauffällig – die
  Strings werden einmal pro Minute abgefragt, bei wechselnden Wolken streut das).
* **Zur gleichen Tageszeit?** Erzeugt ein String im Mittel deutlich später, zeigt er weiter nach
  Westen (oder der andere wird nachmittags verschattet). Passt das nicht zur eingetragenen
  Ausrichtung, fragt die App, ob die Strings vertauscht eingetragen sind.
* **Je kWp:** Bei gleicher Ausrichtung sollten beide Strings je kWp gleich viel liefern (bis 8 %
  normal, über 15 % auffällig). Bei unterschiedlicher Ausrichtung ist ein Unterschied normal –
  im Winter bekommen Ost- und Westflächen deutlich weniger als die Südseite.
* **Trend:** Ab 7 Sonnentagen vergleicht die App das Verhältnis der beiden Strings der letzten
  3 Tage mit den Tagen davor. Das Wetter wirkt auf beide Strings, ein plötzlicher Einbruch nur
  eines Strings (über 25 %) deutet auf neue Verschattung, Schnee, Laub oder einen Defekt.
* **Spannungen:** Die Temperatur verändert beide Strings gleich – sinkt das Spannungsverhältnis
  an zwei Tagen um mehr als 6 %, fehlt einem String etwa ein Modul bzw. eine Bypass-Diode.
  Mit eingetragener Modulzahl prüft die App auch, ob das Spannungsverhältnis dazu passt.

## Plausibilitätsprüfung (🔎)

Prüft über den gewählten Zeitraum, ob die gespeicherten Zahlen zueinander passen:

| Prüfung | Was verglichen wird | unauffällig |
|---|---|---|
| Datenlage | Stunden mit Werten ÷ Stunden im Zeitraum, Lücken, unvollständige Tage | ≥ 97 % |
| Strings = PV | Summe der String-Energie ÷ PV-Erzeugung (gleiche Minuten) | ± 3 % |
| Energiebilanz | Sonne + Batterie + Netz hinein − (Haus + Batterie + Netz heraus) = Umwandlungsverluste, bezogen auf die umgewandelte Energie | 0–10 % |
| Zählerstände | Bezug/Einspeisung laut Smart Meter ÷ aufsummierte Leistungswerte (Tage ohne Lücke) | ± 3 % |
| Batterie | entladen ÷ (geladen − Änderung des Ladestands × Kapazität), ab einem halben Zyklus | 80–100 % |
| Zähler des Wechselrichters | Zuwachs von E-Total ÷ gemessene AC-Abgabe (bzw. PV-Erzeugung) | ± 4 % |
| Spitzenleistung | höchste PV-Leistung ÷ installierte kWp | ≤ 100 % |

Was E-Total genau zählt, ist je nach Gerät verschieden (bei einem Hybrid-Wechselrichter wie dem
GEN24 vermutlich alles, was er ins Hausnetz abgibt – Sonne **und Batterie**); die Prüfung zeigt
anhand deiner Messwerte, ob er zur AC-Abgabe oder zur PV-Erzeugung passt. Die Auswertungen der
App rechnen nicht mit diesem Zähler.

## Häufige Meldungen

| Meldung | Bedeutung / Abhilfe |
|---|---|
| „… gibt es nicht (HTTP 404) – ist die Solar API eingeschaltet?" | Der Wechselrichter antwortet, aber die Solar API ist aus → Schritt 2. |
| „Fronius-Weboberfläche gefunden, aber die Solar API antwortet nicht" | Wie oben: Gerät gefunden, Solar API aus → Schritt 2 (Anmeldung als Customer). |
| Weboberfläche will eine Anmeldung, Passwort unbekannt | Benutzer **Customer**; Passwort vom Installateur oder per „Passwort vergessen?" + Solar.web zurücksetzen → Schritt 2. |
| „verweigert den Zugriff (HTTP 403)" | ebenfalls Solar API aus (je nach Firmware) → Schritt 2. |
| „… nicht erreichbar" / „Zeitüberschreitung" | IP falsch, Wechselrichter aus (nachts schlafen manche ohne Batterie ein) oder in einem anderen Netz. |
| „Kein Fronius im Netz gefunden" | Die Suche prüft nur das Netz der Bridge (x.x.x.1–254). IP aus dem Router eintragen. |
| „Smart Meter: nein" | Nur Erzeugung sichtbar. Ist ein Smart Meter verbaut, im Wechselrichter-Setup prüfen, ob er eingerichtet ist. |

**Fehlersuche:** Setup → PV-Anlage → **„🩺 Rohdaten des Wechselrichters"** zeigt die
unveränderten Antworten aller Abfragen (mit „Kopieren"). Weicht dein Gerät vom bekannten
Format ab, lässt es sich damit schnell anpassen. Dasselbe liefert `/api/fronius/probe`.

## Technischer Hintergrund

* Umgesetzt in `bridge/fronius.py` – **ohne Zusatzpakete** (nur Standardbibliothek).
* Abfragen (HTTP GET, Port 80, keine Anmeldung):
  `/solar_api/GetAPIVersion.cgi`, `/solar_api/v1/GetPowerFlowRealtimeData.fcgi`,
  `GetInverterInfo.cgi`, `GetInverterRealtimeData.cgi?…CommonInverterData` (Strings),
  `GetMeterRealtimeData.cgi?Scope=System` (Zählerstände, Phasen),
  `GetStorageRealtimeData.cgi?Scope=System` (Batterie), `GetOhmPilotRealtimeData.cgi`,
  `GetActiveDeviceInfo.cgi`.
* GEN24-Besonderheiten werden berücksichtigt (keine Tages-/Jahreswerte, Smart-Meter-Werte
  teils als `SMARTMETER_*`-Felder, Name ohne HTML-Kodierung).
* Endpunkte der Bridge: `/api/fronius` (live + heute), `/api/pv?days=N` (Auswertung),
  `/api/fronius/discover`, `/api/fronius/probe`, `POST /api/fronius/connect`
  (`{"host": "192.168.x.y"}`), `POST /api/fronius/disconnect`.
* Die Solar API ist im Heimnetz ohne Passwort lesbar – das ist bei Fronius so vorgesehen;
  sie kann nur lesen, nichts verstellen.
* Im **Demo-Modus** (`serve --demo`) zeigt die App eine simulierte Anlage (9,9 kWp,
  9,5-kWh-Batterie, Smart Meter).
