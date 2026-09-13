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

* **Zustand:** läuft / aus / bereit / fertig (inkl. Programm & Restzeit, wenn verfügbar).
* **Heute:** Zuwachs des **Gesamtzählers seit Mitternacht** (× Strompreis = Kosten).
* **Gesamt:** der kumulative kWh-Zähler des Geräts.
* **Letzter Waschgang:** kWh des letzten Zyklus, falls das Modell ihn meldet.

## Diagnose (falls der Energiewert fehlt/komisch ist)

Die Feldnamen unterscheiden sich je Modell. Im Setup unter der AEG-Karte gibt es
**„Diagnose: Rohdaten anzeigen"** → **Gerät abfragen**. Das zeigt die tatsächlich
gemeldeten Felder (inkl. aller gefundenen `energy`-Werte). Die Bridge normalisiert
Wh/kWh automatisch anhand der Größenordnung des Zählers.

## Konfiguration per Datei (alternativ)

```json
{
  "electrolux_api_key": "DEIN-API-KEY",
  "electrolux_refresh_token": "DEIN-REFRESH-TOKEN",
  "electrolux_interval": 300
}
```

`electrolux_interval` sind die Sekunden zwischen den Abfragen (Standard 300).
Nicht zu häufig abfragen – die API hat ein Tageslimit.
