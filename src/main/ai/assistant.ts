/**
 * AssistantService — AI-ассистент Brouser (P4: этап 1 + этап 2).
 *
 * Zero-Trust к LLM: сервис живёт в main, НО не даёт модели ничего, кроме
 * текста промпта и контекста-снимка (system-prompt.ts) + тулов реестра
 * (tools/registry.ts — обёртки над существующими методами ProfileManager/
 * Logger). Никаких session, webContents, fs, profileManager модели.
 *
 * Провайдеры (пакет `ollama`, /api/chat со стримом NDJSON):
 *   - Ollama Cloud: endpoint и модель из assistant-config.json,
 *     Authorization: Bearer <ключ> (ключ — safeStorage, в логи не попадает);
 *   - локальный Ollama: http://localhost:11434, без ключа.
 * Режимы: auto (Cloud → Local), cloud, local.
 *
 * Этап 2 — агентский цикл с тулами (двухшаговый по ТЗ):
 *   модель → tool_calls → исполнение тулов (карточки в UI) → результаты
 *   обратно модели → финальный текстовый ответ (или ещё тулы; раундов ≤ 4,
 *   последний — без тулов, чтобы гарантировать текстовый финал).
 *   Fallback-парсер: облачные Ollama периодически кладут tool call сырым
 *   JSON в content вместо tool_calls — парсим и исполняем как тул, пузырь
 *   перезапускается без JSON ([assistant] fallback-parser в журнале).
 *   История хранит только текст: объявления и ответы модели; тул-ходы
 *   живут в локальном контексте одного сообщения пользователя.
 *
 * Отказоустойчивость (этап 1, без изменений): таймаут 30 с на соединение/
 * первый токен, 90 с бездействие между токенами, 1 ретрай на провайдера,
 * затем (в auto) — следующий провайдер; полный провал — сообщение в UI,
 * приложение не падает. История — в памяти, последние 16 сообщений.
 */
import { app, BrowserWindow } from 'electron';
import { Ollama } from 'ollama';
import type { Message as OllamaMessage, Tool, ToolCall } from 'ollama';
import { AssistantConfigService } from './assistantConfig';
import { buildSystemPrompt, SystemPromptContext } from './system-prompt';
import { ToolRegistry } from './tools/registry';
import { parseToolCallsFromContent } from './tools/fallbackParse';
import { Logger } from '../logger';
import {
  AppState,
  AssistantChunkEvent,
  AssistantMessage,
  AssistantStatus,
  AssistantToolEvent,
  CommandResult,
} from '../types';

/** Лимиты этапа 1 (ТЗ). */
const MAX_MESSAGE_LEN = 4000;
const MAX_HISTORY_MESSAGES = 16;
/** Таймаут на соединение + первый токен (ТЗ: 30 с). */
const FIRST_TOKEN_TIMEOUT_MS = 30_000;
/** Таймаут между токенами стрима (cloud бывает медленным на длинных ответах). */
const IDLE_TIMEOUT_MS = 90_000;
/** 1 ретрай = 2 попытки на провайдера. */
const ATTEMPTS_PER_PROVIDER = 2;
/** Таймаут проверки доступности для индикатора. */
const PROBE_TIMEOUT_MS = 2500;

/** Агентские лимиты этапа 2: раундов тул-цикла (последний — только текст). */
const MAX_TOOL_ROUNDS = 4;
/** Тул-вызовов в одном раунде (модели шлют 1–2, защита от зацикливания). */
const MAX_TOOL_CALLS_PER_ROUND = 4;
/** Общий бюджет тул-исполнений на одно сообщение пользователя. */
const TOOL_CALLS_BUDGET = 8;

type Provider = 'cloud' | 'local';

/** Итог агентского хода: только текст (тул-ходы в историю не пишутся). */
interface AgentTurnResult {
  text: string;
  aborted: boolean;
  provider: Provider;
  model: string;
}

/** Один раунд общения с моделью (возможно, с тулами). */
interface RoundResult {
  text: string;
  aborted: boolean;
  toolCalls: ToolCall[];
  provider: Provider;
  model: string;
}

