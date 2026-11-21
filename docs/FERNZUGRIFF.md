# Erreichbarkeit & Fernzugriff

## Warum das iPhone die Bridge manchmal nicht erreicht

Die App holt alle Zahlen von der Bridge auf deinem Mac. Ist sie nicht erreichbar, zeigt die App
„Bridge nicht erreichbar · letzter Stand …“ samt dem Zeitpunkt, zu dem sie zuletzt geantwortet hat.
Die häufigsten Ursachen:

| Ursache | Woran man es erkennt | Abhilfe |
|---|---|---|
| **Mac im Ruhezustand** | Setup → „📶 Erreichbarkeit“: „Mac … × im Ruhezustand“ | Startskripte halten den Mac wach (siehe unten) |
| **IP-Adresse des Macs hat gewechselt** | „IP-Adresse … × gewechselt“ | feste IP im Router oder Adresse mit Namen (`….local`) |
| **Bridge-Fenster geschlossen / Mac neu gestartet** | „vorher unerwartet beendet“ | Startskript als Anmeldeobjekt |
| **Neustart nach einem Update** | „Start nach Update“ im Protokoll | dauert Sekunden – kurz warten |
| **iPhone nicht im WLAN** (Mobilfunk) | – | von unterwegs nur per VPN (siehe unten) |
| **iPhone im Gast-WLAN** | – | Gastnetze sind vom Heimnetz getrennt – ins normale WLAN wechseln |
| **Safari-Meldung „HTTPS-Only“** beim Neuladen | Safari-Fehlerseite statt App | siehe README, oder HTTPS per Tailscale |

Die Bridge führt dazu ein kleines **Protokoll** (Setup → „📶 Erreichbarkeit & Fernzugriff“): jeden Start
und ob der Lauf davor sauber endete, Zeiten im **Ruhezustand** (die Bridge merkt, dass ihr Herzschlag
ausgesetzt hat; macOS bestätigt die Aufwachzeit) und **Adresswechsel**. Technisch: `GET /api/bridge/uptime?days=14`.

### Mac wach halten

Ab v216 halten `start-macos.command`, `update-macos.command` und `auto-update-macos.command` den Mac mit
`caffeinate -s` wach, **solange die Bridge läuft und der Mac am Netzteil hängt** (der Bildschirm darf
ausgehen). Abschalten: vor dem Start `BRIDGE_ALLOW_SLEEP=1` setzen. Zusätzlich hilft:
Systemeinstellungen → Energie → „Automatischen Ruhezustand verhindern, wenn der Bildschirm aus ist“.
Ein **zugeklapptes MacBook** schläft trotzdem (außer mit externem Bildschirm).

### Feste Adresse

Der Router kann dem Mac nach einer Weile eine neue IP geben – eine Homescreen-App mit der alten Adresse
findet die Bridge dann nicht mehr. Am einfachsten, unabhängig vom Router: die App über den **Namen** des
Macs öffnen (`http://<name>.local:8090`, steht in der Karte und beim Start im Terminal) und neu zum
Home-Bildschirm hinzufügen – oder Tailscale nutzen, dessen Adresse sich nie ändert. Einstellungen kommen
dabei automatisch von der Bridge. Manche Router können dem Mac auch immer dieselbe IP geben (FRITZ!Box:
Heimnetz → Netzwerk → Gerät bearbeiten → „Diesem Netzwerkgerät immer die gleiche IPv4-Adresse zuweisen“);
bei Telekom-Speedports geht das je nach Modell nicht oder nur eingeschränkt.

### Automatisch starten

Damit die Bridge nach einem Neustart des Macs von selbst läuft: `auto-update-macos.command` (oder
`start-macos.command`) unter Systemeinstellungen → Allgemein → Anmeldeobjekte hinzufügen.

## Von unterwegs – sicher per VPN

Die Bridge hat **kein Passwort**. Sie gehört deshalb nicht ins offene Internet: **keine Portfreigabe** im
Router. Ab v216 nimmt sie nur Verbindungen aus dem Heimnetz (private Adressen), von diesem Rechner und aus
VPN-Adressbereichen (Tailscale `100.64.0.0/10`) an; Anfragen von öffentlichen Adressen beantwortet sie mit
„403“ und einem Hinweis im Terminal. Wer die Bridge bewusst hinter einem eigenen Reverse-Proxy mit
Anmeldung betreibt, kann das mit `"allow_public_clients": true` in `bridge/config.json` abschalten.

### Empfehlung: Tailscale

Kostenlos für private Nutzung, WireGuard-verschlüsselt, keine Portfreigabe, funktioniert an jedem
Anschluss.

1. Auf dem Mac Tailscale installieren und anmelden (Konto mit Zwei-Faktor-Schutz).
2. Auf dem iPhone die Tailscale-App installieren und mit **demselben Konto** anmelden.
3. Bridge neu starten – im Terminal und in der Karte „📶 Erreichbarkeit“ erscheint die Adresse für
   unterwegs, z. B. `http://<mac-name>.<tailnet>.ts.net:8090` bzw. `http://100.x.y.z:8090`.
4. Diese Adresse am iPhone in Safari öffnen und „Zum Home-Bildschirm“ hinzufügen. Sie funktioniert auch zu
   Hause, solange Tailscale am iPhone eingeschaltet ist.

**Optional HTTPS:** `tailscale serve --bg 8090` auf dem Mac (beim ersten Mal fragt Tailscale, ob
HTTPS-Zertifikate eingeschaltet werden sollen). Dann gibt es `https://<mac-name>.<tailnet>.ts.net` mit
gültigem Zertifikat – nur im eigenen Tailnet erreichbar. Damit entfällt auch die Safari-Meldung zu HTTP.
**Kein „Funnel“** einschalten: der macht die Adresse öffentlich.

### Alternative: VPN des Routers

**Speedport 7:** Die Telekom hat für den Speedport 7 ein eingebautes WireGuard-VPN angekündigt; in der
Telekom-Community hieß es zuletzt, ein Termin stehe noch nicht fest. Firmware-Updates kommen beim
Speedport 7 automatisch – ob das VPN schon da ist, zeigen die Firmware-Hinweise der Telekom bzw. die
MeinMagenta-App. Bis dahin ist Tailscale der Weg.

**FRITZ!Box:** Ohne zusätzlichen Dienst eine WireGuard-Verbindung für das iPhone anlegen und in der
WireGuard-App importieren. Das iPhone ist dann „im Heimnetz“, die gewohnte Adresse bleibt. Funktioniert
nur, wenn die FRITZ!Box von außen erreichbar ist (nicht bei jedem Anschluss, z. B. DS-Lite ohne eigene
IPv4-Adresse).
