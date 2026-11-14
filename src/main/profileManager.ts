/**
 * ProfileManager — ядро Brouser.
 *
 * Управляет профилями, их изолированными сессиями (persist:profile-<id>)
 * и WebContentsView-ячейками сетки.
 *
 * Геометрия (P1.1): расчёт ячеек — ЗДЕСЬ, в main (модуль layout.ts),
 * по contentBounds окна и константам UI_GEOMETRY. Renderer больше не измеряет
 * и не шлёт координаты: он сообщает только layout-ready (handshake, P1.2)
 * и состояние панели журнала (место под неё резервирует main).
 *
 * Правила жизни профилей (P1.3):
 *  - WebContentsView создаётся для профиля, когда он попадает в первые N
 *    ячеек текущей раскладки (N = LAYOUTS[layout].cells);
 *  - при смене раскладки представления НЕ уничтожаются, а перепозиционируются;
 *    не влезающие выносятся за пределы окна (PARKED) — сессия, расширения и
 *    залогиненность сохраняются (backgroundThrottling: false);
 *  - при удалении профиля его представление закрывается, сессия — по желанию;
 *  - сессия каждого профиля persistent (куки/кэш/LocalStorage/IndexedDB на диске).
 */
import { app, BrowserWindow, Session, session, WebContentsView } from 'electron';
import {
  AppState,
  CommandResult,
  LayoutId,
  LAYOUTS,
  NewProfileInput,
  ProfileConfig,
  ProfileState,
  ThemeId,
} from './types';
import { ConfigService, normalizeUrlInput } from './config';
import { Logger } from './logger';
import { parseProxy, ProxyInfo } from './proxy';
import { applyClientHints, applyFingerprint, FingerprintSpec } from './fingerprint';
import { Cell, computeCells, logPanelReserve, PARKED } from './layout';

/** Внутреннее описание активного представления. */
interface ManagedView {
  profile: ProfileConfig;
  view: WebContentsView;
  session: Session;
  proxy: ProxyInfo | null;
  extensions: { source: string; name: string | null; ok: boolean; error: string | null }[];
  /** Спецификация антидетект-отпечатка профиля (P0.1). */
  fp: FingerprintSpec;
  /** Зарегистрирован ли CDP-патч на этом webContents (сбрасывается при detach). */
  scriptAdded: boolean;
}

type EmitFn = (channel: 'profiles-updated' | 'layout-changed', payload: unknown) => void;

export class ProfileManager {
  private win: BrowserWindow | null = null;
  private emit: EmitFn = () => {};

  /** Активные представления, ключ — id профиля. */
  private views = new Map<string, ManagedView>();
  /** webContents.id -> id профиля (для обработчика login прокси). */
  private byWcId = new Map<number, string>();
  /** id профилей, чьи представления сейчас создаются (анти-дублирование). */
  private pendingViews = new Set<string>();

  /** Handshake (P1.2): renderer подтвердил первый рендер. */
  private layoutReadyFlag = false;
  /** Панель журнала открыта (резервируем место справа). */
  private logPanelOpen = false;

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
        fingerprintSeed: p.fingerprintSeed ?? null,
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
  // Геометрия (P1.1): ячейки считает main
  // ------------------------------------------------------------------

  /** Handshake (P1.2): renderer отрисовал сетку — расставляем представления. */
  onLayoutReady(): void {
    this.layoutReadyFlag = true;
    this.recomputeLayout();
  }

  /** Панель журнала открыта/закрыта — пересервируем место. */
  setLogPanel(open: boolean): void {
    if (this.logPanelOpen === open) return;
    this.logPanelOpen = open;
    this.recomputeLayout();
  }

