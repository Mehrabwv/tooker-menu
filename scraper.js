#!/usr/bin/env node
/**
 * ASU Tempe dining hall menu scraper
 * ==================================
 *
 * WHERE THE MENUS LIVE
 *   sundevilhospitality.asu.edu -> "Hours & Locations" -> Tempe links each dining
 *   hall to ASU's dining platform, e.g.
 *     https://asu.mydininghub.com/en/tempe-campus/location/tooker-house-dining-hall
 *   Those pages build the menu with JavaScript after they load, so a plain
 *   download of the HTML has no food items in it.
 *
 * HOW THIS SCRIPT WORKS
 *   1. Reads the list of dining halls from the site's "Dining Halls" page
 *      (Barrett, Hassayampa, HIDA, Manzanita, Pitchforks, Tooker House, ...).
 *   2. Opens each hall's page in a headless (invisible) Chromium browser via
 *      Playwright, exactly like a visitor would. A few halls run at once.
 *   3. For each day, opens the "Meal:" dropdown and goes through EVERY meal
 *      period offered (Breakfast, Brunch, Lunch, Afternoon Snack, Dinner, ...).
 *   4. Reads the stations and dishes off the page, keeps only the stations you
 *      care about (see CONFIG below), and saves the result.
 *
 * USAGE
 *   node scraper.js                        today's menu at every Tempe dining hall
 *   node scraper.js --days 7               today + the next 6 days
 *   node scraper.js --location tooker-house-dining-hall
 *                                          only that hall (repeat for more halls)
 *   node scraper.js --date 2026-11-10      start on a specific day (~6 weeks ahead max)
 *   node scraper.js --all-stations         don't filter, show every station
 *   node scraper.js --out my_folder        where the .md/.json results are written
 *   node scraper.js --json-dir docs/menus  website mode: one JSON file per hall plus
 *                                          index.json (used by the GitHub Action)
 *   node scraper.js --parallel 3           how many halls to scrape at once
 *   node scraper.js --headed               show the browser windows while it runs
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- CONFIG ---
const CAMPUS_URL = 'https://asu.mydininghub.com/en/tempe-campus';
const DINING_HALLS_PAGE = `${CAMPUS_URL}/locations?cat=Dining+Halls`;
const TIMEZONE = 'America/Phoenix'; // ASU's timezone, used to work out "today"

// Used only if the "Dining Halls" page can't be read.
const KNOWN_DINING_HALLS = {
  'barrett-dining-center': 'Barrett Dining Center',
  'hassayampa-dining-hall': 'Hassayampa Dining Hall',
  'hida-dining-hall': 'HIDA Dining Hall',
  'manzanita-dining-hall': 'Manzanita Dining Hall',
  'pitchforks-dining-hall': 'Pitchforks Dining Hall',
  'tooker-house-dining-hall': 'Tooker House Dining Hall',
};

// Stations to keep. A station is kept if its name CONTAINS one of these (any
// case), so 'Pizza' also matches Hassayampa's "Sunbaked Pizza" and Pitchforks'
// "Pizza / Flatbread". The website uses this as its default filter. Edit freely.
const STATIONS_TO_KEEP = ['Home Zone', 'Pizza', 'True Balance'];

// Dishes to leave out because they're always available, by station keyword.
const ITEMS_TO_SKIP = {
  Pizza: ['Classic Cheese Pizza', 'Cheese Pizza', 'Pepperoni Pizza'],
};
// ---------------------------------------------------------------------------

const NO_MENU_NOTE = 'No menu posted on the site for this meal yet';
const USAGE = 'Usage: node scraper.js [--days N] [--date YYYY-MM-DD] [--location SLUG]... '
  + '[--all-stations] [--out DIR] [--json-dir DIR] [--parallel N] [--headed]';

function parseArgs(argv) {
  const opts = {
    days: 1, date: null, out: 'output', jsonDir: null, headed: false,
    allStations: false, locations: [], parallel: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') opts.days = parseInt(argv[++i], 10);
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--location') opts.locations.push(argv[++i]);
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--json-dir') opts.jsonDir = argv[++i];
    else if (arg === '--parallel') opts.parallel = parseInt(argv[++i], 10);
    else if (arg === '--headed') opts.headed = true;
    else if (arg === '--all-stations') opts.allStations = true;
    else if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
    else { console.error(`Unknown option: ${arg}\n${USAGE}`); process.exit(1); }
  }
  if (!Number.isInteger(opts.days) || opts.days < 1) {
    console.error('--days must be a whole number of 1 or more'); process.exit(1);
  }
  if (!Number.isInteger(opts.parallel) || opts.parallel < 1) {
    console.error('--parallel must be a whole number of 1 or more'); process.exit(1);
  }
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    console.error('--date must look like 2026-11-10'); process.exit(1);
  }
  return opts;
}

// ---------- date helpers (dates are plain "YYYY-MM-DD" strings) ----------
const todayInPhoenix = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (a, b) =>
  Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

// The page shows dates like "Mon, Nov 09"
const pageDateLabel = (isoDate) =>
  new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: '2-digit', timeZone: 'UTC',
  });

// ---------- filtering ----------
const norm = (s) => (s || '').trim().toLowerCase();
const matchesAny = (station, keywords) => keywords.some((k) => norm(station).includes(norm(k)));

function filterStations(stations, allStations) {
  if (allStations) return stations;
  return stations
    .filter((st) => matchesAny(st.station, STATIONS_TO_KEEP))
    .map((st) => {
      const skip = new Set(Object.entries(ITEMS_TO_SKIP)
        .filter(([keyword]) => matchesAny(st.station, [keyword]))
        .flatMap(([, items]) => items.map(norm)));
      return {
        ...st,
        items: st.items.filter((it) => !skip.has(norm(it.name))),
        extras: st.extras.filter((it) => !skip.has(norm(it.name))),
      };
    })
    .filter((st) => st.items.length || st.extras.length);
}

// ---------- finding the dining halls ----------
async function findDiningHalls(browser) {
  const page = await browser.newPage();
  try {
    await page.goto(DINING_HALLS_PAGE, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('a[href*="/location/"]', { timeout: 60000 });
    await page.waitForTimeout(2000); // let the whole list render
    const links = await page.$$eval('a[href*="/location/"]', (as) => as.map((a) => ({
      slug: a.getAttribute('href').split('/location/')[1].split(/[?#/]/)[0],
      name: (a.innerText || '').trim().split('\n')[0],
    })));
    const halls = new Map();
    for (const { slug, name } of links) {
      // Only real dining halls (guards against picking up unrelated links).
      if (slug && !halls.has(slug) && (/dining/i.test(name) || KNOWN_DINING_HALLS[slug])) {
        halls.set(slug, name || KNOWN_DINING_HALLS[slug]);
      }
    }
    if (halls.size) return [...halls].map(([slug, name]) => ({ slug, name }));
    throw new Error('no dining halls listed');
  } catch (err) {
    console.error(`Couldn't read the dining halls list (${err.message}); using the built-in list.`);
    return Object.entries(KNOWN_DINING_HALLS).map(([slug, name]) => ({ slug, name }));
  } finally {
    await page.close();
  }
}

// ---------- page helpers ----------
const mealButton = (page) =>
  page.locator('button[aria-haspopup="listbox"]', { hasText: 'Meal:' }).first();

async function closePopups(page) {
  // The "Dining With Us?" email sign-up box and a cookie banner can cover the menu.
  const closers = [
    page.locator('[role="dialog"] button[aria-label="Close"]'),
    page.locator('#onetrust-accept-btn-handler'),
  ];
  for (const c of closers) {
    if (await c.first().isVisible().catch(() => false)) {
      await c.first().click().catch(() => {});
    }
  }
}

// Wait until the menu on screen stops changing (data finished loading/rendering).
async function waitForMenuToSettle(page) {
  let last = null;
  let stableTicks = 0;
  for (let i = 0; i < 40 && stableTicks < 3; i++) {
    await page.waitForTimeout(300);
    const now = await page.evaluate(() =>
      [...document.querySelectorAll('section[data-scroll-section]')]
        .map((s) => s.innerText).join('\n'));
    stableTicks = now === last ? stableTicks + 1 : 0;
    last = now;
  }
}

// Run an action that makes the page fetch a new menu, and wait for it to finish.
async function doAndWaitForMenu(page, action) {
  const response = page
    .waitForResponse((r) => r.url().includes('getLocationRecipes'), { timeout: 20000 })
    .catch(() => null); // no request if the browser already had that menu cached
  await action();
  await response;
  await waitForMenuToSettle(page);
}

// The meal periods in the "Meal:" dropdown for the day on screen ([] if none).
async function getMealOptions(page) {
  await closePopups(page);
  try {
    await mealButton(page).click({ timeout: 10000 });
    const options = page.getByRole('option');
    await options.first().waitFor({ timeout: 10000 });
    return (await options.allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // dropdown disabled or empty: no menus posted for this day
  } finally {
    await page.keyboard.press('Escape');
  }
}

async function selectMeal(page, mealName) {
  const button = mealButton(page);
  const current = (await button.innerText()).replace('Meal:', '').trim();
  if (current === mealName) { await waitForMenuToSettle(page); return; }
  await closePopups(page);
  await button.click();
  await doAndWaitForMenu(page, () =>
    page.getByRole('option', { name: mealName, exact: true }).click());
}

async function goToNextDay(page, expectedLabel) {
  await closePopups(page);
  const next = page.getByRole('button', { name: 'Next Date' });
  if (await next.isDisabled()) return false; // no menus published that far ahead
  await doAndWaitForMenu(page, () => next.click());
  await page.locator('h2', { hasText: expectedLabel }).first()
    .waitFor({ timeout: 15000 }).catch(() => {});
  return true;
}

// Read every station and dish currently shown on the page.
async function readMenu(page) {
  // Expand any collapsed "View more" lists first.
  for (const b of await page.locator('button[aria-label^="View more"]').all()) {
    await b.click().catch(() => {});
  }
  return page.$$eval('section[data-scroll-section]', (sections) => {
    const calories = (el) => {
      const m = (el.innerText || '').match(/([\d,]+)\s*Calories/i);
      return m ? Number(m[1].replace(/,/g, '')) : null;
    };
    return sections.map((sec) => {
      const h3 = sec.querySelector('h3');
      const items = [...sec.querySelectorAll('[role="group"][aria-label="Recipe"]')].map((g) => ({
        name: g.querySelector('h4')?.innerText.trim() || '',
        description: g.querySelector('p')?.innerText.trim() || '',
        calories: calories(g),
      }));
      // Smaller "Also available at <station>" add-ons (toppings, sides, ...)
      const extras = [...sec.querySelectorAll('section')]
        .filter((s) => /^also available/i.test(s.querySelector('h4')?.innerText || ''))
        .flatMap((s) => [...s.querySelectorAll('li')].map((li) => ({
          name: li.querySelector('h4')?.innerText.trim() || '',
          calories: calories(li),
        })));
      return { station: h3?.innerText.trim() || 'Unknown station', items, extras };
    });
  });
}

// ---------- scraping one dining hall ----------
async function scrapeLocation(browser, hall, opts, today) {
  const url = `${CAMPUS_URL}/location/${hall.slug}`;
  const tag = `[${hall.name.replace(/ Dining (Hall|Center)$/i, '')}]`;
  const result = { slug: hall.slug, name: hall.name, url, days: [] };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Skip food photos, fonts and video: not needed for the text, and much faster.
  await context.route('**/*', (route) =>
    (['image', 'media', 'font'].includes(route.request().resourceType())
      ? route.abort() : route.continue()));
  const page = await context.newPage();
  try {
    console.log(`${tag} opening ${url}`);
    await doAndWaitForMenu(page, () =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }));
    await mealButton(page).waitFor({ timeout: 60000 });
    result.name = (await page.locator('h1').first().innerText().catch(() => '')).trim() || hall.name;
    await closePopups(page);

    // Step forward from today to the start date, one day at a time.
    for (let i = 1; i <= daysBetween(today, opts.startDate); i++) {
      if (!(await goToNextDay(page, pageDateLabel(addDays(today, i))))) {
        throw new Error(`no menus published for ${opts.startDate} yet`);
      }
    }

    for (let d = 0; d < opts.days; d++) {
      const date = addDays(opts.startDate, d);
      try {
        if (d > 0 && !(await goToNextDay(page, pageDateLabel(date)))) {
          console.log(`${tag} no menus published past ${addDays(date, -1)}`);
          break;
        }
        const day = { date, label: pageDateLabel(date), meals: [] };
        for (const meal of await getMealOptions(page)) {
          await selectMeal(page, meal);
          // The site sometimes lists a meal period but hasn't posted its menu yet.
          const noMenu = await page.getByText('no menus available for this meal period')
            .first().isVisible().catch(() => false);
          const stations = noMenu ? [] : filterStations(await readMenu(page), opts.allStations);
          day.meals.push({ meal, ...(noMenu && { note: NO_MENU_NOTE }), stations });
        }
        result.days.push(day);
        console.log(`${tag} ${day.label}: ${day.meals.map((m) => m.meal).join(', ') || 'no menus'}`);
      } catch (err) {
        // Keep the days we already have instead of losing everything.
        console.error(`${tag} stopped at ${date}: ${err.message}`);
        break;
      }
    }
  } catch (err) {
    result.error = err.message;
    console.error(`${tag} failed: ${err.message}`);
  } finally {
    await context.close();
  }
  return result;
}

