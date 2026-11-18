/**
 * Adapter D3 — D3 thường vẽ ra SVG (<text> đã được tầng DOM đọc). Adapter này
 * bổ sung dữ liệu gắn vào phần tử qua __data__ (tên vùng bản đồ, nút không có nhãn...).
 */
(() => {
  const UCF = window.__UCF_MAIN__;
  if (!UCF) return;
  const { helpers } = UCF;
  const KEYS = ['name', 'label', 'title', 'text', 'id', 'key'];

  function datumText(d) {
    if (d == null) return '';
    if (typeof d === 'string') return d;
    if (typeof d !== 'object') return '';
    const src = d.properties && typeof d.properties === 'object' ? d.properties : d.data && typeof d.data === 'object' ? d.data : d;
    for (const k of KEYS) if (typeof src[k] === 'string' && src[k].trim()) return src[k];
    return '';
  }

  UCF.register({
    name: 'D3',
    detect: () => !!window.d3,
    extractTexts() {
      const out = [];
      const seen = new Set();
      const els = document.querySelectorAll('svg *, [class] > svg');
      for (const el of els) {
        if (out.length >= 3000) break;
        if (!('__data__' in el) || el.localName === 'text' || el.localName === 'tspan') continue;
        const text = datumText(el.__data__);
        if (!text || (el.textContent || '').includes(text)) continue;
        const key = text + '|' + (el.ownerSVGElement ? '' : el.localName);
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (seen.has(key + r.left + r.top)) continue;
        seen.add(key + r.left + r.top);
        out.push({ text, bbox: helpers.rect(el), ref: { el }, host: el.ownerSVGElement || el });
      }
      return out;
    },
    getBBox({ ref }) { return helpers.rect(ref.el); },
  });
})();
