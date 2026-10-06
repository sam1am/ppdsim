(() => {
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rad = (d) => d * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

// ---------------------------------------------------------------- geometry

// Angular density at the centre of a flat panel. pitch and distance share a unit.
const ppdFor = (pitch, distance) => 1 / deg(2 * Math.atan(pitch / (2 * distance)));
const pitchFor = (ppd, distance) => 2 * distance * Math.tan(rad(1 / ppd) / 2);
const distanceFor = (ppd, pitch) => pitch / (2 * Math.tan(rad(1 / ppd) / 2));

// name, diagonal (in), width, height
const PRESETS = [
  ['24″ 1080p', 24, 1920, 1080],
  ['27″ 1440p', 27, 2560, 1440],
  ['27″ 4K', 27, 3840, 2160],
  ['27″ 5K', 27, 5120, 2880],
  ['32″ 4K', 31.5, 3840, 2160],
  ['32″ 6K', 32, 6016, 3384],
  ['34″ ultrawide 1440p', 34, 3440, 1440],
  ['MacBook Air 13″', 13.6, 2560, 1664],
  ['MacBook Air 15″', 15.3, 2880, 1864],
  ['MacBook Pro 14″', 14.2, 3024, 1964],
  ['MacBook Pro 16″', 16.2, 3456, 2234],
  ['15.6″ laptop 1080p', 15.6, 1920, 1080],
];

// Reference points offered as one-tap targets. Monitors are evaluated at the user's distance.
const REFERENCES = [
  { label: 'Quest 2', ppd: 20 },
  { label: 'Quest 3', ppd: 25 },
  { label: 'Vision Pro', ppd: 34 },
  { label: '24″ 1080p', monitor: [24, 1920, 1080] },
  { label: '27″ 1440p', monitor: [27, 2560, 1440] },
  { label: '20/20 acuity', ppd: 60 },
  { label: '27″ 4K', monitor: [27, 3840, 2160] },
];

// ---------------------------------------------------------------- state

const STORE_KEY = 'ppdsim:v1';
const state = defaults();
try {
  // Only take stored values that have the type we expect.
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(STORE_KEY) || '{}'))) {
    if (k in state && typeof v === (k === 'target' ? 'number' : typeof state[k]) && (typeof v !== 'number' || v > 0)) state[k] = v;
  }
} catch { /* storage unavailable: run with defaults */ }

function defaults() {
  const dpr = window.devicePixelRatio || 1;
  const rw = Math.round(screen.width * dpr), rh = Math.round(screen.height * dpr);
  const phone = Math.max(screen.width, screen.height) < 1000;
  const hit = PRESETS.find((p) => p[2] === Math.max(rw, rh) && p[3] === Math.min(rw, rh));
  return {
    diag: hit ? hit[1] : phone ? 6.1 : 24,
    resW: rw, resH: rh,
    dist: phone ? 30 : 60, // always cm
    unit: 'cm',
    target: null,
    view: 'split',
    split: 0.5,
    fontSize: 16, font: 'sans', codeSize: 13,
    imageSrc: window.PPD_PHOTOS ? Object.keys(window.PPD_PHOTOS)[0] : 'chart',
  };
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

// Everything the renderers need, derived from state. Rebuilt by update().
let env = null;

function derive() {
  const dpr = window.devicePixelRatio || 1;
  const pitch = state.diag * 25.4 / Math.hypot(state.resW, state.resH); // mm
  const dist = state.dist * 10; // mm
  const nativePPD = ppdFor(pitch, dist);

  // Canvas pixels per panel pixel. 1 unless the OS resamples its output (macOS scaled modes) or the
  // entered resolution doesn't match the screen this window is on.
  const rw = Math.round(screen.width * dpr), rh = Math.round(screen.height * dpr);
  let backing = Math.max(rw, rh) / Math.max(state.resW, state.resH);
  const scaled = Math.abs(backing - 1) > 0.02;
  backing = scaled ? clamp(backing, 0.25, 4) : 1;

  if (state.target == null) state.target = Math.max(5, Math.round(nativePPD / 2));
  const target = Math.min(state.target, nativePPD);
  const s = pitchFor(target, dist) / pitch; // panel pixels per simulated pixel

  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  return {
    dpr, pitch, dist, nativePPD, target, s, backing, scaled, rw, rh, dark,
    k: s * backing, // canvas pixels per simulated pixel
    cssPerDeg: nativePPD * backing / dpr,
    pal: dark ? PALETTE.dark : PALETTE.light,
  };
}

const PALETTE = {
  light: {
    paper: '#ffffff', ink: '#1b1c1f', muted: '#666a73', rule: '#dcdad3',
    codeBg: '#fbfbfa', gutter: '#a3a8b0', comment: '#6e7781', string: '#0a6640',
    keyword: '#cf222e', number: '#0550ae', func: '#8250df',
  },
  dark: {
    paper: '#17181b', ink: '#e6e6e8', muted: '#9a9ea8', rule: '#2f3238',
    codeBg: '#121316', gutter: '#5d626b', comment: '#8b949e', string: '#a5d6ff',
    keyword: '#ff7b72', number: '#79c0ff', func: '#d2a8ff',
  },
};

// ---------------------------------------------------------------- resampling

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LINEAR_TO_SRGB = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) {
  const v = i / 4095;
  LINEAR_TO_SRGB[i] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}

