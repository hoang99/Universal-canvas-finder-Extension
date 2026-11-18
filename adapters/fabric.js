/** Adapter Fabric.js — đối tượng text / i-text / textbox (kể cả trong group). */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;
  const { helpers } = UCF;

  const isFabricCanvas = (v) => typeof v.getObjects === 'function' && v.lowerCanvasEl instanceof HTMLCanvasElement;

  function canvases() {
    const set = new Set(helpers.scanGlobals(isFabricCanvas));
    // Một số app giữ instance trên phần tử canvas.
    document.querySelectorAll('canvas').forEach((c) => {
      for (const k of ['__canvas', 'fabric', '__fabric']) {
        try { if (c[k] && isFabricCanvas(c[k])) set.add(c[k]); } catch (e) { /* ignore */ }
      }
    });
    return [...set];
  }

  function walk(objs, out) {
    for (const o of objs || []) {
      if (typeof o.text === 'string' && /text/i.test(o.type || 'text')) out.push(o);
      const kids = typeof o.getObjects === 'function' ? o.getObjects() : o._objects;
      if (kids && kids.length) walk(kids, out);
    }
  }

  function bbox(c, o) {
    const r = c.lowerCanvasEl.getBoundingClientRect();
    const k = r.width / (c.getWidth ? c.getWidth() : c.width);
    const b = o.getBoundingRect(); // đã gồm viewportTransform
    return { x: r.left + b.left * k, y: r.top + b.top * k, w: b.width * k, h: b.height * k };
  }

  UCF.register({
    name: 'Fabric',
    detect: () => !!window.fabric || canvases().length > 0,
    extractTexts() {
      const out = [];
      for (const c of canvases()) {
        const list = [];
        walk(c.getObjects(), list);
        for (const o of list) out.push({ text: o.text, bbox: bbox(c, o), ref: { c, o }, host: c.wrapperEl || c.lowerCanvasEl });
      }
      return out;
    },
    highlight({ ref }) {
      if (ref.o.group) return; // không chọn được phần tử con của group
      ref.c.setActiveObject(ref.o);
      ref.c.requestRenderAll();
    },
    getBBox({ ref }) { return bbox(ref.c, ref.o); },
    observe(cb) {
      for (const c of canvases()) ['object:added', 'object:removed', 'object:modified', 'text:changed'].forEach((ev) => c.on(ev, cb));
    },
  });
})();
