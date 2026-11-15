/**
 * Brouser — импорт cookies (P3, backlog).
 *
 * Поддерживаются два формата:
 *   1) Netscape cookies.txt (curl/wget, «Экспорт cookies» в Opera GX/Chrome
 *      через расширения): таб-разделённые строки
 *      domain \t flag \t path \t secure \t expiration \t name \t value,
 *      комментарии «#...», спец-префикс «#HttpOnly_» = httpOnly.
 *   2) DevTools-JSON: массив объектов, как экспортируют DevTools
 *      (Application -> Cookies, CDP Network.getAllCookies) и расширения
 *      (EditThisCookie и клоны): domain, hostOnly, path, secure, httpOnly,
 *      expirationDate|expires (секунды с epoch либо ISO-строка), session,
 *      sameSite («None»/«no_restriction»/«Lax»/«Strict»...).
 *
 * Модуль чистый (без electron) — легко тестировать; маппинг в
 * Electron.CookieSetDetails — в toCookieSetDetails (тип-only импорт).
 *
 * Правила нормализации:
 *   - host-only cookie (netscape flag=FALSE, json hostOnly=true) —
 *     устанавливается только на точный хост (без атрибута domain);
 *   - domain-cookie (flag=TRUE, ведущая точка) — с атрибутом domain,
 *     точка гарантируется;
 *   - SameSite=None/no_restriction форсирует Secure (требование Chromium,
 *     иначе cookie молча отбрасывается);
 *   - истёкшие (expirationDate <= now) не устанавливаются — их отсеивает
 *     ProfileManager.importCookies до set();
 *   - сессионные (expiration 0 / session:true / без expiry) —
 *     без expirationDate, доживают только до закрытия.
 */
import type { CookiesSetDetails as CookieSetDetails } from 'electron';

/** Нормализованный cookie (общий для обоих форматов). */
export interface NormalizedCookie {
  name: string;
  value: string;
  /** Домен как в источнике; ведущая точка = domain-cookie (поддомены). */
  domain: string;
  /** Cookie привязан только к точному хосту (без атрибута domain). */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Секунды с epoch; undefined = сессионный cookie. */
  expirationDate?: number;
  /** undefined === 'unspecified'. */
  sameSite?: 'no_restriction' | 'lax' | 'strict';
}

/** Формат, выбранный пользователем («auto» — авто-детект по содержимому). */
export type CookieFormatChoice = 'auto' | 'netscape' | 'json';

/** Результат разбора текста. */
export interface CookieParseResult {
  cookies: NormalizedCookie[];
  /** Фактический формат, к которому привели строки. */
  format: 'netscape' | 'json';
  /** Строки, которые не удалось разобрать (логируются одной суммой). */
  invalid: number;
}

const SAME_SITE_MAP: Record<string, 'no_restriction' | 'lax' | 'strict' | 'unspecified'> = {
  none: 'no_restriction',
  no_restriction: 'no_restriction',
  lax: 'lax',
  strict: 'strict',
  unspecified: 'unspecified',
};

/** Авто-детект: JSON — если текст начинается с [ или {, иначе netscape. */
export function detectCookieFormat(text: string): 'netscape' | 'json' {
  const t = (text || '').trimStart();
  return t.startsWith('[') || t.startsWith('{') ? 'json' : 'netscape';
}

/**
 * Разобрать текст cookies. Бросает Error с человеческим сообщением,
 * если формат не разбирался вовсе (не «пропущено N строк», а полный провал).
 */
export function parseCookieText(text: string, choice: CookieFormatChoice = 'auto'): CookieParseResult {
  const source = (text || '').trim();
  if (!source) throw new Error('Пустой ввод');
  const format = choice === 'auto' ? detectCookieFormat(source) : choice;
  return format === 'json' ? parseJsonCookies(source) : parseNetscapeCookies(source);
}

// ------------------------------------------------------------------
// Netscape cookies.txt
// ------------------------------------------------------------------

function parseNetscapeCookies(text: string): CookieParseResult {
  const cookies: NormalizedCookie[] = [];
  let invalid = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    // Спец-префикс curl: #HttpOnly_domain ... — это cookie, не комментарий.
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true;
      line = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue; // комментарий / заголовок файла
    }

    // Формально поля разделены табами; некоторые экспортёры пишут
    // выравнивание пробелами — терпим оба, но только если 7 полей.
    let parts = line.split('\t');
    if (parts.length < 7) parts = line.split(/\s{2,}/);
    if (parts.length < 7) {
      invalid++;
      continue;
    }

    const domainField = parts[0]?.trim() ?? '';
    const domain = domainField.toLowerCase();
    if (!domain) {
      invalid++;
      continue;
    }
    // flag=TRUE => domain-cookie (действует и на поддомены).
    const domainFlag = parts[1]?.trim().toUpperCase() === 'TRUE';
    const path = parts[2]?.trim() || '/';
    const secure = parts[3]?.trim().toUpperCase() === 'TRUE';
    const expiration = Number.parseInt(parts[4]?.trim() ?? '', 10);
    const name = parts[5]?.trim() ?? '';
    // value — последнее поле; табов внутри быть не должно, но склеиваем на всякий.
    const value = parts.slice(6).join('\t');
    if (!name) {
      invalid++;
      continue;
    }

    // Приводим домен к канонической форме: domain-cookie — с точкой,
    // host-only — без.
    let hostOnly: boolean;
    let normDomain: string;
    if (domainFlag || domain.startsWith('.')) {
      hostOnly = false;
      normDomain = domain.startsWith('.') ? domain : `.${domain}`;
    } else {
      hostOnly = true;
      normDomain = domain;
    }

    const cookie: NormalizedCookie = {
      name,
      value,
      domain: normDomain,
      hostOnly,
      path: path || '/',
      secure,
      httpOnly,
    };
    // expiration=0 (или NaN) — сессионный cookie.
    if (Number.isFinite(expiration) && expiration > 0) {
      cookie.expirationDate = expiration;
    }
    cookies.push(cookie);
  }

  if (cookies.length === 0 && invalid === 0) {
    throw new Error('Не найдено ни одного cookie (только комментарии?)');
  }
  return { cookies, format: 'netscape', invalid };
}