// Run fn on every item, at most `limit` at a time.
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- output ----------
const cal = (c) => (c == null ? '' : ` (${c} cal)`);

function toMarkdown(meta, locations) {
  const lines = ['# ASU Tempe dining hall menus', '',
    `Source: ${meta.source}  `,
    `Scraped: ${meta.scrapedAt}  `,
    `Stations: ${meta.stationsFilter}`, ''];
  for (const loc of locations) {
    lines.push(`## ${loc.name}`, '');
    if (loc.error && !loc.days.length) lines.push(`_Couldn't scrape this hall: ${loc.error}_`, '');
    for (const day of loc.days) {
      lines.push(`### ${day.label} (${day.date})`, '');
      if (!day.meals.length) lines.push('_No menu published for this day._', '');
      for (const meal of day.meals) {
        lines.push(`#### ${meal.meal}`, '');
        if (meal.note) { lines.push(`_${meal.note}._`, ''); continue; }
        if (!meal.stations.length) { lines.push('_Nothing from the selected stations._', ''); continue; }
        for (const st of meal.stations) {
          lines.push(`**${st.station}**`, '');
          for (const it of st.items) {
            lines.push(`- ${it.name}${cal(it.calories)}${it.description ? ` — ${it.description}` : ''}`);
          }
          if (st.extras.length) {
            lines.push(`- _Also available:_ ${st.extras.map((e) => e.name + cal(e.calories)).join(', ')}`);
          }
          lines.push('');
        }
      }
    }
  }
  return lines.join('\n');
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// Website mode: one JSON file per hall plus index.json listing the halls.
// If a hall (or some of its days) failed this run, the previous data is kept.
function writeWebsiteFiles(dir, meta, locations, today) {
  fs.mkdirSync(dir, { recursive: true });
  const prevIndex = readJson(path.join(dir, 'index.json')) || {};
  const index = { ...meta, locations: [] };

  for (const loc of locations) {
    const file = `${loc.slug}.json`;
    const previous = readJson(path.join(dir, file)) || {};
    const have = new Set(loc.days.map((d) => d.date));
    const days = [...loc.days, ...(previous.days || []).filter((d) => d.date >= today && !have.has(d.date))]
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!days.length) continue;
    const updatedAt = loc.days.length ? meta.scrapedAt : previous.updatedAt;
    fs.writeFileSync(path.join(dir, file),
      JSON.stringify({ slug: loc.slug, name: loc.name, url: loc.url, updatedAt, days }));
    index.locations.push({ slug: loc.slug, name: loc.name, url: loc.url, file, updatedAt });
  }
  // Keep halls that weren't part of this run (e.g. when --location was used).
  for (const old of prevIndex.locations || []) {
    if (!index.locations.some((l) => l.slug === old.slug) && fs.existsSync(path.join(dir, old.file))) {
      index.locations.push(old);
    }
  }
  index.locations.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 1));
  console.log(`\nSaved ${index.locations.length} halls to ${dir}/`);
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const today = todayInPhoenix();
  opts.startDate = opts.date || today;
  if (daysBetween(today, opts.startDate) < 0) {
    console.error('The site only shows today and future dates.'); process.exit(1);
  }

  const meta = {
    source: CAMPUS_URL,
    scrapedAt: new Date().toISOString(),
    stationsFilter: opts.allStations ? 'all' : STATIONS_TO_KEEP.join(', '),
    // The website uses these as its default station filter.
    preferences: { stations: STATIONS_TO_KEEP, skipItems: ITEMS_TO_SKIP },
  };

  const browser = await chromium.launch({ headless: !opts.headed });
  let locations;
  try {
    const halls = opts.locations.length
      ? opts.locations.map((slug) => ({ slug, name: KNOWN_DINING_HALLS[slug] || slug }))
      : await findDiningHalls(browser);
    console.log(`Scraping ${halls.length} dining hall(s), ${opts.parallel} at a time: `
      + halls.map((h) => h.name).join(', '));
    locations = await mapWithLimit(halls, opts.parallel,
      (hall) => scrapeLocation(browser, hall, opts, today));
  } finally {
    await browser.close();
  }

  const failed = locations.filter((l) => !l.days.length);
  if (failed.length === locations.length) throw new Error('No menu data was scraped.');
  if (failed.length) console.warn(`\nNo data this run for: ${failed.map((l) => l.name).join(', ')}`);

  if (opts.jsonDir) {
    writeWebsiteFiles(opts.jsonDir, meta, locations, today);
    return;
  }
  fs.mkdirSync(opts.out, { recursive: true });
  const base = path.join(opts.out, `menus_${opts.startDate}${opts.days > 1 ? `_${opts.days}days` : ''}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ ...meta, locations }, null, 2));
  fs.writeFileSync(`${base}.md`, toMarkdown(meta, locations));
  console.log(`\nSaved ${base}.json and ${base}.md`);
}

main().catch((err) => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
