# Wohn-Dashboard auf dem Apple TV

Das Apple TV hat keinen Webbrowser, und tvOS-Apps dürfen offiziell keine Webseiten einbetten. Deshalb
gibt es zwei Wege:

| Weg | Aufwand | Ergebnis |
|---|---|---|
| **AirPlay-Bildschirmsynchronisierung** | sofort, ohne Programmierung | iPad/Mac zeigt `…/#dash`, das Apple TV spiegelt es. Das Gerät ist dabei belegt. |
| **Eigene Apple-TV-App** (`appletv/`) | einmal mit Xcode installieren | eigenständige App auf dem Apple TV, holt die Werte selbst von der Bridge |

## Die App

Die App zeigt Uhr, Außentemperatur, Zuhause/Abwesend, **Hinweise** (Fenster offen, lüften, Raum zu kalt,
Termin in der nächsten Stunde, Mülltonnen, Batterie lädt aus dem Netz, PV/Wärmepumpe ohne Werte),
**Energie jetzt** als bewegtes Bild – das Haus in der Mitte, Sonne, Batterie, Netz und Wärmepumpe drumherum,
Punkte laufen in Flussrichtung, schneller bei mehr Leistung –, **Heute** (erzeugt, verbraucht, autark und
Eigenverbrauch mit Ring, Netzbezug, Einspeisung, gespart – mit „+ ≈ … € im Akku“, solange heute Geladenes noch
nicht verbraucht ist), die **Räume** mit Thermometer-Balken (weißer Strich =
deine Wunschtemperatur) und die nächsten **Termine**. Glaskarten über einem langsam wandernden Farblicht, das
warm wird, sobald die Sonne das Haus versorgt (oder ein ruhiges Farbschema, siehe unten); Zahlen rollen beim Aktualisieren auf den neuen Wert. Sie rechnet
nichts selbst: Alle 15 Sekunden holt sie `GET /api/tv` von der Bridge, dort steht alles fertig formuliert
(dieselben Regeln wie im Wohn-Dashboard, z. B. die Fenster-Blinkschwelle und der Tonnen-Vorlauf aus dem Setup).
Der Bildschirmschoner bleibt aus, solange die App offen ist (abschaltbar, siehe unten). ▶︎❙❙ auf der
Fernbedienung lädt sofort neu; ein Klick auf die Mitte der Fernbedienung öffnet die Einstellungen
(⚙︎ oben rechts: Adresse der Bridge, „Bildschirm anlassen“, Farbschema). Damit alles ohne Blättern auf den Fernseher passt,
zeigt die App höchstens 2 Hinweis-Kacheln (weitere als Zeile „+ N weitere: …“), 9 Räume und so viele Termine,
wie darunter Platz haben.

**Farbschema 🎨:** In den Einstellungen (⚙︎) rechts – nach rechts wischen – wählst du das Aussehen; es wirkt
sofort und bleibt auf dem Apple TV gespeichert. *Aurora* ist das ursprüngliche (wanderndes Farblicht hinter
Milchglas), *Aurora sanft* dasselbe Licht halb so stark mit fast deckenden Karten. Ganz ohne Schimmer und ohne
wanderndes Licht: *Nacht* (Anthrazit), *Graphit* (kühles Blaugrau), *Wald* (tiefes Grün) und *Kamin* (warmes Braun) –
matte Karten, ein ruhiger Verlauf mit einem schwachen Licht in den oberen Ecken, das ein wenig warm wird, wenn die
Sonne das Haus versorgt. Die Statusfarben (grün = gut, orange = Achtung) bleiben überall gleich.

**Tachos:** Der Akku hat im Energiefluss einen Ring für seinen Ladestand (grün ab halb voll, orange darunter, rot
unter einem Fünftel); lädt er, läuft ein heller Funke den Ring entlang. Bei „Sonne erzeugt“ zeigt ein Balken, wie
viel vom heute erwarteten Ertrag schon da ist („von ≈ 12 kWh erwartet“), und neben „außen 4°“ steht das Wetter
des Tages als Symbol.

