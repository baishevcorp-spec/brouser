/**
 * Brouser — антидетект-модуль (P0.1 / P0.2 / P2.4 / P3).
 *
 * Каждому профилю назначается стабильный seed (fingerprintSeed из config.json
 * либо хеш FNV-1a от id). Из seed детерминированно выводятся:
 *   - шум Canvas (±1/канал) и AudioContext (±1e-5);
 *   - пара WebGL vendor/renderer из реалистичных ANGLE-строк (по платформе);
 *   - navigator.hardwareConcurrency (4/8/12/16) и deviceMemory (4/8);
 *   - navigator.platform — из явного поля либо из UA (никогда не «случайный»:
 *     платформа обязана совпадать с UA, иначе это лёгкий детект);
 *   - window.screen / devicePixelRatio (P3) — из пула правдоподобных
 *     разрешений по семейству платформы, НЕ меньше реального монитора
 *     (window.outer* обязан вмещаться в заявленный screen.*);
 *   - media devices (P3) — правдоподобное число микрофонов/выходов/камер
 *     с детерминированными deviceId;
 *   - шрифты (P3) — подмножество «редких» системных шрифтов помечается
 *     отсутствующим (JS-уровень), measureText получает шум ±0.2%.
 *
 * Языки и геолокация (P3) выводятся из региона таймзоны:
 *   - locale (navigator.language(s), Accept-Language, Intl) — из явного поля
 *     profile.locale либо из таблицы TZ_LOCALE;
 *   - геолокация — из явного profile.geolocation либо из TZ_GEO (центр
 *     региона + дрожание по seed: профили одной таймзоны не должны светить
 *     идентичные координаты).
 *
 * Инъекция патча двойная (надёжность > минимализм):
 *   1) сгенерированный per-profile preload через session.setPreloads —
 *      запускает патч через webFrame.executeJavaScript в MAIN world;
 *   2) CDP Page.addScriptToEvaluateOnNewDocument (см. ProfileManager) —
 *      выполняется до скриптов страницы.
 * Патч идемпотентен (маркер на прототипе), двойной запуск безопасен.
 *
 * Client Hints (P0.2 + P3): при заданном UA заголовки sec-ch-ua /
 * sec-ch-ua-mobile / sec-ch-ua-platform синхронизируются с версией Chrome из
 * UA; GREASE-бренд и порядок брендов вычисляются ТОЧНО как в Chromium
 * (components/embedder_support/user_agent_utils.cc: бренд
 * «Not{c[m%11]}A{c[(m+1)%11]}Brand», версия {"8","99","24"}[m%3],
 * перестановка списка по major); из ответов вырезается Accept-CH, чтобы
 * Chromium не отправлял high-entropy хинты с реальной версией Electron.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, screen, Session } from 'electron';
import { ProfileConfig } from './types';
import { Logger } from './logger';

/** Патч-генератор живёт в CommonJS-файле без TS (см. шапку fingerprint-preload.js). */
const patchLib = require('./fingerprint-preload') as {
  buildPatchSource(spec: PatchSpecInput): string;
};

/** Семейство платформ: определяет пул GPU-строк, экранов и «редких» шрифтов. */
type GpuFamily = 'windows' | 'mac' | 'linux';

/** Реалистичные пары UNMASKED_VENDOR/UNMASKED_RENDERER (формат ANGLE в Chromium). */
const GPU_BY_FAMILY: Record<GpuFamily, { vendor: string; renderer: string }[]> = {
  windows: [
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) RX 580 Series, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics, D3D11)' },
  ],
  mac: [
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Intel(R) UHD Graphics 630, Unspecified Version)' },
  ],
  linux: [
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (i915), OpenGL 4.6)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 (radeonsi polaris10), OpenGL 4.6)' },
  ],
};

// ------------------------------------------------------------------
// P3: регионы — таймзона -> локаль и центр региона
// ------------------------------------------------------------------

