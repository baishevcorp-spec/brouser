/**
 * Общие типы проекта Brouser.
 *
 * Файл используется и в main-процессе, и в preload/renderer
 * (renderer импортирует LAYOUTS/THEMES и типы как type-only),
 * поэтому здесь не должно быть импортов из 'electron'.
 */

/** Идентификаторы поддерживаемых раскладок (формат: строки x столбца). */
export type LayoutId = '1x1' | '1x2' | '2x1' | '2x2' | '3x1' | '1x3';

/** Параметры раскладки. */
export interface LayoutInfo {
  rows: number;
  cols: number;
  /** Количество ячеек — сколько профилей отображается одновременно. */
  cells: number;
}

/** Реестр раскладок: 1x2 — горизонтально (1 строка, 2 колонки), 2x1 — вертикально и т.д. */
export const LAYOUTS: Record<LayoutId, LayoutInfo> = {
  '1x1': { rows: 1, cols: 1, cells: 1 },
  '1x2': { rows: 1, cols: 2, cells: 2 },
  '2x1': { rows: 2, cols: 1, cells: 2 },
  '2x2': { rows: 2, cols: 2, cells: 4 },
  '3x1': { rows: 3, cols: 1, cells: 3 },
  '1x3': { rows: 1, cols: 3, cells: 3 },
};

/** Темы интерфейса (порядок циклического переключения). */
export type ThemeId = 'light' | 'dark' | 'teal';

export const THEMES: ThemeId[] = ['dark', 'teal', 'light'];

/** Профиль из config.json. */
export interface ProfileConfig {
  /** Уникальный идентификатор; участвует в partition: persist:profile-<id>. */
  id: string;
  /** Отображаемое имя. */
  name: string;
  /** URL, открываемый в ячейке профиля. */
  url: string;
  /** Прокси: http://user:pass@host:port или socks5://host:port. Пусто — прямое соединение. */
  proxy?: string;
  /**
   * Ротация мобильного прокси (P3): смена IP по расписанию и/или вручную.
   * Работает и для паркованных (невидимых) профилей — сессия поднимается
   * с диска по partition. Гео-эмуляция (таймзона/локаль/координаты) не
   * трогается — «с сохранением гео».
   */
  proxyRotation?: ProxyRotationConfig;
  /** Пути к распакованным расширениям (относительные или абсолютные). */
  extensions?: string[];
  /** Свой User-Agent. Пусто/отсутствует — дефолтный UA Electron. */
  userAgent?: string;
  /** Часовой пояс для эмуляции (например, Europe/Moscow). */
  timezone?: string;
  /** Подмена navigator.platform (опционально). */
  platform?: string;
  /** Подмена navigator.hardwareConcurrency (опционально). */
  hardwareConcurrency?: number;
  /**
   * Seed антидетект-шума профиля (P0.1). Опционально: если не задан —
   * детерминированно выводится из id (хеш FNV-1a), так что отпечаток
   * стабилен между перезапусками. Управляет шумом Canvas/Audio,
   * выбором GPU (WebGL), hardwareConcurrency и deviceMemory.
   */
  fingerprintSeed?: number;
  /**
   * Языки профиля (P3, следующая поверхность антидетекта после P0).
   * BCP47-тег основного языка, напр. "ru-RU". Управляет:
   *   - navigator.language / navigator.languages;
   *   - Accept-Language (CDP Network.setUserAgentOverride.acceptLanguage);
   *   - Intl-локалью (Emulation.setLocaleOverride + JS-патч resolvedOptions).
   * Пусто — выводится из timezone по таблице регионов; нет и timezone —
   * языки не трогаем (нативные).
   */
  locale?: string;
  /**
   * Явная геолокация профиля (P3). Пусто — псевдокоординаты детерминированно
   * выводятся из timezone (центр региона + дрожание по seed), чтобы профили
   * одной таймзоны не светили идентичные координаты.
   * Управляет: Emulation.setGeolocationOverride + JS-патчи
   * navigator.geolocation и permissions.query({name:'geolocation'})='granted'.
   */
  geolocation?: { latitude: number; longitude: number };
}

/**
 * Настройки ротации мобильного прокси профиля (P3).
 * Ротация = 1) GET на rotationUrl провайдера («сменить IP», если задан)
 * + 2) перевзвод сессии на те же proxyRules — Chromium рвёт соединения
 * и новые идут через новый IP. Креды прокси не трогаются (app('login')).
 */
