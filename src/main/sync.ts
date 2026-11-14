/**
 * Brouser — синхронизатор действий (P3, backlog).
 *
 * Реплей ввода «как в Dolphin»: клики, колесо и клавиатура в любой видимой
 * ячейке повторяются во все остальные видимые ячейки — одно действие во
 * всех аккаунтах сразу.
 *
 * Механика (полностью через CDP-отладчики, которые и так прикреплены
 * к представлениям для эмуляции):
 *
 *   Захват (каждая участвующая ячейка):
 *     - Runtime.addBinding('__brouserInput') — exposes в страницы глобальную
 *       функцию; вызовы прилетают в main событием Runtime.bindingCalled
 *       на debugger'е этого webContents;
 *     - Page.addScriptToEvaluateOnNewDocument + Runtime.evaluate — установка
 *       CAPTURE_SCRIPT (listen'ы pointerdown/up, wheel, keydown/up в capture
 *       фазе; координаты — clientX/Y, т.е. относительно вьюпорта ячейки).
 *
 *   Ретрансляция (main):
 *     - сообщение bindingCalled из ячейки S -> для каждой ДРУГОЙ видимой
 *       ячейки F: Input.dispatchMouseEvent / dispatchKeyEvent с теми же
 *       координатами (ячейки сетки равного размера, координаты 1:1) и
 *       распознанным VK-кодом клавиши.
 *
 *   Подавление эха (главная ловушка):
 *     - синтетические CDP-события порождают в F НАСТОЯЩИЕ DOM-события,
 *       CAPTURE_SCRIPT в F снова зовёт binding -> бесконечный цикл;
 *     - решение: после dispatch в F ставим окно подавления (100 мс) —
 *       bindingCalled из F внутри окна отбрасывается.
 *
 * Жизненный цикл binding/скрипта захвата (captureLive):
 *   - переживают выключение синхронизации (debugger остаётся прикреплён
 *     для эмуляции, binding жив; без listener события никуда не идут);
 *   - умирают при detach debugger'а (окно DevTools) — восстанавливаются
 *     переустановкой из ProfileManager (devtools-closed -> reinstall);
 *   - умирают вместе с webContents — forget вызывается ДО teardown.
 *
 * Ограничения v1 (осознанные):
 *   - ввод внутри кросс-доменных iframe не захватывается (события не
 *     всплывают наружу); основной UI Avito — top-frame;
 *   - drag&drop не синхронизируется (нет pointermove-потока);
 *   - IME-составной ввод не поддержан;
 *   - координаты совпадают 1:1 (ячейки равного размера); страницы должны
 *     быть в одинаковом состоянии — обычно все профили на одном URL.
 *
 * Crash-безопасность: все операции проверяют wc.isDestroyed(); забывание
 * ячейки — синхронно ДО teardown (destroyView), чтобы listener на
 * debugger'е не жил дольше webContents (урок P2.5: обращения к мёртвому
 * webContents роняют процесс нативно).
 */
import { Debugger, WebContents } from 'electron';
import { Logger } from './logger';

/** Имя CDP-биндинга (глобальная функция на страницах). */
const BINDING = '__brouserInput';

/** Окно подавления эха после синтетического dispatch (мс). */
const SUPPRESS_MS = 100;

// ------------------------------------------------------------------
// Скрипт захвата (MAIN world страниц). Идемпотентен (маркер).
// ------------------------------------------------------------------

/**
 * Модификаторы сразу в порядке CDP: Alt=1, Ctrl=2, Meta=4, Shift=8
 * (порядок DOM-событий другой — Ctrl=1, Shift=2, Alt=4, Meta=8 — не путать).
 */