**Sonne & Wetter ☀️ (ganz unten):** Heute, morgen und übermorgen: wie der Himmel wird (sonnig, heiter,
wechselhaft, trüb, mit Regen/Schnee), die Temperaturen, die Sonne als Tacho (Anteil der hellen Stunden mit
Sonnenschein) und der **erwartete PV-Ertrag** als Balken – aus der Wettervorhersage und dem, was deine Anlage an den
letzten Tagen aus der Sonne gemacht hat (dieselbe Rechnung wie im PV-Tab; braucht den Standort im PV-Setup). Darunter
ein Tipp, z. B. „Heute am meisten Sonne 11–14 Uhr – gut für Waschmaschine, Spülmaschine & Co.“ oder, wenn heute nicht
mehr viel kommt, „Morgen sonnig, ≈ 18 kWh erwartet“.

**Kinder-Routine 🧒:** Läuft eine Routine (z. B. die Abendroutine, eingerichtet in der App unter Setup →
*Kinder-Routine*), steht sie als erste Karte **unterhalb der ersten Seite** – die Kinder nebeneinander, je Kind eine
Abhakliste. Die erste Seite bleibt wie immer (Energie, Räume); oben bei den Hinweisen steht dann „🌙 Abendroutine:
3 von 12 erledigt – zum Abhaken nach unten wischen“. Von den Senderknöpfen aus einmal nach unten wischen landet auf
den Aufgaben. Klicken hakt ab, noch einmal klicken nimmt den Haken zurück. Die Liste ist dieselbe wie im
Wohn-Dashboard (die Bridge führt sie). Wer alles geschafft hat, bekommt Konfetti und einen ⭐.

**Platz auf dem Fernseher – erste Seite und „weiter unten“:** Die erste Seite ist genau so hoch wie der Bildschirm
(nichts rutscht mehr oben heraus): Kopfzeile, Hinweise, Energie, Heute, rechts Radio, Räume und – wenn noch Platz
ist – die nächsten Termine, ganz unten ein **Laufband** mit Fußball-Ergebnissen, den nächsten Spielen und
Schlagzeilen. Alles Weitere liegt darunter – **nach unten wischen**: die Kinder-Routine (während sie läuft), alle
Termine (mit den Fußballspielen), die Nachrichten und ganz unten **Sonne & Wetter** (siehe unten). Jede dieser Karten leuchtet auf, wenn der Fokus auf ihr liegt,
und die Seite rollt mit; nach oben wischen führt zurück.

**Fußball ⚽ und Nachrichten 📰:** Mannschaften (Vereine und Nationalmannschaften) und Nachrichten-Feeds stellst du in
der App im Setup ein (siehe [DASHBOARD.md](DASHBOARD.md)). Die Spiele stehen bei den Terminen und kündigen sich eine
Stunde vorher als Hinweis an; Ergebnisse der letzten drei Tage und die nächsten Spiele laufen durchs Laufband.

**Radio 📻:** Sender, die du in der App unter Setup → *Radio auf dem Apple TV* eingetragen hast, stehen rechts
oben als Knöpfe. Hinwischen und klicken spielt den Sender in der App selbst – das Dashboard bleibt vorne;
noch einmal klicken stoppt. Oben in der Mitte erscheint dann eine **„Läuft gerade“-Karte**: Cover, Titel und
Interpret, kleine Equalizer-Balken und das Cover unscharf als Farblicht dahinter. An einem Feiertag gehört die Mitte
dem Glückwunsch – die Karte steht dann etwas kleiner (mit Cover) unter den Senderknöpfen.

