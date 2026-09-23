import { getSettings, saveSettings, parseDomainList, allItems, allTexts, getDigest } from './store.js';
import { chromeSummarizerStatus, summarizePage, openaiChat, SUMMARIZER_OPTIONS } from './llm.js';

const $ = (id) => document.getElementById(id);
const settings = await getSettings();

if (new URLSearchParams(location.search).has('welcome')) $('welcome').hidden = false;

let savedTimer;
function flash() {
  $('saved').classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => $('saved').classList.remove('on'), 1200);
}

function status(id, msg, bad = false) {
  $(id).textContent = msg;
  $(id).classList.toggle('bad', bad);
}

// ---------- Bind fields ----------

for (const f of document.querySelectorAll('[data-key]')) {
  const key = f.dataset.key;
  const isList = 'list' in f.dataset;
  if (f.type === 'checkbox') f.checked = !!settings[key];
  else if (isList) f.value = (settings[key] || []).join('\n');
  else f.value = settings[key] ?? '';

  f.addEventListener('change', async () => {
    let v;
    if (f.type === 'checkbox') v = f.checked;
    else if (isList) { v = parseDomainList(f.value); f.value = v.join('\n'); }
    else if (f.type === 'number') {
      v = Math.min(Number(f.max || Infinity), Math.max(Number(f.min || 0), Number(f.value) || 0));
      f.value = v;
    } else v = f.value.trim();
    await saveSettings({ [key]: v });
    flash();
  });
}

for (const r of document.querySelectorAll('input[name=provider]')) {
  r.checked = r.value === settings.provider;
  r.addEventListener('change', async () => { await saveSettings({ provider: r.value }); flash(); });
}

// ---------- Ollama ----------

const isCloudModel = (name) => /(^|[:-])cloud$/i.test(name);
const isTinyModel = (name) => /[:-](\d{2,3})m\b/i.test(name); // e.g. gemma3:270m

function describeModel(name) {
  if (isCloudModel(name)) return `${name} (runs on Ollama's servers, not this computer)`;
  if (isTinyModel(name)) return `${name} (very small, may give weak summaries)`;
  return name;
}

function fillOllamaSelect(models, current) {
  const sel = $('ollama-model');
  const names = models.map((m) => m.name);
  const opts = names.map((n) => Object.assign(document.createElement('option'), { value: n, textContent: describeModel(n) }));
  const installed = names.includes(current) || names.includes(`${current}:latest`);
  if (current && !installed) {
    opts.unshift(Object.assign(document.createElement('option'), { value: current, textContent: `${current} (not installed)` }));
  }
  sel.replaceChildren(...opts);
  sel.value = installed && !names.includes(current) ? `${current}:latest` : current;
}

function ollamaAdvice(name) {
  if (isCloudModel(name)) return ` Note: "${name}" is an Ollama Cloud model, so page text leaves this computer. Tab Shelf treats it like a cloud model and won't use it for your private sites.`;
  if (isTinyModel(name)) return ' Models this small often fail to return clean summaries. For better results run: ollama pull gemma3:4b';
  return '';
}

$('ollama-model').addEventListener('change', async () => {
  const name = $('ollama-model').value;
  await saveSettings({ ollamaModel: name });
  flash();
  status('ollama-status', `Using "${name}".${ollamaAdvice(name)}`, isTinyModel(name));
});

async function loadOllamaModels({ quiet = false } = {}) {
  const s = await getSettings();
  const base = s.ollamaUrl.replace(/\/+$/, '');
  fillOllamaSelect([], s.ollamaModel);
  if (!quiet) status('ollama-status', 'Checking…');
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (r.status === 403) {
      return status('ollama-status', 'Ollama is running but blocks the extension. Follow the steps under "If Ollama still blocks the extension", then refresh.', true);
    }
    if (!r.ok) return status('ollama-status', `Ollama answered with an error (${r.status}).`, true);
    const { models = [] } = await r.json();
    if (!models.length) return status('ollama-status', 'Connected, but no models are installed. Run: ollama pull gemma3:4b', true);

    // If the saved model isn't installed, switch to the best installed local one.
    const names = models.map((m) => m.name);
    let current = s.ollamaModel;
    if (!names.includes(current) && !names.includes(`${current}:latest`)) {
      const pick = [...models]
        .filter((m) => !isCloudModel(m.name))
        .sort((a, b) => (b.size || 0) - (a.size || 0))[0] || models[0];
      current = pick.name;
      await saveSettings({ ollamaModel: current });
    }
    fillOllamaSelect(models, current);

    // Listing models is a GET, which can pass even when real requests are blocked.
    // Test a POST like the ones summaries use.
    const probe = await fetch(`${base}/api/show`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: current }), signal: AbortSignal.timeout(5000),
    });
    if (probe.status === 403) {
      return status('ollama-status', 'Ollama lists models but blocks requests from the extension. Reload the extension in chrome://extensions and refresh this page. If it still fails, follow the steps under "If Ollama still blocks the extension".', true);
    }
    status('ollama-status', `Connected. ${models.length} model${models.length === 1 ? '' : 's'} installed. Using "${current}".${ollamaAdvice(current)}`, isTinyModel(current));
  } catch {
    status('ollama-status', `Can't reach Ollama at ${base}. Make sure it's running, then refresh.`, true);
  }
}

