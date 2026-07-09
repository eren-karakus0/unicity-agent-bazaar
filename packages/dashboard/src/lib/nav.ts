/**
 * Clean path-based navigation (no hash). Relies on the SPA rewrite in
 * vercel.json so a deep link like /marketplace serves index.html.
 * e.g. go('/'), go('/marketplace'), go('/agent/@scout').
 */
export function go(path: string): void {
  if (path === location.pathname) return;
  history.pushState({}, '', path);
  // pushState doesn't emit popstate; nudge listeners so the app re-renders.
  window.dispatchEvent(new PopStateEvent('popstate'));
}
