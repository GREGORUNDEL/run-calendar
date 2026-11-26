'use strict';

const REPO = 'GREGORUNDEL/run-calendar';
const WORKFLOW = 'sync.yml';
const TOKEN_KEY = 'runCalendar.githubToken';
const API = 'https://api.github.com';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const $ = (id) => document.getElementById(id);
const state = { runs: [], byDate: new Map(), updated: null, year: 0, month: 0, fresh: new Set() };

/* ------------------------------------------------------------ storage */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/* ------------------------------------------------------------ format */
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const km = (m) => (m / 1000).toFixed(m >= 100000 ? 0 : 1).replace('.', ',');
function km2(m) { return (m / 1000).toFixed(2).replace('.', ','); }
function clock(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
  return h ? `${h}:${pad(mi)}:${pad(se)}` : `${mi}:${pad(se)}`;
}
function hours(s) {
  const total = Math.round(s / 60), h = Math.floor(total / 60), m = total % 60;
  return h ? `${h}<small>ч</small>${pad(m)}<small>м</small>` : `${m}<small>мин</small>`;
}
function pace(sec, meters) {
  if (!sec || !meters) return '—';
  const p = sec / (meters / 1000);
  return `${Math.floor(p / 60)}:${pad(Math.round(p % 60) % 60)}`;
}
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
function dayTitle(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
}
function updatedText(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const now = new Date();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  const day = sameDay ? 'сегодня' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return `Синхронизировано ${day} в ${time}`;
}
function rotationFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 25) - 12) + 'deg';
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
  return data;
}

/* ------------------------------------------------------------ render */
function stampSVG(totalMeters) {
  const value = km(totalMeters);
  const size = value.length > 4 ? 24 : 30;
  return `<svg viewBox="0 0 100 100" aria-hidden="true">
    <circle class="ring" cx="50" cy="50" r="44"/>
    <circle class="ring2" cx="50" cy="50" r="36"/>
    <g class="foot" transform="translate(50 26) rotate(-18)">
      <ellipse cx="-4" cy="-2" rx="3.6" ry="6.2"/>
      <ellipse cx="-3.4" cy="7.6" rx="2.6" ry="2.6"/>
      <ellipse cx="5" cy="1" rx="3.6" ry="6.2"/>
      <ellipse cx="5.6" cy="10.6" rx="2.6" ry="2.6"/>
    </g>
    <text class="km" x="50" y="${size === 30 ? 66 : 64}" style="font-size:${size}px">${value}</text>
    <text class="unit" x="50" y="80">км</text>
  </svg>`;
}

function render() {
  const { year, month } = state;
  $('month').innerHTML = `${MONTHS[month]}<small>${year}</small>`;

  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const todayIso = (() => { const t = new Date(); return iso(t.getFullYear(), t.getMonth(), t.getDate()); })();

  const grid = $('grid');
  grid.innerHTML = '';
  let count = 0, meters = 0, seconds = 0;

  for (let i = 0; i < lead; i++) {
    const cell = document.createElement('div');
    cell.className = 'day out';
    grid.appendChild(cell);
  }
  for (let d = 1; d <= days; d++) {
    const key = iso(year, month, d);
    const runs = state.byDate.get(key) || [];
    const cell = document.createElement(runs.length ? 'button' : 'div');
    cell.className = 'day';
    if (key === todayIso) cell.classList.add('today');
    if (key > todayIso) cell.classList.add('future');
    cell.innerHTML = `<span class="num">${d}</span>`;

    if (runs.length) {
      const total = runs.reduce((s, r) => s + (r.distance || 0), 0);
      count += runs.length;
      meters += total;
      seconds += runs.reduce((s, r) => s + (r.duration || 0), 0);
      cell.classList.add('has-run');
      cell.type = 'button';
      cell.setAttribute('aria-label', `${d} ${MONTHS[month].toLowerCase()}: ${runs.length} ${plural(runs.length, 'пробежка', 'пробежки', 'пробежек')}, ${km2(total)} км`);
      const stamp = document.createElement('span');
      stamp.className = 'stamp';
      stamp.style.setProperty('--r', rotationFor(runs[0].id));
      stamp.innerHTML = stampSVG(total);
      if (runs.some((r) => state.fresh.has(r.id))) {
        stamp.classList.add('pressed');
        stamp.style.animationDelay = `${(d % 7) * 60}ms`;
      }
      cell.appendChild(stamp);
      if (runs.length > 1) cell.insertAdjacentHTML('beforeend', `<span class="count">×${runs.length}</span>`);
      cell.addEventListener('click', () => openDay(key));
    }
    grid.appendChild(cell);
  }

  const stats = $('stats');
  stats.classList.toggle('zero', count === 0);
  stats.innerHTML = `
    <div class="stat"><b>${count}</b><span>${plural(count, 'пробежка', 'пробежки', 'пробежек')}</span></div>
    <div class="stat"><b>${km(meters)}</b><span>км</span></div>
    <div class="stat"><b>${hours(seconds)}</b><span>в беге</span></div>`;

  $('empty').hidden = state.runs.length > 0;
  $('updated').textContent = updatedText(state.updated);
  state.fresh.clear();
}

