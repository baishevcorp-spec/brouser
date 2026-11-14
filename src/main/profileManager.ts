/**
 * ProfileManager — ядро Brouser.
 *
 * Управляет профилями, их изолированными сессиями (persist:profile-<id>)
 * и WebContentsView-ячейками сетки.
 *
 * Ключевая идея координат: renderer (HTML-интерфейс) рисует сетку и после каждой
 * перерисовки измеряет элемент .cell-body, отправляя прямоугольники в main
 * (канал 'view:set-bounds'). Main создаёт представление по запросу и ставит его
 * ровно в ячейку. Благодаря этому панель инструментов никогда не перекрывает
 * представления, а представления всегда видимы (расширения работают).
 *
 * Правила жизни профилей:
 *  - видны и создаются только первые N профилей, где N = ячеек текущей раскладки;
 *  - при смене раскладки лишние представления уничтожаются, недостающие создаются;
 *  - сессия каждого профиля persistent (куки/кэш/LocalStorage/IndexedDB на диске).
 */
import { app, BrowserWindow, Rectangle, Session, session, WebContentsView } from 'electron';
import {
  AppState,
  CommandResult,
  LayoutId,
  LAYOUTS,
  NewProfileInput,
  ProfileConfig,
  ProfileState,
  Rect,
  ThemeId,
} from './types';
import { ConfigService, normalizeUrlInput } from './config';
import { Logger } from './logger';
import { parseProxy, ProxyInfo } from './proxy';

/** Внутреннее описание активного представления. */
interface ManagedView {
  profile: ProfileConfig;
  view: WebContentsView;
  session: Session;
  proxy: ProxyInfo | null;
  extensions: { source: string; name: string | null; ok: boolean; error: string | null }[];
}

type EmitFn = (channel: 'profiles-updated' | 'layout-changed', payload: unknown) => void;

export class ProfileManager {
  private win: BrowserWindow | null = null;
  private emit: EmitFn = () => {};

  /** Активные представления, ключ — id профиля. */
  private views = new Map<string, ManagedView>();
  /** webContents.id -> id профиля (для обработчика login прокси). */
  private byWcId = new Map<number, string>();
  /** Последние известные прямоугольники ячеек (DIP). */
  private bounds = new Map<string, Rect>();

  constructor(private config: ConfigService, private log: Logger) {
    // Аутентификация прокси (login/password из URL) — единый обработчик на app.
    app.on('login', this.handleLogin);
  }

  attachWindow(win: BrowserWindow): void {
    this.win = win;
  }

  /** main подключает рассылку событий в renderer. */
  setEmit(fn: EmitFn): void {
    this.emit = fn;
  }

  // ------------------------------------------------------------------
  // Состояние для renderer
  // ------------------------------------------------------------------

  getState(): AppState {
    const capacity = this.capacity();
    const profiles: ProfileState[] = this.config.config.profiles.map((p, i) => {
      const mv = this.views.get(p.id);
      return {
        id: p.id,
        name: p.name,
        url: p.url,
        hasProxy: !!p.proxy,
        proxyScheme: mv?.proxy?.scheme ?? (p.proxy ? (parseProxy(p.proxy)?.scheme ?? null) : null),
        extensions:
          mv?.extensions ??
          (p.extensions ?? []).map((source) => ({ source, name: null, ok: true, error: null })),
        timezone: p.timezone || null,
        userAgentSet: !!p.userAgent,
        platform: p.platform || null,
        hardwareConcurrency: p.hardwareConcurrency ?? null,
        visible: i < capacity,
      };
    });
    return {
      profiles,
      layout: this.config.config.layout,
      theme: this.config.config.theme ?? 'dark',
      capacity,
      logs: this.log.getRecent(),
    };
  }

  // ------------------------------------------------------------------
  // Команды от renderer
  // ------------------------------------------------------------------

  /** Renderer прислал прямоугольник ячейки профиля. */
  setViewBounds(id: string, rect: Rect): void {
    const normalized = normalizeRect(rect);
    this.bounds.set(id, normalized);
    const profile = this.config.config.profiles.find((p) => p.id === id);
    if (!profile) return;

    const existing = this.views.get(id);
    if (existing) {
      existing.view.setBounds(normalized);
      return;
    }
    // Представление создаём только для профилей из первых N ячеек.
    if (!this.isActive(id)) return;
    void this.createView(profile, normalized);
  }

