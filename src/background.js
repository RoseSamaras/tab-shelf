import { allItems, getSettings, saveSettings, putItem, setText, setQueueState, addStats, hostOf, domainMatches } from './store.js';
import { processQueue } from './queue.js';

const LIBRARY = chrome.runtime.getURL('library.html');
const INTERNAL = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|devtools|view-source|chrome-search):/i;
const DAY = 86_400_000;

// ---------- Setup ----------

async function ensureAlarms() {
  if (!(await chrome.alarms.get('process'))) chrome.alarms.create('process', { periodInMinutes: 1 });
  if (!(await chrome.alarms.get('autostash'))) chrome.alarms.create('autostash', { periodInMinutes: 30 });
}

// Ollama rejects requests whose Origin is chrome-extension://…, which is why it
// normally needs OLLAMA_ORIGINS. Instead, rewrite the Origin header on this
// extension's own requests to Ollama so it sees a localhost origin it already trusts.
async function syncOllamaRule() {
  const s = await getSettings();
  let origin;
  try { origin = new URL(s.ollamaUrl).origin; } catch { return; }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'set', value: origin }] },
      condition: {
        urlFilter: `|${origin}/`,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    }],
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncOllamaRule();
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureAlarms();
  await syncOllamaRule();
  if (reason === 'update') {
    await setQueueState({ lastError: null, backoffUntil: 0 });
    await chrome.storage.local.remove('queueLock');
    const st = await getSettings();
    if (st.maxWords === 1500) await saveSettings({ maxWords: 800 });
  }
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('options.html?welcome=1') });
});
chrome.runtime.onStartup.addListener(() => { ensureAlarms(); syncOllamaRule(); });

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'process') return processQueue({ budgetMs: 45_000, respectIdle: true });
  if (a.name === 'autostash') return autoStash();
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'stash-window') return;
  const win = await chrome.windows.getLastFocused();
  await handleStash({ scope: 'window', windowId: win.id });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'stash') {
    handleStash(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg?.type === 'process') {
    processQueue().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------- Stashing ----------

async function handleStash({ scope, windowId, note = '' }) {
  let tabs;
  if (scope === 'tab') tabs = await chrome.tabs.query({ windowId, active: true });
  else if (scope === 'window') tabs = await chrome.tabs.query({ windowId });
  else tabs = await chrome.tabs.query({});
  return stashTabs(tabs, { note, homeWindowId: windowId, consolidate: scope === 'all' });
}

function stashable(tab, settings) {
  const url = tab.url || tab.pendingUrl || '';
  if (!url || INTERNAL.test(url) || url.startsWith(LIBRARY)) return false;
  if (settings.skipPinned && tab.pinned) return false;
  return true;
}

// Runs inside the page (isolated world) after Readability.js is injected.
function extractInPage(maxChars) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  // Conservative memory estimate: the page's JavaScript heap plus the decoded
  // size of everything it loaded. Chrome's real figure for a tab is usually higher.
  let memBytes = 0;
  try {
    memBytes += performance.memory?.usedJSHeapSize || 0;
    for (const e of performance.getEntriesByType('navigation')) memBytes += e.decodedBodySize || 0;
    for (const e of performance.getEntriesByType('resource')) memBytes += e.decodedBodySize || 0;
  } catch {}
  const withMem = (r) => ({ ...r, memBytes });
  try {
    // Cloning a huge page (web apps, endless feeds) is expensive; read its text directly instead.
    const big = document.getElementsByTagName('*').length > 8000;
    const article = !big && typeof Readability !== 'undefined' ? new Readability(document.cloneNode(true)).parse() : null;
    const text = clean(article?.textContent) || clean(document.body?.innerText);
    return withMem({ text: text.slice(0, maxChars), siteName: article?.siteName || '', title: article?.title || document.title });
  } catch {
    return withMem({ text: clean(document.body?.innerText).slice(0, maxChars), title: document.title });
  }
}

async function capture(tab) {
  // Sleeping (discarded) tabs have no live page to read; we keep the link only.
  if (tab.discarded || !/^https?:/i.test(tab.url || '')) return null;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['vendor/Readability.js'] });
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractInPage, args: [60_000] });
    return res?.result || null;
  } catch {
    return null; // e.g. Chrome Web Store pages, PDFs, pages still loading
  }
}