/** Таймзона -> локаль Chrome на десктопе этого региона (BCP47). */
const TZ_LOCALE: Record<string, string> = {
  // Россия (все пояса; UserLocale на подавляющем большинстве машин — ru)
  'Europe/Moscow': 'ru-RU', 'Europe/Kaliningrad': 'ru-RU', 'Europe/Volgograd': 'ru-RU',
  'Europe/Samara': 'ru-RU', 'Europe/Kirov': 'ru-RU', 'Europe/Saratov': 'ru-RU',
  'Europe/Ulyanovsk': 'ru-RU', 'Europe/Astrakhan': 'ru-RU', 'Europe/Simferopol': 'ru-RU',
  'Asia/Yekaterinburg': 'ru-RU', 'Asia/Omsk': 'ru-RU', 'Asia/Novosibirsk': 'ru-RU',
  'Asia/Barnaul': 'ru-RU', 'Asia/Tomsk': 'ru-RU', 'Asia/Novokuznetsk': 'ru-RU',
  'Asia/Krasnoyarsk': 'ru-RU', 'Asia/Irkutsk': 'ru-RU', 'Asia/Chita': 'ru-RU',
  'Asia/Yakutsk': 'ru-RU', 'Asia/Vladivostok': 'ru-RU', 'Asia/Khabarovsk': 'ru-RU',
  'Asia/Magadan': 'ru-RU', 'Asia/Sakhalin': 'ru-RU', 'Asia/Kamchatka': 'ru-RU',
  'Asia/Anadyr': 'ru-RU',
  // СНГ
  'Europe/Kyiv': 'uk-UA', 'Europe/Kiev': 'uk-UA', 'Europe/Uzhgorod': 'uk-UA', 'Europe/Zaporozhye': 'uk-UA',
  'Europe/Minsk': 'ru-RU', // большинство десктопов РБ — русский интерфейс Chrome
  'Asia/Almaty': 'ru-KZ', 'Asia/Astana': 'ru-KZ', 'Asia/Aqtau': 'ru-KZ', 'Asia/Aqtobe': 'ru-KZ',
  'Asia/Atyrau': 'ru-KZ', 'Asia/Oral': 'ru-KZ', 'Asia/Qyzylorda': 'ru-KZ', 'Asia/Qostanay': 'ru-KZ',
  'Asia/Tashkent': 'uz-UZ', 'Asia/Samarkand': 'uz-UZ',
  'Asia/Tbilisi': 'ka-GE', 'Asia/Yerevan': 'hy-AM', 'Asia/Baku': 'az-Latn-AZ',
  'Asia/Bishkek': 'ru-KG', 'Asia/Dushanbe': 'ru-TJ', 'Asia/Ashgabat': 'ru-TM',
  // ЕС и остальные (Avito-сценарий — редкость, но полноты ради)
  'Europe/Berlin': 'de-DE', 'Europe/Vienna': 'de-AT', 'Europe/Zurich': 'de-CH',
  'Europe/London': 'en-GB', 'Europe/Dublin': 'en-IE',
  'Europe/Warsaw': 'pl-PL', 'Europe/Bucharest': 'ro-RO', 'Europe/Prague': 'cs-CZ',
  'Europe/Bratislava': 'sk-SK', 'Europe/Budapest': 'hu-HU', 'Europe/Sofia': 'bg-BG',
  'Europe/Riga': 'lv-LV', 'Europe/Vilnius': 'lt-LT', 'Europe/Tallinn': 'et-EE',
  'Europe/Helsinki': 'fi-FI', 'Europe/Stockholm': 'sv-SE', 'Europe/Oslo': 'nb-NO',
  'Europe/Copenhagen': 'da-DK', 'Europe/Amsterdam': 'nl-NL', 'Europe/Paris': 'fr-FR',
  'Europe/Madrid': 'es-ES', 'Europe/Lisbon': 'pt-PT', 'Europe/Rome': 'it-IT',
  'Europe/Athens': 'el-GR', 'Europe/Istanbul': 'tr-TR',
  'America/New_York': 'en-US', 'America/Chicago': 'en-US', 'America/Denver': 'en-US',
  'America/Los_Angeles': 'en-US', 'America/Toronto': 'en-CA', 'America/Vancouver': 'en-CA',
  'Asia/Dubai': 'en-AE', 'Asia/Bangkok': 'th-TH', 'Asia/Ho_Chi_Minh': 'vi-VN',
};

