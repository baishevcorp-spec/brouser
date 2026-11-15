/**
 * Renderer окна «Настройки» (отдельное BrowserWindow).
 *
 * Раздел «Расширения»: для выбранного профиля — список подключённых
 * распакованных расширений с статусами (загружено/ошибка), добавить через
 * системный выбор папки (preload → ext:pick-dir, проверка manifest.json в
 * main), убрать (конфиг + живая сессия). Тема — из query (?theme).
 * Состояние перечитывается после каждого действия и по кнопке «Обновить».
 */
import type { AppState, ProfileState } from '../main/types';
import { mountIcons } from './icons';

const api = window.settingsDialog;

const q = new URLSearchParams(window.location.search);
const theme = (q.get('theme') ?? 'dark') as 'dark' | 'teal' | 'light';

const profileSelect = document.getElementById('s-profile') as HTMLSelectElement;
const refreshBtn = document.getElementById('s-refresh') as HTMLButtonElement;
const extListEl = document.getElementById('s-ext-list') as HTMLElement;
const addBtn = document.getElementById('s-add') as HTMLButtonElement;
const reloadEl = document.getElementById('s-reload') as HTMLInputElement;
const statusEl = document.getElementById('s-status') as HTMLElement;
const rotationInfoEl = document.getElementById('s-rotation-info') as HTMLElement;
const rotateBtn = document.getElementById('s-rotate') as HTMLButtonElement;

/** Текущий снимок состояния; выбранный профиль сохраняется между обновками. */
let state: AppState | null = null;
let selectedId: string | null = null;
/** Действие в полёте (кнопки блокируются, чтобы не задваивать). */
let busy = false;

document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.theme = theme;
  mountIcons();
  bind();
  void refresh();
});

function bind(): void {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.closeWindow();
  });
  profileSelect.addEventListener('change', () => {
    selectedId = profileSelect.value || null;
    renderExtensions();
  });
  refreshBtn.addEventListener('click', () => void refresh());

  addBtn.addEventListener('click', () => {
    if (busy || !selectedId) return;
    void api.pickExtensionDir().then((res) => {
      if (!res.ok || !res.path) {
        if (res.error && res.error !== 'Отменено') setStatus('err', res.error);
        return;
      }
      void apply(() => api.addExtensions(selectedId as string, [res.path as string], reloadEl.checked));
    });
  });

  // Удаление строки: делегирование — кнопки создаются динамически.
  extListEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-remove]');
    if (!btn || busy || !selectedId) return;
    const source = btn.dataset.remove as string;
    void apply(() => api.removeExtension(selectedId as string, source, reloadEl.checked));
  });

  // Ротация мобильного прокси (P3): ручная смена IP выбранного профиля.
  rotateBtn.addEventListener('click', () => {
    if (busy || !selectedId) return;
    void apply(() => api.rotateProxy(selectedId as string));
  });
}

/** Перечитать состояние и перерисовать (после действий / «Обновить»). */
async function refresh(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    state = await api.getState();
  } catch (err) {
    setStatus('err', String(err));
    busy = false;
    return;
  }
  busy = false;
  renderProfiles();
  renderExtensions();
}

/** Общий прогон действия: busy-флаг → действие → статус → перечитка списка. */
async function apply(fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
  if (busy) return;
  busy = true;
  addBtn.disabled = true;
  refreshBtn.disabled = true;
  try {
    const res = await fn();
    if (res.ok) {
      setStatus('ok', res.error ? `Готово (частично: ${res.error})` : 'Готово');
    } else {
      setStatus('err', res.error ?? 'Действие не удалось');
    }
  } catch (err) {
    setStatus('err', String(err));
  } finally {
    busy = false;
    addBtn.disabled = false;
    refreshBtn.disabled = false;
    void refresh();
  }
}

function renderProfiles(): void {
  if (!state) return;
  const profiles = state.profiles;
  if (profiles.length === 0) {
    profileSelect.innerHTML = '';
    profileSelect.disabled = true;
    return;
  }
  profileSelect.disabled = false;
  profileSelect.innerHTML = '';
  for (const p of profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} · расширений: ${p.extensions.length}`;
    profileSelect.appendChild(opt);
  }
  const stillExists = profiles.some((p) => p.id === selectedId);
  selectedId = stillExists ? selectedId : profiles[0]?.id ?? null;
  profileSelect.value = selectedId ?? '';
}

function renderExtensions(): void {
  if (!state) return;
  const profile: ProfileState | undefined = state.profiles.find((p) => p.id === selectedId);
  extListEl.innerHTML = '';
  renderRotation(profile);
  if (!profile) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'Профиль не найден (удалён?) — нажмите «Обновить» или закройте окно.';
    extListEl.appendChild(empty);
    return;
  }
  if (profile.extensions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = 'Расширений нет — добавьте первую папку кнопкой ниже.';
    extListEl.appendChild(empty);
    return;
  }
  for (const ext of profile.extensions) {
    const row = document.createElement('div');
    row.className = 'ext-row';

    const path = document.createElement('span');
    path.className = 'ext-path';
    path.textContent = ext.source;
    path.title = ext.source;
    row.appendChild(path);

    const badge = document.createElement('span');
    badge.className = `badge ${ext.ok ? 'ok' : 'err'}`;
    badge.textContent = ext.ok
      ? `✓ ${ext.name ?? 'загружено'}`
      : `✗ ${ext.error ?? 'ошибка загрузки'}`;
    badge.title = ext.ok ? `Загружено в сессию${ext.name ? `: ${ext.name}` : ''}` : String(ext.error ?? '');
    row.appendChild(badge);

    // P3: предупреждение совместимости (MV3 service_worker — Electron 33).
    if (ext.note) {
      const note = document.createElement('span');
      note.className = 'badge warn';
      note.textContent = '⚠ MV3';
      note.title = ext.note;
      row.appendChild(note);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ibtn sm danger';
    btn.dataset.remove = ext.source;
    btn.dataset.icon = 'trash';
    btn.setAttribute('aria-label', `Убрать расширение ${ext.source}`);
    btn.dataset.tip = 'Убрать расширение из профиля и выгрузить из сессии';
    row.appendChild(btn);
    extListEl.appendChild(row);
  }
  mountIcons(extListEl);
}

/** Ротация мобильного прокси выбранного профиля: строка статуса + доступность кнопки. */
function renderRotation(profile: ProfileState | undefined): void {
  if (!profile) {
    rotationInfoEl.textContent = '—';
    rotateBtn.disabled = true;
    return;
  }
  const rot = profile.proxyRotation;
  if (!profile.hasProxy) {
    rotationInfoEl.textContent = 'у профиля нет прокси — ротация не настроена';
    rotateBtn.disabled = true;
    return;
  }
  rotateBtn.disabled = false;
  if (rot) {
    const sched = rot.intervalMin > 0 ? `каждые ${rot.intervalMin} мин` : 'только вручную';
    rotationInfoEl.textContent = `${sched}${rot.hasUrl ? ' • URL провайдера задан' : ''}`;
  } else {
    rotationInfoEl.textContent = 'авто-смена выключена — включается в config.json (proxyRotation)';
  }
}

function setStatus(kind: 'ok' | 'err', text: string): void {
  statusEl.hidden = false;
  statusEl.classList.remove('ok', 'err');
  statusEl.classList.add(kind);
  statusEl.textContent = text;
}
