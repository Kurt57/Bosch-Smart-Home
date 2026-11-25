# Wärmepumpe anbinden (Bosch HomeCom Easy)

Die Bosch **Compress 6800i AW** (und verwandte 5800i/6800i) gehört **nicht** zum
Smart Home Controller, sondern zur Bosch-Heizungswelt. Die App liest sie über
**HomeCom Easy** (Bosch-Cloud) aus – zusätzlich zu den Licht-/Rollladenmodulen.

Angezeigt werden (soweit deine Anlage sie liefert), im eigenen **Wärmepumpe**-Tab
und kombiniert in **Übersicht/Heute/Verlauf**:

* **Aktuelle elektrische & thermische Leistung** (W/kW) – aus den kumulativen
  Zählern je Poll abgeleitet
* **Stromverbrauch gesamt** (kWh), aufgeteilt in **Kompressor** und **Heizstab**
* **Wärme erzeugt gesamt** (kWh) und **COP jetzt** sowie **Jahresarbeitszahl**
* **Modulation** (%), **Betriebsmodus** (Warmwasser/Heizung/Bereitschaft),
  **Außentemperatur**, **Vor-/Rücklauf**, **Starts/Betriebsstunden**
* **Historie** (Strom & Wärme pro Tag/Monat, COP-Verlauf, Wärmekarte) baut die
  Bridge selbst aus den gepollten Zählern auf – die Cloud liefert dafür keine API.

> Hinweis: HomeCom ist eine **Cloud**-Anbindung. Die Zugangsdaten (Login-Token)
> werden nur **lokal** in der Bridge gespeichert (in `config.json`, per
> `.gitignore` von Commits ausgeschlossen). Es werden keine Passwörter gepusht.

---

## Voraussetzungen

* Deine Wärmepumpe ist in der **Bosch HomeCom Easy**-App eingerichtet und online.
* Du kennst deine **Bosch SingleKey ID** (dieselbe Anmeldung wie in der App).
* Die Bridge läuft (siehe `docs/SETUP.md`).

---

## Verbinden – Schritt für Schritt

Alles passiert im **Setup**-Tab der App, Karte **„🔥 Wärmepumpe (HomeCom)"**:

1. **„Login-Link öffnen"** tippen. Es öffnet sich die Bosch-Anmeldung
   (SingleKey ID). Melde dich mit deiner E-Mail + Passwort an.
2. Nach der Anmeldung versucht der Browser, zu einer Adresse zu springen, die mit
   `com.bosch.tt.dashtt.pointt://…` beginnt. Der Browser zeigt dann eine
   **Fehlerseite oder leere Seite** – **das ist normal und richtig.**
3. Kopiere die **komplette Adresse aus der Adressleiste** des Browsers. Sie
   enthält `…?code=XXXXXXXX…`. (Nur den Wert hinter `code=` bis zum nächsten `&`
   reicht auch.)
4. Zurück in der App: die Adresse (oder nur den Code) in das Feld einfügen und
   **„Verbinden"** tippen.

Bei Erfolg erkennt die Bridge automatisch dein Wärmepumpen-Gateway, beginnt zu
pollen, und im **Live**-Tab erscheint die Wärmepumpen-Karte.

### Safari zeigt „Adresse ungültig" – wie komme ich an den Code?
Nach dem Login leitet Bosch auf eine **App-Adresse** `com.bosch.tt.dashtt.pointt://…?code=…`
weiter. Safari (besonders am iPhone) kann diese nicht öffnen und zeigt nur
„Adresse ungültig" – **ohne** dir den `code` zu zeigen. Die Zwischenseite
„Weiterleitung…" enthält den Code **noch nicht**. So bekommst du ihn trotzdem:

**Weg A – Google Chrome am Mac (empfohlen):**
1. Öffne den **Login-Link in Chrome** (Desktop).
2. **Vor** dem Anmelden: Entwicklertools öffnen (⌥⌘I) → Tab **Network/Netzwerk**,
   Häkchen **„Preserve log"** setzen.