const CAPTURE_SCRIPT = `
(() => {
  if (window.__brouserSyncCapture) return;
  window.__brouserSyncCapture = true;
  const send = (o) => { try { __brouserInput(JSON.stringify(o)); } catch (e) {} };
  const mods = (e) =>
    (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const opts = { capture: true, passive: true };
  document.addEventListener('pointerdown', (e) => {
    send({ t: 'md', x: Math.round(e.clientX), y: Math.round(e.clientY), b: e.button, d: e.detail || 1, m: mods(e) });
  }, opts);
  document.addEventListener('pointerup', (e) => {
    send({ t: 'mu', x: Math.round(e.clientX), y: Math.round(e.clientY), b: e.button, d: e.detail || 1, m: mods(e) });
  }, opts);
  document.addEventListener('wheel', (e) => {
    send({ t: 'wh', x: Math.round(e.clientX), y: Math.round(e.clientY), dx: Math.round(e.deltaX), dy: Math.round(e.deltaY), m: mods(e) });
  }, opts);
  document.addEventListener('keydown', (e) => {
    send({ t: 'kd', k: e.key, c: e.code, loc: e.location || 0, m: mods(e) });
  }, opts);
  document.addEventListener('keyup', (e) => {
    send({ t: 'ku', k: e.key, c: e.code, loc: e.location || 0, m: mods(e) });
  }, opts);
})();
`;

// ------------------------------------------------------------------
// Сообщения захвата (дискриминанты — одиночные литералы: TS надёжно
// сужает обе ветки проверок t)
// ------------------------------------------------------------------

export interface SyncMouseDownMessage {
  t: 'md';
  x: number;
  y: number;
  /** e.button: 0 left, 1 middle, 2 right. */
  b: number;
  /** Счётчик кликов (2 = double click). */
  d: number;
  /** Модификаторы в порядке CDP. */
  m: number;
}

export interface SyncMouseUpMessage {
  t: 'mu';
  x: number;
  y: number;
  b: number;
  d: number;
  m: number;
}

export interface SyncWheelMessage {
  t: 'wh';
  x: number;
  y: number;
  dx: number;
  dy: number;
  m: number;
}

export interface SyncKeyDownMessage {
  t: 'kd';
  /** e.key ('a', 'Enter', 'ArrowLeft'...). */
  k: string;
  /** e.code ('KeyA', 'Enter'...). */
  c: string;
  /** e.location: 0 стандарт, 1 левый, 2 правый, 3 numpad. */
  loc: number;
  m: number;
}

export interface SyncKeyUpMessage {
  t: 'ku';
  k: string;
  c: string;
  loc: number;
  m: number;
}

export type SyncMessage =
  | SyncMouseDownMessage
  | SyncMouseUpMessage
  | SyncWheelMessage
  | SyncKeyDownMessage
  | SyncKeyUpMessage;

// ------------------------------------------------------------------
// VK-коды (Windows virtual key codes для Input.dispatchKeyEvent)
// ------------------------------------------------------------------

const VK_SPECIAL: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  Delete: 46,
  Insert: 45,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Meta: 91,
  ' ': 32,
  ContextMenu: 93,
  CapsLock: 20,
  NumLock: 144,
  ScrollLock: 145,
  Pause: 19,
  PrintScreen: 44,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

/** windowsVirtualKeyCode из e.key/e.code. Экспортировано для тестов. */
export function vkCodeFromKey(key: string, code = ''): number {
  const special = VK_SPECIAL[key];
  if (special !== undefined) return special;
  if (key.length === 1) return key.toUpperCase().charCodeAt(0) || 0;
  // Фолбэк по code: KeyA..KeyZ, Digit0..Digit9, Numpad0..9 (VK 96..105).
  const m = /^(?:Key([A-Z])|Digit(\d)|Numpad(\d))$/.exec(code);
  if (m) {
    if (m[1]) return (m[1] as string).charCodeAt(0);
    if (m[2] !== undefined) return (m[2] as string).charCodeAt(0);
    return 96 + Number(m[3]); // Numpad0..9
  }
  const fm = /^F(\d{1,2})$/.exec(code);
  if (fm) {
    const n = Number.parseInt(fm[1] as string, 10);
    if (n >= 1 && n <= 12) return 111 + n;
  }
  return 0;
}