export interface ProxyRotationConfig {
  /** Интервал автосмены IP, минут (1..1440); 0/отсутствие — только вручную. */
  intervalMin: number;
  /** URL «сменить IP» у провайдера прокси (GET, таймаут 20 с), опционально. */
  rotationUrl?: string;
}

/** Сохраняемые размеры окна (по ТЗ достаточно width/height). */
export interface WindowBoundsSize {
  width: number;
  height: number;
}

/** Корневая структура config.json. */
export interface AppConfig {
  profiles: ProfileConfig[];
  layout: LayoutId;
  windowBounds: WindowBoundsSize;
  theme?: ThemeId;
}

/** Данные профиля для renderer (без логинов/паролей прокси). */
export interface ProfileState {
  id: string;
  name: string;
  url: string;
  hasProxy: boolean;
  /** Схема прокси для тултипа (без учётных данных). */
  proxyScheme: string | null;
  extensions: ExtensionState[];
  timezone: string | null;
  userAgentSet: boolean;
  platform: string | null;
  hardwareConcurrency: number | null;
  /** Заданный вручную seed антидетекта (null — выводится из id автоматически). */
  fingerprintSeed: number | null;
  /** Эффективная локаль профиля (явная либо выведенная из timezone). */
  locale: string | null;
  /** Ротация мобильного прокси включена (интервал в минутах; null — выкл). */
  proxyRotation: { intervalMin: number; hasUrl: boolean } | null;
  /** Попадает ли профиль в первые N ячеек текущей раскладки. */
  visible: boolean;
}

/** Полное состояние, отправляемое в renderer. */
export interface AppState {
  profiles: ProfileState[];
  layout: LayoutId;
  theme: ThemeId;
  capacity: number;
  logs: LogEntry[];
  /** Синхронизатор действий включён (P3). */
  inputSync: boolean;
}

export type LogLevel = 'info' | 'warn' | 'error';

/** Одна запись журнала. */
export interface LogEntry {
  time: number;
  level: LogLevel;
  message: string;
}

/** Прямоугольник ячейки сетки в DIP (= координаты WebContentsView в окне). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Геометрия интерфейса (DIP). Единый источник истины для main (layout.ts)
 * и renderer (CSS-переменные применяются из preload) — чтобы расчёт ячеек
 * в main и отрисовка сетки в renderer никогда не разъезжались.
 */
export interface UiGeometry {
  /** Внешние отступы #app (все стороны). */
  appPad: number;
  /** Зазор между тулбаром и сеткой. */
  appGap: number;
  /** Высота панели инструментов. */
  toolbarH: number;
  /** Зазор между ячейками сетки. */
  gridGap: number;
  /** Высота шапки ячейки (имя профиля + кнопки). */
  cellHeadH: number;
  /** Зазор между шапкой и телом ячейки. */
  cellGap: number;
}

/** Значения синхронны с styles.css (там — через CSS-переменные с фолбэками). */
export const UI_GEOMETRY: UiGeometry = {
  appPad: 10,
  appGap: 10,
  toolbarH: 52,
  gridGap: 10,
  cellHeadH: 36,
  cellGap: 8,
};

/** Данные формы «Добавить профиль»: все поля строками, валидация в main. */
export interface NewProfileInput {
  name: string;
  url: string;
  proxy?: string;
  /** Пути расширений — строки, разделённые переводом строки / ';' / ','. */
  extensions?: string;
  userAgent?: string;
  timezone?: string;
  platform?: string;
  hardwareConcurrency?: string;
  /** Ротация мобильного прокси: интервал в минутах ('0'/пусто — выкл). */
  rotationIntervalMin?: string;
  /** URL «сменить IP» у провайдера прокси (необязательно). */
  rotationUrl?: string;
}

/** Результат команд, возвращаемый в renderer. */
export interface CommandResult {
  ok: boolean;
  error?: string;
}

/** Данные формы импорта cookies (P3): текст cookies + параметры импорта. */
export interface CookieImportInput {
  /** Полный текст: Netscape cookies.txt или DevTools-JSON. */
  source: string;
  /** Формат: auto (по содержимому) | netscape | json. */
  format: 'auto' | 'netscape' | 'json';
  /** Фильтр доменов (строка через запятую/пробел); пусто — импортировать все. */
  domains?: string;
}

