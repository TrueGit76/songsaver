// Offline-Tests: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, parsePlaylistCsv, splitArtists } from '../js/csv.js';
import { normalizeTitle, versionMarkers, bestNameSimilarity } from '../js/text.js';
import { scoreSong, pickBestSong, buildPurchasePlan, matchPlaylist, ACCEPT_SONG } from '../js/matcher.js';

test('CSV: Anführungszeichen, Kommas, Zeilenumbrüche und BOM', () => {
  const rows = parseCsv('﻿"a","b, c"\r\n"d ""x""","e\nf"\n');
  assert.deepEqual(rows, [['a', 'b, c'], ['d "x"', 'e\nf']]);
});

test('Exportify: maskierte Kommas in Künstlernamen', () => {
  assert.deepEqual(splitArtists('Tyler\\, The Creator, Kali Uchis'), ['Tyler, The Creator', 'Kali Uchis']);
});

test('Exportify: Beispieldatei wird vollständig gelesen', () => {
  const tracks = parsePlaylistCsv(readFileSync(new URL('../samples/beispiel-playlist.csv', import.meta.url), 'utf8'));
  assert.equal(tracks.length, 14);
  assert.deepEqual(tracks[1].artists, ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers']);
  assert.equal(tracks[5].album, 'Thriller');
  assert.ok(tracks[0].durationMs > 0 && tracks[0].isrc);
});

test('Exportify: deutsche Spaltennamen', () => {
  const csv = '"Track-Name","Künstlername(n)","Album-Name","Track-Dauer (ms)"\n"Du hast","Rammstein","Sehnsucht","234000"\n';
  const [t] = parsePlaylistCsv(csv);
  assert.equal(t.name, 'Du hast');
  assert.deepEqual(t.artists, ['Rammstein']);
  assert.equal(t.durationMs, 234000);
});

test('Exportify: unbekanntes Format liefert verständliche Fehlermeldung', () => {
  assert.throws(() => parsePlaylistCsv('"foo","bar"\n"1","2"\n'), /Unbekanntes Format/);
});

test('Titel: Remaster- und Feature-Zusätze werden ignoriert, Versionen nicht', () => {
  assert.equal(normalizeTitle('Bohemian Rhapsody - Remastered 2011'), 'bohemian rhapsody');
  assert.equal(normalizeTitle('Get Lucky (feat. Pharrell Williams & Nile Rodgers)'), 'get lucky');
  assert.equal(normalizeTitle('Song (2009 Remaster)'), 'song');
  assert.deepEqual(versionMarkers('Get Lucky (Radio Edit)'), ['edit']);
  assert.deepEqual(versionMarkers('Du hast - Live'), ['live']);
});

test('Künstler: Kollaboration auf iTunes passt zum Hauptkünstler', () => {
  assert.ok(bestNameSimilarity('Daft Punk, Pharrell Williams & Nile Rodgers', ['Daft Punk', 'Pharrell Williams']) >= 0.9);
  assert.ok(bestNameSimilarity('The Beatles', ['Beatles']) === 1);
});

const track = { name: 'Du hast', artists: ['Rammstein'], album: 'Sehnsucht', durationMs: 234_000 };
const cand = (o) => ({ wrapperType: 'track', kind: 'song', trackName: 'Du hast', artistName: 'Rammstein', collectionName: 'Sehnsucht', trackTimeMillis: 234_500, trackPrice: 1.29, ...o });

test('Matching: Live-Version wird nicht als Studioaufnahme akzeptiert', () => {
  assert.ok(scoreSong(track, cand({ trackName: 'Du hast (Live)', collectionName: 'Live aus Berlin' })) < ACCEPT_SONG);
  assert.ok(scoreSong(track, cand({})) > 0.95);
});

test('Matching: Coverversion eines anderen Künstlers verliert', () => {
  const best = pickBestSong(track, [cand({ artistName: 'Vitamin String Quartet' }), cand({})]);
  assert.equal(best.cand.artistName, 'Rammstein');
});

test('Matching: bei gleichem Score gewinnt der einzeln kaufbare Titel', () => {
  const best = pickBestSong(track, [cand({ trackPrice: -1 }), cand({ trackPrice: 1.29 })]);
  assert.equal(best.cand.trackPrice, 1.29);
});

const match = (id, trackPrice, collectionId, collectionPrice) => ({
  track: { id },
  match: { trackName: id, artistName: 'X', collectionName: `A${collectionId}`, trackPrice, collectionId, collectionPrice, currency: 'EUR', trackViewUrl: 'https://music.apple.com/de/song/1', collectionViewUrl: 'https://music.apple.com/de/album/1' },
});

test('Einkauf: Album wird empfohlen, wenn es günstiger als die Einzeltitel ist', () => {
  const results = Array.from({ length: 9 }, (_, i) => match(`t${i}`, 1.29, 1, 9.99));
  const plan = buildPurchasePlan(results);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].type, 'album');
  assert.equal(plan.total, 9.99);
  assert.equal(plan.singlesTotal, 11.61);
});

