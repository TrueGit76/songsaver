import { loadPlaylistFiles, mergePlaylists } from './playlists.js';
import { ItunesClient } from './itunes.js';
import { matchPlaylist, buildPurchasePlan, withStoreParam } from './matcher.js';

const OWNED_KEY = 'songsaver:owned';
const COUNTRY_KEY = 'songsaver:country';

const AMAZON_DOMAIN = { de: 'amazon.de', at: 'amazon.de', ch: 'amazon.de', gb: 'amazon.co.uk', us: 'amazon.com' };
const QOBUZ_LOCALE = { de: 'de-de', at: 'at-de', ch: 'ch-de', gb: 'gb-en', us: 'us-en' };

const $ = id => document.getElementById(id);

const state = {
  tracks: [],
  playlists: [],
  results: null,
  country: 'de',
  owned: loadOwned(),
};

// ---------- Hilfsfunktionen ----------

/** Baut ein Element; Text wird immer als Text gesetzt (CSV-Inhalte sind nicht vertrauenswürdig). */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

function link(href, text, cls) {
  return el('a', { href, target: '_blank', rel: 'noopener', class: cls }, text);
}

function money(value, currency) {
  if (value == null) return '–';
  try {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: currency || 'EUR' }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency ?? ''}`;
  }
}

function loadOwned() {
  try { return new Set(JSON.parse(localStorage.getItem(OWNED_KEY) ?? '[]')); } catch { return new Set(); }
}

function saveOwned() {
  try { localStorage.setItem(OWNED_KEY, JSON.stringify([...state.owned])); } catch { /* nur Komfort */ }
}

function showError(id, message) {
  const node = $(id);
  node.textContent = message ?? '';
  node.hidden = !message;
}

function shopLinks(term, kind) {
  const q = encodeURIComponent(term);
  return el('span', { class: 'shop-links' },
    link(`https://bandcamp.com/search?q=${q}&item_type=${kind === 'album' ? 'a' : 't'}`, 'Bandcamp'),
    link(`https://www.${AMAZON_DOMAIN[state.country]}/s?k=${q}&i=digital-music`, 'Amazon'),
    link(`https://www.qobuz.com/${QOBUZ_LOCALE[state.country]}/search?q=${q}`, 'Qobuz'),
  );
}

// ---------- Import ----------

function loadTracks(tracks, summary) {
  state.tracks = tracks;
  state.results = null;
  $('results').hidden = true;
  $('progress').hidden = true;
  showError('search-error', null);

  const albums = new Set(tracks.map(t => t.albumKey)).size;
  $('playlist-summary').textContent =
    `${summary}: ${tracks.length} Titel von ${albums} ${albums === 1 ? 'Album' : 'Alben'}.`;
  $('search').hidden = false;
  $('start').focus();
}

function applyPlaylists(playlists) {
  const { tracks, duplicates } = mergePlaylists(playlists);
  if (!tracks.length) {
    showError('import-error', 'Die gewählten Playlists enthalten keine Titel.');
    return;
  }
  let summary = playlists.length === 1 ? `„${playlists[0].name}“` : `${playlists.length} Playlists`;
  if (duplicates) summary += ` (${duplicates} doppelte Titel nur einmal gezählt)`;
  loadTracks(tracks, summary);
}

async function readFiles(fileList) {
  const files = [...(fileList ?? [])];
  if (!files.length) return;
  showError('import-error', null);
  $('picker').hidden = true;

  const inputs = await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const { playlists, errors } = await loadPlaylistFiles(inputs);
  const usable = playlists.filter(p => p.tracks.length);
  if (errors.length) showError('import-error', errors.join('\n'));

  if (!usable.length) {
    if (!errors.length) showError('import-error', 'Keine Titel gefunden.');
    $('search').hidden = true;
    return;
  }
  if (usable.length === 1) applyPlaylists(usable);
  else showPicker(usable);
}

function showPicker(playlists) {
  state.playlists = playlists;
  $('search').hidden = true;
  $('results').hidden = true;
  $('picker-title').textContent = `${playlists.length} Playlists gefunden – welche möchtest du kaufen?`;
  $('picker-filter').value = '';

  const items = playlists.map((p, i) => el('li', { 'data-name': p.name.toLowerCase() },
    el('label', {},
      el('input', { type: 'checkbox', value: String(i), onchange: updatePickerCount }),
      el('span', {}, p.name),
      el('span', { class: 'count' }, `${p.tracks.length} Titel`))));
  $('picker-list').replaceChildren(...items);
  $('picker').hidden = false;
  updatePickerCount();
}

