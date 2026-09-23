// Model layer. Every non-Chrome provider speaks the OpenAI-compatible
// /chat/completions API, so Ollama, LM Studio, OpenRouter and anything
// similar share one code path.

import { domainMatches } from './store.js';

export class LLMError extends Error {
  constructor(message, { status, kind } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // rate_limit | no_provider | needs_page | private | auth | cors | network | bad_output
  }
}

const trimUrl = (u) => String(u || '').replace(/\/+$/, '');
const inPage = typeof document !== 'undefined';

function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local');
  } catch { return false; }
}

// ---------- Chrome built-in AI (Gemini Nano, runs on device) ----------

// Chrome requires an explicit output language. Use the browser's language
// when Chrome supports it, otherwise English.
const CHROME_AI_LANGS = ['en', 'de', 'es', 'fr', 'ja'];
const uiLang = String(globalThis.navigator?.language || 'en').slice(0, 2).toLowerCase();
export const CHROME_AI_OUTPUT = CHROME_AI_LANGS.includes(uiLang) ? uiLang : 'en';

export const SUMMARIZER_OPTIONS = {
  type: 'tldr',
  format: 'plain-text',
  length: 'short',
  outputLanguage: CHROME_AI_OUTPUT,
  sharedContext: 'Web pages a person kept open in a browser tab to come back to later.',
};
const PROMPT_OUTPUT = { expectedOutputs: [{ type: 'text', languages: [CHROME_AI_OUTPUT] }] };

export async function chromeSummarizerStatus() {
  if (typeof globalThis.Summarizer === 'undefined') return 'unsupported';
  try { return await globalThis.Summarizer.availability(SUMMARIZER_OPTIONS); } catch { return 'unavailable'; }
}

export async function chromePromptStatus() {
  if (typeof globalThis.LanguageModel === 'undefined') return 'unsupported';
  try { return await globalThis.LanguageModel.availability(PROMPT_OUTPUT); } catch { return 'unavailable'; }
}

let summarizerPromise = null;

async function chromeSummarize(title, text) {
  summarizerPromise ||= globalThis.Summarizer.create(SUMMARIZER_OPTIONS);
  const s = await summarizerPromise;
  for (const limit of [6000, 2500]) {
    try {
      return (await s.summarize(text.slice(0, limit), { context: `Page title: ${title}` })).trim();
    } catch (e) {
      if (e.name !== 'QuotaExceededError') {
        summarizerPromise = null;
        throw new LLMError(`Chrome on-device AI failed: ${e.message}`);
      }
    }
  }
  throw new LLMError('The page is too long for Chrome on-device AI.');
}

async function chromePrompt(system, user) {
  const session = await globalThis.LanguageModel.create({ ...PROMPT_OUTPUT, initialPrompts: [{ role: 'system', content: system }] });
  try { return await session.prompt(user); } finally { session.destroy?.(); }
}

// ---------- Ollama reachability (cached so we don't ping on every item) ----------

let ollamaCache = { at: 0, ok: false, url: '' };

export async function ollamaReachable(url) {
  if (ollamaCache.url === url && Date.now() - ollamaCache.at < 60_000) return ollamaCache.ok;
  let ok = false;
  try {
    const r = await fetch(`${trimUrl(url)}/api/tags`, { signal: AbortSignal.timeout(1500) });
    ok = r.ok;
  } catch { /* not running */ }
  ollamaCache = { at: Date.now(), ok, url };
  return ok;
}

// ---------- Endpoint selection ----------

export async function endpointsFor(settings, { purpose }) {
  const ollama = {
    kind: 'openai', name: `Ollama (${settings.ollamaModel})`,
    baseUrl: `${trimUrl(settings.ollamaUrl)}/v1`, model: settings.ollamaModel, isOllama: true,
    // Ollama Cloud models (e.g. "qwen3.5:cloud") run on Ollama's servers, so they aren't private.
    local: !/(^|[:-])cloud$/i.test(settings.ollamaModel || ''),
  };
  const openrouter = settings.openrouterKey && settings.openrouterModel ? {
    kind: 'openai', name: `OpenRouter (${settings.openrouterModel})`,
    baseUrl: 'https://openrouter.ai/api/v1', model: settings.openrouterModel, apiKey: settings.openrouterKey,
    local: false, extraHeaders: { 'X-Title': 'Tab Shelf' },
  } : null;
  const custom = settings.customUrl && settings.customModel ? {
    kind: 'openai', name: `${settings.customModel}`,
    baseUrl: trimUrl(settings.customUrl), model: settings.customModel, apiKey: settings.customKey,
    local: isLocalUrl(settings.customUrl),
  } : null;

  const chromeStatus = purpose === 'summary' ? await chromeSummarizerStatus() : await chromePromptStatus();
  const chromeAI = chromeStatus === 'available'
    ? { kind: purpose === 'summary' ? 'chrome-summarizer' : 'chrome-prompt', name: 'Chrome on-device AI', local: true }
    : null;

  const list = [];
  switch (settings.provider) {
    case 'chrome': if (chromeAI) list.push(chromeAI); break;
    case 'ollama': list.push(ollama); break;
    case 'openrouter': if (openrouter) list.push(openrouter); break;
    case 'custom': if (custom) list.push(custom); break;
    default: // auto: the richest free option first, cloud last
      if (settings.ollamaModel && await ollamaReachable(settings.ollamaUrl)) list.push(ollama);
      if (chromeAI) list.push(chromeAI);
      if (custom) list.push(custom);
      if (openrouter) list.push(openrouter);
  }
  return list;
}

