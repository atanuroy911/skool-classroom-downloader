# Skool Classroom Downloader

Scrapes a [Skool](https://www.skool.com) community's classroom (modules + lessons) that you
have access to, and saves each lesson locally as:

- a Markdown file (title, description, links, extracted text)
- the lesson's video (downloaded via `yt-dlp`)
- the lesson's images

Two independent workflows are included — pick **one**.

## Workflow A — Browser console + Node (recommended, no browser automation)

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Install `yt-dlp`** (used to download lesson videos)

   ```bash
   pip install yt-dlp
   ```
   Also make sure [`ffmpeg`](https://ffmpeg.org/) is installed and on your `PATH`.

3. **Start the local save server** (receives the scraped data from your browser)

   ```bash
   node server.cjs
   ```
   Leave this running in its own terminal — it listens on `http://localhost:9876`.

4. **Log in to Skool** in your normal browser and open the classroom page of the
   community you want to download, e.g. `https://www.skool.com/<your-community>/classroom`.

5. **Run the extractor in the browser console**
   - Open DevTools (`F12`) → Console tab, on the classroom page.
   - Paste the contents of [`extract-lessons.js`](extract-lessons.js) and press Enter.
   - It walks every module/lesson via `fetch`, collects video/image URLs and text,
     and triggers a download of `lesson-data-<community>.json`.
   - Rename/move the downloaded file to `lesson-data.json` in this project folder
     (or `POST` it to `http://localhost:9876` if you adapt the script to `fetch` instead
     of triggering a file download — `server.cjs` will save it as `lesson-data.json`).

6. **Download everything**

   ```bash
   node download.js            # downloads all lessons
   node download.js --test     # downloads only the first lesson, to sanity-check output
   ```

   Output is written to `output/`, one folder per module, containing per-lesson
   `.md` files plus `images/` and `videos/` subfolders, and a top-level `INDEX.md`.

## Workflow B — Puppeteer (automates the browser for you)

Use this if you'd rather not paste scripts into the console for every lesson —
it drives a real Chrome window with Puppeteer and downloads videos as it goes
(including resolving Wistia-hosted videos automatically).

1. Install dependencies and `yt-dlp`/`ffmpeg` as in steps 1–2 above.

2. **Extract the classroom structure** (modules + lesson list, not the full lesson content):
   - On the classroom page, open DevTools console and paste
     [`extract-structure.js`](extract-structure.js).
   - It copies the resulting JSON to your clipboard — save it as
     `classroom-structure.json` in this project folder.

3. **Run the downloader**

   ```bash
   node downloader.js           # test mode: downloads 1 lesson, then stops
   node downloader.js --all     # downloads every module/lesson
   node downloader.js --module 0   # download only module index 0
   ```

   A Chrome window opens using a local profile (`.chrome-profile/`, created
   automatically). Log in to Skool in that window the first time you're prompted,
   then press Enter in the terminal to continue.

   Output is written to `output/`, same layout as Workflow A.

## Project files

| File | Purpose |
|---|---|
| `extract-lessons.js` | Browser-console script for Workflow A — extracts full lesson data (video URL, images, text) for every lesson. |
| `extract-structure.js` | Browser-console script for Workflow B — extracts just the module/lesson list and URLs. |
| `server.cjs` | Tiny local HTTP server that saves posted JSON as `lesson-data.json`, for Workflow A. |
| `download.js` | Workflow A downloader — reads `lesson-data.json`, downloads videos/images, writes Markdown. |
| `downloader.js` | Workflow B downloader — drives Puppeteer to visit each lesson, resolve Wistia videos, and write Markdown. |

## Notes

- Both workflows skip lessons that already have a Markdown file in `output/`, so
  you can re-run them to resume an interrupted download.
- Video downloads rely on `yt-dlp`; if it's missing, the Markdown file will still
  be written with the raw video URL so you can download it manually later.
- Only download content from communities you're a paid/authorized member of, for
  personal backup — check Skool's and the creator's terms before redistributing
  any downloaded material.
# skool-classroom-downloader
