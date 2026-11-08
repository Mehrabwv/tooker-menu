#!/usr/bin/env node
/**
 * Tooker House Dining Hall menu scraper (ASU Tempe)
 * ==================================================
 *
 * WHERE THE MENU LIVES
 *   sundevilhospitality.asu.edu -> "Hours & Locations" -> Tempe links Tooker
 *   House Dining Hall to ASU's dining platform:
 *     https://asu.mydininghub.com/en/tempe-campus/location/tooker-house-dining-hall
 *   That page builds the menu with JavaScript after it loads, so a plain
 *   download of the HTML has no food items in it.
 *
 * HOW THIS SCRIPT WORKS
 *   1. Opens the page in a headless (invisible) Chromium browser via Playwright,
 *      exactly like a visitor would.
 *   2. For each day, opens the "Meal:" dropdown and goes through EVERY meal
 *      period offered that day (Breakfast, Brunch, Lunch, Light Lunch,
 *      Afternoon Snack, Dinner, ... whatever Tooker is serving).
 *   3. Reads the stations and dishes off the page, keeps only the stations you
 *      care about (see CONFIG below), and saves the result as JSON + Markdown.
 *
 * USAGE
 *   node scraper.js                    today's menu
 *   node scraper.js --days 7           today + the next 6 days
 *   node scraper.js --date 2026-11-10  one specific day (up to ~6 weeks ahead)
 *   node scraper.js --all-stations     don't filter, show every station
 *   node scraper.js --out my_folder    choose where the files are written
 *   node scraper.js --json docs/menu.json
 *                                      write one JSON file for the website
 *                                      (used by the daily GitHub Action)
 *   node scraper.js --headed           show the browser window while it runs
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- CONFIG ---
const MENU_URL =
  'https://asu.mydininghub.com/en/tempe-campus/location/tooker-house-dining-hall';
const TIMEZONE = 'America/Phoenix'; // ASU's timezone, used to work out "today"

// Only these stations are kept (case doesn't matter). Edit freely.
const STATIONS_TO_KEEP = ['Home Zone', 'Pizza', 'True Balance'];

// Dishes to leave out because they're always available. Edit freely.
const ITEMS_TO_SKIP = {
  Pizza: ['Classic Cheese Pizza', 'Cheese Pizza', 'Pepperoni Pizza'],
};
// ---------------------------------------------------------------------------

const NO_MENU_NOTE = 'No menu posted on the site for this meal yet';
const USAGE = `Usage: node scraper.js [--days N] [--date YYYY-MM-DD] [--all-stations] [--out DIR] [--json FILE] [--headed]`;

function parseArgs(argv) {
  const opts = { days: 1, date: null, out: 'output', headed: false, allStations: false, json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--days') opts.days = parseInt(argv[++i], 10);
    else if (arg === '--json') opts.json = argv[++i];
    else if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--headed') opts.headed = true;
    else if (arg === '--all-stations') opts.allStations = true;
    else if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
    else { console.error(`Unknown option: ${arg}\n${USAGE}`); process.exit(1); }
  }
  if (!Number.isInteger(opts.days) || opts.days < 1) {
    console.error('--days must be a whole number of 1 or more'); process.exit(1);
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

function filterStations(stations, allStations) {
  if (allStations) return stations;
  const keep = new Set(STATIONS_TO_KEEP.map(norm));
  const skipByStation = Object.fromEntries(
    Object.entries(ITEMS_TO_SKIP).map(([st, items]) => [norm(st), new Set(items.map(norm))]),
  );
  return stations
    .filter((st) => keep.has(norm(st.station)))
    .map((st) => {
      const skip = skipByStation[norm(st.station)] || new Set();
      return {
        ...st,
        items: st.items.filter((it) => !skip.has(norm(it.name))),
        extras: st.extras.filter((it) => !skip.has(norm(it.name))),
      };
    })
    .filter((st) => st.items.length || st.extras.length);
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

async function getMealOptions(page) {
  await closePopups(page);
  await mealButton(page).click();
  const options = page.getByRole('option');
  await options.first().waitFor({ timeout: 10000 });
  const names = (await options.allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  await page.keyboard.press('Escape');
  return names;
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

// ---------- output ----------
const cal = (c) => (c == null ? '' : ` (${c} cal)`);

function toMarkdown(result) {
  const lines = [`# ${result.location} — Menu`, '',
    `Source: ${result.source}  `,
    `Scraped: ${result.scrapedAt}  `,
    `Stations: ${result.stationsFilter}`, ''];
  for (const day of result.days) {
    lines.push(`## ${day.label} (${day.date})`, '');
    if (!day.meals.length) lines.push('_No menu published for this day._', '');
    for (const meal of day.meals) {
      lines.push(`### ${meal.meal}`, '');
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
  return lines.join('\n');
}

function printDay(day) {
  console.log(`\n=== ${day.label} (${day.date}) ===`);
  if (!day.meals.length) console.log('  No menu published for this day.');
  for (const meal of day.meals) {
    console.log(`\n  [${meal.meal}]`);
    if (meal.note) console.log(`    (${meal.note})`);
    else if (!meal.stations.length) console.log('    (nothing from the selected stations)');
    for (const st of meal.stations) {
      console.log(`    ${st.station}`);
      for (const it of st.items) console.log(`      - ${it.name}${cal(it.calories)}`);
      if (st.extras.length) console.log(`      + also: ${st.extras.map((e) => e.name).join(', ')}`);
    }
  }
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const today = todayInPhoenix();
  const startDate = opts.date || today;
  const offset = daysBetween(today, startDate);
  if (offset < 0) { console.error('The site only shows today and future dates.'); process.exit(1); }

  const browser = await chromium.launch({ headless: !opts.headed });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const result = {
    location: 'Tooker House Dining Hall',
    source: MENU_URL,
    scrapedAt: new Date().toISOString(),
    stationsFilter: opts.allStations ? 'all' : STATIONS_TO_KEEP.join(', '),
    // The website uses these as its default station filter.
    preferences: { stations: STATIONS_TO_KEEP, skipItems: ITEMS_TO_SKIP },
    days: [],
  };

  try {
    console.log(`Opening ${MENU_URL} ...`);
    await doAndWaitForMenu(page, () =>
      page.goto(MENU_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }));
    await mealButton(page).waitFor({ timeout: 60000 });
    await closePopups(page);

    // Step forward from today to the start date, one day at a time.
    for (let i = 1; i <= offset; i++) {
      if (!(await goToNextDay(page, pageDateLabel(addDays(today, i))))) {
        throw new Error(`No menus are published for ${startDate} yet.`);
      }
    }

    for (let d = 0; d < opts.days; d++) {
      const date = addDays(startDate, d);
      try {
        if (d > 0 && !(await goToNextDay(page, pageDateLabel(date)))) {
          console.log(`\nNo menus published past ${addDays(date, -1)}; stopping.`);
          break;
        }
        const day = { date, label: pageDateLabel(date), meals: [] };
        const meals = await getMealOptions(page);
        console.log(`\n${day.label}: meal periods offered -> ${meals.join(', ')}`);
        for (const meal of meals) {
          await selectMeal(page, meal);
          // The site sometimes lists a meal period but hasn't posted its menu yet.
          const noMenu = await page.getByText('no menus available for this meal period')
            .first().isVisible().catch(() => false);
          const stations = noMenu ? [] : filterStations(await readMenu(page), opts.allStations);
          day.meals.push({ meal, ...(noMenu && { note: NO_MENU_NOTE }), stations });
        }
        result.days.push(day);
        printDay(day);
      } catch (err) {
        // Keep the days we already have instead of losing everything.
        console.error(`\nStopped at ${date}: ${err.message}`);
        break;
      }
    }
  } finally {
    await browser.close();
  }

  if (!result.days.length) throw new Error('No menu data was scraped.');

  if (opts.json) {
    // Website mode: one JSON file. If a later day failed this run, keep that
    // day from the previous file so the site doesn't lose it.
    let previous = [];
    try { previous = JSON.parse(fs.readFileSync(opts.json, 'utf8')).days || []; } catch {}
    const have = new Set(result.days.map((d) => d.date));
    for (const old of previous) {
      if (old.date >= today && !have.has(old.date)) result.days.push(old);
    }
    result.days.sort((a, b) => a.date.localeCompare(b.date));
    fs.mkdirSync(path.dirname(opts.json), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(result));
    console.log(`\nSaved ${opts.json} (${result.days.length} days)`);
    return;
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const base = path.join(opts.out, `tooker_menu_${startDate}${opts.days > 1 ? `_${opts.days}days` : ''}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
  fs.writeFileSync(`${base}.md`, toMarkdown(result));
  console.log(`\nSaved ${base}.json and ${base}.md`);
}

main().catch((err) => {
  console.error('Scrape failed:', err.message);
  process.exit(1);
});
