// ASU Dining Hall Tracker web app
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
    if (v == null) continue;
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

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
function fmtTime(hhmm) { // "16:30" -> "4:30 PM", "07:00" -> "7 AM"
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h % 24 < 12 ? 'AM' : 'PM'}`;
}

const asDate = (iso) => new Date(`${iso}T12:00:00Z`);
function relDay(iso) { // "today" / "tomorrow" / "Thursday"
  const diff = Math.round((asDate(iso) - asDate(nowInPhoenix().date)) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return asDate(iso).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

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
  const fresh = { hall: null, stations: {}, hideAlways: true, avoid: [], require: [] };
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (p && typeof p === 'object') {
      return { ...fresh, ...p, stations: p.stations || {}, avoid: p.avoid || [], require: p.require || [] };
    }
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

// ---------- food restrictions (apply at every hall) ----------
// Each dish in the saved menus has tags like "beef", "milk", "vegan". The
// allergen and diet tags are the dining site's own labels; the meat tags are
// worked out from the dish name, description and ingredient list.
const RESTRICTIONS = {
  meats: [['beef', 'Beef'], ['pork', 'Pork'], ['poultry', 'Chicken & turkey'], ['seafood', 'Fish & shellfish']],
  allergens: [['egg', 'Eggs'], ['fish', 'Fish'], ['milk', 'Milk'], ['peanut', 'Peanuts'], ['sesame', 'Sesame'],
    ['shellfish', 'Shellfish'], ['soy', 'Soy'], ['treenut', 'Tree nuts'], ['wheat', 'Wheat']],
  diets: [['vegetarian', 'Vegetarian'], ['vegan', 'Vegan'], ['gf', 'Gluten free'], ['halal', 'Halal']],
};
const ALLERGEN_CODES = new Set(RESTRICTIONS.allergens.map(([code]) => code));
const hasRestrictions = () => prefs.avoid.length > 0 || prefs.require.length > 0;

// 'hide' = conflicts with your restrictions, 'warn' = can't be sure, 'ok' = fine.
function checkDish(dish) {
  if (!hasRestrictions()) return 'ok';
  const tags = dish.tags;
  if (!tags) return 'warn'; // menu saved before tags existed
  if (prefs.avoid.some((t) => tags.includes(t))) return 'hide';
  if (prefs.require.some((t) => !tags.includes(t))) return 'hide';
  // The site says this dish's allergen list is incomplete.
  if (tags.includes('allergen?') && prefs.avoid.some((t) => ALLERGEN_CODES.has(t))) return 'warn';
  return 'ok';
}

let hiddenCount = 0; // dishes hidden by restrictions in the meal on screen

function visibleStations(meal) {
  hiddenCount = 0;
  const allowed = (list) => list.flatMap((dish) => {
    const verdict = checkDish(dish);
    if (verdict === 'hide') { hiddenCount++; return []; }
    return [verdict === 'warn' ? { ...dish, warn: true } : dish];
  });
  const keep = new Set(activeStations().map(norm));
  const skipRules = prefs.hideAlways ? Object.entries(index?.preferences?.skipItems || {}) : [];
  return meal.stations
    .filter((s) => keep.has(norm(s.station)))
    .map((s) => {
      const skip = new Set(skipRules.filter(([k]) => matchesAny(s.station, [k]))
        .flatMap(([, items]) => items.map(norm)));
      return {
        ...s,
        items: allowed(s.items.filter((i) => !skip.has(norm(i.name)))),
        extras: allowed(s.extras.filter((i) => !skip.has(norm(i.name)))),
      };
    })
    .filter((s) => s.items.length || s.extras.length);
}

// ---------- choosing what to show ----------
const upcomingDays = () => {
  const today = nowInPhoenix().date;
  return (hall()?.days || []).filter((d) => d.date >= today);
};

// Opening hours for one meal on one day, e.g. { meal, from: '16:30', to: '20:00' }.
const mealHours = (day, meal) => day?.hours?.find((h) => norm(h.meal) === norm(meal));

function defaultMeal(day) {
  if (!day?.meals.length) return null;
  const now = nowInPhoenix();
  if (day.date !== now.date) return day.meals[0].meal;
  const endsAt = (m) => {
    const h = mealHours(day, m.meal);
    return h ? toMinutes(h.to) : (MEAL_ENDS[m.meal] ?? 24 * 60);
  };
  const current = day.meals.find((m) => endsAt(m) > now.minutes);
  return (current || day.meals[day.meals.length - 1]).meal;
}

// When the hall next opens after the current moment, e.g. "at 4:30 PM" or
// "Thursday at 7 AM" (null if not in the saved days).
function nextOpening(afterDate, afterMinutes) {
  for (const d of upcomingDays()) {
    if (d.date < afterDate) continue;
    const h = (d.hours || []).find((x) => d.date > afterDate || toMinutes(x.from) > afterMinutes);
    if (h) return d.date === nowInPhoenix().date ? `at ${fmtTime(h.from)}` : `${relDay(d.date)} at ${fmtTime(h.from)}`;
  }
  return null;
}

// "Open now · Dinner until 8 PM" or "Closed now · Opens tomorrow at 7 AM".
function hallStatus() {
  const now = nowInPhoenix();
  const today = upcomingDays().find((d) => d.date === now.date);
  if (!today || (!today.hours && !today.closed)) return null; // hours unknown
  const open = (today.hours || []).find((h) => toMinutes(h.from) <= now.minutes && now.minutes < toMinutes(h.to));
  if (open) return { open: true, text: `Open now · ${open.meal} until ${fmtTime(open.to)}` };
  const prefix = today.closed ? `Closed today${today.special ? ` (${today.special})` : ''}` : 'Closed now';
  const next = nextOpening(now.date, now.minutes);
  return { open: false, text: next ? `${prefix} · Opens ${next}` : prefix };
}

function closedNotice(day) {
  const when = relDay(day.date);
  const next = nextOpening(day.date, 24 * 60);
  return el('div', { class: 'notice', role: 'status' },
    el('strong', {}, `${shortName(hall().name)} is closed ${/^(today|tomorrow)$/.test(when) ? when : `on ${when}`}`),
    day.special ? el('span', {}, day.special) : null,
    next ? el('span', {}, `Opens ${next}`) : null);
}

function pickDefaults() {
  const days = upcomingDays();
  if (!days.some((d) => d.date === state.date)) state.date = days[0]?.date ?? null;
  const day = days.find((d) => d.date === state.date);
  if (!day?.meals.some((m) => m.meal === state.meal)) state.meal = defaultMeal(day);
}

// ---------- rendering ----------
function renderHallPicker() {
  const today = nowInPhoenix().date;
  $('hall').replaceChildren(...index.locations.map((l) => {
    // Not on the selected hall: its status line already says so.
    const closedToday = l.slug !== state.hall && halls[l.slug]?.days?.find((d) => d.date === today)?.closed;
    const opt = el('option', { value: l.slug }, shortName(l.name) + (closedToday ? ' (closed today)' : ''));
    opt.selected = l.slug === state.hall;
    return opt;
  }));
}

function renderStatus() {
  $('settingsBtn').classList.toggle('active', hasRestrictions());
  const st = hall() ? hallStatus() : null;
  const p = $('status');
  p.hidden = !st;
  if (st) {
    p.textContent = st.text;
    p.className = `status ${st.open ? 'open' : 'closed'}`;
  }
}

function render() {
  const days = upcomingDays();
  const today = nowInPhoenix().date;

  $('days').replaceChildren(...days.map((d) => {
    const [top, num] = dayChip(d.date, today);
    return el('button', {
      class: d.closed ? 'day closed' : 'day', type: 'button', 'aria-pressed': String(d.date === state.date),
      'aria-label': d.closed ? `${top} ${num}, closed` : null,
      onclick: () => { state.date = d.date; state.meal = null; pickDefaults(); render(); },
    }, top, el('b', {}, String(num)));
  }));
  renderStatus();

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
  // A closed day gets a notice at the top (and any menu the site still posted below it).
  const top = day?.closed ? [closedNotice(day)] : [];
  const show = (...nodes) => menu.replaceChildren(...top, ...nodes.filter(Boolean));

  const meal = day?.meals.find((m) => m.meal === state.meal);
  if (!meal) { show(top.length ? null : message('No menu posted for this day.')); return; }
  const mh = mealHours(day, meal.meal);
  const hoursLine = mh ? el('p', { class: 'meal-hours' }, `${meal.meal} · ${fmtTime(mh.from)} – ${fmtTime(mh.to)}`) : null;
  if (meal.note) { show(hoursLine, message('No menu posted for this meal yet.')); return; }

  const stations = visibleStations(meal);
  const hiddenNote = hiddenCount ? el('p', { class: 'hidden-note' },
    `${hiddenCount} ${hiddenCount === 1 ? 'dish' : 'dishes'} hidden by your food restrictions. `,
    el('button', { class: 'link', type: 'button', onclick: openSettings }, 'Change')) : null;
  if (!stations.length) {
    show(hoursLine, el('div', { class: 'empty' },
      el('p', {}, hiddenCount ? `Nothing at ${meal.meal} fits your food restrictions at these stations.`
        : `Nothing from your stations at ${meal.meal}.`),
      el('button', { class: 'btn', type: 'button', onclick: openSettings }, 'Change settings')));
    return;
  }
  const badges = (dish) => {
    const t = dish.tags || [];
    const list = [t.includes('vegan') ? 'Vegan' : t.includes('vegetarian') ? 'Vegetarian' : null,
      t.includes('gf') ? 'Gluten free' : null, t.includes('halal') ? 'Halal' : null].filter(Boolean);
    return list.length ? el('p', { class: 'badges' }, list.map((b) => el('span', {}, b))) : null;
  };
  const warning = (dish) => (dish.warn
    ? el('p', { class: 'warn' }, 'Allergen info not available for this dish. Ask the staff.') : null);
  show(hoursLine, ...stations.map((s) => el('section', { class: 'station' },
    el('h2', {}, s.station),
    s.items.length ? el('ul', { class: 'items' }, s.items.map((i) => el('li', { class: 'item' },
      el('div', { class: 'item-head' },
        el('span', { class: 'name' }, i.name),
        i.calories != null ? el('span', { class: 'cal' }, `${i.calories} cal`) : null),
      i.description ? el('p', { class: 'desc' }, i.description) : null,
      badges(i), warning(i)))) : null,
    s.extras.length ? el('p', { class: 'extras' }, el('b', {}, 'Also: '),
      s.extras.map((e) => e.name + (e.warn ? ' (allergen info not available)' : '')).join(', ')) : null)),
  hiddenNote);
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
  const group = (id, options, list) => $(id).replaceChildren(...options.map(([code, label]) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = prefs[list].includes(code);
    box.addEventListener('change', () => {
      prefs[list] = prefs[list].filter((c) => c !== code);
      if (box.checked) prefs[list].push(code);
      savePrefs(); render();
    });
    return el('label', { class: 'check' }, box, el('span', {}, label));
  }));
  group('avoidMeats', RESTRICTIONS.meats, 'avoid');
  group('avoidAllergens', RESTRICTIONS.allergens, 'avoid');
  group('requireDiets', RESTRICTIONS.diets, 'require');
  $('settings').showModal();
}

$('settingsBtn').addEventListener('click', openSettings);
$('hideAlways').addEventListener('change', (e) => { prefs.hideAlways = e.target.checked; savePrefs(); render(); });
$('resetBtn').addEventListener('click', () => {
  delete prefs.stations[state.hall];
  prefs.hideAlways = true;
  prefs.avoid = [];
  prefs.require = [];
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
  renderHallPicker(); // adds "(closed today)" labels as halls load
}

async function showHall(slug) {
  state.hall = slug;
  if (index) renderHallPicker();
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

// Keep "Open now / Closed now" current while the app stays open.
setInterval(() => { if (document.visibilityState === 'visible') renderStatus(); }, 60 * 1000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

load();
