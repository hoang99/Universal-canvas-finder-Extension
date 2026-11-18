/**
 * Adapter GoJS — đọc TextBlock của mọi Node/Link trong mọi Diagram.
 *
 * Hỗ trợ cả sơ đồ "ảo hoá" (virtualized, theo mẫu Virtualized của GoJS):
 * trang giữ TOÀN BỘ dữ liệu trong một Model riêng (vd. window.myTreeModel,
 * mỗi node data có `bounds` = go.Rect trong toạ độ document), còn diagram.model
 * chỉ chứa những node đang nằm trong khung nhìn. Khi đó chỉ đọc Node đã vẽ sẽ
 * bỏ sót gần hết. Adapter tìm Model ảo đó, dựng chữ của từng node bằng cách
 * gán data vào bản sao của node template (đúng chữ như khi được vẽ), và khi
 * người dùng chọn kết quả thì centerRect(bounds) để trang tự vẽ node ra.
 */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;

  const MAX_VIRTUAL = 50000;

  function diagrams() {
    const go = window.go;
    const out = new Set();
    document.querySelectorAll('div').forEach((div) => {
      try { const d = go.Diagram.fromDiv(div); if (d) out.add(d); } catch (e) { /* ignore */ }
    });
    return [...out];
  }

  function textBlocks(obj, out) {
    const go = window.go;
    if (obj instanceof go.TextBlock) {
      if (obj.text && obj.visible !== false && (!obj.isVisibleObject || obj.isVisibleObject())) out.push(obj);
    } else if (obj instanceof go.Panel) {
      if (obj.visible === false) return;
      const it = obj.elements;
      while (it.next()) textBlocks(it.value, out);
    }
  }

  function docRectToView(diagram, b) {
    const go = window.go;
    const p1 = diagram.transformDocToView(new go.Point(b.x, b.y));
    const p2 = diagram.transformDocToView(new go.Point(b.x + b.width, b.y + b.height));
    const r = diagram.div.getBoundingClientRect();
    return { x: r.left + p1.x, y: r.top + p1.y, w: p2.x - p1.x, h: p2.y - p1.y };
  }

  /**
   * Bounds của GraphObject trong toạ độ document.
   * getDocumentBounds() chỉ có từ GoJS 1.7 → bản cũ (vd. 1.6) dùng getDocumentPoint
   * ở hai góc; cuối cùng lùi về actualBounds của Part chứa nó.
   */
  function docBounds(obj) {
    const go = window.go;
    if (typeof obj.getDocumentBounds === 'function') {
      const b = obj.getDocumentBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
    if (typeof obj.getDocumentPoint === 'function') {
      const a = obj.getDocumentPoint(go.Spot.TopLeft);
      const c = obj.getDocumentPoint(go.Spot.BottomRight);
      const x = Math.min(a.x, c.x), y = Math.min(a.y, c.y);
      const w = Math.abs(c.x - a.x), h = Math.abs(c.y - a.y);
      if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) return { x, y, width: w, height: h };
    }
    const b = (obj.part || obj).actualBounds;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  const viewBBox = (diagram, tb) => docRectToView(diagram, docBounds(tb));

  /** Đọc bounds của node data trong Model ảo (go.Rect hoặc {x,y,width,height}). */
  function dataBounds(data) {
    const b = data && data.bounds;
    if (!b) return null;
    const x = +b.x, y = +b.y, w = +(b.width ?? b.w), h = +(b.height ?? b.h);
    return [x, y, w, h].every(Number.isFinite) && w > 0 && h > 0 ? { x, y, width: w, height: h } : null;
  }

  /**
   * Tìm các Model "ảo": go.Model không phải model của diagram nào, có node data
   * mang `bounds`, và chứa (cùng object hoặc cùng key) dữ liệu của diagram.
   * Trả về Map(diagram → model).
   */
  function virtualModels(ds) {
    const go = window.go;
    const result = new Map();
    const own = new Set(ds.map((d) => d.model));
    let models = [];
    try {
      models = UCF.helpers.scanGlobals((v) => v instanceof go.Model && !own.has(v)
        && Array.isArray(v.nodeDataArray) && v.nodeDataArray.length > 0 && !!dataBounds(v.nodeDataArray[0]), 10);
    } catch (e) { return result; }
    for (const m of models) {
      let target = null;
      // 1) Diagram có data trùng object/key với model ảo
      for (const d of ds) {
        const arr = d.model.nodeDataArray;
        if (!arr.length) continue;
        const sample = arr[0];
        let found = null;
        try { found = m.findNodeDataForKey(d.model.getKeyForNodeData(sample)); } catch (e) { /* ignore */ }
        if (found && (found === sample || found === arr[0])) { target = d; break; }
      }
      // 2) Không có node nào đang vẽ → chọn diagram lớn nhất có template phù hợp
      if (!target) {
        const cat = m.getCategoryForNodeData(m.nodeDataArray[0]);
        const cand = ds.filter((d) => d.nodeTemplateMap.has(cat) || cat === '');
        cand.sort((a, b) => b.div.clientWidth * b.div.clientHeight - a.div.clientWidth * a.div.clientHeight);
        target = cand[0] || null;
      }
      if (target && !result.has(target)) result.set(target, m);
    }
    return result;
  }

  /** Lấy chữ của node data bằng cách gán vào bản sao template (đúng binding của trang). */
  function makeTextOf(d, m) {
    const copies = new Map();
    return (data) => {
      let cat = '';
      try { cat = m.getCategoryForNodeData(data) || ''; } catch (e) { /* ignore */ }
      let p = copies.get(cat);
      if (p === undefined) {
        p = null;
        try {
          const tpl = d.nodeTemplateMap.getValue(cat) || d.nodeTemplate;
          if (tpl) p = tpl.copy();
        } catch (e) { p = null; }
        copies.set(cat, p);
      }
      const texts = [];
      if (p) {
        try {
          p.data = data;
          const tbs = [];
          textBlocks(p, tbs);
          for (const tb of tbs) texts.push(tb.text);
        } catch (e) { /* binding lỗi → dùng fallback */ }
      }
      if (!texts.length) {
        // Fallback: các trường chuỗi/số của data (bỏ thuộc tính nội bộ)
        for (const [k, v] of Object.entries(data)) {
          if (k.startsWith('_') || k === '__gohashid') continue;
          if (typeof v === 'string' && v.trim()) texts.push(v);
          else if (typeof v === 'number' && k !== m.nodeKeyProperty) texts.push(String(v));
        }
      }
      return texts;
    };
  }

  function findRenderedTextBlock(d, key, text) {
    const node = d.findNodeForKey(key);
    if (!node) return { node: null, tb: null };
    const tbs = [];
    textBlocks(node, tbs);
    return { node, tb: tbs.find((t) => t.text === text) || null };
  }

  UCF.register({
    name: 'GoJS',
    detect: () => !!(window.go && window.go.Diagram && window.go.Diagram.fromDiv),

    extractTexts() {
      const out = [];
      const ds = diagrams();
      const virt = virtualModels(ds);
      for (const d of ds) {
        const vm = virt.get(d);
        if (vm) {
          // Sơ đồ ảo hoá: đọc từ Model đầy đủ (bao gồm cả node đang vẽ)
          const textOf = makeTextOf(d, vm);
          const arr = vm.nodeDataArray;
          for (let i = 0; i < arr.length && i < MAX_VIRTUAL; i++) {
            const data = arr[i];
            const b = dataBounds(data);
            const key = vm.getKeyForNodeData(data);
            for (const text of textOf(data)) {
              out.push({ text, bbox: b ? docRectToView(d, b) : null, ref: { d, key, data, text, virtual: true }, host: d.div });
            }
          }
        }
        const colls = vm ? [d.links] : [d.nodes, d.links];
        for (const coll of colls) {
          const it = coll.iterator;
          while (it.next()) {
            const part = it.value;
            const tbs = [];
            textBlocks(part, tbs);
            for (const tb of tbs) {
              out.push({ text: tb.text, bbox: viewBBox(d, tb), ref: { d, part, tb }, host: d.div });
            }
          }
        }
      }
      return out;
    },

    scrollTo({ ref }) {
      const { d } = ref;
      if (ref.virtual) {
        const b = dataBounds(ref.data);
        if (b) d.centerRect(new window.go.Rect(b.x, b.y, b.width, b.height));
        return;
      }
      if (d.commandHandler && d.commandHandler.scrollToPart) d.commandHandler.scrollToPart(ref.part);
      else d.centerRect(ref.part.actualBounds);
    },

    highlight({ ref }) {
      if (ref.virtual) {
        const n = ref.d.findNodeForKey(ref.key);
        if (n) ref.d.select(n);
        return;
      }
      ref.d.select(ref.part);
    },

    getBBox({ ref }) {
      const { d } = ref;
      if (ref.virtual) {
        // Sau centerRect trang đã vẽ node → chọn node và lấy đúng vị trí TextBlock
        const { node, tb } = findRenderedTextBlock(d, ref.key, ref.text);
        if (node) { try { d.select(node); } catch (e) { /* ignore */ } }
        if (tb) return viewBBox(d, tb);
        if (node) return docRectToView(d, node.actualBounds);
        const b = dataBounds(ref.data);
        return b ? docRectToView(d, b) : null;
      }
      return viewBBox(d, ref.tb);
    },

    observe(cb) {
      const ds = diagrams();
      const fire = (e) => { if (e.isTransactionFinished) cb(); };
      for (const d of ds) d.addModelChangedListener(fire);
      for (const m of virtualModels(ds).values()) {
        try { m.addChangedListener(fire); } catch (e) { /* ignore */ }
      }
    },
  });
})();
