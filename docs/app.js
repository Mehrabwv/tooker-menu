// Dining Hall Menus web app
// Loads menus/index.json (the list of halls) and menus/<hall>.json, which the
// GitHub Action rewrites twice a day, and shows them.

const TZ = 'America/Phoenix';
const PREFS_KEY = 'menu-prefs-v2';
const OLD_PREFS_KEY = 'tooker-prefs-v1'; // from the Tooker-only version
const DEFAULT_HALL = 'tooker-house-dining-hall';

// Rough end time of each meal (minutes after midnight). Only used to open the
// app on the meal that's being served right now.
const MEAL_ENDS = {
  'Breakfast': 10 * 60 + 30, 'Morning Snack': 11 * 60, 'Brunch': 14 * 60,
  'Lunch': 14 * 60, 'Light Lunch': 14 * 60, 'Afternoon Snack': 16 * 60 + 30,
  'Limited Dinner': 20 * 60, 'Dinner': 20 * 60, 'Evening Snack': 23 * 60,
};

let index = null;  // menus/index.json
let halls = {};    // slug -> that hall's menu JSON, loaded when needed
let lastLoad = 0;
const state = { hall: null, date: null, meal: null };
let prefs = loadPrefs();

const $ = (id) => document.getElementById(id);
const norm = (s) => (s || '').trim().toLowerCase();
const matchesAny = (name, keywords) => keywords.some((k) => norm(name).includes(norm(k)));
const shortName = (name) => name.replace(/\s+Dining\s+(Hall|Center)$/i, '');
const hall = () => halls[state.hall];

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
const message = (text) => el('p', { class: 'empty' }, text);

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
  const fresh = { hall: null, stations: {}, hideAlways: true };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (p && typeof p === 'object') return { ...fresh, ...p, stations: p.stations || {} };
    const old = JSON.parse(localStorage.getItem(OLD_PREFS_KEY));
    if (old && typeof old === 'object') {
      if (Array.isArray(old.stations)) fresh.stations[DEFAULT_HALL] = old.stations;
      if (typeof old.hideAlways === 'boolean') fresh.hideAlways = old.hideAlways;
    }
  } catch {}
  return fresh;
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

// Every station name at the current hall, in the order the site lists them.
function stationNames(h = hall()) {
  const seen = new Map();
  for (const d of h?.days || []) for (const m of d.meals) for (const s of m.stations) {
    if (!seen.has(norm(s.station))) seen.set(norm(s.station), s.station);
  }
  return [...seen.values()];
}

// Stations shown at this hall: your picks for it, or the default keywords
// ("Home Zone", "Pizza", "True Balance") matched against its station names.
function activeStations() {
  return prefs.stations[state.hall]
    ?? stationNames().filter((name) => matchesAny(name, index?.preferences?.stations || []));
}

function visibleStations(meal) {
  const keep = new Set(activeStations().map(norm));
  const skipRules = prefs.hideAlways ? Object.entries(index?.preferences?.skipItems || {}) : [];
  return meal.stations
    .filter((s) => keep.has(norm(s.station)))
    .map((s) => {
      const skip = new Set(skipRules.filter(([k]) => matchesAny(s.station, [k]))
        .flatMap(([, items]) => items.map(norm)));
      return {
        ...s,
        items: s.items.filter((i) => !skip.has(norm(i.name))),
        extras: s.extras.filter((i) => !skip.has(norm(i.name))),
      };
    })
    .filter((s) => s.items.length || s.extras.length);
}

// ---------- choosing what to show ----------
const upcomingDays = () => {
  const today = nowInPhoenix().date;
  return (hall()?.days || []).filter((d) => d.date >= today);
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
function renderHallPicker() {
  $('hall').replaceChildren(...index.locations.map((l) => {
    const opt = el('option', { value: l.slug }, shortName(l.name));
    opt.selected = l.slug === state.hall;
    return opt;
  }));
}

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

  const h = hall();
  if (h) {
    $('updated').textContent = `${shortName(h.name)} menu updated ${new Date(h.updatedAt).toLocaleString('en-US', {
      timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })}`;
    $('source').href = h.url;
  }

  const menu = $('menu');
  if (!days.length) {
    menu.replaceChildren(message('No upcoming menus saved for this hall yet. Check back after the next update.'));
    return;
  }
  const meal = day?.meals.find((m) => m.meal === state.meal);
  if (!meal) { menu.replaceChildren(message('No menu posted for this day.')); return; }
  if (meal.note) { menu.replaceChildren(message('No menu posted for this meal yet.')); return; }

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

// ---------- station settings (per hall) ----------
function openSettings() {
  if (!hall()) return;
  $('settingsTitle').textContent = `Stations at ${shortName(hall().name)}`;
  const active = new Set(activeStations().map(norm));
  $('stationList').replaceChildren(...stationNames().map((name) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = active.has(norm(name));
    box.addEventListener('change', () => {
      const picked = activeStations().filter((s) => norm(s) !== norm(name));
      if (box.checked) picked.push(name);
      prefs.stations[state.hall] = picked;
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
  delete prefs.stations[state.hall];
  prefs.hideAlways = true;
  savePrefs(); $('settings').close(); render();
});
$('hall').addEventListener('change', (e) => {
  prefs.hall = e.target.value;
  savePrefs();
  state.meal = null; // keep the same day if this hall has it
  showHall(e.target.value);
});

// ---------- loading ----------
async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadHall(slug) {
  const loc = index.locations.find((l) => l.slug === slug);
  halls[slug] = await fetchJson(`menus/${loc.file}`);
}

async function showHall(slug) {
  state.hall = slug;
  if (!halls[slug]) {
    $('meals').replaceChildren();
    $('menu').replaceChildren(message('Loading menu…'));
    try { await loadHall(slug); } catch {
      if (state.hall === slug) $('menu').replaceChildren(message("Couldn't load this hall's menu. Check your connection."));
      return;
    }
  }
  if (state.hall !== slug) return; // picked another hall while this one loaded
  pickDefaults();
  render();
}

async function load() {
  try {
    index = await fetchJson('menus/index.json');
  } catch {
    if (!index) $('menu').replaceChildren(message("Couldn't load the menus. Check your connection and reopen the app."));
    return;
  }
  lastLoad = Date.now();
  halls = {};
  const slugs = index.locations.map((l) => l.slug);
  state.hall = [state.hall, prefs.hall, DEFAULT_HALL, slugs[0]].find((s) => slugs.includes(s));
  renderHallPicker();
  await showHall(state.hall);
  // Fetch the other halls in the background so switching is instant (and works offline).
  setTimeout(() => slugs.forEach((s) => halls[s] || loadHall(s).catch(() => {})), 1500);
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
