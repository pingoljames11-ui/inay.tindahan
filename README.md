# Tindahan Manager (GitHub Pages + Google Sheets)

Inventory and price system for a sari-sari store. It runs in the phone's browser and keeps
all data in a **Google Sheet**. The website itself is hosted free on **GitHub Pages**.
No computer has to stay on in the store, and it works on mobile data as well as Wi-Fi.

```
Phone browser  ──►  GitHub Pages (the app files)
      │
      └──────────►  Stein API  ──►  Your Google Sheet (all the data)
```

## What changed from the local version

| Before | Now |
|---|---|
| `server.js` on one computer, Wi-Fi only | No server. Any phone with internet, anywhere |
| Data in `data/store.json` | Data in your Google Sheet (you can read and edit it there) |
| Daily backup files | Google Sheets version history, plus **Account > Download backup** |
| Default logins `admin` / `staff` | You create the owner account the first time you open the app |

Everything you see in the app (Home, Products, Prices, Stock, Reports, staff and owner roles) works the same.

---

## Set up (about 15 minutes, one time)

### Part 1: Prepare the Google Sheet

1. Open the Google Sheet that your Stein API points to.
2. Go to **File > Import > Upload** and choose **`tindahan-database-template.xlsx`**.
3. For *Import location* choose **Insert new sheet(s)**, then **Import data**.
4. At the bottom you should now see five tabs: **Users, Products, Categories, PriceHistory, Movements**.
   Each has only its column names in row 1. You can delete the empty `Sheet1`.
5. In your Stein dashboard, make sure the API allows **reading, adding, updating and deleting**
   (the app uses all four).

Do not rename the tabs or change the column names in row 1. The app finds its data by those exact names.

### Part 2: Put the app on GitHub Pages

1. Create a free account at https://github.com and click **New repository**.
   Name it (for example `tindahan`) and choose **Public**. On a free account, GitHub Pages needs a public repository.
2. Unzip this folder. On the repository page click **Add file > Upload files** and drag in
   **everything inside the folder** (`index.html`, `config.js`, the `css` and `js` folders, the icons...).
   `index.html` must be at the top level of the repository, not inside another folder. Click **Commit changes**.
3. Go to **Settings > Pages**. Under *Build and deployment* set **Source: Deploy from a branch**,
   **Branch: main**, **Folder: / (root)**, then **Save**.
4. After a minute or two the page shows your address: `https://YOUR-NAME.github.io/tindahan/`.

### Part 3: First use

1. Open that address on your phone. The first screen is **Set up your store**.
   Create the owner account **before you share the link with anyone**.
2. On the Home screen tap **Load sample products** to try things out, or start adding your own under **Products > +**.
3. Add staff under **Account > Manage users**. Each person must change their temporary password at first sign-in.
4. Add the app to the home screen: in Chrome tap **⋮ > Add to Home screen**; on iPhone use **Share > Add to Home Screen**.

## What each role can do

- **Administrator:** everything: products, prices, stock adjustments, categories, users, all reports, backups.
- **Staff:** search products, view prices, stock in and stock out, view stock and the Products / Low stock reports. Staff do not see cost prices in the app.

---

## Read this: privacy and security

This version has no server, so **the login is a convenience, not real protection.**

- The Stein address is needed to read and write the sheet, and the app runs in the browser.
  Anyone who has the address can read every row (including cost prices and password hashes)
  and can add or change rows, without signing in.
- Because the repository is public and `config.js` contains the address, someone who finds
  your repository could find the address too. Use this for a small store's stock and prices, not for secrets.
- Keep the Google Sheet itself private (do not share it with "anyone with the link").

**Keeping the address out of GitHub (recommended if that worries you):**
open `config.js` and change `STEIN_URL` to `""`. The app then asks for the address once on each phone.
The owner can send a ready-made link from **Account > Copy link that also sets the database address**.
Send it only to your staff. This does not make the data secure, but it stops the address from sitting in a public repository.

## Good to know

- **Speed:** each save takes about 1–3 seconds (it talks to Google Sheets). The app shows "Saving…".
- **Two phones at once:** before saving a stock change the app re-reads the latest count from the sheet, so different items on different phones are safe.
  If two people change the *same* item within the same second, one change can overwrite the other. The stock history shows what happened.
- **Live updates:** an open phone checks for changes every 30 seconds (stock and prices), and re-reads history every 5 minutes or when you come back to the app after a while. Change this in `config.js`.
- **Editing in the Sheet:** you can correct a price, stock or name directly in the **Products** tab. Add new products in the app,
  because each one needs a unique `id`. Do not delete or rename the header row.
- **Growth:** `PriceHistory` and `Movements` gain a row for every change. After a year or two, move old rows to another tab so the app stays fast.
- **Limits:** the hosted Stein service and Google Sheets both have usage limits. Check your plan in the Stein dashboard.
- **Backups:** Google Sheets keeps history (**File > Version history**). Make a copy now and then (**File > Make a copy**).
  **Account > Download backup** saves products, prices, stock history and categories as a file (without passwords).

## Optional settings (`config.js`)

| Setting | What it does |
|---|---|
| `STEIN_URL` | Your Stein API address. `""` means each phone asks for it. |
| `SHEET_URL` | Your normal Google Sheets link. Adds an **Open Google Sheet** button for the owner. |
| `REFRESH_SECONDS` | How often an open phone checks for changes (default 30). |
| `SESSION_DAYS` | How long a phone stays signed in (default 30). |

After you edit a file on GitHub, wait a minute and reload. If you still see the old version, refresh the page twice.

## If something goes wrong

- **"The Google Sheet isn't ready"** shows which tabs could not be read. Check the tab names and row 1 against Part 1.
- **"No connection"**: check the phone's internet, then tap **Try again**.
- **"The database is busy"**: wait a few seconds; too many requests were sent at once.
- **Someone forgot their password:** the owner uses **Account > Manage users > Reset**.
  If the owner forgets theirs, open the Google Sheet, go to the `Users` tab, and delete the whole owner row.
  If no users are left, the app shows the **Set up your store** screen again.

## Files

```
index.html, config.js   the page and your settings
css/style.css           look and feel
js/db.js                the Google Sheets database layer (replaces server.js)
js/app.js               the screens
manifest.webmanifest, icon*.png, icon.svg, apple-touch-icon.png   home-screen icon
tindahan-database-template.xlsx   the five tabs to import into your Google Sheet
```
