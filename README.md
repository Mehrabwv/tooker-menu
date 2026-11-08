# Tooker Menu

A phone-friendly web app showing the **Tooker House Dining Hall** (ASU Tempe) menu
for every meal: Breakfast, Brunch, Lunch, Light Lunch, Afternoon Snack, Dinner and so on.
By default it shows these stations:

- **Home Zone**
- **Pizza**, leaving out Classic Cheese and Pepperoni because they're always available
- **True Balance**

You can turn other stations on or off from the ⚙ button in the app. That choice is
saved on your phone.

**Live site:** https://mehrabwv.github.io/tooker-menu/

> Unofficial student project. Menu data comes from
> [asu.mydininghub.com](https://asu.mydininghub.com/en/tempe-campus/location/tooker-house-dining-hall).

## Put it on your phone like an app

- **iPhone (Safari):** open the live site → **Share** button → **Add to Home Screen** → Add.
- **Android (Chrome):** open the live site → **⋮** menu → **Add to Home screen** / **Install app**.

It opens full-screen with its own icon, starts on whatever meal is being served
right now, and still opens with the last menu it saw when you have no signal.

## One-time GitHub setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**
2. **Actions** tab → **Update menu and website** → **Run workflow**

After that it runs on its own twice a day (about 5:23 AM and 2:23 PM Arizona time).
Each run scrapes the next 7 days, commits `docs/menu.json` and republishes the site.
This is all free on a public repo.

## How it works

```
asu.mydininghub.com ──(GitHub Action runs scraper.js in headless Chrome)──▶ docs/menu.json
                                                                             │
                     docs/index.html + app.js (GitHub Pages) ◀── loads ──────┘
```

1. `sundevilhospitality.asu.edu` links Tooker House Dining Hall to ASU's dining
   platform at `asu.mydininghub.com`. That page fills in the menu with JavaScript,
   so downloading the raw HTML (for example with Python `requests`) gives you no food items.
2. `scraper.js` drives a real (invisible) Chrome browser with
   [Playwright](https://playwright.dev). For each day it picks every option in the
   **Meal:** dropdown, waits for the menu to load, and reads every station and dish.
3. `docs/` is the website: plain HTML, CSS and JavaScript with no build step.
   `manifest.webmanifest`, `sw.js` and `icons/` turn it into an installable app
   (a "PWA", progressive web app).

| File | What it is |
| --- | --- |
| `scraper.js` | The scraper (Node.js + Playwright) |
| `.github/workflows/update-menu.yml` | The schedule that runs the scraper and publishes the site |
| `docs/index.html`, `style.css`, `app.js` | The website |
| `docs/menu.json` | The scraped menu the website loads |
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

| Option | What it does |
| --- | --- |
| `--days N` | Today plus the next N-1 days |
| `--date YYYY-MM-DD` | Start on a specific day (the site posts menus about 6 weeks ahead) |
| `--all-stations` | Skip the station filter and show everything |
| `--out DIR` | Folder for the `.md` and `.json` results (default `output/`) |
| `--json FILE` | Write a single JSON file instead (this is what the website uses) |
| `--headed` | Show the browser window so you can watch it work |

To preview the website locally, run `npx serve docs` (or `python3 -m http.server -d docs`)
and open the address it prints.

## Customizing

- **Default stations / always-available items:** `STATIONS_TO_KEEP` and
  `ITEMS_TO_SKIP` at the top of `scraper.js`. The website reads them from `menu.json`.
- **Colors:** the variables at the top of `docs/style.css`.
- **Schedule:** the `cron` lines in `.github/workflows/update-menu.yml` (times are UTC).

If ASU or Aramark redesigns the dining page, the selectors in `readMenu()` and
`mealButton()` in `scraper.js` are the parts most likely to need updating.
