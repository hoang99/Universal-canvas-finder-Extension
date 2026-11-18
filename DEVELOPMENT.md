# Universal Canvas Finder — Tài liệu kỹ thuật

Dành cho người muốn hiểu cách extension hoạt động, thêm adapter hoặc debug.
Hướng dẫn sử dụng cho người dùng: xem [README.md](README.md).

## 1. Cách hoạt động

```
Ctrl+Shift+F ─► background.js ─► content.js (frame trên cùng: thanh tìm kiếm)
                     │                 │ start-scan
                     │                 ▼
                     ├─► content.js ở MỌI frame tự quét chính nó:
                     │      Tầng 1  DOM:     <text> SVG, alt/title/aria-label/placeholder, SVG trong <img>
                     │      Tầng 2  Adapter: injected.js + adapters/*.js chạy ở MAIN world
                     │      Tầng 3  OCR:     canvas / ảnh / bg-image / SVG dạng path / iframe "đóng"
                     │               │ ảnh (dataURL hoặc ảnh chụp tab + vùng cắt)
                     ▼               ▼
              offscreen.html + ocr-worker.js ─► Tesseract.js (Web Worker, WASM)
```

- **Chế độ Tự động**: các tầng áp dụng *theo từng phần tử*. Canvas đã có adapter đọc được → không OCR;
  SVG đã có `<text>` → không OCR; `<img src=*.svg>` có `<text>` → đọc thẳng mã SVG. Phần còn lại được OCR.
  `alt` của ảnh không chặn OCR (alt thường là mô tả, không phải chữ trong ảnh).
- Trong popup có thể **ép** chỉ dùng một tầng (DOM / Adapter / OCR) hoặc chạy tất cả.
- **Nguồn ảnh cho OCR**: `canvas.toDataURL()` → nếu canvas bị *tainted* hoặc là WebGL không giữ buffer thì
  `chrome.tabs.captureVisibleTab` + cắt theo vị trí phần tử. Ảnh lỗi CORS → background service worker tải hộ.
  Phần tử cao hơn màn hình → tự cuộn từng đoạn, chụp, rồi trả trang về vị trí cũ.
- **iframe cross-origin**: `all_frames` + `match_origin_as_fallback` cho content script chạy trong từng frame;
  frame con tính toạ độ của mình trong tab qua chuỗi `postMessage` lên frame cha. iframe không chạy được
  content script (sandbox, PDF viewer…) → frame cha chụp màn hình vùng đó.
- **Tiền xử lý OCR**: nền trắng cho ảnh trong suốt, phóng to 2× với ảnh nhỏ, chuyển xám, kéo giãn tương phản,
  đảo màu khi chữ sáng trên nền tối; ảnh lớn chia ô 1500 px chồng nhau 10%, loại từ trùng ở vùng chồng.
- **Cache** kết quả OCR theo SHA-256 của ảnh (+ ngôn ngữ, vùng cắt) trong `chrome.storage.local` (300 mục, có nút xoá).
- **Tô sáng**: overlay `position:fixed` trong Shadow DOM kín, cập nhật mỗi khung hình (requestAnimationFrame)
  nên bám theo khi cuộn/zoom/resize. OCR lưu bbox từng từ → tô đúng từ khớp; adapter dùng API của thư viện để
  căn giữa và chọn đối tượng (GoJS `scrollToPart`+`select`, mxGraph `scrollCellToVisible`, ECharts `showTip`…).
- **GoJS ảo hoá (virtualized)**: nhiều trang (vd. cây phả hệ hàng trăm node) chỉ đưa vào `diagram.model` các node
  đang trong khung nhìn, còn toàn bộ dữ liệu nằm ở một Model riêng (vd. `window.myTreeModel`, data có `bounds`).
  Adapter GoJS tự tìm Model đó, dựng chữ bằng bản sao node template (đúng như khi vẽ), và khi chọn kết quả thì
  `centerRect(bounds)` để trang vẽ node ra rồi chọn nó. Hỗ trợ cả GoJS 1.x cũ (không có `getDocumentBounds`).

## 2. Cấu trúc thư mục

