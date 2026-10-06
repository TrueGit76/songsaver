// Klickt die App mit der Beispiel-Playlist durch (echte iTunes-Abfragen) und speichert Screenshots.
// node tools/ui-check.mjs [ausgabeordner]
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const out = process.argv[2] ?? 'screenshots';
const server = await serve(0);
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch();
const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };
const text = async (page, sel) => (await page.textContent(sel)).replace(/\s+/g, ' ').trim();

for (const [name, viewport, colorScheme] of [['desktop', { width: 1100, height: 900 }, 'light'], ['mobile', { width: 400, height: 900 }, 'dark']]) {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  const errors = [];
  let itunesRequests = 0;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));
  page.on('request', r => { if (r.url().startsWith('https://itunes.apple.com/')) itunesRequests++; });

  await page.goto(url);

  // Exportify-„Export All“-ZIP: Auswahl mit Zeitschätzung, nichts wird automatisch gesucht.
  await page.setInputFiles('#file', 'tests/fixtures/export_all.zip');
  await page.waitForSelector('#picker:not([hidden])');
  await page.click('#picker-all');
  await page.waitForFunction(() => document.getElementById('picker-count').textContent.includes('Suche'));
  const pickerCount = await text(page, '#picker-count');
  await page.click('#picker-apply');
  await page.waitForFunction(() => document.getElementById('estimate').textContent.includes('Anfragen'));
  const estimateAll = await text(page, '#estimate');
  if (name === 'desktop') await page.screenshot({ path: `${out}/${name}-before.png`, fullPage: true });

  // „Habe ich“ vor der Suche ändert die Schätzung (Karma Police = Einzeltitel = 1 Anfrage weniger).
  await page.locator('#track-rows input[type=checkbox]').first().check();
  await page.waitForFunction(prev => document.getElementById('estimate').textContent.replace(/\s+/g, ' ').trim() !== prev && document.getElementById('estimate').textContent.includes('Anfragen'), estimateAll);
  const estimateOwned = await text(page, '#estimate');
  console.log(`${name}: Auswahl „${pickerCount}“ | ${estimateAll} | nach „Habe ich“: ${estimateOwned}`);
  check(itunesRequests === 0, `${name}: ${itunesRequests} iTunes-Anfragen ohne Klick auf „Preise suchen“`);
  check(estimateAll.includes('14 Titel') && estimateOwned.includes('13 Titel'), `${name}: Schätzung reagiert nicht auf Auswahl`);

  // Suche starten, nach 2 Ergebnissen pausieren, dann weitersuchen.
  await page.click('#start');
  await page.waitForFunction(() => document.querySelectorAll('#track-rows .tag').length >= 2, null, { timeout: 60_000 });
  await page.click('#start'); // Pause
  await page.waitForFunction(() => document.getElementById('progress-text').textContent.includes('Pausiert'), null, { timeout: 30_000 });
  const paused = await text(page, '#progress-text');
  const pausedButton = await text(page, '#start');
  console.log(`${name}: ${paused} | Knopf: ${pausedButton}`);
  check(pausedButton === 'Weitersuchen', `${name}: Knopf nach Pause heißt „${pausedButton}“`);

  // Neu laden: Sitzung kommt wieder, aber es wird nichts automatisch abgefragt.
  const before = itunesRequests;
  await page.reload();
  await page.waitForSelector('#tracks:not([hidden])');
  await page.waitForTimeout(4000);
  const restored = await text(page, '#progress-text');
  console.log(`${name}: nach Neuladen: ${restored}`);
  check(itunesRequests === before, `${name}: nach Neuladen ${itunesRequests - before} Anfragen ohne Klick`);
  check(restored.includes('wiederhergestellt'), `${name}: Sitzung nicht wiederhergestellt`);

  await page.click('#start');
  await page.waitForFunction(() => document.getElementById('estimate').textContent.includes('Alle Titel sind gesucht'), null, { timeout: 120_000 });
  const stats = await text(page, '#stats');
  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(`${name}: ${stats} | ${await page.locator('#track-rows a.buy').count()} Kaufposten | ${itunesRequests} iTunes-Anfragen insgesamt | Seitenbreite ${pageWidth}px`);
  check(stats.includes('13 / 13'), `${name}: nicht alle Titel gefunden`);
  check(pageWidth <= viewport.width, `${name}: horizontaler Überlauf`);

  await page.locator('#track-rows input[type=checkbox]').first().uncheck();
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  check(!errors.length, `${name}: Fehler in der Seite: ${errors.join(' | ')}`);
  await context.close();
}

await browser.close();
server.close();
if (problems.length) {
  console.error('\nPROBLEME:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('\nAlles in Ordnung.');
