/**
 * Preload окна «Настройки» (отдельное BrowserWindow, sandbox: true).
 *
 * Управление распакованными расширениями профилей поверх существующих
 * каналов: state:get (снимок), ext:pick-dir (системный диалог выбора папки
 * с проверкой manifest.json), profile:add-extensions / profile:remove-
 * extension (конфиг + живая сессия), view:reload, dialog:close.
 * Никакого Node, никаких новых привилегий.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { SettingsDialogApi } from './main/types';

const api: SettingsDialogApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  pickExtensionDir: () => ipcRenderer.invoke('ext:pick-dir'),
  addExtensions: (profileId, paths, reload) =>
    ipcRenderer.invoke('profile:add-extensions', profileId, paths, reload),
  removeExtension: (profileId, source, reload) =>
    ipcRenderer.invoke('profile:remove-extension', profileId, source, reload),
  reloadProfile: (profileId) => ipcRenderer.invoke('view:reload', profileId),
  rotateProxy: (profileId) => ipcRenderer.invoke('profile:rotate-proxy', profileId),
  closeWindow: () => ipcRenderer.send('dialog:close'),
};

contextBridge.exposeInMainWorld('settingsDialog', api);

declare global {
  interface Window {
    settingsDialog: SettingsDialogApi;
  }
}
