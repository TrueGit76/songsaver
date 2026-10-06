import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSingleArtist, pickArtist, pickHomepage, pickBandcamp, ArtistSiteClient } from '../js/artistsite.js';
import { memoryStore } from '../js/store.js';

test('Sampler zählen nicht als Einzelkünstler', () => {
  assert.equal(isSingleArtist('Various Artists'), false);
  assert.equal(isSingleArtist('Verschiedene Interpreten'), false);
  assert.equal(isSingleArtist(''), false);
  assert.equal(isSingleArtist('Earth, Wind & Fire'), true);
});

test('Künstlerwahl: nur eindeutiger Namenstreffer mit hoher Übereinstimmung', () => {
  const hit = (id, name, score) => ({ id, name, score });
  assert.equal(pickArtist([hit('a', 'Radiohead', 100), hit('b', 'radiohead 3', 57)], 'Radiohead'), 'a');
  assert.equal(pickArtist([hit('a', 'Michael Jackson', 100), hit('b', 'Michael Jackson', 64)], 'Michael Jackson'), 'a');
  assert.equal(pickArtist([hit('a', 'Queen', 100), hit('b', 'Queen', 98)], 'Queen'), null, 'zwei gleich gute Namensvettern');
  assert.equal(pickArtist([hit('a', 'Radiohead Tribute', 100)], 'Radiohead'), null, 'anderer Name');
  assert.equal(pickArtist([hit('a', 'Foo', 70)], 'Foo'), null, 'zu unsicher');
  assert.equal(pickArtist([], 'Foo'), null);
});

test('Homepage: nur "official homepage", nicht beendet, http(s)', () => {
  const rel = (type, resource, ended = false) => ({ type, ended, url: { resource } });
  assert.equal(pickHomepage([rel('youtube', 'https://y.example'), rel('official homepage', 'http://alt.example', true), rel('official homepage', 'http://band.example/')]), 'http://band.example/');
  assert.equal(pickHomepage([rel('official homepage', 'javascript:alert(1)')]), null);
  assert.equal(pickHomepage([]), null);
});

test('Bandcamp: nur https-Seiten auf bandcamp.com, nicht beendet', () => {
  const rel = (type, resource, ended = false) => ({ type, ended, url: { resource } });
  assert.equal(pickBandcamp([rel('bandcamp', 'https://band.bandcamp.com'), rel('bandcamp', 'https://zweite.bandcamp.com')]), 'https://band.bandcamp.com/');
  assert.equal(pickBandcamp([rel('bandcamp', 'https://alt.bandcamp.com', true), rel('bandcamp', 'https://neu.bandcamp.com/')]), 'https://neu.bandcamp.com/');
  assert.equal(pickBandcamp([rel('bandcamp', 'http://band.bandcamp.com')]), null, 'kein https');
  assert.equal(pickBandcamp([rel('bandcamp', 'https://bandcamp.com.evil.example/x')]), null, 'fremde Domain');
  assert.equal(pickBandcamp([rel('official homepage', 'https://band.bandcamp.com')]), null, 'falscher Typ');
  assert.equal(pickBandcamp([]), null);
});

function fakeFetch(calls) {
  return async url => {
    calls.push(url);
    const body = url.includes('/artist?')
      ? { artists: [{ id: 'abc', name: 'Radiohead', score: 100 }] }
      : { relations: [{ type: 'official homepage', url: { resource: 'https://radiohead.com/' } }, { type: 'bandcamp', url: { resource: 'https://radiohead.bandcamp.com/' } }] };
    return { ok: true, json: async () => body };
  };
}

test('Client: zwei Anfragen, danach aus dem Cache; Fehler werden nicht gemerkt', async () => {
  const calls = [];
  const store = memoryStore();
  const client = new ArtistSiteClient({ store, fetch: fakeFetch(calls), sleep: async () => {} });
  assert.deepEqual(await client.find('Radiohead'), { website: 'https://radiohead.com/', bandcamp: 'https://radiohead.bandcamp.com/' });
  assert.equal(calls.length, 2);
  assert.deepEqual(await client.find('radiohead'), { website: 'https://radiohead.com/', bandcamp: 'https://radiohead.bandcamp.com/' });
  assert.equal(calls.length, 2, 'zweiter Aufruf ohne Anfrage');

  const failing = new ArtistSiteClient({ store: memoryStore(), fetch: async () => ({ ok: false, status: 503 }), sleep: async () => {} });
  assert.deepEqual(await failing.find('Radiohead'), { website: null, bandcamp: null });
  assert.equal(await failing.store.get('cache', 'artist-links:radiohead'), undefined);
});
