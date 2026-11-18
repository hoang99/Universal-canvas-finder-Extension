/**
 * Universal Canvas Finder — background service worker.
 *
 * Vai trò: "trạm trung chuyển" giữa các frame của tab, MAIN world của trang,
 * offscreen document (nơi chạy Tesseract) và các API chỉ có ở background
 * (captureVisibleTab, fetch không bị CORS, scripting).
 *
 * Mọi xử lý đều cục bộ: không có request nào gửi dữ liệu ra ngoài.
 * Request mạng duy nhất là tải lại chính ảnh mà trang đang hiển thị khi bị CORS.
 */
'use strict';

const OFFSCREEN_URL = 'offscreen.html';
const OCR_CACHE_MAX = 300;          // số kết quả OCR giữ trong chrome.storage.local
const CAPTURE_MIN_INTERVAL = 550;   // Chrome giới hạn ~2 lần captureVisibleTab / giây
const MAX_FETCH_BYTES = 30 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  scanMode: 'auto',          // auto | dom | adapter | ocr | all
  ocrLangs: ['eng', 'vie'],
  autoRescan: false,
  includeHtmlText: false,
  minOcrSize: 40,
  maxOcrTargets: 40,
  caseSensitive: false,
  ignoreDiacritics: true,
  wholeWord: false,
  regex: false,
};

/* ------------------------------------------------------------------ */
/* Tiện ích                                                            */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) { console.log('[UCF bg]', ...args); }

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Gửi tin tới một frame; không ném lỗi nếu frame không có content script. */
async function sendToFrame(tabId, frameId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId });
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
}

/* ------------------------------------------------------------------ */
/* Bật/tắt thanh tìm kiếm                                              */
/* ------------------------------------------------------------------ */

/** Đảm bảo content.js có mặt ở mọi frame (tab mở trước khi cài extension). */
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
    return true;
  } catch (e) {
    log('Không inject được content.js:', e.message);
    return false;
  }
}

async function showFinder(tabId, action /* 'toggle' | 'open' */) {
  let res = await sendToFrame(tabId, 0, { type: 'ui', action });
  if (res && res.error) {
    const ok = await ensureContentScript(tabId);
    if (!ok) {
      // Trang bị hạn chế (chrome://, Chrome Web Store, trang PDF gốc...).
      chrome.action.setBadgeText({ tabId, text: '!' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#d33' });
      chrome.action.setTitle({ tabId, title: 'Universal Canvas Finder không chạy được trên trang này (trang bị Chrome hạn chế).' });
      return { error: 'restricted' };
    }
    res = await sendToFrame(tabId, 0, { type: 'ui', action });
  }
  return res;
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-finder') return;
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (t && t.id != null) showFinder(t.id, 'toggle');
});

chrome.runtime.onInstalled.addListener(async () => {
  // Bổ sung khoá mặc định còn thiếu, giữ nguyên lựa chọn cũ của người dùng.
  const cur = await chrome.storage.sync.get(null);
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (!(k in cur)) patch[k] = v;
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
});

/* ------------------------------------------------------------------ */
/* Adapter / MAIN world                                                */
/* ------------------------------------------------------------------ */

let adapterFilesPromise = null;
/** Đọc danh sách adapter từ adapters/index.json (plugin). */
function getAdapterFiles() {
  if (!adapterFilesPromise) {
    adapterFilesPromise = fetch(chrome.runtime.getURL('adapters/index.json'))
      .then((r) => r.json())
      .then((list) => list.filter((f) => typeof f === 'string' && /^[\w.-]+\.js$/.test(f)).map((f) => 'adapters/' + f))
      .catch((e) => { log('adapters/index.json lỗi:', e); adapterFilesPromise = null; return []; });
  }
  return adapterFilesPromise;
}

async function injectMain(tabId, frameId) {
  const files = ['injected.js', ...(await getAdapterFiles())];
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    files,
    injectImmediately: true,
  });
}

/** Gọi một hàm của window.__UCF_MAIN__ trong MAIN world của frame. */
async function callMain(tabId, frameId, fn, args) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: (fnName, fnArgs) => {
      const api = window.__UCF_MAIN__;
      if (!api || typeof api[fnName] !== 'function') return { error: 'not-injected' };
      try {
        return Promise.resolve(api[fnName](...(fnArgs || []))).catch((e) => ({ error: String(e && e.message || e) }));
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
    },
    args: [fn, args || []],
  });
  return res ? res.result : { error: 'no-result' };
}

/* ------------------------------------------------------------------ */
/* Chụp màn hình                                                       */
/* ------------------------------------------------------------------ */

let lastCaptureAt = 0;
let captureChain = Promise.resolve();

/** Chụp phần nhìn thấy của tab, tạm ẩn UI của extension để không lọt vào ảnh. */
function captureTab(tab) {
  const job = captureChain.then(async () => {
    const wait = CAPTURE_MIN_INTERVAL - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    await sendToFrame(tab.id, 0, { type: 'ui-visibility', visible: false });
    await sleep(60);
    try {
      lastCaptureAt = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { dataUrl };
    } finally {
      await sendToFrame(tab.id, 0, { type: 'ui-visibility', visible: true });
    }
  });
  captureChain = job.catch(() => {});
  return job;
}