| File | Vai trò |
|---|---|
| `manifest.json` | MV3: `activeTab`, `scripting`, `storage`, `offscreen`, host `<all_urls>`, phím tắt |
| `background.js` | Service worker: phím tắt, điều phối quét mọi frame, inject MAIN world, chụp tab, tải ảnh CORS, cache OCR |
| `content.js` | Chạy ở mọi frame: 3 tầng quét, overlay tô sáng; frame trên cùng có thêm thanh tìm kiếm + bộ tìm kiếm |
| `injected.js` | MAIN world: registry adapter, `extract()` và `reveal()` |
| `adapters/*.js` | Mỗi thư viện một file; `adapters/index.json` liệt kê file cần nạp |
| `offscreen.html`, `ocr-worker.js` | Offscreen document chạy Tesseract.js (bản thân nhận dạng chạy trong Web Worker) |
| `popup.html/js` | Chọn ngôn ngữ OCR, chế độ quét, tuỳ chọn; lưu bằng `chrome.storage.sync` |
| `styles.css` | CSS của thanh tìm kiếm (nạp vào Shadow DOM) |
| `lib/tesseract/` | Tesseract.js 7 + lõi WASM (LSTM) + dữ liệu `eng, vie, jpn, kor, chi_sim` (bản `best_int`) |
| `test/` | `demo.html` (thử với extension thật), `harness.html` (tự kiểm thử không cần cài extension) |

Nâng cấp Tesseract hoặc thêm ngôn ngữ: thêm gói `@tesseract.js-data/<lang>` vào `package.json`, thêm mã ngôn ngữ
vào `LANGS` trong `scripts/setup-tesseract.js`, `AVAILABLE_LANGS` trong `ocr-worker.js` và một checkbox trong
`popup.html`, rồi chạy `npm install && npm run setup`.

## 3. Thêm adapter cho thư viện khác

1. Tạo file `adapters/<ten>.js`:

```js
/** Adapter MyLib — mô tả ngắn. */
(() => {
  const UCF = window.__UCF_MAIN__;          // do injected.js tạo
  if (!UCF) return;
  const { helpers } = UCF;                  // hostId, rect, stripHtml, str, scanGlobals, notifyChanged

  UCF.register({
    name: 'MyLib',                           // hiện trong kết quả: "Adapter:MyLib"
    detect: () => !!window.MyLib,            // thư viện có trên trang không?
    extractTexts() {                         // trả về [{ text, bbox, ref, host }]
      return window.MyLib.instances.flatMap((chart) =>
        chart.labels.map((label) => ({
          text: label.text,
          bbox: { x: ..., y: ..., w: ..., h: ... }, // toạ độ KHUNG NHÌN (CSS px), hoặc null
          ref: { chart, label },             // đối tượng gốc, chỉ dùng trong MAIN world
          host: chart.container,             // phần tử DOM chứa sơ đồ (div/canvas/svg)
        })));
    },
    scrollTo(item) { item.ref.chart.centerOn(item.ref.label); },   // tuỳ chọn
    highlight(item) { item.ref.chart.select(item.ref.label); },    // tuỳ chọn
    getBBox(item) { /* bbox mới sau scrollTo */ },                  // tuỳ chọn
    observe(cb) { window.MyLib.on('change', cb); },                 // tuỳ chọn: tự quét lại
  });
})();
```

2. Thêm `"<ten>.js"` vào `adapters/index.json` (extension không liệt kê được thư mục lúc chạy, nên cần danh sách này).
3. Vào `chrome://extensions` → bấm ↻ (Reload) trên extension → tải lại trang cần thử.

Mẹo:
- Thư viện không có danh sách instance toàn cục? Dùng `helpers.scanGlobals(v => typeof v.getObjects === 'function')`
  để dò biến toàn cục (2 cấp), hoặc tìm qua DOM (ví dụ ECharts: `[_echarts_instance_]`).
- Phần tử `host` được loại khỏi OCR ở chế độ Tự động, nên trả về đúng container của sơ đồ.
- Nếu không chắc bbox, trả `null`: khi chọn kết quả, cả `host` sẽ được tô sáng.

## 4. Debug khi không tìm thấy chữ

