/**
 * Brouser — точка входа main-процесса.
 *
 * Создаёт frameless-окно, в которое загружается renderer (панель инструментов + сетка).
 * Ячейки сетки — это WebContentsView (новый API); их геометрию с P1.1 считает
 * main (layout.ts) по contentBounds окна. Renderer шлёт только команды
 * (раскладка/профили/тема) и два события состояния: layout-ready (handshake)
 * и ui:log-panel (панель журнала). Resize — throttled recompute (16мс).
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { ConfigService } from './config';
import { Logger } from './logger';
import { ProfileManager } from './profileManager';
import { AppState, CommandResult, LayoutId, NewProfileInput, ThemeId } from './types';

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
        preload: path.join(__dirname, '..', 'preload.js'),
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
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    manager!.attachWindow(win);

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
      manager?.destroyAll();
    });
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
    ipcMain.handle('layout:set', (_e, layout: LayoutId): CommandResult =>
      manager!.setLayout(layout),
    );
    ipcMain.handle('theme:set', (_e, theme: ThemeId): CommandResult => manager!.setTheme(theme));

    ipcMain.handle('views:reload-all', (): void => manager!.reloadAll());
    ipcMain.handle('view:reload', (_e, id: string): void => manager!.reloadView(id));
    ipcMain.handle('view:devtools', (_e, id: string): void => manager!.openDevTools(id));

    ipcMain.handle('config:save', (): CommandResult => {
      config!.save();
      logger!.info('config.json сохранён вручную');
      return { ok: true };
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
