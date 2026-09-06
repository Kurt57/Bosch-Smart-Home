/* Bosch Home Strom — iPhone web app.
 * Talks to the local bridge (bridge/shc_bridge.py). If no bridge is reachable
 * it falls back to a built-in demo generator so the UI always works. */
'use strict';

const LS = {
  base: 'bhe_base',
  price: 'bhe_price',
  demo: 'bhe_demo',
};
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const $ = (id) => document.getElementById(id);

let STATE = {
  base: localStorage.getItem(LS.base) || '',
  price: parseFloat(localStorage.getItem(LS.price) || '0.35'),
  demo: localStorage.getItem(LS.demo) === '1',
  useDays: 14,
  data: null,     // analytics for the profile/forecast window (90d)
  live: null,     // frequently-refreshed analytics (short window)
  health: null,   // last /api/health payload
  cur: '€',
};

/* ------------------------------------------------------------------ utils */
const fmt = (n, d = 0) => (n == null ? '–' :
  Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }));
const kwh = (n, d = 1) => fmt(n, d) + ' kWh';
const eur = (n, d = 2) => fmt(n, d) + ' ' + STATE.cur;

function money(n) {
  if (n == null) return '–';
  return (n >= 100 ? fmt(n, 0) : fmt(n, 2)) + ' ' + STATE.cur;
}

