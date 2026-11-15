/**
 * Zod-схемы аргументов тулов ассистента (P4, этап 2).
 *
 * Единственный источник истины: JSON Schema для LLM генерируется из этих
 * схем (toJsonSchemaForModel), входящие аргументы валидируются ими же.
 * Версии моделей меняются, поэтому всё «строго по ТЗ»: .max/.min/.enum/.default,
 * никаких произвольных строк. Ответ тула отдельно обрезается реестром
 * до 4–8 КБ — на эти схемы лимиты не завязаны.
 *
 * Профиль всюду — строка (имя/id/«active»): id подставляет main
 * (resolve.ts), модель его не знает и знать не должна.
 */
import { z } from 'zod';

/** Раскладки сетки (зеркалит LAYOUTS в types.ts). */
const LAYOUT_IDS = ['1x1', '1x2', '2x1', '2x2', '3x1', '1x3'] as const;

/** Аргумент профиля: имя, id или псевдоним «active». */
const profileArg = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('Имя или id профиля; «active» = выделенная ячейка (подставит система)');

/** 1. list_profiles — без аргументов. */
export const listProfilesSchema = z.object({});

/** 2. profile_details — сводка одного профиля (без кредов). */
export const profileDetailsSchema = z.object({
  profile: profileArg,
});

/** 3. grid_info — без аргументов. */
export const gridInfoSchema = z.object({});

/** 4. set_layout — сменить раскладку. */
export const setLayoutSchema = z.object({
  layout: z.enum(LAYOUT_IDS).describe('Целевая раскладка сетки, например «2x2»'),
});

/** 5. reload_profile — перезагрузить страницу в ячейке профиля. */
export const reloadProfileSchema = z.object({
  profile: profileArg,
});

/** 6. reload_all — без аргументов. */
export const reloadAllSchema = z.object({});

/** 7. open_devtools — DevTools профиля в отдельном окне. */
export const openDevtoolsSchema = z.object({
  profile: profileArg,
});

/** 8. reorder_profile — переставить профиль в другую ячейку. */
export const reorderProfileSchema = z.object({
  profile: profileArg,
  cell: z
    .number()
    .int()
    .min(1)
    .max(12)
    .describe('Номер целевой ячейки, начиная с 1 (верхний левый угол — 1)'),
});

/** 9. toggle_input_sync — включить/выключить синхронизатор действий. */
export const toggleInputSyncSchema = z.object({
  enabled: z.boolean().describe('true — включить, false — выключить'),
});

/** 10. rotate_proxy_ip — сменить IP мобильного прокси сейчас. */
export const rotateProxyIpSchema = z.object({
  profile: profileArg,
});

/**
 * 11. log_tail — хвост журнала (кольцевой буфер 300 записей).
 * Этап 3: фильтр по профилю (profileName резолвится через resolve.ts →
 * тег [id] в строках журнала) + построчный кламп 150 символов
 * (30 × 150 = 4,5 КБ — с запасом под общий лимит результата 8 КБ;
 * глобальный кламп реестра остаётся страховкой для других тулов).
 */
export const logTailSchema = z.object({
  profileName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .optional()
    .describe('Имя или id профиля («active» = выделенная ячейка); не задан — общий журнал'),
  lines: z
    .number()
    .int()
    .min(5)
    .max(50)
    .default(30)
    .describe('Сколько последних записей показать (по умолчанию 30, максимум 50)'),
  level: z
    .enum(['all', 'info', 'warn', 'error'])
    .default('all')
    .describe('Фильтр по уровню; «all» — все'),
});

/** 12. app_info — без аргументов. */
export const appInfoSchema = z.object({});

/** 13. search_faq — поиск по документации проекта. */
export const searchFaqSchema = z.object({
  query: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .describe('Что искать в README/BACKLOG/ROADMAP/docs — обычными словами'),
});

/**
 * Zod-схема → параметры тулa для /api/chat.
 *
 * Поля с default модель может не передавать — z.toJSONSchema кладёт их в
 * required (output-io), поэтому убираем из required; $schema модели не нужен.
 */
export function toJsonSchemaForModel(
  schema: z.ZodObject<Record<string, z.ZodType>>,
): ToolParameters {
  const js = z.toJSONSchema(schema) as unknown as ToolParameters;
  if (Array.isArray(js.required) && js.properties) {
    const req = js.required.filter((k) => js.properties?.[k]?.default === undefined);
    if (req.length === 0) delete js.required;
    else js.required = req;
  }
  delete js.$schema;
  return js;
}

/** Форма параметров тулa в /api/chat (подмножество JSON Schema). */
export interface ToolParameters {
  $schema?: string;
  type: string;
  properties?: Record<string, { default?: unknown; enum?: unknown[]; type?: string }>;
  required?: string[];
  [key: string]: unknown;
}
