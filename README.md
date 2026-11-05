# Centi Catalog (first implementation)

Mobile-first static catalog for GitHub Pages. Reads the public Google Sheet CSV export, searches SKU/name/variation, adds products to a cart, caches the catalog/cart in the browser, and submits formatted orders through a Google Apps Script endpoint to a Telegram chat.

## Current source sheet
- Spreadsheet ID: `1wTJRGfmdAARp9d_qNNQ1UUUssuNo5p9tarxPiYllGLo`
- Tab GID: `0`
- CSV export: `https://docs.google.com/spreadsheets/d/1wTJRGfmdAARp9d_qNNQ1UUUssuNo5p9tarxPiYllGLo/export?format=csv&gid=0`
- Required columns: `SKU`, `Nama Pendek`, `Images`, `Notes`, `regular price`, `Name`, `Variation`.
- Search checks SKU, Nama Pendek, Name, Variation and Notes.
- Displayed price is `regular price`.

## Publish on GitHub Pages
1. Create a GitHub repository, e.g. `centi-catalog`.
2. Upload the contents of this folder (not the parent folder).
3. In repository Settings → Pages, select Deploy from a branch, branch `main`, folder `/ (root)`.
4. Wait for GitHub Pages to publish the site.
5. Open the URL on Android Chrome → menu → Add to Home screen / Install app.

## Google Sheets access
The sheet must be shared as **Anyone with the link – Viewer** for direct CSV loading from the browser. The app does not write to the sheet. It tries the direct CSV export first and falls back to the Apps Script JSONP catalog endpoint if the browser blocks the cross-origin CSV request.

## Configure Telegram backend
1. Open `script.new` while signed into the Google account that can read the sheet.
2. Paste `apps-script/Code.gs` into the Apps Script editor.
3. In Project Settings → Script Properties, add:
   - `SPREADSHEET_ID` = `1wTJRGfmdAARp9d_qNNQ1UUUssuNo5p9tarxPiYllGLo`
   - `SHEET_GID` = `0`
   - `TELEGRAM_BOT_TOKEN` = token from BotFather
   - `TELEGRAM_CHAT_ID` = destination chat ID (your private chat/group)
   - `ORDER_PIN` = a long, unique PIN/passphrase used by the website when submitting an order
4. Deploy → New deployment → type **Web app**.
5. Execute as **Me**. Set access to **Anyone** (required for the static website to call it).
6. Authorize the script and copy the Web app URL ending in `/exec`.
7. Open the catalog website → gear icon → paste the Web app URL and order PIN → Save.
8. Send a small test order and confirm it arrives in the intended Telegram chat.

## Telegram bot setup
1. In Telegram, open `@BotFather`, create a bot, and copy its token.
2. Start a private chat with the bot (press Start), or add it to the intended group.
3. Obtain the destination chat ID using a trusted Telegram bot/API method, then put it in `TELEGRAM_CHAT_ID`.
4. Never put the bot token in this repository or in the website settings.

## Important limitations / security
- This first build reads the public CSV export directly. If the sheet is not actually public, Google will return an access/HTML page instead of CSV.
- The product image URLs in the supplied CSV point to an external image host, not Google Drive. The app keeps those URLs as requested; images therefore load from that host. The app does not upload or copy images.
- Because the GitHub Pages site is public, its JavaScript is public. The order PIN is entered by the user and stored in that browser local storage; it can still be observed by someone with access to that device/browser. JSONP sends the PIN and order in a GET URL, so URLs may be visible in browser/network logs. Use a long random PIN, do not share the endpoint URL, and rotate the PIN if exposed.
- Apps Script web apps set to Anyone are callable by other people who discover the URL. The PIN is a basic gate, not strong user authentication; use a long random passphrase, do not publish the endpoint URL, and rotate the PIN if exposed. For stronger abuse protection, put a proper authenticated backend in front of Telegram.
- Telegram message delivery is capped to one message (the current template must fit Telegram's message limit). The script rejects messages above 3,500 characters. The frontend currently limits bot submissions to 1,500 characters to keep the GET request manageable; longer orders can still be copied manually.
- Catalog data is cached locally for offline viewing after a successful load. A fresh catalog refresh needs internet. External product images may not be available offline unless the browser has cached them.
- This build does not yet connect to Jubelio automatically. It sends the WebStore-style notification to Telegram for manual copy/paste.

## Local testing
You can open `index.html` for a visual check, but browsers may restrict service workers on `file://`. For full testing, serve the folder over localhost or publish to GitHub Pages.
