/** Adapter JointJS / JointJS+ (Rappid) — attrs.*.text của element và nhãn của link. */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;
  const { helpers } = UCF;

  const isPaper = (v) => v && v.model && typeof v.model.getElements === 'function' && typeof v.findViewByModel === 'function' && v.el;

  function papers() {
    const set = new Set(helpers.scanGlobals(isPaper));
    const views = window.joint && window.joint.mvc && window.joint.mvc.views;
    if (views) Object.values(views).forEach((v) => { if (isPaper(v)) set.add(v); });
    return [...set];
  }

  /** Gom mọi trường "text" trong attrs (label/text, headerText/text, ...). */
  function collectTexts(obj, out, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return;
    for (const [k, v] of Object.entries(obj)) {
      if ((k === 'text' || k === 'textWrap') && (typeof v === 'string' || typeof v === 'number')) out.push(String(v));
      else if (k === 'textWrap' && v && typeof v.text === 'string') out.push(v.text);
      else if (typeof v === 'object') collectTexts(v, out, depth + 1);
    }
  }

  let lastHl = null;
  UCF.register({
    name: 'JointJS',
    detect: () => !!window.joint && papers().length > 0,
    extractTexts() {
      const out = [];
      for (const paper of papers()) {
        const cells = [...paper.model.getElements(), ...paper.model.getLinks()];
        for (const cell of cells) {
          const texts = [];
          collectTexts(cell.get('attrs'), texts);
          (cell.get('labels') || []).forEach((l) => collectTexts(l.attrs, texts));
          const view = paper.findViewByModel(cell);
          for (const t of new Set(texts)) {
            out.push({ text: t, bbox: view ? helpers.rect(view.el) : null, ref: { paper, cell, view }, host: paper.el });
          }
        }
      }
      return out;
    },
    scrollTo({ ref }) { if (ref.view) ref.view.el.scrollIntoView({ block: 'center', inline: 'center' }); },
    highlight({ ref }) {
      const v = ref.view;
      if (!v) return;
      try {
        if (lastHl) { lastHl(); lastHl = null; }
        const H = window.joint.highlighters;
        if (H && H.mask) { H.mask.add(v, 'root', 'ucf-hl'); lastHl = () => H.mask.remove(v, 'ucf-hl'); }
        else if (v.highlight) { v.highlight(); lastHl = () => v.unhighlight(); }
      } catch (e) { /* ignore */ }
    },
    getBBox({ ref }) { return ref.view ? helpers.rect(ref.view.el) : null; },
    observe(cb) { for (const p of papers()) p.model.on('add remove change:attrs change:labels', cb); },
  });
})();