3. Anmelden. Am Ende scheitert das Öffnen der App-Adresse – das ist ok.
4. Im Netzwerk-Tab die letzte Zeile suchen, die mit
   **`com.bosch.tt.dashtt.pointt://app/login?code=…`** beginnt (Filter: `code=`).
   Rechtsklick → **„Copy → Copy link address"**.
5. Diese Adresse in der App ins Code-Feld einfügen → **Verbinden**.

**Weg B – Firefox mit Add-on:** Die Community-Erweiterung
**„SingleKey Code Catcher"** (Firefox) zeigt den Code nach dem Login automatisch an.

> Wichtig: Du brauchst die **finale** Adresse mit `…?code=…` (App-Schema
> `com.bosch…`), **nicht** die Zwischenseite „Weiterleitung…" bzw. die
> `…/authorize/callback?…`-Adresse – die enthält noch keinen Code.

---

## Tag-genaue Historie per CSV-Import

Die Cloud liefert bei diesem Gerät **keine** tag-genaue Verlaufs-API. Für echte
Vergangenheitsdaten (Verlauf, COP, Wärmekarte, Monatsbilanz, Prognose – inkl.
Aufteilung **Heizung/Warmwasser**) gibt es einen CSV-Import:

1. In **HomeCom Easy** (App/Website) die **Energiedaten exportieren** (CSV).
   Die Datei enthält Stunden-, **Tag-** und **Monatswerte** (`EnergyData_*.csv`).
2. In der App: **Setup → „📁 Wärmepumpen-Historie (CSV)"** → Datei auswählen.
3. Die Bridge liest die deutschen Spalten (`;`-getrennt, Komma-Dezimal) selbst
   aus – elektrischer Verbrauch (Wärmepumpe + Elektro-Zuheizer), erzeugte Wärme
   (inkl. Umgebungswärme) und die Aufteilung Heizung/Warmwasser – und speichert
   sie **lokal** (`hp_history` in `energy.db`, nicht im Repo). Erneuter Import
   aktualisiert vorhandene Tage/Monate.

Danach zeigen alle Ansichten echte Werte; die Jahresprognose basiert auf den
importierten Monaten statt auf einer Hochrechnung.

## Häufige Meldungen

| Meldung | Bedeutung |
|---|---|
| „Login fehlgeschlagen … Code korrekt/kopiert?" | Der Code ist nur wenige Minuten gültig. Login-Link neu öffnen, neu anmelden, Adresse frisch kopieren. |
| „Keine Wärmepumpe gefunden" | Anmeldung ok, aber HomeCom liefert kein Gateway. Ist die WP in der HomeCom-App online? |
| „Fehler" im Setup-Status | Letzter Abruf schlug fehl (z. B. Token abgelaufen/Netz). Die Bridge erneuert den Token automatisch; bei dauerhaftem Fehler neu verbinden. |
| „HomeCom-Anmeldung abgelaufen" / `invalid_grant` | Der Refresh-Token ist verbraucht/ungültig – im Setup einfach **neu verbinden** (neuer Login-Code). Wird ab Werk automatisch rotiert und gespeichert. Häufigste Ursache war eine **zweite laufende Bridge** (siehe unten). |
| „HomeCom-Modul nicht installiert" | Datei `bridge/homecom.py` fehlt – aus dem Repo nachziehen. |
| „Zeitüberschreitung beim Verschlüsseln (TLS-Handshake) mit …" | Die Bridge erreicht den Bosch-Server, die verschlüsselte Verbindung kommt aber nicht zustande. Erst den **Verbindungstest** (unten) machen. Zeigt er „kein TLS 1.3" und klappt `curl` im Terminal, liegt es am Python der Bridge → siehe „Python der Bridge". |
| „Name … nicht auflösbar (DNS)" / „antwortet nicht" | Internet, Router/DNS, VPN oder Filter am Rechner der Bridge prüfen. |
| „HTTP 429 – Bosch drosselt gerade" | Zu viele Anfragen; legt sich meist nach einiger Zeit. Die Bridge versucht es danach von selbst. |
| „HomeCom antwortet, liefert aber keine Werte" | Anmeldung ok, aber das Gateway meldet nichts – in der HomeCom-App prüfen, ob die Wärmepumpe online ist. |
| „WP · Betriebsart unbekannt (Datenlücke)" | Die Bridge hat die Wärmepumpe länger als 30 Minuten nicht erreicht (Rechner aus/im Ruhezustand, Cloud gestört, Anmeldung abgelaufen). Der Stromzähler zeigt danach, wie viel in der Zeit verbraucht wurde – das zählt voll zum Tagesverbrauch. Ob dafür geheizt oder Warmwasser gemacht wurde, war aber nicht zu sehen; deshalb wird diese Menge keiner Betriebsart zugeschlagen. In der Stundenreihe und im Tagesablauf bleibt die Lücke leer. |

