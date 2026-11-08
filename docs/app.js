// Tooker Menu web app
// Loads menu.json (written every morning by the GitHub Action) and shows it.

const TZ = 'America/Phoenix';
const PREFS_KEY = 'tooker-prefs-v1';

// Rough end time of each meal (minutes after midnight). Only used to open the
// app on the meal that's being served right now.
const MEAL_ENDS = {
  'Breakfast': 10 * 60 + 30, 'Morning Snack': 11 * 60, 'Brunch': 14 * 60,
  'Lunch': 14 * 60, 'Light Lunch': 14 * 60, 'Afternoon Snack': 16 * 60 + 30,
  'Limited Dinner': 20 * 60, 'Dinner': 20 * 60, 'Evening Snack': 23 * 60,
};

let data = null;
let lastLoad = 0;
const state = { date: null, meal: null };
let prefs = loadPrefs();

const $ = (id) => document.getElementById(id);
const norm = (s) => (s || '').trim().toLowerCase();

// Small helper to build HTML elements safely (no innerHTML with menu text).
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

// ---------- time ----------
function nowInPhoenix() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

const asDate = (iso) => new Date(`${iso}T12:00:00Z`);
function dayChip(iso, today) {
  const diff = Math.round((asDate(iso) - asDate(today)) / 86400000);
  const wk = asDate(iso).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  const num = asDate(iso).getUTCDate();
  if (diff === 0) return ['Today', num];
  if (diff === 1) return ['Tmrw', num];
  return [wk, num];
}

// ---------- preferences (saved on this phone only) ----------
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (p && typeof p === 'object') return { stations: p.stations ?? null, hideAlways: p.hideAlways ?? true };
  } catch {}
  return { stations: null, hideAlways: true };
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}
const activeStations = () => prefs.stations ?? data?.preferences?.stations ?? [];

function visibleStations(meal) {
  const keep = new Set(activeStations().map(norm));
  const skip = {};
  if (prefs.hideAlways) {
    for (const [st, items] of Object.entries(data?.preferences?.skipItems || {})) {
      skip[norm(st)] = new Set(items.map(norm));
    }
  }
  return meal.stations
    .filter((s) => keep.has(norm(s.station)))
    .map((s) => {
      const sk = skip[norm(s.station)] || new Set();
      return {
        ...s,
        items: s.items.filter((i) => !sk.has(norm(i.name))),
        extras: s.extras.filter((i) => !sk.has(norm(i.name))),
      };
    })
    .filter((s) => s.items.length || s.extras.length);
}

// ---------- choosing what to show ----------
const upcomingDays = () => {
  const today = nowInPhoenix().date;
  return (data?.days || []).filter((d) => d.date >= today);
};

function defaultMeal(day) {
  if (!day?.meals.length) return null;
  const now = nowInPhoenix();
  if (day.date !== now.date) return day.meals[0].meal;
  const current = day.meals.find((m) => (MEAL_ENDS[m.meal] ?? 24 * 60) > now.minutes);
  return (current || day.meals[day.meals.length - 1]).meal;
}

function pickDefaults() {
  const days = upcomingDays();
  if (!days.some((d) => d.date === state.date)) state.date = days[0]?.date ?? null;
  const day = days.find((d) => d.date === state.date);
  if (!day?.meals.some((m) => m.meal === state.meal)) state.meal = defaultMeal(day);
}

