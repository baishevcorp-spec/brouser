/**
 * Brouser — расчёт геометрии сетки в MAIN-процессе (P1.1).
 *
 * Раньше renderer измерял ячейки и слал координаты в main (гонки, дрожание
 * при resize, off-by-one). Теперь main сам вычисляет прямоугольники тел ячеек
 * по contentBounds окна + константам UI_GEOMETRY (единый источник с CSS),
 * а renderer только рисует «оболочку» (шапки ячеек) и шлёт layout-ready /
 * состояние панели журнала.
 *
 * Сетка занимает: contentBounds минус отступы #app, высота тулбара, зазоры.
 * Ячейка = шапка (cellHeadH) + зазор (cellGap) + тело; WebContentsView
 * ставится ровно в тело ячейки.
 */
import type { Rectangle } from 'electron';
import { LayoutId, LAYOUTS, UI_GEOMETRY } from './types';

/** Реэкспорт для preload (window.brouser.GEOMETRY) — единый источник констант. */
export { UI_GEOMETRY };

/** Высота панели инструментов — экспорт для preload (window.brouser.TOOLBAR_HEIGHT). */
export const TOOLBAR_HEIGHT = UI_GEOMETRY.toolbarH;

/** Прямоугольник ячейки (тело) в DIP, относительной начала контента окна. */
export interface Cell {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * «Парковка» представления, не попавшего в текущую раскладку (P1.3):
 * view НЕ уничтожается (сессия/расширения/вкладки живут), а выносится
 * за пределы окна с минимальным размером 1x1.
 *
 * Выбор в пользу x:-10000 (а не width:0): нулевой размер у части версий
 * Chromium триггерит paint-деградацию; off-screen с backgroundThrottling:false
 * гарантирует, что страница продолжит жить и останется «видимой» для
 * расширений (Avito-помощнику нужна активная сессия).
 */
export const PARKED: Cell = { x: -10000, y: 0, width: 1, height: 1 };

/**
 * Вычислить прямоугольники тел ячеек для раскладки.
 *
 * @param layout        идентификатор раскладки ('2x2' и т.п.)
 * @param contentBounds contentBounds окна (нужны только width/height: система
 *                      координат дочерних view — от начала контента окна)
 * @param reservedRight сколько DIP справа не отдавать сетке (панель журнала)
 * @returns массив длиной LAYOUTS[layout].cells
 */
export function computeCells(layout: LayoutId, contentBounds: Rectangle, reservedRight = 0): Cell[] {
  const L = LAYOUTS[layout];
  const g = UI_GEOMETRY;

  const left = g.appPad;
  const top = g.appPad + g.toolbarH + g.appGap;
  const right = Math.max(left, contentBounds.width - g.appPad - Math.max(0, reservedRight));
  const bottom = Math.max(top, contentBounds.height - g.appPad);

  const innerW = Math.max(0, right - left);
  const innerH = Math.max(0, bottom - top);
  const cw = (innerW - (L.cols - 1) * g.gridGap) / L.cols;
  const ch = (innerH - (L.rows - 1) * g.gridGap) / L.rows;

  const cells: Cell[] = [];
  for (let i = 0; i < L.cells; i++) {
    const row = Math.floor(i / L.cols);
    const col = i % L.cols;
    const cellX = left + col * (cw + g.gridGap);
    const cellY = top + row * (ch + g.gridGap);
    cells.push({
      x: Math.round(cellX),
      y: Math.round(cellY + g.cellHeadH + g.cellGap),
      width: Math.max(1, Math.round(cw)),
      height: Math.max(1, Math.round(ch - g.cellHeadH - g.cellGap)),
    });
  }
  return cells;
}

/**
 * Сколько DIP справа резервировать под панель журнала (#logpanel:
 * right:16px, ширина min(430, vw-32) + зазор 10, чтобы view её не перекрывал).
 */
export function logPanelReserve(contentWidth: number, open: boolean): number {
  if (!open) return 0;
  const panelW = Math.min(430, Math.max(0, contentWidth - 32));
  return panelW + 10;
}

/**
 * Сколько DIP справа резервировать под панель AI-ассистента (P4, этап 1).
 * Геометрия = #assistant в styles.css: right:16px, ширина min(400, vw-32),
 * зазор 10 — WebContentsView не перекрывает панель, как у журнала.
 * Панели журнала и ассистента взаимозаменяемы (открытие одной закрывает
 * другую — renderer это гарантирует), но резерв считаем суммой: если обе
 * каким-то образом открыты, сетка честно сожмётся, а не перекроется.
 */
export function assistantPanelReserve(contentWidth: number, open: boolean): number {
  if (!open) return 0;
  const panelW = Math.min(400, Math.max(0, contentWidth - 32));
  return panelW + 10;
}
