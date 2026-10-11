// Wie oft ein Titel gehört wurde – aus dem erweiterten Streamingverlauf von Spotify
// (Kontodaten-Download „Erweiterter Streamingverlauf“: Streaming_History_Audio_*.json).
// Ohne geladenen Verlauf gibt es keine Hörzahlen (playCount() liefert null).

import { isZip, readZip } from './zip.js';
import { normalizeName, normalizeTitle } from './text.js';

/** Spotify zählt ab 30 Sekunden als Wiedergabe; durchgelaufene Titel zählen immer (auch sehr kurze). */
const MIN_PLAYED_MS = 30000;

/** Erweiterter Verlauf (Streaming_History_Audio_2020.json) und der ältere Kontoverlauf (StreamingHistory0.json). */
export function isHistoryFile(name) {
  const base = name.split('/').pop();
  return /^Streaming_?History(_Audio)?[_\d].*\.json$/i.test(base) && !/video/i.test(base);
}

/** Schlüssel für den Abgleich ohne URI: Künstler und Titel, ohne Remaster-/feat.-Zusätze. */
export function nameKey(artist, title) {
  return `${normalizeName(artist ?? '')}|${normalizeTitle(title ?? '')}`;
}

/**
 * Zählt die Wiedergaben je Titel.
 * @param {Array<{name: string, bytes: Uint8Array}>} files JSON-Dateien des Verlaufs
 * @returns {{uris: Object<string, number>, names: Object<string, number>, plays: number, errors: string[]}}
 */
export function parseHistory(files) {
  const uris = {};
  const names = {};
  const errors = [];
  let plays = 0;
  const decoder = new TextDecoder('utf-8');

  for (const file of files) {
    let rows;
    try {
      rows = JSON.parse(decoder.decode(file.bytes));
      if (!Array.isArray(rows)) throw new Error('keine Liste');
    } catch (err) {
      errors.push(`${file.name}: kein gültiger Streamingverlauf (${err.message}).`);
      continue;
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      // Erweitertes Format: master_metadata_*; älteres Format: artistName/trackName/msPlayed ohne URI.
      const uri = row.spotify_track_uri;
      const title = row.master_metadata_track_name ?? row.trackName;
      const artist = row.master_metadata_album_artist_name ?? row.artistName;
      if (!title) continue; // Podcasts, Hörbücher, Videos
      const ms = Number(row.ms_played ?? row.msPlayed ?? 0);
      if (!(ms >= MIN_PLAYED_MS || row.reason_end === 'trackdone')) continue;
      plays++;
      if (typeof uri === 'string' && uri.startsWith('spotify:track:')) uris[uri] = (uris[uri] ?? 0) + 1;
      const key = nameKey(artist, title);
      names[key] = (names[key] ?? 0) + 1;
    }
  }
  return { uris, names, plays, errors };
}

/**
 * Trennt Verlaufsdateien (einzeln oder als ZIP von Spotify) von den übrigen hochgeladenen Dateien.
 * @returns {Promise<{history: Array<{name: string, bytes: Uint8Array}>, rest: Array<{name: string, bytes: Uint8Array}>}>}
 */
export async function extractHistoryFiles(files) {
  const history = [];
  const rest = [];
  for (const file of files) {
    if (isZip(file.bytes)) {
      let entries = [];
      try { entries = await readZip(file.bytes); } catch { /* kaputtes ZIP meldet später der Playlist-Import */ }
      const found = entries.filter(e => isHistoryFile(e.name));
      history.push(...found);
      if (!found.length || entries.some(e => /\.csv$/i.test(e.name))) rest.push(file);
    } else if (isHistoryFile(file.name)) {
      history.push(file);
    } else {
      rest.push(file);
    }
  }
  return { history, rest };
}

let history = null;

/** Setzt den geladenen Verlauf (oder null zum Entfernen). */
export function setHistory(h) { history = h; }
export function getHistory() { return history; }
export function hasHistory() { return history !== null; }

/** Anzahl Wiedergaben eines Titels; null, solange kein Verlauf geladen ist. */
export function playCount(track) {
  if (!history) return null;
  const byUri = history.uris[track.id] ?? 0;
  const byName = history.names[nameKey(track.artists?.[0], track.name)] ?? 0;
  return Math.max(byUri, byName);
}

/** Titel, die mindestens `min`-mal gehört wurden (ohne Verlauf bleiben alle). */
export function filterByPlays(tracks, min) {
  return min > 1 && history ? tracks.filter(t => playCount(t) >= min) : tracks;
}
