import {
  saveSettings,
  allItems, patchItem, putItems, deleteItems, getSettings, getDigest, setDigest,
  getQueueState, allTexts, isItemKey, isTextKey, getStats, fmtBytes,
} from './store.js';
import { buildDigest, heuristicDigest } from './llm.js';
import { processQueue } from './queue.js';
import { h, timeAgo, faviconUrl, plural } from './ui.js';

const STALE_MS = 30 * 86_400_000;
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

const state = {
  view: params.get('session') ? 'date' : 'topics',
  focus: params.get('session'),
  q: '',
  items: [],
  digest: null,
  queue: {},
  texts: null,
  building: false,
  digestError: null,
  stats: null,
};

async function load() {
  [state.items, state.digest, state.queue, state.stats] = await Promise.all([allItems(), getDigest(), getQueueState(), getStats()]);
  render();
}

function buckets() {
  const now = Date.now();
  const active = state.items.filter((i) => !i.archived);
  return {
    active,
    done: state.items.filter((i) => i.archived),
    stale: active.filter((i) => !i.openedCount && now - i.stashedAt > STALE_MS),
  };
}

function matches(i) {
  if (!state.q) return true;
  const hay = [i.title, i.url, i.summary, i.note, i.reason, i.topic].join(' ').toLowerCase();
  if (hay.includes(state.q)) return true;
  return !!(state.texts && state.texts[i.id]?.includes(state.q));
}

// ---------- Render ----------

function render() {
  const b = buckets();
  renderBrief(b.active);
  renderNotice(b.active);
  renderViews(b);
  renderContent(b);
}

function renderBrief(active) {
  const wrap = $('brief-wrap');
  wrap.replaceChildren();
  const d = state.digest;
  const btn = $('digest');
  btn.disabled = state.building || !active.length;
  btn.textContent = state.building ? 'Building digest…' : d ? 'Rebuild digest' : 'Build digest';
  const st = state.stats;
  if (st?.tabsClosed) {
    wrap.append(h('div', { class: 'freed' },
      h('span', { class: 'freed-num' }, fmtBytes(st.bytesFreed)),
      h('span', { class: 'freed-label' },
        `memory freed by closing ${plural(st.tabsClosed, 'tab')} since ${new Date(st.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}. `,
        h('span', { class: 'muted' }, 'A conservative estimate; Chrome usually used more.'))));
  }
  if (!active.length) return;

  if (d?.brief) {
    const added = active.filter((i) => i.stashedAt > d.builtAt).length;
    wrap.append(
      h('p', { class: 'brief' }, d.brief),
      h('p', { class: 'brief-meta muted' },
        `Digest built ${timeAgo(d.builtAt)} from ${plural(d.itemCount, 'page')} with ${d.provider}.`,
        added ? ` ${added} added since.` : ''),
    );
  } else {
    wrap.append(h('p', { class: 'brief' },
      `${plural(active.length, 'page')} on your shelf. Build a digest to group them by topic and get a short brief on what to read first.`));
  }
}

const settingsButton = () => h('button', { class: 'quiet', onclick: () => chrome.runtime.openOptionsPage() }, 'Open settings');

function renderNotice(active) {
  const n = $('notice');
  n.replaceChildren();
  const pending = active.filter((i) => i.status === 'pending').length;
  if (state.digestError) {
    n.append(h('div', { class: 'notice' },
      `Couldn't write a digest. ${state.digestError} Pages are grouped by site for now. `, settingsButton()));
  }
  if (pending && state.queue.lastError) {
    n.append(h('div', { class: 'notice' }, `Summaries paused. ${state.queue.lastError} `, settingsButton()));
  } else if (pending) {
    n.append(h('p', { class: 'muted small' }, `Summarizing ${plural(pending, 'page')}…`));
  }
}

function renderViews(b) {
  const tabs = [
    ['topics', 'Topics'],
    ['date', 'By date'],
    ['stale', `Stale (${b.stale.length})`],
    ['done', `Done (${b.done.length})`],
  ];
  $('views').replaceChildren(...tabs.map(([key, label]) =>
    h('button', {
      role: 'tab', 'aria-selected': String(state.view === key),
      onclick: () => { state.view = key; render(); },
    }, label)));
}

const EMPTY = {
  topics: 'Everything here is done. Stash some tabs to fill the shelf again.',
  date: 'Everything here is done. Stash some tabs to fill the shelf again.',
  stale: 'Nothing stale. You come back to what you save.',
  done: 'Pages you mark as done show up here.',
};