test('Einkauf: wenige Titel eines Albums werden einzeln gekauft', () => {
  const plan = buildPurchasePlan([match('a', 1.29, 1, 9.99), match('b', 1.29, 1, 9.99)]);
  assert.deepEqual(plan.items.map(i => i.type), ['track', 'track']);
  assert.equal(plan.total, 2.58);
});

test('Einkauf: Titel „nur im Album“ gelten als nicht gefunden und erzwingen kein Album', () => {
  const plan = buildPurchasePlan([match('a', -1, 1, 9.99), match('b', 1.29, 1, 9.99)]);
  assert.deepEqual(plan.items.map(i => [i.type, i.covers[0]]), [['track', 'b']]);
  assert.deepEqual(plan.unmatched.map(r => r.track.id), ['a']);
  assert.equal(plan.total, 1.29);
});

test('Einkauf: Album nur, wenn es billiger ist als die Einzeltitel', () => {
  // 9 Titel à 1,11 = 9,99 = Albumpreis -> kein Vorteil, also einzeln
  const same = buildPurchasePlan(Array.from({ length: 9 }, (_, i) => match(`t${i}`, 1.11, 1, 9.99)));
  assert.ok(same.items.every(i => i.type === 'track'));
  // Titel ohne Einzelpreis zählen nicht zur Einzelsumme mit
  const mixed = buildPurchasePlan([...Array.from({ length: 8 }, (_, i) => match(`t${i}`, 1.29, 1, 9.99)), match('x', -1, 1, 9.99)]);
  assert.equal(mixed.items.filter(i => i.type === 'album').length, 1);
  assert.equal(mixed.items[0].covers.length, 8);
});

test('Einkauf: bereits gekaufte Titel zählen nicht', () => {
  const results = Array.from({ length: 9 }, (_, i) => match(`t${i}`, 1.29, 1, 9.99));
  const plan = buildPurchasePlan(results, new Set(['t0', 't1', 't2', 't3', 't4', 't5', 't6']));
  assert.deepEqual(plan.items.map(i => i.type), ['track', 'track']);
});

test('Ablauf: Album-Titel werden mit zwei Anfragen statt einzeln gefunden', async () => {
  const tracks = ['Eins', 'Zwei', 'Drei'].map((name, i) => ({
    id: name, name, artists: ['Band'], album: 'Platte', albumArtists: ['Band'], albumKey: 'p', trackNumber: i + 1, durationMs: 200_000,
  }));
  const calls = [];
  const client = {
    async searchAlbums(term) { calls.push(['album', term]); return [{ collectionType: 'Album', collectionId: 7, collectionName: 'Platte', artistName: 'Band', trackCount: 3 }]; },
    async albumWithTracks(id) { calls.push(['lookup', id]); return tracks.map(t => cand({ trackName: t.name, artistName: 'Band', collectionName: 'Platte', collectionId: 7, trackTimeMillis: 200_000 })); },
    async searchSongs(term) { calls.push(['song', term]); return []; },
  };
  const results = await matchPlaylist(tracks, client);
  assert.deepEqual(calls.map(c => c[0]), ['album', 'lookup']);
  assert.ok(results.every(r => r.match && r.via === 'album'));
});

