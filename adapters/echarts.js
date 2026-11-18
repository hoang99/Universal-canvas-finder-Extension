/** Adapter Apache ECharts — title, legend, nhãn trục category, series & dữ liệu. */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;
  const { helpers } = UCF;

  function instances() {
    const ec = window.echarts;
    if (!ec || !ec.getInstanceByDom) return [];
    return [...document.querySelectorAll('[_echarts_instance_]')]
      .map((dom) => { try { return ec.getInstanceByDom(dom); } catch (e) { return null; } })
      .filter(Boolean);
  }

  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  function pointBBox(inst, seriesIndex, value, whole) {
    try {
      const p = inst.convertToPixel({ seriesIndex }, value);
      if (Array.isArray(p) && Number.isFinite(p[0])) {
        const r = inst.getDom().getBoundingClientRect();
        return { x: r.left + p[0] - 12, y: r.top + p[1] - 12, w: 24, h: 24 };
      }
    } catch (e) { /* pie, map... */ }
    return whole;
  }

  let last = null;
  UCF.register({
    name: 'ECharts',
    detect: () => instances().length > 0,
    extractTexts() {
      const out = [];
      for (const inst of instances()) {
        const host = inst.getDom();
        const whole = helpers.rect(host);
        const opt = inst.getOption() || {};
        const push = (text, ref, bbox) => { const t = helpers.str(text); if (t) out.push({ text: t, bbox: bbox || whole, ref: { inst, ...ref }, host }); };

        arr(opt.title).forEach((t) => { push(t.text, {}); push(t.subtext, {}); });
        arr(opt.legend).forEach((l) => arr(l.data).forEach((d) => push(d, {})));
        const cats = [];
        ['xAxis', 'yAxis', 'angleAxis', 'radiusAxis'].forEach((k) => arr(opt[k]).forEach((ax) => {
          push(ax.name, {});
          if (ax.type === 'category' || ax.data) { arr(ax.data).forEach((d) => push(d, {})); cats.push(arr(ax.data)); }
        }));
        arr(opt.series).forEach((s, si) => {
          push(s.name, { seriesIndex: si });
          arr(s.data).slice(0, 3000).forEach((d, di) => {
            const name = d && typeof d === 'object' && !Array.isArray(d) ? d.name : (cats[0] && helpers.str(cats[0][di]));
            const val = d && typeof d === 'object' && !Array.isArray(d) ? d.value : d;
            const text = [name, helpers.str(val)].filter(Boolean).join(': ');
            const coord = Array.isArray(val) ? val : [cats[0] ? cats[0][di] && helpers.str(cats[0][di]) : di, val];
            push(text, { seriesIndex: si, dataIndex: di }, pointBBox(inst, si, coord, whole));
          });
        });
      }
      return out;
    },
    highlight({ ref }) {
      const { inst, seriesIndex, dataIndex } = ref;
      if (seriesIndex == null) return;
      if (last) { try { last.inst.dispatchAction({ type: 'downplay', seriesIndex: last.seriesIndex, dataIndex: last.dataIndex }); } catch (e) { /* ignore */ } }
      inst.dispatchAction({ type: 'highlight', seriesIndex, dataIndex });
      if (dataIndex != null) inst.dispatchAction({ type: 'showTip', seriesIndex, dataIndex });
      last = ref;
    },
  });
})();