/** Таймзона -> координаты центра крупнейшего города региона. */
const TZ_GEO: Record<string, [number, number]> = {
  'Europe/Moscow': [55.7558, 37.6173],
  'Europe/Kaliningrad': [54.7104, 20.4522],
  'Europe/Samara': [53.1959, 50.1002],
  'Europe/Volgograd': [48.7072, 44.5373],
  'Europe/Saratov': [51.5336, 46.0342],
  'Europe/Kirov': [58.6035, 49.6679],
  'Europe/Ulyanovsk': [54.3142, 48.4031],
  'Asia/Yekaterinburg': [56.8389, 60.6057],
  'Asia/Omsk': [54.9885, 73.3242],
  'Asia/Novosibirsk': [55.0084, 82.9357],
  'Asia/Barnaul': [53.3548, 83.7698],
  'Asia/Tomsk': [56.4977, 84.9744],
  'Asia/Krasnoyarsk': [56.0153, 92.8932],
  'Asia/Irkutsk': [52.2823, 104.2964],
  'Asia/Chita': [52.034, 113.4994],
  'Asia/Yakutsk': [62.0281, 129.7326],
  'Asia/Vladivostok': [43.1155, 131.8855],
  'Asia/Khabarovsk': [48.4827, 135.0719],
  'Asia/Magadan': [59.5638, 150.8045],
  'Asia/Sakhalin': [46.9591, 142.7357],
  'Asia/Kamchatka': [53.037, 158.6557],
  'Europe/Kyiv': [50.4501, 30.5234], 'Europe/Kiev': [50.4501, 30.5234],
  'Europe/Minsk': [53.9006, 27.559],
  'Asia/Almaty': [43.222, 76.8512],
  'Asia/Astana': [51.1694, 71.449],
  'Asia/Tashkent': [41.2995, 69.2401],
  'Asia/Tbilisi': [41.7151, 44.8271],
  'Asia/Yerevan': [40.1872, 44.0151],
  'Asia/Baku': [40.4093, 49.8671],
  'Asia/Bishkek': [42.8746, 74.5698],
  'Europe/Berlin': [52.52, 13.405],
  'Europe/London': [51.5074, -0.1278],
  'Europe/Paris': [48.8566, 2.3522],
  'Europe/Warsaw': [52.2297, 21.0122],
  'Europe/Bucharest': [44.4268, 26.1025],
  'Europe/Prague': [50.0755, 14.4378],
  'Europe/Budapest': [47.4979, 19.0402],
  'Europe/Riga': [56.9496, 24.1052],
  'Europe/Vilnius': [54.6872, 25.2797],
  'Europe/Tallinn': [59.437, 24.7536],
  'Europe/Helsinki': [60.1699, 24.9384],
  'Europe/Amsterdam': [52.3676, 4.9041],
  'Europe/Madrid': [40.4168, -3.7038],
  'Europe/Lisbon': [38.7223, -9.1393],
  'Europe/Rome': [41.9028, 12.4964],
  'Europe/Athens': [37.9838, 23.7275],
  'Europe/Istanbul': [41.0082, 28.9784],
  'America/New_York': [40.7128, -74.006],
  'America/Chicago': [41.8781, -87.6298],
  'America/Denver': [39.7392, -104.9903],
  'America/Los_Angeles': [34.0522, -118.2437],
  'Asia/Dubai': [25.2048, 55.2708],
  'Asia/Bangkok': [13.7563, 100.5018],
};

// ------------------------------------------------------------------
// P3: пулы экранов, «редкие» шрифты
// ------------------------------------------------------------------

/** Пул правдоподобных разрешений мониторов (CSS-px) по семейству платформы. */
const SCREEN_POOL: Record<GpuFamily, { w: number; h: number; dpr: number }[]> = {
  windows: [
    { w: 1366, h: 768, dpr: 1 },
    { w: 1600, h: 900, dpr: 1 },
    { w: 1920, h: 1080, dpr: 1 },
    { w: 2560, h: 1440, dpr: 1 },
    { w: 3840, h: 2160, dpr: 1.5 }, // 4K: типовое масштабирование 150%
  ],
  mac: [
    { w: 1440, h: 900, dpr: 2 }, // MacBook Air 13"
    { w: 1512, h: 982, dpr: 2 }, // MacBook Pro/Air 14"
    { w: 1728, h: 1117, dpr: 2 }, // MacBook Pro 16"
    { w: 1920, h: 1080, dpr: 1 }, // внешний монитор
    { w: 2560, h: 1440, dpr: 1 },
  ],
  linux: [
    { w: 1366, h: 768, dpr: 1 },
    { w: 1920, h: 1080, dpr: 1 },
    { w: 2560, h: 1440, dpr: 1 },
  ],
};

