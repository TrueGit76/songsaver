// Kleiner Schlüssel-Wert-Speicher auf IndexedDB (fasst deutlich mehr als localStorage).
// Fällt auf einen flüchtigen Speicher zurück, wenn IndexedDB gesperrt ist (privates Fenster, Vorschau).

const DB_NAME = 'songsaver';
const STORES = ['cache', 'session'];

export function memoryStore() {
  const maps = Object.fromEntries(STORES.map(s => [s, new Map()]));
  return {
    async get(store, key) { return maps[store].get(key); },
    async set(store, key, value) { maps[store].set(key, value); },
    async delete(store, key) { maps[store].delete(key); },
    async count(store) { return maps[store].size; },
    async clear(store) { maps[store].clear(); },
  };
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function openStore() {
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { for (const s of STORES) req.result.createObjectStore(s); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blockiert'));
    });
    const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
    return {
      get: (store, key) => request(tx(store, 'readonly').get(key)),
      set: (store, key, value) => request(tx(store, 'readwrite').put(value, key)),
      delete: (store, key) => request(tx(store, 'readwrite').delete(key)),
      count: store => request(tx(store, 'readonly').count()),
      clear: store => request(tx(store, 'readwrite').clear()),
    };
  } catch {
    return memoryStore();
  }
}
