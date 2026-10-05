// Klickt die App mit der Beispiel-Playlist durch (echte iTunes-Abfragen) und speichert Screenshots.
// node tools/ui-check.mjs [ausgabeordner]
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const out = process.argv[2] ?? 'screenshots';
const server = await serve(0);
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch();
let failed = false;

for (const [name, viewport, colorScheme] of [['desktop', { width: 1100, height: 900 }, 'light'], ['mobile', { width: 400, height: 900 }, 'dark']]) {
  const page = await browser.newPage({ viewport, colorScheme });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => m.type() === 'error' && errors.push(m.text()));

  await page.goto(url);

  // Exportify-„Export All“-ZIP hochladen: Auswahl erscheint, kaputte Datei wird gemeldet.
  await page.setInputFiles('#file', 'tests/fixtures/export_all.zip');
  await page.waitForSelector('#picker:not([hidden])');
  const pickerTitle = await page.textContent('#picker-title');
  const importError = await page.textContent('#import-error');
  await page.click('#picker-all');
  await page.click('#picker-apply');
  const summary = await page.textContent('#playlist-summary');
  console.log(`${name}: ${pickerTitle} | ${summary} | Fehlermeldung: ${importError.trim()}`);
  if (!summary.includes('14 Titel') || !summary.includes('3 doppelte')) { failed = true; console.error(`${name}: Zusammenführen falsch`); }
  if (name === 'desktop') {
    await page.setInputFiles('#file', 'tests/fixtures/export_all.zip');
    await page.waitForSelector('#picker:not([hidden])');
    await page.fill('#picker-filter', 'lieb');
    await page.screenshot({ path: `${out}/${name}-picker.png`, fullPage: true });
  }

  await page.click('#sample');
  await page.click('#start');
  await page.waitForSelector('#results:not([hidden])', { timeout: 120_000 });

  const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const stats = (await page.textContent('#stats')).replace(/\s+/g, ' ');
  const items = await page.locator('.purchase').count();

  // "Habe ich" für einen Thriller-Titel setzen: Album bleibt bei 8 offenen Titeln günstiger.
  await page.locator('#track-rows input[type=checkbox]').nth(5).check();
  const statsAfter = (await page.textContent('#stats')).replace(/\s+/g, ' ');
  await page.locator('#track-rows input[type=checkbox]').nth(5).uncheck();

  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  console.log(`${name}: ${stats} | ${items} Posten | nach Abhaken: ${statsAfter} | Seitenbreite ${pageWidth}px`);
  if (errors.length || pageWidth > viewport.width) {
    failed = true;
    console.error(`${name}: Fehler`, errors, pageWidth > viewport.width ? 'horizontaler Überlauf' : '');
  }
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