### Warum die Anmeldung verloren gehen kann

Bosch (SingleKey ID) gibt bei **jeder** Token-Erneuerung (etwa stündlich) einen neuen Refresh-Token
aus; der alte gilt danach nicht mehr. Benutzt eine zweite Stelle den alten noch einmal, sperrt Bosch
die ganze Anmeldung. Genau das passierte, wenn die Bridge **zweimal lief** – z. B. weil
`update-macos.command` gestartet wurde, während die alte Bridge noch lief: die neue erneuerte sofort
den Token und beendete sich erst danach wegen des belegten Ports; die alte arbeitete mit dem
verbrauchten Token weiter. Seit v202:

* Pro `config.json` läuft nur **eine** Bridge (Sperrdatei `bridge/.bridge.lock`); eine zweite
  beendet sich mit einem Hinweis, **bevor** sie Bosch oder AEG kontaktiert. Auch den Port belegt
  die Bridge zuerst.
* `start-macos.command`, `update-macos.command` und `auto-update-macos.command` beenden eine
  laufende Bridge vorher sauber.
* Beim Beenden (Fenster schließen, Strg+C, `kill`) und beim Neustart nach einem Update wartet die
  Bridge eine laufende Token-Erneuerung ab; `config.json` wird atomar geschrieben.
* Der Demo-Modus benutzt die echten Bosch-/AEG-Zugänge nicht.

Nach einer Sperre hilft nur einmal **neu verbinden**; danach sollte sie halten.

### Verbindungstest

**Setup → Wärmepumpe (HomeCom) → „🩺 Verbindung zur Bosch-Cloud testen"** prüft Schritt für
Schritt, wo es hängt: Name (DNS) → Verbindung → Verschlüsselung (TLS) für die Anmeldung
(`singlekey-id.com`) und die Daten (`pointt-api.bosch-thermotechnology.com`), dann die
Anmeldung selbst und einen Datenabruf. Dazu: wann zuletzt echte Werte kamen und welches Python
die Bridge nutzt. Das Ergebnis lässt sich kopieren. Auf der Wärmepumpen-Karte erscheint ein
Hinweis mit Link zum Test, sobald keine neuen Werte mehr kommen.

Im Terminal geht dasselbe ohne Anmeldung (verändert den Login der laufenden Bridge nicht):

```bash
cd bridge
python3 shc_bridge.py diag
```

### Python der Bridge

macOS bringt mit den Entwicklerwerkzeugen ein älteres `python3` (3.9, SSL-Bibliothek
LibreSSL 2.8.3, **ohne TLS 1.3**). Das reicht normalerweise. Lehnt ein Server ältere
Verschlüsselung ab, hilft ein aktuelles Python von **python.org**: installieren und danach im
Ordner *Programme → Python 3.x* einmal **„Install Certificates.command"** doppelklicken. Die
Startskripte (`start-macos.command`, `update-macos.command`, …) nehmen ein solches Python
(oder eines von Homebrew) automatisch und zeigen beim Start an, welches sie verwenden.

---

## Arbeitszahl: Datenblatt vs. Praxis