$('check-ollama').onclick = () => loadOllamaModels();
loadOllamaModels({ quiet: true });

// Reload the list when the address changes
document.querySelector('[data-key=ollamaUrl]').addEventListener('change', () => setTimeout(() => loadOllamaModels(), 50));

// ---------- Chrome on-device AI ----------

async function showChromeStatus() {
  const st = await chromeSummarizerStatus();
  const text = {
    unsupported: "This version of Chrome doesn't include the on-device Summarizer. It's available in Chrome 138 and later.",
    unavailable: "This device can't run Chrome's on-device model (it needs enough disk space, memory and a supported GPU or CPU).",
    downloadable: 'Supported. The model needs a one-time download of a few GB.',
    downloading: 'Downloading the on-device model…',
    available: 'Ready. Summaries can run on this computer.',
  }[st] || st;
  status('chrome-status', text, st === 'unsupported' || st === 'unavailable');
  $('chrome-download').hidden = st !== 'downloadable';
}

$('chrome-download').onclick = async () => {
  $('chrome-download').disabled = true;
  try {
    // Must run from a click: Chrome only starts the download on a user gesture.
    const s = await globalThis.Summarizer.create({
      ...SUMMARIZER_OPTIONS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => status('chrome-status', `Downloading… ${Math.round(e.loaded * 100)}%`));
      },
    });
    s.destroy?.();
  } catch (e) {
    status('chrome-status', `Download failed: ${e.message}`, true);
  }
  $('chrome-download').disabled = false;
  showChromeStatus();
};

showChromeStatus();

// ---------- OpenRouter ----------

$('load-or').onclick = async () => {
  status('or-status', 'Loading models…');
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8000) });
    const { data = [] } = await r.json();
    const free = data.filter((m) => m.id.endsWith(':free')).sort((a, b) => a.id.localeCompare(b.id));
    $('or-models').replaceChildren(...free.map((m) =>
      Object.assign(document.createElement('option'), { value: m.id, label: m.name || m.id })));
    status('or-status', `${free.length} free models loaded. Click the Model field to pick one.`);
  } catch (e) {
    status('or-status', `Couldn't load the model list. ${e.message}`, true);
  }
};

$('check-or').onclick = async () => {
  const s = await getSettings();
  if (!s.openrouterKey || !s.openrouterModel) return status('or-status', 'Add an API key and a model first.', true);
  status('or-status', 'Checking…');
  try {
    await openaiChat({
      name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: s.openrouterModel,
      apiKey: s.openrouterKey, extraHeaders: { 'X-Title': 'Tab Shelf' },
    }, [{ role: 'user', content: 'Reply with the single word OK.' }]);
    status('or-status', `Connected. ${s.openrouterModel} answered.`);
  } catch (e) {
    status('or-status', e.message, true);
  }
};

// ---------- Try a summary with the current settings ----------

const SAMPLE = `Pen plotters draw with a real pen instead of printing with ink droplets. Because a 3D printer already moves a head precisely in three axes, it can be converted into a plotter by mounting a pen holder next to the nozzle and sending drawing paths as G-code. The pen is lowered by moving the Z axis down a millimetre and lifted by moving it back up between strokes. Good results depend on a flat bed, a slightly flexible pen mount so the tip doesn't dig into the paper, and slower travel speeds than printing. Vector artwork from SVG files is converted into paths, optimised so the pen travels as little as possible between lines, and then streamed to the printer. Many makers use this to produce generative art, handwritten-style cards, or technical drawings with fineliners, markers, and even brush pens.`;

$('try').onclick = async () => {
  $('try').disabled = true;
  status('try-status', 'Summarizing…');
  try {
    const r = await summarizePage({ title: 'Turning a 3D printer into a pen plotter', url: 'https://example.com/plotter', text: SAMPLE }, await getSettings());
    const lines = [`Model: ${r.provider}`, `Summary: ${r.summary}`];
    if (r.reason) lines.push(`Likely kept for: ${r.reason}`);
    if (r.topic) lines.push(`Topic: ${r.topic}`);
    $('try-status').replaceChildren(...lines.map((l) => Object.assign(document.createElement('div'), { textContent: l })));
    $('try-status').classList.remove('bad');
  } catch (e) {
    status('try-status', e.message, true);
  }
  $('try').disabled = false;
};

// ---------- Export ----------

$('export').onclick = async () => {
  const [items, texts, digest] = await Promise.all([allItems(), allTexts(), getDigest()]);
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), items, texts, digest }, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `tab-shelf-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