// ---------- rendering ----------
function render() {
  const days = upcomingDays();
  const today = nowInPhoenix().date;

  $('days').replaceChildren(...days.map((d) => {
    const [top, num] = dayChip(d.date, today);
    return el('button', {
      class: 'day', type: 'button', 'aria-pressed': String(d.date === state.date),
      onclick: () => { state.date = d.date; state.meal = null; pickDefaults(); render(); },
    }, top, el('b', {}, String(num)));
  }));

  const day = days.find((d) => d.date === state.date);
  $('meals').replaceChildren(...(day?.meals || []).map((m) => el('button', {
    class: 'meal', type: 'button', 'aria-pressed': String(m.meal === state.meal),
    onclick: () => { state.meal = m.meal; render(); },
  }, m.meal)));

  const menu = $('menu');
  if (!data) return;
  if (!days.length) {
    menu.replaceChildren(el('p', { class: 'empty' }, 'No upcoming menus in the saved data yet. Check back after the next daily update.'));
    return;
  }
  const meal = day?.meals.find((m) => m.meal === state.meal);
  if (!meal) {
    menu.replaceChildren(el('p', { class: 'empty' }, 'No menu posted for this day.'));
    return;
  }
  if (meal.note) {
    menu.replaceChildren(el('p', { class: 'empty' }, 'No menu posted for this meal yet.'));
    return;
  }
  const stations = visibleStations(meal);
  if (!stations.length) {
    menu.replaceChildren(el('div', { class: 'empty' },
      el('p', {}, `Nothing from your stations at ${meal.meal}.`),
      el('button', { class: 'btn', type: 'button', onclick: openSettings }, 'Choose stations')));
    return;
  }
  menu.replaceChildren(...stations.map((s) => el('section', { class: 'station' },
    el('h2', {}, s.station),
    s.items.length ? el('ul', { class: 'items' }, s.items.map((i) => el('li', { class: 'item' },
      el('div', { class: 'item-head' },
        el('span', { class: 'name' }, i.name),
        i.calories != null ? el('span', { class: 'cal' }, `${i.calories} cal`) : null),
      i.description ? el('p', { class: 'desc' }, i.description) : null))) : null,
    s.extras.length ? el('p', { class: 'extras' }, el('b', {}, 'Also: '),
      s.extras.map((e) => e.name).join(', ')) : null)));
}

function renderUpdated() {
  if (!data?.scrapedAt) return;
  const when = new Date(data.scrapedAt).toLocaleString('en-US', {
    timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  $('updated').textContent = `Menu updated ${when}`;
}

// ---------- station settings ----------
function allStationNames() {
  const seen = new Map();
  for (const d of data?.days || []) for (const m of d.meals) for (const s of m.stations) {
    if (!seen.has(norm(s.station))) seen.set(norm(s.station), s.station);
  }
  for (const s of data?.preferences?.stations || []) if (!seen.has(norm(s))) seen.set(norm(s), s);
  return [...seen.values()];
}

function openSettings() {
  const active = new Set(activeStations().map(norm));
  $('stationList').replaceChildren(...allStationNames().map((name) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = active.has(norm(name));
    box.addEventListener('change', () => {
      const set = new Set(activeStations());
      for (const s of [...set]) if (norm(s) === norm(name)) set.delete(s);
      if (box.checked) set.add(name);
      prefs.stations = [...set];
      savePrefs(); render();
    });
    return el('label', { class: 'check' }, box, el('span', {}, name));
  }));
  $('hideAlways').checked = prefs.hideAlways;
  $('settings').showModal();
}

$('settingsBtn').addEventListener('click', openSettings);
$('hideAlways').addEventListener('change', (e) => { prefs.hideAlways = e.target.checked; savePrefs(); render(); });
$('resetBtn').addEventListener('click', () => {
  prefs = { stations: null, hideAlways: true };
  savePrefs(); $('settings').close(); render();
});

// ---------- loading ----------
async function load() {
  try {
    const res = await fetch('menu.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    lastLoad = Date.now();
    pickDefaults();
    renderUpdated();
    render();
  } catch (err) {
    if (!data) {
      $('menu').replaceChildren(el('p', { class: 'empty' }, "Couldn't load the menu. Check your connection and reopen the app."));
    }
  }
}

// A home-screen app can stay open for days; refresh when it comes back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastLoad > 30 * 60 * 1000) { state.date = null; state.meal = null; load(); }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

load();
