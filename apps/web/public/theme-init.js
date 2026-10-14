/* global document */
// Applies a stored theme override before first paint. Keep in sync with src/lib/theme.ts.
try {
  var oaTheme = localStorage.getItem('oa-theme');
  if (oaTheme === 'light' || oaTheme === 'dark') document.documentElement.dataset.theme = oaTheme;
} catch {
  // Storage blocked: follow the system theme.
}
