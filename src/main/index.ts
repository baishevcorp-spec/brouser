/**
 * Brouser — точка входа main-процесса.
 *
 * Создаёт frameless-окно, в которое загружается renderer (панель инструментов + сетка).
 * Ячейки сетки — это WebContentsView (новый API); их геометрию с P1.1 считает
 * main (layout.ts) по contentBounds окна. Renderer шлёт только команды
 * (раскладка/профили/тема) и два события состояния: layout-ready (handshake)
 * и ui:log-panel (панель журнала). Resize — throttled recompute (16мс).
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigService } from './config';
import { Logger } from './logger';
import { preloadPath, RENDERER_DIR } from './paths';
import { ProfileManager } from './profileManager';
import { openDialog } from './windows/dialogWindow';
import { TooltipWindowManager } from './windows/tooltipWindow';
import {
  AppState,
  CommandResult,
  CookieImportInput,
  CookieImportResult,
  FilePickResult,
  LayoutId,
  NewProfileInput,
  ThemeId,
  TooltipShowPayload,
} from './types';

// Только один экземпляр приложения (одна сетка сессий за раз).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap(): void {
  // Двойная страховка от фонового троттлинга
  // (помимо backgroundThrottling: false у каждого WebContentsView).
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');

  // WebRTC не должен светить локальный/прямой публичный IP (P3, антидетект):
  // disable_non_proxied_udp разрешает UDP только через прокси-канал.
  // Для профилей с прокси ICE-кандидаты идут через прокси (IP не утекает);
  // для профилей без прокси WebRTC деградирует (кандидатов не будет) —
  // Avito WebRTC не использует, а утечка IP дороже.
  app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

  let win: BrowserWindow | null = null;
  let logger: Logger | null = null;
  let config: ConfigService | null = null;
  let manager: ProfileManager | null = null;
  /** Окно rich-тултипов: прозрачный always-on-top overlay поверх views. */
  let tooltips: TooltipWindowManager | null = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    logger = new Logger();
    logger.init();

    config = new ConfigService(logger);
    config.load();

    manager = new ProfileManager(config, logger);

    // Все записи журнала дублируются в renderer (канал 'log-message').
    logger.setBroadcast((entry) => {
      if (win && !win.isDestroyed()) win.webContents.send('log-message', entry);
    });

    // События main -> renderer: profiles-updated, layout-changed.
    manager.setEmit((channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    });

    createWindow();
    registerIpc();
  });

  function createWindow(): void {
    const bounds = config!.config.windowBounds;
    win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      minWidth: 720,
      minHeight: 520,
      frame: false, // без рамки — панель инструментов сама рисует кнопки окна
      show: false,
      backgroundColor: '#0b1518', // тёмная база под темы (renderer рисует свой фон)
      title: 'Brouser',
      webPreferences: {
        preload: preloadPath('preload.js'),
        contextIsolation: true,
        // sandbox: false — preload-у нужен require('./main/layout') для констант
        // геометрии (единый источник с main). Изоляция страницы не страдает:
        // nodeIntegration выключен, contextIsolation включен, страница не
        // получает require — только preload.
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    win.once('ready-to-show', () => win?.show());
    void win.loadFile(path.join(RENDERER_DIR, 'index.html'));

    manager!.attachWindow(win);
    // Тултипы поверх WebContentsView: прозрачное always-on-top окно с темой
    // главного конфига. При blur (фокус ушёл в диалог/DevTools) — прятать.
    tooltips = new TooltipWindowManager(win, () => config!.config.theme ?? 'dark');
    win.on('blur', () => tooltips?.hide());

    // Запоминаем размеры окна (по ТЗ сохраняются только width/height).
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    const persistBounds = (): void => {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        if (!win || win.isDestroyed() || !config) return;
        const b = win.getBounds();
        config.config.windowBounds = { width: b.width, height: b.height };
      }, 350);
    };

    // P1.1: пересчёт сетки при resize — троттлинг 16мс (main-«requestAnimationFrame»):
    // при resize views двигаются не чаще раза за кадр — без дрожания и гонок.
    let recomputeTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRecompute = (): void => {
      if (recomputeTimer !== undefined) return;
      recomputeTimer = setTimeout(() => {
        recomputeTimer = undefined;
        manager?.recomputeLayout();
      }, 16);
    };
    const onGeometryChange = (): void => {
      persistBounds();
      scheduleRecompute();
    };
    win.on('resize', onGeometryChange);
    win.on('maximize', onGeometryChange);
    win.on('unmaximize', onGeometryChange);

    // При закрытии окна сохраняем конфиг и корректно гасим все сессии.
    win.on('close', () => {
      config?.save();
    });
    win.on('closed', () => {
      win = null;
      tooltips?.destroy();
      tooltips = null;
      manager?.destroyAll();
    });
  }

  /** Хост URL без www — предзаполнение фильтра домена в диалоге импорта cookies. */
  function hostFromUrl(url: string): string {
    try {
      let host = new URL(url).hostname.toLowerCase();
      if (host.startsWith('www.')) host = host.slice(4);
      return host;
    } catch {
      return '';
    }
  }

  function registerIpc(): void {
    // ---------- Запросы renderer (invoke) ----------
    ipcMain.handle('state:get', (): AppState => manager!.getState());

    ipcMain.handle('profile:add', (_e, input: NewProfileInput): Promise<CommandResult> =>
      manager!.addProfile(input),
    );
    ipcMain.handle('profile:remove', (_e, id: string): Promise<CommandResult> =>
      manager!.removeProfile(id),
    );
    ipcMain.handle('profile:duplicate', (_e, id: string): Promise<CommandResult> =>
      manager!.duplicateProfile(id),
    );

    // Импорт cookies (P3): текст cookies.txt/JSON -> сессия профиля.
    // Диалог импорта не модален: пока он открыт, профиль можно удалить из
    // главного окна. Если к моменту «Импортировать» профиля уже нет — не
    // оставляем окно висеть с «Профиль не найден»: сообщение и закрытие.
    ipcMain.handle(
      'cookies:import',
      async (e, profileId: string, input: CookieImportInput): Promise<CookieImportResult> => {
        const exists = manager!.getState().profiles.some((p) => p.id === profileId);
        if (!exists) {
          const dlg = BrowserWindow.fromWebContents(e.sender);
          if (dlg && !dlg.isDestroyed()) {
            await dialog.showMessageBox(dlg, {
              type: 'warning',
              title: 'Brouser',
              message: 'Профиль был удалён',
              detail: 'Окно импорта cookies закроется.',
              buttons: ['OK'],
              defaultId: 0,
            });
            dlg.close();
          }
          return {
            ok: false,
            total: 0,
            imported: 0,
            skippedDomain: 0,
            expired: 0,
            failed: 0,
            error: 'Профиль был удалён',
          };
        }
        return manager!.importCookies(profileId, input);
      },
    );
    // Диалог выбора файла cookies (cookies.txt / .json, ≤ 10 МБ) и его чтение.
    // Возврат — в renderer: текст попадает в textarea модалки (можно отредактировать).
    // Родитель файлового диалога — окно, из которого пришли (главное ИЛИ окно
    // импорта cookies): диалог всегда поверх того, что сейчас активно.
    ipcMain.handle('cookies:pick-file', async (e): Promise<FilePickResult> => {
      try {
        const parent =
          BrowserWindow.fromWebContents(e.sender) ??
          (win && !win.isDestroyed() ? win : null);
        const options: Electron.OpenDialogOptions = {
          title: 'Импорт cookies — выберите файл',
          filters: [
            { name: 'Cookies (cookies.txt, JSON)', extensions: ['txt', 'json'] },
            { name: 'Все файлы', extensions: ['*'] },
          ],
          properties: ['openFile'],
        };
        const res = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
        if (res.canceled || res.filePaths.length === 0) return { ok: false, error: 'Отменено' };
        const filePath = res.filePaths[0] as string;
        const stat = fs.statSync(filePath);
        if (stat.size > 10 * 1024 * 1024) {
          return { ok: false, error: 'Файл больше 10 МБ — экспортируйте только нужный сайт' };
        }
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content.trim()) return { ok: false, error: 'Файл пуст' };
        return { ok: true, name: path.basename(filePath), content };
      } catch (err) {
        return { ok: false, error: String((err as Error).message ?? err) };
      }
    });
    ipcMain.handle('layout:set', (_e, layout: LayoutId): CommandResult =>
      manager!.setLayout(layout),
    );
    ipcMain.handle('theme:set', (_e, theme: ThemeId): CommandResult => manager!.setTheme(theme));

    // Синхронизатор действий (P3): реплей ввода между видимыми ячейками.
    ipcMain.handle('sync:set', (_e, on: boolean): Promise<CommandResult> =>
      manager!.setInputSync(!!on),
    );

    ipcMain.handle('views:reload-all', (): void => manager!.reloadAll());
    ipcMain.handle('view:reload', (_e, id: string): void => manager!.reloadView(id));
    ipcMain.handle('view:devtools', (_e, id: string): void => manager!.openDevTools(id));

    ipcMain.handle('config:save', (): CommandResult => {
      config!.save();
      logger!.info('config.json сохранён вручную');
      return { ok: true };
    });

    // ---------- Диалоговые окна (UI-фикс: HTML-модалки перекрывались views) ----------
    // Все модалки — отдельные BrowserWindow с parent=главное окно (см.
    // windows/dialogWindow.ts); данные — в query, команды — существующие каналы.
    ipcMain.handle('dialog:open-cookie-import', (_e, profileId: string): CommandResult => {
      if (!win || win.isDestroyed()) return { ok: false, error: 'Главное окно закрыто' };
      const p = manager!.getState().profiles.find((x) => x.id === profileId);
      if (!p) return { ok: false, error: 'Профиль не найден' };
      openDialog(win, logger!, {
        html: 'cookie-import.html',
        preload: 'preload-cookie.js',
        query: {
          id: p.id,
          name: p.name,
          host: hostFromUrl(p.url),
          visible: p.visible ? '1' : '0',
          theme: manager!.getState().theme,
        },
        title: `Импорт cookies — ${p.name}`,
        width: 640,
        height: 560,
        minWidth: 520,
        minHeight: 460,
      });
      return { ok: true };
    });

    ipcMain.handle('dialog:open-profile-form', (): CommandResult => {
      if (!win || win.isDestroyed()) return { ok: false, error: 'Главное окно закрыто' };
      openDialog(win, logger!, {
        html: 'profile-form.html',
        preload: 'preload-profile-form.js',
        query: { theme: manager!.getState().theme },
        title: 'Новый профиль — Brouser',
        width: 470,
        height: 580,
        minWidth: 420,
        minHeight: 480,
      });
      return { ok: true };
    });

    ipcMain.handle('dialog:open-delete-confirm', (_e, profileId: string): CommandResult => {
      if (!win || win.isDestroyed()) return { ok: false, error: 'Главное окно закрыто' };
      const p = manager!.getState().profiles.find((x) => x.id === profileId);
      if (!p) return { ok: false, error: 'Профиль не найден' };
      openDialog(win, logger!, {
        html: 'confirm-delete.html',
        preload: 'preload-confirm.js',
        query: { id: p.id, name: p.name, theme: manager!.getState().theme },
        title: `Удалить профиль — ${p.name}`,
        width: 400,
        height: 230,
        resizable: false,
      });
      return { ok: true };
    });

    // Закрыть окно, из которого пришло сообщение (диалоги).
    ipcMain.on('dialog:close', (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w && !w.isDestroyed()) w.close();
    });

    // ---------- Rich-тултипы (прозрачное always-on-top окно) ----------
    ipcMain.on('tooltip:show', (e, payload: TooltipShowPayload) => {
      // Тултипы шлёт только renderer главного окна (у диалогов — свои CSS-тултипы).
      if (win && !win.isDestroyed() && e.sender === win.webContents) tooltips?.show(payload);
    });
    ipcMain.on('tooltip:hide', (e) => {
      if (win && !win.isDestroyed() && e.sender === win.webContents) tooltips?.hide();
    });

    // ---------- Кнопки окна (frameless) ----------
    ipcMain.handle('window:minimize', (): void => win?.minimize());
    ipcMain.handle('window:toggle-maximize', (): void => {
      if (!win) return;
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    });
    ipcMain.handle('window:close', (): void => win?.close());

    // ---------- События состояния UI (односторонние) ----------
    // Handshake (P1.2): renderer закончил первый рендер сетки.
    ipcMain.on('layout:ready', () => manager!.onLayoutReady());
    // Панель журнала открыта/закрыта — резервируем место под неё.
    ipcMain.on('ui:log-panel', (_e, open: boolean) => manager!.setLogPanel(!!open));
  }

  app.on('window-all-closed', () => {
    // Для Brouser закрытие окна = выход: persistent-сессии уже записаны на диск.
    app.quit();
  });

  app.on('before-quit', () => {
    config?.save();
  });
}
