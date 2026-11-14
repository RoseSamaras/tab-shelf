// AI Wrapped: runs on AI chat sites, only while AI Wrapped is switched on (the background registers this script
// when you turn it on and removes it when you turn it off).
//
// Light by design: nothing runs until you send a prompt. Then it reads the latest reply every 1.5 s until the
// reply stops changing, sends that one turn to the extension, and goes quiet again. No page observers, no
// network interception, nothing kept in memory between turns. The turn is stored on this computer only.
(() => {
  if (window.__tabShelfWrapped) return;
  window.__tabShelfWrapped = true;

  const host = location.hostname.replace(/^www\./, '');
  const isGoogle = /^google\.[a-z.]+$/.test(host);

  // Each site: where your messages and the replies are, and how to tell a reply is still being written.
  // Several selectors per field so a site redesign can fall back to an older layout.
  const SITES = [
    {
      engine: 'chatgpt',
      test: () => host === 'chatgpt.com' || host === 'chat.openai.com',
      user: ['[data-user-message-bubble="true"]', '[data-message-author-role="user"]'],
      reply: ['[data-dil-message-id]', '[data-message-author-role="assistant"]'],
      busy: () => !!document.querySelector('[data-talvt-turn-state]:not([data-talvt-turn-state="complete"]), button[data-testid="stop-button"], button[aria-label^="Stop"]'),
      conversation: () => (location.pathname.match(/\/c\/([\w-]+)/) || [])[1],
    },
    {
      engine: 'claude',
      test: () => host === 'claude.ai',
      user: ['[data-testid="user-message"]'],
      reply: ['[data-is-streaming]', '.font-claude-response'],
      busy: () => !!document.querySelector('[data-is-streaming="true"], button[aria-label^="Stop"]'),
      conversation: () => (location.pathname.match(/\/chat\/([\w-]+)/) || [])[1],
    },
    {
      engine: 'gemini',
      test: () => host === 'gemini.google.com',
      user: ['user-query .query-text', 'user-query'],
      reply: ['model-response message-content', 'model-response'],
      busy: () => !!document.querySelector('button[aria-label*="Stop"], .stop-icon'),
      conversation: () => (location.pathname.match(/\/app\/([\w-]+)/) || [])[1],
    },
    {
      engine: 'perplexity',
      test: () => host === 'perplexity.ai',
      user: ['[class*="group/query"]', 'h1'],
      reply: ['[id^="markdown-content"]', '.prose'],
      busy: () => !!document.querySelector('button[aria-label*="Stop"]'),
      conversation: () => (location.pathname.match(/\/search\/([\w.-]+)/) || [])[1],
      onLoad: true,
    },
    {
      engine: 'copilot',
      test: () => host === 'copilot.microsoft.com',
      user: ['[data-content="user-message"]', '[class*="user-message"]'],
      reply: ['[data-content="ai-message"]', '[class*="ai-message"]'],
      busy: () => !!document.querySelector('button[aria-label*="Stop"], button[title*="Stop"]'),
      conversation: () => (location.pathname.match(/\/chats\/([\w-]+)/) || [])[1],
    },
    {
      engine: 'deepseek',
      test: () => host === 'chat.deepseek.com',
      user: ['[class*="user-message"]', '[data-role="user"]'],
      reply: ['.ds-markdown', '[class*="markdown"]'],
      busy: () => !!document.querySelector('[class*="stop"] svg, button[aria-label*="Stop"]'),
      conversation: () => (location.pathname.match(/\/s\/([\w-]+)/) || [])[1],
    },
    {
      engine: 'grok',
      test: () => host === 'grok.com',
      user: ['[class*="message-bubble"][class*="user"]', '.items-end .message-bubble'],
      reply: ['.items-start .message-bubble', '[class*="response-content"]'],
      busy: () => !!document.querySelector('button[aria-label*="Stop"]'),
      conversation: () => (location.pathname.match(/\/(?:c|chat)\/([\w-]+)/) || [])[1],
    },
    {
      // Google AI Mode only (udm=50). Ordinary Google searches are never read.
      engine: 'google_ai_mode',
      test: () => isGoogle && location.pathname === '/search' && new URLSearchParams(location.search).get('udm') === '50',
      user: [],
      reply: ['[data-subtree="aimc"]', '[data-container-id="main-col"]', '#aim-chrome-initial-inline-async-container', 'div[role="main"]'],
      busy: () => !!document.querySelector('button[aria-label*="Stop"]'),
      conversation: () => new URLSearchParams(location.search).get('q') || '',
      promptFromUrl: () => new URLSearchParams(location.search).get('q') || '',
      onLoad: true,
    },
  ];

  const site = SITES.find((s) => s.test());
  if (!site) return;

  const MAX_REPLY = 20_000;
  const MAX_PROMPT = 8_000;
  const POLL_MS = 1500;
  const STABLE_POLLS = 3;
  const GIVE_UP_MS = 4 * 60_000;
  // Screen-reader labels some sites put in front of each message.
  const LABELS = /^(you said:?|chatgpt said:?|gemini said|claude responded:?|copilot said:?)\s*/i;

  const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lastOf = (selectors) => {
    for (const sel of selectors) {
      const all = document.querySelectorAll(sel);
      if (all.length) return { el: all[all.length - 1], count: all.length };
    }
    return { el: null, count: 0 };
  };

  // The text you were about to send, read from the text box when you press Enter or the send button.
  let composerText = '';
  const editableText = (el) => {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return el.isContentEditable ? el.innerText || '' : '';
  };
  const activeComposer = () => {
    const a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.isContentEditable)) return a;
    return document.querySelector('form textarea, [contenteditable="true"][role="textbox"], .ProseMirror[contenteditable="true"], .ql-editor[contenteditable="true"], textarea');
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.altKey) return;
    const el = e.target;
    if (!el || !(el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const text = editableText(el);
    if (text.trim()) {
      composerText = text;
      watch();
    }
  }, true);

  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('button');
    if (!btn) return;
    const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('data-testid') || ''} ${btn.title || ''}`.toLowerCase();
    if (!/send|submit|ask|αποστολ|invia|trimite|küld|wyślij|senden|envoyer|enviar/.test(label)) return;
    const text = editableText(activeComposer());
    if (text.trim()) composerText = text;
    watch();
  }, true);

  function sources(el) {
    if (!el) return [];
    const out = new Set();
    for (const a of el.querySelectorAll('a[href^="http"]')) {
      try {
        const u = new URL(a.href);
        const h = u.hostname.replace(/^www\./, '');
        if (!h || h === host || h.endsWith('.' + host) || /(^|\.)google\.[a-z.]+$/.test(h) && u.pathname === '/search') continue;
        for (const p of [...u.searchParams.keys()]) if (/^utm_|^ref$|^fbclid$|^gclid$/.test(p)) u.searchParams.delete(p);
        out.add(u.origin + u.pathname);
      } catch {}
      if (out.size >= 30) break;
    }
    return [...out];
  }

  let watching = null;

  function watch() {
    if (watching) {
      watching.extendUntil = Date.now() + GIVE_UP_MS;
      return;
    }
    const startReply = lastOf(site.reply);
    const startText = startReply.el ? startReply.el.innerText : '';
    const startCount = startReply.count;
    watching = { extendUntil: Date.now() + GIVE_UP_MS };
    let lastText = '';
    let stable = 0;

    const tick = () => {
      if (!watching) return;
      if (Date.now() > watching.extendUntil) { watching = null; return; }
      const reply = lastOf(site.reply);
      const text = reply.el ? reply.el.innerText : '';
      // Wait for a new reply (more replies than before, or the last one changed).
      const isNew = reply.count > startCount || (text && text !== startText);
      if (!isNew || !text.trim()) { setTimeout(tick, POLL_MS); return; }
      if (text === lastText && !site.busy()) stable++;
      else stable = 0;
      lastText = text;
      if (stable < STABLE_POLLS) { setTimeout(tick, POLL_MS); return; }
      watching = null;
      send(reply.el, text);
    };
    setTimeout(tick, POLL_MS);
  }

  function send(replyEl, replyText) {
    const user = lastOf(site.user);
    const prompt = clean((user.el ? user.el.innerText : '') || composerText || (site.promptFromUrl ? site.promptFromUrl() : '')).replace(LABELS, '');
    composerText = '';
    if (!prompt) return;
    const turnIndex = Math.max(1, user.count);
    const conversation = site.conversation() || `page-${location.pathname}`;
    try {
      chrome.runtime.sendMessage({
        type: 'wrapped:turn',
        turn: {
          engine: site.engine,
          conversation: String(conversation).slice(0, 200),
          turnIndex,
          prompt: prompt.slice(0, MAX_PROMPT),
          reply: clean(replyText).replace(LABELS, '').slice(0, MAX_REPLY),
          links: sources(replyEl),
          at: Date.now(),
        },
      });
    } catch {
      // The extension was reloaded; this page keeps an old copy of the script. Nothing to do.
    }
  }

  // Sites where sending a prompt opens a new page (Google AI Mode, Perplexity's first question).
  if (site.onLoad) {
    const fresh = performance.getEntriesByType('navigation')[0];
    if (!fresh || fresh.type !== 'back_forward') watch();
  }
})();
