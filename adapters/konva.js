/** Adapter Konva — Konva.stages[].find('Text') và TextPath. */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;

  function bbox(stage, node) {
    const r = stage.container().getBoundingClientRect();
    const b = node.getClientRect(); // toạ độ trong stage (CSS px)
    const k = r.width / (stage.width() || r.width);
    return { x: r.left + b.x * k, y: r.top + b.y * k, w: b.width * k, h: b.height * k };
  }

  UCF.register({
    name: 'Konva',
    detect: () => !!(window.Konva && window.Konva.stages && window.Konva.stages.length),
    extractTexts() {
      const out = [];
      for (const stage of window.Konva.stages) {
        const nodes = [...stage.find('Text'), ...stage.find('TextPath')];
        for (const n of nodes) {
          if (n.isVisible && !n.isVisible()) continue;
          out.push({ text: n.text(), bbox: bbox(stage, n), ref: { stage, n }, host: stage.container() });
        }
      }
      return out;
    },
    getBBox({ ref }) { return bbox(ref.stage, ref.n); },
    observe(cb) {
      // Konva không có sự kiện "model changed" chung; theo dõi thay đổi text.
      for (const stage of window.Konva.stages) stage.find('Text').forEach((n) => n.on('textChange', cb));
    },
  });
})();
