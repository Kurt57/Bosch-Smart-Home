# Tibber verbinden – echte Tarifpreise ⚡

Wenn du einen **Tibber**-Vertrag hast, kann die App deine **tatsächlichen
stündlichen Tarifpreise** anzeigen – statt der Schätzung „Börsenpreis +
Aufschlag". Diese Preise sind **all-in** (Energie + Netzentgelte + Steuern +
MwSt.), also genau das, was du wirklich pro kWh zahlst.

Sobald verbunden, nutzt der ganze **Börse-Tab** deine Tibber-Preise:
Preiskurve, beste Zeiten für Warmwasser/Waschen/E-Auto, die **Live-Ampel**
(„jetzt guter Zeitpunkt?") und der **Smart-Timer**.

## So bekommst du den Token

1. Öffne **[developer.tibber.com](https://developer.tibber.com/)** und melde
   dich mit **deinem Tibber-Konto** an (dieselben Zugangsdaten wie in der
   Tibber-App).
2. Im Bereich **Access Token** einen persönlichen Token erzeugen bzw. kopieren.
3. In der App: **Setup → „Tibber verbinden"** → Token einfügen → **Verbinden**.

Der Token ist ein **Lese-Zugang** zu deinen Preis- und Verbrauchsdaten. Er wird
**nur lokal** auf deiner Bridge gespeichert (in `bridge/config.json`, per
`.gitignore` von Commits ausgeschlossen) – niemals im Code oder in der Cloud.

## Was genau angezeigt wird

* **Aktuelle & kommende Preise** (heute + morgen, sobald Tibber sie
  veröffentlicht) als **ct/kWh all-in**.
* Die **beste Startzeit** für flexible Lasten – im Smart-Timer wahlweise nach
  Preis, CO₂ oder PV-Überschuss.
* Eine **Live-Ampel**: kombiniert deinen aktuellen Preis mit der
  CO₂-Intensität des Netzes zu einer klaren „jetzt / später"-Empfehlung.

Für die **saisonale Kostenrechnung** (Konzept-Tab, Jahreswerte) wird die
Tages-/Stundenkurve auf das typische Jahresprofil hochgerechnet, weil Tibber
nur die nächsten ~2 Tage liefert.

## Echter Gesamtverbrauch

Zusätzlich zu den Preisen liest die App deinen **tatsächlichen Verbrauch** aus
dem Tibber-Zähler – den **Netzzähler des ganzen Hauses**. Im **Verlauf**-Tab
erscheint dann die Karte **„Gesamtverbrauch (Tibber)"** mit den Tageswerten
(kWh + Kosten) der letzten 30 Tage. Das erfasst **alle** Verbraucher, auch die,
die die Bosch-Module nicht messen (Kühlschrank, Herd, Licht …) – eine gute
Gegenprobe zur gemessenen Smart-Home-Summe.

Route: `GET /api/tibber/consumption?resolution=DAILY&last=30`.

## Kein Tibber?

Ohne Tibber bleibt alles beim **kostenlosen Börsen-Feed** (EPEX Day-Ahead über
aWATTar) plus deinem eingetragenen **Aufschlag** und der **MwSt.** – siehe
**Setup → „Dynamischer Börsentarif"**. Beide Wege liefern **Bruttopreise**.

## Technik

* Endpoint: `https://api.tibber.com/v1-beta/gql` (GraphQL), Bearer-Token.
* Client: `bridge/tibber.py` (nur Standardbibliothek), gecacht ~15 min.
* Bridge-Routen: `POST /api/tibber/connect` (Token prüfen & speichern),
  `GET /api/tibber` (Status). Bei verbundenem Tibber liefert `GET /api/spot`
  die echten Preise mit `source: "tibber"`.
