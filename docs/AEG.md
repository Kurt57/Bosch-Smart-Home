# AEG / Electrolux Haushaltsgeräte anbinden 🧺

Vernetzte **AEG-/Electrolux-Geräte** (Waschmaschine, Trockner …) mit WLAN lassen
sich einbinden. Die Bridge liest über die **offizielle Electrolux-Group-API**
den **Betriebszustand**, den **Strom pro Waschgang** und den **Gesamt-kWh-Zähler**
aus. Auf der **Übersicht** erscheint dann eine Karte **„Haushaltsgeräte"**.

> Anders als der Bosch-Controller (lokal im LAN) läuft AEG/Electrolux **über die
> Cloud** – du brauchst einmalig Zugangsdaten aus dem Entwickler-Portal. Danach
> bleibt alles lokal auf deiner Bridge; nichts wird an Dritte weitergegeben.

## Voraussetzung

* Das Gerät ist in der **AEG-App** (bzw. Electrolux-App) eingerichtet und **online**.
* Der Verbrauch (kWh) wird nur angezeigt, wenn dein Modell ihn meldet. Viele
  AEG-Waschmaschinen liefern einen **Gesamtzähler** und **kWh pro Waschgang** –
  falls nicht, siehe *Diagnose* unten.

## Zugangsdaten erstellen

1. Auf **[developer.electrolux.one](https://developer.electrolux.one/)** gehen und
   mit **derselben E-Mail wie in der AEG-App** registrieren/anmelden.
2. Im **[Dashboard](https://developer.electrolux.one/dashboard)**:
   * einen **API-Key** erstellen,
   * einen **Access-Token** und einen **Refresh-Token** generieren.

## In der App verbinden

1. In der Web-App den Tab **Setup** öffnen → Karte **„🧺 AEG / Electrolux verbinden"**.
2. **API-Key** und **Refresh-Token** einfügen (Access-Token optional) → **Verbinden**.
3. Die Bridge prüft die Zugangsdaten, listet deine Geräte auf und startet die
   regelmäßige Abfrage. Auf der **Übersicht** taucht die Karte **„Haushaltsgeräte"** auf.

Die Tokens landen ausschließlich in `bridge/config.json` (per `.gitignore`
ausgeschlossen). Der Refresh-Token rotiert bei jeder Erneuerung – die Bridge
speichert den neuen automatisch.

## Was angezeigt wird

* **Zustand:** läuft / bereit / fertig (inkl. Programm & Restzeit, wenn verfügbar).
* **Waschgänge:** der kumulative Zykluszähler des Geräts (z. B. 429).
* **Heute / Gesamt:** Stromverbrauch.

### Wichtig: viele Modelle melden **kein kWh** 🔎

In der Praxis liefern **viele AEG-Waschmaschinen über die API keinen Energiewert**
(das `energy_fields`-Objekt in der Diagnose ist dann leer). Sie melden aber einen
**Waschgang-Zähler** (`totalWashCyclesCount`). Für solche Geräte **schätzt** die App
die Energie als **Waschgänge × ø kWh/Waschgang** und markiert die Werte mit **„≈"**.

* Der Standardwert ist **0,8 kWh/Waschgang** (gemischte Nutzung, 9-kg-Klasse).
* Passe ihn im **Setup** unter der AEG-Karte an (Feld **„Ø kWh pro Waschgang"**) –
  z. B. an den Wert vom Energielabel oder aus einer Messung mit einem Zwischenstecker.
* Meldet dein Modell **doch** einen echten kWh-Wert, wird dieser bevorzugt (ohne „≈").

## Diagnose (Rohdaten deines Geräts)

Im Setup unter der AEG-Karte: **„Diagnose: Rohdaten anzeigen"** → **Gerät abfragen**.
Das zeigt die tatsächlich gemeldeten Felder (`reported`) und alle gefundenen
`energy`-Werte. Ist `energy_fields` leer, greift die Waschgang-Schätzung oben.

## Konfiguration per Datei (alternativ)

```json
{
  "electrolux_api_key": "DEIN-API-KEY",
  "electrolux_refresh_token": "DEIN-REFRESH-TOKEN",
  "electrolux_interval": 300,
  "electrolux_kwh_per_cycle": 0.8
}
```

`electrolux_interval` sind die Sekunden zwischen den Abfragen (Standard 300).
Nicht zu häufig abfragen – die API hat ein Tageslimit.
`electrolux_kwh_per_cycle` ist die Schätzung pro Waschgang für Geräte ohne kWh-Feld.