/** Итог импорта cookies: счётчики по каждой причине отсева. */
export interface CookieImportResult {
  ok: boolean;
  error?: string;
  /** Сколько cookies найдено в источнике. */
  total: number;
  /** Успешно установлено в сессию профиля. */
  imported: number;
  /** Отсечено фильтром домена. */
  skippedDomain: number;
  /** Пропущено как истёкшее. */
  expired: number;
  /** Ошибки cookies.set (Chromium отверг отдельные cookies). */
  failed: number;
}

/** Результат диалога выбора файла cookies (IPC cookies:pick-file). */
export interface FilePickResult {
  ok: boolean;
  error?: string;
  /** Имя файла (для индикации в UI). */
  name?: string;
  /** Содержимое файла (≤ 10 МБ, utf-8). */
  content?: string;
}

/** Результат выбора каталога распакованного расширения (IPC ext:pick-dir). */
export interface DirPickResult {
  ok: boolean;
  error?: string;
  /** Абсолютный путь к каталогу с manifest.json (для индикации и вставки). */
  path?: string;
}

/**
 * Статус расширения профиля в списке окна «Настройки».
 * id — идентификатор в сессии (session.loadExtension), по которому расширение
 * выгружается (session.removeExtension); null — не загружено/ошибка.
 */
export interface ExtensionState {
  /** Путь как задан в конфиге (может быть относительным). */
  source: string;
  name: string | null;
  id: string | null;
  ok: boolean;
  error: string | null;
  /** Предупреждение совместимости (например, MV3 service_worker — Electron 33). */
  note: string | null;
}

/**
 * Rich-тултип поверх сетки (UI-фикс: HTML-тултипы renderer'а перекрываются
 * WebContentsView, поэтому тултип рисуется в отдельном прозрачном
 * always-on-top окне). Payload renderer -> main по каналу `tooltip:show`.
 */
export interface TooltipShowPayload {
  /** Прямоугольник якоря в CSS-пикселях относительно контента главного окна. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Показать над якорем (шапки ячеек), по умолчанию — под. */
  preferTop?: boolean;
  /** Заголовок подсказки (жирная строка). */
  title: string;
  /** Тело подсказки — 1–2 предложения инструкции (опционально). */
  body?: string;
}

/** Данные рендера тултипа: main -> tooltip-окно (канал `tooltip:render`). */
export interface TooltipRenderData {
  /** Поколение запроса: запаздывающий ответ с чужим gen игнорируется. */
  gen: number;
  title: string;
  body?: string;
  /** Тема главного окна — тултип красится в ту же. */
  theme: ThemeId;
}

/**
 * API диалога «Импорт cookies» (отдельное BrowserWindow, preload-cookie.ts).
 * Диалог переиспользует существующие каналы cookies:import / cookies:pick-file /
 * view:reload — новых привилегий не появляется.
 */
export interface CookieDialogApi {
  /** Системный диалог выбора файла (родитель — окно диалога) + чтение ≤ 10 МБ. */
  pickFile(): Promise<FilePickResult>;
  /** Импорт cookies в сессию профиля. */
  importCookies(profileId: string, input: CookieImportInput): Promise<CookieImportResult>;
  /** Перезагрузить ячейку профиля (после импорта). */
  reloadProfile(profileId: string): Promise<void>;
  /** Закрыть окно диалога. */
  closeWindow(): void;
}

/** API диалога «Добавить профиль» (отдельное BrowserWindow, preload-profile-form.ts). */
export interface ProfileFormDialogApi {
  addProfile(input: NewProfileInput): Promise<CommandResult>;
  /** Выбор каталога распакованного расширения (системный диалог + проверка manifest.json). */
  pickExtensionDir(): Promise<DirPickResult>;
  closeWindow(): void;
}

/**
 * API окна «Настройки» (отдельное BrowserWindow, preload-settings.ts):
 * управление распакованными расширениями профилей — добавить через выбор
 * папки, убрать, статус загрузки в сессию. Изменения применяются к живой
 * сессии немедленно (без пересоздания ячейки).
 */
