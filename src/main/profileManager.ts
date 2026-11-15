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
  CookieImportInput,
  CookieImportResult,
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
import { applyClientHints, applyFingerprint, FingerprintSpec, removeFingerprintPreload } from './fingerprint';
import {
  domainMatches,
  NormalizedCookie,
  parseCookieText,
  splitDomains,
  toCookieSetDetails,
} from './cookies';
import { Cell, computeCells, logPanelReserve, PARKED } from './layout';
import { InputSync } from './sync';

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
  /**
   * Представление в процессе teardown (удаление профиля / закрытие окна).
   * Все отложенные и асинхронные обработчики (did-navigate, devtools-closed,
   * in-flight CDP-команды) обязаны молчать: обращение к webContents ПОСЛЕ
   * close() роняет процесс нативно (crashpad, Windows/Electron 33).
   */
  closing: boolean;
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
  /** Синхронизатор действий (P3): реплей ввода между видимыми ячейками. */
  private inputSync: InputSync;

  constructor(private config: ConfigService, private log: Logger) {
    // Инициализация ДО подписок: inputSync нуждается в логгере.
    this.inputSync = new InputSync(this.log);
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
        locale: p.locale || null,
        visible: i < capacity,
      };
    });
    return {
      profiles,
      layout: this.config.config.layout,
      theme: this.config.config.theme ?? 'dark',
      capacity,
      logs: this.log.getRecent(),
      inputSync: this.inputSync.isEnabled(),
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
      // Пустой список профилей — безопасный no-op: деление только на константы
      // раскладки (cols/rows >= 1), цикл просто не выполняется.

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
    // Состав видимых ячеек мог измениться — пересинхронизировать участников
    // (no-op при выключенном синхронизаторе).
    this.syncParticipants();
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
    const victim = this.config.config.profiles.find((p) => p.id === id) ?? null;
    const before = this.config.config.profiles.length;
    this.config.config.profiles = this.config.config.profiles.filter((p) => p.id !== id);
    if (this.config.config.profiles.length === before) {
      return { ok: false, error: 'Профиль не найден' };
    }
    this.config.save();
    // Preload-файл отпечатка (userData/fingerprint-preloads/<id>.js) больше
    // не нужен — удаляем, иначе в userData копится мёртвый мусор.
    if (victim) removeFingerprintPreload(victim, this.log);
    this.destroyView(id);
    this.log.info(`профиль удалён: ${id}`);
    this.notify();
    // Сдвинуть оставшиеся представления на освободившиеся ячейки
    // (при пустом списке профилей recomputeLayout — безопасный no-op).
    this.recomputeLayout();
    return { ok: true };
  }

  /**
   * Дублирование профиля (P3): копируются URL, прокси, расширения, UA,
   * таймзона, платформа, hardwareConcurrency, локаль и геолокация. НЕ копируются:
   *   - id — новый (generateProfileId), т.е. отдельная persistent-сессия;
   *   - fingerprintSeed — новый id -> свой авто-seed -> ДРУГОЙ стабильный
   *     отпечаток (клоны не должны светить одинаково для антифрода),
   *     в т.ч. другие координаты дрожания гео и другой набор медиа-устройств.
   * Логин/куки не переносятся: дубликат стартует с чистой сессией.
   */
  async duplicateProfile(id: string): Promise<CommandResult> {
    const src = this.config.config.profiles.find((p) => p.id === id);
    if (!src) return { ok: false, error: 'Профиль не найден' };
    const copy: ProfileConfig = {
      id: this.config.generateProfileId(src.name),
      name: `${src.name} (копия)`,
      url: src.url,
      proxy: src.proxy,
      extensions: [...(src.extensions ?? [])],
      userAgent: src.userAgent,
      timezone: src.timezone,
      platform: src.platform,
      hardwareConcurrency: src.hardwareConcurrency,
      locale: src.locale,
      geolocation: src.geolocation
        ? { latitude: src.geolocation.latitude, longitude: src.geolocation.longitude }
        : undefined,
    };
    this.config.config.profiles.push(copy);
    this.config.save();
    this.log.info(`профиль дублирован: ${src.id} -> ${copy.id} (${copy.name})`);
    this.notify();
    // Новый профиль попадает в сетку, если есть свободная ячейка,
    // иначе будет создан при смене раскладки (правила жизни профилей).
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

  // ------------------------------------------------------------------
  // Импорт cookies (P3)
  // ------------------------------------------------------------------

  /**
   * Импорт cookies в сессию профиля (persist:profile-<id>) из текста
   * cookies.txt (Netscape) или DevTools-JSON. Работает и когда представление
   * профиля ещё не создано: сессия поднимается с диска сама, куки лягут
   * на место и применятся при следующей загрузке страницы.
   *
   * Истёкшие cookies не устанавливаются; фильтр доменов (если задан)
   * отсекает посторонние куки экспорта. Установка — батчами по 200,
   * ошибка отдельного cookie не валит импорт.
   */
  async importCookies(profileId: string, input: CookieImportInput): Promise<CookieImportResult> {
    const empty: CookieImportResult = {
      ok: false,
      total: 0,
      imported: 0,
      skippedDomain: 0,
      expired: 0,
      failed: 0,
    };
    const profile = this.config.config.profiles.find((p) => p.id === profileId);
    if (!profile) return { ...empty, error: 'Профиль не найден' };

    const source = (input.source || '').trim();
    if (!source) return { ...empty, error: 'Пустой ввод — вставьте cookies или выберите файл' };
    if (source.length > 16 * 1024 * 1024) return { ...empty, error: 'Текст больше 16 МБ' };

    let parsed: ReturnType<typeof parseCookieText>;
    try {
      parsed = parseCookieText(source, input.format || 'auto');
    } catch (err) {
      return { ...empty, error: String((err as Error).message ?? err) };
    }

    const filters = splitDomains(input.domains ?? '');
    const nowSec = Math.floor(Date.now() / 1000);
    const target: NormalizedCookie[] = [];
    let skippedDomain = 0;
    let expired = 0;
    for (const c of parsed.cookies) {
      if (filters.length > 0 && !filters.some((f) => domainMatches(c.domain, f))) {
        skippedDomain++;
        continue;
      }
      if (c.expirationDate !== undefined && c.expirationDate <= nowSec) {
        expired++;
        continue;
      }
      target.push(c);
    }

    if (target.length === 0) {
      return {
        ...empty,
        total: parsed.cookies.length,
        skippedDomain,
        expired,
        error:
          skippedDomain > 0
            ? `Ни один cookie не прошёл фильтр доменов (${filters.join(', ')})`
            : expired > 0
              ? 'Все cookies из источника уже истекли'
              : 'В источнике нет подходящих cookies',
      };
    }

    // Та же partition, что и у представления профиля — куки попадают
    // в его persistent-хранилище.
    const ses = session.fromPartition(`persist:profile-${profile.id}`);
    let imported = 0;
    let failed = 0;
    const CHUNK = 200;
    for (let i = 0; i < target.length; i += CHUNK) {
      const batch = target.slice(i, i + CHUNK);
      const results = await Promise.allSettled(batch.map((c) => ses.cookies.set(toCookieSetDetails(c))));
      for (const r of results) {
        if (r.status === 'fulfilled') imported++;
        else failed++;
      }
    }

    const summary =
      `cookies: импортировано ${imported}/${parsed.cookies.length} (${parsed.format})` +
      (filters.length ? `, фильтр «${filters.join(', ')}»` : '') +
      (expired ? `, истёкших пропущено ${expired}` : '') +
      (skippedDomain ? `, чужих доменов пропущено ${skippedDomain}` : '') +
      (failed ? `, ошибок ${failed}` : '') +
      (parsed.invalid ? `, битых строк ${parsed.invalid}` : '');
    if (imported > 0) this.log.info(`[${profile.id}] ${summary}`);
    else this.log.warn(`[${profile.id}] ${summary}`);

    return {
      ok: imported > 0,
      error: imported > 0 ? undefined : 'Ни один cookie не установлен (см. журнал)',
      total: parsed.cookies.length,
      imported,
      skippedDomain,
      expired,
      failed,
    };
  }

  setTheme(theme: ThemeId): CommandResult {
    this.config.config.theme = theme;
    this.config.save();
    this.notify();
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Синхронизатор действий (P3)
  // ------------------------------------------------------------------

  /**
   * Включить/выключить реплей ввода между видимыми ячейками.
   * Участники пересчитываются при каждом изменении сетки
   * (syncParticipants из recomputeLayout/createView/destroyView).
   */
  async setInputSync(on: boolean): Promise<CommandResult> {
    try {
      await this.inputSync.setEnabled(on, this.visibleSyncTargets());
      this.notify();
      return { ok: true };
    } catch (err) {
      this.log.error(`синхронизатор: ошибка переключения: ${String(err)}`);
      return { ok: false, error: String(err) };
    }
  }

  /** Видимые представления как цели синхронизации (первые N, живые). */
  private visibleSyncTargets(): { profileId: string; wc: Electron.WebContents }[] {
    const cap = this.capacity();
    const out: { profileId: string; wc: Electron.WebContents }[] = [];
    this.config.config.profiles.slice(0, cap).forEach((p) => {
      const mv = this.views.get(p.id);
      if (mv && !mv.closing && !mv.view.webContents.isDestroyed()) {
        out.push({ profileId: p.id, wc: mv.view.webContents });
      }
    });
    return out;
  }

  /** Пересинхронизировать участников (изменения сетки/профилей). */
  private syncParticipants(): void {
    if (!this.inputSync.isEnabled()) return;
    void this.inputSync.setParticipants(this.visibleSyncTargets());
  }

  reloadAll(): void {
    for (const mv of this.views.values()) {
      if (mv.closing) continue;
      try {
        const wc = mv.view.webContents;
        if (wc.isDestroyed()) continue;
        wc.reload();
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
    if (mv.closing) return;
    try {
      const wc = mv.view.webContents;
      if (wc.isDestroyed()) {
        this.log.warn(`reload: webContents уже закрыт (${id})`);
        return;
      }
      wc.reload();
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
    const wc = mv.view.webContents;
    if (wc.isDestroyed()) {
      this.log.warn(`devtools: webContents уже закрыт (${id})`);
      return;
    }

    // P2.1: CDP-отладчик (эмуляция) конфликтует с DevTools —
    // «Debugger is already attached». Отключаем наш отладчик перед открытием;
    // регистрация Page.addScriptToEvaluateOnNewDocument умирает вместе с сессией,
    // поэтому сбрасываем флаг — после закрытия DevTools всё переустановится.
    try {
      if (wc.debugger.isAttached()) {
        wc.debugger.detach();
        mv.scriptAdded = false;
        this.log.info(`[${id}] CDP-отладчик временно отключён для DevTools`);
      }
    } catch (err) {
      this.log.warn(`[${id}] detach перед DevTools не удался: ${String(err)}`);
    }

    // После закрытия DevTools восстанавливаем эмуляцию:
    // UA/platform, таймзону и патч отпечатка (Page.addScript...).
    // ВАЖНО: devtools-closed стреляет и при закрытии самого профиля
    // (destroyView -> close() гасит и окно DevTools) — в этом случае wc
    // уже мёртв, восстанавливать нечего и трогать его нельзя (crashpad).
    wc.once('devtools-closed', () => {
      if (mv.closing || wc.isDestroyed()) return;
      this.log.info(`[${id}] DevTools закрыт — восстанавливаю CDP-эмуляцию`);
      void this.applyProfileEmulation(mv).then(() => {
        // Detach debugger'а убил и захват синхронизатора — переустановка
        // вслед за эмуляцией (debugger уже прикреплён).
        this.inputSync.reinstall(id, wc);
      });
    });

    try {
      wc.openDevTools({ mode: 'detach' });
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
      //    P2.2: на macOS расширения из бандла копируются в userData
      //    (Gatekeeper блокирует loadExtension из app path).
      const extensions: ManagedView['extensions'] = [];
      for (const source of profile.extensions ?? []) {
        const abs = this.config.resolveExtensionPath(source);
        if (!abs) {
          extensions.push({ source, name: null, ok: false, error: 'путь не найден' });
          this.log.error(`${tag} расширение не найдено: ${source}`);
          continue;
        }
        const loadPath = this.config.prepareExtensionForLoad(abs, this.log);
        try {
          const loaded = await ses.loadExtension(loadPath);
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

      // Профиль могли удалить, пока готовилась сессия. Файл-инъекция мог
      // быть записан шагом выше — подчищаем за собой (мусор в userData).
      if (!this.isActive(profile.id)) {
        this.log.info(`${tag} профиль больше не активен — представление не создаётся`);
        removeFingerprintPreload(profile);
        return;
      }
      if (!this.win || this.win.isDestroyed()) return;

      // 5) Само представление. backgroundThrottling: false — страницы живут в фоне.
      //    Прямоугольник ставится СРАЗУ после прицепления: не оставляем view
      //    в дереве с нулевым прямоугольником до конца async-подготовки
      //    (bounds-опции у конструктора в Electron 33 нет; долгая жизнь
      //    в нуле — известная причина «пустой» отрисовки WebContentsView).
      //    Финальную геометрию по актуальному contentBounds ставит positionView.
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          backgroundThrottling: false,
        },
      });
      this.win.contentView.addChildView(view);
      try {
        view.setBounds(rect);
      } catch {
        /* окно могло закрыться параллельно */
      }

      const mv: ManagedView = {
        profile,
        view,
        session: ses,
        proxy,
        extensions,
        fp,
        scriptAdded: false,
        closing: false,
      };
      this.views.set(profile.id, mv);
      this.byWcId.set(view.webContents.id, profile.id);

      const wc = view.webContents;
      wc.on('render-process-gone', (_e, details) => {
        this.log.error(`${tag} процесс страницы аварийно завершился: ${details.reason}`);
      });
      wc.on('did-fail-load', (_e, errorCode, errorDescription, failedUrl, isMainFrame) => {
        if (isMainFrame) this.log.error(`${tag} ошибка загрузки ${failedUrl}: ${errorCode} ${errorDescription}`);
      });
      // После каждой навигации повторно применяем таймзону/локаль/гео
      // (CDP-override'ы привязаны к процессу рендера и могут слетать при смене процесса).
      // Событие может прилететь и во время teardown — applyNavigationEmulation
      // проверяет closing/isDestroyed и молча выходит.
      wc.on('did-navigate', () => {
        void this.applyNavigationEmulation(mv);
      });

      // 6) Эмуляция через CDP: UA/platform, таймзона и патч отпечатка
      //    (Page.addScriptToEvaluateOnNewDocument — до скриптов страницы).
      await this.applyProfileEmulation(mv);

      // Профиль могли удалить, пока готовилась CDP-эмуляция: webContents уже
      // закрыт в destroyView — loadURL/позиционирование запрещены (crashpad).
      if (mv.closing || wc.isDestroyed()) {
        this.log.info(`${tag} профиль удалён во время создания — представление не активируется`);
        return;
      }

      // 7) Загружаем URL (или about:blank, если не задан).
      const target = profile.url && profile.url.trim() ? profile.url.trim() : 'about:blank';
      wc.loadURL(target).catch((err: Error) => {
        this.log.error(`${tag} loadURL(${target}) failed: ${String(err)}`);
      });

      // 7.5) «Пинок» композитору после каждой полной загрузки (в т.ч. reload):
      //      известная особенность WebContentsView — кадр может не дойти до
      //      поверхности окна, пока внешнее событие (resize, DevTools) не
      //      заставит пересобрать дерево. Реальный resize-цикл bounds (±1px
      //      туда-обратно, визуально не виден) гарантирует выдачу кадра.
      wc.on('did-finish-load', () => {
        if (mv.closing || wc.isDestroyed()) return;
        try {
          this.positionView(profile.id, rect);
          const b = mv.view.getBounds();
          mv.view.setBounds({ x: b.x, y: b.y, width: b.width + 1, height: b.height });
          mv.view.setBounds(b);
        } catch {
          /* view мог закрыться параллельно */
        }
      });

      // 8) Актуальная геометрия: за время подготовки сессии могли прийти
      //    resize/смена раскладки — ставим свежий прямоугольник (или паркинг).
      this.positionView(profile.id, rect);

      this.notify();
      // Представление создано и стало видимым — вписать его в синхронизатор
      // (no-op при выключенном).
      this.syncParticipants();
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
    if (mv.closing) return;
    try {
      if (!mv.view.webContents.isDestroyed()) mv.view.setBounds(cell);
    } catch {
      /* view мог закрыться параллельно */
    }
  }

  /**
   * CDP-эмуляция профиля: Network.setUserAgentOverride (UA + navigator.platform
   * + Accept-Language), Emulation.setTimezoneOverride / setLocaleOverride /
   * setGeolocationOverride (P3: языки и координаты из региона таймзоны) и патч
   * отпечатка через Page.addScriptToEvaluateOnNewDocument (основная инъекция P0.1).
   * Идемпотентность патча — на уровне скрипта (маркер на прототипе),
   * здесь дополнительно страхуемся флагом scriptAdded (сбрасывается при detach).
   */
  private async applyProfileEmulation(mv: ManagedView): Promise<void> {
    const { profile } = mv;
    if (mv.closing) return;
    const wc = mv.view.webContents;
    if (wc.isDestroyed()) return;

    // Ссылки на webContents/debugger берём, ПОКА таргет жив: после await'ов
    // wc может быть закрыт (удаление профиля), и доступ к свойствам мёртвого
    // объекта недопустим. Все шаги — под guard alive().
    const dbg = wc.debugger;
    const alive = (): boolean => !mv.closing && !wc.isDestroyed();

    const locale = mv.fp.locale;
    const wantUa = !!profile.platform || !!profile.userAgent || !!locale;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      if (wantUa && alive()) {
        const params: Record<string, unknown> = {
          userAgent: profile.userAgent || mv.session.getUserAgent(),
        };
        if (profile.platform) params.platform = profile.platform;
        // Accept-Language в синхроне с подменёнными языками (P3).
        if (locale) params.acceptLanguage = locale;
        await dbg.sendCommand('Network.setUserAgentOverride', params);
      }
      if (profile.timezone && alive()) {
        await dbg.sendCommand('Emulation.setTimezoneOverride', {
          timezoneId: profile.timezone,
        });
      }
      // P3: локаль (Intl-форматирование + navigator.language согласованы с TZ).
      if (locale && alive()) {
        await dbg.sendCommand('Emulation.setLocaleOverride', { locale });
      }
      // P3: геолокация — координаты региона таймзоны + дрожание по seed.
      if (mv.fp.geo && alive()) {
        await dbg.sendCommand('Emulation.setGeolocationOverride', {
          latitude: mv.fp.geo.latitude,
          longitude: mv.fp.geo.longitude,
          accuracy: mv.fp.geo.accuracy,
        });
      }
      if (alive() && !mv.scriptAdded) {
        await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
          source: mv.fp.source,
        });
        mv.scriptAdded = true;
      }
    } catch (err) {
      // «target closed while handling command» — норма при удалении профиля
      // в момент применения эмуляции: preload-патч уже в файле сессии,
      // приложение не должно падать.
      this.log.warn(
        `[${profile.id}] CDP-эмуляция не удалась (продолжаем, preload-патч подстрахует): ${String(err)}`,
      );
    }
  }

  /**
   * Повторная эмуляция после навигации: таймзона, локаль и геолокация
   * (CDP-override'ы привязаны к процессу рендера и могут слетать
   * при смене процесса при переходе между сайтами).
   */
  private async applyNavigationEmulation(mv: ManagedView): Promise<void> {
    const fp = mv.fp;
    if (mv.closing) return;
    if (!fp.timezone && !fp.locale && !fp.geo) return;
    try {
      const wc = mv.view.webContents;
      if (wc.isDestroyed()) return;
      const dbg = wc.debugger; // ссылка — пока таргет жив
      if (!dbg.isAttached()) dbg.attach('1.3');
      if (mv.closing || wc.isDestroyed()) return;
      if (fp.timezone) {
        await dbg.sendCommand('Emulation.setTimezoneOverride', {
          timezoneId: fp.timezone,
        });
      }
      if (mv.closing || wc.isDestroyed()) return;
      if (fp.locale) {
        await dbg.sendCommand('Emulation.setLocaleOverride', { locale: fp.locale });
      }
      if (mv.closing || wc.isDestroyed()) return;
      if (fp.geo) {
        await dbg.sendCommand('Emulation.setGeolocationOverride', {
          latitude: fp.geo.latitude,
          longitude: fp.geo.longitude,
          accuracy: fp.geo.accuracy,
        });
      }
    } catch (err) {
      this.log.warn(`[${mv.profile.id}] повторная эмуляция после навигации не удалась: ${String(err)}`);
    }
  }

  /**
   * Аутентификация прокси: login/password из URL прокси профиля (P2.3 —
   * креды отдаются ТОЛЬКО на хост прокси этого профиля; иначе чужой
   * запрос мог бы перехватить учётные данные).
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
      const creds = mv?.proxy;
      if (creds?.username === undefined || !creds.host) return;
      if (authInfo.host === creds.host) {
        event.preventDefault();
        callback(creds.username, creds.password ?? '');
        this.log.info(`[${profileId}] учётные данные прокси предоставлены (${creds.host})`);
      } else {
        // Хост запроса не совпадает с прокси профиля: креды не отдаём —
        // это может быть подставной запрос или прокси другого профиля.
        this.log.warn(
          `[${profileId}] запрос прокси-авторизации для ${authInfo.host} не совпадает с прокси профиля (${creds.host}) — креды не отправлены`,
        );
      }
    } catch (err) {
      this.log.error(`login handler error: ${String(err)}`);
    }
  };

  private destroyView(id: string): void {
    const mv = this.views.get(id);
    if (!mv) return;

    // Флаг «teardown пошёл»: все отложенные обработчики и in-flight CDP-команды
    // этого представления обязаны молчать (см. closing в ManagedView).
    mv.closing = true;

    // Синхронизатор забывает ячейку ДО каких-либо действий с webContents:
    // listener снимается на живом объекте, окно подавления гаснет.
    this.inputSync.forgetProfile(id);

    // webContents берём ДО любых действий и один раз: после close() доступ
    // к view.webContents запрещён (Windows/Electron 33: crashpad).
    let wc: Electron.WebContents | null = null;
    try {
      wc = mv.view.webContents;
    } catch {
      /* webContents мог уже закрыться */
    }

    try {
      if (wc) this.byWcId.delete(wc.id);
    } catch {
      /* ignore */
    }

    // Порядок ОБЯЗАТЕЛЕН (регрессия P1.3, crashpad на Win/Electron 33):
    //   1) открепить view от родителя — close() на ещё прицепленном к
    //      contentView view роняет процесс нативно;
    try {
      this.win?.contentView.removeChildView(mv.view);
    } catch {
      /* окно могло уже закрыться */
    }

    //   2) снять CDP-отладчик ДО close — закрытие таргета с прицепленным
    //      debugger'ом (или с командой в полёте) тоже роняет процесс;
    try {
      if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
    } catch {
      /* ignore */
    }

    //   3) закрыть webContents.
    try {
      if (wc && !wc.isDestroyed()) wc.close();
    } catch (err) {
      this.log.warn(`[${id}] ошибка закрытия webContents: ${String(err)}`);
    }

    // Дальше view.webContents НЕ существует — ни одного обращения.
    this.views.delete(id);
    this.log.info(`представление закрыто: ${id}`);
  }

  /** Полная остановка: вызывается при закрытии окна (все сессии завершаются корректно). */
  destroyAll(): void {
    // Синхронизатор гасим ПЕРВЫМ: снимаем listener'ы с debugger'ов, пока
    // webContents ещё живы (урок P2.5: после close() их трогать нельзя).
    void this.inputSync.setEnabled(false, []);
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
