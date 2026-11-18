/**
 * OCR engine — chạy trong offscreen document (offscreen.html).
 *
 * - Tesseract.js được đóng gói sẵn trong lib/tesseract (không tải code từ CDN).
 * - Bản thân việc nhận dạng chạy trong Web Worker do Tesseract.js tạo
 *   (lib/tesseract/worker.min.js) → không chặn trang, không chặn service worker.
 * - Tiền xử lý: nền trắng cho ảnh trong suốt, phóng to 2x với ảnh nhỏ,
 *   chuyển xám, kéo giãn tương phản, đảo màu nếu chữ sáng trên nền tối.
 * - Ảnh lớn được chia ô ~1500px chồng nhau 10%, từ trùng ở vùng chồng được loại bỏ.
 */
/* global Tesseract */
'use strict';

const AVAILABLE_LANGS = ['eng', 'vie', 'jpn', 'kor', 'chi_sim'];
const TILE = 1500;
const OVERLAP = Math.round(TILE * 0.1);
const MIN_WORD_CONF = 25;
const MAX_SIDE = 16000; // giới hạn kích thước sau khi phóng to

let tWorker = null;
let tWorkerLangs = '';
let tWorkerPromise = null;
let jobChain = Promise.resolve();
let currentJob = null;           // { scanId, jobId, tabId, frameId, tileIndex, tiles, reject }
const cancelledScans = new Set();

/* ------------------------------------------------------------------ */
/* Tesseract worker                                                    */
/* ------------------------------------------------------------------ */

function reportProgress(progress, status) {
  const j = currentJob;
  if (!j) return;
  chrome.runtime.sendMessage({
    type: 'ocr-progress', tabId: j.tabId, frameId: j.frameId, jobId: j.jobId, progress, status,
  }).catch(() => {});
}

async function getWorker(langs) {
  const key = langs.join('+');
  if (tWorker && tWorkerLangs === key) return tWorker;
  if (tWorkerPromise && tWorkerLangs === key) return tWorkerPromise;
  await terminateWorker();
  tWorkerLangs = key;
  tWorkerPromise = (async () => {
    const w = await Tesseract.createWorker(langs, 1 /* OEM.LSTM_ONLY */, {
      workerPath: chrome.runtime.getURL('lib/tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('lib/tesseract/core'),
      langPath: chrome.runtime.getURL('lib/tesseract/lang'),
      workerBlobURL: false,   // CSP của extension không cho worker từ blob:
      cacheMethod: 'none',    // dữ liệu đã nằm trong extension, không cần IndexedDB
      gzip: true,
      logger: (m) => {
        const j = currentJob;
        if (!j) return;
        if (m.status === 'recognizing text') {
          reportProgress((j.tileIndex + (m.progress || 0)) / j.tiles, 'recognizing');
        } else if (/load/i.test(m.status || '')) {
          reportProgress(0, m.status);
        }
      },
      errorHandler: (e) => console.warn('[UCF ocr] worker error', e),
    });
    await w.setParameters({
      tessedit_pageseg_mode: '11',     // SPARSE_TEXT: hợp với sơ đồ, slide, chữ rải rác
      preserve_interword_spaces: '1',
    });
    tWorker = w;
    return w;
  })();
  try {
    return await tWorkerPromise;
  } catch (e) {
    tWorker = null; tWorkerLangs = ''; tWorkerPromise = null;
    throw e;
  }
}

async function terminateWorker() {
  const w = tWorker || (tWorkerPromise && await tWorkerPromise.catch(() => null));
  tWorker = null; tWorkerPromise = null; tWorkerLangs = '';
  if (w) { try { await w.terminate(); } catch (e) { /* ignore */ } }
}

/* ------------------------------------------------------------------ */
/* Tiền xử lý ảnh                                                      */
/* ------------------------------------------------------------------ */

/** Rasterize SVG bằng <img> (createImageBitmap không hỗ trợ SVG blob). */
function rasterizeSvg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth || 800, h = img.naturalHeight || 600;
        const k = Math.max(1, 1600 / Math.max(w, h)); // vector → vẽ ở độ phân giải tốt
        w = Math.round(w * k); h = Math.round(h * k);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(createImageBitmap(c));
      } catch (e) { reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không đọc được SVG')); };
    img.src = url;
  });
}

