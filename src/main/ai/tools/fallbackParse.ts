/**
 * Fallback-парсер tool-call'ов из content (P4, этап 2).
 *
 * Известная особенность облачных Ollama-моделей: периодически модель
 * возвращает вызов тулa не в message.tool_calls, а сырым JSON прямо в
 * content — иногда в ```json-фенсе, иногда с текстом-вступлением рядом.
 * Без вторичного парсера тулы работали бы «через раз».
 *
 * Правило распознавания: сбалансированный объект верхнего уровня с полями
 * { name: string, arguments: object|string } — выполняется как тул.
 * cleaned — текст без JSON-кусков (и без опустевших фесов): его ассистент
 * заново отдаёт в пузырь (restart + chunk), чтобы пользователь не видел
 * сырой JSON, а история не тащила его в следующий контекст.
 *
 * Модуль чистый (без electron) — пригоден для smoke-теста в node.
 */

export interface FallbackToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FallbackParseResult {
  calls: FallbackToolCall[];
  /** Текст без JSON-кусков (для повторной выдачи в пузырь). */
  cleaned: string;
}

/** Похоже ли значение на форму tool-call: { name, arguments }. */
function isToolCallShape(j: unknown): j is { name: unknown; arguments: unknown } {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return false;
  const obj = j as Record<string, unknown>;
  if (typeof obj.name !== 'string') return false;
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(obj.name)) return false;
  // arguments допускается объектом ИЛИ строкой с JSON (модели периодически
  // кладут туда JSON.stringify) — normalizeArgs приведёт к объекту.
  if (obj.arguments === undefined) return true;
  if (typeof obj.arguments === 'string') return true;
  return typeof obj.arguments === 'object' && obj.arguments !== null && !Array.isArray(obj.arguments);
}

/** Нормализовать arguments: строка с JSON → объект; мусор → {}. */
function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return {};
}

/**
 * Найти tool-call JSON в content. Возвращает null, если ничего похожего нет —
 * тогда текст честно остаётся обычным ответом.
 */
export function parseToolCallsFromContent(text: string): FallbackParseResult | null {
  if (!text || text.indexOf('{') === -1) return null;

  // Сбалансированные {…} верхнего уровня (учит строки с экранированием).
  const spans: [number, number][] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          spans.push([start, i + 1]);
          start = -1;
        }
      }
    }
  }

  const calls: FallbackToolCall[] = [];
  for (const [from, to] of spans) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(from, to));
    } catch {
      continue;
    }
    if (!isToolCallShape(parsed)) continue;
    calls.push({ name: (parsed as { name: string }).name, args: normalizeArgs((parsed as { arguments?: unknown }).arguments) });
  }
  if (calls.length === 0) return null;

  // cleaned: вырезать JSON-куски (с конца, чтобы индексы не поехали),
  // затем убрать опустевшие ```-фенсы, лишние пробелы и пустые строки.
  let cleaned = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    cleaned = cleaned.slice(0, spans[i][0]) + cleaned.slice(spans[i][1]);
  }
  cleaned = cleaned
    .replace(/```[a-z]*\s*```/gi, '')
    .replace(/\n[ \t]*```[a-z]*\s*\n?/gi, '\n')
    .replace(/[ \t]*```[ \t]*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { calls, cleaned };
}
