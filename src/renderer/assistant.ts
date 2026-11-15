/**
 * Renderer: чат AI-ассистента (P4, этапы 1–2).
 *
 * Логика диалога панели #assistant: отправка (Enter), потоковая отрисовка
 * ответа (события assistant:chunk/restart/done/error), «Стоп», «Очистить
 * историю», индикатор «Cloud / Local / Недоступен» (дешёвая проба main).
 * Этап 2: карточки выполненных тулов (assistant:tool) — компактные, не JSON;
 * после карточки текст ответа продолжает СВЕЖИЙ пузырь (botBubble = null,
 * чанк-хендлер создаёт новый) — порядок: объявление → карточка → ответ.
 * Открытие/закрытие панели и резервация layout — в renderer.ts.
 *
 * Текст и карточки вставляются ТОЛЬКО через textContent — модель не может
 * внедрить разметку в окно Brouser.
 */
import type { AssistantStatus, AssistantToolEvent } from '../main/types';

const api = window.brouser;

const messagesEl = document.getElementById('assistant-messages') as HTMLElement;
const formEl = document.getElementById('assistant-form') as HTMLFormElement;
const inputEl = document.getElementById('assistant-input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('assistant-send') as HTMLButtonElement;
const abortBtn = document.getElementById('assistant-abort') as HTMLButtonElement;
const clearBtn = document.getElementById('assistant-clear') as HTMLButtonElement;
const statusEl = document.getElementById('assistant-status') as HTMLElement;

/** Ответ ассистента сейчас стримится. */
let streaming = false;
/** Пузырь текущего ответа (создаётся при отправке, наполняется чанками). */
let botBubble: HTMLElement | null = null;

export function initAssistantChat(): void {
  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });
  // Enter — отправить, Shift+Enter — перенос строки (textarea по умолчанию
  // вставляет \n — перехватываем только «голый» Enter).
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });
  abortBtn.addEventListener('click', () => api.assistantAbort());
  clearBtn.addEventListener('click', () => {
    void api.assistantClear();
    messagesEl.replaceChildren();
    botBubble = null;
  });

  api.onAssistantChunk((ev) => {
    // После тул-карточки (или fallback-парсера) пузырь начинается заново.
    if (!botBubble) {
      botBubble = addMsg('bot', '');
      botBubble.classList.add('pending');
    }
    botBubble.classList.remove('pending');
    botBubble.textContent = (botBubble.textContent ?? '') + ev.delta;
    scrollBottom();
    // Живая метка провайдера во время стрима.
    setStatus(ev.provider === 'cloud' ? 'cloud' : 'local', ev.provider === 'cloud' ? 'Cloud' : 'Local', '');
  });
  api.onAssistantRestart(() => {
    if (!botBubble) return;
    botBubble.textContent = '';
    botBubble.classList.add('pending');
  });
  // Карточка выполненного тула (этап 2): между пузырями ответа; следующий
  // за ней чанк откроет свежий пузырь — визуальный порядок хода ассистента.
  api.onAssistantTool((ev) => {
    addToolCard(ev);
    botBubble = null;
  });
  api.onAssistantDone((ev) => {
    finishStream();
    if (botBubble && !botBubble.textContent) {
      // Пустой ответ (в т.ч. мгновенный «Стоп») — пузырь не нужен.
      botBubble.remove();
    }
    botBubble = null;
    if (ev.provider) {
      setStatus(ev.provider === 'cloud' ? 'cloud' : 'local', ev.provider === 'cloud' ? 'Cloud' : 'Local', ev.model ?? '');
    }
  });
  api.onAssistantError((ev) => {
    finishStream();
    if (botBubble && !botBubble.textContent) botBubble.remove();
    botBubble = null;
    addMsg('sys', ev.message);
    // Индикатор пересматриваем: причина могла измениться (ключ, сеть).
    void probeAssistantStatus();
  });
}

/** Отправить сообщение из поля ввода. */
async function submit(): Promise<void> {
  const text = (inputEl.value ?? '').trim();
  if (!text || streaming) return;
  addMsg('user', text);
  inputEl.value = '';
  botBubble = addMsg('bot', '');
  botBubble.classList.add('pending');
  streaming = true;
  sendBtn.disabled = true;
  abortBtn.hidden = false;
  setStatus('busy', '…', 'Ассистент отвечает');
  const res = await api.assistantSend(text);
  if (!res.ok) {
    finishStream();
    botBubble?.remove();
    botBubble = null;
    addMsg('sys', res.error ?? 'Сообщение не отправлено');
  }
  // Успешный приём: ответ приходит событиями chunk/done/error.
}

function finishStream(): void {
  streaming = false;
  sendBtn.disabled = false;
  abortBtn.hidden = true;
  if (botBubble) botBubble.classList.remove('pending');
}

/** Пузырь сообщения (текст — только textContent, без HTML). */
function addMsg(kind: 'user' | 'bot' | 'sys', text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollBottom();
  return el;
}

/** Карточка тул-вызова (этап 2): компактная, только textContent. */
function addToolCard(ev: AssistantToolEvent): void {
  const card = document.createElement('div');
  card.className = `tool-card${ev.ok ? '' : ' err'}`;
  const head = document.createElement('div');
  head.className = 'tool-card-head';
  head.textContent = ev.title;
  card.appendChild(head);
  for (const line of ev.lines) {
    const row = document.createElement('div');
    row.className = 'tool-card-line';
    row.textContent = line;
    card.appendChild(row);
  }
  messagesEl.appendChild(card);
  scrollBottom();
}

function scrollBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(state: string, label: string, title: string): void {
  statusEl.dataset.state = state;
  statusEl.textContent = label;
  statusEl.title = title || label;
}

/**
 * Обновить индикатор доступности (вызывается при открытии панели и после
 * ошибок). main делает дешёвую пробу: Cloud → Local → «Недоступен».
 */
export async function probeAssistantStatus(): Promise<void> {
  setStatus('probe', '…', 'Проверяю доступность…');
  try {
    const s: AssistantStatus = await api.assistantProbe();
    applyStatus(s);
  } catch {
    setStatus('off', 'Недоступен', 'Не удалось проверить');
  }
}

export function applyStatus(s: AssistantStatus): void {
  if (s.ok) {
    setStatus(
      s.provider === 'cloud' ? 'cloud' : 'local',
      s.label,
      s.detail ?? (s.mode === 'auto' ? 'Авто: Cloud с фолбэком на локальный Ollama' : ''),
    );
  } else {
    setStatus('off', s.label, s.detail ?? 'Провайдер недоступен');
  }
}
