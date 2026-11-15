/**
 * Preload диалога подтверждения удаления профиля (BrowserWindow, sandbox: true).
 *
 * Удаление — операция с человеческим подтверждением: окно показывает имя
 * профиля и две кнопки; «Удалить» дёргает существующий канал profile:remove,
 * успех/ошибка отражаются в окне до закрытия.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { ConfirmDialogApi } from './main/types';

const api: ConfirmDialogApi = {
  removeProfile: (profileId: string) => ipcRenderer.invoke('profile:remove', profileId),
  closeWindow: () => ipcRenderer.send('dialog:close'),
};

contextBridge.exposeInMainWorld('confirmDialog', api);

declare global {
  interface Window {
    confirmDialog: ConfirmDialogApi;
  }
}
