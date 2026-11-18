/** Adapter Chart.js (v2–v4) — tiêu đề, nhãn trục, tên dataset, dữ liệu tooltip. */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;
  const { helpers } = UCF;

  function charts() {
    const inst = window.Chart && window.Chart.instances;
    if (!inst) return [];
    return (inst instanceof Map ? [...inst.values()] : Object.values(inst)).filter((c) => c && c.canvas);
  }

  function toPage(chart, x, y, w, h) {
    const r = chart.canvas.getBoundingClientRect();
    const k = r.width / (chart.width || r.width);
    return { x: r.left + x * k, y: r.top + y * k, w: w * k, h: h * k };
  }

  function valueText(v) {
    if (v == null) return '';
    if (typeof v === 'object') return helpers.str(v.y ?? v.v ?? v.r ?? v.value ?? v.x);
    return String(v);
  }

  UCF.register({
    name: 'Chart.js',
    detect: () => charts().length > 0,
    extractTexts() {
      const out = [];
      for (const chart of charts()) {
        const host = chart.canvas;
        const whole = helpers.rect(host);
        const opts = chart.options || {};
        const title = (opts.plugins && opts.plugins.title && opts.plugins.title.text) || (opts.title && opts.title.text);
        if (title) out.push({ text: helpers.str(title), bbox: chart.titleBlock ? toPage(chart, chart.titleBlock.left, chart.titleBlock.top, chart.titleBlock.width, chart.titleBlock.height) : whole, ref: { chart }, host });

        const labels = (chart.data && chart.data.labels) || [];
        const scales = Object.values(chart.scales || {});
        const cat = scales.find((s) => s.type === 'category');
        labels.forEach((lab, i) => {
          let bbox = whole;
          try {
            if (cat) {
              const p = cat.getPixelForValue(i);
              bbox = cat.isHorizontal()
                ? toPage(chart, p - 30, cat.top, 60, cat.height)
                : toPage(chart, cat.left, p - 10, cat.width, 20);
            }
          } catch (e) { /* ignore */ }
          out.push({ text: helpers.str(lab), bbox, ref: { chart, index: i }, host });
        });

        const hit = chart.legend && chart.legend.legendHitBoxes;
        (chart.data.datasets || []).forEach((ds, d) => {
          const hb = hit && hit[d];
          if (ds.label) out.push({ text: ds.label, bbox: hb ? toPage(chart, hb.left, hb.top, hb.width, hb.height) : whole, ref: { chart, datasetIndex: d }, host });
          const meta = chart.getDatasetMeta ? chart.getDatasetMeta(d) : null;
          (ds.data || []).slice(0, 2000).forEach((v, i) => {
            const el = meta && meta.data && meta.data[i];
            const name = labels[i] != null ? helpers.str(labels[i]) : (ds.label || '');
            const text = `${name}: ${valueText(v)}`;
            const x = el && (el.x ?? (el._model && el._model.x)), y = el && (el.y ?? (el._model && el._model.y));
            out.push({ text, bbox: Number.isFinite(x) ? toPage(chart, x - 10, y - 10, 20, 20) : whole, ref: { chart, datasetIndex: d, index: i }, host });
          });
        });
      }
      return out;
    },
    highlight({ ref }) {
      const { chart, datasetIndex, index } = ref;
      if (datasetIndex == null || index == null || !chart.setActiveElements) return;
      const act = [{ datasetIndex, index }];
      chart.setActiveElements(act);
      if (chart.tooltip && chart.tooltip.setActiveElements) chart.tooltip.setActiveElements(act, { x: 0, y: 0 });
      chart.update();
    },
  });
})();