function renderContent(b) {
  const c = $('content');
  c.replaceChildren();

  if (!state.items.length) {
    c.append(h('div', { class: 'empty' },
      h('h2', {}, 'Nothing on the shelf yet'),
      h('p', {}, 'Click the Tab Shelf icon in the toolbar and choose Stash this window. Your tabs close, and each page waits here with a short summary.'),
      h('p', { class: 'muted' }, 'Shortcut: Alt+Shift+S stashes the current window.')));
    return;
  }

  const source = { topics: b.active, date: b.active, stale: b.stale, done: b.done }[state.view];
  const list = source.filter(matches);
  if (!list.length) {
    c.append(h('p', { class: 'empty muted' }, state.q ? `Nothing matches “${state.q}”.` : EMPTY[state.view]));
    return;
  }

  let shelves;
  if (state.view === 'topics') shelves = topicShelves(list);
  else if (state.view === 'date') shelves = dateShelves(list);
  else if (state.view === 'stale') {
    shelves = [{
      name: 'Not opened in 30 days',
      note: 'You stashed these over a month ago and never came back to them.',
      items: list,
      bulk: { label: 'Mark all as done', run: () => markDone(list) },
    }];
  } else {
    shelves = [{
      name: 'Done',
      items: list,
      bulk: {
        label: 'Delete all',
        run: () => { if (confirm(`Delete ${plural(list.length, 'page')} permanently?`)) deleteItems(list.map((i) => i.id)); },
      },
    }];
  }
  c.append(...shelves.map(shelfEl));

  if (state.focus) {
    const target = document.querySelector(`[data-session="${CSS.escape(state.focus)}"]`);
    if (target) { target.classList.add('highlight'); target.scrollIntoView({ block: 'start' }); }
    state.focus = null;
  }
}

function topicShelves(list) {
  const stored = state.digest;
  const d = stored || heuristicDigest(list);
  const byId = new Map(list.map((i) => [i.id, i]));
  const used = new Set();
  const out = [];

  if (stored) {
    const fresh = list.filter((i) => i.stashedAt > stored.builtAt);
    if (fresh.length) {
      out.push({ name: 'Added since the last digest', note: 'Rebuild the digest to sort these into topics.', items: fresh });
      fresh.forEach((i) => used.add(i.id));
    }
  }
  for (const cl of d.clusters) {
    const its = cl.ids.map((id) => byId.get(id)).filter((i) => i && !used.has(i.id));
    its.forEach((i) => used.add(i.id));
    if (its.length) out.push({ name: cl.name, note: cl.note, items: its });
  }
  const rest = list.filter((i) => !used.has(i.id));
  if (rest.length) out.push({ name: 'Not grouped yet', items: rest });
  return out;
}

