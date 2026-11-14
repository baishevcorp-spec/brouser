/**
 * Brouser — антидетект-модуль (P0.1 / P0.2 / P2.4).
 *
 * Каждому профилю назначается стабильный seed (fingerprintSeed из config.json
 * либо хеш FNV-1a от id). Из seed детерминированно выводятся:
 *   - шум Canvas (±1/канал) и AudioContext (±1e-5);
 *   - пара WebGL vendor/renderer из реалистичных ANGLE-строк (по платформе);
 *   - navigator.hardwareConcurrency (4/8/12/16) и deviceMemory (4/8);
 *   - navigator.platform — из явного поля либо из UA (никогда не «случайный»:
 *     платформа обязана совпадать с UA, иначе это лёгкий детект).
 *
 * Инъекция патча двойная (надёжность > минимализм):
 *   1) сгенерированный per-profile preload через session.setPreloads —
 *      запускает патч через webFrame.executeJavaScript в MAIN world;
 *   2) CDP Page.addScriptToEvaluateOnNewDocument (см. ProfileManager) —
 *      выполняется до скриптов страницы.
 * Патч идемпотентен (маркер на прототипе), двойной запуск безопасен.
 *
 * Client Hints (P0.2): при заданном UA заголовки sec-ch-ua / sec-ch-ua-mobile /
 * sec-ch-ua-platform синхронизируются с версией Chrome из UA; из ответов
 * вырезается Accept-CH, чтобы Chromium не отправлял high-entropy хинты
 * с реальной версией Electron.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, Session } from 'electron';
import { ProfileConfig } from './types';
import { Logger } from './logger';

/** Патч-генератор живёт в CommonJS-файле без TS (см. шапку fingerprint-preload.js). */
const patchLib = require('./fingerprint-preload') as {
  buildPatchSource(spec: PatchSpecInput): string;
};

/** Семейство платформ: определяет пул реалистичных GPU-строк. */
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

/** Вход патч-генератора (см. fingerprint-preload.js). */
interface PatchSpecInput {
  seed: number;
  timezone: string | null;
  platform: string | null;
  hardwareConcurrency: number;
  deviceMemory: number;
  webglVendor: string;
  webglRenderer: string;
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

/** Платформа из UA; null, если определить нельзя. */
function parseUa(ua: string): UaInfo | null {
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

  const input: PatchSpecInput = {
    seed,
    timezone,
    platform,
    hardwareConcurrency,
    deviceMemory,
    webglVendor: gpu.vendor,
    webglRenderer: gpu.renderer,
  };
  const source = patchLib.buildPatchSource(input);

  const description =
    `fingerprint: seed=${seed}, canvas=patched, webgl=${gpu.renderer}, ` +
    `platform=${platform || 'native'}, cores=${hardwareConcurrency}, mem=${deviceMemory}, ` +
    `ch=${clientHints ? 'chrome-' + clientHints.major : 'default'}`;

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

// ------------------------------------------------------------------
// Client Hints в синхроне с UA (путь P0.2)
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
  const secChUa = `"Chromium";v="${major}", "Not_A Brand";v="24"`;

  try {
    // Исходящие: подставляем low-entropy хинты, соответствующие подменённому UA.
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...(details.requestHeaders ?? {}) };
      try {
        headers['sec-ch-ua'] = secChUa;
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = `"${platform}"`;
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

    log?.info(`[${profile.id}] Client Hints синхронизированы с UA (chrome-${major}, ${platform})`);
  } catch (err) {
    log?.warn(`[${profile.id}] Client Hints: ${String(err)}`);
  }
}
