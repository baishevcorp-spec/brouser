/**
 * Preload окна rich-тултипов (прозрачное always-on-top окно, sandbox: true).
 *
 * Main присылает tooltip:render {gen, title, body, theme}; окно отрисовывает
 * карточку, меряет её и отвечает tooltip:measured {gen, w, h} — main ставит
 * окну финальные bounds и показывает его (см. windows/tooltipWindow.ts).
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { TooltipRenderData, TooltipWindowApi } from './main/types';

const api: TooltipWindowApi = {
  onRender: (cb: (data: TooltipRenderData) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, data: TooltipRenderData): void => cb(data);
    ipcRenderer.on('tooltip:render', listener);
    return () => {
      ipcRenderer.removeListener('tooltip:render', listener);
    };
  },
  measured: (gen: number, width: number, height: number) =>
    ipcRenderer.send('tooltip:measured', gen, width, height),
};

contextBridge.exposeInMainWorld('tipApi', api);

declare global {
  interface Window {
    tipApi: TooltipWindowApi;
  }
}