// Box-filter taps for one axis: destination pixel i covers source interval [i*ratio, (i+1)*ratio).
function taps(srcN, dstN, ratio) {
  const max = Math.ceil(ratio) + 1;
  const start = new Int32Array(dstN), count = new Int32Array(dstN), weight = new Float32Array(dstN * max);
  for (let i = 0; i < dstN; i++) {
    const a = Math.min(i * ratio, srcN), b = Math.min((i + 1) * ratio, srcN);
    if (b - a < 1e-6) { start[i] = srcN - 1; count[i] = 1; weight[i * max] = 1; continue; }
    const s0 = Math.floor(a), s1 = Math.min(srcN, Math.ceil(b - 1e-9));
    let n = 0;
    for (let s = s0; s < s1; s++) weight[i * max + n++] = (Math.min(b, s + 1) - Math.max(a, s)) / (b - a);
    start[i] = s0; count[i] = n;
  }
  return { start, count, weight, max };
}

// Area-coverage resample in linear light. With ratio < 1 this draws each source pixel as a hard-edged
// block (the simulated pixel); with ratio > 1 it averages, like a properly filtered downscale.
// rx, ry are source pixels per destination pixel.
function resample(src, sw, sh, dw, dh, rx, ry) {
  const tx = taps(sw, dw, rx), ty = taps(sh, dh, ry);
  const tmp = new Float32Array(dw * sh * 3);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    let o = y * dw * 3;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0;
      const n = tx.count[x], wi = x * tx.max;
      let p = row + tx.start[x] * 4;
      for (let t = 0; t < n; t++, p += 4) {
        const w = tx.weight[wi + t];
        r += w * SRGB_TO_LINEAR[src[p]];
        g += w * SRGB_TO_LINEAR[src[p + 1]];
        b += w * SRGB_TO_LINEAR[src[p + 2]];
      }
      tmp[o++] = r; tmp[o++] = g; tmp[o++] = b;
    }
  }
  const out = new ImageData(dw, dh);
  const od = out.data, acc = new Float32Array(dw * 3), rowLen = dw * 3;
  for (let y = 0; y < dh; y++) {
    acc.fill(0);
    const n = ty.count[y], wi = y * ty.max;
    for (let t = 0; t < n; t++) {
      const w = ty.weight[wi + t], base = (ty.start[y] + t) * rowLen;
      for (let i = 0; i < rowLen; i++) acc[i] += w * tmp[base + i];
    }
    let o = y * dw * 4;
    for (let i = 0; i < rowLen; i += 3) {
      od[o++] = LINEAR_TO_SRGB[(acc[i] * 4095 + 0.5) | 0];
      od[o++] = LINEAR_TO_SRGB[(acc[i + 1] * 4095 + 0.5) | 0];
      od[o++] = LINEAR_TO_SRGB[(acc[i + 2] * 4095 + 0.5) | 0];
      od[o++] = 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- scenes
//
// A scene is (widthCss, env) -> { height, key, native(ctx, dpr, devW, devH), sim(simW, simH, scale, fw, fh) }
// native() draws at the display's own resolution; sim() returns RGBA pixels rendered on the coarse grid,
// where `scale` is simulated pixels per CSS pixel and fw x fh is the (fractional) size of the scene on it.

// Scene drawn with canvas calls in CSS-pixel coordinates; rasterised directly at either resolution.
function vectorScene(height, key, paint) {
  return {
    height, key,
    native(ctx, dpr) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(ctx, dpr);
    },
    sim(simW, simH, scale) {
      const c = document.createElement('canvas');
      c.width = simW; c.height = simH;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      paint(ctx, scale);
      return ctx.getImageData(0, 0, simW, simH).data;
    },
  };
}

const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Charter, "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

const measureCtx = document.createElement('canvas').getContext('2d');

function wrap(text, font, maxWidth) {
  measureCtx.font = font;
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? line + ' ' + word : word;
    if (line && measureCtx.measureText(next).width > maxWidth) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

const STORY = {
  kicker: 'FIELD NOTES',
  title: 'The Observatory at the End of the Road',
  byline: 'Written for reading at arm’s length',
  body: [
    'The road gave out a mile below the summit, and Ines walked the rest with the lens case strapped across her back. By the time she reached the dome the valley had gone the colour of slate, and the first lights were coming on in the town, each one small and separate and exactly where it had been the night before.',
    'She had been told the old telescope could split a pair of stars that the eye alone would swear were one. It was true, though not in the way she expected. Nothing grew larger. The sky simply became more particular: a smudge resolved into a cluster, a cluster into a scatter of points, and between the points a darkness with edges.',
    'Later, writing it down by lamplight, she found the same thing happening on the page. Held close, the letters were ink and fibre; at the proper distance they were words. Somewhere between the two, she thought, was the place where detail stops being something you see and becomes something you only assume.',
  ],
  fine: 'Fine print: if you can read this line comfortably on the simulated side, the pixel density is doing its job. 0123456789 il1I O0 rn m.',
};

const layoutCache = new Map();
function cached(key, build) {
  if (!layoutCache.has(key)) {
    if (layoutCache.size > 40) layoutCache.clear();
    layoutCache.set(key, build());
  }
  return layoutCache.get(key);
}

function textScene(w, env) {
  const size = state.fontSize, family = FONTS[state.font];
  const L = cached(`text|${w}|${size}|${state.font}`, () => {
    const pad = w < 500 ? 18 : 32;
    const colW = Math.min(w - 2 * pad, size * 36);
    const x = Math.round((w - colW) / 2);
    const lines = [];
    let y = pad;
    const block = (text, px, style, color, leading, after) => {
      const font = `${style} ${px}px ${family}`;
      const lh = px * leading;
      for (const t of wrap(text, font, colW)) {
        lines.push({ text: t, font, color, x, y: y + (lh - px) / 2 + px * 0.8 });
        y += lh;
      }
      y += after;
    };
    block(STORY.kicker, size * 0.72, '600', 'muted', 1.4, size * 0.4);
    block(STORY.title, size * 1.9, '700', 'ink', 1.18, size * 0.5);
    block(STORY.byline, size * 0.88, 'italic 400', 'muted', 1.4, size * 1.1);
    for (const p of STORY.body) block(p, size, '400', 'ink', 1.55, size * 0.8);
    block(STORY.fine, size * 0.7, '400', 'muted', 1.5, 0);
    return { lines, height: Math.ceil(y + pad) };
  });
  const pal = env.pal;
  return vectorScene(L.height, `text|${size}|${state.font}|${env.dark}`, (ctx, scale) => {
    // Baselines sit on whole pixels of whichever grid is being drawn, as a real text renderer would place them.
    const snap = (v) => Math.round(v * scale) / scale;
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, w + 64, L.height + 64);
    ctx.textBaseline = 'alphabetic';
    for (const ln of L.lines) {
      ctx.font = ln.font;
      ctx.fillStyle = pal[ln.color];
      ctx.fillText(ln.text, snap(ln.x), snap(ln.y));
    }
  });
}

const CODE = `// Pixels per degree at the centre of a flat display.
export function pixelsPerDegree({ diagonal, width, height, distance }) {
  const pitch = diagonal / Math.hypot(width, height);
  const radians = 2 * Math.atan(pitch / (2 * distance));
  return 1 / (radians * 180 / Math.PI);
}

class Display {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
  }

  describe(distance = 24) {
    const ppd = pixelsPerDegree({ ...this.spec, distance });
    const verdict = ppd >= 60 ? "sharp" : "visibly pixelated";
    return \`\${this.name}: \${ppd.toFixed(1)} PPD (\${verdict})\`;
  }
}

const displays = [
  new Display("27-inch 4K", { diagonal: 27, width: 3840, height: 2160 }),
  new Display("24-inch 1080p", { diagonal: 24, width: 1920, height: 1080 }),
];

for (const display of displays) {
  if (!display.spec) continue; // nothing to measure
  console.log(display.describe());
}`;

const TOKEN = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|for|of|new|export|import|from|class|extends|while|continue|this)\b|\b(\d+(?:\.\d+)?)\b|([A-Za-z_$][\w$]*)(?=\()/g;
const TOKEN_KINDS = [null, 'comment', 'string', 'keyword', 'number', 'func'];

// [{ col, text, kind }] per line
const CODE_LINES = CODE.split('\n').map((line) => {
  const out = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    if (m.index > last) out.push({ col: last, text: line.slice(last, m.index), kind: 'ink' });
    out.push({ col: m.index, text: m[0], kind: TOKEN_KINDS[m.findIndex((g, i) => i > 0 && g !== undefined)] });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ col: last, text: line.slice(last), kind: 'ink' });
  return out;
});

