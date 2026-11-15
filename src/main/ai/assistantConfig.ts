/**
 * AssistantConfigService — настройки AI-ассистента (P4, этап 1).
 *
 * Файл: userData/assistant-config.json (НЕ config.json):
 *   mode            — auto (Cloud → Local) | cloud | local;
 *   cloud.endpoint/model — Ollama Cloud (OpenAI-совместимый https://ollama.com);
 *   local.endpoint/model  — локальный Ollama (http://localhost:11434);
 *   apiKeyEnc       — API-ключ Ollama Cloud, base64(safeStorage.encryptString).
 *
 * Модель — поле конфига, а не константа: список моделей Ollama Cloud меняется
 * (сегодня gpt-oss:20b, завтра — нет), смена модели не должна требовать правки
 * кода. Дефолты заданы здесь, пользователь меняет в «Настройки → AI-ассистент».
 *
 * Ключ НИКОГДА не попадает в config.json и в логи. Приоритет источника ключа:
 * переменная окружения OLLAMA_API_KEY, затем зашифрованное значение из файла.
 * Если safeStorage недоступен (Linux без keyring) — ключ не сохраняется:
 * лучше отказ, чем лежащий открытым текстом секрет.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, safeStorage } from 'electron';
import {
  AssistantConfigInput,
  AssistantConfigView,
  AssistantEndpointConfig,
  AssistantMode,
  CommandResult,
} from '../types';
import { Logger } from '../logger';

const DEFAULT_CLOUD_ENDPOINT = 'https://ollama.com';
const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434';
/** Дефолты моделей: Cloud — gpt-oss:20b (нативный tool calling), Local — qwen2.5:7b. */
const DEFAULT_CLOUD_MODEL = 'gpt-oss:20b';
const DEFAULT_LOCAL_MODEL = 'qwen2.5:7b';

const MODES: AssistantMode[] = ['auto', 'cloud', 'local'];

interface StoredConfig {
  mode: AssistantMode;
  cloud: AssistantEndpointConfig;
  local: AssistantEndpointConfig;
  /** base64(safeStorage.encryptString(ключ)) — пусто/отсутствует = ключа нет. */
  apiKeyEnc?: string;
}

export class AssistantConfigService {
  readonly configPath: string;
  private stored: StoredConfig = defaults();

  constructor(private log: Logger) {
    this.configPath = path.join(app.getPath('userData'), 'assistant-config.json');
  }

  load(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        this.stored = normalize(JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as unknown);
        this.log.info(
          `[assistant] config загружен: mode=${this.stored.mode}, cloud=${this.stored.cloud.model}, local=${this.stored.local.model}`,
        );
      } else {
        this.stored = defaults();
        this.save();
      }
    } catch (err) {
      this.log.error(
        `[assistant] assistant-config.json повреждён (${String(err)}) — использую значения по умолчанию`,
      );
      this.stored = defaults();
    }
  }

  /** Атомарная запись (как config.json): tmp + rename. */
  save(): void {
    try {
      const tmp = this.configPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.stored, null, 2), 'utf8');
      fs.renameSync(tmp, this.configPath);
    } catch (err) {
      this.log.error(`[assistant] не удалось сохранить assistant-config.json: ${String(err)}`);
    }
  }

  /** Публичный вид настроек (без ключа — только факт его наличия). */
  view(): AssistantConfigView {
    const key = this.getApiKey();
    return {
      mode: this.stored.mode,
      cloud: { ...this.stored.cloud },
      local: { ...this.stored.local },
      hasKey: !!key.key,
      keyFromEnv: key.fromEnv,
    };
  }

  /**
   * Ключ Ollama Cloud: env OLLAMA_API_KEY -> расшифрованное хранилище ОС.
   * Возвращает null, если ключа нет/не читается. Сам ключ не логируется.
   */
  getApiKey(): { key: string | null; fromEnv: boolean } {
    const env = (process.env.OLLAMA_API_KEY ?? '').trim();
    if (env) return { key: env, fromEnv: true };
    const enc = this.stored.apiKeyEnc;
    if (!enc) return { key: null, fromEnv: false };
    try {
      const plain = safeStorage.decryptString(Buffer.from(enc, 'base64'));
      return plain ? { key: plain, fromEnv: false } : { key: null, fromEnv: false };
    } catch {
      this.log.warn('[assistant] не удалось расшифровать API-ключ — сохраните его заново в «Настройках»');
      return { key: null, fromEnv: false };
    }
  }

  /**
   * Сохранить настройки из UI. apiKey: undefined — не трогать, '' — удалить,
   * строка — зашифровать safeStorage и записать. Об ошибке — CommandResult.
   */
  applyInput(input: AssistantConfigInput): CommandResult {
    const src = input ?? ({} as AssistantConfigInput);
    const mode: AssistantMode = MODES.includes(src.mode) ? src.mode : this.stored.mode;
    this.stored.mode = mode;

    this.stored.cloud = normalizeEndpoint(
      src.cloud,
      this.stored.cloud,
      DEFAULT_CLOUD_ENDPOINT,
      DEFAULT_CLOUD_MODEL,
    );
    this.stored.local = normalizeEndpoint(
      src.local,
      this.stored.local,
      DEFAULT_LOCAL_ENDPOINT,
      DEFAULT_LOCAL_MODEL,
    );

    if (src.apiKey !== undefined) {
      const plain = (src.apiKey ?? '').trim();
      if (!plain) {
        delete this.stored.apiKeyEnc;
      } else {
        try {
          if (!safeStorage.isEncryptionAvailable()) {
            return {
              ok: false,
              error:
                'Шифрование ключа недоступно в этой ОС (нет keychain/secret service) — ключ не сохранён. Задайте переменную OLLAMA_API_KEY или включите системное хранилище секретов.',
            };
          }
          this.stored.apiKeyEnc = safeStorage.encryptString(plain).toString('base64');
        } catch (err) {
          return { ok: false, error: `Не удалось зашифровать ключ: ${String(err)}` };
        }
      }
    }

    this.save();
    this.log.info(`[assistant] config сохранён: mode=${mode}`);
    return { ok: true };
  }
}