Tab **Wärme → 📊 Effizienz**, Karte **⚖️ Arbeitszahl: Datenblatt vs. Praxis**. Voreingestellt ist die
**Bosch Compress 6800i AW mit Außeneinheit AW 7 OR-S** (R290) mit ihren EN-14511-Punkten
A−7/W35 COP 2,36 (6,71 kW) · A2/W35 4,06 (2,87 kW) · A7/W35 4,8 (2,85 kW) und SCOP 4,58 (35 °C) /
3,51 (55 °C) – zusammengetragen aus Händler- und Fachportal-Angaben des Bosch-Datenblatts (das
Original-PDF konnte nicht direkt geprüft werden). Unter „Datenblatt-Werte anpassen“ lassen sich die
Punkte ändern oder ergänzen (z. B. W55-Punkte); sie gelten dann auf allen Geräten.

* **Theorie für deine Bedingungen:** Jeder Datenblatt-Punkt sagt, welchen Anteil des idealen
  (Carnot-)COP die Maschine bei dieser Außentemperatur erreicht (Verflüssigung 4 K über dem
  Vorlauf, Verdampfung 8 K unter der Luft). Zwischen den Punkten linear, außerhalb gleich. Für jede
  Messung (alle 5 Minuten) wird damit der COP bei genau der gemessenen Außen- und
  Vorlauftemperatur berechnet – Warmwasser mit 50–55 °C Vorlauf bekommt also auch in der Theorie
  einen niedrigeren COP als Heizen mit 30 °C.
* **Praxis:** erzeugte Wärme ÷ Strom aus den Zählern der Wärmepumpe (HomeCom: Verdichter +
  Heizstab, `outputProduced`). Keine geeichten Zähler; die Wärme berechnet die WP selbst. Grobe
  Zähler (1-kWh-Schritte) gleichen sich über Tage aus, einzelne Tage schwanken.
* **Aufteilung:** Heizen und Warmwasser getrennt, Heizen je Außentemperatur (3-K-Stufen), pro Tag
  (ab 46 Tagen Zeitraum pro Monat).
* **Wohin der Mehrverbrauch geht:** Strom im Stillstand (Standby, Frostschutz), der Heizstab (seine
  Wärme hätte die WP mit dem Datenblatt-COP erzeugt) und der Rest (Abtauen, Takten, Teillast,
  Umwälzpumpen, Messgenauigkeit). Den Heizstab-Zähler schreibt die Bridge ab v210 je Abfrage mit
  (`hp_samples.eheater_kwh`); vorher steckt er im Rest.
* **Zum Einordnen:** der SCOP ist ein Normwert (mittleres Klima, nur Heizen, ohne Warmwasser und
  Stillstand); Feldtests des Fraunhofer ISE an Luft-Wärmepumpen im Bestand: Ø JAZ 3,1
  („WPsmart im Bestand“) bzw. 3,4, Spanne 2,6–4,9 („WP-QS im Bestand“).

**Warmwasser-Vorlauf:** Bei der CS6800i sitzt der Vorlauffühler, den HomeCom meldet, im Heizkreis – während der
Speicher lädt, zeigt er nur die ruhende Heizleitung (~30 °C). Durch den **Rücklauffühler** strömt dann das Heizwasser,
das aus der Wendel im Speicher zurückkommt (beobachtet: ~55 °C). Die App nimmt beim Warmwasser deshalb
**Rücklauf + 5 K** als Vorlauf, wenn der Rücklauf deutlich wärmer ist als der gemeldete Vorlauf; sonst
**Speichertemperatur + 6 K** (ohne beides: 50 °C). Der Wert ist mit * markiert.

### Verbesserungs-Check

Karte **🔧 Verbesserungs-Check** direkt darunter: was einzelne Stellschrauben mit deinen Messwerten bringen
würden, sortiert nach Wirkung –

