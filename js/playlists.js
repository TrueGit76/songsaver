// Hochgeladene Dateien (einzelne CSVs oder Exportify-ZIP) in Playlists umwandeln und zusammenführen.

import { parsePlaylistCsv } from './csv.js';
import { isZip, readZip } from './zip.js';

/** Exportify-Dateinamen sind kleingeschrieben mit "_" statt Leerzeichen: "meine_lieblingssongs.csv" */
export function playlistNameFromFile(fileName) {
  const base = fileName.split('/').pop().replace(/\.csv$/i, '');
  const name = base.replace(/_+/g, ' ').trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : fileName;
}

/**
 * @param {Array<{name: string, bytes: Uint8Array}>} files
 * @returns {Promise<{playlists: Array<{name: string, tracks: Array}>, errors: string[]}>}
 */
export async function loadPlaylistFiles(files) {
  const playlists = [];
  const errors = [];
  const decoder = new TextDecoder('utf-8');

  const addCsv = (fileName, bytes) => {
    try {
      const tracks = parsePlaylistCsv(decoder.decode(bytes));
      playlists.push({ name: playlistNameFromFile(fileName), tracks });
    } catch (err) {
      errors.push(`${fileName}: ${err.message}`);
    }
  };

  for (const file of files) {
    if (isZip(file.bytes)) {
      try {
        const entries = (await readZip(file.bytes))
          .filter(e => /\.csv$/i.test(e.name) && !e.name.startsWith('__MACOSX/'));
        if (!entries.length) errors.push(`${file.name}: enthält keine CSV-Dateien.`);
        for (const e of entries) addCsv(e.name, e.bytes);
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`);
      }
    } else {
      addCsv(file.name, file.bytes);
    }
  }
  return { playlists, errors };
}

/** Führt Playlists zusammen; ein Song, der in mehreren Playlists steht, wird nur einmal gekauft;
 * jeder Titel merkt sich in `playlists`, in welchen Playlists er steht. */
export function mergePlaylists(playlists) {
  const byId = new Map();
  const tracks = [];
  let duplicates = 0;
  for (const p of playlists) {
    for (const t of p.tracks) {
      const known = byId.get(t.id);
      if (known) {
        duplicates++;
        if (!known.playlists.includes(p.name)) known.playlists.push(p.name);
        continue;
      }
      const merged = { ...t, playlists: [p.name] }; // Kopie: die Playlist-Objekte bleiben unverändert
      byId.set(t.id, merged);
      tracks.push(merged);
    }
  }
  return { tracks, duplicates };
}
