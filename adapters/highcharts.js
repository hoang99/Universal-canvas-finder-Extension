/** Adapter Highcharts — title, subtitle, categories, tên series và điểm dữ liệu. */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;
  const { helpers } = UCF;

  const charts = () => ((window.Highcharts && window.Highcharts.charts) || []).filter((c) => c && c.container);

  function toPage(chart, x, y, w, h) {
    const r = chart.container.getBoundingClientRect();
    return { x: r.left + x, y: r.top + y, w, h };
  }

  UCF.register({
    name: 'Highcharts',
    detect: () => charts().length > 0,
    extractTexts() {
      const out = [];
      for (const chart of charts()) {
        const host = chart.container;
        const whole = helpers.rect(host);
        const push = (text, ref, bbox) => { const t = helpers.stripHtml(helpers.str(text)); if (t.trim()) out.push({ text: t, bbox: bbox || whole, ref: { chart, ...ref }, host }); };
        const elBox = (svgEl) => { try { return svgEl && svgEl.element ? helpers.rect(svgEl.element) : null; } catch (e) { return null; } };

        push(chart.title && chart.title.textStr, {}, elBox(chart.title));
        push(chart.subtitle && chart.subtitle.textStr, {}, elBox(chart.subtitle));
        [...(chart.xAxis || []), ...(chart.yAxis || [])].forEach((ax) => {
          push(ax.axisTitle && ax.axisTitle.textStr, {}, elBox(ax.axisTitle));
          (ax.categories || []).forEach((c, i) => {
            const tick = ax.ticks && ax.ticks[i] && ax.ticks[i].label;
            push(c, {}, elBox(tick));
          });
        });
        (chart.series || []).forEach((s) => {
          push(s.name, { series: s }, elBox(s.legendItem && (s.legendItem.label || s.legendItem)));
          (s.points || []).slice(0, 3000).forEach((p) => {
            const name = p.name ?? p.category;
            const text = [helpers.str(name), p.y != null ? p.y : ''].filter((x) => x !== '').join(': ');
            const bbox = Number.isFinite(p.plotX)
              ? (chart.inverted
                ? toPage(chart, chart.plotLeft + chart.plotWidth - p.plotY - 10, chart.plotTop + chart.plotHeight - p.plotX - 10, 20, 20)
                : toPage(chart, chart.plotLeft + p.plotX - 10, chart.plotTop + (p.plotY || 0) - 10, 20, 20))
              : whole;
            push(text, { point: p }, bbox);
          });
        });
      }
      return out;
    },
    highlight({ ref }) {
      const p = ref.point;
      if (!p) return;
      if (p.onMouseOver) p.onMouseOver();
      else if (ref.chart.tooltip) ref.chart.tooltip.refresh(p);
    },
  });
})();