function codeScene(w, env) {
  const size = state.codeSize, font = `${size}px ${FONTS.mono}`;
  const lh = Math.round(size * 1.55), pad = 16;
  measureCtx.font = font;
  const cw = measureCtx.measureText('M').width;
  const gutter = pad + cw * 3;
  const height = pad * 2 + lh * CODE_LINES.length;
  const pal = env.pal;
  return vectorScene(height, `code|${size}|${env.dark}`, (ctx, scale) => {
    const snap = (v) => Math.round(v * scale) / scale;
    ctx.fillStyle = pal.codeBg;
    ctx.fillRect(0, 0, w + 64, height + 64);
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    CODE_LINES.forEach((tokens, i) => {
      const y = snap(pad + i * lh + (lh - size) / 2 + size * 0.8);
      ctx.fillStyle = pal.gutter;
      ctx.textAlign = 'right';
      ctx.fillText(String(i + 1), snap(gutter - cw), y);
      ctx.textAlign = 'left';
      for (const t of tokens) {
        ctx.fillStyle = pal[t.kind];
        ctx.fillText(t.text, snap(gutter + cw + t.col * cw), y);
      }
    });
  });
}

function chartScene(w, env) {
  const pal = env.pal, pad = w < 500 ? 14 : 24, iw = w - 2 * pad, gap = 12, label = 22;
  const cpds = [5, 10, 15, 20, 25, 30];
  const cols = iw >= 560 ? 6 : 3;
  const bw = (iw - gap * (cols - 1)) / cols, bh = 64, rowH = bh + 26;
  const r = Math.min(90, (iw - 2 * gap) / 6);
  const sizes = [7, 8, 9, 10, 11, 12, 14, 16];

  const yGrating = pad + label;
  const yFigures = yGrating + Math.ceil(cpds.length / cols) * rowH + 8 + label;
  const yLadder = yFigures + 2 * r + 20 + label;
  const yGradient = yLadder + sizes.reduce((sum, s) => sum + Math.round(s * 1.5), 0) + 16 + label;
  const height = yGradient + 24 + 6 + 24 + pad;
  const cssPerDeg = env.cssPerDeg;

  return vectorScene(height, `chart|${env.dark}|${cssPerDeg.toFixed(3)}`, (ctx, scale) => {
    const snap = (v) => Math.round(v * scale) / scale;
    const heading = (text, y) => {
      ctx.font = `600 11px ${FONTS.sans}`;
      ctx.fillStyle = pal.muted;
      ctx.fillText(text, pad, snap(y - 8));
    };
    ctx.fillStyle = pal.paper;
    ctx.fillRect(0, 0, w + 64, height + 64);
    ctx.textBaseline = 'alphabetic';

    heading('Line gratings, in cycles per degree. A display needs at least twice that in PPD.', yGrating);
    cpds.forEach((cpd, i) => {
      const bx = pad + (i % cols) * (bw + gap), by = yGrating + Math.floor(i / cols) * rowH;
      const period = cssPerDeg / cpd;
      ctx.fillStyle = pal.ink;
      for (let x = 0; x < bw; x += period) ctx.fillRect(bx + x, by, Math.min(period / 2, bw - x), bh);
      ctx.font = `11px ${FONTS.sans}`;
      ctx.fillStyle = pal.muted;
      ctx.fillText(`${cpd} cpd · ${cpd * 2}+ PPD`, bx, snap(by + bh + 15));
    });

    heading('Radial, concentric and angled lines', yFigures);
    ctx.fillStyle = pal.ink;
    ctx.strokeStyle = pal.ink;
    const cy = yFigures + r;
    // Siemens star
    const spokes = 24, cx = pad + r;
    for (let i = 0; i < spokes; i++) {
      const a = i * 2 * Math.PI / spokes;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a, a + Math.PI / spokes);
      ctx.fill();
    }
    // Zone-plate style rings: spacing tightens towards the rim
    const rings = Math.max(6, Math.round(r / 4)), zx = pad + iw / 2;
    for (let n = 1; n < rings; n += 2) {
      const r0 = r * Math.sqrt(n / rings), r1 = r * Math.sqrt((n + 1) / rings);
      ctx.lineWidth = r1 - r0;
      ctx.beginPath();
      ctx.arc(zx, cy, (r0 + r1) / 2, 0, 2 * Math.PI);
      ctx.stroke();
    }
    // Fan of one-pixel lines
    const fx = pad + iw - 2 * r, fy = yFigures + 2 * r;
    ctx.lineWidth = 1;
    for (let a = 0; a <= 90; a += 6) {
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(fx + 2 * r * Math.cos(rad(a)), fy - 2 * r * Math.sin(rad(a)));
      ctx.stroke();
    }

    heading('Small text', yLadder);
    let y = yLadder;
    ctx.fillStyle = pal.ink;
    for (const s of sizes) {
      const lh = Math.round(s * 1.5);
      ctx.font = `${s}px ${FONTS.sans}`;
      ctx.fillText(`${s}px  Sphinx of black quartz, judge my vow. 0123456789`, pad, snap(y + lh * 0.75));
      y += lh;
    }

    heading('Gradients', yGradient);
    const grey = ctx.createLinearGradient(pad, 0, pad + iw, 0);
    grey.addColorStop(0, '#000');
    grey.addColorStop(1, '#fff');
    ctx.fillStyle = grey;
    ctx.fillRect(pad, yGradient, iw, 24);
    const hue = ctx.createLinearGradient(pad, 0, pad + iw, 0);
    for (let i = 0; i <= 12; i++) hue.addColorStop(i / 12, `hsl(${i * 30} 90% 50%)`);
    ctx.fillStyle = hue;
    ctx.fillRect(pad, yGradient + 30, iw, 24);
  });
}