export interface SettingsDialogApi {
  /** Снимок состояния (профили + статусы их расширений + тема). */
  getState(): Promise<AppState>;
  /** Системный диалог выбора каталога расширения (проверка manifest.json в main). */
  pickExtensionDir(): Promise<DirPickResult>;
  /** Подключить расширения профилю (пути-каталоги); reload — перезагрузить ячейку. */
  addExtensions(profileId: string, paths: string[], reload: boolean): Promise<CommandResult>;
  /** Отключить расширение профиля (конфиг + живая сессия); reload — перезагрузить ячейку. */
  removeExtension(profileId: string, source: string, reload: boolean): Promise<CommandResult>;
  /** Перечитать состояние (после изменений в главном окне). */
  reloadProfile(profileId: string): Promise<void>;
  /** Ротация мобильного прокси (P3): сменить IP профиля сейчас (триггер). */
  rotateProxy(profileId: string): Promise<CommandResult>;
  /** ---------- AI-ассистент (P4, этап 1: раздел в этом же окне) ---------- */
  /** Настройки ассистента без ключа (только факт его наличия). */
  getAssistantConfig(): Promise<AssistantConfigView>;
  /** Сохранить настройки; apiKey: '' = удалить, undefined = не трогать. */
  setAssistantConfig(input: AssistantConfigInput): Promise<CommandResult>;
  /** Проверить доступность провайдера («Cloud / Local / Недоступен»). */
  probeAssistant(): Promise<AssistantStatus>;
  closeWindow(): void;
}

/** API диалога подтверждения удаления (отдельное BrowserWindow, preload-confirm.ts). */
export interface ConfirmDialogApi {
  /** Удаление — только здесь, с явным подтверждением человека. */
  removeProfile(profileId: string): Promise<CommandResult>;
  closeWindow(): void;
}

// ==================== AI-ассистент (P4, этап 1) ====================

/** Режим работы ассистента: авто (Cloud → Local), только Cloud, только Local. */
export type AssistantMode = 'auto' | 'cloud' | 'local';

/** Настройки одного провайдера LLM (Ollama Cloud / локальный Ollama). */
export interface AssistantEndpointConfig {
  /** Базовый URL (без /api/...): https://ollama.com или http://localhost:11434. */
  endpoint: string;
  /** Модель — поле конфига, НЕ константа: список моделей Ollama Cloud меняется. */
  model: string;
}

/** Публичный вид настроек ассистента (ключ не возвращается — только факт наличия). */
export interface AssistantConfigView {
  mode: AssistantMode;
  cloud: AssistantEndpointConfig;
  local: AssistantEndpointConfig;
  /** API-ключ Ollama Cloud задан (зашифрован в хранилище ОС или взят из env). */
  hasKey: boolean;
  /** Ключ взят из переменной окружения OLLAMA_API_KEY, а не из хранилища ОС. */
  keyFromEnv: boolean;
}

/** Вход настроек из UI: apiKey '' = удалить, undefined = не трогать. */
export interface AssistantConfigInput {
  mode: AssistantMode;
  cloud?: Partial<AssistantEndpointConfig>;
  local?: Partial<AssistantEndpointConfig>;
  apiKey?: string;
}

/** Состояние индикатора «Cloud / Local / Недоступен» (панель и «Настройки»). */
export interface AssistantStatus {
  ok: boolean;
  /** Провайдер, доступный прямо сейчас. */
  provider: 'cloud' | 'local' | 'none';
  /** Короткая метка для UI: «Cloud», «Local», «Недоступен». */
  label: string;
  /** Причина недоступности / деталь проверки (не содержит ключа). */
  detail: string | null;
  mode: AssistantMode;
  hasKey: boolean;
}

/** Сообщение чата ассистента (история живёт в памяти, не персистится). */
export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Кусок стрима ответа main -> renderer (канал assistant:chunk). */
export interface AssistantChunkEvent {
  delta: string;
  provider: 'cloud' | 'local';
}

/** Завершение ответа main -> renderer (канал assistant:done). */
export interface AssistantDoneEvent {
  aborted: boolean;
  provider: 'cloud' | 'local' | null;
  model: string | null;
}

/** Перезапуск пузыря ответа после ретрая/фолбэка (канал assistant:restart). */
export interface AssistantRestartEvent {
  provider: 'cloud' | 'local';
}

/** Ошибка main -> renderer (канал assistant:error). */
export interface AssistantErrorEvent {
  message: string;
}

/** API preload-tooltip.ts (окно rich-тултипов). */
export interface TooltipWindowApi {
  /** Подписка на данные рендера (main -> окно тултипа). */
  onRender(cb: (data: TooltipRenderData) => void): () => void;
  /** Сообщить фактический размер отрисованной карточки (для setBounds). */
  measured(gen: number, width: number, height: number): void;
}

/**
 * API, который preload экспортирует в renderer как window.brouser.
 * Описание каналов см. в README (раздел «IPC-контракт»).
 */