test('Exportify (aktuelles Format): Künstler mit ";" getrennt, Kommas gehören zum Namen', () => {
  const csv = [
    '"Track URI","ISRC","Track Name","Album Name","Artist Name(s)","Release Date","Duration (ms)"',
    '"spotify:track:1","USX1","My Darlin\'","Das Ist Daddy","Marlon Hoffstadt;Rose Gray","2024-01-01","180000"',
    '"spotify:track:2","USX2","September","The Best Of","Earth, Wind & Fire","1978-01-01","215000"',
  ].join('\n');
  const [a, b] = parsePlaylistCsv(csv);
  assert.deepEqual(a.artists, ['Marlon Hoffstadt', 'Rose Gray']);
  assert.deepEqual(b.artists, ['Earth, Wind & Fire']);
  assert.equal(a.durationMs, 180000);
  assert.equal(a.isrc, 'USX1');
  assert.deepEqual(b.albumArtists, ['Earth, Wind & Fire']);
});

test('Matching: gleicher Titel von anderem Künstler ist kein Treffer', () => {
  const t = { name: "For What It's Worth", artists: ['The Lone Bellow'], album: "For What It's Worth", durationMs: 200_000 };
  assert.ok(scoreSong(t, cand({ trackName: "For What It's Worth", artistName: 'Haley Reinhart', collectionName: "What's That Sound?", trackTimeMillis: 200_000 })) < ACCEPT_SONG);
});

test('Titel: „Original Mix“ ist die normale Fassung', () => {
  assert.equal(normalizeTitle('Long Life - Original Mix'), 'long life');
  assert.deepEqual(versionMarkers('Long Life (Original Mix)'), []);
  assert.deepEqual(versionMarkers('Long Life - Extended Mix'), ['mix']);
});

import { playCount, filterByPlays, parseHistory, extractHistoryFiles, isHistoryFile, setHistory } from '../js/plays.js';

const jsonFile = (name, rows) => ({ name, bytes: new TextEncoder().encode(JSON.stringify(rows)) });
const play = (uri, title, artist, ms, reason = 'fwdbtn') => ({
  spotify_track_uri: uri, master_metadata_track_name: title, master_metadata_album_artist_name: artist, ms_played: ms, reason_end: reason,
});

test('Streamingverlauf: Wiedergaben ab 30 Sekunden oder bis zum Ende zählen, Podcasts und Anspielen nicht', () => {
  const h = parseHistory([jsonFile('Streaming_History_Audio_2020.json', [
    play('spotify:track:a', 'Karma Police', 'Radiohead', 264000, 'trackdone'),
    play('spotify:track:a', 'Karma Police', 'Radiohead', 31000),
    play('spotify:track:a', 'Karma Police', 'Radiohead', 4000),                  // übersprungen
    play('spotify:track:b', 'Kurzer Song', 'Band', 12000, 'trackdone'),          // sehr kurz, aber durchgelaufen
    { spotify_track_uri: null, master_metadata_track_name: null, episode_name: 'Folge 1', ms_played: 900000 },
    play('spotify:track:a2', 'Karma Police - Remastered 2009', 'Radiohead', 60000), // andere URI, gleicher Song
  ])]);
  assert.equal(h.plays, 4);
  assert.equal(h.uris['spotify:track:a'], 2);
  assert.equal(h.errors.length, 0);

  setHistory(h);
  assert.equal(playCount({ id: 'spotify:track:a', name: 'Karma Police', artists: ['Radiohead'] }), 3);
  // Playlist-Titel mit anderer ID wird über Künstler und Titel gefunden
  assert.equal(playCount({ id: 'spotify:track:x', name: 'Karma Police', artists: ['Radiohead'] }), 3);
  assert.equal(playCount({ id: 'spotify:track:b', name: 'Kurzer Song', artists: ['Band'] }), 1);
  assert.equal(playCount({ id: 'spotify:track:z', name: 'Unbekannt', artists: ['Niemand'] }), 0);
  setHistory(null);
});