// Decoded photos: key -> { data, w, h } once loaded, or 'loading'.
const photos = new Map();
const MAX_PHOTO_SIDE = 3000;
let photoVersion = 0;

function loadPhoto(key, url) {
  photos.set(key, 'loading');
  const img = new Image();
  img.onload = () => {
    // Tall images are centre-cropped to a square so the panel stays a sensible height.
    const sw = img.naturalWidth, sh = Math.min(img.naturalHeight, sw);
    const sy = (img.naturalHeight - sh) / 2;
    const f = Math.min(1, MAX_PHOTO_SIDE / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.round(sw * f); c.height = Math.round(sh * f);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, sy, sw, sh, 0, 0, c.width, c.height);
    photos.set(key, { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height, version: ++photoVersion });
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    invalidate();
  };
  img.onerror = () => { photos.delete(key); };
  img.src = url;
}

function photoScene(w) {
  const key = state.imageSrc;
  let photo = photos.get(key);
  if (!photo) {
    const builtin = window.PPD_PHOTOS && window.PPD_PHOTOS[key];
    if (builtin) loadPhoto(key, builtin.src);
    return null;
  }
  if (photo === 'loading') return null;
  const { data, w: sw, h: sh, version } = photo;
  return {
    height: Math.round(w * sh / sw),
    key: `photo|${version}`,
    native(ctx, dpr, devW, devH) {
      ctx.putImageData(resample(data, sw, sh, devW, devH, sw / devW, sh / devH), 0, 0);
    },
    sim(simW, simH, scale, fw, fh) {
      return resample(data, sw, sh, simW, simH, sw / fw, sh / fh).data;
    },
  };
}

