// Regenerate the README's panel screenshots from the real stylesheet.
//
// NOT decoration, and not hand-made images: these render `src/popup/ftnss.css` itself, so a design
// change that never reaches the README is impossible to ship silently — rerun this and the pictures
// move with the code. Hand-captured screenshots are how a README ends up showing a version of the
// product that no longer exists.
//
//   node tools/screenshot-panels.mjs
//
// Requires Google Chrome installed. Not part of `npm test`: it needs a browser and writes binaries,
// and a unit suite that does either is a suite that fails for reasons unrelated to your change.
//
// TWO THEMES, because GitHub serves the README in both and the stylesheet themes via
// `prefers-color-scheme`. Headless Chrome has no OS preference to consult, so the media query is
// resolved HERE — the dark variant promotes those tokens onto `:root` — rather than trusting a flag
// to land. A screenshot that silently rendered one theme for both is the failure this avoids.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(ROOT, 'docs/assets/readme');

const css = readFileSync(join(ROOT, 'src/popup/ftnss.css'), 'utf8')
  .replaceAll('url("fonts/', `url("file://${ROOT}/src/popup/fonts/`);
const darkBlock = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}\s*\}/);
if (darkBlock == null) throw new Error('the dark-theme block moved; this script must be updated');
const light = css.replace(darkBlock[0], '');
const themes = { light, dark: `${light}\n:root {${darkBlock[1]}}\n` };

const LOGO = `file://${ROOT}/src/icons/icon-48.png`;

const header = (title = 'Nearby gyms') =>
  `<div class="panel-header"><div class="brand"><img src="${LOGO}" alt="">` +
  `<div class="wordmark">${title}</div></div><div class="header-actions">` +
  `<button class="ghost">\u{1F1E8}\u{1F1E6} en-CA</button><button class="ghost">Settings</button></div></div>`;

// The four gyms the live endpoint returns for a downtown Toronto listing, with the fields it
// actually sends. `passes` and `hours` are absent because the endpoint does not serve them yet, so
// the filters render disabled — the README should show what ships, not what we intend to ship.
const GYMS = [
  ['Hone Fitness \u2014 Queen &amp; Spadina', '~1.2 km'],
  ['Hone Fitness \u2014 Isabella', '~2.8 km'],
  ['Hone Fitness \u2014 Bloor &amp; Christie', '~3.4 km'],
  ['Hone Fitness \u2014 Queen &amp; Carlaw', '~4.3 km'],
];
const KINDS = ['Day', '3 day', 'Week', 'Month', '90 day', 'Year'];
const LANGS = [
  ['\u{1F1FA}\u{1F1F8}', 'English (US)'], ['\u{1F1EC}\u{1F1E7}', 'English (UK)'],
  ['\u{1F1E8}\u{1F1E6}', 'English (Canada)'], ['\u{1F1EB}\u{1F1F7}', 'Fran\u00e7ais'],
  ['\u{1F1E9}\u{1F1EA}', 'Deutsch'], ['\u{1F1EA}\u{1F1F8}', 'Espa\u00f1ol'],
  ['\u{1F1EF}\u{1F1F5}', '\u65e5\u672c\u8a9e'], ['\u{1F1E7}\u{1F1F7}', 'Portugu\u00eas'],
];

const MARKUP = {
  results:
    header() +
    `<div class="filters primary"><button class="chip" disabled>Open now</button>` +
    `<div class="label count">${GYMS.length} of ${GYMS.length}</div></div>` +
    `<div class="filters">${KINDS.map((k) => `<button class="chip" disabled>${k}</button>`).join('')}</div>` +
    `<div class="panel-body">${GYMS.map(([name, distance], i) =>
      `<a class="gym-row" href="#"><div class="rank">${i + 1}</div><div>` +
      `<div class="gym-top"><div class="gym-name">${name}</div>` +
      `<div class="distance">${distance}</div></div>` +
      `<div class="gym-meta"><div class="label">Toronto</div></div></div></a>`).join('')}` +
    `<div class="fineprint">Distances are approximate: measured from a point rounded to a 250m grid.` +
    `</div></div>`,
  idle:
    header() +
    `<div class="panel-body"><div class="label">Nothing has been sent yet.</div>` +
    `<button class="primary block">Find gyms near this stay</button>` +
    `<div class="fineprint">Looking up gyms sends one coordinate rounded to a 250m grid. ` +
    `Nothing about the page you are on.</div></div>`,
  languages:
    header('Language') +
    `<div class="panel-body"><div class="label">57 languages</div>` +
    LANGS.map(([flag, name]) =>
      `<button class="language-row"><span class="flag">${flag}</span>` +
      `<span class="language-name">${name}</span></button>`).join('') +
    `<div class="fineprint">Gym links open in the language you choose.</div></div>`,
};