1. **Xem dòng trạng thái** dưới ô tìm kiếm, ví dụ `24 đoạn văn bản · DOM 2 · Adapter:Konva 1 · OCR 6`.
   Nếu không có nguồn nào bạn mong đợi → xem các bước dưới.
2. **Trang dùng thư viện nào?** Mở DevTools (F12) → Console của trang, gõ:
   ```js
   ({ go: !!window.go, fabric: !!window.fabric, Konva: !!window.Konva, joint: !!window.joint,
      mxGraph: !!(window.mxGraph || window.Graph), Chart: !!window.Chart, echarts: !!window.echarts,
      Highcharts: !!window.Highcharts, PIXI: !!(window.PIXI || window.__PIXI_APP__), d3: !!window.d3 })
   ```
   Sau một lần quét, `__UCF_MAIN__.list()` liệt kê adapter đã nạp, `__UCF_MAIN__.extract()` cho thấy adapter đọc được gì.
   Nhiều trang đóng gói thư viện vào bundle mà không để biến toàn cục → adapter không thấy được → dùng OCR (nút **OCR**).
3. **Xem chỉ mục của extension**: trong Console, chọn context **Universal Canvas Finder** ở menu thả xuống
   (mặc định là `top`), gõ `__UCF__.dump()` để xem toàn bộ văn bản đã thu được. Log chi tiết ở mức *Verbose* (`[UCF] …`).
4. **Log OCR / background**: `chrome://extensions` → Universal Canvas Finder → *Inspect views: service worker*
   (log `[UCF bg]`) và *offscreen.html* (log `[UCF ocr]`, lỗi Tesseract).
5. **OCR không ra chữ**:
   - Chọn đúng ngôn ngữ trong popup (chọn ít ngôn ngữ → chính xác hơn).
   - Chữ quá nhỏ: phóng to trang (Ctrl + =) rồi bấm **OCR** — ảnh chụp tab sẽ rõ hơn.
   - Phần tử nhỏ hơn "Kích thước tối thiểu để OCR" hoặc vượt "Số phần tử OCR tối đa" → chỉnh trong popup.
   - Kết quả cũ bị cache → bấm **Xoá cache OCR** trong popup.
   - Canvas WebGL / iframe đóng chỉ OCR được **phần đang hiển thị**: tab phải đang active, cửa sổ không bị thu nhỏ.
6. **Không có gì xảy ra khi nhấn Ctrl+Shift+F**: phím tắt có thể trùng — kiểm tra `chrome://extensions/shortcuts`.
   Trang mở từ trước khi cài extension sẽ được inject tự động khi kích hoạt; nếu vẫn lỗi, tải lại trang.

## 5. Tự kiểm thử (không cần cài extension)

```bash
node scripts/serve.js
```

Mở `http://127.0.0.1:8765/test/harness.html`, bấm **Mở Finder**. Harness giả lập `chrome.*` và background trong
cùng trang, nên toàn bộ content.js, adapter và Tesseract thật đều chạy (trừ chụp màn hình tab).

## 6. Quyền riêng tư & an toàn cho trang

- Không có request mạng nào ngoài việc tải lại chính ảnh trang đang hiển thị (khi bị CORS).
- UI nằm trong Shadow DOM kín; overlay không nhận chuột; phím gõ trong ô tìm kiếm không lọt ra trang.
- Thay đổi duy nhất trên DOM của trang: thuộc tính `data-ucf-host` trên container sơ đồ (để định vị adapter).
- Tất cả lời gọi vào thư viện của trang đều nằm trong `try/catch`.

## 7. Giới hạn đã biết

- Chụp màn hình chỉ thấy phần đang hiển thị; phần tử nằm trong vùng cuộn riêng (không phải cuộn trang) chỉ OCR được phần nhìn thấy.
- `object-fit`/`transform` trên ảnh làm khung tô sáng OCR lệch nhẹ (văn bản vẫn tìm được).
- Fabric.js, JointJS, mxGraph không có danh sách instance toàn cục: adapter dò biến toàn cục 2 cấp, không thấy instance nằm trong closure.
- Đặc thù Canva/Figma/Google Slides: bản editor dùng WebGL/canvas trong iframe → đi đường OCR qua ảnh chụp tab.
