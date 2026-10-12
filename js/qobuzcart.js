// Qobuz-Warenkorb füllen ohne Erweiterung: Die App öffnet qobuz.com und gibt die Artikel im URL-Teil nach „#“ mit.
// Ein Lesezeichen („Bookmarklet“) legt sie dort mit der Sitzung des Nutzers in den Warenkorb. Aufrufe von außen
// (Link, fetch aus der App) lehnt Qobuz ab: der Warenkorb-Aufruf verlangt den Header X-Requested-With und die Sitzung.

import { QOBUZ_HOST } from './qobuz.js';

const HASH_KEY = 'songsaver';
/** Vorerst nur wenige Titel pro Durchgang, bis geprüft ist, was Qobuz im Warenkorb daraus macht. */
export const CART_TEST_LIMIT = 5;

/** „Artikel-ID:Typ“ für den Warenkorb-Aufruf, den Qobuz für diese Stufe selbst verwendet. */
export function cartItem(match) {
  const type = match.cartLink?.match(/[?&]type=([a-z]+)/)?.[1] ?? 'album'; // Qobuz nennt auch Titel-Artikel so
  return `${match.articleId}:${type}`;
}

/** Qobuz-Adresse, die die Artikel für das Lesezeichen im URL-Teil trägt. Gleiche Artikel nur einmal. */
export function cartUrl(locale, matches) {
  const items = [...new Set(matches.map(cartItem))];
  return `${QOBUZ_HOST}/${locale}/#${HASH_KEY}=${items.join(',')}`;
}

// Läuft auf qobuz.com. Prüft die Eingabe streng, weil jeder den URL-Teil beliebig setzen kann.
function bookmarklet() {
  const found = location.hash.match(/songsaver=([\d:,a-z]+)/);
  const items = found ? found[1].split(',').filter(i => /^\d+:[a-z]+$/.test(i)) : [];
  if (!/(^|\.)qobuz\.com$/.test(location.hostname) || !items.length) {
    alert('Songsaver: Dieses Lesezeichen funktioniert nur auf der Qobuz-Seite, die die App geöffnet hat.');
    return;
  }
  (async () => {
    const failed = [];
    for (const item of items) {
      const [id, type] = item.split(':');
      try {
        const res = await fetch(`/v4/ajax/add-cart?articleId=${id}&type=${type}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'same-origin' });
        if (!(await res.json()).success) failed.push(id);
      } catch { failed.push(id); }
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    const done = items.length - failed.length;
    if (confirm(`Songsaver: ${done} von ${items.length} Artikeln in den Warenkorb gelegt${failed.length ? ` (fehlgeschlagen: ${failed.join(', ')})` : ''}.\n\nJetzt zum Warenkorb?`)) {
      location.href = '/shopping-cart';
    }
  })();
}

/** Inhalt des Lesezeichens als javascript:-Adresse. */
export function bookmarkletHref() {
  return `javascript:(${bookmarklet.toString().replace(/\s*\n\s*/g, ' ')})()`;
}