* **Vorlauf beim Heizen** 2 bzw. 4 K tiefer (Datenblatt-Modell auf die gemessene Heizwärme),
* **Warmwasser** 2 bzw. 4 K kühler und **mittags** statt bei der Außentemperatur, bei der es heute lädt,
* **Heizstab** vermeiden (gemessen ab v210, vorher der Anteil seit Inbetriebnahme; mit Aufteilung Heizen/Warmwasser),
* **Raumtemperatur** 1 K runter (Faustwert 6 % Heizwärme), ab Ø 22 °C,
* Hinweise ohne Euro-Wert: **Heizen bei ≥ 15 °C** außen (Heizgrenze), **Verdichter-Starts** (Gerätezähler, ab v211
  je Abfrage gespeichert) und **Stillstand** über 30 W.

Mit einem HomeCom-Jahresimport stehen kWh und € pro Jahr da, sonst pro Monat beim Wetter des Zeitraums (Preis aus
dem Setup). Schätzungen, nicht einfach addierbar.

### Anlagen-Check (Troubleshooting)

Karte **🩺 Anlagen-Check** darunter – was die Messwerte über **Einbau und Einstellung** verraten. Die App sieht
Symptome, keine Rohre; jede Auffälligkeit nennt deshalb typische Ursachen, getrennt nach ⚙️ **Einstellung**
(Regler/Fachmann-Menü) und 🔧 **Einbau/Mechanik** (Fachbetrieb).

* **Sind ~75 % okay?** Einordnung des Abstands zum Datenblatt (Prüfstand nach EN 14511: Dauerlauf, feste
  Temperaturen – im Alltag sind 15–30 % Abstand normal, Faustwert), getrennt nach Heizen/Warmwasser, nach
  Außentemperatur (gleichmäßig = allgemeine Verluste; Einbruch in der Kälte = Abtauen/Heizstab/Leistungsgrenze;
  schwächer bei milder Luft = Takten), Aufteilung des Mehrverbrauchs (Stillstand, Heizstab, Rest) und Vergleich
  mit den Feldtests des Fraunhofer ISE (Luft-WP im Bestand: Jahresmittel 3,1 bzw. 3,4).
* **Reichen die 7 kW?** Heizlast über der Außentemperatur: gemessen (ein Punkt je Tag), dein **Gebäudemodell**
  aus den U-Werten („🏗️ Theorie vs. Praxis“) und die **angenommene** Maximalleistung der Außeneinheit
  (Datenblattpunkt A−7/W35 6,71 kW, −2 %/K kälter, −1 %/K je Kelvin Vorlauf über 35 °C – keine Bosch-Kurve).
  Daraus der **Bivalenzpunkt** (darunter braucht es den Heizstab), auch mit der täglichen Warmwasser-Ladezeit
  und mit einem Nacht-Leisemodus (−50 %). Der **Heizstab** nach Außentemperatur: läuft er dort, wo die WP allein
  reichen müsste, ist es eine Einstellung, keine zu kleine WP. Dazu der größte Einzelverlust des Gebäudemodells
  und was seine Dämmung an Heizlast, Bivalenzpunkt und Vorlauf (Fußbodenheizung, Exponent 1,1) bringt.
* **Und nach Norm?** (ab v215) Dieselbe Frage mit den Annahmen der Auslegung statt „wie du lebst“:
  Norm-Innentemperaturen 20 °C (Wohn-/Schlafräume, Küche), 24 °C Bad, 15 °C beheizte Flure/Treppen
  (DIN EN 12831 Beiblatt 1, heute DIN/TS 12831-1; flächengewichtet über die Räume im Verteiler-Layout),
  **keine** Wärmegewinne durch Sonne, Personen und Geräte, Wärmebrücken-Pauschale 0,10 W/m²K, Lüftung wie
  im Gebäudemodell. Der nötige Vorlauf folgt der gemessenen Heizkurve, umgerechnet auf Norm-Raumtemperatur
  und -Last. Ohne Heizstab (monovalent) bräuchte die WP nach VDI 4645
  (Heizlast × 24 h + Warmwasser kWh/Tag) ÷ (24 h − Sperrzeit). Für den üblichen Betrieb mit Heizstab
  (monoenergetisch) zählt der Bivalenzpunkt – angestrebt werden −5 °C oder kälter. Die Heizlast-Linie läuft
  dafür von der Norm-Heizlast bis 0 bei 15 °C Heizgrenze (übliche Planungsannahme; zum Vergleich auch ganz
  ohne Gewinne). Mit den Tagesmitteln des letzten Jahres (CSV/Live) schätzt die Karte für beide Fälle den
  Anteil des Heizstabs an der Heizwärme. **Normaußentemperatur** (je Postleitzahl, eine Nachkommastelle)
  und **EVU-Sperrzeit** lassen sich direkt in der Karte eintragen; die Normaußentemperatur gilt auch im Abgleich.
  Ersetzt keine Heizlastberechnung durch den Fachbetrieb.
