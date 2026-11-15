/**
 * Разрешение аргумента `profile` в тул-вызовах (P4, этап 2, Zero-Trust).
 *
 * Модель НЕ передаёт profileId — она может сказать «покажи логи avito1»,
 * а main сам находит профиль в конфиге и подставляет его id. Порядок (docs/
 * assistant-stage0.md, раздел 2):
 *   1. точное совпадение id;
 *   2. уникальное совпадение по имени (регистронезависимо; неоднозначность —
 *      ошибка с подсказкой уточнить);
 *   3. «active» (псевдоним выделенной ячейки) → активный профиль;
 *   4. промах → «профиль не найден» БЕЗ деталей — никакой перечислимости
 *      чужих id, никакой догадки. Это защищает от подстановки чужого id.
 *
 * Модуль чистый (без electron) — пригоден для smoke-теста в node.
 */

/** Минимальная форма профиля для разрешения (из config.profiles / getState). */
export interface ResolvableProfile {
  id: string;
  name: string;
}

export type ResolveResult =
  | { ok: true; profile: ResolvableProfile }
  | { ok: false; reason: string };

/** Псевдонимы «текущего» профиля — выделенная в сетке ячейка. */
const ACTIVE_ALIASES = new Set(['active', 'current', 'текущий', 'этот', 'этот профиль']);

export function resolveProfileArg(
  raw: unknown,
  profiles: ResolvableProfile[],
  activeId: string | null,
): ResolveResult {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return activeId
      ? byId(activeId, profiles)
      : { ok: false, reason: 'профиль не задан — укажите имя или выделите ячейку' };
  }

  // 3. Псевдоним активного профиля.
  if (ACTIVE_ALIASES.has(value.toLowerCase())) {
    if (!activeId) return { ok: false, reason: 'активный профиль не выделен — кликните по шапке ячейки' };
    return byId(activeId, profiles);
  }

  // 1. Точное совпадение id.
  const byIdentifier = byId(value, profiles);
  if (byIdentifier.ok) return byIdentifier;

  // 2. Уникальное совпадение по имени (регистронезависимо).
  const needle = value.toLowerCase();
  const byName = profiles.filter((p) => p.name.toLowerCase() === needle);
  if (byName.length === 1) return { ok: true, profile: byName[0] };
  if (byName.length > 1) {
    return { ok: false, reason: 'имя неоднозначно — уточните, какой профиль имеется в виду' };
  }

  // 4. Промах — без деталей.
  return { ok: false, reason: 'профиль не найден' };
}

function byId(id: string, profiles: ResolvableProfile[]): ResolveResult {
  const hit = profiles.find((p) => p.id === id);
  return hit ? { ok: true, profile: hit } : { ok: false, reason: 'профиль не найден' };
}
