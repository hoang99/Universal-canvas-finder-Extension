/**
 * Universal Canvas Finder — content script (chạy ở MỌI frame, isolated world).
 *
 * Mỗi frame tự quét nội dung của chính nó theo 3 tầng:
 *   Tầng 1 (DOM)     : <text> trong SVG, alt/title/aria-label/placeholder, SVG trong <img>.
 *   Tầng 2 (Adapter) : dữ liệu của thư viện đồ hoạ, đọc qua injected.js ở MAIN world.
 *   Tầng 3 (OCR)     : canvas, ảnh, background-image, SVG dạng path, iframe "đóng".
 * Kết quả (chỉ văn bản) được gửi về frame trên cùng — nơi có thanh tìm kiếm.
 * Chi tiết (phần tử, bbox) được giữ lại trong frame để tô sáng tại chỗ.
 *
 * Không chỉnh sửa trang: UI nằm trong Shadow DOM kín, overlay không nhận chuột,
 * mọi lỗi đều được bắt để không ảnh hưởng tới script của trang.
 */
(() => {
  'use strict';
  if (self.__UCF__) return; // đã inject
  const IS_TOP = window === window.top;
  const FRAME_KEY = Math.random().toString(36).slice(2, 8);

  const DEFAULT_SETTINGS = {
    scanMode: 'auto', ocrLangs: ['eng', 'vie'], autoRescan: false, includeHtmlText: false,
    minOcrSize: 40, maxOcrTargets: 40,
    caseSensitive: false, ignoreDiacritics: true, wholeWord: false, regex: false,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.debug('[UCF]', ...a);

  /* ================================================================== */
  /* Giao tiếp với background                                           */
  /* ================================================================== */

  let contextDead = false;
  async function bg(msg) {
    if (contextDead) return { error: 'context-invalidated' };
    try {
      const r = await chrome.runtime.sendMessage(msg);
      return r === undefined ? {} : r;
    } catch (e) {
      const m = String(e && e.message || e);
      if (/context invalidated/i.test(m)) { contextDead = true; teardown(); }
      return { error: m };
    }
  }
  const toTop = (payload) => (IS_TOP ? handleTopMessage({ ...payload, fromFrame: 0 }) : bg({ type: 'to-top', payload }));

  /* ================================================================== */
  /* Bắt tay giữa các frame (postMessage)                               */
  /* ================================================================== */

  const aliveFrames = new WeakSet();   // iframe có content script của chúng ta
  const pendingOffsets = new Map();

  function deepElements(root = document, limit = 60000) {
    const out = [];
    const stack = [root];
    while (stack.length && out.length < limit) {
      const node = stack.pop();
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      let el = walker.nextNode();
      while (el && out.length < limit) {
        if (el !== uiHost && el !== overlayHost) {
          out.push(el);
          if (el.shadowRoot) stack.push(el.shadowRoot);
        }
        el = walker.nextNode();
      }
    }
    return out;
  }

  function frameElements() {
    return deepElements().filter((e) => /^(IFRAME|FRAME|EMBED|OBJECT)$/.test(e.tagName));
  }

  function findFrameBySource(src) {
    for (const f of frameElements()) {
      try { if (f.contentWindow === src) return f; } catch (e) { /* ignore */ }
    }
    return null;
  }

  function pingChildren() {
    for (const f of frameElements()) {
      try { f.contentWindow && f.contentWindow.postMessage({ __ucf: 'ping' }, '*'); } catch (e) { /* ignore */ }
    }
  }

  /** Toạ độ góc trên-trái của khung nhìn frame này trong khung nhìn của tab. */
  async function getFrameOffset() {
    if (IS_TOP) return { x: 0, y: 0 };
    const reqId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const t = setTimeout(() => { pendingOffsets.delete(reqId); resolve(null); }, 1500);
      pendingOffsets.set(reqId, (v) => { clearTimeout(t); resolve(v); });
      try { window.parent.postMessage({ __ucf: 'offset-req', reqId }, '*'); } catch (e) { resolve(null); }
    });
  }

  function contentBoxOf(frameEl) {
    const r = frameEl.getBoundingClientRect();
    const cs = getComputedStyle(frameEl);
    return {
      x: r.left + frameEl.clientLeft + parseFloat(cs.paddingLeft || 0),
      y: r.top + frameEl.clientTop + parseFloat(cs.paddingTop || 0),
    };
  }

  /** Nhờ các frame cha cuộn iframe chứa frame này vào tầm nhìn. */
  function revealSelfInAncestors() {
    if (!IS_TOP) { try { window.parent.postMessage({ __ucf: 'reveal' }, '*'); } catch (e) { /* ignore */ } }
  }

  window.addEventListener('message', async (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || typeof d.__ucf !== 'string') return;
    try {
      switch (d.__ucf) {
        case 'hello': {
          const f = findFrameBySource(e.source);
          if (f) aliveFrames.add(f);
          break;
        }
        case 'ping':
          if (e.source === window.parent) window.parent.postMessage({ __ucf: 'hello' }, '*');
          break;
        case 'offset-req': {
          const f = findFrameBySource(e.source);
          if (!f) break;
          const mine = await getFrameOffset();
          const box = contentBoxOf(f);
          e.source.postMessage({
            __ucf: 'offset-res', reqId: d.reqId,
            off: mine ? { x: mine.x + box.x, y: mine.y + box.y } : null,
          }, '*');
          break;
        }
        case 'offset-res':
          if (e.source === window.parent && pendingOffsets.has(d.reqId)) {
            pendingOffsets.get(d.reqId)(d.off || null);
            pendingOffsets.delete(d.reqId);
          }
          break;
        case 'reveal': {
          const f = findFrameBySource(e.source);
          if (f) { f.scrollIntoView({ block: 'nearest', inline: 'nearest' }); revealSelfInAncestors(); }
          break;
        }
      }
    } catch (err) { /* không bao giờ làm hỏng trang */ }
  });

  if (!IS_TOP) { try { window.parent.postMessage({ __ucf: 'hello' }, '*'); } catch (e) { /* ignore */ } }

  /* ================================================================== */
  /* Kho mục văn bản của frame                                          */
  /* ================================================================== */

  /**
   * item = { id, text, source, el, kind,
   *          rawMap?  : map chỉ số text → chỉ số textContent (DOM/SVG)
   *          textNode?: Text node duy nhất (văn bản HTML)
   *          rel?     : {x,y,w,h} tỉ lệ so với khung phần tử (OCR, adapter)
   *          words?   : [{s,e,rel}] (OCR) — để tô sáng đúng từ
   *          ref?     : mã đối tượng trong MAIN world (adapter) }
   */
  const items = new Map();
  let itemSeq = 0;
  let scan = { id: null, cancelled: true, running: false };

  function collapseWs(raw) {
    let s = ''; const map = []; let prevSpace = true;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (/\s/.test(c)) {
        if (!prevSpace) { s += ' '; map.push(i); prevSpace = true; }
      } else { s += c; map.push(i); prevSpace = false; }
    }
    if (s.endsWith(' ')) { s = s.slice(0, -1); map.pop(); }
    return { s, map };
  }

  function addItem(it, out) {
    if (!it.text || !it.text.trim()) return;
    it.id = `${FRAME_KEY}-${++itemSeq}`;
    items.set(it.id, it);
    out.push({ id: it.id, text: it.text, source: it.source, conf: it.conf });
  }

  function sendItems(list, replaceSources) {
    if (!list.length && !replaceSources) return;
    toTop({ type: 'frame-items', scanId: scan.id, items: list, replaceSources });
  }

  function progress(label, done, total) {
    toTop({ type: 'frame-progress', scanId: scan.id, label, done, total });
  }

  const isOurs = (el) => el === uiHost || el === overlayHost;

  function isRendered(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return false;
    return true;
  }

  /* ================================================================== */
  /* TẦNG 1 — DOM / SVG / thuộc tính                                     */
  /* ================================================================== */

  const ATTRS = ['alt', 'title', 'aria-label', 'aria-description', 'placeholder', 'data-tooltip'];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  async function tierDom(settings, all, covered) {
    const out = [];
    for (const el of all) {
      if (isOurs(el)) continue;
      // <text> của SVG (gồm cả <tspan> bên trong).
      if (el.namespaceURI === SVG_NS && el.localName === 'text') {
        const { s, map } = collapseWs(el.textContent || '');
        if (s) addItem({ text: s, source: 'DOM', kind: 'svg-text', el, rawMap: map }, out);
        const svg = el.ownerSVGElement;
        if (svg) covered.add(svg);
        continue;
      }
      if (el.namespaceURI === SVG_NS && (el.localName === 'title' || el.localName === 'desc')) {
        const { s } = collapseWs(el.textContent || '');
        if (s && el.parentElement) addItem({ text: s, source: 'DOM', kind: 'attr', el: el.parentElement }, out);
        continue;
      }
      for (const a of ATTRS) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v && v.trim().length > 1) {
          addItem({ text: collapseWs(v).s, source: 'DOM', kind: 'attr', el }, out);
        }
      }
    }

    // Ảnh SVG (<img src="*.svg">): tải mã nguồn SVG và đọc <text> — chính xác hơn OCR.
    const svgImgs = all.filter((el) => el.tagName === 'IMG' && /\.svg(\?|#|$)|^data:image\/svg/i.test(el.currentSrc || el.src || ''));
    for (const img of svgImgs.slice(0, 50)) {
      if (scan.cancelled) break;
      try {
        const src = img.currentSrc || img.src;
        const text = await fetchText(src);
        const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        let found = 0;
        doc.querySelectorAll('text').forEach((t) => {
          const { s } = collapseWs(t.textContent || '');
          if (s) { addItem({ text: s, source: 'DOM', kind: 'svg-img', el: img }, out); found++; }
        });
        if (found) covered.add(img);
      } catch (e) { /* bỏ qua, OCR sẽ xử lý */ }
    }

    // Văn bản HTML thường (tuỳ chọn) — để tìm cả nội dung lẫn chữ trong canvas một chỗ.
    if (settings.includeHtmlText && document.body) {
      const roots = [document.body, ...all.filter((e) => e.shadowRoot).map((e) => e.shadowRoot)];
      for (const root of roots) {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) => {
            const p = n.parentElement;
            if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
            if (p.namespaceURI === SVG_NS) return NodeFilter.FILTER_REJECT; // đã xử lý ở trên
            if (p.closest && (p.closest('[data-ucf-ui]'))) return NodeFilter.FILTER_REJECT;
            return /\S/.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          },
        });
        let n; let count = 0;
        while ((n = w.nextNode()) && count < 20000) {
          const { s, map } = collapseWs(n.data);
          if (s) { addItem({ text: s, source: 'DOM', kind: 'html-text', el: n.parentElement, textNode: n, rawMap: map }, out); count++; }
        }
      }
    }
    return out;
  }

  async function fetchText(url) {
    if (url.startsWith('data:')) {
      const [, meta, data] = url.match(/^data:([^,]*),(.*)$/s) || [];
      return /;base64/i.test(meta || '') ? decodeURIComponent(escape(atob(data))) : decodeURIComponent(data);
    }
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (r.ok) return await r.text();
    } catch (e) { /* CORS → nhờ background */ }
    const res = await bg({ type: 'fetch-image', url });
    if (!res || res.error) throw new Error(res && res.error);
    return fetchText(res.dataUrl);
  }

  /* ================================================================== */
  /* TẦNG 2 — Adapter thư viện đồ hoạ (MAIN world)                      */
  /* ================================================================== */

  async function tierAdapters(covered) {
    const out = [];
    const inj = await bg({ type: 'main-inject' });
    if (inj.error) { log('Không inject được MAIN world:', inj.error); return { out, adapters: [] }; }
    const res = await bg({ type: 'main-call', fn: 'extract', args: [] });
    if (!res || res.error) { log('Adapter lỗi:', res && res.error); return { out, adapters: [] }; }
    for (const it of res.items || []) {
      const host = it.host ? document.querySelector(`[data-ucf-host="${CSS.escape(it.host)}"]`) : null;
      if (!host) continue;
      covered.add(host);
      host.querySelectorAll('canvas,svg').forEach((c) => covered.add(c));
      let rel = null;
      if (it.bbox) {
        const hr = host.getBoundingClientRect();
        if (hr.width > 0 && hr.height > 0) {
          rel = { x: (it.bbox.x - hr.left) / hr.width, y: (it.bbox.y - hr.top) / hr.height, w: it.bbox.w / hr.width, h: it.bbox.h / hr.height };
        }
      }
      addItem({ text: collapseWs(String(it.text)).s, source: 'Adapter:' + it.adapter, kind: 'adapter', el: host, ref: it.ref, rel }, out);
    }
    return { out, adapters: res.adapters || [] };
  }

  /* ================================================================== */
  /* TẦNG 3 — OCR                                                        */
  /* ================================================================== */

  function bgImageUrl(el) {
    let bgi;
    try { bgi = getComputedStyle(el).backgroundImage; } catch (e) { return null; }
    if (!bgi || bgi === 'none') return null;
    const m = bgi.match(/url\(["']?(.*?)["']?\)/);
    return m ? m[1] : null;
  }

  /** Chọn các phần tử cần OCR, ưu tiên phần tử đang hiển thị và lớn. */
  function collectOcrTargets(settings, all, covered, forceAll) {
    const min = settings.minOcrSize || 40;
    const targets = [];
    const big = (r) => r.width >= min && r.height >= min / 2;
    let bgChecks = 0;
    for (const el of all) {
      if (isOurs(el)) continue;
      const tag = el.tagName;
      let type = null, extra = null;
      if (tag === 'CANVAS') type = 'canvas';
      else if (tag === 'IMG') type = 'img';
      else if (el.namespaceURI === SVG_NS && el.localName === 'svg' && !el.ownerSVGElement) type = 'svg';
      else if (/^(IFRAME|FRAME|EMBED|OBJECT)$/.test(tag)) {
        if (aliveFrames.has(el)) continue;     // frame con tự quét
        if (tag === 'OBJECT' && !el.data) continue;
        type = 'frame';
      } else if (bgChecks < 6000) {
        bgChecks++;
        const url = bgImageUrl(el);
        if (url) { type = 'bg'; extra = url; }
      }
      if (!type) continue;
      if (!forceAll && covered.has(el)) continue;
      if (!forceAll && type === 'svg' && el.querySelector('text')) continue;
      if (!isRendered(el)) continue;
      const r = el.getBoundingClientRect();
      if (!big(r)) continue;
      if (type === 'img' && !(el.complete && (el.naturalWidth || /\.svg/i.test(el.src)))) continue;
      const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      targets.push({ el, type, url: extra, score: (inView ? 1e9 : 0) + r.width * r.height });
    }
    targets.sort((a, b) => b.score - a.score);
    return targets.slice(0, Math.max(1, settings.maxOcrTargets || 40));
  }

  function isBlankCanvas(c) {
    // WebGL không bật preserveDrawingBuffer → toDataURL trả về ảnh trong suốt hoàn toàn.
    // Lấy mẫu thu nhỏ; ném lỗi SecurityError nếu canvas bị tainted.
    const S = 160;
    const s = document.createElement('canvas');
    s.width = S; s.height = S;
    const ctx = s.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(c, 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  }

  async function blobToDataUrl(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function imageUrlToDataUrl(url) {
    if (url.startsWith('data:')) return url;
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (r.ok) return await blobToDataUrl(await r.blob());
    } catch (e) { /* CORS */ }
    const res = await bg({ type: 'fetch-image', url });
    if (!res || res.error) throw new Error('fetch-image: ' + (res && res.error));
    return res.dataUrl;
  }

  /**
   * Chụp màn hình vùng phần tử (dùng khi canvas bị tainted/WebGL, iframe đóng, PDF...).
   * Phần tử cao hơn khung nhìn được cuộn từng đoạn và chụp nhiều lần.
   * Trả về [{ image, crop, rel }] — rel là phần của phần tử mà ảnh cắt bao phủ.
   */
  async function captureChunks(el) {
    const chunks = [];
    const dpr = window.devicePixelRatio || 1;
    const sx = scrollX, sy = scrollY;
    let r = el.getBoundingClientRect();
    const tall = r.height > innerHeight * 1.05;
    const docTop = r.top + scrollY;
    const steps = [];
    if (tall) for (let y = 0; y < r.height; y += innerHeight * 0.9) steps.push(y);
    else steps.push(null);
    try {
      for (const step of steps) {
        if (scan.cancelled) break;
        if (step === null) {
          const vis = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
          if (!vis) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else {
          window.scrollTo(scrollX, docTop + step);
        }
        revealSelfInAncestors();
        await sleep(300);
        const off = await getFrameOffset();
        if (!off) break;
        r = el.getBoundingClientRect();
        const vx0 = Math.max(r.left, 0), vy0 = Math.max(r.top, 0);
        const vx1 = Math.min(r.right, innerWidth), vy1 = Math.min(r.bottom, innerHeight);
        if (vx1 - vx0 < 4 || vy1 - vy0 < 4) continue;
        const shot = await bg({ type: 'capture' });
        if (!shot || shot.error || !shot.dataUrl) { log('capture lỗi', shot && shot.error); break; }
        chunks.push({
          image: shot.dataUrl,
          crop: { x: (off.x + vx0) * dpr, y: (off.y + vy0) * dpr, w: (vx1 - vx0) * dpr, h: (vy1 - vy0) * dpr },
          rel: { x: (vx0 - r.left) / r.width, y: (vy0 - r.top) / r.height, w: (vx1 - vx0) / r.width, h: (vy1 - vy0) / r.height },
        });
      }
    } finally {
      if (tall) window.scrollTo(sx, sy);
    }
    return chunks;
  }

  /** Lấy nguồn ảnh cho 1 mục tiêu OCR. */
  async function acquire(t) {
    const full = { x: 0, y: 0, w: 1, h: 1 };
    const el = t.el;
    if (t.type === 'canvas') {
      try {
        if (!isBlankCanvas(el)) return [{ image: el.toDataURL('image/png'), rel: full }];
      } catch (e) { /* tainted */ }
      return captureChunks(el);
    }
    if (t.type === 'img') {
      const src = el.currentSrc || el.src;
      try { return [{ image: await imageUrlToDataUrl(src), rel: full }]; } catch (e) { return captureChunks(el); }
    }
    if (t.type === 'bg') {
      try { return [{ image: await imageUrlToDataUrl(new URL(t.url, location.href).href), rel: full, bg: true }]; } catch (e) { return captureChunks(el); }
    }
    if (t.type === 'svg') {
      try {
        const clone = el.cloneNode(true);
        const r = el.getBoundingClientRect();
        clone.setAttribute('xmlns', SVG_NS);
        if (!clone.getAttribute('width')) clone.setAttribute('width', r.width);
        if (!clone.getAttribute('height')) clone.setAttribute('height', r.height);
        const xml = new XMLSerializer().serializeToString(clone);
        return [{ image: 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml))), rel: full }];
      } catch (e) { return captureChunks(el); }
    }
    return captureChunks(el); // iframe / embed / object
  }

  const ocrJobs = new Map(); // jobId → callback tiến trình

  async function tierOcr(settings, targets) {
    let done = 0;
    for (const t of targets) {
      if (scan.cancelled) break;
      progress(`OCR ${done + 1}/${targets.length}`, done, targets.length);
      const out = [];
      try {
        const sources = await acquire(t);
        for (const src of sources) {
          if (scan.cancelled) break;
          const jobId = Math.random().toString(36).slice(2);
          ocrJobs.set(jobId, (p) => progress(`OCR ${done + 1}/${targets.length}`, done + p, targets.length));
          const res = await bg({ type: 'ocr', image: src.image, crop: src.crop || null, langs: settings.ocrLangs, scanId: scan.id, jobId });
          ocrJobs.delete(jobId);
          if (!res || res.error || res.cancelled) { if (res && res.error) log('OCR lỗi:', res.error); continue; }
          const W = res.width || 1, H = res.height || 1;
          const map = (b) => ({
            x: src.rel.x + (b.x / W) * src.rel.w,
            y: src.rel.y + (b.y / H) * src.rel.h,
            w: (b.w / W) * src.rel.w,
            h: (b.h / H) * src.rel.h,
          });
          for (const line of res.lines || []) {
            addItem({
              text: line.text, source: 'OCR', kind: 'ocr', el: t.el, conf: line.conf,
              rel: src.bg ? null : map(line.bbox),       // background-image: vị trí không chắc chắn
              words: src.bg ? null : (line.words || []).map((w) => ({ s: w.s, e: w.e, rel: map(w.bbox) })),
            }, out);
          }
        }
      } catch (e) {
        log('OCR mục tiêu lỗi:', t.type, e);
      }
      done++;
      sendItems(out);
    }
  }

  /* ================================================================== */
  /* Điều phối quét trong một frame                                     */
  /* ================================================================== */

  let currentSettings = { ...DEFAULT_SETTINGS };

  /** Được background gọi qua scripting.executeScript ở mọi frame. */
  function startFrameScan(scanId, settings) {
    if (scan.running && !scan.cancelled) scan.cancelled = true; // huỷ lần quét cũ
    currentSettings = { ...DEFAULT_SETTINGS, ...settings };
    frameScan(scanId, currentSettings).catch((e) => {
      log('scan lỗi', e);
      toTop({ type: 'frame-done', scanId, error: String(e) });
    });
    return true;
  }

  async function frameScan(scanId, s) {
    const light = !!s.light;           // quét lại nhẹ: giữ kết quả OCR cũ
    scan = { id: scanId, cancelled: false, running: true };
    clearHighlight();
    if (light) { for (const [id, it] of items) if (it.source !== 'OCR') items.delete(id); }
    else items.clear();

    const mode = s.scanMode || 'auto';
    const useDom = ['auto', 'dom', 'all'].includes(mode);
    const useAdapter = ['auto', 'adapter', 'all'].includes(mode);
    const useOcr = !light && (['auto', 'ocr', 'all'].includes(mode) || s.forceOcr);
    const forceAll = mode === 'ocr' || mode === 'all' || !!s.forceOcr;

    pingChildren();
    await sleep(IS_TOP ? 200 : 120);  // chờ iframe con trả lời "hello"
    const all = deepElements();
    const covered = new Set();
    const adapters = [];

    if (useDom && !scan.cancelled) {
      progress('Đọc DOM/SVG', 0, 1);
      sendItems(await tierDom(s, all, covered), light ? ['DOM'] : null);
    }
    if (useAdapter && !scan.cancelled) {
      progress('Đọc thư viện đồ hoạ', 0, 1);
      const r = await tierAdapters(covered);
      adapters.push(...r.adapters);
      sendItems(r.out, light ? ['Adapter'] : null);
    }
    if (useOcr && !scan.cancelled) {
      const targets = collectOcrTargets(s, all, covered, forceAll);
      if (targets.length) await tierOcr(s, targets);
    }
    scan.running = false;
    toTop({ type: 'frame-done', scanId, adapters, cancelled: scan.cancelled, url: location.href });
    setupObserver();
  }

  /* ================================================================== */
  /* Theo dõi thay đổi (tự quét lại)                                     */
  /* ================================================================== */

  let observer = null;
  let changeTimer = null;
  function notifyChanged() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => toTop({ type: 'content-changed' }), 1200);
  }
  function setupObserver() {
    if (!currentSettings.autoRescan) { if (observer) { observer.disconnect(); observer = null; } return; }
    if (observer) return;
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        const t = m.target;
        if (t === uiHost || t === overlayHost || (t.nodeType === 1 && (uiHost && uiHost.contains(t)))) continue;
        if (m.type === 'attributes' && m.attributeName === 'data-ucf-host') continue;
        notifyChanged();
        return;
      }
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['src', 'alt', 'title', 'aria-label'],
    });
  }
  // injected.js phát sự kiện này khi thư viện báo dữ liệu đổi (GoJS model changed, ...).
  document.addEventListener('__ucf_changed', () => { if (currentSettings.autoRescan) notifyChanged(); });

  /* ================================================================== */
  /* Tô sáng (overlay)                                                   */
  /* ================================================================== */

  let overlayHost = null, overlayRoot = null, overlayRaf = 0, overlayGetRects = null;

  function ensureOverlay() {
    if (overlayHost && overlayHost.isConnected) return;
    overlayHost = document.createElement('div');
    overlayHost.setAttribute('data-ucf-ui', 'overlay');
    overlayHost.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    overlayRoot = overlayHost.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(overlayHost);
  }

  function drawBoxes(rects) {
    if (!overlayRoot) return;
    while (overlayRoot.childNodes.length > rects.length) overlayRoot.lastChild.remove();
    rects.forEach((r, i) => {
      let b = overlayRoot.childNodes[i];
      if (!b) {
        b = document.createElement('div');
        b.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #ff6a00;background:rgba(255,200,0,.28);'
          + 'border-radius:3px;box-shadow:0 0 0 3px rgba(255,106,0,.35),0 0 12px rgba(255,106,0,.6);pointer-events:none;'
          + 'transition:left .08s,top .08s,width .08s,height .08s;';
        overlayRoot.appendChild(b);
      }
      const pad = 2;
      b.style.left = (r.x - pad) + 'px';
      b.style.top = (r.y - pad) + 'px';
      b.style.width = Math.max(4, r.w + pad * 2) + 'px';
      b.style.height = Math.max(4, r.h + pad * 2) + 'px';
    });
  }

  function overlayLoop() {
    overlayRaf = 0;
    if (!overlayGetRects) return;
    try { drawBoxes(overlayGetRects()); } catch (e) { drawBoxes([]); }
    overlayRaf = requestAnimationFrame(overlayLoop); // bám theo cuộn/zoom/resize/animation
  }

  function showOverlay(getRects) {
    ensureOverlay();
    overlayGetRects = getRects;
    if (!overlayRaf) overlayRaf = requestAnimationFrame(overlayLoop);
  }

  function clearHighlight() {
    overlayGetRects = null;
    if (overlayRaf) cancelAnimationFrame(overlayRaf);
    overlayRaf = 0;
    if (overlayRoot) drawBoxes([]);
  }

  const relToRect = (el, rel) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + rel.x * r.width, y: r.top + rel.y * r.height, w: rel.w * r.width, h: rel.h * r.height };
  };
  const domRect = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });

  function unionRel(list) {
    const x0 = Math.min(...list.map((w) => w.x)), y0 = Math.min(...list.map((w) => w.y));
    const x1 = Math.max(...list.map((w) => w.x + w.w)), y1 = Math.max(...list.map((w) => w.y + w.h));
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Range bao đúng đoạn khớp trong văn bản DOM/SVG. */
  function makeRange(it, start, end) {
    if (!it.rawMap || !it.rawMap.length) return null;
    const rs = it.rawMap[Math.min(start, it.rawMap.length - 1)];
    const re = it.rawMap[Math.min(end - 1, it.rawMap.length - 1)] + 1;
    const nodes = [];
    if (it.textNode) nodes.push(it.textNode);
    else {
      const w = document.createTreeWalker(it.el, NodeFilter.SHOW_TEXT);
      let n; while ((n = w.nextNode())) nodes.push(n);
    }
    let pos = 0, sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (const n of nodes) {
      const len = n.data.length;
      if (!sNode && rs < pos + len) { sNode = n; sOff = rs - pos; }
      if (sNode && re <= pos + len) { eNode = n; eOff = re - pos; break; }
      pos += len;
    }
    if (!sNode || !eNode) return null;
    const range = document.createRange();
    range.setStart(sNode, sOff);
    range.setEnd(eNode, eOff);
    return range;
  }

  function centerInView(rect) {
    const m = 60;
    let dy = 0, dx = 0;
    if (rect.y < m || rect.y + rect.h > innerHeight - m) dy = rect.y + rect.h / 2 - innerHeight / 2;
    if (rect.x < m || rect.x + rect.w > innerWidth - m) dx = rect.x + rect.w / 2 - innerWidth / 2;
    if (dx || dy) window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  }

  async function highlight(id, start, end) {
    const it = items.get(id);
    if (!it || !it.el || !it.el.isConnected) return { ok: false };
    revealSelfInAncestors();
    let getRects;

    if (it.kind === 'adapter') {
      // Dùng API của thư viện: cuộn/căn giữa + chọn đối tượng, lấy bbox mới.
      const res = await bg({ type: 'main-call', fn: 'reveal', args: [it.ref] });
      if (res && res.bbox) {
        const hr = it.el.getBoundingClientRect();
        const b = res.bbox;
        // Lưu bbox dạng tỉ lệ so với host → overlay tự bám theo khi trang cuộn.
        it.rel = { x: (b.x - hr.left) / hr.width, y: (b.y - hr.top) / hr.height, w: b.w / hr.width, h: b.h / hr.height };
      }
      getRects = () => [it.rel ? relToRect(it.el, it.rel) : domRect(it.el.getBoundingClientRect())];
    } else if (it.rawMap) {
      const range = makeRange(it, start, end);
      getRects = range
        ? () => [...range.getClientRects()].map(domRect).filter((r) => r.w > 0 || r.h > 0)
        : () => [domRect(it.el.getBoundingClientRect())];
    } else if (it.words && it.words.length) {
      const ws = it.words.filter((w) => w.e > start && w.s < end).map((w) => w.rel);
      const rel = ws.length ? unionRel(ws) : it.rel;
      getRects = () => [relToRect(it.el, rel)];
    } else if (it.rel) {
      getRects = () => [relToRect(it.el, it.rel)];
    } else {
      getRects = () => [domRect(it.el.getBoundingClientRect())];
    }

    // Cuộn tới phần tử, rồi căn giữa đúng vùng chữ (với phần tử lớn).
    const r0 = it.el.getBoundingClientRect();
    if (r0.bottom < 0 || r0.top > innerHeight || r0.right < 0 || r0.left > innerWidth) {
      it.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    try { const rs = getRects(); if (rs[0]) centerInView(rs[0]); } catch (e) { /* ignore */ }
    showOverlay(getRects);
    return { ok: true };
  }

  /* ================================================================== */
  /* Tin nhắn từ background                                              */
  /* ================================================================== */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    switch (msg.type) {
      case 'highlight':
        highlight(msg.id, msg.start, msg.end).then(sendResponse, () => sendResponse({ ok: false }));
        return true;
      case 'clear-highlight':
        clearHighlight();
        return false;
      case 'cancel-scan':
        if (scan.id === msg.scanId) scan.cancelled = true;
        return false;
      case 'ocr-progress': {
        const cb = ocrJobs.get(msg.jobId);
        if (cb && typeof msg.progress === 'number') cb(Math.min(0.99, msg.progress));
        return false;
      }
    }
    if (IS_TOP) {
      const r = handleTopMessage(msg);
      if (r !== undefined) { sendResponse(r); }
    }
    return false;
  });

  /* ================================================================== */
  /* FRAME TRÊN CÙNG: UI + tìm kiếm                                     */
  /* ================================================================== */

  let uiHost = null;
  let handleTopMessage = () => undefined;
  let teardown = () => { clearHighlight(); };

  self.__UCF__ = { startFrameScan, highlight, items };
  if (!IS_TOP) return;

  /* ---------------- Chuẩn hoá & tìm kiếm ---------------- */

  /** Bỏ dấu tiếng Việt (và dấu Latin nói chung), giữ bản đồ chỉ số về chuỗi gốc. */
  function normalize(text, stripMarks) {
    if (!stripMarks) return { s: text, map: null };
    let s = ''; const map = [];
    for (let i = 0; i < text.length; i++) {
      let c = text[i];
      if (c === 'đ') c = 'd'; else if (c === 'Đ') c = 'D';
      else c = c.normalize('NFD').replace(/[̀-ͯ]/g, '');
      for (const ch of c) { s += ch; map.push(i); }
    }
    return { s, map };
  }
  const stripMarks = (q) => normalize(q, true).s;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function buildRegex(query, opt) {
    let q = opt.ignoreDiacritics ? stripMarks(query) : query;
    let pat = opt.regex ? q : escapeRe(q).replace(/\s+/g, '\\s+');
    if (opt.wholeWord) pat = `(?<![\\p{L}\\p{N}_])(?:${pat})(?![\\p{L}\\p{N}_])`;
    return new RegExp(pat, 'gu' + (opt.caseSensitive ? '' : 'i'));
  }

  const MAX_MATCHES = 5000;

  const ui = {
    open: false, index: [], indexById: new Map(), matches: [], current: -1,
    scanId: null, scanning: false, expected: new Set(), frameProgress: new Map(),
    adapters: new Set(), scannedUrl: null, error: '',
  };

  function search() {
    const q = els.input.value;
    ui.matches = []; ui.current = -1; ui.error = '';
    if (q.trim()) {
      let re;
      try { re = buildRegex(q, currentSettings); } catch (e) { ui.error = 'Regex không hợp lệ'; }
      if (re) {
        outer: for (const entry of ui.index) {
          if (!entry.norm || entry.normFlag !== currentSettings.ignoreDiacritics) {
            entry.norm = normalize(entry.text, currentSettings.ignoreDiacritics);
            entry.normFlag = currentSettings.ignoreDiacritics;
          }
          const { s, map } = entry.norm;
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(s))) {
            if (m[0].length === 0) { re.lastIndex++; continue; }
            const a = m.index, b = m.index + m[0].length;
            ui.matches.push({ entry, start: map ? map[a] : a, end: map ? map[b - 1] + 1 : b });
            if (ui.matches.length >= MAX_MATCHES) break outer;
          }
        }
      }
    }
    if (ui.matches.length) ui.current = 0;
    renderResults();
    if (ui.current >= 0) select(0, false);
    else broadcastClear();
  }

  // Debug: trong DevTools chọn context của extension rồi gọi __UCF__.dump().
  self.__UCF__.dump = () => ui.index.map((e) => `[${e.source}${e.frameId ? ' f' + e.frameId : ''}] ${e.text}`);

  let searchTimer = 0;
  const searchSoon = (ms = 140) => { clearTimeout(searchTimer); searchTimer = setTimeout(search, ms); };

  function broadcastClear() { bg({ type: 'to-all-frames', payload: { type: 'clear-highlight' } }); }

  async function select(i, focusList = true) {
    if (!ui.matches.length) return;
    ui.current = (i + ui.matches.length) % ui.matches.length;
    const m = ui.matches[ui.current];
    renderCounter();
    markActiveRow(focusList);
    broadcastClear();
    const payload = { type: 'highlight', id: m.entry.id, start: m.start, end: m.end };
    if (m.entry.frameId === 0) await highlight(m.entry.id, m.start, m.end);
    else await bg({ type: 'to-frame', frameId: m.entry.frameId, payload });
  }

  /* ---------------- Quét ---------------- */

  async function startScan(opts = {}) {
    if (ui.scanning) await cancelScan(true);
    const scanId = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    ui.scanId = scanId; ui.scanning = true; ui.scannedUrl = location.href;
    ui.frameProgress.clear(); ui.expected = new Set();
    if (!opts.light) { ui.index = []; ui.indexById.clear(); ui.adapters.clear(); }
    renderProgress('Đang bắt đầu…', 0);
    renderStatus();
    const settings = { ...currentSettings, forceOcr: !!opts.deep, light: !!opts.light };
    const res = await bg({ type: 'start-scan', scanId, settings });
    if (ui.scanId !== scanId) return;
    if (res.error || !res.frames) {
      ui.scanning = false; ui.error = 'Không quét được: ' + (res.error || '?');
      renderProgress(null); renderStatus(); return;
    }
    res.frames.forEach((f) => { if (!ui.frameProgress.has(f + ':done')) ui.expected.add(f); });
    for (const k of [...ui.frameProgress.keys()]) if (k.endsWith(':done')) ui.expected.delete(Number(k.split(':')[0]));
    checkScanDone();
  }

  async function cancelScan(silent) {
    if (!ui.scanId) return;
    const scanId = ui.scanId;
    bg({ type: 'to-all-frames', payload: { type: 'cancel-scan', scanId } });
    if (scan.id === scanId) scan.cancelled = true;
    await bg({ type: 'ocr-cancel', scanId });
    ui.scanning = false; ui.expected.clear();
    if (!silent) { renderProgress(null); renderStatus('Đã huỷ quét.'); }
  }

  function checkScanDone() {
    if (ui.scanning && ui.expected.size === 0 && ui.scanId) {
      ui.scanning = false;
      renderProgress(null);
      renderStatus();
      searchSoon(0);
    }
  }

  handleTopMessage = (msg) => {
    switch (msg.type) {
      case 'ui':
        if (msg.action === 'toggle') (ui.open ? closeUi() : openUi());
        else openUi();
        return { ok: true, open: ui.open };
      case 'ui-visibility':
        if (uiHost) uiHost.style.visibility = msg.visible ? 'visible' : 'hidden';
        if (overlayHost) overlayHost.style.visibility = msg.visible ? 'visible' : 'hidden';
        return { ok: true };
      case 'frame-items': {
        if (msg.scanId !== ui.scanId) return undefined;
        const fid = msg.fromFrame || 0;
        if (msg.replaceSources) {
          ui.index = ui.index.filter((e) => !(e.frameId === fid && msg.replaceSources.some((p) => e.source.startsWith(p))));
        }
        for (const it of msg.items || []) {
          const entry = { ...it, frameId: fid };
          ui.index.push(entry);
        }
        renderStatus();
        searchSoon(250);
        return undefined;
      }
      case 'frame-progress':
        if (msg.scanId !== ui.scanId) return undefined;
        ui.frameProgress.set(msg.fromFrame || 0, msg);
        renderAggregateProgress();
        return undefined;
      case 'frame-done': {
        if (msg.scanId !== ui.scanId) return undefined;
        const fid = msg.fromFrame || 0;
        (msg.adapters || []).forEach((a) => ui.adapters.add(a));
        ui.frameProgress.set(fid + ':done', true);
        ui.frameProgress.delete(fid);
        ui.expected.delete(fid);
        checkScanDone();
        return undefined;
      }
      case 'content-changed':
        if (ui.open && currentSettings.autoRescan && !ui.scanning) startScan({ light: true });
        return undefined;
    }
    return undefined;
  };

  /* ---------------- Giao diện (Shadow DOM) ---------------- */

  let shadow = null;
  const els = {};

  function h(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) e.append(c);
    return e;
  }

  async function buildUi() {
    uiHost = document.createElement('div');
    uiHost.setAttribute('data-ucf-ui', 'finder');
    uiHost.style.cssText = 'all:initial;position:fixed;top:12px;right:16px;z-index:2147483647;visibility:hidden;';
    shadow = uiHost.attachShadow({ mode: 'closed' });

    // CSS nằm trong Shadow DOM → không bị CSS của trang ảnh hưởng và ngược lại.
    try {
      const css = await (await fetch(chrome.runtime.getURL('styles.css'))).text();
      try {
        const sheet = new CSSStyleSheet(); sheet.replaceSync(css);
        shadow.adoptedStyleSheets = [sheet];
      } catch (e) { shadow.append(h('style', {}, css)); }
    } catch (e) { log('Không tải được styles.css', e); }

    const toggle = (key, label, title) => {
      const b = h('button', { class: 'opt', title, 'data-key': key }, label);
      b.addEventListener('click', () => {
        currentSettings[key] = !currentSettings[key];
        chrome.storage.sync.set({ [key]: currentSettings[key] }).catch(() => {});
        renderOptions(); searchSoon(0);
      });
      return b;
    };

    els.input = h('input', { type: 'text', placeholder: 'Tìm trong canvas, ảnh, SVG, sơ đồ…', spellcheck: 'false', autocomplete: 'off' });
    els.counter = h('span', { class: 'counter' }, '0/0');
    els.prev = h('button', { class: 'icon', title: 'Kết quả trước (Shift+Enter)', onclick: () => select(ui.current - 1) }, '↑');
    els.next = h('button', { class: 'icon', title: 'Kết quả sau (Enter)', onclick: () => select(ui.current + 1) }, '↓');
    els.rescan = h('button', { class: 'icon', title: 'Quét lại', onclick: () => startScan() }, '⟳');
    els.deep = h('button', { class: 'icon text', title: 'Quét sâu: OCR mọi canvas/ảnh/iframe (bỏ qua tầng nhanh)', onclick: () => startScan({ deep: true }) }, 'OCR');
    els.close = h('button', { class: 'icon', title: 'Đóng (Esc)', onclick: () => closeUi() }, '✕');
    els.opts = [
      toggle('caseSensitive', 'Aa', 'Phân biệt hoa/thường'),
      toggle('ignoreDiacritics', 'ă→a', 'Bỏ qua dấu tiếng Việt'),
      toggle('wholeWord', '“ab”', 'Khớp toàn từ'),
      toggle('regex', '.*', 'Biểu thức chính quy (regex)'),
    ];
    els.mode = h('span', { class: 'mode' });
    els.bar = h('div', { class: 'bar' });
    els.progLabel = h('span', { class: 'prog-label' });
    els.cancel = h('button', { class: 'link', onclick: () => cancelScan() }, 'Huỷ');
    els.progress = h('div', { class: 'progress hidden' }, h('div', { class: 'track' }, els.bar), els.progLabel, els.cancel);
    els.status = h('div', { class: 'status' });
    els.results = h('div', { class: 'results', role: 'listbox' });
    els.header = h('div', { class: 'header', title: 'Kéo để di chuyển' },
      h('span', { class: 'title' }, 'Canvas Finder'), els.mode,
      h('span', { class: 'spacer' }), els.deep, els.rescan, els.close);

    els.panel = h('div', { class: 'panel' },
      els.header,
      h('div', { class: 'row' }, els.input, els.counter, els.prev, els.next),
      h('div', { class: 'row opts' }, ...els.opts),
      els.progress, els.status, els.results);
    shadow.append(els.panel);

    els.input.addEventListener('input', () => searchSoon());
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); select(ui.current + (e.shiftKey ? -1 : 1)); }
      else if (e.key === 'Escape') { e.preventDefault(); closeUi(); }
    });
    // Chặn phím lọt ra trang (tránh kích hoạt phím tắt của trang khi đang gõ).
    for (const t of ['keydown', 'keyup', 'keypress']) uiHost.addEventListener(t, (e) => e.stopPropagation());
    makeDraggable(els.header, uiHost);
    document.documentElement.appendChild(uiHost);
    uiHost.style.visibility = 'visible';
  }

  function makeDraggable(handle, host) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; handle.setPointerCapture(e.pointerId);
      const r = host.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const x = Math.min(Math.max(0, ox + e.clientX - sx), innerWidth - 80);
      const y = Math.min(Math.max(0, oy + e.clientY - sy), innerHeight - 40);
      host.style.left = x + 'px'; host.style.top = y + 'px'; host.style.right = 'auto';
    });
    const end = () => { dragging = false; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function renderOptions() {
    for (const b of els.opts) b.classList.toggle('on', !!currentSettings[b.dataset.key]);
    const names = { auto: 'Tự động', dom: 'Chỉ DOM', adapter: 'Chỉ Adapter', ocr: 'Chỉ OCR', all: 'Mọi tầng' };
    els.mode.textContent = names[currentSettings.scanMode] || '';
  }

  function renderCounter() {
    els.counter.textContent = ui.matches.length ? `${ui.current + 1}/${ui.matches.length}${ui.matches.length >= MAX_MATCHES ? '+' : ''}` : '0/0';
    els.counter.classList.toggle('none', !!els.input.value.trim() && !ui.matches.length);
  }

  function renderStatus(text) {
    if (!els.status) return;
    if (text) { els.status.textContent = text; return; }
    if (ui.error) { els.status.textContent = ui.error; els.status.classList.add('err'); return; }
    els.status.classList.remove('err');
    const by = {};
    for (const e of ui.index) by[e.source] = (by[e.source] || 0) + 1;
    const parts = Object.entries(by).map(([k, v]) => `${k} ${v}`);
    els.status.textContent = ui.index.length
      ? `${ui.index.length} đoạn văn bản · ${parts.join(' · ')}`
      : (ui.scanning ? 'Đang quét…' : 'Không tìm thấy văn bản ẩn nào. Thử nút OCR để quét sâu.');
  }

  function renderProgress(label, frac) {
    if (!els.progress) return;
    if (label == null) { els.progress.classList.add('hidden'); return; }
    els.progress.classList.remove('hidden');
    els.progLabel.textContent = label;
    els.bar.style.width = Math.round(Math.max(0.03, Math.min(1, frac || 0)) * 100) + '%';
  }

  function renderAggregateProgress() {
    if (!ui.scanning) return;
    let done = 0, total = 0, label = '';
    for (const [k, p] of ui.frameProgress) {
      if (typeof k === 'string') continue;
      done += p.done || 0; total += p.total || 0;
      if (p.label) label = p.label;
    }
    const frames = ui.expected.size > 1 ? ` · ${ui.expected.size} frame` : '';
    renderProgress(label + frames, total ? done / total : 0.05);
  }

  function snippet(text, start, end) {
    const R = 40;
    const a = Math.max(0, start - R), b = Math.min(text.length, end + R);
    const frag = document.createDocumentFragment();
    frag.append((a > 0 ? '…' : '') + text.slice(a, start));
    frag.append(h('b', {}, text.slice(start, end)));
    frag.append(text.slice(end, b) + (b < text.length ? '…' : ''));
    return frag;
  }

  const MAX_ROWS = 300;
  function renderResults() {
    renderCounter();
    renderStatus();
    els.results.replaceChildren();
    const list = ui.matches.slice(0, MAX_ROWS);
    list.forEach((m, i) => {
      const src = m.entry.source;
      const cls = src === 'OCR' ? 'ocr' : src.startsWith('Adapter') ? 'adapter' : 'dom';
      const badge = h('span', { class: 'badge ' + cls, title: src === 'OCR' && m.entry.conf != null ? `Độ tin cậy OCR: ${m.entry.conf}%` : src }, src);
      const row = h('div', { class: 'item', role: 'option', 'data-i': String(i) }, badge);
      if (m.entry.frameId !== 0) row.append(h('span', { class: 'badge frame', title: 'Nằm trong iframe' }, 'iframe'));
      row.append(h('span', { class: 'snip' }, snippet(m.entry.text, m.start, m.end)));
      row.addEventListener('click', () => select(i, false));
      els.results.append(row);
    });
    if (ui.matches.length > MAX_ROWS) {
      els.results.append(h('div', { class: 'more' }, `… và ${ui.matches.length - MAX_ROWS} kết quả nữa (dùng ↑/↓ để duyệt)`));
    }
    markActiveRow(false);
  }

  function markActiveRow(scroll) {
    els.results.querySelectorAll('.item.active').forEach((r) => r.classList.remove('active'));
    const row = els.results.querySelector(`.item[data-i="${ui.current}"]`);
    if (row) { row.classList.add('active'); if (scroll !== false) row.scrollIntoView({ block: 'nearest' }); }
  }

  async function openUi() {
    if (!uiHost || !uiHost.isConnected) { await buildUi(); }
    uiHost.style.display = '';
    ui.open = true;
    renderOptions();
    els.input.focus();
    els.input.select();
    if (!ui.index.length && !ui.scanning || ui.scannedUrl !== location.href) startScan();
    else searchSoon(0);
  }

  function closeUi() {
    ui.open = false;
    if (uiHost) uiHost.style.display = 'none';
    if (ui.scanning) cancelScan(true);
    broadcastClear();
  }

  teardown = () => {
    clearHighlight();
    try { uiHost && uiHost.remove(); overlayHost && overlayHost.remove(); } catch (e) { /* ignore */ }
  };

  /* ---------------- Cài đặt ---------------- */

  chrome.storage.sync.get(DEFAULT_SETTINGS).then((s) => { currentSettings = { ...DEFAULT_SETTINGS, ...s }; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) currentSettings[k] = v.newValue;
    if (ui.open) { renderOptions(); searchSoon(0); }
  });
})();
