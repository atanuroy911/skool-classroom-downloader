/**
 * Skool Classroom Downloader v2
 * ─────────────────────────────
 * Priority: Video download first, then images + markdown content.
 * Test mode: downloads ONE lesson, then stops.
 *
 * Usage:
 *   node downloader.js             ← test ONE lesson only
 *   node downloader.js --all       ← download everything
 *   node downloader.js --module 0  ← download specific module (0-indexed)
 */

import puppeteer from 'puppeteer';
import fs from 'fs-extra';
import path from 'path';
import https from 'https';
import http from 'http';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ────────────────────────────────────────────────────────────────
const TEST_MODE = !process.argv.includes('--all');  // default = test 1 lesson
const MODULE_IDX = (() => {
  const i = process.argv.indexOf('--module');
  return i > -1 ? parseInt(process.argv[i + 1]) : null;
})();

const OUTPUT_DIR  = path.join(__dirname, 'output');
const PROFILE_DIR = path.join(__dirname, '.chrome-profile');
const STRUCT_FILE = path.join(__dirname, 'classroom-structure.json');

// ─── LOGGING ───────────────────────────────────────────────────────────────
const C = { reset:'\x1b[0m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', bold:'\x1b[1m', dim:'\x1b[2m' };
const log = (msg, type='info') => {
  const prefix = { info:C.cyan, ok:C.green, warn:C.yellow, err:C.red }[type] || '';
  const icon   = { info:'→', ok:'✅', warn:'⚠️', err:'❌' }[type] || '·';
  console.log(`${prefix}${icon} ${msg}${C.reset}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── yt-dlp HELPER ─────────────────────────────────────────────────────────
function findYtdlp() {
  for (const cmd of ['yt-dlp', 'python -m yt_dlp', 'python3 -m yt_dlp']) {
    try { execSync(`${cmd.split(' ')[0]} --version`, { stdio:'ignore' }); return cmd; }
    catch {}
  }
  // try pip-installed location
  try {
    const r = execSync('python -m yt_dlp --version', { stdio:'pipe' });
    if (r) return 'python -m yt_dlp';
  } catch {}
  return null;
}

function downloadWithYtdlp(url, outputPath, extraArgs = []) {
  const ytdlp = findYtdlp();
  if (!ytdlp) { log('yt-dlp not found! Run: pip install yt-dlp', 'err'); return false; }

  const args = [
    ...ytdlp.split(' ').slice(1),  // e.g. ['-m', 'yt_dlp'] or []
    url,
    '-o', outputPath,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--quiet',
    '--progress',
    '--no-warnings',
    ...extraArgs,
  ];

  log(`  yt-dlp: ${ytdlp.split(' ')[0]} ${args.slice(0,3).join(' ')} ...`, 'info');
  const result = spawnSync(ytdlp.split(' ')[0], args, { stdio:'inherit', timeout: 600000 });
  return result.status === 0;
}

// ─── IMAGE DOWNLOADER ──────────────────────────────────────────────────────
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    const request = protocol.get(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.skool.com/'
      } 
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.remove(destPath).catch(() => {});
        downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.remove(destPath).catch(() => {});
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', reject);
    });
    request.on('error', (err) => { file.close(); fs.remove(destPath).catch(() => {}); reject(err); });
    request.setTimeout(30000, () => { request.destroy(); reject(new Error('Timeout')); });
  });
}

function getImageExtension(url) {
  const clean = url.split('?')[0].split('#')[0];
  const ext = path.extname(clean).toLowerCase().replace('.', '');
  const validExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'];
  return validExts.includes(ext) ? ext : 'jpg';
}

// Encode a relative path for use inside a Markdown link/image target
// (spaces, parens, etc. otherwise break Markdown link parsing).
function encodePath(relPath) {
  return relPath.split('/')
    .map(seg => encodeURIComponent(seg).replace(/[()!'*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/\s+/g, ' ').trim().substring(0, 80);
}

// ─── PAGE CONTENT EXTRACTOR ────────────────────────────────────────────────
async function extractPageContent(page) {
  return page.evaluate(() => {
    // ── title ──────────────────────────────────────────────────────────────
    const title =
      document.querySelector('h1')?.innerText?.trim() ||
      document.querySelector('h2')?.innerText?.trim() ||
      document.title;

    // ── find main content container ────────────────────────────────────────
    const candidates = [
      // Skool lesson content wrappers
      '[class*="PostTextContainer"]',
      '[class*="postText"]',
      '[class*="LessonContent"]',
      '[class*="lesson-content"]',
      '[class*="Content_content"]',
      '[class*="EditorView"]',
      '[class*="editor-view"]',
      '[class*="ql-editor"]',  // Quill editor output
      '[class*="ProseMirror"]',
      // Generic fallbacks
      'article',
      'main',
    ];

    let contentEl = null;
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.innerText?.trim().length > 30) { contentEl = el; break; }
    }

    // ── images (in content + standalone) ──────────────────────────────────
    const seenSrcs = new Set();
    const images = [];

    const collectImages = (root) => {
      root.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src') || img.dataset.src || img.dataset.lazySrc;
        if (!src || src.startsWith('data:') || seenSrcs.has(src)) return;
        // Filter out tiny icons, avatars, profile pics
        const w = img.naturalWidth || parseInt(img.getAttribute('width') || '0');
        const h = img.naturalHeight || parseInt(img.getAttribute('height') || '0');
        if ((w > 0 && w < 48) || (h > 0 && h < 48)) return;
        if (src.includes('avatar') || src.includes('profile') || src.includes('icon') ||
            src.includes('favicon') || src.includes('logo') && (w < 100)) return;
        seenSrcs.add(src);
        images.push({ src, alt: img.alt || img.title || '' });
      });
    };

    if (contentEl) collectImages(contentEl);
    // Also check the full lesson area
    const lessonArea = document.querySelector('[class*="Lesson"], [class*="lesson"], [class*="Course"], [class*="course"]');
    if (lessonArea) collectImages(lessonArea);

    // ── get text content as structured blocks ──────────────────────────────
    let textContent = '';
    let htmlContent = '';

    if (contentEl) {
      htmlContent = contentEl.innerHTML;
      // Walk the DOM to produce structured text
      const blocks = [];
      const walk = (node, depth = 0) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.trim();
          if (t) blocks.push(t);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName.toLowerCase();

        if (['script','style','nav','header','footer','noscript'].includes(tag)) return;

        if (tag === 'h1') { blocks.push(`\n# ${node.innerText.trim()}\n`); return; }
        if (tag === 'h2') { blocks.push(`\n## ${node.innerText.trim()}\n`); return; }
        if (tag === 'h3') { blocks.push(`\n### ${node.innerText.trim()}\n`); return; }
        if (tag === 'h4') { blocks.push(`\n#### ${node.innerText.trim()}\n`); return; }
        if (tag === 'p')  { const t = node.innerText.trim(); if (t) blocks.push(t + '\n'); return; }
        if (tag === 'li') { blocks.push(`- ${node.innerText.trim()}`); return; }
        if (tag === 'br') { blocks.push(''); return; }
        if (tag === 'hr') { blocks.push('\n---\n'); return; }
        if (tag === 'strong' || tag === 'b') { return; } // handled by parent
        if (tag === 'a') {
          const href = node.href;
          const txt = node.innerText.trim();
          if (href && txt && !href.startsWith('javascript')) {
            blocks.push(`[${txt}](${href})`);
          }
          return;
        }
        if (tag === 'img') return; // handled separately
        if (tag === 'iframe') {
          const src = node.src || node.getAttribute('src');
          if (src) blocks.push(`\n> 📺 [Embedded video](${src})\n`);
          return;
        }

        for (const child of node.childNodes) walk(child, depth + 1);
      };

      walk(contentEl);
      textContent = blocks.filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    // ── Wistia video detection ─────────────────────────────────────────────
    const wistiaIds = new Set();

    // From inline scripts
    document.querySelectorAll('script:not([src])').forEach(s => {
      for (const m of s.textContent.matchAll(/(?:hashedId|videoId|wistiaId)['":\s]+['"]([a-z0-9]{20,})['"]/g)) {
        wistiaIds.add(m[1]);
      }
    });

    // From data attributes
    document.querySelectorAll('[class*="wistia_async_"]').forEach(el => {
      const m = el.className.match(/wistia_async_([a-z0-9]+)/);
      if (m) wistiaIds.add(m[1]);
    });

    // From __NEXT_DATA__
    try {
      const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');
      const meta = nd?.props?.pageProps?.course?.metadata || {};
      if (meta.videoId)   wistiaIds.add(meta.videoId);
      if (meta.wistiaId)  wistiaIds.add(meta.wistiaId);
    } catch {}

    // ── iframes (YouTube, Loom, etc.) ──────────────────────────────────────
    const iframes = [];
    document.querySelectorAll('iframe[src]').forEach(f => {
      const src = f.src || f.getAttribute('src');
      if (src && src.length > 10) iframes.push(src);
    });

    // ── next data for extra metadata ───────────────────────────────────────
    let lessonMeta = {};
    try {
      const nd = JSON.parse(document.getElementById('__NEXT_DATA__')?.textContent || '{}');
      const meta = nd?.props?.pageProps?.course?.metadata || {};
      lessonMeta = {
        videoLink: meta.videoLink || null,
        videoLenMs: meta.videoLenMs || null,
        desc: meta.desc || '',
      };
    } catch {}

    return {
      title,
      textContent,
      htmlContent,
      images,
      wistiaIds: [...wistiaIds],
      iframes,
      lessonMeta,
      pageUrl: window.location.href,
    };
  });
}

