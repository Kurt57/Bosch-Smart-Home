# Einrichtung – Schritt für Schritt

Diese Anleitung bringt die App auf dein iPhone und verbindet sie mit deinem
Bosch Smart Home Controller (SHC).

---

## 0. Überblick

**Zwei Bosch-Geräte, nicht verwechseln:**

* **Smart Home Controller II** – die *Zentrale* (Gateway). Mit ihr redet die
  Bridge. Sie misst selbst keinen Strom.
* **Licht-/Rollladensteuerung II** – die *Unterputz-Module* an Lampen/Rollläden.
  Diese messen die Leistung und liefern die Verbrauchsdaten, die die App anzeigt.

Du brauchst außerdem ein Gerät im Heimnetz, das dauerhaft läuft und die **Bridge**
ausführt (Raspberry Pi, NAS, alter Laptop, Mac oder PC). Das iPhone öffnet nur
die Web-Seite dieser Bridge – es muss nichts installiert werden.

```
Bosch SHC  ──▶  Bridge (Python auf Pi/NAS/PC)  ──▶  iPhone-Browser
```

---

## 1. Bridge herunterladen

Kopiere den Ordner `bridge/` (und `frontend/`) auf das Dauerläufer-Gerät, z. B.:

```bash
git clone <dieses-repo>
cd Bosch-Smart-Home/bridge
```

Python 3.9 oder neuer muss vorhanden sein (`python3 --version`). Es sind **keine**
`pip`-Pakete nötig.

---

## 2. Erst mal ausprobieren (Demo)

```bash
python3 shc_bridge.py serve --demo
```

Die Ausgabe zeigt zwei Adressen, z. B.:

```
Open on your iPhone:   http://192.168.1.42:8090/
```

Diese Adresse am iPhone (gleiches WLAN) im Safari öffnen. Du siehst jetzt die
komplette App mit realistischen Demo-Daten. Zum Beenden `Strg+C`.

---

## 3. Mit dem echten Controller koppeln

> **Am einfachsten – alles in der App:** Starte die Bridge ohne Argumente
> (`python3 shc_bridge.py serve`) und öffne die Seite am iPhone. Im Tab
> **Setup** kannst du dann:
> 1. **„Controller automatisch finden"** tippen – die Bridge durchsucht dein
>    Netzwerk nach dem Controller und trägt die IP automatisch ein.
> 2. **Systempasswort** eingeben, kurz den **Knopf am Controller II** drücken,
>    **„Jetzt koppeln"** tippen – fertig, die App schaltet automatisch auf Live.
>
> Die folgenden Schritte 3.1–3.4 beschreiben denselben Vorgang über die
> Kommandozeile (falls du das lieber magst oder die App-Kopplung nicht klappt).

### 3.1 IP-Adresse und Systempasswort

* **IP des Controllers:** in der Bosch-Smart-Home-App unter
  *Einstellungen → System → Smart Home Controller*, oder im Router.
* **Systempasswort:** das Passwort, das du bei der **Ersteinrichtung** des
  Controllers vergeben hast (nicht das App-/Konto-Passwort). Falls unbekannt,
  lässt es sich in der Bosch-App neu setzen.

### 3.2 Konfiguration anlegen

```bash
cp config.example.json config.json
```

`config.json` öffnen und eintragen:

```json
{
  "shc_ip": "192.168.1.50",
  "system_password": "DEIN-SYSTEMPASSWORT",
  "poll_interval": 30,
  "price_per_kwh": 0.35,
  "currency": "€",
  "device_filter": []
}
```

* `poll_interval` – Abstand der Messungen in Sekunden (30 ist gut).
* `price_per_kwh` – dein Arbeitspreis, für die Kosten-/Jahresrechnung.
* `device_filter` – leer lassen = **alle** Geräte mit Leistungsmessung. Willst du
  nur bestimmte, trage Namensteile ein, z. B. `["Rollladen", "Licht"]`.

> Diese Datei enthält dein Passwort und wird durch `.gitignore` nicht eingecheckt.

### 3.3 Client-Zertifikat koppeln

```bash
python3 shc_bridge.py pair
```

Ablauf:

1. Das Skript erzeugt einmalig ein Client-Zertifikat (`openssl` wird benötigt).
2. Es fordert dich auf, den Controller in den **Kopplungsmodus** zu bringen:
   * **Smart Home Controller II** (deine Zentrale): **kurz** auf den Knopf an der
     Vorderseite drücken.
   * Original-Controller (Gen 1): Knopf **drücken und halten, bis die LED blinkt**.
3. Direkt danach im Terminal **Enter** drücken.
4. Bei Erfolg erscheint `success! Client registered.`

Häufige Meldungen:

| Meldung | Bedeutung |
|---|---|
| `HTTP 401 – wrong system password` | Falsches Systempasswort in `config.json`. |
| `registration failed (HTTP 4xx)` | LED blinkte nicht / Kopplung nicht gestartet. Nochmal probieren. |
| `could not run openssl` | `openssl` installieren (z. B. `sudo apt install openssl`). |

### 3.4 Live starten

```bash
python3 shc_bridge.py serve
```

Adresse am iPhone öffnen – jetzt siehst du **deine echten Daten**. Die Historie
für Tages-/Wochenprofile und die Jahres-Prognose baut sich über die Laufzeit auf
(je länger die Bridge läuft, desto genauer). Lass sie darum dauerhaft laufen.

---

## 4. Auf dem iPhone als App speichern

1. In Safari die Bridge-Adresse öffnen.
2. **Teilen-Symbol** (Quadrat mit Pfeil) tippen.
3. **„Zum Home-Bildschirm"** wählen → *Hinzufügen*.

Jetzt hast du ein App-Icon „Strom" – Vollbild, ohne Browserleiste.

Falls die App mal eine andere Bridge-Adresse braucht: in der App unten auf
**Setup** und die Adresse dort eintragen.

---

## 5. Bridge dauerhaft laufen lassen (optional)

**systemd (Linux / Raspberry Pi):** `/etc/systemd/system/bosch-strom.service`

```ini
[Unit]
Description=Bosch Home Strom Bridge
After=network-online.target

[Service]
WorkingDirectory=/pfad/zu/Bosch-Smart-Home/bridge
ExecStart=/usr/bin/python3 shc_bridge.py serve
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now bosch-strom
```

**Alternativ:** ein `tmux`/`screen`-Fenster oder `nohup python3 shc_bridge.py serve &`.

---

## 6. Wie die Auswertungen entstehen

* **Live-Leistung:** direkt aus dem `PowerMeter`-Feld `powerConsumption` (W).
* **Verbrauch (kWh):** aus dem Energiezähler `energyConsumption` (Wh) – die
  Differenz je Tag ergibt den Tagesverbrauch (Fallback: Leistung über Zeit
  integriert, falls der Zähler mal steht).
* **Grundlast/Standby:** unteres 10-%-Perzentil aller Leistungswerte.
* **Abwesenheit:** Ein Tag gilt als „vermutlich abwesend", wenn der *aktive*
  Verbrauch (über der Grundlast) deutlich unter dem Median liegt – Licht/Rollladen
  wurden also kaum bedient. Das ist eine **Schätzung** rein aus diesen Sensoren.
* **Jahres-Prognose:** Ø-Tagesverbrauch × 365. Saisonale Schwankungen (mehr Licht
  im Winter) sind darin noch nicht enthalten – der Wert wird über die Zeit besser.
* **Sofort-Schätzung aus dem Zählerstand:** Die Module führen einen kumulativen
  Energiezähler seit ihrer Installation (`energyConsumptionStartDate`). Daraus
  rechnet die App schon ab der ersten Messung einen Ø/Tag und eine grobe
  Jahresprognose – noch bevor eigene Historie da ist. Die echte Tageskurve und
  das Profil entstehen dann über die Laufzeit.

---

## 7. Fehlerbehebung

| Problem | Lösung |
|---|---|
| iPhone zeigt „Offline / Demo" | Bridge läuft nicht, falsche Adresse, oder iPhone in anderem WLAN. Adresse in **Setup** prüfen. |
| Keine Geräte / 0 W | Deine Module haben evtl. keine Leistungsmessung, oder `device_filter` ist zu streng. Filter leeren. |
| `last_error` in **Setup → Diagnose** | Zeigt den letzten Abruf-Fehler (z. B. Zertifikat abgelaufen → neu `pair`en). |
| Wenig Historie | Normal am Anfang – die Bridge sammelt ab dem ersten Start. Einfach laufen lassen. |
