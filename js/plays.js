// Wie oft ein Titel gehört wurde. Die echte Streaminghistorie von Spotify liegt noch nicht vor,
// deshalb liefert dieses Modul vorerst reproduzierbare Dummy-Werte pro Titel-ID.
// Später hier die echten Zähler aus der Historie einlesen – der Rest der App ruft nur playCount() auf.

export const DUMMY_PLAYS = true;

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Abschließend durchmischen, sonst liegen ähnliche IDs (gleiches Präfix) nah beieinander.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Anzahl Wiedergaben eines Titels. Dummy: 1 bis 200, die meisten Titel selten, wenige sehr oft. */
export function playCount(track) {
  const r = hash(track.id) / 2 ** 32;
  return Math.max(1, Math.round(Math.exp(r * Math.log(200))));
}

/** Titel, die mindestens `min`-mal gehört wurden. */
export function filterByPlays(tracks, min) {
  return min > 1 ? tracks.filter(t => playCount(t) >= min) : tracks;
}
