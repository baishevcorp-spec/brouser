/**
 * search_faq — поиск по документации проекта (P4, этап 2).
 *
 * Контракт зафиксирован ещё в docs/assistant-stage0.md (тул №13): поиск по
 * README.md, BACKLOG.md, ROADMAP.md и docs/*.md. Этап 3 поднимет его до
 * полноценного RAG (эмбеддинги/индекс), здесь — честный keyword-поиск по
 * секциям: разметка markdown уже делит документ на смысловые куски, чего
 * для тест-кейса «Как проверить фингерпринт?» → раздел «Антидетект»
 * достаточно.
 *
 * Безопасность: чтение ТОЛЬКО этих файлов (никаких произвольных путей —
 * fs ограничен жёстким списком), каждый файл ≤ 512 КБ, цитата ≤ 1,5 КБ.
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

/** Один найденный раздел. */
export interface FaqHit {
  /** Ссылка вида «README.md → «Антидетект»». */
  ref: string;
  /** Цитата раздела (обрезана до EXCERPT_MAX). */
  excerpt: string;
}

const STOPWORDS = new Set([
  'как', 'что', 'где', 'почему', 'это', 'для', 'какой', 'какая', 'какие',
  'мне', 'мои', 'мой', 'она', 'они', 'оно', 'он', 'при', 'или', 'то', 'же',
  'the', 'and', 'for', 'you', 'how', 'what', 'why', 'are', 'can', 'покажи',
  'скажи', 'расскажи', 'проверить', 'нужно', 'надо',
]);

/** Токены запроса: буквы/цифры, длиннее 2, без стоп-слов. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^0-9a-zа-яё]+/i)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

interface Section {
  file: string;
  heading: string;
  title: string;
  body: string;
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
    if (body) out.push({ file, heading, title, body });
    buffer = [];
  };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      // Заголовок секции = «путь» до неё: H1 файла + ближайший H2/H3.
      heading = m[1].length <= 1 ? `${file} → «${m[2].trim()}»` : `${file} → «${m[2].trim()}»`;
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

/**
 * Поиск: секции оцениваются суммой вхождений терминов (заголовок ×5, тело ×1),
 * результат — топ-2 с цитатами. Нет совпадений — честный «не найдено»
 * со списком доступных документов.
 */
export function searchFaq(query: string, limit = 2): { hits: FaqHit[]; files: string[] } {
  const docs = collectDocs();
  const files = docs.map((d) => d.file);
  const terms = tokenize(query);
  if (terms.length === 0 || docs.length === 0) return { hits: [], files };

  const sections: Section[] = [];
  for (const d of docs) sections.push(...splitSections(d.file, d.md));

  const scored: { section: Section; score: number }[] = [];
  for (const s of sections) {
    let score = 0;
    const titleLower = `${s.file} ${s.title}`.toLowerCase();
    const bodyLower = s.body.toLowerCase();
    for (const term of terms) {
      score += countOccurrences(titleLower, term) * 5;
      score += countOccurrences(bodyLower, term);
    }
    if (score > 0) scored.push({ section: s, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const hits: FaqHit[] = scored.slice(0, limit).map(({ section }) => {
    const excerpt =
      section.body.length > EXCERPT_MAX ? `${section.body.slice(0, EXCERPT_MAX)}…` : section.body;
    return { ref: section.heading, excerpt };
  });
  return { hits, files };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = haystack.indexOf(needle, pos + needle.length);
  }
  return count;
}
