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

test('Einkauf: „nur als Album“ erzwingt den Albumkauf', () => {
  const plan = buildPurchasePlan([match('a', -1, 1, 9.99)]);
  assert.equal(plan.items[0].type, 'album');
  assert.equal(plan.items[0].reason, 'albumOnly');
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
