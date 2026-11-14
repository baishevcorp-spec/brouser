/**
 * Копирует статические файлы renderer (html/css) в dist/renderer.
 * tsc не копирует ничего, кроме .js — поэтому делаем это вручную.
 */
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src', 'renderer');
const outDir = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(outDir, { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
  console.log(`copied ${file} -> dist/renderer/`);
}