mkdirSync(OUT, { recursive: true });
for (const [theme, sheet] of Object.entries(themes)) {
  for (const name of ['results', 'idle', 'languages']) {
    const page = join(ROOT, `docs/assets/readme/_${name}.html`);
    writeFileSync(page, panel(name, sheet));
    execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
      '--window-size=360,760', `--screenshot=${join(OUT, `panel-${name}-${theme}.png`)}`,
      `file://${page}`,
    ], { stdio: 'ignore' });
    rmSync(page);
    const shot = join(OUT, `panel-${name}-${theme}.png`);
    const { width, height, trimmed } = trimBottom(shot);
    console.log(`  panel-${name}-${theme}.png  ${width}x${height}  (trimmed ${trimmed}px)`);
  }
}
console.log(`rendered 6 screenshots into ${OUT}`);

function panel(name, sheet) {
  return `<!doctype html><meta charset="utf-8"><style>${sheet}
html,body{background:var(--paper);margin:0;}body{width:360px;}</style>${MARKUP[name]}`;
}

/*
 * A PNG bottom-trim, written against `node:zlib` rather than pulling in a library.
 *
 * Chrome captures the whole window, so every shot arrives padded with dead ground below the panel.
 * At a fixed render width in the README that padding becomes a tall empty gap under each image.
 *
 * This is 60 lines of PNG rather than a dependency because the repository's central claim is that
 * you can read all of it — adding an image library to a zero-dependency project so a README looks
 * tidier is a bad trade, and `zlib` is already in the standard library.
 *
 * Handles 8-bit non-interlaced RGB and RGBA. Chrome writes RGB (colour type 2) for an opaque page,
 * NOT RGBA — an early version assumed 4 bytes per pixel and threw on the first file, which is the
 * behaviour worth keeping: anything unexpected throws rather than guessing, because a silent misread
 * here produces a corrupted image that still opens in a viewer.
 */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Undo the per-scanline filter, which is the only genuinely fiddly part of the format. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (type !== 0) throw new Error(`unknown PNG filter ${type}`);
      out[y * stride + x] = v & 0xff;
    }
  }
  return out;
}

export function trimBottom(file, { pad = 18 } = {}) {
  const png = readFileSync(file);
  let pos = 8; const idat = []; let width; let height; let colourType;
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0 || (data[9] !== 2 && data[9] !== 6)) {
        throw new Error(
          `expected 8-bit non-interlaced RGB or RGBA; got depth ${data[8]}, ` +
          `colour type ${data[9]}, interlace ${data[12]}`,
        );
      }
      colourType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colourType === 6 ? 4 : 3;   // RGBA vs RGB
  const stride = width * bpp;
  const pixels = unfilter(inflateSync(Buffer.concat(idat)), width, height, bpp);

  // The background is whatever the bottom-right corner is; scan up for the last row unlike it.
  const bg = pixels.subarray((height - 1) * stride, (height - 1) * stride + bpp);
  let last = height - 1;
  while (last > 0) {
    let uniform = true;
    for (let x = 0; x < width && uniform; x++) {
      for (let k = 0; k < bpp; k++) {
        if (pixels[last * stride + x * bpp + k] !== bg[k]) { uniform = false; break; }
      }
    }
    if (!uniform) break;
    last--;
  }
  const kept = Math.min(height, last + 1 + pad);
  if (kept === height) return { width, height, trimmed: 0 };

  const raw = Buffer.alloc((stride + 1) * kept);
  for (let y = 0; y < kept; y++) {
    raw[y * (stride + 1)] = 0;                                    // filter 0: store verbatim
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(kept, 4);
  ihdr[8] = 8; ihdr[9] = colourType;      // re-encode in the colour type we read
  writeFileSync(file, Buffer.concat([
    png.subarray(0, 8), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
  return { width, height: kept, trimmed: height - kept };
}
