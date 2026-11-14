// AI Wrapped: labels a turn on this computer, choosing only from the fixed lists the index publishes
// (GET /api/demand-index/lists). The labels are what can be donated; the text never leaves the browser.
//
// Rules first (fast, no model): what kind of request it is, which part of the buying journey, which category
// and industry, which tracked brands the prompt and the reply name, which sites the reply cited.

const fold = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');

// Word lists are matched on folded text (no accents, lower case). Add words, never remove ids.
const W = {
  greeting: /^(hi|hello|hey|thanks|thank you|ok|γεια|γεια σου|ευχαριστω|ciao|grazie|salut|multumesc|bok|hvala|szia|koszonom|czesc|dziekuje|danke|hallo|merci|hola|gracias)[!. ]*$/,
  task: /\b(write|rewrite|draft|translate|summari[sz]e|proofread|paraphrase|fix (this|my)|debug|refactor|code|function|script|regex|sql|python|javascript|typescript|excel formula|essay|cover letter|email to|reply to|caption|poem|story|lyrics|γραψε|ξαναγραψε|μεταφρασε|μεταφραση|περιληψη|διορθωσε|κωδικα|εκθεση|ποιημα|scrivi|riscrivi|traduci|riassumi|scrie|traduce|rezuma|napisi|prevedi|irj|fordits|napisz|przetlumacz|schreib|ubersetze|ecris|traduis|escribe|traduce)\b/,
  coding: /\b(code|coding|function|script|regex|sql|python|javascript|typescript|java|c\+\+|php|react|css|html|api|bug|error|stack trace|compile|κωδικα|programm|kod)\b|```|=>|\bconst\b|\bdef\b/,
  translation: /\b(translate|translation|μεταφρασ|tradu|prevedi|fordit|przetlumacz|ubersetz)\w*/,
  writing: /\b(write|rewrite|draft|email|letter|post|caption|essay|bio|proofread|paraphrase|γραψε|επιστολη|σχεδιο|scrivi|scrie|napisi|irj|napisz|schreib|ecris|escribe)\w*/,
  study: /\b(homework|exam|assignment|explain|lesson|thesis|exercise|solve|equation|εξηγησε|ασκηση|εξετασ|διπλωματικ|compito|esame|tema|zadaca|hazi|zadanie|aufgabe)\w*/,
  analysis: /\b(analy[sz]e|analysis|data|spreadsheet|excel|chart|dataset|ανελυσ|αναλυσ|δεδομεν|analizz|analiz)\w*/,
  creative: /\b(poem|story|song|lyrics|joke|image of|draw|logo|ποιημα|ιστορια|τραγουδι|αστειο|poesia|storia|poezie|pjesma|vers|wiersz|gedicht)\w*/,
  advice: /\b(should i|what should i do|is it normal|advice|να κανω|τι να κανω|πρεπει να|dovrei|ar trebui|trebam li|kellene|powinienem|soll ich)\b/,

  compare: /\b(vs\.?|versus|compare|comparison|difference between|better than|or\b.*\?|συγκρι\w*|διαφορα|καλυτερ\w* απο|confront\w*|differenza|compar\w*|diferenta|usporedb\w*|razlika|osszehasonlit\w*|kulonbseg|porownan\w*|roznica|vergleich\w*|unterschied)\b/,
  price: /\b(price|prices|cost|costs|how much|cheap|cheapest|affordable|discount|deal|fee|fees|τιμη|τιμες|ποσο κανει|ποσο κοστιζει|κοστος|φθην\w*|προσφορ\w*|prezz\w*|quanto costa|economic\w*|pret\w*|cat costa|ieftin\w*|cijen\w*|koliko kosta|jeftin\w*|ar\b|mennyibe|olcso|cen\w*|ile kosztuje|tani\w*|preis\w*|wie viel kostet|gunstig\w*)\b/,
  whereToBuy: /\b(where (can i |to )?buy|where to get|in stock|order online|shop for|που (να )?αγορασω|που θα βρω|dove comprare|unde (pot )?cumpar|gdje kupiti|hol vehetek|gdzie kupic|wo kaufen)\b/,
  alternatives: /\b(alternative|alternatives|instead of|similar to|like \w+ but|εναλλακτικ\w*|αντι για|alternativ\w*|invece di|in loc de|umjesto|helyett|zamiast|statt)\b/,
  reviews: /\b(review|reviews|rating|ratings|reliable|trustworthy|legit|worth it|is \w+ good|κριτικ\w*|αξιοπιστ\w*|αξιζει|recension\w*|affidabil\w*|recenzi\w*|pouzdan\w*|velemeny\w*|megbizhato|opini\w*|bewertung\w*|zuverlassig)\b/,
  recommend: /\b(best|top|recommend|recommendation|suggest|which (one|is the best)|good (place|option)|καλυτερ\w*|προτειν\w*|συστησ\w*|migliore|migliori|consigli\w*|cel mai bun|cele mai bune|recomand\w*|najbolj\w*|preporu\w*|legjobb|ajanl\w*|najlepsz\w*|poleca\w*|beste|empfehl\w*|meilleur\w*|recommand\w*|mejor\w*)\b/,
  troubleshoot: /\b(not working|doesn'?t work|won'?t|error|problem|issue|broken|fix|cancel my|refund|complaint|δεν λειτουργει|δεν δουλευει|προβλημα|ακυρωσ\w*|επιστροφη χρηματων|non funziona|problema|nu functioneaza|ne radi|nem mukodik|nie dziala|funktioniert nicht)\b/,
  howTo: /\b(how (do|can|to|does)|steps to|guide|tutorial|πως (να|μπορω)|πως|come (si|posso)|cum (sa|pot)|kako|hogyan|jak\b|wie (kann|mache))\b/,
  definition: /\b(what is|what are|what does|meaning of|define|τι ειναι|τι σημαινει|cos'?e|che cos'?e|ce (este|inseamna)|sto je|mi az|co to jest|was ist)\b/,
  local: /\b(near me|nearby|in my area|open now|κοντα μου|κοντα σε|vicino a me|langa mine|u blizini|kozelben|w poblizu|in der nahe)\b/,
  question: /\?\s*$|^(what|which|who|where|when|why|how|is|are|can|do|does|should|τι|ποι\w*|που|ποτε|γιατι|πως|ποσο|che|quale|dove|perche|come|ce|care|unde|de ce|cum|sto|koji|gdje|zasto|kako|mi|melyik|hol|miert|hogyan|co|ktory|gdzie|dlaczego|jak|was|welche|wo|warum|wie)\b/,
};

const INDUSTRY_WORDS = {
  insurance: /\b(insurance|insurer|insure|premium|policy cover|ασφαλει\w*|ασφαλιστ\w*|assicura\w*|polizza|asigur\w*|rca|casco|osigur\w*|biztosit\w*|ubezpiecz\w*|oc\b|versicher\w*)\b/,
  energy: /\b(electricity|power bill|natural gas|gas bill|petrol|diesel|fuel|heating oil|solar panel|energy supplier|ρευμα|ηλεκτρικ\w* ενεργει\w*|φυσικο αεριο|βενζιν\w*|πετρελαι\w*|καυσιμ\w*|luce|bolletta|benzina|carburant\w*|curent|energie electric\w*|gaze|struja|plin\b|gorivo|aram|gaz|benzyn\w*|paliw\w*|prad|strom|heizol)\b/,
  banks: /\b(bank|banks|mortgage|loan|credit card|savings account|deposit rate|overdraft|τραπεζ\w*|στεγαστικ\w*|δανει\w*|πιστωτικ\w*|καταθεσ\w*|banca|mutuo|prestito|conto|credit\b|ipotecar\w*|kredit\w*|banka|hitel\w*|szamla|kredyt\w*|konto|hypothek)\b/,
  fintech: /\b(revolut|wise|paypal|send money|money transfer|transfer money abroad|crypto|bitcoin|broker|etf|stocks|investing app|neobank|buy now pay later|klarna|μεταφορα χρηματων|κρυπτο\w*|μετοχ\w*|επενδυσ\w*|bonifico|criptovalut\w*|investi\w*|transfer bani|investit\w*|kriptovalut\w*|ulaganj\w*|befektet\w*|kryptowalut\w*|inwesty\w*)\b/,
  travel: /\b(hotel|hotels|flight|flights|airline|airport|holiday|vacation|trip|itinerary|resort|cruise|hostel|airbnb|booking|ξενοδοχει\w*|πτησ\w*|αεροπορικ\w*|διακοπ\w*|ταξιδ\w*|κρουαζιερ\w*|albergo|volo|voli|vacanz\w*|viaggio|zbor\w*|vacant\w*|calatori\w*|hotel\w*|let\b|letov\w*|odmor|putovanj\w*|szalloda|repulo\w*|utazas|nyaralas|lot\b|loty|wakacj\w*|podroz\w*|urlaub|reise|flug)\b/,
  telecom: /\b(mobile plan|phone plan|data plan|sim card|esim|roaming|broadband|fibre|fiber|internet provider|isp|mobile operator|κινητη τηλεφωνι\w*|προγραμμα κινητ\w*|ιντερνετ|καρτα sim|tariff\w*|operator\w*|abonament\w*|internet\b|tarif\w*|operater\w*|mobilinternet|szolgaltato|abonament|siec komorkow\w*|handyvertrag)\b/,
  beauty: /\b(skincare|serum|moisturi[sz]er|sunscreen|spf|makeup|foundation|mascara|lipstick|shampoo|conditioner|hair mask|perfume|fragrance|cosmetic\w*|κρεμα|ορος|αντηλιακ\w*|μακιγιαζ\w*|σαμπουαν|αρωμα\w*|καλλυντικ\w*|crema|profumo|trucco|parfum\w*|machiaj|sampon|krema|sminka|szampon|perfum\w*|kosmetyk\w*|kosmetik)\b/,
  health: /\b(doctor|symptom\w*|pain|disease|diagnos\w*|medicine|medication|pill|dose|pregnan\w*|blood test|therapy|clinic|hospital|γιατρ\w*|συμπτωμ\w*|πονο\w*|ασθενει\w*|φαρμακ\w*|εγκυμοσυν\w*|εξετασεις αιματος|νοσοκομει\w*|medico|sintom\w*|dolore|farmac\w*|medic\b|simptom\w*|durere|lijecnik|bol\b|orvos|tunet\w*|gyogyszer|lekarz|objaw\w*|arzt|symptom)\b/,
  food: /\b(recipe|restaurant|dinner|lunch|cook|bake|vegan|calories|diet|συνταγ\w*|εστιατορι\w*|φαγητ\w*|μαγειρ\w*|ricett\w*|ristorante|reteta|restaurant|recept\w*|etterem|przepis\w*|restauracj\w*|rezept)\b/,
  automotive: /\b(car|cars|suv|ev\b|electric car|used car|car lease|tyres|tires|dealership|αυτοκινητ\w*|μεταχειρισμεν\w*|ελαστικ\w*|auto\b|automobil\w*|masin\w*|autoturism|automobil|auto\b|samochod\w*|opon\w*|gebrauchtwagen)\b/,
  real_estate: /\b(apartment|flat for rent|rent a|house for sale|real estate|property|landlord|tenant|διαμερισμα\w*|ενοικι\w*|ακινητ\w*|σπιτι προς|appartamento|affitto|immobil\w*|apartament\w*|chirie|imobiliar\w*|stan\b|najam|nekretnin\w*|lakas|alberlet|ingatlan|mieszkani\w*|wynajem|nieruchomo\w*|wohnung|miete)\b/,
  jobs: /\b(job|jobs|salary|cv|resume|interview|hiring|career|δουλει\w*|εργασι\w*|μισθ\w*|βιογραφικ\w*|συνεντευξ\w*|lavoro|stipendio|colloquio|loc de munca|salariu|interviu|posao|placa|allas|fizetes|praca|wynagrodzeni\w*|gehalt|bewerbung)\b/,
  education: /\b(university|degree|master'?s|course|online course|school|scholarship|language course|πανεπιστημι\w*|πτυχι\w*|μεταπτυχιακ\w*|σεμιναρι\w*|universita|corso|universitat\w*|curs\b|sveucilist\w*|tecaj|egyetem|tanfolyam|uniwersytet\w*|kurs\w*|studium)\b/,
  software: /\b(software|app|apps|saas|crm|tool for|plugin|extension|platform|εφαρμογ\w*|λογισμικ\w*|programm\w* per|aplicati\w*|aplikacij\w*|alkalmazas|aplikacj\w*|oprogramowani\w*)\b/,
  technology: /\b(laptop|phone|smartphone|iphone|android|tablet|headphones|tv|television|camera|monitor|router|λαπτοπ|κινητο τηλεφωνο|τηλεοραση|ακουστικ\w*|portatile|telefono|televisor\w*|telefon\w*|laptopul|televizor|mobitel|telefon|laptop\w*|telewizor|fernseher|handy)\b/,
  retail: /\b(buy|shop|store|online shop|delivery|e-?shop|αγορα|αγορασ\w*|καταστημα\w*|ηλεκτρονικο καταστημα|comprare|negozio|cumpar\w*|magazin\w*|kupiti|trgovin\w*|vasarol\w*|bolt\b|kupic|sklep\w*|kaufen|laden)\b/,
  home: /\b(furniture|sofa|mattress|renovation|kitchen|appliance|washing machine|garden|επιπλ\w*|στρωμα|ανακαινισ\w*|κουζιν\w*|πλυντηρι\w*|mobil\w*|materass\w*|ristruttura\w*|mobila|saltea|namjestaj|butor|meble|mobel)\b/,
  legal: /\b(lawyer|attorney|lawsuit|contract|legal|divorce|δικηγορ\w*|νομικ\w*|συμβολαι\w*|διαζυγι\w*|avvocato|legale|avocat|odvjetnik|ugovor|ugyved|prawnik|anwalt)\b/,
  government: /\b(tax|taxes|passport|visa|id card|pension|benefits|permit|εφορια|φορολογ\w*|διαβατηρι\w*|βιζα|ταυτοτητ\w*|συνταξ\w*|επιδομ\w*|tasse|passaporto|pensione|impozit\w*|pasaport|pensie|porez|putovnic\w*|ado\b|utlevel|nyugdij|podatek|paszport|emerytur\w*|steuer\w*|reisepass)\b/,
  entertainment: /\b(movie|movies|film|series|tv show|netflix|game|games|concert|book recommendation|ταινι\w*|σειρ\w*|παιχνιδ\w*|συναυλι\w*|serie tv|gioco|joc|filmul|serij\w*|igra|sorozat|jatek|serial\w*|gra\b|gry|spiel)\b/,
};
const INDUSTRY_ORDER = Object.keys(INDUSTRY_WORDS);

// JavaScript's \b and \w only know Latin letters, so "\bτιμη\b" never matches. Rebuild every pattern with
// boundaries and word characters that cover every script.
const B = '(?:(?<=[\\p{L}\\p{N}])(?![\\p{L}\\p{N}])|(?<![\\p{L}\\p{N}])(?=[\\p{L}\\p{N}]))';
const U = (re) => new RegExp(re.source.replaceAll('\\b', B).replaceAll('\\w', '[\\p{L}\\p{N}_]'), re.flags.includes('u') ? re.flags : `${re.flags}u`);
for (const k of Object.keys(W)) W[k] = U(W[k]);
for (const k of INDUSTRY_ORDER) INDUSTRY_WORDS[k] = U(INDUSTRY_WORDS[k]);

const LANG_WORDS = {
  en: /\b(the|and|is|are|what|which|best|how|for|with|you|i|my|do|to|can|in|of|a|an|it|this)\b/g,
  it: /\b(il|la|che|per|non|una|sono|come|qual|migliore|del)\b/g,
  ro: /\b(si|care|este|pentru|cel|mai|bun|cum|unde|sunt|din)\b/g,
  hr: /\b(je|koji|najbolji|kako|gdje|za|sto|li|su|od|jeftin\w*|cijena)\b/g,
  hu: /\b(az|es|hogy|melyik|legjobb|hogyan|hol|van|nem|egy|mennyibe)\b/g,
  pl: /\b(jest|ktory|najlepszy|jak|gdzie|dla|nie|sie|czy|co|kupic|tanie|ile)\b/g,
  de: /\b(der|die|das|und|ist|welche|beste|wie|wo|fur|nicht)\b/g,
  fr: /\b(le|la|les|et|est|quel|meilleur|comment|ou|pour|pas)\b/g,
  es: /\b(el|la|los|y|es|cual|mejor|como|donde|para|que)\b/g,
};
for (const k of Object.keys(LANG_WORDS)) LANG_WORDS[k] = U(LANG_WORDS[k]);

export function detectLanguage(text) {
  const t = String(text || '');
  if (/[Ͱ-Ͽἀ-῿]/.test(t)) return 'el';
  if (/[Ѐ-ӿ]/.test(t)) return /[ъщ]/i.test(t) && !/[ыэё]/i.test(t) ? 'bg' : /[їєі]/i.test(t) ? 'uk' : /[ђћџљњ]/i.test(t) ? 'sr' : 'ru';
  if (/[ăâîșşțţ]/i.test(t)) return 'ro';
  if (/[őű]/i.test(t)) return 'hu';
  if (/[ąęłńśźż]/i.test(t)) return 'pl';
  if (/[čđšž]/i.test(t)) return 'hr';
  const f = fold(t);
  let best = '';
  let bestScore = 0;
  for (const [lang, re] of Object.entries(LANG_WORDS)) {
    if (/ć/i.test(t) && lang !== 'pl' && lang !== 'hr') continue; // ć is Polish or Croatian
    const n = (f.match(re) || []).length;
    if (n > bestScore) { best = lang; bestScore = n; }
  }
  // One matching word is enough only in a short prompt.
  const words = f.split(/\s+/).filter(Boolean).length;
  return bestScore >= 2 || (bestScore === 1 && words <= 5) ? best : undefined;
}

// ---------- Brands ----------

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Short names (3 letters or fewer) must match exactly, case included: "INA" the brand, not "ina" inside a word.
function termPattern(term) {
  const t = String(term || '').trim();
  if (t.length < 2) return null;
  const exact = t.replace(/\s+/g, ' ').length <= 3;
  const body = escapeRe(exact ? t.normalize('NFKD').replace(/\p{M}/gu, '') : fold(t)).replace(/\s+/g, '\\s+');
  return { exact, re: new RegExp(`(^|[^\\p{L}\\p{N}])${body}(?=$|[^\\p{L}\\p{N}])`, 'gu') };
}

export function compileBrands(brands = []) {
  return brands.map((b) => ({
    id: b.id,
    industries: b.industries || [],
    domain: b.domain || '',
    patterns: [b.name, ...(b.aliases || [])].map(termPattern).filter(Boolean),
  }));
}

// Longest name wins: a short alias inside a longer brand name that matched at the same place is not a mention
// ("Εθνική", an alias of Εθνική Τράπεζα, inside "Εθνική Ασφαλιστική").
export function brandsIn(text, compiled) {
  const plain = String(text || '').normalize('NFKD').replace(/\p{M}/gu, '');
  const folded = fold(text);
  const spans = [];
  for (const b of compiled) {
    for (const p of b.patterns) {
      p.re.lastIndex = 0;
      for (const m of (p.exact ? plain : folded).matchAll(p.re)) {
        const start = m.index + m[1].length;
        spans.push({ id: b.id, start, end: m.index + m[0].length });
      }
    }
  }
  const out = new Set();
  for (const s of spans) {
    const inside = spans.some((o) => o.id !== s.id && o.start <= s.start && o.end >= s.end && o.end - o.start > s.end - s.start);
    if (!inside) out.add(s.id);
  }
  return compiled.map((b) => b.id).filter((id) => out.has(id));
}

// ---------- Domains ----------

const TWO_LABEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'com.gr', 'gov.gr', 'org.gr', 'com.cy', 'co.za', 'com.br', 'com.mx', 'com.tr', 'co.jp', 'co.in', 'com.pl', 'com.ro', 'co.il', 'co.nz']);
export function domainOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\d?\./, '').toLowerCase();
    const parts = h.split('.');
    if (parts.length <= 2) return h;
    const last2 = parts.slice(-2).join('.');
    return TWO_LABEL.has(last2) ? parts.slice(-3).join('.') : last2;
  } catch { return ''; }
}

// ---------- The labeller ----------

function demandCategory(f) {
  if (W.compare.test(f)) return 'compare';
  if (W.whereToBuy.test(f)) return 'where_to_buy';
  if (W.price.test(f)) return 'price';
  if (W.alternatives.test(f)) return 'alternatives';
  if (W.reviews.test(f)) return 'reviews';
  if (W.troubleshoot.test(f)) return 'troubleshoot';
  if (W.local.test(f)) return 'local';
  if (W.recommend.test(f)) return 'recommend';
  if (W.howTo.test(f)) return 'how_to';
  if (W.definition.test(f)) return 'definition';
  return null;
}

function taskCategory(f, raw) {
  if (W.coding.test(f) || /```/.test(raw)) return 'coding';
  if (W.translation.test(f)) return 'translation';
  if (W.creative.test(f)) return 'creative';
  if (W.writing.test(f)) return 'writing';
  if (W.analysis.test(f)) return 'analysis';
  if (W.study.test(f)) return 'study';
  if (W.advice.test(f)) return 'advice';
  return 'other_task';
}

