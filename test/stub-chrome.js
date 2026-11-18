/**
 * Kiểm thử không cần cài extension: giả lập chrome.* và background trong cùng một trang.
 * content.js, injected.js, adapters/*.js và ocr-worker.js (Tesseract thật) chạy như trong extension;
 * chỉ captureVisibleTab là không có (trả lỗi → bỏ qua).
 */
(function () {
  const ROOT = '../';
  const listeners = { content: [], offscreen: [] };
  const store = {};
  const changeListeners = [];

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }

  function deliver(list, msg) {
    return new Promise((resolve) => {
      let responded = false;
      for (const fn of list) {
        const keep = fn(msg, { id: 'stub' }, (r) => { responded = true; resolve(r); });
        if (keep === true) return;
      }
      if (!responded) resolve(undefined);
    });
  }

  let injected = false;
  async function background(msg, from) {
    switch (msg.type) {
      case 'start-scan': return { frames: [self.__UCF__.startFrameScan(msg.scanId, msg.settings) ? 0 : -1] };
      case 'to-all-frames': await deliver(listeners.content, msg.payload); return { ok: true };
      case 'to-frame': return deliver(listeners.content, msg.payload);
      case 'main-inject':
        if (!injected) {
          const list = await (await fetch(ROOT + 'adapters/index.json')).json();
          await loadScript(ROOT + 'injected.js');
          for (const f of list) await loadScript(ROOT + 'adapters/' + f);
          injected = true;
        }
        return { ok: true };
      case 'main-call': {
        const api = window.__UCF_MAIN__;
        return api[msg.fn](...(msg.args || []));
      }
      case 'capture': return { error: 'capture không có trong harness' };
      case 'fetch-image': {
        const r = await fetch(msg.url); const b = await r.blob();
        return { dataUrl: await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); }) };
      }
      case 'ocr': {
        window.__ocrCalls = (window.__ocrCalls || 0) + 1;
        return deliver(listeners.offscreen, { ...msg, target: 'offscreen', tabId: 1, frameId: 0 });
      }
      case 'ocr-cancel': return deliver(listeners.offscreen, { target: 'offscreen', type: 'cancel', scanId: msg.scanId });
      case 'ocr-progress': deliver(listeners.content, { type: 'ocr-progress', jobId: msg.jobId, progress: msg.progress }); return {};
      default: return { error: 'stub: ' + msg.type };
    }
  }

  window.__ucfLog = [];
  const runtime = {
    id: 'stub',
    getURL: (p) => new URL(ROOT + p, location.href).href,
    sendMessage(msg) {
      window.__ucfLog.push(msg.type);
      return background(msg).catch((e) => ({ error: String(e) }));
    },
    onMessage: {
      addListener(fn) {
        // ocr-worker.js đăng ký listener có lọc target:'offscreen'; content.js thì không.
        const src = (new Error().stack || '');
        (/ocr-worker\.js/.test(src) ? listeners.offscreen : listeners.content).push(fn);
      },
    },
  };
  const sync = {
    async get(defs) { return { ...(defs || {}), ...store }; },
    async set(o) {
      const ch = {};
      for (const [k, v] of Object.entries(o)) { ch[k] = { oldValue: store[k], newValue: v }; store[k] = v; }
      changeListeners.forEach((fn) => fn(ch, 'sync'));
    },
  };
  // Giống background gửi khi người dùng nhấn Ctrl+Shift+F.
  window.__ucfOpen = () => deliver(listeners.content, { type: 'ui', action: 'open' });
  window.chrome = { runtime, storage: { sync, onChanged: { addListener: (fn) => changeListeners.push(fn) } } };
})();
