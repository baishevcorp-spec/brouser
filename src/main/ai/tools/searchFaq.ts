/**
 * search_faq — поиск по документации проекта (P4, этап 3: «RAG-lite»).
 *
 * Эмбеддинги и внешние сервисы не используются (Zero-Data: ассистент не
 * ходит в сеть за индексом) — вместо этого retrieval над markdown-секциями
 * с тремя улучшениями против голого keyword-поиска:
 *   1. грубый русский стеммер: «крашится» → «краш», «настроить» →
 *      «настро»; стемы усекаются до 6 символов, склеивая словоформы
 *      («настройка»/«настроить»/«настроен» → «настро»);
 *   2. доменные синонимы: «фингерпринт» ↔ «отпечаток» ↔ «fingerprint»,
 *      «прокси» ↔ «proxy», «куки» ↔ «cookies», «лог» ↔ «журнал» — язык
 *      пользователя и язык документации связаны явно;
 *   3. цитата выдаётся не с начала секции, а вокруг строки с наибольшим
 *      числом совпадений — модель видит релевантный фрагмент, а не вводку.
 * Вопросы в «человеческой» форме попадают в раздел «FAQ» README (вопросы-
 * заголовки) почти дословно и стабильно занимают топ выдачи.
 *
 * Безопасность (правила этапа 0, неизменны): чтение ТОЛЬКО README.md,
 * BACKLOG.md, ROADMAP.md и docs/*.md — жёсткий список, произвольных путей
 * для тула не существует; каждый файл ≤ 512 КБ, цитата ≤ 1,5 КБ.
 *
 * Где лежат документы: dev — корень проекта (app.getAppPath());
 * упакованное приложение — process.resourcesPath (electron-builder
 * кладёт их в extraResources).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';

/** Корень документации: dev — исходники, packaged — extraResources. */
export function docsBaseDir(): string {
  return app.isPackaged ? process.resourcesPath : app.getAppPath();
}

const ROOT_DOCS = ['README.md', 'BACKLOG.md', 'ROADMAP.md'];
const MAX_FILE_BYTES = 512 * 1024;
const EXCERPT_MAX = 1500;
/** Стемы длиннее усекаются: «настроить»/«настройка» → «настро». */
const STEM_MAX = 6;

/** Один найденный раздел. */
export interface FaqHit {
  /** Ссылка вида «README.md → «Антидетект»». */
  ref: string;
  /** Цитата вокруг самого релевантного места секции (обрезана до EXCERPT_MAX). */
  excerpt: string;
}

const STOPWORDS = new Set([
  'как', 'что', 'где', 'почему', 'это', 'для', 'какой', 'какая', 'какие',
  'мне', 'мои', 'мой', 'она', 'они', 'оно', 'он', 'при', 'или', 'то', 'же',
  'the', 'and', 'for', 'you', 'how', 'what', 'why', 'are', 'can', 'покажи',
  'скажи', 'расскажи', 'проверить', 'нужно', 'надо', 'если', 'делать',
  'делает', 'сделать', 'может', 'можно', 'должен', 'быть', 'меня', 'тебя',
]);

/** Доменные синонимы: язык пользователя ↔ язык документации (до нормализации). */
const SYNONYMS: Record<string, string[]> = {
  фингерпринт: ['отпечаток', 'fingerprint', 'антидетект'],
  отпечаток: ['фингерпринт', 'fingerprint', 'антидетект'],
  fingerprint: ['фингерпринт', 'отпечаток'],
  антидетект: ['фингерпринт', 'отпечаток'],
  краш: ['падение', 'падает'],
  падение: ['краш'],
  прокси: ['proxy'],
  proxy: ['прокси'],
  куки: ['cookies', 'печенье'],
  cookies: ['куки'],
  cookie: ['куки'],
  печенье: ['куки'],
  лог: ['журнал'],
  журнал: ['лог'],
  расширение: ['extension'],
  extension: ['расширение'],
  ротация: ['rotation'],
  rotation: ['ротация'],
  авито: ['avito'],
  avito: ['авито'],
};

/**
 * Русские окончания для грубой нормализации (жадно, длиннее — раньше;
 * стем после отрезания обязан остаться ≥ 4 символов). Цикл до трёх
 * проходов снимает составные окончания: «крашится» → «крашит» → «краш».
 */
const RU_ENDINGS = [
  'иями', 'ями', 'ыми', 'ами', 'ией', 'иях', 'ого', 'ому', 'его', 'ему',
  'ия', 'ию', 'ии',
  'ся', 'сь', 'ть', 'ла', 'на', 'еш', 'ет', 'ит', 'ат', 'ят', 'ут', 'ют',
  'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ие', 'ые', 'ую', 'юю',
  'ов', 'ев', 'ам', 'ом', 'ем', 'ах', 'ых', 'их', 'ка', 'ки',
];

