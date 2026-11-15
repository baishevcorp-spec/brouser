/**
 * Единая точка правды для путей к ресурсам Brouser (фикс ERR_FILE_NOT_FOUND).
 *
 * Почему нужен отдельный модуль: tsc (rootDir=src, outDir=dist) кладёт файлы
 * по зеркалу src → dist, поэтому __dirname зависит от ГЛУБИНЫ модуля:
 *   src/main/index.ts          -> dist/main/index.js          (.. = dist)
 *   src/main/windows/*.ts      -> dist/main/windows/*.js      (../.. = dist)
 * Модули, лежащие в подпапках, наивно писали path.join(__dirname, '..',
 * 'renderer', ...) и попадали в dist/main/renderer/ — файла там нет
 * (HTML копирует scripts/copy-assets.js в dist/renderer/, preload'ы tsc
 * кладёт в корень dist/). Отсюда пустые «Windows 95»-окна диалогов и
 * молчащий тултип.
 *
 * Этот модуль живёт ровно в src/main/ (dist/main/paths.js): его __dirname
 * = dist/main, один '..' — корень dist. Все окна (главное, диалоги, тултип)
 * берут пути отсюда — глубина их собственных модулей больше не важна,
 * файлы можно свободно перемещать по src/main/.
 *
 * Работает и в dev (electron . -> dist/main/index.js), и в electron-builder
 * (app.asar повторяет ту же структуру: resources/app.asar/dist/...).
 */
import * as path from 'node:path';

/** Корень сборки: dist (HTML рендерера, бандлы, preload'ы). */
export const DIST_DIR = path.join(__dirname, '..');

/** dist/renderer — HTML диалогов и окна тултипов (копирует copy-assets.js). */
export const RENDERER_DIR = path.join(DIST_DIR, 'renderer');

/**
 * Путь к preload-скрипту. Все preload'ы лежат в корне dist
 * (src/preload-*.ts -> dist/preload-*.js), а не в dist/main.
 */
export function preloadPath(file: string): string {
  return path.join(DIST_DIR, file);
}