interface AssistantDeps {
  log: Logger;
  config: AssistantConfigService;
  /** Главное окно — приёмник событий стрима. */
  getWindow: () => BrowserWindow | null;
  /** Снимок состояния для системного промпта (main подставляет сам). */
  buildContext: () => { state: AppState; activeProfileId: string | null };
  /** Реестр тулов (P4/этап 2): исполнение и определения для модели. */
  tools: ToolRegistry;
}

export class AssistantService {
  /** История диалога в памяти (не персистируется по умолчанию). */
  private history: AssistantMessage[] = [];
  private busy = false;
  /** Пользователь нажал «Стоп». */
  private abortRequested = false;
  /** Таймаут сработал (отличие от пользовательского стопа). */
  private timeoutFired = false;
  /** В текущем ходе уже отправлялись куски ответа (для restart-пузыря). */
  private turnSawChunks = false;
  /** Текущий in-flight стрим — чем прервать. */
  private activeAbort: (() => void) | null = null;

  constructor(private deps: AssistantDeps) {}

  // ------------------------------------------------------------------
  // Публичное API (IPC: assistant:*)
  // ------------------------------------------------------------------

  /**
   * Принять сообщение пользователя. {ok:false} — только валидация/занятость;
   * сам ответ приходит событиями assistant:chunk / assistant:tool /
   * assistant:restart / assistant:done / assistant:error.
   */
  async send(text: string): Promise<CommandResult> {
    const msg = (text ?? '').trim();
    if (!msg) return { ok: false, error: 'Пустое сообщение' };
    if (msg.length > MAX_MESSAGE_LEN) {
      return { ok: false, error: `Сообщение длиннее ${MAX_MESSAGE_LEN} символов — сократите его` };
    }
    if (this.busy) {
      return { ok: false, error: 'Ассистент ещё отвечает — дождитесь ответа или нажмите «Стоп»' };
    }
    this.busy = true;
    this.abortRequested = false;
    this.timeoutFired = false;
    this.turnSawChunks = false;
    // В логах — только длина сообщения, не содержимое (приватность ТЗ).
    this.deps.log.info(`[assistant] chat started (len=${msg.length})`);

    const userMsg: AssistantMessage = { role: 'user', content: msg };
    this.history.push(userMsg);
    try {
      const res = await this.runAgentTurn();
      if (res.text) {
        this.history.push({ role: 'assistant', content: res.text });
      } else {
        // Пустой ответ (в т.ч. стоп до первого токена) — откатываем ход,
        // чтобы повторная отправка не тащила «висящий» user-текст.
        this.history = this.history.filter((m) => m !== userMsg);
      }
      this.trimHistory();
      this.emit('assistant:done', { aborted: res.aborted, provider: res.provider, model: res.model });
      this.deps.log.info(
        `[assistant] ответ готов: провайдер=${res.provider}, модель=${res.model}, символов=${res.text.length}` +
          (res.aborted ? ' (остановлено пользователем)' : ''),
      );
    } catch (err) {
      this.history = this.history.filter((m) => m !== userMsg);
      const message = err instanceof Error ? err.message : String(err);
      this.emit('assistant:error', { message });
      this.deps.log.error(`[assistant] llm error: ${shortError(err)}`);
    } finally {
      this.busy = false;
      this.abortRequested = false;
      this.timeoutFired = false;
      this.activeAbort = null;
    }
    return { ok: true };
  }

  /** «Стоп»: прервать текущий ответ (частичный текст остаётся в чате). */
  abort(): void {
    if (!this.busy) return;
    this.abortRequested = true;
    this.deps.log.info('[assistant] ответ остановлен пользователем');
    try {
      this.activeAbort?.();
    } catch {
      /* ignore */
    }
  }

  /** «Очистить историю»: история живёт только в памяти main. */
  clear(): void {
    this.history = [];
    this.deps.log.info('[assistant] история чата очищена');
  }

  /** Занят ли ассистент (для UI). */
  isBusy(): boolean {
    return this.busy;
  }

