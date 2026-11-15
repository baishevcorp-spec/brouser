/**
 * Renderer Brouser: панель инструментов, сетка профилей, журнал, тултипы.
 *
 * С P1.1 renderer НЕ измеряет и НЕ отправляет координаты ячеек: геометрию
 * считает main (layout.ts) по contentBounds окна. Роль renderer:
 *  - рисовать «оболочку» сетки (шапки ячеек, заглушки пустых ячеек);
 *  - слать layout-ready после первого рендера (handshake, P1.2);
 *  - слать состояние панели журнала (main резервирует под неё место);
 *  - применять константы геометрии из preload в CSS-переменные — чтобы
 *    отрисовка совпадала с расчётом ячеек в main байт-в-байт.
 *
 * UI-фикс (модалки/подсказки поверх WebContentsView): HTML-модалки и
 * CSS-тултипы этого окна перекрываются нативным слоем views. Поэтому
 * все диалоги открываются отдельными BrowserWindow (main:
 * windows/dialogWindow.ts) по командам open*Dialog, а rich-тултипы
 * (tooltips.ts) рендерятся в прозрачном always-on-top окне через
 * api.tooltipShow/tooltipHide.
 */
import { LAYOUTS, THEMES } from '../main/types';
import type { AppState, ProfileState, ThemeId } from '../main/types';
import { ICONS, mountIcons } from './icons';
import { resolveTooltip } from './tooltips';

const api = window.brouser;

// ------------------------------------------------------------------
// Состояние
// ------------------------------------------------------------------

let state: AppState = { profiles: [], layout: '2x2', theme: 'dark', capacity: 4, logs: [], inputSync: false };
let selectedId: string | null = null;
let logOpen = false;

const gridEl = document.getElementById('grid') as HTMLElement;
const toolbarEl = document.getElementById('toolbar') as HTMLElement;
const counterEl = document.getElementById('counter') as HTMLElement;
const removeBtn = document.getElementById('btn-remove') as HTMLButtonElement;
const themeBtn = document.getElementById('btn-theme') as HTMLButtonElement;
const syncBtn = document.getElementById('btn-sync') as HTMLButtonElement;
const logsBtn = document.getElementById('btn-logs') as HTMLButtonElement;
const logPanelEl = document.getElementById('logpanel') as HTMLElement;
const toastEl = document.getElementById('toast') as HTMLElement;

// ------------------------------------------------------------------
// Запуск
// ------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  mountIcons();
  bindToolbar();
  bindTooltips();

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

  // Модалки — отдельные BrowserWindow (UI-фикс: HTML-модалки перекрывались
  // WebContentsView). См. main/windows/dialogWindow.ts.
  document.getElementById('btn-add')?.addEventListener('click', () => {
    void api.openProfileForm().then((res) => {
      if (!res.ok) toast('err');
    });
  });

  document.getElementById('btn-reload-all')?.addEventListener('click', () => void api.reloadAll());
  document.getElementById('btn-save')?.addEventListener('click', async () => {
    const res = await api.saveConfig();
    toast(res.ok ? 'ok' : 'err');
  });
  themeBtn.addEventListener('click', cycleTheme);

  // Синхронизатор действий (P3): тумблер в тулбаре; состояние приходит
  // событием profiles-updated (main подтвердит).
  syncBtn.addEventListener('click', () => {
    void api.setInputSync(!state.inputSync).then((res) => {
      toast(res.ok ? 'ok' : 'err');
    });
  });

  // Удаление выбранного профиля: подтверждение в отдельном окне
  // (HTML-подтверждение перекрывалось views; «armed»-кнопка ушла).
  removeBtn.addEventListener('click', () => {
    if (!selectedId) return;
    void api.openDeleteConfirm(selectedId).then((res) => {
      if (!res.ok) toast('err');
    });
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

  // Настройки: управление расширениями профилей (отдельное окно).
  document.getElementById('btn-settings')?.addEventListener('click', () => {
    void api.openSettings().then((res) => {
      if (!res.ok) toast('err');
    });
  });

  // Кнопки окна (frameless) + разворот по двойному клику на панели.
  document.getElementById('win-min')?.addEventListener('click', () => void api.minimize());
  document.getElementById('win-max')?.addEventListener('click', () => void api.toggleMaximize());
  document.getElementById('win-close')?.addEventListener('click', () => void api.close());
  toolbarEl.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    void api.toggleMaximize();
  });

  // Escape: закрываем панель журнала (диалоги живут в отдельных окнах и
  // обрабатывают Esc сами).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && logOpen) {
      logOpen = false;
      logsBtn.setAttribute('aria-expanded', 'false');
      logPanelEl.hidden = true;
      api.setLogPanel(false);
    }
  });
}