/**
 * «Редкие» системные шрифты (ставятся опционально / зависят от редакции ОС).
 * Подмножество по seed помечается ОТСУТСТВУЮЩИМ — меняет результаты
 * перечисления шрифтов (document.fonts.check) между профилями.
 * Маскируем только true->false: заявленные @font-face и точно установленные
 * базовые шрифты не трогаем (ложное «установлен» ломает загрузку веб-шрифтов).
 */
const RARE_FONTS: Record<GpuFamily, string[]> = {
  windows: [
    'Bahnschrift', 'Ink Free', 'Javanese Text', 'Myanmar Text',
    'Nirmala UI', 'Segoe UI Historic', 'Segoe UI Variable Display',
  ],
  mac: ['Copperplate', 'Al Nile', 'Farah', 'Gurmukhi MN', 'InaiMathi', 'Lao MN', 'Mshtakan'],
  linux: ['URW Gothic', 'FreeMono', 'FreeSans', 'FreeSerif', 'Z003', 'Noto Sans Kufi Arabic'],
};

// ------------------------------------------------------------------
// P3: Client Hints — GREASE-ротация как в Chromium
// ------------------------------------------------------------------

/** GREASE-символы (components/embedder_support/user_agent_utils.cc). */
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
/** GREASE-версии, вращаются по major % 3. */
const GREASE_VERSIONS = ['8', '99', '24'];
/** Перестановки из 3 элементов (GetRandomOrder, seed = major). */
const PERMS3: [number, number, number][] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

/** Точные GREASE-бренд/версия для версии Chrome (алгоритм Chromium). */
function greaseBrandFor(major: number): { brand: string; version: string } {
  const i = ((major % 11) + 11) % 11;
  const j = (((major + 1) % 11) + 11) % 11;
  return {
    brand: `Not${GREASE_CHARS[i]}A${GREASE_CHARS[j]}Brand`,
    version: GREASE_VERSIONS[((major % 3) + 3) % 3] as string,
  };
}

/**
 * Дочерний бренд браузера из UA (Chrome всегда добавляет свой бренд к
 * Chromium; Opera/Edge/Yandex — свой). null — считаем чистым Chrome.
 */
function browserBrandOf(ua: string, chromeMajor: number): { brand: string; version: string } {
  const pairs: [RegExp, string][] = [
    [/OPR\/(\d+)/, 'Opera'],
    [/Edg(?:A|iOS)?\/(\d+)/, 'Microsoft Edge'],
    [/YaBrowser\/(\d+)/, 'YaBrowser'],
    [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/Vivaldi\/(\d+)/, 'Vivaldi'],
  ];
  for (const [re, name] of pairs) {
    const m = re.exec(ua);
    if (m) return { brand: name, version: m[1] as string };
  }
  return { brand: 'Google Chrome', version: String(chromeMajor) };
}

/** Итоговые low-entropy Client Hints для UA. */
interface SecChUa {
  value: string;
  mobile: '?0' | '?1';
  platform: string;
}

/**
 * Сформировать sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform для UA.
 * null — в UA нет Chrome/<major> (заголовки не трогаем).
 * Порядок брендов и GREASE-строки совпадают с реальным Chromium этой версии.
 */
export function buildSecChUa(ua: string, chPlatform: string): SecChUa | null {
  const mm = /Chrome\/(\d+)/.exec(ua);
  if (!mm) return null;
  const major = Number.parseInt(mm[1] as string, 10);
  if (!Number.isFinite(major) || major <= 0) return null;

  const g = greaseBrandFor(major);
  const extra = browserBrandOf(ua, major);
  const pre = [`"${g.brand}";v="${g.version}"`, `"Chromium";v="${major}"`, `"${extra.brand}";v="${extra.version}"`];

  // Перестановка как в Chromium (GetRandomOrder, seed = major, n = 3):
  // shuffled[order[i]] = list[i].
  const order = PERMS3[((major % 6) + 6) % 6] as [number, number, number];
  const out: string[] = new Array(3);
  for (let i = 0; i < 3; i++) out[order[i] as number] = pre[i] as string;

  const mobile: '?0' | '?1' = /Android|iPhone|iPad|Mobile/i.test(ua) ? '?1' : '?0';
  return { value: out.join(', '), mobile, platform: chPlatform };
}