  async addProfile(input: NewProfileInput): Promise<CommandResult> {
    const name = (input.name || '').trim();
    if (!name) return { ok: false, error: 'Имя профиля обязательно' };
    const profile: ProfileConfig = {
      id: this.config.generateProfileId(name),
      name,
      url: normalizeUrlInput(input.url || ''),
      proxy: (input.proxy || '').trim(),
      extensions: splitPaths(input.extensions || ''),
      userAgent: (input.userAgent || '').trim(),
      timezone: (input.timezone || '').trim(),
      platform: (input.platform || '').trim(),
      hardwareConcurrency: parsePositiveInt(input.hardwareConcurrency),
    };
    this.config.config.profiles.push(profile);
    this.config.save();
    this.log.info(`профиль добавлен: ${profile.id} (${profile.name})`);
    this.notify();
    return { ok: true };
  }

  async removeProfile(id: string): Promise<CommandResult> {
    const before = this.config.config.profiles.length;
    this.config.config.profiles = this.config.config.profiles.filter((p) => p.id !== id);
    if (this.config.config.profiles.length === before) {
      return { ok: false, error: 'Профиль не найден' };
    }
    this.config.save();
    this.destroyView(id);
    this.bounds.delete(id);
    this.log.info(`профиль удалён: ${id}`);
    this.notify();
    return { ok: true };
  }

  setLayout(layout: LayoutId): CommandResult {
    if (!LAYOUTS[layout]) return { ok: false, error: 'Неизвестная раскладка' };
    if (this.config.config.layout === layout) return { ok: true };
    this.config.config.layout = layout;
    this.config.save();
    this.log.info(`раскладка изменена: ${layout}`);
    // Представления, не попавшие в новый размер сетки, уничтожаем;
    // новые создадутся, когда renderer пришлёт координаты ячеек.
    this.syncViews();
    this.emit('layout-changed', layout);
    this.notify();
    return { ok: true };
  }

  setTheme(theme: ThemeId): CommandResult {
    this.config.config.theme = theme;
    this.config.save();
    this.notify();
    return { ok: true };
  }

  reloadAll(): void {
    for (const mv of this.views.values()) {
      try {
        mv.view.webContents.reload();
      } catch (err) {
        this.log.error(`[${mv.profile.id}] reload failed: ${String(err)}`);
      }
    }
    this.log.info('все представления перезагружены');
  }

  reloadView(id: string): void {
    const mv = this.views.get(id);
    if (!mv) {
      this.log.warn(`reload: представление не найдено (${id})`);
      return;
    }
    try {
      mv.view.webContents.reload();
    } catch (err) {
      this.log.error(`[${id}] reload failed: ${String(err)}`);
    }
  }

