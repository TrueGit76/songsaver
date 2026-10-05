// Client für die iTunes Search API mit Drosselung (~20 Anfragen/Minute pro IP) und lokalem Cache.

const BASE = 'https://itunes.apple.com';
const MIN_INTERVAL_MS = 3100;
const RETRY_WAIT_MS = 60_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PREFIX = 'songsaver:itunes:';

function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export class ItunesClient {
  /**
   * @param {object} opts
   * @param {string} opts.country  ISO-Ländercode des Stores, z. B. "de"
   * @param {Function} [opts.fetch]
   * @param {Storage|null} [opts.storage]
   * @param {Function} [opts.sleep]
   * @param {Function} [opts.onWait]  wird mit (ms, grund) aufgerufen, bevor länger gewartet wird
   */
  constructor({ country, fetch = globalThis.fetch.bind(globalThis), storage = safeStorage(), sleep, onWait, minIntervalMs = MIN_INTERVAL_MS } = {}) {
    this.country = country;
    this.fetch = fetch;
    this.storage = storage;
    this.sleep = sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.onWait = onWait ?? (() => {});
    this.minIntervalMs = minIntervalMs;
    this.lastRequestAt = 0;
    this.requestCount = 0;
  }

  searchSongs(term, limit = 25) {
    return this.get('/search', { term, entity: 'song', media: 'music', limit });
  }

  searchAlbums(term, limit = 10) {
    return this.get('/search', { term, entity: 'album', media: 'music', limit });
  }

  /** Album samt allen Titeln (erstes Ergebnis ist das Album selbst). */
  albumWithTracks(collectionId) {
    return this.get('/lookup', { id: collectionId, entity: 'song', limit: 200 });
  }

  async get(path, params) {
    const query = new URLSearchParams({ ...params, country: this.country });
    const url = `${BASE}${path}?${query}`;

    const cached = this.readCache(url);
    if (cached) return cached;

    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
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
      const results = data.results ?? [];
      this.writeCache(url, results);
      return results;
    }
  }

  readCache(url) {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(CACHE_PREFIX + url);
      if (!raw) return null;
      const { at, results } = JSON.parse(raw);
      return Date.now() - at < CACHE_TTL_MS ? results : null;
    } catch {
      return null;
    }
  }

  writeCache(url, results) {
    if (!this.storage) return;
    try {
      this.storage.setItem(CACHE_PREFIX + url, JSON.stringify({ at: Date.now(), results }));
    } catch {
      // Speicher voll oder gesperrt – Cache ist nur eine Optimierung.
    }
  }
}
