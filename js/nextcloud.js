// Liest die Titelliste aus der Music-App von Nextcloud (Subsonic-Schnittstelle, nur lesend).
// Anmeldung mit einem API-Schlüssel aus den Einstellungen der Music-App, nicht mit dem Nextcloud-Passwort.

const API = '/index.php/apps/music/subsonic/rest';
const PAGE = 500;
const PARALLEL = 4;

const ERRORS = {
  40: 'Benutzername oder API-Schlüssel stimmt nicht. Den Schlüssel erzeugst du in der Music-App (Einstellungen, Link unten links).',
  41: 'Benutzername oder API-Schlüssel stimmt nicht.',
};

export function normalizeBaseUrl(input) {
  let url = input.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '').replace(/\/index\.php.*$/, '');
}

export class NextcloudMusicClient {
  constructor({ baseUrl, user, key, fetch = globalThis.fetch.bind(globalThis) }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.user = user.trim();
    this.key = key;
    this.fetch = fetch;
    this.signal = null;
  }

  async call(method, params = {}) {
    const query = new URLSearchParams({ u: this.user, p: this.key, v: '1.16.1', c: 'songsaver', f: 'json', ...params });
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${API}/${method}.view?${query}`, { signal: this.signal });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new Error(`Nextcloud nicht erreichbar (${err.message}). Stimmt die Adresse, und erlaubt der Server Abfragen von dieser Seite?`);
    }
    if (!res.ok) throw new Error(`Nextcloud antwortet mit HTTP ${res.status}. Ist die Music-App installiert?`);
    const body = (await res.json())['subsonic-response'];
    if (body?.status !== 'ok') throw new Error(ERRORS[body?.error?.code] ?? body?.error?.message ?? 'Unerwartete Antwort von Nextcloud.');
    return body;
  }

  ping() { return this.call('ping'); }

  /** Alle Titel der Sammlung: erst alle Alben seitenweise, dann die Titel je Album (mehrere gleichzeitig). */
  async allSongs({ onProgress = () => {} } = {}) {
    const albums = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = (await this.call('getAlbumList2', { type: 'alphabeticalByName', size: PAGE, offset })).albumList2?.album ?? [];
      albums.push(...page);
      if (page.length < PAGE) break;
    }
    const songs = [];
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < albums.length) {
        const album = albums[next++];
        const detail = (await this.call('getAlbum', { id: album.id })).album;
        for (const s of detail?.song ?? []) songs.push({ title: s.title, artist: s.artist, albumArtist: detail.artist, path: s.path });
        onProgress(++done, albums.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, albums.length) }, worker));
    return songs;
  }
}