/* ---------------------------------------------------------------- fetching */
async function api(path) {
  const url = (STATE.base || '') + path;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function loadAll() {
  // If the user forced demo, skip the network entirely.
  if (STATE.demo) return applyData(demoAnalytics(90), demoAnalytics(2, true), 'demo');
  try {
    const health = await api('/api/health');
    STATE.health = health;
    STATE.cur = health.currency || '€';
    if (health.price_per_kwh && !localStorage.getItem(LS.price)) {
      STATE.price = health.price_per_kwh; $('price').value = STATE.price;
    }
    const [full, live] = await Promise.all([
      api('/api/analytics?days=90&price=' + STATE.price),
      api('/api/analytics?days=2&price=' + STATE.price),
    ]);
    applyData(full, live, health.mode || 'live');
    $('diag').textContent = JSON.stringify(health, null, 1);
    renderSettings();
  } catch (e) {
    // no bridge → demo
    STATE.health = null;
    setMode('err');
    $('conn-note').innerHTML =
      'Keine Bridge erreichbar (' + e.message + '). Es werden <b>Demo-Daten</b> gezeigt. ' +
      'Trage hier die Adresse deiner Bridge ein oder öffne diese Seite direkt von der Bridge.';
    applyData(demoAnalytics(90), demoAnalytics(2, true), 'demo');
    renderSettings();
  }
}

function applyData(full, live, mode) {
  STATE.data = full;
  STATE.live = live;
  STATE.cur = full.currency || STATE.cur || '€';
  $('cur').textContent = STATE.cur;
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
// generic sizing
const CW = 520;  // internal viewBox width; scales to container
function svg(h, inner) {
  return `<svg viewBox="0 0 ${CW} ${h}" preserveAspectRatio="none" role="img">${inner}</svg>`;
}

function barChart(values, opts = {}) {
  const h = opts.h || 200, pad = 26, top = 12;
  const n = values.length || 1;
  const max = Math.max(0.0001, ...values.map(v => v.v));
  const bw = (CW - pad * 2) / n;
  const iw = Math.max(2, bw * 0.62);
  let bars = '', labels = '';
  values.forEach((d, i) => {
    const bh = (d.v / max) * (h - top - 22);
    const x = pad + i * bw + (bw - iw) / 2;
    const y = h - 22 - bh;
    const col = d.color || 'url(#g1)';
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2.5" fill="${col}"/>`;
    if (d.label && (n <= 16 || i % Math.ceil(n / 12) === 0)) {
      labels += `<text class="axis" x="${(x + iw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle">${d.label}</text>`;
    }
  });
  // gridlines + y labels
  let grid = '';
  for (let g = 0; g <= 2; g++) {
    const y = top + (h - top - 22) * (g / 2);
    const val = max * (1 - g / 2);
    grid += `<line class="gl" x1="${pad}" x2="${CW - 4}" y1="${y}" y2="${y}"/>`;
    grid += `<text class="axis" x="0" y="${y + 3}">${val >= 10 ? Math.round(val) : val.toFixed(1)}</text>`;
  }
  return svg(h, defs() + grid + bars + labels);
}

function areaChart(values, opts = {}) {
  const h = opts.h || 200, pad = 26, top = 12;
  const n = values.length;
  const max = Math.max(0.0001, ...values.map(v => v.v));
  const X = i => pad + (CW - pad - 6) * (n <= 1 ? 0 : i / (n - 1));
  const Y = v => top + (h - top - 22) * (1 - v / max);
  let line = '', area = '';
  values.forEach((d, i) => {
    const cmd = i === 0 ? 'M' : 'L';
    line += `${cmd}${X(i).toFixed(1)} ${Y(d.v).toFixed(1)} `;
  });
  area = `M${X(0).toFixed(1)} ${(h - 22)} ` + line.replace('M', 'L') + ` L${X(n - 1).toFixed(1)} ${h - 22} Z`;
  let grid = '', labels = '';
  for (let g = 0; g <= 2; g++) {
    const y = top + (h - top - 22) * (g / 2);
    const val = max * (1 - g / 2);
    grid += `<line class="gl" x1="${pad}" x2="${CW - 4}" y1="${y}" y2="${y}"/>`;
    grid += `<text class="axis" x="0" y="${y + 3}">${val >= 10 ? Math.round(val) : val.toFixed(1)}</text>`;
  }
  values.forEach((d, i) => {
    if (d.label && i % Math.ceil(n / 8) === 0)
      labels += `<text class="axis" x="${X(i).toFixed(1)}" y="${h - 8}" text-anchor="middle">${d.label}</text>`;
  });
  return svg(h,
    defs() + grid +
    `<path d="${area}" fill="url(#gArea)" opacity="0.5"/>` +
    `<path d="${line}" fill="none" stroke="url(#g1)" stroke-width="2.5" stroke-linejoin="round"/>` +
    labels);
}

function heatmap(grid) {
  // grid: 7 rows (weekday) x 24 cols (hour) of watts
  const h = 190, left = 30, top = 6, cellH = (h - top - 18) / 7;
  const cellW = (CW - left - 6) / 24;
  let max = 0.0001;
  grid.forEach(r => r.forEach(v => { if (v > max) max = v; }));
  let cells = '', ylab = '', xlab = '';
  grid.forEach((row, wd) => {
    row.forEach((v, hh) => {
      const t = v / max;
      const col = heatColor(t);
      cells += `<rect x="${(left + hh * cellW).toFixed(1)}" y="${(top + wd * cellH).toFixed(1)}" width="${cellW + 0.5}" height="${cellH + 0.5}" fill="${col}"/>`;
    });
    ylab += `<text class="axis" x="0" y="${(top + wd * cellH + cellH / 2 + 3).toFixed(1)}">${WD[wd]}</text>`;
  });
  for (let hh = 0; hh < 24; hh += 4)
    xlab += `<text class="axis" x="${(left + hh * cellW).toFixed(1)}" y="${h - 4}">${hh}</text>`;
  return svg(h, cells + ylab + xlab);
}
function heatColor(t) {
  // dark blue -> cyan -> amber
  t = Math.max(0, Math.min(1, t));
  const stops = [[22, 33, 60], [43, 108, 176], [75, 224, 176], [255, 182, 77]];
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const c = stops[i].map((a, k) => Math.round(a + (stops[i + 1][k] - a) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Gradients are defined once globally in index.html (a 0x0 svg that stays in
// the render tree), so per-chart <defs> are not needed.
function defs() { return ''; }

/* --------------------------------------------------------------- rendering */
function renderAll() {
  renderLive();
  renderUse();
  renderProfile();
  renderAway();
  renderForecast();
}

function renderLive() {
  const L = STATE.live.live, S = STATE.data.stats;
  $('live-total').innerHTML = fmt(L.total_power_w, 0) + '<span> W</span>';
  const dev = L.devices.filter(d => d.power_w >= 0);
  const active = dev.filter(d => d.power_w > 1).length;
  $('live-sub').textContent = `${dev.length} Geräte · ${active} aktiv · aktualisiert ${new Date().toLocaleTimeString('de-DE')}`;
  $('k-today').innerHTML = kwh(S.avg_daily_kwh, 2);
  $('k-cost-today').textContent = eur(S.day_avg_cost);
  $('k-total').innerHTML = kwh(L.total_energy_kwh, 0);
  $('k-baseline').innerHTML = fmt(STATE.data.baseline_w, 1) + ' W';

  const max = Math.max(1, ...dev.map(d => d.power_w));
  $('live-devices').innerHTML = dev.map(d => {
    const L = devLabel(d);
    return `
    <div class="devrow">
      <div class="nm"><b>${esc(L.title)}</b><small>${esc(L.sub)}</small>
        <div class="bar"><i style="width:${(d.power_w / max * 100).toFixed(0)}%"></i></div></div>
      <div class="val"><b>${fmt(d.power_w, 1)} W</b><small>${kwh(d.energy_kwh_total, 1)} gesamt</small></div>
    </div>`; }).join('');

  // 24h line from the short-window daily/hourly — use hourly profile as proxy shape
  const hp = STATE.data.hourly_profile.map(h => ({ v: h.avg_w, label: h.hour % 6 === 0 ? h.hour + 'h' : '' }));
  $('chart-24h').innerHTML = areaChart(hp, { h: 170 });
}

const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

// 12-month view: real days count, missing days filled with the current average
function renderYearChart(avg) {
  const realByDay = {};
  for (const d of STATE.data.daily) realByDay[d.day] = d.kwh;
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = m.getFullYear(), mo = m.getMonth();
    const days = new Date(y, mo + 1, 0).getDate();
    let sum = 0, realDays = 0;
    for (let day = 1; day <= days; day++) {
      const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (realByDay[key] != null) { sum += realByDay[key]; realDays++; }
      else sum += avg;
    }
    months.push({ label: MON[mo], v: sum, realDays });
  }
  const vals = months.map(m => ({
    v: m.v, label: m.label,
    color: m.realDays > 0 ? 'url(#g1)' : '#ffb64d',
  }));
  $('chart-daily').innerHTML = barChart(vals, { h: 210 });
}

function renderUse() {
  const year = STATE.useDays >= 365;
  const C = STATE.data.counter_estimate;
  const avg = (C && C.avg_daily_kwh) || STATE.data.stats.avg_daily_kwh || 0;

  if (year) {
    renderYearChart(avg);
    $('chart-daily-title').innerHTML =
      'Verbrauch pro Monat · <span class="badge" style="color:#ffb64d;border-color:#6b551f">gelb = geschätzt</span>';
    $('chart-daily-note').hidden = false;
    $('chart-daily-note').innerHTML =
      `Monate ohne Messung sind mit deinem aktuellen Ø <b>${kwh(avg, 2)}/Tag</b> geschätzt. ` +
      'Sobald echte Tage vorliegen, ersetzen sie die Schätzung automatisch.';
    $('u-avg').innerHTML = kwh(avg, 2); $('u-avg-l').textContent = 'Ø pro Tag';
    $('u-max').innerHTML = kwh(avg * 365, 0); $('u-max-l').textContent = 'Jahr (geschätzt)';
  } else {
    const daily = windowDays(STATE.data.daily, STATE.useDays);
    const vals = daily.map(d => ({
      v: d.kwh,
      color: d.likely_away ? '#ff6b8a' : 'url(#g1)',
      label: shortDay(d.day),
    }));
    $('chart-daily').innerHTML = barChart(vals, { h: 210 });
    const kwhs = daily.map(d => d.kwh);
    const a = kwhs.reduce((x, y) => x + y, 0) / (kwhs.length || 1);
    $('u-avg').innerHTML = kwh(a, 2); $('u-avg-l').textContent = 'Ø pro Tag';
    $('u-max').innerHTML = kwh(Math.max(...kwhs, 0), 2); $('u-max-l').textContent = 'Höchster Tag';
    $('chart-daily-title').innerHTML =
      'Verbrauch pro Tag <span class="badge away-b">rot = wahrsch. abwesend</span>';
    $('chart-daily-note').hidden = true;
  }

  // device share (cumulative kWh)
  const dev = [...STATE.data.live.devices].sort((a, b) => b.energy_kwh_total - a.energy_kwh_total);
  const tot = dev.reduce((a, d) => a + d.energy_kwh_total, 0) || 1;
  $('dev-share').innerHTML = dev.map(d => `
    <div class="devrow">
      <div class="nm"><b>${esc(devLabel(d).title)}</b><small>${(d.energy_kwh_total / tot * 100).toFixed(0)} % des Gesamtverbrauchs</small>
        <div class="bar"><i style="width:${(d.energy_kwh_total / tot * 100).toFixed(0)}%"></i></div></div>
      <div class="val"><b>${kwh(d.energy_kwh_total, 1)}</b></div>
    </div>`).join('');
}

function renderProfile() {
  const hp = STATE.data.hourly_profile.map(h => ({ v: h.avg_w, label: h.hour % 3 === 0 ? h.hour + '' : '' }));
  $('chart-hourly').innerHTML = areaChart(hp, { h: 190 });
  const peak = STATE.data.hourly_profile.reduce((a, b) => b.avg_w > a.avg_w ? b : a);
  const low = STATE.data.hourly_profile.reduce((a, b) => b.avg_w < a.avg_w ? b : a);
  $('profile-note').innerHTML =
    `Höchste Ø-Leistung um <b>${peak.hour}:00 Uhr</b> (${fmt(peak.avg_w, 1)} W), ` +
    `niedrigste um <b>${low.hour}:00 Uhr</b>. Das zeigt eure typischen Aktivitätszeiten.`;

  const wp = STATE.data.weekday_profile.map(w => ({ v: w.avg_kwh, label: WD[w.weekday] }));
  $('chart-weekday').innerHTML = barChart(wp, { h: 170 });

  $('chart-heat').innerHTML = STATE.data.heatmap ? heatmap(STATE.data.heatmap)
    : '<div class="note">Keine Heatmap-Daten.</div>';
}

function renderAway() {
  const A = STATE.data.away;
  $('away-count').innerHTML = fmt(A.count, 0) + '<span> Tage</span>';
  $('away-sub').textContent =
    `von ${A.analysed_days} analysierten Tagen · Schwelle ${kwh(A.threshold_kwh, 2)} aktiv/Tag`;
  const daily = STATE.data.daily;
  const vals = daily.slice(-30).map(d => ({
    v: Math.max(0.02, (d.presence ?? 0)),
    color: d.likely_away ? '#ff6b8a' : 'url(#g1)',
    label: shortDay(d.day),
  }));
  $('chart-presence').innerHTML = barChart(vals, { h: 190 });
  const list = daily.filter(d => d.likely_away);
  $('away-list').innerHTML = list.length
    ? list.map(d => `<span class="badge away-b" style="margin:3px 4px 3px 0; display:inline-block">${longDay(d.day)}</span>`).join('')
    : '<div class="note">Keine eindeutig abwesenden Tage erkannt.</div>';
}

function renderForecast() {
  const S = STATE.data.stats;
  // counter-based "day 1" estimate (from the cumulative meter + start date)
  const C = STATE.data.counter_estimate;
  const cc = $('counter-card');
  if (C) {
    cc.hidden = false;
    $('counter-body').innerHTML = [
      ['Ø pro Tag (seit Installation)', kwh(C.avg_daily_kwh, 2)],
      ['Jahres-Hochrechnung', `${kwh(C.year_estimate_kwh, 0)} · ${money(C.year_estimate_cost)}`],
      ['Zählerbasis', `${kwh(C.total_kwh, 1)} über ${fmt(C.since_days, 0)} Tage`],
    ].map(([k, v]) => `<div class="devrow"><div class="nm"><b>${k}</b></div><div class="val"><small>${v}</small></div></div>`).join('');
  } else {
    cc.hidden = true;
  }

  $('f-year').innerHTML = kwh(S.year_estimate_kwh, 0);
  $('f-year-cost').textContent = money(S.year_estimate_cost);
  $('f-month').innerHTML = kwh(S.month_estimate_kwh, 1);
  $('f-month-cost').textContent = money(S.month_estimate_cost);

  // cumulative projection across 12 months
  const perMonth = S.avg_daily_kwh * 30.4;
  const proj = [];
  for (let m = 1; m <= 12; m++) proj.push({ v: perMonth * m, label: m + '' });
  $('chart-forecast').innerHTML = areaChart(proj, { h: 190 });
  $('forecast-note').innerHTML =
    `Basis: Ø <b>${kwh(S.avg_daily_kwh, 2)}/Tag</b> aus ${STATE.data.daily.length} gemessenen Tagen, ` +
    `hochgerechnet auf 365 Tage. Reale Werte schwanken saisonal (mehr Licht im Winter).`;

  const away = STATE.data.away;
  const standbyYear = (STATE.data.baseline_w * 24 * 365 / 1000);
  $('insights').innerHTML = [
    ['Grundlast (Standby) im Jahr', `${kwh(standbyYear, 0)} · ${money(standbyYear * STATE.price)} — ${(S.standby_share * 100).toFixed(0)} % des Verbrauchs`],
    ['Sparsamster / teuerster Tag', `${kwh(S.min_daily_kwh, 2)} … ${kwh(S.max_daily_kwh, 2)}`],
    ['Median pro Tag', kwh(S.median_daily_kwh, 2)],
    ['Vermutete Abwesenheit', `${away.count} Tage → grob ${money(away.count * S.day_avg_cost)} nicht angefallen`],
  ].map(([k, v]) => `<div class="devrow"><div class="nm"><b>${k}</b></div><div class="val"><small>${v}</small></div></div>`).join('');
}

/* --------------------------------------------------------------- settings */
function statusRow(k, v) {
  return `<div class="devrow"><div class="nm"><b>${k}</b></div><div class="val"><small>${v}</small></div></div>`;
}

function renderSettings() {
  const h = STATE.health;
  const rows = $('status-rows');
  if (!h) {
    rows.innerHTML = statusRow('Bridge', 'nicht erreichbar – Demo-Ansicht');
    $('pair-note').innerHTML =
      'Kopplung ist nur möglich, wenn diese Seite direkt <b>von der Bridge</b> geöffnet wird ' +
      '(nicht in dieser Vorschau).';
    return;
  }
  const modeTxt = { live: 'Live · Controller verbunden', demo: 'Demo-Daten',
    idle: 'Noch nicht gekoppelt' }[h.mode] || h.mode;
  const last = h.last_poll ? new Date(h.last_poll * 1000).toLocaleTimeString('de-DE') : '–';
  rows.innerHTML = [
    ['Modus', modeTxt],
    ['Geräte gefunden', fmt(h.device_count || 0, 0)],
    ['Messpunkte gespeichert', fmt(h.sample_count || 0, 0)],
    ['Letzte Messung', last],
    ['Zertifikat', h.has_cert ? 'vorhanden ✓' : 'fehlt'],
    h.last_error ? ['Letzter Fehler', esc(h.last_error)] : null,
  ].filter(Boolean).map(([k, v]) => statusRow(k, v)).join('');
  if (h.shc_ip && !$('shc-ip').value) $('shc-ip').value = h.shc_ip;
  if (h.price_per_kwh) $('shc-price').value = h.price_per_kwh;
  if (h.poll_interval) $('shc-interval').value = h.poll_interval;
  renderRenameList();
}

function friendlyModel(m) {
  m = m || '';
  if (/SHUTTER/i.test(m)) return 'Rollladen-Modul';
  if (/LIGHT/i.test(m)) return 'Licht-/Rollladen-Modul';
  return m || 'Modul';
}

function renderRenameList() {
  const box = $('rename-list');
  if (!box) return;
  const devs = (STATE.data && STATE.data.live && STATE.data.live.devices) || [];
  if (!devs.length) { box.innerHTML = '<div class="note">Noch keine Geräte gefunden.</div>'; return; }
  const list = [...devs].sort((a, b) => devLabel(a).title.localeCompare(devLabel(b).title));
  box.innerHTML = list.map(d => {
    const cap = [friendlyModel(d.model), d.room || null, 'ID ' + shortId(d.id)]
      .filter(Boolean).join(' · ');
    return `<div style="margin-bottom:12px">
      <label>${esc(cap)}</label>
      <input class="rn" data-id="${esc(d.id)}" value="${esc(d.custom_name || '')}"
             placeholder="${esc(devLabel(d).title)}" autocomplete="off"
             autocapitalize="words" spellcheck="false">
    </div>`;
  }).join('');
}

function applyCustomName(id, name) {
  for (const arr of [STATE.data && STATE.data.live && STATE.data.live.devices,
                     STATE.live && STATE.live.live && STATE.live.live.devices]) {
    if (arr) for (const d of arr) if (d.id === id) d.custom_name = name;
  }
}

async function postJSON(path, body) {
  const r = await fetch((STATE.base || '') + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function doDiscover() {
  const note = $('discover-note');
  note.textContent = 'Suche Controller im Netzwerk … (kann ein paar Sekunden dauern)';
  try {
    const r = await api('/api/discover');
    if (r.suggested) {
      $('shc-ip').value = r.suggested;
      note.innerHTML = `Gefunden: <b>${r.candidates.join(', ')}</b> – oben übernommen. ` +
        'Passt das nicht, IP manuell eintragen.';
    } else {
      note.innerHTML = `Nichts gefunden im Bereich ${esc(r.scanned)}. IP bitte manuell eintragen ` +
        '(Bosch-App → Einstellungen → System → Controller).';
    }
  } catch (e) {
    note.textContent = 'Automatische Suche geht nur, wenn die Seite von der Bridge geöffnet ist.';
  }
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
      note.innerHTML = '⚠︎ ' + esc(r.error || 'Kopplung fehlgeschlagen.') +
        (r.detail ? '<br><small>' + esc(r.detail) + '</small>' : '');
    }
  } catch (e) {
    note.textContent = 'Fehler: ' + e.message + ' – ist die Seite von der Bridge geöffnet?';
  }
  btn.disabled = false;
}

/* ---------------------------------------------------------------- helpers */
function windowDays(daily, n) { return daily.slice(-n); }
function shortDay(s) { const d = new Date(s + 'T00:00'); return d.getDate() + '.'; }
function longDay(s) { const d = new Date(s + 'T00:00'); return WD[(d.getDay() + 6) % 7] + ' ' + d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// Choose a friendly title/subtitle for a device. Bosch often reports the
// device `name` as the generic product type; in that case the room name is
// usually what the user actually assigned, so prefer it as the title.
function shortId(id) {
  const m = String(id || '').match(/([0-9a-f]{6})$/i);
  return m ? m[1] : String(id || '').slice(-6);
}
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

function demoAnalytics(days, shortWindow) {
  const devices = [
    { id: 'demo-wohnzimmer', name: 'Wohnzimmer Rollladen', room: 'Wohnzimmer', model: 'BSM' },
    { id: 'demo-kueche', name: 'Küche Licht', room: 'Küche', model: 'BSM' },
    { id: 'demo-schlafzimmer', name: 'Schlafzimmer Rollladen', room: 'Schlafzimmer', model: 'BSM' },
    { id: 'demo-flur', name: 'Flur Licht', room: 'Flur', model: 'BSM' },
  ];
  const now = new Date();
  const start = new Date(now.getTime() - days * 86400000);
  const awayRanges = [[40, 34], [17, 15], [6, 5]].map(([a, b]) =>
    [new Date(now - a * 86400000), new Date(now - b * 86400000)]);
  const isAway = t => awayRanges.some(([a, b]) => t >= a && t <= b);

  const dayKwh = {}, dayActive = {}, hourP = {}, hwP = {}, counters = {}, devEnergy = {};
  const liveNow = {};
  for (let h = 0; h < 24; h++) hourP[h] = [];
  devices.forEach(d => { counters[d.id] = 0; devEnergy[d.id] = 0; });

  const step = 15 * 60000;
  for (let t = start.getTime(); t <= now.getTime(); t += step) {
    const dt = new Date(t);
    const away = isAway(dt);
    const dayKey = dt.toISOString().slice(0, 10);
    devices.forEach(d => {
      const p = demoPower(d.id, dt, away);
      const wh = p * (step / 3600000);
      counters[d.id] += wh; devEnergy[d.id] += wh;
      dayKwh[dayKey] = (dayKwh[dayKey] || 0) + wh / 1000;
      hourP[dt.getHours()].push(p);
      const key = ((dt.getDay() + 6) % 7) + '_' + dt.getHours();
      (hwP[key] = hwP[key] || []).push(p);
      liveNow[d.id] = p;
    });
  }
  // baseline
  const allP = [];
  Object.values(hourP).forEach(a => a.forEach(v => allP.push(v)));
  allP.sort((a, b) => a - b);
  const baseline = allP[Math.max(0, Math.floor(allP.length * 0.1) - 1)] || 0.4;

  const daysSorted = Object.keys(dayKwh).sort();
  daysSorted.forEach(day => {
    // approximate active energy per day
    dayActive[day] = Math.max(0, dayKwh[day] - baseline * 24 / 1000);
  });
  const complete = daysSorted.slice(1, -1);
  const kwhVals = complete.map(d => dayKwh[d]);
  const avg = kwhVals.reduce((a, b) => a + b, 0) / (kwhVals.length || 1);
  const sortedAct = complete.map(d => dayActive[d]).sort((a, b) => a - b);
  const medAct = sortedAct[Math.floor(sortedAct.length / 2)] || 0;
  const awayThresh = Math.max(0.02, medAct * 0.25);

  const daily = daysSorted.map(day => {
    const active = dayActive[day];
    return {
      day, kwh: round(dayKwh[day], 3), active_kwh: round(active, 3),
      presence: round(medAct <= 0 ? 0 : Math.min(1, active / medAct), 2),
      likely_away: active < awayThresh,
    };
  });
  const awayDays = daily.filter(d => d.likely_away).map(d => d.day);

  const hourly = [];
  for (let h = 0; h < 24; h++) {
    const a = hourP[h];
    hourly.push({ hour: h, avg_w: round(a.reduce((x, y) => x + y, 0) / (a.length || 1), 2) });
  }
  const weekdayAgg = {};
  for (let i = 0; i < 7; i++) weekdayAgg[i] = [];
  daysSorted.forEach(day => { weekdayAgg[(new Date(day + 'T00:00').getDay() + 6) % 7].push(dayKwh[day]); });
  const weekday = [];
  for (let i = 0; i < 7; i++) { const a = weekdayAgg[i]; weekday.push({ weekday: i, avg_kwh: round(a.reduce((x, y) => x + y, 0) / (a.length || 1), 3) }); }
  const heat = [];
  for (let wd = 0; wd < 7; wd++) { const row = []; for (let h = 0; h < 24; h++) { const a = hwP[wd + '_' + h] || []; row.push(round(a.reduce((x, y) => x + y, 0) / (a.length || 1), 1)); } heat.push(row); }

  const perDevice = devices.map(d => ({
    id: d.id, name: d.name, room: d.room, model: d.model,
    power_w: round(liveNow[d.id] || 0, 2),
    energy_kwh_total: round(devEnergy[d.id] / 1000, 3),
  })).sort((a, b) => b.power_w - a.power_w);
  const totalNow = perDevice.reduce((a, d) => a + d.power_w, 0);
  const totalKwh = perDevice.reduce((a, d) => a + d.energy_kwh_total, 0);

  const cAvg = totalKwh / Math.max(1, days);
  return {
    currency: '€', price_per_kwh: STATE.price, baseline_w: round(baseline, 2), window_days: days,
    counter_estimate: {
      since: Math.floor(start.getTime() / 1000), since_days: round(days, 1),
      total_kwh: round(totalKwh, 3), avg_daily_kwh: round(cAvg, 3),
      year_estimate_kwh: round(cAvg * 365, 1), year_estimate_cost: round(cAvg * 365 * STATE.price, 2),
      month_estimate_kwh: round(cAvg * 30.4, 2),
    },
    live: { total_power_w: round(totalNow, 2), total_energy_kwh: round(totalKwh, 3), devices: perDevice },
    daily, hourly_profile: hourly, weekday_profile: weekday, heatmap: heat,
    stats: {
      avg_daily_kwh: round(avg, 3),
      median_daily_kwh: round([...kwhVals].sort((a, b) => a - b)[Math.floor(kwhVals.length / 2)] || 0, 3),
      min_daily_kwh: round(Math.min(...kwhVals, 0), 3), max_daily_kwh: round(Math.max(...kwhVals, 0), 3),
      year_estimate_kwh: round(avg * 365, 1), year_estimate_cost: round(avg * 365 * STATE.price, 2),
      month_estimate_kwh: round(avg * 30.4, 2), month_estimate_cost: round(avg * 30.4 * STATE.price, 2),
      day_avg_cost: round(avg * STATE.price, 2),
      standby_share: avg > 0 ? round((baseline * 24 / 1000) / avg, 3) : 0,
    },
    away: { count: awayDays.length, days: awayDays, threshold_kwh: round(awayThresh, 3), analysed_days: daily.length },
  };
}
function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }

/* ------------------------------------------------------------ interactions */
function switchView(v) {
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function init() {
  $('base').value = STATE.base;
  $('price').value = STATE.price;
  document.querySelectorAll('#nav button').forEach(b =>
    b.addEventListener('click', () => switchView(b.dataset.v)));
  $('use-range').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    STATE.useDays = +b.dataset.d;
    document.querySelectorAll('#use-range button').forEach(x => x.classList.toggle('on', x === b));
    renderUse();
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
  $('rename-list').addEventListener('change', async (e) => {
    const inp = e.target.closest('input.rn');
    if (!inp) return;
    const id = inp.dataset.id, name = inp.value.trim();
    inp.disabled = true;
    try {
      const r = await postJSON('/api/device-name', { id, name });
      if (r && r.ok) {
        applyCustomName(id, name);
        inp.placeholder = name || devLabel({ id, name: '', model: '', room: '' }).title;
        inp.style.borderColor = '#4be0b0';
        renderLive(); renderUse();
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
  // live refresh every 20s (only the short-window analytics)
  setInterval(refreshLive, 20000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function refreshLive() {
  if (STATE.demo) { STATE.live = demoAnalytics(2, true); renderLive(); return; }
  try {
    STATE.live = await api('/api/analytics?days=2&price=' + STATE.price);
    renderLive();
  } catch (e) { /* keep last */ }
}

document.addEventListener('DOMContentLoaded', init);
