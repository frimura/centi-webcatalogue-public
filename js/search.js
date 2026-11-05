/*!
 * search.js - product search for Centi Catalog.
 * Load it BEFORE app.js:   <script src="search.js"></script>
 *
 * What it does
 *   - searches the "Nama Pendek" title (+ SKU); long marketplace titles are only
 *     used as a fallback when the short title has no match
 *   - every word must match, in any order:  "m3 8 baut"  finds  "Baut Button M3 x 8mm"
 *   - understands sizes:  m3x8, m3 x 8, "8" -> 8mm, "6,35" -> 6.35mm, "20 t" -> 20t
 *   - uses aliases / phrase aliases from search-rules.json (English <-> Indonesian etc.)
 *   - fixes typos against the words that really exist in your catalog (puley -> pulley)
 *   - ranks results (exact word > size match > prefix > alias), natural-sorts ties
 *   - suggests "narrow down" chips, pinned ones coming from the categories in the rules file
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CentiSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RULES_CACHE_KEY = 'centi_search_rules_v1';

  const DEFAULT_OPTIONS = {
    hideNames: ['archived products'], // short names (lowercase) that never show in results
    ignoreWords: ['x'],               // filler words dropped from the query ("m3 x 8")
    fallbackToFullTitle: true,        // if the short title has no match, search Name/Variation/Notes
    autoCorrect: true,                // typo correction when nothing matches
    partialMatch: true,               // last resort: show items matching all but one word
    maxChips: 14,
    chipStopwords: []
  };

  const BASE_CHIP_STOP = ['warna', 'per', 'with', 'to', 'tipe', 'type', 'size', 'set', 'only',
    'include', 'and', 'dan', 'untuk', 'ke', 'as', 'up', 'me', 'no', 'saja', 'pas', 'lama'];

  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

  let rules = { options: Object.assign({}, DEFAULT_OPTIONS), aliases: {}, categories: {} };
  let aliasMap = new Map();                 // 'screw' -> [['baut'], ['sekrup']]
  let hideSet = new Set(DEFAULT_OPTIONS.hideNames);
  let ignoreSet = new Set(DEFAULT_OPTIONS.ignoreWords);
  let chipStop = new Set(BASE_CHIP_STOP);

  let docs = [], docOf = new Map(), indexedFor = null;
  let vocab = new Map(), vocabWords = [], vocabAll = [];
  let allowPrefix1 = false;

  /* ------------------------------------------------------------------ text */

  // lowercase, unify separators, split glued sizes:  "M3x8mm" -> "m3 x 8mm"
  function normalize(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/[×✕]/g, 'x')
      .replace(/(\d),(?=\d)/g, '$1.')            // 6,35mm -> 6.35mm
      .replace(/(\d)\s*[x*]\s*(?=\d)/g, '$1 x ')  // m3x8 -> m3 x 8
      .replace(/(\d)\s+(mm|cm|inch)\b/g, '$1$2')  // 8 mm -> 8mm
      .replace(/(^|\s)(\d{1,3}(?:\.\d+)?)\s+([tv])\b/g, '$1$2$3') // "20 t" -> 20t, "12 v" -> 12v (not "m3 t nut", not "2020 t nut")
      .replace(/[^a-z0-9.]+/g, ' ')
      .trim();
  }

  function tokenize(text) {
    const out = [];
    for (let t of normalize(text).split(' ')) {
      t = t.replace(/^\.+|\.+$/g, '');
      if (t) out.push(t);
    }
    return out;
  }

  const RE_SUFFIX = /^(\d+(?:\.\d+)?)([a-z]{0,4})$/;   // 8mm 20t 12v 2020 625zz
  const RE_PREFIX = /^([a-z]{1,4})(\d+(?:\.\d+)?)$/;   // m3 t8 er20 gt2 m2.5
  function parseNum(t) {
    let m = RE_SUFFIX.exec(t);
    if (m) return { num: m[1], unit: m[2], kind: 's' };
    m = RE_PREFIX.exec(t);
    if (m) return { num: m[2], unit: m[1], kind: 'p' };
    return null;
  }

  function pretty(t) {
    let m = /^([a-z]+)(\d[\d.]*)([a-z]*)$/.exec(t);
    if (m) return m[1].toUpperCase() + m[2] + (m[3].length <= 1 ? m[3].toUpperCase() : m[3]);
    m = /^(\d[\d.]*)([a-z]*)$/.exec(t);
    if (m) return m[1] + (m[2].length <= 1 || m[2] === 'zz' ? m[2].toUpperCase() : m[2]);
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /* ----------------------------------------------------------------- rules */

  function setRules(json) {
    const r = json || {};
    rules = {
      options: Object.assign({}, DEFAULT_OPTIONS, r.options || {}),
      aliases: r.aliases || {},
      categories: r.categories || {}
    };
    aliasMap = new Map();
    for (const [k, list] of Object.entries(rules.aliases)) {
      const key = tokenize(k).join(' ');
      if (!key) continue;
      const alts = (Array.isArray(list) ? list : [list]).map(tokenize).filter(a => a.length);
      if (alts.length) aliasMap.set(key, (aliasMap.get(key) || []).concat(alts));
    }
    hideSet = new Set(rules.options.hideNames.map(s => String(s).trim().toLowerCase()));
    ignoreSet = new Set(rules.options.ignoreWords.map(s => String(s).toLowerCase()));
    chipStop = new Set(BASE_CHIP_STOP.concat(rules.options.chipStopwords.map(s => String(s).toLowerCase())));
    return rules;
  }

  async function loadRules(url) {
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      setRules(json);
      try { localStorage.setItem(RULES_CACHE_KEY, JSON.stringify(json)); } catch (e) { /* storage full or blocked */ }
    } catch (err) {
      try {
        const cached = localStorage.getItem(RULES_CACHE_KEY);
        if (cached) setRules(JSON.parse(cached));
      } catch (e) { /* keep defaults */ }
    }
    return rules;
  }

  /* ----------------------------------------------------------------- index */

  function prep(tokens, unique) {
    let tok = unique ? Array.from(new Set(tokens)) : tokens.slice();
    const noX = tok.filter(t => t !== 'x');          // "M3 x 8mm": keep m3 and 8mm side by side
    if (noX.length) tok = noX;
    return { tok, num: tok.map(parseNum), set: new Set(tok) };
  }

  function index(products) {
    docs = []; docOf = new Map(); vocab = new Map();
    products.forEach((p, i) => {
      const short = String(p.short || '').trim();
      // rows whose short name is just "x" are findable through their long name
      const title = short && short.toLowerCase() !== 'x' ? short : (p.name || short || p.sku || '');
      const d = {
        p, i, title,
        key: short.toLowerCase(),
        sku: String(p.sku || '').toLowerCase(),
        main: prep(tokenize(title), false),
        full: prep(tokenize([title, p.name, p.variation, p.notes].join(' ')), true)
      };
      docs.push(d);
      docOf.set(p, d);
      for (const t of d.main.set) vocab.set(t, (vocab.get(t) || 0) + 1);
    });
    vocabAll = Array.from(vocab.keys());
    vocabWords = Array.from(vocab).filter(e => /^[a-z]{3,}$/.test(e[0]));
    indexedFor = products;
  }

  function ensure(products) {
    if (indexedFor !== products) index(products);
  }

  function browse(limit) {
    const out = [];
    for (const d of docs) {
      if (hideSet.has(d.key)) continue;
      out.push(d.p);
      if (out.length >= limit) break;
    }
    return out;
  }

  function count() {
    let n = 0;
    for (const d of docs) if (!hideSet.has(d.key)) n++;
    return n;
  }

  /* --------------------------------------------------------------- matching */

  function tokenScore(q, qn, d, dn) {
    if (d === q) return 100;
    if (qn) {                                  // sizes / codes: exact, or a bare number vs. number+unit
      if (qn.unit === '' && dn && dn.num === qn.num) return dn.kind === 's' ? 75 : 55;
      return 0;
    }
    if (q.length === 1 && !allowPrefix1) return 0;
    if (d.startsWith(q)) return 60 - Math.min(10, d.length - q.length);
    if (q.length >= 4 && d.includes(q)) return 25;   // leadscrew <- screw
    return 0;
  }

  // a group = one typed word (or alias phrase) with its alternatives
  function buildGroups(tokens) {
    const toObj = a => a.map(t => ({ t, n: parseNum(t) }));
    const groups = [];
    let i = 0;
    while (i < tokens.length) {
      let used = 1, alts = [];
      for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
        const key = tokens.slice(i, i + n).join(' ');
        if (aliasMap.has(key)) { used = n; alts = aliasMap.get(key); break; }
      }
      const own = tokens.slice(i, i + used);
      groups.push({
        words: own,
        alts: [{ toks: toObj(own), via: false }].concat(alts.map(a => ({ toks: toObj(a), via: true })))
      });
      i += used;
    }
    return groups;
  }

  function scoreGroup(group, view) {
    let best = 0, bestPos = -1;
    for (const alt of group.alts) {
      let sum = 0, pos = -1, ok = true;
      for (const q of alt.toks) {
        let b = 0, bp = -1;
        for (let i = 0; i < view.tok.length; i++) {
          const s = tokenScore(q.t, q.n, view.tok[i], view.num[i]);
          if (s > b) { b = s; bp = i; }
        }
        if (!b) { ok = false; break; }
        sum += b;
        if (pos < 0) pos = bp;
      }
      if (!ok) continue;
      let s = sum / alt.toks.length;
      if (alt.via) s *= 0.85;                  // a literal match beats an alias match
      if (s > best) { best = s; bestPos = pos; }
    }
    return { s: best, pos: bestPos };
  }

  function runPass(groups, field, minGroups) {
    allowPrefix1 = groups.length === 1;
    const out = [];
    for (const d of docs) {
      if (hideSet.has(d.key)) continue;
      const view = field === 'full' ? d.full : d.main;
      let total = 0, matched = 0, bonus = 0, prev = -9;
      for (let g = 0; g < groups.length; g++) {
        const r = scoreGroup(groups[g], view);
        if (r.s > 0) {
          matched++; total += r.s;
          if (field === 'main') {
            if (r.pos === prev + 1) bonus += 12;           // words next to each other, in order
            if (g === 0 && r.pos === 0) bonus += 20;       // title starts with the first word
          }
          prev = r.pos;
        } else prev = -9;
      }
      if (matched === 0 || matched < minGroups) continue;
      out.push({ d, score: total + bonus + matched * 50 - view.tok.length * 0.5 });
    }
    out.sort((a, b) => (b.score - a.score) || collator.compare(a.d.title, b.d.title) || (a.d.i - b.d.i));
    return out;
  }

  /* ------------------------------------------------------------ typo fixing */

  // optimal-string-alignment distance (counts a swapped pair as one edit)
  function osa(a, b) {
    const m = a.length, n = b.length;
    const d = [];
    for (let i = 0; i <= m; i++) { d[i] = [i]; }
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[m][n];
  }

  function isKnown(t) {
    for (const w of vocabAll) if (w.startsWith(t) || w.includes(t)) return true;
    return false;
  }

  function nearest(t) {
    const maxD = t.length <= 5 ? 1 : 2;
    let best = null, bd = Infinity, bdf = 0;
    const consider = (w, df) => {
      if (Math.abs(w.length - t.length) > maxD) return;
      const dist = osa(t, w);
      if (dist <= maxD && (dist < bd || (dist === bd && df > bdf))) { best = w; bd = dist; bdf = df; }
    };
    for (const e of vocabWords) consider(e[0], e[1]);
    for (const k of aliasMap.keys()) if (/^[a-z]{3,}$/.test(k)) consider(k, 1);
    return best;
  }

  function correctTokens(tokens) {
    let changed = false;
    const out = tokens.map(t => {
      if (t.length < 4 || /\d/.test(t) || aliasMap.has(t) || isKnown(t)) return t;
      const c = nearest(t);
      if (c) { changed = true; return c; }
      return t;
    });
    return changed ? out : null;
  }

  /* ----------------------------------------------------------------- search */

  function pack(hits, mode, groups, tokens, corrected) {
    const skip = new Set();
    for (const g of groups) for (const a of g.alts) for (const q of a.toks) skip.add(q.t);
    return {
      items: hits.map(h => h.d.p),
      total: hits.length,
      mode,                       // exact | full | corrected | partial | sku | none
      corrected: corrected || null,
      words: tokens,
      skip
    };
  }

  function search(query) {
    const raw = String(query || '').trim();
    const rawKey = raw.toLowerCase();

    // 1) SKU typed or pasted
    if (rawKey && /^[a-z0-9.]+$/.test(rawKey)) {
      const exact = docs.filter(d => d.sku === rawKey);
      const pref = rawKey.length >= 6 && /\d/.test(rawKey)
        ? docs.filter(d => d.sku !== rawKey && d.sku.startsWith(rawKey)) : [];
      if (exact.length || pref.length) {
        return { items: exact.concat(pref).map(d => d.p), total: exact.length + pref.length,
          mode: 'sku', corrected: null, words: [rawKey], skip: new Set([rawKey]) };
      }
    }

    let tokens = tokenize(raw);
    const kept = tokens.filter(t => !ignoreSet.has(t));
    if (kept.length) tokens = kept;
    if (!tokens.length) return { items: [], total: 0, mode: 'none', corrected: null, words: [], skip: new Set() };

    const opt = rules.options;
    const both = (groups) => {
      let hits = runPass(groups, 'main', groups.length);
      if (hits.length) return { hits, mode: 'exact' };
      if (opt.fallbackToFullTitle) {
        hits = runPass(groups, 'full', groups.length);
        if (hits.length) return { hits, mode: 'full' };
      }
      return null;
    };

    // 2) every word must match (short title first, then the full title)
    let groups = buildGroups(tokens);
    let r = both(groups);
    if (r) return pack(r.hits, r.mode, groups, tokens);

    // 3) typo correction against the real catalog vocabulary
    let fixed = null;
    if (opt.autoCorrect) {
      fixed = correctTokens(tokens);
      if (fixed) {
        const g2 = buildGroups(fixed);
        r = both(g2);
        if (r) return pack(r.hits, 'corrected', g2, fixed, fixed.join(' '));
        groups = g2; tokens = fixed;
      }
    }

    // 4) closest: all words but one
    if (opt.partialMatch && groups.length >= 2) {
      const min = groups.length - 1;
      let hits = runPass(groups, 'main', min);
      if (!hits.length && opt.fallbackToFullTitle) hits = runPass(groups, 'full', min);
      if (hits.length) return pack(hits, 'partial', groups, tokens, fixed ? fixed.join(' ') : null);
    }
    return pack([], 'none', groups, tokens);
  }

  /* ------------------------------------------------------- narrowing chips */

  function categoryChips(res, items) {
    const words = new Set(res.words);
    const out = [];
    const seen = new Set();
    for (const [name, cat] of Object.entries(rules.categories)) {
      const keys = [name].concat(cat.keywords || []).map(k => tokenize(k));
      const hit = keys.some(k => k.length && k.every(w => words.has(w)));
      if (!hit) continue;
      const values = [];
      for (const [fam, list] of Object.entries(cat.series || {})) values.push({ add: fam, any: list });
      for (const v of [].concat(cat.variant1 || [], cat.variant2 || [], cat.variant3 || [])) values.push({ add: v, any: [v] });
      for (const v of values) {
        const add = tokenize(v.add).join(' ');
        if (!add || seen.has(add) || add.split(' ').every(w => res.skip.has(w))) continue;
        const anyTok = v.any.map(a => tokenize(a).join(' '));
        let c = 0;
        for (const p of items) {
          const d = docOf.get(p);
          if (d && anyTok.some(a => d.main.set.has(a))) c++;
        }
        if (c > 0 && c < items.length) { seen.add(add); out.push({ label: pretty(add), add, count: c, pinned: true }); }
      }
    }
    return out;
  }

  // suggestions that split the current result list (sizes, families, colours ...)
  function refine(res) {
    const max = rules.options.maxChips || 14;
    if (!res || res.mode === 'none' || res.mode === 'sku' || res.items.length < 6) return [];
    const items = res.items.slice(0, 800);
    const n = items.length;

    const pinned = categoryChips(res, items).slice(0, Math.ceil(max / 2));
    const taken = new Set(pinned.map(c => c.add));

    const df = new Map();
    for (const p of items) {
      const d = docOf.get(p);
      if (!d) continue;
      for (const t of d.main.set) if (!res.skip.has(t)) df.set(t, (df.get(t) || 0) + 1);
    }
    const cands = [];
    for (const [t, c] of df) {
      if (t.length < 2 || c < 2 || c > n * 0.9 || chipStop.has(t) || taken.has(t)) continue;
      cands.push({ t, s: Math.min(c, n - c) });
    }
    cands.sort((a, b) => (b.s - a.s) || collator.compare(a.t, b.t));

    const rem = max - pinned.length;
    const words = cands.filter(c => !/\d/.test(c.t));
    const sizes = cands.filter(c => /\d/.test(c.t));
    const ws = words.slice(0, Math.max(Math.ceil(rem / 2), rem - sizes.length));
    const zs = sizes.slice(0, rem - ws.length);
    return pinned.concat(ws, zs).map(c => ({ label: c.label || pretty(c.t), add: c.add || c.t }));
  }

  return {
    setRules, loadRules, index, ensure, search, browse, count, refine,
    normalize, tokenize,
    getRules: () => rules
  };
});