// ------------------------------------------------------------------
// Нормализация / дефолты
// ------------------------------------------------------------------

function defaults(): StoredConfig {
  return {
    mode: 'auto',
    cloud: { endpoint: DEFAULT_CLOUD_ENDPOINT, model: DEFAULT_CLOUD_MODEL },
    local: { endpoint: DEFAULT_LOCAL_ENDPOINT, model: DEFAULT_LOCAL_MODEL },
  };
}

function normalize(raw: unknown): StoredConfig {
  const src = (raw ?? {}) as Record<string, unknown>;
  const mode: AssistantMode = MODES.includes(src.mode as AssistantMode)
    ? (src.mode as AssistantMode)
    : 'auto';
  const apiKeyEnc =
    typeof src.apiKeyEnc === 'string' && src.apiKeyEnc.trim() ? src.apiKeyEnc.trim() : undefined;
  return {
    mode,
    cloud: normalizeEndpoint(
      src.cloud as Partial<AssistantEndpointConfig> | undefined,
      defaults().cloud,
      DEFAULT_CLOUD_ENDPOINT,
      DEFAULT_CLOUD_MODEL,
    ),
    local: normalizeEndpoint(
      src.local as Partial<AssistantEndpointConfig> | undefined,
      defaults().local,
      DEFAULT_LOCAL_ENDPOINT,
      DEFAULT_LOCAL_MODEL,
    ),
    apiKeyEnc,
  };
}

/**
 * Endpoint — только http(s) (защита от file:// и мусора из рукоправленного
 * файла), модель — непустая строка ≤ 100 символов. Битые значения молча
 * заменяются дефолтом: конфиг ассистента не должен блокировать запуск.
 */
function normalizeEndpoint(
  raw: Partial<AssistantEndpointConfig> | undefined,
  prev: AssistantEndpointConfig,
  defEndpoint: string,
  defModel: string,
): AssistantEndpointConfig {
  const src = raw ?? {};
  const prevEndpoint = typeof prev.endpoint === 'string' ? prev.endpoint : defEndpoint;
  const prevModel = typeof prev.model === 'string' ? prev.model : defModel;
  let endpoint = typeof src.endpoint === 'string' ? src.endpoint.trim() : prevEndpoint;
  if (!/^https?:\/\//i.test(endpoint)) endpoint = defEndpoint;
  let model = typeof src.model === 'string' ? src.model.trim() : prevModel;
  if (!model || model.length > 100) model = defModel;
  return { endpoint, model };
}