*Woher Titel und Cover kommen:* Streams schicken nur den Titeltext („Interpret – Titel“, die sogenannten
ICY-Metadaten), kein Bild – und manche Sender gar keinen. Die **Bridge** liest den Titel selbst aus dem Stream (eine
kurze Verbindung, wenige KB, alle 20 Sekunden während das Radio läuft; türkische Buchstaben werden richtig gelesen)
und sucht das Cover über Apples öffentliche iTunes-Suche (gesendet werden nur Interpret und Titel). Das Cover wird nur
genommen, wenn der gefundene Interpret passt – bei Moderation, Werbung oder Sendernamen steht das Senderlogo da.
Schickt ein Sender keine Titel, gibt es auch kein Cover. Ob dein Sender Titel schickt, siehst du im Setup: bei
*Meine Sender* auf 🎵 tippen – dort steht, was gerade läuft und ob ein Cover gefunden wurde. Bei Sendern im
HLS-Format (z. B. KRAL FM) liest die Bridge die Titel aus der Playlist oder aus den ID3-Angaben in den neuesten
Teilen des Streams – so wie das Apple TV; manche HLS-Sender schicken den Titel nur beim Liedwechsel, die Bridge
merkt sich den letzten dann ein paar Minuten. Gefunden werden die
Sender im freien Verzeichnis [radio-browser.info](https://www.radio-browser.info) (Suche im Setup, z. B.
„Metropol FM“, mit ▶︎ zum Probehören am Handy); feste Stream-Adressen sind nicht eingebaut, weil Sender sie ab und
zu ändern. Verlässt du die App, stoppt das Radio. Die Lautstärke regelst du wie gewohnt am Fernseher.

**„Zu kalt“** misst gegen deine **Wunschtemperatur** je Raum (Wärme → Abgleich), sonst gegen das Thermostat-Soll –
aber höchstens 22 °C: Steht ein Thermostat auf 25 °C, ist das bei einer Wärmepumpe meist ein absichtlich offenes
Ventil, kein Wunsch. Gemeldet wird ab 1,5 K darunter (gleiche Regel im Wohn-Dashboard).

**Feier-Modus 🎉:** An einem Geburtstag oder Jahrestag steht oben in der Mitte ein Glückwunsch, das Farblicht
wird pink, violett und gold, und Konfetti fliegt – beim Start aus den unteren Ecken, alle 10 Minuten als
Schauer von oben, jedes Mal, wenn du ▶︎❙❙ drückst, und wenn du den Glückwunsch anklickst (vom ⚙︎ nach links
wischen). Eingeschaltet wird er in der App unter Setup →
🖥️ Wohn-Dashboard → *Feier-Modus* („Heute feiern“, mit eigenem Glückwunsch) oder von selbst durch einen
ganztägigen Kalendertermin mit „Geburtstag“, „Birthday“, „Doğum Günü“, „Jahrestag“, „Hochzeitstag“ oder 🎂 im
Namen. Um Mitternacht ist er vorbei. Mit „Bewegung reduzieren“ (Bedienungshilfen) gibt es den Glückwunsch ohne
Konfetti. Das braucht die Bridge ab v224 und die neu gebaute App (Xcode → ▶︎ Run).

Nur Standard-Schnittstellen von tvOS (SwiftUI, ab tvOS 17). Die erste Fassung lief im tvOS-Simulator; ändert
sich der Code, ohne dass ich ihn bauen kann (kein Mac hier), bitte Fehlermeldungen von Xcode weitergeben.

### Installieren (einmalig, am Mac)

Du brauchst **Xcode** (kostenlos im Mac App Store) und eine **Apple-ID**.

1. **Projekt erzeugen** – am einfachsten mit XcodeGen:
   `brew install xcodegen`, dann im Ordner `appletv` den Befehl `xcodegen` ausführen und
   `HausDashboard.xcodeproj` öffnen.
   *Ohne XcodeGen:* Xcode → File → New → Project → **tvOS → App**, Name „HausDashboard“, Interface SwiftUI.
   Die vorgegebenen Swift-Dateien löschen und die vier Dateien aus `appletv/HausDashboard/` ins Projekt
   ziehen. Unter Target → **Info** hinzufügen: „App Transport Security Settings“ → „Allow Arbitrary Loads“
   = YES (die Bridge spricht im Heimnetz unverschlüsseltes HTTP; dort keine weiteren Einträge wie
   „Allows Local Networking“ setzen, sonst greift „Allow Arbitrary Loads“ nicht mehr) und
   „Privacy – Local Network Usage Description“ mit einem kurzen Text.
