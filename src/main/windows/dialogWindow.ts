/**
 * Фабрика диалоговых окон Brouser (UI-фикс: HTML-модалки в renderer главного
 * окна перекрываются нативным слоем WebContentsView — z-index бессилен).
 *
 * Все модалки (импорт cookies / добавление профиля / подтверждение удаления)
 * открываются отдельным BrowserWindow с parent = главное окно:
 *  - modal НЕ используется: главное окно остаётся полностью рабочим — можно
 *    переключать раскладку, работать с ячейками Avito и открыть другой
 *    диалог, не закрывая этот (parent без modal всё равно держит дочернее
 *    окно выше родителя и сворачивает его вместе с родителем);
 *  - frame: true — системный заголовок: перетаскивание мышью «из коробки»;
 *  - show: false + ready-to-show — без мигания белого фона;
 *  - sandbox: true + contextIsolation: true — отдельный процесс, у preload
 *    только ipcRenderer (каждому диалогу — свой preload с минимальным API);
 *  - HTML и preload берутся из src/main/paths.ts — единая точка путей к
 *    dist (глубина этого модуля — dist/main/windows — не важна).
 *
 * Дочернее окно с parent всегда выше родителя и views в нём — по построению
 * Electron; сетка профилей его больше не перекрывает.
 */
import { BrowserWindow } from 'electron';
import * as path from 'node:path';
import { preloadPath, RENDERER_DIR } from '../paths';
import type { Logger } from '../logger';
import type { ThemeId } from '../types';

/** База окна под тему — чтобы до применения data-theme не мигало белым. */
const THEME_BG: Record<ThemeId, string> = {
  dark: '#0b1518',
  teal: '#02201c',
  light: '#edf4f3',
};

/** Спецификация диалогового окна. */
export interface DialogSpec {
  /** HTML в dist/renderer (например, 'cookie-import.html'). */
  html: string;
  /** Preload в dist (например, 'preload-cookie.js') — свой на каждый диалог. */
  preload: string;
  /** Параметры URL (?a=b&c=d) — данные диалога (id профиля, тема). */
  query: Record<string, string>;
  /** Заголовок окна (системный тайтл-бар). */
  title: string;
  width: number;
  height: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
}

/**
 * Открыть диалоговое окно. Возвращает окно (создатель может слушать closed).
 * Повторный вызов (двойной клик по кнопке) не плодит копии: если диалог
 * того же HTML ещё жив — он переводится вперёд, новый не создаётся.
 */
export function openDialog(
  parent: BrowserWindow,
  logger: Logger,
  spec: DialogSpec,
): BrowserWindow | null {
  if (parent.isDestroyed()) return null;

  // Один экземпляр диалога на окно: того же html — просто показать поверх
  // (URL содержит query — проверяем и чистый путь, и с параметрами).
  const existing = BrowserWindow.getAllWindows().find(
    (w) =>
      !w.isDestroyed() &&
      w.getParentWindow() === parent &&
      (w.webContents.getURL().endsWith(`/${spec.html}`) ||
        w.webContents.getURL().includes(`/${spec.html}?`)),
  );
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  const theme = spec.query.theme as ThemeId | undefined;
  const win = new BrowserWindow({
    parent,
    // modal: false (не указываем) — главное окно не блокируется: с открытым
    // диалогом можно переключать раскладку и работать с ячейками сетки.
    // Побочный эффект допускается и обрабатывается: профиль могли удалить
    // при открытом окне импорта cookies — main закрывает его с сообщением
    // (см. cookies:import в src/main/index.ts).
    width: spec.width,
    height: spec.height,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    resizable: spec.resizable ?? true,
    minimizable: false,
    maximizable: false,
    frame: true, // системный заголовок = перетаскивание из коробки
    show: false, // показать после ready-to-show — без мигания
    title: spec.title,
    backgroundColor: THEME_BG[theme ?? 'dark'],
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(spec.preload),
    },
  });

  // Диалогам не нужна нативная строка меню File/Edit/View/... — Electron
  // подставляет дефолтное меню приложения в каждое frame-окно (главное окно
  // frameless и меню не рисует). На macOS меню окна не показывается.
  if (process.platform !== 'darwin') win.removeMenu();

  win.once('ready-to-show', () => win.show());
  void win.loadFile(path.join(RENDERER_DIR, spec.html), {
    query: spec.query,
  });

  logger.info(`[dialog] открыто окно ${spec.html} (query: ${Object.keys(spec.query).join(',')})`);
  return win;
}
