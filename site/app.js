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
function rotationFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 13) - 6) + 'deg';
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
function stickerSVG(meters) {
  const v = kmTotal(meters);
  const size = v.length >= 5 ? 27 : v.length === 4 ? 32 : 36;
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <g class="foot" transform="translate(50 22) rotate(-16) scale(.85)">
      <ellipse cx="-4" cy="-2" rx="3.6" ry="6.2"/><ellipse cx="-3.4" cy="7.6" rx="2.6" ry="2.6"/>
      <ellipse cx="5" cy="1" rx="3.6" ry="6.2"/><ellipse cx="5.6" cy="10.6" rx="2.6" ry="2.6"/>
    </g>
    <text x="50" y="${52 + size * 0.36}" style="font-size:${size}px">${v}</text>
    <text class="unit" x="50" y="84">км</text>
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
  for (let d = first; d <= new Date(y, m, 1); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    list.push([d.getFullYear(), d.getMonth()]);
  }
  return list;
}

function renderMonth(year, month, todayIso) {
  const section = document.createElement('section');
  section.className = 'month';
  section.id = `m-${monthKey(year, month)}`;
  const now = new Date();
  if (now.getFullYear() === year && now.getMonth() === month) section.classList.add('current');

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
      sticker.style.setProperty('--r', rotationFor(runs[0].id));
      sticker.innerHTML = stickerSVG(total);
      if (runs.some((r) => state.fresh.has(r.id))) sticker.classList.add('pressed');
      cell.appendChild(sticker);
      if (runs.length > 1) cell.insertAdjacentHTML('beforeend', `<span class="count">${runs.length}</span>`);
      cell.addEventListener('click', () => openDay(key));
    }
    grid.appendChild(cell);
  }

  const yearSuffix = year === now.getFullYear() ? '' : ` ${year}`;
  const summary = count
    ? `${count} ${plural(count, 'пробежка', 'пробежки', 'пробежек')}, ${kmTotal(meters)} км, ${hoursText(seconds)}`
    : 'Без пробежек';
  section.innerHTML = `<div class="month-head"><h2>${MONTHS[month]}${yearSuffix}</h2><p>${summary}</p></div>`;
  section.appendChild(grid);
  return section;
}

function render({ scrollTo } = {}) {
  const t = new Date();
  const todayIso = iso(t.getFullYear(), t.getMonth(), t.getDate());
  const feed = $('feed');
  feed.innerHTML = '';
  for (const [y, m] of monthRange()) feed.appendChild(renderMonth(y, m, todayIso));
  $('empty').hidden = state.runs.length > 0;
  $('updated').textContent = updatedText(state.updated);
  state.fresh.clear();

  const target = scrollTo && $(`m-${scrollTo}`);
  if (target && target !== feed.lastElementChild) {
    const barH = document.querySelector('.bar').offsetHeight;
    window.scrollTo(0, target.getBoundingClientRect().top + window.scrollY - barH);
  } else {
    window.scrollTo(0, document.documentElement.scrollHeight);
  }
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

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
async function drawMap(el, run) {
  try {
    const [L, track] = await Promise.all([
      loadLeaflet(),
      fetch(`data/tracks/${run.id}.json?v=${encodeURIComponent(state.updated || '')}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('track')))),
    ]);
    if (!el.isConnected) return;
    const map = L.map(el, { zoomControl: false, scrollWheelZoom: false });
    map.attributionControl.setPrefix(false);
    // Hybrid: satellite imagery + roads + place names
    L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19, maxNativeZoom: 18, attribution: 'Esri, Maxar, Earthstar Geographics',
    }).addTo(map);
    L.tileLayer(`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19, maxNativeZoom: 18, opacity: 0.75,
    }).addTo(map);
    L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 19, maxNativeZoom: 18,
    }).addTo(map);
    L.polyline(track, { color: '#000', weight: 8, opacity: 0.45 }).addTo(map);
    const line = L.polyline(track, { color: '#ff9f0a', weight: 4.5, opacity: 1, lineJoin: 'round' }).addTo(map);
    const dot = { radius: 6, weight: 2.5, color: '#000', fillOpacity: 1 };
    L.circleMarker(track[0], { ...dot, fillColor: '#ffffff' }).addTo(map);
    L.circleMarker(track[track.length - 1], { ...dot, fillColor: '#ff9f0a' }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [22, 22] });
  } catch {
    el.replaceWith(Object.assign(document.createElement('p'), { className: 'map-note', textContent: 'Карту не удалось загрузить.' }));
  }
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