test('Streamingverlauf: Filter nach Mindestanzahl; ohne Verlauf keine Zahlen und kein Filter', () => {
  const tracks = [
    { id: 'spotify:track:1', name: 'Eins', artists: ['A'] },
    { id: 'spotify:track:2', name: 'Zwei', artists: ['B'] },
  ];
  assert.equal(playCount(tracks[0]), null);
  assert.equal(filterByPlays(tracks, 5).length, 2);
  const rows = Array.from({ length: 6 }, () => play('spotify:track:1', 'Eins', 'A', 200000, 'trackdone'));
  setHistory(parseHistory([jsonFile('Streaming_History_Audio_2021.json', rows)]));
  assert.deepEqual(filterByPlays(tracks, 5).map(t => t.id), ['spotify:track:1']);
  assert.equal(filterByPlays(tracks, 1).length, 2);
  setHistory(null);
});

test('Streamingverlauf: älteres Kontoformat ohne URI wird über Namen gezählt; kaputte Dateien melden Fehler', () => {
  const h = parseHistory([
    jsonFile('StreamingHistory0.json', [{ endTime: '2020-01-01 10:00', artistName: 'Radiohead', trackName: 'Karma Police', msPlayed: 200000 }]),
    { name: 'Streaming_History_Audio_2022.json', bytes: new TextEncoder().encode('kein json') },
  ]);
  assert.equal(h.plays, 1);
  assert.equal(h.errors.length, 1);
  setHistory(h);
  assert.equal(playCount({ id: 'x', name: 'Karma Police', artists: ['Radiohead'] }), 1);
  setHistory(null);
});

test('Streamingverlauf: Dateinamen erkannt, Exportify-Dateien bleiben bei den Playlists', async () => {
  assert.ok(isHistoryFile('Spotify Extended Streaming History/Streaming_History_Audio_2013.json'));
  assert.ok(isHistoryFile('StreamingHistory_music_0.json'));
  assert.ok(isHistoryFile('StreamingHistory0.json'));
  assert.ok(!isHistoryFile('Spotify Extended Streaming History/Streaming_History_Video_2017.json'));
  assert.ok(!isHistoryFile('meine_playlist.csv'));
  const { readFileSync } = await import('node:fs');
  const zip = { name: 'export_all.zip', bytes: new Uint8Array(readFileSync(new URL('./fixtures/export_all.zip', import.meta.url))) };
  const csv = { name: 'a.csv', bytes: new TextEncoder().encode('x') };
  const { history, rest } = await extractHistoryFiles([zip, csv, jsonFile('Streaming_History_Audio_2020.json', [])]);
  assert.equal(history.length, 1);
  assert.deepEqual(rest.map(f => f.name), ['export_all.zip', 'a.csv']);
});

test('Einkauf: dieselbe Aufnahme mehrfach in der Auswahl wird nur einmal gezählt und bezahlt', () => {
  const dup = (id, trackId) => { const r = match(id, 1.29, 1, 9.99); r.match.trackId = trackId; return r; };
  // 8 verschiedene Titel, 3 davon zusätzlich unter einer zweiten Spotify-ID
  const results = [...Array.from({ length: 8 }, (_, i) => dup(`t${i}`, i)), dup('t0b', 0), dup('t1b', 1), dup('t2b', 2)];
  const plan = buildPurchasePlan(results);
  const album = plan.items[0];
  assert.equal(plan.items.length, 1);
  assert.equal(album.distinct, 8);
  assert.equal(album.covers.length, 11);
  assert.equal(album.singlesSum, 10.32);
  assert.equal(plan.total, 9.99);

  const few = buildPurchasePlan([dup('a', 1), dup('a2', 1)]);
  assert.equal(few.items.length, 1, 'ein Titel, einmal bezahlt');
  assert.deepEqual(few.items[0].covers, ['a', 'a2']);
  assert.equal(few.total, 1.29);
});
