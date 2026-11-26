'use strict';

const REPO = 'GREGORUNDEL/run-calendar';
const WORKFLOW = 'sync.yml';
const TOKEN_KEY = 'runCalendar.githubToken';
const API = 'https://api.github.com';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const $ = (id) => document.getElementById(id);
const state = { runs: [], byDate: new Map(), updated: null, fresh: new Set() };

/* ------------------------------------------------------------ storage */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/* ------------------------------------------------------------ format */
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const monthKey = (y, m) => `${y}-${pad(m + 1)}`;
const km1 = (m) => (m / 1000).toFixed(1).replace('.', ',');
const km2 = (m) => (m / 1000).toFixed(2).replace('.', ',');
function kmTotal(m) { return m >= 100000 ? String(Math.round(m / 1000)) : km1(m); }
function clock(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
  return h ? `${h}:${pad(mi)}:${pad(se)}` : `${mi}:${pad(se)}`;
}
function hoursText(s) {
  const total = Math.round(s / 60), h = Math.floor(total / 60), m = total % 60;
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}
function pace(sec, meters) {
  if (!sec || !meters) return '—';
  const p = Math.round(sec / (meters / 1000));
  return `${Math.floor(p / 60)}:${pad(p % 60)}`;
}
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
function dayTitle(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(y, m - 1, d).toLocaleDateString('ru-RU', { weekday: 'long' });
  const thisYear = new Date().getFullYear() === y;
  return `${wd}, ${d} ${MONTHS_GEN[m - 1]}${thisYear ? '' : ` ${y}`}`;
}
function updatedText(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === new Date().toDateString();
  return `Синхронизировано ${sameDay ? 'сегодня' : `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`} в ${time}`;
}
function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------ data */
async function loadData() {
  const res = await fetch(`data/runs.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`runs.json: ${res.status}`);
  const data = await res.json();
  state.runs = data.runs || [];
  state.updated = data.updated || null;
  state.byDate = new Map();
  for (const r of state.runs) {
    if (!state.byDate.has(r.date)) state.byDate.set(r.date, []);
    state.byDate.get(r.date).push(r);
  }
  for (const list of state.byDate.values()) list.sort((a, b) => a.start.localeCompare(b.start));
}

/* ------------------------------------------------------------ render */
function stickerSVG(meters, day) {
  const v = kmTotal(meters);
  const size = v.length >= 5 ? 27 : v.length === 4 ? 32 : 36;
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <g class="foot" transform="translate(50 22) rotate(-16) scale(.85)">
      <ellipse cx="-4" cy="-2" rx="3.6" ry="6.2"/><ellipse cx="-3.4" cy="7.6" rx="2.6" ry="2.6"/>
      <ellipse cx="5" cy="1" rx="3.6" ry="6.2"/><ellipse cx="5.6" cy="10.6" rx="2.6" ry="2.6"/>
    </g>
    <text x="50" y="${52 + size * 0.36}" style="font-size:${size}px">${v}</text>
    <text class="unit" x="50" y="84">км</text>
    <text class="idx" x="24" y="31">${day}</text>
  </svg>`;
}

function monthRange() {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  let first = new Date(y, m - 2, 1);
  for (const r of state.runs) {
    const [ry, rm] = r.date.split('-').map(Number);
    const d = new Date(ry, rm - 1, 1);
    if (d < first) first = d;
  }
  const list = [];
  for (let d = first; d <= new Date(y, m + 2, 1); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    list.push([d.getFullYear(), d.getMonth()]);
  }
  return list;
}

function renderMonth(year, month, todayIso, planned) {
  const section = document.createElement('section');
  section.className = 'month';
  section.id = `m-${monthKey(year, month)}`;
  const now = new Date();
  if (now.getFullYear() === year && now.getMonth() === month) section.classList.add('current');
  if (new Date(year, month, 1) > new Date(now.getFullYear(), now.getMonth() + 1, 1)) section.classList.add('fading');

  const grid = document.createElement('div');
  grid.className = 'grid';
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  let count = 0, meters = 0, seconds = 0;

  for (let i = 0; i < lead; i++) grid.appendChild(Object.assign(document.createElement('div'), { className: 'day' }));

  for (let d = 1; d <= days; d++) {
    const key = iso(year, month, d);
    const runs = state.byDate.get(key) || [];
    const cell = document.createElement(runs.length ? 'button' : 'div');
    cell.className = 'day';
    if (key === todayIso) cell.classList.add('today');
    if (key > todayIso) cell.classList.add('future');

    if (!runs.length) {
      cell.innerHTML = `<span class="num">${d}</span>`;
      if (planned.has(key)) {
        cell.classList.add('planned');
        cell.title = 'Запланированная пробежка';
      }
    } else {
      const total = runs.reduce((s, r) => s + (r.distance || 0), 0);
      count += runs.length;
      meters += total;
      seconds += runs.reduce((s, r) => s + (r.duration || 0), 0);
      cell.type = 'button';
      cell.classList.add('has-run');
      cell.setAttribute('aria-label', `${d} ${MONTHS_GEN[month]}: ${runs.length} ${plural(runs.length, 'пробежка', 'пробежки', 'пробежек')}, ${km2(total)} км`);
      const sticker = document.createElement('span');
      sticker.className = 'sticker';
      sticker.innerHTML = stickerSVG(total, d);
      if (runs.some((r) => state.fresh.has(r.id))) sticker.classList.add('pressed');
      cell.appendChild(sticker);
      if (runs.length > 1) cell.insertAdjacentHTML('beforeend', `<span class="count">${runs.length}</span>`);
      cell.dataset.date = key;
      cell.addEventListener('click', () => openDay(key));
    }
    grid.appendChild(cell);
  }

  const yearSuffix = year === now.getFullYear() ? '' : ` ${year}`;
  const isFuture = new Date(year, month, 1) > now;
  const summary = count
    ? `${count} ${plural(count, 'пробежка', 'пробежки', 'пробежек')}, ${kmTotal(meters)} км, ${hoursText(seconds)}`
    : isFuture ? '' : 'Без пробежек';
  section.innerHTML = `<div class="month-head"><h2>${MONTHS[month]}${yearSuffix}</h2>${summary ? `<p>${summary}</p>` : ''}</div>`;
  section.appendChild(grid);
  return section;
}

/* Plan: 2 days of running, 1 day of rest. Continues from the actual recent runs,
   so the highlighted days shift on their own if a run is moved or skipped. */
const PLAN_RUN_DAYS = 2;
function plannedDays(today) {
  const key = (dt) => iso(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const addDays = (dt, n) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + n);
  let day = state.byDate.has(key(today)) ? addDays(today, 1) : new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let streak = 0;
  for (let back = addDays(day, -1); state.byDate.has(key(back)); back = addDays(back, -1)) streak++;
  const end = new Date(today.getFullYear(), today.getMonth() + 3, 1);
  const out = new Set();
  for (; day < end; day = addDays(day, 1)) {
    if (streak < PLAN_RUN_DAYS) { out.add(key(day)); streak++; } else streak = 0;
  }
  return out;
}

function totalText() {
  const total = state.runs.reduce((sum, r) => sum + (r.distance || 0), 0);
  return state.runs.length ? `${Math.round(total / 1000).toLocaleString('ru-RU')} км` : '';
}

const barHeight = () => document.querySelector('.bar').offsetHeight;

function scrollToMonth(key, smooth) {
  const target = $(`m-${key}`);
  if (!target) return;
  const top = target.getBoundingClientRect().top + window.scrollY - barHeight() + 6;
  window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

function render({ scrollTo } = {}) {
  const t = new Date();
  const todayIso = iso(t.getFullYear(), t.getMonth(), t.getDate());
  const feed = $('feed');
  feed.innerHTML = '';
  const planned = plannedDays(t);
  for (const [y, m] of monthRange()) feed.appendChild(renderMonth(y, m, todayIso, planned));
  feed.appendChild(Object.assign(document.createElement('footer'), { className: 'feed-end', textContent: updatedText(state.updated) }));
  if (sheet.key) markSelected(sheet.key);
  setStatus('');
  $('total').textContent = totalText();
  $('countAll').textContent = state.runs.length || '';
  state.fresh.clear();
  scrollToMonth(scrollTo || monthKey(t.getFullYear(), t.getMonth()), false);
}

/* ------------------------------------------------------------ day sheet */
let leafletPromise = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      js.onload = () => resolve(window.L);
      js.onerror = () => { leafletPromise = null; reject(new Error('leaflet')); };
      document.head.appendChild(js);
    });
  }
  return leafletPromise;
}

