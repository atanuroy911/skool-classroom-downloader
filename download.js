/**
 * Skool Downloader — NO PUPPETEER
 * 
 * Reads lesson-data.json (produced by the browser subagent),
 * downloads videos with yt-dlp, images with https.get, writes markdown.
 *
 * Usage:
 *   node download.js           ← process all lessons in lesson-data.json
 *   node download.js --test    ← process first lesson only
 */

import fs from 'fs-extra';
import path from 'path';
import https from 'https';
import http from 'http';
import { spawnSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEST_MODE  = process.argv.includes('--test');
const OUTPUT_DIR = path.join(__dirname, 'output');
const DATA_FILE  = path.join(__dirname, 'lesson-data.json');

// ── colours ──────────────────────────────────────────────────────────────────
const ok   = s => console.log(`\x1b[32m✅ ${s}\x1b[0m`);
const info = s => console.log(`\x1b[36m→  ${s}\x1b[0m`);
const warn = s => console.log(`\x1b[33m⚠️  ${s}\x1b[0m`);
const err  = s => console.log(`\x1b[31m❌ ${s}\x1b[0m`);

// ── sanitise filename ─────────────────────────────────────────────────────────
function safe(name) {
  return name
    // Remove emoji and non-ASCII characters (cause Windows filename issues)
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FEFF}]/gu, '')
    // Remove Windows-illegal chars
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80);
}

// ── find yt-dlp ───────────────────────────────────────────────────────────────
function findYtdlp() {
  for (const cmd of ['yt-dlp', 'python -m yt_dlp']) {
    try { execSync(cmd.split(' ')[0] + ' --version', { stdio: 'ignore' }); return cmd; }
    catch {}
  }
  return null;
}

// ── download video with yt-dlp ────────────────────────────────────────────────
function findFfmpeg() {
  // Check common install locations after winget install
  const locations = [
    'ffmpeg',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe'),
  ];
  for (const loc of locations) {
    try { execSync(`"${loc}" -version`, { stdio: 'ignore' }); return loc; } catch {}
  }
  return null;
}

function downloadVideo(videoUrl, outPath, referer = 'https://www.skool.com/') {
  const ytdlp = findYtdlp();
  if (!ytdlp) { warn('yt-dlp not found. pip install yt-dlp'); return false; }

  const ffmpeg = findFfmpeg();
  const [bin, ...pre] = ytdlp.split(' ');
  const args = [
    ...pre,
    videoUrl,
    '-o', outPath,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--add-header', `Referer:${referer}`,
    '--add-header', 'Origin:https://www.skool.com',
    '--quiet',
    '--progress',
  ];

  // Tell yt-dlp where ffmpeg is
  if (ffmpeg && ffmpeg !== 'ffmpeg') {
    args.push('--ffmpeg-location', path.dirname(ffmpeg));
  }

  info(`  yt-dlp → ${path.basename(outPath)}`);
  const r = spawnSync(bin, args, { stdio: 'inherit', timeout: 600_000 });

  // Clean up any leftover split fragment files (.f2376.mp4, .faudio*.mp4)
  if (r.status === 0) {
    const dir = path.dirname(outPath);
    const base = path.basename(outPath, '.mp4');
    try {
      const fragments = fs.readdirSync(dir).filter(f =>
        f.startsWith(base) && f !== path.basename(outPath) &&
        (f.includes('.f') || f.includes('faudio'))
      );
      for (const frag of fragments) {
        fs.removeSync(path.join(dir, frag));
        info(`  Cleaned fragment: ${frag}`);
      }
    } catch {}
  }

  return r.status === 0;
}