* **Automatische Prüfungen:** Heizkurve/Vorlauf, Spreizung, Durchfluss, Außenfühler gegen den Wetterdienst
  (Standort aus dem PV-Tab), Abtauen (aus dem Leistungsverlauf geschätzt), Abstand nach Außentemperatur,
  Heizstab, Warmwasser, Takten, Heizen bei milder Luft, Raumtemperatur, Stillstand.
* **Vor Ort nachsehen:** 14 Punkte zum Abhaken (✓ passt / ⚠ auffällig, gilt auf allen Geräten) – Aufstellung
  und Abstände der Außeneinheit, Lamellen, Fundament/Kondensat, Dämmung der Leitungen außen und innen,
  Leitungslänge/Rohrdurchmesser, Schmutzfänger/Entlüftung/Druck, Puffer/Weiche, Raumregler/Abgleich,
  Warmwasserspeicher, Außenfühler, Reglereinstellungen, Leisemodus, Wartung/Fehlerspeicher. Punkte, zu denen
  eine automatische Prüfung passt, sind markiert. Exakte Werte (Mindestabstände, Rohrdimensionen,
  Mindestdurchfluss) stehen im Bosch-EinbauCheck und in der Installationsanleitung.

**Heizlast-Kennlinie (ab v214):** ein Punkt je Tag – mittlere **Heizwärme** über der mittleren
Außentemperatur, aus dem HomeCom-CSV (Stunden je Tag summiert, sonst Tageszeilen) und aus den Live-Zählern
(Tage mit ≥ 80 % Abdeckung). Vorher rechnete der CSV-Zweig mit dem **Heizstrom** statt der Wärme – die
Heizlast kam etwa um den Faktor COP zu niedrig heraus (auch im Reiter Abgleich). Ein neuer Import speichert
die erzeugte Heizwärme direkt; ältere Importe teilen die Gesamtwärme nach den Stromanteilen auf. Im Abgleich
bekommen Räume ohne Auskühl-Messung (τ) jetzt ihren Anteil an der gemessenen Gesamtlast nach Fläche.

### Strom & Wärme nach Außentemperatur

Tab **Wärme → 📊 Effizienz**, Karte **🌡️ Strom & Wärme nach Außentemperatur** (direkt unter „Effizienz nach
Außentemperatur“). Ein Punkt je Tag: waagerecht die mittlere Außentemperatur des Tages (Fühler der Wärmepumpe;
wie bei der Heizkurve links warm, rechts kalt), senkrecht der **verbrauchte Strom** (rot, linke Achse) und die
**erzeugte Wärme** (gelb, rechte Achse) – Heizen und Warmwasser zusammen. Gestrichelt die Trendlinien über die
Heiztage unter 16 °C. Darunter: wie viel Strom und Wärme ein Grad kälter je Tag mehr bedeutet, was ein Tag mit
0 °C braucht (ist 0 °C noch nicht gemessen, als „geschätzt“ markiert) und die Arbeitszahl über die gezeigten Tage.
Zeitraum 90 Tage, 1 Jahr oder 2 Jahre; Strom, Wärme und Trendlinien einzeln ausblendbar; Tippen auf einen Punkt
zeigt den Tag.

