# Dining Hall Menus

A phone-friendly web app showing the daily menus for every **ASU Tempe dining hall**:
Barrett, Hassayampa, HIDA, Manzanita, Pitchforks and Tooker House. It covers every
meal: Breakfast, Brunch, Lunch, Light Lunch, Afternoon Snack, Dinner and so on.

Pick a hall at the top of the app (it remembers your choice; Tooker House is the default).
By default each hall shows the stations whose names contain:

- **Home Zone**
- **Pizza** (e.g. "Sunbaked Pizza", "Pizza / Flatbread"), leaving out Classic Cheese
  and Pepperoni because they're always available
- **True Balance**

Use the ⚙ button to choose different stations. Your choice is remembered separately
for each hall, on your phone.

It also shows whether the hall is **open right now** ("Open now · Dinner until 8 PM" /
"Closed now · Opens tomorrow at 7 AM"), each meal's hours, and **closed days** such as
holidays and breaks, using the opening-hours schedule published on each hall's page.

**Live site:** https://mehrabwv.github.io/tooker-menu/

> Unofficial student project. Menu data comes from
> [asu.mydininghub.com](https://asu.mydininghub.com/en/tempe-campus/locations?cat=Dining+Halls).

## Food restrictions

The ⚙ button also has a **Food restrictions** section that applies at every hall:

- **Hide dishes with:** beef, pork, chicken & turkey, fish & shellfish
- **Hide dishes containing these allergens:** eggs, fish, milk, peanuts, sesame, shellfish,
  soy, tree nuts, wheat (the nine the ASU dining site tracks)
- **Only show dishes labeled:** vegetarian, vegan, gluten free, halal

Allergen and diet labels are the dining site's own. Beef, pork, poultry and seafood are
worked out by `tagsFor()` in `scraper.js` from each dish's name, description and
ingredient list, so they are best effort. Dishes whose allergen list the site marks as
incomplete are shown with a warning instead of being hidden. This is a convenience
filter, not a safety guarantee: with an allergy, always confirm with dining hall staff.

## Put it on your phone like an app

- **iPhone (Safari):** open the live site → **Share** button → **Add to Home Screen** → Add.
- **Android (Chrome):** open the live site → **⋮** menu → **Add to Home screen** / **Install app**.

It opens full-screen with its own icon, starts on whatever meal is being served
right now, and still opens with the last menus it saw when you have no signal.

## One-time GitHub setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. **Actions** tab → **Update menu and website** → **Run workflow**

After that it runs on its own twice a day (about 5:23 AM and 2:23 PM Arizona time).
Each run scrapes the next 7 days at every dining hall (about 10 minutes), commits
`docs/menus/` and republishes the site. This is all free on a public repo.

## How it works

```
asu.mydininghub.com ──(GitHub Action runs scraper.js in headless Chrome)──▶ docs/menus/*.json
                                                                              │
                      docs/index.html + app.js (GitHub Pages) ◀── loads ──────┘
```

1. `sundevilhospitality.asu.edu` links each dining hall to ASU's dining platform at
   `asu.mydininghub.com`. Those pages fill in the menu with JavaScript, so
   downloading the raw HTML (for example with Python `requests`) gives you no food items.
2. `scraper.js` reads the list of halls from the site's "Dining Halls" page, then
   drives a real (invisible) Chrome browser with [Playwright](https://playwright.dev),
   three halls at a time. For each day it picks every option in the **Meal:**
   dropdown, waits for the menu to load, and reads every station and dish.
3. `docs/` is the website: plain HTML, CSS and JavaScript with no build step.
   `manifest.webmanifest`, `sw.js` and `icons/` turn it into an installable app
   (a "PWA", progressive web app).

| File | What it is |
| --- | --- |
| `scraper.js` | The scraper (Node.js + Playwright) |
| `.github/workflows/update-menu.yml` | The schedule that runs the scraper and publishes the site |
| `docs/index.html`, `style.css`, `app.js` | The website |
| `docs/menus/index.json` | List of halls (and the default station filter) |
| `docs/menus/<hall>.json` | One hall's menus for the next 7 days |
| `docs/manifest.webmanifest`, `sw.js`, `icons/` | What makes it work as a home-screen app |

## Run the scraper on your computer

Install [Node.js](https://nodejs.org) (LTS), then in this folder:

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
node scraper.js --days 7
```

```bash
node scraper.js --location tooker-house-dining-hall --days 3
```

| Option | What it does |
| --- | --- |
| `--days N` | Today plus the next N-1 days |
| `--date YYYY-MM-DD` | Start on a specific day (the site posts menus about 6 weeks ahead) |
| `--location SLUG` | Only this hall, using the last part of its web address (repeat for more halls) |
| `--all-stations` | Skip the station filter and show everything |
| `--out DIR` | Folder for the `.md` and `.json` results (default `output/`) |
| `--json-dir DIR` | Website mode: one JSON per hall plus `index.json` |
| `--parallel N` | How many halls to scrape at once (default 3) |
| `--headed` | Show the browser windows so you can watch it work |

Hall slugs: `barrett-dining-center`, `hassayampa-dining-hall`, `hida-dining-hall`,
`manzanita-dining-hall`, `pitchforks-dining-hall`, `tooker-house-dining-hall`.

To preview the website locally, run `npx serve docs` (or `python3 -m http.server -d docs`)
and open the address it prints.

## Customizing

- **Default stations / always-available items:** `STATIONS_TO_KEEP` and
  `ITEMS_TO_SKIP` at the top of `scraper.js`. The website reads them from `menus/index.json`.
- **Colors:** the variables at the top of `docs/style.css`.
- **Schedule:** the `cron` lines in `.github/workflows/update-menu.yml` (times are UTC).

If ASU or Aramark redesigns the dining pages, the selectors in `readMenu()`,
`mealButton()` and `findDiningHalls()` in `scraper.js` are the parts most likely to need updating.
