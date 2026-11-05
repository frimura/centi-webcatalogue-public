/*!
 * search.js - product search for Centi Catalog.
 * Load it BEFORE app.js:   <script src="search.js"></script>
 *
 * What it does
 *   - searches the "Nama Pendek" title (+ SKU); long marketplace titles are only
 *     used as a fallback when the short title has no match
 *   - relevance-ranked search: partial matches remain visible instead of being discarded
 *   - uses Code Categorizing cluster codes to prioritize products in the requested category
 *   - dimensions are normalized across M3x10 / M3 x 10 / M3 10 / M3 10mm
 *   - understands sizes:  m3x8, m3 x 8, "8" -> 8mm, "6,35" -> 6.35mm, "20 t" -> 20t
 *   - uses aliases / phrase aliases from search-rules.json (English <-> Indonesian etc.)
 *   - fixes typos against the words that really exist in your catalog (puley -> pulley)
 *   - ranks exact terms and dimensions first, then close matches and category matches
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


  // Category codes come from the catalog's "Code Categorizing" column.
  // The first letter is the cluster; E is the coupling cluster.
  const CATEGORY_PREFIXES = {
    pulley: ['C'],              // Linear Motion
    corner: ['B'],              // Mechanical Structure
    coupling: ['E'],            // Couplings
    'profile aluminium': ['B'],
    't nut': ['A'],             // T-nuts are grouped with bolts/nuts in this catalog
    wiremesh: ['F'],            // Mechanical Accessories
    Socket: ['A'],
    ballnose: ['G'],            // CNC Parts
    mur: ['A']
  };

  function detectedCategories(tokens) {
    const found = [];
    const q = new Set(tokens);
    for (const [name, cat] of Object.entries(rules.categories)) {
      const keys = [name].concat(cat.keywords || []);
      const hit = keys.some(key => {
        const parts = tokenize(key);
        return parts.length && parts.every(t => q.has(t) ||
          (aliasMap.get(t) || []).some(a => a.length === 1 && q.has(a[0])));
      });
      if (hit) found.push(name);
    }
    return found;
  }


  function dimensionMatchCount(queryTokens, view) {
    const wanted = queryTokens.map(parseNum).filter(Boolean);
    if (!wanted.length) return { matched: 0, exact: 0 };
    const available = view.tok.map((t, i) => ({ n: view.num[i], used: false }))
      .filter(x => x.n);
    let matched = 0, exact = 0;
    for (const q of wanted) {
      let at = available.findIndex(x => !x.used && x.n.num === q.num && x.n.unit === q.unit);
      if (at >= 0) {
        available[at].used = true; matched++; exact++; continue;
      }
      // A bare number (e.g. 10) may match a dimensional token (10mm).
      if (q.unit === '') {
        at = available.findIndex(x => !x.used && x.n.num === q.num);
        if (at >= 0) { available[at].used = true; matched++; }
      }
    }
    return { matched, exact };
  }

  function runRanked(groups, tokens) {
    allowPrefix1 = groups.length === 1;
    const cats = detectedCategories(tokens);
    const prefixes = cats.flatMap(c => CATEGORY_PREFIXES[c] || []);
    const out = [];

    for (const d of docs) {
      if (hideSet.has(d.key)) continue;

      let total = 0, matched = 0, mainMatched = 0, fullMatched = 0;
      let exactDimensions = 0, partialDimensions = 0, bonus = 0, prev = -9;

      for (let g = 0; g < groups.length; g++) {
        const main = scoreGroup(groups[g], d.main);
        const full = scoreGroup(groups[g], d.full);
        const r = main.s >= full.s ? main : full;
        if (r.s > 0) {
          matched++;
          total += r.s;
          if (main.s > 0) mainMatched++;
          else fullMatched++;
          const queryHasNumber = groups[g].alts.some(a => a.toks.some(t => !!t.n));
          if (queryHasNumber) {
            if (r.s >= 95) exactDimensions++;
            else partialDimensions++;
          }
          if (r.pos === prev + 1) bonus += 10;
          if (g === 0 && r.pos === 0 && main.s > 0) bonus += 18;
          prev = r.pos;
        } else {
          prev = -9;
        }
      }

      // Dimension ranking is based on the short/catalog title, not the long
      // marketplace title which may list many unrelated variation sizes.
      const dimensionFit = dimensionMatchCount(tokens, d.main);

      const code = String(d.p.category || '').trim().toUpperCase();
      const categoryMatch = prefixes.some(prefix => code.startsWith(prefix));
      // Keep every item in a requested category, even if its title has no
      // matching dimensions or wording. Text/dimension matches rank within it.
      if (!matched && !categoryMatch) continue;

      const coverage = matched / Math.max(1, groups.length);
      let score = total + bonus + matched * 38;
      score += coverage * 100;
      score += mainMatched * 12;
      score -= fullMatched * 3;
      score += exactDimensions * 32 + partialDimensions * 8;
      if (categoryMatch) score += 420;
      if (matched === groups.length) score += 90;
      if (matched === 0 && categoryMatch) score += 0;

      out.push({
        d, score, matched, coverage, categoryMatch,
        exactDimensions, partialDimensions,
        dimensionMatches: dimensionFit.matched, dimensionExact: dimensionFit.exact,
        rank: matched === groups.length ? 'strong' : (matched ? 'related' : 'category')
      });
    }

    out.sort((a, b) =>
      (Number(b.categoryMatch) - Number(a.categoryMatch)) ||
      (b.dimensionMatches - a.dimensionMatches) ||
      (b.dimensionExact - a.dimensionExact) ||
      (b.score - a.score) ||
      (b.matched - a.matched) ||
      collator.compare(a.d.title, b.d.title) ||
      (a.d.i - b.d.i)
    );
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
      mode,
      corrected: corrected || null,
      words: tokens,
      skip,
      ranking: hits.map(h => ({
        sku: h.d.sku, score: Math.round(h.score),
        matched: h.matched, categoryMatch: h.categoryMatch,
        dimensionMatches: h.dimensionMatches,
        rank: h.rank
      }))
    };
  }

  function search(query) {
    const raw = String(query || '').trim();
    const rawKey = raw.toLowerCase();

    // Exact SKU and SKU-prefix searches retain their dedicated behavior.
    if (rawKey && /^[a-z0-9.]+$/.test(rawKey)) {
      const exact = docs.filter(d => d.sku === rawKey);
      const pref = rawKey.length >= 6 && /\d/.test(rawKey)
        ? docs.filter(d => d.sku !== rawKey && d.sku.startsWith(rawKey)) : [];
      if (exact.length || pref.length) {
        return {
          items: exact.concat(pref).map(d => d.p),
          total: exact.length + pref.length,
          mode: 'sku', corrected: null, words: [rawKey],
          skip: new Set([rawKey])
        };
      }
    }

    let tokens = tokenize(raw);
    const kept = tokens.filter(t => !ignoreSet.has(t));
    if (kept.length) tokens = kept;
    if (!tokens.length) return {
      items: [], total: 0, mode: 'none', corrected: null,
      words: [], skip: new Set()
    };

    let groups = buildGroups(tokens);
    let hits = runRanked(groups, tokens);

    // Only use typo correction when the original query produced no result.
    let fixed = null;
    if (!hits.length && rules.options.autoCorrect) {
      fixed = correctTokens(tokens);
      if (fixed) {
        const correctedGroups = buildGroups(fixed);
        const correctedHits = runRanked(correctedGroups, fixed);
        if (correctedHits.length) {
          groups = correctedGroups;
          tokens = fixed;
          hits = correctedHits;
          return pack(hits, 'corrected', groups, tokens, fixed.join(' '));
        }
      }
    }

    return pack(hits, hits.length ? 'ranked' : 'none', groups, tokens);
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
