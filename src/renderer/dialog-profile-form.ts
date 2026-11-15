/**
 * Renderer диалога «Добавить профиль» (отдельное BrowserWindow).
 * Тема — из query (?theme), отправка формы — window.profileForm
 * (preload-profile-form.ts) поверх канала profile:add.
 */
import type { NewProfileInput } from '../main/types';
import { mountIcons } from './icons';

const api = window.profileForm;

const q = new URLSearchParams(window.location.search);
const theme = (q.get('theme') ?? 'dark') as 'dark' | 'teal' | 'light';

const formEl = document.getElementById('profile-form') as HTMLFormElement;
const fName = document.getElementById('f-name') as HTMLInputElement;
const fUrl = document.getElementById('f-url') as HTMLInputElement;
const fProxy = document.getElementById('f-proxy') as HTMLInputElement;
const fExt = document.getElementById('f-ext') as HTMLTextAreaElement;
const fUa = document.getElementById('f-ua') as HTMLInputElement;
const fTz = document.getElementById('f-tz') as HTMLInputElement;
const statusEl = document.getElementById('pf-status') as HTMLElement;
const saveBtn = document.getElementById('pf-save') as HTMLButtonElement;

document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.theme = theme;
  mountIcons();
  fName.focus();

  // Шапка-дубль с ✕ удалена: закрытие — нативным крестиком тайтл-бара,
  // Esc или «Отмена» внизу.
  document.getElementById('pf-cancel')?.addEventListener('click', () => api.closeWindow());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.closeWindow();
  });

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    const input: NewProfileInput = {
      name: fName.value.trim(),
      url: fUrl.value.trim(),
      proxy: fProxy.value.trim(),
      extensions: fExt.value,
      userAgent: fUa.value.trim(),
      timezone: fTz.value.trim(),
    };
    if (!input.name) {
      setStatus('err', 'Имя профиля обязательно');
      return;
    }
    saveBtn.disabled = true;
    void api
      .addProfile(input)
      .then((res) => {
        if (res.ok) {
          api.closeWindow(); // сетку обновит событие profiles-updated
        } else {
          setStatus('err', res.error ?? 'Профиль не создан');
          saveBtn.disabled = false;
        }
      })
      .catch((err) => {
        setStatus('err', String(err));
        saveBtn.disabled = false;
      });
  });
});

function setStatus(kind: 'ok' | 'err', text: string): void {
  statusEl.hidden = false;
  statusEl.classList.remove('ok', 'err');
  statusEl.classList.add(kind);
  statusEl.textContent = text;
}
