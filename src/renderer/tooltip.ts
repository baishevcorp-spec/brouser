/**
 * Renderer окна rich-тултипов (прозрачное always-on-top BrowserWindow).
 *
 * Main присылает tooltip:render {gen, title, body, theme}; карточка
 * отрисовывается в (0,0), её фактический размер (getBoundingClientRect)
 * уходит назад (tooltip:measured {gen, w, h}) — main ставит окну bounds
 * и показывает его. Шрифты системные — измерение синхронно корректно,
 * но ждём rAF, чтобы DOM гарантированно отрендерился.
 */

const api = window.tipApi;

const cardEl = document.getElementById('tip') as HTMLElement;
const titleEl = document.getElementById('tip-title') as HTMLElement;
const bodyEl = document.getElementById('tip-body') as HTMLElement;

api.onRender((data) => {
  document.documentElement.dataset.theme = data.theme;
  titleEl.textContent = data.title;
  if (data.body) {
    bodyEl.textContent = data.body;
    bodyEl.hidden = false;
  } else {
    bodyEl.textContent = '';
    bodyEl.hidden = true;
  }
  requestAnimationFrame(() => {
    // Карточка лежит в (0,0) — её прямоугольник = размер окна тултипа.
    const r = cardEl.getBoundingClientRect();
    api.measured(data.gen, Math.ceil(r.width), Math.ceil(r.height));
  });
});