// ------------------------------------------------------------------
// Маппинг сообщений -> параметры CDP Input.*
// ------------------------------------------------------------------

const CDP_BUTTONS: Record<number, string> = { 0: 'left', 1: 'middle', 2: 'right' };

/** mousePressed/mouseReleased/mouseWheel из сообщения захвата. */
export function buildMouseParams(
  msg: SyncMouseDownMessage | SyncMouseUpMessage | SyncWheelMessage,
): Record<string, unknown> {
  const button = msg.t === 'wh' ? 'none' : (CDP_BUTTONS[msg.b] ?? 'left');
  const params: Record<string, unknown> = {
    type: msg.t === 'md' ? 'mousePressed' : msg.t === 'mu' ? 'mouseReleased' : 'mouseWheel',
    x: msg.x,
    y: msg.y,
    button,
    buttons: msg.t === 'md' ? 1 << msg.b : 0,
    modifiers: msg.m,
  };
  if (msg.t === 'md' || msg.t === 'mu') params.clickCount = msg.d || 1;
  if (msg.t === 'wh') {
    params.deltaX = msg.dx;
    params.deltaY = msg.dy;
  }
  return params;
}

/** keyDown/keyUp (с text для печатаемых — вставка текста, как в Puppeteer). */
export function buildKeyParams(
  msg: SyncKeyDownMessage | SyncKeyUpMessage,
): Record<string, unknown> {
  const vk = vkCodeFromKey(msg.k, msg.c);
  const printable =
    msg.k.length === 1 || msg.k === 'Enter' || msg.k === 'Tab' || msg.k === 'Backspace';
  const params: Record<string, unknown> = {
    type: msg.t === 'kd' ? 'keyDown' : 'keyUp',
    key: msg.k,
    code: msg.c,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: msg.m,
  };
  if (msg.loc) params.location = msg.loc;
  // text только на keyDown печатаемых клавиш — иначе Chromium дублирует ввод.
  if (msg.t === 'kd' && printable) {
    if (msg.k.length === 1) params.text = msg.k;
    else if (msg.k === 'Enter') params.text = '\r';
  }
  return params;
}

