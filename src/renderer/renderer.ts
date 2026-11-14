/**
 * Renderer Brouser: панель инструментов, сетка профилей, модальное окно, журнал.
 *
 * С P1.1 renderer НЕ измеряет и НЕ отправляет координаты ячеек: геометрию
 * считает main (layout.ts) по contentBounds окна. Роль renderer:
 *  - рисовать «оболочку» сетки (шапки ячеек, заглушки пустых ячеек);
 *  - слать layout-ready после первого рендера (handshake, P1.2);
 *  - слать состояние панели журнала (main резервирует под неё место);
 *  - применять константы геометрии из preload в CSS-переменные — чтобы
 *    отрисовка совпадала с расчётом ячеек в main байт-в-байт.
 */
import { LAYOUTS, THEMES } from '../main/types';
import type { AppState, NewProfileInput, ProfileState, ThemeId } from '../main/types';

const api = window.brouser;

// ------------------------------------------------------------------
// Иконки (inline SVG; stroke/fill наследуют currentColor)
// ------------------------------------------------------------------

const S = (inner: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const G = (inner: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;

const ICONS: Record<string, string> = {
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
};

/** Вставляет иконки во все элементы с data-icon. */
function mountIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const html = ICONS[el.dataset.icon ?? ''];
    if (html && !el.firstChild) el.insertAdjacentHTML('afterbegin', html);
  });
}

// ------------------------------------------------------------------
// Состояние
// ------------------------------------------------------------------

let state: AppState = { profiles: [], layout: '2x2', theme: 'dark', capacity: 4, logs: [] };
let selectedId: string | null = null;
let logOpen = false;

const gridEl = document.getElementById('grid') as HTMLElement;
const toolbarEl = document.getElementById('toolbar') as HTMLElement;
const counterEl = document.getElementById('counter') as HTMLElement;
const removeBtn = document.getElementById('btn-remove') as HTMLButtonElement;
const themeBtn = document.getElementById('btn-theme') as HTMLButtonElement;
const logsBtn = document.getElementById('btn-logs') as HTMLButtonElement;
const logPanelEl = document.getElementById('logpanel') as HTMLElement;
const toastEl = document.getElementById('toast') as HTMLElement;

const overlayEl = document.getElementById('modal-overlay') as HTMLElement;
const formEl = document.getElementById('modal') as HTMLFormElement;
const fName = document.getElementById('f-name') as HTMLInputElement;
const fUrl = document.getElementById('f-url') as HTMLInputElement;
const fProxy = document.getElementById('f-proxy') as HTMLInputElement;
const fExt = document.getElementById('f-ext') as HTMLTextAreaElement;
const fUa = document.getElementById('f-ua') as HTMLInputElement;
const fTz = document.getElementById('f-tz') as HTMLInputElement;

// ------------------------------------------------------------------
// Запуск
// ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  mountIcons();
  bindToolbar();
  bindModal();

  // Геометрия из preload -> CSS-переменные (P1.1): отрисовка в renderer
  // и расчёт ячеек в main используют один источник констант.
  applyGeometryVars();

  // Первичное состояние; после первого рендера — handshake layout-ready (P1.2):
  // окно уже имеет финальные размеры, main может расставить представления.
  api
    .getState()
    .then((s) => {
      state = s;
      applyTheme();
      renderAll();
      api.layoutReady();
    })
    .catch((err) => console.error('state:get failed', err));

  // События main -> renderer. Координаты ячеек больше не ходят по IPC:
  // main сам пересчитывает сетку при resize/раскладке/профилях.
  api.onProfilesUpdated((s) => {
    state = s;
    applyTheme();
    renderAll();
  });
  api.onLayoutChanged((layout) => {
    state.layout = layout;
    state.capacity = LAYOUTS[layout].cells;
    renderAll();
  });
  api.onLogMessage((entry) => {
    state.logs = [...state.logs, entry].slice(-60);
    renderLogs();
    updateLogDot();
  });
});

/** Константы геометрии (layout.ts в main) -> CSS-переменные документа. */
function applyGeometryVars(): void {
  const g = api.GEOMETRY;
  const root = document.documentElement;
  root.style.setProperty('--app-pad', `${g.appPad}px`);
  root.style.setProperty('--app-gap', `${g.appGap}px`);
  root.style.setProperty('--toolbar-h', `${g.toolbarH}px`);
  root.style.setProperty('--grid-gap', `${g.gridGap}px`);
  root.style.setProperty('--cell-head-h', `${g.cellHeadH}px`);
  root.style.setProperty('--cell-gap', `${g.cellGap}px`);
}

// ------------------------------------------------------------------
// Тема
// ------------------------------------------------------------------

function applyTheme(): void {
  document.documentElement.dataset.theme = state.theme;
}

