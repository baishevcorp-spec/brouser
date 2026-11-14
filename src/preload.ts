/**
 * Preload-скрипт: экспортирует безопасный API window.brouser через contextBridge.
 *
 * Renderer не получает Node — только IPC-мост. Полный контракт каналов
 * описан в README (раздел «IPC-контракт»).
 *
 * P1.1: экспортирует константы геометрии (TOOLBAR_HEIGHT / GEOMETRY) —
 * renderer применяет их в CSS-переменные, чтобы расчёт ячеек в main
 * и отрисовка сетки в renderer всегда совпадали.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  AppState,
  BrouserApi,
  CookieImportInput,
  CookieImportResult,
  FilePickResult,
  LayoutId,
  LogEntry,
  TooltipShowPayload,
} from './main/types';
import { TOOLBAR_HEIGHT, UI_GEOMETRY } from './main/layout';

/** Подписка на событие main с функцией отписки. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: BrouserApi = {
  // Константы геометрии (P1.1) — единый источник с layout.ts в main.
  TOOLBAR_HEIGHT,
  GEOMETRY: UI_GEOMETRY,

  // Запросы состояния и команды
  getState: () => ipcRenderer.invoke('state:get'),
  addProfile: (input) => ipcRenderer.invoke('profile:add', input),
  removeProfile: (id) => ipcRenderer.invoke('profile:remove', id),
  duplicateProfile: (id) => ipcRenderer.invoke('profile:duplicate', id),
  importCookies: (profileId, input) => ipcRenderer.invoke('cookies:import', profileId, input),
  pickCookieFile: () => ipcRenderer.invoke('cookies:pick-file'),
  setInputSync: (enabled) => ipcRenderer.invoke('sync:set', enabled),
  setLayout: (layout) => ipcRenderer.invoke('layout:set', layout),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  reloadAll: () => ipcRenderer.invoke('views:reload-all'),
  reloadView: (id) => ipcRenderer.invoke('view:reload', id),
  openDevTools: (id) => ipcRenderer.invoke('view:devtools', id),
  saveConfig: () => ipcRenderer.invoke('config:save'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // Диалоговые окна поверх WebContentsView (UI-фикс) — отдельные BrowserWindow.
  openCookieImport: (profileId) => ipcRenderer.invoke('dialog:open-cookie-import', profileId),
  openProfileForm: () => ipcRenderer.invoke('dialog:open-profile-form'),
  openDeleteConfirm: (profileId) => ipcRenderer.invoke('dialog:open-delete-confirm', profileId),

  // Rich-тултипы: прозрачное always-on-top окно (HTML-тултипы перекрыты views).
  tooltipShow: (payload) => ipcRenderer.send('tooltip:show', payload),
  tooltipHide: () => ipcRenderer.send('tooltip:hide'),

  // События состояния UI (односторонние, P1.2 / P1.1)
  layoutReady: () => ipcRenderer.send('layout:ready'),
  setLogPanel: (open) => ipcRenderer.send('ui:log-panel', open),

  // События main -> renderer
  onProfilesUpdated: (cb) => subscribe<AppState>('profiles-updated', cb),
  onLayoutChanged: (cb) => subscribe<LayoutId>('layout-changed', cb),
  onLogMessage: (cb) => subscribe<LogEntry>('log-message', cb),
};

contextBridge.exposeInMainWorld('brouser', api);

declare global {
  interface Window {
    brouser: BrouserApi;
  }
}
