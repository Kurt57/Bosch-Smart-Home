# Home Assistant verbinden 🏠

Wenn bei dir **Home Assistant (HA)** läuft, kann die App dessen **Leistungs- und
Energiesensoren** mitlesen. Das ist der einfachste Weg, um Geräte in die App zu
holen, welche die Bosch-Module **nicht** messen – zum Beispiel eine alte
**Koogeek-Steckdose** (P1EU), deren Cloud/App es nicht mehr gibt.

## Warum über Home Assistant?

Die Koogeek ist ein **HomeKit-Gerät** und liefert ihren Momentanverbrauch nur
**lokal, verschlüsselt** über HomeKit (nicht über eine Cloud). Ein neuer
Controller muss sich dafür **kryptografisch koppeln** – das übernimmt HA mit
seiner Integration **„HomeKit Controller"** (Einstellungen → Geräte & Dienste →
Integration hinzufügen → *HomeKit Controller*, dann mit dem 8-stelligen
Setup-Code koppeln). Danach taucht der **Watt-Wert** als Sensor in HA auf – und
unsere Bridge liest ihn ganz normal über die **HA-REST-API** (nur HTTP + Token,
passt zum zero-dependency-Prinzip). HA kann die Steckdose außerdem über seine
eigene **HomeKit Bridge** wieder an Apple Home zurückgeben, sodass Siri/Home-App
weiter funktionieren.

> Hinweis: Um die Steckdose in HA zu koppeln, musst du sie meist **einmal aus
> Apple Home entfernen** (HomeKit erlaubt keine zweite fremde Kopplung). Danach
> übernimmt HA – einmalig, dann hast du Verbrauch **und** Apple Home wieder.

## Token erstellen & verbinden

1. In HA: unten links auf dein **Profil** → ganz unten **Langlebige
   Zugangs-Tokens** → **Token erstellen**, Namen vergeben, Token **kopieren**
   (er wird nur einmal angezeigt).
2. In der App: **Setup → „Home Assistant verbinden"**:
   - **Adresse**: z. B. `http://homeassistant.local:8123` (oder die IP,
     `http://192.168.x.y:8123`).
   - **Token**: den kopierten Long-Lived Access Token.
   - **Sensoren** (optional): leer lassen = alle Leistungs-/Energiesensoren
     automatisch; oder gezielt `sensor.koogeek_p1eu_power, sensor.koogeek_p1eu_energy`.
3. **Verbinden.** Die gefundenen Sensoren erscheinen als Karte **„Home
   Assistant"** auf der **Übersicht** – mit der aktuellen Leistung (W) und, wenn
   vorhanden, dem Energiezähler (kWh).

Adresse und Token bleiben **lokal** auf der Bridge (in `bridge/config.json`,
per `.gitignore` von Commits ausgeschlossen) – niemals im Code oder in der Cloud.

## Technik

* Client: `bridge/ha_client.py` (nur Standardbibliothek).
* Auth: Long-Lived Access Token als `Authorization: Bearer …`.
* Endpunkte: `GET /api/` (Token-Prüfung), `GET /api/states` (alle Entitäten).
* Erkannt werden Sensoren mit `device_class: power` (W/kW → W) und
  `device_class: energy` (Wh/kWh → kWh); Einheiten werden normalisiert.
* Bridge-Routen: `POST /api/ha/connect`, `GET /api/ha` (gecacht ~20 s).
