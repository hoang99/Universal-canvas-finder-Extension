/** Adapter mxGraph / maxGraph / draw.io (diagrams.net) — nhãn của vertex & edge. */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;
  const { helpers } = UCF;

  const isGraph = (v) => v && v.model && v.model.cells && typeof v.getView === 'function' && v.container;

  function graphs() {
    const set = new Set(helpers.scanGlobals((v) => isGraph(v) || isGraph(v.graph) || isGraph(v.editor && v.editor.graph)));
    const norm = new Set();
    for (const v of set) norm.add(isGraph(v) ? v : isGraph(v.graph) ? v.graph : v.editor.graph);
    // draw.io: window.EditorUi giữ danh sách instance ở một số bản build
    try { const ui = window.EditorUi && window.EditorUi.instance; if (ui && isGraph(ui.editor.graph)) norm.add(ui.editor.graph); } catch (e) { /* ignore */ }
    return [...norm];
  }

  function label(g, cell) {
    let s = '';
    try { s = g.convertValueToString ? g.convertValueToString(cell) : ''; } catch (e) { /* ignore */ }
    if (!s && cell.value != null) {
      s = typeof cell.value === 'string' ? cell.value
        : (cell.value.getAttribute && (cell.value.getAttribute('label') || cell.value.getAttribute('value'))) || '';
    }
    return helpers.stripHtml(s);
  }

  function bbox(g, cell) {
    const st = g.view.getState(cell);
    if (!st) return null;
    const c = g.container;
    const r = c.getBoundingClientRect();
    const tb = st.text && st.text.boundingBox;
    const b = tb && tb.width > 0 ? tb : st;
    return { x: r.left + b.x - c.scrollLeft, y: r.top + b.y - c.scrollTop, w: b.width, h: b.height };
  }

  UCF.register({
    name: 'mxGraph',
    detect: () => !!(window.mxGraph || window.mxClient || window.Graph) && graphs().length > 0,
    extractTexts() {
      const out = [];
      for (const g of graphs()) {
        for (const cell of Object.values(g.model.cells)) {
          if (!cell || !(cell.vertex || cell.edge)) continue;
          const text = label(g, cell);
          if (text.trim()) out.push({ text, bbox: bbox(g, cell), ref: { g, cell }, host: g.container });
        }
      }
      return out;
    },
    scrollTo({ ref }) { ref.g.scrollCellToVisible(ref.cell, true); },
    highlight({ ref }) { ref.g.setSelectionCell(ref.cell); },
    getBBox({ ref }) { return bbox(ref.g, ref.cell); },
    observe(cb) { for (const g of graphs()) g.model.addListener('change', cb); },
  });
})();