function cycleTheme(): void {
  const idx = THEMES.indexOf(state.theme);
  const next = THEMES[(idx + 1) % THEMES.length] as ThemeId;
  state.theme = next; // мгновенный отклик, main подтвердит событием
  applyTheme();
  void api.setTheme(next);
}

// ------------------------------------------------------------------
// Панель инструментов
// ------------------------------------------------------------------

function bindToolbar(): void {
  // Раскладки.
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void api.setLayout(btn.dataset.layout as AppState['layout']);
    });
  });

  document.getElementById('btn-add')?.addEventListener('click', openModal);
  document.getElementById('btn-reload-all')?.addEventListener('click', () => void api.reloadAll());
  document.getElementById('btn-save')?.addEventListener('click', async () => {
    const res = await api.saveConfig();
    toast(res.ok ? 'ok' : 'err');
  });
  themeBtn.addEventListener('click', cycleTheme);

  // Удаление выбранного профиля: первое нажатие «взводит» кнопку,
  // второе (в течение 2.5 c) удаляет.
  removeBtn.addEventListener('click', () => {
    if (!selectedId) return;
    if (removeBtn.classList.contains('armed')) {
      disarmRemove();
      void api.removeProfile(selectedId);
      selectedId = null;
      updateRemoveBtn();
    } else {
      removeBtn.classList.add('armed');
      removeBtn.dataset.tip = 'Нажмите ещё раз для удаления';
      setTimeout(disarmRemove, 2500);
    }
  });

  // Журнал: открытие/закрытие меняет доступную сетке ширину — сообщаем main,
  // чтобы он резервировал место под панель и не перекрывал views.
  logsBtn.addEventListener('click', () => {
    logOpen = !logOpen;
    logsBtn.setAttribute('aria-expanded', String(logOpen));
    logPanelEl.hidden = !logOpen;
    api.setLogPanel(logOpen);
    if (logOpen) renderLogs();
  });

  // Кнопки окна (frameless) + разворот по двойному клику на панели.
  document.getElementById('win-min')?.addEventListener('click', () => void api.minimize());
  document.getElementById('win-max')?.addEventListener('click', () => void api.toggleMaximize());
  document.getElementById('win-close')?.addEventListener('click', () => void api.close());
  toolbarEl.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    void api.toggleMaximize();
  });
}

function disarmRemove(): void {
  removeBtn.classList.remove('armed');
  removeBtn.dataset.tip = 'Удалить выбранный профиль — нажмите дважды';
}

function updateRemoveBtn(): void {
  removeBtn.disabled = selectedId === null;
}

// ------------------------------------------------------------------
// Сетка
// ------------------------------------------------------------------

function renderAll(): void {
  const { rows, cols, cells } = LAYOUTS[state.layout];

  gridEl.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  gridEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  gridEl.replaceChildren();

  const visible = state.profiles.slice(0, cells);
  for (let i = 0; i < cells; i++) {
    const p = visible[i];
    gridEl.appendChild(p ? buildCell(p) : buildEmptyCell());
  }

  // Счётчик профилей/ячеек.
  counterEl.textContent = `${state.profiles.length}/${cells}`;
  counterEl.dataset.tip = `Профилей: ${state.profiles.length} — в сетке: ${Math.min(state.profiles.length, cells)}`;

  // Активная кнопка раскладки.
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((btn) => {
    const active = btn.dataset.layout === state.layout;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  // Выделение могло исчезнуть (профиль удалён / скрыт).
  if (selectedId && !state.profiles.some((p) => p.id === selectedId)) {
    selectedId = null;
  }
  updateRemoveBtn();
}

function buildCell(p: ProfileState): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'cell' + (p.id === selectedId ? ' selected' : '');

  // --- Шапка ячейки ---
  const head = document.createElement('div');
  head.className = 'cell-head';
  head.dataset.id = p.id;
  // Тултип со сводкой профиля (вместо текста в интерфейсе).
  head.dataset.tip = cellTooltip(p);

  const dot = document.createElement('span');
  dot.className = 'dot';

  const title = document.createElement('span');
  title.className = 'cell-title';
  title.textContent = p.name;

  head.append(dot, title);

  // Кнопки шапки: дублировать / обновить / devtools / удалить.
  const btnCopy = iconButton('copy', 'Дублировать профиль (настройки и прокси копируются, отпечаток будет свой)', 'top');
  btnCopy.addEventListener('click', () => {
    void api.duplicateProfile(p.id).then((res) => {
      toast(res.ok ? 'ok' : 'err');
    });
  });

  const btnReload = iconButton('rotate', 'Обновить', 'top');
  btnReload.addEventListener('click', () => void api.reloadView(p.id));

  const btnDev = iconButton('code', 'DevTools (отдельное окно)', 'top');
  btnDev.addEventListener('click', () => void api.openDevTools(p.id));

  const btnDel = iconButton('trash', 'Удалить профиль — нажмите дважды', 'top');
  btnDel.classList.add('sm', 'danger');
  btnDel.addEventListener('click', () => {
    if (btnDel.classList.contains('armed')) {
      void api.removeProfile(p.id);
      if (selectedId === p.id) selectedId = null;
      updateRemoveBtn();
    } else {
      btnDel.classList.add('armed');
      btnDel.dataset.tip = 'Нажмите ещё раз для удаления';
      setTimeout(() => {
        btnDel.classList.remove('armed');
        btnDel.dataset.tip = 'Удалить профиль — нажмите дважды';
      }, 2500);
    }
  });

  head.append(btnCopy, btnReload, btnDev, btnDel);

  // Клик по шапке выделяет профиль (для кнопки удаления в тулбаре).
  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    selectedId = selectedId === p.id ? null : p.id;
    renderAll();
  });

  // --- Тело ячейки: сюда main кладёт WebContentsView (координаты считает сам) ---
  const body = document.createElement('div');
  body.className = 'cell-body';
  body.dataset.viewId = p.id;

  cell.append(head, body);
  return cell;
}

