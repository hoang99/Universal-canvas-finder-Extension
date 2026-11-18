/** Adapter PixiJS — Text / BitmapText / HTMLText trong cây display object. */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;
  const { helpers } = UCF;

  const isApp = (v) => v && v.stage && v.renderer && (v.renderer.view || v.renderer.canvas);

  function apps() {
    const set = new Set();
    if (isApp(window.__PIXI_APP__)) set.add(window.__PIXI_APP__); // quy ước của PixiJS DevTools
    if (window.__PIXI_STAGE__ && window.__PIXI_RENDERER__) set.add({ stage: window.__PIXI_STAGE__, renderer: window.__PIXI_RENDERER__ });
    helpers.scanGlobals(isApp, 5).forEach((a) => set.add(a));
    return [...set];
  }

  function canvasOf(app) {
    const r = app.renderer;
    const v = r.canvas || r.view;
    return v && v.canvas instanceof HTMLCanvasElement ? v.canvas : v;
  }

  function walk(obj, out, depth = 0) {
    if (!obj || depth > 40) return;
    if (typeof obj.text === 'string' && obj.text && obj.visible !== false) out.push(obj);
    for (const c of obj.children || []) walk(c, out, depth + 1);
  }

  function bbox(app, node) {
    const canvas = canvasOf(app);
    const r = canvas.getBoundingClientRect();
    const screenW = (app.renderer.screen && app.renderer.screen.width) || r.width;
    const k = r.width / screenW;
    const b = node.getBounds();
    const rect = b.rectangle || b; // v8 Bounds | v7 Rectangle
    return { x: r.left + rect.x * k, y: r.top + rect.y * k, w: rect.width * k, h: rect.height * k };
  }

  UCF.register({
    name: 'PixiJS',
    detect: () => apps().length > 0,
    extractTexts() {
      const out = [];
      for (const app of apps()) {
        const host = canvasOf(app);
        if (!(host instanceof Element)) continue;
        const list = [];
        walk(app.stage, list);
        for (const n of list) out.push({ text: n.text, bbox: bbox(app, n), ref: { app, n }, host });
      }
      return out;
    },
    getBBox({ ref }) { return bbox(ref.app, ref.n); },
  });
})();
