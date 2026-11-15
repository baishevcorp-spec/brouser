/**
 * ConfigService — чтение/запись config.json (папка userData) и валидация.
 *
 * Пользователь может править файл руками, поэтому всё нормализуем при загрузке:
 * неизвестная раскладка -> 2x2, битые профили отбрасываются, id дедуплицируются.
 * Запись атомарная (tmp + rename), чтобы не побить файл при падении.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { AppConfig, LayoutId, LAYOUTS, ProfileConfig, ProxyRotationConfig, ThemeId, THEMES } from './types';
import { Logger } from './logger';

const DEFAULT_URL = 'https://www.avito.ru';

export class ConfigService {
  readonly configDir: string;
  readonly configPath: string;
  config!: AppConfig;

  constructor(private log: Logger) {
    this.configDir = app.getPath('userData');
    this.configPath = path.join(this.configDir, 'config.json');
  }

  load(): AppConfig {
    if (fs.existsSync(this.configPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as unknown;
        this.config = normalizeConfig(raw);
        this.log.info(
          `config.json загружен: ${this.config.profiles.length} профилей, раскладка ${this.config.layout}`,
        );
      } catch (err) {
        this.log.error(`config.json повреждён (${String(err)}) — использую значения по умолчанию`);
        this.config = defaultConfig();
      }
    } else {
      this.config = defaultConfig();
      this.log.info('config.json не найден — создаю файл по умолчанию (2 профиля Avito)');
      this.save();
    }
    return this.config;
  }

  /** Атомарная запись config.json. */
  save(): void {
    try {
      fs.mkdirSync(this.configDir, { recursive: true });
      const tmp = this.configPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf8');
      fs.renameSync(tmp, this.configPath);
    } catch (err) {
      this.log.error(`не удалось сохранить config.json: ${String(err)}`);
    }
  }

  /**
   * Пути расширений: абсолютные — как есть; относительные ищем по порядку:
   *   1) папка userData (config.json рядом);
   *   2) resources/extensions — в упакованном приложении (extraResources);
   *   3) рабочая директория;
   *   4) корень приложения (в dev — папка проекта).
   * Возвращаем null, если путь не существует — вызывающий код залогирует ошибку.
   */
  resolveExtensionPath(relOrAbs: string): string | null {
    const p = (relOrAbs || '').trim();
    if (!p) return null;
    if (path.isAbsolute(p)) return fs.existsSync(p) ? p : null;
    const candidates = [
      path.join(this.configDir, p),
      ...(app.isPackaged ? [path.join(process.resourcesPath, 'extensions', p)] : []),
      path.join(process.cwd(), p),
      path.join(app.getAppPath(), p),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  /**
   * P2.2: на macOS ses.loadExtension() изнутри app-бандла блокируется
   * Gatekeeper/quarantine-атрибутами. Поэтому на darwin расширения,
   * лежащие внутри приложения (app.getAppPath() / resourcesPath),
   * копируем в userData/extensions/<имя>-<хеш> и грузим оттуда.
   * Windows/Linux грузят напрямую.
   */
  prepareExtensionForLoad(abs: string, log: Logger): string {
    if (process.platform !== 'darwin') return abs;
    const insideBundle =
      abs.startsWith(app.getAppPath() + path.sep) ||
      (app.isPackaged ? abs.startsWith(process.resourcesPath + path.sep) : false);
    if (!insideBundle) return abs;

    // Стабильный суффикс из пути: коллизии одинаковых имён исключены.
    let hash = 0x811c9dc5;
    for (let i = 0; i < abs.length; i++) {
      hash ^= abs.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    const name = `${path.basename(abs)}-${(hash >>> 0).toString(16)}`;
    const target = path.join(this.configDir, 'extensions', name);
    try {
      if (!fs.existsSync(path.join(target, 'manifest.json'))) {
        fs.rmSync(target, { recursive: true, force: true });
        fs.cpSync(abs, target, { recursive: true });
        log.info(`расширение скопировано в userData (macOS/Gatekeeper): ${name}`);
      }
      return target;
    } catch (err) {
      log.warn(`не удалось скопировать расширение в userData (${abs}): ${String(err)} — пробую оригинальный путь`);
      return abs;
    }
  }

  /**
   * Уникальный id вида avito1, avito2... либо слаг из имени
   * (только латиница/цифры/дефис: id попадает в имя partition).
   */
  generateProfileId(name: string): string {
    const slug = (name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const base = slug && /^[a-z0-9-]+$/.test(slug) ? slug : 'avito';
    const taken = new Set(this.config.profiles.map((p) => p.id));
    if (!taken.has(base)) return base;
    for (let i = 1; i < 500; i++) {
      const id = `${base}${i}`;
      if (!taken.has(id)) return id;
    }
    return `${base}-${Date.now()}`;
  }
}

// ---------- Нормализация / дефолты ----------

function defaultConfig(): AppConfig {
  return {
    profiles: [
      {
        id: 'avito1',
        name: 'Avito Account 1',
        url: DEFAULT_URL,
        proxy: '',
        extensions: [],
        userAgent: '',
        timezone: 'Europe/Moscow',
        platform: '',
        fingerprintSeed: 4821,
      },
      {
        id: 'avito2',
        name: 'Avito Account 2',
        url: DEFAULT_URL,
        proxy: '',
        extensions: [],
        userAgent: '',
        timezone: 'Europe/Moscow',
        platform: '',
        fingerprintSeed: 7342,
      },
    ],
    layout: '2x2',
    windowBounds: { width: 1600, height: 900 },
    theme: 'dark',
  };
}

function normalizeConfig(raw: unknown): AppConfig {
  const src = (raw ?? {}) as Partial<AppConfig>;
  const layout: LayoutId = LAYOUTS[src.layout as LayoutId] ? (src.layout as LayoutId) : '2x2';
  const theme: ThemeId = THEMES.includes(src.theme as ThemeId) ? (src.theme as ThemeId) : 'dark';
  const boundsRaw = src.windowBounds ?? { width: 1600, height: 900 };
  const width = clampInt(boundsRaw.width, 720, 7680, 1600);
  const height = clampInt(boundsRaw.height, 480, 4320, 900);
  const profiles = Array.isArray(src.profiles)
    ? src.profiles.map(normalizeProfile).filter((p): p is ProfileConfig => p !== null)
    : [];
  // Гарантируем уникальность id (иначе partition двух профилей смешается).
  const seen = new Set<string>();
  const unique = profiles.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  return { profiles: unique, layout, theme, windowBounds: { width, height } };
}

function normalizeProfile(raw: unknown): ProfileConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : '';
  if (!id) return null; // профиль без id бесполезен
  return {
    id,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : id,
    url: normalizeUrlInput(typeof p.url === 'string' ? p.url : ''),
    proxy: typeof p.proxy === 'string' ? p.proxy.trim() : '',
    // Ротация мобильного прокси (P3): битые значения отбрасываются —
    // поле не должно блокировать загрузку профиля.
    proxyRotation: normalizeRotation(p.proxyRotation),
    extensions: Array.isArray(p.extensions)
      ? p.extensions.filter((e): e is string => typeof e === 'string' && e.trim() !== '').map((e) => e.trim())
      : [],
    userAgent: typeof p.userAgent === 'string' ? p.userAgent.trim() : '',
    timezone: typeof p.timezone === 'string' ? p.timezone.trim() : '',
    platform: typeof p.platform === 'string' ? p.platform.trim() : '',
    // P3: языки и геолокация (пустые/битые — не блокируют профиль,
    // значения выводятся из timezone на этапе фингерпринта).
    locale: typeof p.locale === 'string' ? p.locale.trim() : '',
    geolocation:
      typeof p.geolocation === 'object' &&
      p.geolocation !== null &&
      Number.isFinite((p.geolocation as { latitude?: unknown }).latitude) &&
      Number.isFinite((p.geolocation as { longitude?: unknown }).longitude)
        ? {
            latitude: (p.geolocation as { latitude: number }).latitude,
            longitude: (p.geolocation as { longitude: number }).longitude,
          }
        : undefined,
    hardwareConcurrency:
      typeof p.hardwareConcurrency === 'number' && p.hardwareConcurrency >= 1 && p.hardwareConcurrency <= 128
        ? Math.floor(p.hardwareConcurrency)
        : undefined,
    fingerprintSeed:
      typeof p.fingerprintSeed === 'number' && Number.isFinite(p.fingerprintSeed) && p.fingerprintSeed >= 1
        ? Math.min(2147483647, Math.floor(p.fingerprintSeed))
        : undefined,
  };
}

/** URL профиля: пусто -> Avito, без схемы -> добавляем https://. */
export function normalizeUrlInput(url: string): string {
  const trimmed = (url || '').trim();
  if (!trimmed) return DEFAULT_URL;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Ротация мобильного прокси: интервал 1..1440 минут (0/битое — выкл),
 * rotationUrl — только http(s) (защита от file:// и прочего мусора
 * из рукоправленного config.json).
 */
function normalizeRotation(raw: unknown): ProxyRotationConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const intervalRaw = typeof r.intervalMin === 'number' && Number.isFinite(r.intervalMin)
    ? Math.floor(r.intervalMin)
    : 0;
  const intervalMin = Math.min(1440, Math.max(0, intervalRaw));
  const url =
    typeof r.rotationUrl === 'string' && r.rotationUrl.trim() && /^https?:\/\//i.test(r.rotationUrl.trim())
      ? r.rotationUrl.trim()
      : undefined;
  if (intervalMin <= 0 && !url) return undefined;
  return intervalMin > 0 ? { intervalMin, rotationUrl: url } : url ? { intervalMin: 0, rotationUrl: url } : undefined;
}
