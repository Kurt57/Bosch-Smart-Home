/* Bosch Energie — iPhone web app.
 * Energy-management view over the local bridge (bridge/shc_bridge.py):
 * Smart Home (Licht-/Rollladensteuerung II) + Bosch heat pump (HomeCom Easy),
 * combined. If no bridge is reachable it falls back to a built-in demo. */
'use strict';

const LS = { base: 'bhe_base', price: 'bhe_price', demo: 'bhe_demo' };
const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const COL = { sh: '#4da3ff', hp: '#ef6c4d', heat: '#f6b93b', away: '#ff6b8a' };
const HP_MODE = { dhw: 'Warmwasser', ch: 'Heizung', cooling: 'Kühlen',
  frost: 'Frostschutz', off: 'Bereitschaft', '': 'Bereitschaft' };
const APP_VERSION = '2026-09-11 · Energiemanagement +WP-Wofür';
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
  histDays: 14,
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
function shortDay(s) { const d = new Date(s + 'T00:00'); return d.getDate() + '.'; }
function longDay(s) { const d = new Date(s + 'T00:00'); return WD[(d.getDay() + 6) % 7] + ' ' + d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); }
function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function dayOfYear(dt) { const s = new Date(dt.getFullYear(), 0, 0); return Math.floor((dt - s) / 86400000); }

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
    let y = base;
    series.forEach(s => {
      const v = Math.max(0, r.values[s.key] || 0);
      if (v <= 0) return;
      const bh = v / max * (base - top);
      y -= bh;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${iw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${s.color}"/>`;
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
  renderOverview(); renderToday(); renderHistory(); renderHeatpump(); renderProfile(); renderSettings();
}

function renderOverview() {
  const ov = STATE.ov; if (!ov) return;
  $('ov-today').innerHTML = fmt(ov.today.total_kwh, 1) + '<span> kWh</span>';
  $('ov-today-cost').textContent = eur(ov.today.cost) + ' · Stand ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  $('ov-now').textContent = fmt(ov.now.total_w, 0) + ' W';
  $('ov-now-hp').textContent = ov.now.heatpump_w != null ? fmt(ov.now.heatpump_w, 0) + ' W' : '–';
  $('ov-month').innerHTML = kwh(ov.estimate.month_kwh, 0);
  $('ov-month-cost').textContent = money(ov.estimate.month_cost);

  const segs = ov.breakdown.filter(b => b.kwh > 0).map(b => ({ label: b.label, value: b.kwh, color: b.color }));
  $('ov-break-sum').textContent = kwh(ov.today.total_kwh, 1);
  $('ov-donut').innerHTML = segs.length
    ? donutChart(segs, { big: fmt(ov.today.total_kwh, 1), center: 'kWh heute' })
    : '<div class="note">Noch keine Verbrauchsdaten für heute.</div>';
  $('ov-legend').innerHTML = legendHtml(segs.slice(0, 8).map(s => ({ label: s.label, color: s.color, sub: kwh(s.value, 2) })));

  const w = ov.combined_daily.slice(-14);
  $('ov-daily').innerHTML = stackedBar(
    w.map(d => ({ label: shortDay(d.day), values: { sh: d.smarthome_kwh, hp: d.heatpump_kwh } })),
    [{ key: 'sh', color: COL.sh }, { key: 'hp', color: COL.hp }], { h: 200 });

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

function renderHistory() {
  const ov = STATE.ov, data = STATE.data; if (!ov || !data) return;
  const days = STATE.histDays;
  const cd = ov.combined_daily;
  const shHex = COL.sh, hpHex = COL.hp;
  $('h-daily-legend').innerHTML = legendHtml([
    { label: 'Smart Home', color: shHex }, { label: 'Wärmepumpe', color: hpHex }]);

  if (days >= 365) {
    const avgSh = mean(cd.slice(1, -1).map(d => d.smarthome_kwh)) || mean(cd.map(d => d.smarthome_kwh));
    const avgHp = mean(cd.slice(1, -1).map(d => d.heatpump_kwh)) || mean(cd.map(d => d.heatpump_kwh));
    const byDay = {}; cd.forEach(d => byDay[d.day] = d);
    const now = new Date(), months = [];
    for (let i = 11; i >= 0; i--) {
      const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = m.getFullYear(), mo = m.getMonth(), nd = new Date(y, mo + 1, 0).getDate();
      let sh = 0, hp = 0, real = 0;
      for (let dd = 1; dd <= nd; dd++) {
        const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
        if (byDay[key]) { sh += byDay[key].smarthome_kwh; hp += byDay[key].heatpump_kwh; real++; }
        else { sh += avgSh; hp += avgHp; }
      }
      months.push({ label: MON[mo], values: { sh, hp }, real });
    }
    $('h-daily').innerHTML = stackedBar(months, [{ key: 'sh', color: shHex }, { key: 'hp', color: hpHex }], { h: 210 });
    $('h-daily-title').innerHTML = 'Strom pro Monat · <span class="badge" style="color:#ffb64d;border-color:#6b551f">grau = geschätzt</span>';
    $('h-daily-note').hidden = false;
    $('h-daily-note').innerHTML = `Monate ohne Messung sind mit deinem aktuellen Ø ` +
      `<b>${kwh(avgSh + avgHp, 2)}/Tag</b> geschätzt und werden durch echte Werte ersetzt.`;
    $('h-avg').innerHTML = kwh(avgSh + avgHp, 2);
    $('h-max').innerHTML = kwh((avgSh + avgHp) * 365, 0); $('h-max-l').textContent = 'Jahr (geschätzt)';
  } else {
    const w = cd.slice(-days);
    $('h-daily').innerHTML = stackedBar(
      w.map(d => ({ label: shortDay(d.day), values: { sh: d.smarthome_kwh, hp: d.heatpump_kwh } })),
      [{ key: 'sh', color: shHex }, { key: 'hp', color: hpHex }], { h: 210 });
    const tot = w.map(d => d.total_kwh);
    $('h-avg').innerHTML = kwh(mean(tot), 2);
    $('h-max').innerHTML = kwh(Math.max(0, ...tot), 2); $('h-max-l').textContent = 'Höchster Tag';
    $('h-daily-title').textContent = 'Strom pro Tag';
    $('h-daily-note').hidden = true;
  }

  // cumulative share over the window: per Smart-Home device + heat pump
  const winKeys = new Set(cd.slice(-Math.min(days, cd.length)).map(d => d.day));
  const pdd = data.per_device_day || {};
  const names = {}; (data.live.devices || []).forEach(d => names[d.id] = devLabel(d).title);
  const shares = [];
  Object.keys(pdd).forEach(id => {
    let s = 0; for (const day in pdd[id]) if (winKeys.has(day)) s += pdd[id][day];
    if (s > 0) shares.push({ label: names[id] || id, kwh: s, color: COL.sh });
  });
  const hpWin = cd.slice(-Math.min(days, cd.length)).reduce((a, d) => a + d.heatpump_kwh, 0);
  if (hpWin > 0) shares.push({ label: 'Wärmepumpe', kwh: hpWin, color: COL.hp });
  shares.sort((a, b) => b.kwh - a.kwh);
  const totShare = shares.reduce((a, s) => a + s.kwh, 0) || 1;
  $('h-share').innerHTML = shares.length
    ? shares.map(s => devRow(s.label, (s.kwh / totShare * 100).toFixed(0) + ' % im Zeitraum', kwh(s.kwh, 1), '', s.kwh / totShare * 100, s.color)).join('')
    : '<div class="note">Noch keine Daten.</div>';

  // away detection (Smart Home)
  const A = data.away;
  $('h-away-sum').textContent = `${A.count} Tage`;
  const pres = data.daily.slice(-30).map(d => ({
    v: Math.max(0.02, d.presence ?? 0), color: d.likely_away ? COL.away : COL.sh, label: shortDay(d.day),
  }));
  $('h-presence').innerHTML = barChart(pres, { h: 180 });
  const list = data.daily.filter(d => d.likely_away);
  $('h-away-list').innerHTML = list.length
    ? list.map(d => `<span class="badge away-b" style="margin:3px 4px 3px 0;display:inline-block">${longDay(d.day)}</span>`).join('')
    : '<div class="note">Keine eindeutig abwesenden Tage erkannt.</div>';

  // combined forecast & insights
  const S = data.stats, hpS = STATE.hpA.stats;
  const standbyYear = data.baseline_w * 24 * 365 / 1000;
  $('h-insights').innerHTML = [
    ['Hochrechnung / Jahr', `${kwh(ov.estimate.year_kwh, 0)} · ${money(ov.estimate.year_cost)}`],
    ['davon Wärmepumpe', hpS.year_estimate_kwh ? `${kwh(hpS.year_estimate_kwh, 0)} · ${money(hpS.year_estimate_cost)}` : '–'],
    ['davon Smart Home', `${kwh(S.year_estimate_kwh, 0)} · ${money(S.year_estimate_cost)}`],
    ['Grundlast Smart Home / Jahr', `${kwh(standbyYear, 0)} · ${(S.standby_share * 100).toFixed(0)} %`],
    ['Vermutete Abwesenheit', `${A.count} Tage · ~${money(A.count * S.day_avg_cost)}`],
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

  const m = A.monthly || [];
  $('hp-monthly').innerHTML = m.length ? groupedBar(
    m.map(x => ({ label: MON[parseInt(x.month.slice(5), 10) - 1], values: { e: x.elec_kwh, h: x.heat_kwh } })),
    [{ key: 'e', color: COL.hp }, { key: 'h', color: COL.heat }], { h: 180 })
    : '<div class="note">Noch keine vollen Monate.</div>';

  const hasHeat = (A.heatmap || []).some(r => r.some(v => v > 0));
  $('hp-heat').innerHTML = hasHeat ? heatmap(A.heatmap) : '<div class="note">Noch keine Wärmekarte-Daten.</div>';
}

/* --------------------------------------------------------------- profile */
function renderProfile() {
  const data = STATE.data; if (!data) return;
  const hp = data.hourly_profile.map(h => ({ v: h.avg_w, label: h.hour % 3 === 0 ? h.hour + '' : '' }));
  $('chart-hourly').innerHTML = areaChart(hp, { h: 190 });
  const peak = data.hourly_profile.reduce((a, b) => b.avg_w > a.avg_w ? b : a);
  const low = data.hourly_profile.reduce((a, b) => b.avg_w < a.avg_w ? b : a);
  $('profile-note').innerHTML = `Höchste Ø-Leistung um <b>${peak.hour}:00 Uhr</b> (${fmt(peak.avg_w, 1)} W), ` +
    `niedrigste um <b>${low.hour}:00 Uhr</b>. Typische Aktivitätszeiten im Haushalt.`;
  $('chart-weekday').innerHTML = barChart(data.weekday_profile.map(w => ({ v: w.avg_kwh, label: WD[w.weekday] })), { h: 170 });
  $('chart-heat').innerHTML = data.heatmap ? heatmap(data.heatmap) : '<div class="note">Keine Heatmap-Daten.</div>';
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
  document.querySelectorAll('#nav button').forEach(b => b.addEventListener('click', () => switchView(b.dataset.v)));
  $('hist-range').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    STATE.histDays = +b.dataset.d;
    document.querySelectorAll('#hist-range button').forEach(x => x.classList.toggle('on', x === b));
    renderHistory();
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
  const vn = $('version-note'); if (vn) vn.innerHTML = 'App-Stand: <b>' + APP_VERSION + '</b>';
  const hpl = $('hp-login');
  if (hpl) hpl.addEventListener('click', async () => {
    try { const r = await api('/api/homecom/authurl'); if (r.url) window.open(r.url, '_blank'); }
    catch (e) { $('hp-connect-note').textContent = 'Nur möglich, wenn die Seite von der Bridge geöffnet ist.'; }
  });
  const hpc = $('hp-connect'); if (hpc) hpc.addEventListener('click', doHomecomConnect);
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
    renderOverview(); renderToday(); renderHistory(); renderHeatpump();
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