const tracks = new Map();
function loadTrack(run) {
  if (!tracks.has(run.id)) {
    tracks.set(run.id, fetch(`data/tracks/${run.id}.json?v=${encodeURIComponent(state.updated || '')}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('track'))))
      .catch((e) => { tracks.delete(run.id); throw e; }));
  }
  return tracks.get(run.id);
}

function buildMap(L, el, track, interactive) {
  const map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
    dragging: interactive,
    touchZoom: interactive,
    doubleClickZoom: interactive,
    scrollWheelZoom: interactive,
    boxZoom: false,
    keyboard: false,
    tap: false,
  });
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  L.polyline(track, { color: '#3a1d00', weight: 8, opacity: 0.55, interactive: false }).addTo(map);
  const line = L.polyline(track, { color: '#ff6a00', weight: 4.5, opacity: 1, lineJoin: 'round', interactive: false }).addTo(map);
  const dot = { radius: 6, weight: 2.5, color: '#000', fillOpacity: 1, interactive: false };
  L.circleMarker(track[0], { ...dot, fillColor: '#ffffff' }).addTo(map);
  L.circleMarker(track[track.length - 1], { ...dot, fillColor: '#ff9f0a' }).addTo(map);
  const pad = interactive
    ? { paddingTopLeft: [28, (document.querySelector('.map-bar')?.offsetHeight || 0) + 28], paddingBottomRight: [28, 40] }
    : { padding: [24, 24] };
  const fit = () => { map.invalidateSize(); map.fitBounds(line.getBounds(), pad); };
  fit();
  setTimeout(fit, 380); // after the sheet finishes opening
  return map;
}

async function drawMap(el, run) {
  try {
    const [L, track] = await Promise.all([loadLeaflet(), loadTrack(run)]);
    if (!el.isConnected) return;
    const holder = document.createElement('div');
    holder.className = 'map-tiles';
    el.appendChild(holder);
    buildMap(L, holder, track, false);
    const open = document.createElement('button');
    open.className = 'map-open';
    open.setAttribute('aria-label', 'Открыть карту');
    open.addEventListener('click', () => openFullMap(run));
    el.appendChild(open);
  } catch {
    el.replaceWith(Object.assign(document.createElement('p'), { className: 'map-note', textContent: 'Карту не удалось загрузить.' }));
  }
}

let fullMap = null;
async function openFullMap(run) {
  haptic();
  const wrap = $('mapView');
  $('mapTitle').textContent = run.name || 'Пробежка';
  wrap.hidden = false;
  const [L, track] = await Promise.all([loadLeaflet(), loadTrack(run)]);
  if (fullMap) fullMap.remove();
  fullMap = buildMap(L, $('mapFull'), track, true);
}
function closeFullMap() {
  $('mapView').hidden = true;
  if (fullMap) { fullMap.remove(); fullMap = null; }
}

/* Heart-rate zones as % of max HR (Garmin-style 5 zones). */
const MAX_HR = 201;
const ZONE_PCT = [0.6, 0.7, 0.8, 0.9];

function zoneSeconds(hr) {
  const bounds = [0, ...ZONE_PCT.map((p) => Math.round(MAX_HR * p)), 999];
  const out = [0, 0, 0, 0, 0];
  hr.s.forEach((sec, i) => {
    if (!sec) return;
    const lo = hr.from + i * hr.step, hi = lo + hr.step;
    for (let z = 0; z < 5; z++) {
      const overlap = Math.max(0, Math.min(hi, bounds[z + 1]) - Math.max(lo, bounds[z]));
      out[z] += sec * overlap / hr.step;
    }
  });
  return out;
}

function zonesHTML(r) {
  if (!r.hr || !r.hr.s) return '';
  const z = zoneSeconds(r.hr);
  const total = z.reduce((a, b) => a + b, 0);
  if (!total) return '';
  const easy = Math.round(((z[0] + z[1]) / total) * 100);
  const bar = z.map((sec, i) => (sec / total >= 0.005 ? `<span class="z${i + 1}" style="flex:${sec}"></span>` : '')).join('');
  return `<div class="zones"><div class="zone-bar" aria-hidden="true">${bar}</div>
    <p><b>${easy}%</b> времени в лёгкой зоне, до ${Math.round(MAX_HR * ZONE_PCT[1])} уд/мин</p></div>`;
}

function runHTML(r, i) {
  const time = r.start ? r.start.slice(11, 16) : '';
  const fig = (label, value, cls = '') => `<div class="${cls}"><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<section class="run">
    <h3>${escapeHTML(r.name || 'Пробежка')}</h3>
    <p class="when">Старт в ${time}</p>
    <dl class="figures">
      ${fig('Дистанция', r.distance ? `${km2(r.distance)}<small> км</small>` : '—', 'accent')}
      ${fig('Время', r.duration ? clock(r.duration) : '—')}
      ${fig('Темп', `${pace(r.duration, r.distance)}<small> /км</small>`)}
      ${fig('Средний пульс', r.avgHr ? `${r.avgHr}<small> уд/мин</small>` : '—')}
      ${fig('Макс. пульс', r.maxHr ? `${r.maxHr}<small> уд/мин</small>` : '—')}
      ${fig('Набор высоты', r.elevGain != null ? `${r.elevGain}<small> м</small>` : '—')}
    </dl>
    ${zonesHTML(r)}
    ${r.track === 'ok' ? `<div class="map" data-run="${i}"></div>`
      : r.track === 'pending' ? '<p class="map-note">Маршрут загрузится при следующей синхронизации.</p>'
      : r.track === 'none' ? '<p class="map-note">Без GPS-маршрута.</p>' : ''}
  </section>`;
}

let lastFocus = null;
function openSheet(wrap) {
  lastFocus = document.activeElement;
  wrap.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet(wrap) {
  wrap.hidden = true;
  document.body.style.overflow = '';
  if (lastFocus) lastFocus.focus({ preventScroll: true });
}

/* Run sheet: opens under the month grid, which scrolls up right below the header.
   While it is open the calendar does not scroll; swipes go to the sheet. */
const sheet = { key: null, open: false };

function monthGrid(key) {
  const month = key && $(`m-${key.slice(0, 7)}`);
  return month ? month.querySelector('.grid') : null;
}

// The selected day's week plus the two weeks before it stay visible above the sheet.
function visibleRows(key) {
  const grid = monthGrid(key);
  if (!grid) return null;
  const cells = [...grid.children];
  const idx = cells.findIndex((c) => c.dataset.date === key);
  const lastRow = Math.floor((cells.length - 1) / 7);
  const row = Math.max(0, Math.floor(idx / 7));
  const startRow = Math.max(0, Math.min(row - 2, lastRow - 2));
  const first = cells[startRow * 7];
  const last = cells[Math.min(cells.length - 1, (startRow + 2) * 7)];
  const top = first.getBoundingClientRect().top + window.scrollY;
  const bottom = last.getBoundingClientRect().bottom + window.scrollY;
  return { top, height: bottom - top };
}

function gridScrollTop(key) {
  const rows = visibleRows(key);
  return rows ? rows.top - barHeight() - 6 : window.scrollY;
}

function sheetHeight() {
  const rows = visibleRows(sheet.key);
  const used = barHeight() + 6 + (rows ? rows.height : 180) + 3;
  return Math.max(300, window.innerHeight - used);
}

function setSheetHeight(h, animate = true) {
  const el = $('runSheet');
  el.style.transition = animate ? '' : 'none';
  el.style.height = `${Math.max(0, h)}px`;
}

function showSheet() {
  const el = $('runSheet');
  el.hidden = false;
  sheet.open = true;
  requestAnimationFrame(() => setSheetHeight(sheetHeight()));
}

function closeRunSheet() {
  const el = $('runSheet');
  if (sheet.open) haptic();
  sheet.open = false;
  sheet.key = null;
  setSheetHeight(0);
  markSelected(null);
  setTimeout(() => {
    if (sheet.open) return;
    el.hidden = true;
    document.body.style.paddingBottom = '';
  }, 330);
}

function markSelected(key) {
  document.querySelectorAll('.day.selected').forEach((d) => d.classList.remove('selected'));
  if (key) document.querySelector(`.day[data-date="${key}"]`)?.classList.add('selected');
}

function openDay(key, silent) {
  if (!silent) haptic();
  const runs = state.byDate.get(key) || [];
  sheet.key = key;
  markSelected(key);
  $('sheetTitle').textContent = dayTitle(key);
  const body = $('sheetBody');
  body.innerHTML = runs.map(runHTML).join('');
  body.classList.toggle('multi', runs.length > 1);
  body.scrollTop = 0;
  document.body.style.paddingBottom = `${window.innerHeight}px`; // room to lift any week under the header
  window.scrollTo({ top: gridScrollTop(key), behavior: 'smooth' });
  showSheet();
  body.querySelectorAll('.map').forEach((el) => drawMap(el, runs[Number(el.dataset.run)]));
}

function initSheetDrag() {
  const el = $('runSheet');
  const body = $('sheetBody');
  let drag = null;


  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { drag = null; return; }
    drag = { y0: e.touches[0].clientY, h0: el.offsetHeight, active: false, last: [] };
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!drag) return;
    const y = e.touches[0].clientY;
    const dy = y - drag.y0;
    if (!drag.active) {
      if (Math.abs(dy) < 6) return;
      if (dy > 0 && body.scrollTop <= 0) {
        drag.active = true;
        drag.y0 = y;
      } else {
        drag = null; // let the content scroll
        return;
      }
    }
    e.preventDefault();
    setSheetHeight(Math.min(drag.h0, drag.h0 - (y - drag.y0)), false);
    drag.last.push([performance.now(), y]);
    if (drag.last.length > 5) drag.last.shift();
  }, { passive: false });

  const end = () => {
    if (!drag || !drag.active) { drag = null; return; }
    const pulled = drag.h0 - el.offsetHeight;
    const [t0, y0] = drag.last[0] || [0, 0];
    const [t1, y1] = drag.last[drag.last.length - 1] || [1, 0];
    const v = (y1 - y0) / Math.max(1, t1 - t0);
    drag = null;
    if (pulled > 90 || v > 0.45) closeRunSheet();
    else setSheetHeight(sheetHeight());
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);

  window.addEventListener('resize', () => { if (sheet.open) setSheetHeight(sheetHeight(), false); });
}

/* ------------------------------------------------------------ year overview */
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function renderYears() {
  const kmByDay = new Map();
  for (const r of state.runs) kmByDay.set(r.date, (kmByDay.get(r.date) || 0) + (r.distance || 0));
  const years = [...new Set(state.runs.map((r) => Number(r.date.slice(0, 4))))].sort((a, b) => a - b); // oldest on top, like the month feed
  const t = new Date();
  const todayIso = iso(t.getFullYear(), t.getMonth(), t.getDate());
  return years.map((y) => {
    const yearRuns = state.runs.filter((r) => r.date.startsWith(`${y}-`));
    const yearKm = yearRuns.reduce((a, r) => a + (r.distance || 0), 0);
    let rows = '';
    for (let m = 0; m < 12; m++) {
      const days = new Date(y, m + 1, 0).getDate();
      let dots = '', monthM = 0;
      for (let d = 1; d <= 31; d++) {
        if (d > days) { dots += '<i class="off"></i>'; continue; }
        const key = iso(y, m, d);
        const meters = kmByDay.get(key) || 0;
        monthM += meters;
        const cls = meters >= 10000 ? 'r3' : meters >= 5000 ? 'r2' : meters > 0 ? 'r1' : key > todayIso ? 'fut' : '';
        dots += `<i class="${cls}"></i>`;
      }
      rows += `<div class="ym"><span class="ym-name">${MONTHS_SHORT[m]}</span><div class="ym-dots">${dots}</div>
        <span class="ym-km${monthM ? '' : ' zero'}">${monthM ? kmTotal(monthM) : '—'}</span></div>`;
    }
    return `<section class="year"><h2>${y}</h2>
      <p>${yearRuns.length} ${plural(yearRuns.length, 'пробежка', 'пробежки', 'пробежек')}, ${kmTotal(yearKm)} км</p>${rows}</section>`;
  }).join('');
}

function openYears() {
  if (!state.runs.length) return;
  haptic();
  const body = $('yearBody');
  body.innerHTML = renderYears();
  $('yearView').hidden = false;
  body.scrollTop = body.scrollHeight; // start at the current year
}
function closeYears() {
  haptic();
  $('yearView').hidden = true;
}

/* ------------------------------------------------------------ sync */
function setStatus(text, kind) {
  const el = $('status');
  if (!text) {
    el.className = 'status idle';
    el.textContent = '';
    return;
  }
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.innerHTML = text;
}
function setBusy(busy) {
  $('syncSpin').hidden = !busy;
}

function askToken() {
  return new Promise((resolve) => {
    const wrap = $('tokenWrap');
    const form = $('tokenForm');
    const input = $('tokenInput');
    input.value = '';
    openSheet(wrap);
    setTimeout(() => input.focus(), 50);
    const closers = wrap.querySelectorAll('[data-close-token]');
    const done = (value) => {
      form.removeEventListener('submit', onSubmit);
      closers.forEach((el) => el.removeEventListener('click', onCancel));
      closeSheet(wrap);
      resolve(value);
    };
    const onSubmit = (e) => { e.preventDefault(); done(input.value.trim() || null); };
    const onCancel = () => done(null);
    form.addEventListener('submit', onSubmit);
    closers.forEach((el) => el.addEventListener('click', onCancel));
  });
}

function gh(path, token, init = {}) {
  return fetch(API + path, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

/* Light haptic tap. iOS 18+ Safari ticks when a switch checkbox toggles; elsewhere vibrate if available. */
let hapticLabel = null;
function haptic() {
  try {
    if (navigator.vibrate) { navigator.vibrate(8); return; }
    if (!hapticLabel) {
      hapticLabel = document.createElement('label');
      hapticLabel.className = 'haptic';
      hapticLabel.setAttribute('aria-hidden', 'true');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      hapticLabel.appendChild(input);
      document.body.appendChild(hapticLabel);
    }
    hapticLabel.click();
  } catch { /* no haptics */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Sync runs automatically when the app is opened (at most every 10 minutes). */
const AUTO_SYNC_MIN_GAP = 10 * 60 * 1000;
let syncing = false;
let lastAttempt = 0;

function offerConnect(message) {
  setStatus(`${message} <a href="#" id="connectLink">Подключить синхронизацию</a>`, message ? 'error' : '');
  $('connectLink').addEventListener('click', async (e) => {
    e.preventDefault();
    const token = await askToken();
    if (!token) return;
    store.set(TOKEN_KEY, token);
    setStatus('');
    sync();
  });
}

function maybeAutoSync() {
  if (syncing || document.visibilityState !== 'visible') return;
  const token = store.get(TOKEN_KEY);
  if (!token) { offerConnect(''); return; }
  const last = Math.max(lastAttempt, state.updated ? Date.parse(state.updated) : 0);
  if (Date.now() - last < AUTO_SYNC_MIN_GAP) return;
  sync();
}

async function sync() {
  const token = store.get(TOKEN_KEY);
  if (!token || syncing) return;
  syncing = true;
  lastAttempt = Date.now();
  setBusy(true);
  const before = new Set(state.runs.map((r) => r.id));
  const beforeUpdated = state.updated;
  const startedAt = Date.now() - 20000;

  try {
    const res = await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, token, {
      method: 'POST',
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      store.del(TOKEN_KEY);
      offerConnect('GitHub не принял токен.');
      return;
    }
    if (!res.ok) throw new Error(`Синхронизация не запустилась: GitHub ответил ошибкой ${res.status}.`);

    let run = null;
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const r = await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`, token);
      if (!r.ok) continue;
      const list = (await r.json()).workflow_runs || [];
      run = list.find((x) => Date.parse(x.created_at) >= startedAt) || null;
      if (run && run.status === 'completed') break;
    }
    if (!run || run.status !== 'completed') return; // still running; next open will pick it up
    if (run.conclusion !== 'success') {
      throw new Error(`Синхронизация не удалась. <a href="${run.html_url}" target="_blank" rel="noopener">Подробности на GitHub</a>`);
    }

    // The new site version can take a few seconds to reach the CDN.
    for (let i = 0; i < 8; i++) {
      await loadData();
      if (state.updated !== beforeUpdated) break;
      await sleep(4000);
    }
    const added = state.runs.filter((r) => !before.has(r.id));
    if (!added.length) {
      $('total').textContent = totalText();
      $('countAll').textContent = state.runs.length || '';
      return;
    }
    added.forEach((r) => state.fresh.add(r.id));
    const openKey = sheet.open ? sheet.key : null;
    render({ scrollTo: openKey ? null : added.reduce((a, b) => (b.start > a.start ? b : a)).date.slice(0, 7) });
    if (openKey) openDay(openKey, true);
    haptic();
  } catch (err) {
    setStatus(err.message || 'Синхронизация не удалась.', 'error');
  } finally {
    syncing = false;
    setBusy(false);
  }
}

