/**
 * AssistantService — каркас AI-ассистента Brouser (P4, этап 1).
 *
 * Zero-Trust к LLM: сервис живёт в main, НО не даёт модели ничего, кроме
 * текста промпта и контекста-снимка (system-prompt.ts): никаких session,
 * webContents, fs, profileManager. Тулы подключаются на этапе 2 отдельным
 * реестром — сюда они не входят сознательно.
 *
 * Провайдеры (пакет `ollama`, /api/chat со стримом NDJSON):
 *   - Ollama Cloud: endpoint и модель из assistant-config.json,
 *     Authorization: Bearer <ключ> (ключ — safeStorage, в логи не попадает);
 *   - локальный Ollama: http://localhost:11434, без ключа.
 * Режимы: auto (Cloud → Local), cloud, local.
 *
 * Отказоустойчивость по ТЗ этапа 1: таймаут 30 с на соединение/первый токен,
 * 90 с бездействие между токенами, 1 ретрай на провайдера, затем (в auto) —
 * следующий провайдер; полный провал — сообщение в UI, приложение не падает.
 * История — в памяти (не персистится), последние 16 сообщений.
 */
import { app, BrowserWindow } from 'electron';
import { Ollama } from 'ollama';
import type { Message as OllamaMessage } from 'ollama';
import { AssistantConfigService } from './assistantConfig';
import { buildSystemPrompt, SystemPromptContext } from './system-prompt';
import { Logger } from '../logger';
import {
  AppState,
  AssistantChunkEvent,
  AssistantMessage,
  AssistantStatus,
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

type Provider = 'cloud' | 'local';

interface AssistantDeps {
  log: Logger;
  config: AssistantConfigService;
  /** Главное окно — приёмник событий стрима. */
  getWindow: () => BrowserWindow | null;
  /** Снимок состояния для системного промпта (main подставляет сам). */
  buildContext: () => { state: AppState; activeProfileId: string | null };
}

export class AssistantService {
  /** История диалога в памяти (не персистится по умолчанию). */
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
   * сам ответ приходит событиями assistant:chunk / assistant:restart /
   * assistant:done / assistant:error.
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
    const messages = this.buildMessages();
    try {
      const res = await this.runTurn(messages);
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
  // Внутреннее: цикл ответа
  // ------------------------------------------------------------------

  /** Системный промпт (снимок приложения) + хвост истории. */
  private buildMessages(): OllamaMessage[] {
    const { state, activeProfileId } = this.deps.buildContext();
    const ctx: SystemPromptContext = {
      state,
      activeProfileId,
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? '?',
      chromiumVersion: process.versions.chrome ?? '?',
      platform: `${process.platform} ${process.arch}`,
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
  private async runTurn(
    messages: OllamaMessage[],
  ): Promise<{ text: string; aborted: boolean; provider: Provider; model: string }> {
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
          const res = await this.streamOne(provider, endpoint, model, key.key, messages);
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
   * Один стрим-вызов /api/chat с таймаутами: 30 с на первый токен, затем
   * 90 с бездействие. Пользовательский «Стоп» возвращает частичный текст;
   * таймаут — бросает ошибку (ретрай/фолбэк на уровне runTurn).
   */
  private async streamOne(
    provider: Provider,
    endpoint: string,
    model: string,
    apiKey: string | null,
    messages: OllamaMessage[],
  ): Promise<{ text: string; aborted: boolean }> {
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
    try {
      // Установка соединения в ollama-js без fetch-сигнала: гоняем с таймером
      // вручную; проигравший запрос безвредно «повисает» и собирается позже.
      const chatPromise = client.chat({
        model,
        messages,
        stream: true,
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
      }
      return { text, aborted: false };
    } catch (err) {
      if (isAbortError(err)) {
        if (this.abortRequested && !this.timeoutFired) {
          // Стоп по кнопке: частичный текст остаётся в чате.
          return { text, aborted: true };
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
