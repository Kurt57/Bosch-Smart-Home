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
const COL = { sh: '#4da3ff', hp: '#ef6c4d', heat: '#f6b93b', away: '#ff6b8a' };
const HP_MODE = { dhw: 'Warmwasser', ch: 'Heizung', cooling: 'Kühlen',
  frost: 'Frostschutz', off: 'Bereitschaft', '': 'Bereitschaft' };
const APP_VERSION = '2026-09-21 · Theorie-Monat 3 Reihen umschaltbar + HA-Anbindung + 60%-Kappung'
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

let STATE = {
  base: localStorage.getItem(LS.base) || '',
  price: parseFloat(localStorage.getItem(LS.price) || '0.35'),
  demo: localStorage.getItem(LS.demo) === '1',
  histSel: '14',
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

/* ---------------------------------------------------------- info tooltips */
const INFO = {
  wofuer: () => 'Aufteilung des heutigen Stroms nach Quelle. Die Wärmepumpe wird nach ' +
    '<b>Heizung</b> und <b>Warmwasser</b> getrennt (aus ihrem Betriebsmodus), dazu jedes Smart-Home-Gerät.',
  'ov-month': () => 'Hochrechnung für den laufenden Monat: dein durchschnittlicher Tagesverbrauch ' +
    '(Smart Home aus dem Zählerstand, Wärmepumpe aus dem Zählerwachstum) – <b>saisonal</b> für diesen ' +
    'Monat gewichtet und mit deinem kWh-Preis multipliziert.',
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
  'pv-batt': () => 'Linker Balken = dein PV-Ertrag, aufgeteilt in <b style="color:#4be0b0">direkt genutzt</b>, ' +
    '<b style="color:#7c5cff">über die Batterie genutzt</b> und <b style="color:#f6b93b">eingespeist</b>. ' +
    'Der lila Anteil ist genau das, was der <b>Speicher</b> bringt: sonst eingespeister Strom, den du dank ' +
    'Batterie selbst nutzt. Rechter Balken = dein <b>Verbrauch nach Quelle</b> ' +
    '(<b style="color:#4da3ff">Hausstrom</b>, <b style="color:#ef6c4d">Wärmepumpe</b>, ' +
    '<b style="color:#e26fb0">E-Auto</b>).',
  share: () => 'Anteil je Quelle über die <b>gemessenen</b> Tage im Zeitraum (kumulierte kWh). ' +
    'Geschätzte Tage zählen hier nicht mit.',
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
  ha: () => 'Liest Leistungs- und Energiesensoren aus deinem <b>Home Assistant</b> (lokal, über dessen REST-API mit ' +
    'einem Zugangs-Token). Damit kommen Geräte in die App, die die Bosch-Module nicht messen – z. B. eine alte ' +
    '<b>Koogeek-Steckdose</b>, die du in HA über den <b>HomeKit Controller</b> eingebunden hast: HA erledigt die ' +
    'HomeKit-Kopplung, wir lesen nur den fertigen <b>Watt-Wert</b>. Adresse und Token bleiben lokal auf der Bridge.',
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
    'gerechnet hat. Ersparnis kommt aus dem Tarifvergleich (bester Tarif mit PV vs. ohne).',
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
  'theory-month': () => 'Drei Balken je Monat, oben per Häkchen <b>ein-/ausblendbar</b>: <b>Theorie</b> (aus dem ' +
    'Gebäudemodell, Heizsaison-verteilt + Warmwasser), <b>Gemessen</b> (deine echten Monatswerte aus der HomeCom-CSV; ' +
    'stammt ein Monat noch aus dem <b>Vorjahr</b>, steht das dran) und <b>Erwartet</b> (dein <b>gemessenes Jahresniveau</b>, ' +
    'saisonal verteilt – so haben auch noch nicht gemessene Monate wie Nov/Dez eine echte Prognose statt des Vorjahreswerts). ' +
    'Große Unterschiede zeigen z. B. Nachtabsenkung, Vorlauftemperatur oder Wetter.',
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
// Household daily derived from the meter: real total minus the heat pump's
// seasonal share over the same months (household baseload is ~constant).
function meterHouseholdDaily() {
  const s = meterStats(); if (!s || s.dailyAvg == null) return null;
  const hpDaily = s.months.length ? mean(s.months.map(m => (hpMonthEst(m) || 0) / DIM[m])) : hpAvgDaily();
  return Math.max(0, s.dailyAvg - (hpDaily || 0));
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
function hpAvgDaily() {
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
  if (!im || !(im.monthly || []).length) return null;
  const cur = im.latest, byM = {};
  im.monthly.forEach(r => {
    if (r.month === cur || !(r.elec_kwh > 0)) return;
    const m = +r.month.slice(5) - 1, y = +r.month.slice(0, 4);
    if (!byM[m] || y > byM[m].year) byM[m] = { kwh: r.elec_kwh, year: y };
  });
  return Object.keys(byM).length ? byM : null;
}
// Full-month heat-pump electricity estimate for calendar month m.
function hpMonthEst(m) {
  const im = STATE.hpA && STATE.hpA.imported;
  const now = new Date();
  // current calendar month: scale the still-running partial value to a full month
  if (im && (im.monthly || []).length && m === now.getMonth()) {
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
  const hpMonth = hpMonthEst(m);
  const hpYear = hpYearFromMonthly() || hpAvgDaily() * 365;
  return {
    shYear: sh * 365, hpYear, year: sh * 365 + hpYear, yearCost: (sh * 365 + hpYear) * p,
    monthNow: shMonth + hpMonth, monthNowCost: (shMonth + hpMonth) * p,
    shMonth, hpMonth, hpImported: !!hpYearFromMonthly(),
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

async function loadAll() {
  if (STATE.demo) return applyDemo('demo');
  try {
    const health = await api('/api/health');
    STATE.health = health;
    STATE.cur = health.currency || '€';
    if (health.price_per_kwh && !localStorage.getItem(LS.price)) {
      STATE.price = health.price_per_kwh; $('price').value = STATE.price;
    }
    const p = STATE.price;
    const wantTib = health.tibber_connected || health.mode === 'demo';
    const wantHa = health.ha_connected || health.mode === 'demo';
    const [ov, hpA, data, appl, meter, sp, co2, tibCons, haData] = await Promise.all([
      api('/api/overview?days=90&price=' + p),
      api('/api/heatpump/analytics?days=90&price=' + p),
      api('/api/analytics?days=90&price=' + p),
      api('/api/appliances').catch(() => null),
      api('/api/meter').catch(() => null),
      api('/api/spot').catch(() => null),
      api('/api/carbon').catch(() => null),
      wantTib ? api('/api/tibber/consumption?resolution=DAILY&last=30').catch(() => null) : Promise.resolve(null),
      wantHa ? api('/api/ha').catch(() => null) : Promise.resolve(null),
    ]);
    STATE.ov = ov; STATE.hpA = hpA; STATE.data = data; STATE.appliances = appl;
    STATE.meter = (meter && meter.readings) || [];
    STATE.spot = sp;
    STATE.tibberCons = (tibCons && tibCons.ok) ? tibCons : null;
    STATE.ha = haData || null;
    STATE.carbon = (co2 && co2.ok) ? co2 : demoCarbon();
    STATE.cur = data.currency || STATE.cur;
    $('cur').textContent = STATE.cur;
    setMode(health.mode || 'live');
    $('diag').textContent = JSON.stringify(health, null, 1);
    renderAll();
  } catch (e) {
    STATE.health = null;
    $('conn-note').innerHTML =
      'Keine Bridge erreichbar (' + esc(e.message) + '). Es werden <b>Demo-Daten</b> gezeigt. ' +
      'Trage im Setup die Adresse deiner Bridge ein oder öffne diese Seite direkt von der Bridge.';
    applyDemo('err');
  }
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
  STATE.spot = { enabled: true, demo: true, market: 'demo', surcharge_ct: sc, vat: sv, prices };
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
    { entity_id: 'sensor.koogeek_p1eu_power', name: 'Koogeek P1EU – Leistung', kind: 'power', unit: 'W', watt: 47 },
    { entity_id: 'sensor.koogeek_p1eu_energy', name: 'Koogeek P1EU – Energie', kind: 'energy', unit: 'kWh', kwh: 128.4 },
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
function svg(h, inner) { return `<svg viewBox="0 0 ${CW} ${h}" preserveAspectRatio="none" role="img">${inner}</svg>`; }

function gridLines(h, top, base, pad, max) {
  let g = '';
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
  const max = Math.max(0.0001, ...values.map(v => v.v));
  const bw = (CW - pad * 2) / n, iw = Math.max(2, bw * 0.62);
  let bars = '', labels = '';
  values.forEach((d, i) => {
    const bh = (d.v / max) * (base - top);
    const x = pad + i * bw + (bw - iw) / 2, y = base - bh;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2.5" fill="${d.color || 'url(#g1)'}"/>`;
    if (d.label && (n <= 16 || i % Math.ceil(n / 12) === 0))
      labels += `<text class="axis" x="${(x + iw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${d.label}</text>`;
  });
  return svg(h, gridLines(h, top, base, pad, max) + bars + labels);
}

function stackedBar(rows, series, opts = {}) {
  const h = opts.h || 210, pad = 26, top = 12, base = h - 22;
  const n = rows.length || 1;
  const totals = rows.map(r => series.reduce((a, s) => a + Math.max(0, r.values[s.key] || 0), 0));
  const max = Math.max(0.0001, ...totals);
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
  return svg(h, gridLines(h, top, base, pad, max) + bars + labels);
}

function groupedBar(rows, series, opts = {}) {
  const h = opts.h || 200, pad = 26, top = 12, base = h - 22;
  const n = rows.length || 1;
  const max = Math.max(0.0001, ...rows.map(r => Math.max(...series.map(s => r.values[s.key] || 0))));
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
  return svg(h, gridLines(h, top, base, pad, max) + bars + labels);
}

function areaChart(values, opts = {}) {
  const h = opts.h || 200, pad = 26, top = 12, base = h - 22;
  const n = values.length;
  const max = Math.max(0.0001, ...values.map(v => v.v));
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
  return svg(h, gridLines(h, top, base, pad, max) +
    `<path d="${area}" fill="${opts.fill || 'url(#gArea)'}" opacity="0.55"/>` +
    `<path d="${line}" fill="none" stroke="${opts.stroke || 'url(#g1)'}" stroke-width="2.5" stroke-linejoin="round"/>` +
    labels);
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
    const hpDaily = s.months.length ? mean(s.months.map(m => (hpMonthEst(m) || 0) / DIM[m])) : hpAvgDaily();
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

function renderBorse() {
  const sp = STATE.spot;
  const off = $('borse-off-card');
  const cards = ['borse-now-card', 'borse-price-card', 'borse-best-card', 'borse-cost-card', 'borse-batt-card'];
  if (!sp || !sp.enabled || !(sp.prices && sp.prices.length)) {
    if (off) off.hidden = false;
    cards.forEach(id => { const el = $(id); if (el) el.hidden = true; });
    return;
  }
  if (off) off.hidden = true;
  cards.forEach(id => { const el = $(id); if (el) el.hidden = false; });
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
  if (!(invest > 0) || !(annualSavings > 0)) {
    $('fin-kpi').innerHTML = ''; $('fin-chart').innerHTML = '';
    $('fin-note').innerHTML = !(annualSavings > 0)
      ? 'Sobald oben eine <b>Ersparnis mit PV</b> herauskommt (Tab <b>PV</b> ausfüllen), rechne ich hier Kreditrate gegen Ersparnis.'
      : 'Trag deine <b>Investition</b> (PV/Speicher) und den Kreditzins ein.';
    return;
  }
  const cash = years <= 0;
  const annuity = cash ? 0 : (rate > 0 ? invest * rate / (1 - Math.pow(1 + rate, -years)) : invest / years);
  const N = 25, cum = [cash ? -invest : 0]; let be = null;
  for (let y = 1; y <= N; y++) {
    const sav = annualSavings * Math.pow(1 + infl, y - 1);
    const pay = (!cash && y <= years) ? annuity : 0;
    cum.push(cum[cum.length - 1] + sav - pay);
    if (be == null && cum[cum.length - 1] >= 0) be = y;
  }
  const yr1net = annualSavings - annuity;
  $('fin-kpi').innerHTML =
    `<div class="grid2"><div class="kpi sm"><div class="v">${money(annualSavings)}</div><div class="l">Stromersparnis / Jahr</div></div>` +
    `<div class="kpi sm"><div class="v">${cash ? '–' : money(annuity)}</div><div class="l">Kreditrate / Jahr${cash ? ' (bar bezahlt)' : ''}</div></div>` +
    `<div class="kpi sm"><div class="v" style="color:${yr1net >= 0 ? '#4be0b0' : '#ef6c4d'}">${yr1net >= 0 ? '+' : ''}${money(yr1net / 12)}</div><div class="l">Saldo / Monat (Kreditphase)</div></div>` +
    `<div class="kpi sm"><div class="v">${be ? be + ' J.' : '> 25 J.'}</div><div class="l">amortisiert nach</div></div></div>`;
  $('fin-chart').innerHTML = financeChart(cum, cash ? 0 : years);
  $('fin-note').innerHTML =
    (cash
      ? `Bar bezahlt: ab Jahr 1 sparst du <b>${money(annualSavings)}/Jahr</b> (steigt mit dem Strompreis). `
      : yr1net >= 0
        ? `Schon während der Kreditlaufzeit bist du <b>${money(yr1net)}/Jahr im Plus</b> (Ersparnis > Rate). `
        : `Während der ${years} Kreditjahre ist es rund <b>${money(-yr1net)}/Jahr teurer</b> (Rate > Ersparnis), ` +
          `<b>nach dem Abbezahlen</b> bleibt die volle Ersparnis (${money(annualSavings)}+/Jahr). `) +
    `Kumuliert nach 25 Jahren: <b>${money(cum[25])}</b>. ` +
    `<span style="color:var(--muted)">Ersparnis = bester Tarif mit PV vs. ohne, mit ${fmt(infl * 100, 0)} % Strompreis-Steigerung/Jahr; ` +
    `ohne Förderung/Wartung/Degradation. Kurve = kumulierter Saldo, gelbe Linie = Kredit abbezahlt.</span>`;
}
function renderKonzept() {
  if (!$('konzept-nopv')) return;
  const tar = tariffData(), price = STATE.price;
  const hhKwh = shAvgDaily() * 365;                       // household (incl. unmetered)
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
function renderAll() {
  renderOverview(); renderToday(); renderHistory(); renderHeatpump(); renderProfile(); renderPv(); renderSettings(); renderAppliances(); renderMeter(); renderBorse(); renderCarbon(); renderSmart(); renderKonzept(); renderHa();
}

function renderOverview() {
  const ov = STATE.ov; if (!ov) return;
  $('ov-today').innerHTML = fmt(ov.today.total_kwh, 1) + '<span> kWh</span>';
  $('ov-today-cost').textContent = eur(ov.today.cost) + ' · Stand ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  $('ov-now').textContent = fmt(ov.now.total_w, 0) + ' W';
  $('ov-now-hp').textContent = ov.now.heatpump_w != null ? fmt(ov.now.heatpump_w, 0) + ' W' : '–';
  const fc = annualForecast();
  $('ov-month').innerHTML = kwh(fc.monthNow, 0);
  $('ov-month-cost').textContent = money(fc.monthNowCost);

  const segs = ov.breakdown.filter(b => b.kwh > 0).map(b => ({ label: b.label, value: b.kwh, color: b.color }));
  $('ov-break-sum').textContent = kwh(ov.today.total_kwh, 1);
  $('ov-donut').innerHTML = segs.length
    ? donutChart(segs, { big: fmt(ov.today.total_kwh, 1), center: 'kWh heute' })
    : '<div class="note">Noch keine Verbrauchsdaten für heute.</div>';
  $('ov-legend').innerHTML = legendHtml(segs.slice(0, 8).map(s => ({ label: s.label, color: s.color, sub: kwh(s.value, 2) })));

  const now = new Date();
  const w = filledDaily(new Date(now.getTime() - 13 * 86400000), now);
  $('ov-daily').innerHTML = stackedBar(
    w.map(d => ({ label: shortDay(d.day), estimated: d.estimated, values: { sh: d.sh, hp: d.hp } })),
    [{ key: 'sh', color: COL.sh }, { key: 'hp', color: COL.hp }], { h: 200 });
  const estN = w.filter(d => d.estimated).length;
  const dn = $('ov-daily-note');
  if (dn) {
    dn.hidden = estN === 0;
    if (estN) dn.innerHTML = `Blasse Balken (${estN} Tage) sind geschätzt – die Bridge hatte an diesen Tagen noch keine Messung. Details unter <b>Verlauf</b>.`;
  }

  const card = $('ov-hp-card');
  if (ov.heatpump_connected) {
    card.hidden = false;
    $('ov-hp-cop').textContent = ov.heatpump.seasonal_cop ? 'JAZ ' + fmt(ov.heatpump.seasonal_cop, 2) : '';
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
function renderSavings() {
  const card = $('ov-savings-card'); if (!card) return;
  const price = STATE.price, L = [];
  // 1) always-on base load (measured Smart-Home devices)
  const prof = (STATE.data && STATE.data.hourly_profile) || [];
  const vals = prof.map(h => h.avg_w).filter(v => v != null);
  if (vals.length >= 24) {
    const baseW = mean(vals.slice().sort((a, b) => a - b).slice(0, 3));
    const eur = baseW * 0.3 / 1000 * 8760 * price;      // trimming ~30 % of the base load
    if (eur > 8) L.push({ label: 'Dauerverbraucher/Standby senken', hint: 'Profil → Grundlast', eur, color: COL.sh });
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
    if (mw && mw.water > 0 && nD > 0) wwYear = mw.water / nD * 365;
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
    const hpDaily = ms.months.length ? mean(ms.months.map(m => (hpMonthEst(m) || 0) / DIM[m])) : hpAvgDaily();
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
    hrs.map(h => ({ label: h.hour % 3 === 0 ? h.hour + '' : '', values: { sh: h.smarthome_kwh, hp: h.heatpump_kwh } })),
    [{ key: 'sh', color: COL.sh }, { key: 'hp', color: COL.hp }], { h: 190 })
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

  const HP_KEYS = new Set(['heatpump', 'hp_heating', 'hp_water', 'hp_other']);
  const devs = ov.breakdown.filter(b => !HP_KEYS.has(b.key) && b.kwh > 0);
  const maxD = Math.max(0.0001, ...devs.map(d => d.kwh));
  $('t-devices').innerHTML = devs.length
    ? devs.map(d => devRow(d.label, kwh(d.kwh, 3) + ' heute', kwh(d.kwh, 2), '', d.kwh / maxD * 100, COL.sh)).join('')
    : '<div class="note">Noch keine Gerätedaten für heute.</div>';
}

// Resolve the current Verlauf window [from,to] and the display mode.
function historyWindow() {
  const sel = STATE.histSel, now = new Date();
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

function renderHistory() {
  const ov = STATE.ov, data = STATE.data; if (!ov || !data) return;
  const shHex = COL.sh, hpHex = COL.hp;
  const win = historyWindow();
  const filled = filledDaily(win.from, win.to);
  const anyEst = filled.some(d => d.estimated);
  $('h-daily-legend').innerHTML = legendHtml([
    { label: 'Smart Home', color: shHex }, { label: 'Wärmepumpe', color: hpHex }]
    .concat(anyEst ? [{ label: 'geschätzt (Ø, saisonal)', color: 'rgba(147,162,196,.5)' }] : []));

  if (win.mode === 'month') {
    const months = aggregateMonths(filled);
    $('h-daily').innerHTML = stackedBar(
      months.map(m => ({ label: m.label, estimated: m.estimated, values: { sh: m.sh, hp: m.hp } })),
      [{ key: 'sh', color: shHex }, { key: 'hp', color: hpHex }], { h: 210 });
    const tot = months.map(m => m.total);
    $('h-avg').innerHTML = kwh(mean(months.map(m => m.total / 30.4)), 2);
    $('h-max').innerHTML = kwh(Math.max(0, ...tot), 0); $('h-max-l').textContent = 'Stärkster Monat';
  } else {
    $('h-daily').innerHTML = stackedBar(
      filled.map(d => ({ label: shortDay(d.day), estimated: d.estimated, values: { sh: d.sh, hp: d.hp } })),
      [{ key: 'sh', color: shHex }, { key: 'hp', color: hpHex }], { h: 210 });
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

  // cumulative share over the (measured) window: per Smart-Home device + heat pump
  const winKeys = new Set(filled.map(d => d.day));
  const pdd = data.per_device_day || {};
  const names = {}; (data.live.devices || []).forEach(d => names[d.id] = devLabel(d).title);
  const shares = [];
  Object.keys(pdd).forEach(id => {
    let s = 0; for (const day in pdd[id]) if (winKeys.has(day)) s += pdd[id][day];
    if (s > 0) shares.push({ label: names[id] || id, kwh: s, color: COL.sh });
  });
  const hpByDay = {}; ((ov.combined_daily) || []).forEach(d => hpByDay[d.day] = d.heatpump_kwh);
  let hpWin = 0; winKeys.forEach(k => { if (hpByDay[k]) hpWin += hpByDay[k]; });
  if (hpWin > 0) shares.push({ label: 'Wärmepumpe', kwh: hpWin, color: COL.hp });
  shares.sort((a, b) => b.kwh - a.kwh);
  const totShare = shares.reduce((a, s) => a + s.kwh, 0) || 1;
  $('h-share').innerHTML = shares.length
    ? shares.map(s => devRow(s.label, (s.kwh / totShare * 100).toFixed(0) + ' % (gemessen)', kwh(s.kwh, 1), '', s.kwh / totShare * 100, s.color)).join('')
    : '<div class="note">Noch keine gemessenen Daten im Zeitraum.</div>';

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
  const standbyYear = data.baseline_w * 24 * 365 / 1000;
  $('h-insights').innerHTML = [
    ['Hochrechnung / Jahr', `${kwh(fc.year, 0)} · ${money(fc.yearCost)}`],
    ['davon Wärmepumpe', fc.hpYear > 0 ? `${kwh(fc.hpYear, 0)} · ${money(fc.hpYear * price)}` + (fc.hpImported ? ' ✓' : '') : '–'],
    ['davon Smart Home', `${kwh(fc.shYear, 0)} · ${money(fc.shYear * price)}`],
    [`Prognose ${MON[m]}`, `${kwh(fc.monthNow, 0)} · ${money(fc.monthNowCost)}`],
    ['Wärmepumpe Winter vs. Sommer', fc.hpYear > 0
      ? `${kwh(hpMonthEst(0), 0)} (Jan) ↔ ${kwh(hpMonthEst(6), 0)} (Jul)` : '–'],
    ['Grundlast Smart Home / Jahr', `${kwh(standbyYear, 1)} · ${(S.standby_share * 100).toFixed(0)} %`],
    ['Vermutete Abwesenheit', `${A.count} Tage · ~${money(A.count * (S.day_avg_cost || 0))}`],
  ].map(([k, v]) => statusRow(k, v)).join('');
  renderTibberCons();
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
// A horizontal energy-class scale (kWh/m²·a heating) with a marker.
function classBar(spec) {
  const h = 56, top = 8, barH = 16, y = top, max = 200;
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
  const marker = `<path d="M${mx.toFixed(1)} ${y - 1} l-5 -7 l10 0 z" fill="#fff"/>` +
    `<line x1="${mx.toFixed(1)}" y1="${y}" x2="${mx.toFixed(1)}" y2="${y + barH}" stroke="#fff" stroke-width="2"/>`;
  return svg(h, rects + marker + ticks);
}
function buildClass(spec) {
  if (spec <= 15) return ['Passivhaus-Niveau', '#2ecc71'];
  if (spec <= 45) return ['KfW-Effizienzhaus-Niveau', '#4be0b0'];
  if (spec <= 90) return ['Neubau / gut saniert', '#f6b93b'];
  if (spec <= 140) return ['typischer sanierter Altbau', '#f39c12'];
  return ['wenig gedämmter Altbau', '#ef6c4d'];
}
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
    const annualExp = hpYearFromMonthly() || (hpAvgDaily() * 365);
    const expectedMonth = MON.map((_, m) => annualExp * hpSeasShare[m]);
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

    const series = [];
    if (on('thm-t')) series.push({ key: 't', color: 'url(#gHeat)' });
    if (pOn) series.push({ key: 'p', color: COL.sh });
    if (on('thm-e')) series.push({ key: 'e', color: 'rgba(56,189,216,0.85)' });
    const rows = MON.map((lbl2, m) => ({
      label: lbl2, values: {
        t: theoryMonth[m],
        p: measured && measured[m] ? measured[m].kwh : 0,
        e: expectedMonth[m],
      } }));
    $('hp-theory-month').innerHTML = series.length
      ? groupedBar(rows, series, { h: 190 })
      : '<div class="note">Alle Reihen ausgeblendet – oben wieder anhaken.</div>';
    $('hp-theory-month-legend').innerHTML = legendHtml([
      on('thm-t') ? { color: COL.heat, label: 'Theorie' } : null,
      pOn ? { color: COL.sh, label: measLabel } : null,
      on('thm-e') ? { color: '#38bdd8', label: 'Erwartet (Erfahrung)' } : null,
    ].filter(Boolean));
    // note: compare measured vs theory over the measured months
    if (measured) {
      let worst = null, sT = 0, sP = 0;
      Object.keys(measured).forEach(mk => {
        const m = +mk, abs = measured[m].kwh - theoryMonth[m];
        sT += theoryMonth[m]; sP += measured[m].kwh;
        if (!worst || Math.abs(abs) > Math.abs(worst.abs)) worst = { m, abs };
      });
      const totPct = sT > 0 ? (sP - sT) / sT : 0;
      const prevMonths = Object.keys(measured).filter(m => measured[m].year < curY).map(m => MON[+m]);
      $('hp-theory-month-note').innerHTML =
        'Drei Reihen je Monat – oben ein-/ausblendbar: <b>Theorie</b> (Gebäudemodell), <b>' + esc(measLabel) +
        '</b> (echte Messung) und <b>Erwartet</b> (dein gemessenes Jahresniveau, saisonal verteilt – auch für noch nicht ' +
        'gemessene Monate wie Nov/Dez). ' +
        `Über die gemessenen Monate liegt die Praxis <b>${totPct >= 0 ? '+' : ''}${fmt(totPct * 100, 0)} %</b> zur Theorie.` +
        (worst ? ` Größter Unterschied im <b>${MON[worst.m]}</b> (${worst.abs >= 0 ? '+' : '−'}${kwh(Math.abs(worst.abs), 0)}` +
          `${worst.abs > 0 ? ' – mehr als gerechnet' : ' – weniger, z. B. kaum geheizt/effizient'}).` : '') +
        (prevMonths.length ? ` <span style="color:var(--muted)">Noch aus dem Vorjahr: ${prevMonths.join(', ')} – dafür zeigt „Erwartet" die aktuelle Prognose.</span>` : '');
    } else {
      $('hp-theory-month-note').innerHTML = 'Zwei Reihen: <b>Theorie</b> (Gebäudemodell) und <b>Erwartet</b> ' +
        '(aus deinem gemessenen Niveau, saisonal verteilt). Für echte Monatsmesswerte importiere im Setup eine ' +
        '<b>HomeCom-CSV</b> – dann kommt die Reihe „Gemessen" dazu.';
    }
  }

  // ---- Gebäude-Einordnung (kWh/m²·a Heizwärmebedarf) -------------------
  const spec = b.area > 0 ? r.qHeat / b.area : 0;
  const [cls, col] = buildClass(spec);
  $('hp-theory-class').innerHTML = classBar(spec);
  $('hp-theory-class-note').innerHTML = `Dein <b>spezifischer Heizwärmebedarf</b> ist ~<b style="color:${col}">` +
    `${fmt(spec, 0)} kWh/m²·a</b> → <b>${cls}</b>. Zum Einordnen: Passivhaus &lt;15, KfW ~30–45, Neubau ~55–70, ` +
    `unsanierter Altbau ~150–250. (Nur Heizung, ohne Warmwasser; Marker oben.)`;

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
    if (l.supply_c != null && l.return_c != null) rows.push(['Vor-/Rücklauf', fmt(l.supply_c, 1) + ' / ' + fmt(l.return_c, 1) + ' °C']);
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
    body.innerHTML = `<div class="note" style="margin:-2px 0 10px">${hpStatusPill(l)}</div>` +
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
  ].filter(s => s.value > 0.01);
  const mTot = mSegs.reduce((a, s) => a + s.value, 0);
  $('hp-mode-sum').textContent = mTot > 0 ? kwh(mTot, 0) : '';
  $('hp-mode-donut').innerHTML = mSegs.length
    ? donutChart(mSegs, { big: mTot >= 100 ? fmt(mTot, 0) : fmt(mTot, 1), center: 'kWh Strom' })
    : '<div class="note">Sobald die Bridge Betriebsdaten gesammelt hat, erscheint hier die Aufteilung Heizung/Warmwasser.</div>';
  $('hp-mode-legend').innerHTML = legendHtml(mSegs.map(s => ({
    label: s.label, color: s.color, sub: kwh(s.value, 0) + ' · ' + (s.value / mTot * 100).toFixed(0) + ' %' })));
  // warm-water: annual electricity & cost, plus an optimisation hint
  const nDays = (A.daily || []).length;
  const waterKwh = mw.water || 0;
  if (waterKwh > 0.01 && nDays > 0 && mTot > 0) {
    const price = STATE.price;
    const waterYear = waterKwh / nDays * 365, waterCost = waterYear * price;
    const sharePct = waterKwh / mTot * 100;
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
      `${fmt(sharePct, 0)} % des Wärmepumpen-Stroms. ` + tip;
  } else { $('hp-mode-note').innerHTML = ''; }

  const daily = (A.daily || []).slice(-30);
  $('hp-daily').innerHTML = daily.length ? groupedBar(
    daily.map(d => ({ label: shortDay(d.day), values: { e: d.elec_kwh, h: d.heat_kwh } })),
    [{ key: 'e', color: COL.hp }, { key: 'h', color: COL.heat }], { h: 200 })
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
    [{ key: 'e', color: COL.hp }, { key: 'h', color: COL.heat }], { h: 180 })
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
  $('chart-hourly').innerHTML = areaChart(prof.map(h => ({ v: h.avg_w, label: h.hour % 3 === 0 ? h.hour + '' : '' })), { h: 190 });
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
  renderBehavior();
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
    `• <b>Mess-Steckdosen</b> (z. B. Shelly Plug&nbsp;S) an großen Verbrauchern – zeigt Einzelwerte.<br>` +
    `• <b>Zähler auslesen</b> am Hauptzähler (z. B. Shelly&nbsp;3EM oder ein Lesekopf/Tibber Pulse) misst den ` +
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
  const shShape = normFrac((STATE.data && STATE.data.hourly_profile || []).map(h => h.avg_w));
  const hpProf = (STATE.hpA && STATE.hpA.hourly_profile) || [];
  const hpShape = hpProf.length && hpProf.some(h => h.avg_w > 0)
    ? normFrac(hpProf.map(h => h.avg_w)) : new Array(24).fill(1 / 24);
  const shDaily = shAvgDaily();
  const hpDaily = hpAvgDaily();
  const hpAnnual = hpDaily * 365;
  const pvShare = pvMonth(), hpSeas = normFrac(HP_SEASON);
  let Y = 0, S = 0, F = 0, G = 0, L = 0, repDay = null;
  const monthly = [];
  const evDayBase = p.evAnnual / 365;
  const useReal = !!hpRealMonthMap();
  const acShare = normFrac(AC_MONTH);
  for (let m = 0; m < 12; m++) {
    const days = new Date(2025, m + 1, 0).getDate();
    const dayPv = (p.kwp * p.spec * pvShare[m]) / days;
    // prefer real monthly heat-pump consumption when a CSV was imported
    const dayHp = (useReal ? hpMonthEst(m) : hpAnnual * (0.35 * (days / 365) + 0.65 * hpSeas[m])) / days;
    const dayEv = evDayBase * (1 + 0.12 * Math.cos(2 * Math.PI * m / 12)); // a bit more in winter
    const dayAc = (p.acAnnual * acShare[m]) / days;
    const pvH = pvHourFractions(m);
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
        mDirect += direct; mBatt += dis + carDis; mFeed += feed; mGrid += grid; mPv += pv; mLoad += load;
        if (m === 6 && d === Math.floor(days / 2)) { capturePv.push(pv); captureLoad.push(load); }
      }
      if (capturePv.length) { dPv = capturePv; dLoad = captureLoad; }
    }
    const mSelf = mDirect + mBatt;
    Y += mPv; S += mSelf; F += mFeed; G += mGrid; L += mLoad;
    monthly.push({ m, pv: mPv, load: mLoad, self: mSelf, direct: mDirect, batt: mBatt, feed: mFeed, grid: mGrid,
      loadSh: mSh, loadHp: mHp, loadEv: mEv, loadAc: mAc });
    if (dPv) repDay = { pv: dPv, load: dLoad };
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
    monthly, repDay,
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
  const shDaily = shAvgDaily(), hpDaily = hpAvgDaily(), hpAnnual = hpDaily * 365;
  const pvShare = pvMonth(), hpSeas = normFrac(HP_SEASON), acShare = normFrac(AC_MONTH);
  const useReal = !!hpRealMonthMap(), evDayBase = p.evAnnual / 365;
  let C = 0;
  for (let m = 0; m < 12; m++) {
    const days = new Date(2025, m + 1, 0).getDate();
    const clearDays = Math.max(1, Math.round(days * 0.30));       // ~30 % of days are clear
    const clearDayPv = (p.kwp * p.spec * pvShare[m]) * 0.55 / clearDays;  // carrying ~55 % of the month's yield
    const pvH = pvHourFractions(m);
    const dayHp = (useReal ? hpMonthEst(m) : hpAnnual * (0.35 * (days / 365) + 0.65 * hpSeas[m])) / days;
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

// Per month: a stacked PV bar (direct self / battery self / feed-in) next to a
// consumption bar – shows what the battery shifts from feed-in to self-use.
const PVC = { direct: '#4be0b0', batt: '#7c5cff', feed: '#f6b93b',
  sh: '#4da3ff', hp: '#ef6c4d', ev: '#e26fb0', ac: '#38bdd8' };
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
  const load = simulatePv({ ...p, kwp: 0.0001 }).load_kwh;
  const coverK = load / (p.spec || 1000);
  const maxK = Math.min(60, Math.max(24, Math.ceil(coverK * 3.5), Math.ceil(cur * 1.5)));
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
  const knee = pts.find(x => x.self < 0.32) || pts[pts.length - 1];
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

function pvDayChart(pv, load) {
  const h = 190, pad = 26, top = 12, base = h - 22, n = 24;
  const max = Math.max(0.0001, ...pv, ...load);
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
  return svg(h, gridLines(h, top, base, pad, max) +
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
    if (d.count > 0) vlab += `<text x="${(x + iw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" style="font-size:11px;font-weight:700;fill:var(--ink)">${d.count}</text>`;
    labels += `<text class="axis" x="${(x + iw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle"${isCur ? ' style="fill:#4da3ff;font-weight:700"' : ''}>${d.kwp}${isCur ? '★' : ''}</text>`;
    hits += `<rect class="gfhit" data-kwp="${d.kwp}" data-count="${d.count}" x="${(pad + i * gw).toFixed(1)}" y="${top}" width="${gw.toFixed(1)}" height="${(base - top).toFixed(1)}" fill="#000" opacity="0" pointer-events="all"/>`;
  });
  return svg(h, gridLines(h, top, base, pad, max) + bars + vlab + labels + hits);
}
function showGfTip(kwp, count) {
  const t = $('toast'); if (!t) return;
  t.innerHTML = `<b>${kwp} kWp</b> → <b style="color:${count >= 5 ? '#4be0b0' : count >= 2 ? '#f6b93b' : '#ef6c4d'}">${count} von 12 Monaten</b> ohne Netzbezug`;
  t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 6000);
}
// In which months could you run entirely without grid power – and how does
// that change with a bigger PV array?
function renderPvGridFree(p) {
  const el = $('pv-gridfree'); if (!el) return;
  const cur = Math.max(1, Math.round(p.kwp || 0));
  const gridFreeMonths = kwp =>            // month indices with ~zero grid import
    simulatePv({ ...p, kwp }).monthly.filter(mm => mm.grid <= Math.max(2, mm.load * 0.01)).map(mm => mm.m);

  // --- headline + 12-month strip for the CURRENT array ---
  const curSet = new Set(gridFreeMonths(cur));
  const n = curSet.size;
  $('pv-gridfree-kpi').innerHTML =
    `<div class="kpi"><div class="v" style="color:${n >= 5 ? '#4be0b0' : n >= 2 ? '#f6b93b' : '#ef6c4d'}">` +
    `${n} <span style="font-size:16px;color:var(--muted)">von 12</span></div>` +
    `<div class="l">Monaten deckst du dich <b>komplett selbst</b> (${fmt(cur, 0)} kWp · ${kwh(p.batt, 0)} Speicher)</div></div>`;
  $('pv-gridfree-strip').innerHTML = '<div style="display:flex; gap:3px">' + MON.map((mn, m) => {
    const on = curSet.has(m);
    return `<div style="flex:1; text-align:center; padding:7px 0; border-radius:6px; font-size:11px; font-weight:600;` +
      `background:${on ? 'rgba(75,224,176,.22)' : 'var(--bg2)'}; color:${on ? '#4be0b0' : 'var(--muted)'}">${mn[0]}</div>`;
  }).join('') + '</div>';
  $('pv-gridfree-strip-note').innerHTML = n
    ? `<span style="color:#4be0b0">Grün</span> = kein Netzstrom nötig (${[...curSet].map(m => MON[m]).join(', ')}). ` +
      `Grau = du beziehst noch etwas Netzstrom.`
    : 'In allen Monaten brauchst du noch etwas Netzstrom. Die grünen Sommermonate erreichst du mit mehr kWp/Speicher.';

  // --- sweep: netzfreie Monate je Anlagengröße ---
  const maxK = Math.max(12, cur + 6);
  const step = Math.max(1, Math.ceil(maxK / 15));
  const kwps = [];
  for (let k = step; k <= maxK; k += step) kwps.push(k);
  if (!kwps.includes(cur) && cur <= maxK) { kwps.push(cur); kwps.sort((a, b) => a - b); }
  const data = kwps.map(k => ({ kwp: k, count: gridFreeMonths(k).length }));
  el.innerHTML = gridFreeSweepChart(data, cur);
  const maxAch = Math.max(...data.map(d => d.count));
  const satK = (data.find(d => d.count >= maxAch) || {}).kwp;
  $('pv-gridfree-note').innerHTML =
    `Balkenhöhe = netzfreie Monate, X-Achse = Anlagengröße in kWp (★ = deine ${fmt(cur, 0)} kWp). ` +
    (maxAch > n ? `Mit ~<b>${fmt(satK, 0)} kWp</b> wären es bis zu <b>${maxAch} Monate</b>. ` : '') +
    `Mehr bringt es kaum: die dunklen <b>Wintermonate</b> bekommst du mit PV allein nie netzfrei ` +
    `(zu wenig Sonne). Dort hilft nur Netzbezug – idealerweise günstig über einen <b>Börsentarif</b>.`;
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

  $('pv-day').innerHTML = r.repDay ? pvDayChart(r.repDay.pv, r.repDay.load)
    : '<div class="note">Kein Tagesprofil verfügbar.</div>';

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
        ? '<b>Demo</b> – Beispiel-Sensoren (Koogeek P1EU). Auf deiner Bridge dein echtes Home Assistant verbinden.'
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
    if (r.ok) { note.innerHTML = '✅ ' + esc(r.message || 'Verbunden.'); setTimeout(loadAll, 1500); }
    else note.innerHTML = '⚠︎ ' + esc(r.error || 'Verbindung fehlgeschlagen.');
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
      note.innerHTML = '✅ ' + esc(r.message || 'Verbunden.');
      $('aeg-refresh').value = ''; $('aeg-access').value = '';   // don't leave tokens on screen
      setTimeout(loadAll, 1500);
    } else note.innerHTML = '⚠︎ ' + esc(r.error || 'Verbindung fehlgeschlagen.');
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
  btn.disabled = false;
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
      note.innerHTML = '✅ ' + esc(r.message || 'Verbunden.') + (n ? ` (${n} Sensor(en))` : '');
      $('ha-token').value = '';                     // don't leave the token on screen
      setTimeout(loadAll, 1200);
    } else note.innerHTML = '⚠︎ ' + esc(r.error || 'Verbindung fehlgeschlagen.');
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
      note.innerHTML = '✅ ' + esc(r.message || 'Verbunden.');
      $('tibber-token').value = '';                 // don't leave the token on screen
      setTimeout(loadAll, 1200);
    } else note.innerHTML = '⚠︎ ' + esc(r.error || 'Verbindung fehlgeschlagen.');
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

async function doPvgis() {
  const note = $('pv-pvgis-note'), btn = $('pv-pvgis');
  const lat = parseFloat($('pv-lat').value), lon = parseFloat($('pv-lon').value);
  if (!isFinite(lat) || !isFinite(lon)) { note.textContent = 'Bitte Breiten- und Längengrad eingeben (oder „Mein Standort").'; return; }
  const tilt = parseFloat($('pv-tilt').value) || 35, az = parseFloat($('pv-az').value) || 0;
  btn.disabled = true; note.textContent = 'Frage PVGIS für deinen Standort …';
  try {
    const r = await api(`/api/pvgis?lat=${lat}&lon=${lon}&tilt=${tilt}&az=${az}`);
    if (!r || r.ok === false) { note.textContent = '⚠︎ ' + ((r && r.error) || 'PVGIS-Abruf fehlgeschlagen.'); btn.disabled = false; return; }
    if (r.yield) {
      // add/replace a PVGIS option in the yield dropdown and select it
      const sel = $('pv-orient');
      let opt = [...sel.options].find(o => o.dataset.pvgis);
      if (!opt) { opt = document.createElement('option'); opt.dataset.pvgis = '1'; sel.appendChild(opt); }
      opt.value = Math.round(r.yield); opt.textContent = `PVGIS Standort: ${Math.round(r.yield)} kWh/kWp`;
      sel.value = opt.value;
      try { localStorage.setItem(PV_LS.orient, opt.value); } catch (e) {}
    }
    if (Array.isArray(r.monthly) && r.monthly.every(v => v > 0)) {
      try { localStorage.setItem(PV_LS.pgm, JSON.stringify(r.monthly)); } catch (e) {}
    }
    note.innerHTML = `✅ Übernommen: <b>${Math.round(r.yield)} kWh/kWp</b> und die Monatskurve für deinen Standort` +
      (r.demo ? ' <span style="color:var(--muted)">(Demo)</span>' : '') + '.';
    renderPv(); renderKonzept();
  } catch (e) { note.textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
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
  $('hp-fc-note').innerHTML = `Quelle: <b>Open-Meteo</b>${w.tz === 'demo' ? ' <span style="color:var(--muted)">(Demo)</span>' : ''}. ` +
    `Summe der ${days.length} Tage: <b>${kwh(total, 0)}</b> (~${money(total * price)}). Grobe Schätzung aus deinem Gebäudemodell.`;
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
    waterWP: find(['verbrauchteenergie', 'wärmepumpe', 'warmwasser']),
    waterEH: find(['verbrauchteenergie', 'elektrischerzuheizer', 'warmwasser']),
    outdoor: r2.findIndex(c => norm(c).includes('temperatur') && norm(c).includes('aussen') || norm(c).includes('außentemperatur')),
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
      outdoor_c: at(c, idx.outdoor),
    });
  }
  return { rows };
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
      note.innerHTML = '✅ ' + esc(r.message) + ` Gesamt: <b>${r.total_days}</b> Tage, <b>${r.total_months}</b> Monate` +
        (r.total_hours ? `, <b>${r.total_hours}</b> Stunden` : '') + '.';
      setTimeout(loadAll, 800);
    } else note.innerHTML = '⚠︎ ' + esc(r.error || 'Import fehlgeschlagen.');
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – Seite von der Bridge geöffnet?'; }
  inp.value = '';
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
    note.innerHTML = '⚠︎ Export nur möglich, wenn die Seite von der <b>Bridge</b> geladen ist (' + esc(e.message) + ').';
  }
}

async function doBridgeUpdate() {
  const note = $('bridge-update-note'), btn = $('bridge-update');
  btn.disabled = true; note.textContent = 'Hole neuesten Code & starte neu …';
  try {
    const r = await postJSON('/api/update', {});
    if (r.ok && r.changed) {
      note.innerHTML = '✅ ' + esc(r.message);
      // the bridge re-execs; wait, then hard-reload fresh code
      setTimeout(hardRefresh, 6000);
      return; // keep button disabled while restarting
    } else if (r.ok) {
      note.innerHTML = 'ℹ️ ' + esc(r.message || 'Bereits aktuell.');
    } else {
      note.innerHTML = '⚠︎ ' + esc(r.error || 'Update fehlgeschlagen.') +
        (r.output ? `<br><small>${esc(r.output)}</small>` : '');
    }
  } catch (e) {
    note.textContent = 'Fehler: ' + e.message + ' – geht nur, wenn die Seite von der Bridge geöffnet ist.';
  }
  btn.disabled = false;
}

async function doDiscover() {
  const note = $('discover-note');
  note.textContent = 'Suche Controller im Netzwerk … (kann ein paar Sekunden dauern)';
  try {
    const r = await api('/api/discover');
    if (r.suggested) {
      $('shc-ip').value = r.suggested;
      note.innerHTML = `Gefunden: <b>${esc(r.candidates.join(', '))}</b> – oben übernommen. Passt das nicht, IP manuell eintragen.`;
    } else {
      note.innerHTML = `Nichts gefunden im Bereich ${esc(r.scanned)}. IP bitte manuell eintragen.`;
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
      note.innerHTML = '✅ ' + (r.message || 'Erfolgreich gekoppelt.');
      STATE.demo = false; localStorage.setItem(LS.demo, '0');
      setTimeout(loadAll, 1400);
    } else {
      note.innerHTML = '⚠︎ ' + esc(r.error || 'Kopplung fehlgeschlagen.') + (r.detail ? '<br><small>' + esc(r.detail) + '</small>' : '');
    }
  } catch (e) { note.textContent = 'Fehler: ' + e.message + ' – ist die Seite von der Bridge geöffnet?'; }
  btn.disabled = false;
}

function switchView(v) {
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
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
  document.addEventListener('click', e => {
    const i = e.target.closest('.info');
    if (i) { e.stopPropagation(); showInfo(i.dataset.info); return; }
    const t = $('toast'); if (t && !t.hidden) t.hidden = true;
  });
  $('hist-range').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    STATE.histSel = b.dataset.d;
    document.querySelectorAll('#hist-range button').forEach(x => x.classList.toggle('on', x === b));
    const cust = $('hist-custom'); if (cust) cust.hidden = (STATE.histSel !== 'custom');
    if (STATE.histSel === 'custom') {
      const now = new Date();
      if (!$('hist-to').value) $('hist-to').value = localKey(now);
      if (!$('hist-from').value) $('hist-from').value = localKey(new Date(now.getTime() - 29 * 86400000));
    }
    renderHistory();
  });
  ['hist-from', 'hist-to'].forEach(id => { const el = $(id); if (el) el.addEventListener('change', renderHistory); });
  const hm = $('hp-heat-month'); if (hm) hm.addEventListener('change', renderHeatpump);
  // Theorie/Gemessen/Erwartet series toggles (persisted)
  [['thm-t', 'bhe_thm_t'], ['thm-p', 'bhe_thm_p'], ['thm-e', 'bhe_thm_e']].forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const s = localStorage.getItem(key); if (s !== null) el.checked = s === '1';
    el.addEventListener('change', () => { try { localStorage.setItem(key, el.checked ? '1' : '0'); } catch (e) {} renderHeatDemand(); });
  });
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
  const exp = $('export-csv'); if (exp) exp.addEventListener('click', doExport);
  const aegD = $('aeg-dash');
  if (aegD) aegD.addEventListener('click', () => window.open('https://developer.electrolux.one/dashboard', '_blank'));
  const aegC = $('aeg-connect'); if (aegC) aegC.addEventListener('click', doAegConnect);
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
    el.addEventListener('input', () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderPv(); });
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
  const pvWx = $('pv-weather'); if (pvWx) pvWx.addEventListener('click', doWeather);
  const hpWx = $('hp-fc-btn'); if (hpWx) hpWx.addEventListener('click', doHpWeather);
  const pvLoc = $('pv-locate');
  if (pvLoc) pvLoc.addEventListener('click', () => {
    const note = $('pv-pvgis-note');
    if (!navigator.geolocation) { note.textContent = 'Standort wird vom Browser nicht unterstützt – Koordinaten manuell eingeben.'; return; }
    note.textContent = 'Ermittle Standort …';
    navigator.geolocation.getCurrentPosition(
      pos => {
        $('pv-lat').value = pos.coords.latitude.toFixed(4); $('pv-lon').value = pos.coords.longitude.toFixed(4);
        try { localStorage.setItem(PV_LS.lat, $('pv-lat').value); localStorage.setItem(PV_LS.lon, $('pv-lon').value); } catch (e) {}
        note.textContent = 'Standort übernommen – jetzt „Ertrag von PVGIS holen".';
      },
      () => { note.textContent = 'Standort nicht verfügbar – bitte Koordinaten manuell eingeben.'; });
  });
  const pvm = $('pv-monthly');
  if (pvm) {
    const onMove = e => { const r = e.target.closest && e.target.closest('.pvhit'); if (r) { e.stopPropagation(); showPvTip(+r.dataset.mi); } };
    pvm.addEventListener('pointermove', onMove);
    pvm.addEventListener('pointerdown', onMove);
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

  loadAll();
  setInterval(refreshLive, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
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
    renderOverview(); renderToday(); renderHistory(); renderHeatpump(); renderPv();
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
  if (mt.heating > 0.01 || mt.water > 0.01) {
    if (mt.heating > 0.01) breakdown.push({ key: 'hp_heating', label: 'WP · Heizung', kwh: round(mt.heating, 3), color: COL.hp });
    if (mt.water > 0.01) breakdown.push({ key: 'hp_water', label: 'WP · Warmwasser', kwh: round(mt.water, 3), color: COL.heat });
    if (mt.other > 0.01) breakdown.push({ key: 'hp_other', label: 'WP · Sonstiges', kwh: round(mt.other, 3), color: '#b07a4d' });
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

document.addEventListener('DOMContentLoaded', init);
