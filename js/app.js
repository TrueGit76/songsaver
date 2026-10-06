import { loadPlaylistFiles, mergePlaylists } from './playlists.js';
import { ItunesClient, MIN_INTERVAL_MS } from './itunes.js';
import { matchPlaylist, estimateRequests, buildPurchasePlan, withStoreParam } from './matcher.js';
import { openStore, memoryStore } from './store.js';
import { playCount, filterByPlays, DUMMY_PLAYS } from './plays.js';

const OWNED_KEY = 'songsaver:owned';
const COUNTRY_KEY = 'songsaver:country';
const NOTIFY_KEY = 'songsaver:notify';
const MIN_PLAYS_KEY = 'songsaver:minPlays';
const SUB_PRICE_KEY = 'songsaver:subPrice';
const APP_TITLE = document.title;

const AMAZON_DOMAIN = { de: 'amazon.de', at: 'amazon.de', ch: 'amazon.de', gb: 'amazon.co.uk', us: 'amazon.com' };
// Spotify Premium (Individual) pro Monat, grobe Richtwerte – im Feld änderbar.
const SPOTIFY_PRICE = { de: 12.99, at: 12.99, ch: 14.9, gb: 12.99, us: 12.99 };
const QOBUZ_LOCALE = { de: 'de-de', at: 'at-de', ch: 'ch-de', gb: 'gb-en', us: 'us-en' };

const $ = id => document.getElementById(id);

const state = {
  tracks: [],          // aktuell ausgewählte Titel
  summary: '',
  playlists: [],       // Kandidaten in der Playlist-Auswahl
  results: new Map(),  // Track-ID -> Suchergebnis (für state.country)
  country: 'de',
  subPrice: null,      // eigener Abo-Preis; null = Richtwert für das Store-Land
  minPlays: 1,         // nur Titel mit mindestens so vielen Wiedergaben beachten
  owned: loadOwned(),
  running: null,       // AbortController der laufenden Suche
  store: memoryStore(),
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

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s <= 5 ? 'wenige Sekunden' : `ca. ${s} Sekunden`;
  const min = Math.round(s / 60);
  if (min < 60) return `ca. ${min} ${min === 1 ? 'Minute' : 'Minuten'}`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return `ca. ${h} Std.${rest ? ` ${rest} Min.` : ''}`;
}

function local(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* nur Komfort */ }
  return null;
}

function loadOwned() {
  try { return new Set(JSON.parse(local(OWNED_KEY) ?? '[]')); } catch { return new Set(); }
}

function saveOwned() {
  local(OWNED_KEY, JSON.stringify([...state.owned]));
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
    link(`https://www.youtube.com/results?search_query=${q}`, 'YouTube'),
  );
}

function newClient(extra = {}) {
  return new ItunesClient({ country: state.country, store: state.store, ...extra });
}

/** Titel, die den Filter „mindestens so oft gehört“ erfüllen. */
function visibleTracks(tracks = state.tracks) {
  return filterByPlays(tracks, state.minPlays);
}

/** Titel, die noch gesucht werden müssen (sichtbar, nicht im Besitz, noch kein Ergebnis). */
function pendingTracks(tracks = state.tracks) {
  return visibleTracks(tracks).filter(t => !state.owned.has(t.id) && !state.results.has(t.id));
}

// ---------- Sitzung speichern (Titel und Ergebnisse überstehen Neuladen) ----------

async function saveTracks() {
  try {
    await state.store.set('session', 'tracks', { tracks: state.tracks, summary: state.summary });
  } catch { /* nur Komfort */ }
}

let resultsSaveTimer = null;
function saveResults(now = false) {
  clearTimeout(resultsSaveTimer);
  const write = async () => {
    try {
      await state.store.set('session', 'results', { country: state.country, results: [...state.results.values()] });
    } catch { /* nur Komfort */ }
  };
  if (now) return write();
  resultsSaveTimer = setTimeout(write, 1500);
  return null;
}

