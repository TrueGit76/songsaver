// Findet die Titel einer Playlist im iTunes Store und berechnet den günstigsten Einkauf.

import { cleanTitle, normalizeTitle, versionMarkers, similarity, bestNameSimilarity } from './text.js';

export const ACCEPT_SONG = 0.6;
const ACCEPT_IN_ALBUM = 0.7;
const ACCEPT_ALBUM = 0.75;

function durationScore(track, cand) {
  if (!track.durationMs || !cand.trackTimeMillis) return 0.5;
  const diff = Math.abs(track.durationMs - cand.trackTimeMillis) / 1000;
  if (diff <= 2) return 1;
  if (diff <= 5) return 0.7;
  if (diff <= 15) return 0.3;
  return 0;
}

/** Wie gut passt ein iTunes-Titel zu einem Playlist-Titel? 0..1 */
export function scoreSong(track, cand) {
  const title = similarity(normalizeTitle(track.name), normalizeTitle(cand.trackName));
  const artist = bestNameSimilarity(cand.artistName, track.artists);
  const album = similarity(normalizeTitle(track.album), normalizeTitle(cand.collectionName));
  const duration = durationScore(track, cand);

  const a = versionMarkers(track.name).join(' ');
  const b = versionMarkers(cand.trackName).join(' ');
  const versionPenalty = a === b ? 0 : 0.3;

  // Ein klar anderer Künstler ist eine Coverversion, kein Treffer – egal wie gut der Titel passt.
  if (artist < 0.5) return Math.min(0.4, 0.45 * title + 0.25 * artist);

  const score = 0.45 * title + 0.25 * artist + 0.2 * duration + 0.1 * album - versionPenalty;
  return Math.max(0, Math.min(1, score));
}

export function scoreAlbum(group, cand) {
  const name = similarity(normalizeTitle(group.album), normalizeTitle(cand.collectionName));
  const artist = bestNameSimilarity(cand.artistName, group.albumArtists);
  const tooSmall = (cand.trackCount ?? 0) < group.tracks.length ? 0.3 : 0;
  // Bei Gleichstand die Ausgabe bevorzugen, deren Titelzahl zur Playlist passt (Standard statt Deluxe).
  const expected = Math.max(...group.tracks.map(t => t.trackNumber ?? 0), group.tracks.length);
  const sizeTiebreak = Math.abs((cand.trackCount ?? expected) - expected) * 0.002;
  return 0.6 * name + 0.4 * artist - tooSmall - sizeTiebreak;
}

export function confidenceLabel(score) {
  if (score >= 0.85) return 'hoch';
  if (score >= 0.7) return 'mittel';
  return 'niedrig';
}

/** Einzeln kaufbar? Titel, die es nur im Album gibt, haben keinen Einzelpreis. */
export function hasPrice(c) {
  return typeof c.trackPrice === 'number' && c.trackPrice > 0;
}

/** Bester Kandidat nach Score; bei fast gleichem Score gewinnt der kaufbare. */
export function pickBestSong(track, candidates) {
  let best = null;
  for (const cand of candidates) {
    if (cand.wrapperType !== 'track' || cand.kind !== 'song') continue;
    const score = scoreSong(track, cand);
    if (!best || score > best.score + 0.02 || (Math.abs(score - best.score) <= 0.02 && hasPrice(cand) && !hasPrice(best.cand))) {
      best = { cand, score };
    }
  }
  return best;
}

export function groupByAlbum(tracks) {
  const groups = new Map();
  for (const t of tracks) {
    if (!groups.has(t.albumKey)) {
      groups.set(t.albumKey, { key: t.albumKey, album: t.album, albumArtists: t.albumArtists, tracks: [] });
    }
    groups.get(t.albumKey).tracks.push(t);
  }
  return [...groups.values()];
}

export function albumTerm(group) {
  return `${group.albumArtists[0] ?? ''} ${cleanTitle(group.album)}`.trim();
}

export function songTerm(track) {
  return `${track.artists[0] ?? ''} ${cleanTitle(track.name)}`.trim();
}

/** Zweiter Suchbegriff ohne jeden Klammerzusatz, z. B. "(Radio Edit)" oder "- Live"; null, wenn identisch. */
function bareSongTerm(track) {
  const bare = track.name.replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim();
  return bare && bare !== cleanTitle(track.name) ? `${track.artists[0] ?? ''} ${bare}`.trim() : null;
}

/** Titel desselben Albums lohnen eine Album-Abfrage (2 Anfragen statt einer pro Titel). */
function usesAlbumLookup(group) {
  return group.tracks.length >= 2 && Boolean(group.album);
}

export function pickBestAlbum(group, albums) {
  const best = albums
    .filter(a => a.collectionType === 'Album')
    .map(cand => ({ cand, score: scoreAlbum(group, cand) }))
    .sort((x, y) => y.score - x.score)[0];
  return best && best.score >= ACCEPT_ALBUM ? best.cand : null;
}

/**
 * Sucht die Titel im iTunes Store und meldet jedes Ergebnis sofort über onResult.
 * Mit einem AbortSignal lässt sich die Suche anhalten (wirft dann einen AbortError).
 * @returns {Promise<Array<{track, match, score, confidence, via}>>} in Playlist-Reihenfolge
 */
