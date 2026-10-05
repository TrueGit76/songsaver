// Normalisierung und Ähnlichkeit von Titeln, Künstlern und Albumnamen.

// Zusätze, die dieselbe Aufnahme nur anders benennen (Remaster, Feature-Gäste) – werden entfernt.
const NOISE_PATTERNS = [
  /\s*[([](feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi,
  /\s+(feat\.?|ft\.?|featuring)\s.*$/gi,
  /\s*-\s*(\d{4}\s+)?(digital(ly)?\s+)?remaster(ed)?(\s+\d{4})?(\s+version)?\s*$/gi,
  /\s*[([](\d{4}\s+)?(digital(ly)?\s+)?remaster(ed)?(\s+\d{4})?(\s+version)?[)\]]/gi,
  /\s*-\s*(single|album)\s+version\s*$/gi,
  /\s*[([](single|album)\s+version[)\]]/gi,
  /\s*[([](\d+(th|st|nd|rd)\s+anniversary\s+)?(deluxe|expanded|special)(\s+edition|\s+version)?[)\]]/gi,
];

// Kennzeichen anderer Aufnahmen derselben Komposition – dürfen nicht stillschweigend gleichgesetzt werden.
const VERSION_MARKERS = ['live', 'remix', 'mix', 'edit', 'acoustic', 'akustik', 'instrumental', 'karaoke', 'demo', 'cover', 'version', 'unplugged', 'mono'];

function baseNormalize(s) {
  return (s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9ß]+/g, ' ')
    .trim();
}

export function cleanTitle(s) {
  let out = s ?? '';
  for (const p of NOISE_PATTERNS) out = out.replace(p, '');
  return out.trim();
}

export function normalizeTitle(s) {
  return baseNormalize(cleanTitle(s));
}

export function normalizeName(s) {
  return baseNormalize(s).replace(/^the /, '');
}

/** Versionskennzeichen (live, remix, …), die nach der Bereinigung im Titel übrig bleiben. */
export function versionMarkers(s) {
  const words = new Set(normalizeTitle(s).split(' '));
  return VERSION_MARKERS.filter(m => words.has(m));
}

function bigrams(s) {
  const t = s.replace(/ /g, '');
  const grams = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
}

/** Dice-Koeffizient über Zeichen-Bigramme, 0..1. Erwartet bereits normalisierte Strings. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of ga) { total += n; overlap += Math.min(n, gb.get(g) ?? 0); }
  for (const n of gb.values()) total += n;
  return (2 * overlap) / total;
}

/** Bester Ähnlichkeitswert eines Namens gegen eine Liste (z. B. alle beteiligten Künstler). */
export function bestNameSimilarity(candidate, names) {
  const c = normalizeName(candidate);
  let best = similarity(c, normalizeName(names.join(' ')));
  for (const n of names) {
    const nn = normalizeName(n);
    best = Math.max(best, similarity(c, nn));
    // iTunes nennt bei Kollaborationen oft "A & B" – Hauptkünstler am Anfang zählt als Treffer.
    if (nn && c.startsWith(nn + ' ')) best = Math.max(best, 0.95);
  }
  return best;
}
