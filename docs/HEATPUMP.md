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

## Häufige Meldungen

| Meldung | Bedeutung |
|---|---|
| „Login fehlgeschlagen … Code korrekt/kopiert?" | Der Code ist nur wenige Minuten gültig. Login-Link neu öffnen, neu anmelden, Adresse frisch kopieren. |
| „Keine Wärmepumpe gefunden" | Anmeldung ok, aber HomeCom liefert kein Gateway. Ist die WP in der HomeCom-App online? |
| „Fehler" im Setup-Status | Letzter Abruf schlug fehl (z. B. Token abgelaufen/Netz). Die Bridge erneuert den Token automatisch; bei dauerhaftem Fehler neu verbinden. |
| „HomeCom-Anmeldung abgelaufen" / `invalid_grant` | Der Refresh-Token ist verbraucht/ungültig – im Setup einfach **neu verbinden** (neuer Login-Code). Wird ab Werk automatisch rotiert und gespeichert. |
| „HomeCom-Modul nicht installiert" | Datei `bridge/homecom.py` fehlt – aus dem Repo nachziehen. |

---

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
* Umgesetzt in `bridge/homecom.py` – **ohne Zusatzpakete** (nur Standardbibliothek).
  Grundlage der Endpunkte: das Community-Projekt
  [`serbanb11/homecom_alt`](https://github.com/serbanb11/homecom_alt).

> Die Cloud-API ist inoffiziell/reverse-engineered und kann sich ändern.
