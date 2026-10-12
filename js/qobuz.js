// Qobuz als zweiter Shop: Titel suchen und den günstigsten Einzelpreis (bevorzugt MP3) ermitteln.
// Qobuz hat keine öffentliche API; gelesen werden die Suchseite und der „In den Warenkorb“-Dialog.
// Die Seiten sind nicht per CORS freigegeben, deshalb laufen die Abfragen über den Proxy aus tools/serve.mjs.

import { scoreSong, songTerm, bareSongTerm, confidenceLabel, ACCEPT_SONG } from './matcher.js';

export const QOBUZ_INTERVAL_MS = 1500;
export const QOBUZ_HOST = 'https://www.qobuz.com';
const PROXY = '/proxy/qobuz';
const CURRENCIES = [[/€/, 'EUR'], [/£/, 'GBP'], [/\$/, 'USD'], [/chf/i, 'CHF']];

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? m;
    return String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16));
  });
}

function clean(s) {
  return decode(s).replace(/\s+/g, ' ').trim();
}

/** Titeltreffer der Suchseite: [{ id, trackName, artistName, collectionName, albumUrl }]. */
export function parseTrackSearch(html) {
  const out = [];
  for (const [, block] of html.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    const id = block.match(/popin-add-cart(?:\/|&#x2F;)track(?:\/|&#x2F;)(\d+)/)?.[1];
    const title = block.match(/<a [^>]*href="([^"]*\/album\/[^"]*)"[^>]*role="tooltip"[^>]*>([\s\S]*?)<\/a>/);
    const sub = block.match(/<p [^>]*>([\s\S]*?)<\/p>/)?.[1];
    if (!id || !title || !sub) continue;
    const [artistName, ...album] = clean(sub).split(' • ');
    out.push({ id, trackName: clean(title[2]), artistName, collectionName: album.join(' • '), albumUrl: decode(title[1]) });
  }
  return out;
}

function parsePrice(text) {
  const num = text.replace(/[^\d.,]/g, '');
  const value = Number(num.includes(',') ? num.replace(/\./g, '').replace(',', '.') : num);
  const currency = CURRENCIES.find(([re]) => re.test(text))?.[1] ?? null;
  return value > 0 ? { price: value, currency } : null;
}

/** Qualitätsstufen aus dem „In den Warenkorb“-Dialog eines Titels: [{ articleId, label, price, currency }]. */
export function parseQualities(html) {
  const out = [];
  for (const [tag] of html.matchAll(/<button\b[^>]*store-modal__quality[^>]*>/g)) {
    const attr = name => tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`))?.[1];
    const price = parsePrice(clean(attr('data-price') ?? ''));
    if (!attr('data-id') || !price) continue;
    out.push({ articleId: attr('data-id'), label: clean(attr('data-label') ?? ''), ...price });
  }
  return out;
}

/** Günstigste Stufe; bei gleichem Preis gewinnt MP3. */
export function cheapestQuality(qualities) {
  const isMp3 = q => /mp3/i.test(q.label);
  return [...qualities].sort((a, b) => a.price - b.price || Number(isMp3(b)) - Number(isMp3(a)))[0] ?? null;
}

export class QobuzClient {
  /**
   * @param {object} opts
   * @param {string} opts.locale  Qobuz-Sprachpfad, z. B. "de-de"
   * @param {object|null} [opts.store]  Speicher aus store.js für den Cache
   */
  constructor({ locale, store = null, fetch = globalThis.fetch.bind(globalThis), sleep, minIntervalMs = QOBUZ_INTERVAL_MS, cacheTtlMs = 7 * 24 * 60 * 60 * 1000, base = PROXY } = {}) {
    this.locale = locale;
    this.store = store;
    this.fetch = fetch;
    this.sleep = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.minIntervalMs = minIntervalMs;
    this.cacheTtlMs = cacheTtlMs;
    this.base = base;
    this.lastRequestAt = 0;
    this.requestCount = 0;
    this.signal = null;
  }

  async searchTracks(term) {
    const path = `${this.locale}/search/tracks/${encodeURIComponent(term)}`;
    return this.cached(`qobuz:${path}`, async () => parseTrackSearch(await this.page(path)));
  }

  /** Günstigste Stufe eines Titels oder null, wenn er nicht einzeln kaufbar ist. */
  async cheapest(trackId) {
    const path = `v4/ajax/popin-add-cart/track/${trackId}`;
    return this.cached(`qobuz:${path}`, async () => cheapestQuality(parseQualities(await this.page(path))));
  }

  async cached(key, load) {
    try {
      const entry = await this.store?.get('cache', key);
      if (entry && Date.now() - entry.at < this.cacheTtlMs) return entry.results;
    } catch { /* ohne Cache weiter */ }
    const results = await load();
    try { await this.store?.set('cache', key, { at: Date.now(), results }); } catch { /* nur Optimierung */ }
    return results;
  }

  async page(path) {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.signal?.throwIfAborted();
    this.lastRequestAt = Date.now();
    this.requestCount++;
    let res;
    try {
      res = await this.fetch(`${this.base}/${path}`);
    } catch (err) {
      throw new Error(`Qobuz nicht erreichbar (${err.message}).`);
    }
    if (res.status === 404 && this.base === PROXY) {
      throw new Error('Qobuz-Abfragen brauchen den lokalen Server („npm start“); auf einer statischen Seite sind sie nicht möglich.');
    }
    if (!res.ok) throw new Error(`Qobuz-Anfrage fehlgeschlagen (HTTP ${res.status}).`);
    return res.text();
  }
}

function pickBest(track, candidates) {
  let best = null;
  for (const cand of candidates) {
    const score = scoreSong(track, cand);
    if (!best || score > best.score) best = { cand, score };
  }
  return best;
}

/**
 * Sucht die Titel bei Qobuz und meldet jedes Ergebnis über onResult. Pro Titel: eine Suche
 * (bei schwachem Treffer eine zweite) und eine Preisabfrage für den besten Treffer.
 * @returns {Promise<Array<{track, match, score, confidence}>>} in Reihenfolge der Titel
 */
export async function matchQobuz(tracks, client, { onResult = () => {}, signal } = {}) {
  client.signal = signal ?? null;
  const results = [];
  for (const track of tracks) {
    signal?.throwIfAborted();
    let best = pickBest(track, await client.searchTracks(songTerm(track)));
    const bare = bareSongTerm(track);
    if ((!best || best.score < ACCEPT_SONG) && bare) {
      const retry = pickBest(track, await client.searchTracks(bare));
      if (retry && (!best || retry.score > best.score)) best = retry;
    }
    let result = { track, match: null, score: best?.score ?? 0, confidence: null };
    if (best && best.score >= ACCEPT_SONG) {
      const quality = await client.cheapest(best.cand.id);
      if (quality) {
        result = {
          track, score: best.score, confidence: confidenceLabel(best.score),
          match: { ...best.cand, albumUrl: `${QOBUZ_HOST}${best.cand.albumUrl}`, ...quality },
        };
      }
    }
    results.push(result);
    onResult(result, results.length, tracks.length);
  }
  return results;
}