  /**
   * Проверка доступности для индикатора «Cloud / Local / Недоступен».
   * Дешёвая: GET /api/tags с коротким таймаутом; ключ на cloud-проверку
   * подставляется, но в ответ/лог не попадает.
   */
  async probe(): Promise<AssistantStatus> {
    const cfg = this.deps.config.view();
    const key = this.deps.config.getApiKey();

    if (cfg.mode === 'cloud' && !key.key) {
      return {
        ok: false,
        provider: 'none',
        label: 'Недоступен',
        detail: 'Не задан API-ключ Ollama Cloud — «Настройки → AI-ассистент»',
        mode: cfg.mode,
        hasKey: false,
      };
    }

    const targets: Provider[] =
      cfg.mode === 'cloud'
        ? ['cloud']
        : cfg.mode === 'local'
          ? ['local']
          : key.key
            ? ['cloud', 'local']
            : ['local'];

    let lastDetail = '';
    for (const provider of targets) {
      const ep = provider === 'cloud' ? cfg.cloud : cfg.local;
      const headers: Record<string, string> =
        provider === 'cloud' && key.key ? { Authorization: `Bearer ${key.key}` } : {};
      const res = await probeEndpoint(ep.endpoint, headers);
      if (res.ok) {
        const label = provider === 'cloud' ? 'Cloud' : 'Local';
        return { ok: true, provider, label, detail: res.detail, mode: cfg.mode, hasKey: !!key.key };
      }
      lastDetail = res.detail ?? '';
    }
    return {
      ok: false,
      provider: 'none',
      label: 'Недоступен',
      detail: lastDetail || 'нет соединения',
      mode: cfg.mode,
      hasKey: !!key.key,
    };
  }

  // ------------------------------------------------------------------
  // Внутреннее: агентский цикл (этап 2)
  // ------------------------------------------------------------------

  /**
   * Двухшаговый цикл по ТЗ: модель → tool_calls → исполнение тулов →
   * результаты обратно модели → финальный ответ. Раунды ограничены; последний
   * идёт без тулов, чтобы цикл гарантированно закончился текстом. История
   * хранит только текст — тул-ходы живут в локальном messages этого хода.
   */
  private async runAgentTurn(): Promise<AgentTurnResult> {
    // Локальный контекст хода: системный промпт + хвост истории + тул-ходы.
    const messages: OllamaMessage[] = this.buildMessages();
    let spent = 0;
    let lastProvider: Provider = 'local';
    let lastModel = '';

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      const budgetLeft = TOOL_CALLS_BUDGET - spent;
      const useTools = round < MAX_TOOL_ROUNDS && budgetLeft > 0;
      const tools = useTools ? this.deps.tools.definitions() : undefined;

      let res = await this.runTurn(messages, tools);
      lastProvider = res.provider;
      lastModel = res.model;

      // Fallback-парсер (этап 2): облачные Ollama периодически кладут
      // tool call сырым JSON в content вместо tool_calls. Исполняем как тул,
      // а пузырь в UI перезапускается с чистым текстом (без JSON).
      if (useTools && res.toolCalls.length === 0 && !res.aborted && res.text) {
        const fb = parseToolCallsFromContent(res.text);
        if (fb) {
          for (const c of fb.calls) {
            this.deps.log.info(`[assistant] fallback-parser: parsed tool from content, name=${c.name}`);
          }
          this.emit('assistant:restart', { provider: res.provider });
          if (fb.cleaned) {
            this.emit('assistant:chunk', { delta: fb.cleaned, provider: res.provider } satisfies AssistantChunkEvent);
          }
          res = {
            ...res,
            text: fb.cleaned,
            toolCalls: fb.calls.map((c) => ({ function: { name: c.name, arguments: c.args } })),
          };
        }
      }

      // Нет тул-вызовов — это финальный текстовый ответ.
      if (res.toolCalls.length === 0) {
        return { text: res.text, aborted: res.aborted, provider: res.provider, model: res.model };
      }

      // Шаг «assistant объявляет + вызывает тулы» → в контекст хода.
      messages.push({ role: 'assistant', content: res.text, tool_calls: res.toolCalls });

      const calls = res.toolCalls.slice(0, Math.min(MAX_TOOL_CALLS_PER_ROUND, TOOL_CALLS_BUDGET - spent));
      for (const call of calls) {
        if (this.abortRequested) {
          // Стоп во время тулов: частичный (объявляющий) текст остаётся в чате.
          return { text: res.text, aborted: true, provider: res.provider, model: res.model };
        }
        spent++;
        const name = call.function?.name ?? '';
        const result = await this.deps.tools.execute(name, call.function?.arguments ?? {});
        // Карточка тула в чате (компактная, не JSON) — между пузырями ответа.
        this.emit('assistant:tool', {
          name,
          title: result.title,
          lines: result.lines,
          ok: result.ok,
        } satisfies AssistantToolEvent);
        // Результат тула → обратно модели (роль 'tool').
        messages.push({ role: 'tool', content: result.text, tool_name: name });
      }
      // Куда-то вело — модель продолжит (новый раунд) с результатами тулов.
    }