function pickerBoxes(visibleOnly = false) {
  return [...$('picker-list').querySelectorAll('li')]
    .filter(li => !visibleOnly || !li.hidden)
    .map(li => li.querySelector('input'));
}

function updatePickerCount() {
  const chosen = pickerBoxes().filter(b => b.checked).map(b => state.playlists[Number(b.value)]);
  const titles = chosen.reduce((n, p) => n + p.tracks.length, 0);
  $('picker-count').textContent = chosen.length ? `${chosen.length} ausgewählt, ${titles} Titel` : 'Nichts ausgewählt';
  $('picker-apply').disabled = !chosen.length;
}

function setupPicker() {
  $('picker-filter').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    for (const li of $('picker-list').querySelectorAll('li')) li.hidden = !li.dataset.name.includes(q);
  });
  $('picker-all').addEventListener('click', () => { pickerBoxes(true).forEach(b => { b.checked = true; }); updatePickerCount(); });
  $('picker-none').addEventListener('click', () => { pickerBoxes(true).forEach(b => { b.checked = false; }); updatePickerCount(); });
  $('picker-apply').addEventListener('click', () => {
    const chosen = pickerBoxes().filter(b => b.checked).map(b => state.playlists[Number(b.value)]);
    if (chosen.length) applyPlaylists(chosen);
  });
}

function setupImport() {
  const input = $('file');
  const zone = $('dropzone');
  input.addEventListener('change', () => { readFiles(input.files); input.value = ''; });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragover');
    readFiles(e.dataTransfer.files);
  });
  $('sample').addEventListener('click', async () => {
    try {
      const res = await fetch('samples/beispiel-playlist.csv');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await readFiles([new File([await res.arrayBuffer()], 'beispiel_playlist.csv')]);
    } catch (err) {
      showError('import-error', `Beispiel konnte nicht geladen werden (${err.message}).`);
    }
  });
  setupPicker();
}

// ---------- Suche ----------

async function runSearch() {
  const button = $('start');
  button.disabled = true;
  showError('search-error', null);
  $('results').hidden = true;
  $('progress').hidden = false;
  const fill = $('progress-fill');
  const text = $('progress-text');
  fill.style.width = '0%';
  text.textContent = 'Starte Suche …';

  state.country = $('country').value;
  try { localStorage.setItem(COUNTRY_KEY, state.country); } catch { /* nur Komfort */ }

  const client = new ItunesClient({
    country: state.country,
    onWait: (ms, reason) => { text.textContent = `${reason} (ca. ${Math.round(ms / 1000)} s) …`; },
  });

  try {
    state.results = await matchPlaylist(state.tracks, client, (done, total, track) => {
      fill.style.width = `${Math.round((done / total) * 100)}%`;
      text.textContent = `${done} von ${total}: ${track.artists[0] ?? ''} – ${track.name}`;
    });
    const found = state.results.filter(r => r.match).length;
    text.textContent = `Fertig: ${found} von ${state.results.length} Titeln im iTunes Store gefunden.`;
    renderResults();
  } catch (err) {
    showError('search-error', err.message);
  } finally {
    button.disabled = false;
  }
}

// ---------- Ergebnisse ----------

function renderResults() {
  const plan = buildPurchasePlan(state.results, state.owned);
  renderStats(plan);
  renderPurchaseList(plan);
  renderTrackRows(plan);
  $('results').hidden = false;
}