Die Tage kommen aus den eigenen Zählerständen der Bridge (nur Tage, die zu mindestens 80 % gemessen sind) und –
für Tage, die die Bridge nicht gesehen hat – aus dem HomeCom-Import (Stunden- oder Tageswerte mit
Außentemperatur). Der laufende Tag fehlt, weil er noch nicht fertig ist; Tage vor dem Bauphasen-Ende aus dem
Setup sind ausgeblendet. Endpunkt: `GET /api/heatpump/tempdays?days=90|365|730`.

## Warmwasser-Speicher & Legionellen

Tab **Wärme → 🚿 Warmwasser**, Karte **🛁 Warmwasser-Speicher** (darunter, umgezogen aus
„Abgleich“: **Warmwasser kostet Komfort**). Grundlage: Bei jeder Abfrage der Wärmepumpe
(Standard alle 5 Minuten) schreibt die Bridge die **Speichertemperatur** (`dhwCircuits/dhw1/actualTemp`),
den **Sollwert** (`currentSetpoint`) und den **Betrieb** (`heatSources/actualHeatDemand`:
Heizen/Warmwasser) mit. Alles ist am **Speicherfühler** gemessen – oben im Speicher ist es etwas
wärmer, unten am Kaltwasser-Eintritt kälter.

* **Ladungen:** jede Warmwasser-Ladung mit Temperatur am Start (= tatsächliche
  Einschalttemperatur) und am Ende, Dauer und Heizpause. Wird eine Ladung unterbrochen
  (z. B. maximale Ladezeit erreicht, die Heizung kommt kurz dran) und geht innerhalb von
  90 Minuten weiter, zählt sie als **eine** – so werden die „3-Stunden-Programme“ sichtbar.
  Lange Ladungen bekommen ihre Gründe dazu: *unterbrochen*, *währenddessen gezapft*,
  *kalt draußen*, *die letzten 2 °C dauerten lange*, *Soll nicht erreicht*, *langer Anlauf*.
* **Minuten pro Grad:** wie viel Zeit jedes Grad beim Aufheizen kostet (der erste
  Anstieg einer Ladung zählt zur Anlaufzeit). Je heißer der Speicher, desto langsamer –
  daran sieht man, was die letzten Grad bis zum Soll kosten.
* **Entladen:** wie lange ein voller Speicher hält, der **Ruheverlust** (langsames Fallen
  ohne Zapfen; über ~0,8 °C/h deutet auf eine dauernd laufende Zirkulation oder schlechte
  Dämmung) und die **Zapfungen** (Fühler fällt schneller als 3 °C/h) nach Uhrzeit.
* **Legionellen:** höchster Wert, Stunden pro Tag unter 45 °C bzw. 50 °C, und ob eine
  Aufheizung auf **60 °C** (thermische Desinfektion) vorkam (Fühler ≥ 59 °C oder Soll ≥ 60 °C).
* **Was wäre wenn:** andere Start-/Stopptemperaturen, gerechnet mit den gemessenen
  Minuten je Grad und den Grad, die der Speicher am Tag verliert (Ladungen/Tag =
  Grad pro Tag ÷ Schaltdifferenz; das Modell wird so skaliert, dass die heutige
  Einstellung die gemessene Dauer trifft). Eine **Schätzung**: kleinere Schaltdifferenz =
  kürzere, dafür häufigere Ladungen; die Warmwasser-Zeit pro Tag bleibt etwa gleich.

**Zur Einordnung:** Legionellen vermehren sich vor allem zwischen 25 und 45 °C, ab etwa
50 °C kaum noch; bei 55 °C sterben sie langsam ab (Stunden), bei 60 °C in Minuten. Das
DVGW-Arbeitsblatt W 551 empfiehlt für Ein- und Zweifamilienhäuser 60 °C am Speicher und, ihn
nie dauerhaft unter 50 °C zu betreiben; eine Prüfpflicht gibt es im selbst genutzten
Einfamilienhaus nicht. Mit Wärmepumpe üblich: im Alltag 50–55 °C und 1× pro Woche 60 °C.
Start-/Stopptemperatur (bzw. Schaltdifferenz), maximale Ladezeit und thermische Desinfektion
stehen bei Bosch meist im Fachmann-Menü des Reglers.