async function restoreSession() {
  try {
    const saved = await state.store.get('session', 'tracks');
    if (!saved?.tracks?.length) return false;
    const res = await state.store.get('session', 'results');
    if (res?.country === state.country) {
      for (const r of res.results) state.results.set(r.track.id, r);
    }
    showTracks(saved.tracks, saved.summary);
    const done = saved.tracks.filter(t => state.results.has(t.id)).length;
    if (done) {
      $('progress').hidden = false;
      $('progress-fill').style.width = `${Math.round((done / saved.tracks.length) * 100)}%`;
      $('progress-text').textContent = `Letzte Sitzung wiederhergestellt: ${done} von ${saved.tracks.length} Titeln bereits gesucht.`;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------- Zeitschätzung ----------

let estimateRun = 0;

/** Berechnet die Suchdauer für die aktuelle Auswahl neu (Cache-Treffer zählen nicht). */
async function updateEstimate() {
  if (state.running) return;
  const run = ++estimateRun;
  const pending = pendingTracks();
  const button = $('start');
  button.textContent = state.results.size ? 'Weitersuchen' : 'Preise suchen';
  button.disabled = !pending.length;

  if (!pending.length) {
    $('estimate').textContent = !state.tracks.length ? ''
      : visibleTracks().length ? 'Alle Titel sind gesucht.' : 'Kein Titel erreicht diese Hörzahl.';
    return;
  }
  $('estimate').textContent = `${pending.length} Titel zu suchen – Dauer wird berechnet …`;
  const requests = await estimateRequests(pending, newClient());
  if (run !== estimateRun) return; // inzwischen neue Auswahl
  $('estimate').textContent = requests
    ? `${pending.length} Titel zu suchen – Dauer ${duration(requests * MIN_INTERVAL_MS)} (${requests} ${requests === 1 ? 'Anfrage' : 'Anfragen'} an iTunes).`
    : `${pending.length} Titel zu suchen – alles zwischengespeichert, dauert nur Sekunden.`;
}

// ---------- Import ----------

function showTracks(tracks, summary) {
  state.tracks = tracks;
  state.summary = summary;
  const albums = new Set(tracks.map(t => t.albumKey)).size;
  $('playlist-summary').textContent =
    `${summary}: ${tracks.length} Titel von ${albums} ${albums === 1 ? 'Album' : 'Alben'}.`;
  $('search').hidden = false;
  renderPlaysInfo();
  renderResults();
  updateEstimate();
}

function applyPlaylists(playlists) {
  if (state.running) return;
  const { tracks, duplicates } = mergePlaylists(playlists);
  if (!tracks.length) {
    showError('import-error', 'Die gewählten Playlists enthalten keine Titel.');
    return;
  }
  let summary = playlists.length === 1 ? `„${playlists[0].name}“` : `${playlists.length} Playlists`;
  if (duplicates) summary += ` (${duplicates} doppelte Titel nur einmal gezählt)`;

  // Bereits gesuchte Titel behalten, falls sie wieder dabei sind.
  const ids = new Set(tracks.map(t => t.id));
  for (const id of [...state.results.keys()]) if (!ids.has(id)) state.results.delete(id);

  $('progress').hidden = true;
  showError('search-error', null);
  showTracks(tracks, summary);
  saveTracks();
  saveResults(true);
  $('start').focus();
}

async function readFiles(fileList) {
  const files = [...(fileList ?? [])];
  if (!files.length || state.running) return;
  showError('import-error', null);
  $('picker').hidden = true;

  const inputs = await Promise.all(files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const { playlists, errors } = await loadPlaylistFiles(inputs);
  const usable = playlists.filter(p => p.tracks.length);
  if (errors.length) showError('import-error', errors.join('\n'));

  if (!usable.length) {
    if (!errors.length) showError('import-error', 'Keine Titel gefunden.');
    return;
  }
  if (usable.length === 1) applyPlaylists(usable);
  else showPicker(usable);
}

function showPicker(playlists) {
  state.playlists = playlists;
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

function chosenPlaylists() {
  return pickerBoxes().filter(b => b.checked).map(b => state.playlists[Number(b.value)]);
}

let pickerRun = 0;

async function updatePickerCount() {
  const run = ++pickerRun;
  const chosen = chosenPlaylists();
  $('picker-apply').disabled = !chosen.length;
  if (!chosen.length) {
    $('picker-count').textContent = 'Nichts ausgewählt';
    return;
  }
  const { tracks } = mergePlaylists(chosen);
  const base = `${chosen.length} ausgewählt, ${tracks.length} Titel`;
  $('picker-count').textContent = base;
  const requests = await estimateRequests(pendingTracks(tracks), newClient());
  if (run !== pickerRun) return;
  $('picker-count').textContent = `${base} – Suche ${requests ? duration(requests * MIN_INTERVAL_MS) : 'nur wenige Sekunden'}`;
}

function setupPicker() {
  $('picker-filter').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    for (const li of $('picker-list').querySelectorAll('li')) li.hidden = !li.dataset.name.includes(q);
  });
  $('picker-all').addEventListener('click', () => { pickerBoxes(true).forEach(b => { b.checked = true; }); updatePickerCount(); });
  $('picker-none').addEventListener('click', () => { pickerBoxes(true).forEach(b => { b.checked = false; }); updatePickerCount(); });
  $('picker-apply').addEventListener('click', () => {
    const chosen = chosenPlaylists();
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

function notifyDone(text) {
  if (document.hidden) {
    document.title = `✓ Fertig – ${APP_TITLE}`;
    if ($('notify').checked && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Songsaver: Suche fertig', { body: text }); } catch { /* manche Browser nur per Service Worker */ }
    }
  } else {
    document.title = APP_TITLE;
  }
}

async function runSearch() {
  if (state.running) {
    state.running.abort();
    return;
  }
  const pending = pendingTracks();
  if (!pending.length) return;

  if ($('notify').checked && 'Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }

  const controller = new AbortController();
  state.running = controller;
  const button = $('start');
  button.textContent = 'Pause';
  button.classList.add('secondary');
  $('country').disabled = true;
  showError('search-error', null);
  $('progress').hidden = false;
  const fill = $('progress-fill');
  const text = $('progress-text');

  const client = newClient({ onWait: (ms, reason) => { text.textContent = `${reason} (${duration(ms)}) …`; } });
  const expected = await estimateRequests(pending, client);
  const startedAt = Date.now();
  let lastLine = 'Starte Suche …';
  let etaMs = expected * MIN_INTERVAL_MS;
  let etaAt = Date.now();

  const showProgress = () => {
    const left = Math.max(0, etaMs - (Date.now() - etaAt));
    text.textContent = left > 1000 ? `${lastLine} · noch ${duration(left)}` : lastLine;
  };
  const ticker = setInterval(showProgress, 1000);
  showProgress();

  try {
    await matchPlaylist(pending, client, {
      signal: controller.signal,
      onResult: (result, done, total) => {
        state.results.set(result.track.id, result);
        saveResults();
        const pct = Math.round((done / total) * 100);
        fill.style.width = `${pct}%`;
        document.title = `(${pct} %) ${APP_TITLE}`;
        lastLine = `${done} von ${total}: ${result.track.artists[0] ?? ''} – ${result.track.name}`;
        // Restzeit aus dem tatsächlichen Tempo (inkl. Wartezeiten) hochrechnen.
        const perRequest = Math.max(MIN_INTERVAL_MS, (Date.now() - startedAt) / Math.max(1, client.requestCount));
        etaMs = Math.max(0, expected - client.requestCount) * perRequest;
        etaAt = Date.now();
        showProgress();
        renderResults();
      },
    });
    const found = pending.filter(t => state.results.get(t.id)?.match).length;
    lastLine = `Fertig: ${found} von ${pending.length} Titeln im iTunes Store gefunden.`;
    notifyDone(lastLine);
  } catch (err) {
    if (err?.name === 'AbortError') {
      lastLine = `Pausiert – ${pending.length - pendingTracks(pending).length} von ${pending.length} Titeln gesucht. „Weitersuchen“ macht dort weiter.`;
      document.title = APP_TITLE;
    } else {
      showError('search-error', err.message);
      lastLine = 'Suche abgebrochen.';
      document.title = APP_TITLE;
    }
  } finally {
    clearInterval(ticker);
    etaMs = 0;
    showProgress();
    state.running = null;
    button.classList.remove('secondary');
    $('country').disabled = false;
    await saveResults(true);
    renderResults();
    updateEstimate();
  }
}

function renderPlaysInfo() {
  const shown = visibleTracks().length;
  $('plays-info').textContent = state.minPlays > 1
    ? `${shown} von ${state.tracks.length} Titeln erreichen das${DUMMY_PLAYS ? ' (Dummy-Zahlen, bis die Spotify-Historie da ist)' : ''}.`
    : DUMMY_PLAYS ? 'Hörzahlen sind vorerst Dummy-Daten, bis die Spotify-Historie da ist.' : '';
}

function setupPlaysFilter() {
  const input = $('min-plays');
  input.value = String(state.minPlays);
  input.addEventListener('input', () => {
    const n = Math.floor(Number(input.value));
    state.minPlays = Number.isFinite(n) && n > 1 ? n : 1;
    local(MIN_PLAYS_KEY, String(state.minPlays));
    renderPlaysInfo();
    renderResults();
    updateEstimate();
  });
}

function setupSearch() {
  setupPlaysFilter();
  setupSubPrice();
  $('start').addEventListener('click', runSearch);
  $('country').addEventListener('change', () => {
    state.country = $('country').value;
    local(COUNTRY_KEY, state.country);
    state.subPrice = null; // eigener Preis gilt nur für das bisherige Land
    local(SUB_PRICE_KEY, '');
    renderSubPrice();
    // Preise gelten pro Land – bisherige Ergebnisse passen nicht mehr.
    state.results.clear();
    saveResults(true);
    $('progress').hidden = true;
    renderResults();
    updateEstimate();
  });
  $('notify').addEventListener('change', async e => {
    local(NOTIFY_KEY, e.target.checked ? '1' : '0');
    if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.running) document.title = APP_TITLE;
  });
}

// ---------- Ergebnisse ----------

function renderResults() {
  const results = visibleTracks().map(t => state.results.get(t.id)).filter(Boolean);
  $('tracks').hidden = !state.tracks.length;
  $('purchase').hidden = !results.length;
  const plan = buildPurchasePlan(results, state.owned);
  renderTrackRows(plan);
  if (!results.length) return;

  $('purchase-note').hidden = pendingTracks().length === 0;
  renderStats(plan);
  renderPurchaseList(plan);
}

function stat(label, value, highlight) {
  return el('div', { class: highlight ? 'stat highlight' : 'stat' },
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value' }, value));
}

function subPrice() {
  return state.subPrice ?? SPOTIFY_PRICE[state.country];
}

/** Wie viele Monate Streaming-Abo der Betrag kostet, z. B. „ca. 3,2 Monate“. */
function subscriptionMonths(total) {
  const price = subPrice();
  if (!(price > 0)) return '–';
  const months = total / price;
  const text = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(months);
  return `ca. ${text} ${text === '1' ? 'Monat' : 'Monate'}`;
}

function renderSubPrice() {
  const input = $('sub-price');
  input.value = String(subPrice());
  input.placeholder = String(SPOTIFY_PRICE[state.country]);
}

function setupSubPrice() {
  $('sub-price').addEventListener('input', e => {
    const v = Number(e.target.value.replace(',', '.'));
    state.subPrice = v > 0 ? v : null;
    local(SUB_PRICE_KEY, state.subPrice == null ? '' : String(state.subPrice));
    renderResults();
  });
}

function renderStats(plan) {
  const searched = visibleTracks().filter(t => !state.owned.has(t.id) && state.results.has(t.id));
  const found = searched.filter(t => state.results.get(t.id).match).length;
  const open = pendingTracks().length;
  $('stats').replaceChildren(
    stat('Gesamtpreis', money(plan.total, plan.currency)),
    stat('Entspricht Spotify-Abo', subscriptionMonths(plan.total)),
    stat(open ? `Gefunden (${open} noch offen)` : 'Gefunden', `${found} / ${searched.length}`),
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

  const rows = [];
  let group = null;
  const multi = new Set(state.tracks.map(t => t.playlists?.[0])).size > 1;
  for (const t of visibleTracks()) {
    const first = t.playlists?.[0];
    if (multi && first !== group) {
      group = first;
      const count = visibleTracks().filter(x => x.playlists?.[0] === first).length;
      rows.push(el('tr', { class: 'group' },
        el('th', { colspan: 6, scope: 'colgroup' }, first ?? 'Ohne Playlist', el('span', { class: 'count' }, ` · ${count} Titel`))));
    }
    rows.push(trackRow(t, inAlbum));
  }
  $('track-rows').replaceChildren(...rows);
}

function trackRow(t, inAlbum) {
  const r = state.results.get(t.id);
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
      updateEstimate();
    },
  });

  let found;
  let price;
  if (r?.match) {
    const [cls, label] = CONFIDENCE_TAG[r.confidence];
    found = el('td', {},
      link(withStoreParam(r.match.trackViewUrl), r.match.trackName),
      ' ', el('span', { class: `tag ${cls}`, title: `Übereinstimmung ${Math.round(r.score * 100)} %` }, label),
      el('span', { class: 'sub' }, `${r.match.artistName} · ${r.match.collectionName}`));
    price = el('td', { class: 'col-num' },
      r.match.trackPrice > 0 ? money(r.match.trackPrice, r.match.currency) : 'nur Album',
      inAlbum.has(t.id) && !owned ? el('span', { class: 'sub' }, 'im Album') : null);
  } else if (r) {
    found = el('td', {},
      el('span', { class: 'tag bad' }, 'nicht gefunden'),
      r.candidate
        ? el('span', { class: 'sub' }, 'Ähnlichster Treffer: ', link(withStoreParam(r.candidate.trackViewUrl), `${r.candidate.artistName} – ${r.candidate.trackName}`))
        : null);
    price = el('td', { class: 'col-num' }, '–');
  } else {
    found = el('td', {}, el('span', { class: 'sub' }, owned ? '–' : 'noch nicht gesucht'));
    price = el('td', { class: 'col-num' }, '');
  }

  const others = (t.playlists ?? []).slice(1);
  return el('tr', { class: owned ? 'owned' : null },
    el('td', { class: 'col-owned' }, checkbox),
    el('td', {}, t.name, el('span', { class: 'sub' }, `${t.artists.join(', ')} · ${t.album}`),
      others.length ? el('span', { class: 'sub' }, `Auch in: ${others.join(', ')}`) : null),
    el('td', { class: 'col-num' }, `${playCount(t)}×`),
    found,
    price,
    el('td', {}, shopLinks(term, 'track')));
}

// ---------- Start ----------

async function init() {
  const savedCountry = local(COUNTRY_KEY);
  if (savedCountry && AMAZON_DOMAIN[savedCountry]) $('country').value = savedCountry;
  state.country = $('country').value;
  renderSubPrice();
  $('notify').checked = local(NOTIFY_KEY) === '1';
  const savedMin = Math.floor(Number(local(MIN_PLAYS_KEY)));
  if (savedMin > 1) state.minPlays = savedMin;
  const savedSub = Number(local(SUB_PRICE_KEY));
  if (savedSub > 0) state.subPrice = savedSub;

  setupImport();
  setupSearch();
  state.store = await openStore();
  await restoreSession();
}

init();
