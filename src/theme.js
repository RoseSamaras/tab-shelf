// Applies the chosen theme (system, light or dark) before the page paints.
(function () {
  const KEY = 'tabshelf-theme';
  const apply = (t) => {
    const root = document.documentElement;
    if (t === 'light' || t === 'dark') root.dataset.theme = t;
    else delete root.dataset.theme; // follow the system setting
  };
  const remember = (t) => { try { localStorage.setItem(KEY, t); } catch {} };
  try { apply(localStorage.getItem(KEY) || 'system'); } catch {}
  chrome.storage.local.get('settings').then(({ settings }) => {
    const t = settings?.theme || 'system';
    apply(t); remember(t);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const t = changes.settings.newValue?.theme || 'system';
    apply(t); remember(t);
  });
})();