// ── download a single file (image) ────────────────────────────────────────────
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    const req   = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer':    'https://www.skool.com/',
      }
    }, res => {
      if ([301, 302].includes(res.statusCode)) {
        file.close();
        fs.removeSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.removeSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
      file.on('error',  reject);
    });
    req.on('error', e => { file.close(); fs.removeSync(dest); reject(e); });
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Encode a relative path for use inside a Markdown link/image target
// (spaces, parens, etc. otherwise break Markdown link parsing).
function encodePath(relPath) {
  return relPath.split('/')
    .map(seg => encodeURIComponent(seg).replace(/[()!'*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

function imgExt(url) {
  const e = path.extname(url.split('?')[0]).replace('.', '').toLowerCase();
  return ['jpg','jpeg','png','gif','webp','svg','avif'].includes(e) ? e : 'jpg';
}

// ── build markdown ────────────────────────────────────────────────────────────
function buildMd(lesson, images, moduleDir) {
  const lines = [];

  lines.push(`# ${lesson.title}`);
  lines.push('');
  lines.push(`> **Module:** ${lesson.moduleName}`);
  lines.push(`> **URL:** [Open in Skool](https://www.skool.com${lesson.url})`);
  if (lesson.durationSec) {
    const m = Math.floor(lesson.durationSec / 60);
    const s = Math.round(lesson.durationSec % 60);
    lines.push(`> **Duration:** ${m}:${String(s).padStart(2,'0')}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // video
  if (lesson.videoLocalFile) {
    lines.push('## 🎬 Video');
    lines.push('');
    const rel = path.relative(moduleDir, lesson.videoLocalPath).replace(/\\/g, '/');
    lines.push(`**[📥 ${lesson.videoLocalFile}](./${encodePath(rel)})**`);
    lines.push('');
  }
  if (lesson.videoUrl) {
    lines.push(`> Stream: \`${lesson.videoUrl}\``);
    lines.push('');
  }
  if (lesson.externalVideoLink) {
    lines.push('## 🔗 External Video');
    lines.push('');
    lines.push(`[▶️ Watch](${lesson.externalVideoLink})`);
    lines.push('');
  }

  // images
  if (images.length > 0) {
    lines.push('## 🖼️ Images');
    lines.push('');
    for (const img of images) {
      const rel = path.relative(moduleDir, img.localPath).replace(/\\/g, '/');
      lines.push(`![${img.alt || 'image'}](./${encodePath(rel)})`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // text
  if (lesson.textContent?.trim()) {
    lines.push('## 📝 Content');
    lines.push('');
    lines.push(lesson.textContent.trim());
    lines.push('');
  }

  return lines.join('\n');
}

// ── process one lesson ────────────────────────────────────────────────────────
async function processLesson(lesson) {
  const moduleName = safe(lesson.moduleName);
  const lessonName = safe(lesson.title);
  const moduleDir  = path.join(OUTPUT_DIR, moduleName);
  const imageDir   = path.join(moduleDir, 'images');
  const videoDir   = path.join(moduleDir, 'videos');
  const mdPath     = path.join(moduleDir, `${lessonName}.md`);

  await fs.ensureDir(moduleDir);

  if (await fs.pathExists(mdPath)) {
    info(`SKIP (exists): ${lesson.title}`);
    return;
  }

  console.log(`\n\x1b[1m📄 ${lesson.title}\x1b[0m`);

  // ── 1. Video ───────────────────────────────────────────────────────────────
  if (lesson.videoUrl) {
    await fs.ensureDir(videoDir);
    const videoFile = `${lessonName}.mp4`;
    const videoPath = path.join(videoDir, videoFile);

    if (!await fs.pathExists(videoPath)) {
      const success = downloadVideo(lesson.videoUrl, videoPath);
      if (success && await fs.pathExists(videoPath)) {
        ok(`Video: ${videoFile}`);
        lesson.videoLocalFile = videoFile;
        lesson.videoLocalPath = videoPath;
      } else {
        warn(`Video download failed — URL saved in markdown`);
      }
    } else {
      info(`Video already exists: ${videoFile}`);
      lesson.videoLocalFile = videoFile;
      lesson.videoLocalPath = videoPath;
    }
  }

  // ── 2. Images ──────────────────────────────────────────────────────────────
  const downloadedImages = [];
  if (lesson.images?.length > 0) {
    await fs.ensureDir(imageDir);
    for (let i = 0; i < lesson.images.length; i++) {
      const img  = lesson.images[i];
      const ext  = imgExt(img.src);
      const name = `${lessonName}-${String(i+1).padStart(2,'0')}.${ext}`;
      const dest = path.join(imageDir, name);

      if (await fs.pathExists(dest)) {
        downloadedImages.push({ ...img, localPath: dest, alt: img.alt });
        continue;
      }
      try {
        await downloadFile(img.src, dest);
        downloadedImages.push({ ...img, localPath: dest, alt: img.alt });
        ok(`  Image: ${name}`);
      } catch (e) {
        warn(`  Image failed: ${e.message.substring(0,60)}`);
      }
    }
  }

  // ── 3. Markdown ────────────────────────────────────────────────────────────
  const md = buildMd(lesson, downloadedImages, moduleDir);
  await fs.writeFile(mdPath, md, 'utf8');
  ok(`Markdown: ${lessonName}.md`);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n\x1b[1m\x1b[32m🚀 Skool Downloader\x1b[0m');
  console.log(`Mode: ${TEST_MODE ? '🧪 TEST (1 lesson)' : '📦 ALL lessons'}\n`);

  if (!await fs.pathExists(DATA_FILE)) {
    err(`lesson-data.json not found at: ${DATA_FILE}`);
    err('Run the browser subagent first to extract lesson data.');
    process.exit(1);
  }

  const data    = await fs.readJson(DATA_FILE);
  const lessons = data.lessons || [];

  ok(`Loaded ${lessons.length} lessons from lesson-data.json`);
  await fs.ensureDir(OUTPUT_DIR);

  // Write index
  const indexLines = [
    '# Ad Creators Lab — Index',
    '',
    `> Generated: ${new Date().toLocaleString()}`,
    `> Lessons: ${lessons.length}`,
    '',
    '---',
    '',
  ];
  const byModule = {};
  for (const l of lessons) {
    if (!byModule[l.moduleName]) byModule[l.moduleName] = [];
    byModule[l.moduleName].push(l);
  }
  for (const [mod, ls] of Object.entries(byModule)) {
    indexLines.push(`## ${mod}`);
    for (const l of ls) {
      const icon = l.videoUrl || l.externalVideoLink ? '🎬' : '📄';
      indexLines.push(`- ${icon} [${l.title}](./${encodePath(safe(mod))}/${encodePath(safe(l.title))}.md)`);
    }
    indexLines.push('');
  }
  await fs.writeFile(path.join(OUTPUT_DIR, 'INDEX.md'), indexLines.join('\n'), 'utf8');
  ok('INDEX.md written');

  // Process lessons
  let count = 0;
  for (const lesson of lessons) {
    await processLesson(lesson);
    count++;
    if (TEST_MODE && count >= 1) {
      console.log('\n\x1b[1m🧪 Test done — 1 lesson processed.\x1b[0m');
      console.log('Run without --test to download all.\n');
      break;
    }
  }
}

main().catch(e => { err(e.message); console.error(e); });
