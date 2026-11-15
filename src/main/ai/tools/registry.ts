/**
 * Реестр тулов ассистента (P4, этап 2) — docs/assistant-stage0.md, №1–13.
 *
 * Каждый тул — обёртка над СУЩЕСТВУЮЩИМ методом ProfileManager/Logger:
 * ноль новых привилегий в main, ноль новых IPC-каналов. Аргументы
 * валидируются Zod-схемами (schemas.ts); для LLM JSON Schema генерируется
 * из тех же схем (z.toJSONSchema) — источник истины один.
 *
 * Zero-Trust (правила этапа 0, неизменны):
 *   - модель передаёт имя/id профиля строкой, id подставляет main
 *     (resolve.ts); промах → «профиль не найден» без деталей;
 *   - ответ модели-facing — компактный текст ≤ 8 КБ (clamp): без него
 *     ассистент захлёбывается контекстом и галлюцинирует;
 *   - profile_details отдаёт хост прокси, но НЕ креды; config.json
 *     целиком, cookies/пароли/ключи — не существуют для тулов;
 *   - UI получает карточку (title + ≤ 6 коротких строк), не JSON.
 *
 * Тулы «меняющие состояние» помечены mutating: системный промпт обязывает
 * модель сначала объявить действие словами, rotate_proxy_ip — отдельное
 * правило 10 (предупредить о возможном разлогине и ждать согласия).
 */
import type { Tool } from 'ollama';
import { z } from 'zod';
import type { ProfileManager } from '../../profileManager';
import type { Logger } from '../../logger';
import { LAYOUTS, LayoutId, ProfileState } from '../../types';
import { resolveProfileArg } from './resolve';
import { searchFaq } from './searchFaq';
import { toJsonSchemaForModel } from './schemas';
import {
  appInfoSchema,
  gridInfoSchema,
  listProfilesSchema,
  logTailSchema,
  openDevtoolsSchema,
  profileDetailsSchema,
  reloadAllSchema,
  reloadProfileSchema,
  reorderProfileSchema,
  rotateProxyIpSchema,
  searchFaqSchema,
  setLayoutSchema,
  toggleInputSyncSchema,
} from './schemas';

/** Лимит текста тула для модели (ТЗ: 4–8 КБ). */
const RESULT_MAX = 8000;
/** Строк в тексте list_profiles до пометки «…и ещё». */
const LIST_MAX_LINES = 20;
/** Таймаут исполнения тула (rotate_proxy_ip ходит в сеть — 20 с внутри + запас). */
const TOOL_EXEC_TIMEOUT_MS = 30_000;
/** Карточка — не простыня: максимум строк в UI. */
const CARD_LINES_MAX = 6;

/** Что получает исполнитель тула (собирает index.ts). */
export interface ToolContext {
  manager: ProfileManager;
  log: Logger;
  /** Выделенная ячейка = активный профиль (развилка 4A этапа 0). */
  activeProfileId: () => string | null;
  /** Версии для app_info. */
  versions: () => { app: string; electron: string; chromium: string; platform: string };
}

/** Результат тула: текст для модели + карточка для UI. */
export interface ToolResult {
  ok: boolean;
  /** Текст для модели (компактный, ≤ 8 КБ). */
  text: string;
  /** Заголовок карточки в чате. */
  title: string;
  /** Строки карточки (≤ 6). */
  lines: string[];
}

interface ToolDef {
  name: string;
  /** Одна строка описания — и модели, и системному промпту. */
  description: string;
  schema: z.ZodObject<Record<string, z.ZodType>>;
  /** Меняет состояние Brouser → модель обязана сначала объявить словами. */
  mutating?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

/** Zod-схема → параметры тула для /api/chat: toJsonSchemaForModel (schemas.ts) — источник истины один. */

/** Обрезать текст тула до лимита (ТЗ: ассистент не должен захлёбываться). */
function clamp(text: string): string {
  const t = (text ?? '').trim();
  return t.length > RESULT_MAX ? `${t.slice(0, RESULT_MAX)}\n…(обрезано: лимит ${RESULT_MAX} символов)` : t;
}

/** Hostname URL или сам URL, если не парсится. */
function shortHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.length > 40 ? `${url.slice(0, 40)}…` : url;
  }
}