2. Xcode → Settings → **Accounts**: Apple-ID hinzufügen. Im Projekt unter **Signing & Capabilities** das
   Team wählen; falls der Bundle Identifier schon vergeben ist, einen eigenen eintragen
   (z. B. `de.deinname.hausdashboard`).
3. **Apple TV koppeln:** Apple TV und Mac im selben Netz. Auf dem Apple TV: Einstellungen → Fernbedienungen
   und Geräte → **Remote-App und Geräte** öffnen und den Bildschirm offen lassen. In Xcode: Window →
   **Devices and Simulators** → links unter „Discovered“ das Apple TV auswählen → **Pair** → den Code vom
   Fernseher eingeben. Beim ersten Mal bereitet Xcode das Apple TV einige Minuten für die Entwicklung vor.
4. Oben in Xcode das Apple TV als Ziel wählen und ▶︎ **Run**. Beim ersten Start die Adresse der Bridge
   eintragen – dieselbe wie am iPhone (z. B. `192.168.2.20:8090`, `mac-name.local:8090` oder die
   Tailscale-Adresse). Tippen geht auch übers iPhone: Es meldet sich mit einer Tastatur für das Apple TV.
   Fragt das Apple TV, ob die App Geräte im lokalen Netzwerk finden darf: **Erlauben**.

### Gültigkeit der Installation

Selbst installierte Apps laufen nur so lange, wie Apples Signatur gilt:

* **kostenlose Apple-ID:** 7 Tage – danach in Xcode erneut ▶︎ Run (Apple TV muss erreichbar sein);
* **Apple Developer Program** (99 €/Jahr): 1 Jahr.

Tools wie Sideloadly oder atvloadly können das Erneuern übernehmen (Drittanbieter, eigene Prüfung).

### Gut zu wissen

* **Musik (YouTube Music):** Die App kann sie nicht selbst abspielen – tvOS hat keinen Web-Player (kein WebKit),
  und YouTube Music bietet keine Schnittstelle zum Abspielen in fremden Apps. Damit Musik läuft, während das
  Dashboard zu sehen ist: Musik am iPhone/iPad in der YouTube-Music-App starten und per **AirPlay an den
  HomePod** schicken (im Wohn-Dashboard über die Musik-Kacheln, siehe [DASHBOARD.md](DASHBOARD.md)). Das Apple TV
  ist daran nicht beteiligt und zeigt weiter das Dashboard. Direkt auf dem Fernseher geht dagegen **Radio**
  (siehe oben).
* **Apple Music:** Es gibt keine offizielle Schnittstelle für „läuft gerade auf meinem iPhone“; die Apple-Music-API
  kennt nur „zuletzt gehört“, und dafür bräuchte die App den MusicKit-Dienst (kostenpflichtiges
  Apple-Developer-Programm) und ein Apple-Music-Abo. Deshalb nicht eingebaut.

* Die Bridge nimmt nur Verbindungen aus dem Heimnetz bzw. per VPN an (siehe
  [FERNZUGRIFF.md](FERNZUGRIFF.md)) – das Apple TV steht ja im Heimnetz.
* Ist die Bridge nicht erreichbar, bleibt der letzte Stand stehen, oben steht der Grund und die Uhrzeit.
* Mehrere Apple TVs dürfen gleichzeitig laufen; die Bridge rechnet die Ansicht höchstens alle 20 Sekunden
  neu, der Smart-Home-Controller wird also nicht öfter gefragt.
* **Strom:** Ein Fernseher, der durchläuft, braucht je nach Größe und Bauart grob 50–150 W, über 24 Stunden
  also etwa 1–3,5 kWh. Wer das Dashboard nur ab und zu anschaut, schaltet in den Einstellungen der App
  „Bildschirm anlassen“ aus – dann geht das Apple TV wie gewohnt in den Ruhezustand.
* **OLED-Fernseher:** Ein stundenlanges Standbild kann einbrennen. Die App verschiebt den Inhalt deshalb jede
  Minute um ein paar Punkte; die Schutzfunktionen des Fernsehers (z. B. Pixel-Verschiebung) eingeschaltet lassen.
