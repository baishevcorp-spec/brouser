/**
 * Preload-скрипт: экспортирует безопасный API window.brouser через contextBridge.
 *
 * Renderer не получает Node — только IPC-мост. Полный контракт каналов
 * описан в README (раздел «IPC-контракт»).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { BrouserApi, AppState, LayoutId, LogEntry } from './main/types';

/** Подписка на событие main с функцией отписки. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: BrouserApi = {
  // Запросы состояния и команды
  getState: () => ipcRenderer.invoke('state:get'),
  addProfile: (input) => ipcRenderer.invoke('profile:add', input),
  removeProfile: (id) => ipcRenderer.invoke('profile:remove', id),
  setLayout: (layout) => ipcRenderer.invoke('layout:set', layout),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  reloadAll: () => ipcRenderer.invoke('views:reload-all'),
  reloadView: (id) => ipcRenderer.invoke('view:reload', id),
  openDevTools: (id) => ipcRenderer.invoke('view:devtools', id),
  saveConfig: () => ipcRenderer.invoke('config:save'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  // Прямоугольники ячеек (односторонняя отправка)
  sendViewBounds: (id, rect) => {
    ipcRenderer.send('view:set-bounds', id, rect);
  },

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