const imageScene = (w, e) => (state.imageSrc === 'chart' ? chartScene(w, e) : photoScene(w));

// ---------------------------------------------------------------- panels

const panels = [
  ['#panel-text', textScene],
  ['#panel-code', codeScene],
  ['#panel-image', imageScene],
].map(([sel, scene]) => {
  const el = $(sel);
  return {
    scene, stage: $('.stage', el), sim: $('canvas.sim', el), nat: $('canvas.native', el),
    dirty: true, visible: false, natKey: '', width: 0,
  };
});

function renderPanel(p) {
  const w = p.stage.clientWidth;
  if (!w) return;
  p.dirty = false;
  p.width = w;
  const scene = p.scene(w, env);
  if (!scene) return; // still loading; the loader invalidates when ready
  const dpr = env.dpr;
  const devW = Math.round(w * dpr), devH = Math.max(1, Math.round(scene.height * dpr));
  p.stage.style.height = devH / dpr + 'px';
  for (const c of [p.sim, p.nat]) {
    if (c.width !== devW || c.height !== devH) { c.width = devW; c.height = devH; p.natKey = ''; }
    c.style.width = devW / dpr + 'px';
    c.style.height = devH / dpr + 'px';
  }

  const natKey = [devW, devH, scene.key].join('|');
  if (natKey !== p.natKey) {
    const ctx = p.nat.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    scene.native(ctx, dpr, devW, devH);
    p.natKey = natKey;
  }

  const ctx = p.sim.getContext('2d');
  if (env.s <= 1.0005) { ctx.drawImage(p.nat, 0, 0); return; }
  const k = env.k, fw = devW / k, fh = devH / k;
  const simW = Math.ceil(fw - 1e-6), simH = Math.ceil(fh - 1e-6);
  const pixels = scene.sim(simW, simH, dpr / k, fw, fh);
  ctx.putImageData(resample(pixels, simW, simH, devW, devH, 1 / k, 1 / k), 0, 0);
}

