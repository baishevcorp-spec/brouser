/**
 * Разбор строки прокси профиля.
 *
 * Поддерживаемые форматы (все — опционально с логином:паролем):
 *   http://user:pass@host:port
 *   https://user:pass@host:port
 *   socks5://user:pass@host:port     (также socks4 и socks5h — нормализуем в socks5)
 *   host:port                        (прямая запись Chromium proxyRules)
 *   "http=host:80;https=host:80"     (пер-протокольные правила Chromium)
 *
 * Важно: Chromium proxyRules не поддерживает встроенные логин/пароль,
 * поэтому учётные данные вырезаются и подаются позже через событие
 * app('login') при первом 407-вызове прокси (см. ProfileManager.handleLogin).
 */
export interface ProxyInfo {
  /** Готовая строка proxyRules для session.setProxy(). */
  rules: string | null;
  /** Схема без учётных данных — для тултипов в UI. */
  scheme: string | null;
  username?: string;
  password?: string;
}

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export function parseProxy(input: string): ProxyInfo | null {
  const raw = (input || '').trim();
  if (!raw) return null;

  if (SCHEME_RE.test(raw)) {
    try {
      const u = new URL(raw);
      let scheme = u.protocol.replace(/:$/, '').toLowerCase();
      // Нормализация: socks и socks5h работают как socks5 в Chromium.
      if (scheme === 'socks' || scheme === 'socks5h') scheme = 'socks5';
      const defaultPort = scheme === 'https' ? '443' : scheme === 'http' ? '80' : '1080';
      const port = u.port || defaultPort;
      const info: ProxyInfo = {
        rules: `${scheme}://${u.hostname}:${port}`,
        scheme,
      };
      if (u.username) {
        info.username = safeDecode(u.username);
        info.password = safeDecode(u.password);
      }
      return info;
    } catch {
      // Странная строка — отдаём как есть, Chromium сам разберётся.
      return { rules: raw, scheme: null };
    }
  }

  // Формат без схемы: host:port или пер-протокольные правила Chromium.
  return { rules: raw, scheme: null };
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}
