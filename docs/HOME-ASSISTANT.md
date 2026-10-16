# Home Assistant verbinden 🏠

Wenn bei dir **Home Assistant (HA)** läuft, kann die App dessen **Leistungs- und
Energiesensoren** mitlesen. Das ist ein **optionaler Zusatz**, um Geräte in die
App zu holen, welche die Bosch-Module **nicht** messen – zum Beispiel einen
**Lesekopf am Hauptzähler**, eine **PV-/Batterie-Integration** oder andere
Nicht-Bosch-Geräte.

## Für messende Steckdosen lieber Bosch Smart Plug+

Für einzelne Verbraucher (Waschmaschine, Kühlschrank, Trockner …) ist der
**Bosch Smart Plug+** der einfachere Weg: Er wird ganz normal im Bosch Smart
Home gekoppelt, benannt und einem Raum zugeordnet – und **erscheint dann
automatisch** als Bosch-Zähler in dieser App. Kein HA, kein Token, kein
Zusatz-Setup nötig; die Bridge erkennt jedes Gerät mit `PowerMeter`-Service
dynamisch (siehe `bridge/shc_bridge.py`, `list_power_devices`).

Der HA-Weg lohnt sich also vor allem für Sensoren, die es als Bosch-Gerät nicht
gibt – z. B. den Netz-/Hauptzähler oder Wechselrichter-Daten.

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

## Sensoren, die „bei 0 hängen"

Manche Geräte (vor allem alte **HomeKit-Steckdosen**) melden zwar eine Leistungs-
Characteristic, schicken aber **keine Update-Events**. HA zeigt den Sensor dann
dauerhaft mit dem alten Wert (oft `0 W`) an, obwohl das Gerät den echten Wert auf
Abruf liefert. Unsere Bridge fängt das ab: sie ruft vor jedem Auslesen den
HA-Dienst **`homeassistant.update_entity`** für die betroffenen Sensoren auf
(`refresh=True`), sodass HA den Wert frisch einliest. Man braucht dafür **keine
Automatisierung in HA**. Alternativ ginge eine HA-Automatisierung mit
`time_pattern` + `homeassistant.update_entity`.

> Praxis-Hinweis: Bei manchen Geräten (z. B. der alten Koogeek P1EU) hilft auch
> `update_entity` nicht, weil sie den Wert nur intern aktualisieren. Für einzelne
> Verbraucher ist deshalb der **Bosch Smart Plug+** die zuverlässigere Wahl – er
> misst nativ und erscheint automatisch in der App.
