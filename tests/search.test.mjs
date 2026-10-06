import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ItunesClient } from '../js/itunes.js';
import { memoryStore } from '../js/store.js';
import { matchPlaylist, estimateRequests } from '../js/matcher.js';

const song = (o) => ({ wrapperType: 'track', kind: 'song', trackName: 'Song', artistName: 'Band', collectionName: 'Platte', collectionId: 7, trackTimeMillis: 200_000, trackPrice: 1.29, collectionPrice: 9.99, currency: 'EUR', trackViewUrl: 'https://x/1', ...o });
const track = (name, album = 'Platte', n = 1) => ({ id: `${album}-${name}`, name, artists: ['Band'], album, albumArtists: ['Band'], albumKey: album, trackNumber: n, durationMs: 200_000 });

// Fake-iTunes: beantwortet Album-Suche, Album-Lookup und Song-Suche.
function fakeFetch(log) {
  return async (url) => {
    log.push(url);
    const u = new URL(url);
    let results = [];
    if (u.pathname === '/search' && u.searchParams.get('entity') === 'album') {
      results = [{ collectionType: 'Album', collectionId: 7, collectionName: 'Platte', artistName: 'Band', trackCount: 3 }];
    } else if (u.pathname === '/lookup') {
      results = ['Eins', 'Zwei', 'Drei'].map(n => song({ trackName: n, extraField: 'wird verworfen' }));
    } else {
      const term = u.searchParams.get('term');
      results = [song({ trackName: term.replace('Band ', ''), collectionName: 'Single', collectionId: 99 })];
    }
    return { ok: true, status: 200, json: async () => ({ results }) };
  };
}

const albumTracks = [track('Eins', 'Platte', 1), track('Zwei', 'Platte', 2), track('Drei', 'Platte', 3)];
const single = track('Solo', 'Single');

function client(store, log) {
  return new ItunesClient({ country: 'de', store, fetch: fakeFetch(log), sleep: async () => {}, minIntervalMs: 0 });
}

test('Schätzung: Album = 2 Anfragen, Einzeltitel = 1; danach alles im Cache', async () => {
  const store = memoryStore();
  const log = [];
  const c = client(store, log);
  const tracks = [...albumTracks, single];

  assert.equal(await estimateRequests(tracks, c), 3);
  await matchPlaylist(tracks, c);
  assert.equal(log.length, 3, 'Schätzung entspricht den tatsächlichen Anfragen');
  assert.equal(await estimateRequests(tracks, c), 0);
});

test('Cache: zweite Suche ohne Anfrage, nur benötigte Felder gespeichert', async () => {
  const store = memoryStore();
  const log = [];
  await matchPlaylist(albumTracks, client(store, log));
  const before = log.length;
  const results = await matchPlaylist(albumTracks, client(store, log));
  assert.equal(log.length, before);
  assert.ok(results.every(r => r.match));
  assert.equal(results[0].match.extraField, undefined);
});

test('Pause: Suche stoppt mit AbortError, bisherige Ergebnisse sind gemeldet', async () => {
  const controller = new AbortController();
  const seen = [];
  const tracks = [track('A', 'X'), track('B', 'Y'), track('C', 'Z')];
  await assert.rejects(
    matchPlaylist(tracks, client(memoryStore(), []), {
      signal: controller.signal,
      onResult: (r) => { seen.push(r.track.name); if (seen.length === 1) controller.abort(); },
    }),
    { name: 'AbortError' },
  );
  assert.deepEqual(seen, ['A']);
});

test('Cache: Gültigkeitsdauer ist einstellbar (unbegrenzt behält auch alte Einträge)', async () => {
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term: 'x', entity: 'song', media: 'music', limit: 25, country: 'de' })}`;
  const store = memoryStore();
  await store.set('cache', url, { at: Date.now() - 400 * 24 * 60 * 60 * 1000, results: [{ trackName: 'alt' }] });

  const week = new ItunesClient({ country: 'de', store });
  assert.equal(await week.peekSongs('x'), null, 'nach 7 Tagen abgelaufen');
  const forever = new ItunesClient({ country: 'de', store, cacheTtlMs: Infinity });
  assert.deepEqual(await forever.peekSongs('x'), [{ trackName: 'alt' }]);
  assert.equal(await store.count('cache'), 1);
  await store.clear('cache');
  assert.equal(await store.count('cache'), 0);
});

const okResponse = { ok: true, status: 200, json: async () => ({ results: [{ trackName: 'x' }] }) };

test('Limit: Abstand zwischen Anfragen wird eingehalten', async () => {
  const waits = [];
  const c = new ItunesClient({ country: 'de', fetch: async () => okResponse, sleep: async ms => { waits.push(ms); } });
  await c.searchSongs('a'); await c.searchSongs('b'); await c.searchSongs('c');
  assert.equal(waits.length, 2, 'erste Anfrage sofort, die nächsten warten');
  assert.ok(waits.every(ms => ms > 2500 && ms <= 3100), `Wartezeiten: ${waits}`);
});

test('Limit: Netzwerkfehler (Apple ohne CORS-Header) wird wie Limit behandelt – warten statt aufgeben', async () => {
  const waits = [];
  const hints = [];
  let calls = 0;
  const c = new ItunesClient({
    country: 'de', minIntervalMs: 0,
    fetch: async () => { if (++calls < 3) throw new TypeError('Failed to fetch'); return okResponse; },
    sleep: async ms => { waits.push(ms); },
    onWait: (ms, why) => hints.push(why),
  });
  assert.deepEqual(await c.searchSongs('a'), [{ trackName: 'x' }]);
  assert.deepEqual(waits, [60_000, 120_000]);
  assert.ok(hints.every(h => h.includes('Anfragelimit')));
});

test('Limit: dauerhaft keine Antwort -> verständliche Fehlermeldung nach drei Versuchen', async () => {
  let calls = 0;
  const c = new ItunesClient({ country: 'de', minIntervalMs: 0, fetch: async () => { calls++; throw new TypeError('Failed to fetch'); }, sleep: async () => {} });
  await assert.rejects(() => c.searchSongs('a'), /vermutlich Anfragelimit/);
  assert.equal(calls, 3);
});

test('Limit: 429 mit Retry-After wartet so lange wie verlangt', async () => {
  const waits = [];
  let calls = 0;
  const c = new ItunesClient({
    country: 'de', minIntervalMs: 0,
    fetch: async () => (++calls === 1 ? { ok: false, status: 429, headers: new Headers({ 'retry-after': '5' }) } : okResponse),
    sleep: async ms => { waits.push(ms); },
  });
  await c.searchSongs('a');
  assert.deepEqual(waits, [5000]);
});
