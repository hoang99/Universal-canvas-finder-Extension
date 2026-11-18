# Universal Canvas Finder

**Tìm chữ mà Ctrl+F của trình duyệt không tìm được.**

Ctrl+F chỉ tìm được chữ nằm trong mã HTML của trang. Những chữ được *vẽ* ra — trên `<canvas>`, trong ảnh,
trong sơ đồ, biểu đồ, slide, file PDF nhúng… — với trình duyệt chỉ là các điểm ảnh, nên Ctrl+F bỏ qua.
Universal Canvas Finder đọc được những chữ đó, cho bạn tìm kiếm, nhảy tới và tô sáng đúng chỗ.

Mọi xử lý chạy **ngay trên máy bạn**. Extension không gửi nội dung trang hay ảnh đi đâu.

---

## Mục lục

1. [Extension làm được gì](#1-extension-làm-được-gì)
2. [Phù hợp với thư viện / trang nào](#2-phù-hợp-với-thư-viện--trang-nào)
3. [Cài đặt](#3-cài-đặt)
4. [Cách dùng](#4-cách-dùng)
5. [Cài đặt trong popup](#5-cài-đặt-trong-popup)
6. [Mẹo & câu hỏi thường gặp](#6-mẹo--câu-hỏi-thường-gặp)
7. [Giới hạn](#7-giới-hạn)

---

## 1. Extension làm được gì

### Tìm chữ ở những nơi Ctrl+F không tới

| Nơi chứa chữ | Ví dụ |
|---|---|
| Sơ đồ, biểu đồ vẽ trên `<canvas>` | Cây phả hệ, sơ đồ tổ chức, flowchart, biểu đồ doanh thu |
| Ảnh (`<img>`, ảnh nền CSS) | Ảnh chụp màn hình, banner, ảnh scan tài liệu |
| SVG | Chữ trong biểu đồ SVG, icon có chữ, SVG vẽ chữ bằng đường nét |
| iframe | Slide, PDF viewer nhúng, nội dung nhúng từ trang khác |
| Thuộc tính ẩn | `alt` của ảnh, tooltip (`title`), `aria-label`, `placeholder` |

### Ba cách đọc chữ (tự động chọn cách tốt nhất)

| Cách | Khi nào dùng | Ưu điểm | Nhược điểm |
|---|---|---|---|
| **1. DOM** | Chữ có sẵn trong mã trang (SVG, tooltip, alt…) | Tức thì, chính xác 100% | Chỉ áp dụng khi chữ có trong mã |
| **2. Adapter** | Trang dùng thư viện vẽ đã được hỗ trợ (xem mục 2) | Nhanh, chính xác 100%, tìm được cả phần **chưa hiện** trên màn hình | Chỉ cho thư viện có adapter |
| **3. OCR** | Còn lại: ảnh, canvas của thư viện lạ, iframe | Đọc được *mọi thứ nhìn thấy được* | Chậm hơn (vài giây), có thể đọc sai; chỉ đọc phần đang hiển thị |

> **OCR** (nhận dạng ký tự quang học) là kỹ thuật "nhìn" ảnh rồi đọc ra chữ. Extension dùng Tesseract.js,
> đóng gói sẵn, hỗ trợ **Tiếng Việt, English, 日本語, 한국어, 简体中文**.

Ở chế độ **Tự động**, mỗi phần tử trên trang được đọc bằng cách nhanh nhất có thể: sơ đồ nào đã đọc được
bằng adapter thì không OCR nữa.

### Tìm kiếm thông minh

- Kết quả cập nhật ngay khi gõ, có bộ đếm **3/12**.
- **Bỏ qua dấu tiếng Việt**: gõ `nguyen van cuong` vẫn ra `NGUYỄN VĂN CƯỜNG`.
- **Phân biệt hoa/thường**, **khớp toàn từ**, **biểu thức chính quy (regex)**.
- Danh sách kết quả có đoạn trích, từ khớp được in đậm, và nhãn nguồn: `DOM`, `Adapter:GoJS`, `OCR`…

### Nhảy tới và tô sáng

- Chọn một kết quả → trang cuộn tới, khung vàng tô đúng chỗ (với OCR: tô đúng **từng từ**).
- Với sơ đồ có adapter: sơ đồ **tự cuộn/căn giữa** tới đối tượng và chọn nó, kể cả khi đối tượng đang
  nằm ngoài màn hình (ví dụ một người ở cuối cây phả hệ 700+ node).
- Khung tô sáng bám theo khi cuộn trang, zoom hoặc đổi kích thước cửa sổ.

### Khác

- Thanh tìm kiếm nổi, kéo thả được, không làm vỡ giao diện trang.
- Quét lại bằng tay (nút **⟳**) hoặc tự quét lại khi nội dung trang thay đổi.
- Ghi nhớ kết quả OCR (cache) → mở lại trang cũ tìm ngay, không phải đọc lại.

---

## 2. Phù hợp với thư viện / trang nào

### Thư viện có adapter (đọc trực tiếp dữ liệu — tốt nhất)

| Thư viện | Thường gặp ở | Đọc được | Khi chọn kết quả |
|---|---|---|---|
| **GoJS** | Sơ đồ tổ chức, cây phả hệ, flowchart, backoffice MLM | Mọi chữ trên node và đường nối; hỗ trợ sơ đồ *ảo hoá* (chỉ vẽ phần đang hiện) và GoJS bản cũ 1.x | Cuộn tới node, chọn node |
| **mxGraph / draw.io** | diagrams.net, sơ đồ kỹ thuật | Nhãn của hình và đường nối | Cuộn tới, chọn ô |
| **JointJS** | Sơ đồ quy trình, BPMN | Chữ trong các phần tử | Tô viền phần tử |
| **Fabric.js** | Trình thiết kế ảnh, tạo banner, in ấn online | Đối tượng chữ (kể cả trong nhóm) | Chọn đối tượng |
| **Konva** | Trình chỉnh sửa canvas, bảng trắng | `Text`, `TextPath` | Tô vị trí |
| **PixiJS** | Game, đồ hoạ tương tác | Đối tượng chữ | Tô vị trí |
| **Chart.js** | Dashboard, báo cáo | Tiêu đề, nhãn trục, tên dataset, giá trị | Kích hoạt điểm dữ liệu |
| **ECharts** | Dashboard (rất phổ biến ở trang Trung Quốc/VN) | Tiêu đề, nhãn trục, series, giá trị | Hiện tooltip điểm dữ liệu |
| **Highcharts** | Biểu đồ tài chính, báo cáo | Tiêu đề, danh mục, series, điểm | Hover điểm dữ liệu |
| **D3** | Trực quan hoá dữ liệu | Tên gắn với dữ liệu (`name`, `label`) | Tô vị trí |

> **Điều kiện:** extension phải "thấy" được thư viện trên trang (thư viện để lộ biến toàn cục như `window.go`,
> `window.echarts`, hoặc gắn instance vào phần tử HTML). Trang nào đóng gói kín thư viện thì extension tự
> chuyển sang OCR.

### Trang / nội dung khác (dùng OCR)

| Loại | Mức độ |
|---|---|
| Ảnh chụp màn hình, ảnh scan, banner | ✅ Tốt nếu chữ rõ, đủ lớn |
| Canvas của thư viện chưa có adapter | ✅ Đọc được phần đang hiển thị |
| Canva, Figma, Google Slides (bản xem/chỉnh sửa) | ⚠️ Đọc được phần đang hiển thị qua ảnh chụp tab |
| PDF nhúng trong trang | ⚠️ Đọc được trang PDF đang hiển thị |
| Canvas WebGL (bản đồ, 3D) | ⚠️ Đọc được phần đang hiển thị |
| Trang `chrome://`, Chrome Web Store, file PDF mở trực tiếp | ❌ Chrome không cho extension chạy |

Muốn hỗ trợ thêm thư viện? Xem hướng dẫn viết adapter trong [DEVELOPMENT.md](DEVELOPMENT.md#3-thêm-adapter-cho-thư-viện-khác).

---

## 3. Cài đặt

1. Mở Chrome (hoặc Edge, Brave, Cốc Cốc — bản Chromium 116 trở lên), vào `chrome://extensions`.
2. Bật **Developer mode** (góc phải trên).
3. Bấm **Load unpacked** → chọn thư mục `universal-canvas-finder`.
4. Bấm icon 🧩 trên thanh công cụ → ghim **Universal Canvas Finder** cho tiện.

Cập nhật bản mới: chép đè thư mục, vào `chrome://extensions` bấm **⟳** trên extension, rồi tải lại trang.

---

## 4. Cách dùng

### Bước 1 — Mở thanh tìm kiếm

Nhấn **Ctrl+Shift+F** (macOS: **⌘+Shift+F**) hoặc bấm icon extension.
Thanh tìm kiếm hiện ở góc phải trên và **tự quét trang** (thanh tiến trình hiện khi đang OCR).

### Bước 2 — Gõ từ khoá

Kết quả hiện ngay bên dưới. Dòng trạng thái cho biết đã đọc được bao nhiêu và từ đâu, ví dụ:
`3028 đoạn văn bản · Adapter:GoJS 3028`.

### Bước 3 — Đi tới kết quả

| Thao tác | Tác dụng |
|---|---|
| **Enter** | Kết quả tiếp theo |
| **Shift+Enter** | Kết quả trước |
| Bấm vào một dòng trong danh sách | Nhảy tới kết quả đó |
| **Esc** hoặc nút **✕** | Đóng thanh tìm kiếm |
| Kéo phần đầu thanh | Di chuyển thanh tìm kiếm |

### Các nút trên thanh tìm kiếm

| Nút | Tác dụng |
|---|---|
| **Aa** | Phân biệt chữ hoa/thường |
| **ă→a** | Bỏ qua dấu tiếng Việt (bật sẵn) |
| **“ab”** | Chỉ khớp nguyên từ (`an` không khớp `anh`) |
| **.\*** | Tìm bằng biểu thức chính quy, ví dụ `3400003\d+` |
| **OCR** | Quét sâu: OCR mọi canvas/ảnh/iframe, kể cả nơi đã đọc được bằng cách khác |
| **⟳** | Quét lại trang (khi trang vừa tải thêm nội dung) |
| **Huỷ** (cạnh thanh tiến trình) | Dừng OCR đang chạy |

### Ví dụ: tìm người trong cây phả hệ (trang dùng GoJS)

1. Mở trang sơ đồ, nhấn **Ctrl+Shift+F**.
2. Gõ `phung tien manh` (không cần dấu, không cần viết hoa) hoặc mã `34000036248`.
3. Bấm kết quả → sơ đồ tự cuộn tới người đó, node được chọn và dòng tên được tô vàng —
   kể cả khi người đó đang nằm ngoài màn hình.

---

## 5. Cài đặt trong popup

Bấm icon extension để mở popup:

| Mục | Ý nghĩa |
|---|---|
| **Chế độ quét** | *Tự động* (khuyên dùng) · *Chỉ DOM* · *Chỉ Adapter* · *Chỉ OCR* · *Tất cả các tầng* |
| **Ngôn ngữ OCR** | Chọn ngôn ngữ của chữ cần đọc. Chọn **ít** ngôn ngữ → nhanh và chính xác hơn. Chữ tiếng Việt nên chọn *Tiếng Việt* (đọc được cả chữ Latin không dấu) |
| **Tự quét lại khi nội dung thay đổi** | Tự cập nhật kết quả khi trang thay đổi (tốn tài nguyên hơn, mặc định tắt) |
| **Tìm cả văn bản HTML thường** | Gộp luôn chữ bình thường của trang vào kết quả (giống Ctrl+F + thêm) |
| **Kích thước tối thiểu để OCR** | Bỏ qua ảnh/canvas nhỏ hơn mức này (mặc định 40 px) — tránh OCR icon |
| **Số phần tử OCR tối đa / frame** | Giới hạn số ảnh/canvas được OCR mỗi lần quét (mặc định 40) |
| **Xoá cache OCR** | Xoá kết quả OCR đã ghi nhớ (khi ảnh đổi nhưng kết quả cũ vẫn hiện) |

Cài đặt được lưu và đồng bộ theo tài khoản Chrome.
Đổi phím tắt tại `chrome://extensions/shortcuts`.

---

## 6. Mẹo & câu hỏi thường gặp

**Nhấn Ctrl+Shift+F không có gì xảy ra?**
Phím tắt có thể trùng với trang hoặc extension khác — đổi tại `chrome://extensions/shortcuts`, hoặc bấm icon
extension. Trang mở từ trước khi cài extension: tải lại trang.

**Tìm không ra chữ trên sơ đồ/biểu đồ?**
- Xem dòng trạng thái: nếu không có `Adapter:…`, có thể thư viện chưa được hỗ trợ → bấm **OCR**.
- Nội dung vừa tải thêm (cuộn, mở rộng nhánh…) → bấm **⟳**.

**OCR đọc sai hoặc không ra chữ?**
- Chọn đúng ngôn ngữ trong popup.
- Chữ nhỏ: phóng to trang (**Ctrl +**) rồi bấm **OCR**.
- OCR chỉ đọc phần **đang hiển thị** với canvas WebGL, iframe, PDF: cuộn tới vùng cần tìm rồi bấm **OCR**.
- Giữ tab đang mở và cửa sổ không thu nhỏ khi OCR.

**Có gửi dữ liệu của tôi đi đâu không?**
Không. OCR chạy bằng Tesseract.js đóng gói trong extension. Extension chỉ tải lại chính những ảnh mà trang đang
hiển thị (khi trang chặn đọc ảnh trực tiếp), và lưu cache OCR trong máy.

**Extension có làm hỏng trang không?**
Giao diện nằm trong Shadow DOM tách biệt; phím gõ trong ô tìm kiếm không ảnh hưởng tới trang. Extension chỉ hoạt
động khi bạn mở nó.

---

## 7. Giới hạn

- OCR chỉ đọc được phần đang hiển thị với canvas WebGL, iframe không truy cập được và PDF nhúng.
- Thư viện bị đóng gói kín (không để lộ biến toàn cục) → adapter không nhận ra → phải dùng OCR.
- Chữ nằm trên nhiều dòng của cùng một đối tượng được tìm theo từng dòng riêng
  (ví dụ tìm `6A2 PHUNG` không ra nếu mã và tên nằm ở hai dòng khác nhau).
- Không chạy trên `chrome://…`, Chrome Web Store và trình xem PDF gốc của Chrome.

---

Tài liệu kỹ thuật (cách hoạt động, cấu trúc mã nguồn, viết adapter, debug): [DEVELOPMENT.md](DEVELOPMENT.md).