async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i]); }
  }));
  return out;
}

async function stashTabs(tabs, { note = '', auto = false, label = '', homeWindowId = null, consolidate = false } = {}) {
  const settings = await getSettings();
  const list = tabs.filter((t) => stashable(t, settings));
  if (!list.length) return { count: 0 };

  const sessionId = crypto.randomUUID();
  const now = Date.now();
  const openOnShelf = new Map((await allItems()).filter((i) => !i.archived).map((i) => [i.url, i]));

  // Capture page text before closing anything.
  const unique = [...new Map(list.map((t) => [t.url, t])).values()];
  const snaps = await mapLimit(unique, 3, capture);

  for (let k = 0; k < unique.length; k++) {
    const tab = unique[k];
    const snap = snaps[k];
    const prev = openOnShelf.get(tab.url);
    const id = prev?.id || crypto.randomUUID();
    const hasText = !!(snap?.text && snap.text.length >= 200);

    const item = {
      ...(prev || {}),
      id,
      url: tab.url,
      title: tab.title || snap?.title || tab.url,
      host: hostOf(tab.url),
      stashedAt: now,
      sessionId,
      sessionLabel: label,
      note: note || prev?.note || '',
      auto,
      archived: false,
      openedCount: prev?.openedCount || 0,
      lastOpenedAt: prev?.lastOpenedAt || null,
      memBytes: snap?.memBytes || 0, // 0 for sleeping tabs: Chrome had already freed them
    };
    if (hasText) {
      await setText(id, snap.text);
      Object.assign(item, { status: 'pending', attempts: 0, error: null, claimedAt: null });
    } else if (!prev) {
      Object.assign(item, { status: 'no_text', summary: '' });
    }
    await putItem(item);
  }

  // Never let a window vanish unexpectedly: if stashing empties it, put the shelf there.
  const closing = new Set(list.map((t) => t.id));
  const windowIds = [...new Set(list.map((t) => t.windowId))];
  const emptied = [];
  for (const wid of windowIds) {
    const inWin = await chrome.tabs.query({ windowId: wid });
    if (inWin.every((t) => closing.has(t.id))) emptied.push(wid);
  }
  const shelfUrl = `${LIBRARY}?session=${sessionId}`;
  if (consolidate) {
    const normal = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (normal.every((w) => emptied.includes(w.id))) {
      await chrome.tabs.create({ windowId: homeWindowId ?? emptied[0], url: shelfUrl });
    }
  } else {
    for (const wid of emptied) await chrome.tabs.create({ windowId: wid, url: shelfUrl });
  }

  await chrome.tabs.remove([...closing]);
  const bytes = snaps.reduce((sum, sn) => sum + (sn?.memBytes || 0), 0);
  await addStats({ tabs: closing.size, bytes });
  processQueue({ respectIdle: true });
  return { count: unique.length, sessionId, bytes };
}

// ---------- Auto-stash idle tabs ----------

async function autoStash() {
  const s = await getSettings();
  if (!s.autoStash) return;
  const cutoff = Date.now() - Math.max(1, s.autoStashDays) * DAY;
  const tabs = await chrome.tabs.query({});
  const idle = tabs.filter((t) =>
    !t.active && !t.audible && t.lastAccessed && t.lastAccessed < cutoff &&
    !domainMatches(hostOf(t.url), s.neverStashDomains));
  if (idle.length) {
    await stashTabs(idle, { auto: true, label: `Idle for ${s.autoStashDays}+ days` });
  }
}
