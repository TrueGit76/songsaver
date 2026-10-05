// CSV-Import für Playlist-Exporte von Exportify (englische und deutsche Spaltennamen).
// Zwei Formate sind im Umlauf: das ältere mit "Artist URI(s)" (Künstler durch ", " getrennt, Kommas als "\,")
// und das aktuelle von exportify.net (Künstler durch ";" getrennt, Kommas gehören zum Namen).

/** Zerlegt CSV-Text (RFC 4180: Anführungszeichen, "" als Escape, CRLF/LF) in Zeilen. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM

  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

// Interner Feldname -> mögliche Spaltennamen (Exportify EN/DE)
const COLUMNS = {
  uri: ['Track URI', 'Track-URI'],
  name: ['Track Name', 'Track-Name'],
  artistUris: ['Artist URI(s)', 'Künstler-URI(s)'],
  artists: ['Artist Name(s)', 'Künstlername(n)'],
  albumUri: ['Album URI', 'Album-URI'],
  album: ['Album Name', 'Album-Name'],
  albumArtists: ['Album Artist Name(s)', 'Album-Künstlername(n)'],
  releaseDate: ['Album Release Date', 'Veröffentlichungsdatum des Albums', 'Release Date'],
  imageUrl: ['Album Image URL', 'Album-Bild-URL'],
  discNumber: ['Disc Number', 'Disc-Nummer'],
  trackNumber: ['Track Number', 'Track-Nummer'],
  durationMs: ['Track Duration (ms)', 'Track-Dauer (ms)', 'Duration (ms)'],
  isrc: ['ISRC'],
};

/**
 * Zerlegt das Künstlerfeld. Älteres Format: ", " als Trenner, Kommas im Namen als "\,".
 * Aktuelles Format: ";" als Trenner, "Earth, Wind & Fire" bleibt ein Name.
 */
export function splitArtists(value, separator = ', ') {
  if (!value) return [];
  const parts = separator === ';' ? value.split(';') : value.split(/(?<!\\), /).map(a => a.replace(/\\,/g, ','));
  return parts.map(a => a.trim()).filter(Boolean);
}

/**
 * Wandelt eine Exportify-CSV in Track-Objekte um.
 * Wirft einen Error mit deutscher Meldung, wenn Pflichtspalten fehlen.
 */
export function parsePlaylistCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Die Datei enthält keine Titel.');

  const header = rows[0].map(h => h.trim());
  const index = {};
  for (const [key, names] of Object.entries(COLUMNS)) {
    index[key] = header.findIndex(h => names.includes(h));
  }
  if (index.name < 0 || index.artists < 0) {
    throw new Error('Unbekanntes Format: Die Spalten „Track Name“ und „Artist Name(s)“ wurden nicht gefunden. Bitte eine CSV-Datei von Exportify verwenden.');
  }

  const separator = index.artistUris >= 0 ? ', ' : ';';
  const get = (row, key) => (index[key] >= 0 ? (row[index[key]] ?? '').trim() : '');
  const toInt = v => (v === '' || isNaN(Number(v)) ? null : Number(v));

  return rows.slice(1)
    .filter(row => get(row, 'name'))
    .map(row => {
      const artists = splitArtists(get(row, 'artists'), separator);
      const albumArtists = splitArtists(get(row, 'albumArtists'), separator);
      const album = get(row, 'album');
      return {
        // Ohne Spotify-URI eine stabile Ersatz-ID, damit derselbe Song in mehreren Dateien gleich erkannt wird.
        id: get(row, 'uri') || `local:${artists[0] ?? ''}|${get(row, 'name')}|${album}`.toLowerCase(),
        name: get(row, 'name'),
        artists,
        album,
        albumArtists: albumArtists.length ? albumArtists : artists.slice(0, 1),
        albumKey: get(row, 'albumUri') || `${album}|${(albumArtists[0] ?? artists[0] ?? '')}`.toLowerCase(),
        releaseDate: get(row, 'releaseDate'),
        imageUrl: get(row, 'imageUrl'),
        discNumber: toInt(get(row, 'discNumber')),
        trackNumber: toInt(get(row, 'trackNumber')),
        durationMs: toInt(get(row, 'durationMs')),
        isrc: get(row, 'isrc'),
      };
    });
}