/** Парсинг payload биндинга (экспортировано для тестов). null = мусор. */
export function parseSyncPayload(raw: string): SyncMessage | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (typeof o.t !== 'string') return null;
    switch (o.t) {
      case 'md':
      case 'mu':
        if (typeof o.x !== 'number' || typeof o.y !== 'number') return null;
        return {
          t: o.t,
          x: o.x,
          y: o.y,
          b: typeof o.b === 'number' ? o.b : 0,
          d: typeof o.d === 'number' ? o.d : 1,
          m: typeof o.m === 'number' ? o.m : 0,
        } as SyncMouseDownMessage | SyncMouseUpMessage;
      case 'wh':
        if (typeof o.x !== 'number' || typeof o.y !== 'number') return null;
        return {
          t: 'wh',
          x: o.x,
          y: o.y,
          dx: typeof o.dx === 'number' ? o.dx : 0,
          dy: typeof o.dy === 'number' ? o.dy : 0,
          m: typeof o.m === 'number' ? o.m : 0,
        } as SyncWheelMessage;
      case 'kd':
      case 'ku':
        if (typeof o.k !== 'string') return null;
        return {
          t: o.t,
          k: o.k,
          c: typeof o.c === 'string' ? o.c : '',
          loc: typeof o.loc === 'number' ? o.loc : 0,
          m: typeof o.m === 'number' ? o.m : 0,
        } as SyncKeyDownMessage | SyncKeyUpMessage;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// InputSync — менеджер участников и ретрансляция
// ------------------------------------------------------------------

interface Participant {
  profileId: string;
  wc: WebContents;
  /** Listener «message» на debugger'е этого wc (снимается при forget/disable). */
  onMessage: (event: unknown, method: string, params?: unknown) => void;
}

export class InputSync {
  /** Синхронизация включена. */
  private enabled = false;
  /** Участники (listener установлен): wcId -> описание. */
  private participants = new Map<number, Participant>();
  /** Идёт установка захвата на этих wcId (анти-дублирование). */
  private pending = new Set<number>();
  /** Окна подавления эха: wcId -> до какого timestamp (мс). */
  private suppressUntil = new Map<number, number>();
  /**
   * На каких wc сейчас живут binding+скрипт захвата. Переживают
   * выключение синхронизации (debugger остаётся прикреплён), умирают при
   * detach (DevTools) и закрытии webContents.
   */
  private captureLive = new Map<number, WebContents>();
  /** Счётчик эха (диагностика). */
  private echoDropped = 0;

  constructor(private log: Logger) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Включить/выключить. views — текущие видимые webContents (пары
   * profileId+wc); при включении они регистрируются, при выключении
   * listener'ы снимаются (binding/скрипт на страницах остаются — без
   * listener их вызовы никуда не идут).
   */
  async setEnabled(on: boolean, views: { profileId: string; wc: WebContents }[]): Promise<void> {
    this.enabled = on;
    if (!on) {
      for (const [wcId] of [...this.participants]) this.detachListener(wcId);
      this.participants.clear();
      this.suppressUntil.clear();
      this.log.info('синхронизатор действий выключен');
      return;
    }
    this.log.info('синхронизатор действий включён');
    await this.setParticipants(views);
  }

  /**
   * Синхронизировать список участников с текущим набором видимых
   * представлений: новых регистрируем, исчезнувших забываем.
   * Вызывается при включении и при любых изменениях сетки/профилей.
   */
  async setParticipants(views: { profileId: string; wc: WebContents }[]): Promise<void> {
    if (!this.enabled) return;
    const wanted = new Map<number, { profileId: string; wc: WebContents }>();
    for (const v of views) {
      if (!v.wc.isDestroyed()) wanted.set(v.wc.id, v);
    }

    // Подчистка captureLive от мёртвых wc (закрытые представления).
    for (const [wcId, wc] of [...this.captureLive]) {
      if (wc.isDestroyed()) this.captureLive.delete(wcId);
    }

    // Ушедшие из сетки: снять listener и забыть.
    for (const [wcId, p] of [...this.participants]) {
      if (!wanted.has(wcId) || p.wc.isDestroyed()) this.forget(wcId);
    }

    // Новые: listener + (если захвата ещё нет) binding/скрипт.
    for (const [wcId, v] of wanted) {
      if (!this.participants.has(wcId)) void this.register(v.profileId, v.wc);
    }
  }

  /** Забыть webContents (вызывается ДО teardown — listener живёт не дольше wc). */
  forget(wcId: number): void {
    const p = this.participants.get(wcId);
    if (p) {
      try {
        p.wc.debugger.removeListener('message', p.onMessage);
      } catch {
        /* wc мог закрыться */
      }
    }
    this.participants.delete(wcId);
    this.captureLive.delete(wcId);
    this.suppressUntil.delete(wcId);
  }

  /** Забыть по id профиля (профиль удалён/вышел из сетки). */
  forgetProfile(profileId: string): void {
    for (const [wcId, p] of [...this.participants]) {
      if (p.profileId === profileId) this.forget(wcId);
    }
  }

  /**
   * Переустановка после devtools-closed: detach debugger'а убил binding
   * и регистрацию скрипта — выкидываем ячейку из состояний и регистрируем
   * заново (applyProfileEmulation уже прикрепил debugger).
   */
  reinstall(profileId: string, wc: WebContents): void {
    if (!this.enabled || wc.isDestroyed()) return;
    this.forget(wc.id);
    void this.register(profileId, wc);
  }

  // ------------------------------------------------------------------
  // Внутреннее
  // ------------------------------------------------------------------

  private detachListener(wcId: number): void {
    const p = this.participants.get(wcId);
    if (!p) return;
    try {
      p.wc.debugger.removeListener('message', p.onMessage);
    } catch {
      /* wc мог закрыться */
    }
    this.participants.delete(wcId);
  }

  private async register(profileId: string, wc: WebContents): Promise<void> {
    const wcId = wc.id;
    if (this.pending.has(wcId) || this.participants.has(wcId) || wc.isDestroyed()) return;
    this.pending.add(wcId);

    const tag = `[${profileId}] sync`;
    // Listener замыкается на wcId — обработчик смотрит актуальное состояние.
    const onMessage = (event: unknown, method: string, params?: unknown): void =>
      this.onBindingCalled(wcId, method, params);

    try {
      const dbg = wc.debugger;
      // Отладчик эмуляции мог быть занят окном DevTools — attach кинет
      // ошибку; ячейка выпадает из синхронизации до переустановки
      // (devtools-closed -> reinstall).
      if (!dbg.isAttached()) dbg.attach('1.3');

      dbg.on('message', onMessage);
      this.participants.set(wcId, { profileId, wc, onMessage });

      // Захват (binding + скрипт) — если его ещё нет на этом debugger'е.
      if (!this.captureLive.has(wcId)) {
        try {
          await dbg.sendCommand('Runtime.enable');
          await dbg.sendCommand('Runtime.addBinding', { name: BINDING });
          await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SCRIPT });
          // Для уже открытой страницы — установка немедленно.
          await dbg.sendCommand('Runtime.evaluate', {
            expression: CAPTURE_SCRIPT,
            userGesture: true,
          });
          if (wc.isDestroyed()) {
            this.forget(wcId);
            return;
          }
          this.captureLive.set(wcId, wc);
          this.log.info(`${tag} захват ввода активен`);
        } catch (err) {
          this.log.warn(`${tag} захват не установлен: ${String(err)}`);
        }
      }
    } catch (err) {
      this.log.warn(`${tag} не удалось подключиться к CDP (открыт DevTools?): ${String(err)}`);
      // Не участник — чистим за собой.
      try {
        wc.debugger.removeListener('message', onMessage);
      } catch {
        /* ignore */
      }
      this.participants.delete(wcId);
    } finally {
      this.pending.delete(wcId);
    }
  }

  /** Сообщение биндинга от страницы одной из ячеек. */
  private onBindingCalled(wcId: number, method: string, params?: unknown): void {
    if (!this.enabled) return;
    if (method !== 'Runtime.bindingCalled') return;
    const p = params as { name?: string; payload?: string } | undefined;
    if (!p || p.name !== BINDING || typeof p.payload !== 'string') return;

    // Подавление эха: синтетические события в этой ячейке в окне после dispatch.
    const until = this.suppressUntil.get(wcId) ?? 0;
    if (Date.now() < until) {
      this.echoDropped++;
      return;
    }

    const msg = parseSyncPayload(p.payload);
    if (!msg) return;

    // Ретрансляция во все ДРУГИЕ живые ячейки.
    for (const [targetId, target] of this.participants) {
      if (targetId === wcId) continue;
      if (target.wc.isDestroyed()) continue;
      this.dispatchTo(targetId, target.wc.debugger, msg);
    }
  }

  /** Dispatch с окном подавления и защитой от мёртвого таргета. */
  private dispatchTo(wcId: number, dbg: Debugger, msg: SyncMessage): void {
    let params: Record<string, unknown>;
    let command: string;
    if (msg.t === 'kd' || msg.t === 'ku') {
      params = buildKeyParams(msg);
      command = 'Input.dispatchKeyEvent';
    } else {
      params = buildMouseParams(msg);
      command = 'Input.dispatchMouseEvent';
    }

    this.suppressUntil.set(wcId, Date.now() + SUPPRESS_MS);
    void dbg.sendCommand(command, params).catch(() => {
      // «target closed» и пр. — ячейка могла закрыться; молчим,
      // следующих итераций не будет (участник забыт при teardown).
    });
  }

  /** Для логов/диагностики: участники и погашенное эхо. */
  stats(): string {
    return `участников: ${this.participants.size}, эха погашено: ${this.echoDropped}`;
  }
}