/** Время записи журнала «HH:MM:SS». */
function hhmmss(time: number): string {
  const d = new Date(time);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Отказ после неудачного разрешения профиля. */
function profileMiss(name: string, reason: string): ToolResult {
  return { ok: false, text: reason, title: name, lines: [reason] };
}

/** Профили в минимальной форме для resolve. */
function resolvable(ctx: ToolContext): { id: string; name: string }[] {
  return ctx.manager.getState().profiles.map((p) => ({ id: p.id, name: p.name }));
}

/** Сводка профиля одной строкой для list_profiles. */
function profileLine(p: ProfileState, index: number): string {
  const bits = [`${index}. ${p.name}`, shortHost(p.url)];
  bits.push(p.hasProxy ? `прокси:${p.proxyScheme ?? '?'}` : 'без прокси');
  bits.push(p.visible ? 'в ячейке' : 'в фоне');
  if (p.timezone) bits.push(`tz:${p.timezone}`);
  if (p.userAgentSet) bits.push('UA свой');
  if (p.extensions.length > 0) {
    bits.push(`расширений ${p.extensions.filter((e) => e.ok).length}/${p.extensions.length}`);
  }
  return bits.join(' · ');
}

/** Определения тулов (регистрация). */
function buildDefs(): ToolDef[] {
  return [
    {
      name: 'list_profiles',
      description:
        'Список профилей: имя, URL, видимость (ячейка/фон), флаги прокси/UA/таймзоны, число расширений и их статус',
      schema: listProfilesSchema,
      run: (_args, ctx) => {
        const st = ctx.manager.getState();
        const head = `профилей: ${st.profiles.length} (видимых: ${st.profiles.filter((p) => p.visible).length}, раскладка ${st.layout})`;
        const lines = st.profiles.slice(0, LIST_MAX_LINES).map(profileLine);
        if (st.profiles.length > LIST_MAX_LINES) lines.push(`…и ещё ${st.profiles.length - LIST_MAX_LINES}`);
        return {
          ok: true,
          text: clamp([head, ...lines].join('\n')),
          title: `Профили: ${st.profiles.length}`,
          lines: st.profiles.slice(0, CARD_LINES_MAX).map((p) => `${p.name}${p.hasProxy ? ' · прокси' : ''}${p.visible ? '' : ' · фон'}`),
        };
      },
    },
    {
      name: 'profile_details',
      description:
        'Сводка одного профиля: расширения со статусами, локаль/таймзона/seed/платформа, ротация прокси (интервал, есть ли URL) — без учётных данных',
      schema: profileDetailsSchema,
      run: (args, ctx) => {
        const st = ctx.manager.getState();
        const res = resolveProfileArg(args.profile, resolvable(ctx), ctx.activeProfileId());
        if (!res.ok) return profileMiss('profile_details', res.reason);
        const p = st.profiles.find((x) => x.id === res.profile.id);
        if (!p) return profileMiss('profile_details', 'профиль не найден');
        const lines = [
          `имя: ${p.name} (id=${p.id})`,
          `url: ${p.url}`,
          p.hasProxy
            ? `прокси: ${p.proxyScheme ?? '?'}://${p.proxyHost ?? '?'} (креды не показываются)`
            : 'прокси: нет (прямое соединение)',
          p.proxyRotation
            ? `ротация IP: каждые ${p.proxyRotation.intervalMin} мин${p.proxyRotation.hasUrl ? ' + URL провайдера' : ', URL не задан'}`
            : 'ротация IP: не настроена',
        ];
        if (p.extensions.length > 0) {
          lines.push(
            `расширения (${p.extensions.length}): ` +
              p.extensions
                .map((e) => {
                  const status = e.ok ? 'загружено' : `ошибка${e.error ? `: ${e.error}` : ''}`;
                  return `${e.name ?? shortHost(e.source)} — ${status}`;
                })
                .join('; '),
          );
        } else {
          lines.push('расширения: нет');
        }
        lines.push(
          `таймзона: ${p.timezone ?? 'системная'}; локаль: ${p.locale ?? 'авто'}; платформа: ${p.platform ?? 'нативная'}; ` +
            `UA: ${p.userAgentSet ? 'свой' : 'дефолтный'}; ядер: ${p.hardwareConcurrency ?? 'авто'}; seed: ${p.fingerprintSeed ?? 'авто (из id)'}`,
        );
        lines.push(p.visible ? 'видимость: в ячейке' : 'видимость: в фоне (паркован)');
        return {
          ok: true,
          text: clamp(lines.join('\n')),
          title: p.name,
          lines: lines.slice(0, CARD_LINES_MAX).map((l) => l.replace(/\n/g, ' ')),
        };
      },
    },
    {
      name: 'grid_info',
      description: 'Текущая раскладка сетки, число ячеек, счётчики профилей/видимых, состояние синхронизатора действий',
      schema: gridInfoSchema,
      run: (_args, ctx) => {
        const st = ctx.manager.getState();
        const info = LAYOUTS[st.layout];
        const text = [
          `раскладка: ${st.layout} (${info.rows}x${info.cols}, ячеек ${info.cells})`,
          `профилей: ${st.profiles.length}, видимых: ${st.profiles.filter((p) => p.visible).length}`,
          `синхронизатор действий: ${st.inputSync ? 'включён' : 'выключен'}`,
        ].join('\n');
        return { ok: true, text, title: `Сетка ${st.layout}`, lines: [text.replace(/\n/g, ' · ')] };
      },
    },
    {
      name: 'set_layout',
      description: 'Сменить раскладку сетки (1x1, 1x2, 2x1, 2x2, 3x1, 1x3); представления переносятся без пересоздания',
      schema: setLayoutSchema,
      mutating: true,
      run: (args, ctx) => {
        const layout = args.layout as LayoutId;
        const before = ctx.manager.getState().layout;
        const res = ctx.manager.setLayout(layout);
        const info = LAYOUTS[layout];
        if (!res.ok) return { ok: false, text: res.error ?? 'не удалось сменить раскладку', title: 'Раскладка', lines: [res.error ?? 'ошибка'] };
        const text =
          before === layout
            ? `раскладка уже ${layout} (${info.cells} ячеек) — ничего менять не пришлось`
            : `раскладка изменена: ${before} → ${layout} (${info.cells} ячеек); представления перенесены без пересоздания, сессии сохранены`;
        return { ok: true, text, title: `Раскладка ${before} → ${layout}`, lines: [text] };
      },
    },
    {
      name: 'reload_profile',
      description: 'Перезагрузить страницу в ячейке одного профиля (сессия сохраняется)',
      schema: reloadProfileSchema,
      mutating: true,
      run: (args, ctx) => {
        const res = resolveProfileArg(args.profile, resolvable(ctx), ctx.activeProfileId());
        if (!res.ok) return profileMiss('reload_profile', res.reason);
        const st = ctx.manager.getState();
        const p = st.profiles.find((x) => x.id === res.profile.id);
        if (p && !p.visible) {
          const reason = 'профиль в фоне (нет ячейки) — сначала увеличьте раскладку или переставьте его';
          return { ok: false, text: reason, title: res.profile.name, lines: [reason] };
        }
        ctx.manager.reloadView(res.profile.id);
        return {
          ok: true,
          text: `страница профиля ${res.profile.name} перезагружена (сессия и логин сохраняются)`,
          title: `${res.profile.name} — перезагружен`,
          lines: ['Страница в ячейке перезагружена'],
        };
      },
    },
    {
      name: 'reload_all',
      description: 'Перезагрузить страницы во всех видимых ячейках',
      schema: reloadAllSchema,
      mutating: true,
      run: (_args, ctx) => {
        ctx.manager.reloadAll();
        return { ok: true, text: 'все видимые ячейки перезагружены', title: 'Все ячейки перезагружены', lines: ['Сессии сохранены'] };
      },
    },
    {
      name: 'open_devtools',
      description: 'Открыть DevTools профиля в отдельном окне (эмуляция временно приостанавливается)',
      schema: openDevtoolsSchema,
      mutating: true,
      run: (args, ctx) => {
        const res = resolveProfileArg(args.profile, resolvable(ctx), ctx.activeProfileId());
        if (!res.ok) return profileMiss('open_devtools', res.reason);
        const st = ctx.manager.getState();
        const p = st.profiles.find((x) => x.id === res.profile.id);
        if (p && !p.visible) {
          const reason = 'профиль в фоне (нет живой ячейки) — DevTools нечего показывать';
          return { ok: false, text: reason, title: res.profile.name, lines: [reason] };
        }
        ctx.manager.openDevTools(res.profile.id);
        return {
          ok: true,
          text: `DevTools профиля ${res.profile.name} открыт в отдельном окне; CDP-эмуляция вернётся после его закрытия`,
          title: `DevTools: ${res.profile.name}`,
          lines: ['Отдельное окно'],
        };
      },
    },
    {
      name: 'reorder_profile',
      description: 'Переставить профиль в другую ячейку (механика drag-and-drop: сдвиг в порядке профилей, представления переносятся)',
      schema: reorderProfileSchema,
      mutating: true,
      run: async (args, ctx) => {
        const res = resolveProfileArg(args.profile, resolvable(ctx), ctx.activeProfileId());
        if (!res.ok) return profileMiss('reorder_profile', res.reason);
        const st = ctx.manager.getState();
        const cell = Number(args.cell ?? 1);
        if (cell > st.profiles.length) {
          const reason = `ячеек с профилями всего ${st.profiles.length} — укажите номер от 1 до ${st.profiles.length}`;
          return { ok: false, text: reason, title: res.profile.name, lines: [reason] };
        }
        const from = st.profiles.findIndex((p) => p.id === res.profile.id);
        const r = await ctx.manager.reorderProfiles(res.profile.id, cell - 1);
        if (!r.ok) return { ok: false, text: r.error ?? 'не удалось переставить', title: res.profile.name, lines: [r.error ?? 'ошибка'] };
        const text =
          from === cell - 1
            ? `профиль ${res.profile.name} уже в ячейке ${cell}`
            : `профиль ${res.profile.name} переставлен в ячейку ${cell} (был ${from + 1}); представления перенесены без пересоздания`;
        return { ok: true, text, title: `${res.profile.name} → ячейка ${cell}`, lines: [text] };
      },
    },
    {
      name: 'toggle_input_sync',
      description: 'Включить/выключить синхронизатор действий — реплей кликов и ввода между видимыми ячейками',
      schema: toggleInputSyncSchema,
      mutating: true,
      run: async (args, ctx) => {
        const enabled = !!args.enabled;
        const r = await ctx.manager.setInputSync(enabled);
        if (!r.ok) return { ok: false, text: r.error ?? 'не удалось переключить', title: 'Синхронизатор', lines: [r.error ?? 'ошибка'] };
        return {
          ok: true,
          text: `синхронизатор действий ${enabled ? 'включён' : 'выключен'}${enabled ? ' — ввод replayится во все видимые ячейки' : ''}`,
          title: `Синхронизатор: ${enabled ? 'вкл' : 'выкл'}`,
          lines: [enabled ? 'Ввод повторяется во всех видимых ячейках' : 'Ввод только в активной ячейке'],
        };
      },
    },
    {
      name: 'rotate_proxy_ip',
      description:
        'Сменить IP мобильного прокси профиля сейчас: rotationUrl провайдера + переподключение сессии (гео не трогается). Требует явного согласия пользователя — см. правило 10',
      schema: rotateProxyIpSchema,
      mutating: true,
      run: async (args, ctx) => {
        const res = resolveProfileArg(args.profile, resolvable(ctx), ctx.activeProfileId());
        if (!res.ok) return profileMiss('rotate_proxy_ip', res.reason);
        const st = ctx.manager.getState();
        const p = st.profiles.find((x) => x.id === res.profile.id);
        if (p && !p.hasProxy) {
          const reason = 'у профиля нет прокси — ротация не имеет смысла';
          return { ok: false, text: reason, title: res.profile.name, lines: [reason] };
        }
        const r = await ctx.manager.rotateProxyNow(res.profile.id);
        if (!r.ok) return { ok: false, text: r.error ?? 'ротация не удалась', title: res.profile.name, lines: [r.error ?? 'ошибка'] };
        return {
          ok: true,
          text: `IP профиля ${res.profile.name} сменён: провайдер опрошен, сессия переподключена к прокси (гео-эмуляция не трогалась); при плановой ротации таймер перезапущен`,
          title: `IP сменён: ${res.profile.name}`,
          lines: ['Сессия переподключена', 'Гео сохранено'],
        };
      },
    },
    {
      name: 'log_tail',
      description: 'Хвост журнала Brouser: последние ≤ 50 записей с уровнями info/warn/error, фильтр по уровню',
      schema: logTailSchema,
      run: (args, ctx) => {
        const limit = Number(args.limit ?? 20);
        const level = (args.level ?? 'all') as 'all' | 'info' | 'warn' | 'error';
        const all = ctx.log.getRecent(300);
        const filtered = level === 'all' ? all : all.filter((e) => e.level === level);
        const take = filtered.slice(-limit);
        if (take.length === 0) {
          return { ok: true, text: 'журнал пуст (по этому фильтру записей нет)', title: 'Журнал: пусто', lines: [] };
        }
        const counts = { info: 0, warn: 0, error: 0 } as Record<string, number>;
        for (const e of take) counts[e.level] = (counts[e.level] ?? 0) + 1;
        const header = `последние ${take.length} записей (info ${counts.info}, warn ${counts.warn}, error ${counts.error}):`;
        const body = take.map((e) => `[${hhmmss(e.time)}] ${e.level.toUpperCase().padEnd(5)} ${e.message.slice(0, 200)}`);
        return {
          ok: true,
          text: clamp([header, ...body].join('\n')),
          title: `Журнал: ${take.length} записей`,
          lines: body.slice(-3),
        };
      },
    },
    {
      name: 'app_info',
      description: 'Версии Brouser/Electron/Chromium, платформа ОС, число профилей — для вопросов «какая версия / почему не работает»',
      schema: appInfoSchema,
      run: (_args, ctx) => {
        const v = ctx.versions();
        const st = ctx.manager.getState();
        const text = [
          `Brouser: v${v.app}`,
          `Electron: ${v.electron} (Chromium ${v.chromium})`,
          `платформа: ${v.platform}`,
          `профилей: ${st.profiles.length}, раскладка ${st.layout}`,
        ].join('\n');
        return { ok: true, text, title: `Brouser v${v.app}`, lines: [`Electron ${v.electron}`, v.platform] };
      },
    },
    {
      name: 'search_faq',
      description: 'Поиск по документации проекта (README/BACKLOG/ROADMAP/docs) — вопросы «как работает фингерпринт», «как настроить ротацию»',
      schema: searchFaqSchema,
      run: (args) => {
        const { hits, files } = searchFaq(String(args.query ?? ''));
        if (hits.length === 0) {
          const text = `ничего не найдено по запросу; доступные документы: ${files.join(', ')}`;
          return { ok: true, text, title: 'FAQ: не найдено', lines: files.slice(0, CARD_LINES_MAX) };
        }
        const text = hits.map((h) => `[${h.ref}]\n${h.excerpt}`).join('\n\n');
        return {
          ok: true,
          text: clamp(text),
          title: `FAQ: ${hits.length} ${hits.length === 1 ? 'раздел' : 'раздела'}`,
          lines: hits.map((h) => h.ref),
        };
      },
    },
  ];
}

/** Promise с таймаутом: тул обязан уложиться в TOOL_EXEC_TIMEOUT_MS. */
async function withTimeout(p: Promise<ToolResult>, name: string): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, text: `тул ${name} не уложился в ${TOOL_EXEC_TIMEOUT_MS / 1000} с`, title: name, lines: ['таймаут'] }),
      TOOL_EXEC_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Короткая сводка ошибки Zod для модели. */
