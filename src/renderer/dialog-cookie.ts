/**
 * Renderer диалога «Импорт cookies» (отдельное BrowserWindow).
 *
 * Данные профиля — из query (?id&name&host&visible&theme), команды — через
 * window.cookieDialog (preload-cookie.js). Логика повторяет прежнюю
 * HTML-модалку (валидация на месте, статус-строка, опциональная
 * перезагрузка ячейки), но окно больше не перекрывается WebContentsView.
 */
import type { CookieImportInput } from '../main/types';
import { mountIcons } from './icons';

const api = window.cookieDialog;

// ---------- Данные из query ----------
const q = new URLSearchParams(window.location.search);
const profileId = q.get('id') ?? '';
const profileName = q.get('name') ?? '';
const defaultHost = q.get('host') ?? '';
const profileVisible = q.get('visible') === '1';
const theme = (q.get('theme') ?? 'dark') as 'dark' | 'teal' | 'light';

// ---------- DOM ----------
const titleEl = document.getElementById('cf-title') as HTMLElement;
const formEl = document.getElementById('cookies-modal') as HTMLFormElement;
const textEl = document.getElementById('cf-text') as HTMLTextAreaElement;
const domainEl = document.getElementById('cf-domain') as HTMLInputElement;
const reloadEl = document.getElementById('cf-reload') as HTMLInputElement;
const statusEl = document.getElementById('cf-status') as HTMLElement;
const fileNameEl = document.getElementById('cf-file-name') as HTMLElement;
const browseBtn = document.getElementById('cf-browse') as HTMLButtonElement;
const importBtn = document.getElementById('cf-import') as HTMLButtonElement;

/** Импорт в процессе (кнопка/закрытие блокируются). */
let importing = false;

document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.theme = theme;
  document.title = `Импорт cookies — ${profileName}`;
  titleEl.textContent = `Импорт cookies — ${profileName}`;
  mountIcons();
  // Фильтр по умолчанию — хост профиля: из общего экспорта браузера
  // берём только куки «своего» сайта (avito.ru), остальное не тащим.
  domainEl.value = defaultHost;
  browseBtn.focus();
  bind();
});

function bind(): void {
  document.getElementById('cf-close')?.addEventListener('click', closeDialog);
  document.getElementById('cf-cancel')?.addEventListener('click', closeDialog);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDialog();
  });

  // Выбор файла в нативном диалоге: main читает его (≤ 10 МБ) и отдаёт
  // текст — кладём в textarea, чтобы перед импортом можно было посмотреть/подрезать.
  browseBtn.addEventListener('click', () => {
    if (importing) return;
    void api.pickFile().then((res) => {
      if (!res.ok) {
        if (res.error && res.error !== 'Отменено') setStatus('err', res.error);
        return;
      }
      textEl.value = res.content ?? '';
      fileNameEl.textContent = res.name ?? 'файл';
      setStatus('ok', `Загружен файл «${res.name}» — проверьте фильтр домена и нажмите «Импортировать»`);
    });
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!profileId || importing) return;
    const source = textEl.value.trim();
    if (!source) {
      setStatus('err', 'Вставьте cookies или выберите файл');
      return;
    }
    const input: CookieImportInput = {
      source,
      format: 'auto',
      domains: domainEl.value.trim(),
    };
    const doReload = reloadEl.checked;
    importing = true;
    importBtn.disabled = true;
    void api
      .importCookies(profileId, input)
      .then((res) => {
        if (res.ok) {
          const parts = [`Импортировано ${res.imported} из ${res.total}`];
          if (res.skippedDomain > 0) parts.push(`чужих доменов пропущено ${res.skippedDomain}`);
          if (res.expired > 0) parts.push(`истёкших пропущено ${res.expired}`);
          if (res.failed > 0) parts.push(`ошибок ${res.failed}`);
          setStatus('ok', `${parts.join(' — ')}. Можно закрыть окно.`);
          // Перезагрузка страницы: куки применяются к живому представлению.
          // Невидимому профилю перезагрузка не нужна — куки лягут в его
          // сессию и применятся при открытии ячейки.
          if (doReload && profileVisible) void api.reloadProfile(profileId);
        } else {
          setStatus('err', res.error ?? 'Импорт не удался');
        }
      })
      .catch((err) => {
        setStatus('err', String(err));
      })
      .finally(() => {
        importing = false;
        importBtn.disabled = false;
      });
  });
}

function closeDialog(): void {
  if (importing) return; // не закрывать посреди импорта
  api.closeWindow();
}

function setStatus(kind: 'ok' | 'err', text: string): void {
  statusEl.hidden = false;
  statusEl.classList.remove('ok', 'err');
  statusEl.classList.add(kind);
  statusEl.textContent = text;
}
