/**
 * Copy Tesseract.js runtime + language data from node_modules into lib/tesseract.
 * Run once after `npm install`:  npm run setup
 * (lib/tesseract is already committed, so this is only needed to upgrade.)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'lib', 'tesseract');
const LANGS = ['eng', 'vie', 'jpn', 'kor', 'chi_sim'];

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log('copied', path.relative(root, dst));
}

copy(path.join(nm, 'tesseract.js/dist/tesseract.min.js'), path.join(out, 'tesseract.min.js'));
copy(path.join(nm, 'tesseract.js/dist/worker.min.js'), path.join(out, 'worker.min.js'));
// OEM 1 (LSTM only) => only the *-lstm cores are ever loaded.
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
  copy(path.join(nm, 'tesseract.js-core', f), path.join(out, 'core', f));
}
for (const l of LANGS) {
  const src = path.join(nm, '@tesseract.js-data', l, '4.0.0_best_int', `${l}.traineddata.gz`);
  if (fs.existsSync(src)) copy(src, path.join(out, 'lang', `${l}.traineddata.gz`));
  else console.warn('missing language data:', l);
}