function zodError(err: unknown): string {
  if (err instanceof z.ZodError) {
    const parts = err.issues.slice(0, 4).map((i) => `${(i.path ?? []).join('.') || 'аргументы'}: ${i.message}`);
    return `аргументы не прошли схему — ${parts.join('; ')}`;
  }
  return `аргументы не прошли схему (${err instanceof Error ? err.message : String(err)})`;
}

export class ToolRegistry {
  private defs: ToolDef[];

  constructor(private ctx: ToolContext) {
    this.defs = buildDefs();
  }

  /** Определения для /api/chat (tools). */
  definitions(): Tool[] {
    return this.defs.map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: `${d.description}${d.mutating ? ' [меняет состояние Brouser]' : ''}`,
        parameters: toJsonSchemaForModel(d.schema),
      },
    }));
  }

  /** Строки для системного промпта: «name — описание (+ пометка)». */
  promptLines(): string[] {
    return this.defs.map((d) => {
      const note = d.name === 'rotate_proxy_ip' ? ' [меняет состояние — правило 10]' : d.mutating ? ' [меняет состояние]' : '';
      return `- ${d.name} — ${d.description}${note}`;
    });
  }

  has(name: string): boolean {
    return this.defs.some((d) => d.name === name);
  }

  /**
   * Исполнить тул: валидация Zod → обёртка над существующим методом →
   * лимит размера. Ошибки не роняют приложение — становятся {ok:false}.
   */
  async execute(name: string, rawArgs: unknown): Promise<ToolResult> {
    const def = this.defs.find((d) => d.name === name);
    if (!def) {
      // Неизвестное имя (галлюцинация модели) — честный отказ, без попыток угадать.
      return { ok: false, text: `тула «${name}» не существует`, title: name, lines: ['тул не существует'] };
    }
    let args: Record<string, unknown>;
    try {
      args = def.schema.parse(rawArgs ?? {}) as Record<string, unknown>;
    } catch (err) {
      this.ctx.log.warn(`[assistant] тул ${name}: ${zodError(err)}`);
      return { ok: false, text: zodError(err), title: name, lines: [zodError(err)] };
    }
    try {
      const res = await withTimeout(Promise.resolve(def.run(args, this.ctx)), name);
      this.ctx.log.info(`[assistant] тул ${name}: ${res.ok ? 'готово' : 'отказ'}`);
      return { ...res, text: clamp(res.text), lines: res.lines.slice(0, CARD_LINES_MAX) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.log.error(`[assistant] тул ${name} упал: ${msg}`);
      return { ok: false, text: `ошибка исполнения: ${msg}`, title: name, lines: [`ошибка: ${msg}`] };
    }
  }
}
