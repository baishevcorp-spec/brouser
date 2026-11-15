/**
 * Preload диалога «Добавить профиль» (отдельное BrowserWindow, sandbox: true).
 *
 * Форма отправляется каналом profile:add (валидация — в main, как и раньше);
 * ext:pick-dir выбирает папку распакованного расширения (проверка
 * manifest.json — в main); dialog:close закрывает окно.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { NewProfileInput, ProfileFormDialogApi } from './main/types';

const api: ProfileFormDialogApi = {
  addProfile: (input: NewProfileInput) => ipcRenderer.invoke('profile:add', input),
  pickExtensionDir: () => ipcRenderer.invoke('ext:pick-dir'),
  closeWindow: () => ipcRenderer.send('dialog:close'),
};

contextBridge.exposeInMainWorld('profileForm', api);

declare global {
  interface Window {
    profileForm: ProfileFormDialogApi;
  }
}