function shiftMonth(delta) {
  const d = new Date(state.year, state.month + delta, 1);
  state.year = d.getFullYear();
  state.month = d.getMonth();
  render();
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

async function drawMap(el, run) {
  try {
    const [L, track] = await Promise.all([
      loadLeaflet(),
      fetch(`data/tracks/${run.id}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('track')))),
    ]);
    if (!el.isConnected) return;
    const map = L.map(el, { zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap © CARTO',
    }).addTo(map);
    const line = L.polyline(track, { color: '#c42e2a', weight: 4, opacity: 0.9 }).addTo(map);
    map.fitBounds(line.getBounds(), { padding: [16, 16] });
  } catch {
    el.replaceWith(Object.assign(document.createElement('p'), { className: 'map-note', textContent: 'Карту не удалось загрузить.' }));
  }
}

function runHTML(r, i) {
  const time = r.start ? r.start.slice(11, 16) : '';
  const fig = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<section class="run">
    <h3>${escapeHTML(r.name || 'Пробежка')}</h3>
    <p class="when">Старт в ${time}</p>
    <dl class="figures">
      ${fig('Дистанция', r.distance ? `${km2(r.distance)} км` : '—')}
      ${fig('Время', r.duration ? clock(r.duration) : '—')}
      ${fig('Темп', `${pace(r.duration, r.distance)} /км`)}
      ${fig('Средний пульс', r.avgHr ? r.avgHr : '—')}
      ${fig('Макс. пульс', r.maxHr ? r.maxHr : '—')}
      ${fig('Набор высоты', r.elevGain != null ? `${r.elevGain} м` : '—')}
    </dl>
    ${r.track === 'ok' ? `<div class="map" data-run="${i}"></div>`
      : r.track === 'pending' ? '<p class="map-note">Маршрут загрузится при следующей синхронизации.</p>'
      : r.track === 'none' ? '<p class="map-note">Без GPS-маршрута.</p>' : ''}
  </section>`;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    const done = (value) => {
      form.removeEventListener('submit', onSubmit);
      wrap.querySelectorAll('[data-close-token]').forEach((el) => el.removeEventListener('click', onCancel));
      closeSheet(wrap);
      resolve(value);
    };
    const onSubmit = (e) => { e.preventDefault(); done(input.value.trim() || null); };
    const onCancel = () => done(null);
    form.addEventListener('submit', onSubmit);
    wrap.querySelectorAll('[data-close-token]').forEach((el) => el.addEventListener('click', onCancel));
  });
}

async function gh(path, token, init = {}) {
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
    if (added.length) {
      const newest = added.reduce((a, b) => (a.start > b.start ? a : b));
      const [y, m] = newest.date.split('-').map(Number);
      state.year = y;
      state.month = m - 1;
    }
    render();
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
function initGestures() {
  let x0 = null, y0 = null;
  const cal = document.querySelector('.cal');
  cal.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  cal.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
    x0 = null;
  });
}

async function init() {
  const now = new Date();
  state.year = now.getFullYear();
  state.month = now.getMonth();
  $('prev').addEventListener('click', () => shiftMonth(-1));
  $('next').addEventListener('click', () => shiftMonth(1));
  $('sync').addEventListener('click', sync);
  $('scrim').addEventListener('click', () => closeSheet($('sheetWrap')));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('sheetWrap').hidden) closeSheet($('sheetWrap'));
  });
  initGestures();
  try {
    await loadData();
  } catch {
    setStatus('Не удалось загрузить данные. Проверь интернет и обнови страницу.', 'error');
  }
  render();
}

init();