let frame = 0;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const p of panels) if (p.dirty && p.visible) renderPanel(p);
  });
}
function invalidate() {
  for (const p of panels) p.dirty = true;
  schedule();
}

const visibility = new IntersectionObserver((entries) => {
  for (const e of entries) panels.find((p) => p.stage === e.target).visible = e.isIntersecting;
  schedule();
}, { rootMargin: '300px' });
const resizes = new ResizeObserver(() => {
  if (panels.some((p) => p.stage.clientWidth !== p.width)) invalidate();
});
for (const p of panels) { visibility.observe(p.stage); resizes.observe(p.stage); }

// ---------------------------------------------------------------- controls

const el = {
  preset: $('#preset'), diag: $('#diag'), resW: $('#resW'), resH: $('#resH'), dist: $('#dist'), unit: $('#unit'),
  target: $('#target'), targetNum: $('#targetNum'), chips: $('#chips'), equiv: $('#equiv'),
  notice: $('#scale-notice'), fontSize: $('#fontSize'), font: $('#font'), codeSize: $('#codeSize'),
  imageSrc: $('#imageSrc'), file: $('#file'), credit: $('#credit'),
};

const fmtDist = (mm) => (state.unit === 'in' ? `${(mm / 25.4).toFixed(1)} in` : `${(mm / 10).toFixed(0)} cm`);
const distShown = () => +(state.unit === 'in' ? state.dist / 2.54 : state.dist).toFixed(1);
// Avoid fighting the user while they type in a field.
const setValue = (input, v) => { if (document.activeElement !== input) input.value = v; };

