/**
 * Universal Canvas Finder — chạy trong MAIN world của trang.
 *
 * Content script (isolated world) không nhìn thấy biến toàn cục của trang
 * (window.go, window.Konva, Chart.instances...). File này được background
 * inject bằng chrome.scripting.executeScript({ world: 'MAIN' }), cùng các file
 * trong adapters/. Mỗi adapter tự đăng ký qua window.__UCF_MAIN__.register().
 *
 * Giao diện adapter:
 *   name                : tên hiển thị ("GoJS")
 *   detect()            : true nếu thư viện có mặt trên trang
 *   extractTexts()      : [{ text, bbox?, ref, host }]
 *                          bbox = {x,y,w,h} theo toạ độ khung nhìn (CSS px)
 *                          ref  = đối tượng gốc của thư viện (giữ trong MAIN world)
 *                          host = phần tử DOM chứa đối tượng (div/canvas/svg)
 *   highlight(item)     : chọn/tô đối tượng bằng API của thư viện (tuỳ chọn)
 *   scrollTo(item)      : căn giữa đối tượng trong sơ đồ (tuỳ chọn)
 *   getBBox(item)       : bbox mới sau khi scrollTo (tuỳ chọn)
 *   observe(cb)         : gọi cb() khi dữ liệu thư viện thay đổi (tuỳ chọn)
 *
 * Chỉ trả về dữ liệu có thể JSON hoá cho content script; không sửa trang
 * ngoài thuộc tính data-ucf-host trên phần tử host để content script tìm lại.
 */
