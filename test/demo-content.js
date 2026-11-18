/**
 * Nội dung trang demo: chữ nằm ở những chỗ Ctrl+F không tìm được.
 * Dùng chung cho test/demo.html (thử với extension thật) và test/harness.html (tự kiểm thử).
 */
(function () {
  function section(title) {
    const s = document.createElement('section');
    const h = document.createElement('h2');
    h.textContent = title;
    s.appendChild(h);
    document.getElementById('app').appendChild(s);
    return s;
  }
  function drawText(canvas, lines, opts) {
    const ctx = canvas.getContext('2d');
    if (!opts || !opts.transparent) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.fillStyle = '#222';
    ctx.font = 'bold 28px Arial, sans-serif';
    lines.forEach(([t, x, y]) => ctx.fillText(t, x, y));
  }

  // 1. Canvas 2D
  const s1 = section('1. Canvas 2D (OCR)');
  const c1 = document.createElement('canvas');
  c1.width = 640; c1.height = 160;
  s1.appendChild(c1);
  drawText(c1, [['Invoice Number 12345', 20, 60], ['Xin chào thế giới', 20, 120]]);

  // 2. Canvas trong suốt
  const s2 = section('2. Canvas nền trong suốt (OCR)');
  const c2 = document.createElement('canvas');
  c2.width = 520; c2.height = 90;
  s2.appendChild(c2);
  drawText(c2, [['Transparent Golf Hotel', 20, 55]], { transparent: true });

  // 3. SVG <text>
  const s3 = section('3. SVG <text> (DOM)');
  s3.insertAdjacentHTML('beforeend',
    '<svg width="520" height="90" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="5" width="300" height="70" rx="8" fill="#e3f2fd"/>'
    + '<text x="20" y="48" font-size="22">Sơ đồ <tspan font-weight="bold">Alpha</tspan> Node</text></svg>');

  // 4. <img> (ảnh chụp chữ) + alt
  const s4 = section('4. Ảnh <img> (OCR) và alt (DOM)');
  const tmp = document.createElement('canvas');
  tmp.width = 560; tmp.height = 90;
  drawText(tmp, [['Image Text Bravo Kilo', 20, 58]]);
  const img = new Image();
  img.src = tmp.toDataURL();
  img.alt = 'Ảnh minh hoạ Juliet';
  s4.appendChild(img);

  // 5. Konva
  if (window.Konva) {
    const s5 = section('5. Konva (Adapter)');
    const div = document.createElement('div');
    s5.appendChild(div);
    const stage = new Konva.Stage({ container: div, width: 560, height: 120 });
    const layer = new Konva.Layer();
    layer.add(new Konva.Rect({ x: 10, y: 10, width: 300, height: 90, fill: '#e8f5e9', cornerRadius: 8 }));
    layer.add(new Konva.Text({ x: 30, y: 40, text: 'Konva Charlie Node', fontSize: 24 }));
    stage.add(layer);
  }

  // 6. Chart.js
  if (window.Chart) {
    const s6 = section('6. Chart.js (Adapter)');
    const c6 = document.createElement('canvas');
    c6.width = 560; c6.height = 240;
    c6.style.width = '560px'; c6.style.height = '240px';
    s6.appendChild(c6);
    new Chart(c6, {
      type: 'bar',
      data: { labels: ['Tháng Một', 'Tháng Hai', 'Tháng Ba'], datasets: [{ label: 'Doanh thu Echo', data: [12, 19, 7] }] },
      options: { responsive: false, animation: false },
    });
  }

  // 7. ECharts
  if (window.echarts) {
    const s7 = section('7. ECharts (Adapter)');
    const d7 = document.createElement('div');
    d7.style.cssText = 'width:560px;height:240px';
    s7.appendChild(d7);
    echarts.init(d7, null, { renderer: 'canvas' }).setOption({
      title: { text: 'Biểu đồ Foxtrot' },
      xAxis: { type: 'category', data: ['Thứ Hai', 'Thứ Ba', 'Thứ Tư'] },
      yAxis: { type: 'value' },
      series: [{ name: 'Lượt xem', type: 'line', data: [120, 200, 150] }],
      animation: false,
    });
  }

  // 8. Canvas rất cao (chữ ở cuối)
  const s8 = section('8. Canvas cao 2400px (OCR, chữ ở đáy)');
  const c8 = document.createElement('canvas');
  c8.width = 600; c8.height = 2400;
  s8.appendChild(c8);
  drawText(c8, [['Top of tall canvas', 20, 60], ['Bottom Delta Marker', 20, 2360]]);
})();