## Technischer Hintergrund

* Login: SingleKey ID OAuth 2.0 (Authorization Code + PKCE),
  `https://singlekey-id.com/auth/connect/token`. Die Bridge speichert den
  **Refresh-Token** und erneuert den Access-Token selbstständig.
* Daten: `https://pointt-api.bosch-thermotechnology.com/pointt-api/api/v1/gateways/{id}/resource/...`
  – die **CS6800i AW** liefert die Energie über
  `heatSources/emon/totalConsumption` (Werte `compressor`, `eheater`,
  `outputProduced`), dazu `actualModulation`, `actualSupplyTemperature`,
  `numberOfStarts`, `workingTime/totalSystem`, `system/sensors/temperatures/outdoor_t1`.
  (Ältere Anlagen nutzen ggf. `hs1/actualPower` o. ä. – der `/api/homecom/probe`-
  Endpunkt zeigt, was deine Anlage kennt.)
* **Volumenstrom:** Bosch dokumentiert für die CS6800i keinen festen Pfad. Die
  Bridge durchsucht deshalb nach der ersten Abfrage (danach wöchentlich, oder per
  Knopf im Abgleich unter „Datenlage") die Bäume `heatSources`, `system` und
  `heatingCircuits` nach einem Wert in l/min, l/h oder m³/h und schreibt ihn bei
  jeder Abfrage mit (**gelesen**). Grenz-/Sollwerte (z. B. `max…`) werden nicht
  als Messwert genommen. Meldet die Anlage keinen, wird er **abgeleitet**:
  l/min = Wärmeleistung ÷ (1,163 Wh/(l·K) × Spreizung × 60), je 15–90 min
  Heizbetrieb mit laufendem Verdichter, Abschnitt für Abschnitt (Abtauung und
  Pausen zählen weder bei Wärme noch Zeit); bei einem groben Wärmezähler (z. B.
  1-kWh-Schritte) werden viele Läufe zusammengerechnet. Der Wert gilt für das
  Wasser durch die Wärmepumpe – mit Pufferspeicher oder hydraulischer Weiche
  fließt in den Heizkreisen eine andere Menge. Ergebnis: `/api/heatpump/flow`.
* **Arbeitszahl Datenblatt vs. Praxis:** `/api/heatpump/coptheory?days=30&pts=-7:35:2.36,2:35:4.06,7:35:4.8`
  (Punkte: Außen:Vorlauf:COP; ohne `pts` die 6800i AW 7 OR-S).
* **Warmwasser-Speicher:** `/api/heatpump/dhwtank?days=14` (Ladungen, Minuten je Grad,
  Entladen, Sollwerte, Legionellen-Kennzahlen, Szenarien) aus `dhw_log` + `hp_samples`.
* **Anlagen-Check:** `/api/heatpump/checkup?days=30&design=-12&lat=…&lon=…` (Heizkurve, Heizlast-Kennlinie mit
  Tagespunkten, Leistungsannahme und Bivalenzpunkten, Heizstab nach Außentemperatur und Betriebsart,
  Warmwasser-Stunden, Spreizung, Durchfluss, Außenfühler gegen Wetterdienst, Abtauen, Raumtemperatur,
  Tagesmittel der Außentemperatur des letzten Jahres `tdays`).
* Umgesetzt in `bridge/homecom.py` – **ohne Zusatzpakete** (nur Standardbibliothek).
  Grundlage der Endpunkte: das Community-Projekt
  [`serbanb11/homecom_alt`](https://github.com/serbanb11/homecom_alt).

> Die Cloud-API ist inoffiziell/reverse-engineered und kann sich ändern.
