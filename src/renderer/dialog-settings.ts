/**
 * Renderer окна «Настройки» (отдельное BrowserWindow).
 *
 * Раздел «Расширения»: для выбранного профиля — список подключённых
 * распакованных расширений с статусами (загружено/ошибка), добавить через
 * системный выбор папки (preload → ext:pick-dir, проверка manifest.json в
 * main), убрать (конфиг + живая сессия). Тема — из query (?theme).
 * Состояние перечитывается после каждого действия и по кнопке «Обновить».
 *
 * Раздел «AI-ассистент» (P4, этап 1): режим Cloud/Local/Auto, endpoints и
 * модели (настраиваются — модели Ollama Cloud со временем меняются),
 * API-ключ (не возвращается из main — только факт наличия), проба
 * доступности и сохранение. Ключ «удалить» — отдельная кнопка, чтобы
 * пустое поле означало «не трогать», а не «стереть».
 */
import type { AppState, AssistantConfigView, AssistantStatus, ProfileState } from '../main/types';
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

// ---------- AI-ассистент ----------
const aMode = document.getElementById('a-mode') as HTMLSelectElement;
const aCloudEndpoint = document.getElementById('a-cloud-endpoint') as HTMLInputElement;
const aCloudModel = document.getElementById('a-cloud-model') as HTMLInputElement;
const aLocalEndpoint = document.getElementById('a-local-endpoint') as HTMLInputElement;
const aLocalModel = document.getElementById('a-local-model') as HTMLInputElement;
const aKey = document.getElementById('a-key') as HTMLInputElement;
const aKeyRemove = document.getElementById('a-key-remove') as HTMLButtonElement;
const aKeyHint = document.getElementById('a-key-hint') as HTMLElement;
const aProbeBtn = document.getElementById('a-probe') as HTMLButtonElement;
const aSaveBtn = document.getElementById('a-save') as HTMLButtonElement;
const aStatus = document.getElementById('a-status') as HTMLElement;

/** Текущий снимок состояния; выбранный профиль сохраняется между обновками. */
let state: AppState | null = null;
let selectedId: string | null = null;
/** Действие в полёте (кнопки блокируются, чтобы не задваивать). */
let busy = false;
/** Пользователь запросил удаление ключа (кнопка ✕). */
let removeKey = false;
/** Последний прочитанный конфиг ассистента. */
let assistantCfg: AssistantConfigView | null = null;

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

  // ---------- AI-ассистент ----------
  aProbeBtn.addEventListener('click', () => void probeAssistant());
  aKeyRemove.addEventListener('click', () => {
    removeKey = true;
    aKey.value = '';
    aKey.placeholder = 'ключ будет удалён при «Сохранить»';
    aKeyRemove.hidden = true;
    setAssistantStatus('err', 'Ключ будет удалён при сохранении');
  });
  aSaveBtn.addEventListener('click', () => void saveAssistant());
}

/** Прочитать и разложить конфиг ассистента по полям (ключ — только факт). */
async function loadAssistantConfig(): Promise<void> {
  try {
    assistantCfg = await api.getAssistantConfig();
  } catch (err) {
    setAssistantStatus('err', `Не удалось прочитать настройки: ${String(err)}`);
    return;
  }
  const cfg = assistantCfg as AssistantConfigView;
  aMode.value = cfg.mode;
  aCloudEndpoint.value = cfg.cloud.endpoint;
  aCloudModel.value = cfg.cloud.model;
  aLocalEndpoint.value = cfg.local.endpoint;
  aLocalModel.value = cfg.local.model;
  removeKey = false;
  aKey.value = '';
  aKeyRemove.hidden = !cfg.hasKey || cfg.keyFromEnv;
  if (cfg.keyFromEnv) {
    aKey.placeholder = 'ключ задан переменной OLLAMA_API_KEY';
    aKeyHint.textContent = 'Ключ берётся из переменной окружения OLLAMA_API_KEY — она главнее сохранённого здесь.';
  } else if (cfg.hasKey) {
    aKey.placeholder = 'ключ задан — введите новый, пусто = не менять';
    aKeyHint.textContent = 'Ключ шифруется системным хранилищем ОС и не показывается обратно. ✕ — удалить сохранённый ключ.';
  } else {
    aKey.placeholder = 'вставьте ключ Ollama Cloud';
    aKeyHint.textContent = 'Ключ шифруется системным хранилищем ОС и не показывается обратно. Альтернатива — переменная окружения OLLAMA_API_KEY.';
  }
}

/** Проверка доступности: «Cloud / Local / Недоступен». */
async function probeAssistant(): Promise<void> {
  if (busy) return;
  busy = true;
  aProbeBtn.disabled = true;
  setAssistantStatus('ok', 'Проверяю…');
  try {
    const s: AssistantStatus = await api.probeAssistant();
    if (s.ok) {
      setAssistantStatus('ok', `Доступен: ${s.label}${s.detail ? ` (${s.detail})` : ''}`);
    } else {
      setAssistantStatus('err', `${s.label}: ${s.detail ?? 'провайдер не отвечает'}`);
    }
  } catch (err) {
    setAssistantStatus('err', String(err));
  } finally {
    busy = false;
    aProbeBtn.disabled = false;
  }
}

/** Сохранить настройки ассистента (ключ: пусто = не трогать, ✕ = удалить). */
async function saveAssistant(): Promise<void> {
  if (busy) return;
  busy = true;
  aSaveBtn.disabled = true;
  try {
    const typedKey = aKey.value.trim();
    const apiKey = removeKey ? '' : typedKey ? typedKey : undefined;
    const res = await api.setAssistantConfig({
      mode: aMode.value as AssistantConfigView['mode'],
      cloud: { endpoint: aCloudEndpoint.value.trim(), model: aCloudModel.value.trim() },
      local: { endpoint: aLocalEndpoint.value.trim(), model: aLocalModel.value.trim() },
      apiKey,
    });
    if (res.ok) {
      setAssistantStatus('ok', 'Настройки ассистента сохранены');
      await loadAssistantConfig();
    } else {
      setAssistantStatus('err', res.error ?? 'Не удалось сохранить');
    }
  } catch (err) {
    setAssistantStatus('err', String(err));
  } finally {
    busy = false;
    aSaveBtn.disabled = false;
  }
}

function setAssistantStatus(kind: 'ok' | 'err', text: string): void {
  aStatus.hidden = false;
  aStatus.classList.remove('ok', 'err');
  aStatus.classList.add(kind);
  aStatus.textContent = text;
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
  void loadAssistantConfig();
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
