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
warm wird, sobald die Sonne das Haus versorgt; Zahlen rollen beim Aktualisieren auf den neuen Wert. Sie rechnet
nichts selbst: Alle 15 Sekunden holt sie `GET /api/tv` von der Bridge, dort steht alles fertig formuliert
(dieselben Regeln wie im Wohn-Dashboard, z. B. die Fenster-Blinkschwelle und der Tonnen-Vorlauf aus dem Setup).
Der Bildschirmschoner bleibt aus, solange die App offen ist (abschaltbar, siehe unten). ▶︎❙❙ auf der
Fernbedienung lädt sofort neu; ein Klick auf die Mitte der Fernbedienung öffnet die Einstellungen
(⚙︎ oben rechts: Adresse der Bridge, „Bildschirm anlassen“). Damit alles ohne Blättern auf den Fernseher passt,
zeigt die App höchstens 2 Hinweis-Kacheln (weitere als Zeile „+ N weitere: …“), 9 Räume und so viele Termine,
wie darunter Platz haben.

**Kinder-Routine 🧒:** Läuft eine Routine (z. B. die Abendroutine, eingerichtet in der App unter Setup →
*Kinder-Routine*), steht links statt des Energieflusses je Kind eine Abhakliste. Mit der Fernbedienung auf eine
Aufgabe wischen und klicken – abgehakt; noch einmal klicken nimmt den Haken zurück. Die Liste ist dieselbe wie im
Wohn-Dashboard (die Bridge führt sie). Wer alles geschafft hat, bekommt Konfetti und einen ⭐. Während die Liste
zu sehen ist, liegt der Fokus meist auf einer Aufgabe – für die Einstellungen nach oben rechts zum ⚙︎ wischen.

**„Zu kalt“** misst gegen deine **Wunschtemperatur** je Raum (Wärme → Abgleich), sonst gegen das Thermostat-Soll –
aber höchstens 22 °C: Steht ein Thermostat auf 25 °C, ist das bei einer Wärmepumpe meist ein absichtlich offenes
Ventil, kein Wunsch. Gemeldet wird ab 1,5 K darunter (gleiche Regel im Wohn-Dashboard).

**Feier-Modus 🎉:** An einem Geburtstag oder Jahrestag steht oben in der Mitte ein Glückwunsch, das Farblicht
wird pink, violett und gold, und Konfetti fliegt – beim Start aus den unteren Ecken, alle 10 Minuten als
Schauer von oben und jedes Mal, wenn du ▶︎❙❙ drückst. Eingeschaltet wird er in der App unter Setup →
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
  ist daran nicht beteiligt und zeigt weiter das Dashboard; die App selbst macht keinen Ton und unterbricht
  nichts.

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
