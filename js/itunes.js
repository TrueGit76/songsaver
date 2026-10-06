// Client für die iTunes Search API mit Drosselung (~20 Anfragen/Minute pro IP) und lokalem Cache.

const BASE = 'https://itunes.apple.com';
export const MIN_INTERVAL_MS = 3100;
const RETRY_WAIT_MS = 60_000;
const MAX_ATTEMPTS = 3;

// Takt und Sperre gelten für alle Clients und Tabs sowie über Pause und Neuladen hinweg;
// sonst könnte „Weitersuchen“ oder ein Neuladen sofort wieder am Limit kratzen.
const LAST_KEY = 'songsaver:itunes:last';
const BLOCKED_KEY = 'songsaver:itunes:blockedUntil';

function sharedTime(key) {
  try { return Number(globalThis.localStorage?.getItem(key)) || 0; } catch { return 0; }
}

function setSharedTime(key, value) {
  try { globalThis.localStorage?.setItem(key, String(value)); } catch { /* nur Komfort */ }
}
export const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Nur diese Felder werden gebraucht – hält den Cache klein.
const FIELDS = [
  'wrapperType', 'kind', 'collectionType', 'trackId', 'collectionId',
  'trackName', 'artistName', 'collectionName', 'collectionArtistName',
  'trackTimeMillis', 'trackPrice', 'collectionPrice', 'currency', 'trackCount',
  'trackViewUrl', 'collectionViewUrl', 'artworkUrl100',
];

function slim(result) {
  const out = {};
  for (const f of FIELDS) if (result[f] !== undefined) out[f] = result[f];
  return out;
}

export class ItunesClient {
  /**
   * @param {object} opts
   * @param {string} opts.country  ISO-Ländercode des Stores, z. B. "de"
   * @param {object|null} [opts.store]  Speicher aus store.js (get/set) für den Cache
   * @param {Function} [opts.fetch]
   * @param {Function} [opts.sleep]
   * @param {number} [opts.cacheTtlMs]  wie lange Antworten gelten (Infinity = unbegrenzt)
   * @param {Function} [opts.onWait]  wird mit (ms, grund) aufgerufen, bevor länger gewartet wird
   */
  constructor({ country, store = null, fetch = globalThis.fetch.bind(globalThis), sleep, onWait, minIntervalMs = MIN_INTERVAL_MS, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.country = country;
    this.store = store;
    this.fetch = fetch;
    this.sleep = sleep ?? (ms => new Promise((resolve, reject) => {
      // Pause soll auch während einer langen Wartezeit sofort greifen.
      const timer = setTimeout(resolve, ms);
      this.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(this.signal.reason); }, { once: true });
    }));
    this.onWait = onWait ?? (() => {});
    this.minIntervalMs = minIntervalMs;
    this.lastRequestAt = 0;
    this.requestCount = 0;
    this.signal = null;
  }

  searchSongs(term) { return this.get(...songQuery(term)); }
  searchAlbums(term) { return this.get(...albumQuery(term)); }
  /** Album samt allen Titeln (erstes Ergebnis ist das Album selbst). */
  albumWithTracks(collectionId) { return this.get(...albumTracksQuery(collectionId)); }

  // Nur aus dem Cache lesen (null = nicht zwischengespeichert) – für die Zeitschätzung.
  peekSongs(term) { return this.readCache(this.url(...songQuery(term))); }
  peekAlbums(term) { return this.readCache(this.url(...albumQuery(term))); }
  peekAlbumTracks(collectionId) { return this.readCache(this.url(...albumTracksQuery(collectionId))); }

  url(path, params) {
    return `${BASE}${path}?${new URLSearchParams({ ...params, country: this.country })}`;
  }

  async get(path, params) {
    const url = this.url(path, params);
    const cached = await this.readCache(url);
    if (cached) return cached;

    for (let attempt = 0; ; attempt++) {
      await this.waitForTurn();

      let res = null;
      try {
        res = await this.fetch(url);
      } catch (err) {
        if (globalThis.navigator?.onLine === false) throw new Error('Keine Internetverbindung.');
        // Bei überschrittenem Limit antwortet Apple oft ohne CORS-Header; der Browser meldet das nur
        // als Netzwerkfehler. Das behandeln wir wie ein Limit und warten, statt aufzugeben.
        if (attempt + 1 >= MAX_ATTEMPTS) {
          throw new Error(`iTunes antwortet nicht (${err.message}) – vermutlich Anfragelimit. Bitte in einigen Minuten mit „Weitersuchen“ fortfahren.`);
        }
        await this.backOff(RETRY_WAIT_MS * (attempt + 1), 'iTunes antwortet nicht (vermutlich Anfragelimit) – warte');
        continue;
      }

      // Apple antwortet bei überschrittenem Limit mit 403 oder 429.
      if (res.status === 403 || res.status === 429) {
        if (attempt + 1 >= MAX_ATTEMPTS) throw new Error('iTunes hat zu viele Anfragen gemeldet. Bitte in ein paar Minuten mit „Weitersuchen“ fortfahren.');
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        const wait = retryAfter > 0 ? retryAfter * 1000 : RETRY_WAIT_MS * (attempt + 1);
        await this.backOff(wait, 'Anfragelimit von iTunes erreicht – warte');
        continue;
      }
      if (!res.ok) throw new Error(`iTunes-Anfrage fehlgeschlagen (HTTP ${res.status}).`);

      const data = await res.json();
      const results = (data.results ?? []).map(slim);
      await this.writeCache(url, results);
      return results;
    }
  }

  /** Wartet auf die nächste erlaubte Anfrage (Mindestabstand und evtl. laufende Sperre) und zählt sie. */
  async waitForTurn() {
    const earliest = Math.max(
      this.lastRequestAt, sharedTime(LAST_KEY),
    ) + this.minIntervalMs;
    const blocked = sharedTime(BLOCKED_KEY);
    if (blocked > Date.now()) this.onWait(blocked - Date.now(), 'Anfragelimit von iTunes – warte');
    const wait = Math.max(earliest, blocked) - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.signal?.throwIfAborted();
    this.lastRequestAt = Date.now();
    setSharedTime(LAST_KEY, this.lastRequestAt);
    this.requestCount++;
  }

  /** Sperre merken (auch für andere Tabs und nach Neuladen) und abbrechbar warten. */
  async backOff(ms, reason) {
    setSharedTime(BLOCKED_KEY, Date.now() + ms);
    this.onWait(ms, reason);
    await this.sleep(ms);
  }

  async readCache(url) {
    if (!this.store) return null;
    try {
      const entry = await this.store.get('cache', url);
      return entry && Date.now() - entry.at < this.cacheTtlMs ? entry.results : null;
    } catch {
      return null;
    }
  }

  async writeCache(url, results) {
    if (!this.store) return;
    try {
      await this.store.set('cache', url, { at: Date.now(), results });
    } catch {
      // Speicher voll oder gesperrt – Cache ist nur eine Optimierung.
    }
  }
}

function songQuery(term) {
  return ['/search', { term, entity: 'song', media: 'music', limit: 25 }];
}

function albumQuery(term) {
  return ['/search', { term, entity: 'album', media: 'music', limit: 10 }];
}

function albumTracksQuery(collectionId) {
  return ['/lookup', { id: collectionId, entity: 'song', limit: 200 }];
}