// ------------------------------------------------------------------
// Вход патч-генератора (см. fingerprint-preload.js)
// ------------------------------------------------------------------

/** Геолокация профиля для JS-патча. */
interface GeoSpec {
  latitude: number;
  longitude: number;
  /** Точность в метрах (15..145) — типичные значения GPS/WiFi-фикса. */
  accuracy: number;
}

/** Экран профиля (CSS-px): screen.* и window.devicePixelRatio. */
interface ScreenSpec {
  width: number;
  height: number;
  availWidth: number;
  availHeight: number;
  availLeft: number;
  availTop: number;
  colorDepth: number;
  dpr: number;
}

/** Число медиа-устройств профиля. */
interface MediaDeviceSpec {
  audioInputs: number;
  audioOutputs: number;
  videoInputs: number;
}

/** Вход патч-генератора (см. fingerprint-preload.js). */
interface PatchSpecInput {
  seed: number;
  timezone: string | null;
  platform: string | null;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
  /** navigator.languages (null — языки не трогаем). */
  languages: string[] | null;
  /** Основная локаль (Intl + navigator.language). */
  locale: string | null;
  /** Геолокация (null — не трогаем). */
  geo: GeoSpec | null;
  /** Экран (задаётся всегда). */
  screen: ScreenSpec;
  /** Медиа-устройства (задаётся всегда). */
  mediaDevices: MediaDeviceSpec;
  /** «Редкие» шрифты семейства платформы (для маскировки подмножества). */
  fontsRare: string[];
}

/** Полная спецификация отпечатка профиля (значения + готовый скрипт + описание). */
export interface FingerprintSpec extends PatchSpecInput {
  /** Client Hints из UA; null — UA не задан, заголовки не трогаем. */
  clientHints: { major: string; platform: string } | null;
  /** Готовый main-world патч-скрипт. */
  source: string;
  /** Однострочная сводка для app.log (P2.4). */
  description: string;
}

/** Информация о платформе, извлечённая из User-Agent. */
interface UaInfo {
  navPlatform: string;
  chPlatform: string;
  family: GpuFamily;
}

// ------------------------------------------------------------------
// Seed и выборки
// ------------------------------------------------------------------

/** FNV-1a 32 бита: стабильный seed из строки (id профиля). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1; // никогда 0
}

/** Итоговый seed профиля: явный fingerprintSeed либо хеш id. */
export function resolveSeed(profile: ProfileConfig): number {
  if (profile.fingerprintSeed && Number.isFinite(profile.fingerprintSeed)) {
    return Math.max(1, Math.min(2147483647, Math.floor(profile.fingerprintSeed))) | 0;
  }
  return fnv1a(profile.id);
}

/** Детерминированный выбор элемента массива по seed. */
function pickBySeed<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed | 0) % arr.length] as T;
}

/** Детерминированное дрожание [-amp, +amp] по (seed, salt). */
function jitter(seed: number, salt: number, amp: number): number {
  const h = Math.imul((seed ^ Math.imul(salt, 2246822519)) >>> 0, 2654435761) >>> 0;
  return ((h % 2001) / 1000 - 1) * amp;
}

/** Детерминированная «точность геолокации» 15..145 м. */
function geoAccuracy(seed: number, salt: number): number {
  const h = Math.imul((seed ^ Math.imul(salt, 668265263)) >>> 0, 2654435761) >>> 0;
  return 15 + (h % 130);
}

