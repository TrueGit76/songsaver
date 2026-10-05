// Client für die iTunes Search API mit Drosselung (~20 Anfragen/Minute pro IP) und lokalem Cache.

const BASE = 'https://itunes.apple.com';
export const MIN_INTERVAL_MS = 3100;
const RETRY_WAIT_MS = 60_000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
   * @param {Function} [opts.onWait]  wird mit (ms, grund) aufgerufen, bevor länger gewartet wird
   */
  constructor({ country, store = null, fetch = globalThis.fetch.bind(globalThis), sleep, onWait, minIntervalMs = MIN_INTERVAL_MS } = {}) {
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
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.signal?.throwIfAborted();
      this.lastRequestAt = Date.now();
      this.requestCount++;

      let res;
      try {
        res = await this.fetch(url);
      } catch (err) {
        if (attempt >= 2) throw new Error(`iTunes ist nicht erreichbar (${err.message}).`);
        await this.sleep(2000);
        continue;
      }

      // Apple antwortet bei überschrittenem Limit mit 403 oder 429.
      if (res.status === 403 || res.status === 429) {
        if (attempt >= 2) throw new Error('iTunes hat zu viele Anfragen gemeldet. Bitte in ein paar Minuten erneut versuchen.');
        this.onWait(RETRY_WAIT_MS, 'Anfragelimit von iTunes erreicht – warte kurz');
        await this.sleep(RETRY_WAIT_MS);
        continue;
      }
      if (!res.ok) throw new Error(`iTunes-Anfrage fehlgeschlagen (HTTP ${res.status}).`);

      const data = await res.json();
      const results = (data.results ?? []).map(slim);
      await this.writeCache(url, results);
      return results;
    }
  }

  async readCache(url) {
    if (!this.store) return null;
    try {
      const entry = await this.store.get('cache', url);
      return entry && Date.now() - entry.at < CACHE_TTL_MS ? entry.results : null;
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
