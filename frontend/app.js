/* Bosch Energie — iPhone web app.
 * Energy-management view over the local bridge (bridge/shc_bridge.py):
 * Smart Home (Licht-/Rollladensteuerung II) + Bosch heat pump (HomeCom Easy),
 * combined. If no bridge is reachable it falls back to a built-in demo. */
'use strict';

const LS = { base: 'bhe_base', price: 'bhe_price', demo: 'bhe_demo', house: 'bhe_house_kwh' };
const PV_LS = { kwp: 'bhe_pv_kwp', orient: 'bhe_pv_orient', batt: 'bhe_pv_batt',
  feedin: 'bhe_pv_feedin', invest: 'bhe_pv_invest', evkm: 'bhe_pv_evkm', evkwh: 'bhe_pv_evkwh', ac: 'bhe_pv_ac',
  v2h: 'bhe_pv_v2h', v2hkwh: 'bhe_pv_v2hkwh', v2hprice: 'bhe_pv_v2hprice', v2hhome: 'bhe_pv_v2hhome',
  lat: 'bhe_pv_lat', lon: 'bhe_pv_lon', tilt: 'bhe_pv_tilt', az: 'bhe_pv_az', pgm: 'bhe_pv_pvgis_monthly',
  cap60: 'bhe_pv_cap60' };
const TAR_LS = { hhbase: 'bhe_tar_hhbase', wp: 'bhe_tar_wp', wpct: 'bhe_tar_wpct',
  wpbase: 'bhe_tar_wpbase', meter2: 'bhe_tar_meter2', spotbase: 'bhe_tar_spotbase' };
const FIN_LS = { invest: 'bhe_fin_invest', rate: 'bhe_fin_rate', years: 'bhe_fin_years', infl: 'bhe_fin_infl' };
const EV_LS = { l100: 'bhe_ev_l100', fuelp: 'bhe_ev_fuelp', chargep: 'bhe_ev_chargep',
  tax: 'bhe_ev_tax', thg: 'bhe_ev_thg', maint: 'bhe_ev_maint', incl: 'bhe_ev_incl' };
// DIY vs. professional PV install cost comparison (Selbstbau vs. Fachfirma)
const PCOST_LS = { diySet: 'bhe_pc_diy_set', proOffer: 'bhe_pc_pro_offer',
  foerder: 'bhe_pc_foerder', diyHours: 'bhe_pc_diy_hours' };
// Annual mobility benefit of driving electric vs. a comparable combustion car:
// fuel saved (petrol cost − charging cost), plus Kfz-Steuer, THG-Quote, lower
// maintenance. Fahrleistung/Verbrauch reuse the PV-planner EV inputs.
function evBenefit() {
  const g = (k, d) => { const v = parseFloat(localStorage.getItem(k)); return isFinite(v) ? v : d; };
  const km = g(PV_LS.evkm, 0), per100 = g(PV_LS.evkwh, 18);
  const l100 = g(EV_LS.l100, 7), fuelp = g(EV_LS.fuelp, 1.80);
  const chargep = g(EV_LS.chargep, STATE.price || 0.30);
  const tax = g(EV_LS.tax, 120), thg = g(EV_LS.thg, 60), maint = g(EV_LS.maint, 200);
  const evKwh = km * per100 / 100;
  const evEnergyCost = evKwh * chargep;
  const fuelCost = km / 100 * l100 * fuelp;
  const tankSave = Math.max(0, fuelCost - evEnergyCost);
  const total = tankSave + tax + thg + maint;
  const include = (localStorage.getItem(EV_LS.incl) ?? '1') === '1';
  return { km, per100, evKwh, evEnergyCost, fuelCost, tankSave, tax, thg, maint, total, include };
}
// How much of the car's annual charging PV covers directly (extra self-consumption
// the car adds), so the user sees that in sunny months little/no grid power is
// bought for it. Informational only – the € value already lives in the PV savings.
function evPvCoverage() {
  try {
    const p = pvInputs();
    if (!(p.kwp > 0) || !(p.evAnnual > 0)) return null;
    const rWith = simulatePv(p);
    const rNo = simulatePv({ ...p, evAnnual: 0 });
    const pvToEv = Math.max(0, rWith.self_kwh - rNo.self_kwh);   // PV kWh now used by the car
    const share = Math.min(1, pvToEv / p.evAnnual);
    return { evKwh: p.evAnnual, pvToEv, share,
      pvValue: pvToEv * Math.max(0, STATE.price - p.feedin) };   // saving vs. feeding it in
  } catch (e) { return null; }
}
function tariffData() {
  const g = (k, d) => { const v = parseFloat(localStorage.getItem(k)); return isFinite(v) ? v : d; };
  let wp = false; try { wp = localStorage.getItem(TAR_LS.wp) === '1'; } catch (e) {}
  return {
    hhPrice: STATE.price,                                  // €/kWh household
    hhBase: g(TAR_LS.hhbase, 0),                           // €/year
    wp, wpPrice: g(TAR_LS.wpct, Math.max(0.1, STATE.price - 0.05)),
    wpBase: g(TAR_LS.wpbase, 0), meter2: g(TAR_LS.meter2, 0),
    spotBase: g(TAR_LS.spotbase, 0),
  };
}
// Fraction of each hour the car is typically home (can charge/discharge for
// the house). Depends on the household: a home-office/family car sits at home
// most of the day (soaks midday PV), a commuter's car is gone 8–16.
const V2H_PROFILES = {
  home:     [1,1,1,1,1,1,1, .9,.75,.85,.9,.9, .8,.75,.85,.9,.9, 1,1,1,1,1,1,1],
  mixed:    [1,1,1,1,1,1,1, .7,.45,.4,.5,.5, .45,.4,.5,.6,.7, 1,1,1,1,1,1,1],
  commuter: [1,1,1,1,1,1,1,1, 0,0,0,0,0,0,0,0,0, 1,1,1,1,1,1,1],
};
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
// Central category palette – the single source of truth for chart colours, so
// each category has exactly ONE colour everywhere (Übersicht, Verlauf, PV, …).
// Hues are chosen to be well separated and high-contrast on the dark theme.
const COL = {
  sh: '#4da3ff',    // Hausstrom / Smart Home – blau
  hp: '#ef6c4d',    // Wärmepumpe (Strom) – rot-orange
  heat: '#f6b93b',  // Wärme erzeugt / PV-Einspeisung – bernstein
  ev: '#e26fb0',    // E-Auto – pink
  ac: '#38bdd8',    // Klima – türkis
  pv: '#4be0b0',    // PV direkt genutzt – grün
  batt: '#a970ff',  // Batterie – violett
  away: '#ff6b8a',  // Abwesenheit – rosa-rot
};
// Fallback names for chart series keys, used by the tap/hover readout when a
// series carries no explicit label (keeps tooltips from showing "undefined").
const SERIES_LABEL = {
  sh: 'Hausstrom', hp: 'Wärmepumpe', heat: 'Wärme', e: 'Strom', h: 'Wärme',
  pv: 'PV', ev: 'E-Auto', ac: 'Klima', batt: 'Batterie', away: 'Abwesenheit',
  hp_heating: 'WP Heizen', hp_water: 'WP Warmwasser', hp_other: 'WP sonstiges', heatpump: 'Wärmepumpe',
  hp_gap: 'WP Betriebsart unbekannt',
};
const HP_MODE = { dhw: 'Warmwasser', ch: 'Heizung', cooling: 'Kühlen',
  frost: 'Frostschutz', off: 'Bereitschaft', '': 'Bereitschaft' };
const APP_BUILD = 'v205';   // short tag shown always-on in the header
const APP_VERSION = 'v205 · 2026-11-19 · Profil → „Lastspitzen & Dimensionierung“ mit dem Smart Meter: statt der Summe der einzeln gemessenen Steckdosen + Wärmepumpe (und einer Schätzung für den Rest) rechnet die Karte mit dem gemessenen Verbrauch des ganzen Hauses – Lastdauerlinie und Kennwerte aus den Minutenmitteln, die Spitzen aus den 15-s-Abfragen (die Bridge speichert dafür je Minute den höchsten Wert von Verbrauch und Netzbezug). Neu: höchster Netzbezug, höchste Batterie-Abgabe und bei jeder Top-Spitze, wie viel aus Netz, Batterie und Sonne kam. Aufschlüsselung je Gerät und Verbrauch je Stunde zeigen den Rest als gemessene Differenz statt Schätzung. Stufen bis 15 kW für den ganzen Haushalt. ' +
  'v204 · 2026-11-19 · Wohn-Dashboard: neue Kachel „Heute“ mit Autarkie-Ring (Anteil des Verbrauchs, der nicht aus dem Netz kam; daneben gestern zum Vergleich) und den Tageswerten Sonne (mit „selbst genutzt“), verbraucht (mit Wärmepumpe und deren Sonnenanteil), aus dem Netz/eingespeist, gespart, Batterie (jetzt und heute min–max) und vermiedenes CO₂; darunter 7 Tage, Monat, seit Anschluss und der beste Sonnentag. Auf breiten Bildschirmen (iPad quer) steht sie neben dem Energiefluss. Die Geldbilanz steht jetzt dort statt im Banner – das Banner erscheint nur noch, wenn es etwas zu tun gibt. IP-Adressen im Heimnetz sind verdeckt, bis man „anzeigen“ antippt (PV-Gerätekarte, Setup, Fehlermeldungen, Eingabefelder; der Rohdaten-Text lässt die Adresse weg). ' +
  'v203 · 2026-11-19 · PV geprüft und erweitert: Neue Karte „🧵 String-Vergleich“ im Tab PV – beide Strings jetzt (Leistung, Spannung, Strom, Anteil), heute als Kurven (umschaltbar auf je kWp), Tages-/Monatswerte, Tabelle mit kWh je kWp, Spitze, „erzeugt im Mittel um“ (Ost früher, West später) und Spannung im Betrieb, dazu eine Bewertung: String liefert nichts, Summe = PV, gleiche Tageszeit/Ausrichtung, Vergleich je kWp, Trend des Verhältnisses, Spannungssprung (Modul/Bypass-Diode). Name, Module, kWp und Ausrichtung je String lassen sich eintragen; sonst schätzt die App die kWp aus den Spannungen. Neue Karte „🔎 Plausibilitätsprüfung“: Datenlage, Strings = PV, Energiebilanz mit Umwandlungsverlusten, Zählerstände gegen Messwerte, Batterie-Wirkungsgrad, Zähler des Wechselrichters (E-Total), Spitzenleistung. Behoben: Strings werden nach Tracker-Nummer gespeichert (ein leerer Platz verschiebt MPP 2 nicht mehr auf MPP 1), die String-Spannungen werden mitgespeichert; die Monatserwartung zählt einen angefangenen Tag nur mit den erfassten Sonnenstunden (und nutzt die Ausrichtung der Strings, wenn eingetragen); „Woher kam dein Strom?“ zeigt Netzbezug für die Batterie nicht mehr als Hausverbrauch; die erste Viertelstunde nach dem Verbinden fehlte bei Zeiträumen über 31 Tage im Zählerstand. ' +
  'v202 · 2026-11-19 · HomeCom-/AEG-Anmeldung geht nicht mehr verloren: Ursache war eine zweite Bridge (z. B. update-macos.command, während die alte noch lief) – sie erneuerte den einmal gültigen Bosch-Token und beendete sich erst danach; die alte arbeitete mit dem verbrauchten Token weiter, Bosch sperrte die Anmeldung. Jetzt: nur eine Bridge pro Konfiguration (die zweite beendet sich vorher mit Hinweis), Port zuerst belegen, Start-/Update-Skripte beenden die alte Bridge sauber, beim Beenden und beim Neustart nach Updates wird eine laufende Token-Erneuerung abgewartet, config.json wird atomar geschrieben, der Demo-Modus fasst echte Zugänge nicht an. Einmal im Setup neu verbinden. ' +
  'v201 · 2026-11-18 · Stundenplan im Wohn-Dashboard: Setup → „🎒 Stundenplan“ (eine Zeile je Stunde: Zeit | Mo | Di | Mi | Do | Fr, „-“ = frei, mit Vorschau). Das Dashboard zeigt den heutigen bzw. nächsten Schultag mit laufender Stunde und Schulschluss; Hinweise „Morgen Sport – Sportsachen einpacken“ (ab 16 Uhr), „Heute Sport“ am Morgen und „Schule aus um …“ 30 Minuten vorher. Feiertage in NRW werden erkannt, Ferien über einen ganztägigen Kalendertermin mit „Ferien“/„schulfrei“. Der Plan liegt wie die übrigen Einstellungen in der Bridge. ' +
  'v200 · 2026-11-18 · Setup → „🖥️ Wohn-Dashboard“: einstellbar, ab wie vielen Sekunden der Fenster-Hinweis blinkt (Standard 600 s = 10 min, zum Testen z. B. 1 s) und wie viele Abende vorher der Tonnen-Hinweis erscheint (Standard 1; bei 2 z. B. „Übermorgen: Papiertonne“ ab 16 Uhr). Gilt für alle Geräte – ein laufendes Dashboard übernimmt die Werte innerhalb einer Minute. Bei offenem Fenster schaut das Dashboard alle 20 s nach (sonst jede Minute); kurze Zeiten stehen als Sekunden da. ' +
  'v199 · 2026-11-18 · Müllabfuhr der AWB Köln: Setup → „🗑️ Müllabfuhr (AWB Köln)“ → Straße und Hausnummer suchen, Adresse antippen. Die Abfuhrtermine (Rest-, Bio-, Papier-, Wertstofftonne …) erscheinen im Wohn-Dashboard bei den Terminen und als Hinweis am Vorabend ab 16 Uhr bzw. am Morgen („Morgen: Biotonne + Papiertonne“). Die Adresse bleibt lokal in der Bridge. AWB hat dafür keine offizielle Schnittstelle – die App nutzt dieselbe Abfrage wie der Abfuhrkalender auf awbkoeln.de. ' +
  'v198 · 2026-11-18 · Wohn-Dashboard: Das Banner zeigt nur noch, was etwas bringt – PV-Überschuss jetzt nutzen, Börse günstig oder teuer. Sonst die Geldbilanz der PV-Anlage: heute durch Eigenverbrauch gespart + Einspeisevergütung, diesen Monat und seit dem Anschluss. „Strompreis mittel“ und „Kein Börsentarif aktiv“ entfallen. Dieselben Summen (gespart diesen Monat / seit Anschluss) stehen auch in der Übersicht und im Tab PV. ' +
  'v197 · 2026-11-18 · Wohn-Dashboard (#dash): standardmäßig dunkel, die Wahl Hell/Dunkel bleibt auf dem Gerät gespeichert. Oben Hinweis-Kacheln: Fenster/Tür offen (ab 10 Minuten blinkend, rot bei Heizbetrieb, Kälte oder Abwesenheit), lüften, Raum zu kalt, Termin in der nächsten Stunde, Mülltonne am Vorabend, Batterie lädt aus dem Netz, PV-Anlage oder Wärmepumpe ohne aktuelle Werte, sehr hoher Verbrauch. Die größten Verbraucher hängen jetzt als Linien am Haus in der Energiefluss-Grafik (Wärmepumpe, Geräte, nicht einzeln gemessener Rest) statt in einer Liste. Neu: Kalender (iCloud-Freigabe, Google, .ics) mit Terminen heute, morgen und der nächsten Tage – Adresse im Setup, sie bleibt nur lokal in der Bridge. ' +
  'v196 · 2026-11-18 · Übersicht mit dem Smart Meter: „Gerade jetzt“ zeigt den gemessenen Hausverbrauch statt der Summe der einzeln gemessenen Geräte. „Noch nicht gemessen“ rechnet live Haus − Wärmepumpe − Geräte (alle 10 s neu) und die Tagesbilanz aus vollständig gemessenen Smart-Meter-Tagen statt aus den Zählerablesungen (die bleiben, bis es einen solchen Tag gibt). Ist der Tag lückenlos gemessen, zeigt „Heute bisher verbraucht“ den Smart-Meter-Wert und „Wofür heute“ den Rest als „Nicht einzeln gemessen“. ' +
  'v195 · 2026-11-18 · PV-Anlage mit echten Daten (Fronius GEN24, Reserva, Smart Meter TS 65A-3) abgeglichen: Lädt die Batterie aus dem Netz (z. B. „charge boost“ bei sehr niedrigem Ladestand), zeigt der Energiefluss einen Bogen Netz → Batterie, ein Hinweis erklärt es, und die Tageswerte zählen „Batterie aus dem Netz geladen“ extra – dieser Strom zählt nicht mehr als Sonnenstrom. Gibt die Batterie ins Netz ab, wird das ebenfalls gezeigt (und nicht als Sonnen-Überschuss empfohlen). Details: leere String-Plätze ausgeblendet, Smart Meter je Phase mit Leistung, Strom, Spannung und cos φ, Batterie mit Spannung/Strom und Modus. Wohn-Dashboard (#dash): Energiefluss, Empfehlung und Verbraucherliste mit den gemessenen Werten des Wechselrichters (alle 10 s) statt der Schätzung; antwortet er nicht, steht das dabei. Behoben: Bei Zeiträumen über 31 Tage zählte die allererste Viertelstunde nach dem Verbinden nur eine Minute. ' +
  'v194 · 2026-11-18 · Wärmepumpe: Strom aus einer Datenlücke (Bridge oder Bosch-Cloud länger als 30 Minuten nicht erreichbar) wird nicht mehr der Betriebsart am Rand der Lücke zugeschlagen – vorher landete z. B. nach einer abgelaufenen Anmeldung der ganze Verbrauch der Lücke im Warmwasser. Er zählt weiter zum Tagesverbrauch, steht in „Wofür heute“ und im Betriebsarten-Ring aber als „Betriebsart unbekannt (Datenlücke)“. Stundenreihe und Tagesablauf lassen die Lücke leer statt sie als Pause oder als eine einzige Riesen-Stunde zu zeigen. PV-Anlage: Ist die Solar API am Wechselrichter noch aus, zeigt die App die Schritte zum Einschalten mit Link zur Weboberfläche, Anmeldung als „Customer“ und was bei vergessenem Passwort hilft. ' +
  'v193 · 2026-11-18 · Wärmepumpe: Ist die HomeCom-Anmeldung abgelaufen oder die Bosch-Cloud nicht erreichbar, speichert die Bridge keine leeren Messungen mehr, sondern meldet den Grund – die Wärmepumpen-Karte zeigt ihn mit Link zum neuen Verbindungstest (Setup → Wärmepumpe → „Verbindung zur Bosch-Cloud testen“: DNS, Verbindung, Verschlüsselung, Anmeldung, Datenabruf; Ergebnis kopierbar; im Terminal: python3 shc_bridge.py diag). Nach einem Fehler versucht die Bridge es nach 1, 2, 4 Minuten erneut. Die Volumenstrom-Suche fragt schonender ab und bricht bei Verbindungsproblemen sofort ab. Keine Tracebacks mehr im Terminal, wenn ein Browser eine Verbindung schließt. Startskripte nutzen ein aktuelles Python (python.org/Homebrew, TLS 1.3), falls installiert. ' +
  'v192 · 2026-11-18 · PV-Anlage (Fronius): Die Bridge liest den Wechselrichter direkt im Heimnetz über die Solar API (nur lesend, ohne Cloud) – Setup mit Suche im Netz, Verbinden und Rohdaten-Diagnose. Neu: Energiefluss jetzt (Sonne, Haus, Batterie, Netz, Wärmepumpe) in der Übersicht; im Tab PV „Deine PV-Anlage“ mit Tageswerten, Tagesverlauf, Verlauf über 7/30/90 Tage oder ein Jahr, Monatswerten mit Erwartung aus Planer/PVGIS sowie Wechselrichter, Strings, Batterie und Smart Meter; in der Wärmepumpen-Karte der Sonnenstrom-Anteil. Netzbezug und Einspeisung kommen aus den Zählerständen des Smart Meters, mit Prüfung auf Lücken und Zählersprünge. Im Demo-Modus eine simulierte Anlage. Außerdem behoben: Tibber-Token, Home-Assistant-Zugang und die Zuordnung Fensterkontakt → Raum gingen bei jedem Neustart der Bridge verloren. ' +
  'v191 · 2026-11-16 · Volumenstrom in der Live-Karte immer sichtbar: mit Wert (gelesen/abgeleitet) oder mit dem Grund, warum es noch keinen gibt (z. B. kein Rücklauf gemeldet, kein Heizbetrieb erkannt, Läufe zu kurz, Spreizung zu klein). Neben Vor-/Rücklauf steht jetzt die Spreizung. Abgeleiteter Volumenstrom genauer: Abtau-Abschnitte zählen weder bei der Wärme noch bei der Zeit (vorher zu niedrig, z. B. 15,9 statt 17,2 l/min). ' +
  'v190 · 2026-11-16 · Volumenstrom der Wärmepumpe: Die Bridge durchsucht einmal (dann wöchentlich) alle Werte, die die Wärmepumpe über HomeCom meldet, nach einem Volumenstrom und schreibt ihn mit („gelesen“). Meldet sie keinen, wird er aus Wärmemenge ÷ Spreizung je Heizlauf berechnet („abgeleitet“) – auch mit grobem 1-kWh-Wärmezähler über viele Läufe genau. Anzeige in der Live-Karte und im Abgleich: Volumenstrom gegen die Summe der Ziel-Durchflüsse aller Kreise; liefert die Pumpe weniger, steht je Kreis der erreichbare Wert, und dein Tacosetter-Wert wird damit verglichen. Unter „Datenlage“: Quelle, Suchergebnis, die letzten Heizläufe und ein Knopf für eine neue Suche. ' +
  'v189 · 2026-11-16 · App startet schneller: Die Bridge rechnet abgeschlossene Tage nur noch einmal (vorberechnete Tageswerte statt Rohdaten), alles Nötige für den Start kommt in EINER Anfrage, die schon beim Laden der Seite losgeht. Beim Wiederaufruf steht sofort der letzte bekannte Stand da („Stand hh:mm · wird aktualisiert …“) und wird ersetzt, sobald die frischen Zahlen da sind; ist die Bridge nicht erreichbar, bleibt der letzte echte Stand stehen statt Demo-Zahlen. Gerendert wird nur der sichtbare Tab, die anderen beim Öffnen. Übertragung komprimiert, App-Code wird im Browser zwischengespeichert. Neu im Setup: „Startzeit“ – was der Start gekostet hat, im Browser und auf der Bridge, mit Knopf zum kalten Nachrechnen. Einstellungen, die direkt vor dem Neuladen geändert wurden, gehen nicht mehr verloren. ' +
  'v188 · 2026-11-15 · Abgleich-Tab neu aufgebaut: aus zehn Karten wurden fünf. Eine Statuskarte mit dem EINEN nächsten Schritt, EINE Raumliste (Versorgung gemessen · Ziel-Durchfluss je Kreis · dein Ist-Wert · Details zum Aufklappen), Schritt-Protokoll, Datenlage und Verteiler-Einrichtung (eingeklappt). Datenfehler behoben: Phantom-Räume „hz_1 …“ verschwinden (Ursache behoben), nur noch ein ΔT und damit EIN l/min-Wert je Kreis, Räume werden gegen ihre Wunschtemperatur bzw. den Hausschnitt beurteilt statt gegen den hochgedrehten Thermostat. Neu „Betrieb – gelesen & gemessen“: Betriebsart der Wärmepumpe (HomeCom), Modus der Thermostate und ob nachts wirklich abgesenkt wurde – ohne Annahmen. Warmwasser-Karte erkennt Ladeketten (gleich lange Ladungen, die sofort neu starten) und protokolliert ab jetzt die Speichertemperatur. ' +
  'v187 · 2026-11-09 · „Warmwasser kostet Komfort" korrigiert: KEINE Annahme mehr über eine Nachtabsenkung (die war falsch). Der echte Grund für „nicht erreicht" ist jetzt gemessen – die WW-Phasen sitzen dicht hintereinander: nach einer Phase bleibt oft nur wenig Heizzeit, bevor die nächste kommt. Phasen heißen jetzt kaum Abkühlung / wieder warm / danach nur X min Heizen / noch nicht zurück, plus Median-Heizzeit zwischen den Phasen. ' +
  'v186 · „Warmwasser kostet Komfort" ehrlicher: ein −0,0 °C-Dip wird nicht mehr als „nicht erreicht" gewertet; jede WW-Phase wird eingeordnet. ' +
  'v185 · Tagesverlauf lesbarer: Zeitachse zoombar (Auto / 1h / 2h / 4h / 8h / 16h / Tag; Auto passt sich an die vorhandenen Daten an, damit ein kurzer Betrieb nicht in 24 h zerquetscht wird). Raumtemperatur-Linien werden jetzt verbunden (die Thermostate messen punktuell/selten – kleine Lücken werden interpoliert, große bleiben offen). Achse re-bucketet beim Zoomen für volle Auflösung. ' +
  'v184 · Fix ‹ ›-Tagesnavigation + Wärme-Tab lädt nur den aktiven Unter-Tab. Performance: der Wärme-Tab lädt jetzt nur noch die Karten des aktiven Unter-Tabs (Heizung/Abgleich/Effizienz/Einstellung) statt beim Öffnen ~20 API-Abfragen gleichzeitig zu starten; die übrigen laden erst beim Wechsel auf ihren Unter-Tab. Der Tagesverlauf lädt immer nur EINEN Tag, der Takt-Trend erst beim Öffnen von „Effizienz". ' +
  'v183 · „Tagesverlauf Wärmepumpe" kombiniert jetzt die Raumtemperaturen: je Raum ein-/ausschaltbar werden die Innentemperaturen (Bosch-Thermostate) auf dieselbe Zeitachse wie WP-Zustände, Leistung und Modulation gelegt – so siehst du chronologisch, wie jeder Raum auf Heizen/Pause/Warmwasser reagiert (eigener, enger Temperaturbereich, Werte auch im Tooltip). ' +
  'v182 · Zwei neue WP-Karten: „Tagesvergleich" (zwei Tage A/B nebeneinander mit Kennzahl-Differenzen + beiden Zustandsbändern, grün = besser) und „Takt-Trend" (Verdichter-Takte/Tag + Min/Takt über Wochen, mit optionaler Abgleich-Marke und Vorher/Nachher-Schnitt). Backend-Refactor: gemeinsame Tages-Kennzahlen inkl. Min/Takt und Ø Außentemperatur. ' +
  'v181 · Neu (Wärmepumpe → Heizung): „Tagesverlauf Wärmepumpe" – ein chronologisches Zeitachsen-Diagramm eines Tages mit Zustandsband (Heizung/Warmwasser/Abtauen/Kühlen/Pause) + Zuheizer-Spur, Strom & Wärme (kW), Modulation %, COP und Vor-/Rücklauf/Außen-Temperaturen (alle ein-/ausblendbar), Tages-Kennzahlen (Takte, Pausen, Abtauzyklen, Zuheizer-Zeit, Ø Modulation), Ereignis-Verlauf und Tag-für-Tag-Blättern. Ideal, um die Wirkung des hydraulischen Abgleichs zu sehen. Abtauen/Zuheizer werden aus dem Betrieb erkannt'
const $ = (id) => document.getElementById(id);

// Unregister the service worker, drop all caches, and reload fresh code.
async function hardRefresh() {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) { /* ignore */ }
  location.reload();
}

/* ------------------------------------------------------------------ *
 * Device/browser-independent settings.
 * Every app setting (PV, tariffs, finance, heating layout, …) is mirrored
 * to the BRIDGE so that every device/browser shows the same values. We keep
 * using localStorage as a synchronous local cache, but:
 *   • on startup we pull the bridge's stored settings into localStorage, and
 *   • every write to an app-setting key is pushed back to the bridge.
 * Only the connection/mode keys (bridge URL, demo flag) stay device-local.  */
const SETTINGS_LOCAL_ONLY = new Set(['bhe_base', 'bhe_demo', 'bhe_heat_sub']);
function isAppSettingKey(k) {
  if (typeof k !== 'string') return false;
  if (SETTINGS_LOCAL_ONLY.has(k)) return false;
  return k.startsWith('bhe_') || k === 'heatLayout' || k === 'hc_dev_p20' || k === 'hc_dev_pm10';
}
let _settingsReady = false;
let _lastSynced = {};                 // last snapshot we successfully pushed to the bridge
let _sweepTimer = null;
// Changes this browser sent but the bridge has not confirmed yet (a page closed
// right after a change only gets a fire-and-forget beacon, and the next start
// asks the bridge for its settings at once – that answer can still be the old
// value). On the next start these win over the bridge's copy and are sent again.
// Not a 'bhe_' key, so it is never synced itself.
const UNSENT_KEY = 'settings_unsent';
function _unsentGet() { try { return JSON.parse(localStorage.getItem(UNSENT_KEY) || '{}') || {}; } catch (e) { return {}; } }
function _unsentPut(o) {
  try { if (Object.keys(o).length) localStorage.setItem(UNSENT_KEY, JSON.stringify(o)); else localStorage.removeItem(UNSENT_KEY); } catch (e) {}
}
function _settingsUrl() { return ((typeof STATE !== 'undefined' && STATE.base) || '') + '/api/settings'; }
// Read every app-setting key currently in localStorage.
function _collectAppSettings() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isAppSettingKey(k)) out[k] = localStorage.getItem(k);
    }
  } catch (e) { /* localStorage blocked (private mode) */ }
  return out;
}
// Compare current localStorage against the last-synced snapshot and push only
// the differences to the bridge. This is BROWSER-INDEPENDENT on purpose: it does
// NOT rely on intercepting localStorage.setItem, which silently fails in Safari
// (WebKit treats `localStorage.setItem = …` as storing a key, not overriding the
// method) and was the reason settings saved in Chrome but not in Safari.
function _syncSweep(useBeacon) {
  if (!_settingsReady) return;
  const cur = _collectAppSettings();
  const changed = {};
  for (const k in cur) if (cur[k] !== _lastSynced[k]) changed[k] = cur[k];
  for (const k in _lastSynced) if (!(k in cur)) changed[k] = null;   // deletions
  const keys = Object.keys(changed);
  if (!keys.length) return;
  const prev = Object.assign({}, _lastSynced);
  keys.forEach(k => { if (changed[k] === null) delete _lastSynced[k]; else _lastSynced[k] = changed[k]; });
  _unsentPut(Object.assign(_unsentGet(), changed));
  const confirmed = () => { const u = _unsentGet(); keys.forEach(k => { if (u[k] === changed[k]) delete u[k]; }); _unsentPut(u); };
  const body = JSON.stringify({ settings: changed });
  if (useBeacon) {
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(_settingsUrl(), new Blob([body], { type: 'application/json' }))) return;
    } catch (e) {}
    try { fetch(_settingsUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {}); return; } catch (e) {}
  }
  if (typeof postJSON === 'function') {
    postJSON('/api/settings', { settings: changed })
      .then(r => { if (r && r.ok !== false) confirmed(); })
      .catch(() => { _lastSynced = prev; });  // retry next sweep on failure
  } else {
    _lastSynced = prev;
  }
}
// coalesce rapid writes into one push shortly after typing stops
function _scheduleSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setTimeout(() => { _sweepTimer = null; _syncSweep(false); }, 400);
}
// force an immediate push (use after structural changes like deleting a room,
// so a quick reload can't lose it before the debounce fires)
function _flushSettingsNow() {
  if (_sweepTimer) { clearTimeout(_sweepTimer); _sweepTimer = null; }
  _syncSweep(false);
}
function _beaconFlush() {
  if (_sweepTimer) { clearTimeout(_sweepTimer); _sweepTimer = null; }
  _syncSweep(true);
}
try {
  window.addEventListener('pagehide', _beaconFlush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') _beaconFlush(); });
  // Periodic safety net: guarantees changes reach the bridge within a few seconds
  // in EVERY browser, independent of any localStorage.setItem hook.
  setInterval(() => _syncSweep(false), 3000);
} catch (e) {}
// Best-effort instant trigger where the browser allows overriding the method
// (Chrome/Firefox). In Safari this assignment is a harmless no-op and the
// periodic sweep above does the work instead.
try {
  const _rawSet = localStorage.setItem.bind(localStorage);
  const _rawRemove = localStorage.removeItem.bind(localStorage);
  localStorage.setItem = function (k, v) { _rawSet(k, v); if (_settingsReady && isAppSettingKey(k)) _scheduleSweep(); };
  localStorage.removeItem = function (k) { _rawRemove(k); if (_settingsReady && isAppSettingKey(k)) _scheduleSweep(); };
} catch (e) { /* localStorage may be unavailable (private mode) */ }
// Pull the bridge's settings into localStorage BEFORE the first render. If the
// bridge has none yet, seed it from this device's current settings (migration).
async function syncSettings() {
  try {
    const r = await (typeof api === 'function' ? api('/api/settings') : Promise.resolve(null));
    await applyServerSettings((r && r.settings) || {});
    return;
  } catch (e) { /* offline / demo file:// – fall back to local values */ }
  // Baseline so the first sweep doesn't re-push everything we just pulled/seeded.
  _lastSynced = _collectAppSettings();
  _settingsReady = true;
}
// Take over the bridge's settings (they arrive with the start request, see
// bootApp – no separate round trip). Must run BEFORE init() builds the UI.
async function applyServerSettings(srv) {
  srv = srv || {};
  const unsent = _unsentGet();
  // a local change the bridge already has is confirmed; the others stay local
  for (const k in unsent) {
    const have = Object.prototype.hasOwnProperty.call(srv, k) ? srv[k] : null;
    if (have === unsent[k]) delete unsent[k];
  }
  _unsentPut(unsent);
  if (Object.keys(srv).length) {
    Object.keys(srv).forEach(k => { if (isAppSettingKey(k) && !(k in unsent)) { try { localStorage.setItem(k, srv[k]); } catch (e) {} } });
  } else {
    // migrate: push this device's existing app settings up to the bridge
    const up = _collectAppSettings();
    if (Object.keys(up).length && typeof postJSON === 'function') {
      try { await postJSON('/api/settings', { settings: up }); } catch (e) {}
    }
  }
  // Baseline so the first sweep doesn't re-push everything we just pulled/seeded –
  // except the unconfirmed local changes, which go out again right away.
  _lastSynced = _collectAppSettings();
  for (const k in unsent) {
    if (unsent[k] === null) { if (Object.prototype.hasOwnProperty.call(srv, k)) _lastSynced[k] = srv[k]; }
    else delete _lastSynced[k];
  }
  _settingsReady = true;
  if (Object.keys(unsent).length) setTimeout(() => _syncSweep(false), 0);
}

let STATE = {
  base: localStorage.getItem(LS.base) || '',
  price: parseFloat(localStorage.getItem(LS.price) || '0.35'),
  demo: localStorage.getItem(LS.demo) === '1',
  histSel: '14',
  histDay: null,  // single-day Verlauf: selected day (Date at local midnight)
  ov: null,       // /api/overview (combined)
  hpA: null,      // /api/heatpump/analytics
  data: null,     // /api/analytics (Smart Home, for profile + shares)
  health: null,
  cur: '€',
};

/* ------------------------------------------------------------------ utils */
const fmt = (n, d = 0) => (n == null ? '–' :
  Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
const kwh = (n, d = 1) => fmt(n, d) + ' kWh';
const eur = (n, d = 2) => fmt(n, d) + ' ' + STATE.cur;
function money(n) { if (n == null) return '–'; return (n >= 100 ? fmt(n, 0) : fmt(n, 2)) + ' ' + STATE.cur; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ---- addresses in the home network: hidden until "anzeigen" is tapped ------
   (screenshots get shared). Revealed ones stay visible until the page reloads. */
const _ipShown = new Set();
const IP_RX = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
function ipTag(host) {
  if (!host) return '';
  const h = String(host), on = _ipShown.has(h);
  return `<span class="ipm${on ? ' on' : ''}">${on ? `<b>${esc(h)}</b>` : '<span class="ipdots">•••.•••.•.••</span>'} ` +
    `<a href="#" class="iptog" data-ip="${esc(h)}">${on ? 'verbergen' : 'anzeigen'}</a></span>`;
}
// free text (error messages …): every IPv4 address in it hidden the same way
function escIp(text) {
  const t = String(text == null ? '' : text);
  let out = '', last = 0;
  t.replace(IP_RX, (m, off) => { out += esc(t.slice(last, off)) + ipTag(m); last = off + m.length; return m; });
  return out + esc(t.slice(last));
}
document.addEventListener('click', e => {
  const a = e.target && e.target.closest && e.target.closest('.iptog, .iptog-in');
  if (!a) return;
  e.preventDefault(); e.stopPropagation();
  if (a.classList.contains('iptog-in')) {               // an input field with an address
    const inp = $(a.dataset.for); if (!inp) return;
    const hid = inp.classList.toggle('hid');
    a.textContent = hid ? 'anzeigen' : 'verbergen';
    return;
  }
  const ip = a.dataset.ip;
  if (_ipShown.has(ip)) _ipShown.delete(ip); else _ipShown.add(ip);
  document.querySelectorAll('.iptog').forEach(x => {
    if (x.dataset.ip !== ip) return;
    const w = x.closest('.ipm'); if (w) w.outerHTML = ipTag(ip);
  });
}, true);

/* ---------------------------------------------------------- info tooltips */
const INFO = {
  fronius: () => 'Die Bridge liest den <b>Fronius-Wechselrichter</b> direkt im Heimnetz über dessen <b>Solar API</b> ' +
    '(HTTP/JSON, ohne Konto, ohne Cloud) – <b>nur lesend</b>, es wird nichts verstellt. Alle 15 s holt sie den Energiefluss ' +
    '(PV, Haus, Netz, Batterie), einmal pro Minute dazu Strings, Smart-Meter-Zählerstände und Batterie, und speichert je ' +
    'Minute einen Mittelwert. <b>GEN24:</b> die Solar API ist ab Werk aus – in der Weboberfläche des Wechselrichters ' +
    '(Anmeldung als Benutzer <b>Customer</b>, Passwort vom Installateur) unter <b>Kommunikation → Solar API</b> einschalten. ' +
    'Ohne <b>Smart Meter</b> sieht der Wechselrichter nur die Erzeugung.',
  'pv-flow': () => 'Wer liefert gerade an wen (alle 10 s aktualisiert, solange die Seite offen ist). Die Sonne versorgt zuerst ' +
    'das <b>Haus</b>, mit dem Überschuss lädt die <b>Batterie</b>, der Rest geht ins <b>Netz</b>; was fehlt, kommt aus Batterie ' +
    'oder Netz. Die Wärmepumpe zeigt ihren Strom laut HomeCom (5-Minuten-Mittel). Die Zahlen darunter gelten für <b>heute</b>.',
  'pv-real': () => '<b>Eigenverbrauch</b> = Anteil der PV-Erzeugung, der nicht eingespeist wurde (inkl. Batterieladung). ' +
    '<b>Autarkie</b> = Anteil deines Verbrauchs, der nicht aus dem Netz kam. <b>Gespart</b> = (Verbrauch − Netzbezug) × ' +
    'Strompreis + Einspeisung × Vergütung. <b>WP-Strom von der Sonne</b>: der Wärmepumpe wird je 5 Minuten derselbe ' +
    'Sonnen-/Batterieanteil zugeordnet wie dem ganzen Haus.',
  'pv-hist': () => 'Tageswerte aus den gespeicherten Minutenwerten der Bridge. <b>Bezug und Einspeisung</b> kommen aus den ' +
    'Zählerständen des Smart Meters (exakt), an Tagen mit Datenlücke aus den Messwerten. Die Spalte <b>Erwartung</b> rechnet ' +
    'mit dem Jahresertrag aus dem PV-Planer (bzw. PVGIS) – ein Durchschnittsjahr, das Wetter schwankt um ±15 %.',
  'pv-str': () => 'Jeder <b>String</b> (Modulreihe an einem MPP-Eingang des Wechselrichters) wird einmal pro Minute mit ' +
    'Spannung, Strom und Leistung gespeichert. <b>Je kWp</b> macht unterschiedlich große Strings vergleichbar – die kWp je String ' +
    'kannst du eintragen; sonst schätzt die App sie aus den Spannungen (gleiche Module vorausgesetzt: die Spannung wächst mit der Zahl ' +
    'der Module in Reihe). <b>Erzeugt im Mittel um</b> zeigt die Ausrichtung: Ost liefert früher, West später. Auffällig wird es, ' +
    'wenn ein String plötzlich weniger liefert als sonst im Verhältnis zum anderen (neue Verschattung, Schnee, Defekt) oder seine ' +
    'Spannung im Verhältnis sinkt (ein Modul oder eine Bypass-Diode fällt aus) – das Wetter wirkt auf beide Strings gleich.',
  'pv-chk': () => 'Prüft, ob die gespeicherten Zahlen zueinander passen: <b>Datenlage</b> (Lücken), <b>Strings</b> = PV-Erzeugung, ' +
    '<b>Energiebilanz</b> (Sonne + Batterie + Netz hinein = Haus + Batterie + Netz heraus + Umwandlungsverluste), <b>Zählerstände</b> ' +
    'des Smart Meters gegen die aufsummierten Leistungswerte, <b>Batterie</b> (geladen gegen entladen, um den Ladestand bereinigt), den ' +
    '<b>Zähler des Wechselrichters</b> (E-Total) und die <b>Spitzenleistung</b> gegen die installierte Leistung. Grün = plausibel, ' +
    'blau = Hinweis, gelb = auffällig.',
  'pv-dev': () => 'Was der Wechselrichter über sich meldet: Zustand, installierte PV-Leistung, je <b>String</b> (MPP-Tracker) ' +
    'Spannung, Strom und Leistung, die <b>Batterie</b> und den <b>Smart Meter</b> mit Zählerständen und Phasen. Einmal pro ' +
    'Minute aktualisiert.',
  wofuer: () => 'Aufteilung des heutigen Stroms nach Quelle. Die Wärmepumpe wird nach ' +
    '<b>Heizung</b> und <b>Warmwasser</b> getrennt (aus ihrem Betriebsmodus), dazu jedes Smart-Home-Gerät. ' +
    '<b>Betriebsart unbekannt (Datenlücke)</b>: Strom, den die Wärmepumpe verbraucht hat, während die Bridge sie nicht ' +
    'erreicht hat (Rechner aus/im Ruhezustand, Bosch-Cloud gestört, Anmeldung abgelaufen). Die Menge stimmt – sie ' +
    'kommt aus dem Zähler –, nur wofür sie lief, war in der Zeit nicht zu sehen.',
  roomtemp: () => 'Alle Räume als <b>Balken nebeneinander</b>: Höhe = aktuelle Temperatur, der gestrichelte ' +
    'Strich ist dein <b>Ziel</b> (Wohlfühl-Temperatur). Grün = am Ziel, gelb/rot = noch zu kalt, blau = wärmer als nötig. ' +
    '<b>Ziel des hydraulischen Abgleichs:</b> bei offenen Ventilen soll jeder Raum sein Ziel erreichen. Räume, die trotz ' +
    'offenem Ventil <b>zu kalt</b> bleiben, brauchen mehr Durchfluss (am Verteiler aufdrehen); Räume, die ihr Ziel ' +
    'locker übertreffen, kannst du <b>androsseln</b>, damit mehr für die kalten übrig bleibt. Weil in der Aufdreh-Phase ' +
    'oft alle Sollwerte auf Anschlag (z. B. 30 °C) stehen, trägst du dein echtes Ziel je Raum unten einmal selbst ein – ' +
    'wird lokal gespeichert. Eine feste Uhrzeit, wann es erreicht sein muss, gibt es nicht; der ehrliche Test ist ein ' +
    '<b>kalter Tag</b> – dann zeigt sich, ob die Anlage ausgewogen ist.',
  'spot-worth': () => 'Lohnt sich ein <b>Börsenstrom-Tarif</b> (dynamisch) für <b>dich</b>? Die App nimmt dein ' +
    'gemessenes Verbrauchsprofil und – falls eingetragen – deine <b>PV & Speicher aus dem PV-Tab</b> und rechnet die ' +
    'Jahreskosten einmal mit deinem <b>Festtarif</b> und einmal mit der <b>saisonalen Börsen-Preisform</b> (Stunde × ' +
    'Monat) über die vorhandene Preis-Historie. <b>Wichtig:</b> Mit PV wandert dein Netzbezug in die teuren Abend-/' +
    'Winterstunden – dann lohnt Börse oft <b>nicht</b>, und ein <b>größerer Speicher</b> bringt meist mehr als der ' +
    'Tarifwechsel. Die Lastverschiebung zeigt, was zusätzlich drin wäre, wenn du WP/E-Auto konsequent in die ' +
    'günstigsten Stunden legst. Grobe Realitäts-Schätzung, kein Vertragsangebot.',
  'ov-month': () => 'Hochrechnung für den laufenden Monat: dein durchschnittlicher Tagesverbrauch ' +
    '(Smart Home aus dem Zählerstand, Wärmepumpe aus dem Zählerwachstum) – <b>saisonal</b> für diesen ' +
    'Monat gewichtet und mit deinem kWh-Preis multipliziert.',
  standby: () => 'Zeigt je <b>gemessenem Gerät</b>, wie viel es im <b>Ruhezustand dauerhaft</b> zieht (Standby/Phantomlast) – ' +
    'nur Geräte, die überhaupt einen Standby haben. <b>Woher ich das weiß:</b> Ich nehme das <b>Dauer-Minimum</b> jedes ' +
    'Geräts (das 10-%-Perzentil seiner <b>eigenen</b> Messwerte) – was es fast immer zieht, ist Standby; alles darüber ist ' +
    'echte Nutzung. Ein Licht, das meist aus ist, kommt auf ~0 W (kein Standby); ein Router/TV, der immer ein paar Watt ' +
    'sipt, zeigt genau diesen Sockel. „jetzt Standby/aktiv" vergleicht die aktuelle Leistung mit diesem Sockel. Der ' +
    'Typ-Hinweis (Netzwerk, Unterhaltung …) ist aus dem Namen geraten – hilft beim Einschätzen, ob der Standby ' +
    '<b>abschaltbar</b> ist (TV/Konsole/Ladegerät per Zeitschaltung aus) oder <b>nötig</b> (Kühlung).',
  pvpick: () => 'Vergleicht die von dir hinterlegten <b>Geräte</b> (Wechselrichter, Speicher, All-in-One) und schlägt vor, was zu <b>deinem Haushalt</b> passt. ' +
    'Oben die aus deinem Verbrauch <b>empfohlene Größe</b> (PV-kWp, Speicher-kWh, Wechselrichter-kW). Darunter wählst du deine <b>Prioritäten</b> – jede Priorität gewichtet die Systeme neu. ' +
    'Die <b>Passung in %</b> sagt, wie gut ein System deine aktiven Prioritäten erfüllt; grüne Haken = Stärken, orange ⚠ = Kompromisse. ' +
    'Das <b>Glossar</b> erklärt jeden Fachbegriff für Nicht-Elektriker. <b>Ohne Preise</b> (stehen nicht auf den Datenblättern) und ersetzt keine Elektro-Planung – hol dir für die konkrete Installation 2–3 Angebote.',
  loadpeaks: () => 'Zeigt deine <b>Leistungsspitzen</b> und wie lange sie dauern – für die <b>Dimensionierung</b> (welche Ausgangsleistung eine Anlage/Batterie/ein Wechselrichter braucht). ' +
    'Die <b>Lastdauerlinie</b> sagt, für wie viel <b>% der Zeit</b> die Leistung über einem Wert lag – die roten Linien markieren gängige Größen (800/1200/2000 W). Darunter die <b>Top-10-Spitzen</b> mit Höhe (W), Dauer und Zeitpunkt. ' +
    'So siehst du: die <b>Dauerlast</b> ist meist niedrig, nur kurze Spitzen (Wärmepumpen-Start, Küche) treiben die nötige Leistung hoch – und wie oft/lange die überhaupt vorkommen. ' +
    'Sobald du <b>Zählerstände</b> (Setup) hinterlegst, wird auf den <b>ganzen Haushalt</b> hochgerechnet: der ungemessene Rest wird nach dem Rhythmus deiner Messungen über die Stunden verteilt, dazu gibt es eine <b>Aufschlüsselung je Gerät</b> und den <b>Verbrauch je Stunde</b>. ' +
    '<b>Ehrlich:</b> ohne Zähler zählt nur die Summe der <b>gemessenen</b> Steckdosen + Wärmepumpe (ungemessene Großverbraucher wie Herd/Wasserkocher fehlen dann). ' +
    'Mit einem <b>Smart Meter</b> (PV-Anlage von Fronius) rechnet die Karte mit dem <b>gemessenen Verbrauch des ganzen Hauses</b> – Minutenmittel, Spitzen aus den 15-s-Abfragen – ' +
    'und zeigt bei jeder Spitze, wie viel aus Netz, Batterie und Sonne kam.',
  balkon: () => 'Simuliert ein <b>Balkonkraftwerk/Steckersolar</b> mit <b>800 W</b> Einspeisegrenze (bis dahin darfst du selbst installieren). ' +
    'Du gibst <b>Module (kWp)</b> und <b>Speicher (kWh)</b> ein (z. B. Anker Solarbank). Die Simulation rechnet gegen dein <b>gemessenes Verbrauchsprofil</b>: ' +
    'Tagsüber deckt die PV direkt die Last, der Überschuss <b>über 800 W</b> lädt den Speicher, der ihn abends wieder als ≤800 W abgibt – so werden die ' +
    '<b>Grundlast-Lücken</b> geschlossen. Oben die Kennzahlen (Autarkie, Netz-Gap, Ersparnis), darunter ein <b>Sommer-/Wintertag</b> (PV, Last, Batterie-SOC, Netzbezug) ' +
    'und der <b>Jahresverlauf</b> (selbst gedeckt vs. Netzbezug). So siehst du, ob sich mehr Speicher/Module lohnen, bevor du kaufst.',
  roomsync: () => 'Zeigt je Raum <b>Ist</b>-Temperatur, <b>Soll</b> und <b>Feuchte</b> aus deinen Bosch-Raumthermostaten – und prüft, ob die <b>Wärmepumpe über die HomeCom-API eine gemessene Raumtemperatur entgegennimmt</b>. ' +
    'Bei der Compress 6800i ist das normalerweise <b>nicht</b> vorgesehen: Die WP ist witterungsgeführt und misst die Raumtemperatur über ihre <b>eigene Raumstation</b>, nicht über einen API-Eingang. Schreibbar ist nur der <b>Raum-Soll</b>. ' +
    'Der Energiemanager kann genau diesen Soll als Hebel nutzen (anheben/absenken je nach gemessener Ist-Temperatur). Ob dein konkretes Gerät doch einen Ist-Eingang hat, sagt dir die Prüfung oben.',
  'hp-day': () => 'Ein <b>chronologischer Tagesverlauf</b> deiner Wärmepumpe: oben <b>Strom &amp; Wärme (kW)</b>, darunter optional <b>Modulation %</b>, <b>COP</b> und <b>Vorlauf/Rücklauf/Außen °C</b>, ganz unten ein <b>Zustandsband</b> (Heizung · Warmwasser · Abtauen · Kühlen · Pause) plus eine <b>Zuheizer</b>-Spur. ' +
    'Jede Kennzahl ist <b>ein-/ausblendbar</b>, und du blätterst mit ‹ › durch die <b>Tage</b> (heute, gestern …). Unten der <b>Ereignis-Verlauf</b>: wann welcher Zustand wie lange lief. ' +
    'So siehst du die Wirkung von Einstellungen wie dem <b>hydraulischen Abgleich</b>: läuft die WP jetzt <b>länger und ruhiger durch</b> (wenige Takte) oder <b>taktet</b> sie (viele kurze Pausen)? ' +
    'Über die <b>Räume</b>-Chips legst du einzelne <b>Raumtemperaturen</b> (aus deinen Bosch-Thermostaten) auf dieselbe Zeitachse – so siehst du chronologisch, wie jeder Raum auf Heizen, Pausen und Warmwasser reagiert. ' +
    '<b>Abtauen</b> &amp; <b>Zuheizer</b> werden aus dem Betrieb <b>erkannt</b> (Wärme bricht ein / Leistung über dem Verdichter-Limit), nicht aus einem Gerätesignal.',
  'hp-compare': () => 'Stellt <b>zwei Tage direkt gegenüber</b> – perfekt für „vorher/nachher", z.&nbsp;B. ein Tag vor und einer nach dem <b>hydraulischen Abgleich</b>. ' +
    'Die Tabelle zeigt je Kennzahl Tag A, Tag B und die Differenz; <b>grün</b> markiert eine Verbesserung (weniger <b>Takte</b>, mehr <b>Min/Takt</b> &amp; Laufzeit). Darunter die beiden <b>Zustandsbänder</b> zum direkten Hinsehen. ' +
    '<b>Fair vergleichen:</b> zwei Tage mit ähnlicher <b>Ø Außentemperatur</b> wählen – kältere Tage takten von allein weniger.',
  'hp-trend': () => 'Zeigt über <b>Wochen</b>, wie oft die Wärmepumpe pro Tag <b>taktet</b> (Verdichterstarts, Balken) und wie lang jeder Lauf dauert (<b>Min/Takt</b>, grüne Linie). ' +
    'Ziel nach einem guten Abgleich: <b>weniger Takte, längere Läufe</b>. Trägst du oben dein <b>Abgleich-Datum</b> ein, setze ich eine Marke und rechne den Schnitt <b>vorher vs. nachher</b> aus (Takte, Min/Takt, Laufzeit) – deine Verbesserung in einer Zahl. ' +
    '<span>Weil kältere Tage von allein weniger takten, zeige ich die <b>Ø Außentemperatur</b> mit – am aussagekräftigsten bei ähnlichem Wetter.</span>',
  'dhw-impact': () => 'Die Compress 6800i hat <b>Warmwasser-Vorrang</b>: macht sie Warmwasser, <b>pausiert die Heizung</b> solange. Diese Karte misst, was das für deinen <b>Komfort</b> bedeutet. ' +
    'Dazu wird die <b>Warmwasser-Phase</b> der Wärmepumpe (aus HomeCom) mit der gemessenen <b>Innentemperatur</b> (aus deinen Bosch-Thermostaten) überlagert. Je Phase: ' +
    'wie viel die Innentemperatur vom Wert <b>bei WW-Start</b> bis zum Tiefpunkt <b>fällt</b> – und wie lange es nach dem Heizungs-Neustart dauert, bis dieser <b>Startwert wieder erreicht</b> ist. ' +
    'Die Beispiel-Kurve zeigt eine typische Phase (schattiert = WW-Pause, gestrichelt = Startwert, grün = wieder warm). Darunter die Abhängigkeit von der <b>Außentemperatur</b> und die letzten Phasen. ' +
    '<b>Je kälter draußen, desto größer der Dip.</b> Gegenmittel: WW in Schwachlastzeiten legen, WW-Soll/Hysterese senken oder die Ladedauer begrenzen – dann pausiert die Heizung kürzer.',
  devtl: () => '<b>Zeitstrahl</b> des Stromverbrauchs je <b>gemessenem Gerät</b>: jeder Balken ein Tag, die <b>Höhe</b> die ' +
    'verbrauchten <b>kWh</b>. „Alle Geräte" stapelt die Geräte farbig übereinander (Top 8 + „übrige"), oder wähle ein ' +
    'einzelnes Gerät. Ein Tippen/Überfahren zeigt die <b>Aufschlüsselung je Tag</b>. Datenquelle sind die von den Modulen ' +
    'gemessenen Steckdosen aus der 90-Tage-Analyse – reine Schalter/Kontakte/Thermostate tauchen nicht auf.',
  baseload: () => 'Deine <b>Grundlast</b> ist der Strom, der <b>rund um die Uhr</b> fließt, auch wenn niemand etwas ' +
    'benutzt. Geschätzt aus dem Mittel der <b>drei ruhigsten Stunden</b> deines Tagesprofils, hochgerechnet aufs Jahr. ' +
    'Hohe Grundlast heißt: viele <b>Dauerverbraucher/Standby</b> (Router, Netzteile, alte Kühlgeräte, Pumpen). Schon ' +
    '10 W weniger sparen ~88 kWh im Jahr. Bezieht sich auf die von den Modulen gemessenen Geräte.',
  savings: () => 'Fasst die <b>größten Sparhebel</b> zusammen, die die App aus deinen Daten erkennt – jeweils mit ' +
    'grob geschätztem <b>€/Jahr</b>-Potenzial und sortiert nach Wirkung: Dauerverbraucher/Standby, Elektro-Zuheizer ' +
    'der Wärmepumpe, PV-Anlage, Lastverschiebung in günstige Stunden und die wirkungsvollste Sanierung. Die Zahlen ' +
    'sind Orientierung, keine Zusage – Aufwand und Kosten der Maßnahmen sind sehr unterschiedlich. Details in den Tabs.',
  budget: () => 'Setz dir ein <b>Monatsbudget</b> (in € oder kWh). Die App zeigt, wie viel du <b>bisher</b> diesen ' +
    'Monat verbraucht hast, und rechnet – aus deinem Ø-Tagesverbrauch, saisonal gewichtet – auf das <b>Monatsende</b> ' +
    'hoch. Der weiße Strich markiert die Hochrechnung: liegt er rechts vom Budget, drohst du drüber zu landen, und die ' +
    'App sagt dir, wie viel pro restlichem Tag noch drin ist. Wird lokal gespeichert.',
  fill: () => 'Gemessene Tage werden voll angezeigt. Für Tage <b>ohne</b> Messung (Bridge lief nicht) ' +
    'wird dein bisheriger Verbrauch <b>saisonal</b> hochgerechnet und blass dargestellt. Echte Messungen ' +
    'ersetzen die Schätzung automatisch.',
  forecast: () => 'Jahres-Hochrechnung = Ø-Tagesverbrauch × 365, saisonal verteilt (Wärmepumpe im Winter ' +
    'mehr). Smart Home aus dem kumulativen Zähler, Wärmepumpe aus dem Zählerwachstum seit Messbeginn.',
  cop: () => 'COP / Arbeitszahl = erzeugte <b>Wärme ÷ eingesetzter Strom</b>. 3,0 heißt: aus 1 kWh Strom ' +
    'werden 3 kWh Wärme. Höher = effizienter.',
  coptemp: () => 'COP je 5-°C-Außentemperatur-Bereich (kumulierte Wärme ÷ Strom). Zeigt, wie die Effizienz ' +
    'mit dem Wetter schwankt – wärmere Luft ist meist effizienter.',
  'hp-cal': () => 'Jede Zelle ist ein Tag, eingefärbt nach Stromverbrauch (heller/röter = mehr). Zeigt die ' +
    '<b>Heizsaison</b> auf einen Blick. Quelle: importierte Tagesdaten aus der CSV plus laufendes Polling. ' +
    'Die Wochentag×Stunde-Wärmekarte braucht dagegen <b>Stundendaten</b> (in der CSV nur die letzten Tage).',
  'hp-counter': () => {
    const im = STATE.hpA && STATE.hpA.imported;
    if (im && im.year_elec_kwh) return `Basis: deine <b>importierte HomeCom-Historie</b> ` +
      `(${im.months} Monate, ${im.days} Tage). Jahresverbrauch <b>${kwh(im.year_elec_kwh, 0)}</b>, ` +
      `Jahresarbeitszahl ${fmt(im.seasonal_cop, 2)}. Monatswerte und COP kommen direkt aus der CSV.`;
    const c = STATE.hpA && STATE.hpA.counter;
    if (!c) return 'Prognose der Wärmepumpe aus den gemessenen Betriebsdaten, saisonal aufs Jahr gerechnet. ' +
      'Für <b>tag-genaue</b> Historie kannst du im Setup eine CSV importieren.';
    return `Basis: der kumulative Stromzähler wuchs über <b>${fmt(c.span_days, 0)} Tage</b> um ` +
      `<b>${kwh(c.elec_growth_kwh, 0)}</b> (Ø ${kwh(c.avg_daily_elec_kwh, 1)}/Tag, gemessen im ` +
      `${(c.observed_months || []).join(', ')}). Das wird <b>saisonal</b> aufs Jahr gerechnet. ` +
      `Für exakte Historie: CSV-Import im Setup.`;
  },
  'pv-sim': () => 'Modellierter Sonnenertrag (nach kWp & Ausrichtung) trifft <b>stündlich</b> auf dein ' +
    '<b>echtes</b> Lastprofil (Smart Home + Wärmepumpe + optional E-Auto). Eine Batterie speichert Überschuss. ' +
    'Daraus ergeben sich Eigenverbrauch, Autarkie und Einspeisung.',
  'pv-quote': () => '<b>Autarkie</b> = Anteil deines Verbrauchs, der durch PV (inkl. Batterie) gedeckt wird. ' +
    '<b>Eigenverbrauchsquote</b> = Anteil des erzeugten PV-Stroms, den du selbst nutzt statt einzuspeisen.',
  'pv-econ': () => 'Für jede Anlagengröße (kWp, X) werden die <b>Netto-Stromkosten/Jahr</b> (Y) durchgerechnet: ' +
    'Netzbezug × Preis − Einspeisung × Vergütung. Unter der <b>0-€-Linie</b> verdienst du netto. Marker: ' +
    '<span style="color:#4da3ff">Wahl</span> = deine Größe, <span style="color:#f6b93b">Deckung</span> = Ertrag = ' +
    'Verbrauch, <span style="color:#4be0b0">0 €</span> = ab hier deckt die Einspeisung den Netzbezug.',
  'pv-orient-opt': () => 'Sucht aus deinem <b>Verbrauch</b> und dessen <b>Tagesverlauf</b> die beste Dachausrichtung ' +
    'und Größe: für jede Ausrichtung wird die kWp so gewählt, dass der <b>Sommer ~100 % autark</b> ist, und dann ' +
    'die <b>Winter-Autarkie</b> verglichen. <b>Süd steil</b> holt im Winter am meisten, <b>Ost-West</b> deckt den ' +
    'Tagesverlauf (morgens/abends) am besten, <b>Süd 35°</b> den höchsten Jahresertrag. Hohe Autarkie braucht einen ' +
    '<b>Speicher</b> (sonst nur Tagesdeckung). <b>Winter 100 % ist mit PV allein nicht möglich</b> – die Zahlen sind ' +
    'Richtwerte für ~50° N; den exakten Standort-Ertrag liefert die PVGIS-Abfrage.',
  'switch': () => 'Schaltet deine <b>Bosch Smart Plug+</b> (und andere schaltbare Bosch-Geräte) direkt aus der App – ' +
    'praktisch, um einen Verbraucher gezielt in ein <b>günstiges/PV-starkes Fenster</b> zu legen (siehe Börse/Smart-Timer). ' +
    'Es wird <b>nur manuell</b> geschaltet (mit Rückfrage) – nichts läuft automatisch. ⚠︎ Schalte keine Dauerverbraucher wie ' +
    '<b>Kühl-/Gefrierschrank, Router/Server</b> versehentlich ab. Mit ↻ aktualisierst du den Status.',
  'heating-diag': () => 'Sucht typische <b>Einstellungsfehler &amp; Effizienz-Verluste</b> deiner Heizung. Grundprinzip einer ' +
    'Wärmepumpe: <b>möglichst niedriger Vorlauf</b> (jedes +1 K ≈ −2–3 % Effizienz), <b>Heizflächen weit offen</b> ' +
    '(die Heizkurve regelt, nicht die Raumthermostate), <b>Spreizung Vorlauf−Rücklauf 5–8 K</b> und <b>wenig Takten</b> ' +
    '(lange Laufzeiten). Geprüft wird aus deinen <b>Raumthermostaten</b> (Soll/Ist/Ventilstellung) und dem <b>Vorlauf/Rücklauf</b> ' +
    'der WP. <b>Betriebswerte</b> (Vorlauf, Spreizung, Takt) sind eine <b>Momentaufnahme</b> – am aussagekräftigsten an einem kalten ' +
    'Heiztag; <b>Einstellungen</b> (Ventile, Sollwerte, Modi) gelten dauerhaft. Es sind <b>Heuristiken</b> als Entscheidungshilfe, ' +
    'keine amtliche Diagnose.',
  'heating-curve': () => 'Die <b>Heizkurve</b> bestimmt, wie heiß der <b>Vorlauf</b> bei welcher <b>Außentemperatur</b> wird. ' +
    'Jeder Punkt ist ein gemessener Betriebspunkt beim Heizen; die <b>rote Linie</b> ist die daraus gefittete Ist-Kurve, ' +
    'die <b>grüne</b> ein WP-freundliches Zielband (möglichst niedrig). Liegt Rot <b>über</b> Grün, läuft die WP unnötig heiß ' +
    '– jedes +1 K Vorlauf kostet ~2–3 % Effizienz. Senke dann an der Wärmepumpe <b>Niveau</b> (verschiebt die ganze Kurve) ' +
    'oder <b>Steilheit/Gradient</b> (kippt sie: wirkt vor allem bei Kälte). Die App <b>sammelt</b> die Punkte im Betrieb, ' +
    'daher wird die Kurve über die Heiztage immer aussagekräftiger – am besten an kalten Tagen. ' +
    'Schneller geht es mit einem <b>HomeCom-CSV-Export</b> (Setup → Import): der enthält <b>stündlich</b> Vorlauf- und ' +
    'Außentemperatur, daraus baut die App die Kurve sofort rückwirkend – es zählen nur echte Heizstunden (kein Warmwasser/Standby). ' +
    'Trägst du zusätzlich die <b>zwei Punkte deiner Geräte-Heizkurve</b> ein (Vorlauf bei +20 °C und −10 °C, wie am WP-Display), ' +
    'zeichne ich sie <b style="color:#3ba9ff">blau</b> mit ein und vergleiche sie direkt mit dem Zielband.',
  'heat-timeseries': () => 'Stündlicher <b>Zeitverlauf</b> aus deinem CSV-Import. Oben <b>Außentemperatur</b> (blau) ' +
    'und <b>Vorlauf</b> (rot); unten der <b>Verbrauch</b> als Balken (Heizung/Warmwasser, gestapelt) und die ' +
    '<b>Arbeitszahl COP</b> (grün, rechte Achse). Daraus leite ich ab, <b>wie</b> die Regelung arbeitet: wie stark Vorlauf ' +
    'und Stromverbrauch mit sinkender Außentemperatur steigen, wie die Effizienz vom Wetter abhängt und welchen Anteil ' +
    'Warmwasser hat. <b>COP</b> = erzeugte Wärme ÷ eingesetzter Strom (höher = besser).',
  'windows': () => 'Nutzt deine <b>Fensterkontakte</b>: jede Öffnung erscheint als Band auf der Zeitachse, darüber läuft die ' +
    '<b>Innentemperatur</b>. So siehst du direkt die <b>Auswirkung</b> – fällt die Temperatur beim Lüften (Wärmeverlust) oder nicht? ' +
    'Die Zahl im Band ist die Temperaturänderung während des Lüftens. <b>Rote</b> Bänder = die Wärmepumpe hat dabei geheizt ' +
    '(Heizen gegen offenes Fenster = reiner Verlust). Ziel: <b>kurzes Stoßlüften</b> statt Dauerkippen. Die App zeichnet die ' +
    'Öffnungen ab jetzt auf – die Timeline füllt sich über die nächsten Tage.',
  'room-ts': () => '<b>Jeder Raum</b> als eigene Temperatur-Linie über die Zeit, gestrichelt der <b>Sollwert</b>, unten ein grüner ' +
    'Streifen für den <b>WP-Heizbetrieb</b>. Damit siehst du: welcher Raum sein Soll <b>nie</b> erreicht (⚠︎), welcher es erreicht ' +
    'und dann das <b>Ventil schließt</b>, wie schnell ein Raum nach Ventil-zu wieder <b>auskühlt</b> (K/h) und <b>warum</b> die WP ' +
    'pausiert (meist: alle Räume am Soll → Ventile zu → keine Abnahme). Einen Raum wählen zeigt zusätzlich die Ventilöffnung ' +
    'als Schattierung. Wird aus deinen Bosch-Raumthermostaten mitgeloggt (ab jetzt).',
  'optimize': () => '<b>Schritt-Protokoll.</b> Der hydraulische Abgleich einer Fußbodenheizung ist ein Regelkreis: einen Kreis ' +
    'ein wenig verstellen, abwarten, messen. Hier hältst du fest, <b>welchen Kreis</b> du auf- oder zugedreht hast. Beim Speichern ' +
    'merkt sich die App den aktuellen Stand des Raums und vergleicht ihn nach <b>1–2 Tagen</b> mit dem neuen: Hat der Raum ' +
    '<b>aufgeholt</b>, war der Schritt wirksam; ist nichts passiert, braucht es einen größeren Schritt; wird ein gedrosselter Raum ' +
    'zu kühl, war es zu viel. Immer nur <b>ein</b> Kreis pro Schritt – sonst lässt sich die Wirkung nicht zuordnen. ' +
    'Die App schreibt dabei <b>nichts</b> an Wärmepumpe oder Verteiler.',
  'abgleich': () => '<b>Hydraulischer Abgleich</b> verteilt das Heizwasser so auf die Heizkreise, dass jeder Raum die passende ' +
    'Menge bekommt. Ohne Abgleich bekommen kurze, nahe Kreise zu viel und lange, ferne zu wenig – man dreht dann den Vorlauf hoch, ' +
    'damit auch der kälteste Raum warm wird, und das kostet bei der Wärmepumpe viel Effizienz.<br><br>' +
    '<b>Woran die App die Schieflage erkennt:</b> an der <b>gemessenen</b> Raumtemperatur der letzten 24 Stunden im Vergleich zur ' +
    '<b>Wunschtemperatur</b> des Raums. Sind die Thermostate hochgedreht (Einstell-Phase), regelt keiner mehr ab – dann zählt, wie weit ' +
    'ein Raum vom <b>Schnitt aller Räume</b> abweicht: Wer deutlich darunter liegt, bekommt zu wenig Wasser, wer darüber liegt, zu viel. ' +
    'Liegt das ganze Haus gleichmäßig zu hoch, ist das kein Verteil-Problem, sondern Sache der <b>Heizkurve</b>.<br><br>' +
    'Im normalen Regelbetrieb gleichen die Thermostate Schieflagen selbst aus; dort zählt, ob ein Raum seinen Sollwert hält und ' +
    'wie viel der Zeit er Wärme anfordert.<br><br>' +
    '<b>„Betrieb – gelesen &amp; gemessen"</b> zeigt, wie die Heizung wirklich eingestellt ist: Betriebsart und Sollwerte der Wärmepumpe ' +
    '(aus HomeCom gelesen), Modus der Raumthermostate (aus Bosch Smart Home gelesen) und ob die Sollwerte in den letzten Nächten ' +
    'tatsächlich abgesenkt wurden (gemessen). Die App nimmt hier nichts an.<br><br>' +
    'Datenbasierte Selbstoptimierung – <b>kein</b> normgerechter Abgleich (Verfahren B für Förderungen macht der Fachbetrieb).',
  'ab-rooms': () => '<b>Eine Zeile je Raum</b> – alles, was früher auf fünf Karten verteilt war.<br><br>' +
    '<b>Versorgung (gemessen):</b> Der Punkt im Balken zeigt, wie weit der Raum abweicht – links zu kalt, rechts zu warm, das grüne ' +
    'Band (±0,7 K) passt. Grundlage ist der Mittelwert der letzten 24 Stunden, ohne Zeiten mit offenem Fenster.<br><br>' +
    '<b>Wunschtemperatur:</b> das, was der Raum haben <b>soll</b> – bewusst nicht der Thermostat-Sollwert, denn der steht in der ' +
    'Einstell-Phase auf 25 °C und würde jeden Raum „4 K zu kalt" aussehen lassen. Die App nimmt deinen eingetragenen Wert, sonst den ' +
    'normalen Sollwert aus der Zeit davor. In den Details änderbar.<br><br>' +
    '<b>Ziel l/min je Kreis:</b> Startwert für den Durchflussmesser (Tacosetter): Heizlast des Raums ÷ (1,163 × Spreizung × 60), ' +
    'geteilt durch die Anzahl der Kreise. Die Heizlast kommt aus der gemessenen Gebäude-Kennlinie, solange die belastbar ist, ' +
    'sonst aus Fläche × W/m². <b>Ein</b> ΔT, <b>eine</b> Rechnung – Annahmen stehen unter „Verteiler einrichten".<br><br>' +
    '<b>Ist:</b> dein abgelesener Wert. Die Bewertung richtet sich nach dem <b>gemessenen</b> Raum: Ein zu warmer Raum wird nie ' +
    'aufgefordert, „auf den Zielwert hochzudrehen".<br><br>' +
    '<b>Details:</b> Trägheit τ (wie lange der Raum Wärme hält – braucht eine heizfreie Phase zum Messen), Auskühl- und ' +
    'Aufheizrate, Heizlast mit Unsicherheitsband. Ohne Durchfluss- oder Rücklaufmessung je Kreis bleibt das eine Schätzhilfe.',
  'automeasure': () => '<b>Auto-Messung – aktive Thermostat-Steuerung.</b> Statt dich nachts selbst absenken zu lassen, macht es die App: ' +
    'sie senkt im <b>Nachtfenster</b> die Raum-Solltemperaturen (schreibt über die lokale Bosch-SHC-API an die Thermostate), erzwingt ' +
    'so freie <b>Auskühlphasen</b> für die τ-Messung und stellt morgens die <b>exakt vorher gespeicherten</b> Sollwerte wieder her. ' +
    '<b>Sicherheitsregeln:</b> senkt nur ab (hebt nie an), nie unter die eingestellte <b>Mindesttemperatur</b>, der Bridge-Client ' +
    'begrenzt zusätzlich hart auf 5–30 °C; die Originalwerte werden <b>vor</b> dem ersten Schreiben gespeichert, sodass auch nach ' +
    'einem Neustart korrekt zurückgestellt wird; „Stop" stellt sofort alles zurück; und es stoppt von selbst nach den eingestellten ' +
    'Nächten oder sobald jeder Raum genug τ-Daten hat. Nur im Live-Modus mit verbundener Bosch-Zentrale.',
  'hp-control': () => 'Schreibt Einstellungen <b>direkt an die Wärmepumpe</b> über die HomeCom-Cloud-API – z. B. ' +
    '<b>Betriebsart</b>, <b>Heizkurven-Niveau</b> oder <b>Soll-Temperaturen</b>. Die App fragt die Anlage, welche ' +
    'Ressourcen <b>änderbar</b> sind (die API meldet pro Wert „writeable" und den erlaubten Bereich), und bietet nur ' +
    'diese an – Werte werden gegen den von der Anlage gemeldeten Bereich geprüft. Jede Änderung ist <b>bestätigungspflichtig</b> ' +
    'und zeigt den vorherigen Wert (zum Zurückstellen). <b>Ehrlich:</b> Die HomeCom-API ist inoffiziell/reverse-engineered; ' +
    'Schreiben ist experimentell. Teste mit einem harmlosen Wert (z. B. Warmwasser-Soll ±1 °C) und beobachte, bevor du die ' +
    'Heizkurve verstellst. Frostschutz/Sicherheitsfunktionen der Anlage bleiben unberührt.',
  'pv-margin': () => 'Hier steht der <b>Ertrag der Kosten gegenüber</b>. Oben drei editierbare Annahmen (€/kWp, €/kWh Speicher, Grundkosten). ' +
    'Oberes Diagramm: <b>Ertrag über 20 Jahre</b> (Linie) vs. <b>Investition</b> (gestrichelt) – der Abstand ist dein Gewinn. ' +
    'Unteres Diagramm: <b>Grenznutzen</b> (€/Jahr je +1 kWp) gegen die <b>Kostengrenze</b>. Das <b>wirtschaftliche Optimum</b> ist das größte ' +
    'kWp, dessen letztes kWp noch seine Kosten einspielt; darüber geht der Überschuss nur noch billig ins Netz. Speicher und geplanter ' +
    'Mehrverbrauch (E-Auto) schieben das Optimum nach oben.',
  'pv-product': () => 'Konkreter Komponenten-Vorschlag zu deiner Planung. Modul: <b>AIKO Neostar (ABC-Rückkontakt)</b> – zukunftssicher ' +
    '(hoher Wirkungsgrad, top bei Verschattung, mehr kWp/m²). <b>Fronius GEN24 Plus</b> ist ein Hybrid-Wechselrichter ' +
    '(batteriefähig, ausbaufähig), den ich <b>mit Reserve</b> auslege, damit du später Module ergänzen kannst, ohne ihn zu tauschen. ' +
    'Die <b>String-Auslegung</b> (Module in Reihe) kommt aus den Spannungen (Kalt-Voc &lt; 1000 V, MPP-Fenster) und den 2 MPP-Trackern. ' +
    '<b>DC/AC</b> = Modulleistung ÷ WR-Leistung: über 1 heißt „überbelegt" und ist bis zur WR-Grenze (GEN24: 1,5) <b>gewollt</b> – mehr Ertrag ' +
    'früh/abends &amp; im Winter, nur kurze Mittagskappung (die der Speicher auffängt). Erst <b>über 1,5</b> empfiehlt die App automatisch einen größeren/zweiten WR. ' +
    'Der <b>Speicher</b> (BYD Battery-Box, modular) lässt sich aufstocken. Links führen zur Herstellerseite.',
  'pv-night': () => 'Zeigt, wie viel Strom du von <b>Sonnenuntergang bis Sonnenaufgang</b> verbrauchst – genau die Menge, ' +
    'die ein <b>Speicher</b> aus dem Tags-Überschuss überbrücken muss. Sonnenauf-/-untergang werden aus deinem <b>Standort</b> ' +
    '(PV-Tab) und dem Datum berechnet, der nächtliche Verbrauch aus deinem <b>echten Stundenprofil</b> (Haushalt + Wärmepumpe). ' +
    'Die <b>Übergangszeit</b> (Frühjahr/Herbst) ist der sinnvolle Auslegungspunkt: lange Nächte, die die PV aber noch füllen kann. ' +
    'Die <b>Winternacht</b> ist am längsten, aber dann liefert die PV zu wenig, um den Speicher zu laden – größer dimensionieren lohnt dafür nicht.',
  'consum-year': () => 'Erwarteter <b>Tagesverbrauch</b> über 365 Tage, gestapelt in <b>Hausstrom</b> (flach, blau) und ' +
    '<b>Wärmepumpe</b> (saisonal, orange). Baut auf demselben Modell wie der PV-Tab auf: Hausstrom aus deinem ' +
    '<b>Zähler</b> (falls eingetragen, inkl. E-Auto/Klima), die Wärmepumpe aus importierter/geschätzter Monatskurve. ' +
    'Es zeigt den <b>tatsächlichen</b> Verbrauch – <b>ohne</b> geplantes E-Auto/Klima aus dem PV-Tab. Die Verbrauchs-Kurve ' +
    'im PV-Tab ist deshalb identisch, solange dort E-Auto & Klima 0 sind; mit geplanten Werten liegt die PV-Kurve höher. ' +
    'Tippen/fahren zeigt Tag, Hausstrom, WP und Summe.',
  'pv-surf': () => 'Trag deine <b>verfügbaren Flächen</b> ein (Satteldach, Flachdach, Garten, Grenz-/Fassadenwand, ' +
    'Terrassenüberdachung, Carport) mit m², Neigung, Azimut und Verschattung. Je Fläche wird die installierbare ' +
    '<b>kWp</b> (Fläche × nutzbarer Anteil × Modul­dichte) und der <b>spezifische Ertrag</b> (aus Neigung/Azimut/Schatten) ' +
    'berechnet. Die <b>Belegungs-Empfehlung</b> füllt die Flächen winter-gewichtet nach Ertrag, bis der <b>Sommer ~100 %</b> ' +
    'autark ist. „Als Anlage übernehmen" rechnet den ganzen PV-Tab (Ertrag, Autarkie, Finanzierung) mit genau dieser ' +
    'Belegung – inkl. der echten, aus deinen Flächen gemischten Monatskurve. Je Fläche steht auch die <b>Belegung</b> ' +
    '(Modulzahl, Neigung) und die erzeugte Energie: <b>kWh/Tag im Winter</b> und <b>kWh/Monat im Sommer</b>. Bei ' +
    'Flachdach/Freiland zeigt eine Tabelle die Aufständerung – <b>flacher = mehr Module</b>, steiler = mehr je Modul. ' +
    '<b>Diffuslicht</b> ist berücksichtigt: Jahres-/Monatserträge beruhen auf realen Werten (direkt + diffus + reflektiert), ' +
    'und eine Verschattung kostet entsprechend weniger, weil ein verschattetes Modul weiter Diffuslicht erntet. ' +
    'Die Belegungs-Reihenfolge nutzt deinen <b>Stunden-Verbrauch</b> (Tagesprofil + WP/Auto): bevorzugt werden Flächen, ' +
    'deren Ertrag zeitlich zu deinem Verbrauch passt (höchster direkt selbst genutzter Strom). Je Fläche zeigt die ' +
    '<b>Tages-Deckung</b>, wie gut die Ausrichtung zu deinen Verbrauchszeiten passt.',
  'pv-build': () => 'Direkter Preisvergleich: dein <b>Komplett-Set</b> (Selbstbau) gegen das <b>Komplett-Angebot</b> ' +
    'der Fachfirma, abzüglich <b>Förderung</b>. Einfach beide Zahlen eintragen – ich zeige die Differenz und, wenn ' +
    'oben eine kWp-Größe steht, den Preis pro kWp. Mit den Buttons übernimmst du den Wert als Investition in die ' +
    'Amortisation. Eigenleistung (Std.) ist nur Info – dein Zeitaufwand, kein Geld.',
  cophour: () => 'COP je Uhrzeit (erzeugte Wärme ÷ Strom, gemittelt über die importierten Stunden). ' +
    'Zeigt, wann die Wärmepumpe am effizientesten läuft – meist mittags/nachmittags (wärmer). ' +
    'Warmwasser/Heizen dann einplanen spart Strom.',
  'pv-suggest': () => 'Vorschlag aus deinem Jahresverbrauch und Tagesprofil: die kWp so, dass der Jahresertrag ' +
    'etwa deinen Verbrauch deckt; der Speicher grob nach deinem abendlichen Bedarf. Nur ein Startwert – ' +
    'passe ihn frei an.',
  'pv-ev': () => 'E-Auto: aus <b>km/Jahr × kWh/100 km</b> wird der Ladebedarf berechnet, auf die Monate ' +
    'verteilt und – möglichst <b>tagsüber</b> geladen (PV-optimiert) – zum Verbrauch addiert. Das erhöht ' +
    'sinnvollen Eigenverbrauch. Standard: 18 kWh/100 km.',
  'pv-ac': () => 'Klimaanlage: gib den geschätzten Jahresverbrauch (kWh) ein. Er wird v. a. auf die ' +
    '<b>Sommermonate</b> und den <b>Nachmittag</b> verteilt – also genau dann, wenn viel PV da ist, ' +
    'darum steigert Kühlung den Eigenverbrauch. „Ø D einsetzen" trägt einen typischen deutschen ' +
    'Haushaltswert (~450 kWh/Jahr) ein; passe ihn an deine Anlage an.',
  'pv-gridfree': () => 'Ein Monat ist „netzfrei", wenn PV + Batterie ihn praktisch komplett decken (Netzbezug &lt; 1 %). ' +
    'Oben: welche Monate das mit <b>deiner</b> Anlage sind (grün). Unten: wie viele Monate es mit einer <b>größeren</b> ' +
    'Anlage (kWp) wären – der Speicher bleibt gleich. Die dunklen Wintermonate bleiben mit PV allein immer auf Netzstrom angewiesen.',
  pvgis: () => 'Holt den <b>echten PV-Ertrag</b> für deinen Standort von <b>PVGIS</b> (EU-Kommission/JRC, kostenlos, ' +
    'ohne Konto) – aus Koordinaten, Dachneigung und Ausrichtung. Setzt den <b>kWh/kWp</b>-Wert und die ' +
    '<b>Monatskurve</b> deiner PV, damit PV-Ertrag, Autarkie und netzfreie Monate standortgenau werden.',
  'hp-forecast': () => 'Rechnet aus der <b>Außentemperatur-Vorhersage</b> (Open-Meteo) und deinen Gebäudedaten den ' +
    'voraussichtlichen <b>Wärmepumpen-Strombedarf</b> der nächsten Tage – gleiche Grundlage wie „Theorie vs. Praxis" ' +
    '(U·A + Heizgradtage), nur mit der echten Wettervorhersage statt Jahresmittel. So siehst du, ob eine <b>Kältewelle</b> ' +
    'kommt und was sie kostet. Braucht deinen Standort aus dem PV-Tab. Grobe Schätzung.',
  'pv-forecast': () => 'Holt die <b>Wetter-Vorhersage</b> für deinen Standort (Open-Meteo, kostenlos, ohne Konto) und ' +
    'rechnet daraus für die nächsten Tage den <b>erwarteten PV-Ertrag</b> (aus der stündlichen Sonneneinstrahlung × deiner ' +
    'kWp) und den voraussichtlichen <b>Wärmepumpen-Strombedarf</b> (aus der Außentemperatur und deinen Gebäudedaten). So siehst ' +
    'du früh, ob morgen ein <b>PV-Überschuss</b>-Tag wird und wann die besten Stunden für Waschen/Laden sind. Grobe Schätzung.',
  cap60: () => '<b>60 %-Einspeisegrenze (Solarspitzengesetz, seit 2025):</b> Neue PV-Anlagen <b>ohne intelligentes ' +
    'Messsystem (Smart Meter)</b> dürfen am Netzanschluss höchstens <b>60 % der installierten kWp</b> ins Netz ' +
    'einspeisen. Das ist eine <b>Momentanleistungs-Grenze, keine Jahresgrenze</b>: bei 10 kWp nie mehr als 6 kW ' +
    'gleichzeitig. Der Überschuss in den Mittagsspitzen muss selbst verbraucht, gespeichert oder <b>abgeregelt</b> ' +
    '(= verworfen) werden. <b>Eigenverbrauch und Speicher</b> senken den Verlust stark; mit <b>Smart Meter entfällt ' +
    'die Grenze</b> (dafür darf der Netzbetreiber bei Engpässen/negativen Preisen steuern). Regeln ändern sich – ' +
    'maßgeblich ist dein Netzbetreiber.',
  'pv-v2h': () => 'Bidirektionales Laden (V2H): dein <b>Auto-Akku dient als Heimspeicher</b> und speist PV-Strom ' +
    'später ins Haus zurück – so kannst du einen <b>kleineren Heimspeicher</b> kaufen. Entscheidend ist, wie oft das ' +
    'Auto <b>tagsüber</b> zuhause steht: nur dann fängt es die Mittagssonne ein. Stell das unter „Auto tagsüber" ein. ' +
    'Braucht eine <b>bidirektionale Wallbox</b> und ein <b>V2H-fähiges Auto</b>.',
  'pv-batt': () => `Linker Balken = dein PV-Ertrag, aufgeteilt in <b style="color:${COL.pv}">direkt genutzt</b>, ` +
    `<b style="color:${COL.batt}">über die Batterie genutzt</b> und <b style="color:${COL.heat}">eingespeist</b>. ` +
    'Der lila Anteil ist genau das, was der <b>Speicher</b> bringt: sonst eingespeister Strom, den du dank ' +
    'Batterie selbst nutzt. Rechter Balken = dein <b>Verbrauch nach Quelle</b> ' +
    `(<b style="color:${COL.sh}">Hausstrom</b>, <b style="color:${COL.hp}">Wärmepumpe</b>, ` +
    `<b style="color:${COL.ev}">E-Auto</b>).`,
  share: () => 'Anteil je Quelle über die <b>gemessenen</b> Tage im Zeitraum (kumulierte kWh), rechts die ' +
    '<b>Hochrechnung pro Jahr</b> (kWh + €). <b>Gemessene Tage zählen exakt</b>; nur die nicht gemessenen Tage ' +
    'werden mit dem Tages-Ø aufgefüllt (= dasselbe wie Ø × 365). „(x/y Tage)" zeigt, wie viele Tage real gemessen ' +
    'sind. So siehst du, welcher Verbraucher aufs Jahr ins Gewicht fällt – gut, um unnötige Dauerläufer zu erkennen. ' +
    'Kurzer Zeitraum = grobe Hochrechnung, die Wärmepumpe ist saisonal.',
  behavior: () => 'Aus den <b>Namen</b> deiner Geräte und den Uhrzeiten, zu denen sie am meisten Strom ziehen, ' +
    'liest die App typische Routinen ab (Kochen, Schlafen, Bad …) und leitet konkrete Spar-Ideen ab. ' +
    'Basis: Ø über die gemessenen Tage.',
  smart: () => 'Findet das <b>beste Startfenster</b> für eine flexible Last (Waschen, Warmwasser, E-Auto) in den ' +
    'nächsten Stunden. Du wählst <b>Dauer</b>, <b>Energie</b> und die Priorität: <b>günstigster Preis</b> (echte ' +
    'Börsen-Day-Ahead-Preise), <b>wenigste CO₂</b> (Netz-Intensität) oder <b>PV-Überschuss</b> (deine Wetter-Prognose ' +
    'aus dem PV-Tab, sonst ein typischer Sonnenverlauf). Zeigt Start, Kosten, CO₂ und PV-Anteil – und was du gegenüber ' +
    '„jetzt sofort" sparst.',
  carbon: () => 'Wie viel <b>CO₂</b> dein Strom verursacht. Der deutsche Netzstrom hat je nach Stunde und Jahreszeit eine ' +
    'unterschiedliche <b>CO₂-Intensität</b> (g/kWh): <span style="color:#4be0b0">grün</span> mittags/im Sommer (viel Sonne & Wind), ' +
    '<span style="color:#ef6c4d">grau</span> abends/im Winter (Kohle/Gas). Deine <b>Jahresbilanz</b> gewichtet diese Intensität mit ' +
    'deinem echten Lastprofil. Verschiebst du flexible Lasten in die <b>grünen Stunden</b>, sinkt dein CO₂-Fußabdruck. ' +
    'Modell auf Basis der veröffentlichten deutschen Netz-Durchschnitte (~380 g/kWh, sinkend).',
  'tibber-cons': () => 'Dein <b>tatsächlicher Gesamtverbrauch</b> pro Tag, direkt aus dem Tibber-Zähler (also dem ' +
    'Netzzähler des ganzen Hauses). Das erfasst <b>alles</b> – auch Geräte, die die Bosch-Module nicht messen ' +
    '(Kühlschrank, Herd, Licht …). Gut als Gegenprobe zur gemessenen Smart-Home-Summe und zur Zählerkalibrierung.',
  dark: () => 'Vergleicht deinen <b>Gesamt-Haushaltsstrom</b> (ohne Wärmepumpe) mit dem, was <b>explizit gemessen</b> ' +
    'wird (Bosch-Module + Smart Plugs). Die Differenz ist der noch <b>nicht einzeln gemessene</b> Anteil („Dunkelverbrauch"). ' +
    'Mit dem <b>Smart Meter</b> des Wechselrichters: oben <b>jetzt</b> (Haus − Wärmepumpe − Geräte, alle 10 s neu) und die ' +
    'Tagesbilanz aus den letzten vollständig gemessenen Tagen. Ohne Smart Meter wird der Haushalt aus deinen ' +
    '<b>Zählerablesungen</b> bzw. dem eingetragenen Jahreswert geschätzt. So siehst du, ob sich weitere ' +
    '<b>Mess-Steckdosen</b> lohnen. Wird kleiner, sobald du Plugs ergänzt.',
  ha: () => 'Optionaler Zusatz: liest beliebige Leistungs- und Energiesensoren aus deinem <b>Home Assistant</b> ' +
    '(lokal, über dessen REST-API mit einem Zugangs-Token) – z. B. einen Lesekopf am Hauptzähler, eine PV-/Batterie-' +
    'Integration oder andere Nicht-Bosch-Geräte. Für messende <b>Steckdosen</b> ist der <b>Bosch Smart Plug+</b> der ' +
    'einfachere Weg (erscheint automatisch als Bosch-Zähler). Adresse und Token bleiben lokal auf der Bridge.',
  tibber: () => 'Verbindet dein <b>Tibber</b>-Konto (Access Token von developer.tibber.com). Dann nutzt der ganze ' +
    'Börse-Tab – Preiskurve, beste Zeiten, Live-Ampel, Smart-Timer – deine <b>echten stündlichen Tarifpreise</b> ' +
    '(all-in inkl. Netz, Abgaben, MwSt.) statt der Börse-plus-Aufschlag-Schätzung. Der Token bleibt lokal auf der ' +
    'Bridge (in <code>config.json</code>, nie im Code/Chat).',
  spot: () => 'Stündlicher <b>Börsenpreis</b> (EPEX Day-Ahead über aWATTar) als <b>Verbraucherpreis</b> ' +
    '= Börse × (1 + MwSt.) + Aufschlag. <span style="color:#4be0b0">Grün</span> = günstig, ' +
    '<span style="color:#ef6c4d">rot</span> = teuer. Die senkrechte Linie ist <b>jetzt</b>. Morgen erscheint ' +
    'nachmittags nach der Börsen-Auktion. Verschiebe flexible Lasten in die grünen Stunden.',
  finance: () => 'Rechnet deine <b>Investition</b> (PV/Speicher) als <b>Kredit</b> mit Zins durch: in den ersten ' +
    'Jahren ist die Kreditrate oft höher als die Stromersparnis (also ähnlich teuer oder teurer), <b>nach dem ' +
    'Abbezahlen</b> bleibt die Ersparnis voll übrig. Die Kurve zeigt den kumulierten Saldo und ab wann es sich ' +
    'gerechnet hat. Ersparnis kommt aus dem Tarifvergleich (bester Tarif mit PV vs. ohne). Optional werden auch ' +
    'die <b>E-Auto-Vorteile</b> (Sprit, Kfz-Steuer, THG-Quote, Wartung) mit einbezogen.',
  konzept: () => 'Vergleicht deine Jahres-Stromkosten in drei Abrechnungs-Varianten – <b>ein Zähler</b>, ' +
    '<b>zwei Zähler</b> (WP-Sondertarif) und <b>Börse</b> – jeweils ohne und mit deiner PV, und leitet daraus eine ' +
    '<b>Empfehlung</b> ab. Tarife stellst du im <b>Setup</b> ein, PV/Speicher/Auto im Tab <b>PV</b>.',
  tariff: () => 'Dein <b>Arbeitspreis</b> (ct/kWh) und <b>Grundpreis</b> (fixe €/Jahr). Optional ein eigener ' +
    '<b>Wärmepumpen-Tarif</b> über einen <b>Zweitzähler</b> – oft günstiger pro kWh, aber mit extra Grund-/Messkosten. ' +
    'Wichtig: über einen separaten WP-Zähler kann deine <b>PV den WP-Strom meist nicht</b> mitversorgen. Der Tab ' +
    '<b>Konzept</b> vergleicht alles (1 Zähler / 2 Zähler / Börse) mit und ohne PV.',
  'spot-batt': () => 'Mit einem dynamischen Tarif lohnt sich <b>Arbitrage</b>: den Speicher (Heim + optional V2H-Auto) ' +
    'in den <b>günstigen</b> Stunden laden und in den <b>teuren</b> nutzen. Der Gewinn ist die Preisdifferenz (Spread) ' +
    'mal nutzbare Kapazität. Vor allem im Winter interessant, wenn PV den Speicher nicht füllt. Braucht einen ' +
    'Speicher/EMS, der preisgesteuert laden kann.',
  'spot-cost': () => 'Vergleich deiner realen Last mit dem <b>dynamischen</b> Preis vs. deinem <b>Festpreis</b>. ' +
    '„Ø dynamisch" gewichtet den Börsenpreis mit deinem <b>Stundenprofil</b> (wann du wie viel verbrauchst). ' +
    'Liegt er unter dem Festpreis, lohnt der dynamische Tarif – noch mehr, wenn du flexible Lasten verschiebst.',
  meter: () => 'Trag deinen <b>Hauptstromzähler</b>-Stand (Gesamt = Haushalt + Wärmepumpe) ' +
    'ab und zu ein. Aus zwei Ablesungen ergibt sich dein <b>echter Gesamtverbrauch</b>; die App zieht ' +
    'die (saisonale) Wärmepumpe ab, deckt so den <b>noch nicht gemessenen Hausstrom</b> auf und ' +
    '<b>kalibriert alle Prognosen</b> auf deinen realen Wert. Bleibt lokal.',
  aeg: () => 'Deine AEG/Electrolux-Geräte (Waschmaschine, Trockner …) über die offizielle ' +
    'Electrolux-Cloud. Angezeigt werden Betriebszustand, <b>Strom pro Waschgang</b> und der ' +
    '<b>Gesamtzähler</b>. „Heute" ist der Zuwachs des Gesamtzählers seit Mitternacht. Verbinden ' +
    'im Setup mit API-Key + Refresh-Token von developer.electrolux.one.',
  'theory-month': () => 'Drei Balken je Monat (nebeneinander), oben per Häkchen <b>ein-/ausblendbar</b>: ' +
    '<b>Theorie</b> (Gebäudemodell, Heizsaison-verteilt + Warmwasser), <b>Gemessen</b> (deine echten Monatswerte; ' +
    'CSV-Monate <b>vor dem Bauphasen-Ende</b> im Setup gelten als Rohbau/Trocknung und werden ausgeblendet) und ' +
    '<b>Erwartet</b> (unser Modell: für Frühjahr–Herbst dein <b>gemessenes Niveau</b> × Saison-Form, für die kalten, ' +
    'noch nicht seriös gemessenen Monate Nov–Feb die <b>Theorie</b>). Sobald du einen echten Winter misst, ersetzt der ' +
    'den Theorie-Wert automatisch und kalibriert die übrigen kalten Monate. <b>Tippe/fahre über einen Monat</b> für die kWh.',
  'theory-class': () => 'Der <b>spezifische Heizwärmebedarf</b> (kWh je m² und Jahr, nur Heizung) ordnet dein Haus ' +
    'zwischen Passivhaus und unsaniertem Altbau ein. Er kommt aus dem U·A-Modell geteilt durch die beheizte Fläche – ' +
    'ein guter Vergleichsmaßstab, unabhängig von der Hausgröße.',
  'theory-reno': () => 'Für jedes noch schlecht gedämmte Bauteil wird gerechnet, wie viel <b>Strom/Jahr</b> eine ' +
    'Dämmung auf einen guten U-Wert spart, plus grobe Kosten und <b>Amortisation</b>. Sortiert nach größtem Hebel. ' +
    'Dazu: was 1 °C weniger Raumtemperatur bringt (~6 % je Grad).',
  theory: () => 'Vereinfachtes Ingenieurmodell: für jedes Bauteil <b>U × Fläche</b> (Wärmeverlust je Grad), ' +
    'mal <b>Heizgradtage</b> (Deutschland ~3500 Kd/a → kWh) plus Lüftung, minus Sonnen-/interne Gewinne, ' +
    'geteilt durch den <b>COP</b> ergibt den erwarteten Strom. Alle Werte sind editierbare Startschätzungen ' +
    'aus deinen Angaben. „Gemessen" ist deine echte Historie – so vergleichst du <b>Theorie und Praxis</b>.',
};
let _toastT = null;
function showInfo(key) {
  const t = $('toast'); if (!t) return;
  const fn = INFO[key]; if (!fn) return;
  t.innerHTML = fn() + '<br><small>(tippen zum Schließen)</small>';
  t.hidden = false;
  clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 9000);
}
function iBtn(key) { return `<span class="info" data-info="${key}" role="button" aria-label="Info">i</span>`; }

/* ---- "Ist das okay?"-System für Fachzahlen (Ampel + Klartext) --------------
 * Ordnet eine Fachkennzahl einem Level zu (gut / ok / beobachten / unklar) mit
 * farbigem Punkt, Klartext-Wort und – beim Antippen – Normalbereich + Erklärung,
 * damit man ohne SHK-Wissen sofort sieht, ob ein Wert in Ordnung ist. */
const RATE_COL = { good: '#4be0b0', ok: '#ffb64d', warn: '#ff6b8a', na: '#93a2c4' };
function rateMetric(key, v) {
  const mk = (lvl, word, range, why) => ({ lvl, word, range, why });
  if (key === 'confidence') {
    const s = String(v == null ? '' : v).toLowerCase();
    if (s === 'hoch') return mk('good', 'belastbar', 'hoch · mittel · niedrig', 'Genug saubere Messphasen – die Werte sind verlässlich.');
    if (s === 'mittel') return mk('ok', 'ok', 'hoch · mittel · niedrig', 'Brauchbar, aber mehr Messphasen machen es sicherer.');
    if (s === 'niedrig') return mk('warn', 'noch dünn', 'hoch · mittel · niedrig', 'Noch wenig Daten – Wert mit Vorsicht, weiter messen.');
    return mk('na', '—', '', 'Noch keine Einstufung.');
  }
  const n = (typeof v === 'number') ? v : parseFloat(v);
  if (n == null || !isFinite(n)) return mk('na', '—', '', 'Dafür fehlen noch Daten.');
  // higher-is-better metrics: {good, ok}
  const HI = {
    cop: [3.5, 2.8, 'gut ab 3,5 · ok ab 2,8', 'Wärme je kWh Strom – höher = günstiger. Gute Luft-Wärmepumpe im Winter 3–4.'],
    jaz: [3.5, 2.8, 'gut ab 3,5 · ok ab 2,8', 'Jahres-Wirkungsgrad der Wärmepumpe – höher = günstiger.'],
    heatup: [0.5, 0.2, 'gut ab 0,5 · ok ab 0,2 K/h', 'Wie schnell der Raum aufheizt. Höher = kräftig versorgt.'],
  };
  // lower-is-better metrics: {good, ok}
  const LO = {
    cooldown: [0.3, 0.6, 'gut < 0,3 · ok < 0,6 K/h', 'Wie schnell es ohne Heizung abkühlt. Niedrig = gut gedämmt; hoch (>0,6) deutet auf Zugluft/undichte Stellen.'],
    deficit: [0.5, 1.5, 'gut < 0,5 · ok < 1,5 K', 'Wie weit die Ist-Temperatur unter dem Soll bleibt. Klein = Raum wird gut warm.'],
  };
  // band metrics: list of [lo, hi, level, word]; outside all → warn
  const BAND = {
    tau: [[[8, 90, 'good', 'normal'], [0, 8, 'ok', 'reagiert schnell'], [90, 150, 'ok', 'sehr träge – gut gedämmt']], 'normal 10–90 h',
          'Thermische Trägheit: wie lange der Raum Wärme hält. Hoch/sehr träge ist eigentlich <b>gut</b> (gut gedämmt, hält lange warm). Gelb steht hier NICHT für ein Problem, sondern dafür, dass sich τ bei so langsamem Auskühlen schwerer exakt messen lässt. Über ~150 h kühlt der Raum kaum aus → Messung noch unsicher.'],
    spec: [[[15, 70, 'good', 'normal'], [70, 110, 'ok', 'eher hoch'], [10, 15, 'ok', 'eher niedrig']], 'normal 15–70 W/m²',
           'Heizlast je m². Typisch 15–70 (gut saniert weniger). Weit außerhalb → Fläche oder Messung prüfen.'],
    balance: [[[10, 16, 'good', 'normal'], [8, 18, 'ok', 'ok']], 'normal 10–16 °C',
              'Ab welcher Außentemperatur geheizt werden muss. Üblich 10–16 °C; viel höher ist unplausibel.'],
    humidity: [[[35, 55, 'good', 'ideal'], [55, 65, 'ok', 'etwas hoch'], [30, 35, 'ok', 'etwas trocken']], 'ideal 40–55 %',
               'Raumluftfeuchte. Dauerhaft über 65 % begünstigt Schimmel (vor allem an kalten Wänden) – mehr lüften/heizen. Unter 35 % ist die Luft eher trocken.'],
  };
  if (HI[key]) { const [g, o, r, w] = HI[key]; return mk(n >= g ? 'good' : n >= o ? 'ok' : 'warn', n >= g ? 'gut' : n >= o ? 'ok' : 'niedrig', r, w); }
  if (LO[key]) { const [g, o, r, w] = LO[key]; return mk(n <= g ? 'good' : n <= o ? 'ok' : 'warn', n <= g ? 'gut' : n <= o ? 'ok' : 'hoch', r, w); }
  if (BAND[key]) {
    const [bands, r, w] = BAND[key];
    for (const [lo, hi, lvl, word] of bands) if (n >= lo && n < hi) return mk(lvl, word, r, w);
    return mk('warn', 'unplausibel', r, w);
  }
  return mk('na', '—', '', '');
}
// small inline badge: colored dot + verdict word, tappable for the explanation
function rateBadge(key, v, label) {
  const r = rateMetric(key, v);
  const dot = r.lvl === 'na' ? '○' : '●';
  const data = ` data-rk="${esc(key)}" data-rv="${v == null ? '' : esc(String(v))}" data-rl="${esc(label || '')}" role="button"`;
  return `<span class="ratebadge" style="color:${RATE_COL[r.lvl]};cursor:pointer;white-space:nowrap"${data}>${dot} ${esc(r.word)}</span>`;
}
// one-time legend explaining the colour system
function statusLegendHtml() {
  return `<div class="note" style="margin-top:4px">🟢 <b style="color:${RATE_COL.good}">gut</b> · ` +
    `🟡 <b style="color:${RATE_COL.ok}">ok / beobachten</b> · 🔴 <b style="color:${RATE_COL.warn}">prüfen</b> · ` +
    `⚪ noch zu wenig Daten. <span style="color:var(--muted)">Tipp auf einen farbigen Wert zeigt den Normalbereich, auf einen <u>unterstrichenen</u> Begriff die Erklärung.</span></div>`;
}
// Twinguard air-quality rating (combinedRating GOOD/MEDIUM/BAD) + VOC purity.
function airRate(air, purity) {
  const a = String(air || '').toUpperCase();
  if (a === 'GOOD') return { lvl: 'good', word: 'gut' };
  if (a === 'MEDIUM') return { lvl: 'ok', word: 'mittel' };
  if (a === 'BAD') return { lvl: 'warn', word: 'schlecht' };
  // no categorical rating – fall back to the VOC value if present
  if (purity != null) return purity < 1000 ? { lvl: 'good', word: 'gut' }
    : purity < 1400 ? { lvl: 'ok', word: 'mittel' } : { lvl: 'warn', word: 'schlecht' };
  return { lvl: 'na', word: '—' };
}
// Lüften: combine humidity + air quality + window state into a short verdict –
// both "→ lüften" (recommend) and "✓ reicht / schließen" (enough) logic.
function ventAdvice(rm) {
  const hum = (typeof rm.humidity === 'number') ? rm.humidity : null;
  const ar = airRate(rm.air, rm.air_purity);
  const open = (rm.windows_open || 0) > 0;
  const heating = rm.heating === true;
  const humBad = hum != null && hum >= 65;
  const humHigh = hum != null && hum >= 60;
  const airBad = ar.lvl === 'warn';
  const airMid = ar.lvl === 'ok';
  if (open) {
    if (heating)
      return { lvl: 'warn', short: 'Fenster offen & Heizung', txt: '⚠️ Fenster offen & Heizung an – kurz stoßlüften, dann schließen' };
    if (!humBad && !airBad && !humHigh && !airMid)
      return { lvl: 'good', txt: '✓ reicht – Fenster wieder schließen' };
    return { lvl: 'ok', txt: '🪟 offen – noch kurz weiter lüften' };
  }
  // window closed
  if (humBad && airBad) return { lvl: 'warn', short: `${fmt(hum, 0)}% feucht & Luft schlecht`, txt: '→ lüften: zu feucht & Luft schlecht' };
  if (humBad) return { lvl: 'warn', short: `${fmt(hum, 0)}% feucht`, txt: '→ lüften: Luftfeuchte hoch (Schimmelrisiko)' };
  if (airBad) return { lvl: 'warn', short: 'Luft schlecht', txt: '→ lüften: Luftqualität schlecht' };
  if (humHigh || airMid) return { lvl: 'ok', txt: '→ bald lüften' };
  if (hum == null && ar.lvl === 'na') return { lvl: 'na', txt: '' };
  return { lvl: 'good', txt: '✓ ok' };
}
function showRate(key, v, label) {
  const t = $('toast'); if (!t) return;
  const r = rateMetric(key, v);
  const words = { good: 'gut ✓', ok: 'ok – im Blick behalten', warn: 'auffällig – prüfen', na: 'noch zu wenig Daten' };
  t.innerHTML = `<b>${esc(label || key)}: <span style="color:${RATE_COL[r.lvl]}">${words[r.lvl] || r.word}</span></b>` +
    (r.range ? `<div class="note" style="margin-top:2px">Normalbereich: <b>${esc(r.range)}</b></div>` : '') +
    (r.why ? `<div class="note" style="margin-top:2px">${r.why}</div>` : '');
  t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 9000);
}
// Glossar: Klartext-Erklärung für Fachbegriffe, die man nicht aus dem Alltag
// kennt. Antippen einer so markierten Kennzahl zeigt die Erklärung unten.
const GLOSS = {
  bilanzpunkt: ['Bilanzpunkt (Heizgrenze)', 'Die Außentemperatur, ab der überhaupt geheizt werden muss. Darüber reichen Sonne + innere Wärme (Menschen, Geräte). Üblich 12–16 °C; gut gedämmt niedriger.'],
  ua: ['Gebäude-UA (W/K)', 'Wärmeverlust des ganzen Hauses je 1 Grad Unterschied innen↔außen. Niedrig = gut gedämmt. Mal dem Temperaturunterschied ergibt die Heizlast.'],
  spec_wm2: ['Spezifische Heizlast (W/m²)', 'Heizleistung je Quadratmeter bei Auslegungs-Kälte. Grob: Passivhaus ~10–15, saniert ~30–50, Altbau 70–120.'],
  coverage: ['Fläche erfasst', 'Wie viel deiner Wohnfläche schon Raum-Daten (Fläche + Messung) hat. Höher = die Aufteilung der Gesamtlast ist verlässlicher.'],
  qtotal: ['Gesamt-Heizlast', 'Wie viel Heizleistung (Watt) das ganze Haus bei der kältesten Auslegungstemperatur braucht – Grundlage für WP-Größe und Durchfluss.'],
  design_c: ['Auslegungstemperatur', 'Die kälteste Außentemperatur, für die geplant wird (regional, z. B. −12 °C). Bei ihr muss die Heizung die volle Heizlast schaffen.'],
  spread_k: ['Spreizung ΔT', 'Temperatur-Unterschied zwischen Vor- und Rücklauf. Je Kreis der Auslege-Zielwert (Fußboden typ. 4–7 K); bestimmt den nötigen Durchfluss.'],
  tau: ['Trägheit τ (Tau)', 'Zeitkonstante: wie lange der Raum Wärme speichert. Hoch = träge (hält lange warm). Sehr hoch (>150 h) heißt meist: kühlt kaum aus → Messung noch unsicher.'],
  flow_lmin: ['Durchfluss (l/min)', 'Wassermenge pro Minute durch einen Heizkreis – das stellst du am Durchflussmesser (Tacosetter) ein. Mehr Durchfluss = mehr Wärme in den Raum.'],
  cop: ['COP / Arbeitszahl', 'Wie viel Wärme aus 1 kWh Strom wird. COP 4 = aus 1 kWh Strom 4 kWh Wärme. Höher = günstiger. Gute Luft-Wärmepumpe im Winter 3–4.'],
  jaz: ['JAZ (Jahresarbeitszahl)', 'Der COP übers ganze Jahr gemittelt – die ehrlichste Effizienz-Zahl der Wärmepumpe. Gut ab ~3,5.'],
  vorlauf: ['Vorlauftemperatur', 'Temperatur des Heizwassers, das zu den Heizflächen fließt. Niedriger = effizienter (die WP muss weniger hoch heizen). Fußbodenheizung kommt oft mit 28–38 °C aus; jedes +1 K kostet ~2–3 % Strom.'],
  heizkurve: ['Heizkurve (Heizkennlinie)', 'Regel, wie hoch der Vorlauf bei welcher Außentemperatur sein soll: kälter draußen → wärmerer Vorlauf. So flach/niedrig wie möglich einstellen, solange alle Räume noch warm werden = sparsamste Einstellung.'],
  heizgradtage: ['Heizgradtage', 'Maß, wie kalt ein Jahr war (Summe der täglichen Differenz Raum↔außen über alle Heiztage). Deutschland ~3500/Jahr. Mehr = höherer Heizbedarf.'],
  u_wert: ['U-Wert (W/m²K)', 'Wärmeverlust eines Bauteils (Wand, Fenster, Dach) je m² und Grad. Niedrig = gut gedämmt. Alte Wand ~1,4; saniert ~0,2.'],
  taktung: ['Taktung', 'Wie oft die Wärmepumpe pro Stunde an-/ausschaltet. Wenige lange Läufe = gut (schonend, effizient). Häufiges Takten deutet auf zu viel Leistung / zu wenig abgenommene Wärme.'],
  humidity: ['Luftfeuchte', 'Relative Raumluftfeuchte. Ideal ~40–55 %. Dauerhaft über 65 % begünstigt Schimmel (besonders an kalten Wänden) – lüften und ausreichend heizen.'],
  heating: ['Heizt gerade?', 'Ob der Raumregler aktuell Wärme anfordert (Befehl zum Stellantrieb). „gemeldet" = direkt vom Bosch-Regler (hasDemand), „~" = aus Soll/Ist abgeleitet.'],
};
function showGloss(key) {
  const g = GLOSS[key]; const t = $('toast'); if (!g || !t) return;
  t.innerHTML = `<b>${esc(g[0])}</b><div class="note" style="margin-top:3px">${g[1]}</div>`;
  t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 11000);
}
// a KPI value that is tappable for a plain-language explanation (dotted underline)
function glossV(v, key) {
  return GLOSS[key] ? `<span class="gloss" data-g="${esc(key)}" style="cursor:help;border-bottom:1px dotted currentColor">${v}</span>` : v;
}
function shortDay(s) { const d = new Date(s + 'T00:00'); return d.getDate() + '.'; }
function longDay(s) { const d = new Date(s + 'T00:00'); return WD[(d.getDay() + 6) % 7] + ' ' + d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); }
function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function dayOfYear(dt) { const s = new Date(dt.getFullYear(), 0, 0); return Math.floor((dt - s) / 86400000); }
const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/* ----------------------------------------------------- seasonality & fills */
// Per-month day factors that average to ~1 over the year, so
// avg_daily × factor[month] estimates a seasonally realistic day.
function shDayFactor(m) { return 1 + 0.18 * Math.cos(2 * Math.PI * m / 12); } // lighting: winter↑
let _hpF = null;
function hpDayFactor(m) {
  // heat-pump seasonality, softened: ~45 % is flat (hot water), ~55 % heating.
  if (!_hpF) { const hs = normFrac(HP_SEASON); _hpF = hs.map((v, i) => 0.45 + 0.55 * v * 365 / DIM[i]); }
  return _hpF[m];
}
// Smart-Home / household annual daily average. A manual whole-house figure
// (from the electricity bill) wins, since the modules only see part of it.
// Raw household daily from the Smart-Home modules only (no overrides).
function shMeteredDaily() {
  const d = STATE.data; if (!d) return 0;
  if (d.counter_estimate && d.counter_estimate.avg_daily_kwh > 0) return d.counter_estimate.avg_daily_kwh;
  if (d.stats && d.stats.avg_daily_kwh > 0) return d.stats.avg_daily_kwh;
  const v = (d.daily || []).map(x => x.kwh).filter(x => x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
// Household daily (everything except the heat pump). Best source first:
// real whole-house meter readings (total − heat pump), then a manual yearly
// household figure, then just the measured modules.
function shAvgDaily() {
  const md = meterHouseholdDaily();
  if (md != null && md > 0) return md;
  const house = houseManual();
  if (house > 0) return house / 365;
  return shMeteredDaily();
}
function houseManual() { return parseFloat(localStorage.getItem(LS.house) || '0') || 0; }
// Household daily for the PV load. The EV/A/C inputs in the PV planner are
// treated as ADDITIONAL / planned loads (e.g. a car you don't own yet) that are
// added on top for sizing – so here we return the plain household (meter total
// minus heat pump, or manual/modules) and the caller adds EV/A/C separately.
// (Verlauf shows only the actual meter household + heat pump, without these.)
function householdBaseDaily() { return shAvgDaily(); }
// Whole-house meter readings → real total daily average and the months spanned.
function meterStats() {
  const r = (STATE.meter || []).filter(x => x && x.kwh != null && x.ts).slice().sort((a, b) => a.ts - b.ts);
  if (r.length < 2) return null;
  const first = r[0], last = r[r.length - 1];
  const spanDays = (last.ts - first.ts) / 86400;
  if (spanDays <= 0 || last.kwh < first.kwh) return { count: r.length, first, last, spanDays: 0, dailyAvg: null, months: [], readings: r };
  const months = []; const d1 = new Date(last.ts * 1000);
  let y = new Date(first.ts * 1000).getFullYear(), m = new Date(first.ts * 1000).getMonth();
  while (y < d1.getFullYear() || (y === d1.getFullYear() && m <= d1.getMonth())) {
    months.push(m); m++; if (m > 11) { m = 0; y++; }
    if (months.length > 24) break;
  }
  return { count: r.length, first, last, spanDays, dailyAvg: (last.kwh - first.kwh) / spanDays, months, readings: r };
}
// Measured heat-pump electricity over the exact meter window [fromTs,toTs],
// summed from the REAL daily series (HomeCom). This is what the meter's growth
// actually contained, so household = meter − this reconciles with the HomeCom
// counter the user reads. Returns null when the daily data doesn't cover the
// span well enough (then we fall back to the seasonal model).
function hpKwhOverSpan(fromTs, toTs) {
  const days = (STATE.ov && STATE.ov.combined_daily) || [];
  if (!days.length) return null;
  const fromKey = localKey(new Date(fromTs * 1000)), toKey = localKey(new Date(toTs * 1000));
  const spanDays = Math.max(1, Math.round((toTs - fromTs) / 86400));
  let sum = 0, n = 0;
  // days AFTER the first reading up to and including the last: that's the energy
  // the meter growth accumulated over the window.
  days.forEach(d => {
    if (d.day > fromKey && d.day <= toKey && d.heatpump_kwh != null) { sum += d.heatpump_kwh; n++; }
  });
  return n >= Math.ceil(spanDays * 0.6) ? { kwh: sum, days: n, spanDays } : null;
}
// Heat-pump daily kWh to subtract from the meter for the calibration window.
// Prefers the real windowed measurement; falls back to the seasonal model.
function meterHpDaily(s) {
  if (!s) return hpAvgDaily();
  const w = hpKwhOverSpan(s.first.ts, s.last.ts);
  if (w && s.spanDays > 0) return w.kwh / s.spanDays;
  return s.months && s.months.length
    ? mean(s.months.map(m => (hpMonthEst(m) || 0) / DIM[m])) : hpAvgDaily();
}
// Household daily derived from the meter: real total minus the heat pump's
// actual consumption over the same window (household baseload is ~constant).
function meterHouseholdDaily() {
  const s = meterStats(); if (!s || s.dailyAvg == null) return null;
  return Math.max(0, s.dailyAvg - (meterHpDaily(s) || 0));
}
// Mean daily heat-pump electricity for the measured season. Prefer the
// meter-growth-over-span figure (robust to polling gaps) over sparse day deltas.
function hpMeasuredMean() {
  const a = STATE.hpA; if (!a) return 0;
  if (a.counter && a.counter.avg_daily_elec_kwh > 0) return a.counter.avg_daily_elec_kwh;
  if (a.stats && a.stats.avg_daily_elec_kwh > 0) return a.stats.avg_daily_elec_kwh;
  const v = (a.daily || []).map(x => x.elec_kwh).filter(x => x > 0);
  return v.length ? v.reduce((a2, b) => a2 + b, 0) / v.length : 0;
}
// … anchored to that season so the ANNUAL daily mean is consistent.
function measuredMonths() {
  const a = STATE.hpA;
  if (a && a.counter && a.counter.observed_months && a.counter.observed_months.length)
    return a.counter.observed_months.map(s => +s.slice(5) - 1);
  const ms = new Set();
  ((STATE.ov && STATE.ov.combined_daily) || []).forEach(d => { if (d.heatpump_kwh > 0) ms.add(+d.day.slice(5, 7) - 1); });
  return [...ms];
}
function hpRefFactor() { const ms = measuredMonths(); return ms.length ? (mean(ms.map(hpDayFactor)) || 1) : 1; }
// Annual heat-pump electricity anchored to the user's REAL measured daily mean,
// de-seasonalised via the measured months' day-factor so the yearly figure is
// consistent. This is the finished-house level; it deliberately ignores the
// imported construction/move-in-phase CSV, whose winter is unrealistically high.
// Returns null when there is no real live measurement to anchor to.
function hpAnnualReal() {
  const mm = hpMeasuredMean();
  if (!(mm > 0)) return null;
  const ref = hpRefFactor();
  return (ref > 0 ? mm / ref : mm) * 365;
}
function hpAvgDaily() {
  // Prefer the real measured level (finished house) over the imported CSV.
  const real = hpAnnualReal();
  if (real) return real / 365;
  const iy = hpYearFromMonthly();
  if (iy) return iy / 365;
  const ref = hpRefFactor(); const mm = hpMeasuredMean();
  return ref > 0 ? mm / ref : mm;
}
// Full 12-month heat-pump electricity built from the imported real months
// (fills the current partial month and any gap so it's a consistent year).
function hpYearFromMonthly() {
  if (!hpRealMonthMap()) return null;
  let s = 0; for (let m = 0; m < 12; m++) s += hpMonthEst(m);
  return s;
}

// Bauphasen-Ende: everything the WP "measured" BEFORE this date belongs to the
// construction/move-in phase (Estrich-/Bautrocknung, undichte Haustür, offene
// Lüftungslöcher, Heizstab) and is unrealistically high for the finished house.
// CSV months before it are ignored for the forecast; default 15 Feb 2026, and
// the user can change it in the Setup. Returns a Date.
const BAU_END_DEFAULT = '2026-02-15';
function buildPhaseEnd() {
  let s = BAU_END_DEFAULT;
  try { s = localStorage.getItem('bhe_bau_end') || BAU_END_DEFAULT; } catch (e) {}
  const d = new Date(s + 'T00:00');
  return isNaN(d) ? new Date(BAU_END_DEFAULT + 'T00:00') : d;
}
// Heating-season months (Nov, Dec, Jan, Feb): for these, the mild-autumn
// extrapolation is too low, so – as long as we have no representative (post-
// construction) measurement yet – we use the engineering/building model.
function isHeatMonth(m) { return m === 10 || m === 11 || m === 0 || m === 1; }
// Do we already have a real, representative winter measurement to learn from?
function hasMeasuredHeatMonth() {
  const byM = hpMeasuredByMonth(); if (!byM) return false;
  return Object.keys(byM).some(k => isHeatMonth(+k) && byM[k].source === 'measured' && !byM[k].partial);
}
// Our best model value for a calendar month (NO substitution of real months –
// that happens in hpMonthEst). Shoulder/summer: real-anchored level × seasonal
// shape. Cold months without representative winter data: the building model
// (theory), optionally calibrated to real winter once we have it. Never below
// the real-anchored baseline.
function hpModelMonth(m) {
  const seasonal = hpAvgDaily() * hpDayFactor(m) * DIM[m];
  if (isHeatMonth(m)) {
    const theory = hpTheoryMonth(m);
    const phys = hpMonthPhysics(m);                 // theory calibrated to measured months
    // Before any real winter is measured, use raw theory (conservative, higher).
    // Once a real winter month exists, the calibration includes it → use phys.
    const cold = (hasMeasuredHeatMonth() && phys != null) ? phys : (theory > 0 ? theory : seasonal);
    return Math.max(seasonal, cold);
  }
  const phys = hpMonthPhysics(m);
  return phys != null ? seasonal * (1 - HP_PHYS_W) + Math.max(seasonal, phys) * HP_PHYS_W : seasonal;
}

// Bauphase-Dämpfung: the first heating season was the move-in/construction
// phase (Rohbau, undichte Baulücken, WP im Dauerbetrieb), so the measured
// winter months are unrealistically high for the finished, tight house. Instead
// of discarding them (pure theory), we KEEP the measurements but pull the part
// that lies ABOVE the building-model expectation partway back toward theory.
// Months at/below theory (typically summer) stay untouched. Opt-in.
function hpDampBauphase() { try { return localStorage.getItem('bhe_hp_damp') === '1'; } catch (e) { return false; } }
const HP_DAMP_W = 0.6; // how strongly the excess over theory is pulled back (0=aus, 1=reine Theorie)
// Per-calendar-month heat-pump electricity from the building model:
// space heat follows the heating-season shape, DHW is spread evenly by days.
function hpTheoryMonth(m) {
  const r = computeHeat(buildData()), hs = normFrac(HP_SEASON);
  return r.eHeat * hs[m] + r.eDhw * DIM[m] / 365;
}
// Temperature/physics-anchored winter estimate: calibrate the building model to
// the REAL measured level using the months we've actually measured (overlap),
// then read the cold months off that. The building model splits heating (very
// seasonal) from hot water (flat) using the house's own heat demand, so Okt–Dez
// come out higher than just scaling the mild autumn average by a generic share –
// which is what made them look "too low". Needs ≥1 completed, self-measured
// month; self-corrects once real winter months are measured (they then win).
const HP_PHYS_W = 0.5; // weight of the physics estimate for not-yet-measured months
function hpPhysicsCal() {
  const byM = hpMeasuredByMonth(); if (!byM) return null;
  const cm = new Date().getMonth();
  let realS = 0, thS = 0;
  Object.keys(byM).forEach(k => {
    const m = +k, e = byM[m];
    if (!e || e.source !== 'measured' || e.partial || m === cm) return; // completed self-measured only
    const th = hpTheoryMonth(m);
    if (th > 0 && e.kwh > 0) { realS += e.kwh; thS += th; }
  });
  if (thS <= 0) return null;
  return Math.min(2.5, Math.max(0.4, realS / thS)); // bounded: a noisy single month can't explode winter
}
function hpMonthPhysics(m) {
  const k = hpPhysicsCal(); if (k == null) return null;
  const th = hpTheoryMonth(m);
  return th > 0 ? th * k : null;
}
// Measured/estimated month for m, with the Bauphase excess dampened toward
// theory when the correction is on.
function hpMonthCorrected(m) {
  const meas = hpMonthEst(m);
  if (!hpDampBauphase()) return meas;
  const theory = hpTheoryMonth(m);
  if (!(theory > 0) || meas <= theory) return meas; // at/below theory: trust the measurement
  return theory + (meas - theory) * (1 - HP_DAMP_W);  // keep the measurement, tame the peak
}
// Full 12-month heat-pump electricity with the Bauphase-Dämpfung applied.
function hpYearCorrected() {
  let s = 0; for (let m = 0; m < 12; m++) s += hpMonthCorrected(m);
  return s;
}

// Real per-calendar-month heat-pump electricity from imported history
// (most recent value per month, excluding the current still-running month).
function hpRealMonthMap() {
  const im = STATE.hpA && STATE.hpA.imported;
  if (!im || !(im.monthly || []).length) return null;
  const cur = im.latest; // e.g. "2026-09" – partial, exclude
  const map = {};
  im.monthly.forEach(r => { if (r.month !== cur && r.elec_kwh > 0) map[+r.month.slice(5) - 1] = r.elec_kwh; });
  return Object.keys(map).length ? map : null;
}
// Real measured value per calendar month WITH its year (most recent per month,
// excluding the current still-running month) – lets the chart tell this-year
// data from previous-year data.
function hpMeasuredByMonth() {
  const im = STATE.hpA && STATE.hpA.imported;
  const polled = (STATE.hpA && STATE.hpA.monthly) || [];   // this-year live-measured months
  if ((!im || !(im.monthly || []).length) && !polled.length) return null;
  const now = new Date(), cm = now.getMonth(), cy = now.getFullYear();
  const curKey = `${cy}-${String(cm + 1).padStart(2, '0')}`;
  const byM = {};
  // 1) CSV baseline: most recent year per calendar month (Vorjahr for months we
  //    haven't measured ourselves yet). Skip the current month (partial) AND any
  //    month that lies in the CONSTRUCTION phase (before Bauphasen-Ende) – that
  //    data is unrealistically high and must not seed the forecast.
  const bauEnd = buildPhaseEnd();
  ((im && im.monthly) || []).forEach(r => {
    if (r.month === curKey || !(r.elec_kwh > 0)) return;
    const m = +r.month.slice(5) - 1, y = +r.month.slice(0, 4);
    if (new Date(y, m, 1) < bauEnd) return;           // construction phase → ignore CSV month
    if (!byM[m] || y > byM[m].year) byM[m] = { kwh: r.elec_kwh, year: y, source: 'csv' };
  });
  // 2) Overlay THIS YEAR's own measurements, aggregated from the real DAILY
  //    series so we know the day-coverage: a month we only polled partially
  //    (e.g. the bridge started mid-month) is projected to a full month from the
  //    recorded days' average instead of showing a too-low partial sum. Months
  //    with (almost) full coverage use the real sum; the running month projects
  //    from elapsed days; months with too little data are left to CSV/model.
  const dailies = (STATE.hpA && STATE.hpA.daily) || [];
  const agg = {};                                   // m → { sum, days }
  dailies.forEach(d => {
    if (!d || !d.day || !(d.elec_kwh > 0)) return;
    const p = String(d.day).split('-'); if (p.length < 3 || +p[0] !== cy) return;
    const m = +p[1] - 1, a = agg[m] || (agg[m] = { sum: 0, days: 0 });
    a.sum += d.elec_kwh; a.days++;
  });
  // fall back to the bridge's monthly sums when no daily series is available
  if (!Object.keys(agg).length) {
    polled.forEach(r => {
      if (!(r.elec_kwh > 0) || String(r.month).length < 7) return;
      const y = +r.month.slice(0, 4), m = +r.month.slice(5) - 1;
      if (y !== cy) return;
      if (m < cm) byM[m] = { kwh: r.elec_kwh, year: y, source: 'measured' };
      else if (m === cm) { const day = Math.max(1, now.getDate()); byM[m] = { kwh: r.elec_kwh * DIM[m] / day, year: y, partial: true, actual: r.elec_kwh, source: 'measured' }; }
    });
  } else {
    Object.keys(agg).forEach(k => {
      const m = +k, a = agg[m]; if (a.days < 1) return;
      const covFrac = a.days / DIM[m], perDay = a.sum / a.days;
      if (m === cm) {
        byM[m] = { kwh: perDay * DIM[m], year: cy, partial: true, actual: a.sum, days: a.days, source: 'measured' };
      } else if (m < cm) {
        if (covFrac >= 0.85) byM[m] = { kwh: a.sum, year: cy, source: 'measured', cov: covFrac };
        else if (a.days >= 4) byM[m] = { kwh: perDay * DIM[m], year: cy, source: 'measured', projected: true, cov: covFrac, days: a.days };
        // else: too few days to trust – leave the CSV/model value in place
      }
    });
  }
  return Object.keys(byM).length ? byM : null;
}
// Full-month heat-pump electricity estimate for calendar month m.
function hpMonthEst(m) {
  const im = STATE.hpA && STATE.hpA.imported;
  const now = new Date(), cm = now.getMonth();
  // When we have REAL live measurements of the finished house, drive the month
  // from the real level + a clean seasonal shape – NOT the imported construction/
  // move-in-phase CSV (whose winter is 3–5× too high for the tight, finished
  // building). A completed THIS-YEAR month that we measured ourselves is exact
  // and wins; the running month and all others use the real-anchored model.
  if (hpAnnualReal() != null) {
    const byM = hpMeasuredByMonth();
    if (byM && byM[m] && byM[m].source === 'measured' && !byM[m].partial && m !== cm) return byM[m].kwh;
    // Not (yet) measured this month → our best model: real-anchored for the
    // shoulder, building-model (theory) for the cold months. Self-corrects once
    // real winter data arrives (then the measured month above wins).
    return hpModelMonth(m);
  }
  // No live data → fall back to the imported CSV history (only source we have).
  // current calendar month: scale the still-running partial value to a full month
  if (im && (im.monthly || []).length && m === cm) {
    const key = `${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`;
    const cur = im.monthly.find(x => x.month === key);
    if (cur && cur.elec_kwh > 0) return cur.elec_kwh * DIM[m] / Math.max(1, now.getDate());
  }
  const rm = hpRealMonthMap();
  if (rm) {
    if (rm[m] != null) return rm[m];
    // nearest available months on each side, interpolate by month distance
    let below = null, bD = 0, above = null, aD = 0;
    for (let d = 1; d <= 6; d++) {
      if (below == null && rm[(m - d + 12) % 12] != null) { below = rm[(m - d + 12) % 12]; bD = d; }
      if (above == null && rm[(m + d) % 12] != null) { above = rm[(m + d) % 12]; aD = d; }
    }
    if (below != null && above != null) return below + (above - below) * (bD / (bD + aD));
    if (below != null) return below; if (above != null) return above;
  }
  return hpAvgDaily() * hpDayFactor(m) * DIM[m];
}

// Single source of truth for all forecasts (prefers imported real data).
function annualForecast() {
  const p = STATE.price, sh = shAvgDaily();
  const now = new Date(), m = now.getMonth();
  const shMonth = sh * shDayFactor(m) * DIM[m];
  const imported = !!hpYearFromMonthly();
  const damp = hpDampBauphase();
  // hpBasis: which source drives the WP forecast.
  //  'gedämpft'   – Bauphase-Dämpfung on: measured, but winter peaks tamed toward theory
  //  'importiert' – real imported monthly meter readings (undampened)
  //  'geschätzt'  – seasonal average fallback (no imported data)
  const hpBasis = damp ? 'gedämpft' : (imported ? 'importiert' : 'geschätzt');
  const hpMonth = damp ? hpMonthCorrected(m) : hpMonthEst(m);
  const hpYear = damp ? hpYearCorrected() : (hpYearFromMonthly() || hpAvgDaily() * 365);
  return {
    shYear: sh * 365, hpYear, year: sh * 365 + hpYear, yearCost: (sh * 365 + hpYear) * p,
    monthNow: shMonth + hpMonth, monthNowCost: (shMonth + hpMonth) * p,
    shMonth, hpMonth, hpImported: imported, hpBasis,
  };
}
// Complete per-day series over [from,to]; real where measured, else a
// seasonally-scaled average (flagged estimated). Capped to keep it light.
function filledDaily(from, to) {
  const shReal = {}, hpReal = {};
  ((STATE.ov && STATE.ov.combined_daily) || []).forEach(d => {
    shReal[d.day] = d.smarthome_kwh; hpReal[d.day] = d.heatpump_kwh;
  });
  const shA = shAvgDaily(), hpA = hpAvgDaily();
  const out = [];
  const t = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  let guard = 0;
  while (t <= end && guard++ < 800) {
    const key = localKey(t), m = t.getMonth();
    const hasSh = shReal[key] != null, hasHp = hpReal[key] != null;
    const sh = hasSh ? shReal[key] : shA * shDayFactor(m);
    // prefer real monthly history (spread over the month) over the model
    const hp = hasHp ? hpReal[key] : hpMonthEst(m) / DIM[m];
    out.push({ day: key, sh, hp, total: sh + hp, estimated: !(hasSh || hasHp) });
    t.setDate(t.getDate() + 1);
  }
  return out;
}
// Aggregate a filled daily series to months (for long spans).
function aggregateMonths(filled) {
  const map = {};
  filled.forEach(d => {
    const m = d.day.slice(0, 7);
    (map[m] = map[m] || { sh: 0, hp: 0, est: 0, n: 0 });
    map[m].sh += d.sh; map[m].hp += d.hp; map[m].n++; if (d.estimated) map[m].est++;
  });
  return Object.keys(map).sort().map(m => ({
    key: m, label: MON[+m.slice(5) - 1], sh: map[m].sh, hp: map[m].hp,
    total: map[m].sh + map[m].hp, estimated: map[m].est > map[m].n / 2,
  }));
}
// Fill empty (weekday,hour) cells of a 7×24 grid with that hour's column mean,
// so a sparse heatmap still reads as a complete pattern.
function fillHeatmap(grid) {
  if (!grid || !grid.length) return grid;
  const colMean = [];
  for (let h = 0; h < 24; h++) {
    let s = 0, n = 0;
    for (let wd = 0; wd < 7; wd++) if (grid[wd][h] > 0) { s += grid[wd][h]; n++; }
    colMean[h] = n ? s / n : 0;
  }
  return grid.map(row => row.map((v, h) => v > 0 ? v : colMean[h]));
}

/* ---------------------------------------------------------------- fetching */
async function api(path) {
  const r = await fetch((STATE.base || '') + path, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function postJSON(path, body) {
  const r = await fetch((STATE.base || '') + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}

/* Put a set of core results on screen. origin: 'fresh' (just computed by the
 * bridge), 'stale' (the bridge's last saved state while it is still computing)
 * or 'snap' (what this browser showed last time). */
function applyCoreState(c, health, origin) {
  if (health) {
    STATE.health = health;
    STATE.cur = health.currency || STATE.cur || '€';
    if (health.price_per_kwh && !localStorage.getItem(LS.price)) {
      STATE.price = health.price_per_kwh; $('price').value = STATE.price;
    }
  }
  STATE.ov = c.ov; STATE.hpA = c.hpA; STATE.data = c.data;
  STATE.meter = Array.isArray(c.meter) ? c.meter : ((c.meter && c.meter.readings) || []);
  // safe defaults so the first render never trips over missing optional data
  STATE.appliances = STATE.appliances || null;
  STATE.spot = STATE.spot || null;
  STATE.tibberCons = STATE.tibberCons || null;
  STATE.ha = STATE.ha || null;
  STATE.carbon = STATE.carbon || demoCarbon();
  STATE.cur = (c.data && c.data.currency) || STATE.cur || '€';
  $('cur').textContent = STATE.cur;
  setMode((health && health.mode) || 'live');
  if (health) $('diag').textContent = JSON.stringify(health, null, 1);
  STATE.coreOrigin = origin;
  STATE.coreTs = origin === 'fresh' ? Date.now() : (c.ts || (c.generated_at ? c.generated_at * 1000 : null));
  renderAll();                         // ← first paint happens here (visible tab only)
  showStand(origin === 'fresh' ? null : STATE.coreTs);
  if (origin === 'fresh') snapSave();
}
// small header line while an older state is on screen
function showStand(ms) {
  const el = $('data-stand'); if (!el) return;
  if (!ms) { el.hidden = true; return; }
  const d = new Date(ms), today = new Date().toDateString() === d.toDateString();
  el.hidden = false;
  el.textContent = 'Stand ' + (today ? '' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ' ') +
    d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' · wird aktualisiert …';
}
// The last core state this browser showed – painted at once on the next start
// when the bridge has not answered yet. Not a 'bhe_' key on purpose: it must
// never be synced to the bridge as an app setting.
const SNAP_KEY = 'core_snap_v1';
function snapSave() {
  if (STATE.demo || !STATE.ov || !STATE.hpA || !STATE.data) return;
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify({ ts: Date.now(), base: STATE.base || '',
      ov: STATE.ov, hpA: STATE.hpA, data: STATE.data, meter: STATE.meter || [], health: STATE.health || null }));
  } catch (e) { try { localStorage.removeItem(SNAP_KEY); } catch (e2) {} }      // quota: rather none than half
}
function snapLoad() {
  try {
    const sn = JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
    if (sn && sn.ov && sn.hpA && sn.data && (sn.base || '') === (STATE.base || '')) return sn;
  } catch (e) {}
  return null;
}

async function loadAll() {
  if (STATE.demo) return applyDemo('demo');
  try {
    const health = await api('/api/health');
    STATE.health = health;
    if (health.price_per_kwh && !localStorage.getItem(LS.price)) {
      STATE.price = health.price_per_kwh; $('price').value = STATE.price;
    }
    const p = STATE.price;
    // CORE: local, fast calls (store reads + computation). Render as soon as
    // these are in – never wait for the external integrations below.
    const [ov, hpA, data, meter] = await Promise.all([
      api('/api/overview?days=90&price=' + p),
      api('/api/heatpump/analytics?days=90&price=' + p),
      api('/api/analytics?days=90&price=' + p),
      api('/api/meter').catch(() => null),
    ]);
    applyCoreState({ ov, hpA, data, meter }, health, 'fresh');
    checkUpdate();                       // show the "update available" banner if behind
    loadOptional(health, p);             // external integrations fill in afterwards
  } catch (e) {
    STATE.health = null;
    const snap = STATE.coreOrigin ? null : snapLoad();
    if (STATE.coreOrigin || snap) {
      // the bridge is unreachable, but we know the last real state: keep showing
      // that (clearly marked) instead of switching to made-up demo numbers
      if (snap) applyCoreState(snap, snap.health, 'snap');
      setMode('err');
      const when = STATE.coreTs ? new Date(STATE.coreTs).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      const el = $('data-stand'); if (el) { el.hidden = false; el.textContent = 'Bridge nicht erreichbar · letzter Stand' + (when ? ' ' + when : ''); }
      $('conn-note').innerHTML = 'Keine Bridge erreichbar (' + escIp(e.message) + '). Angezeigt wird der <b>zuletzt geladene Stand</b>.';
      return;
    }
    $('conn-note').innerHTML =
      'Keine Bridge erreichbar (' + escIp(e.message) + '). Es werden <b>Demo-Daten</b> gezeigt. ' +
      'Trage im Setup die Adresse deiner Bridge ein oder öffne diese Seite direkt von der Bridge.';
    applyDemo('err');
  }
}

// External integrations (Home Assistant, Tibber, carbon, spot market). Each may
// be a slow network call, so they load AFTER the first paint and update their
// own card when they arrive – a slow/unreachable service never delays the app.
function loadOptional(health, p) {
  const wantTib = health.tibber_connected || health.mode === 'demo';
  const wantHa = health.ha_connected || health.mode === 'demo';
  // each result redraws its own cards – right away if their tab is visible,
  // otherwise when that tab is opened (see paintViews)
  api('/api/appliances').then(a => { STATE.appliances = a; paintViews(['renderAppliances']); }).catch(() => {});
  api('/api/spot').then(sp => { STATE.spot = sp; paintViews(['renderBorse', 'renderSmart', 'renderKonzept']); }).catch(() => {});
  api('/api/carbon').then(co2 => { STATE.carbon = (co2 && co2.ok) ? co2 : demoCarbon(); paintViews(['renderCarbon']); }).catch(() => {});
  if (wantTib) api('/api/tibber/consumption?resolution=DAILY&last=30')
    .then(t => { STATE.tibberCons = (t && t.ok) ? t : null; paintViews(['renderBorse', 'renderHistory', 'renderKonzept']); }).catch(() => {});
  if (wantHa) api('/api/ha')
    .then(h => { STATE.ha = h || null; paintViews(['renderHa', 'renderOverview']); }).catch(() => {});
  if (health.fronius_connected) loadFronius(true);
}

function applyDemo(mode) {
  STATE.data = demoAnalytics(90);
  STATE.hpA = demoHpAnalytics(90);
  STATE.ov = demoOverview(STATE.data, STATE.hpA);
  STATE.appliances = { connected: true, appliances: [
    { id: 'demo-washer', name: 'Waschmaschine', type: 'WM', brand: 'AEG', model: 'LR8E75495',
      state: 'READY_TO_START', cycles: 429, total_kwh: 343.2, today_kwh: 0.8, cycle_kwh: 0.8,
      energy_estimated: true },
  ] };
  const nowS = Math.floor(Date.now() / 1000);
  STATE.meter = [{ ts: nowS - 8 * 86400, kwh: 2202, note: '' },
                 { ts: nowS, kwh: 2202 + 8 * 17, note: '' }];
  const h0 = nowS - (nowS % 3600), sv = 19, sc = 15;
  const prices = [];
  for (let i = 0; i < 48; i++) {
    const ts = h0 + i * 3600, h = new Date(ts * 1000).getHours();
    let m = 8 + 6 * Math.exp(-((h - 8) ** 2) / 5) + 8 * Math.exp(-((h - 19) ** 2) / 8)
      - 4 * Math.exp(-((h - 13) ** 2) / 9) - 3 * Math.exp(-((h - 3) ** 2) / 12) + 1.2 * Math.sin(i / 2);
    m = Math.max(-2, m);
    prices.push({ ts, market_ct: Math.round(m * 10) / 10, consumer_ct: Math.round((m * (1 + sv / 100) + sc) * 100) / 100 });
  }
  // synthetic 12×24 market-price grid (ct/kWh, pre-tax) so the "lohnt sich?" card
  // has seasonal shape in demo: winter dearer, midday cheap (PV/wind), peaks am/pm.
  const mBase = [11, 10.5, 9.5, 8, 7, 6.5, 6.5, 7, 8.5, 9.5, 10.5, 11.5];
  const hShape = [];
  for (let h = 0; h < 24; h++) {
    hShape.push(1 + 0.55 * Math.exp(-((h - 8) ** 2) / 4) + 0.65 * Math.exp(-((h - 19) ** 2) / 6)
      - 0.45 * Math.exp(-((h - 13) ** 2) / 10) - 0.35 * Math.exp(-((h - 3) ** 2) / 14));
  }
  const month_hour_ct = mBase.map(b => hShape.map(f => Math.round(Math.max(-2, b * f) * 10) / 10));
  STATE.spot = { enabled: true, demo: true, market: 'demo', surcharge_ct: sc, vat: sv, prices,
    month_hour_ct, hist_hours: 400 * 24 };
  STATE.carbon = demoCarbon();
  // synthetic whole-house consumption (as Tibber would report)
  const tNodes = [];
  const midnight = nowS - (nowS % 86400);
  for (let i = 29; i >= 0; i--) {
    const ts = midnight - i * 86400, kwh = Math.round((16 + 3 * Math.sin((29 - i) / 3)) * 1000) / 1000;
    tNodes.push({ ts, kwh, cost: Math.round(kwh * 0.30 * 1000) / 1000, unit_ct: 30 });
  }
  STATE.tibberCons = { ok: true, demo: true, resolution: 'DAILY', nodes: tNodes,
    total_kwh: Math.round(tNodes.reduce((a, n) => a + n.kwh, 0) * 100) / 100,
    total_cost: Math.round(tNodes.reduce((a, n) => a + n.cost, 0) * 100) / 100 };
  STATE.ha = { available: true, connected: true, demo: true, entities: [
    { entity_id: 'sensor.hauptzaehler_power', name: 'Hauptzähler – Leistung', kind: 'power', unit: 'W', watt: 612 },
    { entity_id: 'sensor.hauptzaehler_energy', name: 'Hauptzähler – Energie', kind: 'energy', unit: 'kWh', kwh: 2502.0 },
    { entity_id: 'sensor.fridge_power', name: 'Kühlschrank – Leistung', kind: 'power', unit: 'W', watt: 78 }] };
  STATE.cur = '€'; $('cur').textContent = STATE.cur;
  setMode(mode);
  renderAll();
}

function setMode(m) {
  const el = $('mode');
  const cls = { live: 'live', demo: 'demo', idle: 'demo', err: 'err' }[m] || 'err';
  const txt = { live: '● Live', demo: '◆ Demo', idle: '⚙︎ Setup nötig', err: '⚠︎ Offline' }[m] || '⚠︎ Offline';
  el.className = 'pill ' + cls;
  el.textContent = txt;
}

/* -------------------------------------------------------------- SVG charts */
const CW = 520;
// Embed per-index detail so a single global handler can show the exact value on
// tap/hover for ANY chart (see _chartReadout). meta = {kind, pad, n, h, tips[]}.
function _cdAttr(meta) {
  return JSON.stringify(meta).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}
function svg(h, inner, meta, tsMeta, hcMeta) {
  let attr = meta ? ` data-cd='${_cdAttr(meta)}'` : '';
  if (tsMeta) attr += ` data-ts='${_cdAttr(tsMeta)}'`;
  if (hcMeta) attr += ` data-hc='${_cdAttr(hcMeta)}'`;
  // transparent hit layer so a tap/hover anywhere on the plot (not only on a bar
  // or line) triggers the value readout; harmless when no readout is attached
  const hit = (meta || tsMeta || hcMeta) ? `<rect x="0" y="0" width="${CW}" height="${h}" fill="transparent" pointer-events="all"/>` : '';
  return `<svg viewBox="0 0 ${CW} ${h}" preserveAspectRatio="none" role="img"${attr}>${hit}${inner}</svg>`;
}
// Tap/hover anywhere on a chart → read the exact value at that x-position in the
// bottom toast, with a vertical marker line on the chart. Works for every chart
// drawn through the generic builders (they attach data-cd via svg()). Browser-
// independent; one delegated listener instead of per-chart wiring.
function _cdClear() { try { document.querySelectorAll('svg .cd-cursor').forEach(l => l.remove()); } catch (e) {} }
function _chartReadout(e) {
  const el = e.target && e.target.closest && e.target.closest('svg[data-cd]');
  if (!el) return;
  let meta; try { meta = JSON.parse(el.dataset.cd); } catch (err) { return; }
  if (!meta || !meta.tips || !meta.tips.length) return;
  const rect = el.getBoundingClientRect(); if (!rect.width) return;
  const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
  const px = Math.min(1, Math.max(0, (cx - rect.left) / rect.width)) * CW;  // viewBox x
  const n = meta.n, pad = meta.pad || 26;
  let i, mark;
  if (meta.kind === 'area') {
    const span = Math.max(1, CW - pad - (meta.padR != null ? meta.padR : 6));
    i = Math.round((px - pad) / span * (n - 1));
    i = Math.min(n - 1, Math.max(0, i));
    mark = pad + span * (n <= 1 ? 0 : i / (n - 1));
  } else {
    const bw = (CW - pad * 2) / Math.max(1, n);
    i = Math.floor((px - pad) / bw);
    i = Math.min(n - 1, Math.max(0, i));
    mark = pad + i * bw + bw / 2;
  }
  const tip = meta.tips[i]; if (tip == null) return;
  const t = $('toast');
  if (t) { t.innerHTML = tip; t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; _cdClear(); }, 6000); }
  _cdClear();
  try {
    const vbH = (el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.height) || meta.h || 200;
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('class', 'cd-cursor');
    ln.setAttribute('x1', mark.toFixed(1)); ln.setAttribute('x2', mark.toFixed(1));
    ln.setAttribute('y1', '0'); ln.setAttribute('y2', String(vbH));
    el.appendChild(ln);
  } catch (err) {}
  e.stopPropagation();
}
// Time-series readout: for charts whose x-axis is real time with irregular
// points (room temperatures, WP history). Carries data-ts = {t0,t1,padL,padR,
// series:[{name,color,unit,pts:[[ts,val],…]}]}. Tap/hover → nearest value per
// series at that moment, a weekday+clock title, and a vertical marker line.
function _tsReadout(e) {
  const el = e.target && e.target.closest && e.target.closest('svg[data-ts]');
  if (!el) return;
  let m; try { m = JSON.parse(el.dataset.ts); } catch (err) { return; }
  if (!m || !m.series || !m.series.length || !(m.t1 > m.t0)) return;
  const rect = el.getBoundingClientRect(); if (!rect.width) return;
  const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
  const px = Math.min(1, Math.max(0, (cx - rect.left) / rect.width)) * CW;
  const padL = m.padL != null ? m.padL : 26, padR = m.padR != null ? m.padR : 10;
  const plotW = Math.max(1, CW - padL - padR);
  const frac = Math.min(1, Math.max(0, (px - padL) / plotW));
  const t = m.t0 + frac * (m.t1 - m.t0);
  const tol = (m.t1 - m.t0) * 0.08;             // only report a series with a point near the cursor
  const parts = [];
  m.series.forEach(s => {
    let best = null, bd = Infinity;
    for (const p of (s.pts || [])) { const d = Math.abs(p[0] - t); if (d < bd) { bd = d; best = p; } }
    if (best && bd <= tol) parts.push(`<span style="color:${s.color}">●</span> ${esc(s.name)} <b>${fmt(best[1], 1)}${s.unit || ''}</b>`);
  });
  if (!parts.length) return;
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const dt = new Date(t * 1000), p2 = x => String(x).padStart(2, '0');
  const title = `${WD[dt.getDay()]} ${p2(dt.getHours())}:${p2(dt.getMinutes())}`;
  const t2 = $('toast');
  if (t2) { t2.innerHTML = `<b>${title}</b><div class="note" style="margin-top:2px">${parts.join(' · ')}</div>`; t2.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t2.hidden = true; _cdClear(); }, 6000); }
  _cdClear();
  try {
    const vbH = (el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.height) || m.h || 200;
    const markX = padL + frac * plotW;
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('class', 'cd-cursor');
    ln.setAttribute('x1', markX.toFixed(1)); ln.setAttribute('x2', markX.toFixed(1));
    ln.setAttribute('y1', '0'); ln.setAttribute('y2', String(vbH));
    el.appendChild(ln);
  } catch (err) {}
  e.stopPropagation();
}
// Heating-curve readout: the x-axis is OUTDOOR temperature (reversed, warm +20
// left → cold −10 right), y is the Vorlauf. Tap/hover → the flow temp each curve
// predicts at that outdoor temp (Zielband, gemessen, Geräte-Kurve) plus the
// nearest measured point. Carries data-hc = {padL,padR,h,XL,XR,YB,YT,
// lines:[{name,color,kind?,a?,b?}], dots:[[outdoor,vorlauf],…]}.
function _hcReadout(e) {
  const el = e.target && e.target.closest && e.target.closest('svg[data-hc]');
  if (!el) return;
  let m; try { m = JSON.parse(el.dataset.hc); } catch (err) { return; }
  if (!m) return;
  const rect = el.getBoundingClientRect(); if (!rect.width) return;
  const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
  const px = Math.min(1, Math.max(0, (cx - rect.left) / rect.width)) * CW;
  const padL = m.padL != null ? m.padL : 30, padR = m.padR != null ? m.padR : 10;
  const plotW = Math.max(1, CW - padL - padR);
  const frac = Math.min(1, Math.max(0, (px - padL) / plotW));
  const o = m.XL - frac * (m.XL - m.XR);              // outdoor temp under the cursor
  const parts = [];
  (m.lines || []).forEach(L => {
    let v;
    if (L.kind === 'ideal') v = Math.max(28, Math.min(45, 30 + (18 - o) * 0.45));
    else if (L.a != null) v = L.a * o + L.b;
    else return;
    parts.push(`<span style="color:${L.color}">●</span> ${esc(L.name)} <b>${fmt(v, 1)}°</b>`);
  });
  if (m.dots && m.dots.length) {                       // nearest measured point (~1.5 °C outdoor)
    let best = null, bd = Infinity;
    for (const p of m.dots) { const d = Math.abs(p[0] - o); if (d < bd) { bd = d; best = p; } }
    if (best && bd <= 1.5) parts.push(`<span style="color:var(--muted)">○</span> Messpunkt <b>${fmt(best[1], 1)}°</b> <span style="color:var(--muted)">(bei ${fmt(best[0], 1)}°)</span>`);
  }
  if (!parts.length) return;
  const t = $('toast');
  if (t) { t.innerHTML = `<b>Außen ${fmt(o, 1)}°</b><div class="note" style="margin-top:2px">${parts.join(' · ')}</div>`; t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; _cdClear(); }, 6000); }
  _cdClear();
  try {
    const vbH = (el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.height) || m.h || 200;
    const markX = padL + frac * plotW;
    const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    ln.setAttribute('class', 'cd-cursor');
    ln.setAttribute('x1', markX.toFixed(1)); ln.setAttribute('x2', markX.toFixed(1));
    ln.setAttribute('y1', '0'); ln.setAttribute('y2', String(vbH));
    el.appendChild(ln);
  } catch (err) {}
  e.stopPropagation();
}
try {
  const onDown = e => { _chartReadout(e); _tsReadout(e); _hcReadout(e); };
  const onMove = e => { if (e.pointerType !== 'mouse' && !(e.buttons & 1)) return; _chartReadout(e); _tsReadout(e); _hcReadout(e); };
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('pointermove', onMove);
} catch (e) {}

// Round a data max up to a "nice" axis maximum with an even step, so gridlines
// read as 0·2·4·6·8 instead of 0·3,65·7,3. target = desired number of divisions.
function niceScale(max, target = 4) {
  if (!(max > 0) || !isFinite(max)) return { max: 1, step: 0.5 };
  const rough = max / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = mult * mag;
  return { max: Math.ceil(max / step - 1e-9) * step, step };
}
// Horizontal gridlines + y-axis labels. Backwards compatible: called with just
// `max` it keeps the old 3-line look. Pass opts.step for evenly-spaced "nice"
// ticks (0..max) and opts.unit to tag the top label with a unit.
function gridLines(h, top, base, pad, max, opts) {
  opts = opts || {};
  let g = '';
  if (opts.step && opts.step > 0 && max > 0) {
    const step = opts.step;
    let dec = 0;                                   // exact decimals for this step (0.25 → 2, 2.5 → 1, 2 → 0)
    for (let d = 0; d <= 3; d++) { const f = step * Math.pow(10, d); if (Math.abs(f - Math.round(f)) < 1e-6) { dec = d; break; } dec = d; }
    const eps = step * 1e-6;
    const vals = [];
    for (let v = 0; v <= max + eps; v += step) vals.push(v);
    vals.forEach((val, i) => {
      const y = base - (base - top) * (val / max);
      g += `<line class="gl" x1="${pad}" x2="${CW - 4}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
      const isTop = i === vals.length - 1;
      const lbl = fmt(val, dec) + (isTop && opts.unit ? ' ' + opts.unit : '');
      g += `<text class="axis" x="0" y="${(y + 3).toFixed(1)}">${lbl}</text>`;
    });
    return g;
  }
  for (let i = 0; i <= 2; i++) {
    const y = top + (base - top) * (i / 2);
    const val = max * (1 - i / 2);
    g += `<line class="gl" x1="${pad}" x2="${CW - 4}" y1="${y}" y2="${y}"/>`;
    g += `<text class="axis" x="0" y="${y + 3}">${val >= 10 ? Math.round(val) : val.toFixed(1)}</text>`;
  }
  return g;
}

function barChart(values, opts = {}) {
  const h = opts.h || 200, pad = 26, top = 12, base = h - 22;
  const n = values.length || 1;
  const sc = niceScale(Math.max(0.0001, ...values.map(v => v.v))), max = sc.max;
  const bw = (CW - pad * 2) / n, iw = Math.max(2, bw * 0.62);
  let bars = '', labels = '';
  values.forEach((d, i) => {
    const bh = (d.v / max) * (base - top);
    const x = pad + i * bw + (bw - iw) / 2, y = base - bh;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2.5" fill="${d.color || 'url(#g1)'}"/>`;
    if (d.label && (n <= 16 || i % Math.ceil(n / 12) === 0))
      labels += `<text class="axis" x="${(x + iw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${d.label}</text>`;
  });
  const tips = values.map(d => d.tip || `<b>${esc(d.full || d.label || '')}</b>: <b>${fmt(d.v, d.v >= 10 ? 0 : 1)}${opts.unit ? (' ' + esc(opts.unit)) : ''}</b>`);
  return svg(h, gridLines(h, top, base, pad, max, { step: sc.step, unit: opts.unit }) + bars + labels, { kind: 'bar', pad, n, h, tips });
}

function stackedBar(rows, series, opts = {}) {
  const h = opts.h || 210, pad = 26, top = 12, base = h - 22;
  const n = rows.length || 1;
  const totals = rows.map(r => series.reduce((a, s) => a + Math.max(0, r.values[s.key] || 0), 0));
  const sc = niceScale(Math.max(0.0001, ...totals)), max = sc.max;
  const bw = (CW - pad * 2) / n, iw = Math.max(2, bw * 0.62);
  let bars = '', labels = '';
  rows.forEach((r, i) => {
    const x = pad + i * bw + (bw - iw) / 2;
    const op = r.estimated ? ' fill-opacity="0.4"' : '';
    let y = base;
    series.forEach(s => {
      const v = Math.max(0, r.values[s.key] || 0);
      if (v <= 0) return;
      const bh = v / max * (base - top);
      y -= bh;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${s.color}"${op}/>`;
    });
    if (r.label && (n <= 16 || i % Math.ceil(n / 12) === 0))
      labels += `<text class="axis" x="${(x + iw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${r.label}</text>`;
  });
  const tips = rows.map(r => _seriesTip(r, series, opts));
  return svg(h, gridLines(h, top, base, pad, max, { step: sc.step, unit: opts.unit }) + bars + labels, { kind: 'bar', pad, n, h, tips });
}

// shared detail string for stacked/grouped bars: x-label + each series value
function _seriesTip(r, series, opts) {
  const parts = series.map(s => {
    const name = s.label || SERIES_LABEL[s.key] || s.key;
    return `<span style="color:${s.color}">●</span> ${esc(name)} <b>${fmt(r.values[s.key] || 0, opts.dec != null ? opts.dec : 1)}${opts.unit ? (' ' + esc(opts.unit)) : ''}</b>`;
  });
  return `<b>${esc(r.full || r.label || '')}</b><div class="note" style="margin-top:2px">${parts.join(' · ')}</div>`;
}

function groupedBar(rows, series, opts = {}) {
  const h = opts.h || 200, pad = 26, top = 12, base = h - 22;
  const n = rows.length || 1;
  const sc = niceScale(Math.max(0.0001, ...rows.map(r => Math.max(...series.map(s => r.values[s.key] || 0))))), max = sc.max;
  const gw = (CW - pad * 2) / n, iw = Math.max(1.5, (gw * 0.7) / series.length);
  let bars = '', labels = '';
  rows.forEach((r, i) => {
    const gx = pad + i * gw + gw * 0.15;
    series.forEach((s, k) => {
      const v = Math.max(0, r.values[s.key] || 0);
      const bh = v / max * (base - top), x = gx + k * iw, y = base - bh;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="1.5" fill="${s.color}"/>`;
    });
    if (r.label && (n <= 16 || i % Math.ceil(n / 12) === 0))
      labels += `<text class="axis" x="${(gx + series.length * iw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${r.label}</text>`;
  });
  const tips = rows.map(r => _seriesTip(r, series, opts));
  return svg(h, gridLines(h, top, base, pad, max, { step: sc.step, unit: opts.unit }) + bars + labels, { kind: 'bar', pad, n, h, tips });
}

function areaChart(values, opts = {}) {
  const h = opts.h || 200, pad = 26, top = 12, base = h - 22;
  const n = values.length;
  const sc = niceScale(Math.max(0.0001, ...values.map(v => v.v))), max = sc.max;
  const X = i => pad + (CW - pad - 6) * (n <= 1 ? 0 : i / (n - 1));
  const Y = v => top + (base - top) * (1 - v / max);
  let line = '';
  values.forEach((d, i) => { line += `${i === 0 ? 'M' : 'L'}${X(i).toFixed(1)} ${Y(d.v).toFixed(1)} `; });
  const area = `M${X(0).toFixed(1)} ${base} ` + line.replace('M', 'L') + ` L${X(n - 1).toFixed(1)} ${base} Z`;
  let labels = '';
  values.forEach((d, i) => {
    if (d.label && i % Math.ceil(n / 8) === 0)
      labels += `<text class="axis" x="${X(i).toFixed(1)}" y="${h - 8}" text-anchor="middle">${d.label}</text>`;
  });
  const tips = values.map(d => d.tip || `<b>${esc(d.full || d.label || '')}</b>: <b>${fmt(d.v, d.v >= 10 ? 0 : 1)}${opts.unit ? (' ' + esc(opts.unit)) : ''}</b>`);
  return svg(h, gridLines(h, top, base, pad, max, { step: sc.step, unit: opts.unit }) +
    `<path d="${area}" fill="${opts.fill || 'url(#gArea)'}" opacity="0.55"/>` +
    `<path d="${line}" fill="none" stroke="${opts.stroke || 'url(#g1)'}" stroke-width="2.5" stroke-linejoin="round"/>` +
    labels, { kind: 'area', pad, n, h, tips });
}

function heatmap(grid) {
  const h = 190, left = 30, top = 6, cellH = (h - top - 18) / 7, cellW = (CW - left - 6) / 24;
  let max = 0.0001;
  grid.forEach(r => r.forEach(v => { if (v > max) max = v; }));
  let cells = '', ylab = '', xlab = '';
  grid.forEach((row, wd) => {
    row.forEach((v, hh) => {
      cells += `<rect x="${(left + hh * cellW).toFixed(1)}" y="${(top + wd * cellH).toFixed(1)}" width="${cellW + 0.5}" height="${cellH + 0.5}" fill="${heatColor(v / max)}"/>`;
    });
    ylab += `<text class="axis" x="0" y="${(top + wd * cellH + cellH / 2 + 3).toFixed(1)}">${WD[wd]}</text>`;
  });
  for (let hh = 0; hh < 24; hh += 4)
    xlab += `<text class="axis" x="${(left + hh * cellW).toFixed(1)}" y="${h - 4}">${hh}</text>`;
  return svg(h, cells + ylab + xlab);
}
// Calendar heatmap: one row per month, 31 day-columns, coloured by daily kWh.
function calendarHeatmap(rows) {
  const left = 34, top = 6, cellH = 15, gap = 1;
  const cols = 31, cellW = (CW - left - 6) / cols;
  const h = top + rows.length * cellH + 16;
  let max = 0.0001;
  rows.forEach(r => r.days.forEach(d => { if (d.v != null && d.v > max) max = d.v; }));
  let cells = '', ylab = '', xlab = '';
  rows.forEach((r, ri) => {
    const y = top + ri * cellH;
    for (let dd = 1; dd <= r.dim; dd++) {
      const d = r.days[dd - 1];
      const x = left + (dd - 1) * cellW;
      const col = (d && d.v != null) ? (d.v > 0 ? heatColor(d.v / max) : 'rgb(28,42,73)') : '#131c31';
      cells += `<rect x="${x.toFixed(1)}" y="${y}" width="${(cellW - gap).toFixed(1)}" height="${cellH - gap}" rx="1.5" fill="${col}"/>`;
    }
    ylab += `<text class="axis" x="0" y="${(y + cellH / 2 + 3).toFixed(1)}">${r.label}</text>`;
  });
  for (let dd = 1; dd <= 31; dd += 7) xlab += `<text class="axis" x="${(left + (dd - 1) * cellW).toFixed(1)}" y="${h - 3}">${dd}</text>`;
  return svg(h, cells + ylab + xlab);
}
function heatColor(t) {
  t = Math.max(0, Math.min(1, t));
  const stops = [[22, 33, 60], [43, 108, 176], [75, 224, 176], [255, 182, 77]];
  const seg = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(seg)), f = seg - i;
  const c = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function donutChart(segs, opts = {}) {
  const list = segs.filter(s => s.value > 0);
  const total = list.reduce((a, s) => a + s.value, 0) || 1;
  const cx = 100, cy = 100, R = 88, r = 56;
  const pol = (rad, a) => ({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
  let paths = '', a0 = -Math.PI / 2;
  if (list.length === 1) {
    paths = `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${list[0].color}" stroke-width="${R - r}"/>`;
  } else {
    list.forEach(s => {
      const a1 = a0 + (s.value / total) * 2 * Math.PI, large = (a1 - a0) > Math.PI ? 1 : 0;
      const o0 = pol(R, a0), o1 = pol(R, a1), i1 = pol(r, a1), i0 = pol(r, a0);
      paths += `<path d="M${o0.x.toFixed(1)} ${o0.y.toFixed(1)} A${R} ${R} 0 ${large} 1 ${o1.x.toFixed(1)} ${o1.y.toFixed(1)} L${i1.x.toFixed(1)} ${i1.y.toFixed(1)} A${r} ${r} 0 ${large} 0 ${i0.x.toFixed(1)} ${i0.y.toFixed(1)} Z" fill="${s.color}"/>`;
      a0 = a1;
    });
  }
  return `<svg viewBox="0 0 200 200" style="display:block;max-width:210px;margin:4px auto">${paths}` +
    `<text x="100" y="97" text-anchor="middle" class="donut-v">${opts.big || ''}</text>` +
    `<text x="100" y="119" text-anchor="middle" class="donut-l">${opts.center || ''}</text></svg>`;
}

const HP_GAP_COL = '#8b93a1';   // heat-pump energy from a data gap: amount known, mode not
// hot-water kWh of a mode split, plus the same share of the gap energy (the
// bridge counted it, but could not see the mode while it was unreachable)
function mwWater(mw) {
  if (!mw) return 0;
  const w = mw.water || 0, known = (mw.heating || 0) + w + (mw.other || 0);
  return w + (known > 0 ? (mw.gap || 0) * w / known : 0);
}
function hpGapNote(gap) {
  return `<br><span style="color:var(--muted)">Grau: <b>${kwh(gap, 1)}</b> aus Datenlücken – der Zähler hat sie erfasst, ` +
    'die Bridge hat die Wärmepumpe in der Zeit aber nicht erreicht. Für die Jahreswerte wird sie wie der Rest aufgeteilt.</span>';
}
function legendHtml(items) {
  return items.map(it => `<div class="it"><span class="sw" style="background:${it.color}"></span>${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</div>`).join('');
}
function statusRow(k, v) { return `<div class="statusrow"><span class="k">${k}</span><span class="v">${v}</span></div>`; }
const AEG_STATE = {
  RUNNING: ['läuft', '#4be0b0'], RUN: ['läuft', '#4be0b0'], ON: ['läuft', '#4be0b0'],
  OFF: ['aus', 'var(--muted)'], IDLE: ['bereit', '#4da3ff'], READY: ['bereit', '#4da3ff'],
  READYTOSTART: ['bereit', '#4da3ff'], STANDBY: ['Standby', 'var(--muted)'],
  END: ['fertig', '#f6b93b'], ENDOFCYCLE: ['fertig', '#f6b93b'], PAUSE: ['Pause', '#f6b93b'],
  PAUSED: ['Pause', '#f6b93b'], DELAYEDSTART: ['Startvorwahl', '#f6b93b'],
};
function aegStateLabel(s) {
  if (!s) return ['–', 'var(--muted)'];
  const key = String(s).toUpperCase().replace(/[^A-Z]/g, '');
  return AEG_STATE[key] || [String(s).toLowerCase().replace(/_/g, ' '), 'var(--muted)'];
}
// Prettify an AEG program UID, e.g. "COTTON_PR_ECO40-60" → "Eco40-60".
function aegProgram(p) {
  if (!p) return '';
  let s = String(p).replace(/_PR_/, ' ').replace(/_/g, ' ').trim();
  const parts = s.split(' ');
  s = parts[parts.length - 1] || s;                 // keep the meaningful tail
  return s.charAt(0) + s.slice(1).toLowerCase();
}
// Cheapest ~2 h delay-start window in the next hours for a wash of `kwh`,
// reusing the Smart-Timer's aligned price series. Returns null if no data.
function aegBestStart(kwh) {
  if (typeof smartHours !== 'function') return null;
  const hrs = smartHours(); if (!hrs || hrs.length < 2) return null;
  const dur = 2, now = Date.now() / 1000;
  let best = null, nowCost = null;
  for (let s = 0; s + dur <= hrs.length; s++) {
    const c = hrs.slice(s, s + dur).reduce((a, o) => a + o.price, 0) / dur;
    if (s === 0) nowCost = c;
    if (!best || c < best.c) best = { c, ts: hrs[s].ts };
  }
  if (!best) return null;
  const future = best.ts > now + 1800;
  const save = future ? Math.max(0, (nowCost - best.c) / 100 * (kwh || 1)) : 0;
  const d = new Date(best.ts * 1000);
  const timeLabel = future
    ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'
    : 'jetzt';
  return { timeLabel, save, source: (STATE.spot && STATE.spot.source) || 'spot', future };
}

function renderAppliances() {
  const card = $('ov-aeg-card'); if (!card) return;
  // AEG/Electrolux integration is currently hidden (brings no value for this
  // setup). Code + bridge stay intact so it can be re-enabled later; for now
  // the overview card never appears.
  card.hidden = true; return;
  const list = (STATE.appliances && STATE.appliances.appliances) || [];
  if (!list.length) { card.hidden = true; return; }
  card.hidden = false;
  let todaySum = 0, anyEst = false;
  const rows = list.map(a => {
    const [lbl, col] = aegStateLabel(a.state);
    const est = !!a.energy_estimated;
    if (est) anyEst = true;
    const today = a.today_kwh != null ? a.today_kwh : null;
    if (today != null) todaySum += today;
    const sub = [];
    if (lbl === 'läuft') {
      if (a.program) sub.push(esc(aegProgram(a.program)));
      if (a.time_to_end_min) sub.push('noch ' + Math.round(a.time_to_end_min / 60 * 10) / 10 + ' h');
    }
    if (a.cycles != null) sub.push(fmt(a.cycles, 0) + ' Waschgänge');
    if (a.total_kwh != null) sub.push((est ? '≈ ' : '') + 'gesamt ' + kwh(a.total_kwh, 0));
    const valTop = today != null ? (est ? '≈ ' : '') + kwh(today, 2) : '–';
    const valBot = today != null && today > 0 ? money(today * STATE.price) : '';
    return `<div class="devrow"><div class="nm">` +
      `<b>${esc(a.name || a.id)} <span style="color:${col};font-weight:600">· ${lbl}</span></b>` +
      `<small>${sub.join(' · ') || (a.brand ? esc(a.brand) : '')}</small></div>` +
      `<div class="val"><b>${valTop}</b>${valBot ? `<small>${valBot}</small>` : ''}</div></div>`;
  }).join('');
  $('ov-aeg-body').innerHTML = rows;
  $('ov-aeg-sum').textContent = todaySum > 0 ? (anyEst ? '≈ ' : '') + kwh(todaySum, 2) + ' heute' : '';
  // delay-start recommendation for an appliance that is ready but not running
  let recTip = '';
  const ready = list.find(a => /READY|IDLE|OFF|STANDBY/i.test(a.state || '') && !/RUN/i.test(a.state || ''));
  if (ready && typeof smartHours === 'function') {
    const rec = aegBestStart(ready.cycle_kwh || 1);
    if (rec) recTip = `<div class="note" style="margin-bottom:8px">🕒 <b>Günstigster Start</b> für „${esc(ready.name || 'Gerät')}": ` +
      `<b>${rec.timeLabel}</b> (Verzögerungsstart)` +
      (rec.save > 0.02 ? ` – spart ~<b>${money(rec.save)}</b> ggü. jetzt` : '') +
      (rec.source === 'tibber' ? ' · echte Tibber-Preise' : '') + `. Mehr im <b>Smart-Timer</b> (Börse).</div>`;
  }
  const err = STATE.appliances && STATE.appliances.last_error;
  $('ov-aeg-note').innerHTML = recTip + (err
    ? '<span style="color:#ff6b8a">Letzter Fehler: ' + esc(err) + '</span>'
    : (anyEst
      ? '„≈" = <b>geschätzt</b>: dein Gerät meldet keinen kWh-Wert, daher rechnet die App ' +
        '<b>Waschgänge × ø kWh/Gang</b> (im Setup anpassbar). „Heute" = neue Waschgänge seit Mitternacht.'
      : 'Strom pro Waschgang & gesamt aus der AEG/Electrolux-Cloud. „Heute" = Zuwachs des Gesamtzählers seit Mitternacht.'));
}
// Home Assistant power/energy sensors (e.g. a Koogeek plug via HA's HomeKit
// Controller), shown live on the overview.
function renderHa() {
  const card = $('ov-ha-card'); if (!card) return;
  const ha = STATE.ha;
  const ents = (ha && ha.entities) || [];
  if (!ha || !ha.connected || !ents.length) { card.hidden = true; return; }
  card.hidden = false;
  const price = STATE.price;
  const powers = ents.filter(e => e.kind === 'power' && e.watt != null);
  const energies = ents.filter(e => e.kind === 'energy' && e.kwh != null);
  const energyByPrefix = {};
  energies.forEach(e => { energyByPrefix[e.entity_id.replace(/_energy$/i, '')] = e; });
  const rows = powers.map(e => {
    const w = e.watt;
    const en = energyByPrefix[e.entity_id.replace(/_power$/i, '')];
    const sub = [`${fmt(w, 0)} W jetzt`];
    if (en) sub.push(`Zähler ${kwh(en.kwh, 0)}`);
    // rough running cost if this load stayed constant
    const yearCost = w / 1000 * 8760 * price;
    return `<div class="devrow"><div class="nm"><b>${esc(e.name)}</b><small>${sub.join(' · ')}</small></div>` +
      `<div class="val"><b>${fmt(w, 0)} W</b>${w > 1 ? `<small>~${money(yearCost)}/J bei Dauerlauf</small>` : ''}</div></div>`;
  });
  // energy-only sensors without a matching power sensor
  energies.filter(e => !powers.some(pw => pw.entity_id.replace(/_power$/i, '') === e.entity_id.replace(/_energy$/i, '')))
    .forEach(e => rows.push(`<div class="devrow"><div class="nm"><b>${esc(e.name)}</b><small>Energiezähler</small></div>` +
      `<div class="val"><b>${kwh(e.kwh, 0)}</b></div></div>`));
  $('ov-ha-body').innerHTML = rows.join('') || '<div class="note">Keine Leistungs-/Energiesensoren gefunden.</div>';
  const totW = powers.reduce((a, e) => a + e.watt, 0);
  $('ov-ha-sum').textContent = powers.length ? fmt(totW, 0) + ' W' : '';
  $('ov-ha-note').innerHTML = (ha.last_error
    ? `<span style="color:#ff6b8a">Letzter Fehler: ${esc(ha.last_error)}</span> · `
    : '') + `Live aus <b>Home Assistant</b>${ha.demo ? ' <span style="color:var(--muted)">(Demo)</span>' : ''}. ` +
    `„W jetzt" ist die aktuelle Leistung; der Jahreswert gilt nur bei Dauerlauf.`;
}

function renderMeter() {
  const list = $('meter-list'), note = $('meter-note'); if (!note) return;
  const di = $('meter-date'); if (di && !di.value) di.value = new Date().toISOString().slice(0, 10);
  const rs = (STATE.meter || []).slice().sort((a, b) => b.ts - a.ts);
  list.innerHTML = rs.length ? rs.map(r =>
    `<div class="statusrow"><span class="k">${longDay(new Date(r.ts * 1000).toISOString().slice(0, 10))}</span>` +
    `<span class="v">${kwh(r.kwh, 0)} <button class="linkbtn meter-del" data-ts="${r.ts}" ` +
    `style="background:none;border:none;color:#ff6b8a;cursor:pointer;font-size:13px">✕</button></span></div>`).join('')
    : '<div class="note">Noch keine Ablesung. Trag oben deinen aktuellen Zählerstand ein – und in ein paar Tagen den nächsten.</div>';
  const s = meterStats();
  if (s && s.dailyAvg != null) {
    const hpDaily = meterHpDaily(s);
    const household = Math.max(0, s.dailyAvg - hpDaily);
    const unmetered = Math.max(0, household - shMeteredDaily());
    note.innerHTML = `Realer Gesamtverbrauch <b>${kwh(s.dailyAvg, 1)}/Tag</b> ` +
      `(~${kwh(s.dailyAvg * 30, 0)}/Monat, ${money(s.dailyAvg * STATE.price)}/Tag), aus ${s.count} Ablesungen ` +
      `über ${fmt(s.spanDays, 0)} Tage. Davon Wärmepumpe ~<b>${kwh(hpDaily, 1)}</b>, Haushalt ~<b>${kwh(household, 1)}</b>/Tag. ` +
      (unmetered > 0.3 ? `Rund <b>${kwh(unmetered, 1)}/Tag</b> Hausstrom messen die Module noch nicht. ` : '') +
      `<b>Prognosen sind jetzt auf diesen Wert kalibriert.</b>`;
  } else if (rs.length === 1) {
    note.innerHTML = 'Erste Ablesung gespeichert ✓ – trag in ein paar Tagen die <b>nächste</b> ein, dann ' +
      'berechnet die App deinen echten Gesamtverbrauch.';
  } else {
    note.textContent = '';
  }
}
// Colour a price by where it sits between the day's min and max.
function spotColor(ct, lo, hi) {
  const t = hi > lo ? (ct - lo) / (hi - lo) : 0.5;
  if (t < 0.33) return '#4be0b0';
  if (t < 0.66) return '#f6b93b';
  return '#ef6c4d';
}
function spotChart(prices, nowTs) {
  const h = 200, pad = 28, top = 14, base = h - 24, n = prices.length || 1;
  const cons = prices.map(p => p.consumer_ct);
  const lo = Math.min(...cons), hi = Math.max(...cons);
  const maxV = Math.max(0.01, hi), minV = Math.min(0, lo);
  const span = maxV - minV || 1;
  const bw = (CW - pad * 2) / n, iw = Math.max(1.5, bw * 0.8);
  const y = v => base - (v - minV) / span * (base - top);
  let bars = '', labels = '', nowLine = '';
  prices.forEach((p, i) => {
    const x = pad + i * bw, yy = y(p.consumer_ct), y0 = y(0);
    bars += `<rect x="${x.toFixed(1)}" y="${Math.min(yy, y0).toFixed(1)}" width="${iw.toFixed(1)}" ` +
      `height="${Math.max(1, Math.abs(yy - y0)).toFixed(1)}" fill="${spotColor(p.consumer_ct, lo, hi)}" rx="1"/>`;
    const hr = new Date(p.ts * 1000).getHours();
    if (hr % 6 === 0) labels += `<text class="axis" x="${(x + iw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${hr}</text>`;
    if (nowTs && p.ts <= nowTs && p.ts + 3600 > nowTs)
      nowLine = `<line x1="${(x + iw / 2).toFixed(1)}" y1="${top}" x2="${(x + iw / 2).toFixed(1)}" y2="${base}" stroke="#fff" stroke-width="1.5" stroke-dasharray="3 3" opacity="0.8"/>`;
  });
  const gy = y(0);
  const zero = minV < 0 ? `<line x1="${pad}" y1="${gy.toFixed(1)}" x2="${CW - pad}" y2="${gy.toFixed(1)}" stroke="var(--line)"/>` : '';
  return svg(h, `<text class="axis" x="2" y="${top + 4}">${fmt(hi, 0)}ct</text>` +
    `<text class="axis" x="2" y="${base}">${fmt(Math.max(0, minV), 0)}</text>` + zero + bars + nowLine + labels);
}
// Live verdict for the CURRENT hour: is now a good moment to run flexible
// loads? Combines the price tercile (from the day-ahead window) with the grid
// CO₂ tercile (from the model's hourly curve).
function renderNowSignal(nowP, lo, hi) {
  const banner = $('borse-now-banner'); if (!banner || !nowP) return;
  const tercile = (v, a, b) => v <= a + (b - a) / 3 ? 0 : v >= a + 2 * (b - a) / 3 ? 2 : 1;   // 0 green,1 mid,2 red
  const pT = tercile(nowP.consumer_ct, lo, hi);
  const c = STATE.carbon;
  let cT = null, coNow = null;
  if (c && c.hour_g) {
    const hr = new Date().getHours(); coNow = c.hour_g[hr];
    const clo = Math.min(...c.hour_g), chi = Math.max(...c.hour_g);
    cT = tercile(coNow, clo, chi);
  }
  const score = cT == null ? pT : (pT + cT) / 2;          // combined 0..2
  const col = score <= 0.7 ? '#4be0b0' : score >= 1.4 ? '#ef6c4d' : '#f6b93b';
  const icon = score <= 0.7 ? '🟢' : score >= 1.4 ? '🔴' : '🟡';
  const priceWord = ['günstig', 'mittel', 'teuer'][pT];
  const co2Word = cT == null ? null : ['grün', 'mittel', 'grau'][cT];
  const verdict = score <= 0.7 ? 'Guter Moment – jetzt Waschmaschine, Warmwasser oder E-Auto laufen lassen.'
    : score >= 1.4 ? 'Eher warten – Strom ist teuer' + (co2Word ? ' und grau' : '') + '. Flexible Lasten später.'
      : 'Mittel – geht, aber es gibt heute günstigere/grünere Stunden (siehe unten).';
  banner.innerHTML =
    `<div style="display:flex;align-items:center;gap:12px">` +
    `<div style="font-size:30px;line-height:1">${icon}</div>` +
    `<div style="flex:1"><div style="font-size:16px;font-weight:700;color:${col}">Jetzt: ${fmt(nowP.consumer_ct, 1)} ct/kWh · ${priceWord}` +
    (co2Word ? ` · ${fmt(coNow, 0)} g CO₂ · ${co2Word}` : '') + `</div>` +
    `<div class="note" style="margin-top:2px">${verdict}</div></div></div>`;
}

// Consumer price grid (12×24, ct/kWh) from the stored market-price shape, with
// gap-filling, so the spot-tariff cost model covers a realistic seasonal day.
function spotPriceGrid() {
  const sp = STATE.spot;
  if (!sp || !sp.month_hour_ct) return null;
  const vat = (sp.vat != null ? sp.vat : 19) / 100;
  const surch = (sp.surcharge_ct != null ? sp.surcharge_ct : 15);
  const raw = sp.month_hour_ct;
  let allSum = 0, allN = 0; const mAvg = [];
  for (let m = 0; m < 12; m++) {
    let s = 0, n = 0;
    for (let h = 0; h < 24; h++) { const v = raw[m] ? raw[m][h] : null; if (v != null) { s += v; n++; allSum += v; allN++; } }
    mAvg[m] = n ? s / n : null;
  }
  const overall = allN ? allSum / allN : (sp.hist_market_ct || sp.typical_market_ct || 8);
  const grid = [];
  for (let m = 0; m < 12; m++) {
    grid[m] = [];
    for (let h = 0; h < 24; h++) {
      let v = raw[m] ? raw[m][h] : null;
      if (v == null) v = (mAvg[m] != null ? mAvg[m] : overall);
      grid[m][h] = v * (1 + vat) + surch;           // consumer ct/kWh
    }
  }
  return { grid, hours: sp.hist_hours || 0 };
}
// Is a dynamic (spot) tariff worth it for THIS household? Uses the real load
// profile + PV/battery (current PV-tab dimensions) and the seasonal price shape.
function spotWorthIt() {
  const pg = spotPriceGrid(); if (!pg) return null;
  const p = pvInputs();
  const fixPrice = STATE.price || 0.35;              // €/kWh fixed tariff
  const base = Object.assign({}, p, { priceGrid: pg.grid });
  const withPv = simulatePv(base);
  const noPv = simulatePv(Object.assign({}, base, { kwp: 0, batt: 0 }));
  const hasPv = p.kwp > 0;
  const mk = sim => ({ grid: sim.grid_kwh, fix: sim.grid_kwh * fixPrice, spot: sim.spot_cost });
  const withCost = mk(withPv), noCost = mk(noPv);
  const cur = hasPv ? withCost : noCost;
  const spotSwitch = cur.fix - cur.spot;             // €/yr saved by switching to spot
  const diffNoPv = noCost.fix - noCost.spot;
  let battExtra = null;
  if (hasPv) {
    const bb = simulatePv(Object.assign({}, base, { batt: p.batt + 3 }));
    battExtra = bb.benefit - withPv.benefit;         // €/yr extra self-use from +3 kWh
  }
  // price spread & load-shift potential (cheapest 6 h per day vs daily average)
  let sumAll = 0, nAll = 0, cheapSum = 0, cheapN = 0;
  for (let m = 0; m < 12; m++) {
    const row = pg.grid[m].slice().sort((a, b) => a - b);
    for (let h = 0; h < 24; h++) { sumAll += pg.grid[m][h]; nAll++; }
    for (let h = 0; h < 6; h++) { cheapSum += row[h]; cheapN++; }
  }
  const avgCt = sumAll / nAll, cheapCt = cheapSum / cheapN;
  const hpAnnual = (typeof hpAvgDaily === 'function' ? hpAvgDaily() : 0) * 365;
  const flexible = Math.max(0, Math.min(cur.grid, 0.7 * (hpAnnual + p.evAnnual)));
  const shiftSave = flexible * (avgCt - cheapCt) / 100;
  return { pg, hasPv, withCost, noCost, cur, spotSwitch, diffNoPv, battExtra,
    fixPrice, avgCt, cheapCt, spread: avgCt - cheapCt, flexible, shiftSave, batt: p.batt };
}
function renderBorseWorth() {
  const card = $('borse-worth-card'); if (!card) return;
  let w; try { w = spotWorthIt(); } catch (e) { w = null; }
  if (!w) { card.hidden = true; return; }
  card.hidden = false;
  const kpi = (val, lbl, col) => `<div class="kpi sm"><div class="v"${col ? ` style="color:${col}"` : ''}>${val}</div><div class="l">${lbl}</div></div>`;
  const diff = w.spotSwitch, absFix = w.cur.fix || 1;
  let head, hcol;
  if (diff > Math.max(30, 0.04 * absFix)) { head = `✅ Börsenstrom spart dir ~<b>${money(diff)}/Jahr</b>`; hcol = '#4be0b0'; }
  else if (diff < -Math.max(20, 0.02 * absFix)) { head = `❌ Börsenstrom ist ~<b>${money(-diff)}/Jahr teurer</b> – lohnt sich für dich <b>nicht</b>`; hcol = '#ff6b8a'; }
  else { head = `➖ Börse ≈ Festtarif (±${money(Math.abs(diff))}/Jahr) – lohnt sich <b>kaum</b>`; hcol = '#ffb64d'; }
  $('borse-worth-verdict').innerHTML = `<div style="font-weight:700;font-size:15px;color:${hcol};line-height:1.4">${head}</div>` +
    `<div class="note" style="margin-top:3px">Verglichen mit deinem Festtarif (${fmt(w.fixPrice * 100, 1)} ct/kWh), bei deinem Verbrauch${w.hasPv ? ' + deiner PV/Speicher' : ' (ohne PV)'}.</div>`;
  const effCt = w.cur.grid > 0 ? w.cur.spot / w.cur.grid * 100 : w.avgCt;
  $('borse-worth-kpi').innerHTML = `<div class="grid2" style="gap:8px">` +
    kpi(money(w.cur.fix), 'Festtarif €/Jahr') +
    kpi(money(w.cur.spot), 'Börse €/Jahr', hcol) +
    kpi(`${fmt(w.cur.grid, 0)} kWh`, 'Netzbezug/Jahr') +
    kpi(`${fmt(effCt, 1)} ct`, 'dein Ø Börsenpreis (gewichtet)') +
    `</div>`;
  const items = [];
  if (w.hasPv) {
    items.push(`☀️ <b>PV-Effekt:</b> Mit deiner PV wandert der Netzbezug in teure <b>Abend-/Winterstunden</b> – das macht Börse weniger attraktiv. ` +
      `Ohne PV wäre Börse ${w.diffNoPv > diff + 20 ? '<b>eher lohnend</b>' : 'ähnlich'} (${w.diffNoPv >= 0 ? '+' : ''}${money(w.diffNoPv)}/Jahr).`);
  }
  if (w.battExtra != null) {
    const spotGain = Math.max(0, diff);
    if (w.battExtra > spotGain + 20) {
      items.push(`🔋 <b>Speicher schlägt Börse:</b> Ein größerer Speicher (+3 kWh) bringt ~<b>${money(w.battExtra)}/Jahr</b> (mehr Eigenverbrauch) – deutlich mehr als der Börsenwechsel (~${money(spotGain)}/Jahr). <b>Nimm lieber den größeren Speicher.</b>`);
    } else {
      items.push(`🔋 <b>Speicher:</b> +3 kWh brächten ~${money(w.battExtra)}/Jahr Eigenverbrauch. Ein größerer Speicher senkt den Netzbezug weiter – dann lohnt der Tarifwechsel noch weniger.`);
    }
  }
  items.push(`🕒 <b>Lastverschiebung:</b> Schiebst du WP/E-Auto gezielt in die günstigsten Stunden (Ø <b>${fmt(w.cheapCt, 1)}</b> statt ${fmt(w.avgCt, 1)} ct), sind zusätzlich bis ~<b>${money(w.shiftSave)}/Jahr</b> möglich – aber nur mit konsequenter Umstellung (sonst 0).`);
  items.push(`📱 <b>Mit dem Handy vorbereiten:</b> WP-Zeitfenster/Smart-Grid in HomeCom auf die günstigen Nachtstunden legen; Waschmaschine/Trockner/Spülmaschine per Startzeit-Vorwahl nachts; E-Auto-Laden aufs günstige Fenster timen. Den <b>Smart-Timer</b> unten nutzen.`);
  $('borse-worth-body').innerHTML = items.map(t => `<div style="font-size:13px;line-height:1.5;margin-bottom:7px">${t}</div>`).join('');
  $('borse-worth-note').innerHTML = `Modell aus deinem gemessenen Verbrauchsprofil + Börsen-Preisform über <b>${w.pg.hours >= 48 ? Math.round(w.pg.hours / 24) + ' Tage' : w.pg.hours + ' h'}</b> Historie` +
    (w.pg.hours < 240 ? ' (noch dünn – verfeinert sich über die nächsten Wochen)' : '') +
    `. Spread Tag↔günstigste Stunden: <b>${fmt(w.spread, 1)} ct/kWh</b>. Grobe Realitäts-Schätzung, kein Vertragsangebot.`;
}
function renderBorse() {
  const sp = STATE.spot;
  const off = $('borse-off-card');
  const cards = ['borse-now-card', 'borse-worth-card', 'borse-price-card', 'borse-best-card', 'borse-cost-card', 'borse-batt-card'];
  if (!sp || !sp.enabled || !(sp.prices && sp.prices.length)) {
    if (off) off.hidden = false;
    cards.forEach(id => { const el = $(id); if (el) el.hidden = true; });
    return;
  }
  if (off) off.hidden = true;
  cards.forEach(id => { const el = $(id); if (el) el.hidden = false; });
  try { renderBorseWorth(); } catch (e) {}
  const now = Date.now() / 1000;
  const P = sp.prices;
  const cons = P.map(p => p.consumer_ct);
  const lo = Math.min(...cons), hi = Math.max(...cons), avg = mean(cons);
  const nowP = P.find(p => p.ts <= now && p.ts + 3600 > now) || P[0];
  $('borse-now').innerHTML = nowP ? `jetzt <b style="color:${spotColor(nowP.consumer_ct, lo, hi)}">${fmt(nowP.consumer_ct, 1)} ct</b>` : '';
  $('borse-chart').innerHTML = spotChart(P, now);
  $('borse-legend').innerHTML = legendHtml([
    { color: '#4be0b0', label: 'günstig' }, { color: '#f6b93b', label: 'mittel' },
    { color: '#ef6c4d', label: 'teuer' }]);
  const srcLabel = sp.source === 'tibber'
    ? `Quelle: <b>Tibber</b>${sp.home ? ' (' + esc(sp.home) + ')' : ''} – deine echten Tarifpreise (all-in)`
    : `Quelle: <b>Börse</b> (EPEX/aWATTar) + Aufschlag`;
  $('borse-note').innerHTML = `${srcLabel}. Spanne heute/morgen <b>${fmt(lo, 1)}–${fmt(hi, 1)} ct</b>, Ø ${fmt(avg, 1)} ct` +
    (sp.demo ? ' · <b>Demo</b>' : (sp.last_error ? ' · <span style="color:#ff6b8a">Abruf-Fehler</span>' : '')) + '.';
  renderNowSignal(nowP, lo, hi);

  // cheapest windows from now on, for typical flexible loads
  const future = P.filter(p => p.ts + 3600 > now);
  const cheapWin = (len) => {
    if (future.length < len) return null;
    let best = null;
    for (let i = 0; i + len <= future.length; i++) {
      const slice = future.slice(i, i + len);
      const c = mean(slice.map(s => s.consumer_ct));
      if (!best || c < best.c) best = { c, start: slice[0].ts, end: slice[len - 1].ts + 3600 };
    }
    return best;
  };
  const hh = ts => new Date(ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const dd = ts => new Date(ts * 1000).toLocaleDateString('de-DE', { weekday: 'short' });
  const loads = [['🚿 Warmwasser (WP)', 1], ['🧺 Waschen/Trocknen', 3], ['🚗 E-Auto laden', 4]];
  $('borse-best').innerHTML = loads.map(([lbl, len]) => {
    const w = cheapWin(len); if (!w) return '';
    const savePct = avg > 0 ? Math.max(0, (avg - w.c) / avg * 100) : 0;
    return devRow(lbl, `günstigstes ${len}-h-Fenster · ${dd(w.start)} ${hh(w.start)}–${hh(w.end)}`,
      fmt(w.c, 1) + ' ct', savePct > 3 ? '−' + fmt(savePct, 0) + '% vs Ø' : '', Math.min(100, savePct), '#4be0b0');
  }).join('') || '<div class="note">Noch keine künftigen Preise.</div>';

  // dynamic vs fixed, weighted by the real hourly load profile (today)
  const shShape = normFrac((STATE.data && STATE.data.hourly_profile || []).map(h => h.avg_w));
  const hpProf = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const hpShape = hpProf.length && hpProf.some(h => h.avg_w > 0) ? normFrac(hpProf.map(h => h.avg_w)) : null;
  const shD = shAvgDaily(), hpD = hpAvgDaily(), totD = shD + hpD;
  const byHour = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) byHour[h] = shD * (shShape[h] || 1 / 24) + hpD * (hpShape ? hpShape[h] : 1 / 24);
  const todays = P.filter(p => { const d = new Date(p.ts * 1000); return d.toDateString() === new Date().toDateString(); });
  let wSum = 0, wCost = 0;
  todays.forEach(p => { const h = new Date(p.ts * 1000).getHours(); wSum += byHour[h]; wCost += byHour[h] * p.consumer_ct; });
  const dynAvg = wSum > 0 ? wCost / wSum : avg;          // ct/kWh, load-weighted
  const fix = STATE.price * 100;                          // ct/kWh
  $('borse-dyn').innerHTML = fmt(dynAvg, 1) + '<span> ct</span>';
  $('borse-fix').innerHTML = fmt(fix, 1) + '<span> ct</span>';
  const diff = (fix - dynAvg) / 100;                      // €/kWh saved (or lost)
  const yearKwh = totD * 365;
  const yearDelta = diff * yearKwh;
  $('borse-cost-body').innerHTML =
    devRow('Ø-Preis deiner Last (heute)', 'Börsenpreis × dein Stundenprofil', fmt(dynAvg, 1) + ' ct', '', Math.min(100, dynAvg / Math.max(fix, dynAvg) * 100), dynAvg <= fix ? '#4be0b0' : '#ef6c4d') +
    devRow('Festpreis', 'dein aktueller Tarif', fmt(fix, 1) + ' ct', '', Math.min(100, fix / Math.max(fix, dynAvg) * 100), '#4da3ff');
  $('borse-cost-note').innerHTML = yearDelta >= 0
    ? `Bei deinem Verbrauch (~${kwh(yearKwh, 0)}/Jahr) wäre der dynamische Tarif <b>${money(yearDelta)}/Jahr günstiger</b> ` +
      `– und mehr, wenn du flexible Lasten in die grünen Stunden legst.`
    : `Aktuell läge der dynamische Tarif <b>${money(-yearDelta)}/Jahr höher</b> als dein Festpreis. Durch ` +
      `Verschieben flexibler Lasten (Warmwasser, Waschen, Auto) in günstige Stunden lässt sich das drehen.`;

  // ---- Speicher clever laden: Arbitrage aus dem Börsen-Spread ----------
  const battCard = $('borse-batt-card');
  const homeBatt = parseFloat(localStorage.getItem(PV_LS.batt) || '0') || 0;
  const v2hOn = (() => { try { return localStorage.getItem(PV_LS.v2h) === '1'; } catch (e) { return false; } })();
  const carKwh = v2hOn ? (parseFloat(localStorage.getItem(PV_LS.v2hkwh) || '0') || 0) : 0;
  const battKwh = homeBatt + carKwh;
  if (battKwh <= 0) {
    $('borse-batt').innerHTML = '<div class="note">Trag im Tab <b>PV</b> deinen <b>Batteriespeicher</b> (und ggf. ' +
      'V2H-Auto) ein – dann rechne ich hier aus, wie viel du sparst, wenn du ihn in den <b>günstigen</b> Börsenstunden lädst.</div>';
    $('borse-batt-note').innerHTML = '';
  } else {
    // hours needed to (dis)charge, assuming ~3 kW; cheapest to charge vs most expensive to displace
    const kHours = Math.max(1, Math.min(8, Math.round(battKwh / 3)));
    const chargeWin = cheapWin(kHours);
    // most expensive kHours in the next 24h (what the battery would displace)
    const dayAhead = future.slice(0, 24).map(p => p.consumer_ct).sort((a, b) => b - a);
    const expAvg = dayAhead.length ? mean(dayAhead.slice(0, kHours)) : hi;
    const cheapAvg = chargeWin ? chargeWin.c : lo;
    const spread = expAvg - cheapAvg;                       // ct/kWh
    const eff = 0.9, usable = battKwh * eff;
    const savDay = usable * spread / 100;                   // €, upper bound (one cycle)
    const savYear = savDay * 300;                           // not worth every single day
    if (spread > 3 && chargeWin) {
      $('borse-batt').innerHTML =
        devRow('🔋 Laden (günstig)', `Speicher ${khLbl(battKwh)} · ${dd(chargeWin.start)} ${hh(chargeWin.start)}–${hh(chargeWin.end)}`,
          fmt(cheapAvg, 1) + ' ct', '', 100, '#4be0b0') +
        devRow('⚡ Nutzen (teuer)', 'abends/morgens statt Netzbezug', fmt(expAvg, 1) + ' ct', '', Math.min(100, cheapAvg / expAvg * 100), '#ef6c4d');
      $('borse-batt-note').innerHTML = `Spread <b>${fmt(spread, 1)} ct/kWh</b>: lädst du deinen Speicher (${khLbl(battKwh)}) günstig ` +
        `und nutzt ihn in den teuren Stunden, sparst du grob <b>${money(savDay)}/Tag</b> (~<b>${money(savYear)}/Jahr</b>). ` +
        `Vor allem im <b>Winter</b> sinnvoll, wenn die PV den Speicher nicht füllt. ` +
        `<br><small style="color:var(--muted)">Nur eine Abschätzung (max. 1 Zyklus/Tag, 90 % Wirkungsgrad). Braucht einen ` +
        `Speicher/EMS, der <b>preisgesteuert laden</b> kann (z. B. sonnen, Huawei, Tibber-Integration).</small>`;
    } else {
      $('borse-batt').innerHTML = '';
      $('borse-batt-note').innerHTML = `Aktuell ist der Tag/Nacht-Spread klein (<b>${fmt(spread, 1)} ct</b>) – gezieltes ` +
        `Netz-Laden lohnt sich heute kaum. An Tagen mit großem Preisunterschied (oft windig/kalt) schon.`;
    }
  }
}
// "10 kWh" or "10 kWh Heim + 20 kWh Auto"
function khLbl(kwh) { return fmt(kwh, 0) + ' kWh'; }

// Ranked annual-cost list: cheapest highlighted green, bars scaled to the max.
function costList(items) {
  const valid = items.filter(x => x.cost != null);
  if (!valid.length) return '<div class="note">–</div>';
  const min = Math.min(...valid.map(x => x.cost)), max = Math.max(...valid.map(x => x.cost));
  return items.map(x => {
    if (x.cost == null) return devRow(x.label, x.sub || 'nicht konfiguriert', '–', '', 0, 'var(--muted)');
    const best = x.cost === min;
    return devRow((best ? '✅ ' : '') + x.label, x.sub || '', money(x.cost) + '/Jahr',
      best ? 'günstigste' : '+' + money(x.cost - min), max > 0 ? x.cost / max * 100 : 0,
      best ? '#4be0b0' : '#4da3ff');
  }).join('');
}
// Typical heat-pump hour-of-day shape (cold mornings/evenings + midday DHW).
const TYPICAL_WP_HOUR = [0.9, 0.85, 0.8, 0.8, 0.85, 1.0, 1.2, 1.25, 1.15, 1.0, 1.05, 1.1,
  1.05, 0.95, 0.9, 0.95, 1.1, 1.25, 1.3, 1.2, 1.1, 1.0, 0.95, 0.9];
// Load-weighted dynamic-tariff cost using the real season×hour price grid – the
// honest number (a heat pump runs in winter/peak hours = expensive spot).
// A client-side copy of the bridge's grid-CO₂ model, for the demo / no-bridge
// case (kept in sync with bridge/carbon.py).
function demoCarbon() {
  const MF = [1.14, 1.11, 1.02, 0.93, 0.85, 0.81, 0.82, 0.85, 0.94, 1.04, 1.12, 1.17];
  const HF = [1.05, 1.07, 1.07, 1.06, 1.05, 1.03, 0.99, 0.94, 0.88, 0.82, 0.77, 0.74,
    0.73, 0.75, 0.80, 0.88, 0.98, 1.09, 1.15, 1.16, 1.13, 1.10, 1.08, 1.06];
  const base = 380;
  const grid = MF.map(mf => HF.map(hf => Math.round(base * mf * hf * 10) / 10));
  const month_avg = grid.map(r => Math.round(mean(r) * 10) / 10);
  const m = new Date().getMonth();
  return { ok: true, demo: true, base_g: base, annual_g: Math.round(mean(month_avg) * 10) / 10,
    month_hour_g: grid, month_avg_g: month_avg, hour_g: grid[m], month: m + 1 };
}

// Annual CO₂ footprint of the user's electricity, load-weighted with the grid
// intensity grid – same load-shape machinery as spotAnalysis.
function carbonAnalysis() {
  const c = STATE.carbon;
  if (!c || !c.month_hour_g) return null;
  const g = c.month_hour_g;
  const homeShape = normFrac((STATE.data && STATE.data.hourly_profile || []).map(x => x.avg_w));
  const hpProf = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const wpShape = hpProf.length && hpProf.some(x => x.avg_w > 0) ? normFrac(hpProf.map(x => x.avg_w)) : normFrac(TYPICAL_WP_HOUR);
  const p = pvInputs();
  const homeKwh = shAvgDaily() * 365, wpKwh = hpYearFromMonthly() || hpAvgDaily() * 365;
  const evK = p.evAnnual, acK = p.acAnnual, acShare = normFrac(AC_MONTH);
  let homeG = 0, wpG = 0, evG = 0, acG = 0;
  for (let m = 0; m < 12; m++) {
    const homeM = homeKwh * DIM[m] / 365, wpM = hpMonthEst(m), evM = evK * DIM[m] / 365, acM = acK * acShare[m];
    for (let h = 0; h < 24; h++) {
      const gi = g[m][h];
      homeG += homeM * homeShape[h] * gi; wpG += wpM * wpShape[h] * gi;
      evG += evM * EV_SHAPE[h] * gi; acG += acM * AC_SHAPE[h] * gi;
    }
  }
  const totalG = homeG + wpG + evG + acG, totalKwh = homeKwh + wpKwh + evK + acK;
  return { totalKg: totalG / 1000, homeKg: homeG / 1000, wpKg: wpG / 1000,
    evKg: evG / 1000, acKg: acG / 1000, totalKwh,
    intensity: totalKwh > 0 ? totalG / totalKwh : c.annual_g };
}

function renderCarbon() {
  const card = $('borse-co2-card'); if (!card) return;
  const c = STATE.carbon, a = carbonAnalysis();
  if (!c || !a) { if ($('borse-co2-note')) $('borse-co2-note').textContent = 'Noch keine Verbrauchsdaten.'; return; }
  $('borse-co2-kpi').innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v">${fmt(a.totalKg / 1000, 2)} t</div><div class="l">CO₂ / Jahr (Strom)</div></div>` +
    `<div class="kpi sm"><div class="v">${fmt(a.intensity, 0)} g</div><div class="l">Ø Intensität /kWh</div></div></div>`;
  const hourG = c.hour_g || c.month_hour_g[new Date().getMonth()];
  const lo = Math.min(...hourG), hi = Math.max(...hourG), span = (hi - lo) || 1;
  const col = v => v <= lo + span * 0.34 ? '#4be0b0' : v >= lo + span * 0.67 ? '#ef6c4d' : '#f6b93b';
  const bars = hourG.map((v, h) => ({ v, label: String(h), color: col(v) }));
  $('borse-co2-chart').innerHTML =
    `<div class="note" style="margin:2px 0 6px">Netz-CO₂ je Stunde (g/kWh, aktueller Monat)</div>` + barChart(bars, { h: 170 });
  $('borse-co2-legend').innerHTML = legendHtml([
    { color: '#4be0b0', label: 'grün' }, { color: '#f6b93b', label: 'mittel' }, { color: '#ef6c4d', label: 'grau' }]);
  const idx = [...hourG.keys()];
  const green = idx.slice().sort((x, y) => hourG[x] - hourG[y]).slice(0, 3).sort((x, y) => x - y);
  const dirty = idx.slice().sort((x, y) => hourG[y] - hourG[x]).slice(0, 3).sort((x, y) => x - y);
  const rng = hs => hs.map(h => h + '–' + (h + 1)).join(', ') + ' Uhr';
  // what a plan-scale PV would save (operational grid CO₂ avoided by self-use)
  let pvLine = '';
  if ((parseFloat($('pv-kwp').value) || 0) > 0) {
    try {
      const r = simulatePv(pvInputs());
      const savedKg = r.self_kwh * a.intensity / 1000;
      if (savedKg > 5) pvLine = `<br>🌞 Deine geplante PV vermeidet grob <b>${fmt(savedKg, 0)} kg CO₂/Jahr</b> ` +
        `(${fmt(savedKg / Math.max(1, a.totalKg) * 100, 0)} % deiner Strom-Emissionen).`;
    } catch (e) {}
  }
  const trees = a.totalKg / 22;   // ~22 kg CO₂/a bound by one young tree – a common yardstick
  $('borse-co2-note').innerHTML =
    `Aufteilung: Hausstrom <b>${fmt(a.homeKg, 0)}</b>, Wärmepumpe <b>${fmt(a.wpKg, 0)}</b>` +
    (a.evKg > 1 ? `, E-Auto <b>${fmt(a.evKg, 0)}</b>` : '') + (a.acKg > 1 ? `, Klima <b>${fmt(a.acKg, 0)}</b>` : '') +
    ` kg/Jahr. Entspricht rund <b>${fmt(trees, 0)} Bäumen</b>, die das binden müssten.` +
    `<br>🌱 <b>Grünste Stunden:</b> ${rng(green)} – <span style="color:#ef6c4d">graue</span>: ${rng(dirty)}. ` +
    `Flexible Lasten in die grünen Stunden legen.` + pvLine +
    `<br><span style="color:var(--muted)">Modell nach dt. Netz-Durchschnitt (${fmt(c.annual_g, 0)} g/kWh${c.demo ? ', Demo' : ''}); keine Echtzeit-Messung.</span>`;
}

// Expected PV power (kW ≈ kWh in that hour) at a given time: from the fetched
// weather forecast if available, else a typical clear-day shape for the month.
function smartPvKw(ts, m, h) {
  const kwp = Math.max(0, parseFloat($('pv-kwp') && $('pv-kwp').value) || 0);
  if (kwp <= 0) return 0;
  const w = STATE.weather;
  if (w && Array.isArray(w.hourly)) {
    const hit = w.hourly.find(x => Math.abs(x.ts - ts) < 1800);
    if (hit) return kwp * (Math.max(0, hit.ghi) / 1000) * 0.85;
  }
  const spec = parseFloat($('pv-orient') && $('pv-orient').value) || 1000;
  const dailyPv = (kwp * spec) * pvMonth()[m] / DIM[m];        // kWh that day
  return dailyPv * pvHourFractions(m)[h];
}

// Aligned hourly series (price ct, CO₂ g, expected PV kW) for the coming hours.
function smartHours() {
  const now = Date.now() / 1000;
  const sp = STATE.spot, c = STATE.carbon;
  let base = [];
  if (sp && sp.prices && sp.prices.length)
    base = sp.prices.filter(p => p.ts + 3600 > now).map(p => ({ ts: p.ts, price: p.consumer_ct, realPrice: true }));
  if (!base.length) {
    const h0 = Math.floor(now / 3600) * 3600;
    for (let i = 0; i < 24; i++) base.push({ ts: h0 + i * 3600, price: STATE.price * 100, realPrice: false });
  }
  base.forEach(o => {
    const d = new Date(o.ts * 1000), m = d.getMonth(), h = d.getHours();
    o.co2 = (c && c.month_hour_g) ? c.month_hour_g[m][h] : 380;
    o.pv = smartPvKw(o.ts, m, h);
  });
  return base;
}

function renderSmart() {
  const card = $('smart-card'); if (!card) return;
  const dur = Math.max(1, Math.min(12, Math.round(parseFloat($('smart-dur').value) || 2)));
  const kwh = Math.max(0, parseFloat($('smart-kwh').value) || 0);
  const prio = ($('smart-prio').value) || 'balanced';
  const hrs = smartHours();
  if (hrs.length < dur) { $('smart-result').innerHTML = ''; $('smart-note').textContent = 'Noch keine Vorschau-Stunden verfügbar.'; return; }
  const anyPrice = hrs.some(o => o.realPrice);
  const P = hrs.map(o => o.price), C = hrs.map(o => o.co2), V = hrs.map(o => o.pv);
  const nrm = (arr, invert) => {
    const lo = Math.min(...arr), hi = Math.max(...arr), sp = (hi - lo) || 1;
    return arr.map(v => invert ? 1 - (v - lo) / sp : (v - lo) / sp);
  };
  const pN = nrm(P, false), cN = nrm(C, false), vN = nrm(V, true);   // lower score = better
  const wt = { money: [1, 0, 0], co2: [0, 1, 0], pv: [0, 0, 1], balanced: [0.5, 0.5, 0] }[prio] || [0.5, 0.5, 0];
  const score = hrs.map((_, i) => wt[0] * pN[i] + wt[1] * cN[i] + wt[2] * vN[i]);
  // best contiguous window of length `dur`
  const winAvg = (arr, s) => arr.slice(s, s + dur).reduce((a, b) => a + b, 0) / dur;
  let best = 0, bestSc = Infinity;
  for (let s = 0; s + dur <= hrs.length; s++) { const sc = winAvg(score, s); if (sc < bestSc) { bestSc = sc; best = s; } }
  // metrics for a window starting at index s
  const winMetrics = s => {
    const slice = hrs.slice(s, s + dur);
    const price = mean(slice.map(o => o.price));                    // ct/kWh
    const co2 = mean(slice.map(o => o.co2));                        // g/kWh
    const pvKw = mean(slice.map(o => o.pv));                        // kW avg
    const loadKw = kwh > 0 ? kwh / dur : 0;
    const pvCover = loadKw > 0 ? Math.min(1, pvKw / loadKw) : 0;
    const gridKwh = kwh * (1 - pvCover);
    return { price, co2, pvCover, cost: gridKwh * price / 100, co2kg: gridKwh * co2 / 1000, start: slice[0].ts };
  };
  const bw = winMetrics(best), nowW = winMetrics(0);
  // worst window for a savings reference
  let worst = 0, worstSc = -Infinity;
  for (let s = 0; s + dur <= hrs.length; s++) { const sc = winAvg(score, s); if (sc > worstSc) { worstSc = sc; worst = s; } }
  const ww = winMetrics(worst);
  const dd = ts => new Date(ts * 1000).toLocaleDateString('de-DE', { weekday: 'short' });
  const hh = ts => new Date(ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const endTs = bw.start + dur * 3600;
  const pvUsed = STATE.weather ? 'Wetter-Prognose' : 'typischer Sonnenverlauf';
  $('smart-result').innerHTML =
    `<div class="kpi" style="text-align:left"><div class="l" style="margin-bottom:4px">Empfohlener Start</div>` +
    `<div class="v">${dd(bw.start)} ${hh(bw.start)}<span style="font-size:14px;color:var(--muted)"> – ${hh(endTs)} Uhr</span></div></div>` +
    `<div class="grid2" style="margin-top:10px">` +
    `<div class="kpi sm"><div class="v">${anyPrice ? money(bw.cost) : '~' + money(bw.cost)}</div><div class="l">Stromkosten</div></div>` +
    `<div class="kpi sm"><div class="v">${fmt(bw.co2kg, 2)} kg</div><div class="l">CO₂</div></div></div>` +
    (kwh > 0 && (parseFloat($('pv-kwp') && $('pv-kwp').value) || 0) > 0 ?
      `<div class="kpi sm" style="margin-top:8px"><div class="v">${fmt(bw.pvCover * 100, 0)} %</div><div class="l">aus PV gedeckt (${esc(pvUsed)})</div></div>` : '');
  const save = nowW.cost - bw.cost, saveC = nowW.co2kg - bw.co2kg;
  let msg = '';
  if (save > 0.01 || saveC > 0.01)
    msg = `Gegenüber „jetzt sofort" sparst du <b>${money(Math.max(0, save))}</b>` +
      (saveC > 0.005 ? ` und <b>${fmt(Math.max(0, saveC), 2)} kg CO₂</b>` : '') + '.';
  else msg = 'Jetzt ist bereits ein guter Zeitpunkt.';
  const spread = ww.cost - bw.cost;
  $('smart-note').innerHTML = msg +
    (spread > 0.02 ? ` Bestes vs. schlechtestes Fenster: bis zu <b>${money(spread)}</b> Unterschied.` : '') +
    (!anyPrice ? `<br><span style="color:var(--muted)">Ohne aktivierten Börsentarif mit deinem Festpreis gerechnet – für echte Stundenpreise im Setup „Dynamischer Börsentarif" aktivieren.</span>` : '') +
    (prio === 'pv' && !STATE.weather ? `<br><span style="color:var(--muted)">Tipp: im PV-Tab „Wetter-Prognose holen", dann nutzt der Timer die echte Vorhersage.</span>` : '');
}

function spotAnalysis(p) {
  const sp = STATE.spot;
  if (!sp || !sp.month_hour_ct) return null;
  const vat = sp.vat != null ? sp.vat : 19, surch = sp.surcharge_ct != null ? sp.surcharge_ct : 15;
  const annual = (sp.annual_consumer_ct || 25) / 100;                 // €/kWh fallback
  const grid = sp.month_hour_ct.map(row => row.map(v => v == null ? annual : (v * (1 + vat / 100) + surch) / 100));
  const homeShape = normFrac((STATE.data && STATE.data.hourly_profile || []).map(x => x.avg_w));
  const hpProf = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const wpShape = hpProf.length && hpProf.some(x => x.avg_w > 0) ? normFrac(hpProf.map(x => x.avg_w)) : normFrac(TYPICAL_WP_HOUR);
  const homeKwh = shAvgDaily() * 365, wpKwh = hpYearFromMonthly() || hpAvgDaily() * 365;
  const evK = p.evAnnual, acK = p.acAnnual, acShare = normFrac(AC_MONTH);
  let homeCost = 0, wpCost = 0, evCost = 0, acCost = 0;
  const monthCost = new Array(12).fill(0);
  for (let m = 0; m < 12; m++) {
    const homeM = homeKwh * DIM[m] / 365, wpM = hpMonthEst(m), evM = evK * DIM[m] / 365, acM = acK * acShare[m];
    for (let h = 0; h < 24; h++) {
      const pr = grid[m][h];
      const cH = homeM * homeShape[h] * pr, cW = wpM * wpShape[h] * pr,
        cE = evM * EV_SHAPE[h] * pr, cA = acM * AC_SHAPE[h] * pr;
      homeCost += cH; wpCost += cW; evCost += cE; acCost += cA;
      monthCost[m] += cH + cW + cE + cA;
    }
  }
  const wpMSum = Array.from({ length: 12 }, (_, m) => hpMonthEst(m)).reduce((a, b) => a + b, 0) || 1;
  return {
    totalCost: homeCost + wpCost + evCost + acCost,
    effHome: homeKwh > 0 ? homeCost / homeKwh * 100 : 0,
    effWp: wpCost / wpMSum * 100,
    effTotal: (homeCost + wpCost + evCost + acCost) / Math.max(1, homeKwh + wpKwh + evK + acK) * 100,
    monthCost, annualAvg: sp.annual_consumer_ct || 25,
    basis: sp.annual_basis, demo: sp.demo,
  };
}
// Cumulative net cash-flow over the years (savings − loan payment), crossing
// zero at break-even; dashed marker where the loan is paid off.
function financeChart(cum, payoffY) {
  const h = 175, pad = 40, top = 14, base = h - 26, n = cum.length;
  const vmax = Math.max(0, ...cum), vmin = Math.min(0, ...cum), span = (vmax - vmin) || 1;
  const X = i => pad + (CW - pad - 6) * (i / (n - 1));
  const Y = v => top + (base - top) * (1 - (v - vmin) / span);
  let pos = '', neg = '';
  cum.forEach((v, i) => {
    const seg = `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `;
    pos += seg; neg += seg;
  });
  const y0 = Y(0);
  const zero = `<line x1="${pad}" y1="${y0.toFixed(1)}" x2="${CW - pad}" y2="${y0.toFixed(1)}" stroke="var(--line)"/>`;
  // area under the curve, clipped green above 0 / red below via two rects masks is complex;
  // simple: color the whole line, fill light green area to the zero line.
  const area = `M${X(0).toFixed(1)} ${y0.toFixed(1)} ` + pos + `L${X(n - 1).toFixed(1)} ${y0.toFixed(1)} Z`;
  const payoff = (payoffY > 0 && payoffY < n)
    ? `<line x1="${X(payoffY).toFixed(1)}" y1="${top}" x2="${X(payoffY).toFixed(1)}" y2="${base}" stroke="#f6b93b" stroke-width="1.5" stroke-dasharray="3 3"/>` +
      `<text class="axis" x="${X(payoffY).toFixed(1)}" y="${(top + 9).toFixed(1)}" text-anchor="middle" style="fill:#f6b93b">Kredit aus</text>` : '';
  let lab = '';
  for (let y = 0; y < n; y += 5) lab += `<text class="axis" x="${X(y).toFixed(1)}" y="${h - 8}" text-anchor="middle">${y}J</text>`;
  const yl = `<text class="axis" x="2" y="${(Y(vmax) + 4).toFixed(1)}">${fmt(vmax, 0)}€</text>` +
    `<text class="axis" x="2" y="${Y(vmin).toFixed(1)}">${fmt(vmin, 0)}</text>`;
  return svg(h, `<path d="${area}" fill="#4be0b0" opacity="0.14"/>` + zero +
    `<path d="${pos}" fill="none" stroke="#4be0b0" stroke-width="2.5" stroke-linejoin="round"/>` + payoff + lab + yl);
}
function renderFinance(annualSavings) {
  const card = $('konzept-fin-card'); if (!card) return;
  const g = (k, d) => { const v = parseFloat(localStorage.getItem(k)); return isFinite(v) ? v : d; };
  const invest = g(FIN_LS.invest, 0), rate = g(FIN_LS.rate, 4) / 100;
  const years = Math.max(0, Math.round(g(FIN_LS.years, 10))), infl = g(FIN_LS.infl, 3) / 100;

  // ---- E-Auto-Vorteile (independent of the PV investment) -----------------
  const ev = evBenefit();
  renderEvBenefit(ev);
  const evAdd = ev.include ? ev.total : 0;
  // savings driving the payback: PV electricity savings + (optionally) EV benefit.
  // The amortization needs a real PV saving; the EV benefit only augments it.
  if (!(invest > 0) || !(annualSavings > 0)) {
    $('fin-kpi').innerHTML = ''; $('fin-chart').innerHTML = '';
    $('fin-note').innerHTML = !(annualSavings > 0)
      ? 'Sobald oben eine <b>Ersparnis mit PV</b> herauskommt (Tab <b>PV</b> ausfüllen), rechne ich hier Kreditrate gegen Ersparnis.'
      : 'Trag deine <b>Investition</b> (PV/Speicher) und den Kreditzins ein.';
    return;
  }
  const totalSavings = annualSavings + evAdd;
  const cash = years <= 0;
  const annuity = cash ? 0 : (rate > 0 ? invest * rate / (1 - Math.pow(1 + rate, -years)) : invest / years);
  const N = 25, cum = [cash ? -invest : 0]; let be = null;
  for (let y = 1; y <= N; y++) {
    const sav = totalSavings * Math.pow(1 + infl, y - 1);
    const pay = (!cash && y <= years) ? annuity : 0;
    cum.push(cum[cum.length - 1] + sav - pay);
    if (be == null && cum[cum.length - 1] >= 0) be = y;
  }
  const yr1net = totalSavings - annuity;
  const savLabel = evAdd > 0 ? 'Ersparnis / Jahr (Strom + E-Auto)' : 'Stromersparnis / Jahr';
  $('fin-kpi').innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v">${money(totalSavings)}</div><div class="l">${savLabel}</div></div>` +
    `<div class="kpi sm"><div class="v">${cash ? '–' : money(annuity)}</div><div class="l">Kreditrate / Jahr${cash ? ' (bar bezahlt)' : ''}</div></div>` +
    `<div class="kpi sm"><div class="v" style="color:${yr1net >= 0 ? '#4be0b0' : '#ef6c4d'}">${yr1net >= 0 ? '+' : ''}${money(yr1net / 12)}</div><div class="l">Saldo / Monat (Kreditphase)</div></div>` +
    `<div class="kpi sm"><div class="v">${be ? be + ' J.' : '> 25 J.'}</div><div class="l">amortisiert nach</div></div></div>`;
  $('fin-chart').innerHTML = financeChart(cum, cash ? 0 : years);
  $('fin-note').innerHTML =
    (cash
      ? `Bar bezahlt: ab Jahr 1 sparst du <b>${money(totalSavings)}/Jahr</b> (steigt mit dem Preis). `
      : yr1net >= 0
        ? `Schon während der Kreditlaufzeit bist du <b>${money(yr1net)}/Jahr im Plus</b> (Ersparnis > Rate). `
        : `Während der ${years} Kreditjahre ist es rund <b>${money(-yr1net)}/Jahr teurer</b> (Rate > Ersparnis), ` +
          `<b>nach dem Abbezahlen</b> bleibt die volle Ersparnis (${money(totalSavings)}+/Jahr). `) +
    `Kumuliert nach 25 Jahren: <b>${money(cum[25])}</b>. ` +
    (evAdd > 0 ? `<b>Inkl. E-Auto-Vorteil ${money(evAdd)}/Jahr.</b> ` : '') +
    `<span style="color:var(--muted)">Stromersparnis = bester Tarif mit PV vs. ohne, mit ${fmt(infl * 100, 0)} % Preis-Steigerung/Jahr; ` +
    `ohne Förderung/Degradation. Kurve = kumulierter Saldo, gelbe Linie = Kredit abbezahlt.</span>`;
}
// E-Auto-Vorteile breakdown (fuel/tax/THG/maintenance).
function renderEvBenefit(ev) {
  const kpi = $('ev-kpi'), note = $('ev-note'); if (!kpi || !note) return;
  if (!(ev.km > 0)) {
    kpi.innerHTML = '';
    note.innerHTML = 'Trag im Tab <b>PV</b> deine <b>Jahres-km</b> und den EV-Verbrauch ein, dann rechne ich hier ' +
      'Sprit-Ersparnis, Kfz-Steuer, THG-Quote und Wartung zusammen.';
    return;
  }
  kpi.innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v">${money(ev.tankSave)}</div><div class="l">Sprit gespart / Jahr</div></div>` +
    `<div class="kpi sm"><div class="v">${money(ev.tax)}</div><div class="l">Kfz-Steuer / Jahr</div></div>` +
    `<div class="kpi sm"><div class="v">${money(ev.thg)}</div><div class="l">THG-Quote / Jahr</div></div>` +
    `<div class="kpi sm"><div class="v">${money(ev.maint)}</div><div class="l">Wartung gespart / Jahr</div></div>` +
    `<div class="kpi sm"><div class="v" style="color:#4be0b0">${money(ev.total)}</div><div class="l">E-Auto-Vorteil gesamt / Jahr</div></div></div>`;
  const cov = evPvCoverage();
  const covTxt = cov
    ? `☀️ Davon deckt deine <b>PV ~${kwh(cov.pvToEv, 0)}/Jahr</b> (${fmt(cov.share * 100, 0)} %) direkt – ` +
      `dafür kaufst du <b>keinen Netzstrom</b>; <b>im Sommer oft fast der ganze Ladebedarf, im Winter kaum</b>. ` +
      `Dieser PV-Ladevorteil (~${money(cov.pvValue)}/Jahr) steckt schon in der <b>Stromersparnis oben</b> – ` +
      `deshalb rechnet der „Sprit gespart"-Wert hier bewusst mit dem <b>Netz-/Referenzpreis</b>, damit nichts doppelt zählt. `
    : '';
  note.innerHTML =
    `Bei <b>${fmt(ev.km, 0)} km/Jahr</b>: E-Auto braucht ~<b>${kwh(ev.evKwh, 0)}</b> Strom (${money(ev.evEnergyCost)} zum Netzpreis), ` +
    `ein Verbrenner hätte ~<b>${money(ev.fuelCost)}</b> getankt. ` + covTxt +
    (ev.include ? 'Fließt in die Amortisation oben ein. ' : 'Zählt <b>nicht</b> in die Amortisation oben. ') +
    `<span style="color:var(--muted)">THG-Quote sinkt jährlich; Kfz-Steuer-Befreiung für E-Autos gilt bis Ende 2030. ` +
    `Werte anpassbar. Der Auto-Kaufpreis selbst steckt hier nicht drin – nur die laufenden Vorteile.</span>`;
}
function renderKonzept() {
  if (!$('konzept-nopv')) return;
  const tar = tariffData(), price = STATE.price;
  const hhKwh = householdBaseDaily() * 365;               // household w/o EV/AC (added separately below)
  const wpKwh = hpYearFromMonthly() || hpAvgDaily() * 365;
  const p = pvInputs();
  const evKwh = p.evAnnual, acKwh = p.acAnnual;
  const homeKwh = hhKwh + evKwh + acKwh;                  // everything on the main meter
  const totalKwh = homeKwh + wpKwh;
  const sp = STATE.spot;
  const sa = spotAnalysis(p);                             // load-weighted dynamic cost
  const spotAvg = sa ? sa.effTotal / 100 : null;          // €/kWh, effective (load-weighted)

  if (totalKwh <= 0) {
    $('konzept-intro').innerHTML = 'Sobald Verbrauchsdaten da sind (Bridge misst bzw. CSV importiert), rechne ich hier ' +
      'deine Tarif-Optionen und ein Gesamt-Konzept aus.';
    ['konzept-nopv', 'konzept-pv', 'konzept-reco'].forEach(id => { const e = $(id); if (e) e.innerHTML = ''; });
    return;
  }
  $('konzept-intro').innerHTML = `Basis: Haushalt ~<b>${kwh(homeKwh, 0)}/Jahr</b>` +
    (evKwh > 0 ? ` (inkl. E-Auto ${kwh(evKwh, 0)})` : '') + `, Wärmepumpe ~<b>${kwh(wpKwh, 0)}/Jahr</b>. ` +
    `Verglichen werden <b>ein Zähler/ein Tarif</b>, <b>zwei Zähler</b> (WP-Sondertarif) und <b>dynamischer Börsentarif</b>.`;

  // ---- ohne PV ----
  const oneMeter = totalKwh * tar.hhPrice + tar.hhBase;
  const twoMeter = tar.wp ? (homeKwh * tar.hhPrice + tar.hhBase + wpKwh * tar.wpPrice + tar.wpBase + tar.meter2) : null;
  const spotCost = sa ? sa.totalCost + tar.spotBase : null;
  $('konzept-nopv').innerHTML = costList([
    { label: 'Ein Zähler, ein Tarif', sub: `${kwh(totalKwh, 0)} × ${fmt(tar.hhPrice * 100, 0)} ct + ${money(tar.hhBase)} Grund`, cost: oneMeter },
    { label: 'Zwei Zähler (WP-Sondertarif)', sub: tar.wp ? `WP ${kwh(wpKwh, 0)} × ${fmt(tar.wpPrice * 100, 0)} ct, + Messkosten` : 'oben aktivieren', cost: twoMeter },
    { label: 'Dynamischer Börsentarif', sub: sa ? `lastgewichtet, Ø effektiv ${fmt(sa.effTotal, 1)} ct` : 'Börsentarif im Setup aktivieren', cost: spotCost },
  ]);
  // the "why Börse isn't automatically cheaper" explanation, from real load-weighting
  let why = '';
  if (sa) {
    const now = new Date().getMonth();
    const past = sa.monthCost.slice(0, now + 1).reduce((a, b) => a + b, 0);
    const future = sa.monthCost.slice(now + 1).reduce((a, b) => a + b, 0);
    why = `<br><b>Warum ist Börse nicht automatisch günstiger?</b> Der dynamische Preis wird ` +
      `<b>lastgewichtet</b> gerechnet: deine <b>Wärmepumpe</b> läuft v. a. im <b>Winter</b> und morgens/abends – ` +
      `genau dann ist die Börse <b>teuer</b>. Sie zahlt effektiv ~<b>${fmt(sa.effWp, 1)} ct/kWh</b>, der Haushalt ` +
      `nur ~<b>${fmt(sa.effHome, 1)} ct/kWh</b> (Jahres-Ø ${fmt(sa.annualAvg, 1)} ct). Dazu kommen ` +
      `<b>${fmt((sp && sp.surcharge_ct) || 15, 0)} ct</b> Aufschlag auf <b>jede</b> kWh. Ein WP-Sondertarif rabattiert dagegen ` +
      `gezielt den größten Verbraucher. „Börse spart" gilt vor allem, wenn du <b>flexibel verschieben</b> kannst ` +
      `(Auto/Warmwasser/Waschen) und PV/Speicher hast.` +
      `<br><span style="color:var(--muted)">Basis: ${sa.demo ? 'Demo-Preise' : sa.basis === 'history' ? 'echte Börsenpreise deiner Bridge-Historie' : 'typischer Jahresverlauf (bis Historie da ist)'}. ` +
      `Jan–${MON[now]} ~${money(past)} (bisherige Preise), ${MON[now]}–Dez ~${money(future)} (Prognose Saison).</span>`;
  }
  $('konzept-nopv-note').innerHTML = 'Reine Bezugskosten pro Jahr, ohne PV. ' +
    (twoMeter != null && twoMeter < oneMeter ? `Der WP-Sondertarif spart hier grob <b>${money(oneMeter - twoMeter)}/Jahr</b> – solange keine PV im Spiel ist.` : '') +
    (sa == null ? ' Für die Börsen-Zeile im <b>Setup</b> den dynamischen Tarif aktivieren.' : '') + why;

  const bestNoPv = Math.min(...[oneMeter, twoMeter, spotCost].filter(v => v != null));

  // ---- mit PV ----
  const pvCard = $('konzept-pv-card');
  let reco = [], annualSavings = 0;
  if (p.kwp > 0) {
    if (pvCard) pvCard.hidden = false;
    const rAll = simulatePv(p);                            // PV vs. all loads (one meter)
    const rHh = simulatePv({ ...p, noHp: true });          // PV vs. household only (HP on 2nd meter)
    const oneMeterPv = rAll.grid_kwh * tar.hhPrice + tar.hhBase - rAll.feed_kwh * p.feedin;
    const twoMeterPv = tar.wp
      ? rHh.grid_kwh * tar.hhPrice + tar.hhBase - rHh.feed_kwh * p.feedin + wpKwh * tar.wpPrice + tar.wpBase + tar.meter2
      : null;
    const spotPv = spotAvg != null ? rAll.grid_kwh * spotAvg + tar.spotBase - rAll.feed_kwh * p.feedin : null;
    $('konzept-pv').innerHTML = costList([
      { label: 'Ein Zähler + PV', sub: `Netzbezug ${kwh(rAll.grid_kwh, 0)}, Einspeisung ${kwh(rAll.feed_kwh, 0)}`, cost: oneMeterPv },
      { label: 'Zwei Zähler + PV', sub: tar.wp ? `PV deckt nur Haushalt; WP ${kwh(wpKwh, 0)} voll am WP-Tarif` : 'WP-Tarif oben aktivieren', cost: twoMeterPv },
      { label: 'Börse + PV', sub: spotAvg != null ? `Restbezug ${kwh(rAll.grid_kwh, 0)} dynamisch` : 'Börsentarif aktivieren', cost: spotPv },
    ]);
    // the key PV-vs-HP-tariff insight
    const hpSelfValue = Math.max(0, (rAll.self_kwh - rHh.self_kwh)) * tar.hhPrice;   // €/yr PV saves on HP via one meter
    const wpDiscount = tar.wp ? Math.max(0, wpKwh * (tar.hhPrice - tar.wpPrice) - tar.wpBase - tar.meter2) : 0;
    $('konzept-pv-note').innerHTML = `Wichtig bei PV: über einen <b>separaten WP-Zähler</b> kann deine PV den ` +
      `Wärmepumpen-Strom <b>nicht</b> mitversorgen. Ein Zähler + PV nutzt PV auch für die WP ` +
      `(~<b>${money(hpSelfValue)}/Jahr</b> Eigenverbrauchs-Vorteil).` +
      (tar.wp ? ` Der WP-Sondertarif spart dagegen ~${money(wpDiscount)}/Jahr. ` +
        `→ <b>${hpSelfValue >= wpDiscount ? 'Ein Zähler + PV lohnt sich mehr.' : 'Der WP-Sondertarif lohnt sich trotz PV.'}</b>` : '');
    // recommendation seeds
    const opts = [['Ein Zähler + PV', oneMeterPv], ['Zwei Zähler + PV', twoMeterPv], ['Börse + PV', spotPv]]
      .filter(o => o[1] != null).sort((a, b) => a[1] - b[1]);
    if (opts.length) { reco.push(['💶', `Günstigste Kombination: <b>${opts[0][0]}</b> mit ~<b>${money(opts[0][1])}/Jahr</b> Netto-Stromkosten.`]);
      annualSavings = Math.max(0, bestNoPv - opts[0][1]); }
    reco.push(['☀️', `Deine PV (${fmt(p.kwp, 1)} kWp${p.batt > 0 ? ` + ${kwh(p.batt, 0)} Speicher` : ''}) deckt ` +
      `<b>${fmt(rAll.autarky * 100, 0)} %</b> deines Verbrauchs. Warmwasser/Waschen/Auto möglichst <b>mittags</b> laufen lassen.`]);
    if (tar.wp) reco.push([hpSelfValue >= wpDiscount ? '🔌' : '🔥',
      hpSelfValue >= wpDiscount
        ? `Mit PV bringt <b>ein gemeinsamer Zähler</b> mehr als der WP-Sondertarif – der PV-Eigenverbrauch der Wärmepumpe wiegt schwerer.`
        : `Der <b>WP-Sondertarif</b> lohnt sich bei dir auch mit PV – die WP läuft viel im Winter, wenn die PV wenig liefert.`]);
  } else {
    if (pvCard) pvCard.hidden = true;
    reco.push(['☀️', 'Noch keine PV eingetragen. Im Tab <b>PV</b> kWp & Speicher durchrechnen – bei deinem Verbrauch ' +
      'meist der größte Hebel. Dann erscheint hier auch der Vergleich „mit PV".']);
    const opts = [['Ein Zähler', oneMeter], ['Zwei Zähler', twoMeter], ['Börse', spotCost]]
      .filter(o => o[1] != null).sort((a, b) => a[1] - b[1]);
    if (opts.length) reco.push(['💶', `Aktuell günstigster Tarif: <b>${opts[0][0]}</b> (~${money(opts[0][1])}/Jahr).`]);
  }
  // battery/V2H + börse hints
  if (p.batt > 0 || (p.v2h && p.carKwh > 0)) reco.push(['🔋', 'Speicher vorhanden: im Tab <b>Börse</b> kannst du ihn ' +
    'in günstigen Stunden laden („Speicher clever laden") – lohnt v. a. im Winter mit dynamischem Tarif.']);
  if (spotAvg != null) reco.push(['⚡', `Dynamischer Tarif aktiv: flexible Lasten in die <b>grünen Börsenstunden</b> ` +
    `legen (Tab Börse) senkt die Kosten zusätzlich.`]);
  $('konzept-reco').innerHTML = reco.map(([ic, t]) =>
    `<div class="devrow" style="align-items:flex-start"><div style="font-size:18px;flex:none;width:24px">${ic}</div>` +
    `<div class="nm"><small style="color:var(--ink);font-size:13px;line-height:1.5">${t}</small></div></div>`).join('');
  renderFinance(annualSavings);
}
function devRow(title, sub, valTop, valBot, pct, col) {
  return `<div class="devrow"><div class="nm"><b>${esc(title)}</b><small>${sub}</small>` +
    `<div class="bar"><i style="width:${pct.toFixed(0)}%${col ? `;background:${col}` : ''}"></i></div></div>` +
    `<div class="val"><b>${valTop}</b>${valBot ? `<small>${valBot}</small>` : ''}</div></div>`;
}

/* --------------------------------------------------------------- rendering */
/* Rendering only what is on screen. renderAll() used to redraw every tab – all
 * nine views, hidden ones included – on the first paint and on every refresh:
 * about 1.2 s of work on a phone before the first number appeared, although
 * the overview alone takes ~20 ms. Each top-level render now belongs to the
 * view(s) it draws into; a view that is not visible is only marked stale and
 * catches up the moment its tab is opened (flushView in switchView). */
const VIEW_RENDERS = {
  overview: ['renderOverview', 'paintNowLine', 'renderFlow', 'renderAppliances', 'renderHa', 'renderDarkLoad', 'renderSwitches'],
  today: ['renderToday'],
  history: ['renderHistory'],
  heatpump: ['renderHeatpump', 'renderHeatExtras'],
  profile: ['renderProfile'],
  pv: ['renderPvReal', 'renderPv', 'renderCarbon', 'renderSmart'],          // the last two also fill PV fields
  borse: ['renderBorse', 'renderCarbon', 'renderSmart'],
  konzept: ['renderKonzept'],
  settings: ['renderSettings', 'renderMeter', 'renderFroniusSetup', 'renderCalSetup', 'renderAwbSetup', 'renderDashSetup', 'renderSchoolSetup'],
};
// the order renderAll() always used (some renders build on earlier ones)
const RENDER_ORDER = ['renderOverview', 'paintNowLine', 'renderToday', 'renderHistory', 'renderHeatpump', 'renderProfile', 'renderPv',
  'renderSettings', 'renderAppliances', 'renderMeter', 'renderBorse', 'renderCarbon', 'renderSmart', 'renderKonzept',
  'renderHa', 'renderDarkLoad', 'renderSwitches', 'renderHeatExtras', 'renderFlow', 'renderPvReal', 'renderFroniusSetup',
  'renderCalSetup', 'renderAwbSetup', 'renderDashSetup', 'renderSchoolSetup'];
const _viewStale = {};                 // view -> Set of render names waiting for that view
function activeView() { const el = document.querySelector('.view.on'); return el ? el.id.replace(/^v-/, '') : 'overview'; }
function _runRender(name) {
  const fn = window[name];
  if (typeof fn === 'function') { try { fn(); } catch (e) { console.error(name, e); } }
  Object.keys(_viewStale).forEach(v => _viewStale[v].delete(name));      // it is fresh everywhere now
}
// Run the given renders (default: all) for the visible view; mark the rest stale.
function paintViews(names) {
  const act = activeView(), eager = !!window.__eagerRender;
  RENDER_ORDER.forEach(name => {
    if (names && names.indexOf(name) < 0) return;
    const views = Object.keys(VIEW_RENDERS).filter(v => VIEW_RENDERS[v].indexOf(name) >= 0);
    if (eager || views.indexOf(act) >= 0) _runRender(name);
    else views.forEach(v => { (_viewStale[v] = _viewStale[v] || new Set()).add(name); });
  });
}
function flushView(v) {
  const st = _viewStale[v];
  if (!st || !st.size) return;
  RENDER_ORDER.filter(n => st.has(n)).forEach(_runRender);
}
// heat-pump tab extras that depend on the core data having arrived
function renderHeatExtras() {
  // re-paint cached heating-check once the WP annual model & price are loaded
  // (so €-savings fill in even if the tab was opened before data arrived)
  if (typeof _hdData !== 'undefined' && _hdData) paintHeatingDiag(_hdData);
  if (typeof _hcData !== 'undefined' && _hcData) paintHeatingCurve(_hcData);
  if (typeof initHpControls === 'function') initHpControls();
  if (typeof renderAutomeasure === 'function') renderAutomeasure();   // re-check availability after health
}
function renderAll() { paintViews(); }

// Device control: switch Bosch Smart Plug+ (and other PowerSwitch devices) on/off.
// Lazy-loaded (one fetch, then cached) so the 30 s overview poll stays cheap;
// manual only – nothing is ever switched automatically.
let _switches = null, _switchesBusy = false;
async function fetchSwitches(force) {
  if (_switchesBusy) return;
  if (_switches && !force) { renderSwitchList(); return; }
  _switchesBusy = true;
  const body = $('ov-switch-body');
  if (force && body) body.innerHTML = '<div class="note">Lade schaltbare Geräte …</div>';
  try {
    const r = await api('/api/switches');
    if (r && r.ok) { _switches = r.switches || []; _switches._demo = !!r.demo; renderSwitchList(); }
    else if (force && body) { $('ov-switch-card').hidden = false; body.innerHTML = `<div class="note">⚠︎ ${escIp((r && r.error) || 'Konnte Geräte nicht laden.')}</div>`; }
    else { const c = $('ov-switch-card'); if (c) c.hidden = true; }     // stay quiet on the overview
  } catch (e) {
    const c = $('ov-switch-card');
    if (force && body) { c.hidden = false; body.innerHTML = '<div class="note">Nur möglich, wenn die Seite von der Bridge geöffnet ist.</div>'; }
    else if (c) c.hidden = true;
  } finally { _switchesBusy = false; }
}
function renderSwitchList() {
  const card = $('ov-switch-card'), body = $('ov-switch-body'); if (!card || !body) return;
  const list = _switches || [];
  if (!list.length) { card.hidden = true; return; }     // no switchable devices → hide the card
  card.hidden = false;
  body.innerHTML = list.map(s => {
    const on = String(s.state).toUpperCase() === 'ON', unk = s.state == null;
    const label = unk ? '?' : (on ? 'AN' : 'AUS');
    return `<div class="devrow"><div class="nm"><b>${esc(s.name || s.id)}</b>` +
      `<small>${esc(s.room || '')}${unk ? ' · Status unbekannt' : ''}</small></div>` +
      `<div class="val"><button class="btn ${on ? '' : 'sec'}" data-sw="${esc(s.id)}" data-on="${on ? '0' : '1'}" ` +
      `data-nm="${esc(s.name || s.id)}" style="width:auto; padding:8px 16px; min-width:68px">${label}</button></div></div>`;
  }).join('');
  $('ov-switch-note').innerHTML = (list._demo ? '<b>Demo-Modus</b> – schaltet keine echten Geräte. ' : '') +
    'Schaltet die <b>Bosch Smart Plug+</b> (und andere schaltbare Bosch-Geräte) direkt. <b>Nur manuell</b> – es wird nichts automatisch geschaltet.';
}
async function doSwitch(id, on, name) {
  if (!window.confirm(`„${name}" wirklich ${on ? 'EINSCHALTEN' : 'AUSSCHALTEN'}?`)) return;
  const note = $('ov-switch-note'); if (note) note.textContent = `Schalte „${name}" ${on ? 'ein' : 'aus'} …`;
  try {
    const r = await postJSON('/api/switch', { device_id: id, on });
    if (r && r.ok) {
      const s = (_switches || []).find(x => x.id === id); if (s) s.state = r.state;
      renderSwitchList();
      if (note) note.innerHTML = `✅ „${esc(name)}" ist jetzt <b>${r.state === 'ON' ? 'AN' : 'AUS'}</b>.`;
    } else if (note) note.innerHTML = '⚠︎ ' + escIp((r && r.error) || 'Schalten fehlgeschlagen.');
  } catch (e) { if (note) note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
}
function renderSwitches() { fetchSwitches(false); }

/* ---- Heizungs-Check: thermostat settings + flow/return efficiency -------- */
const HD_SEV = {
  high: { c: '#ff6b8a', ic: '⛔', lbl: 'wichtig' },
  warn: { c: '#ffb64d', ic: '⚠︎', lbl: 'Hinweis' },
  info: { c: '#3ba9ff', ic: 'ℹ︎', lbl: 'Info' },
  ok:   { c: '#4be0b0', ic: '✓', lbl: 'ok' },
};
const HD_MODE = { ch: 'Heizen', heating: 'Heizen', heat: 'Heizen', dhw: 'Warmwasser', off: 'Standby' };
let _hdData = null, _hdBusy = false;
// Fenster-/Tür-Kontakt → Raum-Zuordnung: lets a contact (e.g. the front door in
// a hallway) be re-homed to the adjacent room so its open/close counts there.
async function renderContactsMap() {
  const box = $('hd-map'); if (!box) return;
  box.innerHTML = '<div class="note">Lade Kontakte …</div>';
  let r;
  try { r = await api('/api/contacts'); } catch (e) { r = null; }
  if (!r || (!r.contacts && r.ok === false)) {
    box.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar (Live oder Demo).</div>';
    return;
  }
  const contacts = r.contacts || [];
  const rooms = r.rooms || [];
  if (!contacts.length) {
    box.innerHTML = '<div class="note">Keine Fenster-/Türkontakte gefunden.</div>';
    return;
  }
  const opt = (sel) => '<option value="">— automatisch (Bosch) —</option>' +
    rooms.map(rm => `<option value="${esc(rm)}"${rm === sel ? ' selected' : ''}>${esc(rm)}</option>`).join('');
  box.innerHTML = `<div class="note" style="margin-bottom:6px">Jeder Kontakt bringt seinen Raum automatisch aus Bosch mit. ` +
    `Nur wenn ein Kontakt für einen <b>anderen</b> Raum zählen soll (z. B. die <b>Haustür</b> im Windfang → Wohnzimmer), hier umhängen.</div>` +
    contacts.map(c => {
      const eff = c.moved ? c.room : '';
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:13px;padding:4px 0;border-bottom:1px solid var(--line)">` +
        `<span>${c.door ? '🚪' : '🪟'} <b>${esc(c.name)}</b>` +
        `<span style="color:var(--muted);font-size:11px"> · in Bosch: ${esc(c.shc_room || '–')}${c.open ? ' · offen' : ''}</span></span>` +
        `<select class="contact-map" data-id="${esc(c.id)}" style="padding:4px 6px;border-radius:8px;border:1px solid var(--line);background:var(--card2);color:var(--ink);font-size:12px">${opt(eff)}</select>` +
        `</div>`;
    }).join('') +
    `<div id="hd-map-msg" class="note" style="margin-top:6px"></div>`;
  box.querySelectorAll('.contact-map').forEach(sel => {
    sel.addEventListener('change', async () => {
      const msg = $('hd-map-msg'); if (msg) msg.textContent = 'Speichere …';
      try {
        await postJSON('/api/contacts/map', { id: sel.dataset.id, room: sel.value });
        if (msg) msg.innerHTML = '<span style="color:#4be0b0">✓ gespeichert</span> – wirkt beim nächsten Heizungs-Check.';
        _hdData = null;   // force a reload so the Fenster column picks up the change
      } catch (e) { if (msg) msg.innerHTML = '<span style="color:#ff6b8a">Speichern fehlgeschlagen.</span>'; }
    });
  });
}
/* ---- Wohn-Dashboard (Kiosk, Vollbild für ein Wand-iPad) ------------------- */
let _kioskClockT = null, _kioskDataT = null, _kioskRooms = null;
let _kioskLive = null, _kioskHp = null;   // light live-power snapshot (kiosk only)
let _kioskAway = (() => { try { return localStorage.getItem('bhe_kiosk_away') === '1'; } catch (e) { return false; } })();
// Average household+heat-pump load in the current hour (kW ≈ kWh/h), from the
// measured hourly profile and the daily averages.
// The inverter's live reading when it is current (≤ 2 min old): the measured
// truth for "now". null → the callers fall back to their estimate.
function frLiveNow() {
  const F = STATE.fr, L = F && F.connected ? F.live : null;
  if (!L || !F.last_poll) return null;
  const age = (F.server_time || Date.now() / 1000) - F.last_poll;
  return age <= 120 ? L : null;
}
function kioskOpen() { const k = $('kiosk'); return !!(k && !k.hidden); }
// connected, but no current reading: say so instead of quietly showing the estimate
function frSilentNote() {
  const F = STATE.fr;
  if (!F || !F.connected || frLiveNow()) return '';
  const age = F.last_poll ? Math.round(((F.server_time || Date.now() / 1000) - F.last_poll) / 60) : null;
  return ` · ⚠︎ Wechselrichter ${age != null ? `seit ${age} min ` : ''}ohne Antwort`;
}
function loadNowKw() {
  const M = frLiveNow();
  if (M && M.load_w != null) return Math.max(0, M.load_w) / 1000;     // smart meter: measured
  const h = new Date().getHours();
  const shShape = normFrac((STATE.data && STATE.data.hourly_profile || []).map(x => x.avg_w));
  const hpProf = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const hpShape = hpProf.length && hpProf.some(x => x.avg_w > 0) ? normFrac(hpProf.map(x => x.avg_w)) : null;
  const shH = shAvgDaily() * (shShape[h] != null ? shShape[h] : 1 / 24);
  const hpH = hpAvgDaily() * (hpShape ? hpShape[h] : 1 / 24);
  return shH + hpH;
}
// PV surplus right NOW (kW). With a connected Fronius: measured production and
// house load. Otherwise an estimate – expected production (weather forecast if
// available, else the clear-day shape) minus the typical house+WP load –
// clearly labelled as such.
function pvNowEstimate() {
  const M = frLiveNow();
  if (M && M.pv_w != null) {                       // the inverter measures it
    const pvKw = Math.max(0, M.pv_w) / 1000, loadKw = loadNowKw();
    return { pvKw, loadKw, surplusKw: pvKw - loadKw, measured: true,
             src: STATE.fr.demo ? 'Demo-Anlage (simuliert)'
               : M.load_w != null ? 'gemessen (Wechselrichter)' : 'PV gemessen, Verbrauch geschätzt' };
  }
  let kwp = 0; try { kwp = Math.max(0, parseFloat(($('pv-kwp') || {}).value) || 0); } catch (e) {}
  if (kwp <= 0) return null;
  const now = new Date(), m = now.getMonth(), h = now.getHours();
  const pvKw = smartPvKw(Date.now() / 1000, m, h);
  const loadKw = loadNowKw();
  return { pvKw, loadKw, surplusKw: pvKw - loadKw,
           src: (STATE.weather && Array.isArray(STATE.weather.hourly)) ? 'Wetter-Prognose' : 'typischer Sonnenverlauf' };
}
function kioskWashAdvice() {
  const sp = STATE.spot;
  const now = Date.now() / 1000;
  const pv = pvNowEstimate();
  // Börse signal (if active)
  let spot = null;
  if (sp && sp.enabled && sp.prices && sp.prices.length) {
    const cons = sp.prices.map(p => p.consumer_ct);
    const lo = Math.min(...cons), hi = Math.max(...cons), avg = mean(cons);
    const nowP = sp.prices.find(p => p.ts <= now && p.ts + 3600 > now) || sp.prices[0];
    const c = nowP.consumer_ct;
    spot = { c, lo, hi, avg, cheap: c <= avg * 0.9, dear: c >= avg * 1.15,
             sub: `Börse jetzt <b>${fmt(c, 1)} ct</b> · heute ${fmt(lo, 1)}–${fmt(hi, 1)} ct (Ø ${fmt(avg, 1)})` };
  }
  const strongSurplus = pv && pv.surplusKw >= 0.4;
  const act = _kioskAway ? 'per Zeitvorwahl programmieren' : 'jetzt einschalten';
  const ca = pv && pv.measured ? '' : '~';            // measured values need no "about"
  // 1) Real PV surplus wins – free solar power beats any tariff signal
  if (strongSurplus) {
    return { level: 'green',
      line: `☀️ PV-Überschuss ${ca}<b>${fmt(pv.surplusKw, 1)} kW</b> – Großverbraucher ${act} (Eigenverbrauch).`,
      sub: `Erzeugung ${ca}${fmt(pv.pvKw, 1)} kW − Last ${ca}${fmt(pv.loadKw, 1)} kW · Quelle: ${pv.src}` + (spot ? ` · ${spot.sub}` : '') };
  }
  // 2) else the Börse signal – only when it says something: cheap or dear
  if (spot && (spot.cheap || spot.dear)) {
    return { level: spot.cheap ? 'green' : 'red',
      line: spot.cheap
        ? `🟢 Börse günstig – guter Moment für Waschmaschine, Trockner, Spüler & E-Auto (${act}).`
        : '🔴 Strom gerade teuer – große Verbraucher besser später laufen lassen.',
      sub: spot.sub + (pv && pv.surplusKw > 0 ? ` · ☀️ etwas PV (${ca}${fmt(pv.surplusKw, 1)} kW)` : '') };
  }
  // 3) otherwise: what the PV system has earned (no filler text without one) –
  // unless the "Heute" panel below already shows it
  const pm = kioskTodayData() ? null : kioskPvMoney();
  if (pm) return pm;
  return null;
}

/* ---- dashboard: cumulative values of the day (autarky ring + tiles) -------- */
function kioskTodayData() {
  const F = STATE.fr, d = F && F.connected && F.today && F.today.today;
  return d && d.load_kwh != null ? d : null;
}
// PV energy of today × the grid's CO₂ intensity in that hour (the same model as
// in the Börse tab) – what the grid did not have to produce
function kioskCo2Kg(F) {
  const C = STATE.carbon || demoCarbon(), mo = new Date().getMonth();
  const g = C.month_hour_g && C.month_hour_g[mo];
  const ser = (F.today && F.today.series) || [];
  if (g && ser.some(p => p.pv_w > 0)) {
    let kg = 0;
    ser.forEach(p => { kg += Math.max(0, p.pv_w || 0) * 0.25 / 1000 * (g[new Date(p.t * 1000).getHours()] || 0) / 1000; });
    return kg;
  }
  const avg = (C.month_avg_g && C.month_avg_g[mo]) || 380;
  return ((F.today.today && F.today.today.pv_kwh) || 0) * avg / 1000;
}
function kioskRing(frac, label) {
  const r = 50, c = 2 * Math.PI * r, f = frac == null ? 0 : Math.max(0, Math.min(1, frac));
  return `<svg viewBox="0 0 120 120" class="kt-ring" role="img" aria-label="${esc(label)} ${frac == null ? '–' : fmt(f * 100, 0) + ' %'}">` +
    `<circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--k-card2)" stroke-width="12"/>` +
    (f >= 0.005 ? `<circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--kb-green)" stroke-width="12" stroke-linecap="round" ` +
      `stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/>` : '') +
    `<text x="60" y="64" text-anchor="middle" class="kt-pct">${frac == null ? '–' : fmt(f * 100, 0) + ' %'}</text>` +
    `<text x="60" y="82" text-anchor="middle" class="kt-rl">${esc(label)}</text></svg>`;
}
function renderKioskToday() {
  const el = $('kiosk-today'); if (!el) return;
  const F = STATE.fr, d = kioskTodayData();
  const wrap = $('kiosk-energy'); if (wrap) wrap.classList.toggle('two', !!d);
  if (!d) { el.innerHTML = ''; return; }
  const m = F.money || {}, L = F.live || {};
  const kw = v => fmt(v || 0, (v || 0) < 10 ? 1 : 0) + '\u00a0kWh';
  const tile = (ic, val, lbl, sub) => `<div class="kt-t"><span class="kt-ic">${ic}</span><div><b>${val}</b>` +
    `<small>${lbl}${sub ? ' · ' + sub : ''}</small></div></div>`;
  const tiles = [
    tile('☀️', kw(d.pv_kwh), 'Sonne', d.self_rate != null && d.pv_kwh >= 0.1 ? `${fmt(d.self_rate * 100, 0)}\u00a0% selbst genutzt` : ''),
    tile('🏠', kw(d.load_kwh), 'verbraucht', d.hp_kwh != null && d.hp_kwh >= 0.1
      ? `Wärmepumpe ${kw(d.hp_kwh)}${d.hp_sun_share != null ? `, ${fmt(d.hp_sun_share * 100, 0)}\u00a0% Sonne` : ''}` : ''),
    tile('🔌', kw(d.imp_kwh), 'aus dem Netz', (d.exp_kwh || 0) >= 0.05 ? `${kw(d.exp_kwh)} eingespeist` : ''),
    tile('💶', eur(d.saved_eur || 0), 'gespart', (d.feed_eur || 0) >= 0.005 ? `davon ${eur(d.feed_eur)} Einspeisung` : ''),
  ];
  const soc = L.soc != null ? L.soc : null;
  if (soc != null) tiles.push(tile('🔋', fmt(soc, 0) + ' %', 'Batterie', d.soc_min != null ? `heute\u00a0${fmt(d.soc_min, 0)}–${fmt(Math.max(d.soc_max, soc), 0)}\u00a0%` : ''));
  const co2 = kioskCo2Kg(F);
  if (co2 >= 0.05) tiles.push(tile('🌱', '≈ ' + fmt(co2, co2 < 10 ? 1 : 0) + ' kg', 'CO₂ vermieden', ''));
  const foot = [];
  const y = m.yesterday, wk = m.week, mo = m.month, tot = m.total;
  if (wk && wk.days > 1 && wk.autarky != null) foot.push(`7 Tage <b>${fmt(wk.autarky * 100, 0)} %</b> autark · ${eur(wk.saved_eur)} gespart`);
  if (mo && mo.days > (wk ? wk.days : 1) && mo.autarky != null) foot.push(`Monat <b>${fmt(mo.autarky * 100, 0)} %</b> · ${eur(mo.saved_eur)}`);
  if (tot && m.since && tot.days > ((mo && mo.days) || 0))
    foot.push(`seit ${new Date(m.since * 1000).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: '2-digit' })} ${eur(tot.saved_eur)}`);
  if (m.best_pv) foot.push(`bester Sonnentag ${dayLabel(m.best_pv.day)} mit ${kw(m.best_pv.pv_kwh)}`);
  el.innerHTML = `<div class="kt-head"><span class="kl-title" style="margin:0">Heute</span>` +
    (y && y.autarky != null ? `<span class="kt-cmp">gestern ${fmt(y.autarky * 100, 0)} % autark</span>` : '') + '</div>' +
    `<div class="kt-body">${kioskRing(d.autarky, 'autark')}<div class="kt-grid">${tiles.join('')}</div></div>` +
    (foot.length ? `<div class="kt-foot">${foot.join(' · ')}</div>` : '') +
    (F.demo ? '<div class="kt-foot">Demo-Anlage (simuliert)</div>' : '');
}
// The PV system's money: own consumption not bought from the grid + feed-in
// paid – today, this month, since it was connected (bridge: /api/fronius money).
function kioskPvMoney() {
  const F = STATE.fr, m = F && F.connected && F.money;
  if (!m || !m.today) return null;
  const e = v => eur(v || 0), t = m.today, mo = m.month, tot = m.total;
  const sinceTxt = m.since ? new Date(m.since * 1000).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '';
  const parts = [];
  if (mo && mo.days > t.days) parts.push(`diesen Monat <b>${e(mo.saved_eur)}</b>`);
  if (tot && tot.days > (mo ? mo.days : 0)) parts.push(`seit ${sinceTxt} <b>${e(tot.saved_eur)}</b>`);
  else if (tot && sinceTxt) parts.push(`seit dem Anschluss am ${sinceTxt}`);
  return { level: 'green',
    line: `☀️ PV heute: <b>${e(t.self_eur)}</b> gespart` + ((t.feed_eur || 0) >= 0.005 ? ` + <b>${e(t.feed_eur)}</b> Einspeisung` : ''),
    sub: `Eigenverbrauch ${fmt(Math.max(0, (t.load_kwh || 0) - (t.imp_kwh || 0)), 1)} kWh × ${fmt(m.price * 100, 0)} ct · ` +
      `eingespeist ${fmt(t.exp_kwh || 0, 1)} kWh × ${fmt(m.feedin * 100, 1)} ct` +
      (t.autarky != null ? ` · Autarkie ${fmt(t.autarky * 100, 0)} %` : '') + (parts.length ? ' · ' + parts.join(' · ') : '') +
      (F.demo ? ' · Demo-Anlage' : '') };
}
// map a rating level (good/ok/warn/na) to a theme-aware kiosk colour token
function kcol(lvl) {
  return lvl === 'good' ? 'var(--kb-green)' : lvl === 'ok' ? 'var(--kb-amber)'
    : lvl === 'warn' ? 'var(--kb-red)' : 'var(--k-sub)';
}
// Icon for a measured device, from its name (the SHC knows no device kinds)
function kioskDevIcon(name) {
  const n = (name || '').toLowerCase();
  if (/licht|lampe|leuchte|\bled\b|spot|strahler/.test(n)) return '💡';
  if (/fernseh|\btv\b|beamer|sound|musik|receiver/.test(n)) return '📺';
  if (/trockn/.test(n)) return '🌀';
  if (/wasch/.test(n)) return '🧺';
  if (/spül|spuel|geschirr|quooker/.test(n)) return '🍽️';
  if (/kühl|kuehl|gefrier/.test(n)) return '🧊';
  if (/router|wlan|netzwerk|server|\bnas\b|switch|fritz/.test(n)) return '📶';
  if (/roll|jalousie|markise/.test(n)) return '🪟';
  if (/\bpc\b|computer|monitor|büro|buero|laptop|drucker/.test(n)) return '💻';
  if (/herd|ofen|koch|mikrowelle/.test(n)) return '🍳';
  if (/kaffee|espresso/.test(n)) return '☕';
  if (/wallbox|auto|laden/.test(n)) return '🚗';
  if (/pumpe|heiz/.test(n)) return '♨️';
  return '🔌';
}
const trunc = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
// The biggest consumers right now for the flow diagram: heat pump, the
// individually measured devices and – with the smart meter – what nothing
// measures individually. At most 6 nodes; the smallest devices are pooled.
function kioskConsumers(houseW) {
  const hpL = _kioskHp || (STATE.hpA && STATE.hpA.live);
  const hpW = hpL && typeof hpL.power_w === 'number' ? Math.max(0, hpL.power_w) : 0;
  const devs = ((_kioskLive && _kioskLive.devices) || (STATE.data && STATE.data.live && STATE.data.live.devices) || [])
    .filter(d => typeof d.power_w === 'number' && d.power_w >= 3)
    .map(d => ({ name: d.custom_name || d.name, room: d.room, w: d.power_w, icon: kioskDevIcon(d.custom_name || d.name), col: 'var(--kb-blue)' }))
    .sort((x, y) => y.w - x.w);
  const devSum = devs.reduce((t, d) => t + d.w, 0);
  const rest = houseW != null ? Math.max(0, houseW - hpW - devSum) : 0;
  const slots = 6 - (hpW >= 5 ? 1 : 0) - (rest >= 20 ? 1 : 0);
  let shown = devs;
  if (devs.length > slots) {
    shown = devs.slice(0, slots - 1);
    const more = devs.slice(slots - 1);
    shown.push({ name: `+${more.length} weitere`, w: more.reduce((t, d) => t + d.w, 0), icon: '⋯', col: 'var(--kb-blue)' });
  }
  const out = [];
  if (hpW >= 5) out.push({ name: 'Wärmepumpe', w: hpW, icon: '♨️', col: 'var(--kb-amber)' });
  out.push(...shown);
  if (rest >= 20) out.push({ name: 'ungemessen', w: rest, icon: '❔', col: 'var(--kb-grid)', rest: true });
  return { list: out, hpW, devSum, rest };
}
// Animated live energy-flow diagram: PV ☀️ → Haus 🏠 ↔ Batterie 🔋 ↔ Netz ⚡,
// and from the house a fan of lines to the biggest consumers right now
// (heat pump, measured devices, the not individually measured rest), with dots
// streaming along the active lines (speed/number ∝ power). Measured by the
// inverter + smart meter when connected, else an instantaneous estimate from
// the PV/load model – the caption says which.
function renderEnergyFlow() {
  const el = $('kiosk-flow'); if (!el) return;
  const M = frLiveNow(), meas = !!(M && M.has_meter);    // inverter + smart meter: all measured
  const pvE = pvNowEstimate();
  const load = loadNowKw();
  const inp = pvInputs();
  let battKwh = inp.batt, haveBatt = battKwh > 0;
  const haveCar = !meas && !!inp.v2h && inp.carKwh > 0;   // the inverter knows no car
  const havePv = !!pvE, pv = pvE ? Math.max(0, pvE.pvKw) : 0;
  const directPV = Math.min(pv, load);
  let surplus = pv - directPV, deficit = load - directPV;
  let bCh = 0, bDis = 0, cCh = 0, cDis = 0, exp = 0, imp = 0, gridToBatt = 0;
  const capB = 3.0, capC = 7.0;
  if (meas) {
    const P = pvFlowParts(M);
    haveBatt = P.hasBatt; battKwh = haveBatt ? 1 : 0;
    bCh = P.ch / 1000; bDis = P.dis / 1000; imp = P.imp / 1000; exp = P.exp / 1000;
    gridToBatt = P.gridBatt / 1000;
  } else {
    // storage chain: home battery first, then the car (if V2H)
    if (surplus > 0.02) {
      if (haveBatt) { bCh = Math.min(surplus, capB); surplus -= bCh; }
      if (haveCar && surplus > 0.02) { cCh = Math.min(surplus, capC); surplus -= cCh; }
      exp = surplus;
    }
    if (deficit > 0.02) {
      if (haveBatt) { bDis = Math.min(deficit, capB); deficit -= bDis; }
      if (haveCar && deficit > 0.02) { cDis = Math.min(deficit, capC); deficit -= cDis; }
      imp = deficit;
    }
  }
  const C = haveCar ? { list: [] } : kioskConsumers(meas ? Math.max(0, M.load_w) : null);
  const R = 27, X0 = 66, XH = 180, XG = 294, YR = 135, YC = 272;
  const dots = (path, color, kw) => {
    if (kw < 0.004) return '';
    const n = Math.max(1, Math.min(4, Math.round(kw / 0.6)));
    const dur = Math.max(0.9, Math.min(2.6, 2.6 - kw * 0.22));
    let s = '';
    // NEGATIVE begin offsets so every dot is already mid-path at t=0 – otherwise a
    // delayed dot would sit at the SVG origin (0,0) until its turn (stray corner dot).
    for (let i = 0; i < n; i++)
      s += `<circle class="kf-dot" r="3.1" fill="${color}"><animateMotion dur="${dur}s" begin="-${(i * dur / n).toFixed(2)}s" repeatCount="indefinite" path="${path}" calcMode="linear"/></circle>`;
    return s;
  };
  // base grey path + (when active) a pulsing, glowing colour overlay
  const seg = (d, color, active) => {
    let s = `<path class="kf-line" d="${d}"/>`;
    if (active) s += `<path d="${d}" stroke="${color}" stroke-width="3" stroke-linecap="round" fill="none" ` +
      `style="filter:drop-shadow(0 0 4px ${color})"><animate attributeName="opacity" values="0.35;0.8;0.35" dur="2.2s" repeatCount="indefinite"/></path>`;
    return s;
  };
  const node = (cx, cy, icon, val, label, dim, labelAbove, r = R, col) => {
    const op = dim ? ' opacity="0.4"' : '';
    const ly = labelAbove ? cy - r - 7 : cy + r + 13;
    return `<g${op}><circle class="kf-node-bg" cx="${cx}" cy="${cy}" r="${r}"${col ? ` stroke="${col}" stroke-width="1.6"` : ''}/>` +
      `<text class="kf-icon" x="${cx}" y="${cy - (r > 22 ? 2 : 1)}" text-anchor="middle"${r <= 22 ? ' style="font-size:17px"' : ''}>${icon}</text>` +
      `<text class="kf-val" x="${cx}" y="${cy + (r > 22 ? 15 : 13)}" text-anchor="middle"${r <= 22 ? ' style="font-size:10px"' : ''}>${val}</text>` +
      (label ? `<text class="kf-lbl" x="${cx}" y="${ly}" text-anchor="middle">${label}</text>` : '') + `</g>`;
  };
  const storeVal = (kwh, ch, dis) => kwh <= 0 ? '–' : ch > 0.04 ? `+${fmt(ch, 1)}` : dis > 0.04 ? `−${fmt(dis, 1)}` : '0';
  const gridVal = imp > 0.04 ? `↓${fmt(imp, 1)}` : exp > 0.04 ? `↑${fmt(exp, 1)}` : '0';
  const pvActive = pv > 0.04, battActive = bCh > 0.04 || bDis > 0.04, gridActive = imp > 0.04 || exp > 0.04;
  const cons = C.list || [];
  const vh = cons.length ? 326 : (haveCar ? 282 : 216);
  const wTxt = w => w >= 1000 ? fmt(w / 1000, 1) + ' kW' : fmt(w, 0) + ' W';
  let fan = '';
  if (cons.length) {
    const n = cons.length, span = 292, x0 = 34;
    cons.forEach((c, i) => {
      const x = n === 1 ? XH : x0 + i * span / (n - 1);
      const d = `M${XH},${YR + R} C${XH},${YR + 70} ${x.toFixed(1)},${YC - 70} ${x.toFixed(1)},${YC - 21}`;
      fan += seg(d, c.col, c.w >= 5) + dots(d, c.col, c.w / 1000);
    });
    cons.forEach((c, i) => {
      const x = n === 1 ? XH : x0 + i * span / (n - 1);
      fan += node(x, YC, c.icon, wTxt(c.w), '', false, false, 21, c.col) +
        `<text class="kf-sub" x="${x.toFixed(1)}" y="${YC + 34}" text-anchor="middle">${esc(trunc(c.name, 11))}</text>`;
    });
  }
  const svg =
    `<svg viewBox="0 -6 360 ${vh}" role="img" aria-label="Energiefluss">` +
    seg(`M${XH},69 L${XH},108`, 'var(--kb-sun)', pvActive) +
    seg(`M${X0 + R},${YR} L${XH - R},${YR}`, 'var(--kb-teal)', battActive) +
    seg(`M${XG - R},${YR} L${XH + R},${YR}`, imp > 0 ? 'var(--kb-blue)' : 'var(--kb-green)', gridActive) +
    (haveCar ? seg(`M${XH},162 L${XH},201`, 'var(--kb-teal)', cCh > 0.04 || cDis > 0.04) : '') +
    dots(`M${XH},69 L${XH},108`, 'var(--kb-sun)', meas ? pv : directPV + bCh + cCh + exp) +
    (bCh > 0 ? dots(`M${XH - R},${YR} L${X0 + R},${YR}`, 'var(--kb-teal)', bCh) : dots(`M${X0 + R},${YR} L${XH - R},${YR}`, 'var(--kb-teal)', bDis)) +
    (imp > 0 ? dots(`M${XG - R},${YR} L${XH + R},${YR}`, 'var(--kb-blue)', imp) : dots(`M${XH + R},${YR} L${XG - R},${YR}`, 'var(--kb-green)', exp)) +
    (haveCar ? (cCh > 0 ? dots(`M${XH},162 L${XH},201`, 'var(--kb-teal)', cCh) : dots(`M${XH},201 L${XH},162`, 'var(--kb-teal)', cDis)) : '') +
    fan +
    node(XH, 42, '☀️', havePv && pvActive ? fmt(pv, 1) : (havePv ? '0' : '–'), 'PV kW', !havePv || !pvActive, true) +
    node(X0, YR, '🔋', storeVal(battKwh, bCh, bDis), meas && M.soc != null ? `Batterie ${fmt(M.soc, 0)} %` : 'Batterie', !haveBatt) +
    node(XH, YR, '🏠', fmt(load, 1), haveCar || cons.length ? '' : 'Haus kW') +
    node(XG, YR, '⚡', gridVal, 'Netz', !gridActive) +
    (haveCar ? node(XH, 228, '🚗', storeVal(inp.carKwh, cCh, cDis), 'E-Auto (V2H)', false) : '') +
    `</svg>`;
  const houseW = meas ? Math.max(0, M.load_w) : null;
  const sum = cons.length ? `Haus <b>${wTxt(houseW != null ? houseW : load * 1000)}</b>` +
    (C.hpW >= 5 ? ` = Wärmepumpe ${wTxt(C.hpW)}` : '') + (C.devSum > 0 ? ` + Geräte ${wTxt(C.devSum)}` : '') +
    (C.rest >= 20 ? ` + <b>nicht einzeln gemessen ${wTxt(C.rest)}</b>` : '') + ' · ' : '';
  el.innerHTML = svg +
    `<div class="k-sub" style="text-align:center;font-size:11px;margin:2px 0 6px">` + sum +
    `Speicher +laden/−entladen · Netz ↓Bezug/↑Einspeisung · ` +
    (meas ? (STATE.fr.demo ? '<b>Demo-Werte</b> (simulierte Anlage)'
      : `<b>gemessen</b> (Wechselrichter, ${new Date(STATE.fr.last_poll * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })})`) +
      (gridToBatt > 0.025 ? ` · 🔋 lädt ${fmt(gridToBatt, 2)} kW <b>aus dem Netz</b>` : '')
      : `Momentan-Schätzung (${pvE ? pvE.src : 'ohne PV'})` + frSilentNote()) + `</div>`;
}
// The consumers now live in the flow diagram (lines from the house) – the old
// list is gone.
function renderKioskLoads() { const el = $('kiosk-loads'); if (el) el.innerHTML = ''; }

// ---- dashboard settings (Setup → Wohn-Dashboard; synced to all devices) --------
const KIOSK_DEF = { win_s: 600, bin_days: 1 };
function kioskSetting(k) {
  let v = null; try { v = localStorage.getItem('bhe_kiosk_' + k); } catch (e) {}
  const n = parseFloat(v);
  if (!isFinite(n)) return KIOSK_DEF[k];
  return k === 'bin_days' ? Math.max(1, Math.min(7, Math.round(n))) : Math.max(1, Math.min(86400, n));
}
// the dashboard runs for days without a reload: take over changes made on
// another device (the bridge holds the synced settings)
async function kioskPullSettings() {
  try {
    const r = await api('/api/settings'), srv = (r && r.settings) || {}, unsent = _unsentGet();
    ['bhe_kiosk_win_s', 'bhe_kiosk_bin_days', 'bhe_school_plan', 'bhe_school_title'].forEach(k => {
      if (srv[k] != null && !(k in unsent)) { try { localStorage.setItem(k, srv[k]); _lastSynced[k] = srv[k]; } catch (e) {} }
    });
  } catch (e) { /* keep the local values */ }
}

// ---- awareness tiles: what needs attention now (urgent ones pulse) ------------
const fmtMin = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
const fmtAgo = sec => sec < 60 ? `${Math.max(0, Math.floor(sec))} s` : fmtMin(Math.floor(sec / 60));
const TRASH_RX = /m(ü|ue)ll|tonne|abfuhr|papier|gelber sack|wertstoff|sperrm/i;
function kioskAlerts() {
  const A = [], now = Date.now() / 1000;
  const rooms = _kioskRooms || [], since = (_hdData && _hdData.window_since) || {};
  const outC = _hdData && _hdData.kpis ? _hdData.kpis.outdoor_c : null;
  // 1) windows / doors open – longer than the set time (default 10 min): pulsing
  const winS = kioskSetting('win_s');
  rooms.filter(rm => (rm.windows_open || 0) > 0).forEach(rm => {
    const ws = (rm.windows || []).filter(w => w.open);
    const door = ws.length > 0 && ws.every(w => w.door);
    const t0 = since[rm.room];
    const secs = t0 ? Math.max(0, now - t0) : null;
    const long = secs != null && secs >= winS;
    const heating = rm.heating === true, cold = outC != null && outC < 12;
    const level = _kioskAway || (long && (heating || cold)) ? 'urgent' : long ? 'warn' : 'info';
    A.push({ level, blink: _kioskAway || long, icon: door ? '🚪' : '🪟',
      title: `${rm.room}: ${door ? 'Tür' : 'Fenster'} offen`,
      detail: [secs == null ? 'offen' : secs < 20 && winS >= 60 ? 'gerade geöffnet' : `seit ${fmtAgo(secs)}`,
        _kioskAway ? 'ihr seid abwesend' : '', heating ? 'Heizung läuft' : (cold ? `außen ${fmt(outC, 0)}°` : ''),
        long && !door ? 'bitte schließen' + (winS >= 300 ? ' – Stoßlüften reicht 5–10 min' : '') : '',
        ws.length > 1 ? ws.map(w => w.name).join(', ') : ''].filter(Boolean).join(' · ') });
  });
  // 2) air / humidity (rooms without an open window) and clearly too cold rooms
  rooms.forEach(rm => {
    if ((rm.windows_open || 0) > 0) return;
    const va = ventAdvice(rm);
    if (va.lvl === 'warn') A.push({ level: 'warn', icon: '🌬️', title: `${rm.room}: lüften`, detail: va.short || va.txt });
    if (rm.temp != null && rm.setpoint != null && rm.temp <= rm.setpoint - 1.5)
      A.push({ level: 'info', icon: '🥶', title: `${rm.room}: zu kalt`, detail: `${fmt(rm.temp, 1)}° statt ${fmt(rm.setpoint, 0)}°` });
  });
  // 3) calendar: what starts within the hour; bins the evening before / that morning
  const C = _kioskCal;
  if (C && C.events) {
    const h = new Date().getHours(), todayNoon = new Date(ymdLocal(new Date()) + 'T12:00:00');
    const ahead = d => Math.round((new Date(d + 'T12:00:00') - todayNoon) / 86400000);   // days until d
    const binDays = kioskSetting('bin_days'), bins = {};
    C.events.forEach(e => {
      if (!e.all_day && e.start > now && e.start - now <= 3600)
        A.push({ level: e.start - now <= 900 ? 'warn' : 'info', blink: e.start - now <= 900, icon: '📅',
          title: `In ${Math.max(1, Math.round((e.start - now) / 60))} min: ${e.title}`,
          detail: new Date(e.start * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr' + (e.location ? ' · ' + e.location : '') });
      if (e.all_day && TRASH_RX.test(e.title)) {
        const k = ahead(e.start_day);
        if (k >= 0 && k <= binDays) { bins[k] = bins[k] || []; if (bins[k].indexOf(e.title) < 0) bins[k].push(e.title); }
      }
    });
    // shown from 16:00 on the evening `binDays` days before until 10:00 on the day itself
    const many = n => n > 1 ? 'Tonnen' : 'Tonne';
    Object.keys(bins).map(Number).sort((x, y) => x - y).forEach(k => {
      const show = k === 0 ? h < 10 : k < binDays ? true : h >= 16;
      if (!show) return;
      const n = bins[k].length, day = new Date(todayNoon.getTime() + k * 86400000);
      const when = k === 0 ? 'Heute' : k === 1 ? 'Morgen' : k === 2 ? 'Übermorgen'
        : 'Am ' + day.toLocaleDateString('de-DE', { weekday: 'long' });
      A.push({ level: k <= 1 ? 'warn' : 'info', icon: '🗑️', title: `${when}: ${bins[k].join(' + ')}`,
        detail: k === 0 ? `${many(n)} rausstellen, falls noch nicht geschehen`
          : k === 1 ? `${many(n)} heute Abend rausstellen`
          : `Abholung in ${k} Tagen (${day.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })}) – am Vorabend rausstellen` });
    });
  }
  // 4) PV system / battery
  const M = frLiveNow();
  if (M) {
    const P = pvFlowParts(M);
    if (P.gridBatt > 100) A.push({ level: 'info', icon: '🔋', title: 'Batterie lädt aus dem Netz',
      detail: `${kwOrW(P.gridBatt)}${M.soc != null ? ` · Ladestand ${fmt(M.soc, 0)} %` : ''}${M.battery_mode ? ` · „${M.battery_mode}“` : ''}` });
    if (M.load_w != null && M.load_w >= 6000) {
      const C2 = kioskConsumers(M.load_w), top = (C2.list || []).filter(c => !c.rest)[0];
      A.push({ level: 'info', icon: '⚡', title: `Hoher Verbrauch: ${kwOrW(M.load_w)}`, detail: top ? `größter: ${top.name} ${kwOrW(top.w)}` : '' });
    }
  } else if (STATE.fr && STATE.fr.connected && !STATE.fr.demo) {
    const note = frSilentNote().replace(/^ · ⚠︎ /, '');
    A.push({ level: 'warn', icon: '☀️', title: 'PV-Anlage: keine aktuellen Werte', detail: note || 'Wechselrichter antwortet nicht' });
  }
  // 5) heat pump without fresh data
  const hl = _kioskHp || (STATE.hpA && STATE.hpA.live);
  if (hl && (hl.last_error || (hl.last_poll && now - hl.last_poll > 1500))) {
    const ago = hl.last_poll ? Math.round((now - hl.last_poll) / 60) : null;
    A.push({ level: 'warn', icon: '♨️', title: 'Wärmepumpe: keine aktuellen Daten',
      detail: (ago != null ? `letzte Werte vor ${fmtMin(ago)}` : '') + (hl.last_error ? (ago != null ? ' · ' : '') + trunc(hl.last_error, 70) : '') });
  }
  try { schoolAlerts(A); } catch (e) { console.error(e); }
  const rank = { urgent: 0, warn: 1, info: 2, good: 3 };
  return A.sort((x, y) => rank[x.level] - rank[y.level]);
}
function renderKioskAlerts() {
  const el = $('kiosk-alerts'); if (!el) return;
  const A = kioskAlerts();
  const w = $('kiosk-warn'); if (w) w.textContent = '';               // folded into the tiles
  if (!A.length) { el.innerHTML = '<div class="ka-ok">✓ Alles in Ordnung – nichts offen, nichts zu tun.</div>'; return; }
  el.innerHTML = A.slice(0, 9).map(a => `<div class="ka ka-${a.level}${a.blink ? ' ka-blink' : ''}">` +
    `<div class="ka-ic">${a.icon}</div><div class="ka-tx"><div class="ka-t">${esc(a.title)}</div>` +
    (a.detail ? `<div class="ka-d">${esc(a.detail)}</div>` : '') + `</div></div>`).join('') +
    (A.length > 9 ? `<div class="ka-ok" style="color:var(--k-sub)">+ ${A.length - 9} weitere</div>` : '');
}


// ---- school timetable (Setup → Stundenplan; kept in the synced settings, so it
// lives only in the bridge – never in the code) ----------------------------------
const SCHOOL_DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
// "08:10-08:55 | Unterricht | Kunst | - | Sport | Musik" per line; '-' or empty = free
function parseSchoolPlan(text) {
  const periods = [], errors = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const l = line.trim();
    if (!l || l.startsWith('#') || /^zeit\b/i.test(l)) return;
    const parts = l.split('|').map(x => x.trim());
    const m = (parts[0] || '').match(/^(\d{1,2})[.:](\d{2})\s*[-–]\s*(\d{1,2})[.:](\d{2})$/);
    if (!m) { errors.push(i + 1); return; }
    const hm = (h, mi) => String(+h).padStart(2, '0') + ':' + mi;
    const subj = [];
    for (let d = 0; d < 5; d++) {
      const x = (parts[d + 1] || '').trim();
      subj.push(!x || /^[-–—]+$/.test(x) ? '' : x);
    }
    periods.push({ from: hm(m[1], m[2]), to: hm(m[3], m[4]), subj });
  });
  periods.sort((a, b) => a.from.localeCompare(b.from));
  return { periods, errors };
}
function schoolPlan() {
  let t = ''; try { t = localStorage.getItem('bhe_school_plan') || ''; } catch (e) {}
  const P = parseSchoolPlan(t);
  return P.periods.length ? P : null;
}
// Easter Sunday (Gregorian) – for the moveable holidays
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mo - 1, da, 12);
}
// public holidays in North Rhine-Westphalia (school-free) → {'YYYY-MM-DD': name}
function holidaysNRW(y) {
  const E = easterSunday(y), off = n => ymdLocal(new Date(E.getTime() + n * 86400000));
  const H = { [`${y}-01-01`]: 'Neujahr', [off(-2)]: 'Karfreitag', [off(1)]: 'Ostermontag', [`${y}-05-01`]: 'Tag der Arbeit',
    [off(39)]: 'Christi Himmelfahrt', [off(50)]: 'Pfingstmontag', [off(60)]: 'Fronleichnam',
    [`${y}-10-03`]: 'Tag der Deutschen Einheit', [`${y}-11-01`]: 'Allerheiligen', [`${y}-12-25`]: '1. Weihnachtstag',
    [`${y}-12-26`]: '2. Weihnachtstag' };
  return H;
}
const SCHOOL_FREE_RX = /ferien|schulfrei|unterrichtsfrei|beweglicher ferientag|brückentag/i;
// why there is no school on that day (null = school day)
function schoolFreeReason(d) {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return 'Wochenende';
  const ymd = ymdLocal(d), hol = holidaysNRW(d.getFullYear())[ymd];
  if (hol) return hol;
  const ev = ((_kioskCal && _kioskCal.events) || []).find(e => e.all_day && SCHOOL_FREE_RX.test(e.title) &&
    e.start_day <= ymd && e.end_day >= ymd);
  return ev ? ev.title : null;
}
// the lessons of one weekday, neighbouring periods with the same subject merged
function schoolLessons(P, d) {
  const di = d.getDay() - 1;
  if (di < 0 || di > 4) return [];
  const out = [];
  P.periods.forEach(p => {
    const sj = p.subj[di]; if (!sj) return;
    const last = out[out.length - 1];
    if (last && last.subj === sj && last.to === p.from) { last.to = p.to; last.periods++; }   // back to back
    else out.push({ from: p.from, to: p.to, subj: sj, periods: 1 });
  });
  return out;
}
const minOfDay = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
// which day to show: today until school is out, else the next school day
function schoolTarget(P) {
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  for (let k = 0; k < 21; k++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + k, 12);
    if (schoolFreeReason(d)) continue;
    const L = schoolLessons(P, d);
    if (!L.length) continue;
    if (k === 0 && nowMin >= minOfDay(L[L.length - 1].to)) continue;      // already out today
    return { d, k, L };
  }
  return null;
}
function renderKioskSchool() {
  const el = $('kiosk-school'); if (!el) return;
  const P = schoolPlan();
  if (!P) { el.innerHTML = ''; return; }
  let title = 'Stundenplan'; try { title = localStorage.getItem('bhe_school_title') || title; } catch (e) {}
  const T = schoolTarget(P);
  if (!T) { el.innerHTML = `<div class="kl-title">🎒 ${esc(title)}</div><div class="k-sub">In den nächsten drei Wochen kein Schultag.</div>`; return; }
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const todayFree = schoolFreeReason(now);
  const dayTxt = T.k === 0 ? 'Heute' : T.k === 1 ? 'Morgen' : T.d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'numeric' });
  const start = T.L[0].from, end = T.L[T.L.length - 1].to;
  const rows = T.L.map(l => {
    const on = T.k === 0 && nowMin >= minOfDay(l.from) && nowMin < minOfDay(l.to);
    const past = T.k === 0 && nowMin >= minOfDay(l.to);
    return `<div class="kc-row${on ? ' on' : ''}"${past ? ' style="opacity:.45"' : ''}><span class="kc-dot" style="background:${/sport|schwimm|turn/i.test(l.subj) ? 'var(--kb-green)' : 'var(--kb-amber)'}"></span>` +
      `<span class="kc-time">${l.from}–${l.to}</span><span class="kc-title">${esc(l.subj)}</span>` +
      (on ? '<span class="kc-b kc-now">jetzt</span>' : '') + `</div>`;
  }).join('');
  el.innerHTML = `<div class="kl-title">🎒 ${esc(title)}</div>` +
    (T.k > 0 && todayFree && todayFree !== 'Wochenende' ? `<div class="k-sub" style="margin-bottom:6px">Heute schulfrei: ${esc(todayFree)}</div>` : '') +
    (() => {          // a free day before the shown one (holiday / Ferien tomorrow)
      if (T.k < 2) return '';
      const tm = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12), r = schoolFreeReason(tm);
      return r && r !== 'Wochenende' ? `<div class="k-sub" style="margin-bottom:6px">Morgen schulfrei: ${esc(r)}</div>` : '';
    })() +
    `<div class="kc-day" style="margin-top:4px">${dayTxt} · ${start}–${end} · Schulschluss ${end}</div>` + rows;
}
// awareness: sports kit the evening before / that morning, school out soon
function schoolAlerts(A) {
  const P = schoolPlan(); if (!P) return;
  const now = new Date(), h = now.getHours(), nowMin = h * 60 + now.getMinutes();
  const kit = L => {
    const s = L.map(l => l.subj).join(' ');
    return /schwimm/i.test(s) ? ['Schwimmen', 'Schwimmsachen'] : /sport|turn/i.test(s) ? ['Sport', 'Sportsachen'] : null;
  };
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12), tomorrow = new Date(today.getTime() + 86400000);
  const Lt = schoolFreeReason(today) ? [] : schoolLessons(P, today), Lm = schoolFreeReason(tomorrow) ? [] : schoolLessons(P, tomorrow);
  const kt = kit(Lt), km = kit(Lm);
  if (kt && Lt.length && nowMin < minOfDay(Lt[0].from))
    A.push({ level: 'warn', icon: '🎒', title: `Heute ${kt[0]}`, detail: `${kt[1]} nicht vergessen – Schule ab ${Lt[0].from}` });
  if (km && h >= 16) A.push({ level: 'warn', icon: '🎒', title: `Morgen ${km[0]}`, detail: `${km[1]} heute Abend einpacken` });
  if (Lt.length) {
    const end = minOfDay(Lt[Lt.length - 1].to);
    if (nowMin >= end - 30 && nowMin < end)
      A.push({ level: 'info', icon: '🏫', title: `Schule aus um ${Lt[Lt.length - 1].to}`, detail: `in ${end - nowMin} min` });
  }
}

// ---- calendar (public iCloud / Google / .ics, read by the bridge) -------------
let _kioskCal = null;
async function kioskLoadCal() {
  try { const r = await api('/api/calendar?days=7'); if (r && r.ok !== false) _kioskCal = r; } catch (e) { /* keep */ }
}
function renderKioskCal() {
  const el = $('kiosk-cal'); if (!el) return;
  const C = _kioskCal;
  if (!C || (!C.configured && !C.demo)) { el.innerHTML = ''; return; }
  const now = Date.now() / 1000, today = ymdLocal(new Date()), tomorrow = ymdLocal(new Date(Date.now() + 86400000));
  const dayName = d => d === today ? 'Heute' : d === tomorrow ? 'Morgen'
    : new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'numeric' });
  const hm = t => new Date(t * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const groups = {};
  (C.events || []).forEach(e => {
    let day;
    if (e.all_day) day = e.start_day <= today && e.end_day >= today ? today : e.start_day;
    else { if (e.end <= now) return; day = e.start < now ? today : ymdLocal(new Date(e.start * 1000)); }
    (groups[day] = groups[day] || []).push(e);
  });
  const days = Object.keys(groups).sort();
  let rows = 0, html = '';
  for (const d of days) {
    if (rows >= 11) break;
    html += `<div class="kc-day">${dayName(d)}</div>`;
    for (const e of groups[d]) {
      if (rows >= 11) break;
      rows++;
      const on = !e.all_day && e.start <= now && e.end > now, soon = !e.all_day && e.start > now && e.start - now <= 3600;
      const time = e.all_day ? (e.end_day > e.start_day ? `bis ${new Date(e.end_day + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short' })}` : 'ganztägig')
        : `${hm(e.start)}${e.end > e.start ? '–' + hm(e.end) : ''}`;
      const badge = on ? '<span class="kc-b kc-now">jetzt</span>'
        : soon ? `<span class="kc-b kc-soon">in ${Math.max(1, Math.round((e.start - now) / 60))} min</span>` : '';
      html += `<div class="kc-row${on ? ' on' : ''}"><span class="kc-dot" style="background:${esc(e.color || 'var(--kb-blue)')}"></span>` +
        `<span class="kc-time">${time}</span><span class="kc-title">${esc(e.title)}` +
        (e.location ? ` <span class="kc-loc">· ${esc(e.location)}</span>` : '') + `</span>${badge}</div>`;
    }
  }
  const errs = (C.calendars || []).filter(c => c.error);
  el.innerHTML = `<div class="kl-title">📅 Termine</div>` +
    (html || '<div class="k-sub">Keine Termine in den nächsten 7 Tagen.</div>') +
    errs.map(c => `<div class="k-sub" style="font-size:12px;margin-top:8px;color:var(--kb-amber)">⚠︎ ${esc(c.name || 'Kalender')}: ${esc(c.error)}</div>`).join('');
}
function paintKiosk() {
  const rooms = _kioskRooms || [];
  // away toggle button state
  const ab = $('kiosk-away');
  if (ab) { ab.classList.toggle('away', _kioskAway); ab.textContent = _kioskAway ? '🚪 Abwesend' : '🏠 Zuhause'; }
  // open-window warning (urgent when away, or when heating against an open window)
  const openRooms = rooms.filter(rm => (rm.windows_open || 0) > 0);
  const heatOpen = openRooms.filter(rm => rm.heating === true).map(rm => esc(rm.room));
  const warn = $('kiosk-warn');
  if (warn) {
    if (_kioskAway && openRooms.length)
      warn.textContent = `⚠️ Abwesend, aber Fenster/Tür offen: ${openRooms.map(rm => rm.room).join(', ')}`;
    else if (heatOpen.length)
      warn.innerHTML = `⚠️ Heizung läuft gegen offenes Fenster: <b>${heatOpen.join(', ')}</b> – schließen oder Thermostat runter.`;
    else warn.textContent = '';
  }
  const out = kioskWashAdvice();
  const ban = $('kiosk-banner');
  if (ban) {
    ban.className = out ? out.level : '';
    ban.innerHTML = out ? `${out.line}<div class="b-sub">${out.sub}</div>` : '';     // nothing to say → no banner
  }
  try { renderKioskAlerts(); } catch (e) { console.error(e); }
  try { renderKioskCal(); } catch (e) { console.error(e); }
  try { renderKioskSchool(); } catch (e) { console.error(e); }
  try { renderEnergyFlow(); } catch (e) { console.error(e); }
  try { renderKioskToday(); } catch (e) { console.error(e); }
  try { renderKioskLoads(); } catch (e) {}
  const og = $('kiosk-out');
  const hp = (_hdData && _hdData.kpis) || {};
  if (og) og.innerHTML = (_kioskAway ? '🚪 Abwesend · ' : '') + (hp.outdoor_c != null ? `🌡️ außen ${fmt(hp.outdoor_c, 0)}°${hp.heating_now ? ' · WP heizt' : ''}` : '');
  const grid = $('kiosk-rooms');
  if (grid) grid.innerHTML = rooms.map(rm => {
    const tags = [];
    if ((rm.windows_open || 0) > 0) tags.push(`<span style="color:var(--kb-amber)">🪟 offen</span>`);
    if (rm.air) { const ar = airRate(rm.air, rm.air_purity); tags.push(`<span style="color:${kcol(ar.lvl)}">● Luft ${ar.word}</span>`); }
    if (rm.humidity != null) { const hr = rateMetric('humidity', rm.humidity); tags.push(`<span style="color:${kcol(hr.lvl)}">${fmt(rm.humidity, 0)}%</span>`); }
    const va = ventAdvice(rm);
    if (va.lvl === 'warn') tags.push(`<span style="color:var(--kb-red)">🌬️ lüften${va.short ? ` · ${va.short}` : ''}</span>`);
    const heat = rm.heating === true ? ' 🔥' : '';
    const cold = rm.setpoint != null && rm.temp != null && rm.temp <= rm.setpoint - 1.0;
    return `<div class="kroom"><div class="kr-name"><span>${esc(rm.room)}</span><span>${heat}</span></div>` +
      `<div class="kr-temp"${cold ? ' style="color:var(--kb-amber)"' : ''}>${rm.temp != null ? fmt(rm.temp, 1) + '°' : '–'}</div>` +
      `<div class="kr-set">Soll ${rm.setpoint != null ? fmt(rm.setpoint, 0) + '°' : '–'}</div>` +
      (tags.length ? `<div class="kr-tags">${tags.join('')}</div>` : '') + `</div>`;
  }).join('') || '<div class="k-sub">Keine Raumdaten – läuft die Bridge?</div>';
  // ventilation one-liner (with the reason per room, so it's never a mystery)
  const vent = rooms.map(rm => ({ rm, a: ventAdvice(rm) })).filter(x => x.a.lvl === 'warn')
    .map(x => `${esc(x.rm.room)}${x.a.short ? ` (${x.a.short})` : ''}`);
  const ve = $('kiosk-vent');
  if (ve) ve.innerHTML = vent.length ? `🌬️ <b>Lüften empfohlen:</b> ${vent.join(', ')} – kurz stoßlüften.` : '✓ Lüften: überall ok.';
  const up = $('kiosk-updated'); if (up) up.textContent = 'aktualisiert ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
let _kioskWinT = null;
// while a window/door is open the rooms are looked at every 20 s (else with the
// regular minute), so "open for longer than …" reacts quickly
function kioskWatchWindows() {
  clearTimeout(_kioskWinT); _kioskWinT = null;
  if (!kioskOpen() || !(_kioskRooms || []).some(rm => (rm.windows_open || 0) > 0)) return;
  _kioskWinT = setTimeout(async () => {
    try {
      const r = await api('/api/heating/diag');
      if (r && (r.rooms || r.ok !== false)) { _hdData = r; _kioskRooms = r.rooms || []; }
    } catch (e) { /* keep */ }
    try { paintKiosk(); } catch (e) {}
    kioskWatchWindows();
  }, 20000);
}
async function kioskLoadData() {
  try {
    const r = await api('/api/heating/diag');
    if (r && (r.rooms || r.ok !== false)) { _hdData = r; _kioskRooms = r.rooms || []; }
  } catch (e) { /* keep whatever we had */ }
  kioskWatchWindows();
  try { if (!STATE.spot) STATE.spot = await api('/api/spot'); } catch (e) {}
  // light live-power refresh (small window = cheap; the live snapshot is the
  // latest sample regardless) – kept separate so the other tabs' 90-day data stays.
  try { const a = await api('/api/analytics?days=2'); if (a && a.live) _kioskLive = a.live; } catch (e) {}
  try { const h = await api('/api/heatpump/analytics?days=2'); if (h && h.live) _kioskHp = h.live; } catch (e) {}
  try { await loadFronius(true); } catch (e) {}
  try { await kioskLoadCal(); } catch (e) {}
  try { await kioskPullSettings(); } catch (e) {}
  paintKiosk();
}
function kioskTick() {
  const c = $('kiosk-clock'), d = $('kiosk-date');
  const now = new Date();
  if (c) c.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d) d.textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
}
// Apple-like light/dark theme for the kiosk: dark unless light was chosen on this device.
function kioskTheme() {
  // the choice is remembered on THIS device (a wall iPad and a phone may differ),
  // deliberately outside the synced bhe_* settings; default: dark
  try { const s = localStorage.getItem('kiosk_theme'); if (s === 'light' || s === 'dark') return s; } catch (e) {}
  return 'dark';
}
function applyKioskTheme(t) {
  const k = $('kiosk'); if (!k) return;
  k.setAttribute('data-ktheme', t);
  const b = $('kiosk-theme'); if (b) b.textContent = t === 'light' ? '☀️' : '🌙';
  try { const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', t === 'light' ? '#f2f2f7' : '#000000'); } catch (e) {}
}
function openKiosk() {
  const k = $('kiosk'); if (!k) return;
  k.hidden = false;
  applyKioskTheme(kioskTheme());
  try { if (location.hash !== '#dash') history.replaceState(null, '', '#dash'); } catch (e) {}
  kioskTick(); paintKiosk(); kioskLoadData();
  clearInterval(_kioskClockT); _kioskClockT = setInterval(kioskTick, 1000);
  clearInterval(_kioskDataT); _kioskDataT = setInterval(kioskLoadData, 60000);
}
function closeKiosk() {
  const k = $('kiosk'); if (k) k.hidden = true;
  clearInterval(_kioskClockT); clearInterval(_kioskDataT); _kioskClockT = _kioskDataT = null;
  clearTimeout(_kioskWinT); _kioskWinT = null;
  try { const m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', '#0b1220'); } catch (e) {}
  try { if (location.hash === '#dash') history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
}
async function renderHeatingDiag(force) {
  const card = $('hd-card'); if (!card) return;
  if (_hdData && !force) { paintHeatingDiag(_hdData); return; }
  if (_hdBusy) return;
  _hdBusy = true;
  if (force) { const h = $('hd-head'); if (h) h.innerHTML = '<span style="color:var(--muted);font-weight:400">lädt …</span>'; }
  try {
    const r = await api('/api/heating/diag');
    if (r && r.ok) { _hdData = r; paintHeatingDiag(r); }
    else { hdMessage((r && r.error) || 'Keine Thermostat-Daten gefunden.'); }
  } catch (e) {
    hdMessage('Nur mit laufender Bridge &amp; gekoppelten Bosch-Thermostaten verfügbar.');
  } finally { _hdBusy = false; }
}
function hdMessage(msg) {
  const head = $('hd-head'); if (head) head.textContent = '';
  const k = $('hd-kpi'), f = $('hd-findings'), ro = $('hd-rooms'), n = $('hd-note');
  if (k) k.innerHTML = ''; if (ro) ro.innerHTML = ''; if (n) n.textContent = '';
  if (f) f.innerHTML = `<div class="note">${msg}</div>`;
}
function paintHeatingDiag(r) {
  const K = r.kpis || {}, F = r.findings || [], rooms = r.rooms || [];
  // header counts
  const badge = (sev, n) => n ? `<span style="color:${HD_SEV[sev].c};margin-left:8px;white-space:nowrap">${HD_SEV[sev].ic} ${n}</span>` : '';
  const head = $('hd-head');
  if (head) head.innerHTML = badge('high', K.n_high) + badge('warn', K.n_warn) + badge('info', K.n_info) + badge('ok', K.n_ok);
  // operating-point tiles + verdict
  const tile = (l, v, col) => `<div style="background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:8px 10px;text-align:center">` +
    `<div style="font-size:18px;font-weight:700;color:${col || 'var(--ink)'}">${v}</div><div style="font-size:11px;color:var(--muted)">${l}</div></div>`;
  const u = (x, s, d = 0) => (x == null ? '–' : fmt(x, d) + ' ' + s);
  const modeTxt = HD_MODE[(K.mode || '').toLowerCase()] || (K.mode || '–');
  const spreadCol = K.spread_k == null ? '' : (K.spread_k < 3 || K.spread_k > 10 ? '#ffb64d' : '#4be0b0');
  const flowCol = (K.supply_c != null && K.ideal_flow_c != null)
    ? (K.supply_c - K.ideal_flow_c >= 8 ? '#ff6b8a' : K.supply_c - K.ideal_flow_c >= 4 ? '#ffb64d' : '#4be0b0') : '';
  const verdictCol = K.n_high ? '#ff6b8a' : K.n_warn ? '#ffb64d' : '#4be0b0';
  // rough €/year: saving fraction × WP annual energy × price (same WP basis as Rechenbasis)
  const wpY = (typeof hpMonthEst === 'function') ? (() => { let s = 0; for (let m = 0; m < 12; m++) s += hpMonthEst(m); return s; })() : 0;
  const price = STATE.price || 0;
  const eur = pct => (wpY > 0 && price > 0 && pct > 0) ? Math.round(pct * wpY * price) : null;
  const totEur = eur(K.saving_pct_total);
  const saveBadge = totEur ? ` · <span style="color:#4be0b0">geschätztes Sparpotenzial ~<b>${money(totEur)}/Jahr</b></span>` : '';
  $('hd-kpi').innerHTML =
    `<div style="font-weight:700;color:${verdictCol};margin-bottom:10px">${esc(r.verdict || '')}${saveBadge}</div>` +
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:8px">` +
    tile('Außen', u(K.outdoor_c, '°C'), '') +
    tile(glossV('Vorlauf', 'vorlauf'), u(K.supply_c, '°C'), flowCol) +
    tile('Rücklauf', u(K.return_c, '°C'), '') +
    tile(glossV('Spreizung', 'spread_k'), u(K.spread_k, 'K', 1), spreadCol) +
    tile('Modus', modeTxt, '') +
    tile(glossV('Ø Takt', 'taktung'), K.cycle_min != null ? fmt(K.cycle_min, 0) + ' min' : '–', '') +
    `</div>`;
  // findings (high/warn/info as cards, ok as a compact green line)
  const main = F.filter(f => f.severity !== 'ok');
  const oks = F.filter(f => f.severity === 'ok');
  const fx = main.map(f => {
    const m = HD_SEV[f.severity] || HD_SEV.info;
    const fe = eur(f.saving_pct);
    const val = f.value ? `<span style="font-size:12px;color:var(--muted);white-space:nowrap">${esc(f.value)}` +
      (f.target ? ` → <b style="color:var(--ink)">${esc(f.target)}</b>` : '') +
      (fe ? ` · <b style="color:#4be0b0">~${money(fe)}/J</b>` : '') + `</span>` : '';
    return `<div style="border-left:3px solid ${m.c};background:var(--card2);border-radius:8px;padding:10px 12px;margin-bottom:8px">` +
      `<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">` +
      `<b style="color:${m.c}">${m.ic} ${esc(f.title)}</b>${val}</div>` +
      `<div style="font-size:13px;margin-top:4px;line-height:1.45">${esc(f.detail)}</div>` +
      (f.fix ? `<div style="font-size:13px;margin-top:6px;color:var(--accent2)">→ ${esc(f.fix)}</div>` : '') +
      `</div>`;
  }).join('');
  const okLine = oks.length ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">✓ ` +
    oks.map(f => esc(f.title.replace(/ im .*|unauffällig|im sinnvollen Bereich|im Zielbereich/i, '').trim()) || esc(f.title)).join(' · ') + `</div>` : '';
  $('hd-findings').innerHTML = (fx || '<div class="note">Keine auffälligen Punkte gefunden. 👍</div>') + okLine;
  // room table
  if (rooms.length) {
    const hit = new Set();
    F.forEach(f => (f.rooms || []).forEach(n => hit.add(n)));
    const modeOf = rm => rm.summerMode ? 'Sommer' : (String(rm.roomControlMode).toUpperCase() === 'OFF' ? 'Aus'
      : (String(rm.operationMode).toUpperCase() === 'MANUAL' ? 'Manuell' : 'Auto'));
    const vbar = v => {
      if (v == null) return '<span style="color:var(--muted)">–</span>';
      const col = v < 50 ? '#ff6b8a' : v < 80 ? '#ffb64d' : '#4be0b0';
      return `<span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:38px;height:6px;border-radius:3px;background:var(--line);position:relative">` +
        `<span style="position:absolute;left:0;top:0;height:6px;border-radius:3px;width:${Math.max(4, v)}%;background:${col}"></span></span>${v}%</span>`;
    };
    // Ventil-%, wenn vorhanden; sonst der Heiz-Zustand des Raumthermostats
    // (🔥 heizt / ⏸ aus). "~" = abgeleitet (Soll>Ist), ohne = vom Gerät gemeldet.
    const ventilCell = rm => {
      if (rm.valve != null) return vbar(rm.valve);
      if (rm.heating === true) return `<span style="color:#ff6b8a;white-space:nowrap" title="${rm.heating_src === 'abgeleitet' ? 'abgeleitet aus Soll/Ist' : 'vom Thermostat gemeldet'}">🔥 heizt${rm.heating_src === 'abgeleitet' ? ' <span style="color:var(--muted)">~</span>' : ''}</span>`;
      if (rm.heating === false) return `<span style="color:#4be0b0;white-space:nowrap" title="${rm.heating_src === 'abgeleitet' ? 'abgeleitet aus Soll/Ist' : 'vom Thermostat gemeldet'}">⏸ aus${rm.heating_src === 'abgeleitet' ? ' <span style="color:var(--muted)">~</span>' : ''}</span>`;
      return '<span style="color:var(--muted)">–</span>';
    };
    // room humidity with mold-risk rating (tap for the normal range)
    const humCell = rm => {
      if (rm.humidity == null) return '<span style="color:var(--muted)">–</span>';
      const rt = rateMetric('humidity', rm.humidity);
      return `<span class="ratebadge" style="color:${RATE_COL[rt.lvl]};white-space:nowrap;cursor:pointer" data-rk="humidity" data-rv="${rm.humidity}" data-rl="Luftfeuchte">${fmt(rm.humidity, 0)} %</span>`;
    };
    // window/door state (auto-read from Bosch – each contact carries its room)
    const winCell = rm => {
      const ws = rm.windows || [];
      if (!ws.length) return '<span style="color:var(--muted)">–</span>';
      const open = ws.filter(w => w.open);
      if (!open.length) return `<span style="color:var(--muted);white-space:nowrap" title="${ws.map(w => esc(w.name)).join(', ')}">✓ zu</span>`;
      const door = open.some(w => w.door);
      const icon = door ? '🚪' : '🪟';
      const lbl = open.length > 1 ? `${open.length} offen` : (door ? 'Tür offen' : 'offen');
      return `<span style="color:#ffb64d;white-space:nowrap" title="${open.map(w => esc(w.name)).join(', ')}">${icon} ${lbl}</span>`;
    };
    // Twinguard air quality (tap for the VOC value)
    const airCell = rm => {
      if (!rm.air && rm.air_purity == null) return '<span style="color:var(--muted)">–</span>';
      const ar = airRate(rm.air, rm.air_purity);
      const t = rm.air_purity != null ? `VOC ≈ ${rm.air_purity} ppm` : 'Luftqualität (Twinguard)';
      return `<span style="color:${RATE_COL[ar.lvl]};white-space:nowrap;cursor:pointer" title="${t}">● ${ar.word}</span>`;
    };
    const anyWin = rooms.some(rm => (rm.windows || []).length);
    const anyAir = rooms.some(rm => rm.air || rm.air_purity != null);
    const rowsHtml = rooms.map(rm => {
      const cold = rm.setpoint != null && rm.temp != null && rm.temp <= rm.setpoint - 1.5;
      const flag = hit.has(rm.room) ? 'border-left:3px solid #ffb64d' : 'border-left:3px solid transparent';
      const istCol = cold ? '#ffb64d' : 'var(--ink)';
      return `<tr style="${flag}"><td style="padding:6px 8px">${esc(rm.room)}</td>` +
        `<td style="padding:6px 8px;text-align:right">${rm.setpoint != null ? fmt(rm.setpoint, 0) + '°' : '–'}</td>` +
        `<td style="padding:6px 8px;text-align:right;color:${istCol}">${rm.temp != null ? fmt(rm.temp, 1) + '°' : '–'}</td>` +
        `<td style="padding:6px 8px;text-align:right">${ventilCell(rm)}</td>` +
        `<td style="padding:6px 8px;text-align:right">${humCell(rm)}</td>` +
        (anyWin ? `<td style="padding:6px 8px;text-align:right">${winCell(rm)}</td>` : '') +
        (anyAir ? `<td style="padding:6px 8px;text-align:right">${airCell(rm)}</td>` : '') +
        `<td style="padding:6px 8px;text-align:right;color:var(--muted)">${modeOf(rm)}</td></tr>`;
    }).join('');
    const th = t => `<th style="text-align:right;padding:4px 8px;font-weight:600">${t}</th>`;
    $('hd-rooms').innerHTML = `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;border-collapse:collapse;font-size:13px">` +
      `<thead><tr style="color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.3px">` +
      `<th style="text-align:left;padding:4px 8px;font-weight:600">Raum</th>` + th('Soll') + th('Ist') + th('Ventil/Heizt') + th('Feuchte') +
      (anyWin ? th('Fenster') : '') + (anyAir ? th('Luft') : '') + th('Modus') +
      `</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
    // ---- Lüften: recommend + "reicht/schließen" per room --------------------
    const ventEl = $('hd-vent');
    if (ventEl) {
      const items = rooms.map(rm => ({ rm, a: ventAdvice(rm) }))
        .filter(x => x.a.lvl !== 'na' && x.a.lvl !== 'good');     // only rooms needing attention
      if (!anyWin && !anyAir && !rooms.some(rm => rm.humidity != null)) {
        ventEl.innerHTML = '';
      } else if (!items.length) {
        ventEl.innerHTML = `<div style="font-weight:700;margin:12px 0 4px">🌬️ Lüften</div>` +
          `<div class="note">Überall ok – aktuell kein Lüften nötig (Feuchte & Luftqualität im grünen Bereich, Fenster passend).</div>`;
      } else {
        ventEl.innerHTML = `<div style="font-weight:700;margin:12px 0 4px">🌬️ Lüften</div>` +
          items.map(x => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:3px 0">` +
            `<b>${esc(x.rm.room)}</b><span style="color:${RATE_COL[x.a.lvl]};text-align:right">${x.a.txt}</span></div>`).join('') +
          `<div class="note" style="margin-top:5px">Stoßlüften (5–10 min, Fenster ganz auf) ist wirksamer und sparsamer als Dauerkippen. ` +
          `Bei aktiver Heizung erst Thermostat/Ventil kurz runter.</div>`;
      }
    }
  } else {
    $('hd-rooms').innerHTML = '<div class="note">Keine Raumthermostate gefunden.</div>';
  }
  const note = $('hd-note');
  if (note) note.innerHTML = (r.demo ? '<b>Demo-Daten</b> (Beispielräume). ' : '') +
    'Betriebswerte sind eine Momentaufnahme – am aussagekräftigsten an einem kalten Heiztag. Einstellungen gelten dauerhaft. ' +
    'Spalten <b>Fenster</b> (Tür-/Fensterkontakte) und <b>Luft</b> (Twinguard) werden automatisch aus Bosch gelesen – ' +
    'jeder Kontakt/Sensor bringt seinen Raum selbst mit, eine manuelle Zuordnung ist nicht nötig. ' +
    '€-Werte sind grobe Schätzungen (Sparanteil × WP-Jahresverbrauch × Strompreis).';
}

/* ---- Heizkurve: flow temp vs. outdoor temp, drawn as a classic Heizkennlinie:
 * x reversed (warm +20 °C left → cold −10 °C right), y Vorlauf fixed 20–50 °C. */
const HC_IDEAL = o => Math.max(28, Math.min(45, 30 + (18 - o) * 0.45));
// linear blend between two [r,g,b] colours → "#rrggbb" (t in 0..1)
function lerpHex(a, b, t) {
  t = Math.min(1, Math.max(0, t));
  const c = k => Math.round(a[k] + (b[k] - a[k]) * t).toString(16).padStart(2, '0');
  return '#' + c(0) + c(1) + c(2);
}
function curveChart(d) {
  const h = 230, padL = 30, padR = 10, top = 12, base = h - 26;
  const pts = d.points || [];
  const XL = 20, XR = -10, YB = 20, YT = 50;              // fixed domain
  const plotW = CW - padL - padR, plotH = base - top;
  const X = x => padL + (XL - x) / (XL - XR) * plotW;      // +20 at left, −10 at right
  const Y = y => top + (YT - y) / (YT - YB) * plotH;       // 50 top, 20 bottom
  const clampY = y => Math.max(YB, Math.min(YT, y));
  // y grid 20/30/40/50
  let g = '';
  for (let v = YB; v <= YT; v += 10) {
    const py = Y(v);
    g += `<line class="gl" x1="${padL}" x2="${CW - padR}" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}"/>`;
    g += `<text class="axis" x="0" y="${(py + 3).toFixed(1)}">${v}</text>`;
  }
  // x ticks 20…−10 (warm→cold)
  let xt = '';
  for (let v = XL; v >= XR; v -= 5) {
    const px = X(v), anchor = v === XL ? 'start' : v === XR ? 'end' : 'middle';
    xt += `<text class="axis" x="${px.toFixed(1)}" y="${h - 8}" text-anchor="${anchor}">${v}°</text>`;
  }
  // target band (green), full domain, clamped to the y range
  let ip = '';
  for (let v = XL; v >= XR; v -= 1) ip += `${v === XL ? 'M' : 'L'}${X(v).toFixed(1)} ${Y(clampY(HC_IDEAL(v))).toFixed(1)} `;
  const idealPath = `<path d="${ip.trim()}" fill="none" stroke="#4be0b0" stroke-width="2.5"/>`;
  // fitted actual curve (red)
  let fitPath = '';
  if (d.fit) {
    const y1 = clampY(d.fit.a * XL + d.fit.b), y2 = clampY(d.fit.a * XR + d.fit.b);
    fitPath = `<line x1="${X(XL).toFixed(1)}" y1="${Y(y1).toFixed(1)}" x2="${X(XR).toFixed(1)}" y2="${Y(y2).toFixed(1)}" stroke="#ff6b8a" stroke-width="2.5"/>`;
  }
  // measured points within the visible domain, shaded by RECENCY so a drifting
  // curve is visible: old points fade to slate, recent ones warm toward the
  // "jetzt" gold. Age is measured against the selected window (since…until);
  // without a window, against the points' own min/max timestamp.
  // anchor the gradient to the shown points' own oldest…newest timestamp, so the
  // full colour range is used for every window (a "since=0" for „Gesamt" or a
  // 30-day window whose data starts later would otherwise collapse the gradient).
  const COLD = [0x53, 0x62, 0x7a], HOT = [0xff, 0xd1, 0x66];
  const vis = pts.filter(p => p[0] <= XL + 0.01 && p[0] >= XR - 0.01 && p[1] >= YB && p[1] <= YT);
  const tsv = vis.map(p => p[2]).filter(v => v != null);
  const ptA = tsv.length ? Math.min(...tsv) : 0;
  const ptB = tsv.length ? Math.max(...tsv) : 1;
  const ptSpan = Math.max(1, ptB - ptA);
  const dots = vis.map(p => {
    const f = p[2] != null ? Math.min(1, Math.max(0, (p[2] - ptA) / ptSpan)) : 0.5;
    const col = lerpHex(COLD, HOT, f), op = (0.32 + 0.5 * f).toFixed(2), r = (2.0 + 1.1 * f).toFixed(1);
    return `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${r}" fill="${col}" fill-opacity="${op}"/>`;
  }).join('');
  // the device's configured 2-point curve (blue), as read off the heat pump
  let devPath = '';
  const dv = d.device;
  if (dv && dv.p20 != null && dv.pm10 != null) {
    const x20 = X(20), xm10 = X(-10), y20 = Y(clampY(dv.p20)), ym10 = Y(clampY(dv.pm10));
    devPath = `<line x1="${x20.toFixed(1)}" y1="${y20.toFixed(1)}" x2="${xm10.toFixed(1)}" y2="${ym10.toFixed(1)}" stroke="#3ba9ff" stroke-width="2.5"/>` +
      `<circle cx="${x20.toFixed(1)}" cy="${y20.toFixed(1)}" r="4" fill="#3ba9ff"/>` +
      `<circle cx="${xm10.toFixed(1)}" cy="${ym10.toFixed(1)}" r="4" fill="#3ba9ff"/>` +
      `<text class="axis" x="${(x20 + 7).toFixed(1)}" y="${(y20 - 5).toFixed(1)}" fill="#3ba9ff">${dv.p20}</text>` +
      `<text class="axis" x="${(xm10 - 7).toFixed(1)}" y="${(ym10 - 5).toFixed(1)}" text-anchor="end" fill="#3ba9ff">${dv.pm10}</text>`;
  }
  // current operating point: highlight where the WP sits RIGHT NOW, so you can
  // read the current Vorlauf and the target at the current outdoor temp without
  // tapping. A hollow green ring marks the Zielband-Soll at the current outdoor.
  let nowMark = '';
  const nw = d._now;
  if (nw && nw.outdoor != null && nw.outdoor <= XL + 0.01 && nw.outdoor >= XR - 0.01) {
    const nx = X(nw.outdoor);
    nowMark += `<line x1="${nx.toFixed(1)}" x2="${nx.toFixed(1)}" y1="${top}" y2="${base}" stroke="#ffffff" stroke-width="1" stroke-dasharray="3 3" opacity="0.45"/>`;
    const ty = Y(clampY(HC_IDEAL(nw.outdoor)));
    nowMark += `<circle cx="${nx.toFixed(1)}" cy="${ty.toFixed(1)}" r="3.6" fill="none" stroke="#4be0b0" stroke-width="2"/>`;
    if (nw.supply != null) {
      const sy = Y(clampY(nw.supply));
      // gently pulsing halo so the current point draws the eye
      nowMark += `<circle cx="${nx.toFixed(1)}" cy="${sy.toFixed(1)}" r="5" fill="none" stroke="#ffd166" stroke-width="1.5" opacity="0.7">` +
        `<animate attributeName="r" values="5;11;5" dur="1.9s" repeatCount="indefinite"/>` +
        `<animate attributeName="opacity" values="0.65;0;0.65" dur="1.9s" repeatCount="indefinite"/></circle>`;
      nowMark += `<circle cx="${nx.toFixed(1)}" cy="${sy.toFixed(1)}" r="4.5" fill="#ffd166" stroke="var(--bg)" stroke-width="1.3"/>`;
      const lblY = sy < top + 18 ? sy + 16 : sy - 9;
      const lblX = nw.outdoor < 2 ? nx - 6 : nx + 7, anc = nw.outdoor < 2 ? 'end' : 'start';
      nowMark += `<text class="axis" x="${lblX.toFixed(1)}" y="${lblY.toFixed(1)}" text-anchor="${anc}" fill="#ffd166" style="font-weight:700">jetzt ${fmt(nw.supply, 0)}°</text>`;
    } else {
      nowMark += `<text class="axis" x="${(nx + 4).toFixed(1)}" y="${(top + 10).toFixed(1)}" fill="#ffffff" opacity="0.7">jetzt ${fmt(nw.outdoor, 0)}° außen</text>`;
    }
  }
  // touch/hover readout: show each curve's Vorlauf at the outdoor temp under the
  // finger (Zielband, gemessen, Geräte-Kurve) + the nearest measured point.
  const lines = [{ name: 'Zielband', color: '#4be0b0', kind: 'ideal' }];
  if (d.fit) lines.push({ name: 'gemessen', color: '#ff6b8a', a: d.fit.a, b: d.fit.b });
  if (dv && dv.p20 != null && dv.pm10 != null) {
    const a = (dv.pm10 - dv.p20) / (XR - XL), b = dv.p20 - a * XL;   // 2-point → linear
    lines.push({ name: 'Geräte-Kurve', color: '#3ba9ff', a, b });
  }
  const hcMeta = {
    padL, padR, h, XL, XR, YB, YT, lines,
    dots: pts.filter(p => p[0] <= XL + 0.01 && p[0] >= XR - 0.01).map(p => [p[0], p[1]]),
  };
  return svg(h, g + xt + dots + idealPath + fitPath + devPath + nowMark, null, null, hcMeta);
}

/* ---- Combined hourly time-series: temps (top) + consumption & COP (bottom) -- */
function heatTimeChart(rows) {
  const h = 280, padL = 26, padR = 28, top = 10;
  const n = rows.length; if (!n) return '<div class="note">Keine Daten.</div>';
  const plotW = CW - padL - padR;
  const xi = i => padL + (n <= 1 ? plotW / 2 : i / (n - 1) * plotW);
  // temperature region (top ~48%)
  const tTop = top, tBase = Math.round(h * 0.48);
  const temps = rows.flatMap(r => [r.outdoor, r.supply, r.indoor]).filter(v => v != null);
  let tmin = Math.floor(Math.min(...temps) - 2), tmax = Math.ceil(Math.max(...temps) + 2);
  if (tmax - tmin < 10) tmax = tmin + 10;
  const yT = v => tTop + (tmax - v) / (tmax - tmin) * (tBase - tTop);
  // energy + COP region (bottom)
  const eTop = tBase + 24, eBase = h - 20;
  const stacks = rows.map(r => (r.heating || 0) + (r.water || 0));
  const emax = Math.max(0.3, ...stacks);
  const yE = v => eBase - v / emax * (eBase - eTop);
  const copMax = Math.max(3, Math.ceil(Math.max(...rows.map(r => r.cop || 0))));
  const yC = v => eBase - v / copMax * (eBase - eTop);
  // temp grid + left labels (unit "°C" appended to the TOP label only, so no
  // separate caption collides with the top value)
  let g = '';
  for (let i = 0; i <= 4; i++) {                 // 5 lines → easier to read °C off the axis
    const v = tmin + (tmax - tmin) * (1 - i / 4), y = yT(v);
    g += `<line class="gl" x1="${padL}" x2="${CW - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    g += `<text class="axis" x="0" y="${(y + (i === 0 ? 8 : 3)).toFixed(1)}">${Math.round(v)}${i === 0 ? ' °C' : ''}</text>`;
  }
  // energy baseline + COP right labels
  g += `<line class="gl" x1="${padL}" x2="${CW - padR}" y1="${eBase}" y2="${eBase}"/>`;
  for (let c = 0; c <= copMax; c += Math.max(1, Math.round(copMax / 3))) {
    const y = yC(c);
    g += `<text class="axis" x="${CW - padR + 3}" y="${(y + 3).toFixed(1)}" text-anchor="start" fill="#4be0b0">${c}</text>`;
  }
  // axis unit captions placed in the empty band between the temp and energy
  // regions (tBase..eTop) so nothing overlaps the numeric labels
  const capY = tBase + 15;
  g += `<text class="axis" x="2" y="${capY.toFixed(1)}" style="opacity:.75">kWh ↓</text>`;
  g += `<text class="axis" x="${CW - padR + 3}" y="${capY.toFixed(1)}" text-anchor="start" fill="#4be0b0" style="opacity:.85">COP</text>`;
  g += `<text class="axis" x="${CW - padR}" y="${(h - 6).toFixed(1)}" text-anchor="end" style="opacity:.7">Zeit →</text>`;
  // day separators + weekday labels at midnight
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  let sep = '';
  rows.forEach((r, i) => {
    if (r.hour === 0) {
      const x = xi(i);
      sep += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${eBase}" stroke="var(--line)" stroke-dasharray="2 3"/>`;
      sep += `<text class="axis" x="${(x + 3).toFixed(1)}" y="${h - 6}" text-anchor="start">${WD[new Date(r.ts * 1000).getDay()]}</text>`;
    }
  });
  // consumption bars (stacked heating + water)
  const bw = Math.max(1.2, plotW / n * 0.72);
  let bars = '';
  rows.forEach((r, i) => {
    const x = xi(i) - bw / 2; let yb = eBase;
    const seg = (val, col) => { if (!val || val <= 0) return; const hh = val / emax * (eBase - eTop); yb -= hh; bars += `<rect x="${x.toFixed(1)}" y="${yb.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${col}"/>`; };
    seg(r.heating, COL.hp); seg(r.water, COL.heat);
  });
  // temp lines (break on nulls) + COP line
  const line = (key, col, yfn, w) => {
    let d = '', pen = false;
    rows.forEach((r, i) => { const v = r[key]; if (v == null) { pen = false; return; } const x = xi(i), y = yfn(v); d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; pen = true; });
    return d ? `<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="${w || 2}"/>` : '';
  };
  const outdoor = line('outdoor', '#3ba9ff', yT, 2);
  const supply = line('supply', '#ff6b8a', yT, 2);
  const indoor = line('indoor', '#b794f6', yT, 2);
  const cop = line('cop', '#4be0b0', yC, 2);
  // value label at the end of each temp line (so the current °C is readable
  // without hovering – important on the phone). Dots mark the point; the text
  // labels are staggered so close values don't overlap.
  const ends = [];
  [['outdoor', '#3ba9ff'], ['supply', '#ff6b8a'], ['indoor', '#b794f6']].forEach(([key, col]) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][key] != null) { ends.push({ col, v: rows[i][key], x: xi(i), y: yT(rows[i][key]) }); break; }
    }
  });
  let endLabels = ends.map(e => `<circle cx="${e.x.toFixed(1)}" cy="${e.y.toFixed(1)}" r="2.6" fill="${e.col}"/>`).join('');
  ends.sort((a, b) => a.y - b.y);
  let lastY = -1e9;
  ends.forEach(e => {
    const ly = Math.min(tBase - 1, Math.max(e.y - 3, lastY + 12));   // ≥12px apart, keep in region
    lastY = ly;
    endLabels += `<text x="${(e.x - 4).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end" fill="${e.col}" style="font-size:11px;font-weight:700">${fmt(e.v, 1)}°</text>`;
  });
  // transparent per-hour hit areas with a native hover tooltip (desktop) –
  // shows that hour's values when the mouse is over the column.
  const hw = plotW / n;
  let hover = '';
  const tips = [];
  rows.forEach((r, i) => {
    const dt = new Date(r.ts * 1000), hh = String(dt.getHours()).padStart(2, '0');
    const P = [`${WD[dt.getDay()]} ${hh}:00`];
    if (r.outdoor != null) P.push(`Außen ${r.outdoor} °C`);
    if (r.supply != null) P.push(`Vorlauf ${r.supply} °C`);
    if (r.indoor != null) P.push(`Innen ${r.indoor} °C`);
    const verb = (r.heating || 0) + (r.water || 0);
    if (verb > 0) P.push(`Verbrauch ${verb.toFixed(2)} kWh (Heiz ${fmt(r.heating || 0, 2)} · WW ${fmt(r.water || 0, 2)})`);
    if (r.cop != null) P.push(`COP ${r.cop}`);
    hover += `<rect x="${(xi(i) - hw / 2).toFixed(1)}" y="${top}" width="${Math.max(1, hw).toFixed(1)}" height="${(h - top - 14).toFixed(1)}" fill="transparent" pointer-events="all"><title>${esc(P.join('\n'))}</title></rect>`;
    // same content as an on-tap toast (works on the phone, where <title> doesn't)
    const parts = [];
    if (r.outdoor != null) parts.push(`<span style="color:#3ba9ff">●</span> Außen <b>${fmt(r.outdoor, 1)}°</b>`);
    if (r.supply != null) parts.push(`<span style="color:#ff6b8a">●</span> Vorlauf <b>${fmt(r.supply, 1)}°</b>`);
    if (r.indoor != null) parts.push(`<span style="color:#b794f6">●</span> Innen <b>${fmt(r.indoor, 1)}°</b>`);
    if (verb > 0) parts.push(`🔥 <b>${fmt(verb, 2)} kWh</b>`);
    if (r.cop != null) parts.push(`<span style="color:#4be0b0">●</span> COP <b>${fmt(r.cop, 2)}</b>`);
    tips.push(`<b>${WD[dt.getDay()]} ${hh}:00</b><div class="note" style="margin-top:2px">${parts.join(' · ')}</div>`);
  });
  return svg(h, g + sep + bars + outdoor + indoor + supply + cop + endLabels + hover,
    { kind: 'area', pad: padL, padR, n, h, tips });
}
let _htsData = null, _htsBusy = false;
async function renderHeatTimeseries(force) {
  const card = $('hts-card'); if (!card) return;
  if (_htsData && !force) { paintHeatTimeseries(_htsData); return; }
  if (_htsBusy) return;
  _htsBusy = true;
  try { const r = await api('/api/heating/timeseries?days=4'); _htsData = r; paintHeatTimeseries(r); }
  catch (e) { const c = $('hts-chart'); if (c) c.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
  finally { _htsBusy = false; }
}
function paintHeatTimeseries(r) {
  const head = $('hts-head'), chart = $('hts-chart'), kpi = $('hts-kpi'), logic = $('hts-logic'), note = $('hts-note');
  if (!r || !r.ok || !r.n) {
    if (head) head.textContent = '';
    if (chart) chart.innerHTML = '<div class="note" style="padding:16px 0;text-align:center">📉 Noch keine Stundendaten – importiere im <b>Setup</b> deinen HomeCom-CSV-Export (stündlich Temperatur + Verbrauch).</div>';
    if (kpi) kpi.innerHTML = ''; if (logic) logic.innerHTML = ''; if (note) note.innerHTML = '';
    return;
  }
  const s = r.stats || {};
  if (head) head.innerHTML = s.avg_cop != null ? `<span style="color:#4be0b0">${glossV('Ø COP', 'cop')} ${fmt(s.avg_cop, 2)}</span> ${rateBadge('cop', s.avg_cop, 'Ø COP')}` : '';
  const tile = (l, v) => `<div style="background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:8px 10px;text-align:center"><div style="font-size:17px;font-weight:700">${v}</div><div style="font-size:11px;color:var(--muted)">${l}</div></div>`;
  if (kpi) kpi.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(78px,1fr));gap:8px">` +
    tile('Ø COP', (s.avg_cop != null ? fmt(s.avg_cop, 2) : '–') + (s.avg_cop != null ? '<br>' + rateBadge('cop', s.avg_cop, 'Ø COP') : '')) +
    tile('Strom', kwh(s.tot_elec, 1)) +
    tile('Wärme', kwh(s.tot_heat, 1)) +
    tile('Heizung', kwh(s.tot_heating, 1)) +
    tile('Warmw.', kwh(s.tot_water, 1)) +
    `</div>`;
  // current (last available) temperatures/COP, big & readable – so you see the
  // actual degrees without needing to hover a line on the phone
  if (kpi) {
    const lastVal = key => { const rr = r.rows || []; for (let i = rr.length - 1; i >= 0; i--) { if (rr[i][key] != null) return rr[i][key]; } return null; };
    const lo = lastVal('outdoor'), ls = lastVal('supply'), li = lastVal('indoor'), lc = lastVal('cop');
    const chip = (lbl, v, unit, col) => v == null ? '' :
      `<span style="display:inline-flex;align-items:baseline;gap:4px"><span style="width:8px;height:8px;border-radius:50%;background:${col};display:inline-block"></span>${lbl} <b style="font-size:15px">${fmt(v, unit === '°' ? 1 : 2)}${unit}</b></span>`;
    const chips = [chip('Außen', lo, '°', '#3ba9ff'), chip('Vorlauf', ls, '°', '#ff6b8a'),
      chip('Innen', li, '°', '#b794f6'), chip('COP', lc, '', '#4be0b0')].filter(Boolean).join('');
    if (chips) kpi.innerHTML += `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:13px">` +
      `<span style="color:var(--muted)">🌡️ Zuletzt:</span>${chips}</div>`;
  }
  if (chart) chart.innerHTML = heatTimeChart(r.rows || []);
  if (logic) logic.innerHTML = `<div style="font-weight:700;margin-bottom:6px">🧠 Abgeleitete Effizienz &amp; Logik</div>` +
    (r.logic || []).map(l => `<div style="font-size:13px;line-height:1.5;margin-bottom:5px">• ${l}</div>`).join('');
  const hasIndoor = (r.rows || []).some(x => x.indoor != null);
  if (note) note.innerHTML = `${r.n} Stunden (${r.days_window || 4} Tage)` + (r.demo ? ' · <b>Demo-Daten</b>' : '') +
    '. Außen-/Vorlauftemperatur &amp; Verbrauch kommen <b>live aus der Wärmepumpe</b> (füllt sich über die nächsten Stunden) ' +
    'bzw. aus dem <b>CSV-Import</b>, wo vorhanden. ' +
    (hasIndoor
      ? '<b>Innentemperatur</b> (lila) wird aus deinen Raumthermostaten mitgeloggt.'
      : '<b>Innentemperatur</b> (lila) wird ab jetzt aus deinen Raumthermostaten mitgeloggt – die Kurve füllt sich über die nächsten Stunden.');
}

/* ---- Fenster & Lüften: open-event timeline vs. indoor temperature --------- */
function windowChart(d) {
  const h = 180, padL = 26, padR = 10, top = 14, base = h - 24;
  const now = Date.now() / 1000, t0 = now - (d.days_window || 3) * 86400, t1 = now;
  const plotW = CW - padL - padR;
  const X = ts => padL + Math.max(0, Math.min(1, (ts - t0) / (t1 - t0))) * plotW;
  const temp = (d.temp_series || []).filter(p => p.ts >= t0);
  const tv = temp.map(p => p.temp);
  let tmin = tv.length ? Math.floor(Math.min(...tv) - 1) : 18;
  let tmax = tv.length ? Math.ceil(Math.max(...tv) + 1) : 24;
  if (tmax - tmin < 4) tmax = tmin + 4;
  const Y = v => top + (tmax - v) / (tmax - tmin) * (base - top);
  let g = '';
  for (let i = 0; i <= 2; i++) { const v = tmin + (tmax - tmin) * (1 - i / 2), y = Y(v); g += `<line class="gl" x1="${padL}" x2="${CW - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="axis" x="0" y="${(y + 3).toFixed(1)}">${Math.round(v)}</text>`; }
  let bands = '', labels = '', lastLabelX = -1e9;
  (d.events || []).forEach(e => {
    let x1 = X(e.start), x2 = X(e.end); if (x2 < x1 + 1.5) x2 = x1 + 1.5;
    const col = e.heating ? '#ff6b8a' : '#ffb64d';
    bands += `<rect x="${x1.toFixed(1)}" y="${top}" width="${(x2 - x1).toFixed(1)}" height="${(base - top).toFixed(1)}" fill="${col}" fill-opacity="0.2"/>`;
    // only label when there is horizontal room since the last label, so clustered
    // openings don't stack into an unreadable blob
    const cx = (x1 + x2) / 2;
    if (e.delta != null && cx - lastLabelX >= 24) {
      labels += `<text class="axis" x="${cx.toFixed(1)}" y="${top + 9}" text-anchor="middle" fill="${e.delta <= -0.4 ? '#ff6b8a' : 'var(--muted)'}">${e.delta > 0 ? '+' : ''}${e.delta}K</text>`;
      lastLabelX = cx;
    }
  });
  bands += labels;   // draw labels above the bands
  let sep = '';
  for (let t = Math.ceil(t0 / 86400) * 86400; t <= t1; t += 86400) { const x = X(t); const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][new Date(t * 1000).getDay()]; sep += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${base}" stroke="var(--line)" stroke-dasharray="2 3"/><text class="axis" x="${(x + 3).toFixed(1)}" y="${h - 6}">${wd}</text>`; }
  let dl = '', pen = false;
  temp.forEach(p => { const x = X(p.ts), y = Y(p.temp); dl += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; pen = true; });
  const line = dl ? `<path d="${dl.trim()}" fill="none" stroke="#b794f6" stroke-width="2"/>` : '';
  return svg(h, g + bands + sep + line);
}
let _winData = null, _winBusy = false;
async function renderWindows(force) {
  const card = $('win-card'); if (!card) return;
  if (_winData && !force) { paintWindows(_winData); return; }
  if (_winBusy) return;
  _winBusy = true;
  try { const r = await api('/api/windows?days=3'); _winData = r; paintWindows(r); }
  catch (e) { const c = $('win-chart'); if (c) c.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
  finally { _winBusy = false; }
}
function paintWindows(r) {
  const head = $('win-head'), chart = $('win-chart'), status = $('win-status'), logic = $('win-logic'), note = $('win-note');
  if (!r || !r.ok) { if (chart) chart.innerHTML = '<div class="note">Keine Daten.</div>'; return; }
  const open = r.current_open || [];
  if (status) status.innerHTML = open.length
    ? `<b style="color:#ffb64d">🪟 ${open.length} Fenster offen:</b> ${open.map(c => esc(c.name || c.room || '?')).join(', ')}`
    : '<span style="color:#4be0b0">✓ Aktuell alle Fenster geschlossen.</span>';
  if (head) head.innerHTML = r.n_events ? `<span style="color:var(--muted)">${r.n_events}× · ${r.total_open_min} min</span>` : '';
  if (chart) chart.innerHTML = ((r.events && r.events.length) || (r.temp_series && r.temp_series.length))
    ? windowChart(r)
    : '<div class="note" style="padding:14px 0;text-align:center">🪟 Noch keine Öffnungen aufgezeichnet – die App loggt deine Fensterkontakte ab jetzt mit.</div>';
  if (logic) logic.innerHTML = `<div style="font-weight:700;margin-bottom:6px">🧠 Awareness</div>` +
    (r.insights || []).map(l => `<div style="font-size:13px;line-height:1.5;margin-bottom:5px">• ${l}</div>`).join('');
  if (note) note.innerHTML = (r.demo ? '<b>Demo-Daten</b>. ' : '') +
    'Band = Fenster offen (<span style="color:#ffb64d">amber</span>; <span style="color:#ff6b8a">rot</span> = dabei heizt die WP). Die Zahl im Band ist die Innentemperatur-Änderung während des Lüftens.';
}

/* ---- Räume & Heizbetrieb: per-room temperature + WP heating state ---------- */
function roomChart(d, sel) {
  const h = 250, padL = 26, padR = 34, top = 12, base = h - 40;
  const now = Date.now() / 1000, t0 = now - (d.days_window || 2) * 86400, t1 = now;
  const X = ts => padL + Math.max(0, Math.min(1, (ts - t0) / (t1 - t0))) * (CW - padL - padR);
  const rooms = sel ? (d.rooms || []).filter(r => r.room === sel) : (d.rooms || []);
  if (!rooms.length) return '<div class="note">Keine Raumdaten.</div>';
  const temps = rooms.flatMap(r => r.points.map(p => p.temp)).filter(v => v != null);
  // reference line = your comfort TARGET (targetOf), not the raw setpoint – so a
  // cranked phase-2 setpoint (e.g. 30 °C) doesn't blow up the y-scale or read as
  // "never reached". Falls back to the setpoint when no target is set.
  const refs = rooms.map(r => targetOf(r)).filter(v => v != null);
  const all = temps.concat(refs);
  let tmin = Math.floor(Math.min(...all) - 1), tmax = Math.ceil(Math.max(...all) + 1);
  if (tmax - tmin < 4) tmax = tmin + 4;
  const Y = v => top + (tmax - v) / (tmax - tmin) * (base - top);
  // y grid: a gridline every 1 °C (small range) up to 5 °C (large range), so you
  // can read the temperature off the axis without tapping
  let g = '';
  const rng = tmax - tmin, stepC = rng <= 6 ? 1 : rng <= 12 ? 2 : rng <= 25 ? 5 : 10;
  for (let v = Math.ceil(tmin / stepC) * stepC; v <= tmax + 1e-6; v += stepC) {
    const y = Y(v);
    g += `<line class="gl" x1="${padL}" x2="${CW - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="axis" x="0" y="${(y + 3).toFixed(1)}">${v}°</text>`;
  }
  // valve-open shading when a single room is selected (room calling for heat)
  let band = '';
  if (sel && rooms[0]) { const p = rooms[0].points; for (let i = 0; i < p.length - 1; i++) { if ((p[i].valve || 0) > 50) { const x1 = X(p[i].ts), x2 = X(p[i + 1].ts); band += `<rect x="${x1.toFixed(1)}" y="${top}" width="${Math.max(0.6, x2 - x1).toFixed(1)}" height="${(base - top).toFixed(1)}" fill="${rooms[0].color}" fill-opacity="0.09"/>`; } } }
  // WP heating strip below the plot + a start-tick (▲) at each cycle start, so
  // the TAKTung (on/off cycling) is visible – many short starts = Takten.
  const stripY = base + 10;
  let strip = `<text class="axis" x="0" y="${stripY + 6}">WP</text>`;
  (d.heating || []).forEach(iv => {
    const x1 = X(iv[0]), x2 = X(iv[1]);
    strip += `<rect x="${x1.toFixed(1)}" y="${stripY}" width="${Math.max(1, x2 - x1).toFixed(1)}" height="6" fill="#4be0b0" fill-opacity="0.85"/>`;
    if (iv[0] >= t0 && iv[0] <= t1) {
      const xs = X(iv[0]);
      strip += `<path d="M${xs.toFixed(1)} ${(stripY - 1).toFixed(1)} l-3 -5 l6 0 z" fill="#4be0b0"/>`;
      strip += `<line x1="${xs.toFixed(1)}" x2="${xs.toFixed(1)}" y1="${top}" y2="${stripY}" stroke="#4be0b0" stroke-width="1" stroke-dasharray="2 3" opacity="${sel ? 0.5 : 0.26}"/>`;
    }
  });
  // time grid with adaptive, denser labels: weekday at midnight, otherwise the
  // hour (or HH:MM for very short ranges). More ticks than before so the x-axis
  // actually tells you when, not just "Mo / Di".
  const span = t1 - t0, spanH = span / 3600;
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  let sep = '';
  const twoD = n => String(n).padStart(2, '0');
  const stepH = spanH <= 1 ? 1 / 6 : spanH <= 6 ? 1 : spanH <= 13 ? 2 : spanH <= 30 ? 4 : spanH <= 52 ? 6 : spanH <= 24 * 4 ? 12 : 24;
  const stepS = stepH * 3600;
  for (let t = Math.ceil(t0 / stepS) * stepS; t <= t1; t += stepS) {
    const x = X(t), dd = new Date(t * 1000);
    const mid = dd.getHours() === 0 && dd.getMinutes() === 0;
    const lbl = mid ? WD[dd.getDay()] : (stepH < 1 ? `${twoD(dd.getHours())}:${twoD(dd.getMinutes())}` : `${twoD(dd.getHours())}h`);
    sep += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${base}" stroke="var(--line)" stroke-dasharray="2 3"${mid ? ' opacity="0.9"' : ' opacity="0.5"'}/><text class="axis" x="${(x + 2).toFixed(1)}" y="${h - 6}"${mid ? ' style="font-weight:700"' : ''}>${lbl}</text>`;
  }
  // temp lines + setpoints + current dot
  let lines = '';
  rooms.forEach(r => {
    const pv = r.points.filter(p => p.temp != null && p.ts >= t0);
    let dl = '', pen = false;
    pv.forEach(p => { const x = X(p.ts), y = Y(p.temp); dl += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; pen = true; });
    if (dl) lines += `<path d="${dl.trim()}" fill="none" stroke="${r.color}" stroke-width="${sel ? 2.4 : 1.8}"/>`;
    if (pv.length) { const last = pv[pv.length - 1]; lines += `<circle cx="${X(last.ts).toFixed(1)}" cy="${Y(last.temp).toFixed(1)}" r="${sel ? 3.2 : 2.6}" fill="${r.color}"/>`; }
    const ref = targetOf(r);
    if (ref != null) { const y = Y(ref); const cranked = r.setpoint != null && (r.setpoint - ref) > 2;
      lines += `<line x1="${padL}" x2="${CW - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${r.color}" stroke-width="1" stroke-dasharray="4 3" opacity="${sel ? 0.85 : 0.3}"/>`;
      if (sel) lines += `<text class="axis" x="${CW - padR + 2}" y="${(y + 3).toFixed(1)}" fill="${r.color}" text-anchor="start">${cranked ? 'Ziel' : 'Soll'} ${fmt(ref, 1)}</text>`; }
  });
  // window-open markers: WHEN was a window open (and which room) – so you can
  // correlate a temperature dip with airing. Selected room → only its events.
  let wins = '';
  (d.window_events || []).forEach(ev => {
    const evDoors = ev.doors || [];
    // a room that is only a door opening is drawn by the door marker below,
    // not as a window band (a door is a brief draught, not airing a room).
    const evRooms = (ev.rooms || []).filter(r => !evDoors.includes(r));
    if (!evRooms.length) return;
    if (sel && !evRooms.includes(sel)) return;
    const xs = X(Math.max(ev.start, t0)), xe = X(Math.min(ev.end, t1));
    if (xe < padL || xs > CW - padR) return;
    const amber = '#ffb64d';
    wins += `<rect x="${xs.toFixed(1)}" y="${top}" width="${Math.max(1.5, xe - xs).toFixed(1)}" height="${(base - top).toFixed(1)}" fill="${amber}" fill-opacity="${sel ? 0.13 : 0.08}"/>`;
    wins += `<line x1="${xs.toFixed(1)}" x2="${xs.toFixed(1)}" y1="${top}" y2="${base}" stroke="${amber}" stroke-width="1" stroke-dasharray="3 2" opacity="0.85"/>`;
    const lbl = sel ? '🪟 offen' : ('🪟 ' + (evRooms[0] || ''));
    wins += `<text x="${(xs + 2).toFixed(1)}" y="${(top + 9).toFixed(1)}" style="font-size:9px" fill="${amber}">${esc(lbl)}</text>`;
  });
  // door-open markers (Haustür etc.): a thin violet line + 🚪, so a door opening
  // (brief cold draught) is distinguishable from airing a room via a window.
  let doors = '';
  (d.window_events || []).forEach(ev => {
    const evDoors = ev.doors || [];
    if (!evDoors.length) return;
    if (sel && !(ev.rooms || []).includes(sel)) return;
    const xs = X(Math.max(ev.start, t0));
    if (xs < padL || xs > CW - padR) return;
    const violet = '#c084fc';
    doors += `<line x1="${xs.toFixed(1)}" x2="${xs.toFixed(1)}" y1="${top}" y2="${base}" stroke="${violet}" stroke-width="1.4" stroke-dasharray="1 2" opacity="0.9"/>`;
    const lbl = sel ? '🚪 offen' : ('🚪 ' + (evDoors[0] || 'Tür'));
    doors += `<text x="${(xs + 2).toFixed(1)}" y="${(top + 20).toFixed(1)}" style="font-size:9px" fill="${violet}">${esc(lbl)}</text>`;
  });
  // per-room series for the tap/hover readout (temperature over time)
  const tsSeries = rooms.map(r => ({
    name: r.room, color: r.color, unit: '°',
    pts: r.points.filter(p => p.temp != null && p.ts >= t0).map(p => [p.ts, Math.round(p.temp * 10) / 10]),
  })).filter(s => s.pts.length);
  return svg(h, g + band + wins + doors + sep + strip + lines, null, { t0, t1, padL, padR, h, series: tsSeries });
}
let _rtsData = null, _rtsBusy = false, _rtsSel = '', _rtsDays = 2;
/* ---- Raumtemperaturen: Balken je Raum + Ziel-Marker (Soll-Erreichung) ----- */
function targetKey(room) { return 'bhe_target_' + room; }
function targetGet(room) {
  try { const v = parseFloat(localStorage.getItem(targetKey(room))); if (isFinite(v) && v > 0) return v; } catch (e) {}
  return null;
}
function targetSet(room, v) {
  try { (v == null || !isFinite(v)) ? localStorage.removeItem(targetKey(room)) : localStorage.setItem(targetKey(room), String(v)); } catch (e) {}
}
// sensible default target when the user hasn't set one and the current setpoint
// is cranked up (phase-2 aufdrehen, e.g. 30 °C): guess from the room name.
function targetGuess(rm) {
  // the bridge's own derivation first (current setpoint, else the normal
  // setpoint from before the thermostats were opened up) – so this card and
  // the balancing tab judge a room against the SAME target
  const src = ((_abData && _abData.rooms) || (_tmData && _tmData.rooms) || []).find(x => x.room === rm.room);
  if (src && src.target != null) return src.target;
  const sp = rm.setpoint;
  if (sp != null && sp <= 24.5) return sp;             // looks like a real comfort value
  const n = (rm.room || '').toLowerCase();
  if (/bad|wc|dusch/.test(n)) return 23;
  if (/schlaf/.test(n)) return 18;
  if (/flur|diele|keller|g[äa]ste|abstell|hwr|technik|wasch/.test(n)) return 19;
  if (/küche|kueche/.test(n)) return 20;
  return 21;
}
function targetOf(rm) { const t = targetGet(rm.room); return t != null ? t : targetGuess(rm); }
let _rtData = null, _rtBusy = false;
async function renderRoomTemps(force) {
  const card = $('roomtemp-card'); if (!card) return;
  if (_rtData && !force) { paintRoomTemps(); return; }
  if (_rtBusy) return;
  _rtBusy = true;
  try {
    if (!_hdData || force) { const r = await api('/api/heating/diag'); if (r && r.rooms) _hdData = r; }
    try { const t = await api('/api/thermal?days=14'); if (t && t.rooms) _tmData = t; } catch (e) {}
    _rtData = true; paintRoomTemps();
  } catch (e) {
    const c = $('rt-chart'); if (c) c.innerHTML = '<div class="note">Nur mit laufender Bridge &amp; gekoppelten Thermostaten verfügbar.</div>';
  } finally { _rtBusy = false; }
}
function paintRoomTemps() {
  const chart = $('rt-chart'), ted = $('rt-targets'), head = $('rt-head'), note = $('rt-note');
  const rooms = (_hdData && _hdData.rooms || []).filter(r => r.temp != null)
    .filter(r => !(r.summerMode) && String(r.roomControlMode || 'HEATING').toUpperCase() !== 'OFF');
  if (!rooms.length) { if (chart) chart.innerHTML = '<div class="note">Noch keine Raum-Temperaturen – läuft die Bridge?</div>'; if (ted) ted.innerHTML = ''; return; }
  const heat = {}; ((_tmData && _tmData.rooms) || []).forEach(r => { heat[r.room] = r.heatup_kph; });
  const MIN = 15, MAX = Math.max(26, Math.ceil(Math.max(...rooms.map(r => Math.max(r.temp, targetOf(r)))) + 0.5));
  const h = (t) => Math.max(2, Math.min(100, (t - MIN) / (MAX - MIN) * 100));
  const COL = { ok: '#4be0b0', warm: '#3ba9ff', near: '#ffb64d', cold: '#ff6b8a' };
  let atGoal = 0;
  const col = (gap) => gap <= 0.3 ? (gap < -0.7 ? 'warm' : 'ok') : gap <= 1.0 ? 'near' : 'cold';
  chart.innerHTML = `<div class="rt-chart">` + rooms.map(r => {
    const tgt = targetOf(r), gap = tgt - r.temp, c = col(gap);
    if (c === 'ok' || c === 'warm') atGoal++;
    const eta = (gap > 0.3 && heat[r.room] > 0.05) ? Math.round(gap / heat[r.room] * 10) / 10 : null;
    const full = h(r.temp) >= 99;
    const gapTxt = gap <= 0.3 ? (gap < -0.7 ? `+${fmt(-gap, 1)}° wärmer` : '✓ am Ziel')
      : `−${fmt(gap, 1)}°${eta != null ? ` · ~${fmt(eta, 1)}h` : ''}`;
    return `<div class="rt-col"><div class="rt-val" style="color:${COL[c]}">${fmt(r.temp, 1)}°</div>` +
      `<div class="rt-barwrap"><div class="rt-bar${full ? ' full' : ''}" style="height:${h(r.temp)}%;background:${COL[c]}"></div>` +
      `<div class="rt-target" style="bottom:${h(tgt)}%"></div></div>` +
      `<div class="rt-name" title="${esc(r.room)}">${esc(r.room)}</div>` +
      `<div class="rt-gap" style="color:${COL[c]}">${gapTxt}<br><span style="color:var(--muted)">Ziel ${fmt(tgt, 1)}°</span></div></div>`;
  }).join('') + `</div>`;
  if (head) head.innerHTML = `<span style="color:var(--muted)">${atGoal}/${rooms.length} am Ziel</span>`;
  // target editor
  ted.innerHTML = `<div style="font-weight:600;font-size:13px;margin-bottom:8px">🎯 Ziel-Temperatur je Raum ` +
    `<span style="font-weight:400;color:var(--muted);font-size:12px">(wird gespeichert)</span></div>` +
    `<div class="rt-ted">` + rooms.map(r =>
      `<label>${esc(r.room)}<input class="rt-tin" data-room="${esc(r.room)}" type="number" step="0.5" min="10" max="28" ` +
      `inputmode="decimal" value="${targetOf(r)}"></label>`).join('') + `</div>`;
  ted.querySelectorAll('.rt-tin').forEach(inp => {
    inp.addEventListener('change', () => {
      const v = parseFloat((inp.value || '').replace(',', '.'));
      targetSet(inp.dataset.room, isFinite(v) ? v : null);
      paintRoomTemps();
    });
  });
  const cold = rooms.filter(r => targetOf(r) - r.temp > 1.0).map(r => esc(r.room));
  const warm = rooms.filter(r => targetOf(r) - r.temp < -0.7).map(r => esc(r.room));
  // outdoor context: how representative is today for judging the balance?
  const out = _hdData && _hdData.kpis ? _hdData.kpis.outdoor_c : null;
  const design = parseFloat((typeof layoutModel === 'function' ? layoutModel().design : -12));
  let outLine = '';
  if (out != null) {
    const d = isFinite(design) ? design : -12;
    outLine = out <= 2
      ? `❄️ Heute <b>${fmt(out, 0)} °C</b> außen – <b>aussagekräftiger Testtag</b> für den Abgleich.`
      : out >= 10
        ? `☀️ Heute mild (<b>${fmt(out, 0)} °C</b>) – da erreichen fast alle Räume ihr Ziel locker. Der echte Test für den Abgleich ist ein <b>kalter Tag</b> (Auslegung ~${fmt(d, 0)} °C).`
        : `Heute <b>${fmt(out, 0)} °C</b> außen – mittel. Je kälter, desto aussagekräftiger (Auslegung ~${fmt(d, 0)} °C).`;
  }
  if (note) note.innerHTML = (_hdData && _hdData.demo ? '<b>Demo-Daten.</b> ' : '') +
    (atGoal === rooms.length
      ? '✅ Alle Räume am oder über Ziel. Jetzt kannst du überversorgte Räume leicht androsseln und – wenn es stabil bleibt – die <b>Heizkurve absenken</b> (spart Strom).'
      : (cold.length ? `❄️ Noch zu kalt: <b>${cold.join(', ')}</b> → beim Abgleich <b>mehr Durchfluss</b> geben (Verteiler aufdrehen) bzw. Vorlauf prüfen. ` : '') +
        (warm.length ? `🔵 Über Ziel: <b>${warm.join(', ')}</b> → leicht <b>androsseln</b>, dann bleibt mehr für die kalten Räume. ` : '')) +
    (outLine ? `<br>${outLine}` : '') +
    '<br><span style="color:var(--muted)">Der <b>hydraulische Abgleich bleibt die ganze Saison gleich</b> – die Tacosetter-Werte stellst du einmal ein. ' +
    'Wird es kälter, gleicht das die <b>Heizkurve (Vorlauftemperatur)</b> für alle Räume zugleich aus, nicht die Verteilung. ' +
    'Die ~h-Angabe ist grob (gemessene Aufheizrate); einen festen „bis wann" gibt es nicht – entscheidend ist, dass alle Räume ihr Ziel an einem <b>kalten Tag</b> halten.</span>';
}
async function renderRoomTs(force) {
  const card = $('rts-card'); if (!card) return;
  if (_rtsData && !force) { paintRoomTs(_rtsData); return; }
  if (_rtsBusy) return;
  _rtsBusy = true;
  try { const r = await api('/api/rooms/timeseries?days=' + _rtsDays); _rtsData = r; paintRoomTs(r); }
  catch (e) { const c = $('rts-chart'); if (c) c.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
  finally { _rtsBusy = false; }
}
function paintRoomTs(r) {
  const sel = $('rts-room'), chart = $('rts-chart'), leg = $('rts-legend'), logic = $('rts-logic'), head = $('rts-head'), note = $('rts-note');
  if (!r || !r.ok) { if (chart) chart.innerHTML = '<div class="note">Keine Daten.</div>'; return; }
  const list = r.rooms || [];
  if (sel && sel.dataset.fill !== String(list.length)) {
    sel.innerHTML = '<option value="">Alle Räume</option>' + list.map(x => `<option>${esc(x.room)}</option>`).join('');
    sel.dataset.fill = String(list.length); sel.value = _rtsSel;
  }
  if (head) head.innerHTML = list.length ? `<span style="color:var(--muted)">${list.length} Räume · ${r.days_window || 2} Tage</span>` : '';
  if (chart) chart.innerHTML = list.length
    ? roomChart(r, _rtsSel || null)
    : '<div class="note" style="padding:14px 0;text-align:center">🌡️ Noch keine Raumdaten – die App loggt ab jetzt pro Raum (Temperatur, Soll, Ventil).</div>';
  // judge "reached" against the comfort TARGET (targetOf), not the raw setpoint –
  // during phase-2 aufdrehen all setpoints are cranked (e.g. 30 °C), which would
  // otherwise flag every room "nie Soll".
  const tmaxOf = x => { const v = (x.points || []).map(p => p.temp).filter(n => n != null); return v.length ? Math.max(...v) : null; };
  const assess = list.map(x => { const tmax = tmaxOf(x), tgt = targetOf(x); return { x, tmax, tgt, gap: tmax != null ? tgt - tmax : null }; });
  const anyCranked = list.some(x => x.setpoint != null && (x.setpoint - targetOf(x)) > 2);
  if (leg) leg.innerHTML = assess.map(a => {
    const badge = a.gap == null ? '' : a.gap <= 0.3 ? ' <span style="color:#4be0b0">✓ am Ziel</span>'
      : a.gap > 1.0 ? ` <span style="color:#ff6b8a">⚠︎ ${fmt(a.gap, 1)}° unter Ziel</span>`
        : ` <span style="color:#ffb64d">${fmt(a.gap, 1)}° unter Ziel</span>`;
    return `<div class="it"><span class="sw" style="background:${a.x.color}"></span>${esc(a.x.room)}${badge}</div>`;
  }).join('') + '<div class="it"><span class="sw" style="background:#4be0b0"></span>WP heizt</div>' +
    '<div class="it"><span style="color:#4be0b0;font-weight:700">▲</span>&nbsp;WP-Start (Takt)</div>' +
    ((r.window_events || []).some(e => (e.rooms || []).some(x => !((e.doors || []).includes(x)))) ? '<div class="it"><span class="sw" style="background:#ffb64d"></span>🪟 Fenster offen</div>' : '') +
    ((r.window_events || []).some(e => (e.doors || []).length) ? '<div class="it"><span class="sw" style="background:#c084fc"></span>🚪 Tür offen</div>' : '');
  if (logic) {
    let insLines;
    if (anyCranked) {
      // phase-2: the server's setpoint-based "Erreicht Soll" lines are misleading →
      // replace with a target-based assessment, keep the rest (cooldown, WP hours).
      const serverIns = (r.insights || []).filter(l => !/Erreicht Soll/.test(l));
      const cold = assess.filter(a => a.gap != null && a.gap > 1.0);
      const okT = assess.filter(a => a.gap != null && a.gap <= 0.3);
      const myIns = ['ℹ️ Deine Sollwerte stehen gerade <b>hoch</b> (Aufdreh-/Abgleich-Phase). Bewertet wird hier gegen dein ' +
        '<b>Ziel</b> aus der Karte „Raumtemperaturen – Ziel-Erreichung" oben, <b>nicht</b> gegen die 30 °C.'];
      if (cold.length) myIns.push(`❄️ <b>Noch unter Ziel:</b> ` + cold.map(a => `${esc(a.x.room)} (${fmt(a.tmax, 1)}° / Ziel ${fmt(a.tgt, 1)}°)`).join(', ') +
        ` → beim Abgleich diese Kreise <b>mehr öffnen</b> bzw. Vorlauf/Heizkurve prüfen.`);
      if (okT.length) myIns.push(`✅ <b>Am Ziel:</b> ` + okT.map(a => esc(a.x.room)).join(', ') + '.');
      insLines = myIns.concat(serverIns);
    } else {
      insLines = (r.insights || []);
    }
    logic.innerHTML = `<div style="font-weight:700;margin-bottom:6px">🧠 Pro-Raum-Analyse</div>` +
      insLines.map(l => `<div style="font-size:13px;line-height:1.5;margin-bottom:5px">• ${l}</div>`).join('');
  }
  if (note) note.innerHTML = (r.demo ? '<b>Demo-Daten</b>. ' : '') +
    'Gestrichelt = dein <b>Ziel</b> (bei hochgedrehtem Soll dein Wohlfühl-Ziel aus der Karte oben, sonst der Sollwert). ' +
    'Die <b style="color:#ffb64d">amberfarbenen Bänder/Marker 🪟</b> zeigen, wann ein <b>Fenster offen</b> war, ' +
    'die <b style="color:#c084fc">violetten Linien 🚪</b> ein <b>Tür-/Haustür-Öffnen</b> (kurzer Kältezug) – so siehst du Zusammenhänge (z. B. Temperatur fällt beim Lüften oder Türöffnen). ' +
    'Das <b style="color:#4be0b0">grüne WP-Band</b> zeigt, wann die Wärmepumpe heizte; das <b style="color:#4be0b0">▲ am Bandanfang</b> markiert jeden <b>Heizstart (Takt)</b> – viele kurze Starts = Takten. ' +
    'Einen Raum oben wählen zeigt zusätzlich, wann sein <b>Ventil offen</b> ist (leichte Schattierung = Raum verlangt Wärme).';
}
/* ---- Auto-Messung: active night-setback on the thermostats ---------------- */
let _amData = null;
function renderAutomeasure() {
  const box = $('am-box'); if (!box) return;
  // only show when it could actually work: demo, or live with a paired SHC cert
  const h = STATE.health || {};
  const avail = STATE.demo || h.mode === 'demo' || (h.mode === 'live' && h.has_cert);
  box.hidden = !avail;
  if (!avail) return;
  const r = _amData || (_abData && _abData.automeasure);
  if (r) paintAutomeasure(r);
}
async function amControl(action) {
  const note = $('am-note'); if (note) note.textContent = '';
  let body = {};
  if (action === 'arm') {
    body = {
      setback_k: parseFloat(($('am-setback') || {}).value) || 4,
      floor_c: parseFloat(($('am-floor') || {}).value) || 15,
      start_h: parseInt(($('am-start') || {}).value, 10),
      end_h: parseInt(($('am-end') || {}).value, 10),
      max_nights: parseInt(($('am-nights') || {}).value, 10) || 5,
    };
  }
  try {
    const r = await postJSON('/api/automeasure/' + action, body);
    if (r && r.ok) { _amData = r; paintAutomeasure(r); }
    else if (note) note.textContent = (r && r.error) || 'Aktion fehlgeschlagen.';
  } catch (e) { if (note) note.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
}
function amActionLabel(a) {
  return a === 'absenken' ? '🔻 abgesenkt' : (a === 'zurückgestellt' ? '↩︎ zurückgestellt'
    : (a === 'auto-stop' ? '⏹ Auto-Stop' : (a === 'fehler' ? '⚠︎ Fehler' : a)));
}
function paintAutomeasure(r) {
  const head = $('am-head'), status = $('am-status'), logEl = $('am-log'), note = $('am-note'),
    btnArm = $('am-arm'), btnDis = $('am-disarm');
  if (!r || !r.ok) { if (status) status.innerHTML = '<div class="note">Keine Daten.</div>'; return; }
  if (btnArm) btnArm.hidden = r.enabled;
  if (btnDis) btnDis.hidden = !r.enabled;
  // prefill config from server (so it reflects the armed values)
  [['am-setback', r.setback_k], ['am-floor', r.floor_c], ['am-start', r.start_h], ['am-end', r.end_h], ['am-nights', r.max_nights]].forEach(([id, v]) => {
    const el = $(id); if (el && v != null && document.activeElement !== el) { el.value = v; el.disabled = r.enabled; }
  });
  if (head) head.innerHTML = r.enabled
    ? `<span style="color:${r.running ? 'var(--warn)' : 'var(--accent)'}">${esc(r.state)}</span>`
    : '<span style="color:var(--muted)">aus</span>';
  if (status) {
    const kpi = (v, l) => `<div class="kpi sm"><div class="v">${v}</div><div class="l">${l}</div></div>`;
    status.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap">` +
      kpi(esc(r.state.split(' ')[0]), 'Status') +
      kpi(`${r.nights_done}/${r.max_nights}`, 'Nächte') +
      kpi(`−${r.setback_k} K`, 'Absenkung') +
      kpi(`≥${r.floor_c}°`, 'Minimum') +
      kpi(`${r.start_h}–${r.end_h} Uhr`, 'Fenster') +
      `</div>` +
      (r.running && r.lowered_rooms && r.lowered_rooms.length
        ? `<div class="note" style="margin-top:6px">Gerade abgesenkt: <b>${r.lowered_rooms.map(esc).join(', ')}</b> – werden morgens automatisch zurückgestellt.</div>`
        : '');
  }
  if (logEl) {
    const L = r.log || [];
    logEl.innerHTML = L.length
      ? `<div style="font-weight:700;margin-bottom:6px">Protokoll</div>` + L.map(e => {
          const when = new Date(e.ts * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          const chg = (e.from != null && e.to != null) ? ` ${e.from}° → ${e.to}°` : (e.to != null ? ` → ${e.to}°` : '');
          return `<div style="font-size:12.5px;line-height:1.5;padding:3px 0;border-bottom:1px solid var(--line)">` +
            `<span style="color:var(--muted)">${when}</span> · ${amActionLabel(e.action)}` +
            (e.room ? ` <b>${esc(e.room)}</b>` : '') + esc(chg) +
            (e.note ? ` <span style="color:var(--muted)">(${esc(e.note)})</span>` : '') + `</div>`;
        }).join('')
      : '';
  }
  if (note) note.innerHTML = (r.demo ? '<b>Demo-Daten</b> – im Demo wird nichts real geschrieben. ' : '') +
    'Tipp: lass es 3–5 Nächte laufen; sobald jeder Raum genug τ-Daten hat, stoppt es automatisch. '
    + 'Du kannst jederzeit <b>Stop</b> drücken – dann werden sofort alle Sollwerte zurückgestellt.';
}

/* ==== Abgleich: ONE consolidated view ====================================== *
 * The tab used to be ten cards, each fetching its own model and rendering its
 * own per-room list (model, heat load, target flow, manifold table, priority,
 * readiness, step form) – with numbers that could disagree between cards.
 * /api/abgleich computes everything once; here it is painted as:
 *   1. status + the single next step (+ how the heating is actually operated)
 *   2. ONE row per room: supply · target flow per circuit · your reading
 *   3. the step log with measured effect
 *   4. data situation + Auto-Messung (collapsed)
 *   5. manifold set-up (collapsed, see renderLayout)                         */
function obsBar(p, col) {
  return `<div style="background:var(--line);border-radius:6px;height:9px;overflow:hidden;flex:1">` +
    `<div style="width:${Math.max(0, Math.min(100, p))}%;height:100%;background:${col}"></div></div>`;
}
let _tmData = null;                 // /api/thermal result (also used by the Heizung tab)
function tmChip(txt, col) {
  return `<span style="display:inline-block;background:${col}22;color:${col};border:1px solid ${col}66;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600">${txt}</span>`;
}
function hlAreas() {
  // room -> area (m²) from the locally stored Verteiler layout
  const l = (typeof layoutModel === 'function') ? layoutModel() : { rooms: {} };
  const out = {};
  Object.keys(l.rooms || {}).forEach(rm => {
    const a = parseFloat((l.rooms[rm] || {}).area);
    if (a > 0) out[rm] = a;
  });
  return out;
}
// Current (actual) tacosetter reading per room [l/min per circuit], entered by
// the user. Stored device-independently in the bridge (bhe_ prefix → synced).
function tacoKey(room) { return 'bhe_taco_' + room; }
function tacoGet(room) { try { const v = parseFloat(localStorage.getItem(tacoKey(room))); return isFinite(v) ? v : null; } catch (e) { return null; } }
// Compare the reading with the design recommendation → {txt, col}. The MEASURED
// state of the room (cat) decides what to do; the design value is only a start
// value, so a room that is too warm is never told to "open up to the target".
function tacoDelta(ist, soll, cat) {
  if (ist == null || soll == null || !(soll > 0)) return { txt: '', col: 'var(--muted)' };
  const diff = ist - soll, pct = diff / soll * 100;
  const near = Math.abs(diff) <= Math.max(0.15, soll * 0.10);     // ≈ reading accuracy
  const num = Math.abs(diff) < 0.05 ? '±0,0 l/min' : `${diff >= 0 ? '+' : '−'}${fmt(Math.abs(diff), 1)} l/min`;
  let word = near ? 'passt zur Empfehlung' : (diff < 0 ? 'unter Empfehlung' : 'über Empfehlung');
  let col = near ? '#4be0b0' : (Math.abs(pct) <= 40 ? '#ffb64d' : '#ff6b8a');
  if (cat === 'under') {
    if (diff < 0 && !near) { word = 'unter Empfehlung → aufdrehen'; col = '#ff6b8a'; }
    else { word += ' – Raum ist trotzdem zu kalt: weiter öffnen'; col = '#ffb64d'; }
  } else if (cat === 'reserve') {
    if (diff > 0 && !near) { word = 'über Empfehlung → androsseln'; col = '#ffb64d'; }
    else { word += ' – Raum ist trotzdem zu warm: nicht hochdrehen'; col = '#4be0b0'; }
  } else if (cat === 'balanced' && !near) {
    word += ' – Raum passt aber, so lassen'; col = '#4be0b0';
  }
  return { txt: `${num} · ${word}`, col };
}
// save ONE app setting and wait until the bridge has it (the balance view is
// computed on the bridge from these settings, so a refetch must come after)
async function abSaveSetting(key, value) {
  const v = value == null ? null : String(value);
  try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, v); } catch (e) {}
  try {
    await postJSON('/api/settings', { settings: { [key]: v } });
    if (typeof _lastSynced === 'object' && _lastSynced) { if (v == null) delete _lastSynced[key]; else _lastSynced[key] = v; }
  } catch (e) { /* offline: the regular settings sweep retries later */ }
}

let _abData = null, _abBusy = false, _abAgain = false, _opData = null, _opBusy = false;
const _abOpen = new Set();          // expanded room rows
const AB_CAT = {
  under: { t: 'zu kalt', icon: '🔺', c: '#ff6b8a' },
  reserve: { t: 'zu warm', icon: '🔻', c: '#3ba9ff' },
  balanced: { t: 'passt', icon: '✓', c: '#4be0b0' },
  observing: { t: 'keine Daten', icon: '○', c: '#93a2c4' },
  none: { t: 'ohne Thermostat', icon: '○', c: '#93a2c4' },
};
const sgn = (v, d = 1) => (v == null ? '–' : (v >= 0 ? '+' : '−') + fmt(Math.abs(v), d));

async function renderAbgleich(force) {
  const card = $('ab-card'); if (!card) return;
  renderOpState(false);
  if (_abData && !force) { paintAbgleich(_abData); return; }
  // a forced refresh that arrives while one is in flight must not get lost
  // (e.g. two quick edits) – it is replayed once the current one has finished
  if (_abBusy) { if (force) _abAgain = true; return; }
  _abBusy = true;
  const note = $('ab-note'); if (note) note.textContent = _abData ? 'rechne neu …' : '';
  try {
    const r = await api('/api/abgleich' + (force ? '?force=1' : ''));
    _abData = r; paintAbgleich(r);
  } catch (e) {
    const p = $('ab-phase'); if (p) p.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>';
  } finally {
    _abBusy = false; if (note) note.textContent = '';
    if (_abAgain) { _abAgain = false; renderAbgleich(true); }
  }
}
function paintAbgleich(r) {
  if (!r || !r.ok) { const p = $('ab-phase'); if (p) p.innerHTML = '<div class="note">Keine Daten.</div>'; return; }
  paintAbStatus(r); paintAbRooms(r); paintAbSteps(r); paintAbData(r);
  if (typeof renderAutomeasure === 'function') renderAutomeasure();
  const ln = $('lay-note');
  if (ln) ln.innerHTML = r.layout_demo
    ? '<b>Demo:</b> Die Raumliste oben nutzt ein Beispiel-Layout (5 Räume). Trage hier eigene Räume mit Fläche ein, um es zu ersetzen – die drei Annahmen wirken sofort.' : '';
}

/* ---- 1 · status + next step ------------------------------------------------ */
function paintAbStatus(r) {
  const head = $('ab-head'), ph = $('ab-phase'), nx = $('ab-next'), kp = $('ab-kpis'), sm = $('ab-summary'), how = $('ab-howto-body');
  const phase = r.phase || {};
  const pcol = { adjust: 'var(--accent)', finish: '#4be0b0', normal: '#4be0b0', nodata: '#ffb64d' }[phase.key] || 'var(--muted)';
  if (head) head.innerHTML = `<span style="color:${pcol}">${esc(phase.label || '')}</span>`;
  if (ph) ph.innerHTML = `<div style="font-size:13px;line-height:1.55">${r.demo ? '<b>Demo-Daten.</b> ' : ''}${phase.text || ''}</div>`;

  if (nx) {
    const n = r.next || {}, k = n.kind;
    const col = k === 'done' || k === 'restore' ? '#4be0b0' : (k === 'open' ? '#ff6b8a' : (k === 'throttle' ? '#3ba9ff'
      : (k === 'curve' ? '#b794f6' : 'var(--accent)')));
    const icon = { open: '🔺', throttle: '🔻', curve: '📉', done: '✅', restore: '✅', wait: '⏳', observe: '⏳' }[k] || '➡️';
    nx.innerHTML = `<div style="border:1px solid ${col};background:${col}14;border-radius:12px;padding:12px">` +
      `<div style="font-size:12px;color:var(--muted);margin-bottom:3px">Nächster Schritt</div>` +
      `<div style="font-size:15px;font-weight:700;margin-bottom:4px">${icon} ${esc(n.title || '')}</div>` +
      `<div style="font-size:13px;line-height:1.55">${n.text || ''}</div></div>` +
      (r.setup_hint ? `<div class="note" style="margin-top:8px;border-left:3px solid var(--accent);padding-left:10px">${r.setup_hint}</div>` : '');
  }

  if (kp) {
    const ks = r.kpis || [];
    kp.innerHTML = ks.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px">` +
      ks.map(k => `<div class="kpi sm"><div class="v" style="color:${RATE_COL[k.tone] && k.tone !== 'na' ? RATE_COL[k.tone] : 'var(--ink)'}">${esc(k.v)}</div>` +
        `<div class="l">${esc(k.l)}${k.hint ? `<br><span style="font-size:11px;opacity:.8">${esc(k.hint)}</span>` : ''}</div></div>`).join('') + `</div>` : '';
  }

  if (sm) {
    const s = r.summary || {}, line = (icon, lbl, arr, col) => (arr && arr.length)
      ? `<div style="font-size:13px;line-height:1.6"><span style="color:${col};font-weight:700">${icon} ${lbl}:</span> ${arr.map(esc).join(', ')}</div>` : '';
    let h = line('🔺', 'aufdrehen', s.open, '#ff6b8a') + line('🔻', 'androsseln', s.throttle, '#3ba9ff') + line('✓', 'passt', s.even, '#4be0b0');
    if ((r.stray_rooms || []).length) {
      h += `<div class="note" style="margin-top:6px">ℹ️ ${r.stray_rooms.length} Fehl-Einträge ausgeblendet (${r.stray_rooms.slice(0, 7).map(esc).join(', ')}): ` +
        `Bei einer einzelnen Abfrage kamen die Räume ohne Namen an und wurden unter ihrer internen Kennung protokolliert. ` +
        `Das sind keine echten Räume – sie tauchen jetzt in keiner Auswertung mehr auf, und die Ursache ist behoben.</div>`;
    }
    sm.innerHTML = h;
  }

  if (how) {
    const cur = { nodata: 1, normal: 3, adjust: 4, finish: 5 }[phase.key] || 0;
    const step = (n, t) => `<div style="display:flex;gap:10px;margin-bottom:9px;${n === cur ? '' : 'opacity:.82'}">` +
      `<div style="flex:0 0 22px;height:22px;border-radius:50%;background:${n === cur ? 'var(--accent)' : 'var(--card2)'};color:${n === cur ? '#06121f' : 'var(--muted)'};border:1px solid var(--line);font-weight:700;display:flex;align-items:center;justify-content:center;font-size:12px">${n}</div>` +
      `<div style="font-size:13px;line-height:1.5">${t}${n === cur ? ' <span style="color:var(--accent);font-weight:600">← hier bist du</span>' : ''}</div></div>`;
    how.innerHTML =
      step(1, '<b>Stammdaten eintragen</b> (einmalig): unten unter „Verteiler einrichten" je Raum Fläche, Kreise und Verteiler.') +
      step(2, '<b>Grundeinstellung:</b> an jedem Durchflussmesser (Tacosetter) den Ziel-Durchfluss „je Kreis" aus der Raumliste einstellen und deine Ist-Werte dort eintragen.') +
      step(3, '<b>Einstell-Phase starten:</b> alle Raumthermostate für ein paar Tage hochdrehen (z. B. 25 °C). So bestimmt der <b>Verteiler</b> die Verteilung, nicht die Einzelraumregelung – und ich kann die Räume direkt miteinander vergleichen.') +
      step(4, '<b>Nachjustieren, ein Kreis nach dem anderen:</b> den empfohlenen Schritt ausführen (±0,2–0,3 l/min), im Schritt-Protokoll speichern, 1–2 Tage warten. Fußbodenheizung reagiert träge.') +
      step(5, '<b>Thermostate zurückstellen</b>, sobald alle Räume im Gleichlauf sind – sie müssen dann nur noch wenig eingreifen.') +
      step(6, '<b>Heizkurve senken</b> (Karte „Heizkurve" unter „Einstellung"), bis der kälteste Raum gerade noch warm wird. Das ist der eigentliche Effizienzgewinn.') +
      `<div class="note" style="margin-top:6px">Der Abgleich bleibt die ganze Saison gleich – wird es kälter, gleicht das die Heizkurve aus, nicht die Verteilung. ` +
      `🔧 <b>Heizkörper statt Flächenheizung?</b> Dann über voreinstellbare Thermostatventile abgleichen. ` +
      `📄 Für Förderung (BEG/BAFA) ist der rechnerische Abgleich „Verfahren B" Pflicht – das macht ein Fachbetrieb. Das hier ist die praktische Selbstoptimierung, kein Norm-Nachweis.</div>`;
  }
}

/* ---- how the heating is actually operated (read + measured) ---------------- */
async function renderOpState(force) {
  if (_opData && !force) { paintOpState(_opData); return; }
  if (_opBusy) return;
  _opBusy = true;
  const el = $('ab-op'); if (el && !_opData) el.innerHTML = '<div class="note">Betrieb wird aus Wärmepumpe und Thermostaten gelesen …</div>';
  try { _opData = await api('/api/heatpump/opstate' + (force ? '?force=1' : '')); paintOpState(_opData); }
  catch (e) { if (el) el.innerHTML = ''; }
  finally { _opBusy = false; }
}
function paintOpState(o) {
  const el = $('ab-op'), dw = $('dhw-op');
  if (!o || !o.ok) { if (el) el.innerHTML = ''; if (dw) dw.innerHTML = ''; return; }
  const col = { none: '#4be0b0', none_measured: '#4be0b0', measured: '#ffb64d', hp_program: '#ffb64d', automeasure: 'var(--accent)', unknown: 'var(--muted)' }[o.state] || 'var(--muted)';
  const row = l => `<div style="display:flex;gap:8px;font-size:12.5px;line-height:1.5;padding:5px 0;border-top:1px solid var(--line)">` +
    `<div style="flex:0 0 20px">${l.icon || ''}</div><div style="flex:1;min-width:0"><b>${esc(l.label)}</b> ` +
    `<span style="color:var(--muted);font-size:11px">· ${esc(l.src || '')}</span><br>${l.html}</div></div>`;
  if (el) el.innerHTML = `<div style="border:1px solid var(--line);border-radius:12px;padding:11px 12px">` +
    `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:4px">` +
      `<b style="font-size:13px">🧾 Betrieb – gelesen &amp; gemessen</b>` +
      `<a href="#" id="ab-op-refresh" style="font-size:12px;color:var(--accent);text-decoration:none">neu lesen</a></div>` +
    `<div style="font-size:13px;line-height:1.5;margin-bottom:6px;border-left:3px solid ${col};padding-left:9px">${o.verdict || ''}</div>` +
    (o.lines || []).map(row).join('') +
    (o.hints || []).map(h => `<div class="note" style="margin-top:8px;border-left:3px solid var(--warn);padding-left:9px">💡 ${h}</div>`).join('') +
    `</div>`;
  // the hot-water card shows the same ground truth instead of assuming anything
  if (dw) {
    const dhwLine = (o.lines || []).find(l => l.label === 'Warmwasser');
    dw.innerHTML = `<div class="note" style="border-left:3px solid ${col};padding-left:9px">` +
      `<b>Betrieb (gelesen &amp; gemessen):</b> ${o.verdict || ''}` +
      (dhwLine ? `<br><b>Warmwasser-Einstellung:</b> ${dhwLine.html} <span style="font-size:11px">(${esc(dhwLine.src)})</span>` : '') + `</div>`;
  }
}

/* ---- 2 · one row per room ---------------------------------------------------- */
function abRoomRow(x, idx, fmax) {
  const cat = AB_CAT[x.category] || AB_CAT.none;
  const open = _abOpen.has(x.room);
  // the number that matters: vs. the house average while the thermostats are
  // open, else vs. the room's own setpoint
  const dv = x.open_mode && x.rel != null ? x.rel : x.dev;
  let catTxt = cat.t;
  if (x.category === 'reserve' && !x.open_mode) catTxt = 'Reserve';
  const badge = `<span style="color:${cat.c};font-weight:700;white-space:nowrap">${cat.icon} ${catTxt}` +
    (dv != null && (x.category === 'under' || x.category === 'reserve' || x.open_mode) ? ` ${sgn(dv)} K` : '') + `</span>`;
  // deviation track: −4 … +4 K, shaded band = "in step"
  let track = '';
  if (dv != null) {
    const pos = 50 + Math.max(-4, Math.min(4, dv)) / 4 * 50, band = 0.7 / 4 * 50;
    track = `<div style="position:relative;height:8px;background:var(--line);border-radius:4px;margin:7px 0 5px">` +
      `<div style="position:absolute;left:${50 - band}%;width:${band * 2}%;top:0;bottom:0;background:#4be0b033"></div>` +
      `<div style="position:absolute;left:50%;top:-2px;width:1px;height:12px;background:var(--muted)"></div>` +
      `<div style="position:absolute;left:calc(${pos}% - 5px);top:-1px;width:10px;height:10px;border-radius:50%;background:${cat.c};border:1px solid #0b1220"></div></div>`;
  }
  const meta = x.has_thermostat
    ? (x.temp_24h != null ? `Ø 24 h <b>${fmt(x.temp_24h, 1)} °C</b>` : (x.temp_now != null ? `jetzt ${fmt(x.temp_now, 1)} °C` : 'keine aktuellen Werte')) +
      (x.target != null ? ` · Wunsch ${fmt(x.target, 1)} °C` : '') +
      (x.open_mode && x.setpoint != null ? ` · <span title="Thermostat hochgedreht">Thermostat ${fmt(x.setpoint, 0)} °C ↑</span>` : '')
    : 'kein Thermostat';
  // flow line: target per circuit + the user's reading
  let flow;
  if (x.flow_loop != null) {
    // when the heat pump delivers less than all circuits together need, the
    // reading is judged against what this circuit can really get
    const soll = x.flow_reach != null ? x.flow_reach : x.flow_loop;
    const ist = tacoGet(x.room), d = tacoDelta(ist, soll, x.category);
    const low = x.flow_loop < 0.3 || x.plausible === false;
    flow = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;margin-top:2px">` +
      `<span>Ziel <b style="color:${low ? '#ffb64d' : '#3ba9ff'}">${fmt(x.flow_loop, 2)} l/min</b>${low ? ' ⚠︎' : ''}` +
      `<span style="color:var(--muted)"> je Kreis${x.loops > 1 ? ` (${x.loops}×)` : ''}</span></span>` +
      `<span style="color:var(--muted)">· Ist</span>` +
      `<input class="taco-in" data-room="${esc(x.room)}" data-idx="${idx}" data-soll="${soll}" data-cat="${esc(x.category || '')}" type="text" inputmode="decimal" ` +
        `placeholder="l/min" value="${ist != null ? fmt(ist, 1) : ''}" style="width:64px;padding:4px 6px;margin:0;border-radius:8px;border:1px solid var(--line);background:var(--card2);color:var(--ink);font-size:13px">` +
      `<span id="taco-d-${idx}" style="color:${d.col};font-weight:600;flex:1;min-width:120px">${d.txt}</span></div>` +
      (x.flow_reach != null ? `<div style="font-size:12px;color:#ffb64d;margin-top:2px">erreichbar ~<b>${fmt(x.flow_reach, 2)} l/min</b> je Kreis ` +
        `<span style="color:var(--muted)">– so viel bekommt der Kreis, wenn alle anteilig eingestellt sind (siehe oben); dein Ist-Wert wird damit verglichen</span></div>` : '');
  } else {
    flow = `<div class="note" style="margin-top:2px">Ziel-Durchfluss: ${(x.flow_missing || ['Fläche fehlt']).map(esc).join(' · ')} ` +
      `<a href="#" data-ab-setup="1" style="color:var(--accent)">eintragen</a></div>`;
  }
  let det = '';
  if (open) {
    const tile = (lbl, val, badge) => `<div style="flex:1;min-width:96px"><div style="font-size:11px;color:var(--muted)">${lbl}</div>` +
      `<div style="font-weight:700;font-size:14px">${val}</div>${badge ? `<div style="font-size:11px">${badge}</div>` : ''}</div>`;
    const explicit = x.target_src === 'eingestellt';
    det = `<div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)">` +
      (x.has_thermostat ? `<div style="font-size:13px;line-height:1.5">${x.finding || ''}</div>` +
        (x.recommendation ? `<div style="font-size:13px;line-height:1.5;margin-top:3px"><b>Tun:</b> ${x.recommendation}</div>` : '') : '') +
      (x.has_thermostat ? `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;margin-top:10px">` +
        `<label style="margin:0">Wunschtemperatur</label>` +
        `<input class="tgt-in" data-room="${esc(x.room)}" type="number" step="0.5" min="10" max="30" value="${x.target != null ? x.target : ''}" style="width:70px;padding:4px 6px;margin:0"> °C` +
        `<span style="color:var(--muted)">(${explicit ? 'von dir eingetragen' : 'automatisch: ' + esc(x.target_src || '')})</span>` +
        (explicit ? `<a href="#" class="tgt-reset" data-room="${esc(x.room)}" style="color:var(--accent)">zurück auf automatisch</a>` : '') + `</div>` : '') +
      `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px">` +
        (x.has_thermostat ? tile('Trägheit τ', x.tau_h != null ? fmt(x.tau_h, 0) + ' h' : '–', x.tau_h != null ? rateBadge('tau', x.tau_h, 'Trägheit τ') : '<span style="color:var(--muted)">braucht eine heizfreie Phase</span>') : '') +
        (x.has_thermostat ? tile('Auskühlrate', x.cooldown_kph != null ? fmt(x.cooldown_kph, 2) + ' K/h' : '–', x.cooldown_kph != null ? rateBadge('cooldown', x.cooldown_kph, 'Auskühlrate') : '') : '') +
        (x.has_thermostat ? tile('Aufheizrate', x.heatup_kph != null ? fmt(x.heatup_kph, 2) + ' K/h' : '–', x.heatup_kph != null ? rateBadge('heatup', x.heatup_kph, 'Aufheizrate') : '') : '') +
        (x.demand_share != null && !x.open_mode ? tile('fordert Wärme an', Math.round(x.demand_share * 100) + ' %', '<span style="color:var(--muted)">der letzten 48 h</span>') : '') +
        (x.q_design != null ? tile('Heizlast', fmt(x.q_design, 0) + ' W', `<span style="color:var(--muted)">${fmt(x.q_lo, 0)}–${fmt(x.q_hi, 0)} W${x.estimated ? ' · geschätzt' : ''}</span>`) : '') +
        (x.area ? tile('Fläche · Kreise', `${fmt(x.area, 0)} m² · ${x.loops}×`, x.flow_room != null ? `<span style="color:var(--muted)">Raum gesamt ${fmt(x.flow_room, 2)} l/min</span>` : '') : '') +
      `</div>` +
      (x.flow_loop != null && x.flow_loop < 0.3 ? `<div class="note" style="margin-top:8px;color:#ffb64d">⚠︎ Ziel-Durchfluss sehr niedrig – nicht 1:1 übernehmen, Kreis nicht unter ~0,5 l/min stellen.</div>` : '') +
      (x.plausible === false ? `<div class="note" style="margin-top:8px;color:#ffb64d">⚠︎ Spezifische Last ${x.spec != null ? fmt(x.spec, 0) + ' W/m² ' : ''}außerhalb des üblichen Bereichs – Fläche prüfen.</div>` : '') +
      (x.has_thermostat ? `<div style="font-size:11px;color:var(--muted);margin-top:8px">Datenbasis: ${x.n} Messpunkte · ${x.n_tau}× freie Auskühlung · ${x.n_warm}× Aufheizen` +
        (x.missing && x.missing.length ? ` · für τ fehlt noch: ${x.missing.map(esc).join('; ')}` : '') + `</div>` : '') +
      `</div>`;
  }
  return `<div style="border:1px solid ${x.category === 'under' || x.category === 'reserve' ? cat.c + '77' : 'var(--line)'};border-radius:12px;padding:11px 12px;margin-bottom:9px">` +
    `<div class="abr-toggle" data-room="${esc(x.room)}" role="button" style="cursor:pointer">` +
      `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">` +
        `<b style="font-size:15px">${esc(x.room)}</b><span style="font-size:13px">${badge} <span style="color:var(--muted)">${open ? '▴' : '▾'}</span></span></div>` +
      `<div style="font-size:12.5px;color:var(--muted);margin-top:2px">${meta}</div>${track}</div>` +
    flow + det + `</div>`;
}
function paintAbRooms(r) {
  const head = $('abr-head'), body = $('abr-body'), note = $('abr-note');
  const rooms = r.rooms || [], t = r.totals || {};
  const fc = r.flow_cmp;
  if (head) head.innerHTML = `<span style="color:var(--muted)">${rooms.length} Räume${t.flow_total != null ? ` · Σ ${fmt(t.flow_total, 1)} l/min` : ''}` +
    (fc ? ` · WP ${fc.src === 'abgeleitet' ? '≈ ' : ''}${fmt(fc.l_min, 1)}` : '') + `</span>`;
  if (!body) return;
  if (!rooms.length) { body.innerHTML = '<div class="note">Noch keine Räume – koppele die Raumthermostate oder trage unten unter „Verteiler einrichten" Räume ein.</div>'; if (note) note.innerHTML = ''; return; }
  let h = '', idx = 0;
  (r.manifolds || [{ name: '' }]).forEach(m => {
    const rs = rooms.filter(x => (x.manifold || '') === (m.name || ''));
    if (!rs.length) return;
    h += `<div style="display:flex;justify-content:space-between;align-items:baseline;margin:14px 0 7px">` +
      `<b style="font-size:14px">🧭 ${m.name ? esc(m.name) : 'Ohne Verteiler'}</b>` +
      `<span style="color:var(--muted);font-size:12px">${m.loops ? `${m.loops} Kreise · Σ ${fmt(m.flow, 1)} l/min` : `${rs.length} Räume`}</span></div>`;
    rs.forEach(x => { h += abRoomRow(x, idx++); });
  });
  body.innerHTML = abFlowCmpBox(fc) + h;
  if (note) {
    const method = t.method === 'calibrated'
      ? `Heizlast aus der <b>gemessenen Gebäude-Kennlinie</b> (${t.q_total != null ? fmt(t.q_total, 0) + ' W' : '–'} bei ${fmt(t.design_c, 0)} °C), über Fläche und Trägheit auf die Räume verteilt.`
      : `Heizlast noch als <b>Flächen-Schätzung</b> (${fmt(t.spec_wm2, 0)} W/m² × Fläche = ${t.q_total != null ? fmt(t.q_total, 0) + ' W' : '–'}) – die gemessene Kennlinie ist dafür noch nicht belastbar.`;
    note.innerHTML = (r.layout_demo ? '<b>Demo</b> mit Beispiel-Layout. ' : '') +
      `<b>Punkt im Balken</b> = Abweichung des Raums (${(r.house || {}).open ? 'gegenüber dem Hausschnitt' : 'gegenüber seinem Sollwert'}); im grünen Band passt es. ` +
      `<b style="color:#3ba9ff">Ziel l/min</b> = Startwert für den Tacosetter je Kreis: l/min = Heizlast ÷ (1,163 × ΔT × 60), mit ΔT <b>${fmt(t.spread_k, 0)} K</b>` +
      (t.central_spread ? ` (zentral gemessen aktuell ${fmt(t.central_spread.spread_k, 1)} K)` : '') + `. ${method} ` +
      `Entscheidend ist am Ende die <b>gemessene</b> Raumtemperatur, nicht der Rechenwert. ` +
      `<a href="#" data-ab-setup="1" style="color:var(--accent)">Annahmen &amp; Flächen ändern</a> · kein normgerechter Abgleich.`;
  }
}

// What the heat pump really pushes through vs. what all circuits should get.
function abFlowCmpBox(fc) {
  if (!fc) return '';
  const col = { warn: '#ffb64d', ok: 'var(--accent)', good: '#4be0b0' }[fc.tone] || 'var(--line)';
  const src = fc.src === 'gelesen' ? 'gelesen aus der Wärmepumpe' : 'abgeleitet aus Wärmemenge ÷ Spreizung';
  return `<div style="border-left:3px solid ${col};padding:6px 0 6px 10px;margin:4px 0 6px;font-size:13px;line-height:1.55">` +
    `💧 <b>Volumenstrom ${fc.src === 'abgeleitet' ? '≈ ' : ''}${fmt(fc.l_min, 1)} l/min</b> <span style="color:var(--muted)">(${src})</span> · ` +
    `Σ Ziel aller Kreise ${fmt(fc.target_sum, 1)} l/min<br>${fc.text}` +
    (fc.ist_text ? `<div class="note" style="margin-top:4px">${esc(fc.ist_text)}</div>` : '') + `</div>`;
}

/* ---- 3 · step log ------------------------------------------------------------ */
async function optAction(path, body) {
  const msg = $('opt-msg'); if (msg) msg.textContent = '';
  try {
    const r = await postJSON(path, body || {});
    if (r && r.ok) { await renderAbgleich(true); }
    else if (msg) msg.textContent = (r && r.error) || 'Aktion fehlgeschlagen.';
  } catch (e) { if (msg) msg.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
}
function optVerdictColor(v) {
  if (v === 'wirksam' || v === 'ok') return '#4be0b0';
  if (v === 'läuft') return 'var(--accent)';
  if (v === 'kaum effekt') return '#ffb64d';
  return '#ff6b8a';   // verschlechtert / zu weit gedrosselt / unbekannt
}
function paintAbSteps(r) {
  const head = $('opt-head'), sel = $('opt-room'), act = $('opt-action'), stepsEl = $('opt-steps'), tools = $('opt-tools'), msg = $('opt-msg');
  if (head) head.innerHTML = `<span style="color:var(--muted)">${r.n_steps || 0} Schritt(e)</span>`;
  const rooms = (r.rooms || []).filter(x => x.has_thermostat);
  if (sel) {
    const sig = rooms.map(x => x.room + x.category).join('|');
    if (sel.dataset.fill !== sig) {
      const want = sel.value;
      sel.innerHTML = rooms.map(x => {
        const tag = x.category === 'under' ? ' – zu kalt' : (x.category === 'reserve' ? (x.open_mode ? ' – zu warm' : ' – Reserve') : '');
        return `<option value="${esc(x.room)}">${esc(x.room)}${tag}</option>`;
      }).join('');
      sel.dataset.fill = sig;
      // preselect what the next step proposes (unless the user already chose)
      const n = r.next || {};
      if (want && rooms.some(x => x.room === want)) sel.value = want;
      else if (n.room && rooms.some(x => x.room === n.room)) { sel.value = n.room; if (act && n.action) act.value = n.action; }
    }
  }
  if (stepsEl) {
    const hs = r.steps || [];
    stepsEl.innerHTML = hs.length
      ? hs.map(s => {
          const e = s.effect || {}, vc = optVerdictColor(e.verdict);
          const a = s.action === 'open' ? '🔺 aufgedreht' : '🔻 angedrosselt';
          const delta = s.delta_lmin != null ? ` ${s.delta_lmin > 0 ? '+' : ''}${fmt(s.delta_lmin, 1)} l/min` : '';
          const when = new Date(s.ts * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
          return `<div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:8px">` +
            `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">` +
              `<b>${esc(s.room)}</b><span style="font-size:12px;color:var(--muted)">${when} · ${a}${delta}</span></div>` +
            (s.note ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">„${esc(s.note)}"</div>` : '') +
            `<div style="font-size:13px;line-height:1.5;margin-top:5px">` +
              `<span style="color:${vc};font-weight:600">${esc(e.verdict || '')}</span>` +
              (e.days != null ? ` <span style="color:var(--muted)">(${fmt(e.days, 1)} T)</span>` : '') +
              ` – ${esc(e.line || '')}</div></div>`;
        }).join('')
      : '<div class="note">Noch keine Schritte protokolliert. Führe den empfohlenen Schritt am Verteiler aus und speichere ihn – dann messe ich die Wirkung.</div>';
  }
  if (tools) tools.style.display = (r.steps || []).length ? 'flex' : 'none';
  if (msg && !msg.textContent && r.curve) {
    const c = r.curve;
    msg.innerHTML = `Heizkurve im 30-Tage-Schnitt <b>${sgn(c.over_k)} K</b> gegenüber dem WP-freundlichen Ziel` +
      (c.saving_pct && !c.efficient ? ` (~${Math.round(c.saving_pct * 100)} % Sparpotenzial)` : '') +
      ` – senken lohnt sich erst, wenn die Räume im Gleichlauf sind.`;
  }
}

/* ---- 4 · data situation ------------------------------------------------------ */
function paintAbData(r) {
  const head = $('abd-head'), body = $('abd-body'), d = r.data || {};
  if (head) head.innerHTML = `<span style="color:${d.done ? '#4be0b0' : 'var(--muted)'}">${d.done ? '✓ reicht für den Abgleich' : (d.overall != null ? d.overall + ' %' : '')}</span>`;
  if (!body) return;
  const sb = d.setback || {};
  body.innerHTML =
    `<div style="font-size:13px;line-height:1.55;margin-bottom:10px">${esc(d.next_action || '')}</div>` +
    `<div class="note" style="margin-bottom:10px">${fmt(d.span_days, 1)} Tage Verlauf · ${fmt(d.n_samples, 0)} Messpunkte · ${d.n_rooms || 0} Räume · ${d.heating_phases || 0} WP-Heizphasen` +
      (sb.nights_checked ? ` · Sollwerte nachts: ${sb.nights_lowered ? `in ${sb.nights_lowered} von ${sb.nights_checked} Nächten abgesenkt` : `in den letzten ${sb.nights_checked} Nächten unverändert`}` : '') + `</div>` +
    (d.steps || []).map(s => {
      const col = s.state === 'done' ? '#4be0b0' : 'var(--accent)';
      return `<div style="margin-bottom:10px">` +
        `<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;margin-bottom:3px">` +
          `<span>${s.state === 'done' ? '✅' : '🔄'} <b>${esc(s.title)}</b></span><span style="color:var(--muted)">${s.progress}%</span></div>` +
        `<div style="display:flex;gap:8px;align-items:center;margin-bottom:3px">${obsBar(s.progress, col)}</div>` +
        `<div style="font-size:12px;color:var(--muted);line-height:1.5">${esc(s.detail)}${s.hint ? ' · ' + esc(s.hint) : ''}</div></div>`;
    }).join('') +
    ((d.disturbances || []).length ? (d.disturbances || []).map(x => `<div class="note" style="margin-bottom:4px">• ${esc(x)}</div>`).join('') : '') +
    (d.gap ? `<div class="note" style="margin-top:8px;border-left:3px solid var(--warn);padding-left:10px">⚠︎ <b>Messlücke:</b> ${esc(d.gap)}</div>` : '') +
    abFlowDataBox(r.flow, r.demo || (r.flow && r.flow.demo));
}
// Datenlage → Volumenstrom: where the number comes from, how it was found,
// the last heating runs it is based on.
function abFlowDataBox(F, demo) {
  if (!F) return '';
  const M = F.measured || {}, D = F.derived || {}, X = F.discovery;
  const when = ts => new Date(ts * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  let h = `<div style="margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)">` +
    `<div style="font-weight:700;font-size:14px;margin-bottom:6px">💧 Volumenstrom durch die Wärmepumpe</div>`;
  // 1 · read from the device?
  let rd;
  if (M.latest != null) {
    rd = `<b style="color:#4be0b0">Gelesen</b> aus HomeCom (<code style="font-size:11px">${esc((M.path || '').replace('/resource', ''))}</code>): ` +
      `zuletzt <b>${fmt(M.latest, 1)} l/min</b> (${when(M.latest_ts)})` +
      (M.heat_median != null ? ` · im Heizbetrieb Median <b>${fmt(M.heat_median, 1)} l/min</b> aus ${M.n} Werten` : '') +
      (M.dhw_median != null ? ` · Warmwasser ${fmt(M.dhw_median, 1)} l/min` : '') + '.';
  } else if (demo) {
    rd = 'Demo: keine echte Wärmepumpe zum Durchsuchen – gezeigt wird nur der abgeleitete Wert.';
  } else if (F.discovering) {
    rd = '🔄 Die Bridge durchsucht gerade die Werte der Wärmepumpe nach einem Volumenstrom …';
  } else if (X && X.primary) {
    rd = `Gefunden: <code style="font-size:11px">${esc(X.primary.replace('/resource', ''))}</code> – wird ab der nächsten Abfrage mitgeschrieben.`;
  } else if (X && X.error) {
    rd = `Suche nach einem Volumenstrom fehlgeschlagen (${esc(X.error)}) – nächster Versuch automatisch.`;
  } else if (X) {
    const units = (X.units || []).map(u => `${esc(u.unit)} ${u.n}×`).join(', ');
    const lim = (X.found || []).filter(f => f.setting);
    rd = `Die Wärmepumpe meldet über HomeCom <b>keinen Volumenstrom</b>. Durchsucht am ${when(X.ts)}: ` +
      `${X.checked} Ressourcen, ${X.leaves} Messwerte${X.complete === false ? ' (Suche begrenzt)' : ''}` +
      (units ? ` – Einheiten: ${units}` : '') + '.' +
      (lim.length ? ` Nur Grenz-/Sollwerte gefunden: ${lim.map(f => `${esc(f.path.replace('/resource', ''))} = ${fmt(f.l_min, 1)} l/min`).join(', ')}.` : '') +
      ' Deshalb wird der Wert unten abgeleitet.';
  } else {
    rd = 'Die Bridge sucht nach der ersten Abfrage der Wärmepumpe einmal nach einem Volumenstrom-Wert (danach wöchentlich).';
  }
  h += `<div style="font-size:13px;line-height:1.55;margin-bottom:8px">${rd}</div>`;
  // 2 · derived
  if (D.typical != null) {
    const cvp = (D.cv || 0) * 100;
    const beh = { konstant: `nahezu <b>konstant</b> (${cvp < 1 ? 'Streuung unter 1 %' : `±${fmt(cvp, 0)} %`}) – die Pumpe läuft offenbar mit fester Fördermenge`,
      'lastabhängig': '<b>steigt mit der Heizleistung</b> – die Pumpe regelt offenbar nach Last (z. B. auf feste Spreizung)',
      schwankend: '<b>schwankt</b> ohne klaren Zusammenhang mit der Leistung' }[D.behaviour];
    h += `<div style="font-size:13px;line-height:1.55;margin-bottom:6px"><b style="color:#ffb64d">Abgeleitet</b>: ≈ <b>${fmt(D.typical, 1)} l/min</b> – ` +
      `${D.pooled ? `aus ${D.pooled.n} Heizläufen zusammengerechnet (${fmt(D.pooled.heat_kwh, 0)} kWh Wärme)` : `Median aus ${D.n} Heizläufen`} der letzten 14 Tage, ` +
      `Spreizung typisch ${fmt(D.spread_k, 1)} K${D.sure ? '' : ' · <span style="color:#ffb64d">noch unsicher</span>'}.` +
      (beh ? ` Verlauf: ${beh}.` : '') +
      `<br><span style="color:var(--muted);font-size:12px">Rechnung: l/min = Wärmeleistung ÷ (1,163 Wh/(l·K) × Spreizung × 60), je 15–90 min Heizbetrieb mit laufendem Verdichter; Abtau- und Pausen-Abschnitte (Spreizung unter 0,3 K) zählen weder bei der Wärme noch bei der Zeit. ` +
      (D.resolution_kwh ? `Der Wärmezähler zählt in Schritten von ${fmt(D.resolution_kwh, D.resolution_kwh < 1 ? 1 : 0)} kWh – deshalb erst über längere Läufe genau. ` : '') +
      `Fühler-Toleranz ±0,2 K ist eingerechnet.</span></div>`;
    const runs = (D.runs || []).slice(-5).reverse();
    if (runs.length) {
      h += `<table style="width:100%;font-size:12px;border-collapse:collapse;margin-bottom:6px"><tr style="color:var(--muted);text-align:right">` +
        `<td style="text-align:left">Heizlauf</td><td>Dauer</td><td>Wärme</td><td>ΔT</td><td>l/min</td>${runs.some(x => x.measured != null) ? '<td>gelesen</td>' : ''}</tr>` +
        runs.map(x => `<tr style="text-align:right;${x.sure ? '' : 'opacity:.6'}"><td style="text-align:left">${when(x.start)}</td><td>${x.dur_min} min</td>` +
          `<td>${fmt(x.heat_kwh, 1)} kWh</td><td>${fmt(x.dt_k, 1)} K</td><td><b>${fmt(x.l_min, 1)}</b></td>` +
          (runs.some(y => y.measured != null) ? `<td>${x.measured != null ? fmt(x.measured, 1) : '–'}</td>` : '') + `</tr>`).join('') + `</table>`;
    }
  } else {
    h += `<div class="note" style="margin-bottom:6px">Abgeleitet: noch kein Wert – ${esc(D.why || 'noch kein Heizlauf von mindestens 15 min')}.</div>`;
  }
  if (F.check) h += `<div class="note" style="margin-bottom:6px">${esc(F.check.text)}</div>`;
  h += `<div class="note">Gilt für das Wasser durch die Wärmepumpe. Liegt ein Pufferspeicher oder eine hydraulische Weiche zwischen Wärmepumpe und Verteiler, fließt in den Heizkreisen eine andere Menge.</div>`;
  if (!demo) h += `<button class="btn sec" id="flow-disc" style="margin-top:10px">🔍 Wärmepumpe erneut nach Volumenstrom durchsuchen</button><div id="flow-disc-msg" class="note" style="margin-top:4px"></div>`;
  return h + `</div>`;
}
async function flowDiscover() {
  const msg = $('flow-disc-msg'), b = $('flow-disc');
  if (b) b.disabled = true;
  try {
    const r = await postJSON('/api/heatpump/flow/discover', {});
    if (msg) msg.textContent = r && r.ok ? 'Suche läuft (dauert etwa 1 Minute) …' : ((r && r.error) || 'Nicht möglich.');
    if (r && r.ok) setTimeout(() => renderAbgleich(true), 75000);
  } catch (e) { if (msg) msg.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  finally { if (b) setTimeout(() => { b.disabled = false; }, 5000); }
}

/* ---- Verteiler & Heizkreise: layout + per-circuit flow (l/min) distribution */
function layoutLoad() { try { return JSON.parse(localStorage.getItem('heatLayout')) || {}; } catch (e) { return {}; } }
function layoutSave(l) { try { localStorage.setItem('heatLayout', JSON.stringify(l)); } catch (e) {} }
function layoutModel() {
  const l = layoutLoad();
  l.q = (l.q != null ? l.q : 40); l.dt = (l.dt != null ? l.dt : 6);
  l.design = (l.design != null ? l.design : -12);          // Auslegungs-Außentemperatur °C
  l.manifolds = Array.isArray(l.manifolds) ? l.manifolds : [];
  l.rooms = l.rooms || {};
  l.hidden = Array.isArray(l.hidden) ? l.hidden : [];   // rooms the user removed (stay gone)
  return l;
}
function layoutSet(room, field, val) {
  const l = layoutModel();
  l.rooms[room] = l.rooms[room] || {};
  if (val === '' || val == null) delete l.rooms[room][field]; else l.rooms[room][field] = val;
  layoutSave(l);
}
function knownRooms() {
  const s = new Set();
  // the bridge's cleaned room list first (no stray entries), then live views
  ((typeof _abData !== 'undefined' && _abData && _abData.rooms) || []).forEach(r => r.has_thermostat && r.room && s.add(r.room));
  const stray = new Set((typeof _abData !== 'undefined' && _abData && _abData.stray_rooms) || []);
  ((typeof _hdData !== 'undefined' && _hdData && _hdData.rooms) || []).forEach(r => r.room && !stray.has(r.room) && s.add(r.room));
  ((typeof _rtsData !== 'undefined' && _rtsData && _rtsData.rooms) || []).forEach(r => r.room && !stray.has(r.room) && s.add(r.room));
  return [...s];
}
// Building-type quick picks for the specific heat load (W/m²) – so a layperson
// taps their house type instead of guessing a number. Used when there is no
// reliable measured signature yet (area-based estimate).
const SPEC_PRESETS = [['Passivhaus ~15', 15], ['Neubau/KfW ~40', 40], ['saniert ~55', 55], ['teilsaniert ~80', 80], ['Altbau ~100', 100]];
// After any layout edit: push the layout to the bridge, then recompute the
// balance view there (debounced so typing a number does not fire per keystroke).
let _layChangeT = null;
function abLayoutChanged(delay) {
  clearTimeout(_layChangeT);
  _layChangeT = setTimeout(async () => {
    let raw = null; try { raw = localStorage.getItem('heatLayout'); } catch (e) {}
    await abSaveSetting('heatLayout', raw);
    renderAbgleich(true);
  }, delay == null ? 700 : delay);
}
function renderLayout() {
  const body = $('lay-body'); if (!body) return;
  const l = layoutModel();
  const rooms = [...new Set([...knownRooms(), ...Object.keys(l.rooms)])]
    .filter(r => !l.hidden.includes(r)).sort();
  const mfOpts = sel => '<option value="">–</option>' + l.manifolds.map(m => `<option${m === sel ? ' selected' : ''}>${esc(m)}</option>`).join('');
  const inp = (ph, val, field, room, w) => `<input type="number" inputmode="decimal" data-lay="${field}" data-room="${esc(room)}" value="${val != null && val !== '' ? esc(String(val)) : ''}" placeholder="${ph}" style="width:${w || 58}px;padding:4px 6px;margin:0">`;
  const rowsHtml = rooms.map(room => { const cfg = l.rooms[room] || {};
    return `<tr><td style="padding:4px 6px">${esc(room)}</td>` +
      `<td style="padding:4px 6px"><select data-lay="manifold" data-room="${esc(room)}" style="padding:4px 6px;margin:0;width:auto;max-width:112px;font-size:14px">${mfOpts(cfg.manifold || '')}</select></td>` +
      `<td style="padding:4px 6px;text-align:right">${inp('m²', cfg.area, 'area', room, 54)}</td>` +
      `<td style="padding:4px 6px;text-align:right">${inp('1', cfg.loops, 'loops', room, 42)}</td>` +
      `<td style="padding:4px 6px;text-align:right">${inp('m', cfg.length, 'length', room, 50)}</td>` +
      `<td style="padding:4px 6px;text-align:center"><a href="#" data-roomdel="${esc(room)}" title="Raum aus dem Layout entfernen" style="color:var(--away);text-decoration:none;font-weight:700;font-size:16px">×</a></td></tr>`;
  }).join('');
  body.innerHTML =
    `<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:10px;font-size:13px">` +
      `<label>Spez. Heizlast <input type="number" id="lay-q" value="${esc(String(l.q))}" style="width:58px;padding:4px 6px;margin:0"> W/m²</label>` +
      `<label>Spreizung ΔT <input type="number" id="lay-dt" value="${esc(String(l.dt))}" style="width:48px;padding:4px 6px;margin:0"> K</label>` +
      `<label>Auslegung <select id="lay-design" style="width:auto;padding:4px 8px;margin:0">` +
        [-10, -12, -14, -16].map(v => `<option value="${v}"${Number(l.design) === v ? ' selected' : ''}>${v} °C</option>`).join('') + `</select></label>` +
    `</div>` +
    `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:-2px 0 8px">` +
      `<span style="color:var(--muted);font-size:12px">Haustyp:</span>` +
      SPEC_PRESETS.map(([lbl, v]) => { const on = Math.round(parseFloat(l.q)) === v;
        return `<button class="btn sec specpre" data-sp="${v}" style="width:auto;padding:4px 10px;margin:0;font-size:12px${on ? ';border-color:var(--accent);color:var(--accent)' : ''}">${esc(lbl)}</button>`; }).join('') +
    `</div>` +
    (() => {
      const bs = (typeof buildingSpec === 'function') ? buildingSpec(parseFloat(l.design) || -12) : null;
      if (!bs || bs < 10 || bs > 200) return '';
      const on = Math.round(parseFloat(l.q)) === bs;
      return `<div style="margin:0 0 8px"><button class="btn sec specpre" data-sp="${bs}" style="width:auto;padding:5px 12px;margin:0;font-size:12px;border-color:var(--accent2)${on ? ';background:var(--accent2);color:#06121f' : ';color:var(--accent2)'}">📐 Aus meinem Gebäudemodell (~${bs} W/m²)</button></div>`;
    })() +
    `<div class="note" style="margin:-2px 0 10px">Bestimmt die geschätzte Heizlast (Fläche × W/m²), solange noch keine belastbare Messung da ist. ` +
      `Am genauesten: <b>dein Gebäudemodell</b> (Theorie vs. Praxis). Sonst Haustyp wählen – altes saniertes Haus → eher „saniert" (55) oder „teilsaniert" (80).</div>` +
    `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:10px">` +
      `<b style="font-size:13px">Verteiler:</b> ` +
      l.manifolds.map(m => `<span style="background:var(--card2);border:1px solid var(--line);border-radius:999px;padding:3px 9px;font-size:12px">${esc(m)} <a href="#" data-mfdel="${esc(m)}" style="color:var(--away);text-decoration:none;font-weight:700">×</a></span>`).join('') +
      `<input id="lay-mf-name" placeholder="z. B. EG" style="width:86px;padding:4px 6px;margin:0"><button class="btn sec" id="lay-mf-add" style="width:auto;padding:4px 10px;margin:0">+ Verteiler</button>` +
    `</div>` +
    (rooms.length
      ? `<div style="overflow-x:auto;-webkit-overflow-scrolling:touch"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="color:var(--muted);font-size:11px;text-transform:uppercase"><th style="text-align:left;padding:4px 6px">Raum</th><th style="text-align:left;padding:4px 6px">Verteiler</th><th style="text-align:right;padding:4px 6px">Fläche</th><th style="text-align:right;padding:4px 6px" title="Anzahl Heizschläuche/Kreise dieses Raums am Verteiler">Kreise</th><th style="text-align:right;padding:4px 6px">Länge</th><th style="padding:4px 6px"></th></tr></thead><tbody>${rowsHtml}</tbody></table></div>`
      : '<div class="note">Noch keine Räume erkannt – öffne kurz den Heizungs-Check/Räume, oder füge unten manuell hinzu.</div>') +
    `<div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap"><input id="lay-room-name" placeholder="Raum hinzufügen" style="width:140px;padding:4px 6px;margin:0"><button class="btn sec" id="lay-room-add" style="width:auto;padding:4px 10px;margin:0">+ Raum</button><button class="btn sec" id="lay-rooms-load" style="width:auto;padding:4px 10px;margin:0">🔄 Räume laden</button><button class="btn sec" id="lay-preset" style="width:auto;padding:4px 10px;margin:0">🏠 Mein Haus vorbefüllen</button></div>` +
    `<div class="note" id="lay-preset-note" style="margin-top:6px;display:none"></div>` +
    `<div class="note" style="margin-top:10px">Die l/min-Werte je Kreis stehen oben in <b>„Räume &amp; Heizkreise"</b> – sie werden aus genau diesen Angaben gerechnet (eine Quelle, ein ΔT).</div>`;
  const lh = $('lay-head');
  if (lh) {
    const nA = rooms.filter(r => parseFloat((l.rooms[r] || {}).area) > 0).length;
    lh.textContent = rooms.length ? `${nA}/${rooms.length} Räume mit Fläche · ${l.manifolds.length} Verteiler` : 'noch leer';
  }
  // open the set-up by itself while it is still empty
  const det = $('lay-det');
  if (det && !det.dataset.auto) { det.dataset.auto = '1'; if (!rooms.some(r => parseFloat((l.rooms[r] || {}).area) > 0)) det.open = true; }
}
// one-tap preset for this household (areas + loops + manifold guess). Only the
// user triggers it; values are merged so manually changed rooms aren't lost
// beyond the preset ones. Honest estimates – the user adjusts afterwards.
const LAYOUT_PRESET = {
  q: 40, dt: 6, manifolds: ['Küche', 'Schlafzimmer', 'OG'],
  rooms: {
    'Wohnzimmer': { manifold: 'Küche', area: 35, loops: 3 },
    'Küche': { manifold: 'Küche', area: 25, loops: 2 },
    'Flur': { manifold: 'Küche', area: 14, loops: 1 },
    'Bad': { manifold: 'Küche', area: 6, loops: 1 },
    'Schlafzimmer': { manifold: 'Schlafzimmer', area: 20, loops: 2 },
    'Yusuf’s Zimmer': { manifold: 'OG', area: 30, loops: 2 },
    'Elif’s Zimmer': { manifold: 'OG', area: 30, loops: 2 },
  },
};
function layoutPresetMyHouse() {
  const l = layoutModel();
  l.q = LAYOUT_PRESET.q; l.dt = LAYOUT_PRESET.dt;
  l.rooms = l.rooms || {};
  // keep only custom manifolds still used by rooms NOT in the preset (drops the
  // old EG/OG guess cleanly), then add the real ones
  const presetRooms = Object.keys(LAYOUT_PRESET.rooms);
  const keep = (l.manifolds || []).filter(m =>
    Object.entries(l.rooms).some(([rm, cfg]) => cfg.manifold === m && !presetRooms.includes(rm)));
  l.manifolds = [...new Set([...LAYOUT_PRESET.manifolds, ...keep])];
  Object.entries(LAYOUT_PRESET.rooms).forEach(([rm, v]) => { l.rooms[rm] = { ...(l.rooms[rm] || {}), ...v }; });
  l.hidden = (l.hidden || []).filter(h => !(h in LAYOUT_PRESET.rooms));   // un-hide rooms the preset adds
  layoutSave(l);
  renderLayout(); abLayoutChanged(0);
  const n = $('lay-preset-note');
  if (n) {
    n.style.display = '';
    n.innerHTML = '✓ Vorbefüllt – 3 Verteiler: <b>Küche</b> (Wohnzimmer, Küche, Flur, Bad), <b>Schlafzimmer</b>, <b>OG</b> (Yusuf’s &amp; Elif’s Zimmer). ' +
      '<b>Bitte noch prüfen:</b> die Raum-<b>Namen</b> müssen exakt deinen Bosch-Namen entsprechen (auch der Apostroph!). ' +
      'Erscheint ein Raum doppelt (echter + Vorlage), nimm den echten (mit „🔄 Räume laden") und <b>lösch die Vorlage-Zeile mit dem ×</b>. ' +
      'Fläche der Kinderzimmer = beheizte Bodenfläche (~30 m²), nicht die Wohnfläche.';
  }
}
function hcDevice() {
  const g = k => { const v = parseFloat(localStorage.getItem(k)); return isFinite(v) ? v : null; };
  const p20 = g('hc_dev_p20'), pm10 = g('hc_dev_pm10');
  return (p20 != null && pm10 != null) ? { p20, pm10 } : null;
}
// Compare the device's 2-point curve against the WP-friendly target band and
// advise concretely which point to lower (and roughly by how much).
function renderHcDeviceNote(device) {
  const el = $('hc-dev-note'); if (!el) return;
  if (!device) {
    el.innerHTML = 'Lies die zwei Punkte an deiner Wärmepumpe ab (Menü <b>Heizkurve</b>) – dann zeichne ich sie blau mit ein und vergleiche.';
    return;
  }
  const t20 = Math.round(HC_IDEAL(20)), tm10 = Math.round(HC_IDEAL(-10));
  const d20 = device.p20 - t20, dm10 = device.pm10 - tm10;
  const slope10 = (device.pm10 - device.p20) / 30 * 10;   // K Vorlauf je 10 K kälter (positiv)
  let advice;
  const parts = [];
  if (dm10 >= 2) parts.push(`den <b>−10 °C-Punkt</b> Richtung ~${tm10} °C (−${Math.round(dm10)} K)`);
  if (d20 >= 2) parts.push(`den <b>+20 °C-Punkt</b> Richtung ~${t20} °C (−${Math.round(d20)} K)`);
  if (parts.length) advice = `<span style="color:#ffb64d">Spielraum nach unten:</span> ${parts.join(' und ')} senken – in <b>1–2 K-Schritten</b>, dann beobachten, ob alle Räume (v. a. der Leitraum) warm bleiben.`;
  else if (d20 <= -2 && dm10 <= -2) advice = '<span style="color:#4be0b0">Deine Kurve liegt bereits unter dem WP-Zielband – sehr effizient.</span> Nur anheben, falls Räume nicht richtig warm werden.';
  else advice = '<span style="color:#4be0b0">Deine Kurve liegt gut im effizienten Bereich.</span>';
  el.innerHTML = `🔵 <b>Deine Geräte-Kurve:</b> +20 °C → ${device.p20} °C · −10 °C → ${device.pm10} °C ` +
    `<span style="color:var(--muted)">(~${fmt(slope10, 1)} K Vorlauf je 10 K kälter)</span>. ${advice}`;
}
// Try to read the configured heating curve straight from the heat pump.
async function readDeviceCurve() {
  const btn = $('hc-dev-read'), el = $('hc-dev-note');
  if (btn) btn.disabled = true;
  if (el) el.innerHTML = 'Lese Heizkurve von der Wärmepumpe …';
  try {
    const r = await api('/api/heating/devicecurve');
    if (r && r.ok && r.found && r.p20 != null && r.pm10 != null) {
      try { localStorage.setItem('hc_dev_p20', r.p20); localStorage.setItem('hc_dev_pm10', r.pm10); } catch (e) {}
      if ($('hc-p20')) $('hc-p20').value = r.p20;
      if ($('hc-pm10')) $('hc-pm10').value = r.pm10;
      if (_hcData) paintHeatingCurve(_hcData); else renderHcDeviceNote(hcDevice());
      if (el) el.innerHTML = `✅ Von der Anlage gelesen (${esc(r.path || 'Heizkurve')}).` +
        (r.demo ? ' <b>(Demo)</b>' : '') + ' Du kannst die Werte oben noch anpassen.';
    } else if (r && r.ok && !r.found) {
      // diagnostic: show candidate resources so the parser can be refined
      const cands = (r.candidates || []).map(c => `<div style="margin-top:4px"><code style="font-size:11px">${esc(c.path)}</code><br><small style="color:var(--muted)">${esc(c.raw || '')}</small></div>`).join('');
      if (el) el.innerHTML = `⚠︎ Konnte die Heizkurve nicht automatisch erkennen (${r.scanned || 0} Ressourcen gescannt). ` +
        `Trag die zwei Punkte oben von Hand ein. ` +
        (cands ? `<details style="margin-top:6px"><summary style="cursor:pointer;color:var(--accent)">Gefundene Kandidaten (zum Weitergeben)</summary>${cands}</details>` : '');
    } else {
      if (el) el.innerHTML = '⚠︎ ' + escIp((r && r.error) || 'Nicht gelesen.') + ' Trag die zwei Punkte oben von Hand ein.';
    }
  } catch (e) {
    if (el) el.innerHTML = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist. Trag die Werte oben von Hand ein.';
  } finally { if (btn) btn.disabled = false; }
}
let _hcData = null, _hcBusy = false, _hcRange = null;
// the measurement window for the heating curve. 'today'/'yesterday'/'all' map to
// a ?range= query, a plain number to ?days=N. Remembered per browser.
function hcRange() {
  if (_hcRange == null) { try { _hcRange = localStorage.getItem('bhe_hc_range') || '30'; } catch (e) { _hcRange = '30'; } }
  return _hcRange;
}
const HC_RANGE_LBL = { today: 'heute', yesterday: 'gestern', all: 'gesamter Zeitraum', '7': '7 Tage', '14': '14 Tage', '30': '30 Tage' };
function hcQuery() {
  const r = hcRange();
  return /^\d+$/.test(r) ? `days=${r}` : `range=${encodeURIComponent(r)}`;
}
async function renderHeatingCurve(force) {
  const card = $('hc-card'); if (!card) return;
  if (_hcData && !force) { paintHeatingCurve(_hcData); return; }
  if (_hcBusy) return;
  _hcBusy = true;
  try { const r = await api('/api/heating/curve?' + hcQuery()); _hcData = r; paintHeatingCurve(r); }
  catch (e) { const c = $('hc-chart'); if (c) c.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
  finally { _hcBusy = false; }
}
function paintHeatingCurve(r) {
  const head = $('hc-head'), chart = $('hc-chart'), ref = $('hc-ref'), note = $('hc-note');
  if (!r || !r.ok) { if (chart) chart.innerHTML = '<div class="note">Keine Daten.</div>'; return; }
  const device = hcDevice();
  r.device = device;
  renderHcDeviceNote(device);
  // current operating point: the TRUE live state (from the heat-pump analytics),
  // independent of the selected measurement window – so the "jetzt" readout stays
  // correct even on a historical range (gestern / gesamt), where r.live_point is
  // deliberately absent. Vorlauf only when the WP is actually heating right now.
  const live = (STATE.hpA && STATE.hpA.live) || {};
  const liveHeating = ['ch', 'heating', 'heat'].includes(String(live.mode || '').toLowerCase())
    && (live.modulation || 0) > 0 && live.supply_c != null && live.supply_c >= 20;
  const nowOut = live.outdoor_c != null ? live.outdoor_c : (r.live_point ? r.live_point[0] : null);
  const nowSup = liveHeating ? live.supply_c : (r.live_point ? r.live_point[1] : null);
  r._now = { outdoor: nowOut, supply: nowSup };
  let nowTxt = '';
  if (nowOut != null) {
    const tgt = HC_IDEAL(nowOut), dk = nowSup != null ? nowSup - tgt : null;
    const dkCol = dk == null ? 'var(--muted)' : dk >= 6 ? '#ff6b8a' : dk >= 3 ? '#ffb64d' : '#4be0b0';
    nowTxt = `<b style="color:#ffd166">● Jetzt:</b> bei <b>${fmt(nowOut, 0)}°</b> außen ` +
      (nowSup != null
        ? `fährt die WP <b>${fmt(nowSup, 0)}° Vorlauf</b> · Ziel ~<b>${fmt(tgt, 0)}°</b> <span style="color:${dkCol}">(${dk >= 0 ? '+' : ''}${fmt(dk, 0)} K)</span>`
        : `– die WP <b>heizt gerade nicht</b> · nötig wären ~<b>${fmt(tgt, 0)}°</b> Vorlauf`) + '. ';
  }
  if (!r.enough) {
    if (head) head.textContent = '';
    if (ref) ref.innerHTML = '';
    if (chart) {
      const p = r.points || [];
      chart.innerHTML = (p.length >= 2 || device || nowOut != null)
        ? curveChart({ points: p, device, _now: r._now, since: r.since, until: r.until })
        : '<div class="note" style="padding:20px 0;text-align:center">📈 Noch keine Heizkurve – trage oben deine Geräte-Kurve ein oder lass die Wärmepumpe heizen.</div>';
    }
    if (note) note.innerHTML = nowTxt + '⏳ ' + esc(r.note || 'Sammelt noch Daten.') +
      ` <span style="color:var(--muted)">(Zeitraum: ${HC_RANGE_LBL[hcRange()] || hcRange()} · ${r.n || 0} Messpunkte)</span>`;
    return;
  }
  const col = r.over_k >= 6 ? '#ff6b8a' : r.over_k >= 3 ? '#ffb64d' : '#4be0b0';
  if (head) head.innerHTML = `<span style="color:${col}">${r.over_k > 0 ? '+' : ''}${fmt(r.over_k, 1)} K vs. Ziel</span>`;
  if (chart) chart.innerHTML = curveChart(r);
  if (ref) {
    // concrete recommendation box (Niveau / Steilheit) derived from the curve
    const rec = r.recommendation;
    let recBox = '';
    if (rec && rec.text) {
      const prov = r.provisional ? `<span style="color:var(--muted);font-weight:400"> · vorläufig${rec.basis === 'provisional' ? ', nur Niveau' : ''}</span>` : '';
      recBox = `<div style="background:var(--card2);border:1px solid var(--line);border-left:3px solid ${col};border-radius:8px;padding:10px 12px;margin-bottom:10px">` +
        `<div style="font-weight:700;color:${col}">💡 Empfehlung${prov}</div>` +
        `<div style="font-size:13px;margin-top:4px;line-height:1.5">${rec.text}</div>` +
        `<div style="font-size:12px;color:var(--muted);margin-top:6px">${rec.howto || ''}</div></div>`;
    }
    const row = (o, a, id) => {
      const diff = a - id, dc = diff >= 2 ? '#ff6b8a' : diff >= 1 ? '#ffb64d' : '#4be0b0';
      return `<tr><td style="padding:5px 8px">${o > 0 ? '+' : ''}${o} °C außen</td>` +
        `<td style="padding:5px 8px;text-align:right">Vorlauf <b>${fmt(a, 0)} °C</b></td>` +
        `<td style="padding:5px 8px;text-align:right;color:var(--muted)">Ziel ${fmt(id, 0)} °C</td>` +
        `<td style="padding:5px 8px;text-align:right;color:${dc}">${diff >= 0 ? '+' : ''}${fmt(diff, 0)} K</td></tr>`;
    };
    // a highlighted "jetzt"-row at the current outdoor temp (matches the gold
    // point on the chart), so the most relevant line is called out directly.
    let nowRow = '';
    if (nowOut != null) {
      const na = nowSup != null ? nowSup : (r.fit ? r.fit.a * nowOut + r.fit.b : null);
      const nid = HC_IDEAL(nowOut);
      if (na != null) {
        const diff = na - nid, dc = diff >= 2 ? '#ff6b8a' : diff >= 1 ? '#ffb64d' : '#4be0b0';
        nowRow = `<tr style="background:rgba(255,209,102,0.13)">` +
          `<td style="padding:5px 8px;border-left:3px solid #ffd166"><span style="color:#ffd166">●</span> <b>jetzt</b> · ${fmt(nowOut, 0)} °C außen</td>` +
          `<td style="padding:5px 8px;text-align:right">Vorlauf <b>${fmt(na, 0)} °C</b>${nowSup == null ? '<span style="color:var(--muted);font-weight:400"> (Modell)</span>' : ''}</td>` +
          `<td style="padding:5px 8px;text-align:right;color:var(--muted)">Ziel ${fmt(nid, 0)} °C</td>` +
          `<td style="padding:5px 8px;text-align:right;color:${dc}">${diff >= 0 ? '+' : ''}${fmt(diff, 0)} K</td></tr>`;
      }
    }
    ref.innerHTML = recBox + `<table style="width:100%;border-collapse:collapse;font-size:13px">` +
      nowRow + (r.ref || []).map(x => row(x.outdoor, x.actual, x.ideal)).join('') + `</table>`;
  }
  if (note) note.innerHTML = (nowTxt ? nowTxt + '<br>' : '') +
    `<b style="color:${col}">${esc(r.verdict)}</b> · <b>Zeitraum: ${HC_RANGE_LBL[hcRange()] || hcRange()}</b> · ${r.n} Messpunkt${r.n === 1 ? '' : 'e'}` +
    (r.csv_points ? ` (davon ${r.csv_points} aus CSV-Import)` : '') +
    (r.cycles && r.cycles.per_day != null ? ` · ~${fmt(r.cycles.per_day, 1)} Takte/Tag` : '') +
    (r.demo ? ' · <b>Demo-Daten</b>' : '') +
    (r.provisional ? '<br><span style="color:var(--muted)">Noch vorläufig – mit mehr Punkten (weiter heizen oder einen HomeCom-CSV-Export mit stündlicher Vorlauftemperatur importieren) wird die Steilheit belastbar.</span>' : '');
}

/* ---- Raumtemperatur ↔ Wärmepumpe: Soll/Ist/Feuchte + API-Prüfung ---------- */
let _rsBusy = false;
async function renderRoomSync() {
  const card = $('roomsync-card'); if (!card) return;
  if (_rsBusy) return; _rsBusy = true;
  try { const r = await api('/api/heatpump/roomsync'); paintRoomSync(r); }
  catch (e) { const t = $('roomsync-table'); if (t) t.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
  finally { _rsBusy = false; }
}
function paintRoomSync(r) {
  const head = $('roomsync-head'), verdict = $('roomsync-verdict'), table = $('roomsync-table'), note = $('roomsync-note');
  if (!r || !r.ok) { if (table) table.innerHTML = '<div class="note">Keine Daten.</div>'; return; }
  const rooms = r.rooms || [];
  if (head) head.innerHTML = `<span style="color:var(--muted)">${rooms.length} Räume</span>`;
  // verdict: does the WP accept a MEASURED room temperature?
  if (verdict) {
    if (!r.connected_wp) {
      verdict.innerHTML = '<span style="color:var(--muted)">⚙︎ Wärmepumpe (HomeCom) nicht verbunden – die Soll/Ist/Feuchte-Übersicht steht trotzdem; die API-Prüfung läuft, sobald die WP verbunden ist.</span>';
    } else if (r.supports_actual) {
      verdict.innerHTML = '<span style="color:var(--accent2)">✅ Deine Anlage meldet einen <b>schreibbaren Raumtemperatur-Eingang</b> – die gemessene Ist-Temperatur lässt sich an die WP übermitteln.</span>';
    } else {
      verdict.innerHTML = '<span style="color:var(--warn)">ℹ️ Deine Anlage bietet <b>keinen API-Eingang für die gemessene Raumtemperatur</b>.</span> ' +
        'Das ist bei der <b>Compress 6800i normal</b>: Sie ist witterungsgeführt und misst die Raumtemperatur über ihre <b>eigene Raumstation</b>, nicht über die API. ' +
        'Schreibbar ist der <b>Raum-Soll</b>' + (r.writeable_setpoints && r.writeable_setpoints.length
          ? ` (z. B. „${esc(r.writeable_setpoints[0].label)}", aktuell ${fmt(r.writeable_setpoints[0].value, 1)} °C)` : '') + '.';
    }
  }
  // per-room Ist / Soll / Feuchte table
  if (table) {
    if (!rooms.length) { table.innerHTML = '<div class="note">Keine aktiven Heizräume.</div>'; }
    else {
      const cell = (v, u) => v == null ? '<span style="color:var(--muted)">–</span>' : `<b>${fmt(v, 1)}</b>${u}`;
      table.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">` +
        `<tr style="color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em">` +
        `<td style="padding:4px 8px">Raum</td><td style="padding:4px 8px;text-align:right">Ist</td>` +
        `<td style="padding:4px 8px;text-align:right">Soll</td><td style="padding:4px 8px;text-align:right">Feuchte</td></tr>` +
        rooms.map(x => {
          const gap = (x.ist != null && x.soll != null) ? x.ist - x.soll : null;
          const gc = gap == null ? 'var(--ink)' : gap >= -0.2 ? '#4be0b0' : gap >= -1 ? '#ffb64d' : '#ff6b8a';
          return `<tr style="border-top:1px solid var(--line)">` +
            `<td style="padding:6px 8px">${esc(x.room)}${x.heating ? ' <span style="color:#4be0b0" title="heizt">●</span>' : ''}</td>` +
            `<td style="padding:6px 8px;text-align:right;color:${gc}">${cell(x.ist, '°')}</td>` +
            `<td style="padding:6px 8px;text-align:right">${cell(x.soll, '°')}</td>` +
            `<td style="padding:6px 8px;text-align:right;color:${x.feuchte > 65 ? '#ffb64d' : 'var(--ink)'}">${cell(x.feuchte, '%')}</td></tr>`;
        }).join('') + `</table>`;
    }
  }
  if (note) note.innerHTML = (r.demo ? '<b>Demo-Daten.</b> ' : '') +
    'Quelle: deine Bosch-Raumthermostate (Ist/Soll) und Feuchte-Sensoren. ' +
    (r.supports_actual
      ? 'Die Übermittlung der Ist-Temperatur an die WP kann der Energiemanager übernehmen.'
      : 'Da die WP keine gemessene Raumtemperatur annimmt, nutzt der Energiemanager später den <b>Raum-Soll</b> als Stellhebel – z. B. Soll leicht anheben, wenn ein Raum zu kühl ist, oder absenken, wenn es passt. So „weiß" die WP indirekt über die Raumlage Bescheid.');
}

// ===== Warmwasser kostet Komfort: Innentemperatur-Dip durch WW-Vorrang ===== #
let _dwDays = null, _dwData = {}, _dwBusy = false;
function dwDays() { if (_dwDays == null) { try { _dwDays = parseInt(localStorage.getItem('bhe_dw_days'), 10) || 14; } catch (e) { _dwDays = 14; } } return _dwDays; }
async function renderDhwImpact() {
  const card = $('dhw-card'); if (!card) return;
  const d = dwDays();
  if (_dwData[d]) { paintDhwImpact(_dwData[d]); return; }
  if (_dwBusy) return; _dwBusy = true;
  const ch = $('dhw-chart'); if (ch) ch.innerHTML = '<div class="note" style="padding:14px 0;text-align:center">Lade Warmwasser-Analyse …</div>';
  try { const r = await api('/api/heatpump/dhwimpact?days=' + d); _dwData[d] = r; paintDhwImpact(r); }
  catch (e) { if (ch) ch.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
  finally { _dwBusy = false; }
}
// one representative DHW phase: indoor temp line, shaded WW-pause, start-temp
// reference line, lowest-point and "wieder warm" markers
function dhwEventChart(rep) {
  const s = rep.series || []; if (s.length < 3) return '<div class="note">Zu wenig Messpunkte für die Kurve.</div>';
  const h = 215, padL = 42, padR = 14, top = 16, base = h - 26, n = s.length;
  const temps = s.map(p => p.temp);
  const lo = Math.min(rep.t_start, ...temps) - 0.3, hi = Math.max(rep.t_start, ...temps) + 0.3;
  const span = Math.max(0.6, hi - lo);
  const X = i => padL + (CW - padL - padR) * (n <= 1 ? 0 : i / (n - 1));
  const Y = v => top + (1 - (v - lo) / span) * (base - top);
  const t0 = s[0].ts, t1 = s[n - 1].ts;
  const xForTs = ts => { const fr = (ts - t0) / Math.max(1, t1 - t0); return padL + (CW - padL - padR) * Math.max(0, Math.min(1, fr)); };
  // shaded WW-pause band
  const xa = xForTs(rep.start), xb = xForTs(rep.end);
  let g = `<rect x="${xa.toFixed(1)}" y="${top}" width="${Math.max(2, xb - xa).toFixed(1)}" height="${(base - top).toFixed(1)}" fill="${COL.hp}" fill-opacity="0.12"/>`;
  g += `<text class="axis" x="${((xa + xb) / 2).toFixed(1)}" y="${top + 10}" text-anchor="middle" fill="${COL.hp}" style="font-size:9px">Warmwasser</text>`;
  // y gridlines (2 levels) + start-temp reference line
  const yS = Y(rep.t_start);
  g += `<line x1="${padL}" x2="${CW - padR}" y1="${yS.toFixed(1)}" y2="${yS.toFixed(1)}" stroke="var(--accent2)" stroke-width="1" stroke-dasharray="4 3" opacity="0.85"/>`;
  g += `<text class="axis" x="${padL + 2}" y="${(yS - 4).toFixed(1)}" fill="var(--accent2)" style="font-size:9px">Start ${fmt(rep.t_start, 1)} °C</text>`;
  // temp line
  let line = ''; s.forEach((p, i) => { line += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.temp).toFixed(1)} `; });
  g += `<path d="${line.trim()}" fill="none" stroke="var(--sh,#4da3ff)" stroke-width="2.2" stroke-linejoin="round"/>`;
  // lowest point marker
  let miV = Infinity, miI = 0; s.forEach((p, i) => { if (p.temp < miV) { miV = p.temp; miI = i; } });
  g += `<circle cx="${X(miI).toFixed(1)}" cy="${Y(miV).toFixed(1)}" r="3.5" fill="${COL.sh}"/>`;
  g += `<text class="axis" x="${X(miI).toFixed(1)}" y="${(Y(miV) + 13).toFixed(1)}" text-anchor="middle" style="font-size:9px">Tief ${fmt(miV, 1)} °C</text>`;
  // recovery marker
  if (rep.rec_ts) {
    const xr = xForTs(rep.rec_ts);
    g += `<line x1="${xr.toFixed(1)}" x2="${xr.toFixed(1)}" y1="${top}" y2="${base}" stroke="${COL.pv}" stroke-width="1" stroke-dasharray="2 2" opacity="0.8"/>`;
    g += `<circle cx="${xr.toFixed(1)}" cy="${Y(rep.t_start).toFixed(1)}" r="3.5" fill="${COL.pv}"/>`;
    g += `<text class="axis" x="${Math.min(CW - padR - 2, xr + 3).toFixed(1)}" y="${(top + 10).toFixed(1)}" fill="${COL.pv}" style="font-size:9px">wieder warm</text>`;
  }
  // y axis labels
  [lo + span * 0.15, lo + span * 0.85].forEach(v => { g += `<text class="axis" x="${padL - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${fmt(v, 1)}</text>`; });
  // x time labels
  [0, Math.floor(n / 2), n - 1].forEach(i => { const hhmm = new Date(s[i].ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); g += `<text class="axis" x="${X(i).toFixed(1)}" y="${h - 6}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${hhmm}</text>`; });
  const tips = s.map(p => `<b>${new Date(p.ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</b> · innen <b>${fmt(p.temp, 1)} °C</b>`);
  return svg(h, g, { kind: 'area', pad: padL, padR, n, h, tips });
}
function paintDhwImpact(r) {
  const head = $('dhw-head'), kpis = $('dhw-kpis'), ch = $('dhw-chart'), repNote = $('dhw-rep-note'),
    legend = $('dhw-legend'), byout = $('dhw-byout'), evs = $('dhw-events'), note = $('dhw-note'), levEl = $('dhw-levers'),
    patEl = $('dhw-pattern');
  const clear = () => [kpis, legend, byout, evs, levEl, patEl].forEach(e => { if (e) e.innerHTML = ''; });
  if (!r || !r.ok || !r.n) {
    const why = r && r.reason === 'no_temp'
      ? 'Dafür brauche ich <b>Innentemperatur über die Zeit</b> aus deinen Bosch-Raumthermostaten – die sammelt die App im Betrieb. Nach ein paar Tagen erscheint hier die Auswertung.'
      : r && r.reason === 'no_dhw'
        ? 'Im Zeitraum habe ich keine klar abgegrenzte <b>Warmwasser-Phase</b> gefunden (oder sie hat die Heizung nicht spürbar pausiert).'
        : 'Noch keine Daten – kommt, sobald WP-Betrieb und Raumtemperaturen über ein paar Tage vorliegen.';
    if (ch) ch.innerHTML = `<div class="note" style="padding:14px 0;text-align:center">${why}</div>`;
    [repNote, note].forEach(e => { if (e) e.innerHTML = ''; }); if (head) head.innerHTML = ''; clear(); return;
  }
  if (head) head.innerHTML = `<span style="color:var(--muted)">${r.n} WW-Phasen</span>`;
  const kpi = (v, l) => `<div class="kpi sm"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  if (kpis) kpis.innerHTML =
    kpi('−' + fmt(r.avg_drop, 1).replace('-', '') + ' °C', 'Ø Abkühlung') +
    kpi(r.avg_recov_min != null ? '~' + fmt(r.avg_recov_min, 0) + ' min' : '–', 'Ø wieder warm') +
    kpi((r.n_meaningful != null ? r.n_meaningful : '?') + '×', `von ${r.n} spürbar`);
  // measured charging pattern: equal-length charges that restart right away
  if (patEl) {
    const p = r.pattern;
    if (p && p.html) {
      const c = p.level === 'warn' ? '#ffb64d' : 'var(--accent)';
      patEl.innerHTML = `<div style="border:1px solid ${c};background:${c}14;border-radius:12px;padding:11px 12px">` +
        `<div style="font-weight:700;font-size:13.5px;margin-bottom:4px">🔁 Warum schaltet sie so oft um?</div>` +
        `<div style="font-size:13px;line-height:1.55">${p.html}</div></div>`;
    } else patEl.innerHTML = '';
  }
  // concrete levers to shrink the dip (quantified from the user's own data)
  if (levEl) {
    const lv = r.levers || [];
    levEl.innerHTML = lv.length
      ? `<div style="font-weight:600;font-size:13.5px;margin-bottom:8px">💡 Hebel: so verkleinerst du den Dip</div>` + lv.map(l => {
        const chip = l.benefit_c != null
          ? `<span style="white-space:nowrap;font-size:11px;background:color-mix(in srgb,${COL.pv} 22%,transparent);color:var(--fg);border:1px solid ${COL.pv};padding:2px 8px;border-radius:999px;font-weight:700">~${fmt(l.benefit_c, 1)} °C weniger</span>`
          : `<span style="white-space:nowrap;font-size:11px;color:var(--muted);border:1px solid var(--line);padding:2px 8px;border-radius:999px">allgemein</span>`;
        return `<div style="padding:9px 0;border-bottom:1px solid var(--line)">` +
          `<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">` +
          `<b style="font-size:13px">${esc(l.icon || '•')} ${esc(l.title)}</b>${chip}</div>` +
          `<div class="note" style="margin-top:3px">${esc(l.detail)}</div></div>`;
      }).join('')
      : '';
  }
  // representative phase
  const rep = r.representative;
  if (rep && ch) {
    ch.innerHTML = `<div style="touch-action:none">${dhwEventChart(rep)}</div>`;
    const when = new Date(rep.start * 1000).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    if (repNote) repNote.innerHTML = `${esc(when)} · WW dauerte <b>${fmt(rep.dur_min, 0)} min</b>${rep.outdoor != null ? ` · außen ${fmt(Math.round(rep.outdoor) + 0, 0)} °C` : ''}: ` +
      `innen von <b>${fmt(rep.t_start, 1)} °C</b> auf <b>${fmt(rep.t_min, 1)} °C</b> gefallen (−${fmt(rep.drop, 1)} °C)` +
      (rep.recov_min != null
        ? `, nach <b>${fmt(rep.recov_min, 0)} min</b> wieder bei ${fmt(rep.t_start, 1)} °C.`
        : rep.status === 'tight'
          ? ` – danach kam nach nur <b>${fmt(rep.heat_min, 0)} min</b> Heizen schon die nächste WW-Phase, kaum Zeit zum Aufheizen.`
          : ' – auch nach ausreichend Heizzeit noch nicht ganz zurück.');
  }
  if (legend) legend.innerHTML =
    `<div class="it"><span class="sw" style="background:${COL.sh}"></span>Innentemperatur</div>` +
    `<div class="it"><span class="sw" style="background:${COL.hp};opacity:.4"></span>Warmwasser (Heizung pausiert)</div>` +
    `<div class="it"><span class="sw" style="background:var(--accent2)"></span>Startwert</div>` +
    `<div class="it"><span class="sw" style="background:${COL.pv}"></span>wieder warm</div>`;
  // by outdoor temperature
  if (byout) {
    const rows = (r.by_outdoor || []).filter(b => b.n > 0);
    byout.innerHTML = rows.length ? `<h2 style="font-size:14px;margin:4px 0 6px">Je nach Außentemperatur</h2>` + rows.map(b =>
      `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px;padding:5px 0;border-bottom:1px solid var(--line)">` +
      `<span>${esc(b.label)} <span style="color:var(--muted)">· ${b.n}×</span></span>` +
      `<span style="white-space:nowrap">−<b>${fmt(b.avg_drop, 1)} °C</b>${b.avg_recov_min != null ? ` <span style="color:var(--muted)">· ~${fmt(b.avg_recov_min, 0)} min zurück</span>` : ''}</span></div>`).join('') : '';
  }
  // recent events (newest first)
  if (evs) {
    const list = (r.events || []).slice().reverse().slice(0, 8);
    const when = ts => new Date(ts * 1000).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const right = e => {
      if (e.status === 'minimal')
        return `<span style="color:var(--muted)">${e.drop >= 0.05 ? '−' + fmt(e.drop, 1) : '0,0'} °C · kaum Abkühlung</span>`;
      if (e.status === 'recovered')
        return `−<b>${fmt(e.drop, 1)} °C</b> <span style="color:var(--muted)">· ~${fmt(e.recov_min, 0)} min zurück</span>`;
      if (e.status === 'tight')
        return `−<b>${fmt(e.drop, 1)} °C</b> <span style="color:var(--muted)">· danach nur ${fmt(e.heat_min, 0)} min Heizen</span>`;
      return `−<b>${fmt(e.drop, 1)} °C</b> <span style="color:var(--muted)">· noch nicht zurück</span>`;
    };
    evs.innerHTML = `<h2 style="font-size:14px;margin:12px 0 6px">Letzte Warmwasser-Phasen</h2>` + list.map(e =>
      `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px;padding:6px 0;border-bottom:1px solid var(--line)">` +
      `<span>${esc(when(e.start))} <span style="color:var(--muted)">· ${fmt(e.dur_min, 0)} min${e.outdoor != null ? ` · ${fmt(Math.round(e.outdoor) + 0, 0)} °C` : ''}` +
        (e.tank_end != null ? `<br>Speicher ${e.tank_start != null ? fmt(e.tank_start, 0) + ' → ' : ''}${fmt(e.tank_end, 0)} °C` +
          (e.tank_set != null ? ` <span style="color:${e.tank_reached ? '#4be0b0' : '#ffb64d'}">(Soll ${fmt(e.tank_set, 0)} ${e.tank_reached ? 'erreicht' : 'nicht erreicht'})</span>` : '') : '') +
      `</span></span>` +
      `<span style="white-space:nowrap">${right(e)}</span></div>`).join('');
  }
  if (note) {
    const nm = r.n_minimal || 0, nt = r.n_tight || 0, nr = r.n_recovered || 0, no = r.n_open || 0;
    const parts = [`Über <b>${r.n} Warmwasser-Phasen</b> pausiert die Heizung im Schnitt <b>${fmt(r.avg_dur_min, 0)} min</b>; typisch kühlt das Haus dabei um <b>~${fmt(r.avg_drop, 1)} °C</b> ab (max. ${fmt(r.max_drop, 1)} °C).`];
    if (nm) parts.push(`<b>${nm}×</b> war die Abkühlung praktisch null – da kostet Warmwasser quasi keinen Komfort.`);
    if (nr) parts.push(`Wo die Heizung danach aufholen konnte, war es nach <b>~${r.median_recov_min != null ? fmt(r.median_recov_min, 0) : '?'} min</b> (Median) wieder auf dem Ausgangswert${no ? `, ${no}× war die Zeit noch nicht ganz genug` : ''}.`);
    if (nt) parts.push(`<b>${nt}×</b> wurde der Startwert nicht wieder erreicht – aber nicht, weil Warmwasser so viel kostet, sondern weil danach <b>kaum Heizzeit</b> blieb: die nächste WW-Phase kam zu schnell, das Haus hatte keine Chance aufzuheizen.`);
    if (r.median_heat_min != null) parts.push(r.median_heat_min < 60
      ? `Zwischen zwei WW-Phasen liegen im Median nur <b>~${fmt(r.median_heat_min, 0)} min</b> Heizen – die Phasen sitzen also dicht hintereinander.`
      : `Zwischen zwei WW-Phasen liegen im Median <b>~${fmt(r.median_heat_min, 0)} min</b> Heizen – meist also genug Zeit zum Aufheizen.`);
    note.innerHTML = parts.join(' ') +
      ` <span style="color:var(--muted)">Je kälter draußen, desto größer der Dip. Willst du den Komfortverlust kleiner: die WW-Phasen <b>entzerren</b> (WW-Hysterese/Soll senken, Zeitfenster), damit zwischendurch länger geheizt wird, oder WW in die Mittagszeit legen. Innentemperatur kommt aus deinen Bosch-Thermostaten, die WW-Phasen aus der Wärmepumpe.</span>`;
  }
  // how the heating is really operated (read, not assumed) – shown below the note
  if (_opData) paintOpState(_opData); else renderOpState(false);
}

// ===== Tagesverlauf Wärmepumpe: chronologische Zustände + Leistung ========= #
const _HPDN = 200;                          // buckets across the VISIBLE window
// zoom span for the day view (hours, or 'auto'/'day')
function hpdSpan() { try { return localStorage.getItem('bhe_hpd_span') || 'auto'; } catch (e) { return 'auto'; } }
function hpdSetSpan(s) { try { localStorage.setItem('bhe_hpd_span', s); } catch (e) {} if (_hpDayShown) paintHpDay(_hpDayShown); }
// visible [w0,w1] window from the chosen span + the day's data extent
function hpdWindow(r, span) {
  const dayS = r.start, dayE = r.start + 86400, nowS = Math.floor(Date.now() / 1000);
  const ds = r.data_start || dayS, de = r.data_end || dayE;
  if (span === 'day') return { w0: dayS, w1: dayE };
  if (span === 'auto') {
    let a = ds, b = r.is_today ? Math.max(de, Math.min(nowS, dayE)) : de;
    if (b - a < 3600) b = a + 3600;
    const pad = (b - a) * 0.03; return { w0: Math.max(dayS, a - pad), w1: Math.min(dayE, b + pad) };
  }
  const H = Math.max(1, parseFloat(span)) * 3600;
  let b = r.is_today ? Math.min(nowS, dayE) : de, a = b - H;
  if (a < dayS) { a = dayS; b = Math.min(dayE, a + H); }
  if (b > dayE) { b = dayE; a = Math.max(dayS, b - H); }
  return { w0: a, w1: b };
}
// bucket the raw samples into nb slots over [w0,w1]
function hpdBucket(raw, w0, w1, nb) {
  const bw = (w1 - w0) / nb, keys = ['p', 'h', 'mod', 'cop', 'sup', 'ret', 'out'];
  const acc = Array.from({ length: nb }, () => ({ p: [], h: [], mod: [], cop: [], sup: [], ret: [], out: [] }));
  (raw || []).forEach(s => { if (s.t < w0 || s.t >= w1) return; let i = Math.floor((s.t - w0) / bw); if (i < 0) i = 0; if (i >= nb) i = nb - 1; keys.forEach(k => { if (s[k] != null) acc[i][k].push(s[k]); }); });
  const av = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  return acc.map((a, i) => { const o = { t: Math.round(w0 + (i + 0.5) * bw) }; keys.forEach(k => o[k] = av(a[k])); return o; });
}
// bucket room point-measurements into nb slots, then connect across small gaps
// by linear interpolation (the thermostats report sparsely → dotty otherwise)
function hpdBucketRooms(rooms, w0, w1, nb) {
  const bw = (w1 - w0) / nb, maxGap = Math.max(1, Math.round(2700 / bw));  // ~45 min
  return (rooms || []).map(r => {
    const slots = Array.from({ length: nb }, () => []);
    (r.points || []).forEach(p => { if (p.t < w0 || p.t >= w1) return; let i = Math.floor((p.t - w0) / bw); if (i < 0) i = 0; if (i >= nb) i = nb - 1; slots[i].push(p.temp); });
    const vals = slots.map(a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const idx = []; vals.forEach((v, i) => { if (v != null) idx.push(i); });
    for (let k = 0; k < idx.length - 1; k++) { const a = idx[k], b = idx[k + 1]; if (b - a > 1 && b - a <= maxGap) for (let j = a + 1; j < b; j++) vals[j] = vals[a] + (vals[b] - vals[a]) * (j - a) / (b - a); }
    return { room: r.room, color: r.color, setpoint: r.setpoint, vals };
  });
}
const HP_ST = {
  heating: { label: 'Heizung', color: '#ef6c4d' },
  water: { label: 'Warmwasser', color: '#4da3ff' },
  defrost: { label: 'Abtauen', color: '#7fd1e8' },
  cooling: { label: 'Kühlen', color: '#38bdd8' },
  idle: { label: 'Pause', color: '#49505f' },
};
const HP_HEATER = '#ff5d73';
const HPD_SERIES = [
  { key: 'p', label: 'Strom', unit: 'kW', color: '#ef6c4d' },
  { key: 'h', label: 'Wärme', unit: 'kW', color: '#f6b93b' },
  { key: 'mod', label: 'Modulation', unit: '%', color: '#a970ff' },
  { key: 'cop', label: 'COP', unit: '', color: '#ffd166' },
  { key: 'sup', label: 'Vorlauf', unit: '°C', color: '#ff8a5c' },
  { key: 'ret', label: 'Rücklauf', unit: '°C', color: '#5c9bff' },
  { key: 'out', label: 'Außen', unit: '°C', color: '#9aa4b2' },
];
const HPD_EV = {
  heating: '🔥 Heizung', water: '🚿 Warmwasser', defrost: '❄️ Abtauen',
  cooling: '❄️ Kühlen', idle: '⏸️ Pause', heater: '⚡ Zuheizer',
};
let _hpDayDate = null, _hpDayCur = null, _hpDayShown = null, _hpDayData = {}, _hpDayBusy = false;
function hpdToggles() {
  try { const v = JSON.parse(localStorage.getItem('bhe_hpd_tg') || 'null'); if (v && typeof v === 'object') return v; } catch (e) {}
  return { p: true, h: true, mod: true, cop: false, sup: false, ret: false, out: false };
}
function hpdToggle(key) {
  const t = hpdToggles(); t[key] = !t[key];
  try { localStorage.setItem('bhe_hpd_tg', JSON.stringify(t)); } catch (e) {}
  if (_hpDayShown) paintHpDay(_hpDayShown);
}
function _hpdDateStr(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function hpdShift(delta) {
  if (!_hpDayCur) return;
  if (delta > 0 && _hpDayCur === _hpdDateStr(new Date())) return;
  const d = new Date(_hpDayCur + 'T12:00:00'); d.setDate(d.getDate() + delta);
  const ns = _hpdDateStr(d);
  _hpDayDate = (ns === _hpdDateStr(new Date())) ? null : ns;
  renderHpDay();
}
async function renderHpDay() {
  const card = $('hpd-card'); if (!card) return;
  const key = _hpDayDate || 'today';
  if (_hpDayData[key] && key !== 'today') { paintHpDay(_hpDayData[key]); return; }
  if (_hpDayBusy) return; _hpDayBusy = true;
  const ch = $('hpd-chart'); if (ch && !_hpDayData[key]) ch.innerHTML = '<div class="note" style="padding:14px 0;text-align:center">Lade Tagesverlauf …</div>';
  try { const r = await api('/api/heatpump/day' + (_hpDayDate ? ('?date=' + _hpDayDate) : '')); _hpDayData[key] = r; paintHpDay(r); }
  catch (e) { if (ch) ch.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
  finally { _hpDayBusy = false; }
}
// path builders that break over null gaps (device offline / future hours)
function _hpdLine(series, acc, X, Y) {
  let d = '', pen = false;
  series.forEach((s, i) => { const v = acc(s); if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' '; pen = true; });
  return d.trim();
}
function _hpdArea(series, acc, X, Y, base) {
  let out = '', run = [];
  const flush = () => { if (run.length > 1) { let d = 'M' + run[0][0].toFixed(1) + ' ' + base.toFixed(1) + ' '; run.forEach(p => d += 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1) + ' '); d += 'L' + run[run.length - 1][0].toFixed(1) + ' ' + base.toFixed(1) + ' Z'; out += '<path d="' + d + '"/>'; } run = []; };
  series.forEach((s, i) => { const v = acc(s); if (v == null) { flush(); return; } run.push([X(i), Y(v)]); });
  flush(); return out;
}
function hpdTips(vb, tg, rvb) {
  return vb.map((s, i) => {
    const hasRoom = (rvb || []).some(r => r.vals[i] != null);
    if (s.p == null && s.h == null && s.mod == null && s.out == null && !hasRoom) return null;
    const hhmm = new Date(s.t * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const parts = [];
    if (tg.p && s.p != null) parts.push(`<span style="color:#ef6c4d">⚡ ${fmt(s.p, 2)} kW</span>`);
    if (tg.h && s.h != null) parts.push(`<span style="color:#f6b93b">🔥 ${fmt(s.h, 2)} kW</span>`);
    if (tg.mod && s.mod != null) parts.push(`Mod ${fmt(s.mod, 0)} %`);
    if (tg.cop && s.cop != null) parts.push(`COP ${fmt(s.cop, 2)}`);
    if (tg.sup && s.sup != null) parts.push(`VL ${fmt(s.sup, 1)}°`);
    if (tg.ret && s.ret != null) parts.push(`RL ${fmt(s.ret, 1)}°`);
    if (tg.out && s.out != null) parts.push(`Außen ${fmt(s.out, 1)}°`);
    (rvb || []).forEach(r => { const v = r.vals[i]; if (v != null) parts.push(`<span style="color:${r.color}">●</span>${esc(r.room)} ${fmt(v, 1)}°`); });
    return `<b>${hhmm}</b> · ${parts.join(' · ')}`;
  });
}
// room-toggle state (default: a room is shown unless explicitly switched off)
function hpdRoomTg() { try { const v = JSON.parse(localStorage.getItem('bhe_hpd_rooms') || 'null'); if (v && typeof v === 'object') return v; } catch (e) {} return {}; }
function hpdRoomOn(room) { return hpdRoomTg()[room] !== false; }
function hpdRoomToggle(room) { const m = hpdRoomTg(); m[room] = !(m[room] !== false); try { localStorage.setItem('bhe_hpd_rooms', JSON.stringify(m)); } catch (e) {} if (_hpDayShown) paintHpDay(_hpDayShown); }
// per-room indoor temperatures (tight axis so small changes show); rvb carries
// the windowed, gap-connected values per room
function hpdRooms(rvb, tips) {
  const act = (rvb || []).filter(r => r.vals.some(v => v != null));
  if (!act.length) return '';
  const h = 120, padL = 42, padR = 14, top = 10, base = h - 18, n = act[0].vals.length;
  const X = i => padL + (CW - padL - padR) * (i / (n - 1));
  const vals = []; act.forEach(r => r.vals.forEach(v => { if (v != null) vals.push(v); }));
  const lo = Math.min(...vals) - 0.4, hi = Math.max(...vals) + 0.4, span = Math.max(2, hi - lo);
  const Y = v => top + (1 - (v - lo) / span) * (base - top);
  let g = '';
  [lo + span * 0.12, lo + span * 0.5, lo + span * 0.88].forEach(v => { g += `<line class="gl" x1="${padL}" x2="${CW - 4}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis" x="0" y="${(Y(v) + 3).toFixed(1)}">${fmt(v, 1)}°</text>`; });
  act.forEach(r => { g += `<path d="${_hpdLine(r.vals, v => v, X, Y)}" fill="none" stroke="${r.color}" stroke-width="1.8"/>`; });
  g += `<text class="axis" x="${CW - 2}" y="${(top + 2).toFixed(1)}" text-anchor="end" fill="var(--muted)">Räume °C</text>`;
  return svg(h, g, { kind: 'area', pad: padL, padR, n, h, tips });
}
function hpdPower(series, tips, tg) {
  const h = 150, padL = 42, padR = 14, top = 12, base = h - 22;
  const X = i => padL + (CW - padL - padR) * (i / (_HPDN - 1));
  const vals = []; series.forEach(s => { if (tg.p && s.p != null) vals.push(s.p); if (tg.h && s.h != null) vals.push(s.h); });
  const sc = niceScale(Math.max(0.5, ...vals)), yMax = sc.max;
  const Y = v => top + (1 - Math.max(0, Math.min(yMax, v)) / yMax) * (base - top);
  let g = gridLines(h, top, base, padL, yMax, { step: sc.step, unit: 'kW' });
  if (tg.h) { g += `<g fill="#f6b93b" fill-opacity="0.15">${_hpdArea(series, s => s.h, X, Y, base)}</g><path d="${_hpdLine(series, s => s.h, X, Y)}" fill="none" stroke="#f6b93b" stroke-width="1.8"/>`; }
  if (tg.p) { g += `<g fill="#ef6c4d" fill-opacity="0.22">${_hpdArea(series, s => s.p, X, Y, base)}</g><path d="${_hpdLine(series, s => s.p, X, Y)}" fill="none" stroke="#ef6c4d" stroke-width="2"/>`; }
  return svg(h, g, { kind: 'area', pad: padL, padR, n: _HPDN, h, tips });
}
function hpdModCop(series, tips, tg) {
  const h = 108, padL = 42, padR = 26, top = 10, base = h - 18;
  const X = i => padL + (CW - padL - padR) * (i / (_HPDN - 1));
  let g = '';
  if (tg.mod) {
    const Y = v => top + (1 - Math.max(0, Math.min(100, v)) / 100) * (base - top);
    g += gridLines(h, top, base, padL, 100, { step: 50, unit: '%' });
    g += `<g fill="#a970ff" fill-opacity="0.16">${_hpdArea(series, s => s.mod, X, Y, base)}</g><path d="${_hpdLine(series, s => s.mod, X, Y)}" fill="none" stroke="#a970ff" stroke-width="1.8"/>`;
  }
  if (tg.cop) {
    const cops = series.map(s => s.cop).filter(v => v != null);
    const sc = niceScale(Math.max(2, ...cops, 0.1)), yMax = sc.max;
    const Y = v => top + (1 - Math.max(0, Math.min(yMax, v)) / yMax) * (base - top);
    g += `<path d="${_hpdLine(series, s => s.cop, X, Y)}" fill="none" stroke="#ffd166" stroke-width="1.8"/>`;
    for (let k = 0; k <= yMax + 1e-6; k += sc.step) g += `<text class="axis" x="${CW - 2}" y="${(Y(k) + 3).toFixed(1)}" text-anchor="end" fill="#ffd166">${fmt(k, 0)}</text>`;
    g += `<text class="axis" x="${CW - 2}" y="${(top + 2).toFixed(1)}" text-anchor="end" fill="#ffd166">COP</text>`;
  }
  return svg(h, g, { kind: 'area', pad: padL, padR, n: _HPDN, h, tips });
}
function hpdTemp(series, tips, tg) {
  const h = 108, padL = 42, padR = 14, top = 10, base = h - 18;
  const X = i => padL + (CW - padL - padR) * (i / (_HPDN - 1));
  const vals = []; ['sup', 'ret', 'out'].forEach(k => { if (tg[k]) series.forEach(s => { if (s[k] != null) vals.push(s[k]); }); });
  if (!vals.length) return '';
  const lo = Math.min(...vals) - 1, hi = Math.max(...vals) + 1, span = Math.max(4, hi - lo);
  const Y = v => top + (1 - (v - lo) / span) * (base - top);
  let g = '';
  [lo + span * 0.12, lo + span * 0.5, lo + span * 0.88].forEach(v => { g += `<line class="gl" x1="${padL}" x2="${CW - 4}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis" x="0" y="${(Y(v) + 3).toFixed(1)}">${fmt(v, 0)}°</text>`; });
  [['sup', '#ff8a5c'], ['ret', '#5c9bff'], ['out', '#9aa4b2']].forEach(([k, c]) => { if (tg[k]) g += `<path d="${_hpdLine(series, s => s[k], X, Y)}" fill="none" stroke="${c}" stroke-width="1.8"/>`; });
  return svg(h, g, { kind: 'area', pad: padL, padR, n: _HPDN, h, tips });
}
function hpdRibbon(r, w0, w1) {
  const h = 52, padL = 42, padR = 14, bandY = 6, bandH = 20, heatY = 29, heatH = 5, W = CW - padL - padR;
  const xf = ts => padL + W * Math.max(0, Math.min(1, (ts - w0) / (w1 - w0)));
  let g = `<rect x="${padL}" y="${bandY}" width="${W.toFixed(1)}" height="${bandH}" fill="#20252e"/>`;
  (r.segments || []).forEach(s => { if (s.end <= w0 || s.start >= w1) return; const x0 = xf(s.start), x1 = xf(s.end), c = (HP_ST[s.state] || {}).color || '#555'; g += `<rect x="${x0.toFixed(1)}" y="${bandY}" width="${Math.max(0.6, x1 - x0).toFixed(1)}" height="${bandH}" fill="${c}"/>`; });
  (r.heater || []).forEach(s => { if (s.end <= w0 || s.start >= w1) return; const x0 = xf(s.start), x1 = xf(s.end); g += `<rect x="${x0.toFixed(1)}" y="${heatY}" width="${Math.max(1.2, x1 - x0).toFixed(1)}" height="${heatH}" rx="1" fill="${HP_HEATER}"/>`; });
  g += `<text class="axis" x="0" y="${(heatY + heatH).toFixed(1)}">Zuheiz.</text>`;
  // time ticks adapted to the window span
  const spanH = (w1 - w0) / 3600, stepS = (spanH <= 2 ? 0.5 : spanH <= 6 ? 1 : spanH <= 16 ? 2 : 3) * 3600;
  for (let t = Math.ceil(w0 / stepS) * stepS; t <= w1 + 1; t += stepS) { const x = xf(t); g += `<text class="axis" x="${x.toFixed(1)}" y="${h - 2}" text-anchor="middle">${new Date(t * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</text>`; }
  const nowS = Math.floor(Date.now() / 1000);
  if (r.is_today && nowS > w0 && nowS < w1) { const x = xf(nowS); g += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${bandY}" y2="${bandY + bandH}" stroke="#fff" stroke-width="1.5" stroke-dasharray="2 2" opacity="0.7"/>`; }
  const nb = 160, tips = []; for (let i = 0; i < nb; i++) { const ts = w0 + (i + 0.5) * (w1 - w0) / nb; const seg = (r.segments || []).find(s => ts >= s.start && ts < s.end); tips.push(seg ? `<b>${new Date(ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</b> · ${(HP_ST[seg.state] || {}).label || seg.state}` : null); }
  return svg(h, g, { kind: 'area', pad: padL, padR, n: nb, h, tips });
}
function _hpdHm(min) { min = Math.round(min || 0); return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + (min % 60) + ' min'; }
function paintHpDay(r) {
  _hpDayShown = r;
  const kpisEl = $('hpd-kpis'), tgEl = $('hpd-tg'), ch = $('hpd-chart'), rl = $('hpd-ribbon-legend'),
    evs = $('hpd-events'), note = $('hpd-note'), lbl = $('hpd-daylabel'), prev = $('hpd-prev'), nx = $('hpd-next');
  const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  if (r && r.date) { const p = r.date.split('-'); _hpDayCur = r.date; if (lbl) lbl.innerHTML = `${WD[r.weekday] || ''}, ${p[2]}.${p[1]}.${p[0]}` + (r.is_today ? ' · <span style="color:var(--accent2)">heute</span>' : ''); }
  if (prev) { prev.disabled = !(r && r.has_prev); prev.style.opacity = (r && r.has_prev) ? '1' : '0.4'; }
  if (nx) { nx.disabled = !(r && r.has_next); nx.style.opacity = (r && r.has_next) ? '1' : '0.4'; }
  if (!r || !r.ok || !r.n || r.n < 2) {
    if (ch) ch.innerHTML = '<div class="note" style="padding:16px 0;text-align:center">Für diesen Tag liegen keine Wärmepumpen-Daten vor.</div>';
    [kpisEl, tgEl, rl, evs, note, $('hpd-rooms')].forEach(e => { if (e) e.innerHTML = ''; }); return;
  }
  const k = r.kpis, tg = hpdToggles();
  const kpi = (v, l) => `<div class="kpi sm"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  if (kpisEl) kpisEl.innerHTML =
    kpi(kwh(k.elec_kwh, 1), 'Strom') + kpi(kwh(k.heat_kwh, 1), 'Wärme erzeugt') +
    kpi(k.cop != null ? fmt(k.cop, 2) : '–', 'Ø Arbeitszahl') +
    kpi(_hpdHm(k.runtime_min), 'Laufzeit') +
    kpi(k.starts + '× · ' + _hpdHm(k.pause_min), 'Takte · Pause') +
    kpi(k.defrost_count + '× · ' + k.defrost_min + ' min', 'Abtauen') +
    kpi(k.heater_min > 0 ? _hpdHm(k.heater_min) : '–', 'Zuheizer') +
    kpi(fmt(k.max_power_kw, 1) + ' kW', 'Spitze elektr.') +
    kpi(k.avg_mod != null ? fmt(k.avg_mod, 0) + ' %' : '–', 'Ø Modulation');
  if (tgEl) tgEl.innerHTML = HPD_SERIES.map(s => { const on = !!tg[s.key]; return `<button class="hpd-t" data-hpt="${s.key}" aria-pressed="${on}" style="padding:6px 10px;border-radius:999px;font-size:12px;cursor:pointer;border:1px solid ${on ? s.color : 'var(--line)'};background:${on ? 'color-mix(in srgb,' + s.color + ' 20%,transparent)' : 'transparent'};color:var(--fg)"><span style="color:${s.color}">●</span> ${esc(s.label)}${s.unit ? (' ' + esc(s.unit)) : ''}</button>`; }).join('');
  const rr = $('hpd-rooms');
  if (rr) rr.innerHTML = (r.rooms || []).length
    ? `<span style="font-size:11px;color:var(--muted);align-self:center;margin-right:2px">Räume:</span>` + (r.rooms || []).map(rm => { const on = hpdRoomOn(rm.room); return `<button class="hpd-rt" data-hpr="${esc(rm.room)}" aria-pressed="${on}" style="padding:5px 9px;border-radius:999px;font-size:11.5px;cursor:pointer;border:1px solid ${on ? rm.color : 'var(--line)'};background:${on ? 'color-mix(in srgb,' + rm.color + ' 20%,transparent)' : 'transparent'};color:var(--fg)"><span style="color:${rm.color}">●</span> ${esc(rm.room)}</button>`; }).join('') : '';
  // zoom window + bucketing at the visible span
  const span = hpdSpan(), win = hpdWindow(r, span);
  const vb = hpdBucket(r.raw || [], win.w0, win.w1, _HPDN);
  const rvb = hpdBucketRooms((r.rooms || []).filter(rm => hpdRoomOn(rm.room)), win.w0, win.w1, _HPDN);
  const sp = $('hpd-span');
  if (sp) sp.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.hsp === String(span)));
  const tips = hpdTips(vb, tg, rvb);
  let html = '';
  if (tg.p || tg.h) html += `<div style="touch-action:none">${hpdPower(vb, tips, tg)}</div>`;
  if (tg.mod || tg.cop) html += `<div style="touch-action:none;margin-top:3px">${hpdModCop(vb, tips, tg)}</div>`;
  if (tg.sup || tg.ret || tg.out) { const t = hpdTemp(vb, tips, tg); if (t) html += `<div style="touch-action:none;margin-top:3px">${t}</div>`; }
  const rp = hpdRooms(rvb, tips); if (rp) html += `<div style="touch-action:none;margin-top:3px">${rp}</div>`;
  html += `<div style="touch-action:none;margin-top:2px">${hpdRibbon(r, win.w0, win.w1)}</div>`;
  if (ch) ch.innerHTML = html;
  // ribbon legend: only the states that actually occurred + heater
  const seen = new Set((r.segments || []).map(s => s.state));
  if (rl) rl.innerHTML = Object.keys(HP_ST).filter(s => seen.has(s)).map(s =>
    `<div class="it"><span class="sw" style="background:${HP_ST[s].color}"></span>${HP_ST[s].label}</div>`).join('') +
    ((r.heater || []).length ? `<div class="it"><span class="sw" style="background:${HP_HEATER}"></span>Zuheizer</div>` : '');
  // chronological event log
  if (evs) {
    const when = ts => new Date(ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    evs.innerHTML = (r.events || []).length ? (r.events || []).map(e => {
      const col = e.kind === 'heater' ? HP_HEATER : (HP_ST[e.kind] || {}).color || '#888';
      return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px;padding:5px 0;border-bottom:1px solid var(--line)">` +
        `<span><span style="color:${col}">●</span> <b>${when(e.ts)}</b> ${esc(HPD_EV[e.kind] || e.kind)}</span>` +
        `<span style="color:var(--muted);white-space:nowrap">${_hpdHm(e.dur_s / 60)}</span></div>`;
    }).join('') : '<div class="note">Keine Zustandswechsel an diesem Tag.</div>';
  }
  if (note) note.innerHTML = `Ein <b>Takt</b> ist ein Verdichterstart; viele kurze Takte (häufige Pausen) deuten auf eine zu hohe Leistung / zu wenig Abnahme hin – nach gutem <b>hydraulischem Abgleich</b> läuft die WP meist <b>länger und ruhiger durch</b>. ` +
    `Mit <b>Auto / 1h … Tag</b> zoomst du die Zeitachse (Auto passt sich an die vorhandenen Daten an). Über die <b>Räume</b>-Chips blendest du einzelne Raumtemperaturen ein und siehst chronologisch, wie sie auf Heizbetrieb und Pausen reagieren. ` +
    `<span style="color:var(--muted)"><b>Abtauen</b> und <b>Zuheizer</b> sind aus dem Betrieb <b>erkannt</b> (Wärme bricht ein bzw. Leistung über dem Verdichter-Limit ~${r.comp_max_w ? fmt(r.comp_max_w / 1000, 1) + ' kW' : '–'}), nicht aus einem Gerätesignal – als Hinweis zu verstehen. Tipp/Overlay auf dem Diagramm zeigt die Werte zur Uhrzeit.</span>`;
}

// ===== Tagesvergleich (zwei Tage nebeneinander) ============================ #
let _hpcData = {};
function hpcGet() {
  try { const v = JSON.parse(localStorage.getItem('bhe_hpc') || 'null'); if (v && v.a && v.b) return v; } catch (e) {}
  const t = new Date(), b = new Date(t), a = new Date(t); b.setDate(b.getDate() - 1); a.setDate(a.getDate() - 7);
  return { a: _hpdDateStr(a), b: _hpdDateStr(b) };
}
async function renderHpCompare(force) {
  const card = $('hpc-card'); if (!card) return;
  const ia = $('hpc-a'), ib = $('hpc-b'), cfg = hpcGet(), today = _hpdDateStr(new Date());
  if (ia) { ia.max = today; if (!ia.value || force) ia.value = cfg.a; }
  if (ib) { ib.max = today; if (!ib.value || force) ib.value = cfg.b; }
  const a = ia ? ia.value : cfg.a, b = ib ? ib.value : cfg.b;
  if (!a || !b) return;
  try { localStorage.setItem('bhe_hpc', JSON.stringify({ a, b })); } catch (e) {}
  const getDay = async d => { if (_hpcData[d]) return _hpcData[d]; const r = await api('/api/heatpump/day?date=' + d); _hpcData[d] = r; return r; };
  const tbl = $('hpc-table');
  try { const [ra, rb] = await Promise.all([getDay(a), getDay(b)]); paintHpCompare(ra, rb); }
  catch (e) { if (tbl) tbl.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
}
function _hpcDate(r) { if (!r || !r.date) return '–'; const p = r.date.split('-'), WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']; return (WD[r.weekday] || '') + ', ' + p[2] + '.' + p[1] + '.'; }
function paintHpCompare(ra, rb) {
  const tbl = $('hpc-table'), rib = $('hpc-ribbons'), leg = $('hpc-legend'), note = $('hpc-note');
  const ka = (ra && ra.kpis) || {}, kb = (rb && rb.kpis) || {};
  const okA = ra && ra.ok && ra.n > 1, okB = rb && rb.ok && rb.n > 1;
  const metr = [
    ['Takte', 'starts', '×', -1], ['Min/Takt', 'min_per_start', ' min', 1],
    ['Laufzeit', 'runtime_min', ' min', 1], ['Pause', 'pause_min', ' min', 0],
    ['Abtauen', 'defrost_count', '×', 0], ['Ø Modulation', 'avg_mod', ' %', 0],
    ['Arbeitszahl', 'cop', '', 1], ['Strom', 'elec_kwh', ' kWh', 0],
    ['Wärme', 'heat_kwh', ' kWh', 0], ['Ø Außen', 'avg_outdoor', ' °C', 0],
  ];
  const num = (v, u) => v == null ? '–' : fmt(v, (Number.isInteger(v) ? 0 : (Math.abs(v) < 10 ? (u === '' || u === ' kWh' ? 2 : 1) : 0))) + (v == null ? '' : u);
  let html = `<div style="display:grid;grid-template-columns:1.25fr 1fr 1fr 0.9fr;gap:3px 6px;font-size:12.5px;align-items:center">` +
    `<div></div><div style="text-align:right;font-weight:600">A · ${esc(_hpcDate(ra))}</div>` +
    `<div style="text-align:right;font-weight:600">B · ${esc(_hpcDate(rb))}</div><div style="text-align:right;color:var(--muted)">Δ</div>`;
  metr.forEach(([lbl, key, unit, dir]) => {
    const va = ka[key], vb = kb[key];
    let dtxt = '', dcol = 'var(--muted)';
    if (typeof va === 'number' && typeof vb === 'number') {
      const dd = vb - va, s = dd > 0 ? '+' : '';
      dtxt = s + fmt(dd, (Number.isInteger(dd) ? 0 : (Math.abs(dd) < 10 ? 1 : 0))) + unit.trim();
      if (dir !== 0 && dd !== 0) dcol = ((dir < 0) ? dd < 0 : dd > 0) ? COL.pv : '#ff8a8a';
    }
    html += `<div>${esc(lbl)}</div><div style="text-align:right">${num(va, unit)}</div>` +
      `<div style="text-align:right">${num(vb, unit)}</div><div style="text-align:right;color:${dcol};font-weight:600">${dtxt}</div>`;
  });
  html += `</div>`;
  if (tbl) tbl.innerHTML = (okA || okB) ? html : '<div class="note">Für die gewählten Tage liegen keine Wärmepumpen-Daten vor.</div>';
  if (rib) { let rh = ''; [['A', ra], ['B', rb]].forEach(([l, r]) => { if (r && r.segments && r.segments.length) rh += `<div style="font-size:11px;color:var(--muted);margin:6px 0 2px">${l} · ${esc(_hpcDate(r))}</div><div style="touch-action:none">${hpdRibbon(r, r.start, r.start + 86400)}</div>`; }); rib.innerHTML = rh; }
  if (leg) { const seen = new Set(); [ra, rb].forEach(r => (r && r.segments || []).forEach(s => seen.add(s.state))); leg.innerHTML = Object.keys(HP_ST).filter(s => seen.has(s)).map(s => `<div class="it"><span class="sw" style="background:${HP_ST[s].color}"></span>${HP_ST[s].label}</div>`).join(''); }
  if (note) note.innerHTML = `Grün = Verbesserung von A → B (weniger <b>Takte</b>, mehr <b>Min/Takt</b> &amp; Laufzeit). ` +
    `<span style="color:var(--muted)">Fairer Vergleich: zwei Tage mit <b>ähnlicher Ø Außentemperatur</b> wählen – kältere Tage takten von allein weniger.</span>`;
}

// ===== Takt-Trend über Wochen (+ Abgleich-Marke, vorher/nachher) =========== #
let _hptDays = null, _hptData = {};
function hptDays() { if (_hptDays == null) { try { _hptDays = parseInt(localStorage.getItem('bhe_hpt_days'), 10) || 30; } catch (e) { _hptDays = 30; } } return _hptDays; }
function hptMark() { try { return localStorage.getItem('bhe_hp_abgleich') || ''; } catch (e) { return ''; } }
async function renderHpTrend() {
  const card = $('hpt-card'); if (!card) return;
  const mk = $('hpt-mark'); if (mk && !mk.value) mk.value = hptMark();
  const d = hptDays();
  if (_hptData[d]) { paintHpTrend(_hptData[d]); return; }
  const ch = $('hpt-chart'); if (ch && !_hptData[d]) ch.innerHTML = '<div class="note" style="padding:14px 0;text-align:center">Lade Trend …</div>';
  try { const r = await api('/api/heatpump/trend?days=' + d); _hptData[d] = r; paintHpTrend(r); }
  catch (e) { if (ch) ch.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
}
function hptChart(daily, mark) {
  const h = 200, pad = 30, top = 12, base = h - 24, n = daily.length;
  const bw = (CW - pad * 2) / Math.max(1, n), iw = Math.max(2, bw * 0.6);
  const Xc = i => pad + i * bw + bw / 2;
  const sc = niceScale(Math.max(4, ...daily.map(x => x.starts || 0))), yMax = sc.max;
  const Y = v => top + (1 - Math.max(0, Math.min(yMax, v)) / yMax) * (base - top);
  let g = gridLines(h, top, base, pad, yMax, { step: sc.step, unit: 'Takte' });
  daily.forEach((x, i) => { const y = Y(x.starts || 0), xx = pad + i * bw + (bw - iw) / 2; g += `<rect x="${xx.toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${Math.max(0, base - y).toFixed(1)}" rx="1.5" fill="${COL.hp}" opacity="0.8"/>`; });
  const mps = daily.map(x => x.min_per_start).filter(v => v != null);
  const mSc = niceScale(Math.max(60, ...mps, 1)), mMax = mSc.max;
  const Yr = v => top + (1 - Math.max(0, Math.min(mMax, v)) / mMax) * (base - top);
  let line = '', pen = false;
  daily.forEach((x, i) => { if (x.min_per_start == null) { pen = false; return; } line += (pen ? 'L' : 'M') + Xc(i).toFixed(1) + ' ' + Yr(x.min_per_start).toFixed(1) + ' '; pen = true; });
  g += `<path d="${line.trim()}" fill="none" stroke="${COL.pv}" stroke-width="2"/>`;
  for (let k = 0; k <= mMax + 1e-6; k += mSc.step) g += `<text class="axis" x="${CW - 2}" y="${(Yr(k) + 3).toFixed(1)}" text-anchor="end" fill="${COL.pv}">${fmt(k, 0)}</text>`;
  const stepL = Math.max(1, Math.ceil(n / 6));
  daily.forEach((x, i) => { if (i % stepL === 0 || i === n - 1) { const p = x.date.split('-'); g += `<text class="axis" x="${Xc(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${p[2]}.${p[1]}</text>`; } });
  if (mark) { const idx = daily.findIndex(x => x.date >= mark); if (idx >= 0) { const mx = pad + idx * bw; g += `<line x1="${mx.toFixed(1)}" x2="${mx.toFixed(1)}" y1="${top}" y2="${base}" stroke="#ffd166" stroke-width="1.5" stroke-dasharray="4 3"/><text class="axis" x="${(mx + 3).toFixed(1)}" y="${(top + 8).toFixed(1)}" fill="#ffd166">Abgleich</text>`; } }
  const tips = daily.map(x => { const p = x.date.split('-'); return `<b>${p[2]}.${p[1]}.</b> · ${x.starts} Takte · ${x.min_per_start != null ? x.min_per_start + ' min/Takt' : '–'} · Ø Mod ${x.avg_mod != null ? x.avg_mod + '%' : '–'} · COP ${x.cop != null ? fmt(x.cop, 2) : '–'} · außen ${x.avg_outdoor != null ? fmt(x.avg_outdoor, 1) + '°' : '–'}`; });
  return svg(h, g, { kind: 'bar', pad, n, h, tips });
}
function paintHpTrend(r) {
  const daily = (r && r.daily) || [], ch = $('hpt-chart'), ba = $('hpt-ba'), leg = $('hpt-legend'), note = $('hpt-note');
  if (!daily.length) { if (ch) ch.innerHTML = '<div class="note" style="padding:14px 0;text-align:center">Noch keine Tagesdaten – kommt nach ein paar Betriebstagen.</div>'; [ba, leg].forEach(e => { if (e) e.innerHTML = ''; }); if (note) note.innerHTML = ''; return; }
  const mark = hptMark();
  if (ch) ch.innerHTML = `<div style="touch-action:none">${hptChart(daily, mark)}</div>`;
  if (leg) leg.innerHTML = `<div class="it"><span class="sw" style="background:${COL.hp}"></span>Takte/Tag</div><div class="it"><span class="sw" style="background:${COL.pv}"></span>Min/Takt</div>` + (mark ? `<div class="it"><span class="sw" style="background:#ffd166"></span>Abgleich</div>` : '');
  if (ba) {
    if (mark) {
      const before = daily.filter(x => x.date < mark), after = daily.filter(x => x.date >= mark);
      const avg = (a, k) => { const v = a.map(x => x[k]).filter(x => x != null); return v.length ? v.reduce((s, y) => s + y, 0) / v.length : null; };
      const mkd = mark.split('-').reverse().join('.');
      const row = (lbl, k, unit, dir) => {
        const b = avg(before, k), a = avg(after, k); if (b == null || a == null) return '';
        const pct = b !== 0 ? Math.round((a - b) / Math.abs(b) * 100) : 0;
        const col = (a - b) === 0 ? 'var(--muted)' : ((dir < 0 ? a < b : a > b) ? COL.pv : '#ff8a8a');
        return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:5px 0;border-bottom:1px solid var(--line)"><span>${lbl}</span><span>Ø <b>${fmt(b, b < 10 ? 1 : 0)}</b> → <b>${fmt(a, a < 10 ? 1 : 0)}</b>${unit} <span style="color:${col};font-weight:600">(${pct > 0 ? '+' : ''}${pct}%)</span></span></div>`;
      };
      ba.innerHTML = (before.length && after.length)
        ? `<div style="border:1px solid var(--accent);border-radius:12px;padding:10px 12px;margin-bottom:12px;background:color-mix(in srgb,var(--accent) 7%,transparent)">` +
        `<div style="font-weight:600;font-size:13px;margin-bottom:4px">Vorher → nachher (ab ${mkd})</div>` +
        row('Takte/Tag', 'starts', '×', -1) + row('Min/Takt', 'min_per_start', ' min', 1) +
        row('Laufzeit/Tag', 'runtime_min', ' min', 1) + row('Ø Außentemp', 'avg_outdoor', ' °C', 0) + `</div>`
        : `<div class="note" style="margin-bottom:10px">Marke auf ${esc(mkd)} gesetzt – sobald Tage <b>vor</b> und <b>nach</b> diesem Datum vorliegen, erscheint hier der Vorher/Nachher-Schnitt.</div>`;
    } else ba.innerHTML = '';
  }
  if (note) note.innerHTML = `Die <b>Min/Takt</b>-Linie ist das beste Maß für ruhigen Lauf: höher = längere, seltenere Läufe. Setze oben dein <b>Abgleich-Datum</b>, dann rechne ich den Schnitt <b>vorher/nachher</b>. ` +
    `<span style="color:var(--muted)">Weil kältere Tage von allein weniger takten, steht die <b>Ø Außentemperatur</b> dabei – vergleiche am besten Phasen mit ähnlichem Wetter.</span>`;
}

/* ---- Wärmepumpe steuern (Experte): read + write HomeCom settings --------- */
let _hpControls = null;
function initHpControls() {
  const card = $('hpctl-card'); if (!card) return;
  const avail = STATE.demo || (STATE.health && (STATE.health.homecom_connected || STATE.health.mode === 'demo'));
  card.hidden = !avail;
  if (avail && _hpControls) renderHpControlList(_hpControls);   // repaint cached
}
async function fetchHpControls(force) {
  const card = $('hpctl-card'), body = $('hpctl-body'), note = $('hpctl-note');
  if (!card) return;
  if (note) note.textContent = '';
  if (force && body) body.innerHTML = '<div class="note">Lese steuerbare Werte von der Wärmepumpe …</div>';
  try {
    const r = await api('/api/homecom/controls');
    if (r && r.ok && (r.controls || []).length) {
      _hpControls = r.controls; _hpControls._demo = !!r.demo;
      card.hidden = false; renderHpControlList(_hpControls);
    } else if (body) {
      body.innerHTML = `<div class="note">${escIp((r && r.error) || 'Keine steuerbaren Werte gefunden. Ist die Wärmepumpe im Setup verbunden?')}</div>`;
    }
  } catch (e) {
    if (body) body.innerHTML = '<div class="note">Nur möglich, wenn die Seite von der Bridge geöffnet ist.</div>';
  }
}
// Human label + plain-language description + group for a HomeCom control path.
function hpCtlMeta(path) {
  const p = (path || '').toLowerCase();
  const seg = p.replace(/\/+$/, '').split('/').pop();
  const water = p.includes('dhwcircuits');
  const levels = p.includes('temperaturelevels');
  const M = (label, desc, group) => ({ label, desc, group });
  if (seg === 'name' || seg === 'namea' || seg === 'a') return { hide: true };
  if (levels) {
    if (water) {
      if (seg === 'high') return M('Warmwasser-Soll · Komfort', 'Zieltemperatur im „high"-Betrieb – höher = mehr Komfort, aber mehr Strom.', 'water');
      if (seg === 'eco') return M('Warmwasser-Soll · Eco', 'Zieltemperatur im Eco-Betrieb – guter Spar-Kompromiss.', 'water');
      if (seg === 'low') return M('Warmwasser-Soll · Sparen', 'Zieltemperatur im Sparbetrieb („low").', 'water');
      if (seg === 'off') return { hide: true };
    } else {
      if (seg.startsWith('comfort')) return M('Raumtemperatur · Komfort', 'Soll-Raumtemperatur im Komfortbetrieb. Höher hebt die ganze witterungsgeführte Heizkurve an (mehr Vorlauf) – DER Hebel, um die Kurve zu verschieben.', 'curve');
      if (seg === 'eco') return M('Raumtemperatur · Absenkung (Eco)', 'Soll-Raumtemperatur im Absenkbetrieb (z. B. nachts). Bei Wärmepumpe nur leicht absenken – tiefe Absenkung kostet beim Wiederaufheizen.', 'curve');
    }
  }
  if (seg === 'operationmode') return water
    ? M('Betriebsart Warmwasser', 'eco/low/high/ownprogram/off – wie warm & wann Warmwasser bereitet wird. eco spart, high = heißer.', 'water')
    : M('Betriebsart Heizung', 'auto = nach Zeitprogramm, manual = feste Wunschtemperatur, off = Heizung aus (Frostschutz bleibt aktiv).', 'heat');
  const MAP = {
    controltype: M('Regelungsart der Heizkurve', 'wdcoptimized = witterungsgeführt optimiert: der Vorlauf wird automatisch aus Außentemperatur + Raum-Soll berechnet. Das IST deine Heizkurve – es gibt keinen separaten „Niveau/Steilheit"-Regler; du verschiebst sie über die Raum-Solltemperatur.', 'curve'),
    maxflowtemp: M('Max. Vorlauftemperatur', 'Obergrenze, die die Heizkurve nie überschreitet. Bei Fußbodenheizung sinnvoll z. B. 35–40 °C statt 50 – schont den Estrich und spart.', 'curve'),
    temperatureroommanual: M('Raum-Soll (manuell)', 'Gewünschte Raumtemperatur im manuellen Betrieb – verschiebt die witterungsgeführte Kurve nach oben/unten.', 'curve'),
    manualroomsetpoint: M('Raum-Soll (manuell)', 'Gewünschte Raumtemperatur im manuellen Betrieb – verschiebt die Kurve nach oben/unten.', 'curve'),
    currentroomsetpoint: M('Aktueller Raum-Soll', 'Momentan aktive Soll-Raumtemperatur (nur Anzeige).', 'curve'),
    heatingtype: M('Heizflächentyp', 'floor = Fußbodenheizung (niedrige Vorlauftemperaturen möglich).', 'heat'),
    heatcoolmode: M('Heizen / Kühlen', 'Aktueller Betriebsmodus der Anlage.', 'heat'),
    currentsuwimode: M('Sommer / Winter', 'forced = Heizbetrieb erzwungen, off = Sommerpause, cooling = Kühlen.', 'heat'),
    suwithreshold: M('Sommer/Winter-Schwelle', 'Außentemperatur, ab der die Heizung in den Sommerbetrieb geht.', 'heat'),
    boostmode: M('Boost', 'Kurzzeitige Leistungserhöhung. Für Wärmepumpen-Effizienz eher aus lassen.', 'heat'),
    boostduration: M('Boost-Dauer', 'Wie lange ein Boost läuft (Stunden).', 'heat'),
    overallstatus: M('Status Heizung', 'Aktueller Betriebszustand (nur Anzeige).', 'heat'),
    activeswitchprogram: M('Aktives Zeitprogramm', 'Welches gespeicherte Heizprogramm gerade aktiv ist.', 'heat'),
    switchprogrammode: M('Zeitprogramm-Modus', 'Art der Zeitsteuerung (z. B. nach Temperaturstufe).', 'heat'),
    singlechargesetpoint: M('Warmwasser Einmalladung – Soll', 'Zieltemperatur für eine manuelle Einmalladung (z. B. vor dem Duschen).', 'water'),
    charge: M('Warmwasser Einmalladung', 'start = jetzt einmalig auf die Einmalladungs-Temperatur aufheizen, stop = abbrechen.', 'water'),
    chargeduration: M('Einmalladungs-Dauer', 'Maximale Dauer der Einmalladung (Minuten).', 'water'),
    chargeremainingtime: M('Einmalladung – Restzeit', 'Verbleibende Zeit der laufenden Einmalladung (Anzeige).', 'water'),
    reducetemponalarm: M('Temp. senken bei Alarm', 'Sicherheitsfunktion – im Alarmfall Zieltemperatur senken.', 'water'),
    actualtemp: M('Warmwasser – Ist-Temperatur', 'Aktuelle Speichertemperatur (nur Anzeige).', 'water'),
    currentsetpoint: M('Warmwasser – aktueller Soll', 'Momentane Zieltemperatur (nur Anzeige).', 'water'),
    currenttemperaturelevel: M('Warmwasser – aktive Stufe', 'Welche WW-Stufe gerade aktiv ist (Anzeige).', 'water'),
    tdmode: M('Thermische Desinfektion', 'Legionellenschutz-Aufheizung (Anzeige).', 'water'),
  };
  if (MAP[seg]) return MAP[seg];
  return M(seg, '', water ? 'water' : 'heat');
}
const HP_CTL_GROUPS = [['curve', '🌡️ Heizkurve & Vorlauf'], ['heat', '⚙️ Heizung – Betrieb'],
  ['water', '🚿 Warmwasser'], ['other', '⋯ Weitere']];
function renderHpControlList(list) {
  const body = $('hpctl-body'); if (!body) return;
  const unit = u => !u ? '' : (u === 'C' ? ' °C' : u === 'K' ? ' K' : ' ' + esc(u));
  const items = list.map((c, i) => ({ c, i, m: hpCtlMeta(c.path) })).filter(x => !x.m.hide);
  const hasCurve = items.some(x => x.m.group === 'curve');
  const rowHtml = ({ c, i, m }) => {
    const cur = `<b>${esc(String(c.value))}${unit(c.unit)}</b>`;
    let control;
    if (c.writeable) {
      if (c.allowed && c.allowed.length) {
        control = `<select data-ctl="${i}" style="width:auto;padding:6px 8px;margin:0">` +
          c.allowed.map(a => `<option${String(a) === String(c.value) ? ' selected' : ''}>${esc(String(a))}</option>`).join('') + `</select>`;
      } else {
        const mn = c.min != null ? ` min="${c.min}"` : '', mx = c.max != null ? ` max="${c.max}"` : '';
        control = `<input type="number" data-ctl="${i}" value="${esc(String(c.value))}" step="0.5"${mn}${mx} style="width:88px;padding:6px 8px;margin:0">`;
      }
      control += ` <button class="btn" data-write="${i}" style="width:auto;padding:6px 14px;margin-left:6px">Setzen</button>`;
    } else {
      control = `<span style="color:var(--muted);font-size:12px">nur Ablesen</span>`;
    }
    const range = (c.allowed && c.allowed.length) ? esc(c.allowed.join(' / '))
      : (c.min != null || c.max != null) ? `${c.min != null ? c.min : '–'} … ${c.max != null ? c.max : '–'}${unit(c.unit)}` : '';
    return `<div class="devrow" style="align-items:flex-start"><div class="nm" style="flex:1 1 60%"><b>${esc(m.label)}</b>` +
      `<small>jetzt ${cur}${range ? ' · erlaubt ' + range : ''}</small>` +
      (m.desc ? `<small style="color:var(--muted);display:block;margin-top:2px;white-space:normal">${m.desc}</small>` : '') +
      `</div><div class="val" style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">${control}</div></div>`;
  };
  let html = list._demo ? '<div class="note" style="margin-bottom:8px"><b>Demo</b> – schreibt keine echte Anlage.</div>' : '';
  if (hasCurve) html += `<div class="note" style="margin-bottom:10px;border-left:3px solid var(--accent);padding-left:10px">` +
    `<b>Deine Heizkurve ist witterungsgeführt</b> (automatisch). Es gibt <b>keinen</b> „Niveau/Steilheit"-Regler – du verschiebst die Kurve über die ` +
    `<b>Raumtemperatur (Komfort/Eco)</b> und begrenzt sie mit der <b>max. Vorlauftemperatur</b>. Niedriger = effizienter, solange alle Räume warm werden.</div>`;
  for (const [g, title] of HP_CTL_GROUPS) {
    const gi = items.filter(x => x.m.group === g);
    if (!gi.length) continue;
    gi.sort((a, b) => (b.c.writeable ? 1 : 0) - (a.c.writeable ? 1 : 0));
    html += `<div style="font-weight:700;margin:14px 0 6px;color:var(--ink)">${title}</div>` + gi.map(rowHtml).join('');
  }
  body.innerHTML = html;
}
async function doHpWrite(i) {
  const c = (_hpControls || [])[i]; if (!c) return;
  const el = document.querySelector(`[data-ctl="${i}"]`); if (!el) return;
  let value = el.value;
  const note = $('hpctl-note');
  const lbl = hpCtlMeta(c.path).label || c.path.split('/').pop();
  if (!window.confirm(`„${lbl}" wirklich auf ${value}${c.unit === 'C' ? ' °C' : c.unit === 'K' ? ' K' : ''} setzen?\n\n(vorher ${c.value}) – wirkt direkt auf die Wärmepumpe.`)) return;
  if (note) note.textContent = `Setze „${lbl}" …`;
  try {
    const r = await postJSON('/api/homecom/write', { path: c.path, value, confirm: true });
    if (r && r.ok) {
      if (note) note.innerHTML = '✅ ' + escIp(r.message || 'Gesetzt.');
      c.value = r.value;                       // reflect new value locally
      renderHpControlList(_hpControls);
    } else if (note) {
      note.innerHTML = '⚠︎ ' + escIp((r && r.error) || 'Fehlgeschlagen.') + ((r && r.detail) ? `<br><small>${escIp(r.detail)}</small>` : '');
    }
  } catch (e) { if (note) note.textContent = 'Fehler: ' + e.message; }
}

function ymdLocal(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
// The last days of the inverter's smart meter (for the "not measured" balance);
// loaded lazily, refreshed every 10 min. Separate from the PV tab's own range.
let _pvDarkBusy = false;
async function loadPvDark() {
  const h = STATE.health;
  if (_pvDarkBusy || !h || !h.fronius_connected) return;
  if (STATE.pvDark && Date.now() - (STATE.pvDarkAt || 0) < 10 * 60000) return;
  _pvDarkBusy = true;
  try { const r = await api('/api/pv?days=8'); if (r && r.ok) { STATE.pvDark = r; STATE.pvDarkAt = Date.now(); } }
  catch (e) { /* keep the last */ } finally { _pvDarkBusy = false; }
  paintViews(['renderDarkLoad', 'renderOverview']);
}
// Whole days the smart meter recorded completely (bridge + inverter ran all
// day): house consumption − heat pump − individually measured devices = what
// no plug/module measures. null until there is such a day.
function smartMeterDays() {
  const P = STATE.pvDark, data = STATE.data, A = STATE.hpA;
  if (!P || !P.daily || !data || !A) return null;
  const today = ymdLocal(new Date());
  const hpBy = {}; (A.daily || []).forEach(d => { hpBy[d.day] = d.elec_kwh; });
  const pdd = data.per_device_day || {};
  const days = P.daily.filter(d => d.day < today && d.load_kwh != null && d.cov_h >= 22.5 &&
    (d.gap_h || 0) <= 0.5 && hpBy[d.day] != null).slice(-7);
  if (!days.length) return null;
  const dev = day => Object.keys(pdd).reduce((a, id) => a + ((pdd[id] || {})[day] || 0), 0);
  const per = days.map(d => ({ day: d.day, house: Math.max(0, d.load_kwh - hpBy[d.day]), hp: hpBy[d.day], dev: dev(d.day) }));
  const avg = k => per.reduce((a, x) => a + x[k], 0) / per.length;
  const house = avg('house'), devices = avg('dev');
  return { n: per.length, days: per.map(x => x.day), house, hp: avg('hp'), devices,
           dark: per.reduce((a, x) => a + Math.max(0, x.house - x.dev), 0) / per.length };
}
// Today's whole-house consumption when the smart meter recorded the WHOLE day
// so far (else null – e.g. on the day the inverter was connected).
function meterToday() {
  const F = STATE.fr, T = F && F.connected && F.today && F.today.today;
  if (!T || T.load_kwh == null) return null;
  const mid = new Date(); mid.setHours(0, 0, 0, 0);
  const sinceMid = (Date.now() - mid.getTime()) / 3600000;
  return (T.cov_h >= sinceMid - 0.25 && (T.gap_h || 0) <= 0.5) ? T.load_kwh : null;
}
let _mtShown = null;          // the smart-meter day total the overview last showed
// "Gerade jetzt": the smart meter's whole-house load when the inverter reports
// it (exact) – else the sum of the individually measured devices + heat pump.
function paintNowLine() {
  const ov = STATE.ov, el = $('ov-now'); if (!el) return;
  const M = frLiveNow();
  if (M && M.load_w != null) {
    el.innerHTML = fmt(Math.max(0, M.load_w), 0) + ' W' +
      `<small style="display:block;font-size:10.5px;font-weight:500;color:var(--muted)">${STATE.fr.demo ? 'Demo-Anlage' : 'Smart Meter'}</small>`;
  } else if (ov) {
    el.innerHTML = fmt(ov.now.total_w, 0) + ' W' +
      (STATE.fr && STATE.fr.connected ? '<small style="display:block;font-size:10.5px;font-weight:500;color:var(--muted)">einzeln gemessen</small>' : '');
  }
  const hp = $('ov-now-hp'), hpW = ov && ov.now.heatpump_w != null ? ov.now.heatpump_w : hpLiveW();
  if (hp) hp.textContent = hpW != null ? fmt(hpW, 0) + ' W' : '–';
}

// "Noch nicht gemessen": whole-house household load minus heat pump vs. what
// the Bosch modules + smart plugs actually measure. The gap is the not-yet-
// individually-metered ("dark") load – shrinks as plugs are added. Basis: the
// inverter's smart meter (live + complete days) when connected, else the
// user's meter readings / yearly figure.
function renderDarkLoad() {
  const card = $('ov-dark-card'); if (!card) return;
  const data = STATE.data;
  loadPvDark();
  const M = frLiveNow(), ov = STATE.ov;
  const liveOk = !!(M && M.load_w != null && ov && ov.now);
  const smd = smartMeterDays();
  // need a whole-house household reference beyond the modules themselves
  const md = meterHouseholdDaily();
  const houseDaily = smd ? smd.house : (md != null && md > 0) ? md : (houseManual() > 0 ? houseManual() / 365 : null);
  if (!data || (houseDaily == null && !liveOk)) { card.hidden = true; return; }
  card.hidden = false;
  const price = STATE.price;
  const GREY0 = '#8b93a7';
  // right now: house (smart meter) = heat pump + individually measured + the rest
  const live = $('ov-dark-live');
  if (live) {
    if (liveOk) {
      const houseW = Math.max(0, M.load_w), hpW = Math.max(0, (ov.now.heatpump_w != null ? ov.now.heatpump_w : hpLiveW()) || 0);
      const devW = Math.max(0, ov.now.smarthome_w != null ? ov.now.smarthome_w : (ov.now.total_w - hpW));
      const darkW = Math.max(0, houseW - hpW - devW), over = hpW + devW > houseW + 50;
      const tot = Math.max(houseW, hpW + devW) || 1;
      const seg = (w, col, t) => w > 0 ? `<div title="${t}" style="width:${(w / tot * 100).toFixed(1)}%;background:${col}"></div>` : '';
      live.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">` +
        `<b>Jetzt</b><span style="color:var(--muted);font-size:12px">Haus <b style="color:var(--ink)">${fmt(houseW, 0)} W</b> · ${STATE.fr.demo ? 'Demo-Anlage' : 'Smart Meter'}</span></div>` +
        `<div style="display:flex;height:22px;border-radius:6px;overflow:hidden;background:var(--card-bd,#2a2f3a)">` +
        seg(hpW, COL.hp, 'Wärmepumpe') + seg(devW, COL.sh, 'einzeln gemessen') + seg(darkW, GREY0, 'nicht einzeln gemessen') + `</div>` +
        `<div class="legend" style="margin-top:6px">` +
        `<div class="it"><span class="sw" style="background:${COL.hp}"></span>Wärmepumpe ${fmt(hpW, 0)} W</div>` +
        `<div class="it"><span class="sw" style="background:${COL.sh}"></span>einzeln gemessen ${fmt(devW, 0)} W</div>` +
        `<div class="it"><span class="sw" style="background:${GREY0}"></span><b>nicht einzeln gemessen ${fmt(darkW, 0)} W</b></div></div>` +
        (over ? `<div class="note" style="margin-top:4px">Die Einzelwerte liegen gerade über dem Hauswert – sie werden zu leicht anderen Zeitpunkten gemessen (Wärmepumpe als 5-Minuten-Mittel).</div>` : '') +
        `<div style="height:12px"></div>`;
    } else live.innerHTML = '';
  }
  if (houseDaily == null) {                 // only the live view so far
    ['ov-dark-bar', 'ov-dark-kpi', 'ov-dark-list'].forEach(id => { const e = $(id); if (e) e.innerHTML = ''; });
    $('ov-dark-sum').textContent = '';
    $('ov-dark-note').innerHTML = 'Die Tagesbilanz erscheint nach dem ersten vollständig gemessenen Tag des Smart Meters.';
    return;
  }
  // "Individually measured" = the SUM of the per-device daily averages (Bosch
  // modules + smart plugs), NOT the household counter estimate. The counter
  // estimate is ~the whole household, which would make the ungemessene Rest look
  // near zero even with hardly any plugs. The plug sum is what actually shrinks
  // as you add Smart Plugs – which is the whole point of this card.
  const pdd = data.per_device_day || {};
  const names = {}; ((data.live && data.live.devices) || []).forEach(d => names[d.id] = devLabel(d).title);
  const rows = [];
  Object.keys(pdd).forEach(id => {
    // with the smart meter: the same complete days as the house figure
    const ds = smd ? smd.days : Object.keys(pdd[id]); if (!ds.length) return;
    let s = 0; ds.forEach(d => s += (pdd[id][d] || 0)); const avg = s / ds.length;
    if (avg > 0.01) rows.push({ label: names[id] || id, kwh: avg });
  });
  rows.sort((a, b) => b.kwh - a.kwh);
  const measuredSum = rows.reduce((a, r) => a + r.kwh, 0);
  const measured = Math.min(measuredSum, houseDaily);   // individually metered (capped)
  const dark = smd ? smd.dark : Math.max(0, houseDaily - measured);
  const darkPct = houseDaily > 0 ? dark / houseDaily * 100 : 0;
  const src = smd ? `${STATE.fr && STATE.fr.demo ? 'Demo-Anlage' : 'Smart Meter'}, ${smd.n} ${smd.n === 1 ? 'Tag' : 'Tage'} gemessen`
    : (md != null && md > 0) ? 'Zählerablesung' : 'eingetragener Jahreswert';

  $('ov-dark-sum').textContent = `${fmt(darkPct, 0)} % offen`;

  // proportion bar: measured (blue) vs dark (grey)
  const GREY = '#8b93a7';
  const wMeas = houseDaily > 0 ? measured / houseDaily * 100 : 0;
  $('ov-dark-bar').innerHTML = (liveOk ? `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">` +
      `<b>Pro Tag</b><span style="color:var(--muted);font-size:12px">${src}</span></div>` : '') +
    `<div style="display:flex;height:22px;border-radius:6px;overflow:hidden;background:var(--card-bd,#2a2f3a)">` +
    `<div title="gemessen" style="width:${wMeas.toFixed(1)}%;background:${COL.sh}"></div>` +
    `<div title="nicht gemessen" style="width:${(100 - wMeas).toFixed(1)}%;background:${GREY}"></div></div>` +
    `<div class="legend" style="margin-top:6px">` +
    `<div class="it"><span class="sw" style="background:${COL.sh}"></span>gemessen ${kwh(measured, 1)}/Tag</div>` +
    `<div class="it"><span class="sw" style="background:${GREY}"></span>nicht gemessen ${kwh(dark, 1)}/Tag</div></div>`;

  $('ov-dark-kpi').innerHTML =
    `<div class="kpi sm"><div class="v">${kwh(dark * 365, 0)}</div><div class="l">nicht gemessen / Jahr · ${money(dark * 365 * price)}</div></div>` +
    `<div class="kpi sm"><div class="v">${kwh(houseDaily * 365, 0)}</div><div class="l">Haushalt gesamt / Jahr (${src})</div></div>`;

  // biggest measured devices, so the scale is tangible – plus the dark remainder
  const scaleMax = Math.max(dark, rows.length ? rows[0].kwh : 0) || 1;
  let html = rows.slice(0, 6).map(r =>
    devRow(r.label, 'gemessen', kwh(r.kwh, 2) + '/Tag', '', r.kwh / scaleMax * 100, COL.sh)).join('');
  if (dark > 0.05) html += devRow('Noch nicht gemessen', smd ? 'gemessen (Smart Meter − Wärmepumpe − Geräte)' : 'geschätzt (Zähler − Module)',
    kwh(dark, 2) + '/Tag', money(dark * 365 * price) + '/Jahr', dark / scaleMax * 100, GREY);
  $('ov-dark-list').innerHTML = html || '<div class="note">Noch keine Einzelgeräte gemessen.</div>';

  // guidance: is it worth more plugs? plus a tangible appliance-equivalent
  const darkYear = dark * 365;
  const equiv = Math.round(darkYear / 250); // ~250 kWh ≈ a typical bigger appliance/year
  let advice;
  if (dark >= 5) advice = `<b>Da läuft noch viel im Verborgenen.</b> Weitere <b>Bosch Smart Plug+</b> an großen ` +
    `Verbrauchern (Kühl-/Gefrierkombi, Herd/Backofen, Trockner, Server/Netzwerk) lohnen sich klar – ` +
    `das entspricht grob <b>${equiv}</b> typischen Großgeräten à ~250 kWh/Jahr.`;
  else if (dark >= 2) advice = `<b>Moderater ungemessener Rest.</b> 2–3 gezielte <b>Smart Plugs</b> an den größten ` +
    `Verbrauchern (Küche, Waschküche, Unterhaltung) würden das meiste davon sichtbar machen ` +
    `(~${equiv} Großgeräte-Äquivalente).`;
  else advice = `<b>Schon gut abgedeckt</b> – der ungemessene Rest ist klein (Kühlschrank, Router, Ladegeräte, ` +
    `Standby). Weitere Steckdosen bringen hier wenig Neues.`;
  $('ov-dark-note').innerHTML = `Basis: Haushalt <b>${kwh(houseDaily, 1)}/Tag</b> (${src}, ohne Wärmepumpe) ` +
    `minus gemessene <b>${kwh(measured, 1)}/Tag</b>. ` + advice +
    (!smd && liveOk ? ' <br><small style="color:var(--muted)">Die Tagesbilanz rechnet noch mit deinen Zählerablesungen (geschätzt); ' +
      'ab dem ersten vollständig gemessenen Tag nimmt sie automatisch den Smart Meter.</small>' : '');
}

function renderOverview() {
  const ov = STATE.ov; if (!ov) return;
  // whole-house figure from the smart meter once it covers the whole day so far;
  // the rest beyond the individually measured devices + heat pump becomes its own slice
  const mT = meterToday();
  _mtShown = mT;
  const restT = mT != null ? Math.max(0, mT - ov.today.total_kwh) : 0;
  const totalT = mT != null && mT >= ov.today.total_kwh ? mT : ov.today.total_kwh;
  $('ov-today').innerHTML = fmt(totalT, 1) + '<span> kWh</span>';
  $('ov-today-cost').textContent = eur(ov.today.total_kwh > 0 ? ov.today.cost * totalT / ov.today.total_kwh : totalT * STATE.price) +
    (mT != null ? ' · Smart Meter' : '') + ' · Stand ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  paintNowLine();
  const fc = annualForecast();
  $('ov-month').innerHTML = kwh(fc.monthNow, 0);
  $('ov-month-cost').textContent = money(fc.monthNowCost);

  const segs = ov.breakdown.filter(b => b.kwh > 0).map(b => ({ label: b.label, value: b.kwh, color: b.color }));
  if (restT > 0.05) { segs.push({ label: 'Nicht einzeln gemessen', value: restT, color: '#8b93a7' }); segs.sort((a, b) => b.value - a.value); }
  $('ov-break-sum').textContent = kwh(totalT, 1);
  $('ov-donut').innerHTML = segs.length
    ? donutChart(segs, { big: fmt(totalT, 1), center: 'kWh heute' })
    : '<div class="note">Noch keine Verbrauchsdaten für heute.</div>';
  $('ov-legend').innerHTML = legendHtml(segs.slice(0, 8).map(s => ({ label: s.label, color: s.color, sub: kwh(s.value, 2) })));
  const gapB = ov.breakdown.find(b => b.key === 'hp_gap' && b.kwh > 0.01), bn = $('ov-break-note');
  if (bn) {
    bn.hidden = !gapB;
    if (gapB) bn.innerHTML = `<b>Betriebsart unbekannt</b>: ${kwh(gapB.kwh, 2)} hat die Wärmepumpe verbraucht, während ` +
      'die Bridge sie nicht erreicht hat. Die Menge kommt aus dem Zähler und stimmt; ob Heizung oder Warmwasser, ' +
      'war in der Zeit nicht zu sehen – deshalb wird sie keiner Betriebsart zugeschlagen.';
  }

  const now = new Date();
  const w = filledDaily(new Date(now.getTime() - 13 * 86400000), now);
  $('ov-daily').innerHTML = stackedBar(
    w.map(d => ({ label: shortDay(d.day), estimated: d.estimated, values: { sh: d.sh, hp: d.hp } })),
    [{ key: 'sh', color: COL.sh }, { key: 'hp', color: COL.hp }], { h: 200, unit: 'kWh' });
  const estN = w.filter(d => d.estimated).length;
  const dn = $('ov-daily-note');
  if (dn) {
    dn.hidden = estN === 0;
    if (estN) dn.innerHTML = `Blasse Balken (${estN} Tage) sind geschätzt – die Bridge hatte an diesen Tagen noch keine Messung. Details unter <b>Verlauf</b>.`;
  }

  const card = $('ov-hp-card');
  if (ov.heatpump_connected) {
    card.hidden = false;
    $('ov-hp-cop').innerHTML = ov.heatpump.seasonal_cop
      ? glossV('JAZ', 'jaz') + ' ' + fmt(ov.heatpump.seasonal_cop, 2) + ' ' + rateBadge('jaz', ov.heatpump.seasonal_cop, 'JAZ (Jahresarbeitszahl)') : '';
    const l = ov.heatpump.live || {};
    const rows = [
      statusRow('Strom heute', kwh(ov.today.heatpump_kwh, 2)),
      l.power_w != null ? statusRow('Leistung jetzt', fmt(l.power_w, 0) + ' W') : '',
      l.cop_live ? statusRow('Wirkungsgrad jetzt', fmt(l.cop_live, 2)) : '',
      l.outdoor_c != null ? statusRow('Außentemperatur', fmt(l.outdoor_c, 1) + ' °C') : '',
    ].join('');
    $('ov-hp-body').innerHTML = rows;
  } else { card.hidden = true; }

  renderBudget();
  renderSavings();
  renderTips();
}

// The renovation measure with the biggest heating-electricity saving.
function renoBest(b, r) {
  let best = null;
  b.comps.forEach(c => {
    const R = RENO[c.k]; if (!R || c.u <= R.u) return;
    const kwh = (c.u - R.u) * c.a * c.f * r.factor * (1 - b.gain) / (b.cop_heat || 2.6);
    if (kwh > 0 && (!best || kwh > best.kwh)) best = { label: R.l, kwh };
  });
  return best;
}

// A ranked, actionable list of the biggest saving levers (€/year), synthesised
// from what the app already computes. Rough estimates – labelled as such.
// Measured standby total from the per-device floor (same basis as the Standby
// card): what every device draws even at rest, projected to a year. The
// "achievable" saving credits clearly switch-off-able devices fully and the
// rest only partially – an always-on router can't be switched to zero.
function standbySavings() {
  const devs = (STATE.data && STATE.data.live && STATE.data.live.devices) || [];
  const price = STATE.price;
  let totW = 0, killW = 0;
  devs.forEach(d => {
    const sb = d.standby_w || 0;
    if (sb < 0.8) return;
    totW += sb;
    const lab = (typeof devLabel === 'function') ? devLabel(d) : { title: d.name || '' };
    if (/abschaltbar/.test(guessDeviceType((lab.title || '') + ' ' + (d.name || '') + ' ' + (d.room || '')))) killW += sb;
  });
  if (totW < 0.5) return null;
  const totCost = totW / 1000 * 8760 * price;
  const killCost = killW / 1000 * 8760 * price;
  return { totW, killW, totCost, killCost, saveCost: killCost + 0.4 * (totCost - killCost) };
}

function renderSavings() {
  const card = $('ov-savings-card'); if (!card) return;
  const price = STATE.price, L = [];
  // 1) standby / always-on base load. Prefer the MEASURED per-device standby
  // (precise, same basis as the Standby card); fall back to the base-load
  // heuristic from the hourly profile when no device-level standby is known.
  const sb = standbySavings();
  if (sb && sb.saveCost > 5) {
    L.push({ label: 'Standby abschalten (je Gerät gemessen)', hint: `Profil → Standby · ${fmt(sb.totW, 0)} W Dauer`, eur: sb.saveCost, color: COL.sh });
  } else {
    const prof = (STATE.data && STATE.data.hourly_profile) || [];
    const vals = prof.map(h => h.avg_w).filter(v => v != null);
    if (vals.length >= 24) {
      const baseW = mean(vals.slice().sort((a, b) => a - b).slice(0, 3));
      const eur = baseW * 0.3 / 1000 * 8760 * price;      // trimming ~30 % of the base load
      if (eur > 8) L.push({ label: 'Dauerverbraucher/Standby senken', hint: 'Profil → Grundlast', eur, color: COL.sh });
    }
  }
  // 2) electric booster heater (Heizstab) on the heat pump
  const hl = (STATE.hpA && STATE.hpA.live) || {};
  if (hl.energy_kwh > 0 && hl.eheater_kwh > 0) {
    const share = hl.eheater_kwh / hl.energy_kwh;
    if (share > 0.06) {
      const hpYear = hpYearFromMonthly() || hpAvgDaily() * 365;
      const eur = hpYear * share * 0.6 * price;          // shifting most heat to the compressor (COP≈2.5)
      if (eur > 10) L.push({ label: 'Elektro-Zuheizer zurückdrängen (Heizkurve/WW-Temp)', hint: 'Wärmepumpe', eur, color: COL.hp });
    }
  }
  // 3) PV self-consumption + feed-in (if a plan is entered)
  if ((parseFloat($('pv-kwp') && $('pv-kwp').value) || 0) > 0) {
    try { const r = simulatePv(pvInputs()); if (r.benefit > 20) L.push({ label: 'PV-Anlage (Eigenverbrauch + Einspeisung)', hint: 'PV-Tab', eur: r.benefit, color: COL.heat }); } catch (e) {}
  }
  // 4) shifting flexible loads into cheap hours (dynamic / Tibber tariff)
  const sp = STATE.spot;
  if (sp && sp.prices && sp.prices.length >= 12) {
    const cons = sp.prices.map(p => p.consumer_ct), avg = mean(cons);
    const cheap = cons.slice().sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(cons.length / 3)));
    const spread = Math.max(0, (avg - mean(cheap)) / 100);         // €/kWh saved by shifting
    let wwYear = 600;
    const mw = STATE.hpA && STATE.hpA.mode_window, nD = (STATE.hpA && STATE.hpA.daily || []).length;
    if (mw && mw.water > 0 && nD > 0) wwYear = mwWater(mw) / nD * 365;
    const flex = wwYear + 1.5 * 365;                                // warm water + ~1.5 kWh/day flexible household
    const eur = flex * spread;
    if (eur > 10) L.push({ label: 'Flexible Lasten in günstige Stunden', hint: 'Börse / Smart-Timer', eur, color: '#4be0b0' });
  }
  // 5) biggest building renovation lever
  try {
    const b = buildData(), r = computeHeat(b), best = renoBest(b, r);
    if (best && best.kwh * price > 20) L.push({ label: best.label, hint: 'Wärmepumpe → Theorie', eur: best.kwh * price, color: '#b07a4d' });
  } catch (e) {}

  L.sort((a, b) => b.eur - a.eur);
  if (!L.length) { card.hidden = true; return; }
  card.hidden = false;
  const max = L[0].eur || 1;
  $('ov-savings-body').innerHTML = L.slice(0, 6).map(x =>
    devRow(x.label, x.hint || '', money(x.eur) + '/Jahr', '', Math.max(6, x.eur / max * 100), x.color)).join('');
  const tot = L.reduce((a, x) => a + x.eur, 0);
  $('ov-savings-note').innerHTML =
    `Zusammen bis zu <b>${money(tot)}/Jahr</b> Einsparpotenzial (grobe Schätzung – die Maßnahmen unterscheiden ` +
    `sich in Aufwand und Kosten). Details und Umsetzung in den jeweiligen Tabs.`;
}

// Actual kWh consumed since the 1st of the current month (measured days full,
// missing days seasonally estimated by filledDaily).
function monthToDateKwh() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return filledDaily(start, now).reduce((a, d) => a + (d.sh || 0) + (d.hp || 0), 0);
}

function renderBudget() {
  const card = $('ov-budget-card'); if (!card) return;
  const unit = ($('ov-budget-unit') && $('ov-budget-unit').value) || 'eur';
  const budget = parseFloat($('ov-budget') && $('ov-budget').value);
  const fc = annualForecast(), price = STATE.price;
  const now = new Date(), dom = now.getDate(), dim = DIM[now.getMonth()], left = Math.max(0, dim - dom);
  const mtdKwh = monthToDateKwh();
  const toVal = k => unit === 'kwh' ? k : k * price;
  const fmtV = v => unit === 'kwh' ? kwh(v, 0) : money(v);
  const budgetKwh = unit === 'kwh' ? budget : (price > 0 ? budget / price : 0);
  const mtdVal = toVal(mtdKwh), projVal = toVal(fc.monthNow), budgetV = budget;
  if (!(budget > 0)) {
    $('ov-budget-bar').innerHTML = '';
    $('ov-budget-note').innerHTML =
      `Trag ein Budget ein – dann zeige ich Stand & Hochrechnung. Aktuell läuft der Monat auf ` +
      `<b>${kwh(fc.monthNow, 0)}</b> · <b>${money(fc.monthNowCost)}</b> hinaus.`;
    return;
  }
  const spentPct = Math.min(100, mtdVal / budgetV * 100);
  const projPct = Math.min(100, projVal / budgetV * 100);
  const over = projVal > budgetV, col = over ? '#ef6c4d' : '#4be0b0';
  $('ov-budget-bar').innerHTML =
    `<div class="bar" style="height:14px;position:relative;overflow:visible">` +
    `<i style="width:${spentPct.toFixed(0)}%;background:${col}"></i>` +
    `<span title="Hochrechnung" style="position:absolute;top:-4px;left:${projPct.toFixed(0)}%;width:2px;height:22px;background:#fff;transform:translateX(-1px)"></span>` +
    `</div>` +
    `<div class="legend" style="margin-top:8px">` +
    `<div class="it"><span class="sw" style="background:${col}"></span>bisher ${fmtV(mtdVal)}</div>` +
    `<div class="it"><span class="sw" style="background:#fff"></span>Hochrechnung ${fmtV(projVal)}</div>` +
    `<div class="it">Budget ${fmtV(budgetV)}</div></div>`;
  const diff = Math.abs(projVal - budgetV);
  const remainKwh = Math.max(0, budgetKwh - mtdKwh), perDay = left > 0 ? remainKwh / left : 0;
  $('ov-budget-note').innerHTML = over
    ? `⚠️ Hochrechnung <b style="color:#ef6c4d">${fmtV(diff)} über</b> Budget (Tag ${dom}/${dim}). ` +
      (remainKwh > 0 && left > 0
        ? `Um es zu halten: höchstens <b>${kwh(perDay, 1)}/Tag</b> (${money(perDay * price)}) an den letzten ${left} Tagen.`
        : `Budget für diesen Monat bereits ausgeschöpft.`)
    : `✅ Hochrechnung <b style="color:#4be0b0">${fmtV(diff)} unter</b> Budget – bisher ${fmtV(mtdVal)} an Tag ${dom}/${dim}.`;
}

// Data-driven, actionable tips – only the relevant ones are shown.
function renderTips() {
  const box = $('ov-tips'), card = $('ov-tips-card');
  if (!box) return;
  const tips = [];
  const A = STATE.hpA, data = STATE.data, fc = annualForecast(), price = STATE.price;
  const l = (A && A.live) || {};
  // 0) whole-house meter calibration: reveal the not-yet-measured household load
  const ms = meterStats();
  if (ms && ms.dailyAvg != null) {
    const hpDaily = meterHpDaily(ms);
    const household = Math.max(0, ms.dailyAvg - hpDaily);
    const unmetered = Math.max(0, household - shMeteredDaily());
    tips.push(['🔢', `Dein <b>Gesamtzähler</b>: real <b>${kwh(ms.dailyAvg, 1)}/Tag</b> ` +
      `(${money(ms.dailyAvg * price)}/Tag). Davon Wärmepumpe ~${kwh(hpDaily, 1)}, Haushalt ~${kwh(household, 1)}. ` +
      (unmetered > 0.3 ? `Rund <b>${kwh(unmetered, 1)}/Tag</b> Hausstrom messen die Module noch <b>nicht</b> ` +
        `(Kühlschrank, Herd, …) – ein Zwischenstecker/Klemmzähler würde das sichtbar machen. ` : '') +
      `Prognosen sind jetzt auf diesen Wert kalibriert.`]);
  }
  // 1) electric booster heater (Heizstab) – expensive direct electric heat
  if (l.energy_kwh > 0 && l.eheater_kwh != null) {
    const share = l.eheater_kwh / l.energy_kwh;
    if (share > 0.06) tips.push(['🔥', `Der <b>Elektro-Zuheizer</b> macht ${fmt(share * 100, 0)} % des ` +
      `WP-Stroms (${kwh(l.eheater_kwh, 0)}). Er heizt 1:1 mit Strom – eine höhere Heizkurve/Warmwasser-` +
      `Temperatur nur über die Wärmepumpe spart hier. Ziel: möglichst < 5 %.`]);
  }
  // 2) seasonal COP
  const scop = (A && A.imported && A.imported.seasonal_cop) || (A && A.stats && A.stats.seasonal_cop);
  if (scop) {
    if (scop < 3) tips.push(['📉', `Jahresarbeitszahl <b>${fmt(scop, 2)}</b> ist eher niedrig. Prüfe ` +
      `Vorlauftemperatur, Takten und Warmwasser-Zeiten – jede 0,1 mehr COP spart spürbar Strom.`]);
    else tips.push(['✅', `Jahresarbeitszahl <b>${fmt(scop, 2)}</b> ist ordentlich – aus 1 kWh Strom werden ` +
      `${fmt(scop, 1)} kWh Wärme.`]);
  }
  // 3) heat pump dominates → PV/battery makes most sense
  if (fc.hpYear > fc.shYear * 2 && fc.hpYear > 1500) tips.push(['☀️', `Die Wärmepumpe ist dein größter ` +
    `Verbraucher (${kwh(fc.hpYear, 0)}/Jahr). Eine <b>PV-Anlage</b> senkt v. a. die Übergangs-/Sommerkosten – ` +
    `im Tab <b>PV</b> kannst du kWp & Speicher für deinen Bedarf durchrechnen.`]);
  // 4) standby / base load
  if (data && data.stats && data.stats.standby_share > 0.25) tips.push(['🔌', `Die Grundlast macht ` +
    `${fmt(data.stats.standby_share * 100, 0)} % deines Smart-Home-Verbrauchs aus – Standby-Fresser ` +
    `(Netzteile, Geräte) lohnen sich zu prüfen.`]);
  // 5) away savings
  if (data && data.away && data.away.count >= 3) tips.push(['🏠', `An ${data.away.count} Tagen wart ihr ` +
    `vermutlich abwesend. Eine Absenkung/Abwesenheits-Automatik an genau diesen Mustern spart zusätzlich.`]);
  // 6) hot-water share
  const mw = A && A.mode_window;
  if (mw && (mw.heating + mw.water) > 0 && mw.water / (mw.heating + mw.water) > 0.6 && mw.water > 3)
    tips.push(['🚿', `Aktuell geht der meiste WP-Strom ins <b>Warmwasser</b>. Lege die Warmwasser-Bereitung ` +
      `wenn möglich in die <b>Mittagszeit</b> – mit PV wird sie dann fast kostenlos.`]);

  if (!tips.length) { card.hidden = true; return; }
  card.hidden = false;
  box.innerHTML = tips.slice(0, 5).map(([ic, t]) =>
    `<div class="devrow" style="align-items:flex-start"><div style="font-size:18px;flex:none;width:24px">${ic}</div>` +
    `<div class="nm"><small style="color:var(--ink);font-size:13px;line-height:1.5">${t}</small></div></div>`).join('');
}

function renderToday() {
  const ov = STATE.ov; if (!ov) return;
  $('t-total').innerHTML = kwh(ov.today.total_kwh, 1);
  $('t-sh').innerHTML = kwh(ov.today.smarthome_kwh, 2);
  $('t-hp').innerHTML = kwh(ov.today.heatpump_kwh, 2);

  const hrs = ov.today_hourly || [];
  const hasData = hrs.some(h => h.smarthome_kwh > 0 || h.heatpump_kwh > 0);
  $('t-hourly').innerHTML = hasData ? stackedBar(
    hrs.map(h => ({ label: h.hour % 3 === 0 ? h.hour + '' : '', full: h.hour + ':00 Uhr', values: { sh: h.smarthome_kwh, hp: h.heatpump_kwh } })),
    [{ key: 'sh', color: COL.sh }, { key: 'hp', color: COL.hp }], { h: 190, unit: 'kWh' })
    : '<div class="note">Der Stundenverlauf füllt sich im Lauf des Tages.</div>';
  if (hasData) {
    const peak = hrs.reduce((a, b) => (b.smarthome_kwh + b.heatpump_kwh) > (a.smarthome_kwh + a.heatpump_kwh) ? b : a);
    $('t-hourly-note').innerHTML = `Verbrauchsstärkste Stunde bisher: <b>${peak.hour}:00 Uhr</b> ` +
      `(${kwh(peak.smarthome_kwh + peak.heatpump_kwh, 2)}).`;
  } else { $('t-hourly-note').textContent = ''; }

  const segs = [
    { label: 'Smart Home', value: ov.today.smarthome_kwh, color: COL.sh },
    { label: 'Wärmepumpe', value: ov.today.heatpump_kwh, color: COL.hp },
  ].filter(s => s.value > 0);
  $('t-donut').innerHTML = segs.length ? donutChart(segs, { big: eur(ov.today.cost), center: 'heute' })
    : '<div class="note">Noch keine Daten für heute.</div>';
  $('t-legend').innerHTML = legendHtml(segs.map(s => ({ label: s.label, color: s.color, sub: kwh(s.value, 2) })));

  const HP_KEYS = new Set(['heatpump', 'hp_heating', 'hp_water', 'hp_other', 'hp_gap']);
  const devs = ov.breakdown.filter(b => !HP_KEYS.has(b.key) && b.kwh > 0);
  const maxD = Math.max(0.0001, ...devs.map(d => d.kwh));
  $('t-devices').innerHTML = devs.length
    ? devs.map(d => devRow(d.label, kwh(d.kwh, 3) + ' heute', kwh(d.kwh, 2), '', d.kwh / maxD * 100, COL.sh)).join('')
    : '<div class="note">Noch keine Gerätedaten für heute.</div>';
}

// Resolve the current Verlauf window [from,to] and the display mode.
// label a day as heute / gestern / "Mi, 15.10.2026"
function dayLabel(d) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t - d) / 86400000);
  if (diff === 0) return 'heute';
  if (diff === 1) return 'gestern';
  if (diff === 2) return 'vorgestern';
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
}
function historyWindow() {
  const sel = STATE.histSel, now = new Date();
  if (sel === 'day') {
    const base = STATE.histDay ? new Date(STATE.histDay) : new Date();
    const from = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const name = dayLabel(from), rel = !/\d{4}/.test(name);   // heute/gestern/… vs. a date
    return { from, to: new Date(from), mode: 'day', single: true, day: from,
      title: 'Strom ' + (rel ? name : 'am ' + name) + ' · pro Stunde' };
  }
  if (sel === 'year') {
    return { from: new Date(now.getFullYear(), 0, 1), to: now, mode: 'month', title: 'Strom dieses Jahr pro Monat' };
  }
  if (sel === 'custom') {
    const f = $('hist-from').value, t = $('hist-to').value;
    let from = f ? new Date(f + 'T00:00') : new Date(now.getTime() - 29 * 86400000);
    let to = t ? new Date(t + 'T00:00') : now;
    if (from > to) { const x = from; from = to; to = x; }
    const span = Math.round((to - from) / 86400000) + 1;
    return { from, to, mode: span > 62 ? 'month' : 'day', title: 'Strom im Zeitraum' + (span > 62 ? ' pro Monat' : ' pro Tag') };
  }
  const d = parseInt(sel, 10) || 14;
  return { from: new Date(now.getTime() - (d - 1) * 86400000), to: now, mode: 'day', title: 'Strom pro Tag' };
}

let _histHit = null;
function renderHistory() {
  const ov = STATE.ov, data = STATE.data; if (!ov || !data) return;
  const shHex = COL.sh, hpHex = COL.hp;
  const win = historyWindow();
  const filled = filledDaily(win.from, win.to);
  const anyEst = filled.some(d => d.estimated);
  $('h-daily-legend').innerHTML = legendHtml([
    { label: 'Smart Home', color: shHex }, { label: 'Wärmepumpe', color: hpHex }]
    .concat(anyEst ? [{ label: 'geschätzt (Ø, saisonal)', color: 'rgba(147,162,196,.5)' }] : [])) +
    `<span style="color:var(--muted);font-size:11px;margin-left:6px">tippen/fahren für Tageswerte</span>`;

  if (win.single) {
    paintHistoryDayHourly(win.day);   // single day → hourly bars (own async path)
  } else if (win.mode === 'month') {
    const months = aggregateMonths(filled);
    $('h-daily').innerHTML = `<div class="dhit" style="touch-action:none">` + stackedBar(
      months.map(m => ({ label: m.label, estimated: m.estimated, values: { sh: m.sh, hp: m.hp } })),
      [{ key: 'sh', color: shHex }, { key: 'hp', color: hpHex }], { h: 210 }) + `</div>`;
    _histHit = { mode: 'month', rows: months.map(m => ({ tip: m.label, sh: m.sh, hp: m.hp, total: m.total, estimated: m.estimated })) };
    const tot = months.map(m => m.total);
    $('h-avg').innerHTML = kwh(mean(months.map(m => m.total / 30.4)), 2);
    $('h-max').innerHTML = kwh(Math.max(0, ...tot), 0); $('h-max-l').textContent = 'Stärkster Monat';
  } else {
    $('h-daily').innerHTML = `<div class="dhit" style="touch-action:none">` + stackedBar(
      filled.map(d => ({ label: shortDay(d.day), estimated: d.estimated, values: { sh: d.sh, hp: d.hp } })),
      [{ key: 'sh', color: shHex }, { key: 'hp', color: hpHex }], { h: 210 }) + `</div>`;
    _histHit = { mode: 'day', rows: filled.map(d => ({
      tip: new Date(d.day + 'T12:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }),
      sh: d.sh, hp: d.hp, total: d.total, estimated: d.estimated })) };
    const tot = filled.map(d => d.total);
    $('h-avg').innerHTML = kwh(mean(tot), 2);
    $('h-max').innerHTML = kwh(Math.max(0, ...tot), 2); $('h-max-l').textContent = 'Höchster Tag';
  }
  $('h-daily-title').textContent = win.title;
  $('h-daily-note').hidden = !anyEst;
  if (anyEst) {
    const realN = filled.filter(d => !d.estimated).length;
    $('h-daily-note').innerHTML = `<b>${realN}</b> von ${filled.length} Tagen sind gemessen; ` +
      `blasse Balken sind aus deinem bisherigen Verbrauch hochgerechnet und <b>saisonal verteilt</b> ` +
      `(Wärmepumpe im Winter mehr, im Sommer weniger). Echte Messungen ersetzen die Schätzung automatisch.`;
  }

  // cumulative share over the (measured) window: per Smart-Home device + heat
  // pump, each with a per-year projection (kWh + €) so unnecessary consumers pop.
  const winKeys = new Set(filled.map(d => d.day));
  const pdd = data.per_device_day || {};
  const names = {}; (data.live.devices || []).forEach(d => names[d.id] = devLabel(d).title);
  const shares = [];
  Object.keys(pdd).forEach(id => {
    let s = 0, n = 0; for (const day in pdd[id]) if (winKeys.has(day)) { s += pdd[id][day]; n++; }
    if (s > 0) shares.push({ label: names[id] || id, kwh: s, days: n, color: COL.sh });
  });
  const hpByDay = {}; ((ov.combined_daily) || []).forEach(d => hpByDay[d.day] = d.heatpump_kwh);
  let hpWin = 0, hpN = 0; winKeys.forEach(k => { if (hpByDay[k] != null && hpByDay[k] > 0) { hpWin += hpByDay[k]; hpN++; } });
  if (hpWin > 0) shares.push({ label: 'Wärmepumpe', kwh: hpWin, days: hpN, color: COL.hp, seasonal: true });
  shares.sort((a, b) => b.kwh - a.kwh);
  const totShare = shares.reduce((a, s) => a + s.kwh, 0) || 1;
  const sharePrice = STATE.price;
  const winDays = winKeys.size || 1;
  const yearOf = s => (s.days > 0 ? s.kwh / s.days * 365 : 0);
  const totYear = shares.reduce((a, s) => a + yearOf(s), 0);
  const totalRow = shares.length
    ? `<div class="devrow" style="border-bottom:1px solid var(--card-bd,#2a2f3a);padding-bottom:8px;margin-bottom:4px">` +
      `<div class="nm"><b>Gesamt (alle gelisteten)</b><small>gemessen <b>${kwh(totShare, 1)}</b> · ${winDays} Tage</small></div>` +
      `<div class="val"><b>~${kwh(totYear, 0)}/Jahr</b><small>${money(totYear * sharePrice)}</small></div></div>`
    : '';
  $('h-share').innerHTML = shares.length
    ? totalRow + shares.map(s => {
        const pct = s.kwh / totShare * 100;
        // exact measured days + average for every not-measured day of the year:
        //   s.kwh (exact) + (s.kwh/s.days) × (365 − s.days)  ==  s.kwh/s.days × 365
        const yearK = yearOf(s);
        const sub = `${pct.toFixed(0)} % · gemessen <b>${kwh(s.kwh, 1)}</b> (${s.days}/${winDays} Tage)` +
          (s.seasonal ? ' · saisonal' : '');
        return devRow(s.label, sub, `~${kwh(yearK, 0)}/Jahr`, money(yearK * sharePrice), pct, s.color);
      }).join('')
    : '<div class="note">Noch keine gemessenen Daten im Zeitraum.</div>';
  const shareNote = $('h-share-note');
  if (shareNote) shareNote.innerHTML = shares.length
    ? 'Rechts die <b>Hochrechnung pro Jahr</b> (kWh + €). <b>Gemessene Tage zählen exakt</b> mit ihrem echten Wert; ' +
      'nur die <b>noch nicht gemessenen</b> Tage (Lücken + der Rest des Jahres) werden mit dem Tages-Ø aufgefüllt – ' +
      'das ist rechnerisch dasselbe wie Ø × 365. Große Posten, die dir <b>nicht wichtig</b> sind, lohnt es zu prüfen ' +
      '(Dauerlast, alte Geräte). <span style="color:var(--muted)">Je mehr gemessene Tage, desto genauer; die ' +
      'Wärmepumpe ist saisonal – für ihren Jahreswert ist die <b>Hochrechnung</b>-Karte oben genauer.</span>'
    : '';

  // away detection (Smart Home)
  const A = data.away;
  $('h-away-sum').textContent = `${A.count} Tage`;
  const pres = data.daily.slice(-30).map(d => ({
    v: Math.max(0.02, d.presence ?? 0), color: d.likely_away ? COL.away : COL.sh, label: shortDay(d.day),
  }));
  $('h-presence').innerHTML = pres.length ? barChart(pres, { h: 180 })
    : '<div class="note">Noch keine Tage zur Anwesenheits-Analyse.</div>';
  const list = data.daily.filter(d => d.likely_away);
  $('h-away-list').innerHTML = list.length
    ? list.map(d => `<span class="badge away-b" style="margin:3px 4px 3px 0;display:inline-block">${longDay(d.day)}</span>`).join('')
    : '<div class="note">Keine eindeutig abwesenden Tage erkannt.</div>';

  // seasonal forecast & insights
  const S = data.stats, price = STATE.price, m = new Date().getMonth();
  const fc = annualForecast();
  // robust base load from the hourly profile (min of the 3 quietest hours);
  // the bridge's baseline_w is ~0 when the modules measure little.
  const prof = (data.hourly_profile || []).map(h => h.avg_w).filter(v => v != null);
  let baseW = data.baseline_w || 0;
  if (prof.length >= 24) baseW = Math.max(baseW, mean(prof.slice().sort((a, b) => a - b).slice(0, 3)));
  const standbyYear = baseW * 24 * 365 / 1000;
  const rows = [
    ['Hochrechnung / Jahr', `${kwh(fc.year, 0)} · ${money(fc.yearCost)}`],
    ['davon Wärmepumpe', fc.hpYear > 0 ? `${kwh(fc.hpYear, 0)} · ${money(fc.hpYear * price)}`
      + (fc.hpBasis === 'gedämpft' ? ' 🏗️' : fc.hpImported ? ' ✓' : '') : '–'],
    ['davon Smart Home', `${kwh(fc.shYear, 0)} · ${money(fc.shYear * price)}`],
    [`Prognose ${MON[m]}`, `${kwh(fc.monthNow, 0)} · ${money(fc.monthNowCost)}`],
    ['Wärmepumpe Winter vs. Sommer', fc.hpYear > 0
      ? (fc.hpBasis === 'gedämpft'
          ? `${kwh(hpMonthCorrected(0), 0)} (Jan) ↔ ${kwh(hpMonthCorrected(6), 0)} (Jul)`
          : `${kwh(hpMonthEst(0), 0)} (Jan) ↔ ${kwh(hpMonthEst(6), 0)} (Jul)`) : '–'],
  ];
  // only show the module base load when the modules actually measure a
  // meaningful base (avoids the misleading "0,0 kWh · 0 %" line)
  if (standbyYear > 20) rows.push(['Grundlast (gemessene Geräte) / Jahr',
    `${kwh(standbyYear, 0)} · ${fmt(fc.shYear > 0 ? standbyYear / fc.shYear * 100 : 0, 0)} % des Hausstroms`]);
  rows.push(['Vermutete Abwesenheit', `${A.count} Tage · ~${money(A.count * (S.day_avg_cost || 0))}`]);
  $('h-insights').innerHTML = rows.map(([k, v]) => statusRow(k, v)).join('');
  renderForecastBasis(fc);
  renderConsumYear();
  renderTibberCons();
}

// Single-day Verlauf: hourly Smart-Home consumption (per device, stacked) for
// the selected day, from /api/series. Reuses the device-timeline machinery.
let _histDayTok = 0;
async function paintHistoryDayHourly(day) {
  const el = $('h-daily'), leg = $('h-daily-legend'); if (!el) return;
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const t0 = Math.floor(dayStart.getTime() / 1000), t1 = t0 + 86400;
  const daysBack = Math.max(1, Math.ceil(Date.now() / 1000 / 86400 - t0 / 86400) + 1);
  el.innerHTML = '<div class="note" style="padding:16px 0;text-align:center">Lade Stundenwerte …</div>';
  const token = (_histDayTok = _histDayTok + 1);
  let samples;
  try { samples = await devtlFetchSeries(daysBack); }
  catch (e) { if (token === _histDayTok) el.innerHTML = '<div class="note">Stundenwerte nur mit laufender Bridge verfügbar.</div>'; return; }
  if (token !== _histDayTok) return;                // a newer day was picked meanwhile
  const by = {};
  for (const s of samples) if (s.ts >= t0 && s.ts < t1) (by[s.device_id] = by[s.device_id] || []).push(s);
  const perDev = {}; let any = false;
  for (const id in by) {
    const arr = by[id]; arr.sort((a, b) => a.ts - b.ts); perDev[id] = {};
    for (let i = 0; i < arr.length; i++) {
      const dt = Math.min(1800, i < arr.length - 1 ? arr[i + 1].ts - arr[i].ts : 900);
      const wh = (arr[i].power_w || 0) * dt / 3600, h = Math.floor((arr[i].ts - t0) / 3600);
      if (h >= 0 && h < 24 && wh > 0) { perDev[id][h] = (perDev[id][h] || 0) + wh; any = true; }
    }
  }
  if (!any) {
    el.innerHTML = '<div class="note" style="padding:16px 0;text-align:center">Für diesen Tag liegen keine gemessenen Stundenwerte vor (gemessene Steckdosen). Mit einem der Mehrtage-Zeiträume siehst du geschätzte Tageswerte.</div>';
    if (leg) leg.innerHTML = '';
    $('h-avg').innerHTML = '–'; $('h-max').innerHTML = '–'; $('h-max-l').textContent = 'Stärkste Stunde';
    return;
  }
  const ranked = Object.keys(perDev).map(id => ({ id, val: Object.values(perDev[id]).reduce((a, b) => a + b, 0) }))
    .filter(x => x.val > 0.001).sort((a, b) => b.val - a.val);
  const { series, restIds } = _devtlSeries3(ranked, 'all');
  const rows = []; let dayTot = 0; const hourTot = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    const values = {};
    series.forEach(s => {
      const wh = s.key === '__rest' ? restIds.reduce((a, id) => a + ((perDev[id] || {})[h] || 0), 0) : ((perDev[s.key] || {})[h] || 0);
      values[s.key] = wh / 1000; dayTot += wh / 1000; hourTot[h] += wh / 1000;
    });
    rows.push({ label: h % 3 === 0 ? (String(h).padStart(2, '0') + 'h') : '',
      full: String(h).padStart(2, '0') + ':00–' + String((h + 1) % 24).padStart(2, '0') + ':00', values });
  }
  // plain wrapper (NOT .dhit): the day chart uses stackedBar's own per-hour
  // readout, so it must not trigger the multi-day _histHit hover handler.
  el.innerHTML = `<div style="touch-action:none">` + stackedBar(rows, series, { h: 210, unit: 'kWh' }) + `</div>`;
  if (leg) leg.innerHTML = legendHtml(series.map(s => ({ label: s.label, color: s.color }))) +
    `<span style="color:var(--muted);font-size:11px;margin-left:6px">tippen/fahren für Stundenwerte</span>`;
  const peakH = hourTot.indexOf(Math.max(...hourTot));
  $('h-avg').innerHTML = kwh(dayTot, 2);
  $('h-max').innerHTML = `${String(peakH).padStart(2, '0')}–${String((peakH + 1) % 24).padStart(2, '0')} h`;
  $('h-max-l').textContent = 'Stärkste Stunde';
}
// day navigator (◀ ▶) for the single-day Verlauf
function updateHistDayNav() {
  const lbl = $('hist-day-label'); if (!lbl) return;
  const base = STATE.histDay ? new Date(STATE.histDay) : new Date();
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const name = dayLabel(d), full = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  lbl.textContent = /\d{4}/.test(name) ? name : `${name} · ${full}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const next = $('hist-day-next'); if (next) next.disabled = d >= today;
}
function histDayShift(delta) {
  const base = STATE.histDay ? new Date(STATE.histDay) : new Date();
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + delta);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (d > today) return;
  STATE.histDay = d; updateHistDayNav(); renderHistory();
}

// Explains WHERE the yearly number comes from and how sure it is – so a
// surprisingly high (or low) figure is legible and improvable.
function renderForecastBasis(fc) {
  const el = $('h-insights-note'); if (!el) return;
  const ms = meterStats();
  const parts = [];
  // heat pump source
  if (fc.hpBasis === 'gedämpft') {
    parts.push('<b>Wärmepumpe</b>: aus deiner <b>importierten HomeCom-Historie</b>, aber mit <b>Bauphase-Dämpfung</b> 🏗️ – die überhöhten Einzugs-/Rohbau-Wintermonate werden Richtung Gebäudemodell gedämpft (Sommermonate bleiben unverändert).');
  } else {
    parts.push(fc.hpImported
      ? '<b>Wärmepumpe</b>: aus deiner <b>importierten HomeCom-Historie</b> (echte Monatswerte) ✓'
      : '<b>Wärmepumpe</b>: aus dem gemessenen Zählerwachstum <b>hochgerechnet</b> (noch keine CSV importiert).');
  }
  // household source
  if (ms && ms.dailyAvg != null) {
    const days = Math.round(ms.spanDays);
    parts.push(`<b>Hausstrom</b>: aus deiner <b>Zählerablesung</b> (${days} Tag(e), Gesamtzähler minus Wärmepumpe), aufs Jahr hochgerechnet.`);
  } else if (houseManual() > 0) {
    parts.push('<b>Hausstrom</b>: aus deinem <b>manuell eingetragenen</b> Jahreswert.');
  } else {
    parts.push('<b>Hausstrom</b>: nur aus den <b>gemessenen Bosch-Modulen</b> – erfasst evtl. nicht das ganze Haus. Trag im Setup deinen <b>Gesamtzähler</b> ein für eine realistische Zahl.');
  }
  // plausibility cross-check against the real meter daily average
  let cross = '';
  if (ms && ms.dailyAvg != null) {
    const projDaily = fc.year / 365;
    cross = ` <br>🔎 Dein Zähler zeigt aktuell ~<b>${kwh(ms.dailyAvg, 1)}/Tag</b>; die Jahresprognose entspricht Ø <b>${kwh(projDaily, 1)}/Tag</b>` +
      (projDaily > ms.dailyAvg * 1.15
        ? ` – mehr, <b>weil die Wärmepumpe im Winter viel stärker heizt</b> als jetzt. Das treibt die Jahreszahl.`
        : ` – passt gut zusammen.`);
  }
  const accuracy = (ms && ms.spanDays < 25)
    ? ' <span style="color:var(--muted)">Für eine stabilere Prognose weitere Zählerstände über mehrere Monate eintragen – dann glättet sich die Hochrechnung.</span>'
    : '';
  el.innerHTML = 'Woher die Zahlen kommen: ' + parts.join(' ') + cross + accuracy;
}

// Real whole-house metered consumption from Tibber (daily), as a bar chart with
// totals – a true meter feed alongside the device-level Bosch data.
function renderTibberCons() {
  const card = $('h-tibber-card'); if (!card) return;
  const t = STATE.tibberCons;
  if (!t || !Array.isArray(t.nodes) || !t.nodes.length) { card.hidden = true; return; }
  card.hidden = false;
  const nodes = t.nodes.slice(-30);
  const days = nodes.length || 1;
  const avg = t.total_kwh / days, avgCost = (t.total_cost || 0) / days;
  const price = STATE.price;
  $('h-tibber-kpi').innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v">${kwh(avg, 1)}</div><div class="l">Ø / Tag · ${money(avgCost || avg * price)}</div></div>` +
    `<div class="kpi sm"><div class="v">${kwh(t.total_kwh, 0)}</div><div class="l">Summe ${days} Tage · ${money(t.total_cost || t.total_kwh * price)}</div></div></div>`;
  $('h-tibber-chart').innerHTML = barChart(
    nodes.map(n => ({ v: n.kwh, label: shortDay(new Date(n.ts * 1000).toISOString().slice(0, 10)) })), { h: 180 });
  const maxN = nodes.reduce((a, b) => b.kwh > a.kwh ? b : a);
  const minN = nodes.reduce((a, b) => b.kwh < a.kwh ? b : a);
  const dd = ts => new Date(ts * 1000).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  $('h-tibber-note').innerHTML =
    `Echter <b>Gesamtverbrauch</b> deines Hauses aus dem Tibber-Zähler${t.demo ? ' <span style="color:var(--muted)">(Demo)</span>' : ''}. ` +
    `Höchster Tag <b>${kwh(maxN.kwh, 1)}</b> (${dd(maxN.ts)}), niedrigster <b>${kwh(minN.kwh, 1)}</b> (${dd(minN.ts)}). ` +
    `Das umfasst <b>alle</b> Verbraucher – auch die, die die Bosch-Module nicht messen.`;
}

/* ------------------------------------------------------------- heat pump */
function hpStatusPill(l) {
  const active = l.modulation != null && l.modulation > 0;
  const modeTxt = HP_MODE[l.mode] || l.mode || 'Bereitschaft';
  return active
    ? `<span style="color:var(--accent2)">● läuft</span> · ${esc(modeTxt)}` + (l.modulation != null ? ` · ${fmt(l.modulation, 0)} %` : '')
    : `<span style="color:var(--muted)">◦ ${esc(modeTxt)}</span>`;
}

/* ---------------------------------------------- building heat-demand model */
const BUILD_LS = 'bhe_building';
const BUILD_DEFAULT = {
  area: 120, height: 2.6, hgt: 3500, n: 0.5, gain: 0.15,
  cop_heat: 2.6, cop_dhw: 2.7, dhw: 2000,
  comps: [
    { k: 'wall', l: 'Außenwände (Bims + 8 cm)', a: 100, u: 0.32, f: 1 },
    { k: 'win', l: 'Fenster 3-fach (KfW55)', a: 18, u: 0.90, f: 1 },
    { k: 'door', l: 'Haustür (KfW55)', a: 2.5, u: 1.30, f: 1 },
    { k: 'flat', l: 'Flachdach ungedämmt', a: 60, u: 1.80, f: 1 },
    { k: 'pitch', l: 'Satteldach (10 cm)', a: 46, u: 0.38, f: 1 },
    { k: 'floorI', l: 'Boden gedämmt (30 cm)', a: 80, u: 0.28, f: 0.5 },
    { k: 'floorU', l: 'Boden über Keller ungedämmt', a: 20, u: 0.80, f: 0.5 },
  ],
};
function buildData() {
  try { const s = JSON.parse(localStorage.getItem(BUILD_LS)); if (s && s.comps) return s; } catch (e) {}
  return JSON.parse(JSON.stringify(BUILD_DEFAULT));
}
function computeHeat(b) {
  const factor = b.hgt * 0.024;               // Kd → kWh per (W/K)
  const items = [];
  let ua = 0;
  b.comps.forEach(c => { const u = c.u * c.a * c.f; ua += u; items.push({ l: c.l, q: u * factor, c }); });
  const qVent = 0.34 * b.n * (b.area * b.height) * factor;
  items.push({ l: 'Lüftung', q: qVent, c: null });
  const gross = ua * factor + qVent;
  const qHeat = gross * (1 - b.gain);          // minus solar/internal gains
  const eHeat = qHeat / b.cop_heat, eDhw = b.dhw / b.cop_dhw;
  return { factor, items, gross, qHeat, eHeat, eDhw, eTotal: eHeat + eDhw, qTotal: qHeat + b.dhw };
}
// Building UA (W/K) from the Theorie-vs-Praxis component model (ΣU·A·f + ventilation).
function buildingUA() {
  const b = buildData();
  let ua = 0;
  (b.comps || []).forEach(c => { ua += (c.u || 0) * (c.a || 0) * (c.f == null ? 1 : c.f); });
  ua += 0.34 * (b.n || 0) * ((b.area || 0) * (b.height || 0));   // ventilation UA
  return ua;
}
// Effective specific heat load (W/m²) implied by the building model at the design
// temperature – so the detailed Gebäudemodell can drive the heat-load estimate
// with one tap instead of a blanket assumption.
function buildingSpec(designC) {
  const ua = buildingUA();
  if (!(ua > 0)) return null;
  const dc = (designC == null || !isFinite(designC)) ? -12 : designC;
  const qDesign = ua * (20 - dc);                 // W at design temp (indoor 20 °C)
  let area = 0;
  try { const o = (typeof hlAreas === 'function') ? hlAreas() : {}; area = Object.values(o).reduce((s, v) => s + (parseFloat(v) || 0), 0); } catch (e) {}
  if (!(area > 0)) { const b = buildData(); area = b.area || 0; }
  if (!(area > 0)) return null;
  return Math.round(qDesign / area);
}
// Sensible post-renovation U-values and rough insulation cost (€/m²) per part.
const RENO = {
  wall:   { u: 0.24, cost: 160, l: 'Außenwände dämmen' },
  pitch:  { u: 0.24, cost: 150, l: 'Satteldach dämmen' },
  flat:   { u: 0.20, cost: 220, l: 'Flachdach dämmen' },
  floorI: { u: 0.30, cost: 90,  l: 'Bodenplatte dämmen' },
  floorU: { u: 0.30, cost: 90,  l: 'Kellerdecke dämmen' },
  win:    { u: 0.90, cost: 550, l: 'Fenster tauschen' },
  door:   { u: 1.10, cost: 0,   l: 'Haustür tauschen' },
};
// A horizontal energy-class scale (kWh/m²·a heating) with a marker. An optional
// second value (measured) is drawn as a blue marker below the bar.
function classBar(spec, measured) {
  const h = measured != null ? 66 : 56, top = 8, barH = 16, y = top, max = 200;
  const segs = [[15, '#2ecc71', 'Passiv'], [45, '#4be0b0', 'KfW'],
    [90, '#f6b93b', 'Neubau'], [140, '#f39c12', 'Bestand'], [max, '#ef6c4d', 'unsaniert']];
  const X = v => (Math.min(v, max) / max) * CW;
  let rects = '', ticks = '', lo = 0;
  segs.forEach(([hi, col]) => {
    rects += `<rect x="${X(lo).toFixed(1)}" y="${y}" width="${(X(hi) - X(lo)).toFixed(1)}" height="${barH}" fill="${col}"/>`;
    ticks += `<text class="axis" x="${X(hi).toFixed(1)}" y="${y + barH + 12}" text-anchor="middle">${hi}</text>`;
    lo = hi;
  });
  const mx = X(spec);
  let marker = `<path d="M${mx.toFixed(1)} ${y - 1} l-5 -7 l10 0 z" fill="#fff"/>` +
    `<line x1="${mx.toFixed(1)}" y1="${y}" x2="${mx.toFixed(1)}" y2="${y + barH}" stroke="#fff" stroke-width="2"/>` +
    `<text class="axis" x="${Math.min(CW - 30, mx + 6).toFixed(1)}" y="${y - 2}" fill="#fff">Modell</text>`;
  if (measured != null) {
    const mm = X(measured);
    marker += `<line x1="${mm.toFixed(1)}" y1="${y}" x2="${mm.toFixed(1)}" y2="${y + barH}" stroke="#3ba9ff" stroke-width="2"/>` +
      `<path d="M${mm.toFixed(1)} ${y + barH + 1} l-5 7 l10 0 z" fill="#3ba9ff"/>` +
      `<text class="axis" x="${Math.min(CW - 40, mm + 6).toFixed(1)}" y="${y + barH + 20}" fill="#3ba9ff">gemessen</text>`;
  }
  return svg(h, rects + marker + ticks);
}
function buildClass(spec) {
  if (spec <= 15) return ['Passivhaus-Niveau', '#2ecc71'];
  if (spec <= 45) return ['KfW-Effizienzhaus-Niveau', '#4be0b0'];
  if (spec <= 90) return ['Neubau / gut saniert', '#f6b93b'];
  if (spec <= 140) return ['typischer sanierter Altbau', '#f39c12'];
  return ['wenig gedämmter Altbau', '#ef6c4d'];
}
let _thmHit = null;
function renderHeatDemand() {
  const card = $('hp-theory-card'); if (!card) return;
  const b = buildData(), r = computeHeat(b), price = STATE.price;
  const measured = hpYearFromMonthly() || (STATE.hpA && STATE.hpA.imported && STATE.hpA.imported.year_elec_kwh) || null;
  // headline comparison
  const bars = [{ label: 'Theorie', v: r.eTotal, color: 'url(#gHeat)' }];
  if (measured) bars.push({ label: 'Gemessen', v: measured, color: 'url(#g1)' });
  let cmp = '';
  if (measured) {
    const diff = (measured - r.eTotal) / r.eTotal;
    cmp = Math.abs(diff) < 0.12 ? `Praxis ≈ Theorie (${diff >= 0 ? '+' : ''}${fmt(diff * 100, 0)} %) – dein Modell passt gut.`
      : diff < 0 ? `Praxis <b>${fmt(-diff * 100, 0)} % besser</b> als berechnet – effiziente Anlage / mildes Wetter / niedrige Vorlauftemperatur.`
        : `Praxis <b>${fmt(diff * 100, 0)} % höher</b> als berechnet – höhere Vorlauftemperatur, mehr Warmwasser oder mehr Lüftungsverluste als angenommen.`;
  }
  // expected (model) vs. measured seasonal COP / JAZ
  const copExp = r.eTotal > 0 ? r.qTotal / r.eTotal : null;
  const A = STATE.hpA;
  const copMeas = (A && A.imported && A.imported.seasonal_cop) || (A && A.stats && A.stats.seasonal_cop) ||
    (A && A.live && A.live.cop_lifetime) || null;
  let copCmp = '';
  if (copExp && copMeas) {
    const d = copMeas - copExp;
    copCmp = Math.abs(d) < 0.15 ? ' – passt gut zusammen.'
      : d > 0 ? ` – deine WP arbeitet <b>effizienter</b> als angenommen; setze „COP Heizen/Warmwasser" höher, dann sinkt der erwartete Strom.`
        : ` – deine WP ist <b>weniger effizient</b> als angenommen (höhere Vorlauf-/Warmwassertemperatur?); setze „COP Heizen/Warmwasser" niedriger.`;
  }
  $('hp-theory-result').innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v">${kwh(r.eTotal, 0)}</div><div class="l">Erwarteter Strom (Theorie)</div></div>` +
    `<div class="kpi sm"><div class="v">${measured ? kwh(measured, 0) : '–'}</div><div class="l">Gemessen (deine Daten)</div></div></div>` +
    `<div class="grid2" style="margin-top:8px"><div class="kpi sm"><div class="v">${copExp ? fmt(copExp, 2) : '–'}</div><div class="l">Arbeitszahl erwartet (Modell)</div></div>` +
    `<div class="kpi sm"><div class="v">${copMeas ? fmt(copMeas, 2) : '–'}</div><div class="l">Arbeitszahl gemessen (JAZ)</div></div></div>` +
    `<div style="margin-top:12px">${barChart(bars, { h: 130 })}</div>` +
    `<div class="note" style="margin-top:8px">Wärmebedarf gesamt ~<b>${kwh(r.qTotal, 0)}</b> thermisch ` +
    `(Heizen ${kwh(r.qHeat, 0)} + Warmwasser ${kwh(b.dhw, 0)}), geteilt durch COP. ${cmp}</div>` +
    (copExp && copMeas ? `<div class="note" style="margin-top:6px">⚙️ <b>Arbeitszahl:</b> Modell ~${fmt(copExp, 2)}, ` +
      `gemessen ${fmt(copMeas, 2)}${copCmp}</div>` : '');
  // biggest levers
  const losses = r.items.filter(x => x.c).sort((a, z) => z.q - a.q);
  const top = losses.slice(0, 4);
  const totalQ = r.items.reduce((a, x) => a + x.q, 0) || 1;
  let bd = top.map(x => devRow(x.l, (x.q / totalQ * 100).toFixed(0) + ' % der Verluste', kwh(x.q, 0), '', x.q / totalQ * 100, x.q === top[0].q ? COL.hp : COL.sh)).join('');
  const flat = b.comps.find(c => c.k === 'flat');
  if (flat && flat.u > 0.5) {
    const save = (flat.u - 0.2) * flat.a * flat.f * r.factor * (1 - b.gain) / b.cop_heat;
    bd += `<div class="note" style="margin-top:8px">💡 <b>Größter Hebel:</b> das ungedämmte Flachdach. Auf U 0,2 ` +
      `gedämmt spart grob <b>${kwh(save, 0)} Strom/Jahr</b> (~${money(save * price)}) – oft die wirtschaftlichste Maßnahme.`;
  }
  $('hp-theory-breakdown').innerHTML = `<div class="note" style="margin-bottom:6px">Wärmeverluste (Theorie, vor Gewinnen):</div>` + bd;
  // editable inputs — build once; skip on re-render so focus/typing is kept
  const ti = $('hp-theory-inputs');
  if (ti && !ti.dataset.built) {
    const g = (id, l, v, step) => `<div style="flex:1;min-width:120px"><label>${l}</label>` +
      `<input type="number" data-g="${id}" value="${v}" step="${step}" inputmode="decimal"></div>`;
    let comps = b.comps.map(c =>
      `<div style="display:flex;gap:6px;align-items:flex-end;margin:6px 0">` +
      `<div style="flex:1;font-size:12px;color:var(--muted)">${esc(c.l)}</div>` +
      `<div style="width:70px"><label style="font-size:10px">m²</label><input type="number" data-ck="${c.k}" data-fld="a" value="${c.a}" step="1" style="margin-top:2px"></div>` +
      `<div style="width:70px"><label style="font-size:10px">U</label><input type="number" data-ck="${c.k}" data-fld="u" value="${c.u}" step="0.05" style="margin-top:2px"></div>` +
      `</div>`).join('');
    ti.innerHTML =
      `<div style="display:flex;flex-wrap:wrap;gap:8px">` +
      g('area', 'Beheizte Fläche m²', b.area, 5) + g('height', 'Raumhöhe m', b.height, 0.1) +
      g('hgt', 'Heizgradtage Kd/a', b.hgt, 100) + g('n', 'Luftwechsel 1/h', b.n, 0.1) +
      g('dhw', 'Warmwasser kWh th./a', b.dhw, 100) + g('cop_heat', 'COP Heizen', b.cop_heat, 0.1) +
      g('cop_dhw', 'COP Warmwasser', b.cop_dhw, 0.1) + g('gain', 'Gewinne-Anteil (0–0,3)', b.gain, 0.05) +
      `</div><div class="note" style="margin-top:10px;color:var(--muted)">Bauteile: Fläche & U-Wert (W/m²K)</div>` + comps;
    ti.dataset.built = '1';
  }
  $('hp-theory-assump').innerHTML =
    `Vereinfachtes U·A-Modell mit Heizgradtagen (Deutschland ~3500 Kd). Werte sind Startschätzungen aus deinen ` +
    `Angaben – bitte anpassen. Boden/Keller mit Faktor 0,5 (gegen Erdreich). Gewinne (Sonne/intern) pauschal ` +
    `abgezogen. Für eine belastbare Heizlast: Energieberater/GEG-Berechnung.`;

  // ---- Monatsansicht: Theorie vs. Praxis ------------------------------
  const hpSeasShare = normFrac(HP_SEASON);
  const theoryMonth = [];
  for (let m = 0; m < 12; m++) theoryMonth[m] = r.eHeat * hpSeasShare[m] + r.eDhw * DIM[m] / 365;
  const realMap = hpRealMonthMap();
  const mCard = $('hp-theory-month-card');
  if (mCard) {
    mCard.hidden = false;
    // Three series per month, each independently toggleable:
    //  • Theorie  – from the U·A building model
    //  • Gemessen – the real measured value (this year, or a previous year → then labelled "Vorjahr")
    //  • Erwartet – an experience-based expectation for EVERY month (your measured
    //               annual level × the seasonal shape), so unmeasured months (Nov/Dec)
    //               show a proper forecast bar instead of borrowing last year's number.
    const measured = hpMeasuredByMonth();
    // "Erwartet" = our best per-month model (hpModelMonth) for EVERY month – real-
    // anchored for the shoulder, building-model (theory) for the cold months that
    // have no representative measurement yet. NOT substituting the measured value,
    // so you can compare expectation vs. reality side by side.
    const expectedMonth = MON.map((_, m) => hpModelMonth(m));
    // year handling for the "measured" series label
    const years = measured ? [...new Set(Object.values(measured).map(v => v.year))] : [];
    const curY = new Date().getFullYear();
    const hasPrev = years.some(y => y < curY), hasCur = years.some(y => y >= curY);
    const measLabel = !measured ? 'Gemessen'
      : hasPrev && !hasCur ? `Vorjahr ${Math.max(...years)}`
        : hasPrev ? 'Gemessen / Vorjahr' : 'Gemessen';
    const lbl = $('thm-p-label'); if (lbl) lbl.textContent = measLabel;
    // checkbox state (persisted); measured checkbox disabled when no data
    const on = id => { const el = $(id); return el ? el.checked : true; };
    const pOn = !!measured && on('thm-p');
    if ($('thm-p')) $('thm-p').disabled = !measured;

    // high-contrast, well-separated hues (orange / blue / violet)
    const COLT = '#ff9f40', COLP = '#3d8bff', COLE = '#b07cff';
    const series = [];
    if (on('thm-t')) series.push({ key: 't', color: COLT, label: 'Theorie' });
    if (pOn) series.push({ key: 'p', color: COLP, label: 'Gemessen' });
    if (on('thm-e')) series.push({ key: 'e', color: COLE, label: 'Erwartet' });
    const rows = MON.map((lbl2, m) => ({
      label: lbl2, values: {
        t: theoryMonth[m],
        p: measured && measured[m] ? measured[m].kwh : 0,
        e: expectedMonth[m],
      } }));
    $('hp-theory-month').innerHTML = series.length
      ? `<div class="tmhit" style="touch-action:none">${groupedBar(rows, series, { h: 190 })}</div>`
      : '<div class="note">Alle Reihen ausgeblendet – oben wieder anhaken.</div>';
    // data for the tap/hover tooltip (kWh per bar, only enabled series)
    _thmHit = { rows, meas: measured, series: series.map(s => ({ key: s.key, color: s.color,
      label: s.key === 't' ? 'Theorie' : s.key === 'p' ? measLabel : 'Erwartet' })) };
    $('hp-theory-month-legend').innerHTML = legendHtml([
      on('thm-t') ? { color: COLT, label: 'Theorie' } : null,
      pOn ? { color: COLP, label: measLabel } : null,
      on('thm-e') ? { color: COLE, label: 'Erwartet (Erfahrung)' } : null,
    ].filter(Boolean)) + `<span style="color:var(--muted);font-size:11px;margin-left:6px">tippen für kWh je Monat</span>`;
    // Gesamtverbrauch je Kategorie (Jahressumme), respektiert die Häkchen
    const price = STATE.price;
    const theoTot = theoryMonth.reduce((a, b) => a + b, 0);
    const expTot = expectedMonth.reduce((a, b) => a + b, 0);
    let measTot = 0, measCnt = 0;
    if (measured) Object.keys(measured).forEach(m => { measTot += measured[m].kwh; measCnt++; });
    const totCard = (c, label, v) => `<div class="kpi sm"><div class="v" style="color:${c}">${kwh(v, 0)}</div>` +
      `<div class="l">${label} · ${money(v * price)}</div></div>`;
    $('hp-theory-month-tot').innerHTML = '<div class="grid3">' +
      (on('thm-t') ? totCard(COLT, 'Theorie / Jahr', theoTot) : '') +
      (pOn ? totCard(COLP, measCnt >= 12 ? measLabel + ' / Jahr' : `${measLabel} (${measCnt} Mon.)`, measTot) : '') +
      (on('thm-e') ? totCard(COLE, 'Erwartet / Jahr', expTot) : '') + '</div>';
    // note: compare measured vs theory over the measured months
    if (measured) {
      let worst = null, sT = 0, sP = 0;
      Object.keys(measured).forEach(mk => {
        const m = +mk;
        if (measured[m].partial) return;           // don't judge the extrapolated current month
        const abs = measured[m].kwh - theoryMonth[m];
        sT += theoryMonth[m]; sP += measured[m].kwh;
        if (!worst || Math.abs(abs) > Math.abs(worst.abs)) worst = { m, abs };
      });
      const totPct = sT > 0 ? (sP - sT) / sT : 0;
      const prevMonths = Object.keys(measured).filter(m => measured[m].year < curY && !measured[m].partial).map(m => MON[+m]);
      const partMonth = Object.keys(measured).find(m => measured[m].partial);
      const projMonths = Object.keys(measured).filter(m => measured[m].projected).map(m => MON[+m]);
      $('hp-theory-month-note').innerHTML =
        'Drei Reihen je Monat – oben ein-/ausblendbar: <b>Theorie</b> (Gebäudemodell), <b>' + esc(measLabel) +
        '</b> (echte Messung, Bauphase vor dem im Setup gesetzten Bauphasen-Ende ausgeblendet) und <b>Erwartet</b> ' +
        '(Frühjahr–Herbst: dein gemessenes Niveau × Saison-Form; <b>Nov–Feb: Theorie</b>, solange kein echter Winter gemessen ist). ' +
        (sT > 0 ? `Über die voll gemessenen Monate liegt die Praxis <b>${totPct >= 0 ? '+' : ''}${fmt(totPct * 100, 0)} %</b> zur Theorie.` : '') +
        (worst ? ` Größter Unterschied im <b>${MON[worst.m]}</b> (${worst.abs >= 0 ? '+' : '−'}${kwh(Math.abs(worst.abs), 0)}` +
          `${worst.abs > 0 ? ' – mehr als gerechnet' : ' – weniger, z. B. kaum geheizt/effizient'}).` : '') +
        (partMonth != null ? ` <span style="color:var(--muted)"><b>${MON[+partMonth]}</b> läuft noch – auf den ganzen Monat <b>hochgerechnet</b> (bisher ${kwh(measured[+partMonth].actual || 0, 0)}).</span>` : '') +
        (projMonths.length ? ` <span style="color:var(--muted)">Nur teilweise gemessen und auf den vollen Monat <b>hochgerechnet</b> (die Bridge lief erst einen Teil des Monats): ${projMonths.join(', ')}.</span>` : '') +
        (prevMonths.length ? ` <span style="color:var(--muted)">Echte Messung aus dem Vorjahr (nach Bauphasen-Ende): ${prevMonths.join(', ')}.</span>` : '') +
        ` <span style="color:var(--muted)">Sobald du Nov/Dez bzw. Jan/Feb echt misst, ersetzt das die Theorie automatisch.</span>`;
    } else {
      $('hp-theory-month-note').innerHTML = 'Zwei Reihen: <b>Theorie</b> (Gebäudemodell) und <b>Erwartet</b> ' +
        '(aus deinem gemessenen Niveau, saisonal verteilt). Für echte Monatsmesswerte importiere im Setup eine ' +
        '<b>HomeCom-CSV</b> – dann kommt die Reihe „Gemessen" dazu.';
    }
  }

  // ---- Gebäude-Einordnung (kWh/m²·a Heizwärmebedarf) -------------------
  const spec = b.area > 0 ? r.qHeat / b.area : 0;
  const [cls, col] = buildClass(spec);
  // measured counterpart per m²: real heating thermal / electricity, total house
  // electricity and PV generation – all per m² of heated area.
  const area = b.area > 0 ? b.area : 0;
  // measured annual WP electricity + thermal heat – from monthly/CSV if present,
  // else the counter-based year estimate (works without a CSV import).
  const measYearElec = measured || (A && A.stats && A.stats.year_estimate_kwh) ||
    (A && A.counter && A.counter.avg_daily_elec_kwh ? A.counter.avg_daily_elec_kwh * 365 : null);
  const measYearHeat = (A && A.counter && A.counter.avg_daily_heat_kwh ? A.counter.avg_daily_heat_kwh * 365 : null) ||
    (measYearElec && copMeas ? measYearElec * copMeas : null);
  let realSpec = null, heatElecM2 = null, elecM2 = null, pvM2 = null, pvCover = null, pvYield = null;
  if (area > 0 && measYearElec) {
    const heatFrac = r.eTotal > 0 ? r.eHeat / r.eTotal : 1;          // model heating share of WP elec
    heatElecM2 = measYearElec * heatFrac / area;
    if (measYearHeat) realSpec = Math.max(0, measYearHeat - b.dhw) / area;  // heating thermal /m²
    const shYear = Math.max(0, shAvgDaily() * 365);
    elecM2 = (shYear + measYearElec) / area;
    try {
      const pin = pvInputs();
      if (pin.kwp > 0) { pvYield = simulatePv(pin).yield_kwh; pvM2 = pvYield / area; pvCover = (shYear + measYearElec) > 0 ? pvYield / (shYear + measYearElec) : null; }
    } catch (e) {}
  }
  $('hp-theory-class').innerHTML = classBar(spec, realSpec);
  $('hp-theory-class-note').innerHTML = `Dein <b>spezifischer Heizwärmebedarf</b> (Modell) ist ~<b style="color:${col}">` +
    `${fmt(spec, 0)} kWh/m²·a</b> → <b>${cls}</b>. Zum Einordnen: Passivhaus &lt;15, KfW ~30–45, Neubau ~55–70, ` +
    `unsanierter Altbau ~150–250. (Nur Heizung, ohne Warmwasser; <span style="color:#fff">weißer Marker</span>.)`;
  // real / measured per m²
  const realEl = $('hp-theory-real');
  if (realEl) {
    if (!area || !measYearElec) {
      realEl.innerHTML = '<div class="note">Für die <b>gemessenen</b> Werte je m² fehlen noch Daten – trage die ' +
        '<b>beheizte Fläche</b> ein (oben) und lass die Wärmepumpe mitlaufen (oder importiere eine HomeCom-CSV).</div>';
    } else {
      const rows = [];
      if (realSpec != null) {
        const [rcls, rcol] = buildClass(realSpec);
        const d = spec > 0 ? (realSpec - spec) / spec : 0;
        rows.push(devRow('Heizwärme gemessen', `thermisch · <b style="color:${rcol}">${rcls}</b>`,
          `${fmt(realSpec, 0)} kWh/m²·a`, Math.abs(d) < 0.12 ? '≈ Modell' : (d < 0 ? `${fmt(-d * 100, 0)}% unter Modell` : `${fmt(d * 100, 0)}% über Modell`),
          Math.min(100, realSpec / 200 * 100), '#3ba9ff'));
      }
      if (heatElecM2 != null) rows.push(devRow('Heizstrom gemessen', 'Strom nur fürs Heizen', `${fmt(heatElecM2, 0)} kWh/m²·a`, money(heatElecM2 * area * STATE.price) + '/Jahr', Math.min(100, heatElecM2 / 80 * 100), COL.hp));
      if (elecM2 != null) rows.push(devRow('Haushaltsstrom gesamt', 'Smart Home + Wärmepumpe', `${fmt(elecM2, 0)} kWh/m²·a`, '', Math.min(100, elecM2 / 120 * 100), COL.sh));
      if (pvM2 != null) rows.push(devRow('PV-Erzeugung', pvCover != null ? `deckt ~${fmt(pvCover * 100, 0)}% deines m²-Strombedarfs` : 'je m² Wohnfläche', `${fmt(pvM2, 0)} kWh/m²·a`, kwh(pvYield, 0) + '/Jahr', Math.min(100, pvM2 / 120 * 100), COL.pv));
      // data basis: which months are actually measured + from CSV or the counter
      const MABB = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
      const fmtYM = ym => { const p = String(ym).split('-'); const mi = parseInt(p[1], 10) - 1; return (MABB[mi] || p[1]) + ' ' + p[0]; };
      const im = A && A.imported, cnt = A && A.counter;
      let basis;
      if (measured && im && im.months) {
        basis = `importierte <b>HomeCom-CSV</b> (${im.months} Monate, ${im.days} Tage` +
          (im.seasonal_cop ? `, JAZ ${fmt(im.seasonal_cop, 2)}` : '') + ')';
      } else if (cnt && (cnt.observed_months || cnt.span_days)) {
        const oms = (cnt.observed_months || []).map(fmtYM);
        const span = oms.length >= 2 ? `${oms[0]} – ${oms[oms.length - 1]}` : (oms[0] || '');
        basis = `dem laufenden <b>WP-Zähler</b> über <b>${fmt(cnt.span_days || 0, 0)} gemessene Tage</b>` +
          (span ? ` (${oms.length >= 2 ? '' : 'Monat '}<b>${span}</b>)` : '');
      } else if (A && A.stats) {
        basis = `der <b>Zähler-Jahresschätzung</b> der Wärmepumpe`;
      } else {
        basis = `den gemessenen WP-Daten`;
      }
      const heatBasis = (cnt && cnt.avg_daily_heat_kwh)
        ? 'der <b>gemessenen Wärmemenge</b> (WP-Wärmezähler)'
        : 'dem <b>gemessenen Strom × Jahresarbeitszahl</b>';
      realEl.innerHTML = `<div style="font-weight:700;font-size:13px;margin-bottom:6px">🔎 Real je m² (gemessen)` +
        (realSpec != null ? ` <span style="font-weight:400;color:#3ba9ff;font-size:12px">· blauer Marker oben</span>` : '') + `</div>` +
        rows.join('') +
        `<div class="note" style="margin-top:8px"><b>Basis:</b> ${basis}, aufs Jahr hochgerechnet und durch die ` +
        `beheizte Fläche (${fmt(area, 0)} m²) geteilt. Die <b>Heizwärme je m²</b> stammt aus ${heatBasis} (Warmwasser herausgerechnet)` +
        (pvM2 != null ? ', die <b>PV-Erzeugung</b> aus deiner PV-Auslegung (PV-Tab)' : '') + '. ' +
        `Je <b>weniger Monate</b> bisher gemessen wurden, desto gröber die Hochrechnung. Die Heizwärme hängt zudem vom <b>Wetter</b> ab: ` +
        `ein milder Zeitraum liegt <b>unter</b> dem Modell-Bedarf (Auslegung), ein kalter <b>darüber</b> – erst über eine volle Heizsaison nähern sich beide Marker an.</div>`;
    }
  }

  // ---- Sanierung: Ersparnis-Ranking + Amortisation --------------------
  const measures = [];
  b.comps.forEach(c => {
    const t = RENO[c.k]; if (!t || c.u <= t.u) return;
    const saveKwh = (c.u - t.u) * c.a * c.f * r.factor * (1 - b.gain) / b.cop_heat;
    if (saveKwh < 20) return;
    const cost = t.cost * c.a * c.f;
    const saveEur = saveKwh * price;
    measures.push({ l: t.l, saveKwh, saveEur, cost, u0: c.u, u1: t.u,
      payback: (cost > 0 && saveEur > 0) ? cost / saveEur : null });
  });
  measures.sort((a, z) => z.saveKwh - a.saveKwh);
  const maxSave = measures.length ? measures[0].saveKwh : 1;
  $('hp-theory-reno').innerHTML = measures.length
    ? measures.map(m => devRow(m.l,
        `U ${fmt(m.u0, 2)} → ${fmt(m.u1, 2)}${m.payback ? ` · grobe Kosten ~${money(m.cost)} · Amortisation ~${fmt(m.payback, 0)} J.` : ''}`,
        money(m.saveEur) + '/J.', kwh(m.saveKwh, 0), m.saveKwh / maxSave * 100,
        m.saveKwh === maxSave ? COL.hp : COL.sh)).join('')
    : '<div class="note">Alle Bauteile sind schon gut gedämmt – kein großer Hebel mehr. 👍</div>';

  // ---- Temperatur-Hebel -----------------------------------------------
  $('hp-theory-temp-head').innerHTML = '🌡️ <b>Raumtemperatur:</b> je 1 °C ≈ 6 % Heizenergie:';
  const tempRows = [[-2, 'kühler'], [-1, 'kühler'], [1, 'wärmer']].map(([d, w]) => {
    const dk = r.eHeat * 0.06 * Math.abs(d);
    return statusRow(`${Math.abs(d)} °C ${w}`, `${d < 0 ? 'spart' : 'kostet'} ~${kwh(dk, 0)} · ${money(dk * price)}/Jahr`);
  }).join('');
  $('hp-theory-temp').innerHTML = tempRows;
  $('hp-theory-reno-note').innerHTML = 'Ersparnis-Schätzung aus dem U·A-Modell – reale Kosten/Nutzen hängen von ' +
    'Bauausführung und Förderung ab. Reihenfolge zeigt den <b>größten Hebel zuerst</b>.';
}

// Volume flow through the heat pump for the live card: read from the device
// when it offers one, otherwise derived (heat ÷ spread) – always labelled, and
// when there is no value yet the line says why instead of disappearing.
function hpFlowLine(F, l) {
  const tag = (t, c) => ` <span style="font-size:11px;color:${c};border:1px solid ${c};border-radius:6px;padding:0 5px;white-space:nowrap">${t}</span>`;
  const sub = txt => `<br><small style="color:var(--muted)">${txt}</small>`;
  const mode = String((l && l.mode) || '').toLowerCase();
  const running = l && (l.modulation || 0) > 0;
  const heatingNow = running && (/^(ch|heat)/.test(mode));
  if (!F) return '<span style="color:var(--muted)">–</span>' + sub('kommt mit dem Bridge-Update (ab v190)');
  const n = F.now, sys = F.system || {}, D = F.derived || {};
  if (n && n.src === 'gelesen') {
    return `${fmt(n.l_min, 1)} l/min` + tag('gelesen', '#4be0b0') +
      (n.mode === 'dhw' ? sub('gerade Warmwasser-Ladung') : '');
  }
  if (n && n.src === 'abgeleitet') {
    return `≈ ${fmt(n.l_min, 1)} l/min` + tag('abgeleitet', '#ffb64d') +
      sub(n.typical ? 'Mittel der letzten Heizläufe – dieser Lauf allein ist zu kurz für den Wärmezähler'
        : `aus Wärmemenge ÷ Spreizung (${fmt(n.dt_k, 1)} K) im aktuellen Heizlauf`) +
      (n.sure === false ? sub('noch unsicher – zu wenige oder zu kurze Läufe') : '');
  }
  if (sys.l_min != null) {
    const why = heatingNow ? 'typisch im Heizbetrieb – der aktuelle Lauf ist noch zu kurz für einen eigenen Wert'
      : (running && mode === 'dhw' ? 'typisch im Heizbetrieb – gerade läuft Warmwasser'
        : 'typisch im Heizbetrieb (letzte 14 Tage) – die Wärmepumpe heizt gerade nicht');
    return `${sys.src === 'abgeleitet' ? '≈ ' : ''}${fmt(sys.l_min, 1)} l/min` +
      tag(sys.src, sys.src === 'gelesen' ? '#4be0b0' : '#ffb64d') + sub(why);
  }
  return '<span style="color:var(--muted)">noch kein Wert</span>' +
    sub(esc(D.why || 'wird nach dem ersten längeren Heizlauf berechnet'));
}

function renderHeatpump() {
  const A = STATE.hpA; if (!A) return;
  const l = A.live || {};
  const connected = A.connected;
  const body = $('hp-body');
  if (!connected && !(A.daily && A.daily.length)) {
    body.innerHTML = '<div class="note">Noch nicht verbunden. Im <b>Setup</b> unter „Wärmepumpe (HomeCom)" koppeln.</div>';
  } else {
    const rows = [];
    if (l.power_w != null) rows.push(['Aktuelle Leistung (elektrisch)', fmt(l.power_w, 0) + ' W']);
    if (l.heat_w != null) rows.push(['Wärmeleistung', fmt(l.heat_w / 1000, 1) + ' kW']);
    if (l.cop_live) rows.push(['Wirkungsgrad jetzt (COP)', fmt(l.cop_live, 2)]);
    if (l.energy_kwh != null) {
      const sp = [];
      if (l.compressor_kwh != null) sp.push('Kompressor ' + kwh(l.compressor_kwh, 0));
      if (l.eheater_kwh != null) sp.push('Heizstab ' + kwh(l.eheater_kwh, 0));
      rows.push(['Stromverbrauch gesamt', kwh(l.energy_kwh, 0) +
        (sp.length ? `<br><small style="color:var(--muted)">${sp.join(' · ')}</small>` : '')]);
    }
    if (l.heat_kwh != null) rows.push(['Wärme erzeugt gesamt', kwh(l.heat_kwh, 0)]);
    if (l.cop_lifetime != null) rows.push(['Jahresarbeitszahl (∅ COP)', fmt(l.cop_lifetime, 2)]);
    if (l.outdoor_c != null) rows.push(['Außentemperatur', fmt(l.outdoor_c, 1) + ' °C']);
    if (l.supply_c != null && l.return_c != null) {
      const dt = l.supply_c - l.return_c;
      rows.push(['Vor-/Rücklauf', fmt(l.supply_c, 1) + ' / ' + fmt(l.return_c, 1) + ' °C' +
        `<br><small style="color:var(--muted)">Spreizung ${fmt(dt, 1)} K</small>`]);
    }
    if (connected) rows.push(['Volumenstrom', hpFlowLine(A.flow, l)]);
    const sun = hpSunLine();
    if (sun) rows.push(['Sonnenstrom', sun]);
    let taktNote = '';
    if (l.starts != null) {
      let extra = '';
      if (l.working_h != null && l.starts > 0) {
        const runMin = l.working_h / l.starts * 60;             // Ø minutes per compressor start (lifetime)
        const rating = runMin >= 60 ? ['ruhig, effizient', '#4be0b0'] : runMin >= 20 ? ['ok', '#f6b93b'] : ['häufiges Takten', '#ef6c4d'];
        extra = `<br><small style="color:var(--muted)">Ø Laufzeit je Start: <b style="color:${rating[1]}">` +
          `${runMin >= 90 ? fmt(runMin / 60, 1) + ' h' : fmt(runMin, 0) + ' min'}</b> (${rating[0]})</small>`;
        if (runMin < 20) taktNote = `<div class="note" style="margin-top:8px">⚠️ <b>Kurzes Takten:</b> im Schnitt nur ` +
          `${fmt(runMin, 0)} min je Kompressorstart. Häufiges Ein-/Ausschalten senkt Effizienz und Lebensdauer. ` +
          `Mögliche Ursachen: zu hohe Heizkurve bei mildem Wetter, überdimensionierte Leistung, zu kleiner Pufferspeicher ` +
          `oder zugedrehte Heizkreise. Eine niedrigere Heizkurve und offene Heizflächen helfen oft. ` +
          `<span style="color:var(--muted)">Wert über die gesamte Laufzeit gemittelt.</span></div>`;
      }
      rows.push(['Starts / Betriebsstunden', fmt(l.starts, 0) + (l.working_h != null ? ' / ' + fmt(l.working_h, 0) + ' h' : '') + extra]);
    }
    const lpAge = l.last_poll ? Date.now() / 1000 - l.last_poll : null;
    const since = l.last_poll ? new Date(l.last_poll * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;
    const hpWarn = l.last_error
      ? `<div class="note" style="margin:0 0 10px;border-left:3px solid #ff6b8a;padding-left:10px">⚠︎ <b>Keine neuen Werte von der Wärmepumpe</b>` +
        `${since ? ' (letzte von ' + since + ')' : ''}: ${esc(l.last_error)}<br><a href="#" data-hp-diag="1" style="color:var(--accent)">Verbindung zur Bosch-Cloud testen</a></div>`
      : (lpAge != null && lpAge > 1500
        ? `<div class="note" style="margin:0 0 10px;border-left:3px solid #ffb64d;padding-left:10px">⚠︎ Die Werte sind von ${since} – seitdem kam nichts Neues. ` +
          '<a href="#" data-hp-diag="1" style="color:var(--accent)">Verbindung testen</a></div>' : '');
    body.innerHTML = hpWarn + `<div class="note" style="margin:-2px 0 10px">${hpStatusPill(l)}</div>` +
      (rows.length ? rows.map(([k, v]) => statusRow(k, v)).join('')
        : '<div class="note">Verbunden – warte auf die erste Messung.</div>') +
      taktNote +
      ((connected && (l.power_w == null || l.heat_w == null))
        ? '<div class="note" style="margin-top:8px">Leistung & COP erscheinen nach der zweiten Messung (Zählerdifferenz).</div>' : '');
  }

  renderHpForecast();
  $('hp-today-e').innerHTML = kwh(A.today.elec_kwh, 2);
  $('hp-today-h').innerHTML = kwh(A.today.heat_kwh, 1);
  $('hp-scop').innerHTML = A.stats.seasonal_cop != null ? fmt(A.stats.seasonal_cop, 2) : '–';
  $('hp-cost').innerHTML = money(A.stats.window_cost);

  // "wofür": heating vs hot water (window)
  const mw = A.mode_window || { heating: 0, water: 0, other: 0 };
  const mSegs = [
    { label: 'Heizung', value: mw.heating || 0, color: COL.hp },
    { label: 'Warmwasser', value: mw.water || 0, color: COL.heat },
    { label: 'Sonstiges', value: mw.other || 0, color: '#b07a4d' },
    { label: 'Betriebsart unbekannt (Datenlücke)', value: mw.gap || 0, color: HP_GAP_COL },
  ].filter(s => s.value > 0.01);
  const mTot = mSegs.reduce((a, s) => a + s.value, 0);
  const mKnown = mTot - (mw.gap > 0.01 ? mw.gap : 0);
  $('hp-mode-sum').textContent = mTot > 0 ? kwh(mTot, 0) : '';
  $('hp-mode-donut').innerHTML = mSegs.length
    ? donutChart(mSegs, { big: mTot >= 100 ? fmt(mTot, 0) : fmt(mTot, 1), center: 'kWh Strom' })
    : '<div class="note">Sobald die Bridge Betriebsdaten gesammelt hat, erscheint hier die Aufteilung Heizung/Warmwasser.</div>';
  $('hp-mode-legend').innerHTML = legendHtml(mSegs.map(s => ({
    label: s.label, color: s.color, sub: kwh(s.value, 0) + ' · ' + (s.value / mTot * 100).toFixed(0) + ' %' })));
  // warm-water: annual electricity & cost, plus an optimisation hint
  const nDays = (A.daily || []).length;
  const waterKwh = mw.water || 0;
  if (waterKwh > 0.01 && nDays > 0 && mKnown > 0) {
    const price = STATE.price;
    // share of the energy whose mode is known; the gap is assumed to split alike
    const waterYear = mwWater(mw) / nDays * 365, waterCost = waterYear * price;
    const sharePct = waterKwh / mKnown * 100;
    const cbhW = ((A.imported && A.imported.cop_by_hour) || []).filter(x => x.water_kwh > 0);
    let tip;
    if (cbhW.length) {
      const wpk = cbhW.reduce((a, b) => b.water_kwh > a.water_kwh ? b : a);
      tip = (wpk.hour >= 10 && wpk.hour <= 15)
        ? `Deine Warmwasser-Bereitung liegt schon gut in der <b>Mittagszeit</b> (${wpk.hour}:00 Uhr) – ideal für PV/günstigen Börsenstrom.`
        : `Meiste Bereitung gegen <b>${wpk.hour}:00 Uhr</b>. Per Zeitprogramm in die <b>Mittagszeit</b> verlegt, nutzt du PV/günstige Stunden und die WP arbeitet effizienter (wärmere Luft).`;
    } else {
      tip = `Bereite Warmwasser möglichst <b>mittags</b> (PV/günstiger Börsenstrom, wärmere Luft = besserer COP) und halte die Temperatur moderat (Legionellenschaltung ~1×/Woche auf 60&nbsp;°C reicht) – das spürst du direkt hier.`;
    }
    $('hp-mode-note').innerHTML = `🚿 <b>Warmwasser</b>: ~<b>${kwh(waterYear, 0)}/Jahr</b> Strom (~${money(waterCost)}), ` +
      `${fmt(sharePct, 0)} % des Wärmepumpen-Stroms` + (mw.gap > 0.01 ? ' mit bekannter Betriebsart' : '') + '. ' + tip +
      (mw.gap > 0.01 ? hpGapNote(mw.gap) : '');
  } else { $('hp-mode-note').innerHTML = mw.gap > 0.01 ? hpGapNote(mw.gap).replace(/^<br>/, '') : ''; }

  const daily = (A.daily || []).slice(-30);
  $('hp-daily').innerHTML = daily.length ? groupedBar(
    daily.map(d => ({ label: shortDay(d.day), values: { e: d.elec_kwh, h: d.heat_kwh } })),
    [{ key: 'e', color: COL.hp }, { key: 'h', color: COL.heat }], { h: 200, unit: 'kWh' })
    : '<div class="note">Noch keine Historie – die Bridge baut sie beim Pollen auf.</div>';

  const cops = daily.filter(d => d.cop != null);
  $('hp-cop-chart').innerHTML = cops.length ? areaChart(
    cops.map(d => ({ v: d.cop, label: shortDay(d.day) })), { h: 180, stroke: COL.heat, fill: 'url(#gHeat)' })
    : '<div class="note">COP erscheint, sobald Strom- und Wärmezähler Historie haben.</div>';
  if (cops.length) {
    const best = cops.reduce((a, b) => b.cop > a.cop ? b : a);
    $('hp-cop-note').innerHTML = `Ø COP im Zeitraum: <b>${fmt(A.stats.seasonal_cop, 2)}</b>. ` +
      `Bester Tag: ${fmt(best.cop, 2)} (${longDay(best.day)}). Höher = effizienter.`;
  } else { $('hp-cop-note').textContent = ''; }

  // efficiency vs outdoor temperature
  const ct = A.cop_by_temp || [];
  $('hp-coptemp').innerHTML = ct.length
    ? areaChart(ct.map(d => ({ v: d.cop, label: d.temp + '°' })), { h: 180, stroke: '#4be0b0', fill: 'url(#gArea)' })
    : '<div class="note">Zu wenig Daten – die Kurve entsteht über mehrere Tage mit unterschiedlichem Wetter.</div>';
  if (ct.length >= 2) {
    const warm = ct[ct.length - 1], cold = ct[0];
    $('hp-coptemp-note').innerHTML = `Bei <b>${warm.temp}&nbsp;°C</b>: COP&nbsp;${fmt(warm.cop, 2)}, ` +
      `bei <b>${cold.temp}&nbsp;°C</b>: ${fmt(cold.cop, 2)}.` +
      (warm.cop >= cold.cop ? ' Wärmere Luft = effizienter (typisch für Wärmepumpen).' : '');
  } else { $('hp-coptemp-note').textContent = ''; }

  // COP by hour of day (from imported hourly history)
  const cbh = (A.imported && A.imported.cop_by_hour) || [];
  const cbhV = cbh.filter(x => x.cop != null);
  const cophCard = $('hp-cophour-card');
  if (cbhV.length >= 4) {
    cophCard.hidden = false;
    $('hp-cophour').innerHTML = areaChart(
      cbhV.map(x => ({ v: x.cop, label: x.hour + '' })),
      { h: 170, stroke: '#4be0b0', fill: 'url(#gArea)' });
    const best = cbhV.reduce((a, b) => b.cop > a.cop ? b : a);
    const worst = cbhV.reduce((a, b) => b.cop < a.cop ? b : a);
    $('hp-cophour-note').innerHTML = `Am effizientesten gegen <b>${best.hour}:00 Uhr</b> (COP ${fmt(best.cop, 2)}), ` +
      `am schwächsten um <b>${worst.hour}:00 Uhr</b> (${fmt(worst.cop, 2)}). ` +
      `Warmwasser & flexible Wärme also möglichst in die <b>Mittagszeit</b> legen (wärmer = effizienter, dazu PV). ` +
      `<span style="color:var(--muted)">Basis: ${A.imported.hours || 0} importierte Stunden.</span>`;
  } else { cophCard.hidden = true; }

  const m = A.monthly || [];
  $('hp-monthly').innerHTML = m.length ? groupedBar(
    m.map(x => ({ label: MON[parseInt(x.month.slice(5), 10) - 1], values: { e: x.elec_kwh, h: x.heat_kwh } })),
    [{ key: 'e', color: COL.hp }, { key: 'h', color: COL.heat }], { h: 180, unit: 'kWh' })
    : '<div class="note">Noch keine vollen Monate.</div>';

  // COP per month (efficiency over the year)
  const mc = m.filter(x => x.cop != null && x.cop > 0);
  const mcCard = $('hp-copmonth-card');
  if (mcCard) {
    if (mc.length >= 2) {
      mcCard.hidden = false;
      $('hp-copmonth').innerHTML = barChart(
        mc.map(x => ({ v: x.cop, label: MON[parseInt(x.month.slice(5), 10) - 1], color: 'url(#gHeat)' })), { h: 170 });
      const best = mc.reduce((a, b) => b.cop > a.cop ? b : a), worst = mc.reduce((a, b) => b.cop < a.cop ? b : a);
      $('hp-copmonth-note').innerHTML = `Bester Monat <b>${MON[+best.month.slice(5) - 1]}</b> (COP ${fmt(best.cop, 2)}), ` +
        `schwächster <b>${MON[+worst.month.slice(5) - 1]}</b> (${fmt(worst.cop, 2)}). Winter meist niedriger ` +
        `(kalte Luft, Heizstab), Sommer höher (v. a. Warmwasser bei milden Temperaturen).`;
    } else { mcCard.hidden = true; }
  }

  // heatmap with month selector; empty cells filled with the hour average
  const hm = A.heatmap_monthly || {};
  const sel = $('hp-heat-month');
  if (sel) {
    const want = sel.value;
    const opts = ['<option value="">Gesamt</option>'].concat(
      Object.keys(hm).sort().map(k => {
        const mi = +k.slice(5) - 1;
        return `<option value="${k}"${k === want ? ' selected' : ''}>${MON[mi]} ${k.slice(0, 4)}</option>`;
      }));
    sel.innerHTML = opts.join('');
    const grid = want && hm[want] ? hm[want] : A.heatmap;
    const has = (grid || []).some(r => r.some(v => v > 0));
    $('hp-heat').innerHTML = has ? heatmap(fillHeatmap(grid)) : '<div class="note">Für diesen Zeitraum noch keine Daten.</div>';
  }

  const impHrs = (STATE.health && STATE.health.hp_import && STATE.health.hp_import.hours) || 0;
  if ($('hp-heat-note')) $('hp-heat-note').innerHTML = 'Wochentag × Stunde · Ø elektrische Leistung (W). ' +
    (impHrs ? `Enthält ${impHrs} importierte Stunden. ` : '') +
    'Leere Zellen sind mit dem Stunden-Ø gefüllt; ein volles Muster entsteht mit mehr Stundendaten (Polling oder CSV-Export mit größerem Stundenbereich).';

  // calendar heatmap of daily electricity: real daily where available, else a
  // monthly average per day so the whole year is shown when only months exist.
  const calDays = {}, calEst = {};
  ((A.imported && A.imported.daily) || []).forEach(d => { if (d.elec_kwh != null) calDays[d.date] = d.elec_kwh; });
  (A.daily || []).forEach(d => { if (calDays[d.day] == null && d.elec_kwh != null) calDays[d.day] = d.elec_kwh; });
  const monMap = {}; ((A.imported && A.imported.monthly) || []).forEach(x => monMap[x.month] = x.elec_kwh);
  const calCard = $('hp-cal-card');
  const monthsSet = [...new Set([...Object.keys(calDays).map(k => k.slice(0, 7)), ...Object.keys(monMap)])].sort();
  if (Object.keys(calDays).length >= 3 || Object.keys(monMap).length >= 2) {
    calCard.hidden = false;
    const rows = monthsSet.map(ym => {
      const [y, mo] = ym.split('-').map(Number);
      const dim = new Date(y, mo, 0).getDate();
      const monAvg = monMap[ym] != null ? monMap[ym] / dim : null;
      const days = [];
      for (let dd = 1; dd <= dim; dd++) {
        const key = `${ym}-${String(dd).padStart(2, '0')}`;
        if (calDays[key] != null) days.push({ day: dd, v: calDays[key] });
        else if (monAvg != null) { days.push({ day: dd, v: monAvg, est: true }); calEst[key] = monAvg; }
        else days.push({ day: dd, v: null });
      }
      return { label: MON[mo - 1] + ' ' + String(y).slice(2), dim, days };
    });
    $('hp-cal').innerHTML = calendarHeatmap(rows);
    const realN = Object.keys(calDays).length;
    const allK = Object.keys(calDays);
    const peak = allK.length ? allK.reduce((a, k) => calDays[k] > calDays[a] ? k : a, allK[0]) : null;
    $('hp-cal-note').innerHTML = `Jede Zelle = ein Tag (heller/röter = mehr Strom). <b>${realN}</b> Tage tag-genau gemessen; ` +
      `Monate ohne Tagesdaten sind <b>gleichmäßig aus dem Monatswert</b> gefärbt (importierte CSV).` +
      (peak ? ` Stärkster gemessener Tag: <b>${longDay(peak)}</b> mit ${kwh(calDays[peak], 1)}.` : '');
  } else { calCard.hidden = true; }

  // seasonal forecast for the heat pump
  const hpA = hpAvgDaily(), mo = new Date().getMonth();
  const im = A.imported;
  const yearE = hpYearFromMonthly() || hpA * 365;
  const scop = (im && im.seasonal_cop) || A.stats.seasonal_cop;
  if (yearE > 0) {
    const basis = im && im.year_elec_kwh
      ? `aus importierter Historie (${im.months} Monate)`
      : 'saisonal geschätzt';
    $('hp-forecast').innerHTML = [
      ['Voraussichtl. Strom / Jahr', `${kwh(yearE, 0)} · ${money(yearE * STATE.price)}`],
      [`Prognose ${MON[mo]}`, `${kwh(hpMonthEst(mo), 0)} · ${money(hpMonthEst(mo) * STATE.price)}`],
      ['Heizsaison (Jan) vs. Sommer (Jul)', `${kwh(hpMonthEst(0), 0)} ↔ ${kwh(hpMonthEst(6), 0)} pro Monat`],
      ['Ø Arbeitszahl (Jahr)', scop != null ? fmt(scop, 2) : '–'],
      ['Basis', basis],
    ].map(([k, v]) => statusRow(k, v)).join('');
  } else {
    $('hp-forecast').innerHTML = '<div class="note">Prognose erscheint, sobald die Wärmepumpe ein paar Tage Daten geliefert hat – oder importiere eine HomeCom-CSV im Setup.</div>';
  }

  renderHeatDemand();
}

/* --------------------------------------------------------------- profile */
function renderProfile() {
  const data = STATE.data; if (!data) return;
  const prof = data.hourly_profile;
  $('chart-hourly').innerHTML = areaChart(prof.map(h => ({ v: h.avg_w, label: h.hour % 3 === 0 ? h.hour + '' : '', full: h.hour + ':00 Uhr', tip: `<b>${h.hour}:00 Uhr</b>: Ø <b>${fmt(h.avg_w, 0)} W</b>` })), { h: 190, unit: 'W' });
  const peak = prof.reduce((a, b) => b.avg_w > a.avg_w ? b : a);
  const low = prof.reduce((a, b) => b.avg_w < a.avg_w ? b : a);
  const nDays = (data.daily || []).length;
  const basis = `<span style="color:var(--muted)">Basis: Ø über ${nDays} gemessene Tage – nicht nur heute.</span>`;
  $('profile-note').innerHTML = `Höchste Ø-Leistung um <b>${peak.hour}:00 Uhr</b> (${fmt(peak.avg_w, 1)} W), ` +
    `niedrigste um <b>${low.hour}:00 Uhr</b>. Typische Aktivitätszeiten im Haushalt. ` + basis;
  $('chart-weekday').innerHTML = barChart(data.weekday_profile.map(w => ({ v: w.avg_kwh, label: WD[w.weekday] })), { h: 170 });
  if ($('profile-weekday-note')) $('profile-weekday-note').innerHTML = basis;
  $('chart-heat').innerHTML = data.heatmap ? heatmap(fillHeatmap(data.heatmap)) : '<div class="note">Keine Heatmap-Daten.</div>';
  if ($('profile-heat-note')) $('profile-heat-note').innerHTML =
    `Dunkel = wenig, hell = viel. ${basis} Leere Zellen sind mit dem Stunden-Ø gefüllt.`;

  // insights & patterns (guarded against thin data)
  const sumRange = (a, b) => prof.filter(h => h.hour >= a && h.hour < b).reduce((s, h) => s + h.avg_w, 0);
  const morning = sumRange(6, 12), afternoon = sumRange(12, 18), evening = sumRange(18, 24), night = sumRange(0, 6);
  const dayTot = morning + afternoon + evening + night || 1;
  const share = v => (v / dayTot * 100).toFixed(0) + ' %';
  const wkAll = data.weekday_profile, wk = wkAll.filter(w => w.avg_kwh > 0);
  const weekdayVals = wkAll.filter(w => w.weekday < 5 && w.avg_kwh > 0).map(w => w.avg_kwh);
  const weekendVals = wkAll.filter(w => w.weekday >= 5 && w.avg_kwh > 0).map(w => w.avg_kwh);
  const m = new Date().getMonth();
  const season = m <= 1 || m === 11 ? 'Winter' : m <= 4 ? 'Frühling' : m <= 7 ? 'Sommer' : 'Herbst';
  const rows = [['Tagesphasen', `Morgens ${share(morning)} · Mittags ${share(afternoon)} · Abends ${share(evening)} · Nachts ${share(night)}`]];
  if (wk.length >= 2) {
    const busiest = wk.reduce((a, b) => b.avg_kwh > a.avg_kwh ? b : a);
    const calmest = wk.reduce((a, b) => b.avg_kwh < a.avg_kwh ? b : a);
    rows.push(['Aktivster / ruhigster Tag', `${WD[busiest.weekday]} (${kwh(busiest.avg_kwh, 2)}) ↔ ${WD[calmest.weekday]} (${kwh(calmest.avg_kwh, 2)})`]);
  }
  if (weekdayVals.length && weekendVals.length) {
    const wa = mean(weekdayVals), we = mean(weekendVals);
    rows.push(['Werktag vs. Wochenende', `${kwh(wa, 2)} ↔ ${kwh(we, 2)}` + (we > wa ? ' – am Wochenende mehr' : ' – unter der Woche mehr')]);
  }
  rows.push(['Verbrauchs-Spitze', `${peak.hour}:00 Uhr – flexible Verbraucher (Waschen, Laden) eher in die günstige Nacht/Mittagszeit legen`]);
  // heat-pump hot-water timing (from imported hourly data)
  const cbh = (STATE.hpA && STATE.hpA.imported && STATE.hpA.imported.cop_by_hour) || [];
  const water = cbh.filter(x => x.water_kwh > 0);
  if (water.length) {
    const wpk = water.reduce((a, b) => b.water_kwh > a.water_kwh ? b : a);
    const midday = wpk.hour >= 10 && wpk.hour <= 15;
    rows.push(['Warmwasser-Zeit', `Meiste Warmwasser-Bereitung gegen <b>${wpk.hour}:00 Uhr</b>` +
      (midday ? ' – gut, das passt zur Mittags-/PV-Zeit.'
        : ' – mit PV oder Zeitprogramm wäre die <b>Mittagszeit</b> günstiger und effizienter (wärmer).')]);
  }
  if (night / dayTot > 0.15) rows.push(['Nacht-Verbrauch',
    `${share(night)} des Tages laufen nachts (0–6 Uhr) – lohnt sich, Dauerverbraucher/Standby zu prüfen.`]);
  rows.push(['Jahreszeit', `${season}: ` + (m <= 1 || m >= 10
    ? 'mehr Licht & Heizung – der Verbrauch liegt jetzt über dem Jahresmittel'
    : m >= 5 && m <= 7 ? 'wenig Licht, wenig Heizung – meist unter dem Jahresmittel' : 'Übergangszeit, nahe am Mittel')]);
  $('profile-insights').innerHTML = rows.map(([k, v]) => statusRow(k, v)).join('');
  renderBaseload();
  renderStandby();
  renderDeviceTimeline();
  renderLoadPeaks();
  renderBehavior();
}

// ---- Verbrauch je Gerät · Zeitstrahl ---------------------------------------
// Three resolutions: Tag (kWh/day from per_device_day), Stunde (kWh/hour) and
// Roh (power W over time) – the two fine ones from /api/series. Device picker is
// sorted by consumption (biggest first) and shows each device's kWh, so big
// consumers are easy to find; "Alle" stacks the top consumers.
let _devtlRes = null, _devtlSel = null, _devtlWinMap = null, _devtlSeries = {}, _devtlBusy = false;
const DEVTL_PAL = ['#3ba9ff', '#ff6b8a', '#4be0b0', '#ffb64d', '#b794f6', '#f78fb3', '#7ed6df', '#e77f67', '#9b8cff', '#ffd166'];
const DEVTL_WIN = {
  day: [{ v: 7, l: '7 T' }, { v: 14, l: '14 T' }, { v: 30, l: '30 T' }, { v: 90, l: '90 T' }],
  hour: [{ v: 1, l: '1 T' }, { v: 2, l: '2 T' }, { v: 3, l: '3 T' }, { v: 7, l: '7 T' }],
  raw: [{ v: 0.25, l: '6 h' }, { v: 0.5, l: '12 h' }, { v: 1, l: '24 h' }, { v: 2, l: '2 T' }],
};
const DEVTL_WIN_DEF = { day: 30, hour: 2, raw: 1 };
function devtlRes() { if (_devtlRes == null) { try { _devtlRes = localStorage.getItem('bhe_devtl_res') || 'day'; } catch (e) { _devtlRes = 'day'; } if (!DEVTL_WIN[_devtlRes]) _devtlRes = 'day'; } return _devtlRes; }
function devtlWinMap() { if (_devtlWinMap == null) { let m = {}; try { m = JSON.parse(localStorage.getItem('bhe_devtl_win') || '{}') || {}; } catch (e) {} _devtlWinMap = { ...DEVTL_WIN_DEF, ...m }; } return _devtlWinMap; }
function devtlWin() { const m = devtlWinMap(), r = devtlRes(); return m[r] != null ? m[r] : DEVTL_WIN_DEF[r]; }
function setDevtlWin(v) { devtlWinMap()[devtlRes()] = v; try { localStorage.setItem('bhe_devtl_win', JSON.stringify(_devtlWinMap)); } catch (e) {} }
function devtlSel() { if (_devtlSel == null) { try { _devtlSel = localStorage.getItem('bhe_devtl_sel') || 'all'; } catch (e) { _devtlSel = 'all'; } } return _devtlSel; }
function devtlName(id) {
  const devs = (STATE.data && STATE.data.live && STATE.data.live.devices) || [];
  const d = devs.find(x => x.id === id); return d ? (d.custom_name || d.name) : id;
}
// devices ranked by their total over the 90-day analysis (stable order + kWh for
// the dropdown), biggest consumer first.
function devtlRanking() {
  const pdd = (STATE.data && STATE.data.per_device_day) || {};
  return Object.keys(pdd).map(id => ({ id, kwh: Object.values(pdd[id] || {}).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.kwh - a.kwh);
}
// energy per interval via power integration (robust against counter resets);
// gaps capped so an offline stretch doesn't inflate a bucket.
function _devtlBucket(arr, bucketOf) {
  const out = {};
  for (let i = 0; i < arr.length; i++) {
    const dt = Math.min(1800, i < arr.length - 1 ? arr[i + 1].ts - arr[i].ts : 900);
    if (dt <= 0) continue;
    const wh = (arr[i].power_w || 0) * dt / 3600;
    const b = bucketOf(arr[i].ts);
    out[b] = (out[b] || 0) + wh;
  }
  return out;
}
// shape the top-N (+ "übrige") series list from a ranked [{id,val}] list
function _devtlSeries3(ranked, selId) {
  if (selId && selId !== 'all' && ranked.some(r => r.id === selId)) {
    return { series: [{ key: selId, color: DEVTL_PAL[0], label: devtlName(selId) }], restIds: [] };
  }
  const TOPN = 8, top = ranked.slice(0, TOPN);
  const series = top.map((t, i) => ({ key: t.id, color: DEVTL_PAL[i % DEVTL_PAL.length], label: devtlName(t.id) }));
  const restIds = ranked.slice(TOPN).map(t => t.id);
  if (restIds.length) series.push({ key: '__rest', color: '#6b7280', label: `übrige (${restIds.length})` });
  return { series, restIds };
}

// --- Tag: daily kWh from per_device_day → stacked bars ---------------------- #
function devtlDailyData(days, selId) {
  const pdd = (STATE.data && STATE.data.per_device_day) || {};
  const ids = Object.keys(pdd);
  const allDays = [...new Set(ids.flatMap(id => Object.keys(pdd[id] || {})))].sort();
  const dayKeys = allDays.slice(-days);
  if (!dayKeys.length) return null;
  const ranked = ids.map(id => ({ id, val: dayKeys.reduce((a, k) => a + ((pdd[id] || {})[k] || 0), 0) }))
    .filter(x => x.val > 0.0001).sort((a, b) => b.val - a.val);
  if (!ranked.length) return null;
  const { series, restIds } = _devtlSeries3(ranked, selId);
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  let total = 0;
  const rows = dayKeys.map(k => {
    const values = {};
    series.forEach(s => {
      const v = s.key === '__rest' ? restIds.reduce((a, id) => a + ((pdd[id] || {})[k] || 0), 0) : ((pdd[s.key] || {})[k] || 0);
      values[s.key] = v; total += v;
    });
    const p = k.split('-'); const dt = new Date(+p[0], +p[1] - 1, +p[2]);
    return { label: `${p[2]}.${p[1]}.`, full: `${WD[dt.getDay()]} ${p[2]}.${p[1]}.${p[0]}`, values };
  });
  return { rows, series, total, unitLabel: 'Tage' };
}

// --- Stunde: hourly kWh from raw samples → stacked bars --------------------- #
function devtlHourlyData(days, selId, samples) {
  const now = Date.now() / 1000, t0 = now - days * 86400;
  const by = {};
  for (const s of samples) { if (s.ts >= t0) (by[s.device_id] = by[s.device_id] || []).push(s); }
  const hourOf = ts => Math.floor(ts / 3600) * 3600;
  const perDev = {};                      // id -> {hourTs: wh}
  for (const id in by) { by[id].sort((a, b) => a.ts - b.ts); perDev[id] = _devtlBucket(by[id], hourOf); }
  const ranked = Object.keys(perDev).map(id => ({ id, val: Object.values(perDev[id]).reduce((a, b) => a + b, 0) }))
    .filter(x => x.val > 0.01).sort((a, b) => b.val - a.val);
  if (!ranked.length) return null;
  const allHb = [...new Set(Object.values(perDev).flatMap(b => Object.keys(b).map(Number)))].filter(h => h >= t0).sort((a, b) => a - b);
  if (!allHb.length) return null;
  const { series, restIds } = _devtlSeries3(ranked, selId);
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], p2 = n => String(n).padStart(2, '0');
  let total = 0;
  const rows = allHb.map(hb => {
    const values = {};
    series.forEach(s => {
      const wh = s.key === '__rest' ? restIds.reduce((a, id) => a + ((perDev[id] || {})[hb] || 0), 0) : ((perDev[s.key] || {})[hb] || 0);
      values[s.key] = wh / 1000; total += wh / 1000;
    });
    const dt = new Date(hb * 1000);
    const label = dt.getHours() === 0 ? WD[dt.getDay()] : `${p2(dt.getHours())}h`;
    return { label, full: `${WD[dt.getDay()]} ${p2(dt.getDate())}.${p2(dt.getMonth() + 1)}. ${p2(dt.getHours())}:00`, values };
  });
  return { rows, series, total, unitLabel: 'Stunden' };
}

// --- Roh: power (W) over time as lines (with the time-series readout) ------- #
function devtlRawChart(days, selId, samples) {
  const now = Date.now() / 1000, t0 = now - days * 86400, t1 = now;
  const by = {};
  for (const s of samples) { if (s.ts >= t0) (by[s.device_id] = by[s.device_id] || []).push(s); }
  for (const id in by) by[id].sort((a, b) => a.ts - b.ts);
  const ranked = Object.keys(by).map(id => ({ id, val: by[id].reduce((a, s) => a + (s.power_w || 0), 0) }))
    .filter(x => x.val > 0).sort((a, b) => b.val - a.val);
  if (!ranked.length) return null;
  let ids = (selId && selId !== 'all' && by[selId]) ? [selId] : ranked.slice(0, 8).map(r => r.id);
  ids = ids.filter(id => (by[id] || []).length);
  if (!ids.length) return null;
  const h = 230, padL = 32, padR = 10, top = 12, base = h - 26;
  const X = ts => padL + Math.max(0, Math.min(1, (ts - t0) / (t1 - t0))) * (CW - padL - padR);
  const maxW = Math.max(1, ...ids.flatMap(id => by[id].map(s => s.power_w || 0)));
  const sc = niceScale(maxW), ymax = sc.max;
  const Y = w => top + (1 - Math.max(0, Math.min(ymax, w)) / ymax) * (base - top);
  let g = gridLines(h, top, base, padL, ymax, { step: sc.step, unit: 'W' });
  // time grid: adaptive hour/day ticks
  const spanH = (t1 - t0) / 3600, p2 = n => String(n).padStart(2, '0');
  const stepH = spanH <= 8 ? 1 : spanH <= 14 ? 2 : spanH <= 26 ? 4 : spanH <= 50 ? 6 : 12, stepS = stepH * 3600;
  let sep = '';
  for (let t = Math.ceil(t0 / stepS) * stepS; t <= t1; t += stepS) {
    const x = X(t), dd = new Date(t * 1000), mid = dd.getHours() === 0;
    sep += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${base}" stroke="var(--line)" stroke-dasharray="2 3" opacity="${mid ? 0.9 : 0.5}"/>` +
      `<text class="axis" x="${(x + 2).toFixed(1)}" y="${h - 6}"${mid ? ' style="font-weight:700"' : ''}>${mid ? p2(dd.getDate()) + '.' : p2(dd.getHours()) + 'h'}</text>`;
  }
  let lines = ''; const series = [];
  ids.forEach((id, i) => {
    const col = DEVTL_PAL[i % DEVTL_PAL.length], pv = by[id];
    let dl = '', pen = false;
    pv.forEach(s => { const x = X(s.ts), y = Y(s.power_w || 0); dl += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; pen = true; });
    if (dl) lines += `<path d="${dl.trim()}" fill="none" stroke="${col}" stroke-width="${ids.length === 1 ? 2 : 1.5}"/>`;
    const last = pv[pv.length - 1];
    if (last) lines += `<circle cx="${X(last.ts).toFixed(1)}" cy="${Y(last.power_w || 0).toFixed(1)}" r="2.6" fill="${col}"/>`;
    series.push({ name: devtlName(id), color: col, unit: ' W', pts: pv.map(s => [s.ts, Math.round(s.power_w || 0)]) });
  });
  const legend = ids.map((id, i) => ({ label: devtlName(id), color: DEVTL_PAL[i % DEVTL_PAL.length] }));
  return { svg: svg(h, g + sep + lines, null, { t0, t1, padL, padR, h, series }), legend };
}

function renderDeviceTimeline() {
  const card = $('pf-devtl-card'); if (!card) return;
  // device dropdown: sorted by consumption, with each device's 90-day kWh
  const sel = $('pf-devtl-dev');
  if (sel) {
    const ranked = devtlRanking();
    const sig = ranked.map(t => t.id + ':' + Math.round(t.kwh)).join(',');
    if (sel.dataset.sig !== sig) {
      sel.innerHTML = '<option value="all">Alle Geräte (Top 8 gestapelt)</option>' +
        ranked.map(t => `<option value="${esc(t.id)}">${esc(devtlName(t.id))} · ${kwh(t.kwh, t.kwh >= 10 ? 0 : 1)}</option>`).join('');
      sel.dataset.sig = sig;
    }
    sel.value = devtlSel();
    if (sel.value !== devtlSel()) { _devtlSel = 'all'; sel.value = 'all'; }   // selected device vanished
  }
  const res = $('pf-devtl-res');
  if (res) res.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.dtr === devtlRes()));
  // window seg: options depend on the resolution
  const winEl = $('pf-devtl-win');
  if (winEl) {
    const opts = DEVTL_WIN[devtlRes()], cur = devtlWin();
    winEl.innerHTML = opts.map(o => `<button data-dtw="${o.v}"${o.v === cur ? ' class="on"' : ''}>${o.l}</button>`).join('');
  }
  paintDeviceTimeline();
}
async function paintDeviceTimeline() {
  const chart = $('pf-devtl-chart'), leg = $('pf-devtl-legend'), note = $('pf-devtl-note'), head = $('pf-devtl-head');
  if (!chart) return;
  const res = devtlRes(), win = devtlWin(), sel = devtlSel();
  const empty = msg => { chart.innerHTML = `<div class="note" style="padding:14px 0;text-align:center">${msg}</div>`; if (leg) leg.innerHTML = ''; if (note) note.innerHTML = ''; if (head) head.innerHTML = ''; };

  if (res === 'day') {
    const built = devtlDailyData(win, sel);
    if (!built) return empty('Noch keine gemessenen Tagesverbräuche – sobald Steckdosen mit Messung Daten liefern, erscheint hier der Zeitstrahl.');
    chart.innerHTML = stackedBar(built.rows, built.series, { h: 230, unit: 'kWh' });
    if (leg) leg.innerHTML = built.series.map(s => `<div class="it"><span class="sw" style="background:${s.color}"></span>${esc(s.label)}</div>`).join('');
    if (head) head.innerHTML = `<span style="color:var(--muted)">${kwh(built.total, 0)} · ${built.rows.length} Tage</span>`;
    if (note) note.innerHTML = `Tages-<b>kWh je Gerät</b> (${sel === 'all' ? 'Top 8 gestapelt + „übrige"' : 'ein Gerät'}). Tippen/überfahren zeigt die Aufschlüsselung je Tag. ` +
      `<span style="color:var(--muted)">Quelle: gemessene Steckdosen aus der 90-Tage-Analyse.</span>`;
    return;
  }
  // fine resolutions (Stunde / Roh) fetch raw samples for the window
  chart.innerHTML = '<div class="note" style="padding:14px 0;text-align:center">Lade Messwerte …</div>';
  let samples;
  try { samples = await devtlFetchSeries(win); }
  catch (e) { return empty('Feinauflösung nur mit laufender Bridge verfügbar.'); }
  if (!samples.length) return empty('Keine Messpunkte im Zeitraum.');

  if (res === 'hour') {
    const built = devtlHourlyData(win, sel, samples);
    if (!built) return empty('Keine gemessenen Verbräuche im Zeitraum.');
    chart.innerHTML = stackedBar(built.rows, built.series, { h: 230, unit: 'kWh' });
    if (leg) leg.innerHTML = built.series.map(s => `<div class="it"><span class="sw" style="background:${s.color}"></span>${esc(s.label)}</div>`).join('');
    if (head) head.innerHTML = `<span style="color:var(--muted)">${kwh(built.total, 1)} · ${built.rows.length} Std.</span>`;
    if (note) note.innerHTML = `Stunden-<b>kWh je Gerät</b> (${sel === 'all' ? 'Top 8 gestapelt' : 'ein Gerät'}). Tippen zeigt die Aufschlüsselung je Stunde. ` +
      `<span style="color:var(--muted)">Energie aus den gemessenen Leistungswerten integriert.</span>`;
    return;
  }
  // raw power
  const built = devtlRawChart(win, sel, samples);
  if (!built) return empty('Keine Messpunkte im Zeitraum.');
  chart.innerHTML = built.svg;
  if (leg) leg.innerHTML = built.legend.map(s => `<div class="it"><span class="sw" style="background:${s.color}"></span>${esc(s.label)}</div>`).join('');
  if (head) head.innerHTML = `<span style="color:var(--muted)">Leistung · ${DEVTL_WIN[res].find(o => o.v === win).l}</span>`;
  if (note) note.innerHTML = `<b>Leistung (W) über die Zeit</b> je Gerät (${sel === 'all' ? 'die 8 größten Verbraucher' : 'ein Gerät'}). Tippen/überfahren zeigt die Watt je Gerät zum Zeitpunkt. ` +
    `<span style="color:var(--muted)">Feinste Auflösung = dein Poll-Intervall (hier Demo ~30 s).</span>`;
}
// raw samples for N days (cached by whole-day bucket)
async function devtlFetchSeries(days) {
  const key = Math.max(1, Math.ceil(days));
  if (_devtlSeries[key]) return _devtlSeries[key];
  const r = await api('/api/series?device=all&days=' + key);
  const s = (r && r.samples) || [];
  _devtlSeries[key] = s; return s;
}

// ---- Lastspitzen & Dimensionierung (load-duration + peak events) ----------
let _lpDays = null, _lpData = {}, _lpBusy = false;
function lpDays() { if (_lpDays == null) { try { _lpDays = parseInt(localStorage.getItem('bhe_lp_days'), 10) || 7; } catch (e) { _lpDays = 7; } } return _lpDays; }
async function renderLoadPeaks() {
  const card = $('pf-lp-card'); if (!card) return;
  const d = lpDays();
  if (_lpData[d]) { paintLoadPeaks(_lpData[d]); return; }
  if (_lpBusy) return; _lpBusy = true;
  const el = $('pf-lp-ldc'); if (el) el.innerHTML = '<div class="note" style="padding:14px 0;text-align:center">Lade Lastanalyse …</div>';
  try { const r = await api('/api/loadpeaks?days=' + d); _lpData[d] = r; paintLoadPeaks(r); }
  catch (e) { if (el) el.innerHTML = '<div class="note">Nur mit laufender Bridge verfügbar.</div>'; }
  finally { _lpBusy = false; }
}
// load-duration curve: for each % of time, the power that was exceeded
function ldcChart(ldc, levels) {
  const h = 220, padL = 42, padR = 12, top = 12, base = h - 26, n = ldc.length;
  const X = i => padL + (CW - padL - padR) * (i / (n - 1));
  const sc = niceScale(Math.max(200, ...ldc.map(p => p.w))), yMax = sc.max;
  const Y = w => top + (1 - Math.max(0, Math.min(yMax, w)) / yMax) * (base - top);
  const g = gridLines(h, top, base, padL, yMax, { step: sc.step, unit: 'W' });
  let up = ''; ldc.forEach((p, i) => { up += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.w).toFixed(1)} `; });
  const area = `<path d="${up}L${X(n - 1).toFixed(1)} ${base} L${X(0).toFixed(1)} ${base} Z" fill="#ffd166" fill-opacity="0.15"/>` +
    `<path d="${up.trim()}" fill="none" stroke="#ffd166" stroke-width="2"/>`;
  let lv = '';
  (levels || []).forEach(L => { const y = Y(L.w); lv += `<line x1="${padL}" x2="${CW - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#ff6b8a" stroke-width="1" stroke-dasharray="3 3" opacity="0.8"/>` +
    `<text class="axis" x="${CW - padR}" y="${(y - 3).toFixed(1)}" text-anchor="end" fill="#ff6b8a">${L.w} W · ${fmt(L.pct_above, 0)}%</text>`; });
  let xt = ''; [0, 25, 50, 75, 100].forEach(pc => { xt += `<text class="axis" x="${X(pc).toFixed(1)}" y="${h - 6}" text-anchor="middle">${pc}%</text>`; });
  const tips = ldc.map((p, i) => `<b>${i}% der Zeit</b> lag die Last über <b>${fmt(p.w, 0)} W</b>`);
  return svg(h, g + area + lv + xt, { kind: 'area', pad: padL, padR, n, h, tips });
}
// one row of the per-device breakdown: name · kWh · share% + a proportional bar
function lpBreakRow(x, maxShare) {
  const isRest = x.measured === false, isHp = x.name === 'Wärmepumpe';
  const c = isRest ? '#9aa4b2' : (isHp ? COL.hp : COL.sh);
  const w = Math.max(3, (x.share || 0) / Math.max(1, maxShare) * 100);
  return `<div style="padding:7px 0;border-bottom:1px solid var(--line)">` +
    `<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px">` +
    `<b${isRest ? ' style="color:var(--muted)"' : ''}>${esc(x.name)}</b>` +
    `<span style="white-space:nowrap"><b>${kwh(x.kwh, x.kwh >= 10 ? 0 : 1)}</b> <span style="color:var(--muted)">· ${fmt(x.share, 0)} %</span></span></div>` +
    `<div class="bar" style="height:7px;margin-top:5px"><i style="width:${w.toFixed(0)}%;background:${c}"></i></div></div>`;
}
// meter-anchored hourly distribution: measured (hell) + verteilter Rest (dunkel)
function lpHourChart(hd, sm) {
  const rows = hd.map(p => ({
    label: (p.hour % 3 === 0) ? String(p.hour) : '',
    full: String(p.hour).padStart(2, '0') + ':00 Uhr',
    values: { meas: p.measured_w, rest: Math.max(0, p.w - p.measured_w) },
  }));
  return stackedBar(rows, [
    { key: 'meas', color: COL.sh, label: sm ? 'Geräte + Wärmepumpe (einzeln gemessen)' : 'gemessen' },
    { key: 'rest', color: '#9aa4b2', label: sm ? 'übriger Verbrauch (Smart Meter)' : 'ungemessener Rest' },
  ], { unit: 'W', h: 200 });
}
function paintLoadPeaks(r) {
  const head = $('pf-lp-head'), kpis = $('pf-lp-kpis'), ldcEl = $('pf-lp-ldc'), lvlEl = $('pf-lp-levels'), evEl = $('pf-lp-events'), note = $('pf-lp-note'), basis = $('pf-lp-basis');
  const brkWrap = $('pf-lp-break-wrap'), brk = $('pf-lp-break'), hrsWrap = $('pf-lp-hours-wrap'), hrs = $('pf-lp-hours');
  if (!r || !r.ok || !r.n) {
    if (ldcEl) ldcEl.innerHTML = '<div class="note" style="padding:14px 0;text-align:center">Noch keine gemessenen Leistungsdaten im Zeitraum – sobald Steckdosen/Wärmepumpe Leistung melden, erscheint hier die Lastanalyse.</div>';
    [kpis, lvlEl, evEl, note, basis].forEach(e => { if (e) e.innerHTML = ''; });
    [brkWrap, hrsWrap].forEach(e => { if (e) e.hidden = true; }); if (head) head.innerHTML = ''; return;
  }
  const whole = r.basis === 'meter' && r.meter;
  const sm = r.basis === 'smartmeter' && r.sm;               // measured whole house (Fronius smart meter)
  const W = v => fmt(v, 0) + ' W';
  const when = ts => new Date(ts * 1000).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (head) head.innerHTML = `<span style="color:var(--muted)">${fmt(r.hours, r.hours < 100 ? 1 : 0)} h · ${sm ? '⚡ Smart Meter' : whole ? '🏠 Ganzhaus' : r.sources + ' Quellen'}</span>`;
  const kpi = (v, l) => `<div class="kpi sm"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  if (kpis) kpis.innerHTML = kpi(W(r.peak_w), sm && sm.has_peaks ? 'Spitze (15 s)' : 'Spitze') + kpi(W(r.p99_w), '99-%-Spitze') +
    kpi(W(r.p95_w), '95-%-Dauerlast') + kpi(W(r.p50_w), 'Median') +
    (sm && sm.grid_peak_w ? kpi(W(sm.grid_peak_w), 'höchster Netzbezug') : '') +
    (sm && sm.batt_max_w ? kpi(W(sm.batt_max_w), 'höchste Batterie-Abgabe') : '');
  if (basis) basis.innerHTML = sm
    ? `⚡ <b>Ganzes Haus, gemessen</b> vom Smart Meter am Netzanschluss: Verbrauch = Netzbezug + Sonne + Batterie − Einspeisung, ` +
      `alle 15 s abgefragt, je Minute gemittelt${sm.has_peaks ? ', die Spitzen aus den einzelnen 15-s-Werten' : ''}. ` +
      `Daten seit ${new Date(sm.since * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` +
      (sm.covered_days < r.days - 0.5 ? ` – für den gewählten Zeitraum liegen erst <b>${fmt(sm.covered_days, 1)} Tage</b> vor` : '') +
      ` · Ø <b>${kwh(sm.daily_kwh, 1)}/Tag</b>${sm.coverage != null ? `, davon einzeln gemessen ${fmt(sm.coverage, 0)} % (Geräte + Wärmepumpe)` : ''}.`
    : whole
      ? `🏠 <b>Ganzhaus</b> aus deinem Zähler: Ø <b>${kwh(r.meter.daily_kwh, 1)}/Tag</b> · davon direkt gemessen <b>${fmt(r.meter.coverage, 0)} %</b> (Steckdosen + WP), der Rest wird hochgerechnet.`
      : `<span style="color:var(--muted)">Nur <b>gemessene</b> Steckdosen + Wärmepumpe – ohne Zählerstand ist das nicht die echte Hausspitze. Trag im Setup ein paar <b>Zählerstände</b> ein, dann rechne ich auf den ganzen Haushalt hoch.</span>`;
  const bn = $('pf-lp-break-note'), hn = $('pf-lp-hours-note');
  if (bn) bn.innerHTML = sm
    ? 'Der gemessene <b>Hausverbrauch</b> aufgeteilt: Geräte mit eigener Messung und die Wärmepumpe real, der <b>Rest</b> (Herd, Licht, Kleingeräte …) ist die Differenz zum Smart Meter – ebenfalls gemessen, nicht geschätzt.'
    : 'Dein <b>Zählerverbrauch</b> aufgeteilt: gemessene Geräte real, der <b>ungemessene Rest</b> (Herd, Licht, Kleingeräte …) als eigener Posten.';
  if (hn) hn.innerHTML = sm
    ? 'Durchschnittliche Leistung je Uhrzeit laut Smart Meter. Hell: Geräte mit eigener Messung + Wärmepumpe, grau: der übrige Verbrauch – beides gemessen.'
    : 'Dein Zähler-Tagesverbrauch auf die Stunden verteilt – nach dem <b>Rhythmus</b> deiner gemessenen Geräte. Der helle Teil ist gemessen, der dunkle der verteilte Rest.';
  // per-device breakdown (whole-house only)
  if (brkWrap && brk) {
    if ((whole || sm) && r.breakdown && r.breakdown.length) {
      const maxShare = Math.max(...r.breakdown.map(x => x.share || 0), 1);
      brk.innerHTML = r.breakdown.map(x => lpBreakRow(x, maxShare)).join('');
      brkWrap.hidden = false;
    } else brkWrap.hidden = true;
  }
  // meter-anchored hourly distribution (whole-house only)
  if (hrsWrap && hrs) {
    if ((whole || sm) && r.hour_dist && r.hour_dist.length === 24) {
      hrs.innerHTML = `<div style="touch-action:none">${lpHourChart(r.hour_dist, !!sm)}</div>`;
      hrsWrap.hidden = false;
    } else hrsWrap.hidden = true;
  }
  if (ldcEl) ldcEl.innerHTML = `<div style="touch-action:none">${ldcChart(r.ldc, r.levels)}</div>`;
  if (lvlEl) lvlEl.innerHTML = (r.levels || []).map(L =>
    `<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px;padding:5px 0;border-bottom:1px solid var(--line)">` +
    `<span>Anlage mit <b>${L.w} W</b> Ausgang</span>` +
    `<span style="white-space:nowrap"><b>${fmt(100 - L.pct_above, 0)}%</b> der Zeit gedeckt <span style="color:var(--muted)">· darüber ${fmt(L.hours_above, 1)} h</span></span></div>`).join('');
  if (evEl) {
    const dur = s => { s = Math.round(s); return s < 90 ? s + ' s' : s < 5400 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h'; };
    const maxP = (r.events[0] && r.events[0].peak_w) || 1;
    // where the power of a peak came from (smart meter): grid / battery / sun
    const src = e => {
      if (e.grid_share == null) return '';
      const g = e.grid_share, b = e.batt_share || 0, s_ = Math.max(0, 1 - g - b);
      return `<div style="font-size:11px;color:var(--muted);margin-top:3px">` +
        [`${fmt(g * 100, 0)} % aus dem Netz`, b >= 0.05 ? `${fmt(b * 100, 0)} % Batterie` : '', s_ >= 0.05 ? `${fmt(s_ * 100, 0)} % Sonne` : '']
          .filter(Boolean).join(' · ') + '</div>';
    };
    evEl.innerHTML = r.events.length ? r.events.map((e, i) =>
      `<div style="padding:7px 0;border-bottom:1px solid var(--line)">` +
      `<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px"><b>${i + 1}. ${fmt(e.peak_w, 0)} W</b>` +
      `<span style="color:var(--muted)">${dur(e.dur_s)} · ${esc(when(e.start))}</span></div>` +
      `<div class="bar" style="height:6px;margin-top:5px"><i style="width:${Math.max(5, e.peak_w / maxP * 100)}%;background:${COL.hp}"></i></div>` +
      src(e) + '</div>').join('')
      : '<div class="note">Keine ausgeprägten Spitzen im Zeitraum.</div>';
  }
  const whole2 = r.basis === 'meter' && r.meter;
  const l800 = (r.levels || []).find(L => L.w === 800);
  if (note && sm) {
    const gridEv = (r.events || []).filter(e => e.grid_share != null);
    const gShare = gridEv.length ? gridEv.reduce((a, e) => a + e.grid_share, 0) / gridEv.length : null;
    note.innerHTML = `Für die <b>Dauerlast</b> reichen ~<b>${W(r.p95_w)}</b> (95 % der Zeit darunter); die höchste Spitze war <b>${W(r.peak_w)}</b>` +
      (r.peak_ts ? ` (${esc(when(r.peak_ts))})` : '') + '. ' +
      (sm.batt_max_w ? `Die Batterie gab höchstens <b>${W(sm.batt_max_w)}</b> ab; was darüber hinausgeht – oder anfällt, wenn sie leer ist –, kommt aus dem Netz. ` : '') +
      (gShare != null ? `Bei den ${gridEv.length} größten Spitzen kam im Schnitt <b>${fmt(gShare * 100, 0)} %</b> aus dem Netz. ` : '') +
      (sm.grid_peak_w ? `Höchster Netzbezug: <b>${W(sm.grid_peak_w)}</b>${sm.grid_peak_ts ? ` (${esc(when(sm.grid_peak_ts))})` : ''}. ` : '') +
      `<span style="color:var(--muted)">Die Lastdauerlinie nutzt die Minutenmittel – sehr kurze Spitzen (Anlaufströme unter einer Sekunde) sieht keine 15-s-Abfrage.` +
      (sm.covered_days < 7 ? ' Für eine Aussage über Wochen und Jahreszeiten braucht es mehr Tage – besonders Winterabende mit Wärmepumpe und Kochen sind wichtig.' : '') + '</span>';
  } else if (note) note.innerHTML = (l800
    ? `Eine Anlage mit <b>800 W</b> Ausgangsleistung deckt <b>${fmt(100 - l800.pct_above, 0)}%</b> deiner Zeit; die Spitzen darüber dauern zusammen nur <b>${fmt(l800.hours_above, 1)} h</b> im Zeitraum. ` : '') +
    `Für die <b>Dauerlast</b> reichen ~<b>${fmt(r.p95_w, 0)} W</b> (95 % der Zeit darunter), die kurzen Lastspitzen bestimmen die Größe. ` +
    (whole2
      ? `<span style="color:var(--muted)">Basis: dein <b>Ganzhaus-Zähler</b> (Ø ${kwh(r.meter.daily_kwh, 1)}/Tag). Die gemessenen Geräte + WP decken davon <b>${fmt(r.meter.coverage, 0)} %</b> (${kwh(r.meter.measured_kwh, 0)}), der ungemessene Rest (<b>${kwh(r.meter.rest_kwh, 0)}</b>) wird <b>nach dem Tagesrhythmus</b> deiner Messungen über die Stunden verteilt. Die <b>Höhe</b> der Spitzen ist damit echt (Zählerenergie), ihr <b>genaues Timing</b> beim ungemessenen Rest ist eine Schätzung.</span>`
      : `<span style="color:var(--muted)">Summe aller <b>gemessenen</b> Steckdosen + Wärmepumpe auf ein ${r.bin_s}-s-Raster. Ohne Ganzhaus-Zähler ist das <b>nicht</b> die echte Hausspitze – ungemessene Großverbraucher (Herd, Wasserkocher, Backofen) fehlen.</span>`);
}

// Rough device-type hint from the name – tells whether a standby is likely
// killable (entertainment, chargers) or necessary (fridge/pump).
function guessDeviceType(name) {
  const n = (name || '').toLowerCase();
  if (/router|fritz|repeater|modem|switch\b|\bnas\b|server|access.?point|wlan/.test(n)) return 'Netzwerk · läuft meist bewusst durch';
  if (/\btv\b|fernseh|beamer|sound|hifi|stereo|konsole|playstation|\bps[45]\b|xbox|receiver|soundbar|media/.test(n)) return 'Unterhaltung · Standby abschaltbar';
  if (/kühl|kuehl|gefrier|fridge|freezer/.test(n)) return 'Kühlung · Dauerlast nötig';
  if (/lad|charger|netzteil|\busb\b|adapter/.test(n)) return 'Ladegerät/Netzteil · oft abschaltbar';
  if (/pumpe|\bpump\b|zirkul/.test(n)) return 'Pumpe';
  if (/kaffee|coffee|siebträger|vollautomat/.test(n)) return 'Kaffeemaschine · Standby abschaltbar';
  if (/drucker|printer/.test(n)) return 'Drucker · Standby abschaltbar';
  if (/\bpc\b|rechner|computer|monitor|laptop|notebook|dock/.test(n)) return 'PC/Monitor · Standby abschaltbar';
  if (/boiler|durchlauf|therme|warmwasser/.test(n)) return 'Warmwasser';
  return '';
}

// Per-device standby / phantom load: the device's own always-on floor
// (standby_w from the bridge = low percentile of its readings over the chosen
// window). Window + threshold are adjustable; devices below the threshold are
// still shown (muted), and a basis line explains what the detection is based on.
let _sbDays = null, _sbThresh = null, _sbCache = {}, _sbBusy = false;
const SB_DAYS_LBL = { 1: 'letzte 24 h', 7: '7 Tage', 30: '30 Tage', 90: '90 Tage', 3650: 'gesamter Zeitraum' };
function sbDays() { if (_sbDays == null) { try { _sbDays = parseInt(localStorage.getItem('bhe_sb_days'), 10) || 90; } catch (e) { _sbDays = 90; } } return _sbDays; }
function sbThresh() { if (_sbThresh == null) { try { const v = parseFloat(localStorage.getItem('bhe_sb_thresh')); _sbThresh = isFinite(v) ? v : 0.8; } catch (e) { _sbThresh = 0.8; } } return _sbThresh; }
async function renderStandby(force) {
  const card = $('pf-standby-card'); if (!card) return;
  const days = sbDays();
  let devs = null;
  if (days === 90 && STATE.data && STATE.data.live && STATE.data.live.devices) {
    devs = STATE.data.live.devices;                 // default window = already loaded
  } else if (_sbCache[days] && !force) {
    devs = _sbCache[days];
  } else {
    const body = $('pf-sb-body'); if (body && !_sbCache[days]) body.innerHTML = '<div class="note">Lade Zeitraum …</div>';
    if (_sbBusy) return; _sbBusy = true;
    try { const a = await api('/api/analytics?days=' + days + '&price=' + STATE.price); devs = (a && a.live && a.live.devices) || []; _sbCache[days] = devs; }
    catch (e) { devs = (STATE.data && STATE.data.live && STATE.data.live.devices) || []; }
    finally { _sbBusy = false; }
  }
  paintStandby(devs || [], days);
}
function paintStandby(devs, days) {
  const price = STATE.price, thr = sbThresh();
  const head = $('pf-sb-head'), body = $('pf-sb-body'), minorEl = $('pf-sb-minor'), note = $('pf-sb-note'), basis = $('pf-sb-basis');
  const rows = devs.map(d => {
    const sb = d.standby_w || 0;
    return { d, sb, label: devLabel(d), now: d.power_w || 0, peak: d.peak_w || 0,
      measures: d.measures_power !== false && (d.measures_power || sb > 0 || (d.win_samples || 0) > 0),
      yearCost: sb / 1000 * 8760 * price };
  });
  const metered = rows.filter(x => x.measures);
  const list = metered.filter(x => x.sb >= thr).sort((a, b) => b.sb - a.sb);
  const minor = metered.filter(x => x.sb > 0 && x.sb < thr).sort((a, b) => b.sb - a.sb);
  // basis line: always shown, so "nothing detected" is explainable
  if (basis) basis.innerHTML = `<b>${metered.length}</b> von <b>${devs.length}</b> Geräten messen Leistung · ` +
    `Fenster <b>${SB_DAYS_LBL[days] || days + ' Tage'}</b> · Schwelle <b>${fmt(thr, thr < 1 ? 1 : 0)} W</b> Dauerlast`;

  const totW = list.reduce((a, x) => a + x.sb, 0), totCost = list.reduce((a, x) => a + x.yearCost, 0);
  const maxCost = list[0] ? (list[0].yearCost || 1) : 1;
  if (head) head.innerHTML = list.length ? `<span style="color:var(--muted)">${fmt(totW, 0)} W · ${money(totCost)}/Jahr</span>` : '';
  const rowHtml = x => {
    const active = x.now > x.sb * 1.3 + 0.8;
    const hint = guessDeviceType((x.label.title || '') + ' ' + (x.d.name || '') + ' ' + (x.d.room || ''));
    const state = active ? `<span style="color:#ffb64d">● jetzt aktiv (${fmt(x.now, 0)} W)</span>` : `<span style="color:var(--muted)">● jetzt Standby</span>`;
    const w = Math.max(5, x.yearCost / maxCost * 100);
    return `<div style="padding:8px 0;border-bottom:1px solid var(--line)">` +
      `<div style="display:flex;justify-content:space-between;gap:8px;font-size:13px">` +
      `<b>${esc(x.label.title)}${hint ? ` <span style="color:var(--muted);font-weight:400;font-size:11px">· ${hint}</span>` : ''}</b>` +
      `<span style="white-space:nowrap"><b>${fmt(x.sb, 1)} W</b> <span style="color:var(--muted)">· ${money(x.yearCost)}/J</span></span></div>` +
      `<div class="bar" style="height:6px;margin:5px 0 3px"><i style="width:${w}%;background:${COL.sh}"></i></div>` +
      `<div style="font-size:11px;color:var(--muted)">${state} · Spitze ~${fmt(x.peak, 0)} W${x.label.sub ? ' · ' + esc(x.label.sub) : ''}</div>` +
      `</div>`;
  };
  if (body) body.innerHTML = list.length ? list.map(rowHtml).join('')
    : `<div class="note" style="padding:4px 0">${metered.length
      ? `✓ Kein Gerät zieht dauerhaft <b>≥ ${fmt(thr, thr < 1 ? 1 : 0)} W</b> – deine gemessenen Geräte gehen im Ruhezustand ~auf 0 W${minor.length ? ' (ein paar Kleinst-Sockel unten)' : ''}. Senke die Schwelle, um kleinere Dauerlasten zu sehen.`
      : 'Noch keine <b>Leistungs-messenden</b> Geräte im Zeitraum – reine Schalter/Kontakte/Thermostate melden keinen Verbrauch. Sobald ein Zwischenstecker mit Messung Daten liefert, erkenne ich Standby automatisch.'}</div>`;
  // muted "below threshold" list, so small always-on draws aren't hidden entirely
  if (minorEl) minorEl.innerHTML = minor.length
    ? `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--muted);font-size:12px">… ${minor.length} weitere unter der Schwelle (${fmt(thr, thr < 1 ? 1 : 0)} W)</summary>` +
      `<div style="margin-top:6px;opacity:.72">` + minor.map(x =>
        `<div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;padding:3px 0;border-bottom:1px solid var(--line)">` +
        `<span>${esc(x.label.title)}</span><span style="white-space:nowrap;color:var(--muted)">${fmt(x.sb, 1)} W · ${money(x.yearCost)}/J</span></div>`).join('') +
      `</div></details>`
    : '';
  const killable = list.filter(x => /abschaltbar/.test(guessDeviceType((x.label.title || '') + ' ' + (x.d.name || ''))));
  if (note) note.innerHTML = (list.length
    ? `Zusammen rund <b>${fmt(totW, 0)} W</b> Dauer-Standby ≈ <b>${kwh(totW / 1000 * 8760, 0)}/Jahr</b> (${money(totCost)}). ` : '') +
    `<b>Erkennung:</b> der Sockel ist das Dauer-Minimum jedes Geräts (10-%-Perzentil seiner eigenen Messwerte im gewählten Zeitraum); was ein Gerät <b>fast immer</b> zieht = Standby, Spitzen darüber = Nutzung. ` +
    (killable.length ? `<br>💡 <b>Abschaltbar</b> (per Zeitschaltuhr/Smart-Plug nachts aus): ${killable.map(x => esc(x.label.title)).join(', ')}. ` : '') +
    `<span style="color:var(--muted)">Der Typ-Hinweis ist aus dem Namen geraten – über „Gerät umbenennen" im Setup kannst du Namen (und damit die Einordnung) korrigieren.</span>`;
}

// Always-on base load of the MEASURED smart-home devices: the robust minimum of
// the hourly power profile (mean of the three quietest hours), projected to a
// year. Reveals standby / phantom loads worth switching off.
function renderBaseload() {
  const card = $('pf-base-card'); if (!card) return;
  const prof = (STATE.data && STATE.data.hourly_profile) || [];
  const vals = prof.map(h => h.avg_w).filter(v => v != null);
  const nDays = ((STATE.data && STATE.data.daily) || []).length;
  if (vals.length < 24 || nDays < 3) {
    $('pf-base-kpi').innerHTML = '';
    $('pf-base-note').innerHTML = 'Noch zu wenig Messtage für eine belastbare Grundlast-Schätzung – kommt nach ein paar Tagen.';
    return;
  }
  const lowest = vals.slice().sort((a, b) => a - b).slice(0, 3);
  const baseW = mean(lowest);
  const price = STATE.price;
  const baseYearKwh = baseW / 1000 * 8760;
  const baseCost = baseYearKwh * price;
  const shYear = Math.max(0.001, shAvgDaily() * 365);
  const sharePct = Math.min(100, baseYearKwh / shYear * 100);
  const per10 = 10 / 1000 * 8760;                        // kWh/a per 10 W permanent
  $('pf-base-kpi').innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v">${fmt(baseW, 0)} W</div><div class="l">Dauerleistung (Grundlast)</div></div>` +
    `<div class="kpi sm"><div class="v">${kwh(baseYearKwh, 0)}</div><div class="l">≈ pro Jahr · ${money(baseCost)}</div></div></div>` +
    `<div class="bar" style="height:12px;margin-top:10px"><i style="width:${sharePct.toFixed(0)}%;background:${COL.sh}"></i></div>`;
  $('pf-base-note').innerHTML =
    `Rund <b>${fmt(baseW, 0)} W</b> laufen <b>durchgehend</b> (Ø der drei ruhigsten Stunden) – das sind ` +
    `~<b>${fmt(sharePct, 0)} %</b> deines gemessenen Smart-Home-Stroms, ganz ohne dass jemand etwas tut. ` +
    `Typische Dauerverbraucher: Router, Standby von TV/Konsole, Netzteile, alte Kühlgeräte, Umwälzpumpen. ` +
    `<br>💡 Jede <b>10 W</b> Dauerlast weniger sparen <b>${kwh(per10, 0)}/Jahr</b> (~${money(per10 * price)}). ` +
    `<span style="color:var(--muted)">Bezieht sich auf die von den Modulen gemessenen Geräte.</span>`;
}

function behaviorInterp(nm) {
  const has = w => nm.includes(w);
  if (has('schlaf')) return 'Zubettgeh-/Aufstehzeit';
  if (has('küche') || has('kueche') || has('koch')) return 'Kochzeiten';
  if (has('wohn')) return 'Feierabend/Abend';
  if (has('bad') || has('dusch')) return 'Bad-Routine (morgens/abends)';
  if (has('flur') || has('eingang') || has('diele')) return 'Kommen & Gehen';
  if (has('kinder')) return 'Kinderzimmer-Zeiten';
  if (has('büro') || has('buero') || has('arbeit')) return 'Arbeitszeiten';
  if (has('ess')) return 'Essenszeiten';
  return '';
}

function renderBehavior() {
  const data = STATE.data, box = $('profile-behavior'); if (!box || !data) return;
  const price = STATE.price, prof = data.hourly_profile;
  const pdh = data.per_device_hour || {};
  const devs = data.live.devices || [];
  const rows = [];
  // read behaviour from named devices + their busiest hours
  [...devs].sort((a, b) => (Math.max(...(pdh[b.id] || [0]))) - (Math.max(...(pdh[a.id] || [0])))).forEach(d => {
    const arr = pdh[d.id]; if (!arr || !arr.length) return;
    const mx = Math.max(...arr), base = Math.min(...arr);
    if (mx <= 0.5 || mx - base < 0.3) return;
    const th = base + (mx - base) * 0.6, peaks = [];
    for (let h = 0; h < 24; h++) if (arr[h] >= th && arr[h] >= arr[(h + 23) % 24] && arr[h] >= arr[(h + 1) % 24]) peaks.push(h);
    if (!peaks.length) peaks.push(arr.indexOf(mx));
    const title = devLabel(d).title;
    const interp = behaviorInterp((title + ' ' + (d.room || '') + ' ' + (d.name || '')).toLowerCase());
    rows.push([title, `aktivste Zeit <b>${peaks.slice(0, 2).map(h => h + ':00').join(' & ')}</b>` + (interp ? ` – ${interp}` : '')]);
  });
  // quantified, actionable hints
  const eveHour = [21, 22, 23].reduce((a, h) => prof[h].avg_w > prof[a].avg_w ? h : a, 21);
  const eveSave = prof[eveHour].avg_w * 365 / 1000 * price;
  if (eveSave > 0.2) rows.push(['🌙 1 h früher schlafen',
    `spart grob <b>${money(eveSave)}/Jahr</b> (Licht/Rollladen um ${eveHour}:00 aus). Beim ganzen Haushalt entsprechend mehr.`]);
  const stand = data.baseline_w * 24 * 365 / 1000 * price;
  if (stand > 1) rows.push(['🔌 Dauerlast (Standby)',
    `~<b>${money(stand)}/Jahr</b> laufen rund um die Uhr – abschaltbare Steckdosenleisten prüfen.`]);
  // heat-pump hot-water shift (needs imported hourly)
  const cbh = (STATE.hpA && STATE.hpA.imported && STATE.hpA.imported.cop_by_hour) || [];
  const wpk = cbh.filter(x => x.water_kwh > 0).sort((a, b) => b.water_kwh - a.water_kwh)[0];
  if (wpk && (wpk.hour < 10 || wpk.hour > 16))
    rows.push(['🚿 Warmwasser verschieben', `Warmwasser läuft meist um ${wpk.hour}:00. In die <b>Mittagszeit</b> gelegt ` +
      `ist es effizienter (wärmer) und – mit PV – fast gratis.`]);

  box.innerHTML = rows.length
    ? rows.map(([k, v]) => `<div class="devrow" style="align-items:flex-start"><div class="nm"><b>${esc(k)}</b>` +
      `<small style="color:var(--ink); font-size:13px; line-height:1.5; display:block; margin-top:2px">${v}</small></div></div>`).join('')
    : '<div class="note">Noch zu wenig Daten für Verhaltensmuster – wächst mit jeder Messung.</div>';

  // what is NOT measured + how to add it
  const src = houseManual() > 0 ? 'dein eingetragener Haushaltswert' : 'nur die gemessenen Module';
  $('profile-missing').innerHTML =
    `Gemessen werden nur die <b>Licht-/Rollladen-Stromkreise</b> (${src}, Ø ${kwh(shAvgDaily(), 2)}/Tag). ` +
    `<b>Nicht</b> dabei: Kühlschrank, Herd/Backofen, Wasch­maschine, Trockner, Geschirrspüler, Router, TV, Ladegeräte … ` +
    `So bekommst du sie rein:<br>` +
    `• <b>Stromrechnung</b>: Jahres-kWh im Setup unter „Haushaltsstrom ergänzen" eintragen – schnellste Lösung.<br>` +
    `• <b>Bosch Smart Plug+</b> (messende Zwischenstecker) an großen Verbrauchern – sie erscheinen ` +
    `<b>automatisch</b> hier in der App (Bosch-Zähler), ganz ohne Zusatz-Setup.<br>` +
    `• <b>Zähler auslesen</b> am Hauptzähler (z. B. ein Lesekopf/Tibber Pulse) misst den ` +
    `<b>ganzen</b> Haushalt live – ließe sich später auch direkt anbinden.`;
}

/* -------------------------------------------------------------- PV planner */
// Monthly share of annual PV yield (Germany, typical) and heat-pump heating
// seasonality – both normalised at use.
const PV_MONTH = [0.028, 0.048, 0.083, 0.112, 0.128, 0.128, 0.130, 0.114, 0.088, 0.063, 0.037, 0.024];
const HP_SEASON = [0.150, 0.130, 0.105, 0.070, 0.035, 0.020, 0.015, 0.020, 0.035, 0.075, 0.120, 0.145];

function normFrac(arr) {
  const s = arr.reduce((a, b) => a + Math.max(0, b), 0);
  return s > 0 ? arr.map(v => Math.max(0, v) / s) : arr.map(() => 1 / (arr.length || 1));
}
// Monthly PV production shape: real values from a PVGIS lookup if present,
// otherwise the generic central-European default.
function pvMonth() {
  try {
    const s = JSON.parse(localStorage.getItem(PV_LS.pgm));
    if (Array.isArray(s) && s.length === 12 && s.every(v => v > 0)) return normFrac(s);
  } catch (e) {}
  return normFrac(PV_MONTH);
}
function pvHourFractions(m) {
  // daylight bell around 13:00; wider (longer days) in summer
  const pm = pvMonth();
  const seasonal = (pm[m] - Math.min(...pm)) / (Math.max(...pm) - Math.min(...pm) || 1);
  const sigma = 2.1 + 1.5 * seasonal;
  const raw = [];
  for (let h = 0; h < 24; h++) raw.push(Math.exp(-((h + 0.5 - 13) ** 2) / (2 * sigma * sigma)));
  return normFrac(raw);
}

function pvInputs() {
  const km = Math.max(0, parseFloat($('pv-ev-km').value) || 0);
  const per100 = Math.max(0, parseFloat($('pv-ev-kwh').value) || 18);
  return {
    kwp: Math.max(0, parseFloat($('pv-kwp').value) || 0),
    spec: parseFloat($('pv-orient').value) || 1000,
    batt: Math.max(0, parseFloat($('pv-batt').value) || 0),
    feedin: Math.max(0, (parseFloat($('pv-feedin').value) || 0) / 100), // ct → €
    invest: parseFloat($('pv-invest').value) || 0,
    evAnnual: km * per100 / 100,                                  // kWh/year for the car
    acAnnual: Math.max(0, parseFloat($('pv-ac').value) || 0),     // kWh/year for A/C
    v2h: !!($('pv-v2h') && $('pv-v2h').checked),
    carKwh: Math.max(0, parseFloat($('pv-v2h-kwh') && $('pv-v2h-kwh').value) || 0),
    v2hPrice: Math.max(0, parseFloat($('pv-v2h-price') && $('pv-v2h-price').value) || 800),
    carHome: V2H_PROFILES[($('pv-v2h-home') && $('pv-v2h-home').value) || 'home'] || V2H_PROFILES.home,
    cap60: !!($('pv-cap60') && $('pv-cap60').checked),
  };
}
// Air-conditioning: strongly summer (cooling season) and afternoon-weighted –
// which aligns well with PV, so it lifts self-consumption.
// A/C runs essentially only on hot days (> ~25 °C) – in Germany that means the
// high-summer months, so the load is concentrated in Jun–Aug (little in May/Sep).
const AC_MONTH = [0, 0, 0, 0.01, 0.05, 0.22, 0.35, 0.28, 0.08, 0.01, 0, 0];
const AC_SHAPE = (() => {
  const raw = [];
  for (let h = 0; h < 24; h++) raw.push(Math.exp(-((h + 0.5 - 15) ** 2) / (2 * 3.5 * 3.5)));
  return normFrac(raw);
})();
// EV daily charging shape: mostly a broad midday window (PV-optimised), with a
// smaller evening share (arriving home). Sums to 1 over the day.
const EV_SHAPE = (() => {
  const raw = [];
  for (let h = 0; h < 24; h++) {
    const mid = Math.exp(-((h + 0.5 - 12.5) ** 2) / (2 * 3.2 * 3.2));   // daytime (solar)
    const eve = 0.5 * Math.exp(-((h + 0.5 - 19) ** 2) / (2 * 1.8 * 1.8)); // evening arrival
    raw.push(mid + eve);
  }
  return normFrac(raw);
})();

function simulatePv(p) {
  // household hourly shape – fall back to a flat 24 h profile when there is no
  // (or only zero) smart-home power data, so shShape[h] is never undefined
  // (an empty normFrac() would yield NaN loads and break the whole PV model).
  const shRaw = (STATE.data && STATE.data.hourly_profile || []).map(h => h.avg_w);
  const shShape = shRaw.length === 24 && shRaw.some(v => v > 0) ? normFrac(shRaw) : new Array(24).fill(1 / 24);
  const hpProf = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const hpShape = hpProf.length && hpProf.some(h => h.avg_w > 0)
    ? normFrac(hpProf.map(h => h.avg_w)) : new Array(24).fill(1 / 24);
  const shDaily = householdBaseDaily();
  const hpDaily = hpAvgDaily();
  const hpAnnual = hpDaily * 365;
  const pvShare = p.pvShareMonth || pvMonth(), hpSeas = normFrac(HP_SEASON);
  const pvHourFn = p.pvHourFn || pvHourFractions;
  const PG = p.priceGrid || null;        // 12×24 consumer ct/kWh for spot-cost model
  let spotCt = 0;                         // Σ grid import × spot price (ct)
  let Y = 0, S = 0, F = 0, G = 0, L = 0, repDay = null, repDayW = null;
  const monthly = [];
  const evDayBase = p.evAnnual / 365;
  const useReal = !!hpRealMonthMap();
  const acShare = normFrac(AC_MONTH);
  for (let m = 0; m < 12; m++) {
    const days = new Date(2025, m + 1, 0).getDate();
    const dayPv = (p.kwp * p.spec * pvShare[m]) / days;
    // prefer real monthly heat-pump consumption when a CSV was imported
    const dayHp = hpMonthEst(m) / days;   // einheitlich: Monatsmodell inkl. Winter-Theorie
    const dayEv = evDayBase * (1 + 0.12 * Math.cos(2 * Math.PI * m / 12)); // a bit more in winter
    const dayAc = (p.acAnnual * acShare[m]) / days;
    const pvH = pvHourFn(m);
    const carCap = p.v2h ? p.carKwh : 0;
    let battery = 0, carBatt = 0, mDirect = 0, mBatt = 0, mFeed = 0, mGrid = 0, mPv = 0, mLoad = 0;
    let mSh = 0, mHp = 0, mEv = 0, mAc = 0;
    let dPv = null, dLoad = null;
    for (let d = 0; d < days; d++) {
      const capturePv = [], captureLoad = [];
      for (let h = 0; h < 24; h++) {
        const pv = dayPv * pvH[h];
        const lSh = shDaily * shShape[h], lHp = p.noHp ? 0 : dayHp * hpShape[h], lEv = dayEv * EV_SHAPE[h], lAc = dayAc * AC_SHAPE[h];
        const load = lSh + lHp + lEv + lAc;
        mSh += lSh; mHp += lHp; mEv += lEv; mAc += lAc;
        const direct = Math.min(pv, load);
        let surplus = pv - direct, deficit = load - direct;
        const av = carCap > 0 ? (p.carHome[h] || 0) : 0;   // fraction of the hour the car is home
        // charge: home battery first, then the car (scaled by how much it is home)
        const charge = Math.min(surplus, p.batt - battery); battery += charge; surplus -= charge;
        let carCharge = 0;
        if (av > 0) { carCharge = Math.min(surplus, carCap - carBatt) * av; carBatt += carCharge; surplus -= carCharge; }
        const feed = surplus;
        // discharge: home battery first, then the car (while home)
        const dis = Math.min(deficit, battery); battery -= dis; deficit -= dis;
        let carDis = 0;
        if (av > 0) { carDis = Math.min(deficit, carBatt) * av; carBatt -= carDis; deficit -= carDis; }
        const grid = deficit;
        if (PG && grid > 0) { const row = PG[m]; if (row && row[h] != null) spotCt += grid * row[h]; }
        mDirect += direct; mBatt += dis + carDis; mFeed += feed; mGrid += grid; mPv += pv; mLoad += load;
        if ((m === 6 || m === 0) && d === Math.floor(days / 2)) { capturePv.push(pv); captureLoad.push(load); }
      }
      if (capturePv.length) { dPv = capturePv; dLoad = captureLoad; }
    }
    const mSelf = mDirect + mBatt;
    Y += mPv; S += mSelf; F += mFeed; G += mGrid; L += mLoad;
    monthly.push({ m, pv: mPv, load: mLoad, self: mSelf, direct: mDirect, batt: mBatt, feed: mFeed, grid: mGrid,
      loadSh: mSh, loadHp: mHp, loadEv: mEv, loadAc: mAc });
    if (dPv) { if (m === 6) repDay = { pv: dPv, load: dLoad }; else if (m === 0) repDayW = { pv: dPv, load: dLoad }; }
  }
  // 60 % feed-in cap: curtailment only occurs on CLEAR days (peak > 0.6·kWp),
  // which the average-day balance above smooths away – so estimate it separately.
  const C = p.cap60 ? Math.min(F, curtailEstimate(p)) : 0;
  const feedFinal = F - C;                       // the cap only throws away feed, not self-use
  return {
    yield_kwh: Y, self_kwh: S, feed_kwh: feedFinal, grid_kwh: G, load_kwh: L,
    curtail_kwh: C, curtail_loss: C * p.feedin,
    self_rate: Y > 0 ? S / Y : 0, autarky: L > 0 ? S / L : 0,
    savings: S * STATE.price, feed_rev: feedFinal * p.feedin, benefit: S * STATE.price + feedFinal * p.feedin,
    spot_cost: PG ? spotCt / 100 : null,       // €/year on a spot tariff (grid import, hourly-weighted)
    monthly, repDay, repDayW,
  };
}

// Estimate annual energy curtailed by a 60 % feed-in cap. The average day never
// reaches the cap, so we model a representative CLEAR day per month (higher
// output, same daylight shape) and cap its midday grid export; a battery soaks
// up part of the peak. Rough but physically grounded.
function curtailEstimate(p) {
  const cap = 0.6 * p.kwp; if (cap <= 0) return 0;
  const shShape = normFrac((STATE.data && STATE.data.hourly_profile || []).map(h => h.avg_w));
  const hpProf = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const hpShape = hpProf.length && hpProf.some(h => h.avg_w > 0) ? normFrac(hpProf.map(h => h.avg_w)) : new Array(24).fill(1 / 24);
  const shDaily = householdBaseDaily(), hpDaily = hpAvgDaily(), hpAnnual = hpDaily * 365;
  const pvShare = pvMonth(), hpSeas = normFrac(HP_SEASON), acShare = normFrac(AC_MONTH);
  const useReal = !!hpRealMonthMap(), evDayBase = p.evAnnual / 365;
  let C = 0;
  for (let m = 0; m < 12; m++) {
    const days = new Date(2025, m + 1, 0).getDate();
    const clearDays = Math.max(1, Math.round(days * 0.30));       // ~30 % of days are clear
    const clearDayPv = (p.kwp * p.spec * pvShare[m]) * 0.55 / clearDays;  // carrying ~55 % of the month's yield
    const pvH = pvHourFractions(m);
    const dayHp = hpMonthEst(m) / days;   // einheitlich: Monatsmodell inkl. Winter-Theorie
    const dayEv = evDayBase * (1 + 0.12 * Math.cos(2 * Math.PI * m / 12));
    const dayAc = (p.acAnnual * acShare[m]) / days;
    const battPeak = p.batt / 3;                                  // a battery soaks up ~its capacity over ~3 midday hours
    for (let h = 0; h < 24; h++) {
      const pv = clearDayPv * pvH[h];
      const load = shDaily * shShape[h] + (p.noHp ? 0 : dayHp * hpShape[h]) + dayEv * EV_SHAPE[h] + dayAc * AC_SHAPE[h];
      const batt = (h >= 11 && h <= 14) ? battPeak : 0;
      const feed = Math.max(0, pv - load - batt);
      C += Math.max(0, feed - cap) * clearDays;
    }
  }
  return C;
}

// ---- Optimale Ausrichtung ------------------------------------------------ #
// Representative central-European monthly PRODUCTION profiles per orientation
// (relative, normalised at use) + annual specific yield (kWh/kWp·a). Steeper
// tilt shifts yield into winter at the cost of annual total; low tilt east/west
// spreads it over the day (morning+evening) which matches household load.
const ORIENTATIONS = [
  { id: 'south35', label: 'Süd, 30–35°', hint: 'Höchster Jahresertrag, Mittagsspitze',
    spec: 1000, tilt: 35, az: 0,
    month: [0.028, 0.048, 0.083, 0.112, 0.128, 0.128, 0.130, 0.114, 0.088, 0.063, 0.037, 0.024] },
  { id: 'south65', label: 'Süd, steil 60–70°', hint: 'Winter-optimiert (mehr Dez/Jan)',
    spec: 900, tilt: 65, az: 0,
    month: [0.050, 0.068, 0.092, 0.102, 0.104, 0.102, 0.104, 0.103, 0.092, 0.074, 0.056, 0.045] },
  { id: 'eastwest', label: 'Ost-West, flach 15°', hint: 'Breite Tagesdeckung (früh+abends)',
    spec: 950, tilt: 15, az: 0, ew: true,
    month: [0.022, 0.042, 0.080, 0.115, 0.135, 0.135, 0.137, 0.117, 0.086, 0.058, 0.030, 0.020] },
];
// East-west daily shape: two humps (morning + afternoon) → broader than a south
// midday bell, so more PV meets the morning/evening household load directly.
function ewHourFn(m) {
  const pm = pvMonth();
  const seasonal = (pm[m] - Math.min(...pm)) / (Math.max(...pm) - Math.min(...pm) || 1);
  const s = 2.0 + 1.2 * seasonal;
  const raw = [];
  for (let h = 0; h < 24; h++)
    raw.push(Math.exp(-((h + 0.5 - 10) ** 2) / (2 * s * s)) + Math.exp(-((h + 0.5 - 16) ** 2) / (2 * s * s)));
  return normFrac(raw);
}
// Self-sufficiency (self ÷ load) over a set of month indices.
function seasonAutarky(r, months) {
  let self = 0, load = 0;
  months.forEach(m => { const x = r.monthly[m]; if (x) { self += x.direct + x.batt; load += x.load; } });
  return load > 0 ? self / load : 0;
}
// Recommend kWp + orientation: size each orientation so SUMMER is ~fully
// self-sufficient (≥ target), then report winter/annual autarky. A battery is
// required for high autarky; use the user's, else suggest one.
function optimizeOrientation() {
  const base = pvInputs();
  if (!(shAvgDaily() > 0 || hpAvgDaily() > 0)) return null;
  // load is independent of PV → get the summer daily load from a zero-PV probe
  const probe = simulatePv({ ...base, kwp: 0, batt: 0, v2h: false, cap60: false });
  const mL = probe.monthly.map(x => x.load);
  const summerDaily = (mL[5] + mL[6] + mL[7]) / (30 + 31 + 31);
  const battSuggested = base.batt <= 0;
  const batt = base.batt > 0 ? base.batt : Math.max(3, Math.round(summerDaily * 0.6));
  const SUMMER = [5, 6, 7], WINTER = [11, 0, 1], target = 0.97;   // ≈ „100 %" praktisch
  const sim = (o, kwp) => simulatePv({ ...base, kwp, batt, v2h: false, cap60: false,
    spec: o.spec, pvShareMonth: normFrac(o.month), pvHourFn: o.ew ? ewHourFn : null });
  const results = ORIENTATIONS.map(o => {
    let kwp = null, r = null;
    for (let k = 1; k <= 30; k += 0.5) {
      r = sim(o, k);
      if (seasonAutarky(r, SUMMER) >= target) { kwp = k; break; }
    }
    const capped = kwp == null;
    if (capped) { kwp = 30; r = sim(o, 30); }
    return { o, kwp, capped, summerAut: seasonAutarky(r, SUMMER),
      winterAut: seasonAutarky(r, WINTER), yearAut: r.autarky, yield_kwh: r.yield_kwh };
  });
  return { results, batt, battSuggested, summerDaily };
}

// ---- Meine Flächen belegen ----------------------------------------------- #
// Surface types the user can own, with a typical tilt and the usable fraction
// of their area (spacing/setbacks/row shading). kWp = area × usable × density.
const SURF_TYPES = {
  gable:   { label: 'Satteldach',              tilt: 35, usable: 0.75 },
  flat:    { label: 'Flachdach',               tilt: 15, usable: 0.55 },
  garden:  { label: 'Gartenfläche (Freiland)', tilt: 30, usable: 0.50 },
  wall:    { label: 'Grenz-/Fassadenwand',     tilt: 90, usable: 0.80 },
  terrace: { label: 'Terrassenüberdachung',    tilt: 10, usable: 0.70 },
  carport: { label: 'Carport',                 tilt: 10, usable: 0.70 },
};
const MOD_DENSITY = 0.19;   // kWp per usable m² (modern modules)
const YIELD_OPT = 1060;     // kWh/kWp·a at the optimum (≈50° N, tilt 30, south)
// Relative yield (% of optimum) by tilt (rows) × |azimuth| (cols, 0=S…180=N).
const Y_TILTS = [0, 15, 30, 45, 60, 90], Y_AZ = [0, 45, 90, 135, 180];
const Y_GRID = [
  [88, 88, 88, 88, 88],
  [95, 93, 87, 78, 72],
  [100, 96, 87, 73, 63],
  [99, 94, 83, 66, 55],
  [93, 87, 75, 58, 47],
  [70, 65, 55, 42, 33],
];
function _interpIdx(arr, x) {
  if (x <= arr[0]) return { i0: 0, i1: 0, f: 0 };
  if (x >= arr[arr.length - 1]) return { i0: arr.length - 1, i1: arr.length - 1, f: 0 };
  for (let i = 0; i < arr.length - 1; i++)
    if (x >= arr[i] && x <= arr[i + 1]) return { i0: i, i1: i + 1, f: (x - arr[i]) / (arr[i + 1] - arr[i]) };
  return { i0: 0, i1: 0, f: 0 };
}
// Relative yield (% of optimum) for a tilt/azimuth, bilinearly interpolated.
function relYield(tilt, az) {
  let a = Math.abs(((az % 360) + 360) % 360); if (a > 180) a = 360 - a;
  const T = _interpIdx(Y_TILTS, Math.max(0, Math.min(90, tilt)));
  const A = _interpIdx(Y_AZ, Math.max(0, Math.min(180, a)));
  const g = (ti, ai) => Y_GRID[ti][ai];
  const top = g(T.i0, A.i0) * (1 - A.f) + g(T.i0, A.i1) * A.f;
  const bot = g(T.i1, A.i0) * (1 - A.f) + g(T.i1, A.i1) * A.f;
  return top * (1 - T.f) + bot * T.f;
}
// Monthly production shape for a tilt, blended between the flat/standard/steep
// anchors (steeper → more winter).
function monthForTilt(tilt) {
  const flat = ORIENTATIONS.find(o => o.id === 'eastwest').month;
  const std = ORIENTATIONS.find(o => o.id === 'south35').month;
  const steep = ORIENTATIONS.find(o => o.id === 'south65').month;
  if (tilt <= 15) return normFrac(flat);
  if (tilt >= 65) return normFrac(steep);
  const [a, b, t0, t1] = tilt < 35 ? [flat, std, 15, 35] : [std, steep, 35, 65];
  const f = (tilt - t0) / (t1 - t0);
  return normFrac(a.map((v, i) => v * (1 - f) + b[i] * f));
}
const SURF_LS = 'bhe_pv_surfaces';
function loadSurfaces() { try { const s = JSON.parse(localStorage.getItem(SURF_LS)); return Array.isArray(s) ? s : []; } catch (e) { return []; } }
function saveSurfaces(a) { try { localStorage.setItem(SURF_LS, JSON.stringify(a)); } catch (e) {} }
const MOD_WP = 0.43;    // kWp per module (~1.7 m²)
// Flat/ground roofs: steeper rows need more spacing, so the usable share of the
// area drops with tilt (self-shading) – more tilt ⇒ fewer modules fit.
function flatUsable(tilt) { return Math.max(0.35, Math.min(0.90, 0.95 - 0.012 * tilt)); }
// Clear-day peak as a share of kWp: south-pitched peaks highest, flat/east-west
// spread it out, a vertical wall lowest.
function peakFactorFor(tilt, az) {
  const a = Math.abs(az);
  if (tilt <= 5) return 0.70;
  if (tilt >= 85) return 0.50;
  if (a >= 60) return 0.62;
  return 0.82;
}
// Generation detail for kWp at a tilt/azimuth (before shading).
function genDetail(kwp, tilt, az) {
  const spec = YIELD_OPT * relYield(tilt, az) / 100, annual = kwp * spec, shape = monthForTilt(tilt);
  const g = m => annual * shape[m];
  return { spec, annual,
    winterDay: (g(11) + g(0) + g(1)) / (31 + 31 + 28),   // avg Dez/Jan/Feb day
    winterMonth: (g(11) + g(0) + g(1)) / 3,              // avg Dez/Jan/Feb month
    summerMonth: (g(5) + g(6) + g(7)) / 3,                // avg Jun/Jul/Aug month
    peakKw: kwp * peakFactorFor(tilt, az) };
}
// Diffuse-aware shading: an obstruction blocks the DIRECT beam in proportion,
// but only part of the DIFFUSE sky light – a shaded module still harvests diffuse
// radiation (≈ half of the annual irradiation in central Europe). So a 50 %
// obstruction costs clearly less than 50 % of the yield.
const DIFFUSE_FRAC = 0.5, SKY_BLOCK = 0.55;
function shadeFactor(shadePct) {
  const s = Math.min(90, Math.max(0, shadePct || 0)) / 100;
  return 1 - s * ((1 - DIFFUSE_FRAC) + SKY_BLOCK * DIFFUSE_FRAC);
}
// How to lay out a surface: pitched roofs keep the roof tilt; flat/garden pick
// the tilt that maximises annual yield over the area (module-count trade-off).
function surfaceLayout(s) {
  const t = SURF_TYPES[s.type] || SURF_TYPES.gable;
  const az = +s.az || 0, shade = Math.min(90, Math.max(0, +s.shade || 0)), f = shadeFactor(shade);
  const area = Math.max(0, +s.area || 0);
  const flexible = (s.type === 'flat' || s.type === 'garden') && (s.tilt == null || s.tilt === '');
  if (flexible) {
    const opts = [10, 15, 20, 30].map(tl => {
      const kwp = area * flatUsable(tl) * MOD_DENSITY, d = genDetail(kwp, tl, az);
      return { tilt: tl, kwp, modules: Math.round(kwp / MOD_WP), spec: d.spec * f, annual: d.annual * f };
    });
    const best = opts.slice().sort((a, b) => b.annual - a.annual)[0];
    const d = genDetail(best.kwp, best.tilt, az);
    return { flexible: true, opts, az, shade, area, tilt: best.tilt, kwp: best.kwp, modules: best.modules,
      spec: best.spec, annual: best.annual, winterDay: d.winterDay * f, winterMonth: d.winterMonth * f,
      summerMonth: d.summerMonth * f, peakKw: d.peakKw * f };
  }
  const tilt = (s.tilt != null && s.tilt !== '') ? +s.tilt : t.tilt;
  // flat/garden pack tilt-dependently (dense when laid flat, sparser when
  // aufgeständert); pitched roofs/terraces/walls use their fixed structural share
  const usable = (s.type === 'flat' || s.type === 'garden') ? flatUsable(tilt) : t.usable;
  const kwp = area * usable * MOD_DENSITY, d = genDetail(kwp, tilt, az);
  return { flexible: false, az, shade, area, tilt, kwp, modules: Math.round(kwp / MOD_WP),
    spec: d.spec * f, annual: d.annual * f, winterDay: d.winterDay * f, winterMonth: d.winterMonth * f,
    summerMonth: d.summerMonth * f, peakKw: d.peakKw * f };
}
// Per-surface potential (for the coverage recommendation), derived from the layout.
function surfaceMetrics(s) {
  const lay = surfaceLayout(s), t = SURF_TYPES[s.type] || SURF_TYPES.gable;
  return { kwp: lay.kwp, spec: lay.spec, tilt: lay.tilt, az: lay.az, shade: lay.shade,
    month: monthForTilt(lay.tilt), ew: Math.abs(lay.az) >= 60, year: lay.annual, label: t.label, layout: lay };
}
// Your average daily load shape over 24 h, weighted by each consumer's daily
// energy (household profile + heat pump + EV + A/C) – the real "when do I use it".
function loadHourShape() {
  const shShape = normFrac((STATE.data && STATE.data.hourly_profile || []).map(h => h.avg_w));
  const hpProf = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const hpShape = hpProf.length && hpProf.some(h => h.avg_w > 0) ? normFrac(hpProf.map(h => h.avg_w)) : new Array(24).fill(1 / 24);
  const p = pvInputs();
  const shD = shAvgDaily(), hpD = hpAvgDaily(), evD = p.evAnnual / 365, acD = p.acAnnual / 365;
  const raw = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) raw[h] = shD * shShape[h] + hpD * hpShape[h] + evD * EV_SHAPE[h] + acD * AC_SHAPE[h];
  return normFrac(raw);
}
// How well a surface's production timing overlaps your daily load (0..1):
// Σ min(pvFrac[h], loadFrac[h]) of the two normalised 24 h shapes. High = the
// sun shines when you actually consume (good direct self-use even without battery).
function surfaceMatch(s) {
  const lay = surfaceLayout(s), load = loadHourShape();
  const pvFn = lay.ew ? ewHourFn : pvHourFractions;
  const acc = new Array(24).fill(0);
  for (let m = 0; m < 12; m++) { const f = pvFn(m); for (let h = 0; h < 24; h++) acc[h] += f[h]; }
  const pv = normFrac(acc);
  let ov = 0; for (let h = 0; h < 24; h++) ov += Math.min(pv[h], load[h]);
  return ov;
}
// Smooth a 12-month daily-average series into 365 daily values (linear between
// month centres) – a clean climatological curve.
function interpYear(md) {
  const centers = []; let cum = 0;
  for (let m = 0; m < 12; m++) { centers.push([cum + DIM[m] / 2, md[m]]); cum += DIM[m]; }
  const out = [];
  for (let d = 0; d < 365; d++) {
    if (d <= centers[0][0]) { out.push(centers[0][1]); continue; }
    if (d >= centers[11][0]) { out.push(centers[11][1]); continue; }
    let i = 0; while (i < 11 && centers[i + 1][0] < d) i++;
    const [x0, y0] = centers[i], [x1, y1] = centers[i + 1];
    out.push(y0 + (y1 - y0) * (d - x0) / (x1 - x0));
  }
  return out;
}
// Per-surface year series: expected daily yield (this surface) and expected
// daily whole-house consumption, as 365-value climatological curves.
function buildSurfaceYear(layout) {
  const yShare = monthForTilt(layout.tilt);
  const yMD = yShare.map((s, m) => layout.annual * s / DIM[m]);
  const p = pvInputs(), shD = householdBaseDaily(), hpAnnual = hpAvgDaily() * 365;
  const useReal = !!hpRealMonthMap(), hpSeas = normFrac(HP_SEASON), acShare = normFrac(AC_MONTH);
  const evDayBase = p.evAnnual / 365;
  // Build household + WP separately so we can overlay the real measured days
  // (same logic as the Verlauf curve); the planned EV/A/C stays a smooth add-on.
  const hausMD = [], wpMD = [], extraMD = [];
  for (let m = 0; m < 12; m++) {
    hausMD[m] = shD;
    wpMD[m] = hpMonthEst(m) / DIM[m];   // einheitlich: gleiche Monatsquelle wie Verlauf/Wärme/PV
    const dayEv = evDayBase * (1 + 0.12 * Math.cos(2 * Math.PI * m / 12));
    const dayAc = p.acAnnual * acShare[m] / DIM[m];
    extraMD[m] = dayEv + dayAc;
  }
  const haus = interpYear(hausMD), wp = interpYear(wpMD), extra = interpYear(extraMD);
  overlayMeasuredDays(haus, wp, shD);          // real values on measured days
  const load = haus.map((v, i) => v + wp[i] + extra[i]);
  return { yld: interpYear(yMD), load };
}
let _surfYear = {};
// 365-day chart: yield (green area/line) vs. whole-house load (blue line).
function yearChart(yld, load, idx) {
  const h = 118, top = 8, base = h - 16, left = 2, right = CW - 2, plotW = right - left;
  const max = Math.max(0.001, ...yld, ...load);
  const X = i => left + i / 364 * plotW, Y = v => base - (v / max) * (base - top);
  const line = arr => arr.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
  const area = `M${X(0).toFixed(1)} ${base} ` + yld.map((v, i) => 'L' + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ') + ` L${X(364).toFixed(1)} ${base} Z`;
  const MON3 = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  let ticks = '', cum = 0;
  for (let m = 0; m < 12; m++) { ticks += `<text class="axis" x="${X(cum + DIM[m] / 2).toFixed(1)}" y="${h - 3}" text-anchor="middle" style="font-size:9px">${MON3[m]}</text>`; cum += DIM[m]; }
  const inner = `<path d="${area}" fill="${COL.pv}" opacity="0.26"/>` +
    `<path d="${line(yld)}" fill="none" stroke="${COL.pv}" stroke-width="1.5"/>` +
    `<path d="${line(load)}" fill="none" stroke="${COL.sh}" stroke-width="1.5"/>` +
    `<line class="syc" x1="0" y1="${top}" x2="0" y2="${base}" stroke="var(--ink)" stroke-width="1" opacity="0"/>` + ticks;
  return `<div class="syhit" data-idx="${idx}" style="touch-action:none;margin-top:6px">${svg(h, inner)}</div>` +
    `<div class="legend" style="margin-top:2px"><div class="it"><span class="sw" style="background:${COL.pv}"></span>Ertrag (Fläche)</div>` +
    `<div class="it"><span class="sw" style="background:${COL.sh}"></span>Hausverbrauch</div>` +
    `<span style="color:var(--muted);font-size:11px;margin-left:6px">kWh/Tag übers Jahr – tippen/fahren für Details</span></div>`;
}
// Expected daily consumption over the year, split Hausstrom vs Wärmepumpe –
// SAME composition as the PV-tab load (household base + EV + A/C, and the heat
// pump per month), so the Verlauf curve matches the PV curve.
// Overlay REALLY measured days onto the smooth model curves (mutates haus & wp).
// The Bosch modules only measure PART of the household (smarthome_kwh), so on a
// measured day we use that day's real module reading PLUS the AVERAGE of the
// not-individually-measured rest ("dark" load); the WP uses its real day value.
// Unmeasured/future days keep the smooth model, so the annual mean is preserved.
//   household(measured day) = gemessen(Tag) + (Ø Haushalt − Ø gemessen)
function overlayMeasuredDays(haus, wp, shBase) {
  const days = (STATE.ov && STATE.ov.combined_daily) || [];
  const shVals = days.map(d => d.smarthome_kwh).filter(v => v != null && v >= 0);
  const avgMod = shVals.length ? shVals.reduce((a, b) => a + b, 0) / shVals.length : 0;
  const avgDark = Math.max(0, shBase - avgMod);
  const now = new Date(), yr = now.getFullYear(), todayKey = localKey(now);
  const measured = [];
  days.forEach(d => {
    if (!d.day || d.day === todayKey) return;                 // skip today (still partial)
    const p = d.day.split('-'); if (p.length !== 3 || +p[0] !== yr) return;
    const doy = Math.round((new Date(yr, +p[1] - 1, +p[2]) - new Date(yr, 0, 1)) / 86400000);
    if (doy < 0 || doy > 364) return;
    if (d.smarthome_kwh != null) { haus[doy] = d.smarthome_kwh + avgDark; measured.push(doy); }
    if (wp && d.heatpump_kwh != null && d.heatpump_kwh > 0) wp[doy] = d.heatpump_kwh;
  });
  return { measured, avgDark, avgMod };
}
function buildConsumptionYear() {
  // Verlauf = ACTUAL consumption: household (meter total − WP, already incl. all
  // real appliances) + heat pump. No planned EV/A/C from the PV planner, so it
  // matches the PV load exactly when those are 0 and stays put otherwise.
  const shBase = shAvgDaily(), hpAnnual = hpAvgDaily() * 365;
  const useReal = !!hpRealMonthMap(), hpSeas = normFrac(HP_SEASON);
  const hausMD = [], wpMD = [];
  for (let m = 0; m < 12; m++) {
    wpMD[m] = hpMonthEst(m) / DIM[m];   // einheitlich: gleiche Monatsquelle wie Verlauf/Wärme/PV
    hausMD[m] = shBase;
  }
  const haus = interpYear(hausMD), wp = interpYear(wpMD);
  const ov = overlayMeasuredDays(haus, wp, shBase);
  return { haus, wp, measured: ov.measured, avgDark: ov.avgDark, avgMod: ov.avgMod };
}
let _consumYear = null;
// Stacked 365-day consumption chart: Hausstrom (bottom) + Wärmepumpe (top).
function renderConsumYear() {
  const el = $('h-consum-chart'); if (!el) return;
  if (!(shAvgDaily() > 0 || hpAvgDaily() > 0)) { el.innerHTML = '<div class="note">Noch keine Verbrauchsdaten.</div>'; $('h-consum-note').innerHTML = ''; return; }
  const s = buildConsumptionYear(); _consumYear = s;
  const h = 130, top = 8, base = h - 16, left = 2, right = CW - 2, plotW = right - left;
  const tot = s.haus.map((v, i) => v + s.wp[i]);
  const max = Math.max(0.001, ...tot);
  const X = i => left + i / 364 * plotW, Y = v => base - (v / max) * (base - top);
  const areaUp = (arr) => `M${X(0).toFixed(1)} ${base} ` + arr.map((v, i) => 'L' + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ') + ` L${X(364).toFixed(1)} ${base} Z`;
  const bandTop = (hausArr, totArr) => { // band between haus and tot (the WP layer)
    let d = `M${X(0).toFixed(1)} ${Y(hausArr[0]).toFixed(1)} `;
    for (let i = 1; i < 365; i++) d += 'L' + X(i).toFixed(1) + ' ' + Y(hausArr[i]).toFixed(1) + ' ';
    for (let i = 364; i >= 0; i--) d += 'L' + X(i).toFixed(1) + ' ' + Y(totArr[i]).toFixed(1) + ' ';
    return d + 'Z';
  };
  const MON3 = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  let ticks = '', cum = 0;
  for (let m = 0; m < 12; m++) { ticks += `<text class="axis" x="${X(cum + DIM[m] / 2).toFixed(1)}" y="${h - 3}" text-anchor="middle" style="font-size:9px">${MON3[m]}</text>`; cum += DIM[m]; }
  const line = arr => arr.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ');
  const inner = `<path d="${areaUp(s.haus)}" fill="${COL.sh}" opacity="0.5"/>` +
    `<path d="${bandTop(s.haus, tot)}" fill="${COL.hp}" opacity="0.5"/>` +
    `<path d="${line(tot)}" fill="none" stroke="${COL.hp}" stroke-width="1.3"/>` +
    `<path d="${line(s.haus)}" fill="none" stroke="${COL.sh}" stroke-width="1.3"/>` +
    `<line class="syc" x1="0" y1="${top}" x2="0" y2="${base}" stroke="var(--ink)" stroke-width="1" opacity="0"/>` + ticks;
  el.innerHTML = `<div class="cyhit" style="touch-action:none">${svg(h, inner)}</div>` +
    `<div class="legend" style="margin-top:2px"><div class="it"><span class="sw" style="background:${COL.sh}"></span>Hausstrom</div>` +
    `<div class="it"><span class="sw" style="background:${COL.hp}"></span>Wärmepumpe</div>` +
    `<span style="color:var(--muted);font-size:11px;margin-left:6px">kWh/Tag – tippen/fahren für Details</span></div>`;
  const avg = tot.reduce((a, b) => a + b, 0) / 365;
  const now = new Date().getMonth(), cumD = DIM.slice(0, now).reduce((a, b) => a + b, 0) + 14;
  const nMeas = (s.measured || []).length;
  const measNote = nMeas
    ? `<b>${nMeas} gemessene Tage</b> nutzen die echten Werte: gemessene Geräte des Tages <b>+ Ø des (noch) nicht gemessenen Rests</b> ` +
      `(${kwh(s.avgDark, 1)}/Tag); übrige/künftige Tage den Tages-Ø. `
    : '';
  $('h-consum-note').innerHTML =
    `Ø <b>${kwh(avg, 1)}/Tag</b> übers Jahr · aktuell (${MON[now]}) ~<b>${kwh(tot[cumD], 1)}/Tag</b> ` +
    `(Hausstrom ${kwh(s.haus[cumD], 1)} + WP ${kwh(s.wp[cumD], 1)}). ` + measNote +
    `<span style="color:var(--muted)">Das ist dein <b>tatsächlicher</b> Verbrauch (Zähler-Hausstrom + WP), <b>ohne</b> ` +
    `geplantes E-Auto/Klima. Die Verbrauchs-Kurve im PV-Tab nutzt jetzt dieselben gemessenen Tage und ist ` +
    `<b>identisch, solange E-Auto & Klima dort 0 sind</b>.</span>`;
}
// Combine a set of surface metrics into one array: total kWp, production-weighted
// monthly shape and effective specific yield.
function combineSurfaces(ms) {
  let kwp = 0, year = 0, ewY = 0; const acc = new Array(12).fill(0);
  ms.forEach(m => { kwp += m.kwp; year += m.year; m.month.forEach((v, i) => acc[i] += m.year * v); if (m.ew) ewY += m.year; });
  return { kwp, year, spec: kwp > 0 ? year / kwp : 0, shape: year > 0 ? normFrac(acc) : null, ew: year > 0 && ewY / year > 0.5 };
}
// Recommend which surfaces to cover: fill best-first (winter-weighted yield)
// until summer is ~fully self-sufficient; report the resulting system.
function recommendCoverage() {
  const surfs = loadSurfaces();
  if (!surfs.length) return { empty: true };
  const items = surfs.map((s, i) => ({ i, s, m: surfaceMetrics(s) }));
  const haveLoad = shAvgDaily() > 0 || hpAvgDaily() > 0;
  const all = combineSurfaces(items.map(x => x.m));
  if (!haveLoad) return { items, all, noLoad: true };
  const base = pvInputs();
  const probe = simulatePv({ ...base, kwp: 0, batt: 0, v2h: false, cap60: false });
  const mL = probe.monthly.map(x => x.load);
  const summerDaily = (mL[5] + mL[6] + mL[7]) / 92;
  const battSuggested = base.batt <= 0;
  const batt = base.batt > 0 ? base.batt : Math.max(3, Math.round(summerDaily * 0.6));
  // per-surface day-match with the hourly load (for display + tie-break)
  items.forEach(it => { it.match = surfaceMatch(it.s); });
  const simSet = set => { const c = combineSurfaces(set.map(x => x.m));
    return { c, r: simulatePv({ ...base, kwp: c.kwp, batt, v2h: false, cap60: false, spec: c.spec, pvShareMonth: c.shape, pvHourFn: c.ew ? ewHourFn : null }) }; };
  // Greedy, LOAD-AWARE: at each step add the surface that raises actually
  // SELF-USED energy the most (uses your hourly consumption via simulatePv),
  // so orientations that match when you consume are preferred – winter share as
  // a gentle tie-break. Stop once summer is ~fully self-sufficient.
  const SUMMER = [5, 6, 7], target = 0.97;
  const remaining = items.slice(); const chosen = []; let reached = false, prevSelf = 0;
  while (remaining.length) {
    let best = null, bestScore = -1, bestR = null;
    for (const cand of remaining) {
      const { r } = simSet([...chosen, cand]);
      const w = cand.m.month[11] + cand.m.month[0] + cand.m.month[1];
      const score = (r.self_kwh - prevSelf) * (1 + 0.4 * w);   // marginal self-use, winter-biased
      if (score > bestScore) { bestScore = score; best = cand; bestR = r; }
    }
    chosen.push(best); remaining.splice(remaining.indexOf(best), 1); prevSelf = bestR.self_kwh;
    if (seasonAutarky(bestR, SUMMER) >= target) { reached = true; break; }
  }
  const { c: comb, r: rF } = simSet(chosen);
  const chosenIds = new Set(chosen.map(x => x.i));
  return { items, chosen, chosenIds, reached, comb, all, batt, battSuggested,
    summerAut: seasonAutarky(rF, SUMMER), winterAut: seasonAutarky(rF, [11, 0, 1]), yearAut: rF.autarky };
}

// Per month: a stacked PV bar (direct self / battery self / feed-in) next to a
// consumption bar – shows what the battery shifts from feed-in to self-use.
// PV chart colours derive from the central palette (single source of truth).
const PVC = { direct: COL.pv, batt: COL.batt, feed: COL.heat,
  sh: COL.sh, hp: COL.hp, ev: COL.ev, ac: COL.ac };
let _pvMonths = [];
function showPvTip(mi) {
  const m = _pvMonths[mi], t = $('toast'); if (!m || !t) return;
  const row = (c, l, v) => v > 0.05 ? `<div class="it"><span class="sw" style="background:${c}"></span>${l}: <b>${kwh(v, 0)}</b></div>` : '';
  // self-coverage for THIS month: PV directly used + from the battery (no feed-in)
  const self = m.direct + m.batt;
  const cover = m.load > 0 ? self / m.load * 100 : 0;
  const full = cover >= 99.5;
  const col = full ? '#4be0b0' : cover >= 60 ? '#f6b93b' : '#ef6c4d';
  t.innerHTML = `<b>${esc(m.label)}</b> · Erzeugung ${kwh(m.pv, 0)} · Verbrauch ${kwh(m.load, 0)}` +
    `<div class="note" style="margin-top:6px">Selbst gedeckt (PV direkt + Batterie): ` +
    `<b style="color:${col}">${kwh(self, 0)} = ${fmt(Math.min(cover, 100), 0)} %</b> des Verbrauchs` +
    `${full ? ' – Monat komplett gedeckt ✓' : ''}</div>` +
    `<div class="legend" style="margin-top:6px">` +
    row(PVC.direct, 'PV direkt', m.direct) + row(PVC.batt, 'PV Batterie', m.batt) +
    row(PVC.sh, 'Hausstrom', m.loadSh) + row(PVC.hp, 'Wärmepumpe', m.loadHp) +
    row(PVC.ev, 'E-Auto', m.loadEv) + row(PVC.ac, 'Klima', m.loadAc) + `</div>`;
  t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 10000);
}
function pvMonthlyChart(months) {
  const h = 210, pad = 26, top = 12, base = h - 22, n = months.length || 1;
  const max = Math.max(0.0001, ...months.map(m => Math.max((m.direct + m.batt + m.feed), m.load)));
  const gw = (CW - pad * 2) / n, bw = Math.max(2, gw * 0.30);
  const stack = (gx, segs) => {
    let y = base, out = '';
    segs.forEach(([v, col]) => {
      if (!(v > 0)) return; const bh = v / max * (base - top); y -= bh;
      out += `<rect x="${gx.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}"/>`;
    });
    return out;
  };
  let bars = '', labels = '', hits = '';
  months.forEach((m, i) => {
    const gx = pad + i * gw + gw * 0.12;
    bars += stack(gx, [[m.direct, PVC.direct], [m.batt, PVC.batt], [m.feed, PVC.feed]]);       // PV
    bars += stack(gx + bw + 2, [[m.loadSh, PVC.sh], [m.loadHp, PVC.hp], [m.loadEv, PVC.ev], [m.loadAc, PVC.ac]]); // Verbrauch
    hits += `<rect class="pvhit" data-mi="${i}" x="${(pad + i * gw).toFixed(1)}" y="${top}" width="${gw.toFixed(1)}" height="${(base - top).toFixed(1)}" fill="#000" opacity="0" pointer-events="all"/>`;
    if (m.label && (n <= 16 || i % Math.ceil(n / 12) === 0))
      labels += `<text class="axis" x="${(gx + bw).toFixed(1)}" y="${h - 8}" text-anchor="middle">${m.label}</text>`;
  });
  return svg(h, gridLines(h, top, base, pad, max) + bars + labels + hits);
}

// Net annual electricity cost (grid purchase − feed-in revenue) over PV size,
// with marker lines for the interesting kWp moments.
function pvEconChart(pts, marks) {
  const h = 220, pad = 40, top = 16, base = h - 34, n = pts.length;
  const kwps = pts.map(p => p.kwp);
  const vals = pts.map(p => p.net);
  let yMax = Math.max(0, ...vals), yMin = Math.min(0, ...vals);
  if (yMax === yMin) yMax += 1;
  const X = i => pad + (CW - pad - 6) * (n <= 1 ? 0 : i / (n - 1));
  const xForK = k => k <= kwps[0] ? X(0) : k >= kwps[n - 1] ? X(n - 1)
    : (() => { for (let i = 1; i < n; i++) if (k <= kwps[i]) { const t = (k - kwps[i - 1]) / (kwps[i] - kwps[i - 1]); return X(i - 1) + (X(i) - X(i - 1)) * t; } return X(n - 1); })();
  const Y = v => top + (base - top) * (1 - (v - yMin) / (yMax - yMin));
  // gridlines (min / 0 / max) with € labels
  let grid = '';
  [yMax, 0, yMin].forEach(v => {
    const y = Y(v);
    grid += `<line class="gl" x1="${pad}" x2="${CW - 4}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"${v === 0 ? ' stroke-width="1.5"' : ''}/>`;
    grid += `<text class="axis" x="0" y="${(y + 3).toFixed(1)}">${Math.round(v)}</text>`;
  });
  let line = '';
  pts.forEach((p, i) => { line += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.net).toFixed(1)} `; });
  let mk = '';
  (marks || []).forEach(m => {
    if (m.kwp == null || m.kwp < kwps[0] || m.kwp > kwps[n - 1]) return;
    const x = xForK(m.kwp);
    mk += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${base}" stroke="${m.color}" stroke-dasharray="3 3"/>` +
      `<text class="axis" x="${x.toFixed(1)}" y="${(top + m.row * 11 + 2).toFixed(1)}" text-anchor="middle" fill="${m.color}" style="font-size:9.5px">${m.label} ${fmt(m.kwp, 1)}</text>`;
  });
  let xl = '';
  for (let i = 0; i < n; i += Math.ceil(n / 6)) xl += `<text class="axis" x="${X(i).toFixed(1)}" y="${h - 20}" text-anchor="middle">${Math.round(kwps[i])}</text>`;
  xl += `<text class="axis" x="${(CW / 2).toFixed(1)}" y="${h - 5}" text-anchor="middle">Anlagengröße (kWp)</text>`;
  return svg(h, grid +
    `<path d="${line}" fill="none" stroke="url(#g1)" stroke-width="2.5" stroke-linejoin="round"/>` + mk + xl);
}
function renderPvEcon(p) {
  const cur = p.kwp || 5, price = STATE.price;
  const loadRaw = simulatePv({ ...p, kwp: 0.0001 }).load_kwh;
  const load = isFinite(loadRaw) ? loadRaw : 0;
  const coverK = load / (p.spec || 1000);
  let maxK = Math.min(60, Math.max(24, Math.ceil(coverK * 3.5), Math.ceil(cur * 1.5)));
  if (!isFinite(maxK) || maxK <= 0) maxK = 24;     // never let a bad input empty the curve
  const step = maxK / 22;
  const pts = [];
  for (let k = step; k <= maxK + 0.001; k += step) {
    const r = simulatePv({ ...p, kwp: k });
    pts.push({ kwp: k, net: r.grid_kwh * price - r.feed_kwh * p.feedin, self: r.self_rate });
  }
  // kWp where net cost crosses 0 (Einspeisung deckt Netzbezug)
  let nullK = null;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i - 1].net > 0 && pts[i].net <= 0) {
      const t = pts[i - 1].net / (pts[i - 1].net - pts[i].net);
      nullK = pts[i - 1].kwp + (pts[i].kwp - pts[i - 1].kwp) * t; break;
    }
  }
  const marks = [
    { kwp: cur, label: 'Wahl', color: COL.sh, row: 0 },
    { kwp: coverK, label: 'Deckung', color: PVC.feed, row: 1 },
  ];
  if (nullK) marks.push({ kwp: nullK, label: '0 €', color: PVC.direct, row: 2 });
  $('pv-econchart').innerHTML = pvEconChart(pts, marks);
  const knee = pts.find(x => x.self < 0.32) || pts[pts.length - 1] || { kwp: maxK };
  const curR = simulatePv(p);
  const curNet = curR.grid_kwh * price - curR.feed_kwh * p.feedin;
  $('pv-econchart-note').innerHTML =
    `Y = <b>Netto-Stromkosten/Jahr</b> (Netzbezug − Einspeise-Erlös), X = <b>kWp</b>. Unter der ` +
    `<b>0-€-Linie</b> verdienst du netto. Deine Wahl (${fmt(cur, 1)} kWp): <b>${money(curNet)}/Jahr</b> netto ` +
    `(Vorteil ${money(curR.benefit)}). ` +
    `<span style="color:${PVC.feed}">Deckung ${fmt(coverK, 1)} kWp</span> = Jahresertrag = Verbrauch; ` +
    (nullK ? `<span style="color:${PVC.direct}">0 € erst bei ${fmt(nullK, 1)} kWp</span> – so viel Dach hat kaum ` +
      `jemand, weil die Einspeisung (${fmt(p.feedin * 100, 1)} ct) viel weniger wert ist als der Netzstrom ` +
      `(${fmt(price * 100, 0)} ct). `
      : `die 0-€-Marke wird selbst bei ${fmt(maxK, 0)} kWp nicht erreicht – Einspeisung ist zu niedrig. `) +
    `Fazit: <b>Eigenverbrauch schlägt Größe</b> – Speicher, E-Auto & Warmwasser tagsüber bringen mehr als pure kWp. ` +
    `Ab ~${fmt(knee.kwp, 0)} kWp fließt fast nur noch Einspeisung.`;
}

function pvDayChart(pv, load, opts) {
  const h = 190, pad = 26, top = 12, base = h - 22, n = 24;
  const sc = opts && opts.nice ? niceScale(Math.max(0.0001, ...pv, ...load)) : null;
  const max = sc ? sc.max : Math.max(0.0001, ...pv, ...load);
  const X = i => pad + (CW - pad - 6) * (i / (n - 1));
  const Y = v => top + (base - top) * (1 - v / max);
  let selfA = `M${X(0).toFixed(1)} ${base} `, pvL = '', loadL = '';
  for (let i = 0; i < n; i++) {
    selfA += `L${X(i).toFixed(1)} ${Y(Math.min(pv[i], load[i])).toFixed(1)} `;
    pvL += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(pv[i]).toFixed(1)} `;
    loadL += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(load[i]).toFixed(1)} `;
  }
  selfA += `L${X(n - 1).toFixed(1)} ${base} Z`;
  let labels = '';
  for (let hh = 0; hh < 24; hh += 6) labels += `<text class="axis" x="${X(hh).toFixed(1)}" y="${h - 8}" text-anchor="middle">${hh}</text>`;
  return svg(h, gridLines(h, top, base, pad, max, sc ? { step: sc.step, unit: opts.unit || '' } : undefined) +
    `<path d="${selfA}" fill="#4be0b0" opacity="0.28"/>` +
    `<path d="${pvL}" fill="none" stroke="${COL.heat}" stroke-width="2.5" stroke-linejoin="round"/>` +
    `<path d="${loadL}" fill="none" stroke="${COL.sh}" stroke-width="2.5" stroke-linejoin="round"/>` + labels);
}

// Sweep chart of netzfreie Monate per kWp: value label on each bar + hover/tap
// hit rects so the exact count is easy to read.
function gridFreeSweepChart(data, cur) {
  const h = 185, pad = 26, top = 20, base = h - 22, n = data.length || 1;
  const max = Math.max(1, ...data.map(d => d.count));
  const gw = (CW - pad * 2) / n, iw = Math.max(3, gw * 0.62);
  let bars = '', labels = '', vlab = '', hits = '';
  data.forEach((d, i) => {
    const bh = d.count / max * (base - top);
    const x = pad + i * gw + (gw - iw) / 2, y = base - bh, isCur = d.kwp === cur;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2.5" fill="${isCur ? 'url(#g1)' : COL.sh}"/>`;
    if (d.count > 0) vlab += `<text x="${(x + iw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" style="font-size:11px;font-weight:700;fill:var(--ink)">${fmt(d.count, 1)}</text>`;
    labels += `<text class="axis" x="${(x + iw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle"${isCur ? ' style="fill:#4da3ff;font-weight:700"' : ''}>${d.kwp}${isCur ? '★' : ''}</text>`;
    hits += `<rect class="gfhit" data-kwp="${d.kwp}" data-count="${d.count}" x="${(pad + i * gw).toFixed(1)}" y="${top}" width="${gw.toFixed(1)}" height="${(base - top).toFixed(1)}" fill="#000" opacity="0" pointer-events="all"/>`;
  });
  return svg(h, gridLines(h, top, base, pad, max) + bars + vlab + labels + hits);
}
function showGfTip(kwp, count) {
  const t = $('toast'); if (!t) return;
  t.innerHTML = `<b>${kwp} kWp</b> → <b style="color:${count >= 5 ? '#4be0b0' : count >= 2 ? '#f6b93b' : '#ef6c4d'}">${fmt(count, 1)} von 12 Monaten</b> ohne Netzbezug (aus Tagen)`;
  t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 6000);
}
// Typical residential household hourly share (fallback when no measured profile
// is available). Low overnight, a morning bump and a broad evening peak.
const HOME_SHAPE_DEFAULT = normFrac(
  [0.6, 0.5, 0.45, 0.45, 0.5, 0.7, 1.1, 1.4, 1.2, 1.0, 1.0, 1.05,
   1.1, 1.0, 0.95, 1.0, 1.15, 1.5, 1.9, 2.0, 1.8, 1.5, 1.1, 0.8]);
// Sunrise/sunset as LOCAL clock decimal hours for a lat/lon and date. Standard
// solar-geometry approximation (declination + equation of time); good to a few
// minutes – plenty for sizing. Returns nulls on polar day/night.
function sunTimes(lat, lon, date) {
  const rad = Math.PI / 180;
  const start = new Date(date.getFullYear(), 0, 0);
  const N = Math.round((date - start) / 86400000);                      // day of year
  const decl = -23.45 * rad * Math.cos(2 * Math.PI * (N + 10) / 365);   // solar declination
  const cosH = -Math.tan(lat * rad) * Math.tan(decl);
  if (cosH >= 1) return { sunrise: null, sunset: null, dayLen: 0, polar: 'night' };
  if (cosH <= -1) return { sunrise: null, sunset: null, dayLen: 24, polar: 'day' };
  const H = Math.acos(cosH) / rad, dayLen = 2 * H / 15;
  const B = 2 * Math.PI * (N - 81) / 364;
  const EoT = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // minutes
  const tz = -date.getTimezoneOffset() / 60;                            // local UTC offset incl. DST
  const TC = 4 * (lon - 15 * tz) + EoT;                                 // time correction, minutes
  const noon = 12 - TC / 60;
  return { sunrise: noon - dayLen / 2, sunset: noon + dayLen / 2, dayLen, polar: null };
}
// Representative hourly consumption (kWh/h) for a calendar month, split into
// household (+WP) and the planned EV/AC, from the real measured hourly profiles.
function hourlyLoadKwh(monthIdx) {
  let shShape = normFrac((STATE.data && STATE.data.hourly_profile || []).map(h => h.avg_w));
  if (shShape.length !== 24) shShape = HOME_SHAPE_DEFAULT;
  const hpProf = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const hpShape = (hpProf.length === 24 && hpProf.some(h => h.avg_w > 0))
    ? normFrac(hpProf.map(h => h.avg_w)) : new Array(24).fill(1 / 24);
  const shD = shAvgDaily();
  const hpD = (monthIdx == null) ? hpAvgDaily() : hpMonthEst(monthIdx) / DIM[monthIdx];
  const p = pvInputs(), evD = p.evAnnual / 365, acD = p.acAnnual / 365;
  const hw = [], ev = [], ac = [];
  for (let h = 0; h < 24; h++) {
    hw[h] = shD * shShape[h] + hpD * hpShape[h];
    ev[h] = evD * EV_SHAPE[h]; ac[h] = acD * AC_SHAPE[h];
  }
  return { hw, ev, ac };
}
// Sum of hourly values that fall OUTSIDE the daylight window [sunrise,sunset]
// (i.e. from sunset to the next sunrise), with fractional hours at the edges.
function nightSum(arr, st) {
  if (!st || st.sunrise == null) return arr.reduce((a, b) => a + b, 0); // polar night → all night
  let s = 0;
  for (let h = 0; h < 24; h++) {
    const dayPart = Math.max(0, Math.min(h + 1, st.sunset) - Math.max(h, st.sunrise));
    s += arr[h] * (1 - Math.min(1, dayPart));
  }
  return s;
}
const _hhm = x => { const h = Math.floor(x), m = Math.round((x - h) * 60); return `${String((h + 24) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
// 24 h consumption bars, night hours highlighted, with sunrise/sunset markers.
function nightChart(hw, st) {
  const h = 108, top = 10, base = h - 18, left = 2, right = CW - 2, w = right - left, bw = w / 24;
  const max = Math.max(0.001, ...hw);
  let bars = '';
  for (let i = 0; i < 24; i++) {
    const bh = (hw[i] / max) * (base - top);
    const dayPart = st.sunrise == null ? 0 : Math.max(0, Math.min(i + 1, st.sunset) - Math.max(i, st.sunrise));
    const night = (1 - Math.min(1, dayPart)) > 0.5;
    bars += `<rect x="${(left + i * bw + 0.6).toFixed(1)}" y="${(base - bh).toFixed(1)}" width="${(bw - 1.2).toFixed(1)}" ` +
      `height="${Math.max(0, bh).toFixed(1)}" rx="1" fill="${night ? COL.hp : '#f6b93b'}" opacity="0.85"/>`;
  }
  let marks = '';
  if (st.sunrise != null) [st.sunrise, st.sunset].forEach(x => {
    const mx = left + (x / 24) * w;
    marks += `<line x1="${mx.toFixed(1)}" y1="${top}" x2="${mx.toFixed(1)}" y2="${base}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 2"/>`;
  });
  let ticks = '';
  [0, 6, 12, 18, 23].forEach(hh => { ticks += `<text class="axis" x="${(left + (hh + 0.5) * bw).toFixed(1)}" y="${h - 4}" text-anchor="middle" style="font-size:9px">${hh}</text>`; });
  return svg(h, bars + marks + ticks);
}
// Representative-day chart with a summer/winter toggle.
let _pvRep = { summer: null, winter: null };
let _pvDaySeason = 'summer';
function renderPvDay() {
  const el = $('pv-day'); if (!el) return;
  const sel = _pvDaySeason === 'winter' ? _pvRep.winter : _pvRep.summer;
  el.innerHTML = sel ? pvDayChart(sel.pv, sel.load) : '<div class="note">Kein Tagesprofil verfügbar.</div>';
  const sB = $('pv-day-summer'), wB = $('pv-day-winter');
  if (sB && wB) { sB.className = _pvDaySeason === 'winter' ? 'btn sec' : 'btn'; wB.className = _pvDaySeason === 'winter' ? 'btn' : 'btn sec'; }
  const note = $('pv-day-note');
  if (note) note.innerHTML = _pvDaySeason === 'winter'
    ? '❄︎ <b>Winter</b> (Mitte Januar): wenig Sonne, hoher Verbrauch (Wärmepumpe) – die Erzeugung deckt nur einen kleinen Teil, der Rest kommt aus dem Netz.'
    : '☀︎ <b>Sommer</b> (Mitte Juli): viel Sonne – der Mittags-Überschuss übersteigt den Verbrauch deutlich und lädt Speicher / wird eingespeist.';
}
// How much you consume from sunset to sunrise, per season, to size a PV battery.
function renderPvNight() {
  const card = $('pv-night-card'); if (!card) return;
  if (!(shAvgDaily() > 0 || hpAvgDaily() > 0)) { card.hidden = true; return; }
  card.hidden = false;
  const loc = getLatLon();
  const lat = loc ? loc.lat : 51, lon = loc ? loc.lon : 10;    // fallback: centre of Germany
  const price = STATE.price, p = pvInputs();
  const now = new Date(), yr = now.getFullYear();
  const seasons = [
    { label: '☀︎ Sommer', date: new Date(yr, 5, 21), m: 5 },
    { label: '🍂 Frühjahr/Herbst', date: new Date(yr, 8, 23), m: 8 },
    { label: '❄︎ Winter', date: new Date(yr, 11, 21), m: 11 },
  ].map(se => {
    const st = sunTimes(lat, lon, se.date), l = hourlyLoadKwh(se.m);
    const night = nightSum(l.hw, st), nEv = nightSum(l.ev, st), nAc = nightSum(l.ac, st);
    const nightLen = st.sunrise == null ? 24 : 24 - st.dayLen;
    return { ...se, st, night, nEv, nAc, nightLen };
  });
  // today
  const stTod = sunTimes(lat, lon, now), lTod = hourlyLoadKwh(now.getMonth());
  const nTod = nightSum(lTod.hw, stTod);
  const winTxt = stTod.sunrise == null ? '—' : `${_hhm(stTod.sunset)} → ${_hhm(stTod.sunrise)}`;
  $('pv-night-body').innerHTML =
    `<div class="grid2"><div class="kpi"><div class="v">${kwh(nTod, 1)}</div>` +
    `<div class="l">heute Nacht (Haushalt+WP) · ${money(nTod * price)}</div></div>` +
    `<div class="kpi sm"><div class="v" style="font-size:19px">${winTxt}</div>` +
    `<div class="l">Sonnenuntergang → -aufgang (${fmt(24 - (stTod.dayLen || 0), 1)} h Nacht)</div></div></div>` +
    `<div style="overflow-x:auto;margin-top:8px"><table style="width:100%;border-collapse:collapse;font-size:13px">` +
    `<tr style="color:var(--muted);text-align:left"><th style="padding:4px 6px">Jahreszeit</th><th>Nacht</th><th style="text-align:right;padding:4px 6px">Verbrauch Nacht</th></tr>` +
    seasons.map(s => `<tr style="border-top:1px solid var(--line)"><td style="padding:6px">${s.label}</td>` +
      `<td style="color:var(--muted)">${s.st.sunrise == null ? '—' : _hhm(s.st.sunset) + '→' + _hhm(s.st.sunrise)}<br><small>${fmt(s.nightLen, 1)} h</small></td>` +
      `<td style="text-align:right;padding:6px"><b>${kwh(s.night, 1)}</b>` +
      ((s.nEv + s.nAc) > 0.05 ? `<br><small style="color:var(--muted)">+${kwh(s.nEv + s.nAc, 1)} EV/Klima</small>` : '') + `</td></tr>`).join('') +
    `</table></div>`;
  $('pv-night-chart').innerHTML = nightChart(lTod.hw, stTod) +
    `<div class="legend" style="margin-top:2px"><div class="it"><span class="sw" style="background:${COL.hp}"></span>Nacht</div>` +
    `<div class="it"><span class="sw" style="background:#f6b93b"></span>Tag</div>` +
    `<span style="color:var(--muted);font-size:11px;margin-left:6px">Verbrauch je Stunde – heute</span></div>`;
  // battery recommendation: the shoulder season (spring/autumn) is the longest
  // night the PV can still realistically recharge for → good sizing target.
  const shoulder = seasons[1].night, summer = seasons[0].night, winter = seasons[2].night;
  const target = shoulder, dod = 0.9, nominal = target / dod;
  const roundHalf = v => Math.max(0.5, Math.round(v * 2) / 2);
  const recNom = roundHalf(nominal);
  const hasBatt = p.batt > 0;
  let battTxt = '';
  if (hasBatt) {
    const coverS = summer > 0 ? Math.min(1, p.batt * dod / summer) : 1;
    const coverSh = shoulder > 0 ? Math.min(1, p.batt * dod / shoulder) : 1;
    battTxt = `Dein geplanter Speicher <b>${kwh(p.batt, 0)}</b> (~${kwh(p.batt * dod, 1)} nutzbar) deckt die Nacht ` +
      `im Sommer zu <b>${fmt(coverS * 100, 0)} %</b>, in der Übergangszeit zu <b>${fmt(coverSh * 100, 0)} %</b>. `;
  }
  $('pv-night-note').innerHTML =
    `Für <b>volle Nacht-Autarkie im PV-Halbjahr</b> (Frühjahr–Herbst) brauchst du ~<b>${kwh(target, 1)}</b> nutzbar, ` +
    `also einen Speicher von ~<b>${kwh(recNom, 0)}</b> (bei ~90 % Entladetiefe). ` + battTxt +
    `<span style="color:var(--muted)">Sommer-Nacht ~${kwh(summer, 1)}, Winter-Nacht ~${kwh(winter, 1)} – ` +
    `aber im <b>Winter füllt die PV den Speicher kaum</b>, darum lohnt es nicht, ihn auf die lange Winternacht auszulegen. ` +
    `Nachts laufende Dauerverbraucher (WP-Warmwasser, Standby) treiben den Wert – die lassen sich teils in den Tag schieben.` +
    (loc ? '' : ' <b>Hinweis:</b> ohne deinen Standort (PV-Tab) rechne ich mit der Mitte Deutschlands.') + `</span>`;
}
// Show the consumption basis the PV planner uses for ALL its numbers, so it's
// transparent where the kWh come from.
function renderPvBasis() {
  const el = $('pv-basis'); if (!el) return;
  const p = pvInputs();
  let wp = 0; for (let m = 0; m < 12; m++) wp += hpMonthEst(m);   // Σ Monatsmodell = wie Verlauf/Wärme
  const haus = householdBaseDaily() * 365;
  const ev = p.evAnnual, ac = p.acAnnual, tot = haus + wp + ev + ac;
  if (!(tot > 0)) { el.innerHTML = ''; return; }
  const part = (lbl, v) => v > 0 ? `${lbl} <b>${kwh(v, 0)}</b>` : '';
  const parts = [part('🏠 Hausstrom', haus), part('🔥 Wärmepumpe', wp), part('🚗 E-Auto', ev), part('❄︎ Klima', ac)].filter(Boolean);
  el.innerHTML = `<b>Rechenbasis:</b> Gesamtverbrauch <b>${kwh(tot, 0)}/Jahr</b> = ` + parts.join(' + ') +
    `. <span style="color:var(--muted)">Grundlage für Ertrag, Autarkie, Grenznutzen und Produktvorschlag. ` +
    `Wärmepumpe = <b>Summe der Monatswerte</b> (dieselbe Zahl wie im <b>Verlauf</b> und unter <b>Wärme „Erwartet"</b>, inkl. Winter-Theorie), ` +
    `Hausstrom aus deinen Messungen, E-Auto/Klima aus deinen Eingaben oben.</span>`;
}
// Cost per kWp (turnkey) to judge whether an extra kWp still pays. Prefers the
// user's own DIY set price; else a sensible German default.
function pvCosts() {
  const num = (id, d) => { const v = parseFloat($(id) && $(id).value); return isFinite(v) && v >= 0 ? v : d; };
  return { kwp: num('pv-cost-kwp', 1400), kwh: num('pv-cost-kwh', 700), base: num('pv-cost-base', 2000) };
}
// Turnkey investment for a given array + battery (€). Base = scaffolding,
// electrician, grid registration, meter; plus €/kWp (modules+inverter+mounting)
// and €/kWh (storage incl. hybrid surcharge).
function pvInvest(kwp, batt, c) { c = c || pvCosts(); return c.base + Math.max(0, kwp) * c.kwp + Math.max(0, batt) * c.kwh; }
function pvCostPerKwp() { return pvCosts().kwp; }
// kWp-sweep chart: line or bars over kWp, with an optional cost threshold line
// and vertical markers (e.g. your current size, the sweet spot).
function pvKwpChart(ks, vals, opts = {}) {
  const h = opts.h || 148, pad = 30, top = 16, base = h - 22, left = pad, right = CW - 8, plotW = right - left;
  const n = ks.length, kmin = ks[0], kmax = ks[n - 1];
  const X = k => left + (kmax > kmin ? (k - kmin) / (kmax - kmin) : 0) * plotW;
  const max = Math.max(0.0001, ...vals, opts.threshold || 0, ...(opts.line2 || []));
  const Y = v => base - Math.max(0, v) / max * (base - top);
  let body = '';
  if (opts.type === 'bars') {
    const bw = Math.max(2, plotW / n * 0.68);
    vals.forEach((v, i) => {
      const x = X(ks[i]) - bw / 2, y = Y(v), below = opts.threshold != null && v < opts.threshold;
      body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, base - y).toFixed(1)}" rx="1.5" ` +
        `fill="${below ? '#8b93a7' : (opts.color || COL.pv)}" opacity="${below ? 0.5 : 0.9}"/>`;
    });
  } else {
    body += `<path d="${vals.map((v, i) => (i ? 'L' : 'M') + X(ks[i]).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ')}" fill="none" stroke="${opts.color || COL.pv}" stroke-width="2"/>`;
  }
  if (opts.line2) {
    body += `<path d="${opts.line2.map((v, i) => (i ? 'L' : 'M') + X(ks[i]).toFixed(1) + ' ' + Y(v).toFixed(1)).join(' ')}" fill="none" stroke="${opts.line2Color || '#8b93a7'}" stroke-width="1.6" stroke-dasharray="${opts.line2Dash || '5 3'}"/>`;
  }
  if (opts.threshold != null) {
    const ty = Y(opts.threshold);
    body += `<line x1="${left}" y1="${ty.toFixed(1)}" x2="${right}" y2="${ty.toFixed(1)}" stroke="#ef6c4d" stroke-width="1" stroke-dasharray="4 3"/>` +
      `<text x="${right}" y="${(ty - 3).toFixed(1)}" text-anchor="end" style="font-size:9px;fill:#ef6c4d">${esc(opts.thresholdLabel || '')}</text>`;
  }
  (opts.markers || []).forEach(mk => {
    const mx = X(mk.k);
    body += `<line x1="${mx.toFixed(1)}" y1="${top}" x2="${mx.toFixed(1)}" y2="${base}" stroke="${mk.color || 'var(--ink)'}" stroke-width="1.2" opacity="0.75"/>` +
      `<text x="${Math.min(right - 2, Math.max(left + 2, mx)).toFixed(1)}" y="${(top - 4).toFixed(1)}" text-anchor="middle" style="font-size:9px;fill:${mk.color || 'var(--ink)'}">${esc(mk.label || '')}</text>`;
  });
  let ticks = ''; const step = Math.max(1, Math.round(n / 8));
  for (let i = 0; i < n; i += step) ticks += `<text class="axis" x="${X(ks[i]).toFixed(1)}" y="${h - 6}" text-anchor="middle" style="font-size:9px">${ks[i]}</text>`;
  ticks += `<text class="axis" x="${right}" y="${h - 6}" text-anchor="end" style="font-size:9px">kWp</text>`;
  return svg(h, gridLines(h, top, base, pad, max) + body + ticks);
}
// "Ab wann lohnt mehr kWp?" – marginal benefit per added kWp vs. its cost.
function renderPvMargin() {
  const card = $('pv-margin-card'); if (!card) return;
  if (!(shAvgDaily() > 0 || hpAvgDaily() > 0)) { card.hidden = true; return; }
  card.hidden = false;
  const p = pvInputs(), price = STATE.price, c = pvCosts(), LIFE = 20;
  const cur = Math.max(1, Math.round(p.kwp || 0));
  const maxK = Math.max(14, Math.ceil(cur * 1.8));
  const ks = []; for (let k = 1; k <= maxK; k++) ks.push(k);
  const runs = ks.map(k => simulatePv({ ...p, kwp: k }));
  const benefit = runs.map(r => r.benefit);                               // €/yr (Ersparnis + Einspeisung)
  const autk = runs.map(r => r.autarky * 100);
  const invest = ks.map(k => pvInvest(k, p.batt, c));                     // € turnkey
  const yield20 = benefit.map(b => b * LIFE);                             // € Ertrag über 20 J (grob, ohne Preissteigerung/Degradation)
  const marg = benefit.map((b, i) => i === 0 ? b : b - benefit[i - 1]);   // €/yr per +1 kWp
  const annCost = c.kwp / LIFE;                                           // €/kWp·a (Grenzkosten)
  let sweet = 1; for (let i = 0; i < ks.length; i++) if (marg[i] >= annCost) sweet = ks[i];
  const autAt = k => autk[Math.min(autk.length - 1, Math.max(0, k - 1))];
  const benAt = k => benefit[Math.min(benefit.length - 1, Math.max(0, k - 1))];
  const investCur = pvInvest(cur, p.batt, c), benCur = benAt(cur);
  const payback = benCur > 0 ? investCur / benCur : 0;
  const net20 = benCur * LIFE - investCur;
  // is the battery worth it? benefit with vs without
  const benNoBatt = simulatePv({ ...p, batt: 0 }).benefit;
  const battVal = Math.max(0, benCur - benNoBatt), battCost = p.batt * c.kwh;
  const battPay = battVal > 0 ? battCost / battVal : 0;
  $('pv-margin-kpi').innerHTML = '<div class="grid3">' +
    `<div class="kpi sm"><div class="v" style="color:#4be0b0">${fmt(sweet, 0)} kWp</div><div class="l">wirtschaftl. Optimum · Autarkie ~${fmt(autAt(sweet), 0)} %</div></div>` +
    `<div class="kpi sm"><div class="v">${money(investCur)}</div><div class="l">Investition bei ${fmt(cur, 0)} kWp + ${fmt(p.batt, 0)} kWh</div></div>` +
    `<div class="kpi sm"><div class="v">${payback > 0 ? '~' + fmt(payback, 1) + ' J.' : '–'}</div><div class="l">Amortisation · Netto 20 J. ${money(net20)}</div></div></div>`;
  const mkCur = { k: cur, label: '★ du', color: '#4da3ff' };
  const mkSweet = { k: sweet, label: 'Optimum', color: '#4be0b0' };
  $('pv-margin-chart').innerHTML = pvKwpChart(ks, yield20, { color: COL.pv, line2: invest, line2Color: '#ef6c4d',
    markers: [mkCur, mkSweet], h: 150 });
  $('pv-margin-legend').innerHTML = `<span style="font-size:11px"><span style="color:${COL.pv}">▬</span> Ertrag über 20 J. · ` +
    `<span style="color:#ef6c4d">▬ ▬</span> Investition. <span style="color:var(--muted)">Abstand = Gewinn; läuft der Abstand nicht mehr auseinander, lohnt mehr kWp nicht.</span></span>`;
  $('pv-margin-chart2').innerHTML = pvKwpChart(ks, marg, { type: 'bars', color: COL.heat,
    threshold: annCost, thresholdLabel: `Kostengrenze ~${money(annCost)}/kWp·a`, markers: [mkCur, mkSweet], h: 140 });
  $('pv-margin-legend2').innerHTML = `<span style="color:var(--muted);font-size:11px">Grenznutzen: €/Jahr pro +1 kWp. Graue Balken unter der roten Linie kosten mehr als sie bringen.</span>`;
  $('pv-margin-note').innerHTML =
    `So rechne ich: <b>Nutzen/Jahr = Ersparnis (Eigenverbrauch × ${money(price)}) + Einspeisung (× ${money(p.feedin)})</b>, dem gegenüber steht die ` +
    `<b>Investition</b> (${money(c.base)} Grund + ${money(c.kwp)}/kWp + ${money(c.kwh)}/kWh Speicher – oben editierbar). ` +
    `Wirtschaftlich optimal sind ~<b>${fmt(sweet, 0)} kWp</b>: dort bringt das letzte kWp gerade noch seine Kosten rein; darüber geht der Überschuss nur noch billig ins Netz. ` +
    (p.batt > 0 ? `<br><span style="color:var(--muted)">Dein <b>Speicher</b> (${fmt(p.batt, 0)} kWh ≈ ${money(battCost)}) bringt ~${money(battVal)}/Jahr mehr Eigenverbrauch → Amortisation ~${battPay > 0 ? fmt(battPay, 0) + ' J.' : '–'}.</span>` : '') +
    ` <span style="color:var(--muted)">Grob: ohne Strompreissteigerung (konservativ) und ohne Modul-Degradation/Speichertausch (optimistisch) – beides hebt sich näherungsweise auf.</span>`;
}
// Concrete components: a Fronius GEN24 Plus hybrid inverter (battery-ready,
// expandable) sized with headroom, plus a modular BYD/LG battery – now with the
// real electrical sizing (MPP trackers, string voltages, DC/AC, input current).
const FRONIUS_URL = 'https://www.fronius.com/de-de/germany/solarenergie';
const BYD_URL = 'https://www.bydbatterybox.com/';
const LG_URL = 'https://www.lgessbattery.com/';
const AIKO_URL = 'https://www.aikosolar.com/';
// Available Fronius GEN24 Plus single units (AC kW). Each has 2 MPP trackers,
// max. DC ~1,5× AC. Primo = 1-phasig (klein), Symo = 3-phasig.
const FRONIUS_UNITS = [
  { kw: 3, phase: '1-phasig', family: 'Primo GEN24 Plus' },
  { kw: 4, phase: '1-phasig', family: 'Primo GEN24 Plus' },
  { kw: 5, phase: '1-phasig', family: 'Primo GEN24 Plus' },
  { kw: 6, phase: '3-phasig', family: 'Symo GEN24 Plus' },
  { kw: 8, phase: '3-phasig', family: 'Symo GEN24 Plus' },
  { kw: 10, phase: '3-phasig', family: 'Symo GEN24 Plus' },
];
function froniusInverter(kwp) {
  const spec = { maxSysV: 1000, mppt: 2, maxImpA: 25, dcFactor: 1.5, mppMin: 150 };
  const mk = (u, count) => Object.assign({
    name: `${count > 1 ? count + '× ' : ''}Fronius ${u.family.split(' ')[0]} GEN24 ${u.kw.toFixed(1)} Plus`,
    kw: u.kw, count, totalKw: u.kw * count, phase: u.phase, family: u.family, multi: count > 1 }, spec);
  const idealAC = kwp / 1.15;                              // Ziel DC/AC ~1,15
  // smallest single unit that carries this DC within DC/AC ≤ 1,5 …
  let u = FRONIUS_UNITS.find(x => x.kw >= idealAC) || (kwp <= 10 * spec.dcFactor ? FRONIUS_UNITS[FRONIUS_UNITS.length - 1] : null);
  if (u) return mk(u, 1);
  // … else split across several 10-kW units (each bis ~15 kWp DC)
  const count = Math.ceil(kwp / (10 * spec.dcFactor));
  const perDc = kwp / count;
  const pu = FRONIUS_UNITS.find(x => x.kw >= perDc / 1.15) || FRONIUS_UNITS[FRONIUS_UNITS.length - 1];
  return mk(pu, count);
}
// Average module electricals derived from its Wp. Defaults suit AIKO Neostar
// (N-type ABC back-contact): higher voltage, excellent low-light/shading.
function moduleSpec(wp) {
  const Imp = 13.6, Vmp = wp / Imp, Voc = Vmp * 1.19, VocCold = Voc * 1.0875; // -10 °C
  return { wp, Imp, Vmp, Voc, VocCold };
}
// String layout for a kWp target with this inverter + module: how many modules
// in series per MPP tracker so the cold open-circuit voltage stays < 1000 V and
// the operating voltage sits in the MPP window; plus DC/AC and headroom.
function pvStringSizing(kwp, inv, ms) {
  const total = Math.max(1, Math.round(kwp * 1000 / ms.wp));
  const maxSeries = Math.max(1, Math.floor(inv.maxSysV / ms.VocCold));   // Spannungsgrenze
  const minSeries = Math.max(4, Math.ceil(inv.mppMin / ms.Vmp));
  const mpptTotal = inv.mppt * (inv.count || 1);
  // use as many MPP trackers as make sense (each string ≥ minSeries), capped by
  // the voltage limit per string
  let strings = Math.max(1, Math.min(mpptTotal, Math.floor(total / minSeries) || 1));
  if (Math.ceil(total / strings) > maxSeries) strings = Math.ceil(total / maxSeries);
  const b = Math.floor(total / strings), rem = total % strings;
  const per = Array.from({ length: strings }, (_, i) => b + (i < rem ? 1 : 0));
  const perMax = Math.max(...per), perMin = Math.min(...per);
  const ac = inv.totalKw || inv.kw;
  const dcKwp = total * ms.wp / 1000, maxDcKwp = ac * inv.dcFactor, dcac = dcKwp / ac;
  return { total, strings, per, maxSeries, minSeries, mpptTotal,
    vOper: Math.round(ms.Vmp * per[0]), vColdMax: Math.round(ms.VocCold * perMax),
    voltOk: ms.VocCold * perMax < inv.maxSysV, mppOk: ms.Vmp * perMin >= inv.mppMin, seriesOk: perMax <= maxSeries,
    dcKwp, maxDcKwp, dcac, overDc: dcac > inv.dcFactor,
    headroom: Math.max(0, Math.floor(maxDcKwp * 1000 / ms.wp) - total),
    ImpOk: ms.Imp <= inv.maxImpA };
}
function bydBattery(usableKwh) {
  const modKwh = 2.56;                                 // HVS module
  const n = Math.max(2, Math.min(5, Math.round((usableKwh / 0.9) / modKwh) || 2));
  return { name: `BYD Battery-Box Premium HVS ${(n * modKwh).toFixed(2)}`, modules: n, nom: +(n * modKwh).toFixed(2),
    min: 5.12, max: 12.8, maxModules: 5 };
}
function renderPvProduct() {
  const card = $('pv-product-card'); if (!card) return;
  if (!(shAvgDaily() > 0 || hpAvgDaily() > 0)) { card.hidden = true; return; }
  card.hidden = false;
  const p = pvInputs();
  const kwpNow = Math.max(1, p.kwp || 0);
  const modWp = Math.max(200, Math.min(700, parseFloat($('pv-mod-wp') && $('pv-mod-wp').value) || 460));
  if ($('pv-product-head')) $('pv-product-head').textContent = `${fmt(kwpNow, 1)} kWp · ${fmt(p.batt, 1)} kWh`;
  // Size the inverter for the array you build NOW; future-proofing comes from the
  // GEN24's own ~1,5× DC headroom (you add modules later, not a second inverter).
  const inv = froniusInverter(kwpNow);
  const ms = moduleSpec(modWp), sz = pvStringSizing(kwpNow, inv, ms);
  // battery target ≈ shoulder-season night consumption (as in the Speicher card)
  const loc = getLatLon(), lat = loc ? loc.lat : 51, lon = loc ? loc.lon : 10, yr = new Date().getFullYear();
  const batTarget = p.batt > 0 ? p.batt : Math.max(5, nightSum(hourlyLoadKwh(8).hw, sunTimes(lat, lon, new Date(yr, 8, 23))));
  const bat = bydBattery(batTarget);
  // The GEN24's hard DC limit is inv.dcFactor (1,5). Up to there, a DC/AC > 1 is
  // DELIBERATE overpaneling – it lifts morning/evening/winter yield and, with a
  // battery, is usually the better economics; only ABOVE 1,5 is a bigger WR due.
  const limit = inv.dcFactor;
  const dcacTxt = sz.dcac < 1.05 ? 'WR mit Reserve – Module noch ergänzbar'
    : sz.dcac <= 1.25 ? 'ideal'
    : sz.dcac <= limit ? 'bewusst überbelegt – mehr Morgen/Abend/Winter-Ertrag, kaum Mittagskappung (mit Speicher ideal)'
    : 'über WR-Grenze – größerer/zweiter WR nötig';
  const dcacCol = sz.dcac > limit ? '#ef6c4d' : sz.dcac > 1.25 ? '#f6b93b' : '#4be0b0';
  const acKw = inv.totalKw || inv.kw, mpptTot = inv.mppt * (inv.count || 1);
  // "2 MPP-Tracker je WR" is the real per-device figure; show the sum only when
  // there is more than one inverter, so a single GEN24 never reads as "4 Tracker".
  const mpptTxt = inv.count > 1 ? `${inv.mppt} MPP-Tracker je WR (${mpptTot} gesamt)` : `${inv.mppt} MPP-Tracker`;
  const a = (href, txt) => `<a href="${href}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(txt)} ↗</a>`;
  const row = (icon, title, sub) => `<div class="devrow"><div class="nm"><b>${icon} ${title}</b><small>${sub}</small></div></div>`;
  $('pv-product-body').innerHTML =
    row('🔌', esc(inv.name), `Hybrid, ${inv.phase}, <b>batteriefähig</b> · <b>${acKw.toFixed(1)} kW AC</b>${inv.count > 1 ? ` (${inv.count}× ${inv.kw.toFixed(1)} kW)` : ''} · ` +
      `${mpptTxt} · max ${inv.maxSysV} V · ~${inv.maxImpA} A/MPP · max DC ~${fmt(acKw * inv.dcFactor, 1)} kWp · ${a(FRONIUS_URL, 'Fronius')}`) +
    row('🔗', 'Verschaltung', `${sz.strings} Strings über ${mpptTot} MPP-Tracker · <b>${sz.per.join(' + ')} Module in Reihe</b> · ` +
      `Betrieb ~${sz.vOper} V (MPP ab ${inv.mppMin} V) · Leerlauf kalt ~${sz.vColdMax} V ${sz.voltOk ? '<b style="color:#4be0b0">✓ &lt; 1000 V</b>' : '<b style="color:#ef6c4d">⚠︎ &gt; 1000 V – kürzere Strings!</b>'} · Strom ~${fmt(ms.Imp, 1)} A/String ✓`) +
    row('⚡', 'Eingang / Ausgang', `DC-Eingang <b>${fmt(sz.dcKwp, 1)} kWp</b> an Modulen · AC-Ausgang <b>${acKw.toFixed(1)} kW</b> · ` +
      `DC/AC <b style="color:${dcacCol}">${fmt(sz.dcac, 2)}</b> <span style="color:${dcacCol}">(${dcacTxt})</span>` +
      (sz.overDc ? ` <b style="color:#ef6c4d">⚠︎ über WR-Grenze (${fmt(inv.dcFactor, 2)}) – größerer/zweiter WR!</b>` : '')) +
    row('☀︎', `${sz.total}× AIKO Neostar (ABC) ~${modWp} Wp`, `Zukunftssicher: <b>Rückkontakt-Zellen</b> (ABC), ~23–24 % Wirkungsgrad, ` +
      `sehr gut bei <b>Verschattung/Schwachlicht</b> & mehr kWp/m² · Ø Modul: Vmp ~${fmt(ms.Vmp, 0)} V · Voc ~${fmt(ms.Voc, 0)} V · Imp ~${fmt(ms.Imp, 1)} A (typisch) · ` +
      `am WR noch Platz für ~<b>${sz.headroom}</b> Module (bis ${fmt(acKw * inv.dcFactor, 1)} kWp DC) · ${a(AIKO_URL, 'AIKO')}`) +
    row('🔋', esc(bat.name), `${bat.modules}× 2,56 kWh = <b>${fmt(bat.nom, 1)} kWh</b> · <b>modular</b> stapelbar ${bat.min}–${bat.max} kWh, später aufstocken · Fronius-kompatibel (HV) · ${a(BYD_URL, 'BYD Battery-Box')}`) +
    row('↔︎', 'Alternative Speicher', `${a(LG_URL, 'LG')} (RESU – Verfügbarkeit prüfen, LG hat sich aus Heimspeichern teils zurückgezogen) · BYD ist aktuell die ausbaufähigste Fronius-Kombi`);
  $('pv-product-note').innerHTML =
    `<b>Geschätzter Gesamtpreis schlüsselfertig:</b> ~<b>${money(pvInvest(kwpNow, p.batt))}</b> ` +
    `<span style="color:var(--muted)">(${fmt(kwpNow, 1)} kWp + ${fmt(p.batt, 1)} kWh, Kosten-Annahmen editierbar im Grenznutzen-Card). </span>` +
    (!sz.voltOk ? `<b style="color:#ef6c4d">Achtung:</b> mit ${modWp} Wp-Modulen wird die Reihe zu lang für 1000 V – kürzere Strings / mehr Strings wählen. ` : '') +
    (sz.dcac > 1.25 && !sz.overDc ? `<b>DC/AC ${fmt(sz.dcac, 2)} ist Absicht, kein Fehler:</b> der GEN24 trägt bis zu ${fmt(acKw * inv.dcFactor, 1)} kWp DC an seinen ${acKw.toFixed(1)} kW AC. ` +
      `Mehr Module als WR-Leistung („überbelegen") bringt früh/abends &amp; im Winter mehr Ertrag; die kurze Mittagskappung (~1–3 % im Jahr) fängt der Speicher auf. ` +
      `Ein <b>größerer WR lohnt erst über 1,5</b> – und darüber schlägt die App automatisch zwei Geräte vor. ` : '') +
    (sz.overDc ? `<b style="color:#ef6c4d">DC/AC ${fmt(sz.dcac, 2)} liegt über der WR-Grenze (${fmt(inv.dcFactor, 2)}):</b> entweder ein paar Module weniger oder ein zweiter/größerer Wechselrichter. ` : '') +
    `<b>Ausbaufähig gedacht:</b> teuer & schwer tauschbar sind <b>Wechselrichter</b> und <b>Speicher-Grundgerät</b> – Module ergänzt du jederzeit ` +
    `(der WR hat noch ~${sz.headroom} Module Reserve). Darum WR <b>eine Nummer größer</b> (${esc(inv.family)}, battery-ready), Speicher <b>modular</b>. ` +
    `<span style="color:var(--muted)">Spannungen/Ströme sind <b>typische</b> Modulwerte – fürs finale Design das echte Moduldatenblatt (Voc, Vmp, Temp.-Koeffizient) und den Fronius-Konfigurator nutzen. ` +
    `Links führen zur Herstellerseite.</span>`;
}
// In which months could you run entirely without grid power – and how does
// that change with a bigger PV array?
function renderPvGridFree(p) {
  const el = $('pv-gridfree'); if (!el) return;
  const cur = Math.max(1, Math.round(p.kwp || 0));
  // Night load per calendar month (for the battery gate), once – depends on the
  // load, not the array size, so it is constant across the sweep.
  const loc = getLatLon(), lat = loc ? loc.lat : 51, lon = loc ? loc.lon : 10, yr = new Date().getFullYear();
  const nightByMonth = [];
  for (let m = 0; m < 12; m++) nightByMonth[m] = nightSum(hourlyLoadKwh(m).hw, sunTimes(lat, lon, new Date(yr, m, 15)));
  const usable = p.batt * 0.9;
  // Fraction of DAYS in a month that need ~no grid. The monthly model is a flat
  // average day, so we add day-to-day weather variability: a day is grid-free if
  // its PV covers the day's load (lognormal clearness around the month mean) AND
  // the battery can bridge that month's night. Partial months therefore count
  // proportionally (½ March + ½ October ≈ 1 full month).
  const dayFrac = mm => {
    const d = DIM[mm.m], dayLoad = mm.load / d;
    if (dayLoad <= 0) return 0;
    const ratio = (mm.pv / d) / dayLoad;
    const z = Math.log(Math.max(ratio, 1e-3)) / 0.5;           // σ≈0.5 (daily weather spread)
    const pClear = 1 / (1 + Math.exp(-1.702 * z));             // ≈ normal CDF
    const nightCover = nightByMonth[mm.m] > 0 ? Math.min(1, usable / nightByMonth[mm.m]) : 1;
    return Math.max(0, Math.min(1, pClear * nightCover));
  };
  const monthsPerDay = 12 / 365;
  const evalKwp = kwp => {
    const mo = simulatePv({ ...p, kwp }).monthly;
    const frac = mo.map(dayFrac);
    const days = mo.reduce((a, mm, i) => a + frac[i] * DIM[mm.m], 0);
    return { days, months: days * monthsPerDay, frac };
  };

  // --- headline + 12-month strip for the CURRENT array ---
  const curRes = evalKwp(cur), em = curRes.months;
  $('pv-gridfree-kpi').innerHTML =
    `<div class="kpi"><div class="v" style="color:${em >= 5 ? '#4be0b0' : em >= 2 ? '#f6b93b' : '#ef6c4d'}">` +
    `${fmt(em, 1)} <span style="font-size:16px;color:var(--muted)">von 12</span></div>` +
    `<div class="l">Monate <b>komplett netzfrei</b> (aus Tagen gerechnet · ${fmt(cur, 0)} kWp · ${kwh(p.batt, 0)} Speicher)</div></div>`;
  $('pv-gridfree-strip').innerHTML = '<div style="display:flex; gap:3px">' + MON.map((mn, m) => {
    const f = curRes.frac[m], a = (0.1 + 0.82 * f).toFixed(2);
    return `<div title="${mn}: ${fmt(f * 100, 0)} % der Tage netzfrei" style="flex:1; text-align:center; padding:7px 0; border-radius:6px; font-size:11px; font-weight:600;` +
      `background:rgba(75,224,176,${a}); color:${f > 0.5 ? '#07271f' : 'var(--muted)'}">${mn[0]}</div>`;
  }).join('') + '</div>';
  $('pv-gridfree-strip-note').innerHTML =
    `Je grüner, desto <b>mehr Tage</b> dieses Monats sind netzfrei. Summe ≈ <b>${fmt(em, 1)} von 12 Monaten</b> ` +
    `(~${fmt(curRes.days, 0)} Tage/Jahr ohne Netzbezug). <span style="color:var(--muted)">Teildeckung zählt anteilig – ` +
    `z. B. halber März + halber Oktober = 1 Monat.</span>`;

  // --- sweep: netzfreie Monate (aus Tagen) je Anlagengröße ---
  const maxK = Math.max(12, cur + 6);
  const step = Math.max(1, Math.ceil(maxK / 15));
  const kwps = [];
  for (let k = step; k <= maxK; k += step) kwps.push(k);
  if (!kwps.includes(cur) && cur <= maxK) { kwps.push(cur); kwps.sort((a, b) => a - b); }
  const data = kwps.map(k => ({ kwp: k, count: evalKwp(k).months }));
  el.innerHTML = gridFreeSweepChart(data, cur);
  const maxAch = Math.max(...data.map(d => d.count));
  const satK = (data.find(d => d.count >= maxAch * 0.98) || {}).kwp;
  $('pv-gridfree-note').innerHTML =
    `Balkenhöhe = netzfreie Monate (aus Tagen, anteilig), X-Achse = kWp (★ = deine ${fmt(cur, 0)} kWp). ` +
    (maxAch > em + 0.3 ? `Mit ~<b>${fmt(satK, 0)} kWp</b> wären es bis zu <b>${fmt(maxAch, 1)} Monate</b>. ` : '') +
    (usable <= 0 ? `<b>Ohne Speicher</b> bleibst du nie eine ganze Nacht netzfrei – ein Speicher hebt diesen Wert stark. ` : '') +
    `Mehr bringt es kaum: die dunklen <b>Wintermonate</b> bekommst du mit PV allein nie netzfrei ` +
    `(zu wenig Sonne). Dort hilft nur Netzbezug – idealerweise günstig über einen <b>Börsentarif</b>.`;
}
// Debounced PV render for live typing: renderPv() is heavy (full simulation +
// charts), so running it on every keystroke made the PV inputs feel frozen.
// Saving still happens immediately; only the visual recompute is coalesced.
let _renderPvTimer = null;
function renderPvSoon() {
  if (_renderPvTimer) clearTimeout(_renderPvTimer);
  _renderPvTimer = setTimeout(() => { _renderPvTimer = null; renderPv(); }, 200);
}
// ---- Balkonkraftwerk (800 W) simulation ------------------------------------
// DC-coupled, AC-capped battery (Solarbank-style): PV covers the load first,
// then charges the battery, then feeds the grid – all AC output limited to the
// 800 W (or chosen) cap. Shows how a battery shifts midday surplus into the
// evening to close the base-load gap, over a day and over the year.
function simulateBalcony(p) {
  const spec = p.spec || 1000, pm = pvMonth();
  const shRaw = (STATE.data && STATE.data.hourly_profile || []).map(h => h.avg_w);
  const shShape = shRaw.length === 24 && shRaw.some(v => v > 0) ? normFrac(shRaw) : new Array(24).fill(1 / 24);
  const shDaily = householdBaseDaily();
  const hpArr = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const hpShape = hpArr.length && hpArr.some(h => h.avg_w > 0) ? normFrac(hpArr.map(h => h.avg_w)) : new Array(24).fill(1 / 24);
  const cap = p.capW / 1000, chP = (p.battChW || 1200) / 1000, disP = (p.battDisW || p.capW) / 1000;
  let soc = 0, Ypv = 0, Yself = 0, Yfeed = 0, Ygrid = 0, Yclip = 0, Yload = 0;
  const months = [], repDay = {};
  for (let m = 0; m < 12; m++) {
    const dim = DIM[m], dayPv = (p.kwp * spec * pm[m]) / dim;
    const dayHp = p.inclHp ? hpMonthEst(m) / dim : 0;
    const pvH = pvHourFractions(m);
    let mPv = 0, mSelf = 0, mFeed = 0, mGrid = 0, mClip = 0, mLoad = 0, lastDay = null;
    for (let d = 0; d < dim; d++) {
      const prof = [];
      for (let h = 0; h < 24; h++) {
        const pvDC = dayPv * pvH[h], load = shDaily * shShape[h] + dayHp * hpShape[h];
        const direct = Math.min(pvDC, cap, load);            // PV → load first (within AC cap)
        let remDC = pvDC - direct, acHead = cap - direct;
        const charge = Math.min(remDC, chP, p.battKwh - soc); soc += charge; remDC -= charge;  // then battery
        const feed = Math.min(remDC, acHead); acHead -= feed;                                   // then feed (capped)
        const clip = remDC - feed;                            // DC lost to the AC cap (battery full)
        const deficit = load - direct;
        const dis = Math.min(deficit, soc, disP, acHead); soc -= dis;                            // discharge for the rest
        const grid = deficit - dis, self = direct + dis;
        mPv += pvDC; mSelf += self; mFeed += feed; mGrid += grid; mClip += clip; mLoad += load;
        prof.push({ h, pv: pvDC, load, soc, direct, dis, grid, feed });
      }
      lastDay = prof;
    }
    months.push({ m, pv: mPv, self: mSelf, grid: mGrid, feed: mFeed, clip: mClip, load: mLoad });
    Ypv += mPv; Yself += mSelf; Yfeed += mFeed; Ygrid += mGrid; Yclip += mClip; Yload += mLoad;
    if (m === 6) repDay.summer = lastDay;
    if (m === 0) repDay.winter = lastDay;
  }
  return { yearPv: Ypv, yearSelf: Yself, yearFeed: Yfeed, yearGrid: Ygrid, yearClip: Yclip, yearLoad: Yload,
    autarky: Yload > 0 ? Yself / Yload : 0, selfRate: Ypv > 0 ? Yself / Ypv : 0, months, repDay };
}
function bkDayChart(day, capW, battKwh) {
  const h = 230, padL = 36, padR = 34, top = 14, base = h - 26, n = 24;
  const X = i => padL + (CW - padL - padR) * (i / (n - 1)), W = x => x * 1000;
  const sc = niceScale(Math.max(200, ...day.flatMap(d => [W(d.load), W(d.pv)]), capW)), yMax = sc.max;
  const Y = w => top + (1 - Math.max(0, Math.min(yMax, w)) / yMax) * (base - top);
  const socMax = Math.max(0.1, battKwh), Ysoc = s => top + (1 - Math.max(0, Math.min(socMax, s)) / socMax) * (base - top);
  let g = gridLines(h, top, base, padL, yMax, { step: sc.step, unit: 'W' });
  const cum = day.map(() => 0); let areas = '';
  [{ k: 'direct', c: '#4be0b0' }, { k: 'dis', c: '#3ba9ff' }, { k: 'grid', c: '#6b7280' }].forEach(L => {
    let up = '', dn = '';
    day.forEach((d, i) => { up += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(W(cum[i] + d[L.k])).toFixed(1)} `; });
    for (let i = n - 1; i >= 0; i--) dn += `L${X(i).toFixed(1)} ${Y(W(cum[i])).toFixed(1)} `;
    areas += `<path d="${up}${dn}Z" fill="${L.c}" fill-opacity="0.5"/>`;
    day.forEach((d, i) => cum[i] += d[L.k]);
  });
  let pvL = '', socL = ''; day.forEach((d, i) => { pvL += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(W(d.pv)).toFixed(1)} `; socL += `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Ysoc(d.soc).toFixed(1)} `; });
  let xt = ''; for (let i = 0; i < 24; i += 3) xt += `<text class="axis" x="${X(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${String(i).padStart(2, '0')}</text>`;
  const capY = Y(capW);
  const inner = g + areas +
    `<path d="${pvL.trim()}" fill="none" stroke="#ffd166" stroke-width="2"/>` +
    `<line x1="${padL}" x2="${CW - padR}" y1="${capY.toFixed(1)}" y2="${capY.toFixed(1)}" stroke="#ff6b8a" stroke-width="1" stroke-dasharray="4 3"/>` +
    `<text class="axis" x="${CW - padR}" y="${(capY - 3).toFixed(1)}" text-anchor="end" fill="#ff6b8a">${capW} W</text>` +
    (battKwh > 0 ? `<path d="${socL.trim()}" fill="none" stroke="#b794f6" stroke-width="1.6"/><text class="axis" x="${CW - padR + 3}" y="${top + 8}" fill="#b794f6">SOC</text>` : '') + xt;
  const tips = day.map(d => `<b>${String(d.h).padStart(2, '0')}:00</b><div class="note" style="margin-top:2px">` +
    `<span style="color:#ffd166">●</span> PV ${fmt(W(d.pv), 0)} W · <span style="color:#4be0b0">●</span> direkt ${fmt(W(d.direct), 0)} · ` +
    `<span style="color:#3ba9ff">●</span> Batterie ${fmt(W(d.dis), 0)} · <span style="color:#6b7280">●</span> Netz ${fmt(W(d.grid), 0)}` +
    (battKwh > 0 ? ` · <span style="color:#b794f6">●</span> SOC ${fmt(d.soc / socMax * 100, 0)}%` : '') + `</div>`);
  return svg(h, inner, { kind: 'area', pad: padL, padR, n, h, tips });
}
let _bkDay = 'summer';
function bkInputs() {
  const cap = parseFloat(($('bk-cap') || {}).value) || 800;
  return { kwp: Math.max(0, parseFloat(($('bk-kwp') || {}).value) || 0),
    battKwh: Math.max(0, parseFloat(($('bk-batt') || {}).value) || 0), capW: cap,
    spec: parseFloat(($('pv-orient') || {}).value) || 1000,
    inclHp: (($('bk-load') || {}).value) === 'all', battChW: 1200, battDisW: cap };
}
function renderBalcony() {
  const card = $('bk-card'); if (!card) return;
  const p = bkInputs(), r = simulateBalcony(p), r0 = p.battKwh > 0 ? simulateBalcony({ ...p, battKwh: 0 }) : null;
  const price = STATE.price, feedin = (pvInputs().feedin || 0), save = r.yearSelf * price + r.yearFeed * feedin;
  const kpi = (v, l) => `<div class="kpi sm"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  if ($('bk-head')) $('bk-head').innerHTML = `<span style="color:var(--muted)">${fmt(p.kwp, 1)} kWp · ${fmt(p.battKwh, 1)} kWh</span>`;
  if ($('bk-kpis')) $('bk-kpis').innerHTML = kpi(fmt(r.autarky * 100, 0) + ' %', 'Grundlast gedeckt') +
    kpi(kwh(r.yearGrid, 0), 'Netz-Gap / Jahr') + kpi(money(save), 'Ersparnis / Jahr') + kpi(kwh(r.yearSelf, 0), 'selbst genutzt / Jahr');
  const day = r.repDay[_bkDay] || r.repDay.summer;
  if ($('bk-daychart')) $('bk-daychart').innerHTML = day ? `<div style="touch-action:none">${bkDayChart(day, p.capW, p.battKwh)}</div>` : '<div class="note">—</div>';
  if ($('bk-day-legend')) $('bk-day-legend').innerHTML = legendHtml([{ label: '☀️ PV-Erzeugung', color: '#ffd166' },
    { label: 'direkt genutzt', color: '#4be0b0' }, { label: 'aus Batterie', color: '#3ba9ff' }, { label: 'Netzbezug', color: '#6b7280' }]
    .concat(p.battKwh > 0 ? [{ label: 'SOC', color: '#b794f6' }] : [])) + `<span style="color:var(--muted);font-size:11px;margin-left:6px">tippen für Stundenwerte</span>`;
  if ($('bk-yearchart')) $('bk-yearchart').innerHTML = stackedBar(
    r.months.map(m => ({ label: MON[m.m][0], full: MON[m.m], values: { self: m.self, grid: m.grid } })),
    [{ key: 'self', color: '#4be0b0', label: 'selbst gedeckt' }, { key: 'grid', color: '#6b7280', label: 'Netzbezug' }], { h: 190, unit: 'kWh' });
  if ($('bk-year-legend')) $('bk-year-legend').innerHTML = legendHtml([{ label: 'selbst gedeckt', color: '#4be0b0' }, { label: 'Netzbezug (Gap)', color: '#6b7280' }]);
  if ($('bk-note')) $('bk-note').innerHTML =
    `Mit <b>${fmt(p.battKwh, 1)} kWh</b> Speicher deckst du <b>${fmt(r.autarky * 100, 0) + ' %'}</b> deiner Last; es bleiben <b>${kwh(r.yearGrid, 0)}/Jahr</b> Netzbezug (Gap). ` +
    (r0 ? `<b>Ohne</b> Speicher wären es nur <b>${fmt(r0.autarky * 100, 0)} %</b> (Gap ${kwh(r0.yearGrid, 0)}) – der Speicher schließt also <b>${kwh(r0.yearGrid - r.yearGrid, 0)}/Jahr</b>. ` : '') +
    `Durch die <b>${p.capW} W</b>-Grenze gehen <b>${kwh(r.yearClip, 0)}/Jahr</b> verloren (Mittags-Überschuss, den der Speicher nicht mehr fasst) – ${r.yearClip > 60 ? 'ein größerer Speicher würde hier noch etwas holen.' : 'die Grenze kostet dich kaum etwas.'} ` +
    `Einspeisung: ${kwh(r.yearFeed, 0)}/Jahr. ` +
    (((typeof houseManual === 'function' ? houseManual() : 0) <= 0 && (typeof meterHouseholdDaily === 'function' ? (meterHouseholdDaily() || 0) : 0) <= 0)
      ? `<br>⚠︎ <b>Für realistische Zahlen</b> trag deinen <b>Haushaltsstrom (kWh/Jahr)</b> ein (Feld „Haushaltsstrom" oben im PV-Tab bzw. im Konzept) – sonst zählt nur der kleine <b>gemessene</b> Anteil deiner Steckdosen, und die Autarkie wirkt zu hoch. ` : '') +
    `<span style="color:var(--muted)">Last = ${p.inclHp ? 'Hausstrom + Wärmepumpe' : 'Hausstrom'} (${kwh(r.yearLoad, 0)}/Jahr); Erzeugung aus ${fmt(p.kwp, 1)} kWp × ${fmt(p.spec, 0)} kWh/kWp.</span>`;
}

function renderPv() {
  if (!$('pv-yield')) return;
  const haveData = shAvgDaily() > 0 || hpAvgDaily() > 0;
  if (!haveData) {
    $('pv-yield').textContent = '–'; $('pv-autarky').textContent = '–';
    $('pv-self').textContent = '–'; $('pv-benefit').textContent = '–';
    $('pv-monthly').innerHTML = '<div class="note">Noch keine Verbrauchsdaten – sobald die Bridge misst, wird hier gerechnet.</div>';
    $('pv-day').innerHTML = ''; $('pv-econ').innerHTML = ''; $('pv-monthly-note').textContent = '';
    return;
  }
  const p = pvInputs(), r = simulatePv(p);
  const v2hRow = $('pv-v2h-row'); if (v2hRow) v2hRow.hidden = !p.v2h;
  $('pv-yield').innerHTML = kwh(r.yield_kwh, 0);
  $('pv-autarky').innerHTML = fmt(r.autarky * 100, 0) + ' %';
  $('pv-self').innerHTML = fmt(r.self_rate * 100, 0) + ' %';
  $('pv-benefit').innerHTML = money(r.benefit);

  // 60 % feed-in cap: what it costs, and how storage / self-use rescues it
  const capNote = $('pv-cap60-note');
  if (capNote) {
    if (p.cap60 && r.curtail_kwh > 0.5) {
      const bare = simulatePv({ ...p, batt: 0, v2h: false });
      const rescued = Math.max(0, bare.curtail_kwh - r.curtail_kwh);
      const pctLost = r.yield_kwh > 0 ? r.curtail_kwh / r.yield_kwh * 100 : 0;
      capNote.innerHTML = `🔌 Durch die <b>60 %-Kappung</b> (max. ${fmt(0.6 * p.kwp, 1)} kW ins Netz) werden ` +
        `~<b>${kwh(r.curtail_kwh, 0)}/Jahr</b> abgeregelt = <b>${fmt(pctLost, 0)} %</b> des Ertrags ` +
        `(~${money(r.curtail_loss)} entgangene Einspeisung).` +
        (p.batt > 0 && rescued > 1 ? ` Dein <b>Speicher</b> rettet davon schon ~<b>${kwh(rescued, 0)}/Jahr</b>.` : '') +
        ` Mit <b>Smart Meter</b> entfällt die Grenze. <span style="color:var(--muted)">Momentanleistung, keine Jahresgrenze – grobe Stundenschätzung.</span>`;
    } else if (p.cap60) {
      capNote.innerHTML = `🔌 Mit dieser Konfiguration greift die 60 %-Kappung kaum – Eigenverbrauch/Speicher fangen die Mittagsspitzen ab. 👍`;
    } else {
      capNote.innerHTML = '';
    }
  }

  _pvMonths = r.monthly.map(x => ({ label: MON[x.m], ...x }));
  $('pv-monthly').innerHTML = pvMonthlyChart(_pvMonths);
  const leg = [
    { label: 'PV: Direkt', color: PVC.direct }, { label: 'PV: Batterie', color: PVC.batt },
    { label: 'PV: Einspeisung', color: PVC.feed },
    { label: 'Hausstrom', color: PVC.sh }, { label: 'Wärmepumpe', color: PVC.hp }];
  if (p.evAnnual > 0) leg.push({ label: 'E-Auto', color: PVC.ev });
  if (p.acAnnual > 0) leg.push({ label: 'Klima', color: PVC.ac });
  $('pv-monthly-legend').innerHTML = legendHtml(leg);
  const cover = r.load_kwh > 0 ? r.yield_kwh / r.load_kwh : 0;
  const extras = [];
  if (p.evAnnual > 0) extras.push(`E-Auto ~${kwh(p.evAnnual, 0)}`);
  if (p.acAnnual > 0) extras.push(`Klima ~${kwh(p.acAnnual, 0)}`);
  const evTxt = extras.length ? ` inkl. ${extras.join(', ')}` : '';
  const battKwh = r.monthly.reduce((a, x) => a + x.batt, 0);
  const battTxt = p.batt > 0
    ? ` Der <b style="color:${PVC.batt}">Speicher</b> verschiebt <b>${kwh(battKwh, 0)}/Jahr</b> von Einspeisung zu Eigenverbrauch` +
      ` (Wert dank Speicher: ~${money(battKwh * (STATE.price - p.feedin))}/Jahr).`
    : ' Ohne Speicher wird der Mittags-Überschuss eingespeist – plane einen Speicher ein, um mehr selbst zu nutzen (der lila Anteil wächst).';
  $('pv-monthly-note').innerHTML =
    `Linker Balken = <b>PV-Ertrag</b> (grün direkt, lila über Batterie, gelb eingespeist), rechter = ` +
    `<b>Verbrauch</b> nach Quelle (blau Hausstrom, orange Wärmepumpe${p.evAnnual > 0 ? ', pink E-Auto' : ''}` +
    `${p.acAnnual > 0 ? ', türkis Klima' : ''}). ` +
    `Erzeugung <b>${kwh(r.yield_kwh, 0)}/Jahr</b> ≈ <b>${fmt(cover * 100, 0)} %</b> deines Verbrauchs (${kwh(r.load_kwh, 0)}${evTxt}).` + battTxt;

  renderPvEcon(p);
  renderPvGridFree(p);
  renderPvNight();
  renderPvBasis();
  renderPvMargin();
  renderPvProduct();

  _pvRep = { summer: r.repDay, winter: r.repDayW };
  renderPvDay();

  const rows = [
    ['Eigenverbrauch', `${kwh(r.self_kwh, 0)} · spart ${money(r.savings)}`],
    ['Einspeisung', `${kwh(r.feed_kwh, 0)} · ${money(r.feed_rev)}`],
    ['Netzbezug (Rest)', `${kwh(r.grid_kwh, 0)} · ${money(r.grid_kwh * STATE.price)}`],
    ['Vorteil gesamt / Jahr', money(r.benefit)],
  ];
  if (p.invest > 0 && r.benefit > 0) {
    rows.push(['Amortisation', `~${fmt(p.invest / r.benefit, 1)} Jahre bei ${money(p.invest)}`]);
  }
  let v2hNote = '';
  if (p.v2h && p.carKwh > 0) {
    const r0 = simulatePv({ ...p, v2h: false });                              // no car
    const rBatt = simulatePv({ ...p, v2h: false, batt: p.batt + p.carKwh });  // same-size home battery instead
    const dAut = (r.autarky - r0.autarky) * 100;
    const v2hUplift = Math.max(0, r.self_kwh - r0.self_kwh);
    const battUplift = Math.max(0.001, rBatt.self_kwh - r0.self_kwh);
    // the car replaces a home battery only as far as it delivers the same self-use
    const equivBatt = Math.min(p.carKwh, p.carKwh * v2hUplift / battUplift);
    const saved = equivBatt * p.v2hPrice;
    const valYr = v2hUplift * (STATE.price - p.feedin);
    const dayAvail = mean(p.carHome.slice(8, 17));   // presence during PV hours 8–16
    const presence = dayAvail > 0.6 ? 'steht auch <b>tagsüber meist zuhause</b> und fängt die Mittagssonne mit ein'
      : dayAvail < 0.3 ? 'ist <b>tagsüber meist weg</b> und kann den Mittags-Überschuss kaum aufnehmen'
        : 'ist <b>tagsüber teils da</b>';
    const equivPct = p.carKwh > 0 ? equivBatt / p.carKwh : 0;
    rows.push(['Autarkie mit V2H', `${fmt(r.autarky * 100, 0)} % (ohne ${fmt(r0.autarky * 100, 0)} %, +${fmt(dAut, 0)} PP)`]);
    v2hNote = `🔋 <b>Bidirektionales Laden:</b> dein Auto deckt <b>${kwh(v2hUplift, 0)}/Jahr</b> zusätzlich aus PV ` +
      `(~${money(valYr)}/Jahr, Autarkie <b>+${fmt(dAut, 0)} PP</b>). Es ${presence} – es ersetzt real etwa ` +
      `<b>${fmt(equivBatt, 1)} kWh Heimspeicher</b> (${fmt(equivPct * 100, 0)} % seiner Kapazität, ~<b>${money(saved)}</b> gespart). ` +
      (equivPct > 0.7 ? 'Fast wie ein echter Heimspeicher – für euch lohnt sich V2H also besonders. ' : '') +
      `<br><small style="color:var(--muted)">Voraussetzung: <b>bidirektionale Wallbox + V2H-fähiges Auto</b> ` +
      `(z. B. Hyundai/Kia E-GMP, VW ID mit V2H, MG, BYD, Renault 5).</small>`;
  }
  $('pv-econ').innerHTML = rows.map(([k, v]) => statusRow(k, v)).join('') +
    (v2hNote ? `<div class="note" style="margin-top:10px;line-height:1.5">${v2hNote}</div>` : '');

  renderBuildCompare(p);
  renderPvOrient();
  renderSurfaces();
  try { renderBalcony(); } catch (e) {}
  try { renderProductPick(); } catch (e) {}
  // the Börse "lohnt sich?" card depends on the PV/battery dimensions here –
  // keep it in sync when they change (it reads pvInputs() live).
  try { if (typeof renderBorseWorth === 'function') renderBorseWorth(); } catch (e) {}
}

// ===== Produktauswahl: welches PV/Speicher-System passt? ==================== #
// Fetches the hardware catalog from the bridge, derives a recommended sizing
// from the household's own consumption, and ranks the systems against the
// user's chosen priorities – in plain language for non-electricians.
let _ppCatalog = null, _ppBusy = false;
const PP_PRIOS = [
  { key: 'control', emoji: '🧠', label: 'Von dieser App steuerbar', hint: 'eigener Energiemanager / Direktvermarktung' },
  { key: 'tariff', emoji: '📈', label: 'Dynamischen Tarif nutzen', hint: 'günstig laden, teuer vermeiden/verkaufen' },
  { key: 'backup', emoji: '🏠', label: 'Notstrom fürs ganze Haus', hint: 'läuft bei Stromausfall weiter' },
  { key: 'expand', emoji: '🔋', label: 'Großer/erweiterbarer Speicher', hint: 'später E-Auto, mehr Module' },
  { key: 'price', emoji: '💶', label: 'Günstiger Preis', hint: 'möglichst wenig Investition' },
  { key: 'europe', emoji: '🇪🇺', label: 'EU-Marke & Service', hint: '10 J. Garantie, Support in DE' },
];
// per-system weight (0..10) for each priority, plus a neutral base
// "control" (this app as the energy manager) is the user's architectural choice,
// so it weighs heaviest for the open Fronius; GoodWe leads on size/price/backup.
const PP_W = {
  fronius: { control: 10, tariff: 8, backup: 6, expand: 6, price: 4, europe: 10, base: 6.5 },
  goodwe: { control: 4, tariff: 9, backup: 10, expand: 10, price: 9, europe: 3, base: 6.5 },
};
function ppPrios() {
  try { const v = JSON.parse(localStorage.getItem('bhe_pp_prios') || 'null'); if (v && typeof v === 'object') return v; } catch (e) {}
  return { control: true, tariff: true, backup: true, expand: false, price: false, europe: false };
}
function ppSetPrio(key, on) {
  const p = ppPrios(); p[key] = !!on;
  try { localStorage.setItem('bhe_pp_prios', JSON.stringify(p)); } catch (e) {}
  renderProductPick();
}
async function renderProductPick() {
  const card = $('pp-card'); if (!card) return;
  if (!_ppCatalog) {
    if (_ppBusy) return; _ppBusy = true;
    try { _ppCatalog = await api('/api/products'); }
    catch (e) { _ppCatalog = null; }
    finally { _ppBusy = false; }
  }
  paintProductPick();
}
// household/day, heat-pump/day → recommended battery, PV kWp, inverter kW
function ppContext() {
  const hh = (typeof shAvgDaily === 'function' ? shAvgDaily() : 0) || 0;
  const hp = (typeof hpAvgDaily === 'function' ? hpAvgDaily() : 0) || 0;
  const dayTotal = hh + hp, annual = dayTotal * 365;
  const kwpPlan = parseFloat(($('pv-kwp') || {}).value) || 0;
  const battPlan = parseFloat(($('pv-batt') || {}).value) || 0;
  const recBatt = Math.max(5, Math.min(20, Math.round(hh * 1.2 + hp * 0.2)));
  const recKwp = kwpPlan > 0 ? kwpPlan : Math.max(5, Math.min(14, Math.round(annual / 950)));
  const recInv = Math.max(5, Math.min(12, Math.round(recKwp * 0.9)));
  return { hh, hp, dayTotal, annual, kwpPlan, battPlan, recBatt, recKwp, recInv };
}
function ppNearest(variants, keyFn, target) {
  let best = null, bd = Infinity;
  (variants || []).forEach(v => { const d = Math.abs(keyFn(v) - target); if (d < bd) { bd = d; best = v; } });
  return best;
}
// build the two comparable systems from the flat catalog
function ppSystems(ctx) {
  const prods = (_ppCatalog && _ppCatalog.products) || [];
  const byId = {}; prods.forEach(p => { byId[p.id] = p; });
  const gen24 = byId['fronius_gen24_plus'], reserva = byId['fronius_reserva'], esa = byId['goodwe_esa'];
  const out = [];
  if (gen24 && reserva) {
    const inv = ppNearest(gen24.variants, v => v.ac_kw, ctx.recInv) || {};
    const bat = ppNearest(reserva.variants, v => v.usable_kwh, ctx.recBatt) || {};
    out.push({
      sysKey: 'fronius', brand: 'Fronius', kind: 'Wechselrichter + Speicher (getrennt)',
      title: 'Fronius GEN24 Plus + Reserva',
      pick: `${inv.model || 'GEN24'} + ${bat.model || 'Reserva'} (${fmt(bat.usable_kwh || 0, 1)} kWh nutzbar)`,
      invKw: inv.ac_kw, battKwh: bat.usable_kwh,
      summary: gen24.summary, catalog: [gen24, reserva],
    });
  }
  if (esa) {
    const v = ppNearest(esa.variants, x => x.ac_kw, ctx.recInv) || {};
    out.push({
      sysKey: 'goodwe', brand: 'GoodWe', kind: 'All-in-One (alles in einem Gerät)',
      title: 'GoodWe ESA-Serie',
      pick: `${v.model || 'ESA'} – Speicher frei in 5/8-kWh-Modulen bis 108 kWh`,
      invKw: v.ac_kw, battKwh: ctx.recBatt,
      summary: esa.summary, catalog: [esa],
    });
  }
  return out;
}
// tailored pro/con bullets per active priority
function ppReasons(sysKey, prios, ctx) {
  const pro = [], con = [];
  const F = sysKey === 'fronius';
  if (prios.control) (F ? pro : con).push(F
    ? 'Offene lokale Schnittstellen (Solar-API + Modbus) – <b>diese App</b> kann direkt messen & steuern (dein eigener Energiemanager, später Direktvermarktung).'
    : 'Hat einen eigenen Energiemanager – per Modbus steuerbar, aber weniger offen für eine komplett eigene App-Logik.');
  if (prios.tariff) (F ? pro : pro).push(F
    ? 'Dynamischer Tarif läuft über diese App / den eigenen Energiemanager – volle Kontrolle, aber nicht „ab Werk".'
    : 'KI-Tarifoptimierung <b>ab Werk</b> – lädt/entlädt automatisch nach dem Börsenpreis.');
  if (prios.backup) (F ? con : pro).push(F
    ? 'Notstrom fürs ganze Haus erst ab 6 kW und mit Zusatz-Umschaltbox, ~10 s Umschaltzeit.'
    : 'Whole-Home-Notstrom mit Umschaltung <b>&lt;4 ms</b> – den Ausfall merkst du gar nicht.');
  if (prios.expand) (F ? con : pro).push(F
    ? 'Speicher bis ~15,8 kWh (oder mehrere Batterien parallel) – für normale Häuser genug, aber nicht riesig.'
    : 'Bis <b>108 kWh / 30 kW</b> ausbaubar – reicht locker für E-Auto + Wärmepumpe + mehr.');
  if (prios.price) (F ? con : pro).push(F
    ? 'Premium-Preis (zwei Geräte) – dafür Top-Service und Langlebigkeit.'
    : 'Als All-in-One meist <b>günstiger</b> und schneller installiert (ein Gerät).');
  if (prios.europe) (F ? pro : con).push(F
    ? 'Österreichische Marke, <b>10 Jahre</b> Garantie, Service & Datenstandort in der EU.'
    : 'Chinesischer Hersteller – gute Technik, aber Service/Datenstandort außerhalb der EU.');
  return { pro, con };
}
function ppScore(sysKey, prios) {
  const w = PP_W[sysKey]; let raw = 0, n = 0;
  PP_PRIOS.forEach(p => { if (prios[p.key]) { raw += w[p.key]; n++; } });
  const pct = n ? Math.round(raw / (10 * n) * 100) : null;
  return { pct, tie: w.base + raw };
}
function paintProductPick() {
  const sizing = $('pp-sizing'), sizeNote = $('pp-sizing-note'), priosEl = $('pp-prios'),
    rank = $('pp-ranking'), gloss = $('pp-glossary'), note = $('pp-note');
  if (!_ppCatalog || !(_ppCatalog.products || []).length) {
    if (rank) rank.innerHTML = '<div class="note">Produktkatalog nur mit laufender Bridge verfügbar.</div>';
    [sizing, sizeNote, priosEl, gloss, note].forEach(e => { if (e) e.innerHTML = ''; });
    return;
  }
  const ctx = ppContext(), prios = ppPrios();
  // recommended sizing KPIs
  if (sizing) sizing.innerHTML =
    `<div class="kpi sm"><div class="v">${fmt(ctx.recKwp, 0)} kWp</div><div class="l">PV empfohlen</div></div>` +
    `<div class="kpi sm"><div class="v">${fmt(ctx.recBatt, 0)} kWh</div><div class="l">Speicher empfohlen</div></div>` +
    `<div class="kpi sm"><div class="v">${fmt(ctx.recInv, 0)} kW</div><div class="l">Wechselrichter</div></div>`;
  if (sizeNote) sizeNote.innerHTML = ctx.dayTotal > 0
    ? `Basis: dein Verbrauch ~<b>${kwh(ctx.annual, 0)}/Jahr</b> (${fmt(ctx.dayTotal, 1)} kWh/Tag inkl. Wärmepumpe)${ctx.kwpPlan > 0 ? ` · PV-kWp aus deiner Planung übernommen` : ''}. Speicher ≈ ein Nacht-/Grundlast-Tag, Wechselrichter ≈ 0,9 × kWp.`
    : `Sobald ein paar Verbrauchstage/Zählerstände vorliegen, rechne ich die empfohlene Größe aus deinen echten Werten.`;
  // priority chips
  if (priosEl) priosEl.innerHTML = PP_PRIOS.map(p => {
    const on = !!prios[p.key];
    return `<button class="pp-prio" data-pp="${p.key}" aria-pressed="${on}" title="${esc(p.hint)}" ` +
      `style="flex:1 1 160px;min-width:150px;text-align:left;padding:9px 11px;border-radius:12px;cursor:pointer;` +
      `border:1px solid ${on ? 'var(--accent)' : 'var(--line)'};background:${on ? 'color-mix(in srgb,var(--accent) 16%,transparent)' : 'transparent'};color:var(--fg)">` +
      `<div style="font-size:13px;font-weight:600">${p.emoji} ${esc(p.label)} ${on ? '✓' : ''}</div>` +
      `<div style="font-size:11px;color:var(--muted)">${esc(p.hint)}</div></button>`;
  }).join('');
  // rank the systems
  const sys = ppSystems(ctx).map(s => ({ ...s, ...ppScore(s.sysKey, prios) }));
  sys.sort((a, b) => (b.pct || 0) - (a.pct || 0) || b.tie - a.tie);
  const anyPrio = PP_PRIOS.some(p => prios[p.key]);
  if (rank) rank.innerHTML = sys.map((s, i) => {
    const top = i === 0 && anyPrio;
    const r = ppReasons(s.sysKey, prios, ctx);
    const bar = s.pct == null ? '' :
      `<div class="bar" style="height:8px;margin:8px 0 2px"><i style="width:${s.pct}%;background:${top ? COL.pv : COL.sh}"></i></div>`;
    const pros = r.pro.map(t => `<div style="font-size:12.5px;margin:3px 0"><span style="color:${COL.pv}">✓</span> ${t}</div>`).join('');
    const cons = r.con.map(t => `<div style="font-size:12.5px;margin:3px 0"><span style="color:#ffb64d">⚠</span> ${t}</div>`).join('');
    const specs = ppSpecTable(s.catalog);
    return `<div style="border:1px solid ${top ? 'var(--accent)' : 'var(--line)'};border-radius:14px;padding:13px 14px;margin-bottom:12px;` +
      `background:${top ? 'color-mix(in srgb,var(--accent) 7%,transparent)' : 'transparent'}">` +
      `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">` +
      `<div><b style="font-size:15px">${esc(s.title)}</b> ${top ? '<span style="font-size:11px;background:' + COL.pv + ';color:#04110c;padding:2px 7px;border-radius:999px;font-weight:700">EMPFEHLUNG</span>' : ''}` +
      `<div style="font-size:11.5px;color:var(--muted);margin-top:1px">${esc(s.kind)}</div></div>` +
      `<div style="text-align:right;white-space:nowrap">${s.pct == null ? '' : `<b style="font-size:18px">${s.pct}%</b><div style="font-size:10px;color:var(--muted)">Passung</div>`}</div></div>` +
      bar +
      `<div class="note" style="margin:8px 0 6px">${esc(s.summary)}</div>` +
      `<div style="font-size:12.5px;margin:6px 0 8px">👉 <b>Für dich:</b> ${esc(s.pick)}</div>` +
      pros + cons +
      specs +
      `</div>`;
  }).join('');
  // glossary (non-electrician)
  const gl = (_ppCatalog.glossary || []);
  if (gloss) gloss.innerHTML = gl.length
    ? `<details><summary style="cursor:pointer;font-weight:600;font-size:13.5px">📖 Fachbegriffe einfach erklärt (${gl.length})</summary>` +
    `<div style="margin-top:8px">` + gl.map(g =>
      `<div style="padding:7px 0;border-bottom:1px solid var(--line)"><b style="font-size:13px">${esc(g.term)}</b>` +
      `<div style="font-size:12.5px;color:var(--muted);margin-top:2px">${esc(g.text)}</div></div>`).join('') + `</div></details>`
    : '';
  if (note) {
    const top = sys[0], sec = sys[1];
    let msg = `<b>Ehrlich:</b> die Datenblätter nennen <b>keine Preise</b> – hol dir für dein Dach 2–3 Angebote. Diese Auswahl ist eine <b>Orientierung</b>, keine Elektro-Planung. `;
    if (top && sec && top.pct != null && sec.pct != null && anyPrio) {
      const close = (top.pct - sec.pct) <= 8;
      msg += `Bei <b>deinen</b> Prioritäten liegt <b>${esc(top.brand)}</b> vorn (${top.pct} % vs. ${sec.pct} %)` + (close ? ' – aber knapp, hier entscheidet dein Geschmack. ' : '. ');
      msg += top.sysKey === 'fronius'
        ? `Soll <b>diese App</b> der Energiemanager sein (dynamischer Tarif, später Direktvermarktung), ist die <b>offene Steuerbarkeit</b> von Fronius der Trumpf. Willst du maximale Speichergröße, bestes Preis-Leistung und Notstrom „out of the box", schalte die passenden Prioritäten – dann zieht GoodWe vorbei.`
        : `GoodWe punktet mit <b>Speichergröße, Preis und sofortigem Notstrom</b> (&lt;4 ms). Soll diese App selbst steuern/direktvermarkten, schalte „<b>Von dieser App steuerbar</b>" scharf – dann zieht Fronius vorbei.`;
    } else {
      msg += `Tippe oben deine Prioritäten an, dann sortiere ich die Systeme für <b>dich</b>.`;
    }
    note.innerHTML = msg;
  }
}
// compact collapsible spec table for a system's catalog entries
function ppSpecTable(entries) {
  const rows = [];
  (entries || []).forEach(p => {
    (p.variants || []).forEach(v => {
      const cells = [];
      if (v.ac_kw != null) cells.push(`${fmt(v.ac_kw, 1)} kW`);
      if (v.usable_kwh != null) cells.push(`${fmt(v.usable_kwh, 1)} kWh`);
      if (v.batt_kwh != null) cells.push(`${fmt(v.batt_kwh, 0)} kWh Speicher`);
      if (v.pv_max_wp != null) cells.push(`bis ${fmt(v.pv_max_wp / 1000, 1)} kWp PV`);
      if (v.modules) cells.push(esc(v.modules));
      rows.push(`<div style="display:flex;justify-content:space-between;gap:8px;font-size:11.5px;padding:3px 0;border-bottom:1px solid var(--line)">` +
        `<span>${esc(v.model)}</span><span style="color:var(--muted);text-align:right">${cells.join(' · ')}</span></div>`);
    });
  });
  const meta = (entries || []).map(p => {
    const bits = [];
    if (p.origin) bits.push(p.origin);
    if (p.chemistry) bits.push(p.chemistry);
    if (p.coupling) bits.push(p.coupling + '-gekoppelt');
    if (p.warranty_years) bits.push(p.warranty_years + ' J. Garantie');
    if (p.efficiency_max_pct) bits.push('η ' + fmt(p.efficiency_max_pct, 1) + ' %');
    if (p.local_api && p.local_api.length) bits.push('API: ' + p.local_api.join(', '));
    return `<div style="font-size:11px;color:var(--muted);margin-top:4px"><b>${esc(p.name)}</b> · ${esc(bits.join(' · '))}</div>`;
  }).join('');
  return `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--muted);font-size:12px">Technische Daten & alle Modelle</summary>` +
    `<div style="margin-top:6px">${rows.join('')}${meta}</div></details>`;
}
// Render the orientation/sizing recommendation.
function renderPvOrient() {
  const card = $('pv-orient-card'); if (!card) return;
  const opt = optimizeOrientation();
  if (!opt) { $('pv-orient-body').innerHTML = '<div class="note">Noch keine Verbrauchsdaten – sobald die Bridge misst, rechne ich die beste Ausrichtung.</div>'; return; }
  const { results, batt, battSuggested, summerDaily } = opt;
  // winter-optimised pick = highest winter autarky (reaching the summer goal)
  const feasible = results.filter(r => !r.capped);
  const pool = feasible.length ? feasible : results;
  const best = pool.slice().sort((a, b) => b.winterAut - a.winterAut)[0];
  const pct = v => `${fmt(Math.min(v * 100, 100), 0)} %`;
  const rowsHtml = results.map(r => {
    const isBest = r.o.id === best.o.id;
    return `<tr style="${isBest ? 'font-weight:600' : ''}">` +
      `<td style="padding:5px 0">${isBest ? '★ ' : ''}${esc(r.o.label)}<br><span style="color:var(--muted);font-weight:400;font-size:12px">${esc(r.o.hint)}</span></td>` +
      `<td style="text-align:right;padding:5px 6px">${fmt(r.kwp, 1)}${r.capped ? '+' : ''} kWp</td>` +
      `<td style="text-align:right;padding:5px 6px;color:${COL.pv}">${pct(r.summerAut)}</td>` +
      `<td style="text-align:right;padding:5px 6px;color:${COL.hp}">${pct(r.winterAut)}</td>` +
      `<td style="text-align:right;padding:5px 0">${pct(r.yearAut)}</td></tr>`;
  }).join('');
  $('pv-orient-body').innerHTML =
    `<table style="width:100%;border-collapse:collapse;font-size:14px">` +
    `<tr style="color:var(--muted);font-size:12px;border-bottom:1px solid var(--card-bd,#2a2f3a)">` +
    `<th style="text-align:left;padding:4px 0">Ausrichtung</th><th style="text-align:right;padding:4px 6px">kWp</th>` +
    `<th style="text-align:right;padding:4px 6px">Sommer</th><th style="text-align:right;padding:4px 6px">Winter</th>` +
    `<th style="text-align:right;padding:4px 0">Jahr</th></tr>${rowsHtml}</table>` +
    `<div style="display:flex;gap:8px;margin-top:12px">` +
    `<button class="btn sec" id="pv-orient-use" style="flex:1">★ Empfehlung übernehmen</button></div>`;
  $('pv-orient-note').innerHTML =
    `<b>Empfehlung:</b> <b>${esc(best.o.label)}</b> mit ~<b>${fmt(best.kwp, 1)} kWp</b>${battSuggested ? ` und ~<b>${batt} kWh</b> Speicher` : ''}. ` +
    `Damit ist der <b>Sommer praktisch autark</b> (${pct(best.summerAut)}) und der <b>Winter</b> so gut es geht gedeckt ` +
    `(<b>${pct(best.winterAut)}</b>). ` +
    `<span style="color:var(--muted)">Die kWp-Zahl ist jeweils so gewählt, dass der Sommer ~100 % erreicht. ` +
    `<b>Winter 100 % ist mit PV allein nicht möglich</b> (kurze Tage, flache Sonne) – dafür bräuchte es ein Vielfaches an ` +
    `Fläche; wirtschaftlich deckt man den Winter besser über Netz/dynamischen Tarif. Steile Südausrichtung holt im ` +
    `Winter am meisten heraus, Ost-West deckt den <b>Tagesverlauf</b> (morgens/abends) am besten. ` +
    (battSuggested ? `Ohne Speicher ist hohe Autarkie nicht erreichbar – daher mit ${batt} kWh gerechnet. ` : `Gerechnet mit deinem ${batt} kWh Speicher. `) +
    `Richtwerte für ~50° N; genaue Zahlen über die PVGIS-Abfrage im Setup.</span>`;
  const btn = $('pv-orient-use');
  if (btn) btn.onclick = () => {
    const setLS = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) {} };
    const kEl = $('pv-kwp'); if (kEl) { kEl.value = best.kwp; setLS(PV_LS.kwp, best.kwp); }
    // the orientation dropdown only carries an annual yield → pick the nearest option
    const opts = [1000, 950, 880, 800];
    const near = opts.reduce((a, b) => Math.abs(b - best.o.spec) < Math.abs(a - best.o.spec) ? b : a);
    const oEl = $('pv-orient'); if (oEl) { oEl.value = String(near); setLS(PV_LS.orient, near); }
    if (battSuggested) { const bEl = $('pv-batt'); if (bEl) { bEl.value = batt; setLS(PV_LS.batt, batt); } }
    // prefill the PVGIS tilt/azimuth so the user can fetch the exact (winter) curve
    const tEl = $('pv-tilt'); if (tEl) { tEl.value = best.o.tilt; setLS(PV_LS.tilt, best.o.tilt); }
    const aEl = $('pv-az'); if (aEl) { aEl.value = best.o.az; setLS(PV_LS.az, best.o.az); }
    renderPv();
    const t = $('toast');
    if (t) { t.innerHTML = `Übernommen: <b>${fmt(best.kwp, 1)} kWp</b>, ${esc(best.o.label)}` +
      `${battSuggested ? `, ${batt} kWh Speicher` : ''}. <span style="color:var(--muted)">Für die exakte ` +
      `${esc(best.o.label)}-Kurve oben „Ertrag von PVGIS holen" (Neigung/Azimut sind schon eingetragen).</span>`;
      t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 9000); }
  };
}
// Render the "Meine Flächen belegen" inventory + coverage recommendation.
function renderSurfaces() {
  const card = $('pv-surf-card'); if (!card) return;
  const rec = recommendCoverage();
  const list = $('pv-surf-list');
  // surface list
  if (rec.empty || !rec.items.length) {
    list.innerHTML = '<div class="note">Noch keine Fläche eingetragen – unten hinzufügen.</div>';
  } else {
    _surfYear = {};
    list.innerHTML = rec.items.map(it => {
      const m = it.m, L = m.layout, used = rec.chosenIds && rec.chosenIds.has(it.i);
      const sub = `${fmt(it.s.area || 0, 0)} m² · Azimut ${m.az > 0 ? '+' : ''}${fmt(m.az, 0)}°` +
        (m.shade > 0 ? ` · ${fmt(m.shade, 0)}% Schatten` : '');
      const rec2 = rec.chosenIds && rec.chosenIds.has(it.i);
      const head = `<div class="devrow" style="align-items:flex-start">` +
        `<div class="nm"><b><label style="cursor:pointer"><input type="checkbox" class="surf-use" data-idx="${it.i}" ${it.s.use !== false ? 'checked' : ''} style="margin-right:7px;vertical-align:middle">${esc(m.label)}</label></b>` +
        (rec2 ? ` <span style="color:${COL.pv};font-size:11px">· empfohlen</span>` : '') +
        `<small>${sub}</small></div>` +
        `<div class="val"><b>${fmt(m.kwp, 1)} kWp</b><small>~${kwh(m.year, 0)}/Jahr` +
        `<span style="white-space:nowrap"> <button class="linkbtn surf-edit" data-idx="${it.i}" title="Bearbeiten" style="background:none;border:none;color:var(--accent,#4da3ff);cursor:pointer;font-size:14px">✎</button>` +
        ` <button class="linkbtn surf-dup" data-idx="${it.i}" title="Duplizieren" style="background:none;border:none;color:var(--accent,#4da3ff);cursor:pointer;font-size:14px">⧉</button>` +
        ` <button class="linkbtn surf-del" data-idx="${it.i}" title="Löschen" style="background:none;border:none;color:#ff6b8a;cursor:pointer;font-size:14px">✕</button></span></small></div></div>`;
      // placement detail
      const place = L.flexible
        ? `Flachdach/Freiland: empfohlene <b>Aufständerung ${fmt(L.tilt, 0)}°</b> → <b>${L.modules} Module</b> (~${fmt(L.kwp, 1)} kWp). ` +
          `<span style="color:var(--muted)">Flacher = mehr Module (mehr kWp), steiler = mehr Ertrag je Modul aber mit Reihenabstand weniger Module.</span>`
        : `<b>${L.modules} Module</b> (~${fmt(L.kwp, 1)} kWp) in <b>Neigung ${fmt(L.tilt, 0)}°</b>.`;
      const flatAz = L.tilt <= 10 && Math.abs(L.az) >= 45
        ? ` <span style="color:var(--muted)">Bei so flacher Neigung spielt die Himmelsrichtung kaum eine Rolle – das Modul schaut fast senkrecht nach oben, nicht „nach Norden".</span>` : '';
      const gen = `🔆 <b>${fmt(L.winterDay, 1)} kWh/Tag</b> im Winter · <b>${fmt(L.summerMonth, 0)} kWh/Monat</b> im Sommer · Spitze ~<b>${fmt(L.peakKw, 1)} kW</b>.`;
      // per m² winter vs summer + seasonal spread
      const area = Math.max(1, +it.s.area || 1);
      const wM2 = L.winterMonth / area, sM2 = L.summerMonth / area;
      const ratio = wM2 > 0 ? sM2 / wM2 : 0;
      const barW = sM2 > 0 ? Math.round(wM2 / sM2 * 100) : 0;
      const spread = `<div style="margin-top:6px">` +
        `<div style="font-size:12px;color:var(--muted);margin-bottom:3px">pro m² · Sommer/Winter-Spannweite ~<b style="color:var(--ink)">${fmt(ratio, 1)}×</b></div>` +
        `<div style="display:flex;align-items:center;gap:6px;margin:1px 0"><span style="width:52px;font-size:11px;color:var(--muted)">❄️ Winter</span>` +
        `<div style="flex:1;height:9px;background:var(--card-bd,#2a2f3a);border-radius:5px;overflow:hidden"><div style="width:${barW}%;height:100%;background:${COL.hp}"></div></div>` +
        `<b style="font-size:11px;width:72px;text-align:right">${fmt(wM2, 1)} kWh/m²</b></div>` +
        `<div style="display:flex;align-items:center;gap:6px;margin:1px 0"><span style="width:52px;font-size:11px;color:var(--muted)">☀️ Sommer</span>` +
        `<div style="flex:1;height:9px;background:var(--card-bd,#2a2f3a);border-radius:5px;overflow:hidden"><div style="width:100%;height:100%;background:${COL.pv}"></div></div>` +
        `<b style="font-size:11px;width:72px;text-align:right">${fmt(sM2, 1)} kWh/m²</b></div>` +
        `<div style="font-size:11px;color:var(--muted);margin-top:2px">kWh je m² Fläche und Monat (Ø Dez–Feb bzw. Jun–Aug)</div></div>`;
      let tbl = '';
      if (L.flexible) {
        tbl = `<table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px">` +
          `<tr style="color:var(--muted)"><th style="text-align:left;font-weight:400">Neigung</th>` +
          `<th style="text-align:right;font-weight:400">Module</th><th style="text-align:right;font-weight:400">kWp</th>` +
          `<th style="text-align:right;font-weight:400">kWh/Jahr</th></tr>` +
          L.opts.map(o => `<tr style="${o.tilt === L.tilt ? 'font-weight:600;color:' + COL.pv : ''}">` +
            `<td style="text-align:left">${o.tilt === L.tilt ? '★ ' : ''}${fmt(o.tilt, 0)}°</td>` +
            `<td style="text-align:right">${o.modules}</td><td style="text-align:right">${fmt(o.kwp, 1)}</td>` +
            `<td style="text-align:right">${kwh(o.annual, 0)}</td></tr>`).join('') + `</table>`;
      }
      // day-match with the user's hourly load
      let matchHtml = '';
      if (it.match != null) {
        const mp = Math.round(it.match * 100);
        const q = it.match >= 0.55 ? 'passt gut' : it.match >= 0.42 ? 'passt mittel' : 'passt wenig';
        matchHtml = `<br>🕑 <b>Tages-Deckung ${mp}/100</b> – ${q} zu deinem Stundenverbrauch (je höher, desto mehr PV kannst du direkt nutzen).`;
      }
      _surfYear[it.i] = buildSurfaceYear(L);
      const chart = yearChart(_surfYear[it.i].yld, _surfYear[it.i].load, it.i);
      return head + `<div class="note" style="margin:-2px 0 12px;line-height:1.55">${place}${flatAz}<br>${gen}${matchHtml}${spread}${tbl}${chart}</div>`;
    }).join('');
  }
  // recommendation / totals
  const resEl = $('pv-surf-result'), noteEl = $('pv-surf-note'), useBtn = $('pv-surf-use'), resetBtn = $('pv-surf-reset');
  if (rec.empty || !rec.items.length) { resEl.innerHTML = ''; noteEl.innerHTML = ''; if (useBtn) useBtn.hidden = true; if (resetBtn) resetBtn.hidden = true; return; }
  const pct = v => `${fmt(Math.min(v * 100, 100), 0)} %`;
  if (rec.noLoad) {
    resEl.innerHTML = `<div class="grid2"><div class="kpi sm"><div class="v">${fmt(rec.all.kwp, 1)} kWp</div><div class="l">max. installierbar</div></div>` +
      `<div class="kpi sm"><div class="v">${kwh(rec.all.year, 0)}</div><div class="l">Potenzial / Jahr</div></div></div>`;
    noteEl.innerHTML = 'Sobald Verbrauchsdaten da sind, empfehle ich auch die beste <b>Belegung</b> (Sommer-Autarkie).';
    if (useBtn) { useBtn.hidden = false; }
    if (resetBtn) resetBtn.hidden = true;   // no recommendation without load data
  } else {
    resEl.innerHTML = `<div class="grid2">` +
      `<div class="kpi sm"><div class="v">${fmt(rec.comb.kwp, 1)} kWp</div><div class="l">empfohlen belegen</div></div>` +
      `<div class="kpi sm"><div class="v">${fmt(rec.all.kwp, 1)} kWp</div><div class="l">max. möglich</div></div>` +
      `<div class="kpi sm"><div class="v" style="color:${COL.pv}">${pct(rec.summerAut)}</div><div class="l">Sommer-Autarkie</div></div>` +
      `<div class="kpi sm"><div class="v" style="color:${COL.hp}">${pct(rec.winterAut)}</div><div class="l">Winter-Autarkie</div></div></div>`;
    const usedLabels = rec.chosen.map(x => x.m.label);
    const reserveKwp = Math.max(0, rec.all.kwp - rec.comb.kwp);
    const steepReserve = rec.items.find(it => !rec.chosenIds.has(it.i) && it.m.tilt >= 60);
    // headline
    let why = `<b>Beste Belegung:</b> ${esc([...new Set(usedLabels)].join(', '))} → ~<b>${fmt(rec.comb.kwp, 1)} kWp</b> ` +
      `(${fmt(rec.comb.spec, 0)} kWh/kWp)${rec.battSuggested ? `, mit ~<b>${rec.batt} kWh</b> Speicher` : ''}. ` +
      (rec.reached ? `Sommer praktisch autark (<b>${pct(rec.summerAut)}</b>), Winter <b>${pct(rec.winterAut)}</b>.`
        : `Sommer <b>${pct(rec.summerAut)}</b>, Winter <b>${pct(rec.winterAut)}</b> – für 100 % im Sommer fehlt Fläche.`);
    // Warum diese Belegung?
    why += `<div style="margin-top:10px"><b>Warum so?</b></div><ul style="margin:4px 0 0;padding-left:18px;line-height:1.5">`;
    why += `<li><b>Ziel = Sommer selbst nutzen:</b> Ich belege so viel, dass im Sommer fast dein ganzer Strom aus eigener ` +
      `PV kommt. Entscheidend ist der <b>direkt selbst genutzte</b> Strom (dein Stunden-Verbrauch) – nicht der höchste Ertrag.</li>`;
    if (rec.reached && reserveKwp > 0.3) {
      why += `<li><b>Warum nicht alles?</b> Die restlichen ~${fmt(reserveKwp, 1)} kWp (○ Reserve) würden im Sommer kaum mehr ` +
        `Eigenverbrauch bringen – der Überschuss ginge fast nur <b>ins Netz</b> (geringe Vergütung). Sie lohnen erst, wenn dein ` +
        `Verbrauch steigt (Auto/Wärmepumpe) oder ein <b>größerer Speicher</b> dazukommt.</li>`;
    } else if (!rec.reached) {
      why += `<li><b>Warum alles?</b> Selbst voll belegt wird der Sommer nicht ganz autark – deshalb nutze ich jede Fläche.</li>`;
    }
    why += `<li><b>Warum nicht weniger?</b> Mit weniger kWp wäre der Sommer nicht mehr voll gedeckt – du müsstest auch im ` +
      `Sommer Strom zukaufen.</li>`;
    why += `<li><b>Warum „vernachlässigen" wir den Winter?</b> Nicht aus Desinteresse: im Dezember/Januar ist die Sonne ` +
      `kurz und flach – <b>100 % Winter-Autarkie ist mit PV praktisch unmöglich</b>. Dafür bräuchte es ein Vielfaches an ` +
      `Fläche, deren riesiger <b>Sommer-Überschuss</b> dann ungenutzt ins Netz ginge (teuer, unwirtschaftlich). Den ` +
      `Winter-Rest deckst du günstiger über <b>Netz/dynamischen Tarif</b>. Trotzdem fließt der Winter in die Auswahl ein ` +
      `(als Gewichtung) – er ist nur nicht das Abbruch-Ziel.</li>`;
    if (steepReserve) {
      why += `<li><b>Warum nicht die ${esc(steepReserve.m.label)} (${fmt(steepReserve.m.tilt, 0)}°)?</b> Stimmt – ihre ` +
        `Sommer/Winter-<b>Spannweite</b> ist kleiner (gleichmäßiger). Aber sie liefert <b>absolut viel weniger</b> ` +
        `(senkrecht ~70 % vom Optimum, ${fmt(steepReserve.m.spec, 0)} statt ${fmt(rec.comb.spec, 0)} kWh/kWp): ihr Winter-Plus ` +
        `ist in kWh klein und ändert nichts daran, dass der Winter &lt;100 % bleibt – fürs Sommer-Ziel bringen die ` +
        `ertragstärkeren Flächen mehr. Ist dir <b>Winterertrag wichtiger als Wirtschaftlichkeit</b>, nimm sie bewusst dazu ` +
        `(sie steht als ○ Reserve bereit).</li>`;
    }
    why += `</ul>`;
    why += `<div class="note" style="margin-top:8px;color:var(--muted)">✓ = genutzt, ○ = Reserve. Reihenfolge nach ` +
      `höchstem <b>Selbstverbrauch</b> (dein Stunden-Profil). Der Button „💡 kWp &amp; Speicher vorschlagen" oben zielt dagegen ` +
      `auf <b>Jahresdeckung</b> (Ertrag ≈ Jahresverbrauch) – darum kann dessen kWp-Zahl abweichen. „Als Anlage übernehmen" ` +
      `rechnet den ganzen PV-Tab mit dieser Belegung. Richtwerte ~50° N; exakt via PVGIS.</div>`;
    noteEl.innerHTML = why;
    if (useBtn) useBtn.hidden = false;
    if (resetBtn) resetBtn.hidden = false;
  }
  renderSurfaceCombo();
}
// Combined card for the surfaces the user ticked: cumulative year chart + totals.
function renderSurfaceCombo() {
  const card = $('pv-combo-card'); if (!card) return;
  const surfs = loadSurfaces();
  if (!surfs.length) { card.hidden = true; return; }
  card.hidden = false;
  const sel = surfs.map((s, i) => ({ i, s })).filter(x => x.s.use !== false);
  const body = $('pv-combo-body'), chart = $('pv-combo-chart'), note = $('pv-combo-note'), useBtn = $('pv-combo-use');
  if (!sel.length) {
    body.innerHTML = '<div class="note">Keine Fläche ausgewählt – oben Häkchen setzen.</div>';
    chart.innerHTML = ''; note.innerHTML = ''; if (useBtn) useBtn.hidden = true; return;
  }
  const ms = sel.map(x => surfaceMetrics(x.s)), comb = combineSurfaces(ms);
  const area = sel.reduce((a, x) => a + (+x.s.area || 0), 0);
  const sum = f => ms.reduce((a, m) => a + m.layout[f], 0);
  const winterDay = sum('winterDay'), summerMonth = sum('summerMonth'), winterMonth = sum('winterMonth');
  const peak = sum('peakKw'), modules = ms.reduce((a, m) => a + m.layout.modules, 0);
  // cumulative daily series
  const yld = new Array(365).fill(0); let load = null;
  ms.forEach(m => { const sy = buildSurfaceYear(m.layout); for (let d = 0; d < 365; d++) yld[d] += sy.yld[d]; if (!load) load = sy.load; });
  _surfYear.combo = { yld, load };
  // autarky (if load known) + suggested battery
  let autHtml = '', batt = 0, battSuggested = false;
  if (shAvgDaily() > 0 || hpAvgDaily() > 0) {
    const base = pvInputs();
    const probe = simulatePv({ ...base, kwp: 0, batt: 0, v2h: false, cap60: false });
    const mL = probe.monthly.map(x => x.load), summerDaily = (mL[5] + mL[6] + mL[7]) / 92;
    battSuggested = base.batt <= 0; batt = base.batt > 0 ? base.batt : Math.max(3, Math.round(summerDaily * 0.6));
    const r = simulatePv({ ...base, kwp: comb.kwp, batt, v2h: false, cap60: false, spec: comb.spec, pvShareMonth: comb.shape, pvHourFn: comb.ew ? ewHourFn : null });
    const pc = v => `${fmt(Math.min(v * 100, 100), 0)} %`;
    autHtml = `<div class="kpi sm"><div class="v" style="color:${COL.pv}">${pc(seasonAutarky(r, [5, 6, 7]))}</div><div class="l">Sommer-Autarkie</div></div>` +
      `<div class="kpi sm"><div class="v" style="color:${COL.hp}">${pc(seasonAutarky(r, [11, 0, 1]))}</div><div class="l">Winter-Autarkie</div></div>`;
  }
  body.innerHTML = `<div class="grid2">` +
    `<div class="kpi sm"><div class="v">${modules} · ${fmt(comb.kwp, 1)} kWp</div><div class="l">Module · Leistung</div></div>` +
    `<div class="kpi sm"><div class="v">${kwh(comb.year, 0)}</div><div class="l">Ertrag/Jahr · ${fmt(comb.spec, 0)} kWh/kWp</div></div>` +
    autHtml + `</div>` +
    `<div class="note" style="margin-top:8px">🔆 <b>${fmt(winterDay, 1)} kWh/Tag</b> im Winter · <b>${fmt(summerMonth, 0)} kWh/Monat</b> im Sommer · Spitze ~<b>${fmt(peak, 1)} kW</b> (Summe). ` +
    `Pro m²: Winter ${fmt(winterMonth / Math.max(1, area), 1)} · Sommer ${fmt(summerMonth / Math.max(1, area), 1)} kWh/m²·Mon · Spannweite ~${fmt(summerMonth / Math.max(0.001, winterMonth), 1)}×.</div>`;
  chart.innerHTML = yearChart(yld, load, 'combo');
  note.innerHTML = `Kumuliert über deine <b>${sel.length}</b> ausgewählte(n) Fläche(n): ${esc([...new Set(ms.map(m => m.label))].join(', '))}. ` +
    `Häkchen oben ändern die Auswahl. Grün = Summe der Erträge, blau = Hausverbrauch.`;
  if (useBtn) { useBtn.hidden = false; useBtn._combo = { comb, batt, battSuggested }; }
}
// Selbstbau vs. Fachfirma: just two prices – your complete DIY set vs. the
// turnkey offer (minus subsidy) – so you directly see which is cheaper.
function renderBuildCompare(p) {
  const card = $('pv-build-card'); if (!card) return;
  const g = (k, d) => { const v = parseFloat(localStorage.getItem(k)); return isFinite(v) ? v : d; };
  const kwp = Math.max(0, p.kwp), bat = Math.max(0, p.batt);
  const diyTotal = Math.max(0, g(PCOST_LS.diySet, 0));
  const proOffer = Math.max(0, g(PCOST_LS.proOffer, 0));
  const foerder = Math.max(0, g(PCOST_LS.foerder, 0));
  const proTotal = Math.max(0, proOffer - foerder);
  const diyHours = g(PCOST_LS.diyHours, 0);

  if (!(diyTotal > 0) && !(proOffer > 0)) {
    $('pc-kpi').innerHTML = ''; $('pc-bar').innerHTML = '';
    $('pc-note').innerHTML = 'Trag oben deinen <b>Komplett-Set-Preis</b> (Selbstbau) und das ' +
      '<b>Komplett-Angebot</b> der Fachfirma ein – dann vergleiche ich beide direkt.';
    return;
  }
  const both = diyTotal > 0 && proTotal > 0;
  const cheaper = diyTotal <= proTotal ? 'diy' : 'pro';
  const diff = Math.abs(proTotal - diyTotal);
  const diffPct = Math.max(diyTotal, proTotal) > 0 ? diff / Math.max(diyTotal, proTotal) * 100 : 0;

  // KPIs
  $('pc-kpi').innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v" style="color:${both && cheaper === 'diy' ? '#4be0b0' : 'inherit'}">${diyTotal > 0 ? money(diyTotal) : '–'}</div><div class="l">Selbstbau (Set)</div></div>` +
    `<div class="kpi sm"><div class="v" style="color:${both && cheaper === 'pro' ? '#4be0b0' : 'inherit'}">${proOffer > 0 ? money(proTotal) : '–'}</div><div class="l">Fachfirma (netto)</div></div>` +
    (both
      ? `<div class="kpi sm"><div class="v">${money(diff)}</div><div class="l">${cheaper === 'diy' ? 'Selbstbau spart' : 'Fachfirma günstiger'} · ${fmt(diffPct, 0)} %</div></div>`
      : `<div class="kpi sm"><div class="v">–</div><div class="l">beide Preise eintragen</div></div>`) +
    (kwp > 0 ? `<div class="kpi sm"><div class="v">${fmt(kwp, 1)} kWp · ${fmt(bat, 1)} kWh</div><div class="l">Anlage (aus Planung)</div></div>` : '') + `</div>`;

  // two comparison bars (net totals), scaled to the larger one
  const mx = Math.max(diyTotal, proTotal, 1);
  const bar = (label, total, win, minusTxt) => {
    if (!(total > 0)) return '';
    return `<div style="display:flex;justify-content:space-between;font-size:13px;margin:2px 0">` +
      `<span>${label}${win ? ' <b style="color:#4be0b0">✓ günstiger</b>' : ''}</span><b>${money(total)}</b></div>` +
      `<div style="height:20px;border-radius:6px;overflow:hidden;background:var(--card-bd,#2a2f3a)">` +
      `<div style="width:${(total / mx * 100).toFixed(1)}%;height:100%;background:${win ? COL.pv : COL.hp}"></div></div>` +
      (minusTxt ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">${minusTxt}</div>` : '');
  };
  $('pc-bar').innerHTML =
    bar('🔧 Selbstbau', diyTotal, both && cheaper === 'diy', '') +
    (diyTotal > 0 && proTotal > 0 ? `<div style="height:8px"></div>` : '') +
    bar('🏢 Fachfirma', proTotal, both && cheaper === 'pro',
      foerder > 0 && proOffer > 0 ? `Angebot ${money(proOffer)} − Förderung ${money(foerder)}` : '');

  const perKwpDiy = kwp > 0 && diyTotal > 0 ? diyTotal / kwp : 0, perKwpPro = kwp > 0 && proTotal > 0 ? proTotal / kwp : 0;
  $('pc-note').innerHTML =
    (both
      ? `<b>${cheaper === 'diy' ? 'Selbstbau' : 'Die Fachfirma'}</b> ist rund <b>${money(diff)}</b> günstiger (${fmt(diffPct, 0)} %). `
      : 'Trag <b>beide</b> Preise ein, dann zeige ich die Differenz. ') +
    (kwp > 0 && both ? `Das sind ${money(perKwpDiy)} vs. ${money(perKwpPro)} <b>pro kWp</b>. ` : '') +
    (diyHours > 0 ? `Dein Eigenaufwand: ~<b>${fmt(diyHours, 0)} Std.</b> (nicht in Geld gerechnet). ` : '') +
    `<span style="color:var(--muted)">Selbstbau = dein Komplett-Set; Netzanschluss/Anmeldung braucht i. d. R. eine ` +
    `Elektrofachkraft. Fachfirma = schlüsselfertiges Angebot minus Förderung (die oft eine Fachfirma voraussetzt). ` +
    `Nutz die Buttons, um den Wert als Investition in die Amortisation zu übernehmen.</span>`;
}

/* --------------------------------------------------------------- settings */
function renderSettings() {
  const h = STATE.health;
  const rows = $('status-rows');
  if (!h) {
    rows.innerHTML = statusRow('Bridge', 'nicht erreichbar – Demo-Ansicht');
    $('pair-note').innerHTML = 'Kopplung ist nur möglich, wenn diese Seite direkt <b>von der Bridge</b> geöffnet wird.';
    return;
  }
  const modeTxt = { live: 'Live · Controller verbunden', demo: 'Demo-Daten', idle: 'Noch nicht gekoppelt' }[h.mode] || h.mode;
  const last = h.last_poll ? new Date(h.last_poll * 1000).toLocaleTimeString('de-DE') : '–';
  rows.innerHTML = [
    ['Modus', modeTxt],
    ['Geräte gefunden', fmt(h.device_count || 0, 0)],
    ['Messpunkte gespeichert', fmt(h.sample_count || 0, 0)],
    ['Letzte Messung', last],
    ['Zertifikat', h.has_cert ? 'vorhanden ✓' : 'fehlt'],
    ['Wärmepumpe', h.homecom_connected ? 'verbunden ✓' : 'nicht verbunden'],
    (h.hp_import && (h.hp_import.days || h.hp_import.months))
      ? ['WP-Historie (CSV)', `${h.hp_import.days} Tage · ${h.hp_import.months} Monate ✓`] : null,
    h.last_error ? ['Letzter Fehler', esc(h.last_error)] : null,
  ].filter(Boolean).map(([k, v]) => statusRow(k, v)).join('');
  if (h.shc_ip && !$('shc-ip').value) $('shc-ip').value = h.shc_ip;
  if (h.price_per_kwh) $('shc-price').value = h.price_per_kwh;
  if (h.poll_interval) $('shc-interval').value = h.poll_interval;
  const au = $('auto-update'), aun = $('auto-update-note');
  if (au) {
    if (document.activeElement !== au) au.value = String(h.auto_update_interval || 0);
    if (aun) aun.innerHTML = h.is_git_repo === false
      ? 'Nur bei einer git-Installation möglich (du hast das Repo geklont). Sonst bitte manuell aktualisieren.'
      : (h.auto_update_interval > 0
        ? `Aktiv – die Bridge prüft alle <b>${h.auto_update_interval} Min.</b> auf Updates und startet bei Bedarf neu.`
        : 'Aus – Updates holst du über den Knopf oben.');
  }
  renderRenameList();

  const hs = $('hp-status');
  if (hs) {
    hs.innerHTML = !h.homecom_available
      ? 'HomeCom-Modul nicht installiert (Datei <code>bridge/homecom.py</code> fehlt).'
      : h.homecom_connected
        ? 'Verbunden ✓' + (h.homecom_gateway ? ' · Gateway ' + esc(h.homecom_gateway) : '') +
          (h.homecom_last_error ? ' · <span style="color:#ff6b8a">Fehler: ' + esc(h.homecom_last_error) + '</span>' : '')
        : 'Noch nicht verbunden.';
  }

  const as = $('aeg-status');
  if (as) {
    as.innerHTML = h.electrolux_available === false
      ? 'Electrolux-Modul nicht installiert (Datei <code>bridge/electrolux.py</code> fehlt).'
      : h.electrolux_connected
        ? 'Verbunden ✓' + (h.electrolux_count ? ' · ' + h.electrolux_count + ' Gerät(e)' : '') +
          (h.electrolux_last_error ? ' · <span style="color:#ff6b8a">Fehler: ' + esc(h.electrolux_last_error) + '</span>' : '')
        : 'Noch nicht verbunden.';
  }
  const kpc = $('aeg-kpc');
  if (kpc && document.activeElement !== kpc && h.electrolux_kwh_per_cycle != null)
    kpc.value = h.electrolux_kwh_per_cycle;

  const ts = $('tibber-status');
  if (ts) {
    ts.innerHTML = h.tibber_available === false
      ? 'Tibber-Modul nicht installiert (Datei <code>bridge/tibber.py</code> fehlt).'
      : h.mode === 'demo'
        ? '<b>Demo</b> – es werden Beispiel-Tarifpreise gezeigt. Verbinde auf deiner Bridge dein echtes Konto.'
        : h.tibber_connected
          ? '<b style="color:#4be0b0">Verbunden ✓</b> – die Börse-Ansicht nutzt deine echten Tibber-Preise.'
          : 'Noch nicht verbunden.';
  }
  const has = $('ha-status');
  if (has) {
    const cnt = (STATE.ha && STATE.ha.entities || []).length;
    has.innerHTML = h.ha_available === false
      ? 'HA-Modul nicht installiert (Datei <code>bridge/ha_client.py</code> fehlt).'
      : h.mode === 'demo'
        ? '<b>Demo</b> – Beispiel-Sensoren. Auf deiner Bridge dein echtes Home Assistant verbinden.'
        : h.ha_connected
          ? `<b style="color:#4be0b0">Verbunden ✓</b>${cnt ? ' – ' + cnt + ' Sensor(en) auf der Übersicht' : ''}.`
          : 'Noch nicht verbunden.';
    const uu = $('ha-url'); if (uu && document.activeElement !== uu && h.ha_url) uu.value = h.ha_url;
  }

  const se = $('spot-enabled');
  if (se && document.activeElement !== se) {
    se.checked = !!h.spot_enabled;
    const sm = $('spot-market'); if (sm && document.activeElement !== sm) sm.value = h.spot_market || 'de';
    const ss = $('spot-surcharge'); if (ss && document.activeElement !== ss) ss.value = h.spot_surcharge_ct != null ? h.spot_surcharge_ct : 15;
    const sv = $('spot-vat'); if (sv && document.activeElement !== sv) sv.value = h.spot_vat != null ? h.spot_vat : 19;
    const sn = $('spot-note');
    if (sn) sn.innerHTML = h.spot_available === false
      ? 'Spot-Modul nicht installiert (<code>bridge/spot.py</code> fehlt).'
      : h.spot_enabled ? 'Aktiv ✓ – im Tab <b>Börse</b> siehst du die Preise.' : 'Aus.';
  }
}

function friendlyModel(m) {
  m = m || '';
  // Bosch Smart Plug / Smart Plug+ (measuring plug) report models like
  // PSM, PLUG_COMPACT, SMARTPLUG, BSP…; match by pattern, never a fixed id.
  if (/PLUG|PSM|SMART[\s_-]?PLUG|\bBSP\b/i.test(m)) return 'Zwischenstecker (Smart Plug)';
  if (/SHUTTER/i.test(m)) return 'Rollladen-Modul';
  if (/LIGHT/i.test(m)) return 'Licht-/Rollladen-Modul';
  return m || 'Modul';
}

function renderRenameList() {
  const box = $('rename-list'); if (!box) return;
  const devs = (STATE.data && STATE.data.live && STATE.data.live.devices) || [];
  if (!devs.length) { box.innerHTML = '<div class="note">Noch keine Geräte gefunden.</div>'; return; }
  const list = [...devs].sort((a, b) => devLabel(a).title.localeCompare(devLabel(b).title));
  box.innerHTML = list.map(d => {
    const cap = [friendlyModel(d.model), d.room || null, 'ID ' + shortId(d.id)].filter(Boolean).join(' · ');
    return `<div style="margin-bottom:12px"><label>${esc(cap)}</label>
      <input class="rn" data-id="${esc(d.id)}" value="${esc(d.custom_name || '')}"
             placeholder="${esc(devLabel(d).title)}" autocomplete="off" autocapitalize="words" spellcheck="false"></div>`;
  }).join('');
}

function applyCustomName(id, name) {
  const arr = STATE.data && STATE.data.live && STATE.data.live.devices;
  if (arr) for (const d of arr) if (d.id === id) d.custom_name = name;
}

function shortId(id) { const m = String(id || '').match(/([0-9a-f]{6})$/i); return m ? m[1] : String(id || '').slice(-6); }
function devLabel(d) {
  const custom = (d.custom_name || '').trim();
  if (custom) return { title: custom, sub: d.room || d.name || '' };
  const name = d.name || '';
  const generic = /rollladensteuerung|micromodule|light[\s_-]?control|shutter[\s_-]?control/i.test(name)
    || name.toLowerCase() === (d.model || '').toLowerCase();
  if (generic && d.room) return { title: d.room, sub: name };
  if (generic) return { title: 'Licht/Rollladen · ' + shortId(d.id), sub: name };
  return { title: name || d.room || 'Gerät', sub: d.room || d.model || '' };
}

/* ------------------------------------------------------------ interactions */
async function doHomecomConnect() {
  const note = $('hp-connect-note'), btn = $('hp-connect');
  const code = $('hp-code').value.trim();
  if (!code) { note.textContent = 'Bitte den Code bzw. die Redirect-Adresse einfügen.'; return; }
  btn.disabled = true; note.textContent = 'Verbinde mit HomeCom …';
  try {
    const r = await postJSON('/api/homecom/connect', { code });
    if (r.ok) { note.innerHTML = '✅ ' + escIp(r.message || 'Verbunden.'); setTimeout(loadAll, 1500); }
    else note.innerHTML = '⚠︎ ' + escIp(r.error || 'Verbindung fehlgeschlagen.');
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
  btn.disabled = false;
}

async function doAegConnect() {
  const note = $('aeg-connect-note'), btn = $('aeg-connect');
  const api_key = $('aeg-key').value.trim();
  const refresh_token = $('aeg-refresh').value.trim();
  const access_token = $('aeg-access').value.trim();
  if (!api_key || !refresh_token) { note.textContent = 'Bitte API-Key und Refresh-Token einfügen.'; return; }
  btn.disabled = true; note.textContent = 'Verbinde mit AEG/Electrolux …';
  try {
    const r = await postJSON('/api/electrolux/connect', { api_key, refresh_token, access_token });
    if (r.ok) {
      note.innerHTML = '✅ ' + escIp(r.message || 'Verbunden.');
      $('aeg-refresh').value = ''; $('aeg-access').value = '';   // don't leave tokens on screen
      setTimeout(loadAll, 1500);
    } else note.innerHTML = '⚠︎ ' + escIp(r.error || 'Verbindung fehlgeschlagen.');
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
  btn.disabled = false;
}

async function doAegDisconnect() {
  const note = $('aeg-connect-note'), btn = $('aeg-disconnect');
  if (!confirm('AEG/Electrolux deaktivieren und Zugangsdaten löschen? (Keine Fehlermeldungen mehr; später über „Verbinden" wieder aktivierbar.)')) return;
  if (btn) btn.disabled = true; if (note) note.textContent = 'Deaktiviere …';
  try {
    const r = await postJSON('/api/electrolux/disconnect', {});
    if (note) note.innerHTML = r && r.ok ? '✅ ' + escIp(r.message || 'Deaktiviert.') : '⚠︎ ' + escIp((r && r.error) || 'Fehlgeschlagen.');
    setTimeout(loadAll, 1200);
  } catch (e) { if (note) note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
  if (btn) btn.disabled = false;
}

async function doHaConnect() {
  const note = $('ha-note'), btn = $('ha-connect');
  const url = $('ha-url').value.trim(), token = $('ha-token').value.trim();
  const entities = $('ha-entities').value.trim();
  if (!url || !token) { note.textContent = 'Bitte Adresse und Token eingeben.'; return; }
  btn.disabled = true; note.textContent = 'Verbinde mit Home Assistant …';
  try {
    const r = await postJSON('/api/ha/connect', { url, token, entities });
    if (r.ok) {
      const n = (r.entities || []).length;
      note.innerHTML = '✅ ' + escIp(r.message || 'Verbunden.') + (n ? ` (${n} Sensor(en))` : '');
      $('ha-token').value = '';                     // don't leave the token on screen
      setTimeout(loadAll, 1200);
    } else note.innerHTML = '⚠︎ ' + escIp(r.error || 'Verbindung fehlgeschlagen.');
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
  btn.disabled = false;
}

async function doTibberConnect() {
  const note = $('tibber-note'), btn = $('tibber-connect');
  const token = $('tibber-token').value.trim();
  if (!token) { note.textContent = 'Bitte deinen Tibber Access Token einfügen.'; return; }
  btn.disabled = true; note.textContent = 'Verbinde mit Tibber …';
  try {
    const r = await postJSON('/api/tibber/connect', { token });
    if (r.ok) {
      note.innerHTML = '✅ ' + escIp(r.message || 'Verbunden.');
      $('tibber-token').value = '';                 // don't leave the token on screen
      setTimeout(loadAll, 1200);
    } else note.innerHTML = '⚠︎ ' + escIp(r.error || 'Verbindung fehlgeschlagen.');
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
  btn.disabled = false;
}

async function doAegProbe() {
  const out = $('aeg-probe-out'), btn = $('aeg-probe');
  btn.disabled = true; out.textContent = 'Frage Gerät ab …';
  try {
    const r = await postJSON('/api/electrolux/probe', {});
    out.textContent = r.ok ? JSON.stringify(r.probe, null, 2) : ('Fehler: ' + (r.error || '?'));
  } catch (e) { out.textContent = 'Fehler: ' + e.message; }
  btn.disabled = false;
}

// Apply a yield (kWh/kWp) + monthly curve to the planner (shared by the PVGIS
// fetch and the local-estimate fallback).
function applyPvYield(yieldKwp, monthly, label) {
  const sel = $('pv-orient');
  if (sel && yieldKwp) {
    let opt = [...sel.options].find(o => o.dataset.pvgis);
    if (!opt) { opt = document.createElement('option'); opt.dataset.pvgis = '1'; sel.appendChild(opt); }
    opt.value = Math.round(yieldKwp); opt.textContent = `${label}: ${Math.round(yieldKwp)} kWh/kWp`;
    sel.value = opt.value;
    try { localStorage.setItem(PV_LS.orient, opt.value); } catch (e) {}
  }
  if (Array.isArray(monthly) && monthly.length === 12 && monthly.every(v => v > 0)) {
    try { localStorage.setItem(PV_LS.pgm, JSON.stringify(monthly)); } catch (e) {}
  }
  renderPv(); renderKonzept();
}
// Built-in estimate from tilt/azimuth (no network, ~50° N) – used as a fallback
// when the PVGIS request can't be reached (e.g. desktop Safari blocking it).
function localYieldEstimate(tilt, az) {
  return { yield: YIELD_OPT * relYield(tilt, az) / 100, monthly: monthForTilt(tilt) };
}
async function doPvgis() {
  const note = $('pv-pvgis-note'), btn = $('pv-pvgis');
  const lat = parseFloat($('pv-lat').value), lon = parseFloat($('pv-lon').value);
  const tilt = parseFloat($('pv-tilt').value) || 35, az = parseFloat($('pv-az').value) || 0;
  const fallback = (reason) => {
    const est = localYieldEstimate(tilt, az);
    applyPvYield(est.yield, est.monthly, 'Schätzung');
    note.innerHTML = `✅ <b>${Math.round(est.yield)} kWh/kWp</b> + Monatskurve aus dem <b>eingebauten Modell</b> ` +
      `(Neigung ${fmt(tilt, 0)}°, Azimut ${az > 0 ? '+' : ''}${fmt(az, 0)}°). ` +
      `<span style="color:var(--muted)">${esc(reason)} Richtwert für ~50° N – für den exakten Standortwert PVGIS direkt von der Bridge aufrufen.</span>`;
  };
  btn.disabled = true;
  try {
    if (!isFinite(lat) || !isFinite(lon)) { fallback('PVGIS braucht Koordinaten – daher lokal geschätzt.'); btn.disabled = false; return; }
    note.textContent = 'Frage PVGIS für deinen Standort …';
    // race a timeout so a silently-hanging request (some desktop browsers block
    // local requests without erroring) still falls back instead of spinning.
    const r = await Promise.race([
      api(`/api/pvgis?lat=${lat}&lon=${lon}&tilt=${tilt}&az=${az}`),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000)),
    ]);
    if (!r || r.ok === false || !r.yield) { fallback('PVGIS nicht erreichbar – lokal geschätzt.'); btn.disabled = false; return; }
    applyPvYield(r.yield, r.monthly, 'PVGIS Standort');
    note.innerHTML = `✅ Übernommen: <b>${Math.round(r.yield)} kWh/kWp</b> und die Monatskurve für deinen Standort` +
      (r.demo ? ' <span style="color:var(--muted)">(Demo)</span>' : '') + '.';
  } catch (e) {
    fallback('PVGIS nicht erreichbar (Netz/Browser) – lokal geschätzt.');
  }
  btn.disabled = false;
}

// Envelope + ventilation heat-loss coefficient of the building, in W/K –
// the same terms the annual degree-day model sums (see computeHeat).
function buildUA(b) {
  let ua = 0;
  b.comps.forEach(c => { ua += c.u * c.a * c.f; });
  ua += 0.34 * b.n * (b.area * b.height);        // ventilation
  return ua;
}

// The user's location: from the PV inputs, else from what PVGIS saved.
function getLatLon() {
  let lat = parseFloat($('pv-lat') && $('pv-lat').value), lon = parseFloat($('pv-lon') && $('pv-lon').value);
  if (!isFinite(lat) || !isFinite(lon)) {
    try { lat = parseFloat(localStorage.getItem(PV_LS.lat)); lon = parseFloat(localStorage.getItem(PV_LS.lon)); } catch (e) {}
  }
  return (isFinite(lat) && isFinite(lon)) ? { lat, lon } : null;
}

// Expected heat-pump electricity & heat per forecast day, from outside temp +
// the building model (same degree-day basis as the annual theory).
function hpForecastDays(w) {
  const b = buildData(), ua = buildUA(b);
  const copHeat = b.cop_heat || 2.6, gain = b.gain, tIndoor = 20;
  const dhwElec = (b.dhw / (b.cop_dhw || 2.7)) / 8760;
  // Calibrate the building-model forecast to the user's REAL measured WP level,
  // so the Wärme tab stays consistent with the overview/Verlauf figures. The
  // pure heat-loss model tends to run high for the finished house; we keep its
  // weather-driven day-to-day shape and only rescale the absolute height to the
  // real annual (hpAnnualReal). Falls back to 1 (raw theory) without real data.
  const rHeat = computeHeat(b);
  const realAnnual = hpAnnualReal() || hpYearFromMonthly() || null;
  const cal = (realAnnual && rHeat.eTotal > 0) ? realAnnual / rHeat.eTotal : 1;
  const dayMap = new Map();
  (w.hourly || []).forEach(h => {
    const d = new Date(h.ts * 1000), key = d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(h);
  });
  const now = new Date(), todayKey = now.getFullYear() * 10000 + now.getMonth() * 100 + now.getDate();
  return [...dayMap.keys()].sort((a, z) => a - z).map(k => {
    const rows = dayMap.get(k); let elec = 0, heat = 0, tmin = 99, tmax = -99;
    rows.forEach(h => {
      elec += dhwElec;
      if (h.temp != null) {
        const th = ua * Math.max(0, tIndoor - h.temp) / 1000 * (1 - gain);   // kWh thermal that hour
        heat += th; elec += th / copHeat; tmin = Math.min(tmin, h.temp); tmax = Math.max(tmax, h.temp);
      }
    });
    const d = new Date(rows[0].ts * 1000);
    elec *= cal; heat *= cal;   // anchor the building-model level to reality
    return { key: k, elec, heat, tmin, tmax, partial: rows.length < 20,
      label: k === todayKey ? 'heute' : ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()] };
  });
}

function renderHpForecast() {
  const card = $('hp-fc-card'); if (!card) return;
  const w = STATE.weather;
  if (!w || !Array.isArray(w.hourly) || !w.hourly.length) {
    $('hp-fc-kpi').innerHTML = ''; $('hp-fc-chart').innerHTML = ''; $('hp-fc-legend').innerHTML = '';
    return;
  }
  const days = hpForecastDays(w), price = STATE.price;
  if (!days.length) return;
  const tom = days.find(d => d.label !== 'heute') || days[0];
  $('hp-fc-kpi').innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v">${kwh(tom.elec, 1)}</div><div class="l">WP-Strom ${esc(tom.label)} · ${money(tom.elec * price)}</div></div>` +
    `<div class="kpi sm"><div class="v">${fmt(tom.tmin, 0)}…${fmt(tom.tmax, 0)}°C</div><div class="l">Außentemperatur ${esc(tom.label)}</div></div></div>`;
  $('hp-fc-chart').innerHTML = groupedBar(
    days.map(d => ({ label: d.label, values: { e: d.elec, h: d.heat } })),
    [{ key: 'e', color: COL.hp }, { key: 'h', color: COL.heat }], { h: 180 });
  $('hp-fc-legend').innerHTML =
    `<div class="it"><span class="sw" style="background:${COL.hp}"></span>Strom (kWh)</div>` +
    `<div class="it"><span class="sw" style="background:${COL.heat}"></span>Wärme (kWh)</div>`;
  const total = days.reduce((a, d) => a + d.elec, 0);
  const calNote = (hpAnnualReal() || hpYearFromMonthly())
    ? ' <b>auf deinen echten Messwert kalibriert</b> (Wetter gibt den Tagesverlauf, dein gemessenes WP-Niveau die Höhe)'
    : ' (Gebäudemodell, noch ohne Messwert-Kalibrierung)';
  $('hp-fc-note').innerHTML = `Quelle: <b>Open-Meteo</b>${w.tz === 'demo' ? ' <span style="color:var(--muted)">(Demo)</span>' : ''}. ` +
    `Summe der ${days.length} Tage: <b>${kwh(total, 0)}</b> (~${money(total * price)}).` + calNote + '.';
}

async function doHpWeather() {
  const note = $('hp-fc-note'), btn = $('hp-fc-btn');
  const loc = getLatLon();
  if (!loc) { note.innerHTML = 'Bitte zuerst im <b>PV</b>-Tab deinen Standort eintragen („📍 Mein Standort").'; return; }
  btn.disabled = true; note.textContent = 'Frage Wetter-Vorhersage …';
  try {
    const r = await api(`/api/weather?lat=${loc.lat}&lon=${loc.lon}`);
    if (!r || r.ok === false || !Array.isArray(r.hourly) || !r.hourly.length) {
      note.textContent = '⚠︎ ' + ((r && r.error) || 'Wetter-Abruf fehlgeschlagen.'); btn.disabled = false; return;
    }
    STATE.weather = r; renderHpForecast();
    if (typeof renderSmart === 'function') renderSmart();
  } catch (e) { note.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  btn.disabled = false;
}

async function doWeather() {
  const note = $('pv-weather-note'), btn = $('pv-weather');
  const lat = parseFloat($('pv-lat').value), lon = parseFloat($('pv-lon').value);
  if (!isFinite(lat) || !isFinite(lon)) {
    note.innerHTML = 'Bitte oben bei <b>PVGIS</b> Breiten- und Längengrad eintragen (oder „📍 Mein Standort").'; return;
  }
  btn.disabled = true; note.textContent = 'Frage Wetter-Vorhersage für deinen Standort …';
  try {
    const r = await api(`/api/weather?lat=${lat}&lon=${lon}`);
    if (!r || r.ok === false || !Array.isArray(r.hourly) || !r.hourly.length) {
      note.textContent = '⚠︎ ' + ((r && r.error) || 'Wetter-Abruf fehlgeschlagen.'); btn.disabled = false; return;
    }
    STATE.weather = r;
    renderWeather(r);
    if (typeof renderHpForecast === 'function') renderHpForecast();
    if (typeof renderSmart === 'function') renderSmart();
    note.innerHTML = 'Quelle: <b>Open-Meteo</b>' + (r.demo ? ' <span style="color:var(--muted)">(Demo)</span>' : '') +
      '. Grobe Schätzung – reale Werte hängen von Wetter, Dach und Anlage ab.';
  } catch (e) { note.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  btn.disabled = false;
}

// Turn an hourly forecast row into expected PV (kWh) and heat-pump power (kWh).
function forecastHour(h, ctx) {
  const pv = ctx.kwp > 0 ? ctx.kwp * (Math.max(0, h.ghi) / 1000) * ctx.PR : 0;
  let hp = ctx.dhwElec;                          // constant warm-water baseload
  if (h.temp != null)
    hp += ctx.ua * Math.max(0, ctx.tIndoor - h.temp) / 1000 * (1 - ctx.gain) / ctx.copHeat;
  return { pv, hp };
}

function renderWeather(r) {
  const b = buildData();
  const ctx = {
    kwp: Math.max(0, parseFloat($('pv-kwp').value) || 0),
    PR: 0.85, ua: buildUA(b), tIndoor: 20, gain: b.gain,
    copHeat: b.cop_heat || 2.6, dhwElec: (b.dhw / (b.cop_dhw || 2.7)) / 8760,
  };
  // group forecast rows into local calendar days
  const dayMap = new Map();
  r.hourly.forEach(h => {
    const d = new Date(h.ts * 1000);
    const key = d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(h);
  });
  const now = new Date();
  const todayKey = now.getFullYear() * 10000 + now.getMonth() * 100 + now.getDate();
  const keys = [...dayMap.keys()].sort((a, z) => a - z);
  // "tomorrow" = first day after today with a (near) full set of hours, else the fullest day
  let pick = keys.find(k => k > todayKey && dayMap.get(k).length >= 20);
  if (pick == null) pick = keys.filter(k => k > todayKey)[0];
  if (pick == null) pick = keys.reduce((best, k) => dayMap.get(k).length > dayMap.get(best).length ? k : best, keys[0]);
  const rows = (dayMap.get(pick) || []).slice().sort((a, z) => a.ts - z.ts);

  // per-day totals for the summary of every available day
  const dayTotals = keys.map(k => {
    let pv = 0, hp = 0;
    dayMap.get(k).forEach(h => { const f = forecastHour(h, ctx); pv += f.pv; hp += f.hp; });
    const d = new Date(dayMap.get(k)[0].ts * 1000);
    return { k, pv, hp, label: k === todayKey ? 'heute' : ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][d.getDay()] };
  });

  // the picked day, hour by hour
  const barRows = [], hourF = [];
  rows.forEach(h => {
    const f = forecastHour(h, ctx); hourF.push({ h, f });
    barRows.push({ label: String(new Date(h.ts * 1000).getHours()), values: { pv: f.pv, hp: f.hp } });
  });
  const pvDay = hourF.reduce((a, x) => a + x.f.pv, 0);
  const hpDay = hourF.reduce((a, x) => a + x.f.hp, 0);
  const cover = hpDay > 0 ? Math.min(1, hourF.reduce((a, x) => a + Math.min(x.f.pv, x.f.hp), 0) / hpDay) : null;
  const pickDate = new Date(rows[0].ts * 1000);
  const dayName = pick === todayKey ? 'heute' : (pick === todayKey + 1 || (keys.indexOf(pick) >= 0)) ?
    ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'][pickDate.getDay()] : 'morgen';

  $('pv-weather-kpi').innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v">${kwh(pvDay, 1)}</div><div class="l">PV-Ertrag ${esc(dayName)}</div></div>` +
    `<div class="kpi sm"><div class="v">${kwh(hpDay, 1)}</div><div class="l">WP-Strombedarf ${esc(dayName)}</div></div></div>` +
    `<div class="grid2" style="margin-top:8px"><div class="kpi sm"><div class="v">${cover == null ? '–' : fmt(cover * 100, 0) + ' %'}</div><div class="l">PV deckt WP</div></div>` +
    `<div class="kpi sm"><div class="v">${Math.round(Math.max(...rows.map(h => h.temp == null ? -99 : h.temp)))}°C</div><div class="l">Höchsttemperatur</div></div></div>`;

  $('pv-weather-chart').innerHTML =
    `<div class="note" style="margin:2px 0 6px"><b>${esc(dayName)}</b> · stündlich (0–23 Uhr)</div>` +
    groupedBar(barRows, [{ key: 'pv', color: COL.heat }, { key: 'hp', color: COL.hp }], { h: 190 });
  $('pv-weather-legend').innerHTML =
    `<div class="it"><span class="sw" style="background:${COL.heat}"></span>PV-Ertrag (kWh/h)</div>` +
    `<div class="it"><span class="sw" style="background:${COL.hp}"></span>WP-Strombedarf (kWh/h)</div>`;

  // best PV hours to run flexible loads
  const best = hourF.filter(x => x.f.pv > 0.05).sort((a, z) => z.f.pv - a.f.pv).slice(0, 3)
    .map(x => new Date(x.h.ts * 1000).getHours()).sort((a, z) => a - z);
  const outlook = dayTotals.map(d => `${d.label}: ☀️ ${fmt(d.pv, 0)}·🔥 ${fmt(d.hp, 0)} kWh`).join('   ');
  let msg = '';
  if (pvDay > hpDay && hpDay > 0) msg = `☀️ <b>Überschuss-Tag:</b> die PV deckt den Wärmepumpen-Strom voraussichtlich vollständig.`;
  else if (cover != null && cover < 0.3) msg = `🔥 <b>Wenig Sonne / kalt:</b> die Wärmepumpe zieht ${esc(dayName)} überwiegend Netzstrom.`;
  else msg = `Teils Sonne: flexible Lasten am besten in die Mittagsstunden legen.`;
  $('pv-weather-best').innerHTML = msg +
    (best.length ? `<br>Beste PV-Stunden ${esc(dayName)}: <b>${best.map(h => h + '–' + (h + 1) + ' Uhr').join(', ')}</b> – ideal für Waschen/Laden.` : '') +
    `<br><span style="color:var(--muted)">Ausblick: ${outlook}</span>`;
}

function doPvSuggest() {
  const note = $('pv-suggest-note');
  const evAnnual = (Math.max(0, parseFloat($('pv-ev-km').value) || 0) * Math.max(0, parseFloat($('pv-ev-kwh').value) || 18)) / 100;
  const acAnnual = Math.max(0, parseFloat($('pv-ac').value) || 0);
  const annualLoad = shAvgDaily() * 365 + hpAvgDaily() * 365 + evAnnual + acAnnual;
  if (annualLoad <= 0) { note.textContent = 'Noch zu wenig Verbrauchsdaten für einen Vorschlag.'; return; }
  const spec = parseFloat($('pv-orient').value) || 1000;
  const dailyLoad = annualLoad / 365;
  const round5 = v => Math.max(0, Math.round(v * 2) / 2);
  // size PV so annual yield ≈ annual consumption; battery ≈ half a day's load (capped)
  const kwp = Math.min(30, Math.max(1, round5(annualLoad / spec)));
  const batt = Math.min(20, round5(Math.min(dailyLoad * 0.55, kwp * 1.3)));
  $('pv-kwp').value = kwp; $('pv-batt').value = batt;
  try { localStorage.setItem(PV_LS.kwp, String(kwp)); localStorage.setItem(PV_LS.batt, String(batt)); } catch (e) {}
  renderPv();
  const r = simulatePv(pvInputs());
  note.innerHTML = `Vorschlag: <b>${fmt(kwp, 1)} kWp</b> + <b>${fmt(batt, 1)} kWh</b> Speicher ` +
    `(Jahresverbrauch ~${kwh(annualLoad, 0)}). Ergebnis: Autarkie ${fmt(r.autarky * 100, 0)} %, ` +
    `Eigenverbrauch ${fmt(r.self_rate * 100, 0)} %. Werte sind ein Startpunkt – frei anpassbar.`;
}

// Parse a HomeCom "EnergyData" CSV export (German ; / , format, 3 header rows,
// Tag/Monat/Stunde categories). Robust: identifies columns from the headers.
function parseHomeComCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  const split = l => l.split(';');
  const norm = s => (s || '').toLowerCase().trim();
  const hi = lines.findIndex(l => norm(split(l)[0]) === 'kategorie');
  if (hi < 0) return { error: 'Kopfzeile „Kategorie" nicht gefunden – ist das ein HomeCom-Export?' };
  const r0 = hi >= 2 ? split(lines[hi - 2]) : [];
  const r1 = hi >= 1 ? split(lines[hi - 1]) : [];
  const r2 = split(lines[hi]);
  const key = i => norm(r0[i]) + '|' + norm(r2[i]) + '|' + norm(r1[i]); // group|source|sub
  const find = (parts) => {
    for (let i = 0; i < r2.length; i++) { const k = key(i); if (parts.every(p => k.includes(p))) return i; }
    return -1;
  };
  const idx = {
    elecWP: find(['verbrauchteenergie', 'wärmepumpe', 'gesamt']),
    elecEH: find(['verbrauchteenergie', 'elektrischerzuheizer', 'gesamt']),
    prodWP: find(['produziertewärme', 'wärmepumpe', 'gesamt']),
    prodUmg: find(['produziertewärme', 'umgebung', 'gesamt']),
    heatWP: find(['verbrauchteenergie', 'wärmepumpe', 'heizung']),
    heatEH: find(['verbrauchteenergie', 'elektrischerzuheizer', 'heizung']),
    prodHeatWP: find(['produziertewärme', 'wärmepumpe', 'heizung']),
    prodHeatUmg: find(['produziertewärme', 'umgebung', 'heizung']),
    waterWP: find(['verbrauchteenergie', 'wärmepumpe', 'warmwasser']),
    waterEH: find(['verbrauchteenergie', 'elektrischerzuheizer', 'warmwasser']),
    outdoor: r2.findIndex(c => norm(c).includes('temperatur') && norm(c).includes('aussen') || norm(c).includes('außentemperatur')),
    supply: r2.findIndex(c => norm(c).includes('vorlauftemperatur')),
    watert: r2.findIndex(c => norm(c).includes('warmwassertemperatur')),
  };
  if (idx.elecWP < 0) return { error: 'Spalte „Verbrauchte Energie · Wärmepumpe · Gesamt" nicht gefunden.' };
  const num = s => { s = (s || '').trim(); if (!s || s === '-') return null; const n = parseFloat(s.replace(/\./g, '').replace(',', '.')); return isNaN(n) ? null : n; };
  const add = (a, b) => (a == null && b == null) ? null : (a || 0) + (b || 0);
  const at = (c, i) => i >= 0 ? num(c[i]) : null;
  const rows = [];
  for (let li = hi + 1; li < lines.length; li++) {
    const c = split(lines[li]); const cat = norm(c[0]);
    const period = cat === 'tag' ? 'day' : cat === 'monat' ? 'month' : cat === 'stunde' ? 'hour' : null;
    if (!period) continue;
    const date = (c[1] || '').trim().slice(0, period === 'month' ? 7 : period === 'hour' ? 16 : 10);
    if (!/^\d{4}-\d{2}/.test(date)) continue;
    const elec = add(at(c, idx.elecWP), at(c, idx.elecEH));
    const heat = add(at(c, idx.prodWP), at(c, idx.prodUmg));
    if (elec == null && heat == null) continue;
    rows.push({
      period, date, elec_kwh: elec, heat_kwh: heat,
      heating_kwh: add(at(c, idx.heatWP), at(c, idx.heatEH)),
      water_kwh: add(at(c, idx.waterWP), at(c, idx.waterEH)),
      heat_heating_kwh: add(at(c, idx.prodHeatWP), at(c, idx.prodHeatUmg)),  // produced space heat
      outdoor_c: at(c, idx.outdoor),
      supply_c: at(c, idx.supply),       // Vorlauftemperatur (for the heating curve)
      water_c: at(c, idx.watert),        // Warmwassertemperatur (for the time-series)
    });
  }
  return { rows };
}

async function doHpRefresh() {
  const note = $('hp-refresh-note'), btn = $('hp-refresh');
  if (btn) btn.disabled = true;
  if (note) note.textContent = 'Lese aktuellen Zählerstand …';
  try {
    const r = await postJSON('/api/homecom/refresh', {});
    if (r && r.ok) {
      if (note) note.innerHTML = '✓ ' + escIp(r.message || 'Nachgeladen.');
      setTimeout(loadAll, 600);
    } else if (note) {
      note.innerHTML = '⚠︎ ' + escIp((r && r.error) || 'Konnte nicht nachladen.');
    }
  } catch (e) {
    if (note) note.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.';
  } finally {
    if (btn) btn.disabled = false;
  }
}
async function doHpImport(ev) {
  const note = $('hp-import-note'), inp = ev.target;
  const file = inp.files && inp.files[0];
  if (!file) return;
  note.textContent = 'Lese Datei …';
  try {
    const text = await file.text();
    const res = parseHomeComCsv(text);
    if (res.error) { note.innerHTML = '⚠︎ ' + esc(res.error); inp.value = ''; return; }
    if (!res.rows.length) { note.textContent = 'Keine Datenzeilen gefunden.'; inp.value = ''; return; }
    note.textContent = `Sende ${res.rows.length} Zeilen an die Bridge …`;
    const r = await postJSON('/api/homecom/import', { rows: res.rows });
    if (r.ok) {
      note.innerHTML = '✅ ' + escIp(r.message) + ` Gesamt: <b>${r.total_days}</b> Tage, <b>${r.total_months}</b> Monate` +
        (r.total_hours ? `, <b>${r.total_hours}</b> Stunden` : '') + '.';
      setTimeout(loadAll, 800);
    } else note.innerHTML = '⚠︎ ' + escIp(r.error || 'Import fehlgeschlagen.');
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
  inp.value = '';
}

async function doHpImportClear() {
  const note = $('hp-import-clear-note');
  if (!window.confirm('Importierte HomeCom-Historie (CSV) wirklich löschen?\n\nDeine laufenden Live-Messungen der Bridge bleiben erhalten – nur die hochgeladenen CSV-Daten (z. B. die alte Bauphasen-Historie) werden entfernt.')) return;
  note.textContent = 'Lösche importierte Historie …';
  try {
    const r = await postJSON('/api/homecom/import/clear', {});
    if (r.ok) { note.innerHTML = '✅ ' + escIp(r.message || 'Importierte Historie gelöscht.'); setTimeout(loadAll, 800); }
    else note.innerHTML = '⚠︎ ' + escIp(r.error || 'Löschen fehlgeschlagen.');
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
}

async function doExport() {
  const note = $('export-note');
  const days = ($('export-days') && $('export-days').value) || '365';
  const url = (STATE.base || '') + `/api/export.csv?days=${encodeURIComponent(days)}&price=${STATE.price}`;
  note.textContent = 'Erzeuge CSV …';
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const cd = r.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const name = (m && m[1]) || `energie_${new Date().toISOString().slice(0, 10)}.csv`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    const lines = (await blob.text()).split('\n').filter(Boolean).length - 1;
    note.innerHTML = `✅ <b>${name}</b> geladen (${Math.max(0, lines)} Tage).`;
  } catch (e) {
    note.innerHTML = '⚠︎ Export nur möglich, wenn die Seite von der <b>Bridge</b> geladen ist (' + escIp(e.message) + ').';
  }
}

// Shared core: triggers `git pull` + restart ON THE COMPUTER that runs the
// bridge, from any device (incl. iPhone). Used by the Setup button and the
// "update available" banner. `btns` are disabled while restarting.
async function bridgeUpdate(note, btns) {
  btns = (btns || []).filter(Boolean);
  btns.forEach(b => b.disabled = true);
  if (note) note.textContent = 'Hole neuesten Code & starte die Bridge neu …';
  try {
    const r = await postJSON('/api/update', {});
    if (r.ok && r.changed) {
      if (note) note.innerHTML = '✅ ' + escIp(r.message);
      setTimeout(hardRefresh, 6000);   // bridge re-execs → reload fresh code
      return;                          // keep buttons disabled while restarting
    } else if (r.ok) {
      if (note) note.innerHTML = 'ℹ️ ' + escIp(r.message || 'Bereits aktuell.');
      const b = $('update-banner'); if (b) b.hidden = true;   // nothing to do
    } else {
      if (note) note.innerHTML = '⚠︎ ' + escIp(r.error || 'Update fehlgeschlagen.') +
        (r.output ? `<br><small>${esc(r.output)}</small>` : '');
    }
  } catch (e) {
    if (note) note.textContent = 'Fehler: ' + e.message + ' – geht nur, wenn die Seite von der Bridge geöffnet ist.';
  }
  btns.forEach(b => b.disabled = false);
}
function doBridgeUpdate() { return bridgeUpdate($('bridge-update-note'), [$('bridge-update')]); }

// Ask the bridge whether newer code is on the git remote; show the banner if so.
async function checkUpdate(force) {
  if (STATE.demo) return;
  const banner = $('update-banner'); if (!banner) return;
  try {
    const r = await api('/api/update/check' + (force ? '?force=1' : ''));
    if (r && r.git && r.behind > 0) {
      const info = $('update-banner-info');
      if (info) info.textContent = ` · ${r.behind} Änderung${r.behind === 1 ? '' : 'en'}`
        + (r.latest ? ` · „${r.latest}"` : '');
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  } catch (e) { /* offline / not served by the bridge → stay quiet */ }
}

async function doDiscover() {
  const note = $('discover-note');
  note.textContent = 'Suche Controller im Netzwerk … (kann ein paar Sekunden dauern)';
  try {
    const r = await api('/api/discover');
    if (r.suggested) {
      $('shc-ip').value = r.suggested;
      note.innerHTML = `Gefunden: ${r.candidates.map(ipTag).join(', ')} – oben übernommen. Passt das nicht, IP manuell eintragen.`;
    } else {
      note.innerHTML = 'Nichts gefunden im Netz der Bridge. IP bitte manuell eintragen.';
    }
  } catch (e) { note.textContent = 'Automatische Suche geht nur, wenn die Seite von der Bridge geöffnet ist.'; }
}

async function doPair() {
  const note = $('pair-note'), btn = $('pair-btn');
  const ip = $('shc-ip').value.trim(), pw = $('shc-pw').value;
  if (!ip || !pw) { note.textContent = 'Bitte IP-Adresse und Systempasswort eingeben.'; return; }
  btn.disabled = true;
  note.textContent = 'Koppeln … hast du gerade kurz den Knopf am Controller II gedrückt?';
  try {
    const r = await postJSON('/api/pair', {
      ip, password: pw,
      price_per_kwh: parseFloat($('shc-price').value) || 0.35,
      poll_interval: parseInt($('shc-interval').value, 10) || 30,
    });
    if (r.ok) {
      note.innerHTML = '✅ ' + escIp(r.message || 'Erfolgreich gekoppelt.');
      STATE.demo = false; localStorage.setItem(LS.demo, '0');
      setTimeout(loadAll, 1400);
    } else {
      note.innerHTML = '⚠︎ ' + escIp(r.error || 'Kopplung fehlgeschlagen.') + (r.detail ? '<br><small>' + escIp(r.detail) + '</small>' : '');
    }
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – ist die Seite von der Bridge geöffnet?'; }
  btn.disabled = false;
}

/* Wärme-Tab in sinnvolle Cluster aufgeteilt (Unter-Tabs). Karten werden per
 * data-hs einem Cluster zugeordnet; CSS blendet die nicht-aktiven aus. Alle
 * Renders laufen beim Öffnen des Tabs weiter – die Unter-Tabs sind nur Ansicht. */
const HEAT_SUBS = ['heizung', 'abgleich', 'effizienz', 'einstellung'];
const HEAT_SUB_MAP = {
  'ab-card': 'abgleich', 'abr-card': 'abgleich', 'abd-card': 'abgleich',
  'hp-card': 'heizung', 'hpd-card': 'heizung', 'hpc-card': 'heizung', 'hd-card': 'heizung', 'roomtemp-card': 'heizung', 'hts-card': 'heizung', 'rts-card': 'heizung', 'win-card': 'heizung',
  'hpt-card': 'effizienz',
  'dhw-card': 'abgleich',
  'opt-card': 'abgleich', 'layout-card': 'abgleich',
  'hc-card': 'einstellung', 'hpctl-card': 'einstellung', 'roomsync-card': 'einstellung',
  // everything else in the Wärme view (COP/stats/theory charts) → Effizienz
};
function assignHeatSubs() {
  const sec = document.getElementById('v-heatpump'); if (!sec) return;
  [...sec.children].forEach(el => {
    if (!el.classList || !el.classList.contains('card')) return;
    el.dataset.hs = HEAT_SUB_MAP[el.id] || 'effizienz';
  });
}
// Which renders belong to which Wärme sub-tab, so we only fetch the cards the
// user is actually looking at (opening the whole tab used to fire ~20 heavy API
// calls at once → slow). Each sub-tab loads lazily the first time it's shown.
const HEAT_SUB_RENDER = {
  heizung: ['renderHpDay', 'renderHeatingDiag', 'renderRoomTemps', 'renderHeatTimeseries', 'renderRoomTs', 'renderWindows', 'renderHpCompare'],
  abgleich: ['renderAbgleich', 'renderLayout', 'renderDhwImpact'],
  effizienz: ['renderHpTrend'],
  einstellung: ['renderHeatingCurve', 'initHpControls', 'renderRoomSync'],
};
function renderHeatSub(sub) {
  (HEAT_SUB_RENDER[sub] || []).forEach(name => {
    const fn = window[name];
    if (typeof fn === 'function') { try { fn(false); } catch (e) {} }
  });
}
function setHeatSub(sub) {
  if (HEAT_SUBS.indexOf(sub) < 0) sub = 'heizung';
  const sec = document.getElementById('v-heatpump'); if (!sec) return;
  HEAT_SUBS.forEach(s => sec.classList.toggle('hsa-' + s, s === sub));
  document.querySelectorAll('#heat-subnav button').forEach(b => b.classList.toggle('on', b.dataset.hs === sub));
  try { localStorage.setItem('bhe_heat_sub', sub); } catch (e) {}
  try { window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' }); } catch (e) {}
  // render this sub-tab's cards only while the Wärme view is actually visible
  if (sec.classList.contains('on')) renderHeatSub(sub);
}
function switchView(v) {
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  flushView(v);                         // draw what arrived while this tab was hidden
  if (v === 'settings' && typeof renderPerf === 'function') renderPerf();
  // lazily load ONLY the active Wärme sub-tab when the tab is opened
  if (v === 'heatpump') {
    let sub = 'heizung'; try { sub = localStorage.getItem('bhe_heat_sub') || 'heizung'; } catch (e) {}
    setHeatSub(sub);
  }
}

function init() {
  $('base').value = STATE.base;
  $('price').value = STATE.price;
  // keep the sticky time-range bar aligned right below the header
  const setHdrH = () => {
    const h = document.querySelector('header');
    if (h) document.documentElement.style.setProperty('--hdr-h', h.offsetHeight + 'px');
  };
  setHdrH();
  window.addEventListener('resize', setHdrH);
  window.addEventListener('orientationchange', () => setTimeout(setHdrH, 200));

  document.querySelectorAll('#nav button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.v)));
  // Wärme sub-tabs: assign cards to clusters, wire the bar, restore last choice
  assignHeatSubs();
  document.querySelectorAll('#heat-subnav button').forEach(b => b.addEventListener('click', () => setHeatSub(b.dataset.hs)));
  setHeatSub((() => { try { return localStorage.getItem('bhe_heat_sub') || 'heizung'; } catch (e) { return 'heizung'; } })());
  document.addEventListener('click', e => {
    const i = e.target.closest('.info');
    if (i) { e.stopPropagation(); showInfo(i.dataset.info); return; }
    const rb = e.target.closest('.ratebadge');
    if (rb) { e.stopPropagation(); showRate(rb.dataset.rk, rb.dataset.rv === '' ? null : rb.dataset.rv, rb.dataset.rl); return; }
    const gl = e.target.closest('.gloss');
    if (gl) { e.stopPropagation(); showGloss(gl.dataset.g); return; }
    const pp = e.target.closest('.pp-prio');
    if (pp) { e.stopPropagation(); ppSetPrio(pp.dataset.pp, pp.getAttribute('aria-pressed') !== 'true'); return; }
    const hpt = e.target.closest('.hpd-t');
    if (hpt) { e.stopPropagation(); hpdToggle(hpt.dataset.hpt); return; }
    const hpr = e.target.closest('.hpd-rt');
    if (hpr) { e.stopPropagation(); hpdRoomToggle(hpr.dataset.hpr); return; }
    const t = $('toast'); if (t && !t.hidden) t.hidden = true;
  });
  $('hist-range').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    STATE.histSel = b.dataset.d;
    document.querySelectorAll('#hist-range button').forEach(x => x.classList.toggle('on', x === b));
    const cust = $('hist-custom'); if (cust) cust.hidden = (STATE.histSel !== 'custom');
    const dayNav = $('hist-day'); if (dayNav) dayNav.hidden = (STATE.histSel !== 'day');
    if (STATE.histSel === 'day') {
      if (!STATE.histDay) { const n = new Date(); STATE.histDay = new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
      updateHistDayNav();
    }
    if (STATE.histSel === 'custom') {
      const now = new Date();
      if (!$('hist-to').value) $('hist-to').value = localKey(now);
      if (!$('hist-from').value) $('hist-from').value = localKey(new Date(now.getTime() - 29 * 86400000));
    }
    renderHistory();
  });
  { const pv = $('hist-day-prev'), nx = $('hist-day-next');
    if (pv) pv.addEventListener('click', () => histDayShift(-1));
    if (nx) nx.addEventListener('click', () => histDayShift(1)); }
  ['hist-from', 'hist-to'].forEach(id => { const el = $(id); if (el) el.addEventListener('change', renderHistory); });
  // heating-curve measurement window: Heute / Gestern / 7·14·30 T / Gesamt
  const hcr = $('hc-range');
  if (hcr) {
    hcr.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      _hcRange = b.dataset.hcr;
      try { localStorage.setItem('bhe_hc_range', _hcRange); } catch (err) {}
      hcr.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderHeatingCurve(true);
    });
    // reflect the stored range on the buttons
    const cur = hcRange();
    hcr.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.hcr === cur));
  }
  // standby card: measurement window + detection threshold
  const sbd = $('pf-sb-days');
  if (sbd) {
    sbd.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      _sbDays = parseInt(b.dataset.sbd, 10);
      try { localStorage.setItem('bhe_sb_days', String(_sbDays)); } catch (err) {}
      sbd.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderStandby(true);
    });
    sbd.querySelectorAll('button').forEach(x => x.classList.toggle('on', parseInt(x.dataset.sbd, 10) === sbDays()));
  }
  const sbt = $('pf-sb-thr');
  if (sbt) {
    sbt.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      _sbThresh = parseFloat(b.dataset.sbt);
      try { localStorage.setItem('bhe_sb_thresh', String(_sbThresh)); } catch (err) {}
      sbt.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderStandby(false);     // threshold is a client-side filter; no refetch needed
    });
    sbt.querySelectorAll('button').forEach(x => x.classList.toggle('on', parseFloat(x.dataset.sbt) === sbThresh()));
  }
  // device-consumption timeline: resolution + device picker + window
  const dtDev = $('pf-devtl-dev');
  if (dtDev) dtDev.addEventListener('change', () => {
    _devtlSel = dtDev.value; try { localStorage.setItem('bhe_devtl_sel', _devtlSel); } catch (e) {}
    paintDeviceTimeline();
  });
  const dtRes = $('pf-devtl-res');
  if (dtRes) dtRes.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    _devtlRes = b.dataset.dtr; try { localStorage.setItem('bhe_devtl_res', _devtlRes); } catch (err) {}
    dtRes.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderDeviceTimeline();     // rebuild the window seg for this resolution, then paint
  });
  const dtWin = $('pf-devtl-win');
  if (dtWin) dtWin.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    setDevtlWin(parseFloat(b.dataset.dtw));
    dtWin.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    paintDeviceTimeline();
  });
  // load-peaks window
  const lpd = $('pf-lp-days');
  if (lpd) {
    lpd.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      _lpDays = parseInt(b.dataset.lpd, 10); try { localStorage.setItem('bhe_lp_days', String(_lpDays)); } catch (err) {}
      lpd.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderLoadPeaks();
    });
    lpd.querySelectorAll('button').forEach(x => x.classList.toggle('on', parseInt(x.dataset.lpd, 10) === lpDays()));
  }
  const hpp = $('hpd-prev'); if (hpp) hpp.addEventListener('click', () => hpdShift(-1));
  const hpn = $('hpd-next'); if (hpn) hpn.addEventListener('click', () => hpdShift(1));
  const hsp = $('hpd-span');
  if (hsp) hsp.addEventListener('click', e => { const b = e.target.closest('button'); if (b) hpdSetSpan(b.dataset.hsp); });
  ['hpc-a', 'hpc-b'].forEach(id => { const el = $(id); if (el) el.addEventListener('change', () => renderHpCompare()); });
  const htd = $('hpt-days');
  if (htd) htd.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    _hptDays = parseInt(b.dataset.htd, 10); try { localStorage.setItem('bhe_hpt_days', String(_hptDays)); } catch (err) {}
    htd.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderHpTrend();
  });
  if (htd) htd.querySelectorAll('button').forEach(x => x.classList.toggle('on', parseInt(x.dataset.htd, 10) === hptDays()));
  const htm = $('hpt-mark');
  if (htm) htm.addEventListener('change', () => { try { htm.value ? localStorage.setItem('bhe_hp_abgleich', htm.value) : localStorage.removeItem('bhe_hp_abgleich'); } catch (e) {} const d = hptDays(); if (_hptData[d]) paintHpTrend(_hptData[d]); });
  const htmc = $('hpt-mark-clear');
  if (htmc) htmc.addEventListener('click', () => { try { localStorage.removeItem('bhe_hp_abgleich'); } catch (e) {} if ($('hpt-mark')) $('hpt-mark').value = ''; const d = hptDays(); if (_hptData[d]) paintHpTrend(_hptData[d]); });
  const dwd = $('dhw-days');
  if (dwd) {
    dwd.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      _dwDays = parseInt(b.dataset.dwd, 10); try { localStorage.setItem('bhe_dw_days', String(_dwDays)); } catch (err) {}
      dwd.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderDhwImpact();
    });
    dwd.querySelectorAll('button').forEach(x => x.classList.toggle('on', parseInt(x.dataset.dwd, 10) === dwDays()));
  }
  // tap/hover a day (or month) bar to read its exact values
  const hd = $('h-daily');
  if (hd) {
    const onH = e => {
      const hit = e.target.closest && e.target.closest('.dhit'); if (!hit || !_histHit) return;
      const svgEl = hit.querySelector('svg'); if (!svgEl) return;
      const rect = svgEl.getBoundingClientRect();
      const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
      const fx = Math.min(1, Math.max(0, (cx - rect.left) / (rect.width || 1)));
      const rows = _histHit.rows, n = rows.length, pad = 26, bw = (CW - pad * 2) / Math.max(1, n);
      let i = Math.floor((fx * CW - pad) / bw); i = Math.min(n - 1, Math.max(0, i));
      const r = rows[i]; if (!r) return;
      const t = $('toast');
      if (t) {
        t.innerHTML = `<b>${esc(r.tip)}</b> · 🏠 <b>${kwh(r.sh, 1)}</b> · 🔥 <b>${kwh(r.hp, 1)}</b>` +
          `<div class="note" style="margin-top:2px;color:var(--muted)">Σ <b>${kwh(r.total, 1)}</b>${_histHit.mode === 'month' ? '/Monat' : '/Tag'} · ` +
          `${money(r.total * STATE.price)}${r.estimated ? ' · <i>geschätzt</i>' : ''}</div>`;
        t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 5000);
      }
      e.stopPropagation();
    };
    hd.addEventListener('pointermove', onH);
    hd.addEventListener('pointerdown', onH);
  }
  const hm = $('hp-heat-month'); if (hm) hm.addEventListener('change', renderHeatpump);
  // Theorie/Gemessen/Erwartet series toggles (persisted)
  [['thm-t', 'bhe_thm_t'], ['thm-p', 'bhe_thm_p'], ['thm-e', 'bhe_thm_e']].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const s = localStorage.getItem(key); if (s !== null) el.checked = s === '1';
    el.addEventListener('change', () => { try { localStorage.setItem(key, el.checked ? '1' : '0'); } catch (e) {} renderHeatDemand(); });
  });
  // tap/hover a month to read the kWh of each bar (Theorie/Gemessen/Erwartet)
  const tm = $('hp-theory-month');
  if (tm) {
    const onTm = e => {
      const hit = e.target.closest && e.target.closest('.tmhit'); if (!hit || !_thmHit) return;
      const svgEl = hit.querySelector('svg'); if (!svgEl) return;
      const rect = svgEl.getBoundingClientRect();
      const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
      const fx = Math.min(1, Math.max(0, (cx - rect.left) / (rect.width || 1)));
      const pad = 26, n = 12, gw = (CW - pad * 2) / n;
      let i = Math.floor((fx * CW - pad) / gw); i = Math.min(n - 1, Math.max(0, i));
      const r = _thmHit.rows[i]; if (!r) return;
      const t = $('toast');
      if (t) {
        const parts = _thmHit.series.map(s => {
          const mInfo = s.key === 'p' && _thmHit.meas ? _thmHit.meas[i] : null;
          const mark = mInfo && (mInfo.projected || mInfo.partial) ? ' <span style="color:var(--muted)">(hochger.)</span>' : '';
          return `<span style="color:${s.color}">●</span> ${esc(s.label)} <b>${kwh(r.values[s.key] || 0, 0)}</b>${mark}`;
        });
        t.innerHTML = `<b>${esc(r.label)}</b><div class="note" style="margin-top:2px">${parts.join(' · ')}</div>`;
        t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 5000);
      }
      e.stopPropagation();
    };
    tm.addEventListener('pointermove', onTm);
    tm.addEventListener('pointerdown', onTm);
  }
  // Bauphase-Dämpfung: keep measurements but tame the inflated move-in winter peaks
  (() => {
    const el = $('h-baukorr'); if (!el) return;
    try { el.checked = localStorage.getItem('bhe_hp_damp') === '1'; } catch (e) {}
    el.addEventListener('change', () => {
      try { localStorage.setItem('bhe_hp_damp', el.checked ? '1' : '0'); } catch (e) {}
      renderAll();
    });
  })();
  $('save-base').addEventListener('click', () => {
    STATE.base = $('base').value.trim().replace(/\/+$/, '');
    localStorage.setItem(LS.base, STATE.base);
    localStorage.setItem(LS.demo, '0'); STATE.demo = false;
    $('conn-note').textContent = 'Verbinde …';
    loadAll();
  });
  $('use-demo').addEventListener('click', () => {
    STATE.demo = true; localStorage.setItem(LS.demo, '1');
    $('conn-note').textContent = 'Demo-Modus aktiv.';
    loadAll();
  });
  $('discover').addEventListener('click', doDiscover);
  $('pair-btn').addEventListener('click', doPair);
  const hr = $('hard-refresh'); if (hr) hr.addEventListener('click', hardRefresh);
  const bu = $('bridge-update'); if (bu) bu.addEventListener('click', doBridgeUpdate);
  const bb = $('update-banner-btn');
  if (bb) bb.addEventListener('click', () => bridgeUpdate($('update-banner-note'), [bb, $('bridge-update')]));
  const au = $('auto-update');
  if (au) au.addEventListener('change', async () => {
    const aun = $('auto-update-note'), v = parseInt(au.value, 10) || 0;
    if (aun) aun.textContent = 'Speichere …';
    try {
      const r = await postJSON('/api/config', { auto_update_interval: v });
      if (r && r.ok) { if (STATE.health) STATE.health.auto_update_interval = v; renderSettings(); }
      else if (aun) aun.textContent = 'Konnte nicht gespeichert werden.';
    } catch (e) { if (aun) aun.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  });
  const vn = $('version-note'); if (vn) vn.innerHTML = 'App-Stand: <b>' + APP_VERSION + '</b>';
  const hpl = $('hp-login');
  if (hpl) hpl.addEventListener('click', async () => {
    try { const r = await api('/api/homecom/authurl'); if (r.url) window.open(r.url, '_blank'); }
    catch (e) { $('hp-connect-note').textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  });
  const hpc = $('hp-connect'); if (hpc) hpc.addEventListener('click', doHomecomConnect);
  const hpi = $('hp-import'); if (hpi) hpi.addEventListener('change', doHpImport);
  const hic = $('hp-import-clear'); if (hic) hic.addEventListener('click', doHpImportClear);
  const bau = $('hp-bau-end');
  if (bau) {
    try { const s = localStorage.getItem('bhe_bau_end'); if (s) bau.value = s; } catch (e) {}
    bau.addEventListener('change', () => {
      try { if (bau.value) localStorage.setItem('bhe_bau_end', bau.value); } catch (e) {}
      renderAll();
    });
  }
  const swRef = $('ov-switch-refresh'); if (swRef) swRef.addEventListener('click', () => fetchSwitches(true));
  const swBody = $('ov-switch-body');
  if (swBody) swBody.addEventListener('click', e => {
    const b = e.target.closest('button[data-sw]'); if (!b) return;
    doSwitch(b.dataset.sw, b.dataset.on === '1', b.dataset.nm || 'Gerät');
  });
  // "So nutzt du es" help box – remember open/closed (synced across devices)
  const helpD = $('help-waerme');
  if (helpD) {
    try { helpD.open = localStorage.getItem('bhe_help_waerme') !== '0'; } catch (e) {}
    helpD.addEventListener('toggle', () => {
      try { localStorage.setItem('bhe_help_waerme', helpD.open ? '1' : '0'); } catch (e) {}
    });
  }
  const hpr = $('hp-refresh'); if (hpr) hpr.addEventListener('click', doHpRefresh);
  const hdr = $('hd-refresh'); if (hdr) hdr.addEventListener('click', () => { renderHeatingDiag(true); renderHeatingCurve(true); renderRoomTemps(true); });
  const hdRaw = $('hd-raw-btn');
  if (hdRaw) hdRaw.addEventListener('click', async () => {
    const pre = $('hd-raw'); if (!pre) return;
    pre.hidden = false; pre.textContent = 'Lese Thermostat-Rohdaten …';
    try {
      const r = await api('/api/climate/raw');
      pre.textContent = JSON.stringify(r.devices || r, null, 2);
    } catch (e) { pre.textContent = 'Nur mit laufender Bridge im Live-Modus verfügbar.'; }
  });
  const hdMap = $('hd-map-btn');
  if (hdMap) hdMap.addEventListener('click', () => {
    const box = $('hd-map'); if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) renderContactsMap();
  });
  // Wohn-Dashboard (Kiosk)
  const ok = $('open-kiosk'); if (ok) ok.addEventListener('click', openKiosk);
  const kx = $('kiosk-exit'); if (kx) kx.addEventListener('click', closeKiosk);
  const ka = $('kiosk-away'); if (ka) ka.addEventListener('click', () => {
    _kioskAway = !_kioskAway;
    try { localStorage.setItem('bhe_kiosk_away', _kioskAway ? '1' : '0'); } catch (e) {}
    paintKiosk();
  });
  const kt = $('kiosk-theme'); if (kt) kt.addEventListener('click', () => {
    const next = ($('kiosk') && $('kiosk').getAttribute('data-ktheme') === 'light') ? 'dark' : 'light';
    try { localStorage.setItem('kiosk_theme', next); } catch (e) {}
    applyKioskTheme(next);
  });
  window.addEventListener('hashchange', () => { if (location.hash === '#dash') openKiosk(); });
  if (location.hash === '#dash') setTimeout(openKiosk, 300);
  // device heating-curve points (read off the heat pump), stored locally
  [['hc-p20', 'hc_dev_p20'], ['hc-pm10', 'hc_dev_pm10']].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const s = localStorage.getItem(key); if (s !== null) el.value = s;
    el.addEventListener('input', () => {
      try { el.value === '' ? localStorage.removeItem(key) : localStorage.setItem(key, el.value); } catch (e) {}
      if (_hcData) paintHeatingCurve(_hcData); else renderHcDeviceNote(hcDevice());
    });
  });
  const amA = $('am-arm');
  if (amA) amA.addEventListener('click', () => {
    const sb = parseFloat(($('am-setback') || {}).value) || 4, fl = parseFloat(($('am-floor') || {}).value) || 15;
    if (confirm(`Auto-Messung starten? Die App senkt nachts die Raum-Solltemperaturen um ${sb} K (nie unter ${fl} °C) und schreibt dafür real an deine Bosch-Thermostate. Morgens werden sie automatisch zurückgestellt.`))
      amControl('arm');
  });
  const amD = $('am-disarm'); if (amD) amD.addEventListener('click', () => amControl('disarm'));
  // ---- Abgleich: status card
  const abR = $('ab-refresh'); if (abR) abR.addEventListener('click', () => { renderAbgleich(true); renderOpState(true); });
  const abCard = $('ab-card');
  if (abCard) abCard.addEventListener('click', e => {
    if (e.target.id === 'ab-op-refresh') { e.preventDefault(); e.target.textContent = 'lese …'; renderOpState(true); }
  });
  // ---- Abgleich: room list (expand rows, flow-meter readings, comfort targets)
  const openSetup = () => { const d = $('lay-det'); if (d) { d.open = true; d.scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
  const abrCard = $('abr-card');
  if (abrCard) {
    const updTaco = (el) => {
      const room = el.dataset.room, soll = parseFloat(el.dataset.soll) || 0;
      const raw = (el.value || '').trim().replace(',', '.');
      const ist = raw === '' ? null : parseFloat(raw);
      const valid = ist != null && isFinite(ist) && ist >= 0;
      try { if (!valid) localStorage.removeItem(tacoKey(room)); else localStorage.setItem(tacoKey(room), String(ist)); } catch (e) {}
      const d = tacoDelta(valid ? ist : null, soll, el.dataset.cat);
      const ds = document.getElementById('taco-d-' + el.dataset.idx); if (ds) { ds.textContent = d.txt; ds.style.color = d.col; }
    };
    abrCard.addEventListener('input', e => { const el = e.target.closest && e.target.closest('.taco-in'); if (el) updTaco(el); });
    abrCard.addEventListener('change', async e => {
      const taco = e.target.closest && e.target.closest('.taco-in');
      if (taco) { updTaco(taco); if (typeof _flushSettingsNow === 'function') _flushSettingsNow(); return; }
      const tgt = e.target.closest && e.target.closest('.tgt-in');
      if (tgt) {            // comfort target changed → the bridge re-judges every room
        const v = parseFloat(String(tgt.value).replace(',', '.'));
        await abSaveSetting(targetKey(tgt.dataset.room), isFinite(v) && v >= 10 && v <= 30 ? v : null);
        renderAbgleich(true);
      }
    });
    abrCard.addEventListener('click', async e => {
      if (e.target.closest('[data-ab-setup]')) { e.preventDefault(); openSetup(); return; }
      const rs = e.target.closest('.tgt-reset');
      if (rs) { e.preventDefault(); await abSaveSetting(targetKey(rs.dataset.room), null); renderAbgleich(true); return; }
      if (e.target.closest('input,select,a,label')) return;       // don't toggle while typing
      const tg = e.target.closest('.abr-toggle');
      if (tg) { const rm = tg.dataset.room; _abOpen.has(rm) ? _abOpen.delete(rm) : _abOpen.add(rm); if (_abData) paintAbRooms(_abData); }
    });
  }
  // ---- Abgleich: Datenlage → search the heat pump for a volume-flow value
  const abdCard = $('abd-card');
  if (abdCard) abdCard.addEventListener('click', e => { if (e.target.closest('#flow-disc')) { e.preventDefault(); flowDiscover(); } });
  // ---- Abgleich: step log
  const optLog = $('opt-log');
  if (optLog) optLog.addEventListener('click', () => {
    const room = ($('opt-room') || {}).value; if (!room) return;
    const body = { room, action: ($('opt-action') || {}).value || 'open' };
    const d = parseFloat(String(($('opt-delta') || {}).value || '').replace(',', '.')); if (!isNaN(d)) body.delta_lmin = d;
    const nt = (($('opt-note-inp') || {}).value || '').trim(); if (nt) body.note = nt;
    optAction('/api/optimize/step', body).then(() => { const n = $('opt-note-inp'); if (n) n.value = ''; const di = $('opt-delta'); if (di) di.value = ''; });
  });
  const optUndo = $('opt-undo'); if (optUndo) optUndo.addEventListener('click', () => optAction('/api/optimize/undo', {}));
  const optReset = $('opt-reset'); if (optReset) optReset.addEventListener('click', () => { if (confirm('Den gesamten Schritt-Verlauf löschen?')) optAction('/api/optimize/reset', {}); });
  const rtsSel = $('rts-room');
  if (rtsSel) rtsSel.addEventListener('change', () => { _rtsSel = rtsSel.value; if (_rtsData) paintRoomTs(_rtsData); });
  const rtsRange = $('rts-range');
  if (rtsRange) rtsRange.addEventListener('change', () => { _rtsDays = parseFloat(rtsRange.value) || 2; renderRoomTs(true); });
  const layCard = $('layout-card');
  if (layCard) {
    layCard.addEventListener('input', e => {
      const t = e.target;
      if (t.id === 'lay-q') { const l = layoutModel(); l.q = t.value; layoutSave(l); abLayoutChanged(); }
      else if (t.id === 'lay-dt') { const l = layoutModel(); l.dt = t.value; layoutSave(l); abLayoutChanged(); }
      else if (t.dataset.lay && t.dataset.room && t.tagName !== 'SELECT') {
        layoutSet(t.dataset.room, t.dataset.lay, t.value); abLayoutChanged();
      }
    });
    layCard.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.lay === 'manifold' && t.dataset.room) { layoutSet(t.dataset.room, 'manifold', t.value); abLayoutChanged(0); }
      else if (t.id === 'lay-design') { const l = layoutModel(); l.design = parseFloat(t.value); layoutSave(l); abLayoutChanged(0); }
    });
    layCard.addEventListener('click', e => {
      const sp = e.target.closest('.specpre');
      if (sp) {
        e.preventDefault();
        const v = parseFloat(sp.dataset.sp); if (!isFinite(v)) return;
        const l = layoutModel(); l.q = v; layoutSave(l);
        const qin = $('lay-q'); if (qin) qin.value = v;
        document.querySelectorAll('.specpre').forEach(b => { const on = Math.round(parseFloat(b.dataset.sp)) === v; b.style.borderColor = on ? 'var(--accent)' : ''; b.style.color = on ? 'var(--accent)' : ''; });
        abLayoutChanged(0);
        return;
      }
      const rdel = e.target.closest('[data-roomdel]');
      if (rdel) {
        e.preventDefault(); const rm = rdel.dataset.roomdel;
        if (confirm('Raum „' + rm + '" aus dem Layout entfernen?')) {
          const l = layoutModel(); delete l.rooms[rm];
          if (!l.hidden.includes(rm)) l.hidden.push(rm);   // stays gone even if it's a live thermostat room
          layoutSave(l);
          renderLayout(); abLayoutChanged(0);       // persist now + drop the room from the balance view
        }
        return;
      }
      const del = e.target.closest('[data-mfdel]');
      if (del) { e.preventDefault(); const l = layoutModel(); l.manifolds = l.manifolds.filter(m => m !== del.dataset.mfdel); Object.values(l.rooms).forEach(r => { if (r.manifold === del.dataset.mfdel) delete r.manifold; }); layoutSave(l); renderLayout(); abLayoutChanged(0); return; }
      if (e.target.id === 'lay-mf-add') { const v = ($('lay-mf-name').value || '').trim(); if (v) { const l = layoutModel(); if (!l.manifolds.includes(v)) l.manifolds.push(v); layoutSave(l); renderLayout(); abLayoutChanged(0); } return; }
      if (e.target.id === 'lay-room-add') { const v = ($('lay-room-name').value || '').trim(); if (v) { const l = layoutModel(); l.rooms[v] = l.rooms[v] || {}; l.hidden = l.hidden.filter(h => h !== v); layoutSave(l); renderLayout(); abLayoutChanged(0); } return; }
      if (e.target.id === 'lay-rooms-load') { const l = layoutModel(); l.hidden = []; layoutSave(l); renderLayout(); abLayoutChanged(0); return; }
      if (e.target.id === 'lay-preset') {
        if (confirm('Verteiler-Layout mit deinen Hauswerten vorbefüllen (Flächen, Stränge, Verteiler Küche/Schlafzimmer/OG)? Bestehende Angaben zu diesen Räumen werden überschrieben.'))
          layoutPresetMyHouse();
        return;
      }
    });
  }
  const hcdr = $('hc-dev-read'); if (hcdr) hcdr.addEventListener('click', readDeviceCurve);
  const hpcl = $('hpctl-load'); if (hpcl) hpcl.addEventListener('click', () => fetchHpControls(true));
  const hpcb = $('hpctl-body');
  if (hpcb) hpcb.addEventListener('click', e => {
    const b = e.target.closest('button[data-write]'); if (!b) return;
    doHpWrite(parseInt(b.dataset.write, 10));
  });
  const exp = $('export-csv'); if (exp) exp.addEventListener('click', doExport);
  const aegD = $('aeg-dash');
  if (aegD) aegD.addEventListener('click', () => window.open('https://developer.electrolux.one/dashboard', '_blank'));
  const aegC = $('aeg-connect'); if (aegC) aegC.addEventListener('click', doAegConnect);
  const aegDis = $('aeg-disconnect'); if (aegDis) aegDis.addEventListener('click', doAegDisconnect);
  const tibC = $('tibber-connect'); if (tibC) tibC.addEventListener('click', doTibberConnect);
  const haC = $('ha-connect'); if (haC) haC.addEventListener('click', doHaConnect);
  const aegP = $('aeg-probe'); if (aegP) aegP.addEventListener('click', doAegProbe);
  const saveSpot = async () => {
    const sn = $('spot-note');
    const body = {
      spot_enabled: $('spot-enabled').checked,
      spot_market: $('spot-market').value,
      spot_surcharge_ct: parseFloat($('spot-surcharge').value) || 0,
      spot_vat: parseFloat($('spot-vat').value) || 0,
    };
    if (sn) sn.textContent = 'Speichere …';
    try {
      const r = await postJSON('/api/config', body);
      if (r && r.ok) { setTimeout(loadAll, 800); } else if (sn) sn.textContent = 'Konnte nicht gespeichert werden.';
    } catch (e) { if (sn) sn.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  };
  ['spot-enabled', 'spot-market', 'spot-surcharge', 'spot-vat'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('change', saveSpot);
  });
  const aegK = $('aeg-kpc');
  if (aegK) aegK.addEventListener('change', async () => {
    const n = $('aeg-kpc-note'), v = parseFloat(aegK.value);
    if (!(v >= 0)) return;
    n.textContent = 'Speichere …';
    try {
      const r = await postJSON('/api/config', { electrolux_kwh_per_cycle: v });
      if (r && r.ok) { n.innerHTML = `✓ Es wird mit <b>${fmt(v, 2)} kWh/Waschgang</b> geschätzt.`; setTimeout(loadAll, 800); }
      else n.textContent = 'Konnte nicht gespeichert werden.';
    } catch (e) { n.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  });
  // tariff inputs (localStorage), restore + save + re-render Konzept
  const tarFields = [['tar-hhbase', TAR_LS.hhbase], ['tar-wpct', TAR_LS.wpct],
    ['tar-wpbase', TAR_LS.wpbase], ['tar-meter2', TAR_LS.meter2], ['tar-spotbase', TAR_LS.spotbase]];
  tarFields.forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const s = localStorage.getItem(key); if (s !== null) el.value = s;
    el.addEventListener('input', () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderKonzept(); });
  });
  // finance inputs (Konzept): investment prefilled from the PV planner
  const finFields = [['fin-invest', FIN_LS.invest], ['fin-rate', FIN_LS.rate],
    ['fin-years', FIN_LS.years], ['fin-infl', FIN_LS.infl]];
  finFields.forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    let s = localStorage.getItem(key);
    if (s === null && id === 'fin-invest') s = localStorage.getItem(PV_LS.invest);   // prefill
    if (s !== null && s !== '') el.value = s;
    el.addEventListener('input', () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderKonzept(); });
  });
  // E-Auto-Vorteile inputs (Konzept finance card) with sensible defaults
  const evFields = [['ev-l100', EV_LS.l100, 7], ['ev-fuelp', EV_LS.fuelp, 1.80],
    ['ev-chargep', EV_LS.chargep, STATE.price || 0.30], ['ev-tax', EV_LS.tax, 120],
    ['ev-thg', EV_LS.thg, 60], ['ev-maint', EV_LS.maint, 200]];
  evFields.forEach(([id, key, def]) => {
    const el = $(id); if (!el) return;
    const s = localStorage.getItem(key);
    el.value = (s !== null && s !== '') ? s : def;
    el.addEventListener('input', () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderKonzept(); });
  });
  const evIncl = $('ev-incl');
  if (evIncl) {
    evIncl.checked = (localStorage.getItem(EV_LS.incl) ?? '1') === '1';
    evIncl.addEventListener('change', () => {
      try { localStorage.setItem(EV_LS.incl, evIncl.checked ? '1' : '0'); } catch (e) {}
      renderKonzept();
    });
  }
  // Selbstbau-vs-Fachfirma: two prices + Förderung (PV tab), re-render on edit
  [['pc-diy-set', PCOST_LS.diySet], ['pc-pro-offer', PCOST_LS.proOffer],
   ['pc-foerder', PCOST_LS.foerder], ['pc-diy-hours', PCOST_LS.diyHours]
  ].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const s = localStorage.getItem(key); if (s !== null && s !== '') el.value = s;
    el.addEventListener('input', () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderPvSoon(); });
  });
  const adoptInvest = (total) => {
    try { localStorage.setItem(FIN_LS.invest, String(Math.round(total))); localStorage.setItem(PV_LS.invest, String(Math.round(total))); } catch (e) {}
    const fi = $('fin-invest'); if (fi) fi.value = Math.round(total);
    const pi = $('pv-invest'); if (pi) pi.value = Math.round(total);
    renderPv(); renderKonzept();
  };
  const g2 = (k, d) => { const v = parseFloat(localStorage.getItem(k)); return isFinite(v) ? v : d; };
  const useDiy = $('pc-use-diy');
  if (useDiy) useDiy.addEventListener('click', () => adoptInvest(Math.max(0, g2(PCOST_LS.diySet, 0))));
  const usePro = $('pc-use-pro');
  if (usePro) usePro.addEventListener('click', () =>
    adoptInvest(Math.max(0, g2(PCOST_LS.proOffer, 0) - Math.max(0, g2(PCOST_LS.foerder, 0)))));
  const tarWp = $('tar-wp'), tarWpRow = $('tar-wp-row');
  if (tarWp) {
    try { tarWp.checked = localStorage.getItem(TAR_LS.wp) === '1'; } catch (e) {}
    if (tarWpRow) tarWpRow.hidden = !tarWp.checked;
    tarWp.addEventListener('change', () => {
      try { localStorage.setItem(TAR_LS.wp, tarWp.checked ? '1' : '0'); } catch (e) {}
      if (tarWpRow) tarWpRow.hidden = !tarWp.checked;
      renderKonzept();
    });
  }
  const hk = $('house-kwh');
  if (hk) {
    const saved = localStorage.getItem(LS.house); if (saved) hk.value = saved;
    const upd = () => {
      const v = parseFloat(hk.value) || 0;
      try { v > 0 ? localStorage.setItem(LS.house, String(v)) : localStorage.removeItem(LS.house); } catch (e) {}
      $('house-note').innerHTML = v > 0
        ? `✓ Es wird mit <b>${kwh(v, 0)}/Jahr</b> Haushaltsstrom gerechnet (statt nur der Module).`
        : 'Leer – es zählen nur die gemessenen Licht-/Rollladenmodule.';
      renderOverview(); renderHistory(); renderProfile(); renderPv();
    };
    hk.addEventListener('input', upd); upd();
  }

  // Balkonkraftwerk (800 W) simulation: inputs, presets, day toggle (localStorage)
  const bkFields = [['bk-kwp', 'bhe_bk_kwp'], ['bk-batt', 'bhe_bk_batt'], ['bk-cap', 'bhe_bk_cap'], ['bk-load', 'bhe_bk_load']];
  bkFields.forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    try { const v = localStorage.getItem(key); if (v != null && v !== '') el.value = v; } catch (e) {}
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderBalcony(); });
  });
  document.querySelectorAll('.bk-preset').forEach(b => b.addEventListener('click', () => {
    if ($('bk-kwp')) $('bk-kwp').value = b.dataset.kwp;
    if ($('bk-batt')) $('bk-batt').value = b.dataset.batt;
    try { localStorage.setItem('bhe_bk_kwp', b.dataset.kwp); localStorage.setItem('bhe_bk_batt', b.dataset.batt); } catch (e) {}
    renderBalcony();
  }));
  const bkDay = $('bk-day');
  if (bkDay) bkDay.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    _bkDay = b.dataset.bd;
    bkDay.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderBalcony();
  });

  // whole-house meter readings: add + delete (stored on the bridge)
  const mAdd = $('meter-add');
  if (mAdd) mAdd.addEventListener('click', async () => {
    const note = $('meter-note');
    const dv = $('meter-date').value, kv = parseFloat($('meter-kwh').value);
    if (!dv || !isFinite(kv)) { note.textContent = 'Bitte Datum und Zählerstand eingeben.'; return; }
    const ts = Math.floor(new Date(dv + 'T12:00:00').getTime() / 1000);
    mAdd.disabled = true;
    try {
      const r = await postJSON('/api/meter', { ts, kwh: kv });
      if (r && r.ok) { STATE.meter = r.readings || []; $('meter-kwh').value = ''; renderAll(); }
      else note.textContent = (r && r.error) || 'Konnte nicht gespeichert werden.';
    } catch (e) { note.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
    mAdd.disabled = false;
  });
  const mList = $('meter-list');
  if (mList) mList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.meter-del'); if (!btn) return;
    const ts = parseInt(btn.dataset.ts, 10);
    try {
      const r = await postJSON('/api/meter/delete', { ts });
      if (r && r.ok) { STATE.meter = r.readings || []; renderAll(); }
    } catch (err) {}
  });

  // PV planner: restore saved inputs, save + recompute on change
  const pvFields = [['pv-kwp', PV_LS.kwp], ['pv-orient', PV_LS.orient], ['pv-batt', PV_LS.batt],
    ['pv-feedin', PV_LS.feedin], ['pv-invest', PV_LS.invest], ['pv-ev-km', PV_LS.evkm],
    ['pv-ev-kwh', PV_LS.evkwh], ['pv-ac', PV_LS.ac],
    ['pv-v2h-kwh', PV_LS.v2hkwh], ['pv-v2h-price', PV_LS.v2hprice]];
  pvFields.forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const saved = localStorage.getItem(key);
    if (saved !== null) el.value = saved;
    el.addEventListener('input', () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderPvSoon(); });
  });
  const v2h = $('pv-v2h');
  if (v2h) {
    try { v2h.checked = localStorage.getItem(PV_LS.v2h) === '1'; } catch (e) {}
    v2h.addEventListener('change', () => {
      try { localStorage.setItem(PV_LS.v2h, v2h.checked ? '1' : '0'); } catch (e) {}
      renderPv();
    });
  }
  const cap60 = $('pv-cap60');
  if (cap60) {
    try { cap60.checked = localStorage.getItem(PV_LS.cap60) === '1'; } catch (e) {}
    cap60.addEventListener('change', () => {
      try { localStorage.setItem(PV_LS.cap60, cap60.checked ? '1' : '0'); } catch (e) {}
      renderPv(); renderKonzept();
    });
  }
  const v2hHome = $('pv-v2h-home');
  if (v2hHome) {
    try { const s = localStorage.getItem(PV_LS.v2hhome); if (s) v2hHome.value = s; } catch (e) {}
    v2hHome.addEventListener('change', () => {
      try { localStorage.setItem(PV_LS.v2hhome, v2hHome.value); } catch (e) {}
      renderPv();
    });
  }
  const pvSug = $('pv-suggest'); if (pvSug) pvSug.addEventListener('click', doPvSuggest);
  const pvMod = $('pv-mod-wp'); if (pvMod) pvMod.addEventListener('input', renderPvProduct);
  ['pv-cost-kwp', 'pv-cost-kwh', 'pv-cost-base'].forEach(id => {
    const el = $(id); if (!el) return;
    try { const s = localStorage.getItem('bhe_' + id); if (s !== null && s !== '') el.value = s; } catch (e) {}
    el.addEventListener('input', () => {
      try { localStorage.setItem('bhe_' + id, el.value); } catch (e) {}
      renderPvMargin(); renderPvProduct();
    });
  });
  const pvDS = $('pv-day-summer'), pvDW = $('pv-day-winter');
  if (pvDS) pvDS.addEventListener('click', () => { _pvDaySeason = 'summer'; renderPvDay(); });
  if (pvDW) pvDW.addEventListener('click', () => { _pvDaySeason = 'winter'; renderPvDay(); });
  // Monthly-budget inputs (persist + re-render on change)
  [['ov-budget', 'bhe_budget'], ['ov-budget-unit', 'bhe_budget_unit']].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const s = localStorage.getItem(key); if (s !== null) el.value = s;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderBudget(); });
  });
  // Smart-Timer inputs (persist + re-render on change)
  [['smart-dur', 'bhe_smart_dur'], ['smart-kwh', 'bhe_smart_kwh'], ['smart-prio', 'bhe_smart_prio']].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const s = localStorage.getItem(key); if (s !== null) el.value = s;
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderSmart(); });
  });
  // PVGIS location fields (persist) + buttons
  [['pv-lat', PV_LS.lat], ['pv-lon', PV_LS.lon], ['pv-tilt', PV_LS.tilt], ['pv-az', PV_LS.az]].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const s = localStorage.getItem(key); if (s !== null) el.value = s;
    el.addEventListener('input', () => { try { localStorage.setItem(key, el.value); } catch (e) {} });
  });
  const pvGis = $('pv-pvgis'); if (pvGis) pvGis.addEventListener('click', doPvgis);
  // Meine Flächen: add / remove / apply
  let _surfEdit = null;   // index being edited, or null (= add mode)
  const surfAdd = $('surf-add'), surfCancel = $('surf-cancel');
  const surfFormReset = () => {
    _surfEdit = null;
    $('surf-area').value = ''; $('surf-tilt').value = ''; $('surf-az').value = ''; $('surf-shade').value = '';
    if (surfAdd) surfAdd.textContent = '+ Fläche hinzufügen';
    if (surfCancel) surfCancel.style.display = 'none';
  };
  const surfFormLoad = (s, idx) => {
    _surfEdit = idx;
    $('surf-type').value = s.type; $('surf-area').value = s.area != null ? s.area : '';
    $('surf-tilt').value = (s.tilt == null ? '' : s.tilt); $('surf-az').value = (s.az == null ? '' : s.az);
    $('surf-shade').value = (s.shade == null ? '' : s.shade);
    if (surfAdd) surfAdd.textContent = '✓ Änderungen speichern';
    if (surfCancel) surfCancel.style.display = '';
    const c = $('pv-surf-card'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  if (surfCancel) surfCancel.addEventListener('click', surfFormReset);
  if (surfAdd) surfAdd.addEventListener('click', () => {
    const type = $('surf-type').value;
    const area = parseFloat($('surf-area').value) || 0;
    if (!(area > 0)) { $('pv-surf-note').textContent = 'Bitte eine Fläche in m² eintragen.'; return; }
    const tiltRaw = $('surf-tilt').value, azRaw = $('surf-az').value, shRaw = $('surf-shade').value;
    const rec = { type, area, tilt: tiltRaw === '' ? null : parseFloat(tiltRaw),
      az: azRaw === '' ? 0 : parseFloat(azRaw), shade: shRaw === '' ? 0 : parseFloat(shRaw) };
    const arr = loadSurfaces();
    if (_surfEdit != null && arr[_surfEdit]) { rec.use = arr[_surfEdit].use; arr[_surfEdit] = rec; }
    else { rec.use = true; arr.push(rec); }
    saveSurfaces(arr);
    surfFormReset();
    renderSurfaces();
  });
  const surfList = $('pv-surf-list');
  if (surfList) surfList.addEventListener('click', (e) => {
    const arr = loadSurfaces();
    const del = e.target.closest('.surf-del');
    if (del) { const i = +del.dataset.idx; if (arr[i]) { arr.splice(i, 1); saveSurfaces(arr); if (_surfEdit === i) surfFormReset(); renderSurfaces(); } return; }
    const dup = e.target.closest('.surf-dup');
    if (dup) { const i = +dup.dataset.idx; if (arr[i]) { arr.splice(i + 1, 0, { ...arr[i] }); saveSurfaces(arr); renderSurfaces(); } return; }
    const ed = e.target.closest('.surf-edit');
    if (ed) { const i = +ed.dataset.idx; if (arr[i]) surfFormLoad(arr[i], i); return; }
  });
  const surfReset = $('pv-surf-reset');
  if (surfReset) surfReset.addEventListener('click', () => {
    const rec = recommendCoverage();
    if (!rec || !rec.chosenIds) return;
    const arr = loadSurfaces();
    arr.forEach((s, i) => { s.use = rec.chosenIds.has(i); });
    saveSurfaces(arr); renderSurfaces();
  });
  // checkbox: which surfaces the user actually uses (drives the combined card)
  if (surfList) surfList.addEventListener('change', (e) => {
    const cb = e.target.closest('.surf-use'); if (!cb) return;
    const idx = +cb.dataset.idx, arr = loadSurfaces();
    if (arr[idx]) { arr[idx].use = cb.checked; saveSurfaces(arr); renderSurfaces(); }
  });
  // hover/tap on a year chart → show day, yield, consumption (per surface + combo)
  const onYear = (e) => {
    const hit = e.target.closest && e.target.closest('.syhit'); if (!hit) return;
    const idx = hit.dataset.idx, ser = _surfYear[idx]; if (!ser) return;
    const svgEl = hit.querySelector('svg'); if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
    const fx = Math.min(1, Math.max(0, (cx - rect.left) / (rect.width || 1)));
    const left = 2, right = CW - 2;
    let di = Math.round((fx * CW - left) / (right - left) * 364);
    di = Math.min(364, Math.max(0, di));
    const d = new Date(new Date().getFullYear(), 0, 1 + di);
    const t = $('toast');
    if (t) {
      t.innerHTML = `<b>${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</b> · ` +
        `☀️ Ertrag <b>${kwh(ser.yld[di], 1)}</b> · 🏠 Verbrauch <b>${kwh(ser.load[di], 1)}</b>` +
        `<div class="note" style="margin-top:2px;color:var(--muted)">${ser.yld[di] >= ser.load[di] ? 'Überschuss ' + kwh(ser.yld[di] - ser.load[di], 1) + ' (einspeisen/laden)' : 'Rest ' + kwh(ser.load[di] - ser.yld[di], 1) + ' aus Netz/Speicher'}</div>`;
      t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 5000);
    }
    const ln = svgEl.querySelector('.syc');
    if (ln) { const lx = (left + (right - left) * di / 364).toFixed(1); ln.setAttribute('x1', lx); ln.setAttribute('x2', lx); ln.setAttribute('opacity', '0.7'); }
    e.stopPropagation();
  };
  if (surfList) { surfList.addEventListener('pointermove', onYear); surfList.addEventListener('pointerdown', onYear); }
  const comboCard = $('pv-combo-card');
  if (comboCard) { comboCard.addEventListener('pointermove', onYear); comboCard.addEventListener('pointerdown', onYear); }
  const comboUse = $('pv-combo-use');
  if (comboUse) comboUse.addEventListener('click', () => {
    const c = comboUse._combo; if (!c || !(c.comb.kwp > 0)) return;
    const setLS = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) {} };
    const kwp = Math.round(c.comb.kwp * 10) / 10;
    const kEl = $('pv-kwp'); if (kEl) { kEl.value = kwp; setLS(PV_LS.kwp, kwp); }
    if (c.comb.shape) setLS(PV_LS.pgm, JSON.stringify(c.comb.shape));
    const opts = [1000, 950, 880, 800];
    const near = opts.reduce((a, b) => Math.abs(b - c.comb.spec) < Math.abs(a - c.comb.spec) ? b : a);
    const oEl = $('pv-orient'); if (oEl) { oEl.value = String(near); setLS(PV_LS.orient, near); }
    if (c.battSuggested && c.batt) { const bEl = $('pv-batt'); if (bEl) { bEl.value = c.batt; setLS(PV_LS.batt, c.batt); } }
    renderPv();
    const t = $('toast');
    if (t) { t.innerHTML = `Übernommen: <b>${fmt(kwp, 1)} kWp</b> aus deiner Flächen-Auswahl.`; t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 7000); }
  });
  const surfUse = $('pv-surf-use');
  if (surfUse) surfUse.addEventListener('click', () => {
    const rec = recommendCoverage();
    const comb = (rec && !rec.empty) ? (rec.comb || rec.all) : null;
    if (!comb || !(comb.kwp > 0)) return;
    const setLS = (k, v) => { try { localStorage.setItem(k, String(v)); } catch (e) {} };
    const kwp = Math.round(comb.kwp * 10) / 10;
    const kEl = $('pv-kwp'); if (kEl) { kEl.value = kwp; setLS(PV_LS.kwp, kwp); }
    // write the real blended monthly curve into the planner's PV-shape slot
    if (comb.shape) setLS(PV_LS.pgm, JSON.stringify(comb.shape));
    const opts = [1000, 950, 880, 800];
    const near = opts.reduce((a, b) => Math.abs(b - comb.spec) < Math.abs(a - comb.spec) ? b : a);
    const oEl = $('pv-orient'); if (oEl) { oEl.value = String(near); setLS(PV_LS.orient, near); }
    if (rec.battSuggested && rec.batt) { const bEl = $('pv-batt'); if (bEl) { bEl.value = rec.batt; setLS(PV_LS.batt, rec.batt); } }
    renderPv();
    const t = $('toast');
    if (t) { t.innerHTML = `Übernommen: <b>${fmt(kwp, 1)} kWp</b> aus deinen Flächen (echte Monatskurve). ` +
      `<span style="color:var(--muted)">Der ganze PV-Tab rechnet jetzt mit dieser Belegung.</span>`;
      t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 9000); }
  });
  const pvWx = $('pv-weather'); if (pvWx) pvWx.addEventListener('click', doWeather);
  const hpWx = $('hp-fc-btn'); if (hpWx) hpWx.addEventListener('click', doHpWeather);
  const pvLoc = $('pv-locate');
  if (pvLoc) pvLoc.addEventListener('click', () => {
    const note = $('pv-pvgis-note');
    const insecureHint = ' <span style="color:var(--muted)">Tipp: GPS im Browser geht nur über <b>HTTPS</b> oder ' +
      '<b>localhost</b> – auf <code>http://&lt;Bridge-IP&gt;</code> blockt der Browser das. Koordinaten sonst ' +
      'manuell eintragen (z. B. aus Google Maps: Rechtsklick → Koordinaten) – der Ertrag wird auch ohne Standort ' +
      'über das eingebaute Modell geschätzt.</span>';
    if (!navigator.geolocation) { note.innerHTML = 'Standort wird vom Browser nicht unterstützt.' + insecureHint; return; }
    if (window.isSecureContext === false) { note.innerHTML = '⚠︎ GPS ist hier gesperrt (keine sichere Verbindung).' + insecureHint; return; }
    note.textContent = 'Ermittle Standort …';
    navigator.geolocation.getCurrentPosition(
      pos => {
        $('pv-lat').value = pos.coords.latitude.toFixed(4); $('pv-lon').value = pos.coords.longitude.toFixed(4);
        try { localStorage.setItem(PV_LS.lat, $('pv-lat').value); localStorage.setItem(PV_LS.lon, $('pv-lon').value); } catch (e) {}
        note.textContent = 'Standort übernommen – jetzt „Ertrag holen (PVGIS)".';
      },
      (err) => {
        const why = err && err.code === 1 ? 'Zugriff abgelehnt/gesperrt'
          : err && err.code === 2 ? 'Position nicht verfügbar'
          : err && err.code === 3 ? 'Zeitüberschreitung' : 'nicht verfügbar';
        note.innerHTML = `⚠︎ Standort ${why}.` + insecureHint;
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
  });
  const pvm = $('pv-monthly');
  if (pvm) {
    const onMove = e => { const r = e.target.closest && e.target.closest('.pvhit'); if (r) { e.stopPropagation(); showPvTip(+r.dataset.mi); } };
    pvm.addEventListener('pointermove', onMove);
    pvm.addEventListener('pointerdown', onMove);
  }
  const consum = $('h-consum-chart');
  if (consum) {
    const onC = e => {
      const hit = e.target.closest && e.target.closest('.cyhit'); if (!hit || !_consumYear) return;
      const svgEl = hit.querySelector('svg'); if (!svgEl) return;
      const rect = svgEl.getBoundingClientRect();
      const cx = (e.touches && e.touches[0] ? e.touches[0].clientX : e.clientX);
      const fx = Math.min(1, Math.max(0, (cx - rect.left) / (rect.width || 1)));
      const left = 2, right = CW - 2;
      let di = Math.round((fx * CW - left) / (right - left) * 364); di = Math.min(364, Math.max(0, di));
      const haus = _consumYear.haus[di], wp = _consumYear.wp[di], d = new Date(new Date().getFullYear(), 0, 1 + di);
      // sum the whole calendar month the hovered day belongs to, so it can be
      // checked against the meter (e.g. ~485 kWh for September)
      const mo = d.getMonth();
      let mStart = 0; for (let k = 0; k < mo; k++) mStart += DIM[k];
      let mHaus = 0, mWp = 0;
      for (let k = mStart; k < mStart + DIM[mo] && k < 365; k++) { mHaus += _consumYear.haus[k]; mWp += _consumYear.wp[k]; }
      const t = $('toast');
      if (t) {
        t.innerHTML = `<b>${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}</b> · ` +
          `🏠 Hausstrom <b>${kwh(haus, 1)}</b> · 🔥 WP <b>${kwh(wp, 1)}</b>` +
          `<div class="note" style="margin-top:2px;color:var(--muted)">Gesamt <b>${kwh(haus + wp, 1)}/Tag</b></div>` +
          `<div class="note" style="margin-top:2px"><b>${MON[mo]}</b> gesamt <b>${kwh(mHaus + mWp, 0)}</b> ` +
          `<span style="color:var(--muted)">(🏠 ${kwh(mHaus, 0)} + 🔥 ${kwh(mWp, 0)})</span></div>`;
        t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 5000);
      }
      const ln = svgEl.querySelector('.syc');
      if (ln) { const lx = (left + (right - left) * di / 364).toFixed(1); ln.setAttribute('x1', lx); ln.setAttribute('x2', lx); ln.setAttribute('opacity', '0.7'); }
      e.stopPropagation();
    };
    consum.addEventListener('pointermove', onC);
    consum.addEventListener('pointerdown', onC);
  }
  const gf = $('pv-gridfree');
  if (gf) {
    const onGf = e => { const r = e.target.closest && e.target.closest('.gfhit'); if (r) { e.stopPropagation(); showGfTip(+r.dataset.kwp, +r.dataset.count); } };
    gf.addEventListener('pointermove', onGf);
    gf.addEventListener('pointerdown', onGf);
  }
  const acFill = $('pv-ac-fill');
  if (acFill) acFill.addEventListener('click', () => {
    $('pv-ac').value = 450; // typical German home A/C usage, kWh/year
    try { localStorage.setItem(PV_LS.ac, '450'); } catch (e) {}
    renderPv();
  });
  $('rename-list').addEventListener('change', async (e) => {
    const inp = e.target.closest('input.rn'); if (!inp) return;
    const id = inp.dataset.id, name = inp.value.trim();
    inp.disabled = true;
    try {
      const r = await postJSON('/api/device-name', { id, name });
      if (r && r.ok) {
        applyCustomName(id, name);
        inp.style.borderColor = '#4be0b0';
        renderOverview(); renderToday(); renderHistory();
      } else { inp.style.borderColor = '#ff6b8a'; }
    } catch (err) { inp.style.borderColor = '#ff6b8a'; }
    inp.disabled = false;
  });
  $('price').addEventListener('change', () => {
    STATE.price = parseFloat($('price').value) || 0.35;
    localStorage.setItem(LS.price, String(STATE.price));
    loadAll();
  });
  const ti = $('hp-theory-inputs');
  if (ti) ti.addEventListener('input', e => {
    const el = e.target; if (el.tagName !== 'INPUT') return;
    const b = buildData(), v = parseFloat(el.value);
    if (!isFinite(v)) return;
    if (el.dataset.g) { b[el.dataset.g] = v; }
    else if (el.dataset.ck) { const c = b.comps.find(x => x.k === el.dataset.ck); if (c) c[el.dataset.fld] = v; }
    try { localStorage.setItem(BUILD_LS, JSON.stringify(b)); } catch (err) {}
    renderHeatDemand();
  });
  const tr = $('hp-theory-reset');
  if (tr) tr.addEventListener('click', () => {
    try { localStorage.removeItem(BUILD_LS); } catch (err) {}
    if (ti) delete ti.dataset.built;   // force the input grid to rebuild with defaults
    renderHeatDemand();
  });

  const pfb = $('perf-bench'); if (pfb) pfb.addEventListener('click', () => renderPerf(true));
  initPvReal();
  initHpDiag();
  initCalSetup();
  if (!_bootDriven) loadAll();
  setInterval(refreshLive, 30000);
  // Service worker: register, then actively check for a newer version and take
  // it over automatically. Without the controllerchange auto-reload the browser
  // keeps running the old app.js until the user manually clears the cache –
  // which is exactly the "it still doesn't save" confusion we kept hitting.
  if ('serviceWorker' in navigator) {
    let _swReloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_swReloaded) return;          // reload exactly once when new code activates
      _swReloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      try { reg.update(); } catch (e) {}
      setInterval(() => { try { reg.update(); } catch (e) {} }, 60000);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          // a new worker is installed and an old one controls the page → switch now
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            try { nw.postMessage({ type: 'SKIP_WAITING' }); } catch (e) {}
          }
        });
      });
    }).catch(() => {});
  }
  // deep-link: #heatpump etc. opens that tab on load (also keeps the tab on reload)
  const openFromHash = () => {
    const h = (location.hash || '').replace(/^#/, '');
    if (h && document.getElementById('v-' + h)) switchView(h);
  };
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
}

async function refreshLive() {
  if (STATE.demo) { applyDemo('demo'); return; }
  try {
    const p = STATE.price;
    const [ov, hpA] = await Promise.all([
      api('/api/overview?days=90&price=' + p),
      api('/api/heatpump/analytics?days=90&price=' + p),
    ]);
    STATE.ov = ov; STATE.hpA = hpA;
    paintViews(['renderOverview', 'renderToday', 'renderHistory', 'renderHeatpump', 'renderPv']);
    if (STATE.coreOrigin !== 'fresh') { STATE.coreOrigin = 'fresh'; showStand(null); setMode((STATE.health && STATE.health.mode) || 'live'); }
    snapSave();
  } catch (e) { /* keep last */ }
}

/* --------------------------------------------------------- demo generator */
function demoPower(id, dt, away) {
  const h = dt.getHours() + dt.getMinutes() / 60;
  const weekend = dt.getDay() === 0 || dt.getDay() === 6;
  const base = 0.4;
  const bell = (c, w, p) => p * Math.exp(-((h - c) ** 2) / (2 * w * w));
  if (away) {
    if (id.includes('rollladen') && (Math.abs(h - 8) < 0.2 || Math.abs(h - 20) < 0.2)) return base + 55;
    return base + 0.1;
  }
  let v = base;
  if (id.includes('kueche')) v += bell(7.5, 1, 22) + bell(18.5, 2, 30) + (weekend ? bell(12.5, .8, 15) : 0);
  else if (id.includes('flur')) v += bell(7, 1.2, 10) + bell(19, 2.5, 14) + bell(1, .3, 6);
  else if (id.includes('wohnzimmer')) { v += bell(20, 2.8, 45) + bell(9, 1.5, 8); if (Math.abs(h - 7.5) < .2 || Math.abs(h - 21.5) < .2) v += 60; }
  else if (id.includes('schlafzimmer')) { v += bell(6.7, .8, 12) + bell(22, 1.2, 14); if (Math.abs(h - (weekend ? 9 : 7)) < .2 || Math.abs(h - 22) < .2) v += 58; }
  v *= 1 + 0.06 * Math.sin(dt.getTime() / 137000);
  return Math.max(0, v);
}

function demoHpOp(dt) {
  const doy = dayOfYear(dt), h = dt.getHours() + dt.getMinutes() / 60;
  const outdoor = round(9 - 12 * Math.cos((doy - 20) / 365 * 2 * Math.PI) + 4 * Math.sin((h - 14) / 24 * 2 * Math.PI), 1);
  let elec, mode, cop;
  const dhw = (h >= 6 && h <= 7) || (h >= 18.5 && h <= 19.5);
  if (dhw) { elec = 1500; mode = 'dhw'; cop = Math.max(1.8, Math.min(3.6, 2.0 + 0.07 * outdoor)); }
  else if (outdoor < 16) { elec = 300 + (16 - outdoor) * 95; cop = Math.max(1.6, Math.min(4.8, 1.9 + 0.11 * outdoor)); mode = 'ch'; }
  else { elec = 14; mode = 'off'; cop = 0; }
  const heat = elec * cop;
  return { elec, heat, outdoor, mode, modulation: mode === 'off' ? 0 : Math.round(Math.min(100, elec / 2600 * 100)) };
}

const DEMO_DEVICES = [
  { id: 'demo-wohnzimmer', name: 'Wohnzimmer Rollladen', room: 'Wohnzimmer', model: 'BSM' },
  { id: 'demo-kueche', name: 'Küche Licht', room: 'Küche', model: 'BSM' },
  { id: 'demo-schlafzimmer', name: 'Schlafzimmer Rollladen', room: 'Schlafzimmer', model: 'BSM' },
  { id: 'demo-flur', name: 'Flur Licht', room: 'Flur', model: 'BSM' },
];

function demoAnalytics(days) {
  const now = new Date(), start = new Date(now.getTime() - days * 86400000);
  const awayRanges = [[40, 34], [17, 15], [6, 5]].map(([a, b]) => [new Date(now - a * 86400000), new Date(now - b * 86400000)]);
  const isAway = t => awayRanges.some(([a, b]) => t >= a && t <= b);
  const dayKwh = {}, dayActive = {}, hourP = {}, hwP = {}, devEnergy = {}, perDevDay = {}, liveNow = {};
  for (let h = 0; h < 24; h++) hourP[h] = [];
  DEMO_DEVICES.forEach(d => { devEnergy[d.id] = 0; perDevDay[d.id] = {}; });
  const step = 15 * 60000;
  for (let t = start.getTime(); t <= now.getTime(); t += step) {
    const dt = new Date(t), away = isAway(dt), dayKey = localKey(dt);
    DEMO_DEVICES.forEach(d => {
      const p = demoPower(d.id, dt, away), wh = p * (step / 3600000);
      devEnergy[d.id] += wh;
      dayKwh[dayKey] = (dayKwh[dayKey] || 0) + wh / 1000;
      perDevDay[d.id][dayKey] = (perDevDay[d.id][dayKey] || 0) + wh / 1000;
      hourP[dt.getHours()].push(p);
      const key = ((dt.getDay() + 6) % 7) + '_' + dt.getHours();
      (hwP[key] = hwP[key] || []).push(p);
      liveNow[d.id] = p;
    });
  }
  const allP = []; Object.values(hourP).forEach(a => a.forEach(v => allP.push(v))); allP.sort((a, b) => a - b);
  const baseline = allP[Math.max(0, Math.floor(allP.length * 0.1) - 1)] || 0.4;
  const daysSorted = Object.keys(dayKwh).sort();
  daysSorted.forEach(day => { dayActive[day] = Math.max(0, dayKwh[day] - baseline * 24 / 1000); });
  const complete = daysSorted.slice(1, -1), kwhVals = complete.map(d => dayKwh[d]);
  const avg = mean(kwhVals);
  const sortedAct = complete.map(d => dayActive[d]).sort((a, b) => a - b);
  const medAct = sortedAct[Math.floor(sortedAct.length / 2)] || 0, awayThresh = Math.max(0.02, medAct * 0.25);
  const daily = daysSorted.map(day => ({
    day, kwh: round(dayKwh[day], 3), active_kwh: round(dayActive[day], 3),
    presence: round(medAct <= 0 ? 0 : Math.min(1, dayActive[day] / medAct), 2),
    likely_away: dayActive[day] < awayThresh,
  }));
  const hourly = []; for (let h = 0; h < 24; h++) hourly.push({ hour: h, avg_w: round(mean(hourP[h]), 2) });
  const wAgg = {}; for (let i = 0; i < 7; i++) wAgg[i] = [];
  daysSorted.forEach(day => wAgg[(new Date(day + 'T00:00').getDay() + 6) % 7].push(dayKwh[day]));
  const weekday = []; for (let i = 0; i < 7; i++) weekday.push({ weekday: i, avg_kwh: round(mean(wAgg[i]), 3) });
  const heat = [];
  for (let wd = 0; wd < 7; wd++) { const row = []; for (let h = 0; h < 24; h++) row.push(round(mean(hwP[wd + '_' + h] || []), 1)); heat.push(row); }
  const perDevice = DEMO_DEVICES.map(d => ({
    id: d.id, name: d.name, room: d.room, model: d.model, custom_name: '',
    power_w: round(liveNow[d.id] || 0, 2), energy_kwh_total: round(devEnergy[d.id] / 1000, 3),
    // no-bridge demo: synthetic standby floor (module/always-on sips a bit, pure lights ~0)
    standby_w: /rollladen|router|\btv\b|modul|micromodule|steck/i.test(d.name + ' ' + (d.model || '')) ? 1.3 : 0.3,
    peak_w: round(Math.max(liveNow[d.id] || 0, 9), 0),
  })).sort((a, b) => b.power_w - a.power_w);
  return {
    currency: '€', price_per_kwh: STATE.price, baseline_w: round(baseline, 2), window_days: days,
    live: { total_power_w: round(perDevice.reduce((a, d) => a + d.power_w, 0), 2),
      total_energy_kwh: round(perDevice.reduce((a, d) => a + d.energy_kwh_total, 0), 3), devices: perDevice },
    daily, hourly_profile: hourly, weekday_profile: weekday, heatmap: heat, per_device_day: perDevDay,
    stats: {
      avg_daily_kwh: round(avg, 3),
      median_daily_kwh: round([...kwhVals].sort((a, b) => a - b)[Math.floor(kwhVals.length / 2)] || 0, 3),
      min_daily_kwh: round(Math.min(...kwhVals, 0), 3), max_daily_kwh: round(Math.max(...kwhVals, 0), 3),
      year_estimate_kwh: round(avg * 365, 1), year_estimate_cost: round(avg * 365 * STATE.price, 2),
      month_estimate_kwh: round(avg * 30.4, 2), month_estimate_cost: round(avg * 30.4 * STATE.price, 2),
      day_avg_cost: round(avg * STATE.price, 2),
      standby_share: avg > 0 ? round((baseline * 24 / 1000) / avg, 3) : 0,
    },
    away: { count: daily.filter(d => d.likely_away).length, days: daily.filter(d => d.likely_away).map(d => d.day),
      threshold_kwh: round(awayThresh, 3), analysed_days: daily.length },
  };
}
function localKey(dt) { return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }

function demoHpAnalytics(days) {
  const now = new Date(), start = new Date(now.getTime() - days * 86400000), step = 15 * 60000;
  const elecDay = {}, heatDay = {}, hourP = {}, hwP = {}, outH = {};
  for (let h = 0; h < 24; h++) { hourP[h] = []; outH[h] = []; }
  const modeWin = { heating: 0, water: 0, other: 0 }, modeToday = { heating: 0, water: 0, other: 0 };
  const tempBins = {}; const today0 = localKey(now);
  let lastOp = null;
  for (let t = start.getTime(); t <= now.getTime(); t += step) {
    const dt = new Date(t), op = demoHpOp(dt), key = localKey(dt), dtH = step / 3600000;
    const e = op.elec / 1000 * dtH, hh = op.heat / 1000 * dtH;
    elecDay[key] = (elecDay[key] || 0) + e;
    heatDay[key] = (heatDay[key] || 0) + hh;
    const mk = op.mode === 'ch' ? 'heating' : op.mode === 'dhw' ? 'water' : 'other';
    modeWin[mk] += e; if (key === today0) modeToday[mk] += e;
    const tb = Math.floor(op.outdoor / 5) * 5; (tempBins[tb] = tempBins[tb] || [0, 0]); tempBins[tb][0] += e; tempBins[tb][1] += hh;
    hourP[dt.getHours()].push(op.elec);
    outH[dt.getHours()].push(op.outdoor);
    const wk = ((dt.getDay() + 6) % 7) + '_' + dt.getHours();
    (hwP[wk] = hwP[wk] || []).push(op.elec);
    lastOp = op;
  }
  const copByTemp = Object.keys(tempBins).map(Number).sort((a, b) => a - b)
    .filter(k => tempBins[k][0] > 0.5 && tempBins[k][1] > 0)
    .map(k => ({ temp: k, cop: round(tempBins[k][1] / tempBins[k][0], 2), kwh: round(tempBins[k][0], 1) }));
  const daysSorted = Object.keys(elecDay).sort();
  const daily = daysSorted.map(d => {
    const e = round(elecDay[d], 3), h = round(heatDay[d] || 0, 3);
    return { day: d, elec_kwh: e, heat_kwh: h, cop: e > 0 ? round(h / e, 2) : null, cost: round(e * STATE.price, 2) };
  });
  const hourly = []; for (let h = 0; h < 24; h++) hourly.push({ hour: h, avg_w: round(mean(hourP[h]), 1), avg_outdoor: outH[h].length ? round(mean(outH[h]), 1) : null });
  const heat = [];
  for (let wd = 0; wd < 7; wd++) { const row = []; for (let h = 0; h < 24; h++) row.push(round(mean(hwP[wd + '_' + h] || []), 1)); heat.push(row); }
  const monE = {}, monH = {};
  daysSorted.forEach(d => { const m = d.slice(0, 7); monE[m] = (monE[m] || 0) + elecDay[d]; monH[m] = (monH[m] || 0) + (heatDay[d] || 0); });
  const monthly = Object.keys(monE).sort().map(m => ({ month: m, elec_kwh: round(monE[m], 1), heat_kwh: round(monH[m] || 0, 1), cop: monE[m] > 0 ? round((monH[m] || 0) / monE[m], 2) : null }));
  const today = localKey(now), te = round(elecDay[today] || 0, 3), th = round(heatDay[today] || 0, 3);
  const complete = daily.slice(1, -1), avgE = mean(complete.map(d => d.elec_kwh)) || mean(daily.map(d => d.elec_kwh));
  const totE = Object.values(elecDay).reduce((a, b) => a + b, 0), totH = Object.values(heatDay).reduce((a, b) => a + b, 0);
  const eLife = round(totE, 1), hLife = round(totH, 1);
  const cop = lastOp && lastOp.elec > 0 ? round(lastOp.heat / lastOp.elec, 2) : null;
  return {
    generated_at: Math.floor(Date.now() / 1000), window_days: days, connected: true,
    live: { power_w: round(lastOp.elec, 0), heat_w: round(lastOp.heat, 0), cop_live: cop,
      cop_lifetime: eLife > 0 ? round(hLife / eLife, 2) : null, modulation: lastOp.modulation, mode: lastOp.mode,
      outdoor_c: lastOp.outdoor, supply_c: round(28 + lastOp.heat / 6000 * 12, 1), return_c: round(28 + lastOp.heat / 6000 * 12 - lastOp.heat / 6000 * 5, 1),
      energy_kwh: eLife, heat_kwh: hLife, compressor_kwh: round(eLife * 0.87, 1), eheater_kwh: round(eLife * 0.13, 1),
      starts: 655, working_h: 4333, last_poll: Math.floor(Date.now() / 1000) },
    today: { elec_kwh: te, heat_kwh: th, cost: round(te * STATE.price, 2), cop: te > 0 ? round(th / te, 2) : null },
    mode_today: { heating: round(modeToday.heating, 3), water: round(modeToday.water, 3), other: round(modeToday.other, 3) },
    mode_window: { heating: round(modeWin.heating, 3), water: round(modeWin.water, 3), other: round(modeWin.other, 3) },
    cop_by_temp: copByTemp,
    daily, monthly, hourly_profile: hourly, heatmap: heat,
    stats: {
      avg_daily_elec_kwh: round(avgE, 3), window_elec_kwh: round(totE, 1), window_heat_kwh: round(totH, 1),
      window_cost: round(totE * STATE.price, 2), seasonal_cop: totE > 0 ? round(totH / totE, 2) : null,
      year_estimate_kwh: round(avgE * 365, 1), year_estimate_cost: round(avgE * 365 * STATE.price, 2),
    },
  };
}

function demoOverview(sh, hp) {
  const now = new Date(), today = localKey(now);
  const shDaily = {}; sh.daily.forEach(d => shDaily[d.day] = d);
  const hpDaily = {}; hp.daily.forEach(d => hpDaily[d.day] = d);
  const shToday = round((shDaily[today] || {}).kwh || 0, 3), hpToday = hp.today.elec_kwh;
  const totalToday = round(shToday + hpToday, 3);
  const allDays = [...new Set([...Object.keys(shDaily), ...Object.keys(hpDaily)])].sort();
  const combined = allDays.map(d => ({
    day: d, smarthome_kwh: round((shDaily[d] || {}).kwh || 0, 3), heatpump_kwh: round((hpDaily[d] || {}).elec_kwh || 0, 3),
    total_kwh: round(((shDaily[d] || {}).kwh || 0) + ((hpDaily[d] || {}).elec_kwh || 0), 3),
  }));
  // today hourly (Smart Home from device power, heat pump from op)
  const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const shH = new Array(24).fill(0), hpH = new Array(24).fill(0), step = 15 * 60000;
  for (let t = mid.getTime(); t <= now.getTime(); t += step) {
    const dt = new Date(t), dtH = step / 3600000;
    DEMO_DEVICES.forEach(d => { shH[dt.getHours()] += demoPower(d.id, dt, false) / 1000 * dtH; });
    hpH[dt.getHours()] += demoHpOp(dt).elec / 1000 * dtH;
  }
  const todayHourly = []; for (let h = 0; h < 24; h++) todayHourly.push({ hour: h, smarthome_kwh: round(shH[h], 3), heatpump_kwh: round(hpH[h], 3) });
  // breakdown today (heat pump split by heating vs hot water)
  const breakdown = [];
  const mt = hp.mode_today || { heating: 0, water: 0, other: 0 };
  const heat_ = round(mt.heating || 0, 3), water_ = round(mt.water || 0, 3), gap_ = round(mt.gap || 0, 3);
  // reconcile: unclassified WP energy → "Sonstiges" so slices sum to hpToday
  const other_ = round(Math.max(mt.other || 0, (hpToday || 0) - heat_ - water_ - gap_), 3);
  if (heat_ > 0.01 || water_ > 0.01 || other_ > 0.01 || gap_ > 0.01) {
    if (heat_ > 0.01) breakdown.push({ key: 'hp_heating', label: 'WP · Heizung', kwh: heat_, color: COL.hp });
    if (water_ > 0.01) breakdown.push({ key: 'hp_water', label: 'WP · Warmwasser', kwh: water_, color: COL.heat });
    if (other_ > 0.01) breakdown.push({ key: 'hp_other', label: 'WP · Sonstiges', kwh: other_, color: '#b07a4d' });
    if (gap_ > 0.01) breakdown.push({ key: 'hp_gap', label: 'WP · Betriebsart unbekannt (Datenlücke)', kwh: gap_, color: HP_GAP_COL });
  } else if (hpToday > 0) {
    breakdown.push({ key: 'heatpump', label: 'Wärmepumpe', kwh: hpToday, color: COL.hp });
  }
  (sh.per_device_day ? Object.keys(sh.per_device_day) : []).forEach(id => {
    const v = round((sh.per_device_day[id][today] || 0), 3);
    const dev = sh.live.devices.find(x => x.id === id);
    if (v > 0) breakdown.push({ key: id, label: dev ? devLabel(dev).title : id, kwh: v, color: COL.sh });
  });
  breakdown.sort((a, b) => b.kwh - a.kwh);
  const shNow = sh.live.total_power_w, hpNow = hp.live.power_w;
  const monthKwh = round((sh.stats.avg_daily_kwh + hp.stats.avg_daily_elec_kwh) * 30.4, 1);
  const yearKwh = round((sh.stats.avg_daily_kwh + hp.stats.avg_daily_elec_kwh) * 365, 1);
  return {
    generated_at: Math.floor(Date.now() / 1000), window_days: sh.window_days, price_per_kwh: STATE.price,
    heatpump_connected: true,
    now: { total_w: round(shNow + hpNow, 1), smarthome_w: round(shNow, 1), heatpump_w: round(hpNow, 1) },
    today: { total_kwh: totalToday, smarthome_kwh: shToday, heatpump_kwh: hpToday, cost: round(totalToday * STATE.price, 2) },
    estimate: { month_kwh: monthKwh, month_cost: round(monthKwh * STATE.price, 2), year_kwh: yearKwh, year_cost: round(yearKwh * STATE.price, 2) },
    combined_daily: combined, today_hourly: todayHourly, breakdown,
    heatpump: { today: hp.today, live: hp.live, seasonal_cop: hp.stats.seasonal_cop },
  };
}

/* ------------------------------------------------------------- app start --
 * Goal: numbers on screen as early as possible.
 *  • index.html starts fetching /api/boot – settings, bridge status and the
 *    three core results in ONE answer – before this script has even been
 *    downloaded. The app used to make three round trips in a row instead
 *    (settings → health → analytics), each waiting for the one before.
 *  • The settings must be in localStorage BEFORE init() builds the UI (it
 *    restores dozens of inputs from them); they come with that same answer.
 *  • If the bridge has not answered yet but this browser has shown the app
 *    before, the last known state is painted at once, marked with its time,
 *    and replaced as soon as the fresh data arrives.
 *  • Only the visible tab is rendered (see paintViews).                       */
let _bootDriven = false;               // true → init() must not start its own loadAll()
const PERF = { t: {}, mark(k) { if (!(k in this.t)) this.t[k] = Math.round(performance.now()); } };

/* ==========================================================================
 * PV system (Fronius inverter): live energy flow, today, history, devices,
 * setup. Data comes from the bridge (/api/fronius live every 10 s while the
 * Übersicht or PV tab is open, /api/pv for the history).
 * ========================================================================== */
const PVR_DAYS_KEY = 'pvr_days_v1';              // UI preference, not synced
let _frBusy = false, _pvBusy = false, _pvAgain = false;

function kwOrW(w) {
  if (w == null) return '–';
  const a = Math.abs(w);
  return a >= 1000 ? fmt(w / 1000, a >= 10000 ? 0 : 1) + ' kW' : fmt(w, 0) + ' W';
}
function pctOf(x, d = 0) { return x == null ? '–' : fmt(x * 100, d) + ' %'; }
function dayLabel(s) { return s ? s.slice(8, 10) + '.' + s.slice(5, 7) + '.' : ''; }

function pvStatusTag(F) {
  if (!F) return '';
  if (F.demo) return '<span style="color:var(--warn)">◆ Demo</span>';
  if (F.ok && F.last_poll) {
    const age = Math.max(0, (F.server_time || F.last_poll) - F.last_poll);
    return `<span style="color:#4be0b0">● live</span> <span style="color:var(--muted)">· ${age < 90 ? age + ' s' : Math.round(age / 60) + ' min'}</span>`;
  }
  if (F.error) return '<span style="color:#ff6b8a">● keine Verbindung</span>';
  return '<span style="color:var(--muted)">◦ verbinde …</span>';
}

// Who supplies whom right now. PV covers the house first, then charges the
// battery, the rest goes into the grid; the grid covers what is left.
function pvFlowParts(f) {
  const pv = Math.max(0, (f && f.pv_w) || 0);
  const load = f ? f.load_w : null, grid = f ? f.grid_w : null, batt = f ? f.batt_w : null;
  const ch = batt != null ? Math.max(0, -batt) : 0, dis = batt != null ? Math.max(0, batt) : 0;
  const imp = grid != null ? Math.max(0, grid) : 0, exp = grid != null ? Math.max(0, -grid) : 0;
  const pvBatt = Math.min(pv, ch);
  const pvGrid = Math.min(pv - pvBatt, exp);
  const pvHouse = Math.max(0, pv - pvBatt - pvGrid);
  // charging beyond what the sun delivers comes from the grid (e.g. a GEN24
  // 'charge boost' at a very low charge level); feed-in beyond the sun's share
  // comes from the battery
  const gridBatt = grid != null ? Math.max(0, Math.min(ch - pvBatt, imp)) : 0;
  const battGrid = Math.max(0, Math.min(dis, exp - pvGrid));
  const battHouse = Math.max(0, dis - battGrid);
  // what the house gets from the grid – the rest of the import are the
  // inverter's conversion losses while it charges the battery
  let gridHouse = Math.max(0, imp - gridBatt);
  if (load != null) gridHouse = Math.min(gridHouse, Math.max(0, load - pvHouse - battHouse));
  return { pv, load, ch, dis, imp, exp, pvBatt, pvGrid, pvHouse, gridBatt, battGrid, gridHouse, battHouse,
           hasBatt: batt != null || (f && f.soc != null), hasMeter: !!(f && f.has_meter) };
}

function pvFlowSvg(f, hpW) {
  const P = pvFlowParts(f);
  const showHp = hpW != null && P.hasMeter;
  const gb = P.hasBatt && P.hasMeter && (P.gridBatt > 25 || P.battGrid > 25);   // grid <-> battery now
  const H = showHp ? 262 : (gb ? 214 : 204);
  const node = (x, y, col, icon, l1, l2, anchor, l3) => {
    const tx = anchor === 'start' ? x + 32 : anchor === 'end' ? x - 32 : x;
    const ty = anchor ? y - 3 : y + 42;
    return `<circle cx="${x}" cy="${y}" r="25" fill="var(--card2)" stroke="${col}" stroke-width="2.2"/>` +
      `<text x="${x}" y="${y + 7}" text-anchor="middle" font-size="19">${icon}</text>` +
      `<text x="${tx}" y="${ty}" text-anchor="${anchor || 'middle'}" font-size="13.5" font-weight="700" style="fill:var(--ink)">${l1}</text>` +
      (l2 ? `<text x="${tx}" y="${ty + 15}" text-anchor="${anchor || 'middle'}" font-size="11" style="fill:var(--muted)">${l2}</text>` : '') +
      (l3 ? `<text x="${tx}" y="${ty + 29}" text-anchor="${anchor || 'middle'}" font-size="11" font-weight="700" style="fill:#ff6b8a">${l3}</text>` : '');
  };
  const line = (d, w, col) => {
    const on = w > 25;
    const dur = on ? Math.max(0.45, Math.min(2.6, 2.9 - Math.log10(w) * 0.62)).toFixed(2) : 0;
    return `<path d="${d}" fill="none" stroke="var(--line)" stroke-width="3" stroke-linecap="round"/>` +
      (on ? `<path class="flowln" d="${d}" stroke="${col}" stroke-width="${Math.min(6, 2.6 + w / 2500).toFixed(1)}" style="animation-duration:${dur}s"/>` : '');
  };
  const gridCol = P.imp > 25 ? '#ff6b8a' : (P.exp > 25 ? '#4be0b0' : 'var(--muted)');
  let g = line('M180 66 L180 102', P.pvHouse, COL.heat);
  if (P.hasMeter) g += line('M202 52 Q278 60 294 102', P.pvGrid, COL.heat) + line('M274 128 L206 128', P.gridHouse, '#ff6b8a');
  if (P.hasBatt) g += line('M158 52 Q82 60 66 102', P.pvBatt, COL.heat) + line('M86 128 L154 128', P.battHouse, COL.batt);
  // grid <-> battery (only drawn while it happens): an arc over the house
  if (gb) g += P.gridBatt >= P.battGrid ? line('M281 111 Q180 72 79 111', P.gridBatt, '#ff6b8a')
    : line('M79 111 Q180 72 281 111', P.battGrid, COL.batt);
  if (showHp) g += line('M199 146 Q236 196 276 214', hpW, COL.hp);
  g += node(180, 40, COL.heat, '☀️', kwOrW(P.pv), 'Sonne', 'start');
  g += node(180, 128, COL.sh, '🏠', P.load != null ? kwOrW(P.load) : '–', 'Haus');
  if (P.hasMeter) g += node(300, 128, gridCol, '🔌', P.imp > 25 ? kwOrW(P.imp) : (P.exp > 25 ? kwOrW(P.exp) : '0 W'),
    P.imp > 25 ? 'Bezug' : (P.exp > 25 ? 'Einspeisung' : 'Netz'));
  if (P.hasBatt) g += node(60, 128, COL.batt, '🔋', f.soc != null ? fmt(f.soc, 0) + ' %' : '–',
    P.ch > 25 ? 'lädt ' + kwOrW(P.ch) : (P.dis > 25 ? 'liefert ' + kwOrW(P.dis) : 'Ruhe'), undefined,
    P.gridBatt > 25 ? 'aus dem Netz' : (P.battGrid > 25 ? 'ins Netz' : ''));
  if (showHp) g += node(300, 226, COL.hp, '♨️', kwOrW(hpW), 'Wärmepumpe', 'end');
  return `<svg viewBox="0 0 360 ${H}" style="width:100%;height:auto;max-width:460px;display:block;margin:0 auto" role="img" aria-label="Energiefluss">${g}</svg>`;
}
// heat-pump electrical power right now (HomeCom), for the flow picture
function hpLiveW() {
  const l = STATE.hpA && STATE.hpA.live;
  if (l && l.power_w != null) return l.power_w;
  return (STATE.ov && STATE.ov.now && STATE.ov.now.heatpump_w != null) ? STATE.ov.now.heatpump_w : null;
}

function pvTodayKpis(T, L, MNY) {
  const d = T && T.today;
  if (!d) return '<div class="note">Heute noch keine gespeicherten Werte – die Bridge speichert ab der Verbindung jede Minute einen Wert.</div>';
  const tile = (v, l) => `<div><b>${v}</b><small>${l}</small></div>`;
  let h = tile(kwh(d.pv_kwh, d.pv_kwh < 10 ? 2 : 1), 'PV heute');
  if (d.load_kwh != null) {
    h += tile(pctOf(d.autarky), 'Autarkie') + tile(pctOf(d.self_rate), 'Eigenverbrauch') +
      tile(kwh(d.exp_kwh, 1), 'eingespeist') + tile(kwh(d.imp_kwh, 1), 'Netzbezug') +
      tile(money(d.saved_eur), 'gespart heute' + (d.feed_eur ? ` <span style="opacity:.8">(${eur(d.self_eur)} + ${eur(d.feed_eur)} Einsp.)</span>` : ''));
    if (MNY && MNY.month && MNY.month.days > 1) h += tile(money(MNY.month.saved_eur), 'gespart diesen Monat');
    if (MNY && MNY.total && MNY.total.days > ((MNY.month && MNY.month.days) || 0))
      h += tile(money(MNY.total.saved_eur), `gespart seit ${new Date(MNY.since * 1000).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric', year: '2-digit' })}`);
  }
  if (d.ch_grid_kwh != null && d.ch_grid_kwh >= 0.05) h += tile(kwh(d.ch_grid_kwh, d.ch_grid_kwh < 10 ? 2 : 1), 'Batterie aus dem Netz geladen');
  if (d.hp_sun_share != null) h += tile(pctOf(d.hp_sun_share), 'WP-Strom von der Sonne');
  if (L && L.soc != null) h += tile(fmt(L.soc, 0) + ' %', 'Batterie' + (d.soc_min != null ? ` · heute ${fmt(d.soc_min, 0)}–${fmt(Math.max(d.soc_max, L.soc), 0)} %` : ''));
  return `<div class="pvk">${h}</div>`;
}

function pvHint(L, F) {
  if (!L) return F && F.error ? `⚠︎ ${escIp(F.error)}` : '';
  if (!L.has_meter) return 'Ohne <b>Smart Meter</b> sieht der Wechselrichter nur die <b>Erzeugung</b> – Verbrauch, Einspeisung und Autarkie lassen sich dann nicht zeigen.';
  const P = pvFlowParts(L);
  if (P.gridBatt > 100) return `🔋 Die Batterie lädt gerade <b>aus dem Netz</b> (${kwOrW(P.gridBatt)})` +
    (L.battery_mode ? ` – der Wechselrichter meldet „${esc(L.battery_mode)}“` : '') +
    (L.soc != null && L.soc < 15 ? `. Bei ${fmt(L.soc, 0)} % Ladestand vermutlich eine Schutzladung, damit sie nicht tiefentladen wird` : '') +
    '. Diesen Strom zahlst du zum Netzpreis.';
  if (P.battGrid > 300) return `🔋 Die Batterie gibt gerade <b>${kwOrW(P.battGrid)}</b> ins Netz ab` +
    (L.battery_mode ? ` – der Wechselrichter meldet „${esc(L.battery_mode)}“` : '') + '. Das steuert der Wechselrichter selbst.';
  if (P.pvGrid > 1500) return `☀️ Gerade gehen <b>${kwOrW(P.pvGrid)}</b> Sonnenstrom ins Netz – guter Moment für Waschmaschine, Spülmaschine oder das E-Auto.`;
  if (P.ch > 800 && (L.soc == null || L.soc < 97)) return `🔋 Der Überschuss lädt gerade die Batterie (${kwOrW(P.ch)}).`;
  if (P.pv < 30 && P.dis > 100) return '🌙 Die Batterie versorgt gerade das Haus.';
  if (P.imp > 1000 && L.soc != null && L.soc <= 10) return `🔌 Batterie leer – ${kwOrW(P.imp)} kommen gerade aus dem Netz.`;
  return '';
}

// today in 15-min steps: PV (amber), house (blue), directly covered (green
// area), battery charge level (violet, right axis 0–100 %)
function pvRealDayChart(series) {
  const h = 200, pad = 30, padR = 30, top = 12, base = h - 22, n = 96;
  const mid = new Date(); mid.setHours(0, 0, 0, 0);
  const t0 = mid.getTime() / 1000;
  const pts = new Array(n).fill(null);
  (series || []).forEach(p => { const i = Math.round((p.t - t0) / 900); if (i >= 0 && i < n) pts[i] = p; });
  const sc = niceScale(Math.max(0.1, ...(series || []).map(p => Math.max(p.pv_w || 0, p.load_w || 0) / 1000)));
  const max = sc.max;
  const X = i => pad + (CW - pad - padR) * (i / (n - 1));
  const Y = w => top + (base - top) * (1 - Math.max(0, w / 1000) / max);     // w in W, axis in kW
  const Ys = s => top + (base - top) * (1 - s / 100);
  const path = (key, yf) => {
    let d = '', open = false;
    pts.forEach((p, i) => {
      const v = p ? p[key] : null;
      if (v == null) { open = false; return; }
      d += `${open ? 'L' : 'M'}${X(i).toFixed(1)} ${yf(v).toFixed(1)} `; open = true;
    });
    return d;
  };
  let area = '';
  let run = [];
  const flush = () => {
    if (run.length > 1) area += `M${X(run[0][0]).toFixed(1)} ${base} ` + run.map(([i, v]) => `L${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ') +
      ` L${X(run[run.length - 1][0]).toFixed(1)} ${base} Z `;
    run = [];
  };
  pts.forEach((p, i) => { if (p && p.load_w != null) run.push([i, Math.min(p.pv_w || 0, p.load_w)]); else flush(); });
  flush();
  let labels = '';
  for (let hh = 0; hh <= 24; hh += 3) labels += `<text class="axis" x="${X(Math.min(n - 1, hh * 4)).toFixed(1)}" y="${h - 8}" text-anchor="middle">${hh}</text>`;
  let socAx = '';
  if (pts.some(p => p && p.soc != null)) {
    [0, 50, 100].forEach(sv => { socAx += `<text class="axis" x="${CW - padR + 4}" y="${(Ys(sv) + 3).toFixed(1)}" style="fill:${COL.batt}">${sv}%</text>`; });
  }
  const now = Math.min(n - 1, Math.max(0, Math.round((Date.now() / 1000 - t0) / 900)));
  const tips = pts.map((p, i) => {
    const hh = String(Math.floor(i / 4)).padStart(2, '0') + ':' + String((i % 4) * 15).padStart(2, '0');
    if (!p) return `<b>${hh}</b> – ${i > now ? 'kommt noch' : 'keine Daten'}`;
    const gridTxt = p.grid_w == null ? '' : ` · 🔌 ${p.grid_w >= 0 ? 'Bezug ' + kwOrW(p.grid_w) : 'Einspeisung ' + kwOrW(-p.grid_w)}`;
    return `<b>${hh}</b> · ☀️ ${kwOrW(p.pv_w)}${p.load_w != null ? ' · 🏠 ' + kwOrW(p.load_w) : ''}${gridTxt}` +
      (p.batt_w != null ? ` · 🔋 ${p.batt_w < 0 ? 'lädt ' + kwOrW(-p.batt_w) +
        (p.grid_w != null && p.load_w != null && p.grid_w > p.load_w + 25 ? ' aus dem Netz' : '') : (p.batt_w > 0 ? 'liefert ' + kwOrW(p.batt_w) : 'Ruhe')}` : '') +
      (p.soc != null ? ` (${fmt(p.soc, 0)} %)` : '');
  });
  return svg(h, gridLines(h, top, base, pad, max, { step: sc.step, unit: 'kW' }) +
    (area ? `<path d="${area}" fill="${COL.pv}" opacity="0.28"/>` : '') +
    `<path d="${path('pv_w', Y)}" fill="none" stroke="${COL.heat}" stroke-width="2.4" stroke-linejoin="round"/>` +
    `<path d="${path('load_w', Y)}" fill="none" stroke="${COL.sh}" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="${path('soc', Ys)}" fill="none" stroke="${COL.batt}" stroke-width="1.6" stroke-dasharray="4 3"/>` +
    `<line x1="${X(now).toFixed(1)}" y1="${top}" x2="${X(now).toFixed(1)}" y2="${base}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3" opacity=".6"/>` +
    labels + socAx, { kind: 'area', pad, padR, n, h, tips });
}

/* ---- Übersicht: energy-flow card ------------------------------------------ */
function renderFlow() {
  const card = $('ov-flow-card'); if (!card) return;
  const F = STATE.fr;
  if (!F || !F.connected) { card.hidden = true; return; }
  card.hidden = false;
  $('ov-flow-head').innerHTML = pvStatusTag(F);
  $('ov-flow').innerHTML = F.live ? pvFlowSvg(F.live, hpLiveW())
    : `<div class="note">${F.error ? '⚠︎ ' + escIp(F.error) : 'Warte auf die erste Messung des Wechselrichters …'}</div>`;
  $('ov-flow-kpi').innerHTML = pvTodayKpis(F.today, F.live, F.money);
  $('ov-flow-note').innerHTML = pvHint(F.live, F);
}

/* ---- PV tab: the real installation ---------------------------------------- */
function renderPvReal() {
  const F = STATE.fr, card = $('pvr-card'); if (!card) return;
  const on = !!(F && F.connected);
  ['pvr-card', 'pvr-hist-card', 'pvr-dev-card'].forEach(id => { const c = $(id); if (c) c.hidden = !on; });
  if (!on) {
    ['pvr-str-card', 'pvr-chk-card'].forEach(id => { const c = $(id); if (c) c.hidden = true; });
    const pr = $('pv-plan-real'); if (pr) pr.hidden = true; return;
  }
  $('pvr-head').innerHTML = pvStatusTag(F);
  $('pvr-flow').innerHTML = F.live ? pvFlowSvg(F.live, hpLiveW())
    : `<div class="note">${F.error ? '⚠︎ ' + escIp(F.error) : 'Warte auf die erste Messung des Wechselrichters …'}</div>`;
  $('pvr-today').innerHTML = pvTodayKpis(F.today, F.live, F.money);
  const ser = (F.today && F.today.series) || [];
  $('pvr-day').innerHTML = ser.length ? pvRealDayChart(ser) : '<div class="note">Der Tagesverlauf füllt sich ab der ersten gespeicherten Minute.</div>';
  $('pvr-day-legend').innerHTML = ser.length ? legendHtml([
    { label: 'PV-Erzeugung', color: COL.heat }, { label: 'Verbrauch Haus', color: COL.sh },
    { label: 'direkt mit Sonne gedeckt', color: COL.pv }].concat(ser.some(p => p.soc != null) ? [{ label: 'Batterie-Ladestand', color: COL.batt }] : [])) : '';
  const pr = $('pv-plan-real'); if (pr) pr.hidden = false;
  const since = F.today && F.today.since;
  $('pvr-note').innerHTML = [pvHint(F.live, F),
    since ? `Gespeichert seit ${new Date(since * 1000).toLocaleDateString('de-DE')} (Minutenwerte; ${F.demo ? 'Demo-Daten' : 'der Wechselrichter selbst liefert keine abrufbare Historie'}).` : ''].filter(Boolean).join('<br>');
  renderPvDevices();
  renderPvStrings();
  if (!STATE.pv || STATE.pv.days !== STATE.pvDays || Date.now() - (STATE.pvAt || 0) > 120000) loadPvHist();
  else paintPvHist();
}

async function loadPvHist(force) {
  if (_pvBusy) { _pvAgain = true; return; }
  _pvBusy = true;
  const days = STATE.pvDays || 30;
  try {
    const r = await api('/api/pv?days=' + days);
    if (r && r.ok) { STATE.pv = r; STATE.pvAt = Date.now(); }
  } catch (e) { /* keep the last result */ }
  finally { _pvBusy = false; }
  if (_pvAgain) { _pvAgain = false; return loadPvHist(true); }
  paintPvHist();
}

function paintPvHist() {
  const R = STATE.pv, F = STATE.fr || {}, kp = $('pvr-kpi'); if (!kp || !R) return;
  const ids = ['pvr-daily', 'pvr-daily-legend', 'pvr-src', 'pvr-src-legend', 'pvr-typ', 'pvr-typ-legend', 'pvr-months', 'pvr-hist-note'];
  if (R.empty) {
    kp.innerHTML = '<div class="note">Im Zeitraum gibt es noch keine gespeicherten Werte – die Bridge speichert ab der Verbindung jede Minute einen Wert.</div>';
    ids.forEach(id => { const e = $(id); if (e) e.innerHTML = ''; });
    $('pvr-hist-head').textContent = '';
    renderPvStrings(); renderPvChecks();
    return;
  }
  const T = R.totals, meter = R.has_meter;
  const cap = F.details && F.details.storage && F.details.storage.capacity_wh;
  const tile = (v, l) => `<div><b>${v}</b><small>${l}</small></div>`;
  let k = tile(kwh(T.pv_kwh, T.pv_kwh < 100 ? 1 : 0), 'PV-Erzeugung');
  if (meter) k += tile(pctOf(T.self_rate), 'Eigenverbrauch') + tile(pctOf(T.autarky), 'Autarkie') + tile(money(T.saved_eur), 'gespart') +
    tile(kwh(T.exp_kwh, 0), 'eingespeist') + tile(kwh(T.imp_kwh, 0), 'Netzbezug');
  if (T.hp_sun_share != null) k += tile(pctOf(T.hp_sun_share), 'WP-Strom von der Sonne');
  if (T.dis_kwh != null && cap) k += tile(fmt(T.dis_kwh / (cap / 1000), 0), 'Batterie-Vollzyklen');
  kp.innerHTML = `<div class="pvk">${k}</div>`;
  const first = R.daily.length ? R.daily[0].day : null, last = R.daily.length ? R.daily[R.daily.length - 1].day : null;
  $('pvr-hist-head').innerHTML = first ? `<span style="color:var(--muted)">${dayLabel(first)}–${dayLabel(last)}</span>` : '';
  // daily bars (monthly for the year view)
  const useMonths = R.days > 120;
  const items = useMonths ? R.monthly.map(m => Object.assign({}, m, { label: MON[+m.month.slice(5, 7) - 1], full: MON[+m.month.slice(5, 7) - 1] + ' ' + m.month.slice(0, 4) }))
    : R.daily.map(d => Object.assign({}, d, { label: dayLabel(d.day).slice(0, 3), full: longDay(d.day) + (d.gap_h > 0.5 ? ` · ⚠︎ ${fmt(d.gap_h, 1)} h Datenlücke` : '') }));
  const unit = 'kWh';
  if (meter) {
    const sDst = [{ key: 'direct', color: COL.pv, label: 'direkt verbraucht' }]
      .concat(R.has_battery ? [{ key: 'batt', color: COL.batt, label: 'in die Batterie' }] : [])
      .concat([{ key: 'feed', color: COL.heat, label: 'eingespeist' }]);
    $('pvr-daily').innerHTML = stackedBar(items.map(d => ({ label: d.label, full: d.full,
      values: { direct: d.direct_kwh || 0, batt: (d.ch_pv_kwh != null ? d.ch_pv_kwh : d.ch_kwh) || 0, feed: d.exp_kwh || 0 } })), sDst, { h: 190, unit });
    $('pvr-daily-legend').innerHTML = legendHtml(sDst.map(s => ({ label: s.label, color: s.color })));
    const sSrc = [{ key: 'sun', color: COL.pv, label: 'eigener Strom (Sonne + Batterie)' }, { key: 'grid', color: '#ff6b8a', label: 'aus dem Netz' }];
    $('pvr-src').innerHTML = stackedBar(items.map(d => ({ label: d.label, full: d.full,
      // import beyond the consumption went into the battery (grid charging) – not into the house
      values: { sun: Math.max(0, (d.load_kwh || 0) - (d.imp_kwh || 0)), grid: Math.min(d.imp_kwh || 0, d.load_kwh || 0) } })), sSrc, { h: 190, unit });
    $('pvr-src-legend').innerHTML = legendHtml(sSrc.map(s => ({ label: s.label, color: s.color })));
  } else {
    const sPv = [{ key: 'pv', color: COL.heat, label: 'PV-Erzeugung' }];
    $('pvr-daily').innerHTML = stackedBar(items.map(d => ({ label: d.label, full: d.full, values: { pv: d.pv_kwh || 0 } })), sPv, { h: 190, unit });
    $('pvr-daily-legend').innerHTML = legendHtml(sPv);
    $('pvr-src').innerHTML = '<div class="note">Ohne Smart Meter keine Aufteilung nach Netz und eigenem Strom.</div>';
    $('pvr-src-legend').innerHTML = '';
  }
  const hr = R.hourly || [];
  $('pvr-typ').innerHTML = hr.length === 24 ? pvDayChart(hr.map(x => (x.pv_w || 0) / 1000), hr.map(x => (x.load_w || 0) / 1000), { nice: true, unit: 'kW' }) : '';
  $('pvr-typ-legend').innerHTML = legendHtml([{ label: 'PV (kW, Ø je Stunde)', color: COL.heat }]
    .concat(meter ? [{ label: 'Verbrauch (kW)', color: COL.sh }, { label: 'direkt gedeckt', color: COL.pv }] : []));
  // months, with the expected yield from the planner / PVGIS where known
  // yearly yield per kWp: from the orientation of the strings when both are
  // entered (more exact for e.g. south-east + west), else from the planner / PVGIS
  const sCfg = pvStrCfg(), sK = pvStrKwp(sCfg, R.strings, F);
  const fromStr = !!(sK && sCfg[0].az && sCfg[1].az);
  const spec = fromStr ? (sK.k[0] * PV_AZ_SPEC[sCfg[0].az] + sK.k[1] * PV_AZ_SPEC[sCfg[1].az]) / (sK.k[0] + sK.k[1])
    : parseFloat(($('pv-orient') || {}).value) || 0;
  const kwpReal = F.identity && F.identity.pv_power_w ? F.identity.pv_power_w / 1000 : (parseFloat(($('pv-kwp') || {}).value) || 0);
  const shape = pvMonth();
  const exp = m => {
    if (!spec || !kwpReal) return null;
    const y = +m.month.slice(0, 4), mo = +m.month.slice(5, 7);
    const dim = new Date(y, mo, 0).getDate();
    // complete days with data, weighted by the sun hours they cover (a day
    // that starts at 22:00 counts ~0, not as a whole day)
    const cov = m.pv_days != null ? m.pv_days : R.daily.filter(d => d.day.startsWith(m.month)).length;
    return spec * kwpReal * shape[mo - 1] * cov / dim;
  };
  const showExp = spec && kwpReal;
  $('pvr-months').innerHTML = R.monthly.length ? `<table class="pvt"><tr><th>Monat</th><th>PV kWh</th>${showExp ? '<th>Erwartung</th>' : ''}` +
    (meter ? '<th>Eigen&shy;verbr.</th><th>Autarkie</th><th>gespart</th>' : '') + '</tr>' +
    R.monthly.map(m => {
      const e = exp(m);
      const dev = e ? (m.pv_kwh / e - 1) : null;
      const part = m.days < new Date(+m.month.slice(0, 4), +m.month.slice(5, 7), 0).getDate();
      return `<tr><td>${MON[+m.month.slice(5, 7) - 1]} ${m.month.slice(2, 4)}${part ? `<br><small style="color:var(--muted)">${m.days} Tage</small>` : ''}</td>` +
        `<td>${fmt(m.pv_kwh, 0)}</td>` +
        (showExp ? `<td>${e ? fmt(e, 0) : '–'}${dev != null ? `<br><small style="color:${dev >= -0.15 ? '#4be0b0' : '#ffb64d'}">${dev >= 0 ? '+' : '−'}${fmt(Math.abs(dev) * 100, 0)} %</small>` : ''}</td>` : '') +
        (meter ? `<td>${pctOf(m.self_rate)}</td><td>${pctOf(m.autarky)}</td><td>${m.saved_eur != null ? fmt(m.saved_eur, 0) + ' ' + STATE.cur : '–'}</td>` : '') + '</tr>';
    }).join('') + '</table>' : '';
  const gaps = R.daily.filter(d => d.gap_h > 0.5).length;
  const feed = (R.feedin || 0) * 100;
  $('pvr-hist-note').innerHTML = [
    meter ? `<b>Gespart</b> = (Verbrauch − Netzbezug) × ${fmt((R.price || 0) * 100, 1)} ct + Einspeisung × ${fmt(feed, 2)} ct ` +
      `(Strompreis aus dem Setup, Vergütung aus dem PV-Planer – <a href="#" data-pvr-feed="1" style="color:var(--accent)">ändern</a>).` : '',
    meter ? 'Bezug und Einspeisung stammen aus den <b>Zählerständen des Smart Meters</b> (exakt); Tage mit Datenlücke aus den Messwerten.' : '',
    gaps ? `⚠︎ ${gaps} Tag(e) mit Datenlücke (Bridge oder Wechselrichter nicht erreichbar) – deren Werte sind unvollständig.` : '',
    showExp ? `<b>Erwartung</b> = ${fmt(spec, 0)} kWh/kWp (` +
      (fromStr ? 'aus der Ausrichtung der Strings: ' + [0, 1].map(i => `${PV_AZ_LABEL[sCfg[i].az]} ${fmt(sK.k[i], 1)} kWp × ${PV_AZ_SPEC[sCfg[i].az]}`).join(', ')
        : 'Planer' + ($('pv-orient') && $('pv-orient').selectedOptions[0] && $('pv-orient').selectedOptions[0].dataset.pvgis ? ', PVGIS' : '')) +
      `) × ${fmt(kwpReal, 2)} kWp × Monatsanteil, auf die erfassten Sonnenstunden gerechnet (ein angefangener Tag zählt anteilig) – das Wetter schwankt von Jahr zu Jahr um ±15 %.` : '',
    T.hp_sun_share != null ? '<b>WP-Strom von der Sonne</b>: der Wärmepumpe wird je 5 Minuten derselbe Anteil Sonnen- bzw. Batteriestrom zugeordnet wie dem ganzen Haus (anteilige Rechnung).' : '',
  ].filter(Boolean).join('<br>');
  renderPvStrings();
  renderPvChecks();
}

function renderPvDevices() {
  const F = STATE.fr, body = $('pvr-dev'); if (!body || !F) return;
  const I = F.identity || {}, D = F.details || {}, L = F.live || {};
  const inv = pvInv1(F);
  const sub = t => `<small style="color:var(--muted)">${t}</small>`;
  const H = t => `<h2 style="font-size:14px;margin:14px 0 6px">${t}</h2>`;
  const stTxt = inv.state_de || ((I.inverters || [])[0] || {}).state_de;
  $('pvr-dev-head').innerHTML = stTxt ? `<span style="color:${/Betrieb/.test(stTxt) ? '#4be0b0' : 'var(--muted)'}">${esc(stTxt)}</span>` : '';
  let h = H('🔌 Wechselrichter') + [
    statusRow('Gerät', esc(I.name || 'Fronius') + (I.type && I.type !== I.name ? ' ' + sub(esc(I.type)) : '')),
    statusRow('Zustand', esc(inv.state_de || ((I.inverters || [])[0] || {}).state_de || '–')),
    I.pv_power_w ? statusRow('PV-Leistung installiert', fmt(I.pv_power_w / 1000, 2) + ' kWp') : '',
    statusRow('AC-Leistung jetzt', inv.pac_w != null && inv.pac_w < -25
      // negative: the inverter draws from the house grid (charging the battery or its own standby)
      ? 'bezieht ' + kwOrW(-inv.pac_w) + ' ' + sub(pvFlowParts(L).ch > 25 ? 'aus dem Hausnetz – lädt die Batterie' : 'aus dem Hausnetz (Eigenbedarf)')
      : kwOrW(inv.pac_w != null ? inv.pac_w : null)),
    inv.uac_v != null ? statusRow('Netzspannung · Frequenz', fmt(inv.uac_v, 1) + ' V · ' + fmt(inv.fac_hz, 2) + ' Hz') : '',
    inv.total_wh != null ? statusRow('AC-Abgabe seit Inbetriebnahme ' + sub('Zähler E-Total'), kwh(inv.total_wh / 1000, inv.total_wh < 100000 ? 1 : 0)) : '',
    L.mode_de ? statusRow('Betriebsart', esc(L.mode_de)) : '',
    F.host ? statusRow('Adresse', ipTag(F.host)) : '',
  ].join('');
  const st = inv.strings || [];
  if (st.length) {
    const td = F.today && F.today.strings;
    const kwhToday = [td && td.today_mpp1_kwh, td && td.today_mpp2_kwh];
    h += H('🧵 Strings (MPP-Tracker)') + `<table class="pvt"><tr><th>String</th><th>Spannung</th><th>Strom</th><th>Leistung</th><th>heute</th></tr>` +
      // by tracker number: an empty slot is left out, so the list index is not the tracker
      st.map(s => `<tr><td>${s.n}</td><td>${s.u_v != null ? fmt(s.u_v, 0) + ' V' : '–'}</td><td>${s.i_a != null ? fmt(s.i_a, 2) + ' A' : '–'}</td>` +
        `<td>${kwOrW(s.p_w)}</td><td>${kwhToday[s.n - 1] != null ? kwh(kwhToday[s.n - 1], 1) : '–'}</td></tr>`).join('') + '</table>' +
      (st.length > 1 ? '<div class="note" style="margin-top:6px">Vergleich der Strings über Tage, je kWp und mit Bewertung: Karte <b>🧵 String-Vergleich</b> weiter oben.</div>' : '');
  }
  const B = D.storage;
  if (B || L.soc != null) {
    const P = pvFlowParts(L);
    h += H('🔋 Batterie') + [
      B && (B.manufacturer || B.model) ? statusRow('Modell', esc([B.manufacturer, B.model].filter(Boolean).join(' '))) : '',
      B && B.capacity_wh ? statusRow('Kapazität', kwh(B.capacity_wh / 1000, 1)) : '',
      statusRow('Ladestand', L.soc != null ? fmt(L.soc, 0) + ' %' : (B && B.soc != null ? fmt(B.soc, 0) + ' %' : '–')),
      statusRow('gerade', P.ch > 25 ? 'lädt mit ' + kwOrW(P.ch) + (P.gridBatt > 25 ? ' <b>aus dem Netz</b>' : (P.pvBatt > 25 ? ' von der Sonne' : ''))
        : (P.dis > 25 ? 'liefert ' + kwOrW(P.dis) + (P.battGrid > 25 ? ' (davon ' + kwOrW(P.battGrid) + ' ins Netz)' : '') : 'Ruhe')),
      B && B.temp_c != null ? statusRow('Zelltemperatur', fmt(B.temp_c, 1) + ' °C') : '',
      B && B.u_v != null ? statusRow('Spannung · Strom', fmt(B.u_v, 0) + ' V' + (B.i_a != null ? ' · ' + fmt(Math.abs(B.i_a), 2) + ' A' : '')) : '',
      L.battery_mode ? statusRow('Modus (Wechselrichter)', esc(L.battery_mode_de || L.battery_mode) +
        (L.battery_mode_de && L.battery_mode_de.toLowerCase() !== String(L.battery_mode).toLowerCase() ? ' ' + sub('„' + esc(L.battery_mode) + '“') : '')) : '',
    ].join('');
  }
  (D.meters || []).forEach(m => {
    const pw = m.p_w;
    h += H('📟 Smart Meter' + (m.location !== 'grid' ? ' · ' + esc(m.location_de) : '')) + [
      statusRow('Modell', esc([m.manufacturer, m.model].filter(Boolean).join(' ') || '–')),
      statusRow('Einbauort', esc(m.location_de || '–')),
      pw != null ? statusRow('jetzt', m.location === 'grid' ? (pw >= 0 ? 'Bezug ' + kwOrW(pw) : 'Einspeisung ' + kwOrW(-pw)) : kwOrW(pw)) : '',
      m.location === 'grid' && m.import_wh != null ? statusRow('Zählerstand Bezug', kwh(m.import_wh / 1000, 1)) : '',
      m.location === 'grid' && m.export_wh != null ? statusRow('Zählerstand Einspeisung', kwh(m.export_wh / 1000, 1)) : '',
      m.freq_hz != null ? statusRow('Netzfrequenz', fmt(m.freq_hz, 2) + ' Hz') : '',
    ].join('');
    const ph = m.phases || [];
    if (ph.length) {
      const hasPf = ph.some(p => p.pf != null);
      h += `<table class="pvt" style="margin-top:6px"><tr><th>Phase</th><th>Leistung</th><th>Strom</th><th>Spannung</th>${hasPf ? '<th>cos φ</th>' : ''}</tr>` +
        ph.map(p => `<tr><td>L${p.n}</td><td>${kwOrW(p.p_w)}</td><td>${p.i_a != null ? fmt(p.i_a, 1) + ' A' : '–'}</td>` +
          `<td>${p.u_v != null ? fmt(p.u_v, 0) + ' V' : '–'}</td>${hasPf ? `<td>${p.pf != null ? fmt(Math.abs(p.pf), 2) : '–'}</td>` : ''}</tr>`).join('') + '</table>' +
        `<div class="note" style="margin-top:6px">${m.location === 'grid' ? 'Leistung je Phase: + Bezug, − Einspeisung. ' : ''}` +
        (hasPf ? 'cos φ = wie viel der Leistung tatsächlich genutzt wird (1 = alles); Blindleistung wird Haushalten nicht berechnet. ' : '') +
        'Spannung im Netz: 230 V ± 10 %.</div>';
    }
  });
  (D.ohmpilots || []).forEach(o => {
    h += H('♨️ Ohmpilot') + statusRow('Leistung', kwOrW(o.p_w)) + (o.temp_c != null ? statusRow('Temperatur', fmt(o.temp_c, 1) + ' °C') : '');
  });
  const errs = Object.entries(D.errors || {});
  if (errs.length) h += `<div class="note" style="margin-top:8px">Nicht lesbar: ${errs.map(([k, v]) => esc(k) + ' – ' + escIp(v)).join('; ')}</div>`;
  if (I.pv_power_w) {
    const plan = parseFloat(($('pv-kwp') || {}).value) || 0;
    const real = Math.round(I.pv_power_w / 100) / 10;
    if (Math.abs(plan - real) >= 0.05)
      h += `<button class="btn sec" data-pvr-kwp="${real}" style="margin-top:10px">☀️ ${fmt(real, 1)} kWp in den PV-Planer übernehmen</button>`;
  }
  if (F.demo) h += '<div class="note" style="margin-top:8px">Demo-Anlage: alle Werte sind simuliert.</div>';
  body.innerHTML = h;
}

/* ---- PV tab: string comparison (MPP trackers) ------------------------------ */
const PVSTR_KEY = 'bhe_pv_strings';             // synced: [{name, mods, kwp, az}] per MPP tracker
const PVSTR_NORM_KEY = 'pvr_str_norm';          // UI preference on this device: curves per kWp
const PV_AZ = { O: -90, SO: -45, S: 0, SW: 45, W: 90, NO: -135, NW: 135, N: 180 };
const PV_AZ_LABEL = { '': 'unbekannt', O: 'Ost', SO: 'Südost', S: 'Süd', SW: 'Südwest', W: 'West',
  NO: 'Nordost', NW: 'Nordwest', N: 'Nord', F: 'flach' };
const STR_COL = ['#f6b93b', '#38bdd8'];         // string 1 amber, string 2 turquoise
// typical yearly yield in Germany per kWp by orientation (30–35° roof; flat ≈ 10–15°)
const PV_AZ_SPEC = { S: 1000, SO: 950, SW: 950, O: 840, W: 840, NO: 680, NW: 680, N: 600, F: 870 };

function medianOf(a) {
  const s = (a || []).filter(x => x != null && isFinite(x)).slice().sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const hmOf = x => { const m = Math.round(x * 60); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const sgnPct = (d, dec = 1) => (d >= 0 ? '+' : '−') + fmt(Math.abs(d) * 100, dec) + ' %';

function pvStrCfg() {
  let a = [];
  try { a = JSON.parse(localStorage.getItem(PVSTR_KEY) || '[]'); } catch (e) { a = []; }
  if (!Array.isArray(a)) a = [];
  return [0, 1].map(i => {
    const c = a[i] && typeof a[i] === 'object' ? a[i] : {};
    return {
      name: typeof c.name === 'string' ? c.name.trim().slice(0, 24) : '',
      mods: +c.mods > 0 ? Math.round(+c.mods) : null,
      kwp: +c.kwp > 0 ? +c.kwp : null,
      az: typeof c.az === 'string' && Object.prototype.hasOwnProperty.call(PV_AZ_LABEL, c.az) ? c.az : '',
    };
  });
}
const pvStrLabel = (i, cfg) => 'String ' + (i + 1) + (cfg && cfg[i] && cfg[i].name ? ' · ' + esc(cfg[i].name) : '');

// installed power per string: entered > from the module counts > estimated
// from the MPP voltages (same modules: the voltage grows with the modules in series)
function pvStrKwp(cfg, S, F) {
  const tot = F && F.identity && F.identity.pv_power_w > 0 ? F.identity.pv_power_w / 1000 : null;
  const [a, b] = cfg;
  if (a.kwp && b.kwp) return { k: [a.kwp, b.kwp], src: 'eingetragen', tot };
  if (tot && (a.kwp || b.kwp)) {
    const k = a.kwp ? [a.kwp, tot - a.kwp] : [tot - b.kwp, b.kwp];
    if (k[0] > 0.2 && k[1] > 0.2) return { k, src: 'eingetragen bzw. Rest der Anlage', tot };
  }
  if (a.mods && b.mods && tot) {
    const m = a.mods + b.mods;
    return { k: [tot * a.mods / m, tot * b.mods / m], src: 'aus der Modulzahl', tot };
  }
  if (tot && S && S.mpp1_u > 50 && S.mpp2_u > 50) {
    const u = S.mpp1_u + S.mpp2_u;
    return { k: [tot * S.mpp1_u / u, tot * S.mpp2_u / u], src: 'geschätzt aus den String-Spannungen', tot, est: true };
  }
  return null;
}

function pvInv1(F) {
  const inv = (F && F.details && F.details.inverters) || {};
  return inv['1'] || Object.values(inv).find(v => v && v.strings && v.strings.length) || {};
}

// right now: one bar per string with voltage, current, share and W per kWp
function pvStrLive(F, cfg, K) {
  const st = (pvInv1(F).strings || []).filter(s => s.n === 1 || s.n === 2);
  if (!st.length) return '<div class="note">Der Wechselrichter meldet gerade keine String-Werte.</div>';
  const tot = st.reduce((a, s) => a + Math.max(0, s.p_w || 0), 0);
  const pmax = Math.max(1, ...st.map(s => Math.max(0, s.p_w || 0)));
  let h = '<div class="strbar">';
  st.forEach(s => {
    const i = s.n - 1, p = Math.max(0, s.p_w || 0);
    h += `<span style="font-weight:650;color:${STR_COL[i]}">${pvStrLabel(i, cfg)}</span>` +
      `<div class="bar"><i style="width:${(p / pmax * 100).toFixed(1)}%;background:${STR_COL[i]}"></i></div>` +
      `<span class="num">${kwOrW(p)}</span>` +
      `<div class="sub">${s.u_v != null ? fmt(s.u_v, 0) + ' V' : '– V'} · ${s.i_a != null ? fmt(s.i_a, 2) + ' A' : '– A'}` +
      (tot > 30 ? ` · ${fmt(p / tot * 100, 0)} %` : '') + (K && tot > 30 ? ` · ${fmt(p / K.k[i], 0)} W/kWp` : '') + '</div>';
  });
  h += '</div>';
  const pv = F.live && F.live.pv_w;
  const when = F.details && F.details.ts ? new Date(F.details.ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
  return h + `<div class="note" style="margin-top:2px">Zusammen <b>${kwOrW(tot)}</b>` +
    (pv != null ? ` · PV laut Energiefluss ${kwOrW(pv)}` : '') +
    (when ? ` · Strings von ${when} Uhr (einmal pro Minute abgefragt)` : '') +
    (tot <= 30 ? ' · nachts bleibt an den Modulen eine kleine Spannung ohne Strom – normal' : '') + '</div>';
}

// today in 15-min steps: one line per string (kW, or W per kWp)
function pvStrDayChart(series, norm, K) {
  const h = 170, pad = 30, padR = 8, top = 12, base = h - 22, n = 96;
  const mid = new Date(); mid.setHours(0, 0, 0, 0);
  const t0 = mid.getTime() / 1000;
  const pts = new Array(n).fill(null);
  (series || []).forEach(p => { const i = Math.round((p.t - t0) / 900); if (i >= 0 && i < n) pts[i] = p; });
  const val = (p, k) => {
    const w = p ? p['mpp' + (k + 1) + '_w'] : null;
    return w == null ? null : (norm ? w / K.k[k] : w / 1000);
  };
  const all = [];
  pts.forEach(p => [0, 1].forEach(k => { const v = val(p, k); if (v != null) all.push(v); }));
  const sc = niceScale(Math.max(norm ? 20 : 0.1, ...all)), max = sc.max;
  const X = i => pad + (CW - pad - padR) * (i / (n - 1));
  const Y = v => top + (base - top) * (1 - Math.max(0, v) / max);
  const path = k => {
    let d = '', open = false;
    pts.forEach((p, i) => {
      const v = val(p, k);
      if (v == null) { open = false; return; }
      d += `${open ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `; open = true;
    });
    return d;
  };
  let labels = '';
  for (let hh = 0; hh <= 24; hh += 3) labels += `<text class="axis" x="${X(Math.min(n - 1, hh * 4)).toFixed(1)}" y="${h - 8}" text-anchor="middle">${hh}</text>`;
  const now = Math.min(n - 1, Math.max(0, Math.round((Date.now() / 1000 - t0) / 900)));
  const f = v => v == null ? '–' : (norm ? fmt(v, 0) + ' W/kWp' : kwOrW(v * 1000));
  const tips = pts.map((p, i) => {
    const hh = String(Math.floor(i / 4)).padStart(2, '0') + ':' + String((i % 4) * 15).padStart(2, '0');
    if (!p || (p.mpp1_w == null && p.mpp2_w == null)) return `<b>${hh}</b> – ${i > now ? 'kommt noch' : 'keine String-Werte'}`;
    const a = p.mpp1_w || 0, b = p.mpp2_w || 0;
    return `<b>${hh}</b> · <span style="color:${STR_COL[0]}">●</span> String 1 ${f(val(p, 0))} · ` +
      `<span style="color:${STR_COL[1]}">●</span> String 2 ${f(val(p, 1))}` +
      (a + b > 30 ? ` · zusammen ${kwOrW(a + b)}` : '');
  });
  return svg(h, gridLines(h, top, base, pad, max, { step: sc.step, unit: norm ? 'W/kWp' : 'kW' }) +
    [0, 1].map(k => `<path d="${path(k)}" fill="none" stroke="${STR_COL[k]}" stroke-width="2.3" stroke-linejoin="round"/>`).join('') +
    `<line x1="${X(now).toFixed(1)}" y1="${top}" x2="${X(now).toFixed(1)}" y2="${base}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="2 3" opacity=".6"/>` +
    labels, { kind: 'area', pad, padR, n, h, tips });
}

// per day (per month for the year view): string 1 and 2 side by side
function pvStrDaily(R, norm, K) {
  const months = R.days > 120;
  const items = months
    ? R.monthly.map(m => ({ label: MON[+m.month.slice(5, 7) - 1], full: MON[+m.month.slice(5, 7) - 1] + ' ' + m.month.slice(0, 4), a: m.mpp1_kwh, b: m.mpp2_kwh }))
    : R.daily.map(d => ({ label: dayLabel(d.day).slice(0, 3), a: d.mpp1_kwh, b: d.mpp2_kwh,
        full: longDay(d.day) + (d.pv_cov != null && d.pv_cov < 0.9 ? ` · nur ${fmt(d.pv_cov * 100, 0)} % der Sonnenstunden erfasst` : '') }));
  const ser = [0, 1].map(k => ({ key: 's' + k, color: STR_COL[k], label: 'String ' + (k + 1) }));
  const rows = items.map(x => ({ label: x.label, full: x.full, values: {
    s0: norm ? (x.a || 0) / K.k[0] : (x.a || 0), s1: norm ? (x.b || 0) / K.k[1] : (x.b || 0) } }));
  return groupedBar(rows, ser, { h: 170, unit: norm ? 'kWh/kWp' : 'kWh', dec: norm ? 2 : 1 });
}

function pvStrTable(R, cfg, K) {
  const S = R.strings; if (!S) return '';
  const e = [S.mpp1_kwh || 0, S.mpp2_kwh || 0], sum = e[0] + e[1];
  const u = [S.mpp1_u, S.mpp2_u], pk = [S.mpp1_peak_w, S.mpp2_peak_w], tc = [S.mpp1_tc, S.mpp2_tc];
  const sm = t => ` <small style="color:var(--muted)">${t}</small>`;
  const row = (lbl, f) => `<tr><td>${lbl}</td>${[0, 1].map(i => `<td>${f(i)}</td>`).join('')}</tr>`;
  let h = `<table class="pvt"><tr><th>${R.days > 120 ? 'Zeitraum' : R.days + ' Tage'}</th>` +
    [0, 1].map(i => `<th style="color:${STR_COL[i]}">${pvStrLabel(i, cfg)}</th>`).join('') + '</tr>';
  if (cfg[0].az || cfg[1].az) h += row('Ausrichtung', i => cfg[i].az ? PV_AZ_LABEL[cfg[i].az] : '–');
  if (cfg[0].mods || cfg[1].mods) h += row('Module', i => cfg[i].mods || '–');
  if (K) h += row('Leistung', i => (K.est ? '≈ ' : '') + fmt(K.k[i], K.est ? 1 : 2) + ' kWp');
  h += row('Energie', i => kwh(e[i], e[i] < 100 ? 1 : 0) + (sum > 0.05 ? sm(fmt(e[i] / sum * 100, 0) + ' %') : ''));
  if (K) h += row('je kWp', i => fmt(e[i] / K.k[i], 2) + ' kWh');
  h += row('Spitze', i => pk[i] != null ? kwOrW(pk[i]) + (K ? sm(fmt(pk[i] / K.k[i], 0) + ' W/kWp') : '') : '–');
  if (tc[0] != null || tc[1] != null) h += row('Erzeugt im Mittel um', i => tc[i] != null ? hmOf(tc[i]) + ' Uhr' : '–');
  if (u[0] != null || u[1] != null) h += row('Spannung im Betrieb', i => u[i] != null ? fmt(u[i], 0) + ' V' : '–');
  h += '</table>';
  const notes = [];
  if (K) notes.push(`kWp ${K.src}${K.est ? ' (gleiche Module angenommen) – genauer mit Modulzahl oder kWp unten' : ''}` +
    (K.tot ? ` · Anlage laut Wechselrichter ${fmt(K.tot, 2)} kWp` : '') + '.');
  if (tc[0] != null) notes.push('<b>Erzeugt im Mittel um</b>: Schwerpunkt der Tageserzeugung – Ostdächer liefern früher, Westdächer später.');
  if (u[0] != null) notes.push('<b>Spannung im Betrieb</b>: gewichtet nach Leistung, nur solange der String Strom liefert.');
  return h + `<div class="note" style="margin-top:6px">${notes.join(' ')}</div>`;
}

function verdictHtml(list) {
  const ic = { ok: '✓', info: 'i', warn: '!' }, ord = { warn: 0, info: 1, ok: 2 };
  return '<div class="vlist">' + list.slice().sort((a, b) => ord[a.lvl] - ord[b.lvl]).map(v =>
    `<div class="vrow v-${v.lvl}"><span class="vi">${ic[v.lvl]}</span><div class="vt"><b>${v.t}</b>${v.d ? `<small>${v.d}</small>` : ''}</div></div>`).join('') + '</div>';
}

function pvStrVerdicts(R, F, cfg, K) {
  const out = [], S = R.strings, C = R.checks || {};
  const add = (lvl, t, d) => out.push({ lvl, t, d });
  const L = i => pvStrLabel(i, cfg);
  // 1. right now: one string silent while the other produces
  const st = pvInv1(F).strings || [];
  const s1 = st.find(s => s.n === 1), s2 = st.find(s => s.n === 2);
  if (s1 && s2 && F.details && Date.now() / 1000 - (F.details.ts || 0) < 300) {
    const p = [Math.max(0, s1.p_w || 0), Math.max(0, s2.p_w || 0)];
    const lo = p[0] < p[1] ? 0 : 1, hi = 1 - lo, sl = [s1, s2][lo];
    if (p[hi] > 300 && p[lo] < 0.02 * p[hi])
      add('warn', `${L(lo)} liefert gerade nichts`, `während ${L(hi)} ${kwOrW(p[hi])} bringt (${L(lo)}: ` +
        `${fmt(sl.u_v || 0, 0)} V, ${fmt(sl.i_a || 0, 2)} A). Schnee oder starke Verschattung? Sonst DC-Trennschalter, ` +
        'Steckverbinder und Sicherung prüfen lassen.');
  }
  // 2. days on which one string (almost) delivered nothing
  const dead = [];
  (R.daily || []).forEach(d => {
    const a = d.mpp1_kwh || 0, b = d.mpp2_kwh || 0;
    if (Math.max(a, b) >= 1 && Math.min(a, b) < 0.03 * Math.max(a, b)) dead.push(dayLabel(d.day) + ' String ' + (a < b ? 1 : 2));
  });
  if (dead.length) add('warn', `An ${dead.length} Tag${dead.length > 1 ? 'en' : ''} lieferte ein String fast nichts`,
    dead.slice(-6).join(', ') + ' – Schnee, Verschattung oder ein Defekt (Steckverbinder, Sicherung, Eingang des Wechselrichters)?');
  // 3. Σ strings = PV generation (same rows)
  const cs = C.strings;
  if (cs && cs.pv_kwh >= 1) {
    const dv = Math.abs(cs.dev);
    add(dv <= 0.03 ? 'ok' : dv <= 0.06 ? 'info' : 'warn', dv <= 0.03 ? 'Summe der Strings = PV-Erzeugung' : 'Summe der Strings weicht von der PV-Erzeugung ab',
      `${kwh(cs.sum_kwh, 1)} aus den Strings, ${kwh(cs.pv_kwh, 1)} laut Energiefluss (${sgnPct(cs.dev)})` +
      (dv > 0.03 ? ' – die Strings werden nur einmal pro Minute abgefragt, bei wechselnden Wolken streut das.' : '.'));
  }
  if (!S || S.mpp2_kwh == null) return out;
  const e = [S.mpp1_kwh || 0, S.mpp2_kwh || 0];
  // 4. when each string produces (east early, west late) and the orientation
  const ew = cfg.map(c => c.az && c.az !== 'F' ? Math.sin(PV_AZ[c.az] * Math.PI / 180) : null);   // −1 east … +1 west
  const tc = [S.mpp1_tc, S.mpp2_tc];
  const dT = tc[0] != null && tc[1] != null ? tc[1] - tc[0] : null;                              // h, + = string 2 later
  const diffAz = ew[0] != null && ew[1] != null && Math.abs(ew[1] - ew[0]) > 0.3;
  if (dT != null && e[0] >= 0.5 && e[1] >= 0.5) {
    if (diffAz && ((ew[1] > ew[0] && dT < -0.25) || (ew[1] < ew[0] && dT > 0.25))) {
      const w = ew[1] > ew[0] ? 1 : 0;
      add('warn', 'Ausrichtung passt nicht zu den Messwerten', `Laut Eintrag zeigt ${L(w)} weiter nach Westen, er erzeugt aber im Mittel ` +
        `${fmtMin(Math.round(Math.abs(dT) * 60))} früher (${hmOf(tc[w])} statt später als ${hmOf(tc[1 - w])} Uhr). Sind die Strings beim Eintragen vertauscht?`);
    } else if (Math.abs(dT) >= 0.3) {
      const late = dT > 0 ? 1 : 0;
      add('info', `${L(late)} erzeugt im Mittel ${fmtMin(Math.round(Math.abs(dT) * 60))} später`,
        `Schwerpunkt ${hmOf(tc[0])} bzw. ${hmOf(tc[1])} Uhr → ${L(late)} ist weiter nach Westen ausgerichtet` +
        (diffAz ? ' (passt zum Eintrag)' : '') + ' – oder der andere wird nachmittags verschattet.');
    } else if (!diffAz) add('ok', 'Beide Strings erzeugen zur gleichen Tageszeit', `Schwerpunkt ${hmOf(tc[0])} bzw. ${hmOf(tc[1])} Uhr – gleiche Ausrichtung, keine einseitige Verschattung.`);
  }
  // 5. yield per kWp
  if (K && e[0] >= 0.5 && e[1] >= 0.5) {
    const y = [e[0] / K.k[0], e[1] / K.k[1]], d = y[1] / y[0] - 1, ad = Math.abs(d), lo = d < 0 ? 1 : 0;
    const sameDir = (cfg[0].az && cfg[0].az === cfg[1].az) || (!diffAz && dT != null && Math.abs(dT) < 0.3);
    const est = K.est ? ' (kWp aus den Spannungen geschätzt)' : '';
    if (sameDir) {
      add(ad <= 0.08 ? 'ok' : ad <= 0.15 ? 'info' : 'warn',
        ad <= 0.08 ? 'Beide Strings liefern je kWp gleich viel' : `${L(lo)} liefert je kWp ${fmt(ad * 100, 0)} % weniger`,
        `${fmt(y[0], 2)} bzw. ${fmt(y[1], 2)} kWh je kWp${est}` +
        (ad <= 0.08 ? ' – bis 8 % Unterschied sind normal (Modultoleranz, Kabel).'
          : ad <= 0.15 ? ' – leichte Verschattung, Verschmutzung oder Modultoleranz.'
            : ' – bei gleicher Ausrichtung zu viel: Verschattung, Schmutz/Laub/Schnee oder ein defektes Modul? Bei Sonne die Ströme vergleichen.'));
    } else {
      add('info', `Je kWp: ${fmt(y[0], 2)} kWh (String 1) und ${fmt(y[1], 2)} kWh (String 2)`,
        (diffAz || (dT != null && Math.abs(dT) >= 0.3)
          ? 'Unterschiedlich ausgerichtete Dachflächen liefern unterschiedlich viel – im Winter steht die Sonne tief im Süden, Ost- und Westflächen bekommen dann deutlich weniger als im Sommer. Entscheidend ist, ob das Verhältnis über die Wochen stabil bleibt.'
          : 'Ohne bekannte Ausrichtung lässt sich nicht sagen, welcher Unterschied normal ist – unten eintragen.') + est);
    }
  }
  // 6. trend of the daily ratio: a sudden change = new shade, snow, dirt or a defect
  const days = (R.daily || []).filter(d => (d.mpp1_kwh || 0) >= 0.2 && (d.mpp2_kwh || 0) >= 0.2 && (d.pv_cov == null || d.pv_cov >= 0.8));
  if (days.length >= 7) {
    const r = days.map(d => d.mpp2_kwh / d.mpp1_kwh);
    const base = medianOf(r.slice(0, -3)), last = r.slice(-3).map(x => x / base - 1);
    const down = last.every(x => x < -0.25), up = last.every(x => x > 0.25);
    if (down || up) add('warn', 'Verhältnis der Strings hat sich verändert',
      `In den letzten 3 Sonnentagen lieferte ${L(down ? 1 : 0)} im Verhältnis rund ${fmt(Math.abs(medianOf(last)) * 100, 0)} % weniger als davor. Neue Verschattung, Schnee, Laub – oder ein Defekt?`);
    else add('ok', 'Verhältnis der Strings stabil', `An ${days.length} Tagen lieferte String 2 zwischen ${fmt(Math.min(...r) * 100, 0)} und ` +
      `${fmt(Math.max(...r) * 100, 0)} % von String 1 (meist ${fmt(medianOf(r) * 100, 0)} %) – die Schwankung kommt vom Wetter.`);
  } else add('info', 'Trend noch offen', `Für eine Trend-Aussage braucht es mindestens 7 Tage, an denen beide Strings Strom geliefert haben ` +
    `(bisher ${days.length}${R.days < 30 ? '; evtl. Zeitraum 30 T wählen' : ''}).`);
  // 7. voltage ratio: temperature acts on both strings alike – a lost module or
  // bypass diode lowers only one string's voltage
  const vd = (R.daily || []).filter(d => d.mpp1_u > 50 && d.mpp2_u > 50);
  if (vd.length >= 5) {
    const q = vd.map(d => d.mpp1_u / d.mpp2_u), base = medianOf(q.slice(0, -2)), last = q.slice(-2).map(x => x / base - 1);
    if (last.every(x => x < -0.06) || last.every(x => x > 0.06)) {
      const lo = last[0] < 0 ? 0 : 1;
      add('warn', `Spannung von ${L(lo)} gesunken`, `Gegenüber String ${2 - lo} rund ${fmt(Math.abs(medianOf(last)) * 100, 0)} % niedriger als an den ` +
        `Tagen davor – das entspricht etwa einem Modul bzw. einer Bypass-Diode${cfg[lo].mods ? ` (1 von ${cfg[lo].mods} Modulen = ${fmt(100 / cfg[lo].mods, 0)} %)` : ''}. ` +
        'Teilverschattung kann das auch kurz bewirken – hält es an, vom Installateur prüfen lassen.');
    } else add('ok', 'Spannungen stabil', `Verhältnis String 1 : String 2 = ${fmt(medianOf(q), 2)} an ${vd.length} Tagen ohne Sprung` +
      (cfg[0].mods && cfg[1].mods ? '' : ' – bei gleichen Modulen ist das auch das Verhältnis der Modulzahl in Reihe') + '.');
    if (cfg[0].mods && cfg[1].mods) {
      const ex = cfg[0].mods / cfg[1].mods, dq = medianOf(q) / ex - 1;
      add(Math.abs(dq) <= 0.08 ? 'ok' : 'info', Math.abs(dq) <= 0.08 ? 'Spannungen passen zur Modulzahl' : 'Spannungen passen nicht zur eingetragenen Modulzahl',
        `Modulzahl ${cfg[0].mods} : ${cfg[1].mods} = ${fmt(ex, 2)}, Spannung ${fmt(medianOf(q), 2)}` +
        (Math.abs(dq) <= 0.08 ? '.' : ' – bei parallel geschalteten Strängen an einem Eingang oder unterschiedlichen Modulen normal, sonst Modulzahl prüfen.'));
    }
  }
  // 8. entered kWp vs the power stored in the inverter
  if (K && K.tot && cfg[0].kwp && cfg[1].kwp && Math.abs((cfg[0].kwp + cfg[1].kwp) / K.tot - 1) > 0.05)
    add('info', 'Summe der kWp weicht ab', `Eingetragen ${fmt(cfg[0].kwp + cfg[1].kwp, 2)} kWp, im Wechselrichter hinterlegt ${fmt(K.tot, 2)} kWp.`);
  return out;
}

function pvStrForm(cfg) {
  const opt = sel => Object.keys(PV_AZ_LABEL).map(k => `<option value="${k}"${k === sel ? ' selected' : ''}>${PV_AZ_LABEL[k]}</option>`).join('');
  return '<div class="strform">' + [0, 1].map(i => {
    const c = cfg[i];
    return `<fieldset><legend style="color:${STR_COL[i]}">String ${i + 1}</legend>` +
      `<label>Name<input data-sf="name" data-i="${i}" maxlength="24" placeholder="z. B. Süddach" value="${esc(c.name)}"></label>` +
      `<label>Module<input data-sf="mods" data-i="${i}" type="number" inputmode="numeric" min="1" max="80" step="1" value="${c.mods || ''}"></label>` +
      `<label>Leistung (kWp)<input data-sf="kwp" data-i="${i}" type="text" inputmode="decimal" autocomplete="off" placeholder="z. B. 8,16" value="${c.kwp ? fmt(c.kwp, 2) : ''}"></label>` +
      `<label>Ausrichtung<select data-sf="az" data-i="${i}">${opt(c.az)}</select></label></fieldset>`;
  }).join('') + '</div>' +
    '<div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">' +
    '<button class="btn" id="pvr-str-save" style="width:auto;padding:8px 16px;margin:0">Speichern</button>' +
    '<span class="note" id="pvr-str-msg" style="margin:0;flex:1;min-width:180px">Steht im Angebot bzw. Datenblatt des Installateurs. ' +
    'Leer lassen ist okay – dann schätzt die App die kWp aus den Spannungen. Gilt für alle Geräte.</span></div>';
}

function renderPvStrings() {
  const card = $('pvr-str-card'); if (!card) return;
  const F = STATE.fr, R = STATE.pv;
  const live = (pvInv1(F).strings || []).filter(s => s.n === 1 || s.n === 2);
  const S = R && !R.empty ? R.strings : null;
  if (!F || !F.connected || !(live.length >= 2 || (S && S.mpp2_kwh != null))) { card.hidden = true; return; }
  card.hidden = false;
  const cfg = pvStrCfg(), K = pvStrKwp(cfg, S, F);
  let norm = false;
  try { norm = !!K && localStorage.getItem(PVSTR_NORM_KEY) === '1'; } catch (e) { /* default kW */ }
  const ns = $('pvr-str-norm');
  if (ns) { ns.hidden = !K; ns.querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.n === '1') === norm)); }
  $('pvr-str-live').innerHTML = pvStrLive(F, cfg, K);
  const ser = (F.today && F.today.series) || [];
  const hasSer = ser.some(p => p.mpp1_w != null || p.mpp2_w != null);
  $('pvr-str-day').innerHTML = hasSer ? pvStrDayChart(ser, norm, K)
    : '<div class="note">Die String-Kurven füllen sich ab der ersten gespeicherten Minute mit String-Werten.</div>';
  $('pvr-str-day-legend').innerHTML = hasSer ? legendHtml([0, 1].map(i => ({ label: 'String ' + (i + 1) + (cfg[i].name ? ' · ' + cfg[i].name : ''), color: STR_COL[i] }))) : '';
  const hd = $('pvr-str-head');
  if (S && R.daily && R.daily.length) {
    $('pvr-str-daily-h').textContent = R.days > 120 ? 'Monatswerte im Zeitraum' : 'Tageswerte im Zeitraum';
    $('pvr-str-daily').innerHTML = pvStrDaily(R, norm, K);
    $('pvr-str-daily-legend').innerHTML = legendHtml([0, 1].map(i => ({ label: 'String ' + (i + 1) + (norm ? ' (kWh je kWp)' : ' (kWh)'), color: STR_COL[i] })));
    $('pvr-str-table').innerHTML = pvStrTable(R, cfg, K);
    const V = pvStrVerdicts(R, F, cfg, K);
    $('pvr-str-verdict').innerHTML = verdictHtml(V);
    const nw = V.filter(v => v.lvl === 'warn').length;
    if (hd) hd.innerHTML = nw ? `<span style="color:#ffb64d">${nw} Hinweis${nw > 1 ? 'e' : ''}</span>` : '<span style="color:#4be0b0">unauffällig</span>';
  } else {
    $('pvr-str-daily').innerHTML = R && R.empty ? '' : '<div class="note">Lade die Tageswerte …</div>';
    ['pvr-str-daily-legend', 'pvr-str-table'].forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
    $('pvr-str-verdict').innerHTML = R && !R.empty && !S
      ? '<div class="note">Im Zeitraum haben die Strings noch keinen Strom geliefert (oder es gibt noch keine String-Werte) – der Vergleich füllt sich, sobald die Sonne scheint.</div>' : '';
    if (hd) hd.innerHTML = '';
  }
  const det = $('pvr-str-cfg'), form = $('pvr-str-form');
  if (det && form && !form.dataset.ready) { form.innerHTML = pvStrForm(cfg); form.dataset.ready = '1'; }
}

function savePvStrings() {
  const form = $('pvr-str-form'); if (!form) return;
  const cfg = [{}, {}];
  form.querySelectorAll('[data-sf]').forEach(el => {
    const i = +el.dataset.i, k = el.dataset.sf, raw = String(el.value || '').trim(), v = raw.replace(',', '.');
    if (k === 'name') cfg[i].name = raw.slice(0, 24);
    else if (k === 'az') cfg[i].az = v;
    else if (k === 'mods') cfg[i].mods = parseInt(v, 10) > 0 ? Math.min(80, parseInt(v, 10)) : null;
    else if (k === 'kwp') cfg[i].kwp = parseFloat(v) > 0 ? Math.min(40, Math.round(parseFloat(v) * 100) / 100) : null;
  });
  try { localStorage.setItem(PVSTR_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
  const m = $('pvr-str-msg'); if (m) m.textContent = '✅ Gespeichert.';
  renderPvStrings();
}

/* ---- PV tab: plausibility check of the stored numbers ---------------------- */
function renderPvChecks() {
  const card = $('pvr-chk-card'); if (!card) return;
  const F = STATE.fr || {}, R = STATE.pv;
  if (!F.connected || !R || R.empty || !R.checks) { card.hidden = true; return; }
  card.hidden = false;
  const C = R.checks, T = R.totals || {}, out = [];
  const add = (lvl, t, d) => out.push({ lvl, t, d });
  // 1. data coverage
  const cv = C.coverage;
  if (cv && cv.span_h > 0) {
    const pct = Math.min(1, cv.covered_h / cv.span_h);
    add(pct >= 0.97 ? 'ok' : pct >= 0.9 ? 'info' : 'warn', `Werte für ${fmt(pct * 100, pct < 0.995 ? 1 : 0)} % der Zeit`,
      `${fmt(cv.covered_h, 0)} von ${fmt(cv.span_h, 0)} Stunden seit Beginn des Zeitraums bzw. der Aufzeichnung` +
      (cv.gap_h >= 0.05 ? ` · Lücken zusammen ${fmt(cv.gap_h, 1)} h${cv.gap_days.length ? ' (' + cv.gap_days.slice(-5).map(dayLabel).join(', ') + ')' : ''}` +
        ' – Bridge-Rechner aus, WLAN oder Wechselrichter nicht erreichbar.' : ' · keine Lücken.'));
  }
  const today = _hpdDateStr(new Date());
  const part = (R.daily || []).filter(d => d.pv_cov != null && d.pv_cov < 0.9 && d.day !== today);
  if (part.length) add('info', `${part.length} Tag${part.length > 1 ? 'e' : ''} nicht vollständig erfasst`,
    part.slice(-6).map(d => `${dayLabel(d.day)} ${fmt(d.pv_cov * 100, 0)} %`).join(', ') + ' der Sonnenstunden – deren Werte sind zu niedrig ' +
    '(z. B. der Tag der Inbetriebnahme). Die Erwartung im Monatsvergleich rechnet sie nur anteilig.');
  // 2. strings = PV
  const cs = C.strings;
  if (cs && cs.pv_kwh >= 1) {
    const dv = Math.abs(cs.dev);
    add(dv <= 0.03 ? 'ok' : dv <= 0.06 ? 'info' : 'warn', `Strings ${dv <= 0.03 ? '=' : '≈'} PV-Erzeugung`,
      `${kwh(cs.sum_kwh, 1)} aus den einzelnen Strings, ${kwh(cs.pv_kwh, 1)} laut Energiefluss (${sgnPct(cs.dev)}).`);
  }
  // 3. energy balance: what comes in = what goes out + conversion losses
  const B = C.balance;
  if (B && B.load_kwh > 0.5) {
    const inn = B.pv_kwh + B.dis_kwh + B.imp_kwh, outt = B.load_kwh + B.ch_kwh + B.exp_kwh, loss = inn - outt;
    const conv = Math.max(0.5, B.pv_kwh + B.dis_kwh - B.ch_kwh + 2 * (T.ch_grid_kwh || 0));
    const rel = loss / conv, fine = rel >= -0.01 && rel <= 0.1, near = rel >= -0.03 && rel <= 0.15;
    add(fine ? 'ok' : near ? 'info' : 'warn',
      near ? `Energiebilanz geht auf – ${fmt(Math.max(0, rel) * 100, 1)} % Umwandlungsverluste` : 'Energiebilanz geht nicht auf',
      `Hinein: Sonne ${fmt(B.pv_kwh, 1)} + Batterie ${fmt(B.dis_kwh, 1)} + Netz ${fmt(B.imp_kwh, 1)} = ${kwh(inn, 1)} · ` +
      `Heraus: Haus ${fmt(B.load_kwh, 1)} + Batterie ${fmt(B.ch_kwh, 1)} + Netz ${fmt(B.exp_kwh, 1)} = ${kwh(outt, 1)} → ` +
      `Differenz ${kwh(loss, 1)} = Umwandlungsverluste von Wechselrichter und Batterie (üblich 3–8 %)` +
      (rel < -0.01 ? ' – mehr heraus als hinein: ein Wert ist zu hoch oder fehlt.' : rel > 0.15 ? ' – auffällig hoch.' : '.'));
  }
  // 4. meter counters vs the integrated power readings
  const M = C.meter;
  if (M && M.days && M.imp_int_kwh + M.exp_int_kwh >= 1) {
    const di = M.imp_int_kwh >= 0.5 ? M.imp_cnt_kwh / M.imp_int_kwh - 1 : 0;
    const de = M.exp_int_kwh >= 0.5 ? M.exp_cnt_kwh / M.exp_int_kwh - 1 : 0;
    const worst = Math.max(Math.abs(di), Math.abs(de));
    add(worst <= 0.03 ? 'ok' : worst <= 0.08 ? 'info' : 'warn', worst <= 0.03 ? 'Zählerstände passen zu den Messwerten' : 'Zählerstände weichen von den Messwerten ab',
      `Bezug ${kwh(M.imp_cnt_kwh, 1)} laut Smart Meter, ${kwh(M.imp_int_kwh, 1)} aus den Leistungswerten (${sgnPct(di)}) · ` +
      `Einspeisung ${kwh(M.exp_cnt_kwh, 1)} bzw. ${kwh(M.exp_int_kwh, 1)}${M.exp_int_kwh >= 0.5 ? ' (' + sgnPct(de) + ')' : ''} – ` +
      `an ${M.days} Tag${M.days > 1 ? 'en' : ''} ohne Lücke. Angezeigt werden die Zählerstände.`);
  }
  if (C.meter_jumps && C.meter_jumps.length) add('warn', 'Sprung im Zählerstand',
    `Am ${C.meter_jumps.slice(-5).map(dayLabel).join(', ')} sprang ein Zählerstand des Smart Meters (Tausch, Neustart?) – diese Tage werden aus den Leistungswerten gerechnet.`);
  // 5. battery: charged vs discharged, corrected by the change of the charge level
  const Bt = C.battery, cap = F.details && F.details.storage && F.details.storage.capacity_wh;
  if (Bt && cap > 0 && Bt.ch_kwh != null) {
    const dE = ((Bt.soc_last || 0) - (Bt.soc_first || 0)) / 100 * cap / 1000;
    const inp = Bt.ch_kwh - dE;
    if (Bt.ch_kwh >= 0.5 * cap / 1000 && inp > 0.2) {
      const eta = Bt.dis_kwh / inp;
      add(eta >= 0.8 && eta <= 1.0 ? 'ok' : eta >= 0.7 && eta <= 1.03 ? 'info' : 'warn', `Batterie: ${fmt(eta * 100, 0)} % Wirkungsgrad`,
        `Geladen ${kwh(Bt.ch_kwh, 1)}, entladen ${kwh(Bt.dis_kwh, 1)}, Ladestand ${fmt(Bt.soc_first, 0)} → ${fmt(Bt.soc_last, 0)} % ` +
        `(${dE >= 0 ? '+' : '−'}${kwh(Math.abs(dE), 2)}) – von 10 kWh hinein kommen ${fmt(eta * 10, 1)} kWh wieder heraus` +
        (eta > 1.0 ? ' – mehr als hinein geht nicht: Ladestand oder Kapazität stimmen nicht.' : ' (üblich 8,5–9,5; Standby und Schutzladung kosten etwas).'));
    } else add('info', 'Batterie: noch zu wenig geladen für eine Aussage', `Bisher ${kwh(Bt.ch_kwh, 1)} geladen – für den Wirkungsgrad braucht es mindestens einen halben Zyklus (${kwh(cap / 2000, 1)}).`);
  }
  // 6. the inverter's own energy counter
  const E = C.etotal;
  if (E && E.et_kwh >= 1) {
    const dA = E.ac_kwh > 0.5 ? E.et_kwh / E.ac_kwh - 1 : null, dP = E.pv_kwh > 0.5 ? E.et_kwh / E.pv_kwh - 1 : null;
    if (dA != null && Math.abs(dA) <= 0.04)
      add('ok', 'Zähler des Wechselrichters passt', `E-Total stieg um ${kwh(E.et_kwh, 1)}, die gemessene AC-Abgabe war ${kwh(E.ac_kwh, 1)} (${sgnPct(dA)}). ` +
        `Er zählt also alles, was er ins Hausnetz abgibt – Sonne und Batterie –, nicht die PV-Erzeugung allein (${kwh(E.pv_kwh, 1)}).`);
    else if (dP != null && Math.abs(dP) <= 0.04)
      add('ok', 'Zähler des Wechselrichters passt', `E-Total stieg um ${kwh(E.et_kwh, 1)} – wie die PV-Erzeugung (${kwh(E.pv_kwh, 1)}, ${sgnPct(dP)}).`);
    else add('info', 'Zähler des Wechselrichters weicht ab', `E-Total +${kwh(E.et_kwh, 1)}, AC-Abgabe ${kwh(E.ac_kwh, 1)}, PV ${kwh(E.pv_kwh, 1)} – ` +
      'manche Geräte zählen in groben Schritten oder anders; die App rechnet nicht mit diesem Zähler.');
    if (E.jumps && E.jumps.length) add('info', 'Sprung im Zähler des Wechselrichters', `Am ${E.jumps.slice(-5).map(dayLabel).join(', ')} (Neustart, Update?) – nicht mitgezählt.`);
  }
  // 7. peak power vs installed modules
  const kwp = F.identity && F.identity.pv_power_w ? F.identity.pv_power_w / 1000 : null;
  if (C.peak && kwp && C.peak.pv_w > 0) {
    const r = C.peak.pv_w / 1000 / kwp;
    add(r <= 1.0 ? 'ok' : r <= 1.1 ? 'info' : 'warn', `Höchste PV-Leistung ${kwOrW(C.peak.pv_w)} = ${fmt(r * 100, 0)} % der Modulleistung`,
      `am ${dayLabel(C.peak.day)} · installiert ${fmt(kwp, 2)} kWp` +
      (r > 1.1 ? ' – deutlich über der installierten Leistung: stimmt die kWp-Angabe im Wechselrichter?'
        : r > 1.0 ? ' – kurz über Nennleistung ist an kalten Tagen mit Wolkenrand-Effekt möglich.'
          : ' – plausibel. Die volle Leistung erreichen Module nur bei hoch stehender Sonne und Kälte; im Winter und bei ' +
            'Dachflächen in verschiedene Richtungen (die zu verschiedenen Zeiten Sonne bekommen) bleibt die Spitze deutlich darunter.'));
  }
  $('pvr-chk').innerHTML = verdictHtml(out) +
    `<div class="note" style="margin-top:10px">Geprüft über den gewählten Zeitraum (${R.days > 120 ? 'Jahr' : R.days + ' Tage'}) mit denselben ` +
    'Zahlen, die oben angezeigt werden. Die Bridge speichert jede Minute einen Mittelwert; Zählerstände und Strings fragt sie einmal pro Minute ab.</div>';
  const nw = out.filter(v => v.lvl === 'warn').length, nok = out.filter(v => v.lvl === 'ok').length;
  $('pvr-chk-head').innerHTML = nw ? `<span style="color:#ffb64d">${nw} auffällig</span>` : `<span style="color:#4be0b0">${nok} × ✓</span>`;
}

/* ---- heat pump card: share of solar power right now ------------------------ */
function hpSunLine() {
  const F = STATE.fr;
  if (!F || !F.connected || !F.live || F.live.load_w == null) return '';
  const P = pvFlowParts(F.live);
  if (!(P.load > 0)) return '';
  const share = Math.max(0, Math.min(1, 1 - P.imp / P.load));
  const td = F.today && F.today.today && F.today.today.hp_sun_share;
  return `${fmt(share * 100, 0)} % gerade` +
    `<br><small style="color:var(--muted)">Anteil aus PV/Batterie am Hausverbrauch` +
    (td != null ? ` · heute ${fmt(td * 100, 0)} % des WP-Stroms` : '') + '</small>';
}

/* ---- Setup: find & connect the inverter ----------------------------------- */
function renderFroniusSetup() {
  const st = $('fr-status'); if (!st) return;
  const h = STATE.health || {}, F = STATE.fr;
  const inp = $('fr-host');
  if (inp && !inp.value && h.fronius_host) inp.value = h.fronius_host;
  let msg;
  if (h.mode === 'demo') {
    msg = '◆ <b>Demo-Modus</b>: gezeigt wird eine Beispiel-Anlage (9,9 kWp, 9,5-kWh-Batterie, Smart Meter). ' +
      (h.fronius_host ? `Eingetragen für den Normalbetrieb: ${ipTag(h.fronius_host)}.` : 'Eine hier eingetragene Adresse gilt im Normalbetrieb.');
  } else if (h.fronius_available === false) {
    msg = 'Das Fronius-Modul fehlt in der Bridge (<code>bridge/fronius.py</code>) – bitte die Bridge aktualisieren.';
  } else if (h.fronius_connected) {
    const I = (F && F.identity) || {};
    msg = F && F.ok ? `✅ Verbunden mit <b>${esc(I.name || 'Fronius')}</b> (${ipTag(h.fronius_host)}) · ${pvStatusTag(F)}`
      : `⚠︎ Eingetragen: ${ipTag(h.fronius_host)} – ${escIp((F && F.error) || h.fronius_error || 'noch keine Antwort')}`;
  } else {
    msg = 'Noch kein Wechselrichter verbunden.';
  }
  st.innerHTML = msg;
  const dis = $('fr-disconnect'); if (dis) dis.hidden = !(h.fronius_connected && h.mode !== 'demo');
  const info = $('fr-info');
  if (info) {
    const I = F && F.identity;
    info.innerHTML = I ? [
      statusRow('Gerät', esc(I.name || '–') + (I.type && I.type !== I.name ? ` <small style="color:var(--muted)">${esc(I.type)}</small>` : '')),
      I.pv_power_w ? statusRow('PV-Leistung', fmt(I.pv_power_w / 1000, 2) + ' kWp') : '',
      statusRow('Smart Meter', I.has_meter ? 'ja' + (I.meter_location === 'grid' ? ' (Einspeisepunkt)' : I.meter_location === 'load' ? ' (Verbrauchszweig)' : '') : '<b>nein</b> – nur Erzeugung sichtbar'),
      statusRow('Batterie', I.has_battery ? 'ja' : 'nein'),
    ].join('') : '';
  }
}

async function loadFronius(force) {
  if (_frBusy && !force) return;
  _frBusy = true;
  try { const r = await api('/api/fronius'); if (r) STATE.fr = r; } catch (e) { /* keep the last values */ }
  finally { _frBusy = false; }
  // the heat-pump card shows the solar share too (redrawn when its tab is open)
  const mT = meterToday();               // today's smart-meter total moved → the hero + 'Wofür heute' follow
  const reOv = STATE.ov && ((mT == null) !== (_mtShown == null) || (mT != null && Math.abs(mT - _mtShown) >= 0.05));
  paintViews(['renderFlow', 'renderPvReal', 'renderFroniusSetup', 'renderHeatpump', 'paintNowLine', 'renderDarkLoad']
    .concat(reOv ? ['renderOverview'] : []));
  if (kioskOpen()) { try { paintKiosk(); } catch (e) {} }
}

async function frRefreshHealth() {
  try { const h = await api('/api/health'); if (h && h.ok) STATE.health = h; } catch (e) {}
}

// The inverter's web UI answers but its Solar API is off (GEN24 factory
// default): how to switch it on, incl. the login the owner usually lacks.
function frApiOffHelp(host) {
  const ok = /^[\w.\-:\[\]]+$/.test(host || '');
  const link = ok ? `<a href="http://${esc(host)}/" target="_blank" rel="noopener">Weboberfläche des Wechselrichters öffnen ↗</a>`
    : 'Weboberfläche öffnen (IP des Wechselrichters im Browser)';
  return '<div class="note fr-help" style="line-height:1.6; margin-top:8px; padding:10px 12px; border-radius:10px; background:var(--card2)">' +
    '<b>So schaltest du die Solar API ein (einmalig):</b><br>' +
    `1. ${link} – klappt nur im Heimnetz.<br>` +
    '2. Anmelden als Benutzer <b>Customer</b> (Kunde). Das Passwort wird bei der Inbetriebnahme vergeben – ' +
    'frag deinen Installateur, oft steht es im Inbetriebnahme-Protokoll.<br>' +
    '3. <b>Kommunikation → Solar API</b> → „Kommunikation über Solar API aktivieren" einschalten und speichern.<br>' +
    '4. Hier noch einmal <b>Verbinden</b> tippen.<br>' +
    '<b>Passwort unbekannt?</b> Auf der Anmeldeseite „Passwort vergessen?" → Benutzer <b>Customer</b> wählen → es erscheint ' +
    'ein <b>PIN</b>. In <b>Solar.web</b> (dort als Besitzer der Anlage eingetragen) unter Einstellungen → Komponenten → beim ' +
    'Wechselrichter „Aktionen" → „Customer Passwort zurücksetzen" mit dem PIN einen <b>Freischalt-Code</b> erzeugen, ihn auf ' +
    'der Anmeldeseite eintragen und ein neues Passwort setzen. Der PIN gilt nur, solange er angezeigt wird. ' +
    'Oder den Installateur bitten, die Solar API einzuschalten.<br>' +
    '<small style="color:var(--muted)">Ablauf laut Fronius-Hilfe; die Bezeichnungen können je nach Firmware leicht abweichen.</small></div>';
}

async function frFind() {
  const b = $('fr-find'), out = $('fr-found'), note = $('fr-note');
  if (b) b.disabled = true;
  if (out) out.innerHTML = '';
  if (note) note.textContent = 'Suche im Heimnetz … (dauert bis zu 30 Sekunden)';
  try {
    const r = await api('/api/fronius/discover');
    if (!r || !r.ok) { if (note) note.textContent = (r && r.error) || 'Suche nicht möglich.'; return; }
    if (!r.found.length) {
      if (note) note.innerHTML = 'Kein Fronius im Netz der Bridge gefunden. Ist der Wechselrichter eingeschaltet und im selben Netz wie die Bridge? ' +
        'Sonst seine IP im Router nachsehen (Liste der verbundenen Geräte) und oben eintragen.';
      return;
    }
    if (note) note.textContent = r.found.length === 1 ? 'Gefunden – antippen zum Verbinden:' : `${r.found.length} Geräte gefunden – antippen zum Verbinden:`;
    const off = r.found.find(f => !f.solar_api);
    if (out) out.innerHTML = r.found.map(f => `<button class="btn sec" data-fr-host="${esc(f.host)}" style="text-align:left; margin-top:6px">` +
      `${f.solar_api ? '☀️' : '⚠︎'} <b>${esc(f.name || f.type || 'Fronius')}</b>` +
      (f.pv_power_w ? ` · ${fmt(f.pv_power_w / 1000, 1)} kWp` : '') +
      (f.note ? `<br><small style="color:var(--muted)">${esc(f.note).replace(IP_RX, '•••.•••.•.••')}</small>` : '') + '</button>' +
      `<div class="note" style="margin:2px 0 0 4px">Adresse ${ipTag(f.host)}</div>`).join('') +
      (off ? frApiOffHelp(off.host) : '');
  } catch (e) {
    if (note) note.textContent = 'Suche nur möglich, wenn die Seite von der Bridge geöffnet ist.';
  } finally { if (b) b.disabled = false; }
}

async function frConnect(host) {
  const inp = $('fr-host'), note = $('fr-note'), b = $('fr-connect');
  host = String(host || (inp && inp.value) || '').trim();
  if (!host) { if (note) note.textContent = 'Bitte die IP-Adresse eintragen oder „Im Netz suchen" tippen.'; return; }
  if (inp) inp.value = host;
  if (b) b.disabled = true;
  if (note) note.textContent = 'Verbinde …';
  try {
    const r = await postJSON('/api/fronius/connect', { host });
    if (r && r.ok) {
      const I = r.identity || {};
      if (inp && I.host) inp.value = I.host;      // the address as saved (no http://, no path)
      await frRefreshHealth();                    // status + live values first, then the message
      STATE.pv = null;
      await loadFronius(true);
      if (note) note.innerHTML = `✅ Verbunden: <b>${esc(I.name || 'Fronius')}</b>` +
        (I.pv_power_w ? ` · ${fmt(I.pv_power_w / 1000, 2)} kWp` : '') +
        ` · Smart Meter: ${I.has_meter ? 'ja' : '<b>nein</b>'} · Batterie: ${I.has_battery ? 'ja' : 'nein'}<br>` +
        (r.demo ? 'Im Demo-Modus laufen weiter die Beispielwerte – die Adresse gilt im Normalbetrieb.'
          : 'Live-Werte erscheinen in der <b>Übersicht</b> und im Tab <b>PV</b>; die Bridge speichert ab jetzt jede Minute einen Wert.');
      const fo = $('fr-found'); if (fo) fo.innerHTML = '';
    } else if (note && r && r.api_off) {
      // reachable Fronius, Solar API switched off: say that plainly + how to fix
      const fo = $('fr-found'); if (fo) fo.innerHTML = '';
      note.innerHTML = `⚠︎ Unter ${ipTag(r.host || host)} antwortet ein Fronius-Wechselrichter, aber seine <b>Solar API ist noch ausgeschaltet</b>.` +
        frApiOffHelp(r.host || host) + `<small style="color:var(--muted)">Technisch: ${escIp(r.error || '')}</small>`;
    } else if (note) {
      note.innerHTML = `❌ ${escIp((r && r.error) || 'Verbindung fehlgeschlagen.')}` + (r && r.hint ? `<br>💡 ${esc(r.hint)}` : '');
    }
  } catch (e) {
    if (note) note.textContent = 'Verbinden nur möglich, wenn die Seite von der Bridge geöffnet ist.';
  } finally { if (b) b.disabled = false; }
}

async function frDisconnect() {
  if (!confirm('Verbindung zum Wechselrichter trennen? Die gespeicherten Werte bleiben erhalten.')) return;
  try { await postJSON('/api/fronius/disconnect', {}); } catch (e) {}
  await frRefreshHealth();
  STATE.fr = null; STATE.pv = null;
  const note = $('fr-note'); if (note) note.textContent = 'Getrennt.';
  paintViews(['renderFlow', 'renderPvReal', 'renderFroniusSetup']);
}

let _frProbeText = '';
async function frProbe() {
  const out = $('fr-probe-out'), b = $('fr-probe'), cp = $('fr-probe-copy');
  if (b) b.disabled = true;
  if (out) { out.hidden = false; out.textContent = 'Lade Rohdaten …'; }
  try {
    const host = (($('fr-host') || {}).value || '').trim();
    const r = await api('/api/fronius/probe' + (host && !(STATE.health && STATE.health.mode === 'demo') ? '?host=' + encodeURIComponent(host) : ''));
    let txt;
    if (!r || r.ok === false) txt = 'Fehler: ' + ((r && r.error) || 'keine Antwort');
    else if (r.note) txt = r.note;
    else {
      txt = `Fronius · ${new Date((r.ts || 0) * 1000).toLocaleString('de-DE')} (Adresse ausgelassen)\n`;
      (r.endpoints || []).forEach(e => {
        txt += `\n### ${e.path}\n` + (e.error ? 'Fehler: ' + e.error : `HTTP ${e.status} · ${e.ms} ms\n`);
        if (e.body != null) { try { txt += JSON.stringify(JSON.parse(e.body), null, 1); } catch (err) { txt += e.body; } }
        txt += '\n';
      });
    }
    _frProbeText = txt;
    if (out) out.textContent = txt;
    if (cp) cp.hidden = false;
  } catch (e) {
    if (out) out.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.';
  } finally { if (b) b.disabled = false; }
}
function copyText(txt) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(txt).then(() => true, () => false);
  // plain HTTP in the home network (iPhone Safari): the old way still works
  const ta = document.createElement('textarea');
  ta.value = txt; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, txt.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove();
  return Promise.resolve(ok);
}

function initPvReal() {
  try { const d = parseInt(localStorage.getItem(PVR_DAYS_KEY), 10); STATE.pvDays = [7, 30, 90, 365].includes(d) ? d : 30; } catch (e) { STATE.pvDays = 30; }
  const pr = $('pvr-range');
  if (pr) {
    [...pr.querySelectorAll('button[data-d]')].forEach(x => x.classList.toggle('on', +x.dataset.d === STATE.pvDays));
    pr.addEventListener('click', e => {
      const btn = e.target.closest('button[data-d]'); if (!btn) return;
      STATE.pvDays = +btn.dataset.d;
      try { localStorage.setItem(PVR_DAYS_KEY, String(STATE.pvDays)); } catch (err) {}
      [...pr.querySelectorAll('button[data-d]')].forEach(x => x.classList.toggle('on', x === btn));
      loadPvHist(true);
    });
  }
  const ns = $('pvr-str-norm');
  if (ns) ns.addEventListener('click', e => {
    const b = e.target.closest('button[data-n]'); if (!b) return;
    try { localStorage.setItem(PVSTR_NORM_KEY, b.dataset.n); } catch (err) { /* private mode */ }
    renderPvStrings();
  });
  const sc = $('pvr-str-card');
  if (sc) sc.addEventListener('click', e => { if (e.target.closest('#pvr-str-save')) { e.preventDefault(); savePvStrings(); } });
  const dev = $('pvr-dev-card');
  if (dev) dev.addEventListener('click', e => {
    const b = e.target.closest('[data-pvr-kwp]'); if (!b) return;
    const inp = $('pv-kwp'); if (!inp) return;
    inp.value = b.dataset.pvrKwp;
    try { localStorage.setItem(PV_LS.kwp, inp.value); } catch (err) {}
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    renderPv(); renderPvDevices();
  });
  const hc = $('pvr-hist-card');
  if (hc) hc.addEventListener('click', e => {
    if (!e.target.closest('[data-pvr-feed]')) return;
    e.preventDefault();
    const f = $('pv-feedin'); if (f) { f.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => f.focus(), 400); }
  });
  const ff = $('pv-feedin');
  if (ff) ff.addEventListener('change', () => { STATE.pvAt = 0; setTimeout(() => { if (activeView() === 'pv') loadPvHist(true); }, 1500); });
  const fb = $('fr-find'); if (fb) fb.addEventListener('click', frFind);
  const fc = $('fr-connect'); if (fc) fc.addEventListener('click', () => frConnect());
  const fo = $('fr-found'); if (fo) fo.addEventListener('click', e => { const b = e.target.closest('[data-fr-host]'); if (b) frConnect(b.dataset.frHost); });
  const fh = $('fr-host'); if (fh) fh.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); frConnect(); } });
  const fd = $('fr-disconnect'); if (fd) fd.addEventListener('click', frDisconnect);
  const fp = $('fr-probe'); if (fp) fp.addEventListener('click', frProbe);
  const fcp = $('fr-probe-copy');
  if (fcp) fcp.addEventListener('click', async () => {
    const ok = await copyText(_frProbeText || '');
    fcp.textContent = ok ? '✅ Kopiert' : 'Bitte Text markieren und kopieren';
    setTimeout(() => { fcp.textContent = '📋 Kopieren'; }, 2500);
  });
  // live values every 10 s while the Übersicht, the PV tab or the dashboard is on screen
  setInterval(() => {
    const h = STATE.health;
    if (!h || !h.fronius_connected || document.visibilityState !== 'visible') return;
    if (kioskOpen() || ['overview', 'pv'].includes(activeView())) loadFronius();
  }, 10000);
}

/* ---- Setup → Wärmepumpe: where does the data get stuck? ------------------- */
let _hpDiagText = '';
function hpDiagHtml(d) {
  const col = { ok: '#4be0b0', warn: '#ffb64d', error: '#ff6b8a' }[d.level] || 'var(--muted)';
  const when = t => t ? new Date(t * 1000).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
  const step = (x, label) => !x ? '' : `${x.ok ? '✅' : '❌'} ${label} <small style="color:var(--muted)">${fmt(x.ms, 0)} ms</small>` +
    (x.ok && x.version ? ` <small style="color:var(--muted)">${esc(x.version)}</small>` : '') +
    (!x.ok ? `<br><small style="color:#ff6b8a">${esc(x.error || '')}</small>` : '');
  let h = `<div style="border-left:3px solid ${col};padding:6px 0 6px 10px;margin-bottom:8px;font-size:13.5px;line-height:1.5">` +
    `<b style="color:${col}">${esc(d.verdict || '')}</b>` +
    ((d.tips || []).length ? '<ul style="margin:6px 0 0 18px;padding:0">' + d.tips.map(t => `<li>${esc(t)}</li>`).join('') + '</ul>' : '') + '</div>';
  (d.net || []).forEach(n => {
    h += statusRow(`${esc(n.host)}<br><small style="color:var(--muted)">${esc(n.role || '')}</small>`,
      [step(n.dns, 'Name (DNS)'), step(n.tcp, 'Verbindung'), step(n.tls, 'Verschlüsselung')].filter(Boolean).join('<br>'));
  });
  if (d.token) h += statusRow('Anmeldung (Token)', d.token.ok ? `✅ <small style="color:var(--muted)">${fmt(d.token.ms, 0)} ms</small>` : `❌ <small style="color:#ff6b8a">${esc(d.token.error || '')}</small>`);
  if (d.api) h += statusRow('Datenabruf (Zähler)', d.api.ok ? `✅ HTTP 200 <small style="color:var(--muted)">${fmt(d.api.ms, 0)} ms</small>`
    : `❌ ${d.api.status ? 'HTTP ' + d.api.status : ''} <small style="color:#ff6b8a">${esc(d.api.error || '')}</small>`);
  const sm = d.samples || {}, p = d.poller || {};
  h += statusRow('Letzte echte Messung', when(sm.last_good_ts)) +
    statusRow('Letzte 24 h', `${fmt(sm.n_good_24h || 0, 0)} von ${fmt(sm.n_24h || 0, 0)} Abfragen mit Werten`) +
    (p.last_error ? statusRow('Letzter Fehler', `<small>${esc(p.last_error)}</small>`) : '') +
    statusRow('Python der Bridge', `${esc(d.python || '')} · ${esc(d.ssl || '')}` + (d.tls13 ? '' : ' · <b style="color:#ffb64d">kein TLS 1.3</b>'));
  return h;
}
function hpDiagText(d) {
  const L = [`Verbindungstest Bosch-Cloud · ${new Date((d.ts || 0) * 1000).toLocaleString('de-DE')}`,
    `Ergebnis: ${d.verdict || ''}`].concat((d.tips || []).map(t => '- ' + t));
  L.push(`Python ${d.python} (${d.executable || ''}) · ${d.ssl} · TLS 1.3: ${d.tls13 ? 'ja' : 'nein'}`);
  L.push(`HomeCom verbunden: ${d.configured ? 'ja' : 'nein'} · Gateway ${d.gateway || '–'}`);
  (d.net || []).forEach(n => {
    const part = k => n[k] ? `${k.toUpperCase()} ${n[k].ok ? 'ok' : 'FEHLER'} ${n[k].ms} ms${n[k].version ? ' ' + n[k].version : ''}${n[k].ok ? '' : ' (' + n[k].error + ')'}` : '';
    L.push(`${n.host}: ${['dns', 'tcp', 'tls'].map(part).filter(Boolean).join(' · ')}`);
  });
  if (d.token) L.push(`Anmeldung: ${d.token.ok ? 'ok' : 'FEHLER ' + (d.token.error || '')}`);
  if (d.api) L.push(`Datenabruf: ${d.api.status ? 'HTTP ' + d.api.status : ''} ${d.api.ok ? 'ok' : (d.api.error || '')}`);
  const sm = d.samples || {}, p = d.poller || {};
  L.push(`Letzte echte Messung: ${sm.last_good_ts ? new Date(sm.last_good_ts * 1000).toLocaleString('de-DE') : '–'} · 24 h: ${sm.n_good_24h} von ${sm.n_24h} mit Werten`);
  if (p.last_error) L.push(`Letzter Fehler: ${p.last_error} (${p.fails || 0}× in Folge)`);
  return L.join('\n');
}
async function hpDiag() {
  const out = $('hp-diag-out'), b = $('hp-diag'), cp = $('hp-diag-copy');
  if (!out) return;
  if (b) b.disabled = true;
  out.innerHTML = '<div class="note">Teste die Verbindung zur Bosch-Cloud … (dauert bis zu 30 Sekunden)</div>';
  try {
    const d = await api('/api/homecom/diag');
    out.innerHTML = hpDiagHtml(d);
    _hpDiagText = hpDiagText(d);
    if (cp) cp.hidden = false;
  } catch (e) {
    out.innerHTML = '<div class="note">Der Test geht nur, wenn die Seite von der Bridge geöffnet ist (und die Bridge läuft).</div>';
  } finally { if (b) b.disabled = false; }
}
/* ---- Setup → Kalender im Wohn-Dashboard --------------------------------------- */
async function renderCalSetup() {
  const st = $('cal-status'); if (!st) return;
  try {
    const r = await api('/api/calendar/config');
    const clr = $('cal-clear');
    if (r && r.available === false) st.textContent = 'Das Kalender-Modul fehlt in der Bridge (bridge/calendar_ics.py) – bitte die Bridge aktualisieren.';
    else if (r && r.count) st.innerHTML = `✅ ${r.count === 1 ? 'Ein Kalender' : r.count + ' Kalender'} eingetragen: ` + (r.urls || []).map(u => `<code>${esc(u)}</code>`).join(', ');
    else st.textContent = 'Noch kein Kalender eingetragen.';
    if (clr) clr.hidden = !(r && r.count);
  } catch (e) { st.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
}
async function calSave() {
  const ta = $('cal-urls'), note = $('cal-note'), b = $('cal-save');
  const urls = String((ta && ta.value) || '').split(/\s+/).map(x => x.trim()).filter(Boolean);
  if (!urls.length) { if (note) note.textContent = 'Bitte die Kalender-Adresse einfügen.'; return; }
  if (b) b.disabled = true;
  if (note) note.textContent = 'Lade den Kalender …';
  try {
    const r = await postJSON('/api/calendar/config', { urls });
    const res = (r && r.results) || [];
    if (note) note.innerHTML = res.map(x => x.ok
      ? `✅ <b>${esc(x.name)}</b>: ${x.events_7d} Termine in den nächsten 7 Tagen (${x.events_total} Einträge insgesamt)`
      : `❌ <code>${esc(x.url)}</code>: ${esc(x.error || 'nicht lesbar')}`).join('<br>') || escIp((r && r.error) || 'Nicht gespeichert.');
    if (r && r.ok) { if (ta) ta.value = ''; _kioskCal = null; }
  } catch (e) {
    if (note) note.textContent = 'Speichern nur möglich, wenn die Seite von der Bridge geöffnet ist.';
  } finally { if (b) b.disabled = false; renderCalSetup(); }
}
async function calClear() {
  if (!confirm('Kalender aus dem Wohn-Dashboard entfernen?')) return;
  try { await postJSON('/api/calendar/config', { clear: true }); } catch (e) {}
  _kioskCal = null;
  const note = $('cal-note'); if (note) note.textContent = 'Entfernt.';
  renderCalSetup();
}
function renderDashSetup() {
  const w = $('dash-win-s'), b = $('dash-bin-days'); if (!w || !b) return;
  if (document.activeElement !== w) w.value = String(kioskSetting('win_s'));
  if (document.activeElement !== b) b.value = String(kioskSetting('bin_days'));
  const s = kioskSetting('win_s'), note = $('dash-note');
  if (note) note.innerHTML = `Fenster blinkt nach <b>${s >= 60 ? fmtMin(Math.floor(s / 60)) + (s % 60 ? ' ' + Math.round(s % 60) + ' s' : '') : s + ' s'}</b> · ` +
    `Tonnen-Hinweis <b>${kioskSetting('bin_days') === 1 ? 'am Vorabend' : kioskSetting('bin_days') + ' Abende vorher'}</b> (ab 16 Uhr).`;
}
function initDashSetup() {
  const w = $('dash-win-s'), b = $('dash-bin-days');
  const save = (k, v) => { try { localStorage.setItem('bhe_kiosk_' + k, String(v)); } catch (e) {} renderDashSetup();
    if (kioskOpen()) { try { paintKiosk(); } catch (e) {} } };
  if (w) w.addEventListener('change', () => { const n = parseFloat(w.value); save('win_s', isFinite(n) && n >= 1 ? Math.min(86400, Math.round(n)) : KIOSK_DEF.win_s); });
  if (b) b.addEventListener('change', () => save('bin_days', Math.max(1, Math.min(7, parseInt(b.value, 10) || 1))));
  const r = $('dash-reset'); if (r) r.addEventListener('click', () => { save('win_s', KIOSK_DEF.win_s); save('bin_days', KIOSK_DEF.bin_days); });
}
function schoolPreviewHtml(text) {
  const P = parseSchoolPlan(text);
  if (!P.periods.length) return P.errors.length ? `⚠︎ Keine Zeile erkannt (Zeile ${P.errors.join(', ')}). Format: <code>08:10-08:55 | Mo | Di | Mi | Do | Fr</code>` : '';
  const cs = 'style="text-align:left;white-space:normal;word-break:break-word;padding:4px 3px;vertical-align:top"';
  const head = `<tr><th ${cs}>Zeit</th>` + SCHOOL_DAYS.map(d => `<th ${cs}>${d.slice(0, 2)}</th>`).join('') + '</tr>';
  const body = P.periods.map(p => `<tr><td ${cs}>${p.from}<br>${p.to}</td>` +
    p.subj.map(x => `<td ${cs}>${x ? esc(x) : '<span style="color:var(--muted)">–</span>'}</td>`).join('') + '</tr>').join('');
  return `<table class="pvt" style="font-size:11px;table-layout:fixed;width:100%">${head}${body}</table>` +
    (P.errors.length ? `<div class="note" style="margin-top:4px">⚠︎ Zeile ${P.errors.join(', ')} nicht erkannt (Format: Zeit | Mo | Di | Mi | Do | Fr).</div>` : '');
}
function renderSchoolSetup() {
  const ta = $('school-plan'), ti = $('school-title'); if (!ta) return;
  let t = '', tt = ''; try { t = localStorage.getItem('bhe_school_plan') || ''; tt = localStorage.getItem('bhe_school_title') || ''; } catch (e) {}
  if (document.activeElement !== ta && !ta.dataset.dirty) ta.value = t;
  if (ti && document.activeElement !== ti && !ti.dataset.dirty) ti.value = tt;
  const pv = $('school-preview'); if (pv) pv.innerHTML = schoolPreviewHtml(ta.value);
}
function initSchoolSetup() {
  const ta = $('school-plan'), ti = $('school-title'), b = $('school-save'), pv = $('school-preview'), note = $('school-note');
  if (ta) ta.addEventListener('input', () => { ta.dataset.dirty = '1'; if (pv) pv.innerHTML = schoolPreviewHtml(ta.value); });
  if (ti) ti.addEventListener('input', () => { ti.dataset.dirty = '1'; });
  if (b) b.addEventListener('click', () => {
    const P = parseSchoolPlan(ta ? ta.value : '');
    try {
      localStorage.setItem('bhe_school_plan', ta ? ta.value.trim() : '');
      localStorage.setItem('bhe_school_title', ti ? ti.value.trim() : '');
    } catch (e) {}
    if (ta) delete ta.dataset.dirty; if (ti) delete ti.dataset.dirty;
    if (note) note.innerHTML = P.periods.length ? `✅ Gespeichert – ${P.periods.length} Stunden je Tag. Das Wohn-Dashboard zeigt ihn innerhalb einer Minute.`
      : (ta && ta.value.trim() ? '⚠︎ Gespeichert, aber keine Zeile erkannt.' : 'Stundenplan entfernt.');
    if (kioskOpen()) { try { paintKiosk(); } catch (e) {} }
  });
}
function initCalSetup() {
  initDashSetup();
  initSchoolSetup();
  const b = $('cal-save'); if (b) b.addEventListener('click', calSave);
  const c = $('cal-clear'); if (c) c.addEventListener('click', calClear);
  const s = $('awb-search'); if (s) s.addEventListener('click', awbSearch);
  const x = $('awb-clear'); if (x) x.addEventListener('click', awbClear);
  ['awb-street', 'awb-nr'].forEach(id => { const e = $(id); if (e) e.addEventListener('keydown', ev => { if (ev.key === 'Enter') awbSearch(); }); });
  const f = $('awb-found');
  if (f) f.addEventListener('click', ev => { const t = ev.target.closest('[data-awb]'); if (t) awbPick(JSON.parse(t.dataset.awb)); });
}

/* ---- Setup → Müllabfuhr (AWB Köln) ------------------------------------------- */
function awbNextHtml(nxt) {
  if (!nxt || !nxt.length) return '';
  return nxt.slice(0, 6).map(d => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px;white-space:nowrap">` +
    `<span style="width:9px;height:9px;border-radius:50%;background:${esc(d.color)}"></span>` +
    `${new Date(d.date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' })} ${esc(d.label)}</span>`).join('');
}
async function renderAwbSetup() {
  const st = $('awb-status'); if (!st) return;
  try {
    const r = await api('/api/awb/config');
    const clr = $('awb-clear');
    if (r && r.available === false) st.textContent = 'Das AWB-Modul fehlt in der Bridge (bridge/awb_koeln.py) – bitte die Bridge aktualisieren.';
    else if (r && r.configured) st.innerHTML = `✅ <b>${esc(r.label || 'Adresse eingetragen')}</b>` +
      (r.error ? `<br>⚠︎ ${escIp(r.error)}` : '') + (r.next && r.next.length ? `<br>Nächste Abholungen: ${awbNextHtml(r.next)}` : '');
    else st.textContent = 'Noch keine Adresse eingetragen.';
    if (clr) clr.hidden = !(r && r.configured);
  } catch (e) { st.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
}
async function awbSearch() {
  const note = $('awb-note'), out = $('awb-found'), b = $('awb-search');
  const street = (($('awb-street') || {}).value || '').trim(), nr = (($('awb-nr') || {}).value || '').trim();
  if (street.length < 3 || !nr) { if (note) note.textContent = 'Bitte Straße (mind. 3 Buchstaben) und Hausnummer eingeben.'; return; }
  if (b) b.disabled = true;
  if (out) out.innerHTML = '';
  if (note) note.textContent = 'Frage die AWB …';
  try {
    const r = await api('/api/awb/streets?street=' + encodeURIComponent(street) + '&nr=' + encodeURIComponent(nr));
    if (!r || !r.ok) { if (note) note.textContent = (r && r.error) || 'Suche nicht möglich.'; return; }
    if (!r.results.length) { if (note) note.textContent = 'Keine passende Adresse gefunden – Schreibweise prüfen (z. B. „Straße“ statt „Str.“).'; return; }
    if (note) note.textContent = r.results.length === 1 ? 'Gefunden – antippen zum Übernehmen:' : `${r.results.length} Treffer – deine Adresse antippen:`;
    if (out) out.innerHTML = r.results.slice(0, 12).map(x => `<button class="btn sec" data-awb='${esc(JSON.stringify(x))}' ` +
      `style="text-align:left; margin-top:6px">🏠 ${esc(x.label)}</button>`).join('');
  } catch (e) {
    if (note) note.textContent = 'Suche nur möglich, wenn die Seite von der Bridge geöffnet ist.';
  } finally { if (b) b.disabled = false; }
}
async function awbPick(x) {
  const note = $('awb-note'), out = $('awb-found');
  if (note) note.textContent = 'Lade die Abfuhrtermine …';
  try {
    const r = await postJSON('/api/awb/config', x);
    if (r && r.ok) {
      if (out) out.innerHTML = '';
      if (note) note.innerHTML = `✅ Gespeichert: <b>${esc(x.label)}</b> – ${r.count} Abfuhrtermine im nächsten Jahr.` +
        (r.next && r.next.length ? `<br>${awbNextHtml(r.next)}` : '') +
        (r.types && r.types.length ? `<br><small style="color:var(--muted)">Tonnenarten laut AWB: ${r.types.map(esc).join(', ')}</small>` : '');
      _kioskCal = null;
    } else if (note) note.textContent = (r && r.error) || 'Nicht gespeichert.';
  } catch (e) { if (note) note.textContent = 'Speichern nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  renderAwbSetup();
}
async function awbClear() {
  if (!confirm('Müllabfuhr-Termine aus dem Wohn-Dashboard entfernen?')) return;
  try { await postJSON('/api/awb/config', { clear: true }); } catch (e) {}
  _kioskCal = null;
  const note = $('awb-note'); if (note) note.textContent = 'Entfernt.';
  renderAwbSetup();
}

function initHpDiag() {
  const b = $('hp-diag'); if (b) b.addEventListener('click', hpDiag);
  const cp = $('hp-diag-copy');
  if (cp) cp.addEventListener('click', async () => {
    const ok = await copyText(_hpDiagText || '');
    cp.textContent = ok ? '✅ Kopiert' : 'Bitte Text markieren und kopieren';
    setTimeout(() => { cp.textContent = '📋 Ergebnis kopieren'; }, 2500);
  });
  // "Verbindung testen" link on the heat-pump card → Setup, run the test
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('[data-hp-diag]'); if (!a) return;
    e.preventDefault();
    switchView('settings');
    setTimeout(() => { const c = $('homecom-card'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); hpDiag(); }, 250);
  });
}

/* ---- Setup → "Startzeit": what this start cost, measured ------------------ */
let _perfSrv = null, _perfBusy = false;
async function renderPerf(bench) {
  const body = $('perf-body'), head = $('perf-head'), note = $('perf-note');
  if (!body) return;
  const t = PERF.t, ms = v => (v == null ? '–' : fmt(v, 0) + ' ms');
  const row = (l, v, sub) => `<div class="devrow"><div class="nm"><b>${l}</b>${sub ? `<small>${sub}</small>` : ''}</div>` +
    `<div class="val"><b>${v}</b></div></div>`;
  const first = Math.min(t.paint_old != null ? t.paint_old : Infinity, t.paint_fresh != null ? t.paint_fresh : Infinity);
  let h = '';
  if (isFinite(first)) {
    h += row('Erste Zahlen sichtbar', ms(first), t.paint_old != null && t.paint_old <= first
      ? 'zuerst der letzte bekannte Stand' : 'direkt mit frischen Daten');
    if (t.paint_old != null) h += row('Frische Daten sichtbar', ms(t.paint_fresh), 'ersetzen den letzten Stand');
  } else {
    h += row('Erste Zahlen sichtbar', '–', STATE.demo ? 'Demo-Modus – keine Bridge-Messung' : 'klassischer Start (ohne Start-Anfrage)');
  }
  if (window.__bootT0 != null) {
    h += row('Start-Anfrage an die Bridge', window.__bootT1 != null ? ms(window.__bootT1 - window.__bootT0) : 'keine Antwort',
      `abgeschickt nach ${ms(window.__bootT0)}` + (PERF.bootMs == null ? ''
        : PERF.bootMs < 5 ? ' · Bridge hatte die Auswertung schon fertig' : ` · davon Rechenzeit der Bridge ${ms(PERF.bootMs)}`) +
      (PERF.bootStale ? ' · Bridge rechnete noch, lieferte den gespeicherten Stand' : ''));
  }
  h += row('App-Skript startklar', ms(t.script), 'geladen, eingelesen und ausgeführt');
  // how the app code travelled (same-origin resource timing)
  try {
    const e = performance.getEntriesByType('resource').find(r => /\/app\.js(\?|$)/.test(r.name));
    if (e) {
      const kb = v => fmt(v / 1024, 0) + ' kB';
      const cached = e.transferSize === 0 && e.decodedBodySize > 0;
      const how = e.transferSize == null ? '' : (cached ? 'aus dem Browser-Cache – nichts übertragen'
        : `${kb(e.transferSize)} übertragen` + (e.decodedBodySize ? ` (entpackt ${kb(e.decodedBodySize)})` : ''));
      h += row('App-Code (app.js)', ms(e.duration), how);
    }
  } catch (e) {}
  body.innerHTML = h + '<div class="note" style="margin-top:8px">Bridge wird abgefragt …</div>';
  if (STATE.demo || _perfBusy) { if (STATE.demo) body.innerHTML = h; return; }
  _perfBusy = true;
  if (bench && note) note.textContent = 'Bridge rechnet die drei Kern-Auswertungen ohne Cache neu …';
  try { _perfSrv = await api('/api/perf' + (bench ? '?bench=1' : '')); } catch (e) { _perfSrv = null; }
  _perfBusy = false;
  const p = _perfSrv;
  if (!p || !p.ok) { body.innerHTML = h + '<div class="note" style="margin-top:8px">Bridge-Werte nicht verfügbar (ältere Bridge?).</div>'; if (note) note.textContent = ''; return; }
  const core = (p.core || []).filter(c => c.ms != null);
  h += `<div style="font-weight:700;margin:12px 0 2px">Bridge</div>`;
  if (core.length) h += row('Rechenzeit Kern-Auswertungen', ms(Math.max.apply(null, core.map(c => c.ms))),
    core.map(c => `${esc(c.label)} ${ms(c.ms)}`).join(' · ') + ' (Übersicht enthält die beiden anderen)');
  const db = p.db || {}, ru = p.rollup || {};
  h += row('Datenbank', (db.size_mb != null ? fmt(db.size_mb, 0) + ' MB' : '–'),
    `${fmt(db.samples || 0, 0)} Messwerte · ${fmt(db.day_rows || 0, 0)} vorberechnete Tageswerte`);
  h += row('Tageswerte', ru.running ? 'wird umgerechnet …' : (ru.error ? 'Fehler' : 'aktuell'),
    ru.running ? `bisher ${fmt(ru.rows || 0, 0)} Tageswerte – läuft einmalig im Hintergrund`
      : (ru.error ? esc(ru.error) : 'abgeschlossene Tage werden nur einmal aus den Rohdaten berechnet'));
  body.innerHTML = h;
  if (head) head.innerHTML = isFinite(first) ? `<span style="color:var(--muted)">${ms(first)}</span>` : '';
  if (note) note.innerHTML = p.bench_ms != null
    ? `Kalt nachgerechnet in <b>${ms(p.bench_ms)}</b> (alle drei Kern-Auswertungen ohne Cache).` : '';
}

async function useBoot(boot) {
  const c = (boot && boot.core) || {};
  if (c.error || !c.ov || !c.hpA || !c.data) { loadAll(); return; }     // let the classic loader report it
  PERF.bootMs = c.ms; PERF.bootStale = !!c.stale;
  applyCoreState(c, boot.health, c.stale ? 'stale' : 'fresh');
  PERF.mark(c.stale ? 'paint_old' : 'paint_fresh');
  checkUpdate();                       // show the "update available" banner if behind
  loadOptional(boot.health, STATE.price);
  if (c.stale) {                       // the bridge was still computing → fetch the real thing
    try {
      const b2 = await api('/api/boot?days=90&fresh=1');
      if (b2 && b2.core && b2.core.ov) { applyCoreState(b2.core, b2.health, 'fresh'); PERF.mark('paint_fresh'); }
    } catch (e) { /* the 30 s refresh will catch up */ }
  }
}

async function bootApp() {
  PERF.mark('script');
  // Always-visible build stamp in the header, so you can tell at a glance on ANY
  // tab whether the browser loaded the current code (end of the cache confusion).
  try { const av = $('app-ver'); if (av) av.textContent = 'App-Stand: ' + APP_BUILD; } catch (e) {}
  STATE.demo = localStorage.getItem(LS.demo) === '1';
  const bootP = (!STATE.demo && window.__boot) ? window.__boot : null;
  if (!bootP) {
    // demo mode, or a page that did not send the early request: classic start
    await syncSettings();
    STATE.price = parseFloat(localStorage.getItem(LS.price) || '0.35');
    STATE.demo = localStorage.getItem(LS.demo) === '1';
    init();
    return;
  }
  const snap = snapLoad();
  let boot = null, failed = false;
  const settled = bootP.then(b => { boot = b; }, () => { failed = true; });
  // With a last state to show, do not keep the user waiting for a slow bridge;
  // without one there is nothing to draw yet anyway.
  await (snap ? Promise.race([settled, new Promise(r => setTimeout(r, 250))]) : settled);
  _bootDriven = true;
  if (boot) await applyServerSettings(boot.settings);
  STATE.price = parseFloat(localStorage.getItem(LS.price) || '0.35');
  init();
  if (boot) { await useBoot(boot); return; }
  if (snap) { applyCoreState(snap, snap.health, 'snap'); PERF.mark('paint_old'); }
  if (!failed) await settled;          // slow bridge: wait for it now that something is on screen
  if (boot) {
    await applyServerSettings(boot.settings);
    STATE.price = parseFloat(localStorage.getItem(LS.price) || '0.35');
    await useBoot(boot);
  } else {
    // no usable answer (bridge down, or an older bridge without /api/boot)
    if (!_settingsReady) await syncSettings();
    loadAll();
  }
}
document.addEventListener('DOMContentLoaded', bootApp);