function updateRemoveBtn(): void {
  removeBtn.disabled = selectedId === null;
}

// ------------------------------------------------------------------
// Сетка
// ------------------------------------------------------------------

function renderAll(): void {
  const { rows, cols, cells } = LAYOUTS[state.layout];

  // Перерисовка сетки заменяет DOM под курсором без mouseout — гасим тултип,
  // если он был над элементом сетки.
  hideTooltipIfStale();

  gridEl.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  gridEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  gridEl.replaceChildren();

  const visible = state.profiles.slice(0, cells);
  for (let i = 0; i < cells; i++) {
    const p = visible[i];
    gridEl.appendChild(p ? buildCell(p) : buildEmptyCell());
  }

  // Счётчик профилей/ячеек (rich-тултип — над сеткой, поверх views).
  counterEl.textContent = `${state.profiles.length}/${cells}`;
  counterEl.dataset.tipId = 'counter';

  // Активная кнопка раскладки.
  document.querySelectorAll<HTMLButtonElement>('[data-layout]').forEach((btn) => {
    const active = btn.dataset.layout === state.layout;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  // Синхронизатор: активное состояние кнопки + rich-тултип о состоянии.
  syncBtn.classList.toggle('active', state.inputSync);
  syncBtn.setAttribute('aria-pressed', String(state.inputSync));
  syncBtn.dataset.tipId = state.inputSync ? 'btn-sync-on' : 'btn-sync-off';

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
  // Rich-тултип со сводкой профиля: динамические title+body (над views).
  head.dataset.tipTitle = p.name;
  head.dataset.tipBody = cellTooltip(p);

  const dot = document.createElement('span');
  dot.className = 'dot';

  const title = document.createElement('span');
  title.className = 'cell-title';
  title.textContent = p.name;

  head.append(dot, title);

  // Кнопки шапки: дублировать / импорт cookies / обновить / devtools / удалить.
  const btnCopy = iconButton('copy', 'cell-copy', 'top');
  btnCopy.addEventListener('click', () => {
    void api.duplicateProfile(p.id).then((res) => {
      toast(res.ok ? 'ok' : 'err');
    });
  });

  // Импорт cookies — отдельное окно (HTML-модалка уходила под views).
  const btnCookies = iconButton('cookies', 'cell-cookies', 'top');
  btnCookies.addEventListener('click', () => {
    void api.openCookieImport(p.id).then((res) => {
      if (!res.ok) toast('err');
    });
  });

  const btnReload = iconButton('rotate', 'cell-reload', 'top');
  btnReload.addEventListener('click', () => void api.reloadView(p.id));

  const btnDev = iconButton('code', 'cell-devtools', 'top');
  btnDev.addEventListener('click', () => void api.openDevTools(p.id));

  const btnDel = iconButton('trash', 'cell-delete', 'top');
  btnDel.classList.add('sm', 'danger');
  btnDel.addEventListener('click', () => {
    void api.openDeleteConfirm(p.id).then((res) => {
      if (!res.ok) toast('err');
    });
  });

  head.append(btnCopy, btnCookies, btnReload, btnDev, btnDel);

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
  const btn = iconButton('plus', 'cell-empty-add', 'top');
  btn.addEventListener('click', () => {
    void api.openProfileForm().then((res) => {
      if (!res.ok) toast('err');
    });
  });
  cell.appendChild(btn);
  return cell;
}

function iconButton(icon: string, tipId: string, pos?: 'top'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ibtn sm';
  btn.dataset.icon = icon;
  btn.dataset.tipId = tipId;
  if (pos) btn.dataset.tipPos = pos;
  btn.setAttribute('aria-label', tipId);
  btn.innerHTML = ICONS[icon] ?? '';
  return btn;
}

/** Сводка профиля для тела rich-тултипа шапки ячейки. */
function cellTooltip(p: ProfileState): string {
  const parts = [p.url];
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
// Rich-тултипы поверх WebContentsView
// ------------------------------------------------------------------

/**
 * HTML-тултипы этого окна перекрываются нативными views — поэтому контент
 * подсказок (tooltips.ts: data-tip-id / data-tip-title / data-tip) уходит
 * в main (tooltip:show), а рисует его прозрачное always-on-top окно.
 * Задержка показа 300 мс — как у прежних CSS-тултипов.
 */
const TIP_DELAY = 300;
let tipTimer: ReturnType<typeof setTimeout> | undefined;
/** Элемент, над которым сейчас тултип (или запланирован). */
let tipEl: HTMLElement | null = null;

function tipTarget(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof Element)) return null;
  const found = el.closest<HTMLElement>('[data-tip], [data-tip-id], [data-tip-title]');
  return found ?? null;
}

function hideTooltipIfStale(): void {
  if (tipEl && gridEl.contains(tipEl)) {
    clearTimeout(tipTimer);
    tipEl = null;
    api.tooltipHide();
  }
}

function bindTooltips(): void {
  const scheduleShow = (el: HTMLElement): void => {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (tipEl !== el) return;
      const content = resolveTooltip(el);
      if (!content) return;
      const r = el.getBoundingClientRect();
      api.tooltipShow({
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        preferTop: el.dataset.tipPos === 'top',
        title: content.title,
        body: content.body,
      });
    }, TIP_DELAY);
  };

  document.addEventListener('mouseover', (e) => {
    const el = tipTarget(e.target);
    if (el === tipEl) return;
    tipEl = el;
    if (!el) {
      clearTimeout(tipTimer);
      api.tooltipHide();
      return;
    }
    const content = resolveTooltip(el);
    if (!content) {
      clearTimeout(tipTimer);
      api.tooltipHide();
      return;
    }
    scheduleShow(el);
  });

  document.addEventListener('mouseout', (e) => {
    const from = tipTarget(e.target);
    if (!from || from !== tipEl) return;
    const to = tipTarget(e.relatedTarget);
    if (to === tipEl) return;
    clearTimeout(tipTimer);
    tipEl = null;
    api.tooltipHide();
  });

  // Клавиатурная доступность: тултип на клавиатурном фокусе (:focus-visible —
  // как раньше в CSS), клик по кнопке его не дёргает.
  document.addEventListener('focusin', (e) => {
    const el = tipTarget(e.target);
    if (!el || !el.matches(':focus-visible')) return;
    tipEl = el;
    const content = resolveTooltip(el);
    if (!content) return;
    const r = el.getBoundingClientRect();
    api.tooltipShow({
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      preferTop: el.dataset.tipPos === 'top',
      title: content.title,
      body: content.body,
    });
  });
  document.addEventListener('focusout', () => {
    if (tipTimer) clearTimeout(tipTimer);
    tipEl = null;
    api.tooltipHide();
  });

  // Клик/нажатие клавиши — скрыть (тултип не должен переживать действие).
  document.addEventListener('mousedown', () => {
    clearTimeout(tipTimer);
    api.tooltipHide();
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