    // Бюджет/раунды исчерпаны — не должно случаться (последний раунд без
    // тулов гарантирует текст), но чутьё: возвращаем то, что накопилось.
    return { text: '', aborted: false, provider: lastProvider, model: lastModel };
  }

  /** Системный промпт (снимок приложения + реестр тулов) + хвост истории. */
  private buildMessages(): OllamaMessage[] {
    const { state, activeProfileId } = this.deps.buildContext();
    const ctx: SystemPromptContext = {
      state,
      activeProfileId,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '?',
      chromiumVersion: process.versions.chrome ?? '?',
      platform: `${process.platform} ${process.arch}`,
      toolLines: this.deps.tools.promptLines(),
    };
    const system = buildSystemPrompt(ctx);
    const tail = this.history.slice(-MAX_HISTORY_MESSAGES);
    return [
      { role: 'system', content: system },
      ...tail.map((m) => ({ role: m.role, content: m.content })),
    ];
  }

  /** Держим историю в пределах лимита сообщений и символов. */
  private trimHistory(): void {
    if (this.history.length > MAX_HISTORY_MESSAGES) {
      this.history = this.history.slice(-MAX_HISTORY_MESSAGES);
    }
    let total = this.history.reduce((sum, m) => sum + m.content.length, 0);
    while (this.history.length > 2 && total > 200_000) {
      const dropped = this.history.shift();
      total -= dropped ? dropped.content.length : 0;
    }
  }

  /** Цепочка провайдеров по режиму; в каждом — до ATTEMPTS_PER_PROVIDER попыток. */
  private async runTurn(messages: OllamaMessage[], tools?: Tool[]): Promise<RoundResult> {
    const cfg = this.deps.config.view();
    const key = this.deps.config.getApiKey();
    const chain: Provider[] =
      cfg.mode === 'cloud'
        ? ['cloud']
        : cfg.mode === 'local'
          ? ['local']
          : key.key
            ? ['cloud', 'local']
            : ['local'];

    let lastError = '';

    for (const provider of chain) {
      if (provider === 'cloud' && !key.key) {
        // auto без ключа молча идёт в local; явный режим cloud — ошибка сразу.
        if (chain.length === 1) {
          throw new Error('Не задан API-ключ Ollama Cloud — откройте «Настройки → AI-ассистент» и вставьте ключ');
        }
        continue;
      }
      const { endpoint, model } = provider === 'cloud' ? cfg.cloud : cfg.local;
      for (let attempt = 1; attempt <= ATTEMPTS_PER_PROVIDER; attempt++) {
        try {
          const res = await this.streamOne(provider, endpoint, model, key.key, messages, tools);
          return { ...res, provider, model };
        } catch (err) {
          // Пользовательский стоп — без ретраев и фолбэков.
          if (this.abortRequested && isAbortError(err)) throw err;
          lastError = shortError(err);
          this.deps.log.warn(
            `[assistant] провайдер ${provider} (попытка ${attempt}/${ATTEMPTS_PER_PROVIDER}) не ответил: ${lastError}`,
          );
          // Ретрай/фолбэк после частичного стрима — перезапустить пузырь в UI.
          if (this.turnSawChunks) {
            this.turnSawChunks = false;
            this.emit('assistant:restart', { provider });
          }
        }
      }
    }

    if (cfg.mode === 'local') {
      throw new Error(
        `Локальный Ollama недоступен (${cfg.local.endpoint}, модель ${cfg.local.model}) — запустите «ollama serve» или проверьте «Настройки → AI-ассистент» (${lastError})`,
      );
    }
    const names = chain.map((p) => (p === 'cloud' ? 'Ollama Cloud' : 'локальный Ollama')).join(', затем ');
    throw new Error(`Ассистент временно недоступен — проверьте соединение и настройки (${names}; ${lastError})`);
  }

  /**
   * Один стрим-вызов /api/chat (с тулами, если заданы) с таймаутами: 30 с на
   * первый токен, затем 90 с бездействие. Возвращает текст объявления и
   * собранные tool_calls стрима. Пользовательский «Стоп» возвращает частичный
   * текст; таймаут — бросает ошибку (ретрай/фолбэк на уровне runTurn).
   */
  private async streamOne(
    provider: Provider,
    endpoint: string,
    model: string,
    apiKey: string | null,
    messages: OllamaMessage[],
    tools?: Tool[],
  ): Promise<{ text: string; aborted: boolean; toolCalls: ToolCall[] }> {
    const headers: Record<string, string> =
      provider === 'cloud' && apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const client = new Ollama({ host: endpoint, headers });
    this.timeoutFired = false;
    this.activeAbort = () => {
      try {
        client.abort();
      } catch {
        /* ignore */
      }
    };

    const abortNow = (): void => {
      try {
        client.abort();
      } catch {
        /* ignore */
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        this.timeoutFired = true;
        abortNow();
      }, ms);
    };
    arm(FIRST_TOKEN_TIMEOUT_MS);

    let text = '';
    const toolCalls: ToolCall[] = [];
    try {
      // Установка соединения в ollama-js без fetch-сигнала: гоняем с таймером
      // вручную; проигравший запрос безвредно «повисает» и собирается позже.
      const chatPromise = client.chat({
        model,
        messages,
        stream: true,
        tools,
        options: { temperature: 0.2 },
      });
      const stream = await raceWithTimeout(chatPromise, FIRST_TOKEN_TIMEOUT_MS, () => {
        this.timeoutFired = true;
        abortNow();
      });

      for await (const part of stream) {
        arm(IDLE_TIMEOUT_MS);
        const delta: string = part.message?.content ?? '';
        if (delta) {
          text += delta;
          this.turnSawChunks = true;
          this.emit('assistant:chunk', { delta, provider } satisfies AssistantChunkEvent);
        }
        // Ollama присылает tool_calls готовыми пакетами (обычно в финальном
        // чанке); собираем всё, что появилось в стриме.
        const calls = part.message?.tool_calls;
        if (calls && calls.length > 0) {
          for (const c of calls) toolCalls.push(c);
        }
      }
      return { text, aborted: false, toolCalls };
    } catch (err) {
      if (isAbortError(err)) {
        if (this.abortRequested && !this.timeoutFired) {
          // Стоп по кнопке: частичный текст остаётся в чате.
          return { text, aborted: true, toolCalls };
        }
        // Таймаут (первый токен или бездействие) — ошибка попытки.
        throw new Error('таймаут: модель не ответила вовремя');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.activeAbort = null;
    }
  }

  private emit(channel: string, payload: unknown): void {
    try {
      const win = this.deps.getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    } catch {
      /* окно могло закрыться во время стрима */
    }
  }
}

// ------------------------------------------------------------------
// Утилиты
// ------------------------------------------------------------------

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function shortError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}

/** Promise.race с таймером; проигравший promise гасится, чтобы не стать unhandled. */
function raceWithTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error('таймаут: соединение с моделью'));
    }, ms);
  });
  p.catch(() => {
    /* гасим: результат уже не нужен */
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** GET /api/tags с коротким таймаутом — дешёвая проверка доступности. */
async function probeEndpoint(
  endpoint: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/api/tags`, {
      headers,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `ключ отклонён (HTTP ${res.status})` };
    }
    // Доступен: у cloud /api/tags может не отдавать список — любой HTTP-ответ
    // означает, что endpoint жив и авторизация прошла.
    return { ok: true, detail: res.ok ? null : `HTTP ${res.status} (endpoint отвечает)` };
  } catch (err) {
    return { ok: false, detail: `нет соединения: ${shortError(err)}` };
  }
}