function openDay(key) {
  const runs = state.byDate.get(key) || [];
  $('sheetTitle').textContent = dayTitle(key);
  const body = $('sheetBody');
  body.innerHTML = runs.map(runHTML).join('');
  openSheet($('sheetWrap'));
  body.querySelectorAll('.map').forEach((el) => drawMap(el, runs[Number(el.dataset.run)]));
}

/* ------------------------------------------------------------ sync */
function setStatus(text, kind) {
  const el = $('status');
  el.hidden = !text;
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.innerHTML = text || '';
}
function setBusy(busy) {
  const b = $('sync');
  b.classList.toggle('busy', busy);
  b.disabled = busy;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sync() {
  let token = store.get(TOKEN_KEY);
  if (!token) {
    token = await askToken();
    if (!token) return;
    store.set(TOKEN_KEY, token);
  }

  setBusy(true);
  setStatus('Запускаю синхронизацию…');
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
      throw new Error('GitHub не принял токен. Нажми синхронизацию ещё раз и вставь новый токен.');
    }
    if (!res.ok) throw new Error(`GitHub ответил ошибкой ${res.status}. Попробуй ещё раз через минуту.`);

    setStatus('Забираю пробежки из Garmin…');
    let run = null;
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const r = await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`, token);
      if (!r.ok) continue;
      const list = (await r.json()).workflow_runs || [];
      run = list.find((x) => Date.parse(x.created_at) >= startedAt) || null;
      if (!run) continue;
      if (run.status === 'completed') break;
      setStatus(run.status === 'queued' ? 'Синхронизация в очереди…' : 'Забираю пробежки из Garmin и обновляю сайт…');
    }
    if (!run || run.status !== 'completed') {
      throw new Error('Синхронизация идёт дольше обычного. Обнови страницу через пару минут.');
    }
    if (run.conclusion !== 'success') {
      throw new Error(`Синхронизация не удалась. <a href="${run.html_url}" target="_blank" rel="noopener">Открыть подробности на GitHub</a>`);
    }

    // The new site version can take a few seconds to reach the CDN.
    for (let i = 0; i < 8; i++) {
      await loadData();
      if (state.updated !== beforeUpdated) break;
      await sleep(4000);
    }
    const added = state.runs.filter((r) => !before.has(r.id));
    added.forEach((r) => state.fresh.add(r.id));
    const newest = added.reduce((a, b) => (!a || b.start > a.start ? b : a), null);
    render({ scrollTo: newest ? newest.date.slice(0, 7) : null });
    setStatus(added.length
      ? `Готово: ${added.length} ${plural(added.length, 'новая пробежка', 'новые пробежки', 'новых пробежек')}.`
      : 'Готово: новых пробежек нет.');
    setTimeout(() => setStatus(''), 6000);
  } catch (err) {
    setStatus(err.message || 'Синхронизация не удалась.', 'error');
  } finally {
    setBusy(false);
  }
}

/* ------------------------------------------------------------ init */
async function init() {
  $('sync').addEventListener('click', sync);
  $('scrim').addEventListener('click', () => closeSheet($('sheetWrap')));
  $('sheetDone').addEventListener('click', () => closeSheet($('sheetWrap')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('sheetWrap').hidden) closeSheet($('sheetWrap'));
  });
  try {
    await loadData();
  } catch {
    setStatus('Не удалось загрузить данные. Проверь интернет и обнови страницу.', 'error');
  }
  render();
}

init();
