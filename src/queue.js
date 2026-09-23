// Works through stashed pages that still need a summary. Runs from the
// service worker on an alarm, and from the shelf page while it's open
// (the page is where Chrome's on-device AI is available).

import { allItems, getSettings, getText, patchItem, getQueueState, setQueueState, domainMatches } from './store.js';
import { summarizePage } from './llm.js';

let running = false;
const CLAIM_MS = 3 * 60_000;
const LOCK_MS = 90_000;
const OWNER = (typeof document !== 'undefined' ? 'page-' : 'worker-') + Math.random().toString(36).slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only one context (service worker or a shelf tab) summarizes at a time,
// so the model never gets several requests at once.
async function takeLock() {
  const { queueLock } = await chrome.storage.local.get('queueLock');
  if (queueLock && queueLock.owner !== OWNER && queueLock.until > Date.now()) return false;
  await chrome.storage.local.set({ queueLock: { owner: OWNER, until: Date.now() + LOCK_MS } });
  return true;
}
async function releaseLock() {
  const { queueLock } = await chrome.storage.local.get('queueLock');
  if (queueLock?.owner === OWNER) await chrome.storage.local.remove('queueLock');
}

export async function processQueue({ budgetMs = 25_000, max = 4, respectIdle = false } = {}) {
  if (running) return;
  running = true;
  const start = Date.now();
  let locked = false;
  try {
    const settings = await getSettings();
    if (settings.pauseSummaries) return;
    if (respectIdle && settings.idleOnly && chrome.idle) {
      const st = await chrome.idle.queryState(60);
      if (st === 'active') return; // you're using the computer; try again later
    }
    const qs = await getQueueState();
    if (qs.backoffUntil && qs.backoffUntil > Date.now()) return;
    if (!(locked = await takeLock())) return;

    const pending = (await allItems())
      .filter((i) => i.status === 'pending' && !i.archived && !(i.claimedAt && Date.now() - i.claimedAt < CLAIM_MS))
      .sort((a, b) => a.stashedAt - b.stashedAt);

    let done = 0;
    for (const item of pending) {
      if (done >= max || Date.now() - start > budgetMs) break;
      if ((await getSettings()).pauseSummaries) break;
      if (done) await sleep(1500); // give the machine room between pages
      await chrome.storage.local.set({ queueLock: { owner: OWNER, until: Date.now() + LOCK_MS } });
      await patchItem(item.id, { claimedAt: Date.now() });

      const text = await getText(item.id);
      if (!text || text.length < 200) {
        await patchItem(item.id, { status: 'no_text', claimedAt: null });
        continue;
      }

      const isPrivate = domainMatches(item.host, settings.privateDomains);
      try {
        const r = await summarizePage({ title: item.title, url: item.url, text }, settings, { isPrivate });
        await patchItem(item.id, {
          status: 'done', summary: r.summary, reason: r.reason, topic: r.topic,
          provider: r.provider, claimedAt: null, error: null,
        });
        await setQueueState({ lastError: null, lastRunAt: Date.now() });
        done++;
      } catch (e) {
        await patchItem(item.id, { claimedAt: null });
        if (e.kind === 'needs_page') break;
        if (e.kind === 'private') { await patchItem(item.id, { status: 'private_skipped' }); continue; }
        if (e.kind === 'rate_limit') { await setQueueState({ backoffUntil: Date.now() + 5 * 60_000, lastError: e.message }); break; }
        if (e.kind === 'no_provider') { await setQueueState({ lastError: e.message }); break; }

        const attempts = (item.attempts || 0) + 1;
        await patchItem(item.id, { attempts, status: attempts >= 3 ? 'error' : 'pending', error: e.message });
        // Connection problems block every page, so pause and say so. A bad answer
        // for one page stays on that page and the queue keeps going.
        if (['cors', 'auth', 'network'].includes(e.kind)) {
          await setQueueState({ lastError: e.message });
          break;
        }
      }
    }
  } finally {
    if (locked) await releaseLock();
    running = false;
  }
}
