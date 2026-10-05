// Prüft den Abgleich einer CSV gegen das echte iTunes: node tools/live-check.mjs samples/beispiel-playlist.csv [land]
import { readFileSync } from 'node:fs';
import { parsePlaylistCsv } from '../js/csv.js';
import { ItunesClient } from '../js/itunes.js';
import { matchPlaylist, buildPurchasePlan } from '../js/matcher.js';

const [file = 'samples/beispiel-playlist.csv', country = 'de'] = process.argv.slice(2);
const tracks = parsePlaylistCsv(readFileSync(file, 'utf8'));
const client = new ItunesClient({ country, storage: null, onWait: (ms, why) => console.log(`… ${why} (${ms / 1000}s)`) });
const results = await matchPlaylist(tracks, client, (d, n, t) => process.stdout.write(`\r${d}/${n} ${t.name.slice(0, 40).padEnd(40)}`));
console.log(`\n${client.requestCount} Anfragen\n`);
for (const r of results) {
  const m = r.match ?? r.candidate;
  console.log(`${r.match ? '✓' : '✗'} ${r.score.toFixed(2)} ${(r.confidence ?? '-').padEnd(7)} ${r.via.padEnd(5)} ${r.track.artists[0]} – ${r.track.name}`);
  if (m) console.log(`      → ${m.artistName} – ${m.trackName} [${m.collectionName}] ${m.trackPrice} / Album ${m.collectionPrice} ${m.currency}`);
}
const plan = buildPurchasePlan(results);
console.log('\nEinkaufsliste:');
for (const i of plan.items) console.log(`  ${i.type.padEnd(5)} ${i.price} ${i.artist} – ${i.title}${i.reason ? ` (${i.reason}, einzeln ${i.singlesSum})` : ''}`);
console.log(`Summe ${plan.total} ${plan.currency} (einzeln ${plan.singlesTotal}), nicht gefunden: ${plan.unmatched.length}`);
