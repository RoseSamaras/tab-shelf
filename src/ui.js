// Tiny DOM helper. Always sets text via textContent, never innerHTML,
// because page titles and summaries come from arbitrary websites.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)} min ago`;
  const hr = m / 60;
  if (hr < 24) return `${Math.floor(hr)} h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

export function faviconUrl(pageUrl) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', pageUrl);
  u.searchParams.set('size', '32');
  return u.toString();
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
