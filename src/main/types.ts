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
  extensions: { source: string; name: string | null; ok: boolean; error: string | null }[];
  timezone: string | null;
  userAgentSet: boolean;
  platform: string | null;
  hardwareConcurrency: number | null;
  /** Заданный вручную seed антидетекта (null — выводится из id автоматически). */
  fingerprintSeed: number | null;
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
}

/** Результат команд, возвращаемый в renderer. */
export interface CommandResult {
  ok: boolean;
  error?: string;
}

/**
 * API, который preload экспортирует в renderer как window.brouser.
 * Описание каналов см. в README (раздел «IPC-контракт»).
 */
export interface BrouserApi {
  getState(): Promise<AppState>;
  addProfile(input: NewProfileInput): Promise<CommandResult>;
  removeProfile(id: string): Promise<CommandResult>;
  setLayout(layout: LayoutId): Promise<CommandResult>;
  reloadAll(): Promise<void>;
  reloadView(id: string): Promise<void>;
  openDevTools(id: string): Promise<void>;
  saveConfig(): Promise<CommandResult>;
  setTheme(theme: ThemeId): Promise<CommandResult>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;

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

  onProfilesUpdated(cb: (state: AppState) => void): () => void;
  onLayoutChanged(cb: (layout: LayoutId) => void): () => void;
  onLogMessage(cb: (entry: LogEntry) => void): () => void;
}
