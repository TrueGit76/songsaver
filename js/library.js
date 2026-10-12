// Abgleich der Playlist mit einer vorhandenen Musikbibliothek (lokaler Ordner oder Nextcloud Music).
// Ein Bibliothekseintrag ist { titles: [...], artists: [...] }: mehrere Kandidaten, weil Ordner- und Dateinamen
// keine feste Struktur haben („Künstler/Album/03 Titel.mp3“ oder „Künstler - Titel.mp3“).

import { normalizeTitle, versionMarkers, bestNameSimilarity } from './text.js';

const AUDIO = /\.(mp3|flac|m4a|aac|ogg|oga|opus|wav|wma|alac|aiff?)$/i;
const ARTIST_MATCH = 0.85;

/** Hängende YouTube-ID von Downloads („Titel-6UeQLO43a2Y“ oder „Titel [6UeQLO43a2Y]“): 11 Zeichen mit Ziffer oder Groß-/Kleinmix. */
function withoutVideoId(title) {
  const m = title.match(/^(.+?)(?:-|\s+\[)([\w-]{11})\]?$/);
  return m && /\d|(?=.*[a-z])(?=.*[A-Z])/.test(m[2]) ? m[1].trim() : null;
}

/** Dateiname ohne Endung und ohne führende Titelnummer („03 - “, „1-03. “). Beides wird als Kandidat geführt. */
function titleCandidates(file) {
  const base = file.replace(/\.[^.]+$/, '').trim();
  const stripped = base.replace(/^(?:\d{1,2}-)?\d{1,3}(?:\s*[-.)]\s*|\s+)/, '').trim();
  const titles = new Set([base, stripped].filter(Boolean));
  const artists = [];
  // „Künstler - Titel“ im Dateinamen
  const dash = stripped.match(/^(.+?)\s+-\s+(.+)$/);
  if (dash) {
    artists.push(dash[1]);
    titles.add(dash[2].trim());
  }
  // Zusätzlicher Kandidat ohne Video-ID; der Originalname bleibt, falls er zu einem Titel passt.
  for (const t of [...titles]) {
    const bare = withoutVideoId(t);
    if (bare) titles.add(bare);
  }
  return { titles: [...titles], artists };
}

/** Einträge aus Dateipfaden (z. B. webkitRelativePath); Nicht-Audiodateien werden übersprungen. */
export function entriesFromPaths(paths) {
  const entries = [];
  for (const path of paths) {
    if (!AUDIO.test(path)) continue;
    const parts = path.split('/').filter(Boolean);
    const file = parts.pop();
    const { titles, artists } = titleCandidates(file);
    // Alle Ordnernamen kommen als Künstler in Frage (Wurzelordner, Künstler, Album).
    entries.push({ titles, artists: [...artists, ...parts] });
  }
  return entries;
}

/**
 * Einträge aus Subsonic-Titeln: [{ title, artist, albumArtist, path }]. Fehlen in der Datei Tags, setzt Nextcloud
 * den Dateinamen als Titel und einen Ordnernamen als Künstler ein – deshalb zählen Titel und Pfad wie Dateinamen.
 */
export function entriesFromSongs(songs) {
  return songs
    .filter(s => s.title)
    .map(s => {
      const fromTitle = titleCandidates(`${s.title}.x`);
      const fromPath = s.path ? entriesFromPaths([s.path])[0] : null;
      return {
        titles: [...new Set([s.title, ...fromTitle.titles, ...(fromPath?.titles ?? [])])],
        artists: [...new Set([s.artist, s.albumArtist, ...fromTitle.artists, ...(fromPath?.artists ?? [])].filter(Boolean))],
      };
    });
}

/** Index nach normalisiertem Titel, damit der Abgleich nicht jeden Titel mit jedem Eintrag vergleicht. */
export function buildIndex(entries) {
  const index = new Map();
  for (const entry of entries) {
    for (const title of entry.titles) {
      const key = normalizeTitle(title);
      if (!key) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ title, artists: entry.artists });
    }
  }
  return index;
}

/** Ist der Titel in der Bibliothek? Gleicher Titel, passender Künstler und dieselbe Fassung (live, remix, …). */
export function inLibrary(track, index) {
  const hits = index.get(normalizeTitle(track.name));
  if (!hits) return false;
  const version = versionMarkers(track.name).join(' ');
  return hits.some(hit =>
    versionMarkers(hit.title).join(' ') === version
    && hit.artists.some(a => bestNameSimilarity(a, track.artists) >= ARTIST_MATCH));
}

/** IDs der Titel, die in der Bibliothek vorhanden sind. */
export function findOwned(tracks, index) {
  return new Set(tracks.filter(t => inLibrary(t, index)).map(t => t.id));
}
