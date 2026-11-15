/**
 * Inline SVG-иконки Brouser (stroke/fill наследуют currentColor) и монтаж
 * их в элементы с data-icon. Общий модуль для renderer'ов главного окна
 * и диалоговых окон (esbuild бандлит его в каждый entry).
 */

const S = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const G = (inner: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;

export const ICONS: Record<string, string> = {
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  trash: S('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>'),
  rotate: S('<path d="M20 12a8 8 0 1 1-2.9-6.2"/><path d="M20 4v4h-4"/>'),
  copy: S('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  save: S('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'),
  palette: S('<path d="M12 2s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/>'),
  logs: S('<path d="M4 6h16M4 12h11M4 18h7"/>'),
  code: S('<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/>'),
  minus: S('<path d="M5 12h14"/>'),
  square: S('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  x: S('<path d="M18 6 6 18M6 6l12 12"/>'),
  check: S('<path d="M20 6 9 17l-5-5"/>'),
  alert: S('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  'grid-1x1': G('<rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/>'),
  'grid-1x2': G('<rect x="4" y="4" width="7" height="16" rx="2.5" fill="currentColor"/><rect x="13" y="4" width="7" height="16" rx="2.5" fill="currentColor" opacity=".45"/>'),
  'grid-2x1': G('<rect x="4" y="4" width="16" height="7" rx="2.5" fill="currentColor"/><rect x="4" y="13" width="16" height="7" rx="2.5" fill="currentColor" opacity=".45"/>'),
  'grid-2x2': G('<rect x="4" y="4" width="7" height="7" rx="2.5" fill="currentColor"/><rect x="13" y="4" width="7" height="7" rx="2.5" fill="currentColor" opacity=".45"/><rect x="4" y="13" width="7" height="7" rx="2.5" fill="currentColor" opacity=".45"/><rect x="13" y="13" width="7" height="7" rx="2.5" fill="currentColor"/>'),
  'grid-3x1': G('<rect x="4" y="4" width="16" height="5" rx="2" fill="currentColor"/><rect x="4" y="10" width="16" height="5" rx="2" fill="currentColor" opacity=".45"/><rect x="4" y="16" width="16" height="5" rx="2" fill="currentColor" opacity=".45"/>'),
  'grid-1x3': G('<rect x="4" y="4" width="5" height="16" rx="2" fill="currentColor"/><rect x="10" y="4" width="5" height="16" rx="2" fill="currentColor" opacity=".45"/><rect x="16" y="4" width="5" height="16" rx="2" fill="currentColor" opacity=".45"/>'),
  cookies: S('<circle cx="12" cy="12" r="9"/><path d="M9 10h.01M14.5 8.5h.01M15.5 14h.01M9.5 15h.01M12 12h.01"/>'),
  file: S('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  zap: S('<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>'),
  bot: S('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V5"/><circle cx="12" cy="3.5" r="1.2"/><path d="M9 13v1.5"/><path d="M15 13v1.5"/><path d="M9.5 17h5"/>'),
  settings: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  folder: S('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
};

/** Вставляет иконки во все элементы с data-icon. */
export function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const html = ICONS[el.dataset.icon ?? ''];
    if (html && !el.firstChild) el.insertAdjacentHTML('afterbegin', html);
  });
}