// ---------- Chat calls ----------

async function checkResponse(r, ep) {
  if (r.status === 429) throw new LLMError(`${ep.name} hit its rate limit. Retrying in a few minutes.`, { status: 429, kind: 'rate_limit' });
  if (r.status === 401 || r.status === 402) throw new LLMError(`${ep.name} rejected the API key (${r.status}).`, { status: r.status, kind: 'auth' });
  if (r.status === 403 && ep.isOllama) {
    throw new LLMError('Ollama blocked the request from the extension. Reload Tab Shelf in chrome://extensions; if that does not fix it, see the Ollama steps in Settings.', { status: 403, kind: 'cors' });
  }
  if (r.status === 404 && ep.isOllama) {
    throw new LLMError(`Ollama doesn't have the model "${ep.model}". Pick an installed model in Settings.`, { status: 404, kind: 'auth' });
  }
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new LLMError(`${ep.name} returned ${r.status}. ${t.slice(0, 200)}`, { status: r.status });
  }
}

async function post(ep, url, headers, body) {
  try {
    return await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  } catch (e) {
    throw new LLMError(`Couldn't reach ${ep.name}. ${e.message}`, { kind: 'network' });
  }
}

export async function openaiChat(ep, messages) {
  const headers = { 'Content-Type': 'application/json', ...(ep.extraHeaders || {}) };
  if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
  const r = await post(ep, `${ep.baseUrl}/chat/completions`, headers,
    { model: ep.model, messages, temperature: 0.2, stream: false });
  await checkResponse(r, ep);
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new LLMError(`${ep.name} returned an empty answer.`, { kind: 'bad_output' });
  return content;
}

// Ollama's native API can force output to match a JSON schema, which keeps
// small local models from answering in prose.
async function ollamaChat(ep, messages, schema) {
  const base = ep.baseUrl.replace(/\/v1$/, '');
  const r = await post(ep, `${base}/api/chat`, { 'Content-Type': 'application/json' }, {
    model: ep.model, messages, stream: false, think: false,
    format: schema || 'json', options: { temperature: 0.2 },
  });
  await checkResponse(r, ep);
  const data = await r.json();
  const content = data.message?.content;
  if (!content) throw new LLMError(`${ep.name} returned an empty answer.`, { kind: 'bad_output' });
  return content;
}

const chatJSON = (ep, messages, schema) => (ep.isOllama ? ollamaChat(ep, messages, schema) : openaiChat(ep, messages));

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' }, why_saved: { type: 'string' }, topic: { type: 'string' } },
  required: ['summary', 'why_saved', 'topic'],
};

const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    brief: { type: 'string' },
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, note: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' } } },
        required: ['name', 'note', 'ids'],
      },
    },
  },
  required: ['brief', 'clusters'],
};

const stripNoise = (t) => String(t).replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```[a-z]*|```/gi, '').trim();

