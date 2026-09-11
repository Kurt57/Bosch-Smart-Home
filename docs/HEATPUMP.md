# Wärmepumpe anbinden (Bosch HomeCom Easy)

Die Bosch **Compress 6800i AW** (und verwandte 5800i/6800i) gehört **nicht** zum
Smart Home Controller, sondern zur Bosch-Heizungswelt. Die App liest sie über
**HomeCom Easy** (Bosch-Cloud) aus – zusätzlich zu den Licht-/Rollladenmodulen.

Angezeigt werden (soweit deine Anlage sie liefert):

* **Aktuelle elektrische Leistung** (W) – aus dem Stromzähler der WP abgeleitet
* **Stromverbrauch gesamt** (kWh)
* **Wärmeleistung** (kW) und **Modulation** (%)
* **Außentemperatur** und ein **geschätzter COP** (Wärme ÷ Strom)

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

### Wenn der Browser direkt „weiterspringt" und du die Adresse nicht siehst
Manche Browser verbergen die Redirect-Adresse. Dann hilft die Community-Erweiterung
**„SingleKey Code Catcher"** (Firefox-Add-on), die den Code automatisch anzeigt –
oder du öffnest den Login-Link in einem Desktop-Browser, wo die Adressleiste die
`code=…`-Adresse behält.

---

## Häufige Meldungen

| Meldung | Bedeutung |
|---|---|
| „Login fehlgeschlagen … Code korrekt/kopiert?" | Der Code ist nur wenige Minuten gültig. Login-Link neu öffnen, neu anmelden, Adresse frisch kopieren. |
| „Keine Wärmepumpe gefunden" | Anmeldung ok, aber HomeCom liefert kein Gateway. Ist die WP in der HomeCom-App online? |
| „Fehler" im Setup-Status | Letzter Abruf schlug fehl (z. B. Token abgelaufen/Netz). Die Bridge erneuert den Token automatisch; bei dauerhaftem Fehler neu verbinden. |
| „HomeCom-Modul nicht installiert" | Datei `bridge/homecom.py` fehlt – aus dem Repo nachziehen. |

---

## Technischer Hintergrund

* Login: SingleKey ID OAuth 2.0 (Authorization Code + PKCE),
  `https://singlekey-id.com/auth/connect/token`. Die Bridge speichert den
  **Refresh-Token** und erneuert den Access-Token selbstständig.
* Daten: `https://pointt-api.bosch-thermotechnology.com/pointt-api/api/v1/gateways/{id}/resource/...`
  (u. a. `heatSources/electricityTotalConsumption`, `heatSources/hs1/actualPower`,
  `heatSources/hs1/powerPercentage`).
* Umgesetzt in `bridge/homecom.py` – **ohne Zusatzpakete** (nur Standardbibliothek).
  Grundlage der Endpunkte: das Community-Projekt
  [`serbanb11/homecom_alt`](https://github.com/serbanb11/homecom_alt).

> Die Cloud-API ist inoffiziell/reverse-engineered und kann sich ändern.