/* ------------------------------------------------------------ init */
async function init() {
  // No pinch zoom (iOS ignores user-scalable=no in Safari).
  document.addEventListener('touchstart', () => {}, { passive: true }); // enables :active on iOS
  document.getElementById('feed').addEventListener('click', (e) => {
    const day = e.target.closest('.day');
    if (day && !day.classList.contains('has-run') && day.querySelector('.num') && !day.closest('.fading')) haptic();
  });
  ['gesturestart', 'gesturechange'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault(), { passive: false }));
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  $('sheetDone').addEventListener('click', closeRunSheet);
  $('mapDone').addEventListener('click', closeFullMap);
  $('total').addEventListener('click', openYears);
  $('countAll').addEventListener('click', openYears);
  $('yearDone').addEventListener('click', closeYears);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('yearView').hidden) closeYears();
    else if (!$('mapView').hidden) closeFullMap();
    else if (sheet.open) closeRunSheet();
  });
  initSheetDrag();
  try {
    await loadData();
  } catch {
    render();
    setStatus('Не удалось загрузить данные. Проверь интернет и обнови страницу.', 'error');
    return;
  }
  render();
  maybeAutoSync();

  // Rotating the phone: rebuild the calendar for the new width so nothing keeps the old size.
  let lastWidth = window.innerWidth, resizeTimer = 0;
  const relayout = () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    const bar = barHeight();
    const top = [...document.querySelectorAll('.month')].find((m) => m.getBoundingClientRect().bottom > bar + 40);
    const openKey = sheet.open ? sheet.key : null;
    render({ scrollTo: top ? top.id.slice(2) : null });
    if (openKey) openDay(openKey, true);
  };
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 150); });
  window.addEventListener('orientationchange', () => setTimeout(relayout, 300));
  document.addEventListener('visibilitychange', maybeAutoSync);
}

init();
