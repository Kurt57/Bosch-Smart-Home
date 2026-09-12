/* Bosch Energie — iPhone web app.
 * Energy-management view over the local bridge (bridge/shc_bridge.py):
 * Smart Home (Licht-/Rollladensteuerung II) + Bosch heat pump (HomeCom Easy),
 * combined. If no bridge is reachable it falls back to a built-in demo. */
'use strict';

const LS = { base: 'bhe_base', price: 'bhe_price', demo: 'bhe_demo', house: 'bhe_house_kwh' };
const PV_LS = { kwp: 'bhe_pv_kwp', orient: 'bhe_pv_orient', batt: 'bhe_pv_batt',
  feedin: 'bhe_pv_feedin', invest: 'bhe_pv_invest', evkm: 'bhe_pv_evkm', evkwh: 'bhe_pv_evkwh', ac: 'bhe_pv_ac' };
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const COL = { sh: '#4da3ff', hp: '#ef6c4d', heat: '#f6b93b', away: '#ff6b8a' };
const HP_MODE = { dhw: 'Warmwasser', ch: 'Heizung', cooling: 'Kühlen',
  frost: 'Frostschutz', off: 'Bereitschaft', '': 'Bereitschaft' };
const APP_VERSION = '2026-09-12 · Netto-0€-Kurve, Geräte-Verhalten, Haushaltsstrom'
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
function shAvgDaily() {
  const house = parseFloat(localStorage.getItem(LS.house) || '0');
  if (house > 0) return house / 365;
  const d = STATE.data; if (!d) return 0;
  if (d.counter_estimate && d.counter_estimate.avg_daily_kwh > 0) return d.counter_estimate.avg_daily_kwh;
  if (d.stats && d.stats.avg_daily_kwh > 0) return d.stats.avg_daily_kwh;
  const v = (d.daily || []).map(x => x.kwh).filter(x => x > 0);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function houseManual() { return parseFloat(localStorage.getItem(LS.house) || '0') || 0; }
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
    const [ov, hpA, data] = await Promise.all([
      api('/api/overview?days=90&price=' + p),
      api('/api/heatpump/analytics?days=90&price=' + p),
      api('/api/analytics?days=90&price=' + p),
    ]);
    STATE.ov = ov; STATE.hpA = hpA; STATE.data = data;
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
function devRow(title, sub, valTop, valBot, pct, col) {
  return `<div class="devrow"><div class="nm"><b>${esc(title)}</b><small>${sub}</small>` +
    `<div class="bar"><i style="width:${pct.toFixed(0)}%${col ? `;background:${col}` : ''}"></i></div></div>` +
    `<div class="val"><b>${valTop}</b>${valBot ? `<small>${valBot}</small>` : ''}</div></div>`;
}

/* --------------------------------------------------------------- rendering */
function renderAll() {
  renderOverview(); renderToday(); renderHistory(); renderHeatpump(); renderProfile(); renderPv(); renderSettings();
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

  renderTips();
}

// Data-driven, actionable tips – only the relevant ones are shown.
function renderTips() {
  const box = $('ov-tips'), card = $('ov-tips-card');
  if (!box) return;
  const tips = [];
  const A = STATE.hpA, data = STATE.data, fc = annualForecast(), price = STATE.price;
  const l = (A && A.live) || {};
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
}

/* ------------------------------------------------------------- heat pump */
function hpStatusPill(l) {
  const active = l.modulation != null && l.modulation > 0;
  const modeTxt = HP_MODE[l.mode] || l.mode || 'Bereitschaft';
  return active
    ? `<span style="color:var(--accent2)">● läuft</span> · ${esc(modeTxt)}` + (l.modulation != null ? ` · ${fmt(l.modulation, 0)} %` : '')
    : `<span style="color:var(--muted)">◦ ${esc(modeTxt)}</span>`;
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
    if (l.starts != null) rows.push(['Starts / Betriebsstunden', fmt(l.starts, 0) + (l.working_h != null ? ' / ' + fmt(l.working_h, 0) + ' h' : '')]);
    body.innerHTML = `<div class="note" style="margin:-2px 0 10px">${hpStatusPill(l)}</div>` +
      (rows.length ? rows.map(([k, v]) => statusRow(k, v)).join('')
        : '<div class="note">Verbunden – warte auf die erste Messung.</div>') +
      ((connected && (l.power_w == null || l.heat_w == null))
        ? '<div class="note" style="margin-top:8px">Leistung & COP erscheinen nach der zweiten Messung (Zählerdifferenz).</div>' : '');
  }

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
  renderBehavior();
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
function pvHourFractions(m) {
  // daylight bell around 13:00; wider (longer days) in summer
  const seasonal = (PV_MONTH[m] - Math.min(...PV_MONTH)) / (Math.max(...PV_MONTH) - Math.min(...PV_MONTH) || 1);
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
  };
}
// Air-conditioning: strongly summer (cooling season) and afternoon-weighted –
// which aligns well with PV, so it lifts self-consumption.
const AC_MONTH = [0, 0, 0.01, 0.03, 0.09, 0.19, 0.28, 0.23, 0.12, 0.04, 0.01, 0];
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
  const pvShare = normFrac(PV_MONTH), hpSeas = normFrac(HP_SEASON);
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
    let battery = 0, mDirect = 0, mBatt = 0, mFeed = 0, mGrid = 0, mPv = 0, mLoad = 0;
    let mSh = 0, mHp = 0, mEv = 0, mAc = 0;
    let dPv = null, dLoad = null;
    for (let d = 0; d < days; d++) {
      const capturePv = [], captureLoad = [];
      for (let h = 0; h < 24; h++) {
        const pv = dayPv * pvH[h];
        const lSh = shDaily * shShape[h], lHp = dayHp * hpShape[h], lEv = dayEv * EV_SHAPE[h], lAc = dayAc * AC_SHAPE[h];
        const load = lSh + lHp + lEv + lAc;
        mSh += lSh; mHp += lHp; mEv += lEv; mAc += lAc;
        const direct = Math.min(pv, load);
        const surplus = pv - direct, deficit = load - direct;
        const charge = Math.min(surplus, p.batt - battery); battery += charge;
        const feed = surplus - charge;
        const dis = Math.min(deficit, battery); battery -= dis;
        const grid = deficit - dis;
        mDirect += direct; mBatt += dis; mFeed += feed; mGrid += grid; mPv += pv; mLoad += load;
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
  return {
    yield_kwh: Y, self_kwh: S, feed_kwh: F, grid_kwh: G, load_kwh: L,
    self_rate: Y > 0 ? S / Y : 0, autarky: L > 0 ? S / L : 0,
    savings: S * STATE.price, feed_rev: F * p.feedin, benefit: S * STATE.price + F * p.feedin,
    monthly, repDay,
  };
}

// Per month: a stacked PV bar (direct self / battery self / feed-in) next to a
// consumption bar – shows what the battery shifts from feed-in to self-use.
const PVC = { direct: '#4be0b0', batt: '#7c5cff', feed: '#f6b93b',
  sh: '#4da3ff', hp: '#ef6c4d', ev: '#e26fb0', ac: '#38bdd8' };
let _pvMonths = [];
function showPvTip(mi) {
  const m = _pvMonths[mi], t = $('toast'); if (!m || !t) return;
  const row = (c, l, v) => v > 0.05 ? `<div class="it"><span class="sw" style="background:${c}"></span>${l}: <b>${kwh(v, 0)}</b></div>` : '';
  t.innerHTML = `<b>${esc(m.label)}</b> · Erzeugung ${kwh(m.pv, 0)} · Verbrauch ${kwh(m.load, 0)}` +
    `<div class="legend" style="margin-top:6px">` +
    row(PVC.direct, 'PV direkt', m.direct) + row(PVC.batt, 'PV Batterie', m.batt) + row(PVC.feed, 'Einspeisung', m.feed) +
    row(PVC.sh, 'Hausstrom', m.loadSh) + row(PVC.hp, 'Wärmepumpe', m.loadHp) +
    row(PVC.ev, 'E-Auto', m.loadEv) + row(PVC.ac, 'Klima', m.loadAc) + `</div>`;
  t.hidden = false; clearTimeout(_toastT); _toastT = setTimeout(() => { t.hidden = true; }, 9000);
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
  $('pv-yield').innerHTML = kwh(r.yield_kwh, 0);
  $('pv-autarky').innerHTML = fmt(r.autarky * 100, 0) + ' %';
  $('pv-self').innerHTML = fmt(r.self_rate * 100, 0) + ' %';
  $('pv-benefit').innerHTML = money(r.benefit);

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
  $('pv-econ').innerHTML = rows.map(([k, v]) => statusRow(k, v)).join('');
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
  const vn = $('version-note'); if (vn) vn.innerHTML = 'App-Stand: <b>' + APP_VERSION + '</b>';
  const hpl = $('hp-login');
  if (hpl) hpl.addEventListener('click', async () => {
    try { const r = await api('/api/homecom/authurl'); if (r.url) window.open(r.url, '_blank'); }
    catch (e) { $('hp-connect-note').textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  });
  const hpc = $('hp-connect'); if (hpc) hpc.addEventListener('click', doHomecomConnect);
  const hpi = $('hp-import'); if (hpi) hpi.addEventListener('change', doHpImport);
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

  // PV planner: restore saved inputs, save + recompute on change
  const pvFields = [['pv-kwp', PV_LS.kwp], ['pv-orient', PV_LS.orient], ['pv-batt', PV_LS.batt],
    ['pv-feedin', PV_LS.feedin], ['pv-invest', PV_LS.invest], ['pv-ev-km', PV_LS.evkm],
    ['pv-ev-kwh', PV_LS.evkwh], ['pv-ac', PV_LS.ac]];
  pvFields.forEach(([id, key]) => {
    const el = $(id); if (!el) return;
    const saved = localStorage.getItem(key);
    if (saved !== null) el.value = saved;
    el.addEventListener('input', () => { try { localStorage.setItem(key, el.value); } catch (e) {} renderPv(); });
  });
  const pvSug = $('pv-suggest'); if (pvSug) pvSug.addEventListener('click', doPvSuggest);
  const pvm = $('pv-monthly');
  if (pvm) {
    const onMove = e => { const r = e.target.closest && e.target.closest('.pvhit'); if (r) { e.stopPropagation(); showPvTip(+r.dataset.mi); } };
    pvm.addEventListener('pointermove', onMove);
    pvm.addEventListener('pointerdown', onMove);
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
