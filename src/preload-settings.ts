/**
 * Preload окна «Настройки» (отдельное BrowserWindow, sandbox: true).
 *
 * Управление распакованными расширениями профилей поверх существующих
 * каналов: state:get (снимок), ext:pick-dir (системный диалог выбора папки
 * с проверкой manifest.json), profile:add-extensions / profile:remove-
 * extension (конфиг + живая сессия), view:reload, dialog:close.
 *
 * AI-ассистент (P4, этап 1): assistant:config:get/set (ключ наружу не
 * возвращается), assistant:probe (доступность Cloud/Local).
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
  // ---------- AI-ассистент (P4, этап 1) ----------
  getAssistantConfig: () => ipcRenderer.invoke('assistant:config:get'),
  setAssistantConfig: (input) => ipcRenderer.invoke('assistant:config:set', input),
  probeAssistant: () => ipcRenderer.invoke('assistant:probe'),
  closeWindow: () => ipcRenderer.send('dialog:close'),
};

contextBridge.exposeInMainWorld('settingsDialog', api);

declare global {
  interface Window {
    settingsDialog: SettingsDialogApi;
  }
}
