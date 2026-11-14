/**
 * Renderer диалога подтверждения удаления профиля (BrowserWindow).
 * id/имя/тема — из query; кнопка «Удалить» дёргает window.confirmDialog
 * (preload-confirm.ts) поверх канала profile:remove.
 */
import { mountIcons } from './icons';

const api = window.confirmDialog;

const q = new URLSearchParams(window.location.search);
const profileId = q.get('id') ?? '';
const profileName = q.get('name') ?? '';
const theme = (q.get('theme') ?? 'dark') as 'dark' | 'teal' | 'light';

const titleEl = document.getElementById('cfm-title') as HTMLElement;
const textEl = document.getElementById('cfm-text') as HTMLElement;
const statusEl = document.getElementById('cfm-status') as HTMLElement;
const deleteBtn = document.getElementById('cfm-delete') as HTMLButtonElement;

document.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.theme = theme;
  document.title = `Удалить профиль — ${profileName}`;
  titleEl.textContent = `Удалить профиль «${profileName}»?`;
  textEl.textContent =
    'Сессия, cookies и настройки профиля будут удалены безвозвратно. Файлы расширений на диске не трогаются.';
  mountIcons();
  deleteBtn.focus();

  document.getElementById('cfm-cancel')?.addEventListener('click', () => api.closeWindow());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.closeWindow();
  });

  deleteBtn.addEventListener('click', () => {
    if (!profileId || deleteBtn.disabled) return;
    deleteBtn.disabled = true;
    void api
      .removeProfile(profileId)
      .then((res) => {
        if (res.ok) {
          api.closeWindow(); // сетку обновит событие profiles-updated
        } else {
          setStatus(res.error ?? 'Профиль не удалён');
          deleteBtn.disabled = false;
        }
      })
      .catch((err) => {
        setStatus(String(err));
        deleteBtn.disabled = false;
      });
  });
});

function setStatus(text: string): void {
  statusEl.hidden = false;
  statusEl.classList.add('err');
  statusEl.textContent = text;
}