/**
 * Giải mã ảnh, cắt theo crop (toạ độ pixel của ảnh) nếu có.
 * Ảnh SVG được rasterize; kích thước trả về là kích thước "gốc" để content
 * script quy đổi bbox → toạ độ tương đối của phần tử.
 */
async function loadBitmap(dataUrl, crop) {
  const blob = await (await fetch(dataUrl)).blob();
  let bmp = /svg/i.test(blob.type) ? await rasterizeSvg(blob) : await createImageBitmap(blob);
  if (crop) {
    const x = Math.max(0, Math.round(crop.x)), y = Math.max(0, Math.round(crop.y));
    const w = Math.min(bmp.width - x, Math.round(crop.w)), h = Math.min(bmp.height - y, Math.round(crop.h));
    if (w <= 2 || h <= 2) throw new Error('Vùng cắt rỗng');
    const cropped = await createImageBitmap(bmp, x, y, w, h);
    bmp.close && bmp.close();
    bmp = cropped;
  }
  return bmp;
}

/** Trả về { canvas, scale } đã tiền xử lý. */
function preprocess(bmp) {
  const w0 = bmp.width, h0 = bmp.height;
  let scale = Math.max(w0, h0) < 1200 ? 2 : 1;
  if (Math.min(w0, h0) * scale < 40) scale = Math.min(4, 40 / Math.max(1, Math.min(w0, h0)));
  if (Math.max(w0, h0) * scale > MAX_SIDE) scale = MAX_SIDE / Math.max(w0, h0);
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';            // ảnh trong suốt → nền trắng
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = g; hist[g]++; sum += g;
  }
  const n = d.length / 4;
  const mean = sum / n;
  // Kéo giãn tương phản theo phân vị 1% – 99%.
  const pct = (p) => {
    let acc = 0; const target = n * p;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
    return 255;
  };
  let lo = pct(0.01), hi = pct(0.99);
  if (hi - lo < 64) {
    // Chữ chiếm < 1% diện tích (ảnh lớn, ít chữ) → phân vị "nuốt" mất chữ; dùng min/max thật.
    let mn = 0, mx = 255;
    while (mn < 255 && !hist[mn]) mn++;
    while (mx > 0 && !hist[mx]) mx--;
    lo = mn; hi = mx;
  }
  if (hi - lo < 16) { lo = 0; hi = 255; } // ảnh gần như một màu: không kéo giãn
  const invert = mean < 110; // chữ sáng trên nền tối
  const k = 255 / (hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let v = (d[i] - lo) * k;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, scale };
}