// ─── WISTIA URL RESOLVER ───────────────────────────────────────────────────
async function resolveWistiaVideoUrl(page, wistiaId) {
  log(`  Resolving Wistia ID: ${wistiaId}`, 'info');

  // Try the public Wistia JSON API
  const apiData = await page.evaluate(async (id) => {
    try {
      const res = await fetch(`https://fast.wistia.com/embed/medias/${id}.json`, {
        credentials: 'include',
        headers: { 'Referer': location.origin }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }, wistiaId);

  if (apiData?.media?.assets) {
    const assets = apiData.media.assets;
    // Priority: original mp4 > high quality mp4 > HLS
    const mp4s = assets
      .filter(a => a.container === 'mp4' && a.url && !a.url.includes('thumbnail'))
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    const hls  = assets.find(a => a.container === 'm3u8' || a.type === 'hls_video');
    const orig = assets.find(a => a.type === 'original');

    const best = orig || mp4s[0] || hls;
    if (best?.url) {
      log(`  ✅ Wistia API → ${best.container || 'mp4'} ${best.width}x${best.height}`, 'ok');
      return { url: best.url, type: best.container || 'mp4', width: best.width, height: best.height };
    }
  }

  // Fallback: intercept by loading the Wistia iframe
  log(`  API failed, trying iframe intercept...`, 'warn');
  const captured = [];
  const handler = (resp) => {
    const u = resp.url();
    if (u.includes('.m3u8') || (u.includes('wistia') && u.endsWith('.mp4'))) {
      captured.push(u);
    }
  };
  page.on('response', handler);

  try {
    await page.goto(`https://fast.wistia.com/embed/iframe/${wistiaId}`, {
      waitUntil: 'networkidle2', timeout: 20000
    });
    await sleep(4000);
  } catch {}

  page.off('response', handler);

  if (captured.length > 0) {
    log(`  ✅ Intercepted: ${captured[0].substring(0, 80)}`, 'ok');
    return { url: captured[0], type: captured[0].includes('.m3u8') ? 'm3u8' : 'mp4' };
  }

  return null;
}

// ─── IMAGE DOWNLOADER FOR LESSON ───────────────────────────────────────────
async function downloadLessonImages(images, imageDir, lessonName) {
  if (!images.length) return [];

  await fs.ensureDir(imageDir);
  const downloaded = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = getImageExtension(img.src);
    const imgFile = `${sanitize(lessonName)}-${String(i + 1).padStart(2, '0')}.${ext}`;
    const imgPath = path.join(imageDir, imgFile);

    if (await fs.pathExists(imgPath)) {
      downloaded.push({ ...img, localFile: imgFile, localPath: imgPath });
      continue;
    }

    try {
      await downloadFile(img.src, imgPath);
      downloaded.push({ ...img, localFile: imgFile, localPath: imgPath });
      log(`    🖼  Image saved: ${imgFile}`, 'ok');
    } catch (e) {
      log(`    Image failed (${e.message.substring(0, 50)}): ${img.src.substring(0, 60)}`, 'warn');
    }
  }

  return downloaded;
}

// ─── MARKDOWN BUILDER ──────────────────────────────────────────────────────
function buildMarkdown(lesson, content, videoResult, downloadedImages, imageDir, moduleDir) {
  const lines = [];

  // Header
  lines.push(`# ${content.title || lesson.title}`);
  lines.push('');
  lines.push(`> **Module:** ${lesson.moduleName}`);
  lines.push(`> **Source:** [Open in Skool](https://www.skool.com${lesson.url})`);

  if (content.lessonMeta?.videoLenMs) {
    const m = Math.floor(content.lessonMeta.videoLenMs / 60000);
    const s = Math.floor((content.lessonMeta.videoLenMs % 60000) / 1000);
    lines.push(`> **Duration:** ${m}:${String(s).padStart(2,'0')}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── VIDEO ────────────────────────────────────────────────────────────────
  if (videoResult) {
    lines.push('## 🎬 Video');
    lines.push('');

    if (videoResult.localFile) {
      const relPath = path.relative(moduleDir, videoResult.localPath).replace(/\\/g, '/');
      lines.push(`**Local file:** [${videoResult.localFile}](./${encodePath(relPath)})`);
      lines.push('');
    }

    if (videoResult.streamUrl) {
      lines.push(`**Stream URL:**`);
      lines.push('```');
      lines.push(videoResult.streamUrl);
      lines.push('```');
      lines.push('');
    }

    if (videoResult.wistiaId) {
      lines.push(`**Wistia embed:** https://fast.wistia.com/embed/iframe/${videoResult.wistiaId}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // External video link (Loom, YouTube, etc.)
  if (content.lessonMeta?.videoLink) {
    lines.push('## 🔗 External Video');
    lines.push('');
    lines.push(`[Watch Video](${content.lessonMeta.videoLink})`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Embedded iframes
  if (content.iframes.length > 0) {
    lines.push('## 📺 Embedded');
    lines.push('');
    for (const src of content.iframes) {
      lines.push(`- [${src.includes('youtube') ? 'YouTube' : src.includes('loom') ? 'Loom' : 'Embedded'}](${src})`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ── IMAGES ───────────────────────────────────────────────────────────────
  if (downloadedImages.length > 0) {
    lines.push('## 🖼️ Images');
    lines.push('');
    for (const img of downloadedImages) {
      const relPath = path.relative(moduleDir, img.localPath).replace(/\\/g, '/');
      const alt = img.alt || 'image';
      lines.push(`![${alt}](./${encodePath(relPath)})`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ── TEXT CONTENT ─────────────────────────────────────────────────────────
  if (content.textContent?.trim()) {
    lines.push('## 📝 Lesson Content');
    lines.push('');
    lines.push(content.textContent.trim());
    lines.push('');
  }

  return lines.join('\n');
}

// ─── LESSON PROCESSOR ──────────────────────────────────────────────────────
async function processLesson(browser, lesson, moduleDir, cookies) {
  const lessonName = sanitize(lesson.title);
  const mdPath     = path.join(moduleDir, `${lessonName}.md`);
  const imageDir   = path.join(moduleDir, 'images');
  const videoDir   = path.join(moduleDir, 'videos');

  if (await fs.pathExists(mdPath)) {
    log(`SKIP (already done): ${lesson.title}`, 'info');
    return { skipped: true };
  }

  log(`\n${C.bold}Processing: ${lesson.title}${C.reset}`, 'info');

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  // Inject cookies
  if (cookies.length) await page.setCookie(...cookies);

  // ── Network interception (for HLS/mp4 capture) ───────────────────────────
  const capturedMedia = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    const ct  = resp.headers()['content-type'] || '';
    if (
      url.includes('.m3u8') ||
      ct.includes('mpegurl') ||
      ct.includes('application/vnd.apple') ||
      (url.includes('wistia') && url.includes('.mp4'))
    ) {
      capturedMedia.push({ url, headers: resp.request().headers() });
      log(`  📡 Captured media: ${url.substring(0, 90)}`, 'ok');
    }
  });

  let videoResult = null;

  try {
    // Navigate to lesson
    const fullUrl = `https://www.skool.com${lesson.url}`;
    log(`  → ${fullUrl}`, 'info');
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(e => log(`  Page load warning (continuing): ${e.message}`, 'warn'));
    await sleep(6000); // let Next.js hydrate + Wistia embed load

    // Try to trigger video play (so HLS manifest loads)
    await page.evaluate(() => {
      // Click Wistia play button
      const btns = [
        '.w-big-play-button', '[aria-label*="play" i]',
        'button[class*="play" i]', 'video',
      ];
      for (const sel of btns) {
        const el = document.querySelector(sel);
        if (el) { try { el.click(); } catch {} break; }
      }
    }).catch(() => {});

    await sleep(3000);

    // Extract page content
    const content = await extractPageContent(page);
    content.moduleName = lesson.moduleName;

    // ── STEP 1: Try to get video URL ──────────────────────────────────────
    log(`  Looking for video...`, 'info');

    // A) Wistia ID from structure (most reliable)
    let wistiaId = lesson.wistiaId;

    // B) Wistia ID found on page
    if (!wistiaId && content.wistiaIds.length > 0) {
      wistiaId = content.wistiaIds[0];
    }

    if (wistiaId) {
      log(`  Wistia ID: ${wistiaId}`, 'info');

      // Try Wistia API to get direct mp4 URL
      const resolved = await resolveWistiaVideoUrl(page, wistiaId);

      if (resolved) {
        await fs.ensureDir(videoDir);
        const videoExt  = resolved.type === 'm3u8' ? 'mp4' : (resolved.type || 'mp4');
        const videoFile = `${lessonName}.mp4`;
        const videoPath = path.join(videoDir, videoFile);

        if (!await fs.pathExists(videoPath)) {
          log(`  ⬇️  Downloading video → ${videoFile}`, 'info');

          // Build yt-dlp args
          const ytArgs = ['--add-header', 'Referer:https://www.skool.com/'];

          // Add Wistia-specific cookie if available
          const wistiaToken = cookies.find(c => c.domain?.includes('wistia') || c.name === '_wt');
          if (wistiaToken) {
            ytArgs.push('--add-header', `Cookie:${wistiaToken.name}=${wistiaToken.value}`);
          }

          // For m3u8 force mp4 output
          if (resolved.type === 'm3u8') {
            ytArgs.push('--hls-prefer-native');
          }

          const ok = downloadWithYtdlp(resolved.url, videoPath, ytArgs);

          if (ok && await fs.pathExists(videoPath)) {
            log(`  ✅ Video downloaded: ${videoFile}`, 'ok');
            videoResult = { localFile: videoFile, localPath: videoPath, streamUrl: resolved.url, wistiaId };
          } else {
            log(`  yt-dlp failed, saving URL only`, 'warn');
            videoResult = { streamUrl: resolved.url, wistiaId };
          }
        } else {
          log(`  Video already exists: ${videoFile}`, 'info');
          videoResult = { localFile: videoFile, localPath: videoPath, streamUrl: resolved.url, wistiaId };
        }
      } else {
        // Could not resolve URL — save wistia ID for reference
        videoResult = { wistiaId, note: 'Could not resolve video URL' };
        log(`  Could not resolve Wistia URL — saved ID for reference`, 'warn');
      }
    } else if (capturedMedia.length > 0) {
      // C) Use network-intercepted URL
      const captured = capturedMedia[capturedMedia.length - 1];
      log(`  Using intercepted URL: ${captured.url.substring(0, 80)}`, 'ok');
      await fs.ensureDir(videoDir);
      const videoFile = `${lessonName}.mp4`;
      const videoPath = path.join(videoDir, videoFile);

      if (!await fs.pathExists(videoPath)) {
        const ok = downloadWithYtdlp(captured.url, videoPath, [
          '--add-header', 'Referer:https://www.skool.com/'
        ]);
        if (ok) videoResult = { localFile: videoFile, localPath: videoPath, streamUrl: captured.url };
        else     videoResult = { streamUrl: captured.url };
      }
    } else if (lesson.videoLink) {
      // D) External link (Loom, YouTube, etc.)
      log(`  External video: ${lesson.videoLink}`, 'info');
      videoResult = { externalUrl: lesson.videoLink };
    } else {
      log(`  No video found`, 'warn');
    }

    // ── STEP 2: Download images ───────────────────────────────────────────
    let downloadedImages = [];
    if (content.images.length > 0) {
      log(`  📥 Downloading ${content.images.length} image(s)...`, 'info');
      downloadedImages = await downloadLessonImages(content.images, imageDir, lessonName);
    }

    // ── STEP 3: Build and save Markdown ──────────────────────────────────
    const markdown = buildMarkdown(lesson, content, videoResult, downloadedImages, imageDir, moduleDir);
    await fs.writeFile(mdPath, markdown, 'utf8');
    log(`  ✅ Saved: ${lessonName}.md`, 'ok');

    return { success: true, videoResult, imagesCount: downloadedImages.length };

  } catch (err) {
    log(`  ❌ Error: ${err.message}`, 'err');
    // Save error stub
    await fs.writeFile(mdPath, `# ${lesson.title}\n\n> **Error:** ${err.message}\n\n**URL:** https://www.skool.com${lesson.url}\n`, 'utf8');
    return { success: false, error: err.message };
  } finally {
    await page.close();
  }
}

// ─── INDEX GENERATOR ───────────────────────────────────────────────────────
async function generateIndex(modules) {
  const totalLessons = modules.reduce((s, m) => s + m.lessons.length, 0);
  const lines = [
    '# 📚 Ad Creators Lab — Classroom Index',
    '',
    `> Downloaded: ${new Date().toLocaleString()}`,
    `> Modules: **${modules.length}** | Lessons: **${totalLessons}**`,
    '',
    '---',
    '',
  ];

  for (let mi = 0; mi < modules.length; mi++) {
    const m = modules[mi];
    const mSlug = sanitize(m.title);
    lines.push(`## ${mi + 1}. ${m.title}`);
    if (m.description) lines.push(`> ${m.description}`);
    lines.push('');
    for (let li = 0; li < m.lessons.length; li++) {
      const l = m.lessons[li];
      const lSlug = sanitize(l.title);
      const icon = l.hasVideo ? '🎬' : '📄';
      lines.push(`  ${li + 1}. ${icon} [${l.title}](./${encodePath(mSlug)}/${encodePath(lSlug)}.md)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── MAIN ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.green}🚀 Skool Classroom Downloader${C.reset}`);
  console.log(`${C.dim}Mode: ${TEST_MODE ? '🧪 TEST (1 lesson)' : '📦 FULL download'}${C.reset}\n`);

  // Load structure
  if (!await fs.pathExists(STRUCT_FILE)) {
    log('classroom-structure.json not found! Run the extraction script first.', 'err');
    process.exit(1);
  }
  const structure = await fs.readJson(STRUCT_FILE);
  const modules   = structure.modules;

  await fs.ensureDir(OUTPUT_DIR);

  // Launch puppeteer (headless: false so extension intercepts work + no login needed with profile)
  log('Launching Chrome...', 'info');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--user-data-dir=${PROFILE_DIR}`,
      '--window-size=1400,900',
      '--no-first-run',
      '--disable-default-apps',
    ],
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const pages = await browser.pages();
  const mainPage = pages[0] || await browser.newPage();

  // Navigate to classroom to establish session
  log('Loading classroom...', 'info');
  // Use domcontentloaded — Skool is a heavy SPA and networkidle2 often times out
  await mainPage.goto('https://www.skool.com/adcreatorslab/classroom', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  }).catch(e => log(`Navigation warning (continuing): ${e.message}`, 'warn'));

  // Wait extra for JS to hydrate (Next.js)
  await sleep(6000);

  // Check login
  const isLoggedIn = await mainPage.evaluate(() =>
    !!(document.querySelector('[class*="Avatar"]') ||
       document.querySelector('img[alt*="avatar" i]') ||
       window.__NEXT_DATA__?.props?.pageProps?.allCourses?.length ||
       document.cookie.includes('skool'))
  ).catch(() => false);

  if (!isLoggedIn) {
    log('⚠️  Not logged in. Please log in to Skool in the browser window, then press ENTER here...', 'warn');
    await new Promise(r => process.stdin.once('data', r));
    // Wait for redirect after login
    await sleep(3000);
  }

  const cookies = await mainPage.cookies();
  log(`Session active. ${cookies.length} cookies loaded.`, 'ok');

  // Generate index
  const indexMd = await generateIndex(modules);
  await fs.writeFile(path.join(OUTPUT_DIR, 'INDEX.md'), indexMd, 'utf8');
  log('INDEX.md created', 'ok');

  // Process lessons
  let processed = 0, errors = 0;

  const targetModules = MODULE_IDX !== null ? [modules[MODULE_IDX]] : modules;

  outer:
  for (const module of targetModules) {
    if (!module) continue;
    const moduleDir = path.join(OUTPUT_DIR, sanitize(module.title));
    await fs.ensureDir(moduleDir);

    // Module README
    await fs.writeFile(
      path.join(moduleDir, 'README.md'),
      `# ${module.title}\n\n${module.description || ''}\n\n## Lessons\n\n` +
      module.lessons.map((l, i) => `${i+1}. ${l.hasVideo ? '🎬' : '📄'} ${l.title}`).join('\n') + '\n',
      'utf8'
    );

    log(`\n${C.bold}📁 MODULE: ${module.title}${C.reset} (${module.lessons.length} lessons)`, 'info');

    for (const lesson of module.lessons) {
      lesson.moduleName = module.title;

      const result = await processLesson(browser, lesson, moduleDir, cookies);

      if (!result.skipped) {
        if (result.success) processed++;
        else errors++;
      }

      await sleep(1500); // polite delay

      // TEST MODE: stop after 1 successful lesson with a video
      if (TEST_MODE && processed >= 1) {
        log(`\n${C.bold}🧪 Test complete! 1 lesson downloaded successfully.${C.reset}`, 'ok');
        log(`Check: ${moduleDir}`, 'info');
        log(`Run with --all flag to download everything.`, 'info');
        break outer;
      }
    }
  }

  console.log(`\n${C.bold}${C.green}✨ Done!${C.reset}`);
  console.log(`  Processed: ${processed} | Errors: ${errors}`);
  console.log(`  Output: ${OUTPUT_DIR}\n`);

  await browser.close();
}

main().catch(err => { log(err.message, 'err'); console.error(err); process.exit(1); });
