// Popup: kept deliberately light. It reads only small values from storage,
// never talks to a model, and shows the buttons before anything else loads.
import { allItems, getSettings, saveSettings, getQueueState, fmtBytes } from './store.js';
import { plural } from './ui.js';

const $ = (id) => document.getElementById(id);
const LIBRARY = chrome.runtime.getURL('library.html');
let winId = null;

async function stash(scope) {
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  $('result').textContent = 'Stashing…';
  try {
    winId ??= (await chrome.windows.getCurrent()).id;
    const res = await chrome.runtime.sendMessage({ type: 'stash', scope, windowId: winId, note: $('note').value.trim() });
    if (res?.error) $('result').textContent = `Couldn't stash: ${res.error}`;
    else if (!res?.count) $('result').textContent = 'Nothing to stash. Pinned tabs and browser pages stay open.';
    else { $('result').textContent = `Stashed ${plural(res.count, 'page')}${res.bytes ? `, freed about ${fmtBytes(res.bytes)}` : ''}.`; setTimeout(() => window.close(), 900); }
  } catch (e) {
    $('result').textContent = `Couldn't stash: ${e.message}`;
  }
  for (const b of document.querySelectorAll('button')) b.disabled = false;
}

$('stash-window').onclick = () => stash('window');
$('stash-tab').onclick = () => stash('tab');
$('stash-all').onclick = () => stash('all');
$('note').addEventListener('keydown', (e) => { if (e.key === 'Enter') stash('window'); });

$('open-shelf').onclick = async () => {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => (t.url || '').startsWith(LIBRARY));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: LIBRARY });
  }
  window.close();
};

function showPause(paused) {
  $('pause').textContent = paused ? 'Resume summaries' : 'Pause summaries';
  $('pause').onclick = async () => { await saveSettings({ pauseSummaries: !paused }); showPause(!paused); showModel(); };
}

async function showModel() {
  const [s, qs] = await Promise.all([getSettings(), getQueueState()]);
  const names = { auto: 'Automatic', ollama: `Ollama (${s.ollamaModel})`, chrome: 'Chrome on-device AI', openrouter: 'OpenRouter', custom: s.customModel || 'custom server' };
  $('model').textContent = s.pauseSummaries ? 'Summaries are paused.'
    : qs.lastError ? `Summaries paused: ${qs.lastError}`
    : `Summaries by ${names[s.provider] || s.provider}${s.idleOnly ? ', while you are away' : ''}.`;
  showPause(!!s.pauseSummaries);
}

// Fill in the numbers after the buttons are already usable.
(async () => {
  const win = await chrome.windows.getCurrent();
  winId = win.id;
  const [here, all] = await Promise.all([chrome.tabs.query({ windowId: win.id }), chrome.tabs.query({})]);
  $('n').textContent = here.length;
  $('n-label').textContent = here.length === 1 ? 'tab open in this window' : 'tabs open in this window';
  $('all').textContent = all.length > here.length ? `${all.length} across all windows` : '';
  $('stash-all').hidden = all.length === here.length;
  showModel();
  const onShelf = (await allItems()).filter((i) => !i.archived).length;
  $('shelf-count').textContent = onShelf ? `${plural(onShelf, 'page')} on your shelf` : 'Your shelf is empty';
})();