export function parseJSON(text) {
  const cleaned = String(text)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```(?:json)?/g, '')
    .trim();
  const s = cleaned.indexOf('{');
  const e = cleaned.lastIndexOf('}');
  if (s < 0 || e <= s) throw new LLMError('The model did not return JSON.', { kind: 'bad_output' });
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch {
    throw new LLMError('The model returned malformed JSON.', { kind: 'bad_output' });
  }
}

const clipWords = (t, n) => {
  const words = String(t).split(/\s+/);
  return words.length > n ? words.slice(0, n).join(' ') + ' …' : String(t);
};

// ---------- Per-page summary ----------

const SUMMARY_SYSTEM = `You summarize web pages that someone kept open in a browser tab to come back to later.
Reply with only a JSON object and no other text:
{"summary": "2-3 plain sentences on what the page says or offers",
 "why_saved": "at most 8 words, a guess at the purpose, e.g. 'comparing pricing' or 'tutorial to follow later'",
 "topic": "a 1-4 word topic label"}`;

export async function summarizePage({ title, url, text }, settings, { isPrivate = false } = {}) {
  const all = await endpointsFor(settings, { purpose: 'summary' });
  const eps = all.filter((ep) => !isPrivate || ep.local);

  if (!eps.length) {
    if (all.length && isPrivate) throw new LLMError('Private site and no local model is available.', { kind: 'private' });
    // Chrome's on-device AI isn't exposed to the service worker; the shelf page handles it.
    if (!inPage && (settings.provider === 'chrome' || settings.provider === 'auto')) {
      throw new LLMError('Waiting for the shelf page to use on-device AI.', { kind: 'needs_page' });
    }
    throw new LLMError('No model is set up yet. Add one in Settings.', { kind: 'no_provider' });
  }

  const body = clipWords(text, settings.maxWords || 1500);
  let lastErr;
  for (const ep of eps) {
    try {
      if (ep.kind === 'chrome-summarizer') {
        return { summary: await chromeSummarize(title, body), reason: '', topic: '', provider: ep.name };
      }
      const out = await chatJSON(ep, [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `Title: ${title}\nURL: ${url}\n\nPage text:\n${body}` },
      ], SUMMARY_SCHEMA);
      let j;
      try { j = parseJSON(out); } catch {
        // The model answered in prose. That's still a usable summary.
        const prose = stripNoise(out).replace(/\s+/g, ' ');
        if (prose.length < 20) throw new LLMError(`${ep.name} returned an unusable answer.`, { kind: 'bad_output' });
        j = { summary: prose.slice(0, 600) };
      }
      if (!String(j.summary || '').trim()) throw new LLMError(`${ep.name} returned an empty summary.`, { kind: 'bad_output' });
      return {
        summary: String(j.summary || '').trim(),
        reason: String(j.why_saved || '').trim(),
        topic: String(j.topic || '').trim().slice(0, 40),
        provider: ep.name,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ---------- Shelf digest: topic groups + a short brief ----------

const DIGEST_SYSTEM = `You organize a person's saved browser tabs into a reading plan.
Group the pages into 3-10 topic clusters that reflect what the person is working on or researching.
Reply with only a JSON object and no other text:
{"brief": "3-5 sentences addressed to the person as 'you': what is on the shelf, what looks most time-sensitive or worth reading first, and what could probably be let go",
 "clusters": [{"name": "short topic name", "note": "one line on what this group is for", "ids": [1, 2]}]}
Use the page numbers as ids. Put each page in at most one cluster.`;

export async function buildDigest(items, settings) {
  const eps = await endpointsFor(settings, { purpose: 'digest' });
  let lastErr = null;

  for (const ep of eps) {
    const pool = items.filter((i) => ep.local || !domainMatches(i.host, settings.privateDomains));
    const small = ep.kind === 'chrome-prompt';
    const sample = pool.slice(0, small ? 40 : 150);
    const lines = sample.map((i, n) => {
      const extra = [i.topic && `topic: ${i.topic}`, i.note && `note: ${i.note}`].filter(Boolean).join('; ');
      return `${n + 1}. ${i.title} (${i.host})${extra ? ` [${extra}]` : ''}\n   ${(i.summary || '').slice(0, small ? 140 : 280)}`;
    }).join('\n');
    const user = `Here are ${sample.length} saved pages:\n\n${lines}`;

    try {
      const raw = small
        ? await chromePrompt(DIGEST_SYSTEM, user)
        : await chatJSON(ep, [{ role: 'system', content: DIGEST_SYSTEM }, { role: 'user', content: user }], DIGEST_SCHEMA);
      const j = parseJSON(raw);
      const seen = new Set();
      const clusters = (Array.isArray(j.clusters) ? j.clusters : [])
        .map((c) => ({
          name: String(c.name || 'Untitled').slice(0, 80),
          note: String(c.note || '').slice(0, 200),
          ids: (Array.isArray(c.ids) ? c.ids : [])
            .map((x) => sample[Number(x) - 1]?.id)
            .filter((id) => id && !seen.has(id) && seen.add(id)),
        }))
        .filter((c) => c.ids.length);
      if (!clusters.length) throw new LLMError(`${ep.name} returned no groups.`, { kind: 'bad_output' });
      return {
        heuristic: false,
        brief: String(j.brief || '').trim(),
        clusters,
        builtAt: Date.now(),
        itemCount: items.length,
        provider: ep.name,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  return heuristicDigest(items, lastErr || new LLMError('No model is set up for digests. Add one in Settings.'));
}

// Fallback grouping when no model is available: by topic label, else by site.
export function heuristicDigest(items, err = null) {
  const groups = new Map();
  for (const i of items) {
    const label = (i.topic || '').trim() || i.host || 'Other';
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name: label, note: '', ids: [] });
    groups.get(key).ids.push(i.id);
  }
  let clusters = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length);
  const singles = clusters.filter((c) => c.ids.length === 1);
  if (clusters.length > 12 && singles.length > 3) {
    clusters = clusters.filter((c) => c.ids.length > 1);
    clusters.push({ name: 'Everything else', note: '', ids: singles.flatMap((c) => c.ids) });
  }
  return {
    heuristic: true, brief: '', clusters, builtAt: Date.now(), itemCount: items.length,
    provider: 'site grouping', error: err ? err.message : null,
  };
}