const fmtDate = (ts) => new Date(ts).toLocaleString(undefined, {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

function dateShelves(list) {
  const m = new Map();
  for (const i of list) {
    const k = i.sessionId || i.id;
    if (!m.has(k)) {
      m.set(k, { sessionId: k, name: i.sessionLabel ? `${i.sessionLabel}, ${fmtDate(i.stashedAt)}` : fmtDate(i.stashedAt), items: [] });
    }
    m.get(k).items.push(i);
  }
  return [...m.values()];
}

const sumBytes = (items) => items.reduce((n, i) => n + (i.memBytes || 0), 0);

function shelfEl(s) {
  const doneView = state.view === 'done';
  const actions = h('div', { class: 'actions' });
  if (!doneView && s.items.length > 1) {
    actions.append(h('button', { class: 'quiet', onclick: () => openAll(s.items) }, `Open all ${s.items.length}`));
  }
  if (s.bulk) actions.append(h('button', { class: 'quiet', onclick: s.bulk.run }, s.bulk.label));
  return h('section', { class: 'shelf', 'data-session': s.sessionId || null },
    h('div', { class: 'shelf-head' }, h('h2', {}, s.name),
      h('span', { class: 'count' }, s.sessionId && sumBytes(s.items) ? `${s.items.length}, freed ~${fmtBytes(sumBytes(s.items))}` : String(s.items.length)),
      actions),
    s.note ? h('p', { class: 'shelf-note' }, s.note) : null,
    s.items.map((i) => itemEl(i, doneView)));
}

function statusText(i) {
  switch (i.status) {
    case 'pending': return 'Summary on the way.';
    case 'no_text': return 'No snapshot. The tab was asleep or the page had no readable text.';
    case 'error': return `Couldn't summarize. ${i.error || ''}`;
    case 'private_skipped': return 'Private site, so it was not sent to a cloud model. Set up Ollama or Chrome on-device AI to summarize it.';
    default: return '';
  }
}

function metaLine(i) {
  const parts = [i.host || 'page', `${i.auto ? 'auto-stashed' : 'stashed'} ${timeAgo(i.stashedAt)}`];
  if (i.memBytes) parts.push(`freed ~${fmtBytes(i.memBytes)}`);
  if (i.openedCount) parts.push(`opened ${i.openedCount}×`);
  return parts.join(', ');
}

const btn = (label, onclick) => h('button', { class: 'quiet', onclick }, label);

function itemEl(i, doneView) {
  const acts = h('div', { class: 'row-actions' });
  if (doneView) {
    acts.append(btn('Restore', () => patchItem(i.id, { archived: false })), btn('Delete', () => deleteItems([i.id])));
  } else {
    if (i.status === 'error' || i.status === 'private_skipped') {
      acts.append(btn('Retry', async () => { await patchItem(i.id, { status: 'pending', attempts: 0, error: null }); pump(); }));
    }
    acts.append(btn('Open', () => openItem(i)), btn('Done', () => patchItem(i.id, { archived: true, archivedAt: Date.now() })));
  }
  const why = i.note ? `Your note: ${i.note}` : i.reason ? `Likely kept for: ${i.reason}` : '';
  const text = i.summary || statusText(i);
  return h('article', { class: 'item' },
    h('img', { src: faviconUrl(i.url), alt: '' }),
    h('div', {},
      h('a', { class: 'title', href: i.url, onclick: (e) => { e.preventDefault(); openItem(i); } }, i.title || i.url),
      h('div', { class: 'meta' }, metaLine(i))),
    acts,
    text ? h('p', { class: i.summary ? 'summary' : 'summary muted' }, text) : null,
    why ? h('p', { class: 'why' }, why) : null);
}

// ---------- Actions ----------

async function openItem(i) {
  await chrome.tabs.create({ url: i.url });
  await patchItem(i.id, { openedCount: (i.openedCount || 0) + 1, lastOpenedAt: Date.now() });
}

async function openAll(items) {
  if (items.length > 20 && !confirm(`Open ${items.length} tabs in a new window?`)) return;
  await chrome.windows.create({ url: items.map((i) => i.url) });
  const now = Date.now();
  await putItems(items.map((i) => ({ ...i, openedCount: (i.openedCount || 0) + 1, lastOpenedAt: now })));
}

async function markDone(items) {
  const now = Date.now();
  await putItems(items.map((i) => ({ ...i, archived: true, archivedAt: now })));
}

$('digest').onclick = async () => {
  state.building = true;
  state.digestError = null;
  render();
  try {
    const settings = await getSettings();
    const d = await buildDigest(state.items.filter((i) => !i.archived), settings);
    if (d.heuristic) state.digestError = d.error;
    else { await setDigest(d); state.digest = d; }
  } catch (e) {
    state.digestError = e.message;
  } finally {
    state.building = false;
    state.view = 'topics';
    render();
  }
};

$('settings').onclick = () => chrome.runtime.openOptionsPage();

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };
async function showTheme() {
  const t = (await getSettings()).theme || 'system';
  $('theme').textContent = THEME_LABEL[t];
  $('theme').onclick = async () => {
    const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    await saveSettings({ theme: next });
    showTheme();
  };
}
showTheme();

let searchTimer;
$('q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    state.q = e.target.value.trim().toLowerCase();
    if (state.q.length >= 3 && !state.texts) {
      const raw = await allTexts();
      state.texts = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v.toLowerCase()]));
    }
    render();
  }, 150);
});

// Live updates from the service worker and other shelf tabs
let reloadTimer;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.some(isTextKey)) state.texts = null;
  if (keys.some((k) => isItemKey(k) || k === 'digest' || k === 'queueState' || k === 'stats')) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 800);
  }
});

// While this page is open it also summarizes, which is what lets
// Chrome's on-device model (not available to the service worker) do the work.
async function pump() {
  if (document.visibilityState !== 'visible') return; // background tabs stay idle
  try { await processQueue({ budgetMs: 15_000, max: 3 }); } catch (e) { console.warn(e); }
}

await load();
pump();
setInterval(pump, 30_000);
document.addEventListener('visibilitychange', pump);
