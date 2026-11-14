/**
 * Окно rich-тултипов Brouser (UI-фикс: CSS-тултипы renderer главного окна
 * перекрываются WebContentsView — native-слой всегда выше HTML).
 *
 * Одно прозрачное always-on-top BrowserWindow на всё приложение:
 *  - frame: false, transparent: true, hasShadow: false, focusable: false,
 *    skipTaskbar: true — «парящая» стеклянная карточка над сеткой;
 *  - setIgnoreMouseEvents(true, {forward}) — окно прозрачно для мыши,
 *    клики проходят к тому, что под ним (в т.ч. в ячейки сетки).
 *
 * Протокол (поколения gen страхуют от гонок):
 *  1. renderer главного окна: mouseenter [data-tip*] -> IPC `tooltip:show`
 *     с прямоугольником якоря в CSS-пикселях контента + контентом (title+body).
 *  2. main: переводит координаты в экранные (contentBounds), шлёт окну
 *     тултипа `tooltip:render` {gen, title, body, theme}, окно скрыто.
 *  3. окно тултипа: рендерит карточку, меряет себя, шлёт `tooltip:measured`
 *     {gen, w, h}.
 *  4. main: позиционирует (кламп к workArea, переворот при нехватке места),
 *     setBounds и showInactive() — тултип появляется над views.
 *
 * `tooltip:hide` — мгновенно (mouseleave/клик/blur главного окна); gen++ в
 * hide() просрочивает запаздывающие measured-ответы.
 */
import { BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'node:path';
import { preloadPath, RENDERER_DIR } from '../paths';
import type { TooltipRenderData, TooltipShowPayload } from '../types';

/** Отступ тултипа от якоря (DIP). */
const TIP_GAP = 8;

/** Максимальная ширина окна тултипа (карточка внутри сжимается под текст). */
const TIP_MAX_W = 340;

/** Менеджер окна rich-тултипов: одно на приложение, создаётся лениво. */
export class TooltipWindowManager {
  private win: BrowserWindow | null = null;
  /** Поколение текущего показа — для отбрасывания устаревших measured. */
  private gen = 0;
  /** Экранный прямоугольник якоря последнего show(). */
  private anchor: { x: number; y: number; width: number; height: number; preferTop: boolean } | null = null;
  /** tooltip.html догрузился — можно слать tooltip:render. */
  private ready = false;
  /** Показ, пришедший до загрузки страницы (отдаётся после did-finish-load). */
  private pending: TooltipRenderData | null = null;

  constructor(
    private readonly parent: BrowserWindow,
    private readonly getTheme: () => 'light' | 'dark' | 'teal',
  ) {
    // measured приходит только от окна тултипа; менеджер один на приложение.
    ipcMain.on('tooltip:measured', this.onMeasured);
    parent.on('closed', () => this.destroy());
  }

  /** Renderer главного окна попросил тултип над элементом-якорем. */
  show(payload: TooltipShowPayload): void {
    const cb = this.parent.getContentBounds();
    this.anchor = {
      x: cb.x + payload.x,
      y: cb.y + payload.y,
      width: payload.width,
      height: payload.height,
      preferTop: !!payload.preferTop,
    };
    this.gen++;
    const w = this.ensureWindow();
    if (!w) return;
    // Гарантированно скрыто, пока не придёт measured с актуальным gen.
    if (w.isVisible()) w.hide();
    const data: TooltipRenderData = {
      gen: this.gen,
      title: payload.title,
      body: payload.body,
      theme: this.getTheme(),
    };
    if (this.ready) {
      w.webContents.send('tooltip:render', data);
    } else {
      // Страница окна ещё грузится — отдадим данные сразу после загрузки.
      this.pending = data;
    }
  }

  hide(): void {
    this.gen++; // просрочить in-flight measured
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  destroy(): void {
    ipcMain.removeListener('tooltip:measured', this.onMeasured);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  /** Ответ окна тултипа: карточка отрисована, вот её фактический размер. */
  private onMeasured = (_e: Electron.IpcMainEvent, gen: number, w: number, h: number): void => {
    if (gen !== this.gen || !this.anchor || !this.win || this.win.isDestroyed()) return;
    const a = this.anchor;
    const width = Math.min(TIP_MAX_W, Math.max(40, Math.round(w)));
    const height = Math.max(20, Math.round(h));

    // Рабочая область экрана, где живёт якорь (без панели задач).
    const wa = screen.getDisplayMatching({
      x: a.x,
      y: a.y,
      width: Math.max(1, a.width),
      height: Math.max(1, a.height),
    }).workArea;

    // По горизонтали — центр якоря, с клампом к краям экрана.
    let x = Math.round(a.x + (a.width - width) / 2);
    x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - width - 4);

    // По вертикали — под якорем; preferTop (шапки ячеек) или нехватка места
    // внизу — над якорем; совсем некуда — впритык к низу экрана.
    const below = a.y + a.height + TIP_GAP;
    const above = a.y - height - TIP_GAP;
    let y: number;
    if (a.preferTop && above >= wa.y) y = above;
    else if (below + height <= wa.y + wa.height) y = below;
    else if (above >= wa.y) y = above;
    else y = wa.y + wa.height - height - 4;

    this.win.setBounds({ x, y, width, height });
    if (!this.win.isVisible()) this.win.showInactive(); // без кражи фокуса
  };

  /** Ленивое создание прозрачного окна; грузит tooltip.html один раз. */
  private ensureWindow(): BrowserWindow | null {
    if (this.win && !this.win.isDestroyed()) return this.win;
    if (this.parent.isDestroyed()) return null;

    const w = new BrowserWindow({
      parent: this.parent,
      width: TIP_MAX_W,
      height: 120,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false, // никогда не крадёт фокус у главного окна
      show: false,
      resizable: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        preload: preloadPath('preload-tooltip.js'),
      },
    });
    // Тултип неинтерактивен: мышь проходит сквозь (forward — чтобы элементы
    // под ним продолжали получать hover/click).
    w.setIgnoreMouseEvents(true, { forward: true });
    // Первый tooltip:render может прийти раньше загрузки страницы —
    // очередь (pending) отдаём после did-finish-load.
    w.webContents.once('did-finish-load', () => {
      this.ready = true;
      const data = this.pending;
      this.pending = null;
      if (data && data.gen === this.gen && this.win && !this.win.isDestroyed()) {
        this.win.webContents.send('tooltip:render', data);
      }
    });
    void w.loadFile(path.join(RENDERER_DIR, 'tooltip.html'));

    this.win = w;
    return w;
  }
}
