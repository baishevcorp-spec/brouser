/**
 * Копирует статические файлы в dist:
 *  - renderer (html/css);
 *  - main/fingerprint-preload.js (CommonJS-генератор патча отпечатка:
 *    tsc не компилирует .js, а fingerprint.ts require-ит его из dist/main).
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

// renderer: html/css
const srcRenderer = path.join(root, 'src', 'renderer');
const outRenderer = path.join(root, 'dist', 'renderer');
fs.mkdirSync(outRenderer, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(srcRenderer, file), path.join(outRenderer, file));
  console.log(`copied renderer/${file} -> dist/renderer/`);
}

// main: fingerprint-preload.js
const srcMain = path.join(root, 'src', 'main', 'fingerprint-preload.js');
const outMain = path.join(root, 'dist', 'main', 'fingerprint-preload.js');
fs.mkdirSync(path.dirname(outMain), { recursive: true });
fs.copyFileSync(srcMain, outMain);
console.log('copied main/fingerprint-preload.js -> dist/main/');