  /** DevTools в отдельном окне, чтобы не перекрывать сетку. */
  openDevTools(id: string): void {
    const mv = this.views.get(id);
    if (!mv) {
      this.log.warn(`devtools: представление не найдено (${id})`);
      return;
    }
    try {
      mv.view.webContents.openDevTools({ mode: 'detach' });
    } catch (err) {
      this.log.error(`[${id}] openDevTools failed: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------------
  // Внутренняя кухня
  // ------------------------------------------------------------------

  private capacity(): number {
    return LAYOUTS[this.config.config.layout].cells;
  }

  /** Профиль входит в первые N ячеек текущей раскладки? */
  private isActive(id: string): boolean {
    const cap = this.capacity();
    return this.config.config.profiles.some((p, i) => i < cap && p.id === id);
  }

  /** Уничтожить представления, не попавшие в активные первые N профилей. */
  private syncViews(): void {
    for (const id of [...this.views.keys()]) {
      if (!this.isActive(id)) this.destroyView(id);
    }
  }

  private notify(): void {
    this.emit('profiles-updated', this.getState());
  }

  /**
   * Создание сессии + WebContentsView для профиля.
   * Все шаги «мягкие»: ошибка прокси/расширения/UA логируется,
   * но не роняет ни приложение, ни остальные профили.
   */
  private async createView(profile: ProfileConfig, rect: Rect): Promise<void> {
    const tag = `[${profile.id}]`;
    try {
      // 1) Изолированная persistent-сессия: persist:profile-<id>.
      //    Куки, кэш, localStorage, IndexedDB — полностью раздельные.
      const ses = session.fromPartition(`persist:profile-${profile.id}`);

      // 2) Прокси. Правила без логина/пароля, учётные данные — через app('login').
      const proxy = profile.proxy ? parseProxy(profile.proxy) : null;
      if (proxy && proxy.rules) {
        try {
          await ses.setProxy({ proxyRules: proxy.rules });
          this.log.info(`${tag} прокси применён: ${proxy.rules}`);
        } catch (err) {
          this.log.error(`${tag} ошибка установки прокси: ${String(err)}`);
        }
      } else if (profile.proxy && profile.proxy.trim()) {
        this.log.warn(`${tag} не удалось разобрать строку прокси — используется прямое соединение`);
      }

      // 3) Расширения (распакованные папки). Ошибка одного не валит остальные.
      const extensions: ManagedView['extensions'] = [];
      for (const source of profile.extensions ?? []) {
        const abs = this.config.resolveExtensionPath(source);
        if (!abs) {
          extensions.push({ source, name: null, ok: false, error: 'путь не найден' });
          this.log.error(`${tag} расширение не найдено: ${source}`);
          continue;
        }
        try {
          const loaded = await ses.loadExtension(abs);
          extensions.push({ source, name: loaded.name, ok: true, error: null });
          this.log.info(`${tag} расширение загружено: ${loaded.name} (${source})`);
        } catch (err) {
          extensions.push({ source, name: null, ok: false, error: String(err) });
          this.log.error(`${tag} не удалось загрузить расширение (${source}): ${String(err)}`);
        }
      }

      // 4) User-Agent профиля.
      if (profile.userAgent) {
        try {
          ses.setUserAgent(profile.userAgent);
          this.log.info(`${tag} User-Agent установлен`);
        } catch (err) {
          this.log.warn(`${tag} setUserAgent failed: ${String(err)}`);
        }
      }

      // Профиль могли удалить, пока грузились расширения.
      if (!this.isActive(profile.id)) {
        this.log.info(`${tag} профиль больше не активен — представление не создаётся`);
        return;
      }
      if (!this.win || this.win.isDestroyed()) return;

      // 5) Само представление. backgroundThrottling: false — страницы живут в фоне.
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          backgroundThrottling: false,
        },
      });
      this.win.contentView.addChildView(view);
      view.setBounds(this.bounds.get(profile.id) ?? rect);

      const mv: ManagedView = { profile, view, session: ses, proxy, extensions };
      this.views.set(profile.id, mv);
      this.byWcId.set(view.webContents.id, profile.id);

      const wc = view.webContents;
      wc.on('render-process-gone', (_e, details) => {
        this.log.error(`${tag} процесс страницы аварийно завершился: ${details.reason}`);
      });
      wc.on('did-fail-load', (_e, errorCode, errorDescription, failedUrl, isMainFrame) => {
        if (isMainFrame) this.log.error(`${tag} ошибка загрузки ${failedUrl}: ${errorCode} ${errorDescription}`);
      });
      // После каждой навигации повторно применяем часовой пояс
      // (CDP-override привязан к процессу рендера и может слетать при смене процесса).
      wc.on('did-navigate', () => {
        void this.applyTimezone(mv);
      });
      // navigator.platform / hardwareConcurrency — инъекция после готовности DOM.
      wc.on('dom-ready', () => {
        this.applyNavigatorSpoof(mv);
      });

      // 6) Спуфинг отпечатка (часовой пояс + platform через CDP).
      await this.applyFingerprint(mv);

      // 7) Загружаем URL (или about:blank, если не задан).
      const target = profile.url && profile.url.trim() ? profile.url.trim() : 'about:blank';
      wc.loadURL(target).catch((err: Error) => {
        this.log.error(`${tag} loadURL(${target}) failed: ${String(err)}`);
      });

      this.notify();
    } catch (err) {
      this.log.error(`${tag} критическая ошибка создания представления: ${String(err)}`);
    }
  }

  /** Часовой пояс + platform через webContents.debugger (CDP). */
  private async applyFingerprint(mv: ManagedView): Promise<void> {
    const { profile } = mv;
    const wc = mv.view.webContents;
    const wantTz = !!profile.timezone;
    const wantUaOverride = !!profile.platform || !!profile.userAgent;
    if (!wantTz && !wantUaOverride) return;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      // Network.setUserAgentOverride задаёт и User-Agent, и navigator.platform
      // до выполнения скриптов страницы.
      if (wantUaOverride) {
        const params: Record<string, unknown> = {
          userAgent: profile.userAgent || mv.session.getUserAgent(),
        };
        if (profile.platform) params.platform = profile.platform;
        await wc.debugger.sendCommand('Network.setUserAgentOverride', params);
      }
      if (wantTz) {
        await wc.debugger.sendCommand('Emulation.setTimezoneOverride', {
          timezoneId: profile.timezone,
        });
      }
      this.log.info(
        `${profile.id}: отпечаток применён (tz=${profile.timezone || 'default'}, platform=${profile.platform || 'default'})`,
      );
    } catch (err) {
      this.log.warn(`${profile.id}: не удалось применить отпечаток через CDP: ${String(err)} (не критично)`);
    }
  }

  /** Повторная установка часового пояса (после навигации). */
  private async applyTimezone(mv: ManagedView): Promise<void> {
    if (!mv.profile.timezone) return;
    try {
      const wc = mv.view.webContents;
      if (wc.isDestroyed()) return;
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setTimezoneOverride', {
        timezoneId: mv.profile.timezone,
      });
    } catch (err) {
      this.log.warn(`[${mv.profile.id}] повторный setTimezoneOverride не удался: ${String(err)}`);
    }
  }

  /** Подмена navigator.platform / hardwareConcurrency инъекцией скрипта. */
  private applyNavigatorSpoof(mv: ManagedView): void {
    const { platform, hardwareConcurrency } = mv.profile;
    if (!platform && !hardwareConcurrency) return;
    const script = `(function(){try{${platform ? `Object.defineProperty(window.navigator,'platform',{get:()=>${JSON.stringify(platform)},configurable:true});` : ''}${hardwareConcurrency ? `Object.defineProperty(window.navigator,'hardwareConcurrency',{get:()=>${hardwareConcurrency},configurable:true});` : ''}}catch(e){}})();`;
    mv.view.webContents.executeJavaScript(script).catch(() => undefined);
  }

  /**
   * Аутентификация прокси: login/password из URL прокси профиля.
   * Вызывается Chromium'ом при первом 407-вызове от прокси-сервера.
   */
  private handleLogin = (
    event: Electron.Event,
    webContents: Electron.WebContents | null,
    _request: unknown,
    authInfo: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ): void => {
    try {
      if (!authInfo || !authInfo.isProxy) return;
      const wcId = webContents?.id;
      const profileId = wcId !== undefined ? this.byWcId.get(wcId) : undefined;
      const mv = profileId ? this.views.get(profileId) : undefined;
      if (mv?.proxy?.username) {
        event.preventDefault();
        callback(mv.proxy.username, mv.proxy.password ?? '');
        this.log.info(`[${profileId}] учётные данные прокси предоставлены`);
      }
    } catch (err) {
      this.log.error(`login handler error: ${String(err)}`);
    }
  };

  private destroyView(id: string): void {
    const mv = this.views.get(id);
    if (!mv) return;
    try {
      this.byWcId.delete(mv.view.webContents.id);
    } catch {
      /* webContents мог уже закрыться */
    }
    try {
      this.win?.contentView.removeChildView(mv.view);
    } catch {
      /* окно могло уже закрыться */
    }
    try {
      mv.view.webContents.close();
    } catch (err) {
      this.log.warn(`[${id}] ошибка закрытия webContents: ${String(err)}`);
    }
    this.views.delete(id);
    this.log.info(`представление закрыто: ${id}`);
  }

  /** Полная остановка: вызывается при закрытии окна (все сессии завершаются корректно). */
  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroyView(id);
    this.byWcId.clear();
    this.bounds.clear();
    app.removeListener('login', this.handleLogin);
  }
}

// ------------------------------------------------------------------
// Утилиты
// ------------------------------------------------------------------

function normalizeRect(r: Rect): Rectangle {
  const x = Math.max(0, Math.round(r && r.x ? r.x : 0));
  const y = Math.max(0, Math.round(r && r.y ? r.y : 0));
  const width = Math.max(1, Math.round(r && r.width ? r.width : 0));
  const height = Math.max(1, Math.round(r && r.height ? r.height : 0));
  return { x, y, width, height };
}

/** Список путей расширений из textarea: строки / ';' / ','. */
function splitPaths(raw: string): string[] {
  return raw
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parsePositiveInt(raw?: string): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 128 ? n : undefined;
}
