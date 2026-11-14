/**
 * Preload диалога «Добавить профиль» (отдельное BrowserWindow, sandbox: true).
 *
 * Форма отправляется каналом profile:add (валидация — в main, как и раньше);
 * dialog:close закрывает окно. Больше диалогу ничего не нужно.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { NewProfileInput, ProfileFormDialogApi } from './main/types';

const api: ProfileFormDialogApi = {
  addProfile: (input: NewProfileInput) => ipcRenderer.invoke('profile:add', input),
  closeWindow: () => ipcRenderer.send('dialog:close'),
};

contextBridge.exposeInMainWorld('profileForm', api);

declare global {
  interface Window {
    profileForm: ProfileFormDialogApi;
  }
}