function tileStarts(len) {
  if (len <= TILE) return [0];
  const out = [];
  for (let s = 0; ; s += TILE - OVERLAP) {
    if (s + TILE >= len) { out.push(Math.max(0, len - TILE)); break; }
    out.push(s);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Phân tích kết quả Tesseract                                         */
/* ------------------------------------------------------------------ */

const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿]/;
/** Ghép từ thành dòng; không chèn khoảng trắng giữa hai ký tự CJK. */
function joinWords(words) {
  let s = '';
  for (const w of words) {
    if (s && !(CJK.test(s[s.length - 1]) && CJK.test(w.text[0]))) s += ' ';
    w.start = s.length;
    s += w.text;
    w.end = s.length;
  }
  return s;
}

/** Duyệt blocks → paragraphs → lines → words (định dạng của Tesseract.js v5–v7). */
function collectLines(data) {
  const lines = [];
  const blocks = data.blocks || [];
  for (const b of blocks) {
    for (const p of (b.paragraphs || [])) {
      for (const l of (p.lines || [])) lines.push(l);
    }
  }
  if (!lines.length && Array.isArray(data.lines)) return data.lines; // định dạng cũ
  return lines;
}

/**
 * @param tile {x,y,w,h} toạ độ ô trong ảnh đã scale
 * @param core vùng "sở hữu" của ô (loại bỏ trùng lặp ở vùng chồng nhau)
 */
function parseTile(data, tile, core, scale) {
  const out = [];
  for (const line of collectLines(data)) {
    const words = [];
    for (const w of (line.words || [])) {
      const text = (w.text || '').trim();
      if (!text || (w.confidence != null && w.confidence < MIN_WORD_CONF)) continue;
      const b = w.bbox;
      const cx = tile.x + (b.x0 + b.x1) / 2;
      const cy = tile.y + (b.y0 + b.y1) / 2;
      if (cx < core.x0 || cx >= core.x1 || cy < core.y0 || cy >= core.y1) continue;
      words.push({
        text,
        bbox: {
          x: (tile.x + b.x0) / scale,
          y: (tile.y + b.y0) / scale,
          w: (b.x1 - b.x0) / scale,
          h: (b.y1 - b.y0) / scale,
        },
      });
    }
    if (!words.length) continue;
    const text = joinWords(words);
    const x0 = Math.min(...words.map((w) => w.bbox.x));
    const y0 = Math.min(...words.map((w) => w.bbox.y));
    const x1 = Math.max(...words.map((w) => w.bbox.x + w.bbox.w));
    const y1 = Math.max(...words.map((w) => w.bbox.y + w.bbox.h));
    out.push({
      text,
      conf: line.confidence != null ? Math.round(line.confidence) : null,
      bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      words: words.map((w) => ({ s: w.start, e: w.end, bbox: w.bbox })),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Job OCR                                                             */
/* ------------------------------------------------------------------ */

async function ocrJob(msg) {
  if (cancelledScans.has(msg.scanId)) return { cancelled: true };
  const langs = (msg.langs || ['eng']).filter((l) => AVAILABLE_LANGS.includes(l));
  if (!langs.length) langs.push('eng');

  const bmp = await loadBitmap(msg.image, msg.crop);
  const { canvas, scale } = preprocess(bmp);
  const width = bmp.width, height = bmp.height;
  bmp.close && bmp.close();

  const xs = tileStarts(canvas.width), ys = tileStarts(canvas.height);
  const tiles = [];
  for (const y of ys) for (const x of xs) {
    tiles.push({ x, y, w: Math.min(TILE, canvas.width - x), h: Math.min(TILE, canvas.height - y) });
  }

  let rejectCurrent;
  const cancelPromise = new Promise((_, rej) => { rejectCurrent = rej; });
  currentJob = { ...msg, tileIndex: 0, tiles: tiles.length, reject: rejectCurrent };
  cancelPromise.catch(() => {});

  const worker = await Promise.race([getWorker(langs), cancelPromise]);
  const lines = [];
  for (let i = 0; i < tiles.length; i++) {
    if (cancelledScans.has(msg.scanId)) return { cancelled: true };
    currentJob.tileIndex = i;
    const t = tiles[i];
    let src = canvas;
    if (tiles.length > 1) {
      src = document.createElement('canvas');
      src.width = t.w; src.height = t.h;
      src.getContext('2d').drawImage(canvas, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
    }
    // Vùng sở hữu: chia đôi phần chồng lấn với ô bên cạnh.
    const half = OVERLAP / 2;
    const core = {
      x0: t.x === 0 ? -Infinity : t.x + half,
      y0: t.y === 0 ? -Infinity : t.y + half,
      x1: t.x + t.w >= canvas.width ? Infinity : t.x + t.w - half,
      y1: t.y + t.h >= canvas.height ? Infinity : t.y + t.h - half,
    };
    const { data } = await Promise.race([
      worker.recognize(src, {}, { blocks: true, text: false, hocr: false, tsv: false }),
      cancelPromise,
    ]);
    lines.push(...parseTile(data, t, core, scale));
  }
  reportProgress(1, 'done');
  return { lines, width, height };
}

function enqueue(msg) {
  const run = jobChain.then(() => ocrJob(msg))
    .catch((e) => {
      if (e && e.cancelled) return { cancelled: true };
      console.error('[UCF ocr]', e);
      return { error: String(e && e.message || e) };
    })
    .finally(() => { currentJob = null; });
  jobChain = run.catch(() => {});
  return run;
}

async function cancelScan(scanId) {
  cancelledScans.add(scanId);
  if (cancelledScans.size > 50) cancelledScans.delete(cancelledScans.values().next().value);
  if (currentJob && currentJob.scanId === scanId) {
    const rej = currentJob.reject;
    await terminateWorker();         // dừng ngay việc nhận dạng đang chạy
    rej && rej({ cancelled: true });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
  if (msg.type === 'ocr') {
    enqueue(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'cancel') {
    cancelScan(msg.scanId).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