// ------------------------------------------------------------------
// DevTools / EditThisCookie JSON
// ------------------------------------------------------------------

function parseJsonCookies(text: string): CookieParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON не разобран: ${String((err as Error).message ?? err)}`);
  }

  // Некоторые экспортёры оборачивают список: { "cookies": [...] } / { url, cookies }.
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const wrapped = (data as { cookies?: unknown }).cookies;
    if (Array.isArray(wrapped)) data = wrapped;
  }
  if (!Array.isArray(data)) {
    throw new Error('Ожидался JSON-массив cookies');
  }

  const cookies: NormalizedCookie[] = [];
  let invalid = 0;

  for (const item of data) {
    if (typeof item !== 'object' || item === null) {
      invalid++;
      continue;
    }
    const c = item as Record<string, unknown>;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    const value = typeof c.value === 'string' ? c.value : '';
    const domainRaw = typeof c.domain === 'string' ? c.domain.trim().toLowerCase() : '';
    if (!name || !domainRaw) {
      invalid++;
      continue;
    }

    const hostOnly =
      c.hostOnly === true ||
      (typeof c.hostOnly !== 'boolean' && !domainRaw.startsWith('.'));

    const path = typeof c.path === 'string' && c.path.trim() ? c.path.trim() : '/';

    const sameSiteRaw = typeof c.sameSite === 'string' ? c.sameSite.trim().toLowerCase() : '';
    const sameSite = SAME_SITE_MAP[sameSiteRaw] ?? 'unspecified';

    const cookie: NormalizedCookie = {
      name,
      value,
      // host-only — без точки; domain-cookie — с точкой.
      domain: hostOnly
        ? domainRaw.replace(/^\./, '')
        : domainRaw.startsWith('.')
          ? domainRaw
          : `.${domainRaw}`,
      hostOnly,
      path,
      secure: c.secure === true || sameSite === 'no_restriction',
      httpOnly: c.httpOnly === true,
    };
    if (sameSite !== 'unspecified') cookie.sameSite = sameSite;

    const expiration = parseJsonExpiration(c);
    const session = c.session === true;
    if (!session && expiration !== undefined && expiration > 0) {
      cookie.expirationDate = expiration;
    }
    cookies.push(cookie);
  }

  if (cookies.length === 0) {
    throw new Error('В JSON не найдено ни одного валидного cookie');
  }
  return { cookies, format: 'json', invalid };
}

/**
 * Expiry из JSON-экспортёров: expirationDate (EditThisCookie, секунды),
 * expires (CDP: секунды-Float) или ISO-строка (редкие экспортёры).
 */
function parseJsonExpiration(c: Record<string, unknown>): number | undefined {
  for (const key of ['expirationDate', 'expires'] as const) {
    const v = c[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
      const ms = Date.parse(v.trim());
      if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
    }
  }
  return undefined;
}

// ------------------------------------------------------------------
// Фильтр доменов и маппинг в Electron
// ------------------------------------------------------------------

/**
 * Подходит ли cookie под фильтр домена. Семантика «семейства сайта»:
 * cookie-домен и фильтр совпадают, либо один — поддомен другого
 * (avito.ru ~ .avito.ru ~ www.avito.ru). Фильтр «avito.ru» не тянет
 * за собой посторонние домены, но включает куки хоста и его поддоменов.
 */
export function domainMatches(cookieDomain: string, filter: string): boolean {
  const d = normalizeDomain(cookieDomain);
  const f = normalizeDomain(filter);
  if (!d || !f) return false;
  return d === f || f.endsWith(`.${d}`) || d.endsWith(`.${f}`);
}

/** Домен без схемы/пути/ведущей точки/«www.» — для фильтров и подсказок. */
export function normalizeDomain(raw: string): string {
  let s = (raw || '').trim().toLowerCase();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      // не URL — обрезаем всё после первого слеша
      s = s.split('/')[0] ?? '';
    }
  } else {
    s = s.split('/')[0]?.split('?')[0]?.split(':')[0] ?? '';
  }
  s = s.replace(/^\./, '');
  if (s.startsWith('www.')) s = s.slice(4);
  return s;
}

/** Список доменов-фильтров из строки «avito.ru, m.avito.com». */
export function splitDomains(raw: string): string[] {
  return (raw || '')
    .split(/[\s,;]+/)
    .map((s) => normalizeDomain(s))
    .filter((s) => s.length > 0);
}

/** NormalizedCookie -> аргумент session.cookies.set(). */
export function toCookieSetDetails(c: NormalizedCookie): CookieSetDetails {
  const host = c.domain.replace(/^\./, '');
  const secure = c.secure || c.sameSite === 'no_restriction';
  const details: CookieSetDetails = {
    // url обязан быть https для Secure/SameSite=None-cookie.
    url: `${secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure,
    httpOnly: c.httpOnly,
  };
  // Атрибут domain — только для domain-cookie; его отсутствие делает
  // cookie host-only (точный хост).
  if (!c.hostOnly) details.domain = c.domain;
  if (Number.isFinite(c.expirationDate) && (c.expirationDate ?? 0) > 0) {
    details.expirationDate = Math.floor(c.expirationDate as number);
  }
  if (c.sameSite) details.sameSite = c.sameSite;
  return details;
}
