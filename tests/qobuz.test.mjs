import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTrackSearch, parseQualities, cheapestQuality, QobuzClient, matchQobuz } from '../js/qobuz.js';
import { memoryStore } from '../js/store.js';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const track = (name, artist, album) => ({ id: name, name, artists: [artist], album, albumArtists: [artist], albumKey: album, durationMs: null });

test('Suchseite: Titel, Künstler, Album, ID und Albumlink', () => {
  const found = parseTrackSearch(fixture('qobuz-search.html'));
  assert.equal(found.length, 3);
  assert.deepEqual(found[0], {
    id: '33839468', trackName: 'Hurt (Album Version)', artistName: 'Johnny Cash',
    collectionName: 'American IV: The Man Comes Around',
    albumUrl: '/de-de/album/american-iv-the-man-comes-around-johnny-cash/0060253727735',
  });
});

test('Warenkorb-Dialog: Qualitätsstufen mit Preis', () => {
  assert.deepEqual(parseQualities(fixture('qobuz-popin.html')),
    [{ articleId: '80822413', cartLink: '/v4/ajax/add-cart?articleId=80822413&type=album', label: 'CD-Qualität', price: 2.29, currency: 'EUR' }]);
  assert.deepEqual(parseQualities('<p>nichts</p>'), []);
});

test('günstigste Stufe: nach Preis, bei Gleichstand MP3', () => {
  const q = (label, price) => ({ articleId: label, label, price, currency: 'EUR' });
  assert.equal(cheapestQuality([q('Hi-Res', 3.49), q('CD-Qualität', 2.29)]).label, 'CD-Qualität');
  assert.equal(cheapestQuality([q('CD-Qualität', 2.29), q('MP3', 2.29)]).label, 'MP3');
  assert.equal(cheapestQuality([]), null);
});

function fakeFetch(log, { popin = fixture('qobuz-popin.html') } = {}) {
  return async url => {
    log.push(url);
    const body = url.includes('/search/tracks/') ? fixture('qobuz-search.html') : popin;
    return { ok: true, status: 200, text: async () => body };
  };
}

const client = (log, store = null, extra) => new QobuzClient({ locale: 'de-de', store, fetch: fakeFetch(log, extra), sleep: async () => {}, minIntervalMs: 0 });

test('Abgleich: bester Treffer mit Preis, danach alles aus dem Cache', async () => {
  const store = memoryStore();
  const log = [];
  const tracks = [track('Hurt', 'Johnny Cash', 'American IV: The Man Comes Around')];
  const [r] = await matchQobuz(tracks, client(log, store));
  assert.equal(r.match.price, 2.29);
  assert.equal(r.match.albumUrl, 'https://www.qobuz.com/de-de/album/american-iv-the-man-comes-around-johnny-cash/0060253727735');
  assert.equal(log.length, 2, 'eine Suche und eine Preisabfrage');

  await matchQobuz(tracks, client(log, store));
  assert.equal(log.length, 2, 'zweiter Durchlauf ohne Anfragen');
});

test('Abgleich: falscher Künstler und nicht einzeln kaufbare Titel ergeben keinen Treffer', async () => {
  const [cover] = await matchQobuz([track('Hurt', 'Nine Inch Nails', 'The Downward Spiral')], client([]));
  assert.equal(cover.match, null);
  const [albumOnly] = await matchQobuz([track('Hurt', 'Johnny Cash', 'American IV: The Man Comes Around')], client([], null, { popin: '<div>keine Preise</div>' }));
  assert.equal(albumOnly.match, null);
});

test('fehlender Proxy wird verständlich gemeldet', async () => {
  const c = new QobuzClient({ locale: 'de-de', fetch: async () => ({ ok: false, status: 404 }), sleep: async () => {}, minIntervalMs: 0 });
  await assert.rejects(c.searchTracks('x'), /npm start/);
});

test('Suchseite: HTML-Entities im Titel werden aufgelöst', () => {
  const html = '<li><a href="/de-de/album/x/1" title="t" role="tooltip">Startin&#039; Somethin&#x27; &amp; Co</a><p class="a">A • B</p>'
    + '<button data-url="&#x2F;v4&#x2F;ajax&#x2F;popin-add-cart&#x2F;track&#x2F;7"></button></li>';
  assert.equal(parseTrackSearch(html)[0].trackName, "Startin' Somethin' & Co");
});

test('Warenkorb-Adresse: Artikel im URL-Teil, doppelte nur einmal, Typ aus dem Qobuz-Aufruf', async () => {
  const { cartUrl, cartItem } = await import('../js/qobuzcart.js');
  const a = { articleId: '1', cartLink: '/v4/ajax/add-cart?articleId=1&type=track' };
  assert.equal(cartItem(a), '1:track');
  assert.equal(cartItem({ articleId: '2' }), '2:album', 'ältere Cache-Einträge ohne Aufruf');
  assert.equal(cartUrl('de-de', [a, a, { articleId: '2' }]), 'https://www.qobuz.com/de-de/#songsaver=1:track,2:album');
});

test('Blöcke: 20 pro Block, Rest im letzten', async () => {
  const { cartBlocks } = await import('../js/qobuzcart.js');
  const blocks = cartBlocks(Array.from({ length: 45 }, (_, i) => i));
  assert.deepEqual(blocks.map(b => b.length), [20, 20, 5]);
  assert.deepEqual(cartBlocks([]), []);
});
