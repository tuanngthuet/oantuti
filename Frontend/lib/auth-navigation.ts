const INTERNAL_ORIGIN = 'https://arena.internal';
/** Only navigate to application pages, never external hosts or auth/API loops. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/')
    || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return '/dashboard';
  try {
    const url = new URL(value, INTERNAL_ORIGIN);
    const decoded = decodeURIComponent(url.pathname);
    if (url.origin !== INTERNAL_ORIGIN || decoded.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(decoded)
      || /%(2f|5c|00|0a|0d)/i.test(decoded)
      || /^\/(login|register|api|_next)(\/|$)/.test(decoded)) return '/dashboard';
    return url.pathname + url.search + url.hash;
  } catch { return '/dashboard'; }
}
export function authLink(mode: 'login' | 'register', target: unknown) {
  return `/${mode}?${new URLSearchParams({ redirect: safeReturnTo(target) })}`;
}