export async function matchPlaylist(tracks, client, { onResult = () => {}, signal } = {}) {
  client.signal = signal ?? null;
  const results = new Map();
  const report = (track, result) => {
    results.set(track.id, result);
    onResult(result, results.size, tracks.length);
  };

  for (const group of groupByAlbum(tracks)) {
    signal?.throwIfAborted();
    let remaining = group.tracks;

    if (usesAlbumLookup(group)) {
      const album = pickBestAlbum(group, await client.searchAlbums(albumTerm(group)));
      if (album) {
        const albumTracks = await client.albumWithTracks(album.collectionId);
        remaining = [];
        for (const track of group.tracks) {
          const best = pickBestSong(track, albumTracks);
          if (best && best.score >= ACCEPT_IN_ALBUM) {
            report(track, { track, match: best.cand, score: best.score, confidence: confidenceLabel(best.score), via: 'album' });
          } else {
            remaining.push(track);
          }
        }
      }
    }

    for (const track of remaining) {
      signal?.throwIfAborted();
      let best = pickBestSong(track, await client.searchSongs(songTerm(track)));
      const bare = bareSongTerm(track);
      if ((!best || best.score < ACCEPT_SONG) && bare) {
        const retry = pickBestSong(track, await client.searchSongs(bare));
        if (retry && (!best || retry.score > best.score)) best = retry;
      }
      const ok = best && best.score >= ACCEPT_SONG;
      report(track, {
        track,
        match: ok ? best.cand : null,
        candidate: ok ? null : best?.cand ?? null,
        score: best?.score ?? 0,
        confidence: ok ? confidenceLabel(best.score) : null,
        via: 'song',
      });
    }
  }

  return tracks.map(t => results.get(t.id));
}

/**
 * Schätzt, wie viele Anfragen an iTunes nötig sind – nach demselben Vorgehen wie matchPlaylist,
 * aber nur mit Blick in den Cache. Zweite Suchversuche und Album-Ausreißer sind nicht vorhersehbar,
 * daher ist das eine Untergrenze, die in der Praxis gut passt.
 */
export async function estimateRequests(tracks, client) {
  let count = 0;
  for (const group of groupByAlbum(tracks)) {
    if (usesAlbumLookup(group)) {
      const albums = await client.peekAlbums(albumTerm(group));
      if (!albums) {
        count += 2;
        continue;
      }
      const album = pickBestAlbum(group, albums);
      if (album) {
        if (!(await client.peekAlbumTracks(album.collectionId))) count += 1;
        continue;
      }
    }
    for (const track of group.tracks) {
      if (!(await client.peekSongs(songTerm(track)))) count += 1;
    }
  }
  return count;
}

export function withStoreParam(url) {
  if (!url) return url;
  const u = new URL(url);
  u.searchParams.set('app', 'itunes'); // öffnet auf Apple-Geräten den iTunes Store statt Apple Music
  return u.toString();
}

/**
 * Berechnet den günstigsten Einkauf: pro iTunes-Album entweder die Einzeltitel oder das ganze Album.
 * @param {Array} results  Ergebnis von matchPlaylist
 * @param {Set<string>} owned  IDs bereits gekaufter Titel – werden nicht eingerechnet
 */
export function buildPurchasePlan(results, owned = new Set()) {
  const byCollection = new Map();
  const unmatched = [];
  let currency = null;

  for (const r of results) {
    if (owned.has(r.track.id)) continue;
    // Titel ohne Einzelpreis (nur im Album erhältlich) zählen wie nicht gefunden
    // und lösen keine Album-Empfehlung aus.
    if (!r.match || !hasPrice(r.match)) { unmatched.push(r); continue; }
    currency ??= r.match.currency;
    const id = r.match.collectionId;
    if (!byCollection.has(id)) byCollection.set(id, []);
    byCollection.get(id).push(r);
  }

  const items = [];
  let total = 0;
  let singlesTotal = 0;

  for (const rs of byCollection.values()) {
    const album = rs[0].match;
    const albumPrice = album.collectionPrice > 0 ? album.collectionPrice : null;
    // Dieselbe Aufnahme kann unter mehreren Spotify-Einträgen in der Auswahl stehen (Single, Album, Sampler);
    // gekauft und gezählt wird sie nur einmal.
    const unique = [...new Map(rs.map(r => [trackKey(r), r])).values()];
    const singlesSum = round(unique.reduce((s, r) => s + r.match.trackPrice, 0));

    // Album nur, wenn es wirklich billiger ist als die Einzeltitel.
    if (albumPrice !== null && unique.length >= 2 && albumPrice < singlesSum) {
      items.push({
        type: 'album',
        title: album.collectionName,
        artist: album.collectionArtistName ?? album.artistName,
        price: albumPrice,
        url: withStoreParam(album.collectionViewUrl),
        artwork: album.artworkUrl100,
        trackCount: album.trackCount,
        covers: rs.map(r => r.track.id),
        distinct: unique.length, // verschiedene Titel des Albums (covers kann Doppelte enthalten)
        reason: 'cheaper',
        singlesSum,
      });
      total += albumPrice;
      singlesTotal += singlesSum;
    } else {
      for (const r of unique) {
        items.push({
          type: 'track',
          title: r.match.trackName,
          artist: r.match.artistName,
          price: r.match.trackPrice,
          url: withStoreParam(r.match.trackViewUrl),
          artwork: r.match.artworkUrl100,
          covers: rs.filter(x => trackKey(x) === trackKey(r)).map(x => x.track.id),
        });
        total += r.match.trackPrice;
        singlesTotal += r.match.trackPrice;
      }
    }
  }

  return { items, total: round(total), singlesTotal: round(singlesTotal), currency, unmatched };
}

function trackKey(r) {
  return r.match.trackId ?? `${r.match.trackName}|${r.match.trackTimeMillis}`;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