/* ------------------------------------------------------------------ */
/* Tải ảnh bị CORS                                                     */
/* ------------------------------------------------------------------ */

async function fetchImage(url) {
  if (!/^(https?|data|blob):/i.test(url)) throw new Error('URL không hỗ trợ: ' + url.slice(0, 40));
  const r = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > MAX_FETCH_BYTES) throw new Error('Ảnh quá lớn');
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_FETCH_BYTES) throw new Error('Ảnh quá lớn');
  const type = r.headers.get('content-type') || 'image/png';
  return { dataUrl: `data:${type.split(';')[0]};base64,${arrayBufferToBase64(buf)}`, type };
}

/* ------------------------------------------------------------------ */
/* OCR qua offscreen document + cache                                  */
/* ------------------------------------------------------------------ */

let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS'],
      justification: 'Chạy Tesseract.js (OCR) trong Web Worker cục bộ.',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function cacheGet(key) {
  const k = 'ocr:' + key;
  const o = await chrome.storage.local.get(k);
  return o[k] || null;
}

async function cachePut(key, value) {
  const k = 'ocr:' + key;
  const { ocrCacheIndex = [] } = await chrome.storage.local.get('ocrCacheIndex');
  const idx = ocrCacheIndex.filter((x) => x !== k);
  idx.push(k);
  const remove = idx.length > OCR_CACHE_MAX ? idx.splice(0, idx.length - OCR_CACHE_MAX) : [];
  if (remove.length) await chrome.storage.local.remove(remove);
  try {
    await chrome.storage.local.set({ [k]: value, ocrCacheIndex: idx });
  } catch (e) {
    // Hết quota: xoá nửa cache cũ nhất rồi bỏ qua.
    await chrome.storage.local.remove(idx.splice(0, Math.ceil(idx.length / 2)));
    await chrome.storage.local.set({ ocrCacheIndex: idx });
  }
}

async function runOcr(msg, sender) {
  const langs = (msg.langs && msg.langs.length ? msg.langs : ['eng']).slice().sort();
  const key = await sha256(langs.join('+') + '|' + JSON.stringify(msg.crop || null) + '|' + msg.image);
  if (!msg.noCache) {
    const hit = await cacheGet(key);
    if (hit) return { ...hit, cached: true };
  }
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'ocr',
    image: msg.image,
    crop: msg.crop || null,
    langs,
    jobId: msg.jobId,
    scanId: msg.scanId,
    tabId: sender.tab.id,
    frameId: sender.frameId,
  });
  if (res && !res.error && !res.cancelled) await cachePut(key, { lines: res.lines, width: res.width, height: res.height });
  return res;
}

/* ------------------------------------------------------------------ */
/* Điều phối quét toàn bộ frame                                        */
/* ------------------------------------------------------------------ */

async function startScan(tabId, scanId, settings) {
  await ensureContentScript(tabId);
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (id, opts) => {
        const api = self.__UCF__;
        return api ? api.startFrameScan(id, opts) : false;
      },
      args: [scanId, settings],
    });
  } catch (e) {
    return { error: e.message };
  }
  return { frames: results.filter((r) => r && r.result === true).map((r) => r.frameId) };
}

/* ------------------------------------------------------------------ */
/* Router tin nhắn                                                     */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false; // tin dành cho offscreen

  const handle = async () => {
    const tab = sender.tab;
    switch (msg.type) {
      case 'start-scan':
        return startScan(tab.id, msg.scanId, msg.settings);

      case 'to-top':
        return sendToFrame(tab.id, 0, { ...msg.payload, fromFrame: sender.frameId });

      case 'to-frame':
        return sendToFrame(tab.id, msg.frameId, msg.payload);

      case 'to-all-frames':
        try { await chrome.tabs.sendMessage(tab.id, msg.payload); } catch (e) { /* ignore */ }
        return { ok: true };

      case 'main-inject':
        await injectMain(tab.id, sender.frameId);
        return { ok: true };

      case 'main-call':
        return callMain(tab.id, sender.frameId, msg.fn, msg.args);

      case 'capture':
        return captureTab(tab);

      case 'fetch-image':
        return fetchImage(msg.url);

      case 'ocr':
        return runOcr(msg, sender);

      case 'ocr-cancel':
        try {
          await chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel', scanId: msg.scanId });
        } catch (e) { /* offscreen chưa mở */ }
        return { ok: true };

      case 'ocr-progress': // từ offscreen → frame đang chờ
        if (msg.tabId != null) {
          sendToFrame(msg.tabId, msg.frameId, { type: 'ocr-progress', jobId: msg.jobId, progress: msg.progress, status: msg.status });
        }
        return { ok: true };

      case 'open-finder': // từ popup
        return showFinder(msg.tabId, 'open');

      case 'clear-ocr-cache': {
        const all = await chrome.storage.local.get(null);
        await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('ocr:') || k === 'ocrCacheIndex'));
        return { ok: true };
      }

      default:
        return { error: 'unknown message: ' + msg.type };
    }
  };

  handle().then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true; // phản hồi bất đồng bộ
});
