// AI Wrapped core: stores captured turns on this computer, labels them, donates the labels (never the text)
// to the Open AI Demand Index, and keeps the local copy tidy. Used by the service worker and the AI Wrapped page.
//
// A turn's life:
//   waiting  → captured and labelled; you can edit its labels, keep it private or delete it
//   donated  → its labels were sent; the text stays here for 30 days (for your Wrapped), then only labels remain
//   private  → you chose never to donate it; deleted after 30 days
// Automatic mode donates each waiting turn at the first midnight at least 12 hours after it was asked.

import { getSettings } from '../store.js';
import { compileBrands, labelTurn } from './label.js';

export const SITES = [
  { engine: 'chatgpt', label: 'ChatGPT', matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'], tested: true },
  { engine: 'gemini', label: 'Gemini', matches: ['https://gemini.google.com/*'], tested: true },
  { engine: 'claude', label: 'Claude', matches: ['https://claude.ai/*'], tested: true },
  { engine: 'perplexity', label: 'Perplexity', matches: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'] },
  { engine: 'copilot', label: 'Microsoft Copilot', matches: ['https://copilot.microsoft.com/*'] },
  { engine: 'google_ai_mode', label: 'Google AI Mode', matches: ['google.com', 'google.gr', 'google.it', 'google.ro', 'google.bg', 'google.hr', 'google.hu', 'google.pl', 'google.de', 'google.co.uk', 'google.fr', 'google.es'].map((d) => `https://www.${d}/search*`) },
  { engine: 'deepseek', label: 'DeepSeek', matches: ['https://chat.deepseek.com/*'] },
  { engine: 'grok', label: 'Grok', matches: ['https://grok.com/*'] },
];

export const COUNTRIES = {
  GR: 'Greece', CY: 'Cyprus', IT: 'Italy', RO: 'Romania', BG: 'Bulgaria', HR: 'Croatia', HU: 'Hungary', PL: 'Poland',
  DE: 'Germany', AT: 'Austria', GB: 'United Kingdom', IE: 'Ireland', FR: 'France', ES: 'Spain', PT: 'Portugal',
  NL: 'Netherlands', BE: 'Belgium', CZ: 'Czechia', SK: 'Slovakia', SI: 'Slovenia', RS: 'Serbia', SE: 'Sweden',
  DK: 'Denmark', FI: 'Finland', NO: 'Norway', US: 'United States', OTHER: 'Somewhere else',
};

const LANGUAGE_COUNTRY = { el: 'GR', it: 'IT', ro: 'RO', bg: 'BG', hr: 'HR', hu: 'HU', pl: 'PL', de: 'DE', fr: 'FR', es: 'ES', pt: 'PT', nl: 'NL', cs: 'CZ', sk: 'SK', sl: 'SI', sr: 'RS', sv: 'SE', da: 'DK', fi: 'FI', nb: 'NO' };
export function guessCountry() {
  const lang = (navigator.language || '').split('-');
  const region = (lang[1] || '').toUpperCase();
  if (region && COUNTRIES[region]) return region;
  return LANGUAGE_COUNTRY[lang[0]] || '';
}

const TURN = 'turn:';
const DAY = 86_400_000;
const KEEP_TEXT_DAYS = 30;
const local = chrome.storage.local;

// ---------- Storage ----------

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomCode(n = 24) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  const s = [...bytes].map((b) => abc[b % abc.length]).join('');
  return s.match(/.{1,4}/g).join('-');
}

export async function getState() {
  const { wrappedState } = await local.get('wrappedState');
  if (wrappedState?.secret) return wrappedState;
  // The secret never leaves this computer. Hashes made from it let the server count you once per month
  // and ignore a turn sent twice, without knowing who you are.
  const fresh = { secret: crypto.randomUUID() + crypto.randomUUID(), createdAt: Date.now(), ...(wrappedState || {}) };
  await local.set({ wrappedState: fresh });
  return fresh;
}

export async function patchState(patch) {
  const cur = await getState();
  await local.set({ wrappedState: { ...cur, ...patch } });
}

export async function allTurns() {
  const keys = (local.getKeys ? await local.getKeys() : Object.keys(await local.get(null))).filter((k) => k.startsWith(TURN));
  if (!keys.length) return [];
  return Object.values(await local.get(keys)).sort((a, b) => b.at - a.at);
}

export async function putTurn(turn) {
  await local.set({ [TURN + turn.id]: turn });
}

export async function patchTurn(id, patch) {
  const k = TURN + id;
  const cur = (await local.get(k))[k];
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await local.set({ [k]: next });
  return next;
}

export async function deleteTurns(ids) {
  await local.remove(ids.map((id) => TURN + id));
  await updateBadge();
}

export async function getDonations() {
  return (await local.get('wrappedDonations')).wrappedDonations || [];
}

// ---------- Lists from the index ----------

export async function getLists({ force = false } = {}) {
  const s = await getSettings();
  const country = s.wrappedCountry && s.wrappedCountry !== 'OTHER' ? s.wrappedCountry : '';
  const { wrappedLists } = await local.get('wrappedLists');
  const fresh = wrappedLists && wrappedLists.country === country && wrappedLists.server === s.wrappedServer && Date.now() - wrappedLists.fetchedAt < DAY;
  if (fresh && !force) return wrappedLists;
  if (!country) return wrappedLists?.country === '' ? wrappedLists : { country: '', brands: [], fetchedAt: 0 };
  try {
    const res = await fetch(`${s.wrappedServer.replace(/\/$/, '')}/api/demand-index/lists?country=${country}`);
    if (!res.ok) throw new Error(`The index answered ${res.status}`);
    const data = await res.json();
    const lists = { country, server: s.wrappedServer, fetchedAt: Date.now(), brands: data.brands || [], taxonomy: data.taxonomy };
    await local.set({ wrappedLists: lists });
    return lists;
  } catch (e) {
    await patchState({ listsError: e.message });
    return wrappedLists || { country, brands: [], fetchedAt: 0 };
  }
}

let compiled = { key: '', brands: [] };
async function compiledBrands() {
  const lists = await getLists();
  const key = `${lists.country}:${lists.fetchedAt}`;
  if (compiled.key !== key) compiled = { key, brands: compileBrands(lists.brands || []) };
  return compiled.brands;
}

// ---------- Capturing ----------

/** The first local midnight at least 12 hours after the turn: your window to edit or delete it. */
export function dueAtFor(at) {
  const d = new Date(at + 12 * 3_600_000);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export function isSensitive(labels, settings) {
  return !settings.wrappedSensitive && ['health', 'legal'].includes(labels.industry);
}

export async function saveCapturedTurn(raw, settings) {
  const id = (await sha256(`${raw.engine}|${raw.conversation}|${raw.turnIndex}`)).slice(0, 24);
  const k = TURN + id;
  const prev = (await local.get(k))[k];
  // A turn already donated is not changed (a regenerated reply on an old turn stays as it was).
  if (prev && prev.status !== 'waiting') return prev;
  const labels = labelTurn(raw, await compiledBrands());
  const turn = {
    id,
    engine: raw.engine,
    turnIndex: raw.turnIndex,
    prompt: raw.prompt,
    reply: raw.reply,
    links: raw.links || [],
    at: prev?.at || raw.at,
    dueAt: prev?.dueAt || dueAtFor(raw.at),
    labels: prev?.edited ? prev.labels : labels,
    edited: !!prev?.edited,
    status: 'waiting',
    excluded: isSensitive(labels, settings) && !prev?.included ? 'sensitive' : null,
    included: !!prev?.included,
  };
  await putTurn(turn);
  await patchState({ [`lastCapture_${raw.engine}`]: Date.now() });
  await updateBadge();
  return turn;
}

/** Register (or remove) the capture script for the sites switched on, and start it in tabs already open. */
export async function syncCapture() {
  const s = await getSettings();
  const ids = ['wrapped-capture'];
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids });
  await updateBadge();
  if (!s.wrappedEnabled || s.wrappedPaused) return;
  const matches = SITES.filter((x) => s[`wrappedSite_${x.engine}`] !== false).flatMap((x) => x.matches);
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([{ id: 'wrapped-capture', matches, js: ['src/wrapped/capture.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
  const tabs = await chrome.tabs.query({ url: matches });
  for (const t of tabs) {
    chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['src/wrapped/capture.js'] }).catch(() => {});
  }
}

// ---------- Donating ----------

/** Exactly what is sent for one turn: fixed-list labels and two hashes. No text. */
export function donationItem(labels, itemKey) {
  const item = {
    itemKey,
    month: labels.month,
    engine: labels.engine,
    turn: labels.turn,
    kind: labels.kind,
    category: labels.category,
    brands: [...(labels.brands || [])],
    answerBrands: [...(labels.answerBrands || [])],
    domains: [...(labels.domains || [])],
  };
  if (labels.stage) item.stage = labels.stage;
  if (labels.industry) item.industry = labels.industry;
  if (labels.language) item.language = labels.language;
  return item;
}

/** The donation(s) these turns would make, one per month, with hashes filled in. Used for the preview too. */
export async function buildDonations(turns) {
  const s = await getSettings();
  const state = await getState();
  const brands = await compiledBrands();
  const byMonth = new Map();
  for (const t of turns) {
    const labels = t.edited ? t.labels : labelTurn(t, brands);
    const item = donationItem(labels, await sha256(`${state.secret}:item:${t.id}`));
    if (!byMonth.has(item.month)) byMonth.set(item.month, []);
    byMonth.get(item.month).push({ turnId: t.id, item });
  }
  const out = [];
  for (const [month, rows] of byMonth) {
    out.push({
      month,
      turnIds: rows.map((r) => r.turnId),
      body: {
        country: s.wrappedCountry,
        month,
        contributorKey: await sha256(`${state.secret}:month:${month}`),
        withdrawHash: '', // filled in when sent
        items: rows.map((r) => r.item),
      },
    });
  }
  return out;
}

export function donatable(t) {
  return t.status === 'waiting' && !t.excluded;
}

/** Donate these turns now. Returns how many were stored. */
export async function donateTurns(turns) {
  const s = await getSettings();
  if (!s.wrappedEnabled) throw new Error('AI Wrapped is off.');
  if (!s.wrappedCountry || s.wrappedCountry === 'OTHER') throw new Error('Pick your country in Settings → AI Wrapped first.');
  const list = turns.filter(donatable);
  if (!list.length) return 0;
  let sent = 0;
  for (const d of await buildDonations(list)) {
    for (let i = 0; i < d.body.items.length; i += 400) {
      const code = randomCode();
      const chunkIds = d.turnIds.slice(i, i + 400);
      const body = { ...d.body, items: d.body.items.slice(i, i + 400), withdrawHash: await sha256(code) };
      const res = await fetch(`${s.wrappedServer.replace(/\/$/, '')}/api/demand-index/donate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `The index answered ${res.status}`);
      const now = Date.now();
      for (const id of chunkIds) await patchTurn(id, { status: 'donated', donatedAt: now, donationCode: code });
      const donations = await getDonations();
      donations.unshift({ id: crypto.randomUUID(), at: now, month: d.month, count: chunkIds.length, code, server: s.wrappedServer, stored: data.stored, alreadyHad: data.alreadyHad });
      await local.set({ wrappedDonations: donations.slice(0, 200) });
      sent += chunkIds.length;
    }
  }
  await patchState({ lastError: null, lastDonationAt: Date.now() });
  await updateBadge();
  return sent;
}

/** Remove a donation from the index with its withdrawal code. */
export async function withdrawDonation(donationId) {
  const donations = await getDonations();
  const d = donations.find((x) => x.id === donationId);
  if (!d) throw new Error('Donation not found.');
  const res = await fetch(`${d.server.replace(/\/$/, '')}/api/demand-index/donate`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: d.code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The index answered ${res.status}`);
  d.withdrawnAt = Date.now();
  d.removed = data.removed;
  await local.set({ wrappedDonations: donations });
  for (const t of await allTurns()) if (t.donationCode === d.code) await patchTurn(t.id, { status: 'private', withdrawnAt: Date.now() });
  return data.removed;
}

// ---------- Scheduled work (service worker alarm) ----------

export async function donateDue() {
  const s = await getSettings();
  if (!s.wrappedEnabled || s.wrappedMode !== 'auto') return 0;
  const due = (await allTurns()).filter((t) => donatable(t) && t.dueAt <= Date.now());
  if (!due.length) return 0;
  try {
    return await donateTurns(due);
  } catch (e) {
    await patchState({ lastError: e.message, lastErrorAt: Date.now() });
    return 0;
  }
}

/** Text is kept 30 days for your Wrapped, then only labels stay. Never-reviewed and private turns go after 30 days. */
export async function housekeeping() {
  const cutoff = Date.now() - KEEP_TEXT_DAYS * DAY;
  const remove = [];
  for (const t of await allTurns()) {
    if (t.at > cutoff) continue;
    if (t.status === 'donated' && !t.textRemoved) await patchTurn(t.id, { prompt: '', reply: '', links: [], textRemoved: true });
    else if (t.status === 'private' || t.status === 'waiting') remove.push(t.id);
  }
  if (remove.length) await deleteTurns(remove);
}

export function weekSummary(turns, now = Date.now()) {
  const week = turns.filter((t) => t.at > now - 7 * DAY);
  const count = (key) => {
    const m = new Map();
    for (const t of week) { const v = key(t); if (v) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  return {
    total: week.length,
    demand: week.filter((t) => t.labels?.kind === 'demand').length,
    topCategory: count((t) => (t.labels?.kind === 'demand' ? t.labels.category : null))[0]?.[0],
    topIndustry: count((t) => t.labels?.industry)[0]?.[0],
    waiting: turns.filter(donatable).length,
  };
}

const WORDS = { compare: 'comparing', price: 'checking prices', recommend: 'asking for recommendations', how_to: 'asking how to', troubleshoot: 'fixing problems', reviews: 'checking reviews', alternatives: 'looking for alternatives', definition: 'asking what things are', where_to_buy: 'looking where to buy', local: 'looking for places nearby' };

export async function weeklyNotice() {
  const s = await getSettings();
  if (!s.wrappedEnabled) return;
  const state = await getState();
  if (state.lastWeeklyNotice && Date.now() - state.lastWeeklyNotice < 7 * DAY) return;
  const sum = weekSummary(await allTurns());
  await patchState({ lastWeeklyNotice: Date.now() });
  if (!sum.total) return;
  const what = sum.topCategory ? `, mostly ${WORDS[sum.topCategory] || sum.topCategory.replace('_', ' ')}${sum.topIndustry ? ` (${sum.topIndustry.replace('_', ' ')})` : ''}` : '';
  const next = sum.waiting
    ? s.wrappedMode === 'auto' ? ` ${sum.waiting} waiting: they're donated at midnight unless you change them.` : ` ${sum.waiting} waiting for you to review.`
    : '';
  chrome.notifications.create('wrapped-weekly', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: 'Your week with AI',
    message: `${sum.total} prompts this week${what}.${next}`,
    priority: 0,
  });
}

export async function updateBadge() {
  const s = await getSettings();
  if (!s.wrappedEnabled) { await chrome.action.setBadgeText({ text: '' }); return; }
  const waiting = (await allTurns()).filter(donatable).length;
  await chrome.action.setBadgeBackgroundColor({ color: '#15302a' });
  await chrome.action.setBadgeText({ text: waiting ? String(Math.min(waiting, 999)) : '' });
}
