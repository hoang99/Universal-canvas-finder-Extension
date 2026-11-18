/**
 * Popup: cài đặt (lưu chrome.storage.sync) + mở thanh tìm kiếm.
 * Bấm icon extension sẽ mở popup và đồng thời mở thanh tìm kiếm trên tab.
 */
'use strict';

const DEFAULTS = {
  scanMode: 'auto', ocrLangs: ['eng', 'vie'], autoRescan: false, includeHtmlText: false,
  minOcrSize: 40, maxOcrTargets: 40,
};

const $ = (id) => document.getElementById(id);
const msg = (t) => { $('msg').textContent = t || ''; };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function openFinder() {
  const tab = await activeTab();
  if (!tab || tab.id == null) return;
  const res = await chrome.runtime.sendMessage({ type: 'open-finder', tabId: tab.id });
  if (res && res.error === 'restricted') msg('Chrome không cho extension chạy trên trang này (chrome://, Web Store, trình xem PDF gốc…).');
  return res;
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  $('scanMode').value = s.scanMode;
  document.querySelectorAll('#langs input').forEach((cb) => { cb.checked = s.ocrLangs.includes(cb.value); });
  $('autoRescan').checked = !!s.autoRescan;
  $('includeHtmlText').checked = !!s.includeHtmlText;
  $('minOcrSize').value = s.minOcrSize;
  $('maxOcrTargets').value = s.maxOcrTargets;
}

function bind() {
  $('open').addEventListener('click', async () => { await openFinder(); window.close(); });
  $('scanMode').addEventListener('change', (e) => chrome.storage.sync.set({ scanMode: e.target.value }));
  document.querySelectorAll('#langs input').forEach((cb) => cb.addEventListener('change', () => {
    let langs = [...document.querySelectorAll('#langs input:checked')].map((x) => x.value);
    if (!langs.length) { langs = ['eng']; document.querySelector('#langs input[value=eng]').checked = true; }
    chrome.storage.sync.set({ ocrLangs: langs });
  }));
  for (const id of ['autoRescan', 'includeHtmlText']) {
    $(id).addEventListener('change', (e) => chrome.storage.sync.set({ [id]: e.target.checked }));
  }
  for (const id of ['minOcrSize', 'maxOcrTargets']) {
    $(id).addEventListener('change', (e) => {
      const v = Math.max(+e.target.min, Math.min(+e.target.max, parseInt(e.target.value, 10) || DEFAULTS[id]));
      e.target.value = v;
      chrome.storage.sync.set({ [id]: v });
    });
  }
  $('clearCache').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clear-ocr-cache' });
    msg('Đã xoá cache OCR.');
  });
}

load().then(bind).catch((e) => msg(String(e)));
// Bấm icon = kích hoạt: mở luôn thanh tìm kiếm trên tab hiện tại.
openFinder().catch(() => {});