function stat(label, value, highlight) {
  return el('div', { class: highlight ? 'stat highlight' : 'stat' },
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value' }, value));
}

function renderStats(plan) {
  const open = state.results.filter(r => !state.owned.has(r.track.id));
  const found = open.filter(r => r.match).length;
  const saving = plan.singlesTotal - plan.total;
  $('stats').replaceChildren(
    stat('Gesamtpreis', money(plan.total, plan.currency)),
    stat('Ersparnis durch Alben', money(saving > 0.004 ? saving : 0, plan.currency), saving > 0.004),
    stat('Gefunden', `${found} / ${open.length}`),
  );
}

function renderPurchaseList(plan) {
  const items = plan.items.map(item => {
    let meta;
    let tag = null;
    if (item.type === 'album') {
      meta = `Album · ${item.trackCount} Titel · enthält ${item.covers.length} aus deiner Playlist`;
      if (item.reason === 'cheaper') tag = el('span', { class: 'tag good' }, `spart ${money(item.singlesSum - item.price, plan.currency)}`);
      else if (item.reason === 'same') tag = el('span', { class: 'tag good' }, 'gleicher Preis, mehr Musik');
      else tag = el('span', { class: 'tag info' }, 'nur als Album erhältlich');
    } else {
      meta = 'Einzeltitel';
    }
    return el('li', { class: 'purchase' },
      el('img', { src: item.artwork ?? '', alt: '', loading: 'lazy' }),
      el('div', {},
        el('div', { class: 'purchase-title' }, item.title),
        el('div', { class: 'purchase-meta' }, `${item.artist} · ${meta} `, tag)),
      el('div', { class: 'purchase-side' },
        el('span', { class: 'price' }, money(item.price, plan.currency)),
        link(item.url, 'Bei iTunes', 'buy')));
  });
  if (!items.length) {
    items.push(el('li', { class: 'hint' }, 'Nichts zu kaufen – alle gefundenen Titel sind als „habe ich“ markiert.'));
  }
  $('purchase-list').replaceChildren(...items);
}

const CONFIDENCE_TAG = {
  hoch: ['good', 'sicher'],
  mittel: ['warn', 'bitte prüfen'],
  niedrig: ['warn', 'unsicher'],
};

function renderTrackRows(plan) {
  const inAlbum = new Map();
  for (const item of plan.items) {
    if (item.type === 'album') for (const id of item.covers) inAlbum.set(id, item);
  }

  const rows = state.results.map(r => {
    const t = r.track;
    const owned = state.owned.has(t.id);
    const term = `${t.artists[0] ?? ''} ${t.name}`;

    const checkbox = el('input', {
      type: 'checkbox',
      checked: owned,
      'aria-label': `${t.name} habe ich schon`,
      onchange: e => {
        if (e.target.checked) state.owned.add(t.id); else state.owned.delete(t.id);
        saveOwned();
        renderResults();
      },
    });

    let found;
    let price;
    if (r.match) {
      const [cls, label] = CONFIDENCE_TAG[r.confidence];
      found = el('td', {},
        link(withStoreParam(r.match.trackViewUrl), r.match.trackName),
        ' ', el('span', { class: `tag ${cls}`, title: `Übereinstimmung ${Math.round(r.score * 100)} %` }, label),
        el('span', { class: 'sub' }, `${r.match.artistName} · ${r.match.collectionName}`));
      const album = inAlbum.get(t.id);
      price = el('td', { class: 'col-num' },
        r.match.trackPrice > 0 ? money(r.match.trackPrice, r.match.currency) : 'nur Album',
        album && !owned ? el('span', { class: 'sub' }, 'im Album') : null);
    } else {
      found = el('td', {},
        el('span', { class: 'tag bad' }, 'nicht gefunden'),
        r.candidate
          ? el('span', { class: 'sub' }, 'Ähnlichster Treffer: ', link(withStoreParam(r.candidate.trackViewUrl), `${r.candidate.artistName} – ${r.candidate.trackName}`))
          : null);
      price = el('td', { class: 'col-num' }, '–');
    }

    return el('tr', { class: owned ? 'owned' : null },
      el('td', { class: 'col-owned' }, checkbox),
      el('td', {}, t.name, el('span', { class: 'sub' }, `${t.artists.join(', ')} · ${t.album}`)),
      found,
      price,
      el('td', {}, shopLinks(term, 'track')));
  });
  $('track-rows').replaceChildren(...rows);
}

// ---------- Start ----------

function init() {
  try {
    const saved = localStorage.getItem(COUNTRY_KEY);
    if (saved && AMAZON_DOMAIN[saved]) $('country').value = saved;
  } catch { /* egal */ }
  setupImport();
  $('start').addEventListener('click', runSearch);
}

init();