/** Нормализация слова: отрезать окончания, усечь длинный стем. */
function normalize(word: string): string {
  let w = word;
  for (let guard = 0; guard < 3; guard++) {
    let cut = false;
    for (const end of RU_ENDINGS) {
      if (w.length >= 4 + end.length && w.endsWith(end)) {
        w = w.slice(0, w.length - end.length);
        cut = true;
        break;
      }
    }
    if (!cut) break;
  }
  return w.length > STEM_MAX ? w.slice(0, STEM_MAX) : w;
}

/** Токены-стемы: буквы/цифры, длиннее 2, без стоп-слов, нормализованы. */
function tokenizeStems(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^0-9a-zа-яё]+/i)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    .map(normalize);
}

/** Совпадение токенов: равенство или общий префикс (короткий ≥ 3). */
function matchToken(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Запрос → стемы + синонимы (по сырому слову и по стему). */
function queryTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^0-9a-zа-яё]+/i)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const terms = new Set<string>();
  for (const w of words) {
    const stem = normalize(w);
    terms.add(stem);
    for (const key of [w, stem]) {
      for (const syn of SYNONYMS[key] ?? []) terms.add(normalize(syn));
    }
  }
  return [...terms];
}

interface Section {
  file: string;
  heading: string;
  title: string;
  body: string;
  /** Стемы заголовка (счёт ×5) и тела (×1). */
  headTokens: string[];
  bodyTokens: string[];
}

/** Разрезать документ на секции по заголовкам (## и ### достаточно). */
function splitSections(file: string, md: string): Section[] {
  const out: Section[] = [];
  const lines = md.split('\n');
  let heading = file;
  let title = '';
  let buffer: string[] = [];
  const flush = (): void => {
    const body = buffer.join('\n').trim();
    if (body) {
      out.push({
        file,
        heading,
        title,
        body,
        headTokens: tokenizeStems(`${title} ${file}`),
        bodyTokens: tokenizeStems(body),
      });
    }
    buffer = [];
  };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      // Заголовок секции = файл + ближайший заголовок («путь» до секции).
      heading = `${file} → «${m[2].trim()}»`;
      title = m[2].trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

/** Список читаемых документов (существующие файлы ≤ MAX_FILE_BYTES). */
function collectDocs(): { file: string; md: string }[] {
  const base = docsBaseDir();
  const candidates = [...ROOT_DOCS];
  try {
    const docsDir = path.join(base, 'docs');
    if (fs.existsSync(docsDir) && fs.statSync(docsDir).isDirectory()) {
      for (const entry of fs.readdirSync(docsDir)) {
        if (entry.toLowerCase().endsWith('.md')) candidates.push(`docs/${entry}`);
      }
    }
  } catch {
    /* каталога docs нет — только корневые документы */
  }
  const out: { file: string; md: string }[] = [];
  for (const rel of candidates) {
    try {
      const abs = path.join(base, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      out.push({ file: rel, md: fs.readFileSync(abs, 'utf8') });
    } catch {
      /* файла нет — пропускаем молча */
    }
  }
  return out;
}

/** Цитата вокруг строки с максимумом совпадений, а не вводка секции. */
function excerptAround(body: string, terms: string[]): string {
  if (body.length <= EXCERPT_MAX) return body;
  const lines = body.split('\n');
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < lines.length; i++) {
    const stems = tokenizeStems(lines[i]).join(' ');
    let score = 0;
    for (const q of terms) if (q.length >= 3 && stems.includes(q)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestScore <= 0) return `${body.slice(0, EXCERPT_MAX)}…`;
  const charIdx = lines.slice(0, bestIdx).join('\n').length + 1;
  const start = Math.max(0, Math.min(charIdx - 250, body.length - EXCERPT_MAX));
  return `${start > 0 ? '…' : ''}${body.slice(start, start + EXCERPT_MAX)}${
    start + EXCERPT_MAX < body.length ? '…' : ''
  }`;
}

/**
 * Поиск (RAG-lite): секции оцениваются суммой совпадений стемов запроса
 * (заголовок ×5, тело ×1), результат — топ-3 с цитатами вокруг релевантного
 * места. Нет совпадений — честное «не найдено» со списком документов.
 */
export function searchFaq(query: string, limit = 3): { hits: FaqHit[]; files: string[] } {
  const docs = collectDocs();
  const files = docs.map((d) => d.file);
  const terms = queryTerms(query);
  if (terms.length === 0 || docs.length === 0) return { hits: [], files };

  const sections: Section[] = [];
  for (const d of docs) sections.push(...splitSections(d.file, d.md));

  const scored: { section: Section; score: number }[] = [];
  for (const s of sections) {
    let score = 0;
    for (const q of terms) {
      for (const t of s.headTokens) if (matchToken(q, t)) score += 5;
      for (const t of s.bodyTokens) if (matchToken(q, t)) score += 1;
    }
    if (score > 0) scored.push({ section: s, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const hits: FaqHit[] = scored.slice(0, limit).map(({ section }) => ({
    ref: section.heading,
    excerpt: excerptAround(section.body, terms),
  }));
  return { hits, files };
}