export interface BrouserApi {
  getState(): Promise<AppState>;
  addProfile(input: NewProfileInput): Promise<CommandResult>;
  removeProfile(id: string): Promise<CommandResult>;
  /** Дублировать профиль: настройки/прокси копируются, id и отпечаток — новые. */
  duplicateProfile(id: string): Promise<CommandResult>;
  /**
   * Drag-and-drop (P3): переставить профиль в другую ячейку — сдвигом в
   * массиве config.profiles. Представления НЕ пересоздаются: recomputeLayout
   * молча переносит живые view в новые ячейки (сессии/логины сохраняются).
   */
  reorderProfiles(fromId: string, toIndex: number): Promise<CommandResult>;
  /** Импорт cookies (Netscape/JSON) в сессию профиля (P3). */
  importCookies(profileId: string, input: CookieImportInput): Promise<CookieImportResult>;
  /** Диалог выбора файла cookies.txt/.json и его чтение (≤ 10 МБ). */
  pickCookieFile(): Promise<FilePickResult>;
  /** Синхронизатор действий (P3): реплей кликов/ввода между видимыми ячейками. */
  setInputSync(enabled: boolean): Promise<CommandResult>;
  setLayout(layout: LayoutId): Promise<CommandResult>;
  reloadAll(): Promise<void>;
  reloadView(id: string): Promise<void>;
  openDevTools(id: string): Promise<void>;
  saveConfig(): Promise<CommandResult>;
  setTheme(theme: ThemeId): Promise<CommandResult>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;

  // ---------- Диалоговые окна (UI-фикс поверх WebContentsView) ----------
  /**
   * Открыть диалог импорта cookies в отдельном окне (родитель — главное окно;
   * на Windows/Linux — модальное). HTML-модалка renderer'а перекрывалась views.
   */
  openCookieImport(profileId: string): Promise<CommandResult>;
  /** Диалог «Добавить профиль» в отдельном окне. */
  openProfileForm(): Promise<CommandResult>;
  /** Диалог подтверждения удаления профиля в отдельном окне. */
  openDeleteConfirm(profileId: string): Promise<CommandResult>;
  /** Окно «Настройки»: управление расширениями профилей. */
  openSettings(): Promise<CommandResult>;

  /**
   * Показать rich-тултип (title + body) в прозрачном always-on-top окне над
   * элементом-якорем. Прямоугольник — в CSS-пикселях контента главного окна.
   */
  tooltipShow(payload: TooltipShowPayload): void;
  /** Скрыть тултип (mouseleave / клик / blur / перерисовка сетки). */
  tooltipHide(): void;

  /** Высота тулбара (DIP) — синхронизация CSS и main (P1.1). */
  readonly TOOLBAR_HEIGHT: number;
  /** Полная геометрия UI — renderer применяет её в CSS-переменные. */
  readonly GEOMETRY: UiGeometry;

  /**
   * Handshake (P1.2): renderer сообщает, что первый рендер сетки состоялся
   * и окно имеет финальные размеры — после этого main расставляет views.
   */
  layoutReady(): void;
  /** Панель журнала открыта/закрыта: main резервирует место под неё (P1.1). */
  setLogPanel(open: boolean): void;
  /** Панель AI-ассистента открыта/закрыта: main резервирует место (P4, этап 1). */
  setAssistantPanel(open: boolean): void;
  /** Выделенный профиль (клик по шапке ячейки) — «активный» для ассистента (P4). */
  setSelectedProfile(id: string | null): void;

  /** ---------- AI-ассистент (P4, этап 1) ---------- */
  /** Отправить сообщение; ответ приходит событиями chunk/done/error. */
  assistantSend(text: string): Promise<CommandResult>;
  /** Остановить текущий ответ (частичный текст сохраняется в чате). */
  assistantAbort(): void;
  /** Очистить историю (в памяти main) и панель чата. */
  assistantClear(): void;
  /** Проверить доступность провайдера: индикатор «Cloud / Local / Недоступен». */
  assistantProbe(): Promise<AssistantStatus>;

  onProfilesUpdated(cb: (state: AppState) => void): () => void;
  onLayoutChanged(cb: (layout: LayoutId) => void): () => void;
  onLogMessage(cb: (entry: LogEntry) => void): () => void;
  onAssistantChunk(cb: (ev: AssistantChunkEvent) => void): () => void;
  onAssistantRestart(cb: (ev: AssistantRestartEvent) => void): () => void;
  onAssistantDone(cb: (ev: AssistantDoneEvent) => void): () => void;
  onAssistantError(cb: (ev: AssistantErrorEvent) => void): () => void;
}
