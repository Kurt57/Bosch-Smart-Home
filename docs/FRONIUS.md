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
* **Wärmepumpe → Live:** wie viel des Stroms gerade von der Sonne kommt.
* **Wohn-Dashboard (`…/#dash`):** Energiefluss und Empfehlung mit den **gemessenen** Werten
  (alle 10 Sekunden). Antwortet der Wechselrichter länger als 2 Minuten nicht, zeigt es wieder
  die Schätzung – mit Hinweis.

## Voraussetzungen

* Der Wechselrichter ist im **selben Heimnetz** wie die Bridge (LAN-Kabel oder WLAN –
  richtet meist der Installateur ein). Gast-WLAN oder ein eigenes VLAN trennen ihn ab.
* **GEN24/Tauro: Solar API einschalten** (ab Werk aus), siehe unten.
* Für Verbrauch, Einspeisung, Autarkie und „gespart" braucht es einen **Fronius Smart Meter**
  (gehört bei GEN24 mit Batterie praktisch immer dazu). Ohne ihn sieht der Wechselrichter nur
  die Erzeugung – die App zeigt dann nur die PV-Werte.

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
Strings, Smart-Meter-Zählerstände und Batterie. Gespeichert wird **je Minute ein Mittelwert**
(Tabelle `pv_samples` in `bridge/energy.db`). Die Adresse steht in `bridge/config.json`;
nach einem Neustart verbindet sich die Bridge von selbst wieder.

> **Historie:** Der GEN24 bietet über die Solar API keine abrufbare Vergangenheit. Die
> Auswertungen beginnen deshalb mit dem Moment der Verbindung – je länger die Bridge läuft,
> desto aussagekräftiger werden Verlauf und Monatswerte.

## Wie gerechnet wird

* **Eigenverbrauch** = Anteil der PV-Erzeugung, der nicht eingespeist wurde (inkl. Batterieladung).
* **Autarkie** = Anteil deines Verbrauchs, der nicht aus dem Netz kam.
* **Gespart** = (Verbrauch − Netzbezug) × Strompreis + Einspeisung × Einspeisevergütung.
  Strompreis aus dem Setup, Vergütung aus dem PV-Planer (Feld „Einspeisung ct/kWh") –
  dort deinen Satz laut Netzbetreiber eintragen.
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
* **Erwartung** (Monatstabelle) = Jahresertrag je kWp aus dem PV-Planer bzw. PVGIS ×
  installierte kWp × Monatsanteil, auf die Tage mit Daten gerechnet. Das Wetter schwankt von
  Jahr zu Jahr um etwa ±15 %.

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
