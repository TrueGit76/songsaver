import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entriesFromPaths, entriesFromSongs, buildIndex, findOwned } from '../js/library.js';
import { NextcloudMusicClient, normalizeBaseUrl } from '../js/nextcloud.js';

const track = (name, ...artists) => ({ id: `${artists[0]}|${name}`, name, artists });
const owned = (tracks, entries) => [...findOwned(tracks, buildIndex(entries))];

test('Pfade: Titelnummer, Künstlerordner und „Künstler - Titel“ werden erkannt', () => {
  const entries = entriesFromPaths([
    'Musik/Johnny Cash/American IV/03 - Hurt.mp3',
    'Musik/Sampler/Rammstein - Du hast.flac',
    'Musik/Nena/Nena/1-02. 99 Luftballons.m4a',
    'Musik/Johnny Cash/cover.jpg',
  ]);
  assert.equal(entries.length, 3, 'Bilder werden übersprungen');
  const tracks = [track('Hurt', 'Johnny Cash'), track('Du hast', 'Rammstein'), track('99 Luftballons', 'Nena'), track('Ghost', 'Johnny Cash')];
  assert.deepEqual(owned(tracks, entries), ['Johnny Cash|Hurt', 'Rammstein|Du hast', 'Nena|99 Luftballons']);
});

test('Abgleich: andere Fassung, anderer Künstler und Remaster-Zusätze', () => {
  const entries = entriesFromSongs([
    { title: 'Bohemian Rhapsody', artist: 'Queen' },
    { title: 'Hurt', artist: 'Johnny Cash' },
    { title: 'Karma Police', artist: 'Radiohead' },
  ]);
  const hits = owned([
    track('Bohemian Rhapsody - Remastered 2011', 'Queen'),
    track('Hurt', 'Nine Inch Nails'),          // Coverversion eines anderen Künstlers
    track('Karma Police - Live', 'Radiohead'), // andere Fassung
  ], entries);
  assert.deepEqual(hits, ['Queen|Bohemian Rhapsody - Remastered 2011']);
});

const response = body => ({ ok: true, status: 200, json: async () => ({ 'subsonic-response': { status: 'ok', ...body } }) });

test('Nextcloud: Adresse wird bereinigt', () => {
  assert.equal(normalizeBaseUrl('cloud.example.de/'), 'https://cloud.example.de');
  assert.equal(normalizeBaseUrl('https://cloud.example.de/index.php/apps/music'), 'https://cloud.example.de');
});

test('Nextcloud: Alben seitenweise lesen, dann Titel je Album', async () => {
  const calls = [];
  const albums = Array.from({ length: 501 }, (_, i) => ({ id: String(i) }));
  const fetch = async url => {
    const u = new URL(url);
    const method = u.pathname.split('/').pop().replace('.view', '');
    calls.push(method);
    assert.equal(u.searchParams.get('p'), 'geheim');
    if (method === 'getAlbumList2') {
      const offset = Number(u.searchParams.get('offset'));
      return response({ albumList2: { album: albums.slice(offset, offset + 500) } });
    }
    return response({ album: { artist: 'Band', song: [{ title: `Lied ${u.searchParams.get('id')}`, artist: 'Band' }] } });
  };
  const client = new NextcloudMusicClient({ baseUrl: 'cloud.example.de', user: 'jay', key: 'geheim', fetch });
  const songs = await client.allSongs();
  assert.equal(songs.length, 501);
  assert.equal(calls.filter(m => m === 'getAlbumList2').length, 2, 'zwei Seiten');
});

test('Nextcloud: falscher Schlüssel und nicht erreichbarer Server geben verständliche Fehler', async () => {
  const wrong = new NextcloudMusicClient({ baseUrl: 'x.de', user: 'a', key: 'b',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ 'subsonic-response': { status: 'failed', error: { code: 40 } } }) }) });
  await assert.rejects(wrong.ping(), /API-Schlüssel/);
  const down = new NextcloudMusicClient({ baseUrl: 'x.de', user: 'a', key: 'b', fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(down.ping(), /nicht erreichbar/);
});

test('Pfade: YouTube-ID am Dateinamen wird ignoriert', () => {
  const entries = entriesFromPaths([
    'Musik/The Knife - Pass This On-6UeQLO43a2Y.mp3',
    'Musik/Radiohead - Karma Police [fHiGbolFFGw].mp3',
  ]);
  const hits = owned([track('Pass This On', 'The Knife'), track('Karma Police', 'Radiohead'), track('Everything', 'The Knife')], entries);
  assert.deepEqual(hits, ['The Knife|Pass This On', 'Radiohead|Karma Police']);
});

test('Nextcloud ohne Tags: Dateiname als Titel, Ordner als Künstler', () => {
  const entries = entriesFromSongs([{
    title: 'The Knife - Pass This On-6UeQLO43a2Y', artist: 'Einzelnes', albumArtist: 'Einzelnes',
    path: '/Musik/Einzelnes/Schöne Musik/The Knife - Pass This On-6UeQLO43a2Y.mp3',
  }]);
  assert.deepEqual(owned([track('Pass This On', 'The Knife'), track('Pass This On', 'Jemand Anderes')], entries), ['The Knife|Pass This On']);
});
