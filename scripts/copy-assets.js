/**
 * Копирует статические файлы в dist:
 *  - renderer (html/css): главное окно + HTML диалоговых окон (импорт
 *    cookies, добавление профиля, подтверждение удаления) и окна тултипов;
 *  - main/fingerprint-preload.js (CommonJS-генератор патча отпечатка:
 *    tsc не компилирует .js, а fingerprint.ts require-ит его из dist/main).
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

// renderer: html/css (главное окно + диалоговые окна + окно тултипов)
const srcRenderer = path.join(root, 'src', 'renderer');
const outRenderer = path.join(root, 'dist', 'renderer');
fs.mkdirSync(outRenderer, { recursive: true });
const rendererFiles = [
  'index.html',
  'styles.css',
  'cookie-import.html',
  'profile-form.html',
  'confirm-delete.html',
  'settings.html',
  'tooltip.html',
];
for (const file of rendererFiles) {
  fs.copyFileSync(path.join(srcRenderer, file), path.join(outRenderer, file));
  console.log(`copied renderer/${file} -> dist/renderer/`);
}

// main: fingerprint-preload.js
const srcMain = path.join(root, 'src', 'main', 'fingerprint-preload.js');
const outMain = path.join(root, 'dist', 'main', 'fingerprint-preload.js');
fs.mkdirSync(path.dirname(outMain), { recursive: true });
fs.copyFileSync(srcMain, outMain);
console.log('copied main/fingerprint-preload.js -> dist/main/');
