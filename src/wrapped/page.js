// The AI Wrapped page: your summary, the turns waiting to be donated (edit labels, keep private, delete),
// past donations (withdraw), and exactly what the next donation will send.
// Captured text is only ever shown with textContent: nothing a web page wrote can run here.

import { getSettings } from '../store.js';
import {
  SITES, allTurns, patchTurn, deleteTurns, getDonations, getState, getLists, buildDonations,
  donateTurns, withdrawDonation, donatable, updateBadge,
} from './core.js';

const $ = (id) => document.getElementById(id);
const ENGINE = Object.fromEntries(SITES.map((s) => [s.engine, s.label]));
const nice = (id) => (id ? String(id).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const FALLBACK = {
  kinds: ['demand', 'task', 'chat'],
  stages: ['discovery', 'consideration', 'purchase', 'support'],
  demandCategories: ['recommend', 'compare', 'price', 'how_to', 'troubleshoot', 'reviews', 'alternatives', 'definition', 'where_to_buy', 'local', 'other'],
  taskCategories: ['coding', 'writing', 'translation', 'study', 'analysis', 'creative', 'advice', 'other_task'],
  industries: ['insurance', 'energy', 'banks', 'travel', 'telecom', 'beauty', 'fintech', 'health', 'food', 'retail', 'technology', 'software', 'education', 'automotive', 'real_estate', 'jobs', 'entertainment', 'home', 'legal', 'government', 'other'],
};
const KIND_NAMES = { demand: 'Looking for something', task: 'Getting work done', chat: 'Small talk' };

let view = new URLSearchParams(location.search).get('view') || 'waiting';
let settings;
let lists;
let brandNames = {};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

function countBy(items, key) {
  const m = new Map();
  for (const it of items) for (const v of [].concat(key(it) || [])) m.set(v, (m.get(v) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function fact(title, rows, name = nice, total) {
  if (!rows.length) return null;
  return el('div', { class: 'fact' },
    el('h3', { text: title }),
    el('ol', {}, rows.slice(0, 6).map(([k, n]) => el('li', {}, el('span', { text: name(k) }), el('span', { text: total ? `${Math.round((n / total) * 100)}%` : String(n) })))));
}

function timeLeft(ms) {
  if (ms <= 0) return 'any minute now';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h ? `in ${h} h ${m} min` : `in ${m} min`;
}

// ---------- Summary ----------

function renderSummary(turns) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const month = turns.filter((t) => t.at >= monthStart && t.labels);
  const wrap = $('summary');
  wrap.replaceChildren();
  if (!month.length) {
    wrap.append(el('p', { class: 'lede', text: settings.wrappedEnabled ? 'Nothing yet this month. Ask ChatGPT, Gemini, Claude or another AI something and it shows up here.' : '' }));
    return;
  }
  const demand = month.filter((t) => t.labels.kind === 'demand');
  const topCat = countBy(demand, (t) => t.labels.category)[0];
  const topInd = countBy(month, (t) => t.labels.industry)[0];
  const topEngine = countBy(month, (t) => t.engine)[0];
  const lede = [
    `${Math.round((demand.length / month.length) * 100)}% of what you asked was looking for something`,
    topCat ? `, most often ${nice(topCat[0]).toLowerCase()}` : '',
    topInd ? `. Your biggest topic: ${nice(topInd[0]).toLowerCase()}` : '',
    topEngine ? `. You used ${ENGINE[topEngine[0]] || topEngine[0]} most.` : '.',
  ].join('');
  wrap.append(
    el('div', { class: 'big-line' }, el('span', { class: 'big-num', text: String(month.length) }), el('span', { class: 'freed-label', text: `prompts this month, ${now.toLocaleString(undefined, { month: 'long' })}` })),
    el('p', { class: 'lede', text: lede }),
    el('div', { class: 'facts' },
      fact('What you use AI for', countBy(month, (t) => t.labels.kind), (k) => KIND_NAMES[k] || nice(k), month.length),
      fact('Where you ask', countBy(month, (t) => t.engine), (k) => ENGINE[k] || k, month.length),
      fact('Your buying questions', countBy(demand, (t) => t.labels.category)),
      fact('Topics', countBy(month, (t) => t.labels.industry)),
      fact('Brands you asked about', countBy(demand, (t) => t.labels.brands), (k) => brandNames[k] || k),
      fact('Brands AI named to you', countBy(demand, (t) => t.labels.answerBrands), (k) => brandNames[k] || k),
      fact('Sites AI cited most', countBy(month, (t) => t.labels.domains), (k) => k),
    ),
  );
}

// ---------- Turn rows ----------

function labelSelect(turn, field, options, allowEmpty) {
  const sel = el('select', { 'aria-label': nice(field) });
  if (allowEmpty) sel.append(el('option', { value: '', text: `No ${field}` }));
  for (const o of options) sel.append(el('option', { value: o, text: field === 'kind' ? KIND_NAMES[o] || nice(o) : nice(o) }));
  sel.value = turn.labels[field] || '';
  sel.addEventListener('change', async () => {
    const labels = { ...turn.labels, [field]: sel.value || undefined };
    if (field === 'kind') {
      labels.category = sel.value === 'demand' ? 'other' : sel.value === 'task' ? 'other_task' : 'other';
      labels.stage = sel.value === 'demand' ? 'discovery' : undefined;
      if (sel.value !== 'demand') { labels.brands = []; labels.answerBrands = []; }
    }
    const sensitive = !settings.wrappedSensitive && ['health', 'legal'].includes(labels.industry);
    await patchTurn(turn.id, { labels, edited: true, excluded: sensitive && !turn.included ? 'sensitive' : null });
    render();
  });
  return sel;
}

function turnRow(turn) {
  const tax = lists?.taxonomy || FALLBACK;
  const l = turn.labels || {};
  const prompt = el('p', { class: 'prompt', title: 'Click to show all', text: turn.textRemoved ? '(text removed after 30 days; only the labels are kept)' : turn.prompt });
  prompt.addEventListener('click', () => prompt.classList.toggle('open'));
  const meta = el('div', { class: 'meta' },
    el('span', { text: ENGINE[turn.engine] || turn.engine }),
    el('span', { text: new Date(turn.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }),
    l.turn === 'follow' ? el('span', { class: 'pill', text: 'follow-up' }) : null,
    turn.edited ? el('span', { class: 'pill', text: 'you edited the labels' }) : null,
    turn.excluded === 'sensitive' ? el('span', { class: 'pill warn', text: `Not donated: ${nice(l.industry).toLowerCase()} questions stay private` }) : null,
  );
  const children = [meta, prompt];
  if (!turn.textRemoved && (turn.reply || turn.links?.length)) {
    children.push(el('details', {},
      el('summary', { text: `Reply${l.domains?.length ? ` and ${plural(l.domains.length, 'cited site')}` : ''}` }),
      turn.reply ? el('div', { class: 'reply', text: turn.reply }) : null,
      l.domains?.length ? el('p', { class: 'chips', text: `Cited: ${l.domains.join(', ')}` }) : null));
  }
  const editable = turn.status === 'waiting' || turn.status === 'private';
  if (editable) {
    const cats = l.kind === 'demand' ? tax.demandCategories : l.kind === 'task' ? tax.taskCategories : ['other'];
    children.push(el('div', { class: 'labels' },
      labelSelect(turn, 'kind', tax.kinds, false),
      labelSelect(turn, 'category', cats, false),
      l.kind === 'demand' ? labelSelect(turn, 'stage', tax.stages, false) : null,
      l.kind !== 'chat' ? labelSelect(turn, 'industry', tax.industries, true) : null));
  } else {
    children.push(el('p', { class: 'chips', text: [KIND_NAMES[l.kind], nice(l.category), nice(l.stage), nice(l.industry)].filter(Boolean).join(' · ') }));
  }
  const asked = (l.brands || []).map((b) => brandNames[b] || b);
  const named = (l.answerBrands || []).map((b) => brandNames[b] || b);
  if (asked.length || named.length) {
    children.push(el('p', { class: 'chips', text: [asked.length ? `You asked about ${asked.join(', ')}` : '', named.length ? `AI named ${named.join(', ')}` : ''].filter(Boolean).join(' · ') }));
  }
  const actions = el('div', { class: 'actions' });
  if (turn.status === 'waiting') {
    if (turn.excluded === 'sensitive') actions.append(el('button', { class: 'quiet small', text: 'Donate this one anyway', onclick: async () => { await patchTurn(turn.id, { excluded: null, included: true }); render(); } }));
    actions.append(el('button', { class: 'quiet small', text: 'Keep private', onclick: async () => { await patchTurn(turn.id, { status: 'private' }); await updateBadge(); render(); } }));
  }
  if (turn.status === 'private' && !turn.withdrawnAt) {
    actions.append(el('button', { class: 'quiet small', text: 'Put back in the waiting list', onclick: async () => { await patchTurn(turn.id, { status: 'waiting' }); await updateBadge(); render(); } }));
  }
  if (turn.status !== 'donated') {
    actions.append(el('button', { class: 'quiet small', text: 'Delete', onclick: async () => { await deleteTurns([turn.id]); render(); } }));
  }
  children.push(actions);
  return el('article', { class: 'turn' }, children);
}

function byDay(turns) {
  const groups = new Map();
  for (const t of turns) {
    const day = new Date(t.at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(t);
  }
  return [...groups.entries()].flatMap(([day, list]) => [el('h2', { class: 'day', text: day }), ...list.map(turnRow)]);
}

// ---------- Views ----------

async function renderWaiting(turns) {
  const waiting = turns.filter((t) => t.status === 'waiting');
  const next = waiting.filter(donatable).map((t) => t.dueAt).sort((a, b) => a - b)[0];
  const intro = settings.wrappedMode === 'auto'
    ? next ? `These are donated automatically at midnight, the next ones ${timeLeft(next - Date.now())}. Before then you can change their labels, keep any of them private, or delete them.` : 'New prompts wait here until the first midnight at least 12 hours after you asked them.'
    : 'Nothing is sent until you press Donate now. Change labels, keep anything private, or delete it first.';
  return [el('p', { class: 'why muted', text: intro }), ...(waiting.length ? byDay(waiting) : [el('p', { class: 'empty', text: 'Nothing waiting.' })])];
}

async function renderDonated(turns) {
  const donations = await getDonations();
  const rows = donations.map((d) => {
    const btn = el('button', { class: 'quiet small', text: d.withdrawnAt ? 'Withdrawn' : 'Withdraw', disabled: !!d.withdrawnAt });
    let armed = false;
    btn.addEventListener('click', async () => {
      if (!armed) { armed = true; btn.textContent = 'Click again to remove it from the index'; return; }
      btn.disabled = true;
      btn.textContent = 'Withdrawing…';
      try { await withdrawDonation(d.id); render(); } catch (e) { btn.textContent = `Couldn't withdraw: ${e.message}`; }
    });
    return el('article', { class: 'turn' },
      el('div', { class: 'meta' }, el('span', { text: new Date(d.at).toLocaleString() }), el('span', { text: plural(d.count, 'prompt') }), el('span', { text: d.server.replace(/^https?:\/\//, '') })),
      el('p', { class: 'chips', text: `Withdrawal code ${d.code}${d.withdrawnAt ? ` · removed ${new Date(d.withdrawnAt).toLocaleDateString()}` : ''}` }),
      el('div', { class: 'actions' }, btn));
  });
  const donated = turns.filter((t) => t.status === 'donated');
  return [
    el('p', { class: 'why muted', text: 'Each donation has a withdrawal code kept only in this browser. Withdrawing removes those labels from the index for good.' }),
    ...(rows.length ? rows : [el('p', { class: 'empty', text: 'No donations yet.' })]),
    donated.length ? el('h2', { class: 'day', text: 'Donated prompts' }) : null,
    ...donated.slice(0, 200).map(turnRow),
  ];
}

async function renderPrivate(turns) {
  const kept = turns.filter((t) => t.status === 'private');
  return [el('p', { class: 'why muted', text: 'Never donated. They are deleted from this browser 30 days after you asked them.' }), ...(kept.length ? byDay(kept) : [el('p', { class: 'empty', text: 'Nothing kept private.' })])];
}

async function renderSent(turns) {
  const next = turns.filter(donatable);
  const donations = await buildDonations(next);
  const shown = donations.map((d) => ({ ...d.body, withdrawHash: '(made when it is sent)' }));
  return [
    el('p', { class: 'why muted', text: 'This is exactly what the next donation sends, and nothing else: labels from fixed lists, the sites the replies cited, and two codes that let the index count you once a month and ignore a prompt sent twice. Your prompts, the replies and anything about you stay here.' }),
    el('pre', { class: 'payload', text: next.length ? JSON.stringify(shown, null, 2) : 'Nothing waiting to be donated.' }),
  ];
}

const VIEWS = [
  ['waiting', 'Waiting', renderWaiting],
  ['donated', 'Donated', renderDonated],
  ['private', 'Kept private', renderPrivate],
  ['sent', 'What is sent', renderSent],
];

async function render() {
  settings = await getSettings();
  const [turns, state] = await Promise.all([allTurns(), getState()]);
  lists = await getLists();
  brandNames = Object.fromEntries((lists.brands || []).map((b) => [b.id, b.name]));

  const notice = $('notice');
  notice.replaceChildren();
  const say = (text) => notice.append(el('p', { class: 'notice', text }));
  if (!settings.wrappedEnabled) say('AI Wrapped is off. Turn it on in Settings → AI Wrapped to start counting your prompts.');
  else if (settings.wrappedPaused) say('AI Wrapped is paused. Nothing new is captured.');
  if (settings.wrappedEnabled && (!settings.wrappedCountry || settings.wrappedCountry === 'OTHER')) say('Pick your country in Settings → AI Wrapped so your prompts count toward it.');
  if (state.lastError) say(`Last donation didn't go through: ${state.lastError}`);

  renderSummary(turns);
  const counts = {
    waiting: turns.filter((t) => t.status === 'waiting').length,
    donated: turns.filter((t) => t.status === 'donated').length,
    private: turns.filter((t) => t.status === 'private').length,
  };
  const nav = $('views');
  nav.replaceChildren(...VIEWS.map(([id, name]) => el('button', {
    role: 'tab', 'aria-selected': String(view === id),
    text: counts[id] !== undefined ? `${name} (${counts[id]})` : name,
    onclick: () => { view = id; history.replaceState(null, '', `?view=${id}`); render(); },
  })));
  const fn = (VIEWS.find(([id]) => id === view) || VIEWS[0])[2];
  $('content').replaceChildren(...(await fn(turns)).filter(Boolean));

  const btn = $('donate-now');
  const n = turns.filter(donatable).length;
  btn.textContent = n ? `Donate ${plural(n, 'prompt')} now` : 'Nothing to donate';
  btn.disabled = !n || !settings.wrappedEnabled;
}

$('donate-now').addEventListener('click', async () => {
  const btn = $('donate-now');
  btn.disabled = true;
  btn.textContent = 'Donating…';
  try {
    const sent = await donateTurns(await allTurns());
    btn.textContent = `Donated ${plural(sent, 'prompt')}. Thank you.`;
    setTimeout(render, 1500);
  } catch (e) {
    btn.textContent = `Couldn't donate: ${e.message}`;
    setTimeout(render, 4000);
  }
});
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('to-shelf').addEventListener('click', () => { location.href = chrome.runtime.getURL('library.html'); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('turn:') || k === 'wrappedDonations')) render();
});

render();