(() => {
  'use strict';
  if (window.__UCF_MAIN__) return;

  const adapters = [];
  const refs = new Map();      // mã → { adapter, item }
  const observed = new WeakSet();
  let refSeq = 0, hostSeq = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- Helpers dùng chung cho adapter ---------------- */

  const helpers = {
    /** Gán (hoặc đọc) mã host cho phần tử DOM. */
    hostId(el) {
      if (!el || el.nodeType !== 1) return null;
      let id = el.getAttribute('data-ucf-host');
      if (!id) { id = 'h' + (++hostSeq) + Math.random().toString(36).slice(2, 5); el.setAttribute('data-ucf-host', id); }
      return id;
    },

    rect(el) {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },

    /** Bỏ thẻ HTML khỏi nhãn (draw.io, Highcharts dùng HTML label). */
    stripHtml(s) {
      s = String(s == null ? '' : s);
      if (!/[<&]/.test(s)) return s;
      try {
        const doc = new DOMParser().parseFromString(s.replace(/<br\s*\/?>/gi, ' '), 'text/html');
        return doc.body.textContent || '';
      } catch (e) { return s.replace(/<[^>]+>/g, ' '); }
    },

    /** Chuyển giá trị bất kỳ (string, số, mảng, {name}) thành chuỗi. */
    str(v) {
      if (v == null) return '';
      if (typeof v === 'string' || typeof v === 'number') return String(v);
      if (Array.isArray(v)) return v.map(helpers.str).filter(Boolean).join(' ');
      if (typeof v === 'object') return helpers.str(v.name ?? v.label ?? v.text ?? v.value ?? '');
      return '';
    },

    /**
     * Quét biến toàn cục (2 cấp) để tìm instance thư viện mà trang không
     * đăng ký ở đâu cả (Fabric canvas, JointJS paper, mxGraph...).
     */
    scanGlobals(pred, max = 20) {
      const found = new Set();
      let names = [];
      try { names = Object.getOwnPropertyNames(window); } catch (e) { return []; }
      const visit = (v, depth) => {
        if (!v || typeof v !== 'object' || v === window || v === document || found.size >= max) return;
        let ok = false;
        try { ok = pred(v); } catch (e) { /* getter lỗi */ }
        if (ok) { found.add(v); return; }
        if (depth <= 0) return;
        // Không đi sâu vào DOM node, window, typed array
        if (v instanceof Node || v instanceof Window || ArrayBuffer.isView(v)) return;
        let keys = [];
        try { keys = Object.keys(v).slice(0, 60); } catch (e) { return; }
        for (const k of keys) {
          let c;
          try { c = v[k]; } catch (e) { continue; }
          visit(c, depth - 1);
        }
      };
      for (const n of names.slice(0, 6000)) {
        if (/^(on|webkit|chrome|__UCF)/.test(n)) continue;
        let v;
        try { v = window[n]; } catch (e) { continue; }
        if (typeof v === 'function') continue;
        visit(v, 1);
      }
      return [...found];
    },

    notifyChanged() {
      try { document.dispatchEvent(new CustomEvent('__ucf_changed')); } catch (e) { /* ignore */ }
    },
  };

  /* ---------------- API cho content script ---------------- */

  function normBBox(b) {
    if (!b) return null;
    const x = +b.x, y = +b.y, w = +(b.w ?? b.width), h = +(b.h ?? b.height);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  const api = {
    helpers,

    register(adapter) {
      if (!adapter || !adapter.name) return;
      const i = adapters.findIndex((a) => a.name === adapter.name);
      if (i >= 0) adapters[i] = adapter; else adapters.push(adapter);
    },

    list() { return adapters.map((a) => a.name); },

    /** Chạy mọi adapter phát hiện được; trả về dữ liệu JSON hoá được. */
    extract() {
      refs.clear();
      const items = [];
      const used = [];
      for (const a of adapters) {
        let ok = false;
        try { ok = !!a.detect(); } catch (e) { ok = false; }
        if (!ok) continue;
        let list = [];
        try { list = a.extractTexts() || []; } catch (e) { console.warn('[UCF] adapter', a.name, 'lỗi:', e); continue; }
        let count = 0;
        for (const it of list) {
          const text = String(it.text ?? '').replace(/\s+/g, ' ').trim();
          if (!text || !it.host) continue;
          const id = 'r' + (++refSeq);
          const bbox = normBBox(it.bbox);
          // Lưu vị trí tương đối so với host → tính lại đúng dù trang đã cuộn.
          let offset = null;
          if (bbox) {
            const hr = it.host.getBoundingClientRect();
            offset = { dx: bbox.x - hr.left, dy: bbox.y - hr.top, w: bbox.w, h: bbox.h };
          }
          refs.set(id, { adapter: a, item: it, offset });
          items.push({ ref: id, text: text.slice(0, 2000), bbox, host: helpers.hostId(it.host), adapter: a.name });
          if (++count >= 20000) break;
        }
        if (count) used.push(a.name);
        if (a.observe && !observed.has(a)) {
          observed.add(a);
          try { a.observe(() => helpers.notifyChanged()); } catch (e) { /* ignore */ }
        }
      }
      return { adapters: used, items };
    },

    /** Căn giữa + chọn đối tượng bằng API của thư viện, trả về bbox mới. */
    async reveal(id) {
      const r = refs.get(id);
      if (!r) return { error: 'ref-not-found' };
      const { adapter: a, item, offset } = r;
      try { a.scrollTo && a.scrollTo(item); } catch (e) { console.warn('[UCF] scrollTo', e); }
      try { a.highlight && a.highlight(item); } catch (e) { console.warn('[UCF] highlight', e); }
      await sleep(a.scrollTo ? 350 : 30); // chờ animation cuộn của thư viện
      let bbox = null;
      try { if (a.getBBox) bbox = a.getBBox(item); } catch (e) { /* ignore */ }
      if (!bbox && offset && item.host.isConnected) {
        const hr = item.host.getBoundingClientRect();
        bbox = { x: hr.left + offset.dx, y: hr.top + offset.dy, w: offset.w, h: offset.h };
      }
      return { bbox: normBBox(bbox) };
    },
  };

  Object.defineProperty(window, '__UCF_MAIN__', { value: api, configurable: false, enumerable: false, writable: false });
})();