function stageFor(category, namesBrand) {
  switch (category) {
    case 'compare': case 'reviews': case 'alternatives': return 'consideration';
    case 'price': case 'where_to_buy': return 'purchase';
    case 'troubleshoot': return 'support';
    case 'how_to': return namesBrand ? 'support' : 'discovery';
    case 'recommend': case 'local': return namesBrand ? 'consideration' : 'discovery';
    default: return 'discovery';
  }
}

/**
 * @param {{prompt:string, reply?:string, links?:string[], engine:string, turnIndex:number, at:number}} turn
 * @param {ReturnType<typeof compileBrands>} brands
 * @returns {{kind, category, stage?, industry?, brands:string[], answerBrands:string[], domains:string[], language?, turn, month, engine}}
 */
export function labelTurn(turn, brands = []) {
  const raw = String(turn.prompt || '');
  const f = fold(raw).replace(/\s+/g, ' ').trim();
  const words = f.split(' ').filter(Boolean).length;
  const lines = raw.split('\n').length;
  const promptBrands = brandsIn(raw, brands);
  const domains = [...new Set((turn.links || []).map(domainOf).filter(Boolean))].slice(0, 12);
  // Only brands the reply names in its text. Citing a brand's site is counted under domains, not as naming it.
  const replyBrands = new Set(brandsIn(turn.reply || '', brands));

  let kind;
  let category;
  // Pasted text, code and long instructions are work requests, whatever words they contain.
  if (words <= 4 && W.greeting.test(f)) { kind = 'chat'; category = 'other'; }
  else if (raw.length > 900 || lines > 12 || /```/.test(raw)) { kind = 'task'; category = taskCategory(f, raw); }
  else if (W.task.test(f) && !W.price.test(f) && !W.recommend.test(f) && !W.compare.test(f)) { kind = 'task'; category = taskCategory(f, raw); }
  else {
    const dc = demandCategory(f);
    if (dc) { kind = 'demand'; category = dc; }
    else if (W.question.test(f) || promptBrands.length) { kind = 'demand'; category = W.definition.test(f) ? 'definition' : 'other'; }
    else { kind = 'task'; category = taskCategory(f, raw); }
  }

  let industry;
  const brandIndustries = new Set();
  for (const id of promptBrands) for (const ind of brands.find((b) => b.id === id)?.industries || []) brandIndustries.add(ind);
  if (brandIndustries.size === 1) industry = [...brandIndustries][0];
  else industry = INDUSTRY_ORDER.find((ind) => INDUSTRY_WORDS[ind].test(f));

  const d = new Date(turn.at || Date.now());
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const out = {
    month,
    engine: turn.engine,
    turn: turn.turnIndex > 1 ? 'follow' : 'first',
    kind,
    category,
    brands: kind === 'demand' ? promptBrands.slice(0, 10) : [],
    answerBrands: kind === 'demand' ? [...replyBrands].slice(0, 10) : [],
    domains,
  };
  if (kind === 'demand') out.stage = stageFor(category, promptBrands.length > 0);
  if (industry && kind !== 'chat') out.industry = industry;
  const language = detectLanguage(raw);
  if (language) out.language = language;
  return out;
}
