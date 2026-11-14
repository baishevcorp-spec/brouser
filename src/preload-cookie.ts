/**
 * Preload диалога «Импорт cookies» (отдельное BrowserWindow, sandbox: true).
 *
 * Окну доступен только минимальный API поверх уже существующих каналов:
 *  - cookies:pick-file (системный диалог выбора файла; родитель — само окно);
 *  - cookies:import (валидация и запись в сессию профиля — в main);
 *  - view:reload (опциональная перезагрузка ячейки после импорта);
 *  - dialog:close (закрыть окно).
 * Никакого Node, никаких новых привилегий относительно старой HTML-модалки.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { CookieDialogApi, CookieImportInput } from './main/types';

const api: CookieDialogApi = {
  pickFile: () => ipcRenderer.invoke('cookies:pick-file'),
  importCookies: (profileId: string, input: CookieImportInput) =>
    ipcRenderer.invoke('cookies:import', profileId, input),
  reloadProfile: (profileId: string) => ipcRenderer.invoke('view:reload', profileId),
  closeWindow: () => ipcRenderer.send('dialog:close'),
};

contextBridge.exposeInMainWorld('cookieDialog', api);

declare global {
  interface Window {
    cookieDialog: CookieDialogApi;
  }
}