  /**
   * Пересчитать сетку и расставить все представления.
   * Вызывается: после layout-ready, при resize (throttle 16мс в index.ts),
   * смене раскладки, добавлении/удалении профиля, переключении журнала.
   */
  recomputeLayout(): void {
    if (!this.win || this.win.isDestroyed() || !this.layoutReadyFlag) return;
    try {
      const content = this.win.getContentBounds();
      const reserved = logPanelReserve(content.width, this.logPanelOpen);
      const cells = computeCells(this.config.config.layout, content, reserved);
      const profiles = this.config.config.profiles;

      for (let i = 0; i < profiles.length; i++) {
        const profile = profiles[i];
        const mv = this.views.get(profile.id);

        if (i < cells.length) {
          if (mv) {
            try {
              mv.view.setBounds(cells[i] as Cell);
            } catch {
              /* view мог закрыться параллельно */
            }
          } else if (!this.pendingViews.has(profile.id)) {
            // Представление создаётся в свой прямоугольник; сессия готовится
            // асинхронно — актуальную геометрию применим в конце создания.
            void this.createView(profile, cells[i] as Cell);
          }
        } else if (mv) {
          // P1.3: не уничтожаем, а паркуем за пределами окна.
          try {
            mv.view.setBounds(PARKED);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (err) {
      this.log.error(`recomputeLayout: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------------
  // Команды от renderer
  // ------------------------------------------------------------------

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
    // Если профиль попал в первые N ячеек — создать для него представление.
    this.recomputeLayout();
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
    this.log.info(`профиль удалён: ${id}`);
    this.notify();
    // Сдвинуть оставшиеся представления на освободившиеся ячейки.
    this.recomputeLayout();
    return { ok: true };
  }

  setLayout(layout: LayoutId): CommandResult {
    if (!LAYOUTS[layout]) return { ok: false, error: 'Неизвестная раскладка' };
    if (this.config.config.layout === layout) return { ok: true };
    this.config.config.layout = layout;
    this.config.save();
    this.log.info(`раскладка изменена: ${layout}`);
    // P1.3: представления не уничтожаются — лишние паркуются,
    // недостающие создаются; залогиненные сессии переживают смену раскладки.
    this.recomputeLayout();
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

  private notify(): void {
    this.emit('profiles-updated', this.getState());
  }

  /**
   * Создание сессии + WebContentsView для профиля.
   * Все шаги «мягкие»: ошибка прокси/расширения/UA логируется,
   * но не роняет ни приложение, ни остальные профили.
   */
  private async createView(profile: ProfileConfig, rect: Cell): Promise<void> {
    const tag = `[${profile.id}]`;
    if (this.views.has(profile.id) || this.pendingViews.has(profile.id)) return;
    this.pendingViews.add(profile.id);
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

      // 4.5) Антидетект (P0.1): preload-патч отпечатка (canvas/webgl/audio/navigator)
      //      + Client Hints в синхроне с UA (P0.2). CDP-инъекция патча — ниже (шаг 6).
      const fp = applyFingerprint(ses, profile, this.log);
      applyClientHints(ses, profile, this.log);
      // Строка для проверки консистентности через https://browserleaks.com/canvas (P2.4).
      this.log.info(`${tag} ${fp.description}`);

      // Профиль могли удалить, пока готовилась сессия.
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

      const mv: ManagedView = { profile, view, session: ses, proxy, extensions, fp, scriptAdded: false };
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

      // 6) Эмуляция через CDP: UA/platform, таймзона и патч отпечатка
      //    (Page.addScriptToEvaluateOnNewDocument — до скриптов страницы).
      await this.applyProfileEmulation(mv);

      // 7) Загружаем URL (или about:blank, если не задан).
      const target = profile.url && profile.url.trim() ? profile.url.trim() : 'about:blank';
      wc.loadURL(target).catch((err: Error) => {
        this.log.error(`${tag} loadURL(${target}) failed: ${String(err)}`);
      });

      // 8) Актуальная геометрия: за время подготовки сессии могли прийти
      //    resize/смена раскладки — ставим свежий прямоугольник (или паркинг).
      this.positionView(profile.id, rect);

      this.notify();
    } catch (err) {
      this.log.error(`${tag} критическая ошибка создания представления: ${String(err)}`);
    } finally {
      this.pendingViews.delete(profile.id);
    }
  }

  /** Поставить представление профиля в его текущую ячейку (или парк). */
  private positionView(id: string, fallback: Cell): void {
    const mv = this.views.get(id);
    if (!mv || !this.win || this.win.isDestroyed()) return;
    let cell: Cell = PARKED;
    try {
      const content = this.win.getContentBounds();
      const reserved = logPanelReserve(content.width, this.logPanelOpen);
      const cells = computeCells(this.config.config.layout, content, reserved);
      const index = this.config.config.profiles.findIndex((p) => p.id === id);
      if (index >= 0 && index < cells.length) cell = cells[index] as Cell;
    } catch {
      cell = fallback;
    }
    try {
      mv.view.setBounds(cell);
    } catch {
      /* view мог закрыться параллельно */
    }
  }

  /**
   * CDP-эмуляция профиля: Network.setUserAgentOverride (UA + navigator.platform),
   * Emulation.setTimezoneOverride и патч отпечатка через
   * Page.addScriptToEvaluateOnNewDocument (основная инъекция P0.1).
   * Идемпотентность патча — на уровне скрипта (маркер на прототипе),
   * здесь дополнительно страхуемся флагом scriptAdded (сбрасывается при detach).
   */
  private async applyProfileEmulation(mv: ManagedView): Promise<void> {
    const { profile } = mv;
    const wc = mv.view.webContents;
    const wantUa = !!profile.platform || !!profile.userAgent;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      if (wantUa) {
        const params: Record<string, unknown> = {
          userAgent: profile.userAgent || mv.session.getUserAgent(),
        };
        if (profile.platform) params.platform = profile.platform;
        await wc.debugger.sendCommand('Network.setUserAgentOverride', params);
      }
      if (profile.timezone) {
        await wc.debugger.sendCommand('Emulation.setTimezoneOverride', {
          timezoneId: profile.timezone,
        });
      }
      if (!mv.scriptAdded) {
        await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: mv.fp.source,
        });
        mv.scriptAdded = true;
      }
    } catch (err) {
      this.log.warn(
        `[${profile.id}] CDP-эмуляция не удалась (продолжаем, preload-патч подстрахует): ${String(err)}`,
      );
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
    this.pendingViews.clear();
    this.layoutReadyFlag = false;
    this.logPanelOpen = false;
    app.removeListener('login', this.handleLogin);
  }
}

// ------------------------------------------------------------------
// Утилиты
// ------------------------------------------------------------------

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
