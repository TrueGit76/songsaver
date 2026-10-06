// Offizielle Künstler-Website und Bandcamp-Seite über MusicBrainz (frei nutzbar, CORS offen, ~1 Anfrage/Sekunde).
// Zwei Schritte: Künstler per Name suchen, dann dessen Links ("official homepage") lesen.

const BASE = 'https://musicbrainz.org/ws/2';
export const MIN_INTERVAL_MS = 1100;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'artist-links:'; // früher 'artist-site:' (nur Website) – bewusst neuer Schlüssel

const VARIOUS = /^(various artists?|verschiedene( interpreten| künstler)?|diverse|sampler|v\.?\s?a\.?)$/i;

/** Nur echte Einzelkünstler: kein Sampler, kein leerer Name. */
export function isSingleArtist(name) {
  const n = (name ?? '').trim();
  return n !== '' && !VARIOUS.test(n);
}

/**
 * Wählt aus den Suchtreffern den Künstler – oder keinen, wenn es nicht eindeutig ist
 * (ein falscher Treffer wäre schlimmer als gar keiner, es gibt viele Namensvettern).
 */
export function pickArtist(hits, name) {
  const wanted = name.trim().toLowerCase();
  const same = (hits ?? [])
    .filter(h => h.name?.trim().toLowerCase() === wanted)
    .sort((a, b) => b.score - a.score);
  const [best, next] = same;
  if (!best || best.score < 95) return null;
  if (next && next.score > 80) return null; // zwei fast gleich gute Namensvettern
  return best.id;
}

/** Erste offizielle Homepage, die nicht als beendet markiert ist. */
export function pickHomepage(relations) {
  for (const r of relations ?? []) {
    const url = r.url?.resource;
    if (r.type === 'official homepage' && !r.ended && /^https?:\/\//i.test(url ?? '')) return url;
  }
  return null;
}

/** Bandcamp-Seite des Künstlers (bandcamp.com oder Unterseite), nicht als beendet markiert. */
export function pickBandcamp(relations) {
  for (const r of relations ?? []) {
    if (r.type !== 'bandcamp' || r.ended) continue;
    try {
      const u = new URL(r.url?.resource ?? '');
      if (u.protocol === 'https:' && (u.hostname === 'bandcamp.com' || u.hostname.endsWith('.bandcamp.com'))) return u.href;
    } catch { /* ungültige URL überspringen */ }
  }
  return null;
}

export class ArtistSiteClient {
  /**
   * @param {object} opts
   * @param {object|null} [opts.store]  Speicher aus store.js; Treffer und Nicht-Treffer werden gemerkt
   * @param {Function} [opts.fetch]
   * @param {Function} [opts.sleep]
   */
  constructor({ store = null, fetch: fetchFn = globalThis.fetch?.bind(globalThis), sleep } = {}) {
    this.store = store;
    this.fetch = fetchFn;
    this.sleep = sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.lastRequestAt = 0;
  }

  async get(path) {
    const wait = this.lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
    const res = await this.fetch(`${BASE}/${path}${path.includes('?') ? '&' : '?'}fmt=json`);
    if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
    return res.json();
  }

  /** @returns {Promise<{website: string|null, bandcamp: string|null}>} bei Fehlern leer, ohne zu speichern */
  async find(name) {
    const key = CACHE_PREFIX + name.trim().toLowerCase();
    try {
      const hit = await this.store?.get('cache', key);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.links;
    } catch { /* Cache ist nur Komfort */ }

    const none = { website: null, bandcamp: null };
    let links;
    try {
      const quoted = name.replace(/(["\\])/g, '\\$1');
      const search = await this.get(`artist?query=${encodeURIComponent(`artist:"${quoted}"`)}&limit=5`);
      const id = pickArtist(search.artists, name);
      const relations = id ? (await this.get(`artist/${id}?inc=url-rels`)).relations : [];
      links = { website: pickHomepage(relations), bandcamp: pickBandcamp(relations) };
    } catch {
      return none; // Netzwerk/Limit: später nochmal versuchen
    }
    try { await this.store?.set('cache', key, { links, at: Date.now() }); } catch { /* s. o. */ }
    return links;
  }

}
