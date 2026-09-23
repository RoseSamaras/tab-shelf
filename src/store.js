// Storage layer. Items and their text snapshots live in separate keys so the
// shelf list loads fast even when hundreds of full-page snapshots are stored.

export const DEFAULT_SETTINGS = {
  theme: 'system',        // system | light | dark
  provider: 'auto', // auto | chrome | ollama | openrouter | custom
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.1:8b',
  openrouterKey: '',
  openrouterModel: '',
  customUrl: '',
  customModel: '',
  customKey: '',
  autoStash: false,
  autoStashDays: 3,
  skipPinned: true,
  maxWords: 800,
  pauseSummaries: false,
  idleOnly: true,         // background summaries only while you're away from the keyboard
  privateDomains: [],     // never sent to a cloud model
  neverStashDomains: [],  // never auto-stashed
};

const ITEM = 'item:';
const TEXT = 'text:';
const local = chrome.storage.local;

export const isItemKey = (k) => k.startsWith(ITEM);
export const isTextKey = (k) => k.startsWith(TEXT);

async function keysWith(prefix) {
  const keys = local.getKeys ? await local.getKeys() : Object.keys(await local.get(null));
  return keys.filter((k) => k.startsWith(prefix));
}

export async function getSettings() {
  const { settings } = await local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await local.set({ settings: next });
  return next;
}

export async function allItems() {
  const keys = await keysWith(ITEM);
  if (!keys.length) return [];
  const got = await local.get(keys);
  return Object.values(got).sort((a, b) => b.stashedAt - a.stashedAt);
}

export async function getItem(id) {
  const k = ITEM + id;
  return (await local.get(k))[k] || null;
}

export async function putItem(item) {
  await local.set({ [ITEM + item.id]: item });
}

export async function putItems(items) {
  if (!items.length) return;
  await local.set(Object.fromEntries(items.map((i) => [ITEM + i.id, i])));
}

export async function patchItem(id, patch) {
  const cur = await getItem(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await putItem(next);
  return next;
}

export async function deleteItems(ids) {
  await local.remove(ids.flatMap((id) => [ITEM + id, TEXT + id]));
}

export async function getText(id) {
  const k = TEXT + id;
  return (await local.get(k))[k] || '';
}

export async function setText(id, text) {
  await local.set({ [TEXT + id]: text });
}

export async function allTexts() {
  const keys = await keysWith(TEXT);
  if (!keys.length) return {};
  const got = await local.get(keys);
  return Object.fromEntries(Object.entries(got).map(([k, v]) => [k.slice(TEXT.length), v]));
}

export async function getDigest() {
  return (await local.get('digest')).digest || null;
}

export async function setDigest(digest) {
  await local.set({ digest });
}

export async function getQueueState() {
  return (await local.get('queueState')).queueState || {};
}

export async function setQueueState(patch) {
  await local.set({ queueState: { ...(await getQueueState()), ...patch } });
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function parseDomainList(text) {
  return String(text || '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
    .filter(Boolean);
}

export function domainMatches(host, list = []) {
  const h = String(host || '').toLowerCase();
  return list.some((d) => h === d || h.endsWith('.' + d));
}

// Lifetime totals, kept separately so deleting pages doesn't erase them.
export async function getStats() {
  return (await local.get('stats')).stats || { tabsClosed: 0, bytesFreed: 0, since: null };
}

export async function addStats({ tabs = 0, bytes = 0 }) {
  const cur = await getStats();
  await local.set({ stats: {
    tabsClosed: cur.tabsClosed + tabs,
    bytesFreed: cur.bytesFreed + bytes,
    since: cur.since || Date.now(),
  } });
}

export function fmtBytes(b) {
  const mb = (b || 0) / 1_048_576;
  if (mb < 1) return 'under 1 MB';
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
