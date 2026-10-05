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

function hasPrice(c) {
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

/**
 * Sucht alle Titel im iTunes Store.
 * Titel desselben Albums werden möglichst über eine Album-Abfrage gefunden (spart Anfragen).
 * @returns {Promise<Array<{track, match, score, confidence, via}>>} in Playlist-Reihenfolge
 */
export async function matchPlaylist(tracks, client, onProgress = () => {}) {
  const results = new Map();
  let done = 0;
  const report = (track, result) => {
    results.set(track.id, result);
    done++;
    onProgress(done, tracks.length, track);
  };

  for (const group of groupByAlbum(tracks)) {
    let remaining = group.tracks;

    if (group.tracks.length >= 2 && group.album) {
      const albumTerm = `${group.albumArtists[0] ?? ''} ${cleanTitle(group.album)}`.trim();
      const albums = (await client.searchAlbums(albumTerm)).filter(a => a.collectionType === 'Album');
      const bestAlbum = albums
        .map(cand => ({ cand, score: scoreAlbum(group, cand) }))
        .sort((x, y) => y.score - x.score)[0];

      if (bestAlbum && bestAlbum.score >= ACCEPT_ALBUM) {
        const albumTracks = await client.albumWithTracks(bestAlbum.cand.collectionId);
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
      const artist = track.artists[0] ?? '';
      let best = pickBestSong(track, await client.searchSongs(`${artist} ${cleanTitle(track.name)}`));
      if (!best || best.score < ACCEPT_SONG) {
        // Zweiter Versuch ohne jeden Klammerzusatz, z. B. "(Radio Edit)" oder "- Live".
        const bare = track.name.replace(/\s*[([].*?[)\]]/g, '').replace(/\s+-\s+.*$/, '').trim();
        if (bare && bare !== cleanTitle(track.name)) {
          const retry = pickBestSong(track, await client.searchSongs(`${artist} ${bare}`));
          if (retry && (!best || retry.score > best.score)) best = retry;
        }
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
    if (!r.match) { unmatched.push(r); continue; }
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
    const buyable = rs.filter(r => hasPrice(r.match));
    const albumOnly = rs.filter(r => !hasPrice(r.match));
    const singlesSum = round(buyable.reduce((s, r) => s + r.match.trackPrice, 0));

    const mustBuyAlbum = albumOnly.length > 0 && albumPrice !== null;
    const albumCheaper = albumPrice !== null && rs.length >= 2 && albumPrice <= singlesSum;

    if (mustBuyAlbum || albumCheaper) {
      items.push({
        type: 'album',
        title: album.collectionName,
        artist: album.collectionArtistName ?? album.artistName,
        price: albumPrice,
        url: withStoreParam(album.collectionViewUrl),
        artwork: album.artworkUrl100,
        trackCount: album.trackCount,
        covers: rs.map(r => r.track.id),
        reason: albumCheaper
          ? (albumPrice < singlesSum ? 'cheaper' : 'same')
          : 'albumOnly',
        singlesSum,
      });
      total += albumPrice;
      // Ohne Album-Option hätte man nur die einzeln kaufbaren Titel bekommen.
      singlesTotal += albumCheaper ? singlesSum : albumPrice;
    } else {
      for (const r of buyable) {
        items.push({
          type: 'track',
          title: r.match.trackName,
          artist: r.match.artistName,
          price: r.match.trackPrice,
          url: withStoreParam(r.match.trackViewUrl),
          artwork: r.match.artworkUrl100,
          covers: [r.track.id],
        });
        total += r.match.trackPrice;
        singlesTotal += r.match.trackPrice;
      }
      // Nur im Album erhältlich, aber kein Albumpreis bekannt -> nicht kaufbar.
      for (const r of albumOnly) unmatched.push({ ...r, notBuyable: true });
    }
  }

  return { items, total: round(total), singlesTotal: round(singlesTotal), currency, unmatched };
}

function round(n) {
  return Math.round(n * 100) / 100;
}