/** Платформа из UA; null, если определить нельзя. */
function parseUa(ua: string): UaInfo | null {
  if (/Android/i.test(ua)) {
    // Android-десктопов у Avito-сценария нет, но корректный sec-ch-ua-platform
    // важнее правдоподобного GPU-пула: семейство оставляем linux.
    return { navPlatform: 'Linux armv8l', chPlatform: 'Android', family: 'linux' };
  }
  if (/Windows NT/i.test(ua)) {
    return { navPlatform: 'Win32', chPlatform: 'Windows', family: 'windows' };
  }
  if (/Macintosh|Mac OS X/i.test(ua)) {
    return { navPlatform: 'MacIntel', chPlatform: 'macOS', family: 'mac' };
  }
  if (/Linux|X11|Ubuntu/i.test(ua)) {
    return { navPlatform: 'Linux x86_64', chPlatform: 'Linux', family: 'linux' };
  }
  return null;
}

/** Семейство по navigator.platform. */
function familyOfPlatform(navPlatform: string): GpuFamily {
  if (/^Win/.test(navPlatform)) return 'windows';
  if (/^Mac/.test(navPlatform)) return 'mac';
  if (/^Linux/.test(navPlatform)) return 'linux';
  return 'windows';
}

/** Семейство реальной ОС (для профилей без подмен платформы). */
function nativeFamily(): GpuFamily {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

// ------------------------------------------------------------------
// P3: языки / геолокация / экран / устройства / шрифты
// ------------------------------------------------------------------

/** Эффективная локаль: явное поле -> регион таймзоны -> не трогаем. */
function resolveLocale(profile: ProfileConfig): string | null {
  const explicit = (profile.locale || '').trim();
  if (explicit) return explicit;
  const tz = (profile.timezone || '').trim();
  return tz ? TZ_LOCALE[tz] ?? null : null;
}

/** navigator.languages из локали (шаблон реального Chrome). */
function localeToLanguages(locale: string): string[] {
  const lang = (locale.split('-')[0] as string).toLowerCase();
  if (lang === 'en') {
    // en-XX Chrome: [en-XX, en-US, en]; en-US: [en-US, en].
    return locale.toLowerCase() === 'en-us' ? ['en-US', 'en'] : [locale, 'en-US', 'en'];
  }
  return [locale, lang, 'en-US', 'en'];
}

/** Эффективная геолокация: явное поле -> центр региона таймзоны + дрожание. */
function resolveGeolocation(profile: ProfileConfig, seed: number): GeoSpec | null {
  const explicit = profile.geolocation;
  if (
    explicit &&
    Number.isFinite(explicit.latitude) &&
    Number.isFinite(explicit.longitude)
  ) {
    return {
      latitude: explicit.latitude,
      longitude: explicit.longitude,
      accuracy: geoAccuracy(seed, 3),
    };
  }
  const tz = (profile.timezone || '').trim();
  const city = tz ? TZ_GEO[tz] : undefined;
  if (!city) return null;
  return {
    latitude: Math.max(-85, Math.min(85, city[0] + jitter(seed, 11, 0.25))),
    longitude: Math.max(-180, Math.min(180, city[1] + jitter(seed, 29, 0.35))),
    accuracy: geoAccuracy(seed, 7),
  };
}

/**
 * Экран профиля: разрешение из пула семейства по seed. Заявленный экран
 * никогда не меньше реального монитора (DIP): window.outer* страницы обязан
 * вмещаться в screen.*, иначе расхождение видно наизусть.
 */
function resolveScreen(family: GpuFamily, seed: number): ScreenSpec {
  const pool = SCREEN_POOL[family];
  let minW = 1366;
  let minH = 768;
  try {
    const disp = screen.getPrimaryDisplay();
    minW = Math.max(minW, Math.ceil(disp.size.width));
    minH = Math.max(minH, Math.ceil(disp.size.height));
  } catch {
    /* screen недоступен (ранняя фаза/тесты) — базовые значения */
  }
  const fits = pool.filter((r) => r.w >= minW && r.h >= minH);
  const chosen = fits.length > 0 ? pickBySeed(fits, seed) : (pool[pool.length - 1] as { w: number; h: number; dpr: number });

  // avail: Windows — панель задач снизу (48px, Win11 по умолчанию);
  // macOS — строка меню сверху (25px); Linux — верхняя панель (24px).
  const top = family === 'mac' ? 25 : family === 'linux' ? 24 : 0;
  const reserved = family === 'windows' ? 48 : top;

  return {
    width: chosen.w,
    height: chosen.h,
    availWidth: chosen.w,
    availHeight: Math.max(1, chosen.h - reserved),
    availLeft: 0,
    availTop: top,
    colorDepth: 24,
    dpr: chosen.dpr,
  };
}

/** Медиа-устройства профиля (правдоподобные наборы десктопа). */
function resolveMediaDevices(seed: number): MediaDeviceSpec {
  return {
    audioInputs: 1 + (Math.abs(seed) % 2), // 1..2
    audioOutputs: 1 + (Math.abs(seed >> 3) % 2), // 1..2
    videoInputs: Math.abs(seed) % 5 === 0 ? 0 : 1, // ~20% десктопов без камеры
  };
}

// ------------------------------------------------------------------
// Спецификация отпечатка
// ------------------------------------------------------------------

/** Собрать спецификацию отпечатка профиля (без побочных эффектов). */
export function buildFingerprintSpec(profile: ProfileConfig): FingerprintSpec {
  const seed = resolveSeed(profile);
  const ua = (profile.userAgent || '').trim();
  const uaInfo = ua ? parseUa(ua) : null;

  // navigator.platform: явное поле -> из UA -> не трогаем (нативная платформа
  // обязана совпадать с UA, «случайная» платформа выдаёт подмену).
  const platform = profile.platform || uaInfo?.navPlatform || null;

  // Пул GPU согласован с итоговой платформой (D3D11/Metal/OpenGL).
  const family = profile.platform
    ? familyOfPlatform(profile.platform)
    : uaInfo?.family ?? nativeFamily();
  const gpu = pickBySeed(GPU_BY_FAMILY[family], seed);

  const hardwareConcurrency = profile.hardwareConcurrency ?? pickBySeed([4, 8, 12, 16], seed);
  const deviceMemory = pickBySeed([4, 8], seed);
  const timezone = profile.timezone || null;

  // Client Hints — только при явном UA (P0.2).
  const majorMatch = ua ? /Chrome\/(\d+)/.exec(ua) : null;
  const clientHints =
    ua && majorMatch && uaInfo ? { major: majorMatch[1] as string, platform: uaInfo.chPlatform } : null;

  // P3: языки, геолокация, экран, медиа-устройства, шрифты.
  const locale = resolveLocale(profile);
  const languages = locale ? localeToLanguages(locale) : null;
  const geo = resolveGeolocation(profile, seed);
  const screenSpec = resolveScreen(family, seed);
  const mediaDevices = resolveMediaDevices(seed);
  const fontsRare = RARE_FONTS[family];

  const input: PatchSpecInput = {
    seed,
    timezone,
    platform,
    hardwareConcurrency,
    deviceMemory,
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
    languages,
    locale,
    geo,
    screen: screenSpec,
    mediaDevices,
    fontsRare,
  };
  const source = patchLib.buildPatchSource(input);

  const description =
    `fingerprint: seed=${seed}, canvas=patched, webgl=${gpu.renderer}, ` +
    `platform=${platform || 'native'}, cores=${hardwareConcurrency}, mem=${deviceMemory}, ` +
    `ch=${clientHints ? 'chrome-' + clientHints.major : 'default'}, ` +
    `locale=${locale || 'native'}, geo=${geo ? `${geo.latitude.toFixed(2)}/${geo.longitude.toFixed(2)}` : 'off'}, ` +
    `screen=${screenSpec.width}x${screenSpec.height}@${screenSpec.dpr}, ` +
    `mdev=${mediaDevices.audioInputs}/${mediaDevices.audioOutputs}/${mediaDevices.videoInputs}, fonts=patched`;

  return { ...input, clientHints, source, description };
}

// ------------------------------------------------------------------
// Инъекция через preload (путь №1)
// ------------------------------------------------------------------

/** Путь сгенерированного preload-файла профиля (userData/fingerprint-preloads/<id>.js). */
export function getPreloadPath(profile: ProfileConfig): string {
  return path.join(app.getPath('userData'), 'fingerprint-preloads', `${profile.id}.js`);
}

/**
 * Регистрирует per-profile preload патча через session.setPreloads
 * (одна сессия — один preload). Значения «запекаются» в файл: env-переменные
 * между preload и main не передаются. Ошибки не бросает — CDP-инъекция
 * (ProfileManager.applyProfileEmulation) подстрахует.
 */
export function applyFingerprint(ses: Session, profile: ProfileConfig, log?: Logger): FingerprintSpec {
  const spec = buildFingerprintSpec(profile);
  try {
    const file = getPreloadPath(profile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const sourceJson = JSON.stringify(spec.source);
    const content =
      `'use strict';\n` +
      `// Brouser fingerprint preload — профиль "${profile.id}" (seed ${spec.seed}).\n` +
      `// Сгенерирован автоматически; запускает патч отпечатка в MAIN world\n` +
      `// до скриптов страницы. CDP-инъекция — страховка (патч идемпотентен).\n` +
      `(function () {\n` +
      `  try {\n` +
      `    var wf = require('electron').webFrame;\n` +
      `    if (wf && typeof wf.executeJavaScript === 'function') {\n` +
      `      wf.executeJavaScript(${sourceJson});\n` +
      `    }\n` +
      `  } catch (e) { /* CDP-инъекция подстрахует */ }\n` +
      `})();\n`;
    fs.writeFileSync(file, content, 'utf8');
    ses.setPreloads([file]);
  } catch (err) {
    log?.warn(`[${profile.id}] preload-патч не зарегистрирован (${String(err)}) — работает CDP-инъекция`);
  }
  return spec;
}

/**
 * Удаляет сгенерированный preload-файл профиля
 * (userData/fingerprint-preloads/<id>.js).
 *
 * Вызывается при удалении профиля: сессия и представление гаснут,
 * файл-инъекция больше никогда не понадобится — иначе в userData
 * копится мёртвый мусор. Ошибки не бросает (удаление профиля не должно
 * падать из-за файловой системы).
 */
export function removeFingerprintPreload(profile: ProfileConfig, log?: Logger): void {
  try {
    const file = getPreloadPath(profile);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      log?.info(`[${profile.id}] preload-файл отпечатка удалён`);
    }
  } catch (err) {
    log?.warn(`[${profile.id}] не удалось удалить preload-файл отпечатка: ${String(err)}`);
  }
}

// ------------------------------------------------------------------
// Client Hints в синхроне с UA (путь P0.2 + P3 GREASE)
// ------------------------------------------------------------------

/**
 * Заголовки sec-ch-ua* синхронизируются с User-Agent профиля.
 * Если UA не задан — заголовки не трогаем (нативное поведение).
 * Дополнительно вырезается Accept-CH из ответов, чтобы Chromium не
 * раскрывал high-entropy хинты реальной версии Electron.
 */
export function applyClientHints(ses: Session, profile: ProfileConfig, log?: Logger): void {
  const ua = (profile.userAgent || '').trim();
  if (!ua) return;
  const spec = buildFingerprintSpec(profile);
  if (!spec.clientHints) {
    log?.warn(`[${profile.id}] UA без Chrome/<major> — Client Hints не синхронизируются`);
    return;
  }
  const { major, platform } = spec.clientHints;
  const sec = buildSecChUa(ua, platform);
  if (!sec) {
    log?.warn(`[${profile.id}] не удалось собрать sec-ch-ua из UA`);
    return;
  }

  try {
    // Исходящие: подставляем low-entropy хинты, соответствующие подменённому UA.
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...(details.requestHeaders ?? {}) };
      try {
        headers['sec-ch-ua'] = sec.value;
        headers['sec-ch-ua-mobile'] = sec.mobile;
        headers['sec-ch-ua-platform'] = `"${sec.platform}"`;
      } catch {
        /* заголовки остаются как есть */
      }
      callback({ requestHeaders: headers });
    });

    // Входящие: убираем Accept-CH — иначе Chromium начнёт отправлять
    // high-entropy хинты (full-version-list и пр.) с реальной версией.
    ses.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...(details.responseHeaders ?? {}) };
      let touched = false;
      for (const key of Object.keys(headers)) {
        if (/^accept-ch$/i.test(key)) {
          delete headers[key];
          touched = true;
        }
      }
      if (touched) callback({ responseHeaders: headers });
      else callback({ responseHeaders: details.responseHeaders ?? {} });
    });

    log?.info(`[${profile.id}] Client Hints синхронизированы с UA (chrome-${major}, ${platform}): ${sec.value}`);
  } catch (err) {
    log?.warn(`[${profile.id}] Client Hints: ${String(err)}`);
  }
}
