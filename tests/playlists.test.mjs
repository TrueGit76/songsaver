import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readZip, isZip } from '../js/zip.js';
import { loadPlaylistFiles, mergePlaylists, playlistNameFromFile } from '../js/playlists.js';

const zipBytes = new Uint8Array(readFileSync(new URL('./fixtures/export_all.zip', import.meta.url)));

test('ZIP: unkomprimierte und komprimierte Einträge, Umlaute im Namen', async () => {
  assert.ok(isZip(zipBytes));
  const files = await readZip(zipBytes);
  assert.deepEqual(files.map(f => f.name), ['beispiel_playlist.csv', 'lieblingssongs_für_unterwegs.csv', 'kaputt.csv', 'readme.txt']);
  assert.match(new TextDecoder().decode(files[1].bytes), /^"Track URI"/);
});

test('ZIP: beschädigte Datei liefert verständliche Fehlermeldung', async () => {
  await assert.rejects(readZip(zipBytes.slice(0, 200)), /beschädigt/);
});

test('Export All: Playlists werden gelesen, fehlerhafte gemeldet, Nicht-CSV ignoriert', async () => {
  const { playlists, errors } = await loadPlaylistFiles([{ name: 'spotify_playlists.zip', bytes: zipBytes }]);
  assert.deepEqual(playlists.map(p => [p.name, p.tracks.length]), [['Beispiel playlist', 14], ['Lieblingssongs für unterwegs', 3]]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^kaputt\.csv: Unbekanntes Format/);
});

test('Zusammenführen: Songs aus mehreren Playlists nur einmal', async () => {
  const { playlists } = await loadPlaylistFiles([{ name: 'spotify_playlists.zip', bytes: zipBytes }]);
  const { tracks, duplicates } = mergePlaylists(playlists);
  assert.equal(tracks.length, 14);
  assert.equal(duplicates, 3);
});

test('Einzelne CSV-Datei', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../samples/beispiel-playlist.csv', import.meta.url)));
  const { playlists, errors } = await loadPlaylistFiles([{ name: 'meine_playlist.csv', bytes }]);
  assert.equal(errors.length, 0);
  assert.equal(playlists[0].name, 'Meine playlist');
});

test('Playlist-Name aus Exportify-Dateinamen', () => {
  assert.equal(playlistNameFromFile('ordner/road_trip_2026.csv'), 'Road trip 2026');
});

test('Zusammenführen: Titel kennt alle seine Playlists', () => {
  const t = id => ({ id, name: id, artists: ['A'] });
  const { tracks, duplicates } = mergePlaylists([
    { name: 'Eins', tracks: [t('x'), t('y')] },
    { name: 'Zwei', tracks: [t('y'), t('z')] },
  ]);
  assert.equal(duplicates, 1);
  assert.deepEqual(tracks.map(x => [x.id, x.playlists]), [['x', ['Eins']], ['y', ['Eins', 'Zwei']], ['z', ['Zwei']]]);
});