PRESETS.forEach(([name], i) => el.preset.add(new Option(name, i)));
el.imageSrc.add(new Option('Test chart', 'chart'));
for (const [key, p] of Object.entries(window.PPD_PHOTOS || {})) el.imageSrc.add(new Option(p.label, key));
if (![...el.imageSrc.options].some((o) => o.value === state.imageSrc)) state.imageSrc = el.imageSrc.options[el.imageSrc.options.length > 1 ? 1 : 0].value;

function update() {
  env = derive();
  const { nativePPD, target, s, pitch, dist } = env;

  // setup fields
  setValue(el.diag, state.diag);
  setValue(el.resW, state.resW);
  setValue(el.resH, state.resH);
  setValue(el.dist, distShown());
  el.unit.value = state.unit;
  const preset = PRESETS.findIndex((p) => p[1] === state.diag && p[2] === state.resW && p[3] === state.resH);
  el.preset.value = preset < 0 ? '' : preset;

  // stats
  $('#s-ppd').textContent = nativePPD.toFixed(1);
  $('#s-ppi').textContent = `${(25.4 / pitch).toFixed(0)} ppi`;
  $('#s-pitch').textContent = `${pitch.toFixed(3)} mm`;
  $('#s-fov').textContent = `${deg(2 * Math.atan(state.resW * pitch / (2 * dist))).toFixed(0)}°`;
  $('#s-d60').textContent = fmtDist(distanceFor(60, pitch));

  el.notice.hidden = !env.scaled;
  if (env.scaled) {
    el.notice.textContent = `Your browser is drawing ${env.rw} × ${env.rh} pixels on this screen, but the panel you entered is ` +
      `${state.resW} × ${state.resH}. That usually means the OS is scaling its output (for example a macOS “More Space” mode) ` +
      'or browser zoom isn’t 100%. The simulation compensates, but simulated pixels won’t line up exactly with real ones. ' +
      'If zoom is the cause, reset it (Ctrl/⌘ 0); and check the specs are for the screen this window is on.';
  }

  // target
  const max = Math.floor(nativePPD * 2) / 2;
  el.target.min = el.targetNum.min = Math.min(5, max);
  el.target.max = max;
  el.targetNum.max = nativePPD.toFixed(1);
  el.target.value = target;
  setValue(el.targetNum, +target.toFixed(1));
  for (const b of $$('[data-native]')) b.textContent = nativePPD.toFixed(0);
  for (const b of $$('[data-target]')) b.textContent = (+target.toFixed(1)).toString();

  el.chips.replaceChildren(...[...REFERENCES, { label: 'Native', ppd: nativePPD, native: true }].map((ref) => {
    const ppd = ref.monitor ? ppdFor(ref.monitor[0] * 25.4 / Math.hypot(ref.monitor[1], ref.monitor[2]), dist) : ref.ppd;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.innerHTML = `${ref.label}<b>${ppd.toFixed(0)}</b>`;
    b.disabled = !ref.native && ppd > nativePPD;
    b.title = b.disabled ? 'Above what your display can show from this distance'
      : ref.monitor ? `${ref.label} viewed from ${fmtDist(dist)}` : ref.native ? 'Your display as it is' : `About ${ppd} PPD`;
    b.setAttribute('aria-pressed', Math.abs(target - ppd) < 0.26);
    b.onclick = () => { state.target = ppd; update(); };
    return b;
  }));

  if (s <= 1.0005) {
    el.equiv.textContent = 'Showing your display as it is. Lower the PPD to simulate a coarser display; to preview a ' +
      'finer one, sit farther back and update the viewing distance.';
  } else {
    el.equiv.innerHTML = `Each simulated pixel covers <b>${s.toFixed(2)} × ${s.toFixed(2)}</b> of yours. That is this ` +
      `${state.diag}″ screen at <b>${Math.round(state.resW / s)} × ${Math.round(state.resH / s)}</b>, or the density of ` +
      `your current display seen from <b>${fmtDist(distanceFor(target, pitch))}</b>.`;
  }

  // view + sample options
  document.body.dataset.view = state.view;
  for (const b of $$('.seg button')) b.setAttribute('aria-pressed', b.dataset.view === state.view);
  setSplit(state.split);
  el.fontSize.value = state.fontSize;
  el.font.value = state.font;
  el.codeSize.value = state.codeSize;
  el.imageSrc.value = state.imageSrc;
  const builtin = window.PPD_PHOTOS && window.PPD_PHOTOS[state.imageSrc];
  el.credit.textContent = builtin ? `Photo: ${builtin.credit}` : '';

  save();
  invalidate();
}