function buildEmptyCell(): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'cell-empty';
  const btn = iconButton('plus', 'Добавить профиль', 'top');
  btn.addEventListener('click', openModal);
  cell.appendChild(btn);
  return cell;
}

function iconButton(icon: string, tip: string, pos?: 'top'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ibtn sm';
  btn.dataset.icon = icon;
  btn.dataset.tip = tip;
  if (pos) btn.dataset.tipPos = pos;
  btn.setAttribute('aria-label', tip);
  btn.innerHTML = ICONS[icon] ?? '';
  return btn;
}

/** Сводка профиля для тултипа шапки ячейки. */
function cellTooltip(p: ProfileState): string {
  const parts = [`${p.name} — ${p.url}`];
  if (p.hasProxy) parts.push(`прокси: ${p.proxyScheme ?? 'вкл'}`);
  if (p.extensions.length > 0) {
    const okCount = p.extensions.filter((e) => e.ok).length;
    parts.push(`расширений: ${okCount}/${p.extensions.length}`);
  }
  if (p.timezone) parts.push(`таймзона: ${p.timezone}`);
  if (p.locale) parts.push(`язык: ${p.locale}`);
  if (p.userAgentSet) parts.push('свой UA');
  parts.push(`fp: seed=${p.fingerprintSeed ?? 'auto'}`);
  return parts.join(' • ');
}

// ------------------------------------------------------------------
// Модальное окно «Добавить профиль»
// ------------------------------------------------------------------

function openModal(): void {
  formEl.reset();
  overlayEl.hidden = false;
  fName.focus();
}

function closeModal(): void {
  overlayEl.hidden = true;
}

function bindModal(): void {
  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-cancel')?.addEventListener('click', closeModal);
  overlayEl.addEventListener('mousedown', (e) => {
    if (e.target === overlayEl) closeModal();
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const input: NewProfileInput = {
      name: fName.value.trim(),
      url: fUrl.value.trim(),
      proxy: fProxy.value.trim(),
      extensions: fExt.value,
      userAgent: fUa.value.trim(),
      timezone: fTz.value.trim(),
    };
    if (!input.name) {
      toast('err');
      return;
    }
    void api.addProfile(input).then((res) => {
      toast(res.ok ? 'ok' : 'err');
      if (res.ok) closeModal();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!overlayEl.hidden) closeModal();
      else if (logOpen) {
        logOpen = false;
        logsBtn.setAttribute('aria-expanded', 'false');
        logPanelEl.hidden = true;
        api.setLogPanel(false);
      }
    }
  });
}

// ------------------------------------------------------------------
// Журнал и тост
// ------------------------------------------------------------------

function renderLogs(): void {
  if (logPanelEl.hidden) return;
  logPanelEl.replaceChildren();
  for (const entry of state.logs.slice(-40)) {
    const row = document.createElement('div');
    row.className = `log-row ${entry.level}`;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date(entry.time).toLocaleTimeString('ru-RU');
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = entry.message;
    row.append(t, m);
    logPanelEl.appendChild(row);
  }
  logPanelEl.scrollTop = logPanelEl.scrollHeight;
}

/** Красная точка на кнопке журнала, если есть свежие ошибки. */
function updateLogDot(): void {
  const hasError = state.logs.slice(-15).some((e) => e.level === 'error');
  if (hasError) logsBtn.dataset.err = '1';
  else delete logsBtn.dataset.err;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function toast(kind: 'ok' | 'err'): void {
  toastEl.className = 'counter ' + kind;
  toastEl.innerHTML = ICONS[kind === 'ok' ? 'check' : 'alert'] ?? '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 1600);
}