function setSplit(v) {
  state.split = clamp(v, 0, 1);
  document.documentElement.style.setProperty('--split', `${(state.split * 100).toFixed(2)}%`);
  for (const h of $$('.handle')) h.setAttribute('aria-valuenow', Math.round(state.split * 100));
}

function bindNumber(input, lo, hi, apply) {
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v) && v >= lo && v <= hi) { apply(v); update(); }
  });
  input.addEventListener('blur', update); // snap an out-of-range entry back to the value in use
}

bindNumber(el.diag, 3, 200, (v) => { state.diag = v; });
bindNumber(el.resW, 320, 16000, (v) => { state.resW = Math.round(v); });
bindNumber(el.resH, 240, 16000, (v) => { state.resH = Math.round(v); });
bindNumber(el.dist, 1, 2000, (v) => { state.dist = state.unit === 'in' ? v * 2.54 : v; });
bindNumber(el.targetNum, 1, 1000, (v) => { state.target = v; });

el.unit.onchange = () => { state.unit = el.unit.value; update(); };
el.preset.onchange = () => {
  const p = PRESETS[el.preset.value];
  if (p) { [, state.diag, state.resW, state.resH] = p; update(); }
};
el.target.oninput = () => { state.target = +el.target.value; update(); };
el.fontSize.onchange = () => { state.fontSize = +el.fontSize.value; update(); };
el.font.onchange = () => { state.font = el.font.value; update(); };
el.codeSize.onchange = () => { state.codeSize = +el.codeSize.value; update(); };
el.imageSrc.onchange = () => { state.imageSrc = el.imageSrc.value; update(); };
for (const b of $$('.seg button')) b.onclick = () => { state.view = b.dataset.view; update(); };

el.file.onchange = () => {
  const file = el.file.files[0];
  if (!file) return;
  if (![...el.imageSrc.options].some((o) => o.value === 'custom')) el.imageSrc.add(new Option('Your image', 'custom'));
  loadPhoto('custom', URL.createObjectURL(file));
  state.imageSrc = 'custom';
  el.file.value = '';
  update();
};

for (const handle of $$('.handle')) {
  const move = (e) => {
    const r = handle.parentElement.getBoundingClientRect();
    setSplit((e.clientX - r.left) / r.width);
  };
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener('pointermove', move);
    e.preventDefault();
  });
  const end = () => { handle.removeEventListener('pointermove', move); save(); };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -0.02, ArrowRight: 0.02 }[e.key];
    if (step) { setSplit(state.split + step); save(); e.preventDefault(); }
  });
}

// Zoom and moving the window between screens both change devicePixelRatio and fire resize.
// Panel width changes are handled by the ResizeObserver; mobile browsers also fire resize while scrolling.
let screenKey = '';
const screenChanged = () => screenKey !== (screenKey = [devicePixelRatio, screen.width, screen.height].join());
screenChanged();
window.addEventListener('resize', () => { if (screenChanged()) update(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', update);

update();
})();
